import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import sharp from "sharp";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

test("returns 404 for a missing library image without stopping the server", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-server-"));
  const sessionsDir = join(root, "sessions");
  const detectedProject = join(root, "detected-project");
  const workdirOnlyProject = join(root, "workdir-only-project");
  await mkdir(join(detectedProject, "canvas"), { recursive: true });
  await mkdir(join(workdirOnlyProject, "canvas"), { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(detectedProject, "canvas", "cowart-view-state.json"), "{}\n", "utf8");
  await writeFile(join(workdirOnlyProject, "canvas", "cowart-view-state.json"), "{}\n", "utf8");
  // Session 1: has turn_context.cwd + JS-call-style start-canvas.sh
  await writeFile(join(sessionsDir, "cowart-open.jsonl"), [
    JSON.stringify({ type: "turn_context", payload: { cwd: detectedProject } }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        arguments: `const result = await tools.exec_command({cmd:"./scripts/start-canvas.sh ${detectedProject}",workdir:"${detectedProject}"});`,
      },
    }),
  ].join("\n") + "\n");
  // Session 2: NO turn_context.cwd -- project dir only in structured JSON workdir.
  await writeFile(join(sessionsDir, "workdir-only.jsonl"), [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        arguments: JSON.stringify({
          cmd: "./scripts/start-canvas.sh",
          workdir: workdirOnlyProject,
        }),
      },
    }),
  ].join("\n") + "\n");
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PORT: "0",
      MOSA_PROJECT_DIR: root,
      MOSA_LIBRARY_DIR: join(root, "library"),
      CODEX_GENERATED_IMAGES_DIR: join(root, "generated-images"),
      CODEX_SESSIONS_DIR: sessionsDir,
      GROK_SESSIONS_DIR: join(root, "grok-sessions"),
      COWART_MOSA_CANVAS_DIR: join(root, "cowart-data"),
      MOSA_COWART_REGISTRY_PATH: join(root, "state", "cowart-projects.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });

  const port = await waitForServerPort(server);
  await waitForServer(port, server);
  const missingImage = await fetch(`http://127.0.0.1:${port}/library/default/images/does-not-exist.png`);
  assert.equal(missingImage.status, 404);
  assert.deepEqual(await missingImage.json(), { error: "Asset not found" });

  const bridgeStatus = await fetch(`http://127.0.0.1:${port}/api/bridges`, {
    headers: { origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(bridgeStatus.status, 200);
  const bridges = await bridgeStatus.json();
  assert.equal(bridges.grok?.enabled, true);
  assert.equal(typeof bridges.grok?.sessionsDir, "string");
  assert.equal(server.exitCode, null);

  const automaticallyDetected = await fetch(`http://127.0.0.1:${port}/api/cowart-canvases`);
  assert.equal(automaticallyDetected.status, 200);
  const detectedCanvases = (await automaticallyDetected.json()).canvases;
  const canonicalDetectedProject = await realpath(detectedProject);
  const canonicalWorkdirOnlyProject = await realpath(workdirOnlyProject);
  assert.equal(detectedCanvases.length, 3);
  assert.equal(detectedCanvases.some((canvas) => canvas.projectDir === canonicalDetectedProject), true);
  assert.equal(detectedCanvases.some((canvas) => canvas.projectDir === canonicalWorkdirOnlyProject), true);

  const otherProject = join(root, "other-project");
  await mkdir(otherProject, { recursive: true });
  const canonicalOtherProject = await realpath(otherProject);
  const addCanvas = await fetch(`http://127.0.0.1:${port}/api/cowart-canvases`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectDir: otherProject }),
  });
  assert.equal(addCanvas.status, 201);
  const added = await addCanvas.json();
  assert.equal(added.canvas.projectDir, canonicalOtherProject);
  assert.equal(added.canvas.canvasDir, join(canonicalOtherProject, "canvas"));

  const canvases = await fetch(`http://127.0.0.1:${port}/api/cowart-canvases`);
  assert.equal(canvases.status, 200);
  assert.equal((await canvases.json()).canvases.length, 4);

  const removeCanvas = await fetch(`http://127.0.0.1:${port}/api/cowart-canvases/${encodeURIComponent(added.canvas.id)}`, { method: "DELETE" });
  assert.equal(removeCanvas.status, 200);
  assert.equal((await removeCanvas.json()).canvas.id, added.canvas.id);
});

test("SQLite HTTP surface paginates assets and serves durable derivatives", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-server-sqlite-"));
  const libraryDir = join(root, "library");
  const imagePath = join(root, "generated-images", "fixture.png");
  const replacementPath = join(root, "replacement.png");
  await mkdir(join(root, "generated-images"), { recursive: true });
  await sharp({ create: { width: 8, height: 8, channels: 4, background: "#243047" } }).png().toFile(imagePath);
  await sharp({ create: { width: 8, height: 8, channels: 4, background: "#c43d38" } }).png().toFile(replacementPath);
  const seeded = createSqliteAssetStore({ projectRoot: root, managerDir: process.cwd(), libraryDir });
  const asset = await seeded.createAsset({ assetId: "sqlite-fixture", imagePath, prompt: "red mechanical future city" });
  await seeded.setMigrationState("completed", { test: true });
  seeded.close();

  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PORT: "0",
      MOSA_PROJECT_DIR: root,
      MOSA_LIBRARY_DIR: libraryDir,
      CODEX_GENERATED_IMAGES_DIR: join(root, "generated-images"),
      CODEX_SESSIONS_DIR: join(root, "sessions"),
      GROK_SESSIONS_DIR: join(root, "grok-sessions"),
      COWART_MOSA_CANVAS_DIR: join(root, "cowart-data"),
      MOSA_COWART_REGISTRY_PATH: join(root, "state", "cowart-projects.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  const port = await waitForServerPort(server);
  await waitForServer(port, server);
  const assets = await fetch(`http://127.0.0.1:${port}/api/assets?project=default&limit=1`);
  assert.equal(assets.status, 200);
  const page = await assets.json();
  assert.equal(page.page.total, 1);
  assert.equal(page.assets[0].id, asset.id);
  const thumbnail = await waitForResponse(`http://127.0.0.1:${port}/library/default/thumbnails/${asset.id}.webp`);
  assert.equal(thumbnail.status, 200);
  assert.equal(thumbnail.headers.get("content-type"), "image/webp");

  const duplicate = await fetch(`http://127.0.0.1:${port}/api/assets/default/${asset.id}/duplicate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assetId: "sqlite-copy" }) });
  assert.equal(duplicate.status, 201);
  const copied = (await duplicate.json()).asset;
  assert.equal(copied.parent_asset_id, null);

  const bypassVersionContract = await fetch(`http://127.0.0.1:${port}/api/assets/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "default", assetId: "bypass-version-contract", imagePath: replacementPath, parent_asset_id: asset.id }),
  });
  assert.equal(bypassVersionContract.status, 400);
  assert.equal((await bypassVersionContract.json()).code, "INVALID_VERSION_CHANGE");

  const invalidVersion = await fetch(`http://127.0.0.1:${port}/api/assets/default/${asset.id}/versions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version_change: " " }),
  });
  assert.equal(invalidVersion.status, 400);
  assert.equal((await invalidVersion.json()).code, "INVALID_VERSION_CHANGE");

  const versionResponse = await fetch(`http://127.0.0.1:${port}/api/assets/default/${asset.id}/versions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assetId: "sqlite-version", imagePath: replacementPath, version_change: "Brighter palette", theme: "Daylight" }),
  });
  assert.equal(versionResponse.status, 201);
  const version = (await versionResponse.json()).asset;
  assert.equal(version.parent_asset_id, asset.id);
  assert.equal(version.version_change, "Brighter palette");
  assert.equal(version.theme, "Daylight");
  assert.equal(version.source.path, replacementPath);
  const versionImage = await fetch(`http://127.0.0.1:${port}${version.image_url}`);
  assert.equal(versionImage.status, 200);
  assert.deepEqual(Buffer.from(await versionImage.arrayBuffer()), await readFile(replacementPath));

  const historyResponse = await fetch(`http://127.0.0.1:${port}/api/assets/default/${version.id}/versions`);
  assert.equal(historyResponse.status, 200);
  const history = (await historyResponse.json()).history;
  assert.equal(history.root_asset_id, asset.id);
  assert.equal(history.selected_asset_id, version.id);
  assert.deepEqual(history.versions.map((item) => item.id), [asset.id, version.id]);

  const missingHistory = await fetch(`http://127.0.0.1:${port}/api/assets/default/missing/versions`);
  assert.equal(missingHistory.status, 404);
  assert.equal((await missingHistory.json()).code, "ASSET_NOT_FOUND");

  const immutableRelation = await fetch(`http://127.0.0.1:${port}/api/assets/default/${version.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent_asset_id: null }),
  });
  assert.equal(immutableRelation.status, 400);
  assert.equal((await immutableRelation.json()).code, "VERSION_RELATION_IMMUTABLE");

  const archived = await fetch(`http://127.0.0.1:${port}/api/assets/default/${copied.id}/archive`, { method: "POST" });
  assert.equal(archived.status, 200);
});

test("invalid cursor returns 400 with INVALID_ASSET_CURSOR code", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-server-cursor-"));
  const libraryDir = join(root, "library");
  const imagePath = join(root, "generated-images", "cursor-test.png");
  await mkdir(join(root, "generated-images"), { recursive: true });
  await sharp({ create: { width: 4, height: 4, channels: 4, background: "#1a2b3c" } }).png().toFile(imagePath);
  const seeded = createSqliteAssetStore({ projectRoot: root, managerDir: process.cwd(), libraryDir });
  await seeded.createAsset({ assetId: "cursor-fixture", imagePath, prompt: "cursor test" });
  await seeded.setMigrationState("completed", { test: true });
  seeded.close();

  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PORT: "0",
      MOSA_PROJECT_DIR: root,
      MOSA_LIBRARY_DIR: libraryDir,
      CODEX_GENERATED_IMAGES_DIR: join(root, "generated-images"),
      CODEX_SESSIONS_DIR: join(root, "sessions"),
      GROK_SESSIONS_DIR: join(root, "grok-sessions"),
      COWART_MOSA_CANVAS_DIR: join(root, "cowart-data"),
      MOSA_COWART_REGISTRY_PATH: join(root, "state", "cowart-projects.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  const port = await waitForServerPort(server);
  await waitForServer(port, server);

  const invalidBase64 = Buffer.from('{"wrong":"field"}').toString("base64url");
  const invalidCursorResponse = await fetch(`http://127.0.0.1:${port}/api/assets?cursor=${invalidBase64}`);
  assert.equal(invalidCursorResponse.status, 400);
  const invalidCursorBody = await invalidCursorResponse.json();
  assert.equal(invalidCursorBody.code, "INVALID_ASSET_CURSOR");
  assert.equal(typeof invalidCursorBody.error, "string");

  const garbageCursor = await fetch(`http://127.0.0.1:${port}/api/assets?cursor=!!!not-valid!!!`);
  assert.equal(garbageCursor.status, 400);
  const garbageBody = await garbageCursor.json();
  assert.equal(garbageBody.code, "INVALID_ASSET_CURSOR");

  const validCursorResponse = await fetch(`http://127.0.0.1:${port}/api/assets?limit=1`);
  assert.equal(validCursorResponse.status, 200);
  const validPage = await validCursorResponse.json();
  assert.ok(validPage.page);

  assert.equal(server.exitCode, null);
});

test("request body errors return correct HTTP status codes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-server-body-"));
  const libraryDir = join(root, "library");
  const imagePath = join(root, "generated-images", "body-test.png");
  await mkdir(join(root, "generated-images"), { recursive: true });
  await sharp({ create: { width: 4, height: 4, channels: 4, background: "#4d5e6f" } }).png().toFile(imagePath);
  const seeded = createSqliteAssetStore({ projectRoot: root, managerDir: process.cwd(), libraryDir });
  await seeded.setMigrationState("completed", { test: true });
  seeded.close();

  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PORT: "0",
      MOSA_PROJECT_DIR: root,
      MOSA_LIBRARY_DIR: libraryDir,
      CODEX_GENERATED_IMAGES_DIR: join(root, "generated-images"),
      CODEX_SESSIONS_DIR: join(root, "sessions"),
      GROK_SESSIONS_DIR: join(root, "grok-sessions"),
      COWART_MOSA_CANVAS_DIR: join(root, "cowart-data"),
      MOSA_COWART_REGISTRY_PATH: join(root, "state", "cowart-projects.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  const port = await waitForServerPort(server);
  await waitForServer(port, server);

  const invalidJsonResponse = await fetch(`http://127.0.0.1:${port}/api/assets/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not valid json!!!",
  });
  assert.equal(invalidJsonResponse.status, 400);
  const invalidJsonBody = await invalidJsonResponse.json();
  assert.equal(invalidJsonBody.code, "INVALID_JSON_BODY");
  assert.equal(typeof invalidJsonBody.error, "string");

  const hugePayload = "x".repeat(6 * 1024 * 1024);
  const tooLargeResponse = await fetch(`http://127.0.0.1:${port}/api/assets/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: hugePayload,
  });
  assert.equal(tooLargeResponse.status, 413);
  const tooLargeBody = await tooLargeResponse.json();
  assert.equal(tooLargeBody.code, "REQUEST_BODY_TOO_LARGE");
  assert.equal(typeof tooLargeBody.error, "string");

  const normalResponse = await fetch(`http://127.0.0.1:${port}/api/assets?project=default&limit=10`);
  assert.equal(normalResponse.status, 200);

  assert.equal(server.exitCode, null);
});

test("JSON backend invalid cursor returns 400 with INVALID_ASSET_CURSOR", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-json-cursor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { createAssetStore } = await import("../lib/asset-store.mjs");
  const store = createAssetStore({ projectRoot: root, managerDir: join(root, "mosa"), libraryDir: join(root, "library") });
  assert.equal(store.storageKind, "json");
  await store.ensureProject("default");

  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PORT: "0",
      MOSA_PROJECT_DIR: root,
      MOSA_LIBRARY_DIR: join(root, "library"),
      CODEX_GENERATED_IMAGES_DIR: join(root, "generated-images"),
      CODEX_SESSIONS_DIR: join(root, "sessions"),
      GROK_SESSIONS_DIR: join(root, "grok-sessions"),
      COWART_MOSA_CANVAS_DIR: join(root, "cowart-data"),
      MOSA_COWART_REGISTRY_PATH: join(root, "state", "cowart-projects.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await once(server, "exit");
    }
  });
  const port = await waitForServerPort(server);
  await waitForServer(port, server);

  const badCursor = Buffer.from('{"bad":true}').toString("base64url");
  const res = await fetch(`http://127.0.0.1:${port}/api/assets?cursor=${badCursor}`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "INVALID_ASSET_CURSOR");

  const garbage = await fetch(`http://127.0.0.1:${port}/api/assets?cursor=!!!nope!!!`);
  assert.equal(garbage.status, 400);
  assert.equal((await garbage.json()).code, "INVALID_ASSET_CURSOR");
});

test("cross-origin request returns 403 while same-origin succeeds", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cors-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PORT: "0",
      MOSA_PROJECT_DIR: root,
      MOSA_LIBRARY_DIR: join(root, "library"),
      CODEX_GENERATED_IMAGES_DIR: join(root, "generated-images"),
      CODEX_SESSIONS_DIR: join(root, "sessions"),
      GROK_SESSIONS_DIR: join(root, "grok-sessions"),
      COWART_MOSA_CANVAS_DIR: join(root, "cowart-data"),
      MOSA_COWART_REGISTRY_PATH: join(root, "state", "cowart-projects.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await once(server, "exit");
    }
  });
  const port = await waitForServerPort(server);
  await waitForServer(port, server);

  const crossOrigin = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    headers: { origin: "https://example.com" },
  });
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(await crossOrigin.json(), { error: "Cross-origin requests are not allowed." });

  const sameOrigin = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    headers: { origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(sameOrigin.status, 200);
  const projects = await sameOrigin.json();
  assert.ok(Array.isArray(projects.projects));
});

test("multi-byte UTF-8 body exceeding 5 MiB returns 413", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-multibyte-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PORT: "0",
      MOSA_PROJECT_DIR: root,
      MOSA_LIBRARY_DIR: join(root, "library"),
      CODEX_GENERATED_IMAGES_DIR: join(root, "generated-images"),
      CODEX_SESSIONS_DIR: join(root, "sessions"),
      GROK_SESSIONS_DIR: join(root, "grok-sessions"),
      COWART_MOSA_CANVAS_DIR: join(root, "cowart-data"),
      MOSA_COWART_REGISTRY_PATH: join(root, "state", "cowart-projects.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await once(server, "exit");
    }
  });
  const port = await waitForServerPort(server);
  await waitForServer(port, server);

  // Each Chinese character is 3 bytes in UTF-8 but 1 JS string length unit.
  // 2 MiB characters → 6 MiB bytes, well above the 5 MiB byte limit.
  const charCount = 2 * 1024 * 1024;
  const jsonBody = JSON.stringify({ prompt: "\u4f60\u597d".repeat(charCount) });
  const jsLen = jsonBody.length;
  const byteLen = Buffer.byteLength(jsonBody, "utf8");
  assert.ok(jsLen < 5 * 1024 * 1024, `JS string length ${jsLen} should be under 5 MiB`);
  assert.ok(byteLen > 5 * 1024 * 1024, `UTF-8 byte length ${byteLen} should exceed 5 MiB`);

  const res = await fetch(`http://127.0.0.1:${port}/api/assets/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: jsonBody,
  });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.code, "REQUEST_BODY_TOO_LARGE");
  assert.equal(typeof body.error, "string");

  const stillWorks = await fetch(`http://127.0.0.1:${port}/api/assets?project=default&limit=10`);
  assert.equal(stillWorks.status, 200);
});

async function waitForServerPort(server) {
  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");
  return new Promise((resolvePort, rejectPort) => {
    let output = "";
    let errorOutput = "";
    const timer = setTimeout(() => finish(new Error("Timed out waiting for MOSA server startup.")), 5000);
    const onOutput = (chunk) => {
      output += chunk;
      const match = /MOSA: http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (match) finish(null, Number(match[1]));
    };
    const onErrorOutput = (chunk) => { errorOutput += chunk; };
    const onExit = () => finish(new Error(`MOSA server exited during startup.${errorOutput ? `\n${errorOutput}` : ""}`));
    const finish = (error, port) => {
      clearTimeout(timer);
      server.stdout.off("data", onOutput);
      server.stderr.off("data", onErrorOutput);
      server.off("exit", onExit);
      if (error) rejectPort(error);
      else resolvePort(port);
    };
    server.stdout.on("data", onOutput);
    server.stderr.on("data", onErrorOutput);
    server.once("exit", onExit);
  });
}

async function waitForServer(port, server) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("MOSA server exited during startup.");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/bridges`);
      if (response.ok) return;
    } catch {
      // The listener may not be ready yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("Timed out waiting for MOSA server startup.");
}

async function waitForResponse(url) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await fetch(url);
    if (response.status !== 404) return response;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
