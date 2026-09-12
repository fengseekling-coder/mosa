import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { cp, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { finalizeCopiedSqliteLibrary } from "../lib/library-relocation.mjs";
import { createSqliteAssetStore, sqliteDatabasePath } from "../lib/sqlite-asset-store.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

test("library relocation rebases managed SQLite paths before the old library is removed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-library-relocation-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sourceLibraryDir = join(root, "source-library");
  const destinationLibraryDir = join(root, "destination-library");
  const importSource = join(root, "incoming.png");
  await writeFile(importSource, ONE_PIXEL_PNG);

  const sourceStore = createSqliteAssetStore({
    projectRoot: root,
    managerDir: root,
    libraryDir: sourceLibraryDir,
    initializeFreshLibrary: true,
  });
  const created = await sourceStore.createAsset({
    projectId: "default",
    assetId: "relocated",
    imagePath: importSource,
    prompt: "relocation fixture",
    source: { type: "local-file", source_path: importSource },
  });
  const oldOriginal = created.image_path;
  sourceStore.close();

  await cp(sourceLibraryDir, destinationLibraryDir, { recursive: true });
  const finalized = await finalizeCopiedSqliteLibrary({ sourceLibraryDir, destinationLibraryDir });
  assert.equal(finalized.checkedAssets, 1);
  assert.equal(finalized.updatedAssets, 1);

  const copiedDb = new Database(sqliteDatabasePath(destinationLibraryDir), { readonly: true });
  const copiedRow = copiedDb.prepare("SELECT original_path, source_path FROM assets WHERE project_id = 'default' AND id = 'relocated'").get();
  copiedDb.close();
  assert.equal(copiedRow.original_path.startsWith(resolve(destinationLibraryDir)), true);
  assert.equal(copiedRow.source_path, importSource, "external provenance paths must not be rebased");
  assert.equal(copiedRow.original_path.startsWith(resolve(sourceLibraryDir)), false);
  assert.equal((await readFile(copiedRow.original_path)).equals(ONE_PIXEL_PNG), true);

  await rm(sourceLibraryDir, { recursive: true, force: true });
  await assert.rejects(stat(oldOriginal), /ENOENT/);
  const relocatedStore = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir: destinationLibraryDir });
  t.after(() => relocatedStore.close());
  const relocated = await relocatedStore.getAsset("default", "relocated");
  assert.equal(relocated.image_path, copiedRow.original_path);
  assert.equal((await relocatedStore.verifyLibrary()).ok, true);

  const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(relocated.image_path, staleTime, staleTime);
  const cleanup = await relocatedStore.cleanupOrphanedManagedFiles({ olderThanMs: 24 * 60 * 60 * 1000 });
  assert.equal(cleanup.removed, 0, "the authoritative relocated original remains referenced");
  assert.equal((await stat(relocated.image_path)).isFile(), true);
});

test("managed-file cleanup fails closed when database paths do not belong to the active library", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-library-path-guard-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  const importSource = join(root, "incoming.png");
  await mkdir(libraryDir, { recursive: true });
  await writeFile(importSource, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir, initializeFreshLibrary: true });
  const created = await store.createAsset({ projectId: "default", assetId: "guarded", imagePath: importSource });
  store.close();

  const database = new Database(sqliteDatabasePath(libraryDir));
  database.prepare("UPDATE assets SET original_path = ? WHERE project_id = 'default' AND id = 'guarded'")
    .run(join(root, "stale-library", "assets", "default", "original", "guarded.png"));
  database.close();

  const guardedStore = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => guardedStore.close());
  const orphan = join(guardedStore.imagesDir("default"), "old-orphan.png");
  await writeFile(orphan, "orphan");
  const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await Promise.all([utimes(created.image_path, staleTime, staleTime), utimes(orphan, staleTime, staleTime)]);

  const cleanup = await guardedStore.cleanupOrphanedManagedFiles({ olderThanMs: 24 * 60 * 60 * 1000 });
  assert.deepEqual(cleanup, { removed: 0, failed: 0, skipped: true, reason: "managed-path-integrity" });
  assert.equal((await stat(orphan)).isFile(), true, "cleanup must delete nothing while managed path integrity is broken");
  assert.equal((await stat(created.image_path)).isFile(), true);
});
