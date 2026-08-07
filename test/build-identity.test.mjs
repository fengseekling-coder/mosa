import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { getBuildIdentity, resetBuildIdentityCache, computeUiFingerprint } from "../lib/build-identity.mjs";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);

async function makeTempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return dir;
}

function runtimeOptions(root, overrides = {}) {
  const libraryDir = join(root, "library");
  return {
    port: 0,
    projectRoot: root,
    managerDir: repositoryRoot,
    cowartProjectDir: join(root, "desktop-data"),
    appDir: join(repositoryRoot, "app"),
    libraryDir,
    assetsRoot: join(libraryDir, "assets"),
    generatedImagesDir: join(root, "generated-images"),
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "codex-sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-canvas"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
    cowartMcpServerPath: join(root, "missing-cowart-mcp-server.mjs"),
    ...overrides,
  };
}

test("getBuildIdentity reads productVersion, gitSha, and uiFingerprint from build-identity.json", async () => {
  const tempAppDir = await makeTempDir("mosa-build-id-");
  t_after_cleanup(tempAppDir);
  await writeFile(join(tempAppDir, "build-identity.json"), JSON.stringify({
    productVersion: "1.2.3",
    gitSha: "abc123def456",
    uiFingerprint: "fingerprint-hash",
  }));
  resetBuildIdentityCache();
  const identity = getBuildIdentity(tempAppDir);
  assert.equal(identity.productVersion, "1.2.3");
  assert.equal(identity.gitSha, "abc123def456");
  assert.equal(identity.uiFingerprint, "fingerprint-hash");
  resetBuildIdentityCache();
});

test("getBuildIdentity returns unknown for all fields when build-identity.json is missing", () => {
  resetBuildIdentityCache();
  const identity = getBuildIdentity("/nonexistent/path/that/does/not/exist");
  assert.equal(identity.productVersion, "unknown");
  assert.equal(identity.gitSha, "unknown");
  assert.equal(identity.uiFingerprint, "unknown");
  resetBuildIdentityCache();
});

test("getBuildIdentity returns unknown for fields that are not strings", async () => {
  const tempAppDir = await makeTempDir("mosa-build-id-invalid-");
  t_after_cleanup(tempAppDir);
  await writeFile(join(tempAppDir, "build-identity.json"), JSON.stringify({
    productVersion: 123,
    gitSha: null,
    uiFingerprint: undefined,
  }));
  resetBuildIdentityCache();
  const identity = getBuildIdentity(tempAppDir);
  assert.equal(identity.productVersion, "unknown");
  assert.equal(identity.gitSha, "unknown");
  assert.equal(identity.uiFingerprint, "unknown");
  resetBuildIdentityCache();
});

test("computeUiFingerprint hashes index.html, styles.css, and app.js", async () => {
  const tempAppDir = await makeTempDir("mosa-fingerprint-");
  t_after_cleanup(tempAppDir);
  await writeFile(join(tempAppDir, "index.html"), "<html></html>");
  await writeFile(join(tempAppDir, "styles.css"), "body{}");
  await writeFile(join(tempAppDir, "app.js"), "console.log();");
  const fp1 = computeUiFingerprint(tempAppDir);
  assert.match(fp1, /^[0-9a-f]{64}$/);

  // Changing any file changes the fingerprint.
  await writeFile(join(tempAppDir, "app.js"), "console.log('changed');");
  const fp2 = computeUiFingerprint(tempAppDir);
  assert.notEqual(fp1, fp2);

  // Reverting restores the original fingerprint.
  await writeFile(join(tempAppDir, "app.js"), "console.log();");
  const fp3 = computeUiFingerprint(tempAppDir);
  assert.equal(fp1, fp3);
});

test("the repository app/ directory has a build-identity.json with valid fields", async () => {
  const appDir = join(repositoryRoot, "app");
  resetBuildIdentityCache();
  const identity = getBuildIdentity(appDir);
  assert.ok(identity.productVersion !== "unknown", "productVersion should be set by the build step");
  assert.ok(identity.gitSha !== "unknown", "gitSha should be set by the build step");
  assert.ok(identity.uiFingerprint !== "unknown", "uiFingerprint should be set by the build step");
  assert.match(identity.uiFingerprint, /^[0-9a-f]{64}$/, "uiFingerprint should be a SHA-256 hex digest");
  resetBuildIdentityCache();
});

test("uiFingerprint in build-identity.json matches the actual content of index.html + styles.css + app.js", async () => {
  const appDir = join(repositoryRoot, "app");
  resetBuildIdentityCache();
  const identity = getBuildIdentity(appDir);
  const computed = computeUiFingerprint(appDir);
  assert.equal(identity.uiFingerprint, computed,
    "uiFingerprint in build-identity.json must match the hash of the actual UI files");
  resetBuildIdentityCache();
});

test("/api/health returns productVersion, gitSha, and uiFingerprint matching build-identity.json", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-health-build-id-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = await startMosaRuntime(runtimeOptions(root));
  t.after(() => service.stop());

  const response = await fetch(`${service.url}/api/health`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.product, "mosa");
  assert.equal(typeof health.productVersion, "string");
  assert.equal(typeof health.gitSha, "string");
  assert.equal(typeof health.uiFingerprint, "string");

  // Verify against the actual build-identity.json in app/
  resetBuildIdentityCache();
  const identity = getBuildIdentity(join(repositoryRoot, "app"));
  assert.equal(health.productVersion, identity.productVersion);
  assert.equal(health.gitSha, identity.gitSha);
  assert.equal(health.uiFingerprint, identity.uiFingerprint);
  resetBuildIdentityCache();
});

test("static resources served by the runtime match the source files in app/", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-static-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = await startMosaRuntime(runtimeOptions(root));
  t.after(() => service.stop());

  for (const file of ["index.html", "styles.css", "app.js"]) {
    const response = await fetch(`${service.url}/${file}`);
    assert.equal(response.status, 200, `${file} should be served`);
    const served = await response.text();
    const source = await readFile(join(repositoryRoot, "app", file), "utf-8");
    assert.equal(served, source, `${file} served by the runtime must match the source file`);
  }
});

test("index.html does not use hardcoded ?v=NN query parameters for cache busting", async () => {
  const indexHtml = await readFile(join(repositoryRoot, "app", "index.html"), "utf-8");
  assert.doesNotMatch(indexHtml, /\?v=\d+["'\s>]/,
    "index.html must not rely on manual ?v=NN query strings; uiFingerprint is the source of truth");
});

test("the forge packaging config includes app/ resources and does not ignore build-identity.json", async () => {
  const forgeConfig = (await import("../desktop/forge.config.mjs")).default;
  const patterns = forgeConfig.packagerConfig.ignore;
  // app/ directory should not be ignored.
  assert.ok(!patterns.some((p) => p.test("/app/index.html")));
  assert.ok(!patterns.some((p) => p.test("/app/build-identity.json")));
  assert.ok(!patterns.some((p) => p.test("/app/app.js")));
});

test("desktop main.mjs loads the shared web UI via loadURL, not loadFile", async () => {
  const source = await readFile(join(repositoryRoot, "desktop", "main.mjs"), "utf-8");
  assert.match(source, /loadURL\(service\.url\)/);
  assert.doesNotMatch(source, /loadFile\(/);
  assert.match(source, /appDir: join\(appPath, "app"\)/);
});

test("early return prevents desktop integration in non-Electron browsers", async () => {
  const appSource = await readFile(join(repositoryRoot, "app", "app.js"), "utf-8");
  // The bindDesktopIntegration function must bail out when electronAPI is absent.
  assert.match(appSource, /if \(!api\) return/);
  // After the guard, event listeners are registered only when api is available.
  assert.match(appSource, /bindDesktopIntegration/);
});

// Helper to register cleanup for temp dirs created outside of test scope.
const cleanups = [];
function t_after_cleanup(dir) {
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
}
test.after(() => Promise.allSettled(cleanups.map((fn) => fn())));
