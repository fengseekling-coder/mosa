import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createDerivativeWorker, processDerivativeJob } from "../lib/derivative-worker.mjs";
import { createAssetStore } from "../lib/asset-store.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

test("SQLite store keeps archive, duplicate, version, and cursor contracts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-sqlite-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir: join(root, "library") });
  t.after(() => store.close());

  const parent = await store.createAsset({ assetId: "parent", imagePath: sourcePath, prompt: "red mechanical future city", group: "Ideas", tags: ["red", "future"] });
  await assert.rejects(store.createGroup({ projectId: "default", name: "ideas" }), /Group already exists/);
  await store.updateMetadata("default", parent.id, { style: "cyberpunk", favorite: true });
  const child = await store.createAsset({ assetId: "child", imagePath: sourcePath, prompt: "red mechanical future city variant", parent_asset_id: parent.id, version_change: "color pass" });
  const duplicate = await store.duplicateAsset("default", parent.id, { assetId: "parent-copy" });
  assert.equal(duplicate.source.duplicated_from, parent.id);

  const searched = await store.listAssetPage({ projectId: "default", query: "mechanical", limit: 2 });
  assert.equal(searched.assets.length, 2);
  assert.equal(searched.page.total, 3);
  assert.ok(searched.page.nextCursor);
  const secondPage = await store.listAssetPage({ projectId: "default", query: "mechanical", limit: 2, cursor: searched.page.nextCursor });
  assert.equal(secondPage.assets.length, 1);
  await assert.rejects(store.listAssetPage({ projectId: "default", cursor: Buffer.from("{}").toString("base64url") }), /Invalid asset cursor/);

  const updatedParent = await store.getAsset("default", parent.id);
  assert.equal(updatedParent.style, "cyberpunk");
  assert.deepEqual(updatedParent.child_asset_ids, [child.id]);
  await store.archiveAsset("default", duplicate.id);
  const active = await store.listAssets({ projectId: "default" });
  assert.deepEqual(active.map((asset) => asset.id).sort(), [child.id, parent.id].sort());
});

test("runtime storage selection cannot bypass migration completion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-storage-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const libraryDir = join(root, "library");

  const beforeMigration = createAssetStore({ projectRoot, managerDir, libraryDir, storage: "sqlite" });
  assert.equal(beforeMigration.storageKind, "json");
  const setup = createSqliteAssetStore({ projectRoot, managerDir, libraryDir });
  await setup.setMigrationState("completed", { verified: true });
  setup.close();
  const afterMigration = createAssetStore({ projectRoot, managerDir, libraryDir, storage: "json" });
  assert.equal(afterMigration.storageKind, "sqlite");
  afterMigration.close();
});

test("derivative job writes WebP previews without changing the original", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivatives-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "image.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await sharp({ create: { width: 1200, height: 800, channels: 4, background: { r: 12, g: 25, b: 40, alpha: 1 } } }).png().toFile(sourcePath);
  const before = await readFile(sourcePath);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir: join(root, "library") });
  t.after(() => store.close());

  const asset = await store.createAsset({ assetId: "image", imagePath: sourcePath, prompt: "A derivative test" });
  const job = await store.claimDerivativeJob();
  const result = await processDerivativeJob(store, job);
  assert.equal(result.ok, true);
  const updated = await store.getAsset("default", asset.id);
  assert.match(updated.thumbnail_url, /thumbnails\/image\.webp$/);
  assert.match(updated.preview_url, /previews\/image\.webp$/);
  const [thumbnail, preview] = await Promise.all([sharp(updated.thumbnail_path).metadata(), sharp(updated.preview_path).metadata()]);
  assert.equal(thumbnail.format, "webp");
  assert.ok(thumbnail.width <= 400 && thumbnail.height <= 400);
  assert.equal(preview.format, "webp");
  assert.ok(preview.width <= 1600 && preview.height <= 1600);
  assert.deepEqual(await readFile(sourcePath), before);

  const worker = createDerivativeWorker({ store });
  worker.start();
  worker.stop();
});
