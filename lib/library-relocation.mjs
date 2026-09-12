import Database from "better-sqlite3";
import { stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { isPathInsideOrEqual } from "./path-safety.mjs";
import { sqliteDatabasePath } from "./sqlite-asset-store.mjs";

const MANAGED_ASSET_PATH_COLUMNS = Object.freeze([
  "original_path",
  "preview_path",
  "medium_path",
  "thumbnail_path",
]);

function relocatedPath(value, sourceLibraryDir, destinationLibraryDir) {
  if (!value) return value;
  const resolvedValue = resolve(String(value));
  if (!isPathInsideOrEqual(sourceLibraryDir, resolvedValue)) return value;
  const suffix = relative(sourceLibraryDir, resolvedValue);
  const candidate = resolve(destinationLibraryDir, suffix);
  if (!isPathInsideOrEqual(destinationLibraryDir, candidate)) {
    throw new Error(`Refusing unsafe relocated library path: ${value}`);
  }
  return candidate;
}

async function assertCopiedManagedFile(sourcePath, destinationPath) {
  const [sourceInfo, destinationInfo] = await Promise.all([stat(sourcePath), stat(destinationPath)]);
  if (!sourceInfo.isFile() || !destinationInfo.isFile()) {
    throw new Error(`Relocated managed path is not a file: ${destinationPath}`);
  }
  if (sourceInfo.size !== destinationInfo.size) {
    throw new Error(`Relocated managed file size mismatch: ${destinationPath}`);
  }
}

/**
 * Finalize a copied SQLite library before it becomes authoritative.
 *
 * MOSA stores managed media paths as absolute paths. Copying the library tree
 * therefore requires rebasing only the managed media columns inside the copied
 * database. Provenance/source paths intentionally stay untouched because they
 * may point to external applications or source folders.
 *
 * The operation is fail-closed: every path that belonged to the old library is
 * checked against the copied byte on disk before a single database row is
 * changed, then the copied SQLite file receives an integrity check after the
 * transaction commits.
 */
export async function finalizeCopiedSqliteLibrary({ sourceLibraryDir, destinationLibraryDir } = {}) {
  const sourceRoot = resolve(String(sourceLibraryDir || ""));
  const destinationRoot = resolve(String(destinationLibraryDir || ""));
  if (!sourceLibraryDir || !destinationLibraryDir || sourceRoot === destinationRoot) {
    throw new Error("Source and destination library directories must be different absolute locations.");
  }

  const databasePath = sqliteDatabasePath(destinationRoot);
  const database = new Database(databasePath);
  try {
    const integrityBefore = database.pragma("integrity_check", { simple: true });
    if (integrityBefore !== "ok") throw new Error(`Copied MOSA database failed integrity check: ${integrityBefore}`);

    const rows = database.prepare(`
      SELECT project_id, id, ${MANAGED_ASSET_PATH_COLUMNS.join(", ")}
      FROM assets
      ORDER BY project_id, id
    `).all();
    const updates = [];

    for (const row of rows) {
      const next = {};
      let changed = false;
      for (const column of MANAGED_ASSET_PATH_COLUMNS) {
        const current = row[column];
        if (!current) continue;
        const rebased = relocatedPath(current, sourceRoot, destinationRoot);
        if (rebased === current) continue;
        await assertCopiedManagedFile(resolve(current), rebased);
        next[column] = rebased;
        changed = true;
      }
      if (changed) updates.push({ projectId: row.project_id, assetId: row.id, next });
    }

    const updateRow = database.prepare(`
      UPDATE assets SET
        original_path = @original_path,
        preview_path = @preview_path,
        medium_path = @medium_path,
        thumbnail_path = @thumbnail_path
      WHERE project_id = @project_id AND id = @id
    `);
    const apply = database.transaction(() => {
      for (const update of updates) {
        const current = database.prepare(`
          SELECT original_path, preview_path, medium_path, thumbnail_path
          FROM assets WHERE project_id = ? AND id = ?
        `).get(update.projectId, update.assetId);
        const values = {
          project_id: update.projectId,
          id: update.assetId,
          original_path: update.next.original_path ?? current.original_path,
          preview_path: update.next.preview_path ?? current.preview_path,
          medium_path: update.next.medium_path ?? current.medium_path,
          thumbnail_path: update.next.thumbnail_path ?? current.thumbnail_path,
        };
        updateRow.run(values);
      }
    });
    apply();

    const stale = database.prepare(`
      SELECT project_id, id, ${MANAGED_ASSET_PATH_COLUMNS.join(", ")}
      FROM assets
      ORDER BY project_id, id
    `).all().find((row) => MANAGED_ASSET_PATH_COLUMNS.some((column) => {
      const value = row[column];
      return value && isPathInsideOrEqual(sourceRoot, resolve(value));
    }));
    if (stale) throw new Error(`Relocated library still references the previous library for asset ${stale.project_id}/${stale.id}.`);

    const integrityAfter = database.pragma("integrity_check", { simple: true });
    if (integrityAfter !== "ok") throw new Error(`Relocated MOSA database failed integrity check: ${integrityAfter}`);
    return { updatedAssets: updates.length, checkedAssets: rows.length };
  } finally {
    database.close();
  }
}
