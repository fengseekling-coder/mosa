import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ensureSchemaUpgradeBackup,
  readSqliteSchemaVersion,
  schemaUpgradeRecoveryError,
  schemaUpgradeBackupPath,
  verifySchemaUpgradeResult,
} from "../lib/schema-upgrade-backup.mjs";

test("schema upgrade creates one consistent pre-migration SQLite snapshot before mutation", async () => {
  const libraryDir = await mkdtemp(join(tmpdir(), "mosa-schema-backup-"));
  const dbPath = join(libraryDir, "mosa.db");
  const database = new Database(dbPath);
  try {
    database.exec("CREATE TABLE library_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)");
    database.exec("CREATE TABLE proof (value TEXT NOT NULL)");
    database.prepare("INSERT INTO library_meta VALUES ('schema_version', '14', '2026-09-19T00:00:00Z')").run();
    database.prepare("INSERT INTO proof VALUES (?)").run("before-upgrade");

    const result = ensureSchemaUpgradeBackup(database, { libraryDir, targetVersion: 15, databaseExisted: true });
    assert.equal(result.created, true);
    assert.equal(result.fromVersion, 14);
    assert.equal(result.path, schemaUpgradeBackupPath({ libraryDir, fromVersion: 14, toVersion: 15 }));
    assert.equal(existsSync(result.path), true);

    database.prepare("UPDATE library_meta SET value = '15' WHERE key = 'schema_version'").run();
    database.prepare("UPDATE proof SET value = 'after-upgrade'").run();

    const backup = new Database(result.path, { readonly: true, fileMustExist: true });
    try {
      assert.equal(readSqliteSchemaVersion(backup), 14);
      assert.equal(backup.prepare("SELECT value FROM proof").get().value, "before-upgrade");
      assert.equal(backup.pragma("integrity_check", { simple: true }), "ok");
    } finally {
      backup.close();
    }
  } finally {
    database.close();
    await rm(libraryDir, { recursive: true, force: true });
  }
});

test("schema upgrade backup is skipped for new or already-current databases", async () => {
  const libraryDir = await mkdtemp(join(tmpdir(), "mosa-schema-backup-current-"));
  const database = new Database(join(libraryDir, "mosa.db"));
  try {
    assert.equal(ensureSchemaUpgradeBackup(database, {
      libraryDir,
      targetVersion: 15,
      databaseExisted: false,
    }).reason, "new-database");
    database.exec("CREATE TABLE library_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)");
    database.prepare("INSERT INTO library_meta VALUES ('schema_version', '15', '2026-09-19T00:00:00Z')").run();
    assert.equal(ensureSchemaUpgradeBackup(database, {
      libraryDir,
      targetVersion: 15,
      databaseExisted: true,
    }).reason, "current");
  } finally {
    database.close();
    await rm(libraryDir, { recursive: true, force: true });
  }
});

test("post-upgrade verification fails closed and points to the pre-upgrade snapshot", async () => {
  const libraryDir = await mkdtemp(join(tmpdir(), "mosa-schema-verify-"));
  const database = new Database(join(libraryDir, "mosa.db"));
  try {
    database.pragma("foreign_keys = OFF");
    database.exec("CREATE TABLE library_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)");
    database.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
    database.exec("CREATE TABLE child (parent_id INTEGER REFERENCES parent(id))");
    database.prepare("INSERT INTO library_meta VALUES ('schema_version', '14', '2026-09-19T00:00:00Z')").run();
    const backup = ensureSchemaUpgradeBackup(database, { libraryDir, targetVersion: 15, databaseExisted: true });
    database.prepare("INSERT INTO child VALUES (999)").run();
    assert.throws(
      () => verifySchemaUpgradeResult(database, backup),
      (error) => /foreign_key_check/.test(error.message) && error.message.includes(backup.path),
    );
  } finally {
    database.close();
    await rm(libraryDir, { recursive: true, force: true });
  }
});

test("migration exceptions retain the pre-upgrade recovery path", () => {
  const backup = { created: true, path: "/safe/library/.schema-backups/mosa-before-v15-from-v14.db" };
  const wrapped = schemaUpgradeRecoveryError(new Error("migration failed"), backup);
  assert.match(wrapped.message, /migration failed/);
  assert.match(wrapped.message, /mosa-before-v15-from-v14\.db/);
  assert.equal(wrapped.cause.message, "migration failed");
});
