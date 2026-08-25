import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { MosaServiceConflictError, startMosaService } from "../desktop/service-manager.mjs";

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);

async function temporaryRoot(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function runtimeOptions(root) {
  const libraryDir = join(root, "library");
  return {
    projectRoot: root,
    managerDir: repositoryRoot,
    cowartProjectDir: join(root, "desktop-data"),
    appDir: join(repositoryRoot, "app"),
    assetsRoot: join(libraryDir, "assets"),
    generatedImagesDir: join(root, "generated-images"),
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "codex-sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-canvas"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
  };
}

function listen(server, port = 0) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => {
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

async function availablePort() {
  const server = createServer();
  await listen(server);
  const port = server.address().port;
  await close(server);
  return port;
}

test("attaches only to a matching MOSA health identity and leaves it running", async (t) => {
  const root = await temporaryRoot(t, "mosa-service-attach-");
  const libraryDir = join(root, "library");
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ product: "mosa", libraryDir, storage: "sqlite" }));
  });
  await listen(server);
  t.after(() => close(server));
  const port = server.address().port;

  const service = await startMosaService({ port, libraryDir });
  assert.equal(service.mode, "attached");
  assert.equal(service.storage, "sqlite");
  await service.stop();
  assert.equal(server.listening, true);
});

test("attaches to a matching pre-health-endpoint MOSA runtime", async (t) => {
  const root = await temporaryRoot(t, "mosa-service-legacy-attach-");
  const libraryDir = join(root, "library");
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/health") {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    if (req.url === "/api/library-path") {
      res.end(JSON.stringify({
        path: join(libraryDir, "assets", "default"),
        libraryDir,
        storage: "sqlite",
      }));
      return;
    }
    if (req.url === "/api/bridges") {
      res.end(JSON.stringify({ codex: { enabled: true }, cowart: { enabled: true } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "Not found" }));
  });
  await listen(server);
  t.after(() => close(server));

  const service = await startMosaService({ port: server.address().port, libraryDir });
  assert.equal(service.mode, "attached");
  assert.equal(service.storage, "sqlite");
  await service.stop();
  assert.equal(server.listening, true);
});

test("rejects non-MOSA listeners and mismatched libraries", async (t) => {
  const root = await temporaryRoot(t, "mosa-service-conflict-");
  const server = createServer((_req, res) => res.end("not mosa"));
  await listen(server);
  t.after(() => close(server));
  const port = server.address().port;

  await assert.rejects(
    startMosaService({ port, libraryDir: join(root, "library") }),
    MosaServiceConflictError,
  );
  assert.equal(server.listening, true);

  const mosaServer = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ product: "mosa", libraryDir: join(root, "other-library"), storage: "sqlite" }));
  });
  await listen(mosaServer);
  t.after(() => close(mosaServer));
  await assert.rejects(
    startMosaService({ port: mosaServer.address().port, libraryDir: join(root, "library") }),
    MosaServiceConflictError,
  );
  assert.equal(mosaServer.listening, true);
});

test("owns a new runtime and releases its lock on stop", async (t) => {
  const root = await temporaryRoot(t, "mosa-service-owned-");
  const libraryDir = join(root, "library");
  const port = await availablePort();
  const runtimeOptionsForRoot = runtimeOptions(root);
  const service = await startMosaService({ port, libraryDir, runtimeOptions: runtimeOptionsForRoot });
  t.after(() => service.stop());
  assert.equal(service.mode, "owned");
  assert.equal((await fetch(`${service.url}/api/health`)).status, 200);

  await service.stop();
  await assert.rejects(fetch(`${service.url}/api/health`));

  const runtime = await startMosaRuntime({ ...runtimeOptionsForRoot, port: 0, libraryDir });
  await runtime.stop();
});

test("attaches after a port race instead of replacing the new owner", async (t) => {
  const root = await temporaryRoot(t, "mosa-service-race-");
  const libraryDir = join(root, "library");
  const port = await availablePort();
  let raceOwner;
  t.after(() => close(raceOwner));

  const service = await startMosaService({
    port,
    libraryDir,
    startRuntime: async () => {
      raceOwner = createServer((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ product: "mosa", libraryDir, storage: "json" }));
      });
      await listen(raceOwner, port);
      const error = new Error("Address already in use");
      error.code = "EADDRINUSE";
      throw error;
    },
  });

  assert.equal(service.mode, "attached");
  await service.stop();
  assert.equal(raceOwner.listening, true);
});
