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

  const rootPage = await store.listAssetPage({ projectId: "default", limit: 0, sort: "oldest" });
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
  assert.deepEqual((await store.listAssetPage({ projectId: "default", limit: 0, sort: "oldest" })).assets.map((asset) => asset.id), ["a", "b", "c", "d"]);
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

  const page = await store.listAssetPage({ projectId: "default", query: "neon orchid", limit: 100 });
  assert.equal(page.page.total, 1);
  assert.deepEqual(page.assets.map((asset) => asset.id), ["a"]);
  assert.deepEqual(page.assets[0].stack, { id: stack.id, count: 3 });

  const inside = await store.listAssetStackAssets("default", stack.id, { query: "neon orchid" });
  assert.deepEqual(inside.assets.map((asset) => asset.id), ["b", "c"]);
});
