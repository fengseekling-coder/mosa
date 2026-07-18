import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssetStore } from "../lib/asset-store.mjs";
import { createCowartAssetBridge, reconcileCowartAssets } from "../lib/cowart-bridge.mjs";

test("archives Cowart page assets once and keeps manager-origin images out", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "asset-manager-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "asset-manager");
  const canvasDir = join(root, "cowart-data", "asset-manager");
  const pageAssetsDir = join(canvasDir, "pages", "page", "assets");
  await mkdir(pageAssetsDir, { recursive: true });
  await writeFile(join(pageAssetsDir, "bear.png"), "fixture Cowart image", "utf8");
  await writeFile(join(pageAssetsDir, "from-library.png"), "fixture library image", "utf8");
  await writeFile(join(canvasDir, "pages", "page", "cowart-canvas.json"), JSON.stringify({
    store: {
      "asset:bear": { id: "asset:bear", typeName: "asset", type: "image", props: { name: "bear.png", src: "/page-assets/page/bear.png" }, meta: {} },
      "shape:bear": { id: "shape:bear", typeName: "shape", type: "image", props: { assetId: "asset:bear", w: 2160, h: 2160, altText: "草原背景的小熊" }, meta: { cowartGeneratedForAiImageHolder: "shape:holder" } },
      "asset:from-library": { id: "asset:from-library", typeName: "asset", type: "image", props: { name: "from-library.png", src: "/page-assets/page/from-library.png" }, meta: { assetManagerAssetId: "existing-library-asset" } },
    },
  }), "utf8");

  const store = createAssetStore({ projectRoot, managerDir, cowartCanvasDir: canvasDir });
  const first = await reconcileCowartAssets({ store, canvasDir });
  assert.equal(first.imported.length, 1);
  assert.equal(first.skipped.length, 1);
  assert.equal(first.imported[0].source.cowart_shape_id, "shape:bear");
  assert.equal(first.imported[0].source.replaced_ai_image_holder, "shape:holder");
  assert.equal(first.imported[0].ratio, "1:1");

  const second = await reconcileCowartAssets({ store, canvasDir });
  assert.equal(second.imported.length, 0);
  assert.equal(second.skipped.filter((item) => item.reason === "already-archived").length, 1);
});

test("watches a Cowart page directory and archives a later image", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "asset-manager-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "asset-manager");
  const canvasDir = join(root, "cowart-data", "asset-manager");
  const pageDir = join(canvasDir, "pages", "page");
  const pageAssetsDir = join(pageDir, "assets");
  await mkdir(pageAssetsDir, { recursive: true });
  await writeFile(join(pageDir, "cowart-canvas.json"), JSON.stringify({ store: {} }), "utf8");

  const store = createAssetStore({ projectRoot, managerDir, cowartCanvasDir: canvasDir });
  const bridge = createCowartAssetBridge({ store, canvasDir, debounceMs: 10, pollIntervalMs: 100 });
  t.after(() => bridge.stop());
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

async function waitFor(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Cowart bridge file watch.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
