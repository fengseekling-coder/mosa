import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

// Mixed-case names exist to pin the NOCASE retrieval order: apple < Banana < Zebra
// regardless of insertion order, exactly like the includeRelations path.
const MIXED_CASE_TAGS = ["Zebra", "apple", "Banana"];
const MIXED_CASE_TAGS_SORTED = ["apple", "Banana", "Zebra"];

async function createTagFixtureStore(t) {
  const root = await mkdtemp(join(tmpdir(), "mosa-list-tags-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  const generatedDir = join(projectRoot, "generated-images");
  await mkdir(generatedDir, { recursive: true });
  const sourcePath = join(generatedDir, "fixture.png");
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => store.close());
  for (const [index, id] of ["a", "b", "c"].entries()) {
    await store.createAsset({
      assetId: id,
      imagePath: sourcePath,
      prompt: `tag fixture ${id}`,
      created_at: `2026-08-29T12:0${index}:00.000Z`,
      source: { type: "local-file" },
    });
  }
  await store.updateMetadata("default", "a", { tags: MIXED_CASE_TAGS });
  await store.updateMetadata("default", "b", { tags: ["solo"] });
  // "c" stays untagged.
  // The Stack exists before any listing so the collapsed branches are live.
  const stack = await store.createAssetStack("default", ["a", "b"], { coverAssetId: "a" });
  return { store, stack };
}

test("every list endpoint returns tags identical to the includeRelations path", async (t) => {
  const { store, stack } = await createTagFixtureStore(t);
  const expected = {
    a: MIXED_CASE_TAGS_SORTED,
    b: ["solo"],
    c: [],
  };
  const expectedById = (asset) => expected[asset.id];

  const byId = {};
  for (const id of ["a", "b", "c"]) byId[id] = (await store.getAsset("default", id)).tags;
  assert.deepEqual(byId, expected, "getAsset defines the reference tag order");

  const assertListMatches = (label, assets) => {
    for (const asset of assets) {
      assert.deepEqual(asset.tags, expectedById(asset), `${label}: asset ${asset.id} tags`);
    }
  };

  // Plain list + paged list (listAssetPage, non-collapsed).
  assertListMatches("listAssets", await store.listAssets({ projectId: "default", sort: "oldest" }));
  const paged = await store.listAssetPage({ projectId: "default", sort: "oldest", limit: 2 });
  assert.deepEqual(paged.assets.map((asset) => asset.id), ["a", "b"]);
  assertListMatches("listAssetPage(limit)", paged.assets);
  const searched = await store.listAssetPage({ projectId: "default", sort: "oldest", limit: 0, query: "fixture" });
  assert.deepEqual(searched.assets.map((asset) => asset.id), ["a", "b", "c"]);
  assertListMatches("listAssetPage(query)", searched.assets);

  // Collapsed gallery: unbounded fast path.
  const collapsedFast = await store.listAssetPage({ projectId: "default", sort: "oldest", limit: 0, collapseStacks: true });
  assert.deepEqual(collapsedFast.assets.map((asset) => asset.id), ["a", "c"]);
  assertListMatches("collapsed fast", collapsedFast.assets);
  assert.deepEqual(collapsedFast.assets[0].tags, MIXED_CASE_TAGS_SORTED);

  // Collapsed gallery: bounded fast path (cursor pages).
  const collapsedBounded = await store.listAssetPage({ projectId: "default", sort: "oldest", limit: 1, collapseStacks: true });
  assert.deepEqual(collapsedBounded.assets.map((asset) => asset.id), ["a"]);
  assertListMatches("collapsed bounded", collapsedBounded.assets);

  // Collapsed gallery: search/facet branch.
  const collapsedSearched = await store.listAssetPage({ projectId: "default", sort: "oldest", limit: 0, collapseStacks: true, query: "fixture" });
  assert.deepEqual(collapsedSearched.assets.map((asset) => asset.id), ["a", "c"]);
  assertListMatches("collapsed searched", collapsedSearched.assets);

  // Stack member listing.
  const stackPage = await store.listAssetStackAssets("default", stack.id, { sort: "oldest" });
  assert.deepEqual(stackPage.assets.map((asset) => asset.id), ["a", "b"]);
  assertListMatches("listAssetStackAssets", stackPage.assets);

  // Incremental reconciliation: all three branches.
  const stackRows = await store.listGalleryRowsForAssets({ projectId: "default", stackId: stack.id, sort: "oldest" }, ["a", "b"]);
  assert.deepEqual(stackRows.rows.map((asset) => asset.id), ["a", "b"]);
  assertListMatches("listGalleryRowsForAssets(stack)", stackRows.rows);

  const collapseRows = await store.listGalleryRowsForAssets({ projectId: "default", collapseStacks: true, sort: "oldest" }, ["a", "b", "c"]);
  assert.deepEqual(collapseRows.rows.map((asset) => asset.id), ["a", "c"]);
  assertListMatches("listGalleryRowsForAssets(collapse)", collapseRows.rows);

  const plainRows = await store.listGalleryRowsForAssets({ projectId: "default", sort: "oldest" }, ["a", "b", "c"]);
  assert.deepEqual(plainRows.rows.map((asset) => asset.id), ["a", "b", "c"]);
  assertListMatches("listGalleryRowsForAssets(plain)", plainRows.rows);

  // The untagged asset must stay an empty array, never undefined/null.
  const untagged = (await store.listAssets({ projectId: "default", sort: "oldest" })).find((asset) => asset.id === "c");
  assert.ok(Array.isArray(untagged.tags));
  assert.equal(untagged.tags.length, 0);
});

test("editing tags from a list payload no longer wipes the stored tags", async (t) => {
  const { store, stack } = await createTagFixtureStore(t);
  const page = await store.listAssetPage({ projectId: "default", sort: "oldest", limit: 0 });
  const target = page.assets.find((asset) => asset.id === "a");
  assert.deepEqual(target.tags, MIXED_CASE_TAGS_SORTED, "precondition: the list carries the stored tags");

  // Frontend merge semantics: existing list tags + one new tag, saved back wholesale.
  const merged = [...target.tags, "brand-new"];
  await store.updateMetadata("default", "a", { tags: merged });

  const after = await store.getAsset("default", "a");
  assert.deepEqual(after.tags, ["apple", "Banana", "brand-new", "Zebra"]);

  const relisted = await store.listAssetPage({ projectId: "default", sort: "oldest", limit: 0 });
  assert.deepEqual(relisted.assets.find((asset) => asset.id === "a").tags, after.tags);
});
