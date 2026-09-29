import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeAssetTimeRange, parseAssetTimeBound } from "../lib/asset-time-filter.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

test("asset time filters normalize inclusive ISO bounds", () => {
  const after = "2026-09-01T00:00:00.000Z";
  const before = "2026-09-30T23:59:59.999Z";
  assert.deepEqual(normalizeAssetTimeRange({ createdAfter: after, createdBefore: before }), {
    createdAfterMs: Date.parse(after),
    createdBeforeMs: Date.parse(before),
  });
});

test("asset time filters reject invalid and inverted ranges", () => {
  assert.throws(() => parseAssetTimeBound("not-a-date"), (error) => error?.code === "ASSET_TIME_FILTER_INVALID");
  assert.throws(() => normalizeAssetTimeRange({
    createdAfter: "2026-09-03T00:00:00.000Z",
    createdBefore: "2026-09-02T00:00:00.000Z",
  }), (error) => error?.code === "ASSET_TIME_RANGE_INVALID");
});

async function createStoreWithDatedAssets(t, root) {
  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir: join(root, "library") });
  t.after(() => store.close());
  await store.createAsset({ assetId: "aug-old", imagePath: sourcePath, created_at: "2026-08-01T00:00:00.000Z" });
  await store.createAsset({ assetId: "sep-mid", imagePath: sourcePath, created_at: "2026-09-10T00:00:00.000Z" });
  await store.createAsset({ assetId: "oct-new", imagePath: sourcePath, created_at: "2026-10-05T00:00:00.000Z" });
  return store;
}

test("gallery collapse view applies created-time bounds, not just the raw asset list", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-time-gallery-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const store = await createStoreWithDatedAssets(t, root);
  // A stack forces listAssetPage through the collapsed gallery path; without
  // one the raw path runs and would mask a fast-path regression.
  await store.createAssetStack("default", ["sep-mid", "oct-new"], { coverAssetId: "sep-mid" });

  const { createdAfterMs, createdBeforeMs } = normalizeAssetTimeRange({
    createdAfter: "2026-09-01T00:00:00.000Z",
    createdBefore: "2026-09-30T23:59:59.999Z",
  });
  const gallery = await store.listAssetPage({
    projectId: "default",
    collapseStacks: true,
    sort: "newest",
    createdAfterMs,
    createdBeforeMs,
  });
  const assetIds = gallery.assets.map((asset) => asset.id);
  assert.ok(!assetIds.includes("aug-old"), "assets created before the window are excluded in gallery view");
  assert.ok(!assetIds.includes("oct-new"), "assets created after the window are excluded in gallery view");
  assert.ok(assetIds.includes("sep-mid"), "assets inside the window survive in gallery view");

  const raw = await store.listAssetPage({ projectId: "default", sort: "newest", createdAfterMs, createdBeforeMs });
  assert.deepEqual(raw.assets.map((asset) => asset.id), ["sep-mid"], "raw list keeps the same time semantics");
});

test("gallery pagination cursors are bound to their created-time window", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-time-cursor-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const store = await createStoreWithDatedAssets(t, root);

  const september = normalizeAssetTimeRange({
    createdAfter: "2026-09-01T00:00:00.000Z",
    createdBefore: "2026-09-30T23:59:59.999Z",
  });
  const first = await store.listAssetPage({
    projectId: "default", sort: "newest", limit: 1, ...september,
  });
  assert.equal(first.assets.map((asset) => asset.id)[0], "sep-mid");
  assert.equal(first.page.nextCursor, null, "a fully consumed window has no next cursor");

  const wide = await store.listAssetPage({
    projectId: "default", sort: "newest", limit: 1,
  });
  assert.ok(wide.page.nextCursor, "the unfiltered window still paginates");
  await assert.rejects(
    store.listAssetPage({
      projectId: "default", sort: "newest", limit: 1, cursor: wide.page.nextCursor, ...september,
    }),
    (error) => error?.code === "INVALID_ASSET_CURSOR",
    "a cursor minted without time bounds must not resume inside a time window",
  );
});
