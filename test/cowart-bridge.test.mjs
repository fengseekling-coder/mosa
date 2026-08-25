import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssetStore } from "../lib/asset-store.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { createCowartAssetBridge, reconcileCowartAssets } from "../lib/cowart-bridge.js";

test("archives Cowart page assets once and keeps MOSA-origin images out", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const canvasDir = join(root, "cowart-data", "mosa");
  const pageAssetsDir = join(canvasDir, "pages", "page", "assets");
  await mkdir(pageAssetsDir, { recursive: true });
  await writeFile(join(pageAssetsDir, "bear.png"), "fixture Cowart image", "utf8");
  await writeFile(join(pageAssetsDir, "from-library.png"), "fixture library image", "utf8");
  await writeFile(join(canvasDir, "pages", "page", "cowart-canvas.json"), JSON.stringify({
    store: {
      "asset:bear": { id: "asset:bear", typeName: "asset", type: "image", props: { name: "bear.png", src: "/page-assets/page/bear.png" }, meta: {} },
      "shape:bear": { id: "shape:bear", typeName: "shape", type: "image", props: { assetId: "asset:bear", w: 2160, h: 2160, altText: "草原背景的小熊" }, meta: { cowartGeneratedForAiImageHolder: "shape:holder", cowartAnnotationSourceShapeId: "shape:source" } },
      "asset:from-library": { id: "asset:from-library", typeName: "asset", type: "image", props: { name: "from-library.png", src: "/page-assets/page/from-library.png" }, meta: { mosaAssetId: "existing-library-asset" } },
    },
  }), "utf8");

  const store = createAssetStore({ projectRoot, managerDir, cowartCanvasDir: canvasDir });
  const first = await reconcileCowartAssets({ store, canvasDir });
  assert.equal(first.imported.length, 1);
  assert.equal(first.skipped.length, 1);
  assert.equal(first.imported[0].source.cowart_shape_id, "shape:bear");
  assert.equal(first.imported[0].source.replaced_ai_image_holder, "shape:holder");
  assert.equal(first.imported[0].source.cowart_annotation_source_shape_id, "shape:source");
  assert.equal(first.imported[0].ratio, "1:1");

  await store.archiveAsset("default", first.imported[0].id);
  const second = await reconcileCowartAssets({ store, canvasDir });
  assert.equal(second.imported.length, 0);
  assert.equal(second.skipped.filter((item) => item.reason === "already-archived").length, 1);
});

test("continues Cowart reconciliation after one asset import fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-import-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const canvasDir = join(root, "cowart-data", "mosa");
  const pageDir = join(canvasDir, "pages", "page");
  const pageAssetsDir = join(pageDir, "assets");
  const failedPath = join(pageAssetsDir, "a-fails.png");
  const succeedingPath = join(pageAssetsDir, "b-succeeds.png");
  await mkdir(pageAssetsDir, { recursive: true });
  await writeFile(failedPath, "fixture failed Cowart image", "utf8");
  await writeFile(succeedingPath, "fixture succeeding Cowart image", "utf8");
  await writeFile(join(pageDir, "cowart-canvas.json"), JSON.stringify({
    store: {
      "asset:a-fails": { id: "asset:a-fails", typeName: "asset", type: "image", props: { name: "a-fails.png", src: "/page-assets/page/a-fails.png" }, meta: {} },
      "shape:a-fails": { id: "shape:a-fails", typeName: "shape", type: "image", props: { assetId: "asset:a-fails", w: 100, h: 100, altText: "失败候选" }, meta: {} },
      "asset:b-succeeds": { id: "asset:b-succeeds", typeName: "asset", type: "image", props: { name: "b-succeeds.png", src: "/page-assets/page/b-succeeds.png" }, meta: {} },
      "shape:b-succeeds": { id: "shape:b-succeeds", typeName: "shape", type: "image", props: { assetId: "asset:b-succeeds", w: 100, h: 100, altText: "继续归档候选" }, meta: {} },
    },
  }), "utf8");

  const createCalls = [];
  const createOptions = [];
  const store = {
    cowartCanvasDir: canvasDir,
    async listAssets() { return []; },
    async createAsset(params, options) {
      createCalls.push(params.imagePath);
      createOptions.push(options);
      if (params.imagePath === failedPath) throw new Error("fixture import failure");
      return { id: "succeeded", image_path: params.imagePath };
    },
  };

  const result = await reconcileCowartAssets({ store, canvasDir });
  assert.deepEqual(createCalls, [failedPath, succeedingPath]);
  assert.deepEqual(createOptions, [
    { trustedSourceRoots: [join(canvasDir, "pages")], ingestMode: "automatic" },
    { trustedSourceRoots: [join(canvasDir, "pages")], ingestMode: "automatic" },
  ]);
  assert.deepEqual(result.skipped, [{ path: failedPath, reason: "import-failed" }]);
  assert.deepEqual(result.imported, [{ id: "succeeded", image_path: succeedingPath }]);
});

test("skips a suppressed Cowart asset and continues to the next candidate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-suppressed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canvasDir = join(root, "cowart-data", "mosa");
  const pageDir = join(canvasDir, "pages", "page");
  const pageAssetsDir = join(pageDir, "assets");
  const firstPath = join(pageAssetsDir, "a-suppressed.png");
  const secondPath = join(pageAssetsDir, "b-imported.png");
  await mkdir(pageAssetsDir, { recursive: true });
  await writeFile(firstPath, "fixture suppressed Cowart image", "utf8");
  await writeFile(secondPath, "fixture imported Cowart image", "utf8");
  await writeFile(join(pageDir, "cowart-canvas.json"), JSON.stringify({
    store: {
      "asset:a-suppressed": { id: "asset:a-suppressed", typeName: "asset", type: "image", props: { name: "a-suppressed.png", src: "/page-assets/page/a-suppressed.png" }, meta: {} },
      "shape:a-suppressed": { id: "shape:a-suppressed", typeName: "shape", type: "image", props: { assetId: "asset:a-suppressed", w: 100, h: 100, altText: "已删除后抑制" }, meta: {} },
      "asset:b-imported": { id: "asset:b-imported", typeName: "asset", type: "image", props: { name: "b-imported.png", src: "/page-assets/page/b-imported.png" }, meta: {} },
      "shape:b-imported": { id: "shape:b-imported", typeName: "shape", type: "image", props: { assetId: "asset:b-imported", w: 100, h: 100, altText: "继续归档" }, meta: {} },
    },
  }), "utf8");

  const calls = [];
  const store = {
    cowartCanvasDir: canvasDir,
    async listAssets() { return []; },
    async createAsset(params, options) {
      calls.push({ params, options });
      if (params.imagePath === firstPath) throw Object.assign(new Error("suppressed"), { code: "AUTOMATIC_IMPORT_SUPPRESSED" });
      return { id: "cowart-imported", image_path: params.imagePath };
    },
  };

  const result = await reconcileCowartAssets({ store, canvasDir });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.options), [
    { trustedSourceRoots: [join(canvasDir, "pages")], ingestMode: "automatic" },
    { trustedSourceRoots: [join(canvasDir, "pages")], ingestMode: "automatic" },
  ]);
  assert.deepEqual(result.skipped, [{ path: firstPath, reason: "suppressed-after-delete" }]);
  assert.deepEqual(result.imported, [{ id: "cowart-imported", image_path: secondPath }]);
});

test("watches a Cowart page directory and archives a later image", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-"));

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const canvasDir = join(root, "cowart-data", "mosa");
  const pageDir = join(canvasDir, "pages", "page");
  const pageAssetsDir = join(pageDir, "assets");
  await mkdir(pageAssetsDir, { recursive: true });
  await writeFile(join(pageDir, "cowart-canvas.json"), JSON.stringify({ store: {} }), "utf8");

  const store = createAssetStore({ projectRoot, managerDir, cowartCanvasDir: canvasDir });
  const bridge = createCowartAssetBridge({ store, canvasDir, debounceMs: 10, pollIntervalMs: 100 });
  t.after(async () => { await bridge.stop(); await rm(root, { recursive: true, force: true }); });
  await bridge.start();

  await writeFile(join(pageAssetsDir, "watch-bear.png"), "fixture watched Cowart image", "utf8");
  await writeFile(join(pageDir, "cowart-canvas.json"), JSON.stringify({
    store: {
      "asset:watch-bear": { id: "asset:watch-bear", typeName: "asset", type: "image", props: { name: "watch-bear.png", src: "/page-assets/page/watch-bear.png" }, meta: {} },
      "shape:watch-bear": { id: "shape:watch-bear", typeName: "shape", type: "image", props: { assetId: "asset:watch-bear", w: 2160, h: 2160, altText: "自动归档测试图" }, meta: {} },
    },
  }), "utf8");

  await waitFor(() => bridge.status().totalImported === 1);
  const assets = await store.listAssets({ projectId: "default" });
  assert.equal(assets.length, 1);
  assert.equal(assets[0].source.cowart_shape_id, "shape:watch-bear");
});

test("waits for an active Cowart archive before cleanup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-stop-"));
  const canvasDir = join(root, "cowart-data", "mosa");
  const pageDir = join(canvasDir, "pages", "page");
  const pageAssetsDir = join(pageDir, "assets");
  let allowCreate;
  let signalCreate;
  const createStarted = new Promise((resolve) => { signalCreate = resolve; });
  const store = {
    cowartCanvasDir: canvasDir,
    async listAssets() { return []; },
    async createAsset() { signalCreate(); await new Promise((resolve) => { allowCreate = resolve; }); return {}; },
  };
  const bridge = createCowartAssetBridge({ store, canvasDir, debounceMs: 0, pollIntervalMs: 60_000 });
  t.after(async () => { await bridge.stop(); await rm(root, { recursive: true, force: true }); });
  await mkdir(pageAssetsDir, { recursive: true });
  await writeFile(join(pageDir, "cowart-canvas.json"), JSON.stringify({ store: {} }), "utf8");
  await bridge.start();

  await writeFile(join(pageAssetsDir, "stop-bear.png"), "fixture watched Cowart image", "utf8");
  await writeFile(join(pageDir, "cowart-canvas.json"), JSON.stringify({
    store: {
      "asset:stop-bear": { id: "asset:stop-bear", typeName: "asset", type: "image", props: { name: "stop-bear.png", src: "/page-assets/page/stop-bear.png" }, meta: {} },
      "shape:stop-bear": { id: "shape:stop-bear", typeName: "shape", type: "image", props: { assetId: "asset:stop-bear", w: 2160, h: 2160, altText: "停止时正在归档" }, meta: {} },
    },
  }), "utf8");

  const reconciling = bridge.reconcile();
  await createStarted;
  let stopped = false;
  const stopping = bridge.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopped, false, "stop waits for the active asset archive");
  allowCreate();
  await reconciling;
  await stopping;
  assert.equal(bridge.status().enabled, false);
});

test("archives a registered external Cowart canvas through the SQLite store only within its pages root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-sqlite-external-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const projectRoot = join(root, "workspace");
  const managerDir = join(projectRoot, "mosa");
  const cowartProjectDir = join(root, "external-project");
  const canvasDir = join(cowartProjectDir, "canvas");
  const pageDir = join(canvasDir, "pages", "page");
  const imagePath = join(pageDir, "assets", "external.png");
  await mkdir(join(pageDir, "assets"), { recursive: true });
  await writeFile(imagePath, "fixture external Cowart image", "utf8");
  await writeFile(join(pageDir, "cowart-canvas.json"), JSON.stringify({
    store: {
      "asset:external": { id: "asset:external", typeName: "asset", type: "image", props: { name: "external.png", src: "/page-assets/page/external.png" }, meta: {} },
      "shape:external": { id: "shape:external", typeName: "shape", type: "image", props: { assetId: "asset:external", w: 1200, h: 800, altText: "External Cowart image" }, meta: {} },
    },
  }), "utf8");

  const store = createSqliteAssetStore({ projectRoot, managerDir, libraryDir: join(root, "library") });
  t.after(() => store.close());
  await assert.rejects(store.createAsset({ imagePath }), /Refusing to import outside the project roots/);

  const result = await reconcileCowartAssets({
    store,
    canvasDir,
    cowartProjectDir,
    sourceId: "registered-external-project",
  });
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].source.cowart_project_dir, cowartProjectDir);
  assert.equal(result.imported[0].source.cowart_source_id, "registered-external-project");
});

async function waitFor(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Cowart bridge file watch.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
