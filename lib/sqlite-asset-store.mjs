import Database from "better-sqlite3";
import { constants as fsConstants, createReadStream, existsSync, mkdirSync } from "node:fs";
import { copyFile, link, lstat, mkdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import {
  assetAlreadyExistsError,
  assetNotFoundError,
  assetStoreError,
  assertMutableVersionPatch,
  buildAssetVersionHistory,
  derivedAssetSource,
  pickVersionOverrides,
  requireVersionChange,
  versionParentError,
} from "./asset-version-history.mjs";

const IMAGE_EXTENSIONS = new Set([".apng", ".avif", ".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp"]);
const DEFAULT_PROJECT_ID = "default";
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 250;
const CURRENT_SCHEMA_VERSION = 2;
const NORMALIZED_METADATA_KEYS = new Set([
  "id", "project_id", "projectId", "asset", "image_path", "prompt_path", "prompt", "skill", "style", "ratio", "business_fields", "theme",
  "tags", "favorite", "archived", "group", "category", "rating", "parent_asset_id", "parentAssetId", "version_change", "changeSummary",
  "child_asset_ids", "created_at", "updated_at", "source", "sourceType", "imagePath", "fileName", "assetId", "preview_path", "thumbnail_path",
  "image_url", "preview_url", "thumbnail_url", "prompt_file",
]);

export function sqliteDatabasePath(libraryDir) {
  return join(resolve(libraryDir), "mosa.db");
}

export function hasCompletedSqliteLibrary(libraryDir) {
  const databasePath = sqliteDatabasePath(libraryDir);
  if (!existsSync(databasePath)) return false;
  try {
    const database = new Database(databasePath, { readonly: true });
    const row = database.prepare("SELECT value FROM library_meta WHERE key = 'migration_state'").get();
    database.close();
    return row?.value === "completed";
  } catch {
    return false;
  }
}

/**
 * SQLite implementation of MOSA's existing asset-store contract. It keeps the
 * public shape used by HTTP, MCP and bridge code while making the database the
 * only mutable metadata authority after a verified migration.
 */
export function createSqliteAssetStore(options = {}) {
  const projectRoot = resolve(options.projectRoot || process.cwd());
  const managerDir = resolve(options.managerDir || join(projectRoot, "mosa"));
  const libraryDir = resolve(options.libraryDir || process.env.MOSA_LIBRARY_DIR || join(homedir(), "MOSA Library"));
  const assetsRoot = join(libraryDir, "assets");
  const legacyAssetsRoot = options.legacyAssetsRoot ? resolve(options.legacyAssetsRoot) : null;
  const generatedImagesDir = resolve(options.generatedImagesDir || join(projectRoot, "generated-images"));
  const codexImagesDir = resolve(options.codexImagesDir || process.env.CODEX_GENERATED_IMAGES_DIR || join(homedir(), ".codex", "generated_images"));
  const cowartCanvasDir = resolve(options.cowartCanvasDir || process.env.COWART_MOSA_CANVAS_DIR || join(homedir(), ".codex", "cowart-data", "mosa"));
  const cowartPageAssetsDir = join(cowartCanvasDir, "pages");
  const databasePath = sqliteDatabasePath(libraryDir);

  const database = openDatabase(databasePath);
  try {
    initializeSchema(database);
  } catch (error) {
    database.close();
    throw error;
  }

  const store = {
    storageKind: "sqlite",
    projectRoot,
    managerDir,
    libraryDir,
    databasePath,
    assetsRoot,
    legacyAssetsRoot,
    generatedImagesDir,
    codexImagesDir,
    cowartCanvasDir,
    cowartPageAssetsDir,
    derivativesAvailable: true,
    projectId(value) {
      return sanitizeProjectId(value);
    },
    projectDir(projectId = DEFAULT_PROJECT_ID) {
      return join(assetsRoot, sanitizeProjectId(projectId));
    },
    imagesDir(projectId = DEFAULT_PROJECT_ID) {
      return join(this.projectDir(projectId), "original");
    },
    previewsDir(projectId = DEFAULT_PROJECT_ID) {
      return join(this.projectDir(projectId), "previews");
    },
    thumbnailsDir(projectId = DEFAULT_PROJECT_ID) {
      return join(this.projectDir(projectId), "thumbnails");
    },
    promptsDir(projectId = DEFAULT_PROJECT_ID) {
      return join(this.projectDir(projectId), "prompts");
    },
    metadataDir(projectId = DEFAULT_PROJECT_ID) {
      return join(this.projectDir(projectId), "metadata");
    },
    async ensureProject(projectId = DEFAULT_PROJECT_ID) {
      const cleanProjectId = sanitizeProjectId(projectId);
      await Promise.all([
        mkdir(this.imagesDir(cleanProjectId), { recursive: true }),
        mkdir(this.previewsDir(cleanProjectId), { recursive: true }),
        mkdir(this.thumbnailsDir(cleanProjectId), { recursive: true }),
      ]);
      database.prepare("INSERT OR IGNORE INTO projects (id, created_at) VALUES (?, ?)").run(cleanProjectId, now());
      return cleanProjectId;
    },
    async listProjects() {
      await this.ensureProject(DEFAULT_PROJECT_ID);
      return database.prepare("SELECT id FROM projects ORDER BY CASE id WHEN 'default' THEN 0 ELSE 1 END, id").all().map((row) => row.id);
    },
    async listAssets(filters = {}) {
      const result = await this.listAssetPage({ ...filters, limit: 0 });
      return result.assets;
    },
    async listAssetPage(filters = {}) {
      const projectId = await this.ensureProject(filters.projectId || DEFAULT_PROJECT_ID);
      const limit = normalizeLimit(filters.limit);
      const cursor = parseCursor(filters.cursor);
      const conditions = ["a.project_id = @projectId", filters.archived ? "a.archived = 1" : "a.archived = 0"];
      const params = { projectId };
      appendFilterConditions(conditions, params, filters);
      if (cursor) {
        conditions.push("(a.created_at < @cursorCreatedAt OR (a.created_at = @cursorCreatedAt AND a.id < @cursorId))");
        params.cursorCreatedAt = cursor.createdAt;
        params.cursorId = cursor.id;
      }
      let joins = "";
      if (filters.query && useFts(filters.query)) {
        joins = "JOIN asset_fts f ON f.project_id = a.project_id AND f.asset_id = a.id";
        conditions.push("f.content MATCH @ftsQuery");
        params.ftsQuery = buildFtsQuery(filters.query);
      } else if (filters.query) {
        conditions.push("LOWER(a.search_text) LIKE @likeQuery");
        params.likeQuery = `%${String(filters.query).toLowerCase()}%`;
      }
      const select = `SELECT a.* FROM assets a ${joins} WHERE ${conditions.join(" AND ")} ORDER BY a.created_at DESC, a.id DESC`;
      const rows = limit > 0
        ? database.prepare(`${select} LIMIT @limit`).all({ ...params, limit: limit + 1 })
        : database.prepare(select).all(params);
      const hasMore = limit > 0 && rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const assets = pageRows.map((row) => rowToAsset(database, row));
      const last = pageRows.at(-1);
      const total = database.prepare(`SELECT COUNT(*) AS count FROM assets a ${joins} WHERE ${conditions.filter((condition) => !condition.includes("cursorCreatedAt")).join(" AND ")}`).get(params).count;
      return {
        assets,
        page: {
          total,
          nextCursor: hasMore && last ? encodeCursor(last) : null,
          limit: limit || total,
        },
      };
    },
    async listGroups(projectId = DEFAULT_PROJECT_ID) {
      const cleanProjectId = await this.ensureProject(projectId);
      const stats = database.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN rating > 0 OR favorite = 1 THEN 1 ELSE 0 END) AS favorites,
          SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS recent,
          SUM(CASE WHEN source_type = 'codex-generated' THEN 1 ELSE 0 END) AS codex,
          SUM(CASE WHEN source_type = 'cowart-generated' THEN 1 ELSE 0 END) AS cowart
        FROM assets WHERE project_id = ? AND archived = 0
      `).get(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), cleanProjectId);
      const groups = database.prepare(`
        SELECT g.name, COUNT(a.id) AS count
        FROM groups g LEFT JOIN assets a ON a.project_id = g.project_id AND a.group_name = g.name AND a.archived = 0
        WHERE g.project_id = ? GROUP BY g.name ORDER BY count DESC, g.name COLLATE NOCASE
      `).all(cleanProjectId).map((row) => [row.name, row.count]);
      const categories = countNamedValues(database, cleanProjectId, "category");
      const styles = countNamedValues(database, cleanProjectId, "style", 20);
      return {
        total: Number(stats.total || 0),
        favorites: Number(stats.favorites || 0),
        recent: Number(stats.recent || 0),
        codex: Number(stats.codex || 0),
        cowart: Number(stats.cowart || 0),
        groups,
        categories,
        styles,
      };
    },
    async createGroup(input = {}) {
      const projectId = await this.ensureProject(input.projectId || DEFAULT_PROJECT_ID);
      const name = normalizeGroupName(input.name);
      if (!name) throw new Error("Group name is required.");
      const result = database.prepare("INSERT OR IGNORE INTO groups (project_id, name, created_at) VALUES (?, ?, ?)").run(projectId, name, now());
      if (!result.changes) throw new Error(`Group already exists: ${name}`);
      return { name, count: 0 };
    },
    async getAsset(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const row = database.prepare("SELECT * FROM assets WHERE project_id = ? AND id = ?").get(cleanProjectId, cleanAssetId);
      if (!row) throw assetNotFoundError(cleanAssetId);
      return rowToAsset(database, row);
    },
    async createAsset(input = {}, context = {}) {
      const projectId = await this.ensureProject(input.projectId || DEFAULT_PROJECT_ID);
      const { sourcePath, readablePath } = await resolveReadableImagePath(store, input.imagePath, context?.trustedSourceRoots);
      const contentHash = createHash("sha256").update(await readFile(readablePath)).digest("hex");
      const codexSource = await codexSourceMetadata(store, readablePath);
      const originalName = sanitizeFileName(input.asset || input.fileName || basename(sourcePath));
      const assetId = sanitizeId(input.assetId || `${slugName(originalName)}-${shortStamp()}`, "asset");
      const parentAssetId = normalizeParentAssetId(input.parent_asset_id ?? input.parentAssetId);
      const existing = database.prepare("SELECT id FROM assets WHERE project_id = ? AND id = ?").get(projectId, assetId);
      if (existing) throw assetAlreadyExistsError(assetId);
      assertSqliteVersionParent(database, projectId, assetId, parentAssetId);
      const versionChange = parentAssetId && !context?.allowMissingVersionChange
        ? requireVersionChange(input)
        : String(input.version_change ?? input.changeSummary ?? "").trim();
      const imageName = `${assetId}${extname(sourcePath) || extname(originalName) || ".png"}`;
      const imagePath = join(this.imagesDir(projectId), imageName);
      let storageMode;
      try {
        storageMode = codexSource
          ? await hardLinkOrCopy(readablePath, imagePath)
          : (await copyFile(readablePath, imagePath, fsConstants.COPYFILE_EXCL), "copy");
      } catch (error) {
        if (error?.code === "EEXIST") throw assetAlreadyExistsError(assetId);
        throw error;
      }
      const timestamp = now();
      const metadata = normalizeAssetMetadata({
        ...input,
        id: assetId,
        project_id: projectId,
        asset: imageName,
        image_path: imagePath,
        prompt_path: null,
        prompt: String(input.prompt || "").trim(),
        parent_asset_id: parentAssetId,
        version_change: versionChange,
        child_asset_ids: [],
        created_at: input.created_at || timestamp,
        updated_at: timestamp,
        source: {
          type: input.sourceType || (codexSource ? "codex-generated" : "local-file"),
          path: sourcePath,
          copied_at: timestamp,
          ...(codexSource || {}),
          ...(input.source && typeof input.source === "object" ? input.source : {}),
          content_sha256: contentHash,
          storage_mode: storageMode,
        },
      });
      try {
        saveAsset(database, metadata, { enqueueDerivative: true, insertOnly: true });
      } catch (error) {
        await unlink(imagePath).catch(() => {});
        if (isSqliteDuplicateError(error)) throw assetAlreadyExistsError(assetId);
        throw error;
      }
      return rowToAsset(database, database.prepare("SELECT * FROM assets WHERE project_id = ? AND id = ?").get(projectId, assetId));
    },
    async updateMetadata(projectId, assetId, patch = {}) {
      assertMutableVersionPatch(patch);
      const current = await this.getAsset(projectId, assetId);
      const metadata = normalizeAssetMetadata({
        ...current,
        ...patch,
        id: current.id,
        project_id: current.project_id,
        asset: current.asset,
        image_path: current.image_path,
        prompt_path: current.prompt_path,
        prompt: Object.hasOwn(patch, "prompt") ? String(patch.prompt || "").trim() : current.prompt,
        source: patch.source && typeof patch.source === "object" ? { ...current.source, ...patch.source } : current.source,
        updated_at: now(),
      });
      saveAsset(database, metadata, { enqueueDerivative: false });
      return this.getAsset(metadata.project_id, metadata.id);
    },
    async archiveAsset(projectId, assetId) {
      return this.updateMetadata(projectId, assetId, { archived: true });
    },
    async duplicateAsset(projectId, assetId, input = {}) {
      const current = await this.getAsset(projectId, assetId);
      return this.createAsset({
        ...current,
        ...pickVersionOverrides(input),
        projectId: current.project_id,
        assetId: input.assetId || `${current.id}-copy-${shortStamp()}`,
        imagePath: current.image_path,
        parent_asset_id: null,
        child_asset_ids: [],
        version_change: "",
        archived: false,
        created_at: undefined,
        updated_at: undefined,
        sourceType: current.source?.type,
        source: derivedAssetSource(current.source, "duplicated_from", current.id),
      });
    },
    async createAssetVersion(projectId, assetId, input = {}) {
      const current = await this.getAsset(projectId, assetId);
      const versionChange = requireVersionChange(input);
      const replacementImagePath = typeof input.imagePath === "string" && input.imagePath.trim() ? input.imagePath : null;
      const replacementSource = input.source && typeof input.source === "object" ? input.source : {};
      return this.createAsset({
        ...current,
        ...pickVersionOverrides(input),
        projectId: current.project_id,
        assetId: input.assetId || input.assetIdNew || `${current.id}-v-${shortStamp()}`,
        imagePath: replacementImagePath || current.image_path,
        parent_asset_id: current.id,
        child_asset_ids: [],
        version_change: versionChange,
        archived: false,
        created_at: undefined,
        updated_at: undefined,
        sourceType: replacementImagePath ? input.sourceType : current.source?.type,
        source: replacementImagePath
          ? derivedAssetSource(replacementSource, "versioned_from", current.id)
          : derivedAssetSource(current.source, "versioned_from", current.id),
      });
    },
    async getAssetVersionHistory(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const rootAssetId = findSqliteVersionRoot(database, cleanProjectId, cleanAssetId);
      const rows = database.prepare(`
        WITH RECURSIVE family(id) AS (
          SELECT ?
          UNION
          SELECT v.asset_id FROM asset_versions v JOIN family f ON v.parent_asset_id = f.id WHERE v.project_id = ?
        )
        SELECT a.* FROM assets a JOIN family f ON f.id = a.id WHERE a.project_id = ?
      `).all(rootAssetId, cleanProjectId, cleanProjectId);
      return buildAssetVersionHistory({
        projectId: cleanProjectId,
        selectedAssetId: cleanAssetId,
        assets: rows.map((row) => rowToAsset(database, row)),
      });
    },
    async assetReadStream(projectId, fileName) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const safeName = sanitizeFileName(fileName);
      const row = database.prepare("SELECT original_path FROM assets WHERE project_id = ? AND asset = ?").get(cleanProjectId, safeName);
      if (!row?.original_path) throw new Error("Asset not found.");
      await assertStoredPath(this.imagesDir(cleanProjectId), row.original_path);
      return createReadStream(row.original_path);
    },
    async derivativeReadStream(projectId, assetId, kind) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const column = kind === "preview" ? "preview_path" : "thumbnail_path";
      const root = kind === "preview" ? this.previewsDir(cleanProjectId) : this.thumbnailsDir(cleanProjectId);
      const row = database.prepare(`SELECT ${column} AS path FROM assets WHERE project_id = ? AND id = ?`).get(cleanProjectId, cleanAssetId);
      if (!row?.path) throw new Error("Derivative not found.");
      await assertStoredPath(root, row.path);
      return createReadStream(row.path);
    },
    async enqueueDerivative(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      database.prepare(`
        INSERT INTO derivative_jobs (project_id, asset_id, status, attempts, created_at, updated_at)
        VALUES (?, ?, 'pending', 0, ?, ?)
        ON CONFLICT(project_id, asset_id) DO UPDATE SET status = 'pending', error = NULL, updated_at = excluded.updated_at
      `).run(cleanProjectId, cleanAssetId, now(), now());
    },
    async enqueueMissingDerivatives() {
      const rows = database.prepare("SELECT project_id, id FROM assets WHERE archived = 0 AND (thumbnail_path IS NULL OR preview_path IS NULL)").all();
      const insert = database.prepare(`
        INSERT INTO derivative_jobs (project_id, asset_id, status, attempts, created_at, updated_at)
        VALUES (?, ?, 'pending', 0, ?, ?)
        ON CONFLICT(project_id, asset_id) DO UPDATE SET status = CASE WHEN derivative_jobs.status = 'running' THEN 'running' ELSE 'pending' END, updated_at = excluded.updated_at
      `);
      const timestamp = now();
      database.transaction(() => rows.forEach((row) => insert.run(row.project_id, row.id, timestamp, timestamp)))();
      return rows.length;
    },
    async claimDerivativeJob() {
      const claim = database.transaction(() => {
        const job = database.prepare(`
          SELECT j.project_id, j.asset_id, j.attempts, a.original_path, a.id
          FROM derivative_jobs j JOIN assets a ON a.project_id = j.project_id AND a.id = j.asset_id
          WHERE j.status = 'pending' OR (j.status = 'running' AND j.updated_at < ?)
          ORDER BY j.created_at ASC LIMIT 1
        `).get(new Date(Date.now() - 5 * 60 * 1000).toISOString());
        if (!job) return null;
        database.prepare("UPDATE derivative_jobs SET status = 'running', attempts = attempts + 1, error = NULL, updated_at = ? WHERE project_id = ? AND asset_id = ?").run(now(), job.project_id, job.asset_id);
        return {
          ...job,
          previewPath: join(store.previewsDir(job.project_id), `${job.asset_id}.webp`),
          thumbnailPath: join(store.thumbnailsDir(job.project_id), `${job.asset_id}.webp`),
        };
      });
      return claim();
    },
    async completeDerivativeJob(job, result = {}) {
      const timestamp = now();
      database.transaction(() => {
        if (result.error) {
          database.prepare("UPDATE derivative_jobs SET status = 'failed', error = ?, updated_at = ? WHERE project_id = ? AND asset_id = ?").run(String(result.error), timestamp, job.project_id, job.asset_id);
          return;
        }
        database.prepare("UPDATE assets SET preview_path = ?, thumbnail_path = ?, updated_at = ? WHERE project_id = ? AND id = ?").run(result.previewPath, result.thumbnailPath, timestamp, job.project_id, job.asset_id);
        database.prepare("UPDATE derivative_jobs SET status = 'completed', error = NULL, updated_at = ? WHERE project_id = ? AND asset_id = ?").run(timestamp, job.project_id, job.assetId ?? job.asset_id);
      })();
    },
    async derivativeStatus() {
      const rows = database.prepare("SELECT status, COUNT(*) AS count FROM derivative_jobs GROUP BY status").all();
      return Object.fromEntries(rows.map((row) => [row.status, row.count]));
    },
    async migrationStatus() {
      return Object.fromEntries(database.prepare("SELECT key, value FROM library_meta").all().map((row) => [row.key, row.value]));
    },
    async setMigrationState(state, details = {}) {
      const timestamp = now();
      const set = database.prepare("INSERT INTO library_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
      const write = database.transaction(() => {
        set.run("migration_state", state, timestamp);
        set.run("migration_details", JSON.stringify(details), timestamp);
      });
      write();
    },
    async recordMigrationIssue(issue) {
      database.prepare("INSERT INTO migration_issues (id, kind, path, detail, created_at) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), issue.kind, issue.path, issue.detail || null, now());
    },
    async clearMigrationIssues() {
      database.prepare("DELETE FROM migration_issues").run();
    },
    async listMigrationIssues() {
      return database.prepare("SELECT kind, path, detail FROM migration_issues ORDER BY created_at, path").all();
    },
    async verifyLibrary() {
      const rows = database.prepare("SELECT project_id, id, original_path, content_sha256 FROM assets ORDER BY project_id, id").all();
      const failures = [];
      for (const row of rows) {
        try {
          const actual = createHash("sha256").update(await readFile(row.original_path)).digest("hex");
          if (actual !== row.content_sha256) failures.push({ projectId: row.project_id, assetId: row.id, reason: "content-hash-mismatch" });
        } catch {
          failures.push({ projectId: row.project_id, assetId: row.id, reason: "original-missing" });
        }
      }
      return { assets: rows.length, failures, ok: failures.length === 0 };
    },
    close() {
      database.close();
    },
  };

  return store;
}

function openDatabase(databasePath) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.pragma("cache_size = -20000");
  database.pragma("temp_store = MEMORY");
  return database;
}

function initializeSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS library_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  `);
  const schemaRow = database.prepare("SELECT value FROM library_meta WHERE key = 'schema_version'").get();
  const existingVersion = schemaRow ? Number(schemaRow.value) : 0;
  if (!Number.isInteger(existingVersion) || existingVersion < 0) {
    throw new Error(`Invalid MOSA schema version: ${schemaRow?.value ?? ""}`);
  }
  if (existingVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(`MOSA schema version ${existingVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}.`);
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS groups (project_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (project_id, name));
    CREATE UNIQUE INDEX IF NOT EXISTS groups_project_name_ci_idx ON groups(project_id, name COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS assets (
      project_id TEXT NOT NULL,
      id TEXT NOT NULL,
      asset TEXT NOT NULL,
      original_path TEXT NOT NULL,
      preview_path TEXT,
      thumbnail_path TEXT,
      content_sha256 TEXT NOT NULL,
      prompt TEXT NOT NULL,
      skill TEXT NOT NULL,
      style TEXT NOT NULL,
      ratio TEXT NOT NULL,
      business_fields_json TEXT NOT NULL,
      theme TEXT NOT NULL,
      favorite INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      group_name TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      rating INTEGER NOT NULL DEFAULT 0,
      parent_asset_id TEXT,
      version_change TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL,
      source_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      search_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, id),
      UNIQUE (project_id, asset)
    );
    CREATE INDEX IF NOT EXISTS assets_project_created_idx ON assets(project_id, archived, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS assets_project_hash_idx ON assets(project_id, content_sha256);
    CREATE INDEX IF NOT EXISTS assets_group_idx ON assets(project_id, group_name);
    CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, normalized_name TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS asset_tags (project_id TEXT NOT NULL, asset_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (project_id, asset_id, tag_id));
    CREATE TABLE IF NOT EXISTS asset_versions (project_id TEXT NOT NULL, asset_id TEXT NOT NULL, parent_asset_id TEXT, change_summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, PRIMARY KEY (project_id, asset_id));
    CREATE TABLE IF NOT EXISTS derivative_jobs (project_id TEXT NOT NULL, asset_id TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (project_id, asset_id));
    CREATE INDEX IF NOT EXISTS derivative_jobs_status_idx ON derivative_jobs(status, created_at);
    CREATE TABLE IF NOT EXISTS migration_issues (id TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS asset_fts USING fts5(project_id UNINDEXED, asset_id UNINDEXED, content, tokenize='trigram');
  `);
  const timestamp = now();
  database.transaction(() => {
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(timestamp);
    database.exec("CREATE INDEX IF NOT EXISTS asset_versions_parent_idx ON asset_versions(project_id, parent_asset_id, created_at, asset_id)");
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?)").run(timestamp);
    database.prepare(`
      INSERT INTO library_meta (key, value, updated_at) VALUES ('schema_version', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      WHERE library_meta.value != excluded.value
    `).run(String(CURRENT_SCHEMA_VERSION), timestamp);
    database.prepare("INSERT OR IGNORE INTO library_meta (key, value, updated_at) VALUES ('migration_state', 'unmigrated', ?)").run(timestamp);
  })();
}

function saveAsset(database, metadata, options = {}) {
  const source = metadata.source || {};
  const searchText = searchableText(metadata);
  const unknownMetadata = unknownFields(metadata);
  const write = database.transaction(() => {
    database.prepare("INSERT OR IGNORE INTO projects (id, created_at) VALUES (?, ?)").run(metadata.project_id, metadata.created_at);
    const updateOnConflict = options.insertOnly ? "" : `
      ON CONFLICT(project_id, id) DO UPDATE SET
        prompt = excluded.prompt, skill = excluded.skill, style = excluded.style, ratio = excluded.ratio,
        business_fields_json = excluded.business_fields_json, theme = excluded.theme, favorite = excluded.favorite,
        archived = excluded.archived, group_name = excluded.group_name, category = excluded.category, rating = excluded.rating,
        parent_asset_id = excluded.parent_asset_id, version_change = excluded.version_change, source_type = excluded.source_type,
        source_json = excluded.source_json, metadata_json = excluded.metadata_json, search_text = excluded.search_text,
        updated_at = excluded.updated_at
    `;
    database.prepare(`
      INSERT INTO assets (
        project_id, id, asset, original_path, preview_path, thumbnail_path, content_sha256, prompt, skill, style, ratio,
        business_fields_json, theme, favorite, archived, group_name, category, rating, parent_asset_id, version_change,
        source_type, source_json, metadata_json, search_text, created_at, updated_at
      ) VALUES (
        @project_id, @id, @asset, @image_path, NULL, NULL, @content_sha256, @prompt, @skill, @style, @ratio,
        @business_fields_json, @theme, @favorite, @archived, @group_name, @category, @rating, @parent_asset_id, @version_change,
        @source_type, @source_json, @metadata_json, @search_text, @created_at, @updated_at
      )
      ${updateOnConflict}
    `).run({
      project_id: metadata.project_id,
      id: metadata.id,
      asset: metadata.asset,
      image_path: metadata.image_path,
      content_sha256: source.content_sha256 || "",
      prompt: metadata.prompt,
      skill: metadata.skill,
      style: metadata.style,
      ratio: metadata.ratio,
      business_fields_json: JSON.stringify(metadata.business_fields),
      theme: metadata.theme,
      favorite: metadata.favorite ? 1 : 0,
      archived: metadata.archived ? 1 : 0,
      group_name: metadata.group,
      category: metadata.category,
      rating: metadata.rating,
      parent_asset_id: metadata.parent_asset_id,
      version_change: metadata.version_change,
      source_type: String(source.type || "local-file"),
      source_json: JSON.stringify(source),
      metadata_json: JSON.stringify(unknownMetadata),
      search_text: searchText,
      created_at: metadata.created_at,
      updated_at: metadata.updated_at,
    });
    database.prepare("DELETE FROM asset_tags WHERE project_id = ? AND asset_id = ?").run(metadata.project_id, metadata.id);
    const insertTag = database.prepare("INSERT OR IGNORE INTO tags (id, normalized_name, name) VALUES (?, ?, ?)");
    const relateTag = database.prepare("INSERT OR IGNORE INTO asset_tags (project_id, asset_id, tag_id) VALUES (?, ?, ?)");
    for (const tag of metadata.tags) {
      const normalized = tag.trim().toLocaleLowerCase();
      if (!normalized) continue;
      const tagId = `tag-${createHash("sha256").update(normalized).digest("hex").slice(0, 20)}`;
      insertTag.run(tagId, normalized, tag.trim());
      relateTag.run(metadata.project_id, metadata.id, tagId);
    }
    if (metadata.group) database.prepare("INSERT OR IGNORE INTO groups (project_id, name, created_at) VALUES (?, ?, ?)").run(metadata.project_id, metadata.group, metadata.created_at);
    database.prepare(`
      INSERT INTO asset_versions (project_id, asset_id, parent_asset_id, change_summary, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, asset_id) DO UPDATE SET parent_asset_id = excluded.parent_asset_id, change_summary = excluded.change_summary
    `).run(metadata.project_id, metadata.id, metadata.parent_asset_id, metadata.version_change, metadata.created_at);
    database.prepare("DELETE FROM asset_fts WHERE project_id = ? AND asset_id = ?").run(metadata.project_id, metadata.id);
    database.prepare("INSERT INTO asset_fts (project_id, asset_id, content) VALUES (?, ?, ?)").run(metadata.project_id, metadata.id, searchText);
    if (options.enqueueDerivative) {
      database.prepare(`
        INSERT INTO derivative_jobs (project_id, asset_id, status, attempts, created_at, updated_at)
        VALUES (?, ?, 'pending', 0, ?, ?)
        ON CONFLICT(project_id, asset_id) DO UPDATE SET status = 'pending', error = NULL, updated_at = excluded.updated_at
      `).run(metadata.project_id, metadata.id, metadata.updated_at, metadata.updated_at);
    }
  });
  write();
}

function rowToAsset(database, row) {
  const metadata = parseJson(row.metadata_json, {});
  const source = parseJson(row.source_json, {});
  const tags = database.prepare(`
    SELECT t.name FROM tags t JOIN asset_tags at ON at.tag_id = t.id
    WHERE at.project_id = ? AND at.asset_id = ? ORDER BY t.name COLLATE NOCASE
  `).all(row.project_id, row.id).map((tag) => tag.name);
  const child_asset_ids = database.prepare("SELECT asset_id FROM asset_versions WHERE project_id = ? AND parent_asset_id = ? ORDER BY created_at, asset_id").all(row.project_id, row.id).map((child) => child.asset_id);
  return withRuntimeUrls({
    ...metadata,
    id: row.id,
    project_id: row.project_id,
    asset: row.asset,
    image_path: row.original_path,
    prompt_path: null,
    prompt: row.prompt,
    skill: row.skill,
    style: row.style,
    ratio: row.ratio,
    business_fields: parseJson(row.business_fields_json, {}),
    theme: row.theme,
    tags,
    favorite: Boolean(row.favorite),
    archived: Boolean(row.archived),
    group: row.group_name,
    category: row.category,
    rating: row.rating,
    parent_asset_id: row.parent_asset_id,
    version_change: row.version_change,
    child_asset_ids,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source,
    preview_path: row.preview_path,
    thumbnail_path: row.thumbnail_path,
  });
}

function withRuntimeUrls(asset) {
  const base = `/library/${encodeURIComponent(asset.project_id)}`;
  const original = `${base}/images/${encodeURIComponent(asset.asset)}`;
  return {
    ...asset,
    image_url: original,
    preview_url: asset.preview_path ? `${base}/previews/${encodeURIComponent(asset.id)}.webp` : original,
    thumbnail_url: asset.thumbnail_path ? `${base}/thumbnails/${encodeURIComponent(asset.id)}.webp` : original,
    prompt_file: null,
  };
}

function appendFilterConditions(conditions, params, filters) {
  if (filters.source) {
    conditions.push("a.source_type = @source");
    params.source = filters.source;
  }
  if (filters.group) {
    conditions.push("a.group_name = @group");
    params.group = filters.group;
  }
  if (filters.category) {
    conditions.push("a.category = @category");
    params.category = filters.category;
  }
  if (filters.style) {
    conditions.push("a.style = @style");
    params.style = filters.style;
  }
  if (filters.favorite) conditions.push("(a.rating > 0 OR a.favorite = 1)");
  if (filters.recent) {
    conditions.push("a.created_at >= @recentSince");
    params.recentSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  }
}

function countNamedValues(database, projectId, column, limit = 0) {
  const rows = database.prepare(`
    SELECT ${column} AS name, COUNT(*) AS count FROM assets
    WHERE project_id = ? AND archived = 0 AND ${column} != ''
    GROUP BY ${column} ORDER BY count DESC, name COLLATE NOCASE${limit ? " LIMIT ?" : ""}
  `).all(...(limit ? [projectId, limit] : [projectId]));
  return rows.map((row) => [row.name, row.count]);
}

function normalizeAssetMetadata(input) {
  const businessFields = parseBusinessFields(input.business_fields);
  return {
    ...Object.fromEntries(Object.entries(input).filter(([key]) => !NORMALIZED_METADATA_KEYS.has(key))),
    id: sanitizeId(input.id, "asset"),
    project_id: sanitizeProjectId(input.project_id || input.projectId || DEFAULT_PROJECT_ID),
    asset: sanitizeFileName(input.asset),
    image_path: resolve(input.image_path),
    prompt_path: input.prompt_path || null,
    prompt: String(input.prompt || ""),
    skill: String(input.skill || ""),
    style: String(input.style || ""),
    ratio: String(input.ratio || ""),
    business_fields: businessFields,
    theme: String(input.theme || ""),
    tags: uniqueArray(input.tags || []),
    favorite: Boolean(input.favorite),
    archived: Boolean(input.archived),
    group: String(input.group || ""),
    category: String(input.category || ""),
    rating: Number.isFinite(input.rating) ? Math.min(5, Math.max(0, Math.round(input.rating))) : 0,
    parent_asset_id: normalizeParentAssetId(input.parent_asset_id ?? input.parentAssetId),
    version_change: String(input.version_change || input.changeSummary || ""),
    child_asset_ids: uniqueArray(input.child_asset_ids || []),
    created_at: input.created_at || now(),
    updated_at: input.updated_at || now(),
    source: input.source && typeof input.source === "object" ? input.source : {},
  };
}

function unknownFields(metadata) {
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !NORMALIZED_METADATA_KEYS.has(key)));
}

function searchableText(metadata) {
  return [
    metadata.id, metadata.asset, metadata.prompt, metadata.skill, metadata.style, metadata.theme, metadata.group, metadata.category,
    ...(metadata.tags || []), ...Object.values(metadata.business_fields || {}), ...Object.values(metadata.source || {}),
  ].map((value) => typeof value === "string" || typeof value === "number" ? String(value) : "").join(" ");
}

function useFts(query) {
  return [...String(query || "").trim()].length >= 3;
}

function buildFtsQuery(query) {
  return String(query).trim().split(/\s+/).filter(Boolean).map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

function normalizeLimit(value) {
  if (value === 0 || value === "0") return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(parsed), MAX_PAGE_SIZE);
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.id })).toString("base64url");
}

function parseCursor(value) {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (typeof cursor?.createdAt !== "string" || typeof cursor?.id !== "string") throw new Error();
    return cursor;
  } catch {
    throw new Error("Invalid asset cursor.");
  }
}

async function resolveReadableImagePath(store, value, trustedSourceRoots = []) {
  const requestedPath = resolveRequiredPath(value, "imagePath");
  if (!IMAGE_EXTENSIONS.has(extname(requestedPath).toLowerCase())) throw new Error(`Unsupported image type: ${requestedPath}`);
  const requestedStat = await lstat(requestedPath);
  if (requestedStat.isSymbolicLink()) throw new Error(`Refusing to import symbolic links: ${requestedPath}`);
  if (!requestedStat.isFile()) throw new Error(`imagePath is not a file: ${requestedPath}`);
  const readablePath = await realpath(requestedPath);
  await assertWithinReadableProject(store, readablePath, trustedSourceRoots);
  return { sourcePath: requestedPath, readablePath };
}

async function assertWithinReadableProject(store, filePath, trustedSourceRoots = []) {
  const allowedRoots = [
    store.projectRoot,
    store.generatedImagesDir,
    store.codexImagesDir,
    store.assetsRoot,
    store.cowartPageAssetsDir,
    store.legacyAssetsRoot,
    ...(Array.isArray(trustedSourceRoots) ? trustedSourceRoots : []),
  ].filter((root) => typeof root === "string" && root);
  const roots = (await Promise.all(allowedRoots.map(async (root) => {
    try { return await realpath(root); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }))).filter(Boolean);
  if (!roots.some((root) => filePath === root || isSafeChildPath(root, filePath))) throw new Error(`Refusing to import outside the project roots: ${filePath}`);
}

async function assertStoredPath(root, filePath) {
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(filePath)]);
  const fileStat = await lstat(realFile);
  if (fileStat.isSymbolicLink() || !fileStat.isFile() || !isSafeChildPath(realRoot, realFile)) throw new Error("Unsafe asset path.");
}

async function codexSourceMetadata(store, filePath) {
  const configuredRoot = resolve(store.codexImagesDir);
  let root;
  try { root = await realpath(configuredRoot); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (!isSafeChildPath(root, filePath)) return null;
  const relativePath = relative(root, filePath);
  const [taskId] = relativePath.split(sep);
  return { codex_generated_images_root: configuredRoot, codex_task_id: taskId || null, codex_relative_path: relativePath };
}

async function hardLinkOrCopy(sourcePath, targetPath) {
  try { await link(sourcePath, targetPath); return "hard-link"; }
  catch (error) {
    if (!["EXDEV", "EPERM", "EOPNOTSUPP", "ENOTSUP", "EMLINK"].includes(error?.code)) throw error;
    await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
    return "copy";
  }
}

function isSqliteDuplicateError(error) {
  return ["SQLITE_CONSTRAINT_PRIMARYKEY", "SQLITE_CONSTRAINT_UNIQUE"].includes(error?.code);
}

function parseBusinessFields(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function assertSqliteVersionParent(database, projectId, assetId, parentAssetId) {
  if (!parentAssetId) return;
  if (parentAssetId === assetId) throw assetStoreError("VERSION_CYCLE", `Asset cannot be its own version parent: ${assetId}`);
  if (database.prepare("SELECT 1 FROM assets WHERE project_id = ? AND id = ?").get(projectId, parentAssetId)) return;
  const foreignProjects = database.prepare("SELECT project_id FROM assets WHERE id = ? AND project_id != ? ORDER BY project_id").all(parentAssetId, projectId).map((row) => row.project_id);
  throw versionParentError(parentAssetId, foreignProjects);
}

function findSqliteVersionRoot(database, projectId, assetId) {
  const visited = new Set();
  let currentAssetId = assetId;
  while (currentAssetId) {
    if (visited.has(currentAssetId)) throw assetStoreError("VERSION_CYCLE", `Version cycle detected at asset: ${currentAssetId}`);
    visited.add(currentAssetId);
    const row = database.prepare("SELECT id, parent_asset_id FROM assets WHERE project_id = ? AND id = ?").get(projectId, currentAssetId);
    if (!row) {
      if (currentAssetId === assetId) throw assetNotFoundError(assetId);
      const foreignProjects = database.prepare("SELECT project_id FROM assets WHERE id = ? AND project_id != ? ORDER BY project_id").all(currentAssetId, projectId).map((item) => item.project_id);
      throw versionParentError(currentAssetId, foreignProjects);
    }
    if (!row.parent_asset_id) return row.id;
    currentAssetId = row.parent_asset_id;
  }
  throw assetStoreError("VERSION_CYCLE", `Version cycle detected at asset: ${assetId}`);
}

function normalizeParentAssetId(value) {
  return value ? sanitizeId(value, "asset") : null;
}

function sanitizeProjectId(value) { return sanitizeId(value || DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ID); }
function sanitizeId(value, fallback) { return String(value || fallback).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || fallback; }
function sanitizeFileName(value) { const raw = basename(String(value || "asset.png")); const extension = extname(raw) || ".png"; const base = raw.slice(0, raw.length - extname(raw).length).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""); return `${base || "asset"}${extension}`; }
function slugName(value) { return sanitizeId(String(value || "asset").replace(/\.[^.]+$/, ""), "asset").slice(0, 56); }
function shortStamp() { return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`; }
function uniqueArray(values) { return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map(String))]; }
function normalizeGroupName(value) { return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80); }
function resolveRequiredPath(value, label) { if (!value || typeof value !== "string") throw new Error(`${label} is required.`); return resolve(value); }
function isSafeChildPath(parent, child) { const pathToChild = relative(parent, child); return pathToChild && !pathToChild.startsWith("..") && !pathToChild.includes(`..${sep}`); }
function now() { return new Date().toISOString(); }
