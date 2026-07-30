import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);

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

async function makeTemporaryRoot(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

test("starts, identifies itself, stops idempotently, and restarts", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-runtime-");
  const options = runtimeOptions(root);
  const first = await startMosaRuntime(options);
  t.after(() => first.stop());

  assert.equal(first.storage, "json");
  const response = await fetch(`${first.url}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    product: "mosa",
    libraryDir: options.libraryDir,
    storage: "json",
  });
  const i18nModule = await fetch(`${first.url}/i18n.mjs`);
  assert.equal(i18nModule.status, 200);
  assert.equal(i18nModule.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.match(await i18nModule.text(), /export default/);
  const bridges = await (await fetch(`${first.url}/api/bridges`)).json();
  assert.equal(bridges.cowart.sources[0].projectDir, options.cowartProjectDir);

  await first.stop();
  await first.stop();

  const second = await startMosaRuntime(options);
  try {
    assert.notEqual(second.port, 0);
    assert.equal((await fetch(`${second.url}/api/health`)).status, 200);
  } finally {
    await second.stop();
  }
});

test("rejects a second runtime in the same process", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-runtime-singleton-");
  const runtime = await startMosaRuntime(runtimeOptions(root));
  t.after(() => runtime.stop());

  await assert.rejects(
    startMosaRuntime(runtimeOptions(join(root, "other-library"))),
    /already active in this process/,
  );
});

test("releases the library lock when listener startup fails", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-runtime-rollback-");
  const portOwner = createServer((_req, res) => res.end("not mosa"));
  await listen(portOwner);
  t.after(() => close(portOwner));
  const address = portOwner.address();
  assert.equal(typeof address, "object");

  const options = runtimeOptions(root, { port: address.port });
  await assert.rejects(startMosaRuntime(options), /EADDRINUSE/);

  await close(portOwner);
  const runtime = await startMosaRuntime(runtimeOptions(root));
  try {
    assert.equal((await fetch(`${runtime.url}/api/health`)).status, 200);
  } finally {
    await runtime.stop();
  }
});

test("releases the library lock when bridge startup fails", async (t) => {
  const root = await makeTemporaryRoot(t, "mosa-runtime-bridge-rollback-");
  const options = runtimeOptions(root);
  await mkdir(join(root, "state"), { recursive: true });
  await writeFile(options.cowartRegistryPath, "not-json", "utf8");

  await assert.rejects(startMosaRuntime(options), /Cowart canvas registry is invalid/);

  await writeFile(options.cowartRegistryPath, '{"version":1,"projects":[]}\n', "utf8");
  const runtime = await startMosaRuntime(options);
  try {
    assert.equal((await fetch(`${runtime.url}/api/health`)).status, 200);
  } finally {
    await runtime.stop();
  }
});
