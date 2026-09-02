import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const cleanEnvPath = join(root, "test", "clean-test-env.mjs");
const initialPackageLock = readFileSync(join(root, "package-lock.json"), "utf8");

const POLLUTED = {
  MOSA_LIBRARY_DIR: "/private/tmp/mosa-polluted-library",
  MOSA_DISABLE_BRIDGES: "cowart,cowartDiscovery,codex,grok",
  MOSA_PORT: "49991",
  MOSA_DESKTOP_PORT: "49992",
  MOSA_COWART_REGISTRY: "/private/tmp/mosa-invalid-registry.json",
  MOSA_COWART_ENDPOINT: "http://127.0.0.1:59999",
  MOSA_COWART_REGISTRY_PATH: "/private/tmp/mosa-invalid-registry-path.json",
  MOSA_PROJECT_DIR: "/private/tmp/mosa-polluted-project",
  MOSA_WEB_CAPTURE_TOKEN: "polluted-web-capture-token",
  MOSA_WEB_CAPTURE_ORIGINS: "chrome-extension://polluted-extension-id",
};

function baseEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(POLLUTED)) delete env[name];
  return env;
}

/** Runs a tiny probe under the real preload hook and returns its last JSON line. */
function runProbe(script, extraEnv = {}) {
  const result = spawnSync(
    process.execPath,
    ["--import", cleanEnvPath, "--input-type=module", "-e", script],
    { env: { ...baseEnv(), ...extraEnv }, encoding: "utf8", cwd: root },
  );
  assert.equal(result.status, 0, `probe exited ${result.status}: ${result.stderr}`);
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

test("preload hook deletes every known polluting MOSA variable", () => {
  const probe = `const out = {};
  for (const name of ${JSON.stringify(Object.keys(POLLUTED))}) out[name] = process.env[name] ?? null;
  process.stdout.write(JSON.stringify(out));`;
  const out = runProbe(probe, POLLUTED);
  for (const name of Object.keys(POLLUTED)) {
    assert.equal(out[name], null, `${name} must be deleted by the preload hook`);
  }
});

test("non-MOSA environment variables survive the preload hook", () => {
  const probe = `process.stdout.write(JSON.stringify({ kept: process.env.MOSA_PROBE_KEEP ?? null, home: process.env.HOME ?? null }));`;
  const out = runProbe(probe, { MOSA_PROBE_KEEP: "still-here", ...POLLUTED });
  assert.equal(out.kept, "still-here");
  assert.equal(out.home, process.env.HOME ?? null);
});

test("test files can still set their own MOSA_* values after the hook runs", () => {
  const probe = `process.env.MOSA_LIBRARY_DIR = "self-set";
  process.stdout.write(JSON.stringify({ value: process.env.MOSA_LIBRARY_DIR }));`;
  const out = runProbe(probe, POLLUTED);
  assert.equal(out.value, "self-set");
});

test("package.json test entry loads the preload hook", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.match(packageJson.scripts.test, /clean-test-env\.mjs/, "npm test must load test/clean-test-env.mjs");
  assert.match(packageJson.scripts.test, /--import/, "npm test must use the --import preload flag");
});

test("polluted MOSA_LIBRARY_DIR cannot hijack asset-store tests", () => {
  const storeUrl = pathToFileURL(join(root, "lib", "asset-store.mjs")).href;
  const probe = `const { createAssetStore } = await import(${JSON.stringify(storeUrl)});
  const store = createAssetStore({});
  process.stdout.write(JSON.stringify({ libraryDir: store.libraryDir ?? null }));`;
  const out = runProbe(probe, POLLUTED);
  assert.equal(out.libraryDir, null, "store must not inherit the polluted library directory");
  assert.notEqual(out.libraryDir, POLLUTED.MOSA_LIBRARY_DIR);
});

test("polluted MOSA_DISABLE_BRIDGES cannot change runtime bridge expectations", () => {
  const bridgesUrl = pathToFileURL(join(root, "lib", "runtime-bridges.mjs")).href;
  const probe = `const { parseDisabledBridges } = await import(${JSON.stringify(bridgesUrl)});
  process.stdout.write(JSON.stringify({ disabled: parseDisabledBridges({ env: process.env }) }));`;
  const out = runProbe(probe, POLLUTED);
  assert.deepEqual(out.disabled, [], "preload hook must neutralise the polluted bridge list");
});

test("the parent process environment is never permanently mutated", () => {
  process.env.MOSA_LIBRARY_DIR = "parent-marker";
  try {
    // Snapshot after the marker is set: the preload hook may already have
    // removed this key in the test process, so it is excluded from the diff.
    const before = { ...process.env, MOSA_LIBRARY_DIR: "parent-marker" };
    runProbe(`process.stdout.write(JSON.stringify({ ok: true }));`, POLLUTED);
    assert.equal(process.env.MOSA_LIBRARY_DIR, "parent-marker", "child deletion must not touch the parent env");
    const after = { ...process.env };
    const gained = Object.keys(after).filter((name) => !(name in before));
    const lost = Object.keys(before).filter((name) => !(name in after));
    assert.deepEqual(gained, [], "probe must not add environment keys to the parent");
    assert.deepEqual(lost, [], "probe must not remove environment keys from the parent");
  } finally {
    delete process.env.MOSA_LIBRARY_DIR;
  }
});

test("no new third-party dependencies are introduced", async () => {
  const files = [
    join(root, "lib", "import-staging.mjs"),
    join(root, "test", "clean-test-env.mjs"),
    join(root, "test", "import-staging-contract.test.mjs"),
    join(root, "test", "test-environment-isolation.test.mjs"),
  ];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)) {
      const specifier = match[1];
      assert.ok(
        specifier.startsWith("node:") || specifier.startsWith("."),
        `${file} must only import node built-ins or local files, got "${specifier}"`,
      );
    }
  }
});

test("package-lock.json is unchanged by the test environment hook", () => {
  assert.equal(
    readFileSync(join(root, "package-lock.json"), "utf8"),
    initialPackageLock,
    "the test environment hook must not mutate package-lock.json",
  );
});

test("polluted library path is never created by the hook itself", () => {
  const probe = `process.stdout.write(JSON.stringify({ ok: true }));`;
  runProbe(probe, POLLUTED);
  assert.equal(existsSync(POLLUTED.MOSA_LIBRARY_DIR), false, "the polluted library path must never be created");
});
