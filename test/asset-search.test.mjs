import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assetSearchScore, compareAssetSearchResults } from "../lib/asset-search.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { removeTestPath as rm } from "./test-cleanup.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

test("asset search ranks identity fields above incidental prompt mentions", () => {
  const logo = {
    id: "mosa-logo",
    asset: "mosa-logo.png",
    tags: ["logo", "brand"],
    category: "branding",
    prompt: "minimal geometric logo for MOSA",
    created_at: "2026-01-01T00:00:00.000Z",
  };
  const poster = {
    id: "poster-newer",
    asset: "poster.png",
    tags: ["poster"],
    category: "poster",
    prompt: "editorial poster with a small logo in the lower corner",
    created_at: "2026-08-01T00:00:00.000Z",
  };

  assert.equal(assetSearchScore(poster, "logo"), 0,
    "a poster that only mentions logo incidentally is not a logo result");
  assert.ok(assetSearchScore(logo, "logo") > 0);
  assert.ok(compareAssetSearchResults("logo", "newest", logo, poster) < 0,
    "relevance wins even when the incidental poster is newer");
});

test("asset search keeps all query terms mandatory", () => {
  const partial = { asset: "logo.png", tags: ["logo"], prompt: "minimal mark" };
  const complete = { asset: "logo.png", tags: ["logo", "neon"], prompt: "neon logo" };
  assert.equal(assetSearchScore(partial, "neon logo"), 0);
  assert.ok(assetSearchScore(complete, "neon logo") > 0);
});

test("SQLite search paginates relevance-first without duplicates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-search-rank-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir: join(root, "library") });
  t.after(() => store.close());

  await store.createAsset({
    assetId: "poster-newer",
    imagePath: sourcePath,
    prompt: "editorial poster with a small logo in the lower corner",
    category: "poster",
    tags: ["poster"],
    created_at: "2026-08-01T00:00:00.000Z",
  });
  await store.createAsset({
    assetId: "logo-older",
    imagePath: sourcePath,
    prompt: "minimal identity mark",
    category: "branding",
    tags: ["logo"],
    created_at: "2026-01-01T00:00:00.000Z",
  });
  await store.createAsset({
    assetId: "logo-prompt-middle",
    imagePath: sourcePath,
    prompt: "logo logo exploration for a product identity",
    category: "branding",
    created_at: "2026-04-01T00:00:00.000Z",
  });

  const first = await store.listAssetPage({ projectId: "default", query: "logo", sort: "newest", limit: 2 });
  assert.equal(first.page.total, 2, "incidental poster mentions are excluded from logo search");
  assert.deepEqual(first.assets.map((asset) => asset.id), ["logo-older", "logo-prompt-middle"]);
  assert.equal(first.page.nextCursor, null);
});

test("FTS page cache is isolated per media kind filter", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-search-media-kind-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir: join(root, "library") });
  t.after(() => store.close());

  await store.createAsset({
    assetId: "kind-image",
    imagePath: sourcePath,
    prompt: "cat logo poster design",
  });
  await store.createAsset({
    assetId: "kind-video",
    imagePath: sourcePath,
    prompt: "cat logo video frame",
    source: { media_kind: "video" },
  });

  const images = await store.listAssetPage({ projectId: "default", query: "cat logo", mediaKind: "img" });
  const videos = await store.listAssetPage({ projectId: "default", query: "cat logo", mediaKind: "video" });
  assert.deepEqual(images.assets.map((asset) => asset.id), ["kind-image"],
    "image filter must return only the image asset");
  assert.deepEqual(videos.assets.map((asset) => asset.id), ["kind-video"],
    "video filter must not be served from the image filter's page cache");
});

test("short ASCII search terms keep page count consistent with results", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-search-short-term-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir: join(root, "library") });
  t.after(() => store.close());

  await store.createAsset({
    assetId: "short-term-match",
    imagePath: sourcePath,
    prompt: "ab hello world design",
  });
  await store.createAsset({
    assetId: "short-term-other",
    imagePath: sourcePath,
    prompt: "completely different thing",
  });

  const result = await store.listAssetPage({ projectId: "default", query: "ab hello" });
  assert.equal(result.assets.length, 1, "the LIKE page query still matches rows with short terms");
  assert.equal(result.page.total, 1,
    "the reported total must agree with the page instead of falling back to an FTS MATCH that cannot index 2-character terms");
});
