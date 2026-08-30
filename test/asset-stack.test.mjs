import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

async function createFixtureStore(t) {
  const root = await mkdtemp(join(tmpdir(), "mosa-asset-stack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  const generatedDir = join(projectRoot, "generated-images");
  await mkdir(generatedDir, { recursive: true });
  const sourcePath = join(generatedDir, "fixture.png");
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => store.close());
  for (const [index, id] of ["a", "b", "c", "d"].entries()) {
    await store.createAsset({
      assetId: id,
      imagePath: sourcePath,
      prompt: `stack fixture ${id}`,
      created_at: `2026-08-29T12:0${index}:00.000Z`,
      source: { type: "local-file" },
    });
  }
  return store;
}

test("asset stacks collapse to one gallery node and use the first member as cover", async (t) => {
  const store = await createFixtureStore(t);
  const stack = await store.createAssetStack("default", ["a", "b", "c"], { coverAssetId: "b" });
  assert.equal(stack.count, 3);
  assert.equal(stack.cover_asset_id, "b");

  const rootPage = await store.listAssetPage({ projectId: "default", limit: 0, sort: "oldest", collapseStacks: true });
  assert.deepEqual(rootPage.assets.map((asset) => asset.id), ["b", "d"]);
  assert.deepEqual(rootPage.assets[0].stack, { id: stack.id, count: 3 });

  const allAssets = await store.listAssets({ projectId: "default", sort: "oldest" });
  assert.deepEqual(allAssets.map((asset) => asset.id), ["a", "b", "c", "d"]);

  const inside = await store.listAssetStackAssets("default", stack.id);
  assert.deepEqual(inside.assets.map((asset) => asset.id), ["b", "a", "c"]);
  assert.deepEqual(inside.assets.map((asset) => asset.stack_position), [0, 1, 2]);
});

test("reordering changes the cover, adding appends, and one remaining member dissolves automatically", async (t) => {
  const store = await createFixtureStore(t);
  const stack = await store.createAssetStack("default", ["a", "b", "c"], { coverAssetId: "b" });

  const reordered = await store.reorderAssetStack("default", stack.id, ["c", "b", "a"]);
  assert.equal(reordered.cover_asset_id, "c");
  await store.addAssetsToStack("default", stack.id, ["d"]);
  assert.deepEqual((await store.listAssetStackAssets("default", stack.id)).assets.map((asset) => asset.id), ["c", "b", "a", "d"]);

  const removal = await store.removeAssetsFromStack("default", stack.id, ["c", "b", "d"]);
  assert.equal(removal.dissolved, true);
  assert.equal(removal.remainingAssetId, "a");
  assert.deepEqual((await store.listAssetPage({ projectId: "default", limit: 0, sort: "oldest", collapseStacks: true })).assets.map((asset) => asset.id), ["a", "b", "c", "d"]);
});

test("archiving a stack member compacts the stack and promotes a new cover", async (t) => {
  const store = await createFixtureStore(t);
  const stack = await store.createAssetStack("default", ["a", "b", "c"], { coverAssetId: "b" });
  await store.archiveAsset("default", "b");
  const summary = await store.getAssetStack("default", stack.id);
  assert.equal(summary.count, 2);
  assert.equal(summary.cover_asset_id, "a");
  assert.deepEqual((await store.listAssetStackAssets("default", stack.id)).assets.map((asset) => asset.id), ["a", "c"]);
});

test("root search maps hidden member matches back to one stack cover node", async (t) => {
  const store = await createFixtureStore(t);
  await store.updateMetadata("default", "b", { prompt: "neon orchid hidden member" });
  await store.updateMetadata("default", "c", { prompt: "neon orchid second hidden member" });
  const stack = await store.createAssetStack("default", ["a", "b", "c"], { coverAssetId: "a" });

  const page = await store.listAssetPage({ projectId: "default", query: "neon orchid", limit: 100, collapseStacks: true });
  assert.equal(page.page.total, 1);
  assert.deepEqual(page.assets.map((asset) => asset.id), ["a"]);
  assert.deepEqual(page.assets[0].stack, { id: stack.id, count: 3 });

  const inside = await store.listAssetStackAssets("default", stack.id, { query: "neon orchid" });
  assert.deepEqual(inside.assets.map((asset) => asset.id), ["b", "c"]);
});

test("root and Stack-interior searches share the same asset-kind intent semantics", async (t) => {
  const store = await createFixtureStore(t);
  await store.updateMetadata("default", "b", { prompt: "logo mark exploration" });
  await store.updateMetadata("default", "c", { prompt: "poster layout exploration" });
  const stack = await store.createAssetStack("default", ["a", "b", "c"], { coverAssetId: "a" });

  const rootLogo = await store.listAssetPage({ projectId: "default", query: "logo", collapseStacks: true, limit: 100 });
  assert.deepEqual(rootLogo.assets.map((asset) => asset.id), ["a"]);
  assert.deepEqual(rootLogo.assets[0].stack, { id: stack.id, count: 3 });

  const insideLogo = await store.listAssetStackAssets("default", stack.id, { query: "logo" });
  assert.deepEqual(insideLogo.assets.map((asset) => asset.id), ["b"]);
  const insidePoster = await store.listAssetStackAssets("default", stack.id, { query: "poster" });
  assert.deepEqual(insidePoster.assets.map((asset) => asset.id), ["c"]);
});

test("gallery filters match hidden members while raw asset queries keep every member", async (t) => {
  const store = await createFixtureStore(t);
  const sourcePath = (await store.getAsset("default", "a")).image_path;
  await store.createAsset({
    assetId: "hidden-flow-video",
    imagePath: sourcePath,
    prompt: "hidden flow video",
    favorite: true,
    created_at: "2026-08-29T12:01:30.000Z",
    source: { type: "web-flow", media_kind: "video" },
  });
  const stack = await store.createAssetStack("default", ["a", "hidden-flow-video"], { coverAssetId: "a" });

  for (const filters of [
    { source: "web-flow" },
    { favorite: true },
    { mediaKind: "video" },
    { source: "web-flow", query: "hidden flow" },
  ]) {
    const page = await store.listAssetPage({ projectId: "default", collapseStacks: true, limit: 100, ...filters });
    assert.deepEqual(page.assets.map((asset) => asset.id), ["a"]);
    assert.deepEqual(page.assets[0].stack, { id: stack.id, count: 2 });
    assert.equal(page.page.total, 1);
  }

  const raw = await store.listAssetPage({ projectId: "default", source: "web-flow", limit: 100 });
  assert.deepEqual(raw.assets.map((asset) => asset.id), ["hidden-flow-video"]);
});

test("changing the first member changes the cover without moving the stack's gallery sort anchor", async (t) => {
  const store = await createFixtureStore(t);
  const sourcePath = (await store.getAsset("default", "a")).image_path;
  await store.createAsset({
    assetId: "between",
    imagePath: sourcePath,
    prompt: "between",
    created_at: "2026-08-29T12:01:30.000Z",
    source: { type: "local-file" },
  });
  const stack = await store.createAssetStack("default", ["a", "b", "c"], { coverAssetId: "b" });
  const before = await store.listAssetPage({ projectId: "default", collapseStacks: true, sort: "newest", limit: 0 });
  assert.deepEqual(before.assets.map((asset) => asset.id), ["d", "between", "b"]);

  const reordered = await store.reorderAssetStack("default", stack.id, ["c", "b", "a"]);
  assert.equal(reordered.cover_asset_id, "c");
  const after = await store.listAssetPage({ projectId: "default", collapseStacks: true, sort: "newest", limit: 0 });
  assert.deepEqual(after.assets.map((asset) => asset.id), ["d", "between", "c"]);
});
