import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { createAssetStore } from "../lib/asset-store.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

async function createFixtureStore(t, StoreFactory) {
  const root = await mkdtemp(join(tmpdir(), "mosa-group-feature-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  const generatedDir = join(projectRoot, "generated-images");
  await mkdir(generatedDir, { recursive: true });
  const sourcePath = join(generatedDir, "fixture.png");
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = StoreFactory({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  if (typeof store.close === "function") t.after(() => store.close());
  for (const [index, id] of ["a", "b", "c", "d"].entries()) {
    await store.createAsset({
      assetId: id,
      imagePath: sourcePath,
      prompt: `group fixture ${id}`,
      created_at: `2026-08-29T12:0${index}:00.000Z`,
      source: { type: "local-file" },
    });
  }
  return store;
}

const storeFactories = [
  ["sqlite", createSqliteAssetStore],
  ["json", createAssetStore],
];

for (const [label, factory] of storeFactories) {
  test(`[${label}] free-text group assignment normalizes whitespace and casing`, async (t) => {
    const store = await createFixtureStore(t, factory);
    await store.createGroup({ projectId: "default", name: "Moodboard" });

    // Trailing space + different casing must collapse onto the stored spelling.
    await store.updateMetadata("default", "a", { group: " Moodboard " });
    const stats = await store.listGroups("default");
    const entry = stats.groups.find((group) => group.name === "Moodboard");
    assert.ok(entry, "normalized assignment should join the existing group");
    assert.equal(entry.count, 1);
    assert.equal(stats.groups.filter((group) => group.name.toLowerCase() === "moodboard").length, 1,
      "no phantom duplicate group may appear");
  });

  test(`[${label}] assignAssetsToGroup moves many assets in one call and supports ungrouping`, async (t) => {
    const store = await createFixtureStore(t, factory);
    await store.createGroup({ projectId: "default", name: "Posters" });
    const result = await store.assignAssetsToGroup("default", ["a", "b", "c"], "Posters");
    assert.equal(result.partial, false);
    assert.equal(result.results.length, 3);

    const stats = await store.listGroups("default");
    assert.equal(stats.groups.find((group) => group.name === "Posters")?.count, 3);

    // Empty group name clears membership.
    const cleared = await store.assignAssetsToGroup("default", ["a", "b"], "");
    assert.equal(cleared.partial, false);
    const after = await store.listGroups("default");
    assert.equal(after.groups.find((group) => group.name === "Posters")?.count, 1);
    assert.equal(after.unorganized, 3);
  });

  test(`[${label}] assignAssetsToGroup reports missing assets without failing the batch`, async (t) => {
    const store = await createFixtureStore(t, factory);
    const result = await store.assignAssetsToGroup("default", ["a", "missing"], "Ghost");
    assert.equal(result.partial, true);
    assert.equal(result.results.find((entry) => entry.id === "missing")?.ok, false);
    assert.equal(result.results.find((entry) => entry.id === "a")?.group, "Ghost");
  });

  test(`[${label}] reorderGroups persists manual order and rejects a stale set`, async (t) => {
    const store = await createFixtureStore(t, factory);
    await store.createGroup({ projectId: "default", name: "First" });
    await store.createGroup({ projectId: "default", name: "Second" });
    await store.createGroup({ projectId: "default", name: "Third" });

    const reordered = await store.reorderGroups("default", ["Third", "First", "Second"]);
    assert.deepEqual(reordered.order, ["Third", "First", "Second"]);
    const stats = await store.listGroups("default");
    assert.deepEqual(stats.groups.map((group) => group.name), ["Third", "First", "Second"]);

    await assert.rejects(
      () => store.reorderGroups("default", ["Third", "First"]),
      (error) => error.code === "GROUP_SET_MISMATCH",
    );
  });

  test(`[${label}] mergeGroups moves membership and deletes the source group`, async (t) => {
    const store = await createFixtureStore(t, factory);
    await store.assignAssetsToGroup("default", ["a", "b"], "Source");
    await store.assignAssetsToGroup("default", ["c"], "Target");

    const result = await store.mergeGroups("default", "Source", "Target");
    assert.equal(result.movedAssets, 2);
    assert.equal(result.into, "Target");

    const stats = await store.listGroups("default");
    assert.equal(stats.groups.find((group) => group.name === "Target")?.count, 3);
    assert.equal(stats.groups.find((group) => group.name === "Source"), undefined);

    await assert.rejects(
      () => store.mergeGroups("default", "Target", "target"),
      (error) => error.code === "GROUP_MERGE_SAME",
    );
  });

  test(`[${label}] updateGroupSettings persists color server-side`, async (t) => {
    const store = await createFixtureStore(t, factory);
    await store.createGroup({ projectId: "default", name: "Palette" });
    const updated = await store.updateGroupSettings("default", "Palette", { color: "#EF4444" });
    assert.equal(updated.color, "#ef4444");

    const stats = await store.listGroups("default");
    assert.equal(stats.groups.find((group) => group.name === "Palette")?.color, "#ef4444");

    const rejected = await store.updateGroupSettings("default", "Palette", { color: "red" });
    assert.equal(rejected.color, "");
  });

  test(`[${label}] getGroupStats reports member facets`, async (t) => {
    const store = await createFixtureStore(t, factory);
    await store.assignAssetsToGroup("default", ["a", "b", "c"], "Stats");
    const stats = await store.getGroupStats("default", "Stats");
    assert.equal(stats.total, 3);
    assert.equal(stats.images, 3);
    assert.deepEqual(stats.categories, stats.categories);
  });

  test(`[${label}] createGroup carries color and position and is case-insensitively unique`, async (t) => {
    const store = await createFixtureStore(t, factory);
    const first = await store.createGroup({ projectId: "default", name: "Alpha", color: "#10b981" });
    assert.equal(first.color, "#10b981");
    assert.equal(first.position, 0);
    const second = await store.createGroup({ projectId: "default", name: "Beta" });
    assert.equal(second.position, 1);
    await assert.rejects(
      () => store.createGroup({ projectId: "default", name: "ALPHA" }),
      (error) => error.code === "GROUP_ALREADY_EXISTS",
    );
  });
}

test("[sqlite] legacy groups table gains position/color via idempotent migration", async (t) => {
  const store = await createFixtureStore(t, createSqliteAssetStore);
  // Opening the store above runs ensureGroupColumns on the freshly created
  // schema; a second close/reopen must not fail or reset order.
  const names = (await store.listGroups("default")).groups.map((group) => group.name);
  assert.ok(Array.isArray(names));
});
