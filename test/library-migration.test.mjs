import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectLegacyLibrary, migrateLegacyLibrary, verifySqliteLibrary } from "../lib/library-migration.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

test("migration copies legacy JSON assets, preserves unknown fields, and verifies hashes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-migrate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const managerDir = join(root, "mosa");
  const imagePath = join(managerDir, "assets", "default", "images", "legacy.png");
  const metadataPath = join(managerDir, "assets", "default", "metadata", "legacy.json");
  await mkdir(join(managerDir, "assets", "default", "metadata"), { recursive: true });
  await mkdir(join(managerDir, "assets", "default", "images"), { recursive: true });
  await writeFile(join(managerDir, "assets", "default", "groups.json"), JSON.stringify(["Empty collection"]));
  await writeFile(imagePath, PNG);
  await writeFile(metadataPath, JSON.stringify({
    id: "legacy",
    project_id: "default",
    asset: "legacy.png",
    prompt: "preserve every prompt exactly",
    tags: ["archive"],
    source: { type: "codex-generated", path: "/old/generated.png", model: "test" },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    legacy_note: "must survive migration",
  }, null, 2));

  const libraryDir = join(root, "library");
  const report = await migrateLegacyLibrary({ managerDir, projectRoot: root, libraryDir });
  assert.equal(report.completed, true);
  assert.equal(report.discovered, 1);
  assert.equal(report.imported, 1);
  assert.equal(report.importedGroups, 1);
  assert.equal(report.verified, 1);
  assert.equal(report.issues.length, 0);
  const verification = await verifySqliteLibrary({ managerDir, projectRoot: root, libraryDir });
  assert.equal(verification.ok, true);
  assert.equal(verification.assets, 1);
  const store = createSqliteAssetStore({ managerDir, projectRoot: root, libraryDir });
  const migrated = await store.getAsset("default", "legacy");
  const groups = await store.listGroups("default");
  store.close();
  assert.equal(migrated.legacy_note, "must survive migration");
  assert.deepEqual(groups.groups, [["Empty collection", 0]]);
  assert.equal(JSON.parse(verification.migration.migration_details).completed, true);

  const backup = await readFile(join(report.backupPath, "default", "metadata", "legacy.json"), "utf8");
  assert.match(backup, /must survive migration/);
  const resumed = await migrateLegacyLibrary({ managerDir, projectRoot: root, libraryDir, resume: true });
  assert.equal(resumed.skipped, 1);
  assert.equal(resumed.skippedGroups, 1);
});

test("corrupt legacy JSON blocks migration and identifies the exact file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-migrate-corrupt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const managerDir = join(root, "mosa");
  const corruptPath = join(managerDir, "assets", "default", "metadata", "broken.json");
  await mkdir(join(managerDir, "assets", "default", "metadata"), { recursive: true });
  await writeFile(corruptPath, "{ not json");
  const inspection = await inspectLegacyLibrary({ managerDir });
  assert.deepEqual(inspection.issues.map((issue) => issue.kind), ["corrupt-json"]);
  assert.equal(inspection.issues[0].path, corruptPath);
  const report = await migrateLegacyLibrary({ managerDir, projectRoot: root, libraryDir: join(root, "library") });
  assert.equal(report.completed, false);
  assert.equal(report.issues[0].path, corruptPath);
});

test("corrupt groups JSON blocks migration and identifies the exact file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-migrate-groups-corrupt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const managerDir = join(root, "mosa");
  const groupsPath = join(managerDir, "assets", "default", "groups.json");
  await mkdir(join(managerDir, "assets", "default"), { recursive: true });
  await writeFile(groupsPath, "{ not json");
  const report = await migrateLegacyLibrary({ managerDir, projectRoot: root, libraryDir: join(root, "library") });
  assert.equal(report.completed, false);
  assert.deepEqual(report.issues.map((issue) => issue.kind), ["corrupt-groups-json"]);
  assert.equal(report.issues[0].path, groupsPath);
});

test("migration orders version parents before children and preserves the tree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-migrate-versions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const managerDir = join(root, "mosa");
  const metadataDir = join(managerDir, "assets", "default", "metadata");
  const imagesDir = join(managerDir, "assets", "default", "images");
  await mkdir(metadataDir, { recursive: true });
  await mkdir(imagesDir, { recursive: true });
  await writeFile(join(imagesDir, "parent.png"), PNG);
  await writeFile(join(imagesDir, "child.png"), PNG);
  await writeFile(join(metadataDir, "a-child.json"), JSON.stringify({
    id: "child",
    project_id: "default",
    asset: "child.png",
    prompt: "child prompt",
    parent_asset_id: "parent",
    version_change: "palette pass",
  }));
  await writeFile(join(metadataDir, "z-parent.json"), JSON.stringify({
    id: "parent",
    project_id: "default",
    asset: "parent.png",
    prompt: "parent prompt",
  }));

  const libraryDir = join(root, "library");
  const report = await migrateLegacyLibrary({ managerDir, projectRoot: root, libraryDir });
  assert.equal(report.completed, true);
  assert.equal(report.imported, 2);
  const store = createSqliteAssetStore({ managerDir, projectRoot: root, libraryDir });
  const history = await store.getAssetVersionHistory("default", "child");
  store.close();
  assert.deepEqual(history.versions.map((asset) => asset.id), ["parent", "child"]);
  assert.equal(history.versions[1].version_change, "palette pass");
});

test("migration reports invalid legacy version relationships without writing SQLite assets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-migrate-invalid-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const managerDir = join(root, "mosa");
  const metadataDir = join(managerDir, "assets", "default", "metadata");
  const imagesDir = join(managerDir, "assets", "default", "images");
  await mkdir(metadataDir, { recursive: true });
  await mkdir(imagesDir, { recursive: true });
  await writeFile(join(imagesDir, "orphan.png"), PNG);
  await writeFile(join(metadataDir, "orphan.json"), JSON.stringify({
    id: "orphan",
    project_id: "default",
    asset: "orphan.png",
    parent_asset_id: "missing",
  }));

  const report = await migrateLegacyLibrary({ managerDir, projectRoot: root, libraryDir: join(root, "library") });
  assert.equal(report.completed, false);
  assert.deepEqual(report.issues.map((issue) => issue.kind), ["version-parent-missing"]);
  assert.equal(report.backupPath, null);
});

test("migration blocks duplicate asset IDs before and after normalization", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-migrate-duplicate-ids-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    ["same", "same"],
    ["same value", "same@value"],
  ];

  for (const [index, ids] of cases.entries()) {
    const managerDir = join(root, `case-${index}`, "mosa");
    const metadataDir = join(managerDir, "assets", "default", "metadata");
    const imagesDir = join(managerDir, "assets", "default", "images");
    await mkdir(metadataDir, { recursive: true });
    await mkdir(imagesDir, { recursive: true });
    await Promise.all([
      writeFile(join(imagesDir, "first.png"), PNG),
      writeFile(join(imagesDir, "second.png"), PNG),
      writeFile(join(metadataDir, "first.json"), JSON.stringify({ id: ids[0], project_id: "default", asset: "first.png" })),
      writeFile(join(metadataDir, "second.json"), JSON.stringify({ id: ids[1], project_id: "default", asset: "second.png" })),
    ]);

    const inspection = await inspectLegacyLibrary({ managerDir });
    assert.equal(inspection.records.length, 2);
    assert.deepEqual(inspection.issues.map((issue) => issue.kind), ["duplicate-asset-id"]);
    assert.match(inspection.issues[0].detail, /after normalization/);
    const report = await migrateLegacyLibrary({ managerDir, projectRoot: join(root, `case-${index}`), libraryDir: join(root, `library-${index}`) });
    assert.equal(report.completed, false);
    assert.equal(report.backupPath, null);
  }
});

test("migration allows the same asset ID in distinct projects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-migrate-cross-project-ids-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const managerDir = join(root, "mosa");
  for (const projectId of ["alpha", "beta"]) {
    const metadataDir = join(managerDir, "assets", projectId, "metadata");
    const imagesDir = join(managerDir, "assets", projectId, "images");
    await mkdir(metadataDir, { recursive: true });
    await mkdir(imagesDir, { recursive: true });
    await writeFile(join(imagesDir, "shared.png"), PNG);
    await writeFile(join(metadataDir, "shared.json"), JSON.stringify({ id: "shared", project_id: projectId, asset: "shared.png" }));
  }
  const inspection = await inspectLegacyLibrary({ managerDir });
  assert.equal(inspection.records.length, 2);
  assert.deepEqual(inspection.issues, []);
});

test("migration reports cross-project parents and multi-node cycles", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-migrate-invalid-graphs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const managerDir = join(root, "mosa");
  const records = [
    ["default", "a", "b"],
    ["default", "b", "a"],
    ["default", "cross", "foreign"],
    ["other", "foreign", null],
  ];
  for (const [projectId, assetId, parentAssetId] of records) {
    const metadataDir = join(managerDir, "assets", projectId, "metadata");
    const imagesDir = join(managerDir, "assets", projectId, "images");
    await mkdir(metadataDir, { recursive: true });
    await mkdir(imagesDir, { recursive: true });
    await writeFile(join(imagesDir, `${assetId}.png`), PNG);
    await writeFile(join(metadataDir, `${assetId}.json`), JSON.stringify({
      id: assetId,
      project_id: projectId,
      asset: `${assetId}.png`,
      ...(parentAssetId ? { parent_asset_id: parentAssetId } : {}),
    }));
  }

  const inspection = await inspectLegacyLibrary({ managerDir });
  const kinds = inspection.issues.map((issue) => issue.kind);
  assert.ok(kinds.includes("version-project-mismatch"));
  assert.ok(kinds.includes("version-cycle"));
  const report = await migrateLegacyLibrary({ managerDir, projectRoot: root, libraryDir: join(root, "library") });
  assert.equal(report.completed, false);
  assert.equal(report.backupPath, null);
});
