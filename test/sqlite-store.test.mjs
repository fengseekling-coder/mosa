import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createDerivativeWorker, processDerivativeJob } from "../lib/derivative-worker.mjs";
import { createAssetStore } from "../lib/asset-store.mjs";
import { normalizeCreatedAt } from "../lib/recent-window.mjs";
import { createSqliteAssetStore, sqliteDatabasePath } from "../lib/sqlite-asset-store.mjs";

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
  assert.equal(Object.hasOwn(searched.assets[0], "recipe_snapshots"), false, "gallery rows keep heavyweight recipe relations lazy");
  assert.equal(Object.hasOwn(searched.assets[0], "child_asset_ids"), true);
  assert.deepEqual(searched.assets[0].child_asset_ids, []);
  assert.equal(Array.isArray((await store.getAsset("default", parent.id)).recipe_snapshots), true, "asset details still include recipe history");
  const secondPage = await store.listAssetPage({ projectId: "default", query: "mechanical", limit: 2, cursor: searched.page.nextCursor });
  assert.equal(secondPage.assets.length, 1);
  assert.equal(secondPage.page.total, 3, "FTS cursor pages retain the total before the cursor");
  await assert.rejects(store.listAssetPage({ projectId: "default", cursor: Buffer.from("{}").toString("base64url") }), /Invalid asset cursor/);

  const updatedParent = await store.getAsset("default", parent.id);
  assert.equal(updatedParent.style, "cyberpunk");
  assert.deepEqual(updatedParent.child_asset_ids, [child.id]);
  await store.archiveAsset("default", duplicate.id);
  const active = await store.listAssets({ projectId: "default" });
  assert.deepEqual(active.map((asset) => asset.id).sort(), [child.id, parent.id].sort());
  const activeSearch = await store.listAssetPage({ projectId: "default", query: "mechanical", limit: 2 });
  assert.equal(activeSearch.page.total, 2, "an archived match invalidates the cached FTS count");
});

test("SQLite recipe snapshots change only with generation inputs and remain immutable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-recipes-sqlite-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({
    projectRoot,
    managerDir: join(projectRoot, "mosa"),
    libraryDir: join(root, "library"),
  });
  t.after(() => store.close());

  const asset = await store.createAsset({
    assetId: "recipe-fixture",
    imagePath: sourcePath,
    prompt: "A red city at dusk",
    negative_prompt: "text, watermark",
    references: [{ asset_id: "moodboard", sha256: "b".repeat(64), role: "palette" }],
    source: {
      generation_tool: "imagegen",
      model: "gpt-image-1",
      prompt_status: "generation-tool-prompt",
      codex_task_id: "task-1",
    },
  });
  const initialHistory = await store.getRecipeSnapshotHistory("default", asset.id);
  assert.equal(initialHistory.snapshots.length, 1);
  // The SQLite twin of the JSON pinned shape. SQLite returns snapshot rows
  // directly rather than through ensureRecipeSnapshots, so without read-time
  // normalisation a row would come back with no rights fields at all and the
  // two stores would disagree on the backend production actually uses.
  assert.deepEqual(initialHistory.snapshots[0].references, [{
    asset_id: "moodboard",
    sha256: "b".repeat(64),
    role: "palette",
    scope: [],
    applied: true,
    allowed_uses: [],
    forbidden_uses: [],
    rights: { copyright: "unknown", portrait_consent: "unknown", redistribution: "unknown", attribution: "" },
  }]);
  const frozenInitial = structuredClone(initialHistory.snapshots[0]);

  await store.updateMetadata("default", asset.id, { rating: 5, group: "Keepers" });
  assert.equal((await store.getRecipeSnapshotHistory("default", asset.id)).snapshots.length, 1);

  const updated = await store.updateMetadata("default", asset.id, {
    prompt: "A blue city at dawn",
    source: { model: "gpt-image-2" },
    recipe_change_summary: "Changed palette, time, and model",
  });
  const updatedHistory = await store.getRecipeSnapshotHistory("default", asset.id);
  assert.equal(updated.source.generation_tool, "imagegen");
  assert.equal(updated.source.codex_task_id, "task-1");
  assert.equal(updatedHistory.snapshots.length, 2);
  assert.deepEqual(updatedHistory.snapshots[0], frozenInitial);
  assert.equal(updatedHistory.snapshots[1].effective_prompt, "A blue city at dawn");
  assert.equal(updatedHistory.snapshots[1].model, "gpt-image-2");
  assert.equal(updatedHistory.snapshots[1].change_summary, "Changed palette, time, and model");
  assert.equal(updatedHistory.active_snapshot_id, updatedHistory.snapshots[1].snapshot_id);
  assert.deepEqual(updated.recipe_snapshots, updatedHistory.snapshots);
});

test("SQLite carries reference rights recorded after archival into the stored snapshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-recipe-rights-sqlite-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({
    projectRoot,
    managerDir: join(projectRoot, "mosa"),
    libraryDir: join(root, "library"),
  });
  t.after(() => store.close());

  const asset = await store.createAsset({
    assetId: "rights-fixture",
    imagePath: sourcePath,
    prompt: "A quiet window portrait",
    references: [{ asset_id: "portrait-ref", sha256: "c".repeat(64), role: "identity" }],
  });
  const before = await store.getRecipeSnapshotHistory("default", asset.id);
  assert.equal(before.snapshots[0].references[0].rights.portrait_consent, "unknown");

  // Recording a refusal is digest-inert, so it must append nothing and still
  // reach the stored row. The former INSERT OR IGNORE silently dropped it.
  await store.updateMetadata("default", asset.id, {
    references: [{
      asset_id: "portrait-ref",
      sha256: "c".repeat(64),
      role: "identity",
      forbidden_uses: ["composition"],
      rights: { copyright: "third-party", portrait_consent: "denied", redistribution: "forbidden", attribution: "Studio" },
    }],
  });

  const after = await store.getRecipeSnapshotHistory("default", asset.id);
  assert.equal(after.snapshots.length, 1, "a rights annotation is not a new recipe");
  assert.equal(after.snapshots[0].recipe_digest, before.snapshots[0].recipe_digest);
  assert.equal(after.snapshots[0].references[0].rights.portrait_consent, "denied");
  assert.equal(after.snapshots[0].references[0].rights.attribution, "Studio");
  assert.deepEqual(after.snapshots[0].references[0].forbidden_uses, ["composition"]);
});

test("SQLite recent filter and counter share the JSON store's date semantics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-sqlite-recent-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const now = new Date();
  const nowIso = now.toISOString();
  // Legacy created_at values, in the formats ECMA-262 guarantees Date.parse accepts.
  const legacyCreatedAt = {
    "legacy-old-rfc": "Sat, 01 Jan 2000 00:00:00 GMT",   // parseable, ancient, sorts ABOVE an ISO cutoff
    "legacy-recent-rfc": now.toUTCString(),               // parseable, recent
    "legacy-recent-expanded-iso": `+00${nowIso}`,         // parseable, recent, sorts BELOW an ISO cutoff
    "legacy-empty": "",                                   // unusable
    "legacy-invalid": "not-a-real-date",                  // unusable
  };
  const assetIds = ["valid-recent-iso", ...Object.keys(legacyCreatedAt)];

  // ---- SQLite store -------------------------------------------------------------------------
  const sqliteProjectRoot = join(root, "sqlite-project");
  const sqliteSourcePath = join(sqliteProjectRoot, "generated-images", "fixture.png");
  await mkdir(join(sqliteProjectRoot, "generated-images"), { recursive: true });
  await writeFile(sqliteSourcePath, ONE_PIXEL_PNG);
  const libraryDir = join(root, "library");
  const openStores = [];
  const openStore = () => {
    const opened = createSqliteAssetStore({ projectRoot: sqliteProjectRoot, managerDir: join(sqliteProjectRoot, "mosa"), libraryDir });
    openStores.push(opened);
    return opened;
  };
  t.after(() => { for (const opened of openStores) { try { opened.close(); } catch { /* already closed */ } } });
  const seedStore = openStore();

  for (const assetId of assetIds) {
    await seedStore.createAsset({ assetId, imagePath: sqliteSourcePath, created_at: nowIso });
  }
  seedStore.close();

  // created_at is declared TEXT NOT NULL, so SQL NULL can never be stored — but the column carries
  // no format validation, so writing legacy text straight into it, and clearing the derived epoch,
  // reproduces exactly what a library written by an older build looks like.
  const database = new Database(sqliteDatabasePath(libraryDir));
  const setCreatedAt = database.prepare("UPDATE assets SET created_at = ?, created_at_epoch = ? WHERE project_id = 'default' AND id = ?");
  for (const [assetId, createdAt] of Object.entries(legacyCreatedAt)) {
    // Include both missing and non-NULL stale derived values. Startup repair must not trust an
    // epoch merely because an older or external writer happened to leave one populated.
    const staleEpoch = assetId === "legacy-old-rfc" || assetId === "legacy-invalid"
      ? Date.parse(nowIso)
      : null;
    assert.equal(setCreatedAt.run(createdAt, staleEpoch, assetId).changes, 1, `${assetId} row must be rewritten`);
  }
  database.close();

  // Reopening repairs the derived column, exactly as upgrading from an older build would.
  const store = openStore();
  const inspect = new Database(sqliteDatabasePath(libraryDir), { readonly: true });
  t.after(() => { try { inspect.close(); } catch { /* already closed */ } });
  const repairedRows = Object.fromEntries(inspect.prepare("SELECT id, created_at, created_at_epoch FROM assets WHERE project_id = 'default'").all().map((row) => [row.id, row]));
  assert.equal(repairedRows["legacy-old-rfc"].created_at, "2000-01-01T00:00:00.000Z", "parseable legacy text is canonicalised on open");
  assert.equal(repairedRows["legacy-old-rfc"].created_at_epoch, Date.parse("2000-01-01T00:00:00.000Z"), "a stale non-NULL epoch is repaired");
  assert.equal(repairedRows["legacy-empty"].created_at_epoch, null, "an unusable date stays NULL");
  assert.equal(repairedRows["legacy-invalid"].created_at_epoch, null, "an unusable date clears a stale non-NULL epoch");
  assert.equal(
    inspect.prepare("SELECT created_at FROM asset_versions WHERE project_id = ? AND asset_id = ?").get("default", "legacy-old-rfc").created_at,
    "2000-01-01T00:00:00.000Z",
    "startup repair also keeps version ordering on the canonical timestamp",
  );
  const plan = inspect.prepare("EXPLAIN QUERY PLAN SELECT a.id FROM assets a WHERE a.project_id = ? AND a.archived = 0 AND a.created_at_epoch >= ?").all("default", 0);
  assert.ok(plan.map((row) => row.detail).join(" | ").includes("assets_project_epoch_idx"), "the recent filter must use the derived index");

  const sqliteAll = await store.listAssets({ projectId: "default" });
  assert.equal(sqliteAll.length, assetIds.length, "every legacy row is still listed without filters");
  const sqliteRecent = await store.listAssets({ projectId: "default", recent: true });
  const sqliteRecentIds = sqliteRecent.map((asset) => asset.id).sort();
  assert.deepEqual(sqliteRecentIds, ["legacy-recent-expanded-iso", "legacy-recent-rfc", "valid-recent-iso"]);

  const sqliteGroups = await store.listGroups("default");
  assert.equal(sqliteGroups.total, assetIds.length);
  assert.equal(sqliteGroups.recent, sqliteRecent.length, "the counter must agree with the filter");
  assert.equal(sqliteGroups.recent, 3);

  // An explicit cutoff is honoured here too, and only the unparseable values stay out.
  const widened = await store.listAssets({ projectId: "default", recent: true, recentSince: Date.parse("1999-12-31T00:00:00.000Z") });
  assert.deepEqual(widened.map((asset) => asset.id).sort(), [
    "legacy-old-rfc",
    "legacy-recent-expanded-iso",
    "legacy-recent-rfc",
    "valid-recent-iso",
  ]);

  // ---- JSON store, same data ----------------------------------------------------------------
  const jsonProjectRoot = join(root, "json-project");
  const jsonManagerDir = join(jsonProjectRoot, "mosa");
  const jsonSourcePath = join(jsonProjectRoot, "generated-images", "fixture.png");
  await mkdir(join(jsonProjectRoot, "generated-images"), { recursive: true });
  await writeFile(jsonSourcePath, ONE_PIXEL_PNG);
  const jsonStore = createAssetStore({ projectRoot: jsonProjectRoot, managerDir: jsonManagerDir });
  assert.equal(jsonStore.storageKind, "json");

  for (const assetId of assetIds) {
    await jsonStore.createAsset({ assetId, imagePath: jsonSourcePath, created_at: nowIso });
  }
  const jsonMetadataDir = join(jsonManagerDir, "assets", "default", "metadata");
  for (const [assetId, createdAt] of Object.entries(legacyCreatedAt)) {
    const filePath = join(jsonMetadataDir, `${assetId}.json`);
    const metadata = JSON.parse(await readFile(filePath, "utf8"));
    metadata.created_at = createdAt;
    await writeFile(filePath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }

  // ---- Both stores must answer identically ---------------------------------------------------
  const jsonRecent = await jsonStore.listAssets({ projectId: "default", recent: true });
  assert.deepEqual(jsonRecent.map((asset) => asset.id).sort(), sqliteRecentIds, "both stores select the same assets");
  const jsonGroups = await jsonStore.listGroups("default");
  assert.equal(jsonGroups.recent, sqliteGroups.recent, "both stores count the same number of recent assets");
});

test("SQLite content-hash lookup uses its index and matches the JSON store's choice", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-sqlite-content-hash-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const libraryDir = join(root, "library");
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => { try { store.close(); } catch { /* already closed */ } });

  const oldest = await store.createAsset({ assetId: "same-oldest", imagePath: sourcePath, created_at: "2026-01-01T00:00:00.000Z" });
  await store.createAsset({ assetId: "same-newest", imagePath: sourcePath, created_at: "2026-03-01T00:00:00.000Z" });
  await store.createAsset({ assetId: "same-archived", imagePath: sourcePath, created_at: "2026-06-01T00:00:00.000Z" });
  await store.archiveAsset("default", "same-archived");

  const hash = oldest.source.content_sha256;
  assert.match(hash, /^[a-f0-9]{64}$/);

  // Simulate a legacy writer after this store was opened. Raw TEXT ordering would put this
  // ancient RFC date above every ISO date and choose the wrong duplicate.
  const rewrite = new Database(sqliteDatabasePath(libraryDir));
  rewrite.prepare("UPDATE assets SET created_at = ?, created_at_epoch = ? WHERE project_id = ? AND id = ?")
    .run("Sat, 01 Jan 2000 00:00:00 GMT", Date.parse("2000-01-01T00:00:00.000Z"), "default", "same-oldest");
  rewrite.close();

  // Same tie-break as the JSON store: active before archived, then newest.
  const found = await store.findAssetByContentHash("default", hash);
  assert.equal(found.id, "same-newest");
  assert.deepEqual(found, await store.getAsset("default", "same-newest"));

  // Any normal metadata edit heals both stored representations of a legacy created_at value.
  const healed = await store.updateMetadata("default", "same-oldest", { rating: 1 });
  assert.equal(healed.created_at, "2000-01-01T00:00:00.000Z");
  const healedRow = new Database(sqliteDatabasePath(libraryDir), { readonly: true });
  assert.deepEqual(
    healedRow.prepare("SELECT created_at, created_at_epoch FROM assets WHERE project_id = ? AND id = ?").get("default", "same-oldest"),
    { created_at: "2000-01-01T00:00:00.000Z", created_at_epoch: Date.parse("2000-01-01T00:00:00.000Z") },
  );
  assert.equal(
    healedRow.prepare("SELECT created_at FROM asset_versions WHERE project_id = ? AND asset_id = ?").get("default", "same-oldest").created_at,
    "2000-01-01T00:00:00.000Z",
    "the version-order copy of created_at heals with the asset row",
  );
  healedRow.close();

  await store.archiveAsset("default", "same-newest");
  await store.archiveAsset("default", "same-oldest");
  assert.equal((await store.findAssetByContentHash("default", hash)).id, "same-archived");

  assert.equal(await store.findAssetByContentHash("default", "0".repeat(64)), null);
  for (const empty of ["", null, undefined]) {
    assert.equal(await store.findAssetByContentHash("default", empty), null);
  }

  // The point of the method is that it is served by the hash index rather than by walking the
  // project. Without the INDEXED BY clause the planner picks assets_project_created_idx, because
  // that index also satisfies the ORDER BY, and scans every row — so assert both directions.
  const inspect = new Database(sqliteDatabasePath(libraryDir), { readonly: true });
  t.after(() => { try { inspect.close(); } catch { /* already closed */ } });
  inspect.function("mosa_normalize_created_at", { deterministic: true }, (value) => normalizeCreatedAt(value, value));
  const planFor = (sql) => inspect.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("default", hash).map((row) => row.detail).join(" | ");
  const plan = planFor(`SELECT * FROM assets INDEXED BY assets_project_hash_idx
    WHERE project_id = ? AND content_sha256 = ? ORDER BY archived ASC, mosa_normalize_created_at(created_at) DESC, id DESC LIMIT 1`);
  assert.ok(plan.includes("assets_project_hash_idx"), `expected the content-hash index to be used, got: ${plan}`);
  assert.equal(plan.includes("assets_project_created_idx"), false, `the project-order index must not be walked, got: ${plan}`);
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

test("SQLite schema v1 upgrades once without changing completed migration state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-schema-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  const databasePath = join(libraryDir, "mosa.db");
  const originalTimestamp = "2026-01-01T00:00:00.000Z";
  await mkdir(libraryDir, { recursive: true });

  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE library_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  `);
  legacy.prepare("INSERT INTO library_meta (key, value, updated_at) VALUES ('schema_version', '1', ?)").run(originalTimestamp);
  legacy.prepare("INSERT INTO library_meta (key, value, updated_at) VALUES ('migration_state', 'completed', ?)").run(originalTimestamp);
  legacy.prepare("INSERT INTO library_meta (key, value, updated_at) VALUES ('migration_details', '{\"verified\":true}', ?)").run(originalTimestamp);
  legacy.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(originalTimestamp);
  legacy.close();

  createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir }).close();
  const upgraded = new Database(databasePath, { readonly: true });
  const schemaAfterUpgrade = upgraded.prepare("SELECT value, updated_at FROM library_meta WHERE key = 'schema_version'").get();
  const migrationState = upgraded.prepare("SELECT value, updated_at FROM library_meta WHERE key = 'migration_state'").get();
  const migrationDetails = upgraded.prepare("SELECT value, updated_at FROM library_meta WHERE key = 'migration_details'").get();
  const migrationVersions = upgraded.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version);
  const parentIndex = upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'asset_versions_parent_idx'").get();
  upgraded.close();

  assert.equal(schemaAfterUpgrade.value, "3");
  assert.notEqual(schemaAfterUpgrade.updated_at, originalTimestamp);
  assert.deepEqual(migrationState, { value: "completed", updated_at: originalTimestamp });
  assert.deepEqual(migrationDetails, { value: '{"verified":true}', updated_at: originalTimestamp });
  assert.deepEqual(migrationVersions, [1, 2, 3]);
  assert.equal(parentIndex.name, "asset_versions_parent_idx");

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir }).close();
  const reopened = new Database(databasePath, { readonly: true });
  assert.deepEqual(
    reopened.prepare("SELECT value, updated_at FROM library_meta WHERE key = 'schema_version'").get(),
    schemaAfterUpgrade,
  );
  reopened.close();
});

test("SQLite schema v2 migration backfills current recipes for existing assets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-recipe-backfill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  const sourcePath = join(projectRoot, "generated-images", "fixture.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  await store.createAsset({
    assetId: "legacy-recipe",
    imagePath: sourcePath,
    prompt: "Prompt retained from schema v2",
    source: { model: "legacy-model" },
  });
  store.close();

  const legacy = new Database(join(libraryDir, "mosa.db"));
  legacy.exec(`
    DROP TABLE recipe_snapshots;
    DELETE FROM schema_migrations WHERE version = 3;
    UPDATE library_meta SET value = '2' WHERE key = 'schema_version';
  `);
  legacy.close();

  const upgraded = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  const history = await upgraded.getRecipeSnapshotHistory("default", "legacy-recipe");
  upgraded.close();
  assert.equal(history.snapshots.length, 1);
  assert.equal(history.snapshots[0].effective_prompt, "Prompt retained from schema v2");
  assert.equal(history.snapshots[0].model, "legacy-model");
  assert.equal(history.snapshots[0].change_summary, "Backfilled current recipe");
  assert.equal(history.active_snapshot_id, history.snapshots[0].snapshot_id);
});

test("SQLite refuses to downgrade a newer schema", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-schema-future-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const libraryDir = join(root, "library");
  const databasePath = join(libraryDir, "mosa.db");
  await mkdir(libraryDir, { recursive: true });
  const future = new Database(databasePath);
  future.exec(`
    CREATE TABLE library_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO library_meta (key, value, updated_at) VALUES ('schema_version', '4', 'future');
  `);
  future.close();

  assert.throws(
    () => createSqliteAssetStore({ projectRoot: root, managerDir: join(root, "mosa"), libraryDir }),
    /schema version 4 is newer than supported version 3/,
  );
  const inspected = new Database(databasePath, { readonly: true });
  assert.deepEqual(inspected.prepare("SELECT value, updated_at FROM library_meta WHERE key = 'schema_version'").get(), { value: "4", updated_at: "future" });
  inspected.close();
});

test("concurrent SQLite creates with the same ID cannot overwrite the winner", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-sqlite-create-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const generatedDir = join(projectRoot, "generated-images");
  const firstPath = join(generatedDir, "first.png");
  const secondPath = join(generatedDir, "second.png");
  await mkdir(generatedDir, { recursive: true });
  await Promise.all([
    sharp({ create: { width: 4, height: 4, channels: 4, background: "#c33c32" } }).png().toFile(firstPath),
    sharp({ create: { width: 4, height: 4, channels: 4, background: "#2e6db4" } }).png().toFile(secondPath),
  ]);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir: join(root, "library") });
  t.after(() => store.close());

  const results = await Promise.allSettled([
    store.createAsset({ assetId: "same-id", imagePath: firstPath, prompt: "first" }),
    store.createAsset({ assetId: "same-id", imagePath: secondPath, prompt: "second" }),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "ASSET_ALREADY_EXISTS");

  const winner = fulfilled[0].value;
  const stored = await store.getAsset("default", "same-id");
  assert.equal(stored.prompt, winner.prompt);
  assert.equal(stored.source.path, winner.source.path);
  assert.deepEqual(await readFile(stored.image_path), await readFile(winner.source.path));
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

test("SQLite store re-links copied Codex assets, archived ones included, and explains each skip", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-sqlite-hardlink-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const codexImagesDir = join(root, ".codex", "generated_images");
  await mkdir(join(codexImagesDir, "task-1"), { recursive: true });
  const codexPath = join(codexImagesDir, "task-1", "generated.png");
  const orphanPath = join(codexImagesDir, "task-1", "orphan.png");
  await writeFile(codexPath, ONE_PIXEL_PNG);
  await writeFile(orphanPath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({
    projectRoot,
    managerDir: join(projectRoot, "mosa"),
    libraryDir: join(root, "library"),
    codexImagesDir,
  });
  t.after(() => store.close());

  const active = await store.createAsset({ assetId: "codex-active", imagePath: codexPath });
  const archived = await store.createAsset({ assetId: "codex-archived", imagePath: codexPath });
  const orphan = await store.createAsset({ assetId: "codex-orphan", imagePath: orphanPath });
  assert.equal(active.source.storage_mode, "hard-link", "ingest already links; only older copies need this pass");
  await store.archiveAsset("default", archived.id);

  // Stand in for a library that predates hard-linked ingest, or one carried over by
  // `mosa migrate`: same bytes, separate inode.
  for (const asset of [active, archived, orphan]) {
    await unlink(asset.image_path);
    await copyFile(codexPath, asset.image_path);
  }
  await unlink(orphanPath);

  const result = await store.migrateCodexAssetsToHardLinks("default");
  assert.deepEqual(result.migrated.sort(), ["codex-active", "codex-archived"]);
  assert.deepEqual(result.skipped, [{ assetId: "codex-orphan", reason: "source-or-library-file-missing" }]);
  const [codexStat, activeStat, archivedStat] = await Promise.all([
    stat(codexPath), stat(active.image_path), stat(archived.image_path),
  ]);
  assert.equal(activeStat.ino, codexStat.ino);
  assert.equal(archivedStat.ino, codexStat.ino, "an archived asset still holds a reclaimable copy");

  const relinked = await store.getAsset("default", "codex-active");
  assert.equal(relinked.source.storage_mode, "hard-link");
  assert.ok(relinked.source.storage_linked_at, "the pass records when it took the link");
  assert.equal(relinked.source.codex_task_id, "task-1", "the rest of the provenance survives untouched");
  assert.equal((await store.verifyLibrary()).ok, true, "re-linking must not disturb the recorded hashes");

  const second = await store.migrateCodexAssetsToHardLinks("default");
  assert.deepEqual(second.migrated, [], "a second pass has nothing left to reclaim");
  assert.deepEqual(second.alreadyLinked.sort(), ["codex-active", "codex-archived"]);
});

test("derivative stream rejects inherited kind names", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-kind-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createSqliteAssetStore({
    projectRoot: root,
    managerDir: join(root, "mosa"),
    libraryDir: join(root, "library"),
  });
  t.after(() => store.close());

  await assert.rejects(
    () => store.derivativeReadStream("default", "asset", "toString"),
    /Invalid derivative kind: toString/,
  );
});
