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
