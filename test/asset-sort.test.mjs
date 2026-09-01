import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJsonAssetStore } from "../lib/asset-store.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { normalizeAssetSort } from "../lib/asset-sort.js";
import { removeTestPath as rm } from "./test-cleanup.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

// Themes are deliberately out of chronological order so a name sort cannot pass
// by accidentally agreeing with the default order.
const FIXTURES = [
  { assetId: "asset-a", theme: "Zebra crossing", created_at: "2026-01-05T00:00:00.000Z" },
  { assetId: "asset-b", theme: "Alpine ridge", created_at: "2026-03-05T00:00:00.000Z" },
  { assetId: "asset-c", theme: "Meadow light", created_at: "2026-02-05T00:00:00.000Z" },
  { assetId: "asset-d", theme: "beacon dusk", created_at: "2026-05-05T00:00:00.000Z" },
  { assetId: "asset-e", theme: "Canyon wall", created_at: "2026-04-05T00:00:00.000Z" },
];

async function seed(store, sourcePath) {
  for (const fixture of FIXTURES) {
    await store.createAsset({ ...fixture, imagePath: sourcePath });
  }
}

async function makeRoot(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  return { root, projectRoot, sourcePath };
}

/** Walks every page so the assertion covers the whole query, not just page one. */
async function drain(store, filters) {
  const ids = [];
  let cursor;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await store.listAssetPage({ ...filters, cursor });
    ids.push(...page.assets.map((asset) => asset.id));
    if (!page.page.nextCursor) return { ids, sort: page.page.sort };
    cursor = page.page.nextCursor;
  }
  throw new Error("pagination did not terminate");
}

test("normalizeAssetSort accepts the documented orders and falls back to newest", () => {
  assert.equal(normalizeAssetSort("newest"), "newest");
  assert.equal(normalizeAssetSort("oldest"), "oldest");
  assert.equal(normalizeAssetSort("name"), "name");
  assert.equal(normalizeAssetSort("NAME"), "name");
  assert.equal(normalizeAssetSort(""), "newest");
  assert.equal(normalizeAssetSort("rating"), "newest");
  assert.equal(normalizeAssetSort(undefined), "newest");
});

for (const kind of ["sqlite", "json"]) {
  test(`${kind} store filters generation sessions and reliable batches with AND semantics`, async (t) => {
    const { root, projectRoot, sourcePath } = await makeRoot(t, `mosa-generation-filter-${kind}-`);
    const libraryDir = join(root, "library");
    const store = kind === "sqlite"
      ? createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir })
      : createJsonAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa") });
    if (kind === "sqlite") t.after(() => store.close());

    await store.createAsset({ assetId: "same-turn-a", imagePath: sourcePath, source: { type: "web-chatgpt", conversation_id: "conversation-a", message_id: "turn-1" } });
    await store.createAsset({ assetId: "same-turn-b", imagePath: sourcePath, source: { type: "web-chatgpt", conversation_id: "conversation-a", message_id: "turn-1" } });
    await store.createAsset({ assetId: "later-turn", imagePath: sourcePath, source: { type: "web-chatgpt", conversation_id: "conversation-a", message_id: "turn-2" } });
    await store.createAsset({ assetId: "legacy-session-only", imagePath: sourcePath, source: { type: "web-chatgpt", conversation_id: "conversation-a" } });
    await store.createAsset({ assetId: "same-turn-other-session", imagePath: sourcePath, source: { type: "web-chatgpt", conversation_id: "conversation-b", message_id: "turn-1" } });

    const session = await store.listAssets({ projectId: "default", conversation: "conversation-a" });
    assert.deepEqual(session.map((asset) => asset.id).sort(), ["later-turn", "legacy-session-only", "same-turn-a", "same-turn-b"]);

    const batch = await store.listAssets({ projectId: "default", conversation: "conversation-a", generationBatch: "turn-1" });
    assert.deepEqual(batch.map((asset) => asset.id).sort(), ["same-turn-a", "same-turn-b"]);
  });

  test(`${kind} store sorts the whole query, not just the loaded page`, async (t) => {
    const { root, projectRoot, sourcePath } = await makeRoot(t, `mosa-sort-${kind}-`);
    const libraryDir = join(root, "library");
    const store = kind === "sqlite"
      ? createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir })
      : createJsonAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa") });
    if (kind === "sqlite") t.after(() => store.close());
    await seed(store, sourcePath);

    const newest = await drain(store, { projectId: "default", sort: "newest", limit: 2 });
    assert.deepEqual(newest.ids, ["asset-d", "asset-e", "asset-b", "asset-c", "asset-a"]);
    assert.equal(newest.sort, "newest");

    const oldest = await drain(store, { projectId: "default", sort: "oldest", limit: 2 });
    assert.deepEqual(oldest.ids, ["asset-a", "asset-c", "asset-b", "asset-e", "asset-d"]);

    // Case-insensitive: "beacon dusk" must land between Alpine and Canyon.
    const byName = await drain(store, { projectId: "default", sort: "name", limit: 2 });
    assert.deepEqual(byName.ids, ["asset-b", "asset-d", "asset-e", "asset-c", "asset-a"]);

    // A missing sort keeps the historical default rather than changing behaviour.
    const untouched = await drain(store, { projectId: "default", limit: 2 });
    assert.deepEqual(untouched.ids, newest.ids);
  });

  test(`${kind} store paginates each order without dropping or repeating assets`, async (t) => {
    const { root, projectRoot, sourcePath } = await makeRoot(t, `mosa-sort-pages-${kind}-`);
    const libraryDir = join(root, "library");
    const store = kind === "sqlite"
      ? createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir })
      : createJsonAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa") });
    if (kind === "sqlite") t.after(() => store.close());
    await seed(store, sourcePath);

    for (const sort of ["newest", "oldest", "name"]) {
      for (const limit of [1, 2, 3]) {
        const { ids } = await drain(store, { projectId: "default", sort, limit });
        assert.equal(ids.length, FIXTURES.length, `${sort} @ limit ${limit} returned ${ids.length} assets`);
        assert.equal(new Set(ids).size, FIXTURES.length, `${sort} @ limit ${limit} repeated an asset`);
        const single = await store.listAssetPage({ projectId: "default", sort, limit: 0 });
        assert.deepEqual(ids, single.assets.map((asset) => asset.id), `${sort} @ limit ${limit} diverged from the unpaged order`);
      }
    }
  });

  test(`${kind} store rejects a cursor issued under a different sort`, async (t) => {
    const { root, projectRoot, sourcePath } = await makeRoot(t, `mosa-sort-cursor-${kind}-`);
    const libraryDir = join(root, "library");
    const store = kind === "sqlite"
      ? createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir })
      : createJsonAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa") });
    if (kind === "sqlite") t.after(() => store.close());
    await seed(store, sourcePath);

    const first = await store.listAssetPage({ projectId: "default", sort: "newest", limit: 2 });
    assert.ok(first.page.nextCursor);
    // Resuming a chronological cursor under a name sort would silently page from
    // the middle of an unrelated ordering, so it has to fail loudly instead.
    await assert.rejects(
      store.listAssetPage({ projectId: "default", sort: "name", limit: 2, cursor: first.page.nextCursor }),
      /Invalid asset cursor/,
    );
    const resumed = await store.listAssetPage({ projectId: "default", sort: "newest", limit: 2, cursor: first.page.nextCursor });
    assert.deepEqual(resumed.assets.map((asset) => asset.id), ["asset-b", "asset-c"]);
  });

  test(`${kind} store keeps sort independent of the other filters`, async (t) => {
    const { root, projectRoot, sourcePath } = await makeRoot(t, `mosa-sort-filters-${kind}-`);
    const libraryDir = join(root, "library");
    const store = kind === "sqlite"
      ? createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir })
      : createJsonAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa") });
    if (kind === "sqlite") t.after(() => store.close());
    await store.createAsset({ assetId: "keep-1", imagePath: sourcePath, theme: "Zulu", style: "poster", group: "Ideas", created_at: "2026-01-01T00:00:00.000Z" });
    await store.createAsset({ assetId: "keep-2", imagePath: sourcePath, theme: "Alpha", style: "poster", group: "Ideas", created_at: "2026-02-01T00:00:00.000Z" });
    await store.createAsset({ assetId: "skip-1", imagePath: sourcePath, theme: "Beta", style: "collage", group: "Ideas", created_at: "2026-03-01T00:00:00.000Z" });

    // Group and style AND together, and the sort applies to that filtered set.
    const filtered = await drain(store, { projectId: "default", group: "Ideas", style: "poster", sort: "name", limit: 1 });
    assert.deepEqual(filtered.ids, ["keep-2", "keep-1"]);

    const filteredNewest = await drain(store, { projectId: "default", group: "Ideas", style: "poster", sort: "newest", limit: 1 });
    assert.deepEqual(filteredNewest.ids, ["keep-2", "keep-1"]);

    const filteredOldest = await drain(store, { projectId: "default", group: "Ideas", style: "poster", sort: "oldest", limit: 1 });
    assert.deepEqual(filteredOldest.ids, ["keep-1", "keep-2"]);

    // A query narrows the same way and still respects the requested order.
    const searched = await drain(store, { projectId: "default", style: "poster", query: "Alpha", sort: "name", limit: 1 });
    assert.deepEqual(searched.ids, ["keep-2"]);
  });
}

test("SQLite name ordering survives a theme edit and reports the style facet total", async (t) => {
  const { root, projectRoot, sourcePath } = await makeRoot(t, "mosa-sort-rename-");
  const libraryDir = join(root, "library");
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => store.close());
  await seed(store, sourcePath);

  // The materialised sort key has to follow an ordinary metadata edit.
  await store.updateMetadata("default", "asset-a", { theme: "Aardvark" });
  const { ids } = await drain(store, { projectId: "default", sort: "name", limit: 2 });
  assert.equal(ids[0], "asset-a");

  const groups = await store.listGroups("default");
  assert.equal(groups.styleTotal, 0, "no styles were seeded");
  await store.updateMetadata("default", "asset-b", { style: "poster" });
  await store.updateMetadata("default", "asset-c", { style: "collage" });
  const withStyles = await store.listGroups("default");
  assert.equal(withStyles.styleTotal, 2);
  assert.equal(withStyles.styles.length, 2);
});
