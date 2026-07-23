import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import sharp from "sharp";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

test("MCP exposes recipe version creation, history, and structured errors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-mcp-versions-"));
  const libraryDir = join(root, "library");
  const imagePath = join(root, "generated-images", "fixture.png");
  const replacementPath = join(root, "generated-images", "replacement.png");
  await mkdir(join(root, "generated-images"), { recursive: true });
  await sharp({ create: { width: 8, height: 8, channels: 4, background: "#243047" } }).png().toFile(imagePath);
  await sharp({ create: { width: 8, height: 8, channels: 4, background: "#c43d38" } }).png().toFile(replacementPath);

  const store = createSqliteAssetStore({ projectRoot: root, managerDir: process.cwd(), libraryDir });
  await store.createAsset({ assetId: "root", imagePath, prompt: "original", style: "editorial" });
  await store.setMigrationState("completed", { test: true });
  store.close();

  const server = spawn(process.execPath, ["mcp/server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PROJECT_DIR: root,
      MOSA_LIBRARY_DIR: libraryDir,
      CODEX_GENERATED_IMAGES_DIR: join(root, "generated-images"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });

  const definitions = await callMcp(server, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tools = definitions.result.tools;
  const createDefinition = tools.find((tool) => tool.name === "asset_version_create");
  assert.deepEqual(createDefinition.inputSchema.required, ["assetId", "version_change"]);
  assert.ok(createDefinition.inputSchema.properties.imagePath);
  assert.ok(tools.some((tool) => tool.name === "asset_version_history"));

  const created = await callMcp(server, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "asset_version_create",
      arguments: {
        projectId: "default",
        assetId: "root",
        assetIdNew: "child",
        imagePath: replacementPath,
        version_change: "Warmer palette",
        prompt: "updated prompt",
        source: { generation_tool: "imagegen", model: "gpt-5.6" },
      },
    },
  });
  assert.equal(created.error, undefined);
  assert.equal(created.result.structuredContent.asset.id, "child");
  assert.equal(created.result.structuredContent.asset.parent_asset_id, "root");
  assert.equal(created.result.structuredContent.asset.source.path, replacementPath);
  assert.deepEqual(await readFile(created.result.structuredContent.asset.image_path), await readFile(replacementPath));
  assert.notDeepEqual(await readFile(created.result.structuredContent.asset.image_path), await readFile(imagePath));

  const history = await callMcp(server, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "asset_version_history", arguments: { projectId: "default", assetId: "child" } },
  });
  assert.equal(history.error, undefined);
  assert.deepEqual(history.result.structuredContent.history.versions.map((asset) => asset.id), ["root", "child"]);

  const invalid = await callMcp(server, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "asset_version_create", arguments: { projectId: "default", assetId: "root", version_change: " " } },
  });
  assert.equal(invalid.error, undefined);
  assert.equal(invalid.result.isError, true);
  assert.equal(invalid.result.structuredContent.error.code, "INVALID_VERSION_CHANGE");

  const bypass = await callMcp(server, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "asset_create",
      arguments: { projectId: "default", assetId: "bypass", imagePath: replacementPath, parent_asset_id: "root" },
    },
  });
  assert.equal(bypass.error, undefined);
  assert.equal(bypass.result.isError, true);
  assert.equal(bypass.result.structuredContent.error.code, "INVALID_VERSION_CHANGE");
});

function callMcp(server, request) {
  return new Promise((resolveResponse, rejectResponse) => {
    let buffer = "";
    const timeout = setTimeout(() => finish(new Error("Timed out waiting for the MOSA MCP response.")), 5000);
    const onData = (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const response = JSON.parse(line);
        if (response.id === request.id) {
          finish(null, response);
          return;
        }
      }
    };
    const onExit = () => finish(new Error("MOSA MCP exited before responding."));
    const finish = (error, response) => {
      clearTimeout(timeout);
      server.stdout.off("data", onData);
      server.off("exit", onExit);
      if (error) rejectResponse(error);
      else resolveResponse(response);
    };
    server.stdout.setEncoding("utf8");
    server.stdout.on("data", onData);
    server.once("exit", onExit);
    server.stdin.write(`${JSON.stringify(request)}\n`);
  });
}
