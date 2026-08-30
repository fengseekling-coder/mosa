import Database from "better-sqlite3";
import { constants as fsConstants, createReadStream, existsSync, mkdirSync } from "node:fs";
import { copyFile, link, lstat, mkdir, readFile, readdir, realpath, stat, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { isPathInside } from "./path-safety.mjs";
import {
  assetAlreadyExistsError,
  assetNotFoundError,
  assetStoreError,
  automaticIngestDuplicateError,
  automaticImportSuppressedError,
  assertMutableVersionPatch,
  buildAssetVersionHistory,
  derivedAssetSource,
  pickVersionOverrides,
  requireVersionChange,
  versionParentError,
} from "./asset-version-history.mjs";
import { createdAtTimestamp, normalizeCreatedAt, recentCutoffTimestamp } from "./recent-window.js";
import { buildRecipeSnapshot, normalizeSnapshotReferences } from "./recipe-snapshot.js";
import { assetSortName, normalizeAssetSort } from "./asset-sort.js";
import {
  ASSET_SEARCH_WEIGHTS,
  assetMatchesSearchKind,
  assetSearchKind,
  normalizeAssetSearchQuery,
} from "./asset-search.mjs";
import { relinkCodexAssets } from "./codex-hardlink.js";
import { PIXEL_HASH_VERSION, safePixelDigest } from "./image-pixel-hash.js";
import { resolveSourceLocations } from "./source-locations.js";
import {
  assertGenerationRelationUserMutable,
  assertGenerationRelationAcyclic,
  buildAssetGenerationHistory,
  buildGenerationLineage,
  generationHistoryError,
  normalizeGenerationEvent,
  normalizeGenerationRelation,
  normalizeGenerationRelationCandidate,
  preserveTrustedGenerationEvent,
  preserveTrustedGenerationRelation,
  resolveGenerationRelationCandidates,
} from "./generation-history.mjs";

const IMAGE_EXTENSIONS = new Set([".apng", ".avif", ".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".m4v", ".mov", ".mp4", ".webm"]);
const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);
// Shared with the gallery's isVideoAsset rule: explicit media_kind wins, then the
// file extension. Exposed to SQL via mosa_media_kind for the V2 type filter.
function mediaKindOf(asset = {}) {
  const kind = asset?.source?.media_kind || asset?.business_fields?.media_kind;
  if (kind === "video") return "video";
  if (kind === "image") return "image";
  const match = /\.([a-z0-9]+)(?:$|\?)/i.exec(String(asset?.image_path || ""));
  const ext = match ? `.${match[1].toLowerCase()}` : "";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "unknown";
}
const DEFAULT_PROJECT_ID = "default";
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 250;
export const STYLE_FACET_LIMIT = 200;
const CURRENT_SCHEMA_VERSION = 12;
const PAGE_ASSET_COLUMNS = [
  "project_id", "id", "asset", "original_path", "preview_path", "medium_path", "thumbnail_path",
  "prompt", "skill", "style", "ratio", "business_fields_json", "theme", "favorite", "archived",
  "group_name", "category", "rating", "parent_asset_id", "version_change", "created_at", "updated_at",
  "source_json", "metadata_json", "sort_name",
].map((column) => `a.${column}`).join(", ");

const CANONICAL_SOURCE_TYPES = new Set([
  "web-chatgpt", "web-gemini", "web-flow", "web-google-ai-studio",
  "codex-generated", "grok-generated", "cowart-generated",
]);

function searchableObjectText(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return Object.values(value).flatMap((item) => Array.isArray(item) ? item : [item])
    .filter((item) => typeof item === "string" || typeof item === "number")
    .map(String)
    .join("\u001f");
}

function tagsSearchText(tags) {
  return (Array.isArray(tags) ? tags : [])
    .map((tag) => String(tag || "").trim())
    .filter(Boolean)
    .join("\u001f");
}

function canonicalSourceTypeOf(asset = {}) {
  const sourceType = String(asset?.source?.type || asset?.source_type || asset?.sourceType || "local-file");
  if (CANONICAL_SOURCE_TYPES.has(sourceType)) return sourceType;
  const provider = String(asset?.source?.provider || asset?.business_fields?.provider || "").toLowerCase();
  const generationTool = String(asset?.source?.generation_tool || asset?.business_fields?.generation_tool || "").toLowerCase();
  if (provider === "chatgpt") return "web-chatgpt";
  if (provider === "gemini") return "web-gemini";
  if (provider === "flow") return "web-flow";
  if (provider === "google-ai-studio") return "web-google-ai-studio";
  if (generationTool === "codex") return "codex-generated";
  if (generationTool === "grok") return "grok-generated";
  if (generationTool === "cowart") return "cowart-generated";
  return sourceType;
}

const NORMALIZED_METADATA_KEYS = new Set([
  "id", "project_id", "projectId", "asset", "image_path", "prompt_path", "prompt", "skill", "style", "ratio", "business_fields", "theme",
  "tags", "favorite", "archived", "group", "category", "rating", "parent_asset_id", "parentAssetId", "version_change", "changeSummary",
  "child_asset_ids", "created_at", "updated_at", "source", "sourceType", "imagePath", "fileName", "assetId", "preview_path", "medium_path", "thumbnail_path",
  "image_url", "preview_url", "medium_url", "thumbnail_url", "preview_ready", "medium_ready", "thumbnail_ready", "prompt_file",
  "recipe_snapshots", "active_recipe_snapshot_id", "recipe_change_summary",
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
  const { codexImagesDir, cowartCanvasDir } = resolveSourceLocations({
    env: process.env,
    overrides: {
      codexImagesDir: options.codexImagesDir,
      cowartCanvasDir: options.cowartCanvasDir,
    },
  });
  const cowartPageAssetsDir = join(cowartCanvasDir, "pages");
  const databasePath = sqliteDatabasePath(libraryDir);

  const database = openDatabase(databasePath);
  try {
    initializeSchema(database);
    if (options.initializeFreshLibrary === true) {
      const migrationState = database.prepare("SELECT value FROM library_meta WHERE key = 'migration_state'").get()?.value;
      if (migrationState === "unmigrated") {
        const timestamp = now();
        const writeFreshState = database.transaction(() => {
          const set = database.prepare("INSERT INTO library_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
          set.run("migration_state", "completed", timestamp);
          set.run("migration_details", JSON.stringify({ source: "fresh-library" }), timestamp);
        });
        writeFreshState();
      }
    }
  } catch (error) {
    database.close();
    throw error;
  }
  const ftsPageCache = new Map();
  let localAssetRevision = 0;
  const invalidateFtsPageCache = () => {
    localAssetRevision += 1;
    ftsPageCache.clear();
  };

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
    mediumsDir(projectId = DEFAULT_PROJECT_ID) {
      return join(this.projectDir(projectId), "mediums");
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
    async libraryRevision() {
      const dataVersion = database.pragma("data_version", { simple: true });
      return `sqlite:${dataVersion}:${localAssetRevision}`;
    },
    async ensureProject(projectId = DEFAULT_PROJECT_ID) {
      const cleanProjectId = sanitizeProjectId(projectId);
      await Promise.all([
        mkdir(this.imagesDir(cleanProjectId), { recursive: true }),
        mkdir(this.previewsDir(cleanProjectId), { recursive: true }),
        mkdir(this.mediumsDir(cleanProjectId), { recursive: true }),
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
      const result = await this.listAssetPage({ ...filters, limit: 0, collapseStacks: false });
      return result.assets;
    },
    async getAssetStack(projectId, stackId) {
      const cleanProjectId = await this.ensureProject(projectId || DEFAULT_PROJECT_ID);
      const cleanStackId = sanitizeId(stackId, "stack");
      const summary = stackSummary(database, cleanProjectId, cleanStackId);
      if (!summary) throw assetStoreError("STACK_NOT_FOUND", `Stack not found: ${cleanStackId}`);
      return summary;
    },
    async listAssetStackAssets(projectId, stackId, filters = {}) {
      const cleanProjectId = await this.ensureProject(projectId || DEFAULT_PROJECT_ID);
      const cleanStackId = sanitizeId(stackId, "stack");
      const stack = stackSummary(database, cleanProjectId, cleanStackId);
      if (!stack) throw assetStoreError("STACK_NOT_FOUND", `Stack not found: ${cleanStackId}`);
      const conditions = ["a.project_id = @projectId", "a.archived = 0", "sm.stack_id = @stackId"];
      const params = { projectId: cleanProjectId, stackId: cleanStackId };
      appendFilterConditions(conditions, params, filters);
      appendSearchConditions(conditions, params, filters.query, { alias: "a", prefix: "stack" });
      const requestedSort = String(filters.sort || "manual").trim().toLowerCase();
      const orderBy = requestedSort === "name"
        ? "a.sort_name ASC, a.id ASC"
        : requestedSort === "oldest"
          ? "a.created_at ASC, a.id ASC"
          : requestedSort === "newest"
            ? "a.created_at DESC, a.id DESC"
            : "sm.position ASC, a.id ASC";
      const rows = database.prepare(`
        SELECT ${PAGE_ASSET_COLUMNS}, sm.position AS stack_position
        FROM asset_stack_members sm
        JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY ${orderBy}
      `).all(params);
      return {
        stack,
        assets: rows.map((row) => ({
          ...rowToAsset(database, row, { includeRelations: false }),
          stack_position: Number(row.stack_position),
        })),
        page: { total: rows.length, nextCursor: null },
      };
    },
    async createAssetStack(projectId, assetIds, options = {}) {
      const cleanProjectId = await this.ensureProject(projectId || DEFAULT_PROJECT_ID);
      const ids = [...new Set((Array.isArray(assetIds) ? assetIds : []).map((id) => sanitizeId(id, "asset")))];
      if (ids.length < 2) throw assetStoreError("STACK_NEEDS_MULTIPLE_ASSETS", "A stack requires at least two assets.");
      const coverAssetId = sanitizeId(options.coverAssetId || ids[0], "asset");
      if (!ids.includes(coverAssetId)) throw assetStoreError("STACK_COVER_NOT_MEMBER", "Stack cover must be one of its assets.");
      const stackId = `stack-${randomUUID()}`;
      const orderedIds = [coverAssetId, ...ids.filter((id) => id !== coverAssetId)];
      const timestamp = now();
      database.transaction(() => {
        const getAssetRow = database.prepare("SELECT id, archived, created_at, sort_name FROM assets WHERE project_id = ? AND id = ?");
        const getMembership = database.prepare("SELECT stack_id FROM asset_stack_members WHERE project_id = ? AND asset_id = ?");
        let coverRow = null;
        for (const assetId of orderedIds) {
          const row = getAssetRow.get(cleanProjectId, assetId);
          if (!row) throw assetNotFoundError(assetId);
          if (row.archived) throw assetStoreError("STACK_ASSET_ARCHIVED", `Archived asset cannot be stacked: ${assetId}`);
          const membership = getMembership.get(cleanProjectId, assetId);
          if (membership) throw assetStoreError("ASSET_ALREADY_STACKED", `Asset ${assetId} already belongs to stack ${membership.stack_id}.`);
          if (assetId === coverAssetId) coverRow = row;
        }
        database.prepare(`
          INSERT INTO asset_stacks (project_id, id, created_at, updated_at, sort_created_at, sort_name)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          cleanProjectId,
          stackId,
          timestamp,
          timestamp,
          String(coverRow?.created_at || timestamp),
          String(coverRow?.sort_name || ""),
        );
        const insertMember = database.prepare(`
          INSERT INTO asset_stack_members (project_id, stack_id, asset_id, position, added_at)
          VALUES (?, ?, ?, ?, ?)
        `);
        orderedIds.forEach((assetId, index) => insertMember.run(cleanProjectId, stackId, assetId, index, timestamp));
      })();
      invalidateFtsPageCache();
      return stackSummary(database, cleanProjectId, stackId);
    },
    async addAssetsToStack(projectId, stackId, assetIds) {
      const cleanProjectId = await this.ensureProject(projectId || DEFAULT_PROJECT_ID);
      const cleanStackId = sanitizeId(stackId, "stack");
      const ids = [...new Set((Array.isArray(assetIds) ? assetIds : []).map((id) => sanitizeId(id, "asset")))];
      if (!ids.length) return this.getAssetStack(cleanProjectId, cleanStackId);
      const timestamp = now();
      database.transaction(() => {
        if (!stackSummary(database, cleanProjectId, cleanStackId)) throw assetStoreError("STACK_NOT_FOUND", `Stack not found: ${cleanStackId}`);
        const getAssetRow = database.prepare("SELECT id, archived FROM assets WHERE project_id = ? AND id = ?");
        const getMembership = database.prepare("SELECT stack_id FROM asset_stack_members WHERE project_id = ? AND asset_id = ?");
        let nextPosition = Number(database.prepare(`
          SELECT COALESCE(MAX(position), -1) + 1 AS next_position
          FROM asset_stack_members WHERE project_id = ? AND stack_id = ?
        `).get(cleanProjectId, cleanStackId).next_position);
        const insertMember = database.prepare(`
          INSERT INTO asset_stack_members (project_id, stack_id, asset_id, position, added_at)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const assetId of ids) {
          const row = getAssetRow.get(cleanProjectId, assetId);
          if (!row) throw assetNotFoundError(assetId);
          if (row.archived) throw assetStoreError("STACK_ASSET_ARCHIVED", `Archived asset cannot be stacked: ${assetId}`);
          const membership = getMembership.get(cleanProjectId, assetId);
          if (membership?.stack_id === cleanStackId) continue;
          if (membership) throw assetStoreError("ASSET_ALREADY_STACKED", `Asset ${assetId} already belongs to stack ${membership.stack_id}.`);
          insertMember.run(cleanProjectId, cleanStackId, assetId, nextPosition, timestamp);
          nextPosition += 1;
        }
        database.prepare("UPDATE asset_stacks SET updated_at = ? WHERE project_id = ? AND id = ?")
          .run(timestamp, cleanProjectId, cleanStackId);
      })();
      invalidateFtsPageCache();
      return stackSummary(database, cleanProjectId, cleanStackId);
    },
    async reorderAssetStack(projectId, stackId, assetIds) {
      const cleanProjectId = await this.ensureProject(projectId || DEFAULT_PROJECT_ID);
      const cleanStackId = sanitizeId(stackId, "stack");
      const ids = [...new Set((Array.isArray(assetIds) ? assetIds : []).map((id) => sanitizeId(id, "asset")))];
      database.transaction(() => {
        const current = database.prepare(`
          SELECT asset_id FROM asset_stack_members
          WHERE project_id = ? AND stack_id = ? ORDER BY position, asset_id
        `).all(cleanProjectId, cleanStackId).map((row) => row.asset_id);
        if (!current.length) throw assetStoreError("STACK_NOT_FOUND", `Stack not found: ${cleanStackId}`);
        if (ids.length !== current.length || current.some((id) => !ids.includes(id))) {
          throw assetStoreError("STACK_ORDER_MISMATCH", "Stack order must contain every member exactly once.");
        }
        database.prepare(`
          UPDATE asset_stack_members SET position = position + 1000000
          WHERE project_id = ? AND stack_id = ?
        `).run(cleanProjectId, cleanStackId);
        const update = database.prepare(`
          UPDATE asset_stack_members SET position = ?
          WHERE project_id = ? AND stack_id = ? AND asset_id = ?
        `);
        ids.forEach((assetId, index) => update.run(index, cleanProjectId, cleanStackId, assetId));
        database.prepare("UPDATE asset_stacks SET updated_at = ? WHERE project_id = ? AND id = ?")
          .run(now(), cleanProjectId, cleanStackId);
      })();
      invalidateFtsPageCache();
      return stackSummary(database, cleanProjectId, cleanStackId);
    },
    async removeAssetsFromStack(projectId, stackId, assetIds) {
      const cleanProjectId = await this.ensureProject(projectId || DEFAULT_PROJECT_ID);
      const cleanStackId = sanitizeId(stackId, "stack");
      const ids = [...new Set((Array.isArray(assetIds) ? assetIds : []).map((id) => sanitizeId(id, "asset")))];
      const outcome = database.transaction(() => {
        if (!stackSummary(database, cleanProjectId, cleanStackId)) throw assetStoreError("STACK_NOT_FOUND", `Stack not found: ${cleanStackId}`);
        const remove = database.prepare("DELETE FROM asset_stack_members WHERE project_id = ? AND stack_id = ? AND asset_id = ?");
        ids.forEach((assetId) => remove.run(cleanProjectId, cleanStackId, assetId));
        return compactAssetStack(database, cleanProjectId, cleanStackId);
      })();
      invalidateFtsPageCache();
      return { ...outcome, stack: outcome.dissolved ? null : stackSummary(database, cleanProjectId, cleanStackId) };
    },
    async dissolveAssetStack(projectId, stackId) {
      const cleanProjectId = await this.ensureProject(projectId || DEFAULT_PROJECT_ID);
      const cleanStackId = sanitizeId(stackId, "stack");
      const members = database.prepare(`
        SELECT asset_id FROM asset_stack_members
        WHERE project_id = ? AND stack_id = ? ORDER BY position, asset_id
      `).all(cleanProjectId, cleanStackId).map((row) => row.asset_id);
      const result = database.prepare("DELETE FROM asset_stacks WHERE project_id = ? AND id = ?").run(cleanProjectId, cleanStackId);
      if (!result.changes) throw assetStoreError("STACK_NOT_FOUND", `Stack not found: ${cleanStackId}`);
      invalidateFtsPageCache();
      return { id: cleanStackId, assetIds: members, dissolved: true };
    },
    async listAssetPage(filters = {}) {
      const projectId = await this.ensureProject(filters.projectId || DEFAULT_PROJECT_ID);
      const limit = normalizeLimit(filters.limit);
      const sort = normalizeAssetSort(filters.sort);
      const searchQuery = normalizeAssetSearchQuery(filters.query);
      const cursor = parseCursor(filters.cursor, sort, searchQuery);
      // The raw asset collection is the default API contract. Only the gallery
      // opts into collapsed logical nodes. Keeping these semantics separate
      // prevents exports/batch operations from silently losing Stack members.
      if (filters.collapseStacks && !filters.archived
        && database.prepare("SELECT 1 FROM asset_stacks WHERE project_id = ? LIMIT 1").get(projectId)) {
        return listCollapsedAssetPage(database, { filters, projectId, limit, sort, searchQuery, cursor });
      }
      const baseConditions = ["a.project_id = @projectId", filters.archived ? "a.archived = 1" : "a.archived = 0"];
      const params = { projectId };
      appendFilterConditions(baseConditions, params, filters);
      const pageConditions = [...baseConditions];
      if (cursor && !searchQuery) {
        if (sort === "name") {
          pageConditions.push("(a.sort_name > @cursorSortName OR (a.sort_name = @cursorSortName AND a.id > @cursorId))");
          params.cursorSortName = cursor.sortName;
        } else {
          const comparison = sort === "oldest" ? ">" : "<";
          pageConditions.push(`(a.created_at ${comparison} @cursorCreatedAt OR (a.created_at = @cursorCreatedAt AND a.id ${comparison} @cursorId))`);
          params.cursorCreatedAt = cursor.createdAt;
        }
        params.cursorId = cursor.id;
      }
      let pageFrom = "assets a";
      let countFrom = "assets a";
      let totalConditions = [...baseConditions];
      const searchTerms = searchQuery ? searchQuery.split(/\s+/u).filter(Boolean) : [];
      const searchKind = searchTerms.length ? assetSearchKind(searchQuery) : "";
      const indexedLikeTerms = !searchKind ? plainAsciiSearchTerms(filters.query) : [];
      const usesIndexedLike = indexedLikeTerms.length > 0;
      const indexedFtsTerms = usesIndexedLike ? indexedLikeTerms.filter((term) => [...term].length >= 3) : [];
      const indexedShortTerms = usesIndexedLike ? indexedLikeTerms.filter((term) => [...term].length < 3) : [];
      if (indexedFtsTerms.length) params.indexedFtsQuery = buildFtsQuery(indexedFtsTerms.join(" "));
      // FTS5's trigram tokenizer can index substring terms of three or more
      // Unicode characters. Use it to drive the candidate set whenever possible;
      // one/two-character terms remain LIKE predicates on that already narrowed
      // set (or on the project index when every term is short).
      const ftsTerms = usesIndexedLike ? [] : searchTerms.filter((term) => [...term].length >= 3);
      const likeTerms = searchTerms.filter((term) => [...term].length < 3);
      const usesFts = ftsTerms.length > 0;
      const searchScoreSql = searchKind ? buildSearchScoreSql(searchTerms, params) : "1";
      if (usesFts) {
        params.ftsQuery = buildFtsQuery(ftsTerms.join(" "));
        if (searchKind) {
          // Type-intent searches need global relevance ranking, so FTS drives the
          // candidate rows and the exact scorer ranks only those matches.
          pageFrom = "asset_fts JOIN assets a ON a.project_id = asset_fts.project_id AND a.id = asset_fts.asset_id";
          pageConditions.push("asset_fts.project_id = @projectId", "asset_fts.content MATCH @ftsQuery");
        } else {
          // Generic content searches already have exact AND membership from FTS.
          // Let the requested sort index drive the page so LIMIT can stop after
          // 101 matching assets instead of ranking/sorting every FTS hit.
          pageFrom = `assets a INDEXED BY ${sort === "name" ? "assets_project_name_idx" : "assets_project_created_idx"}`;
          pageConditions.push("a.id IN (SELECT asset_id FROM asset_fts WHERE project_id = @projectId AND content MATCH @ftsQuery)");
        }
        countFrom = "asset_fts JOIN assets a ON a.project_id = asset_fts.project_id AND a.id = asset_fts.asset_id";
        totalConditions.push("asset_fts.project_id = @projectId");
        totalConditions.push("asset_fts.content MATCH @ftsQuery");
      } else if (indexedFtsTerms.length) {
        pageFrom = `assets a INDEXED BY ${sort === "name" ? "assets_project_name_idx" : "assets_project_created_idx"}`;
        pageConditions.push("a.id IN (SELECT asset_id FROM asset_fts WHERE project_id = @projectId AND content MATCH @indexedFtsQuery)");
        countFrom = "asset_fts JOIN assets a ON a.project_id = asset_fts.project_id AND a.id = asset_fts.asset_id";
        totalConditions.push("asset_fts.project_id = @projectId", "asset_fts.content MATCH @indexedFtsQuery");
      } else if (searchTerms.length) {
        pageFrom = `assets a INDEXED BY ${sort === "name" ? "assets_project_name_idx" : "assets_project_created_idx"}`;
      }
      if (searchTerms.length) {
        const fallbackTerms = usesIndexedLike ? indexedShortTerms : (usesFts ? likeTerms : searchTerms);
        fallbackTerms.forEach((term, index) => {
          const key = `likeTerm${index}`;
          const condition = `LOWER(a.search_text) LIKE @${key} ESCAPE '\\'`;
          pageConditions.push(condition);
          totalConditions.push(condition);
          params[key] = `%${escapeLikePattern(term)}%`;
        });
      }
      if (searchKind) {
        params.searchKind = searchKind;
        const kindCondition = `mosa_asset_matches_search_kind(
          @searchKind, a.asset, a.id, a.prompt, a.skill, a.style, a.theme, a.group_name, a.category, a.tags_text
        ) = 1`;
        pageConditions.push(kindCondition);
        totalConditions.push(kindCondition);
      }
      const cacheKey = (usesFts || indexedFtsTerms.length) && limit > 0 ? JSON.stringify([
        projectId, limit, filters.cursor || null, Boolean(filters.archived), filters.query,
        filters.source || null, filters.group || null, filters.category || null, filters.style || null,
        filters.conversation || null, filters.generationBatch || null, filters.mediaKind || null,
        Boolean(filters.favorite), Boolean(filters.recent), filters.recentSince ?? null, sort,
      ]) : null;
      const dataVersion = cacheKey ? database.pragma("data_version", { simple: true }) : null;
      const cached = cacheKey ? ftsPageCache.get(cacheKey) : null;
      if (cached && cached.localAssetRevision === localAssetRevision && cached.dataVersion === dataVersion) {
        return structuredClone(cached.result);
      }
      const orderBy = (alias = "a") => sort === "name"
        ? `${alias}.sort_name ASC, ${alias}.id ASC`
        : (sort === "oldest" ? `${alias}.created_at ASC, ${alias}.id ASC` : `${alias}.created_at DESC, ${alias}.id DESC`);
      let searchCursorCondition = "";
      if (cursor && searchTerms.length) {
        params.cursorId = cursor.id;
        params.cursorCreatedAt = cursor.createdAt;
        params.cursorSortName = cursor.sortName;
        const secondaryAfter = sort === "name"
          ? "(sort_name > @cursorSortName OR (sort_name = @cursorSortName AND id > @cursorId))"
          : (sort === "oldest"
            ? "(created_at > @cursorCreatedAt OR (created_at = @cursorCreatedAt AND id > @cursorId))"
            : "(created_at < @cursorCreatedAt OR (created_at = @cursorCreatedAt AND id < @cursorId))");
        if (searchKind) {
          params.cursorSearchScore = cursor.searchScore;
          const rankedSecondary = secondaryAfter.replaceAll("sort_name", "r.sort_name").replaceAll("created_at", "r.created_at").replaceAll(" id", " r.id");
          searchCursorCondition = ` AND (r._search_score < @cursorSearchScore OR (r._search_score = @cursorSearchScore AND ${rankedSecondary}))`;
        } else {
          const pageSecondary = secondaryAfter.replaceAll("sort_name", "a.sort_name").replaceAll("created_at", "a.created_at").replaceAll(" id", " a.id");
          pageConditions.push(pageSecondary);
        }
      }
      // MATERIALIZED keeps the native relevance expression single-evaluation
      // even though the outer query references it in WHERE, ORDER BY and cursor
      // predicates.
      const select = searchKind
        ? `WITH ranked AS MATERIALIZED (
            SELECT ${PAGE_ASSET_COLUMNS}, (${searchScoreSql}) AS _search_score
            FROM ${pageFrom}
            WHERE ${pageConditions.join(" AND ")}
          )
          SELECT r.* FROM ranked r
          WHERE r._search_score > 0${searchCursorCondition}
          ORDER BY r._search_score DESC, ${orderBy("r")}`
        : `SELECT ${PAGE_ASSET_COLUMNS}, ${searchTerms.length ? 1 : 0} AS _search_score FROM ${pageFrom} WHERE ${pageConditions.join(" AND ")} ORDER BY ${orderBy("a")}`;
      // Keep the page query free of window aggregates. COUNT(*) OVER() makes SQLite materialise
      // every FTS match before it can apply LIMIT, which turns a 100-row gallery page into a
      // 50k-row sort. The separate count preserves the API's exact total while allowing the page
      // query to stop as soon as it has the next cursor row.
      const rows = limit > 0
        ? database.prepare(`${select} LIMIT @limit`).all({ ...params, limit: limit + 1 })
        : database.prepare(select).all(params);
      const hasMore = limit > 0 && rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const assets = annotateAssetStackCovers(
        database,
        pageRows.map((row) => rowToAsset(database, row, { includeRelations: false })),
        projectId,
      );
      const last = pageRows.at(-1);
      const canCountFtsDirectly = usesFts
        && !searchKind
        && likeTerms.length === 0
        && !filters.archived
        && baseConditions.length === 1;
      // FTS5's trigram tokenizer only indexes terms of three or more characters,
      // so a direct MATCH count is only equivalent to the LIKE page query when
      // every term is indexable; otherwise the count would report zero while the
      // page still matches rows ("ab hello" style queries).
      const allIndexedLikeTermsIndexable = indexedLikeTerms.every((term) => [...term].length >= 3);
      const canCountIndexedFtsDirectly = usesIndexedLike
        && allIndexedLikeTermsIndexable
        && !filters.archived
        && baseConditions.length === 1;
      const canUseDirectFtsCount = canCountFtsDirectly || canCountIndexedFtsDirectly;
      const hasArchivedAssets = canUseDirectFtsCount && database.prepare(`
        SELECT 1 FROM assets INDEXED BY assets_project_created_idx
        WHERE project_id = @projectId AND archived = 1 LIMIT 1
      `).get(params);
      const total = canUseDirectFtsCount && !hasArchivedAssets
        ? database.prepare("SELECT COUNT(*) AS count FROM asset_fts WHERE project_id = @projectId AND content MATCH @countFtsQuery").get({
          ...params,
          countFtsQuery: canCountFtsDirectly ? params.ftsQuery : params.indexedFtsQuery,
        }).count
        : database.prepare(`SELECT COUNT(*) AS count FROM ${countFrom} WHERE ${totalConditions.join(" AND ")}`).get(params).count;
      const result = {
        assets,
        page: {
          total,
          nextCursor: hasMore && last ? encodeCursor(last, sort, searchQuery) : null,
          limit: limit || total,
          sort,
        },
      };
      if (cacheKey) {
        if (ftsPageCache.size >= 64) ftsPageCache.clear();
        ftsPageCache.set(cacheKey, { localAssetRevision, dataVersion, result: structuredClone(result) });
      }
      return result;
    },
    async listGroups(projectId = DEFAULT_PROJECT_ID) {
      const cleanProjectId = await this.ensureProject(projectId);
      const recentSince = recentCutoffTimestamp();
      const stats = database.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN rating > 0 OR favorite = 1 THEN 1 ELSE 0 END) AS favorites,
          SUM(CASE WHEN created_at_epoch >= ? THEN 1 ELSE 0 END) AS recent,
          SUM(CASE WHEN source_type = 'codex-generated' THEN 1 ELSE 0 END) AS codex,
          SUM(CASE WHEN source_type = 'cowart-generated' THEN 1 ELSE 0 END) AS cowart,
          SUM(CASE WHEN source_type = 'grok-generated' THEN 1 ELSE 0 END) AS grok
        FROM assets WHERE project_id = ? AND archived = 0
      `).get(recentSince, cleanProjectId);
      const groups = database.prepare(`
        SELECT g.name, COUNT(a.id) AS count
        FROM groups g LEFT JOIN assets a ON a.project_id = g.project_id AND a.group_name = g.name AND a.archived = 0
        WHERE g.project_id = ? GROUP BY g.name ORDER BY count DESC, g.name COLLATE NOCASE
      `).all(cleanProjectId).map((row) => [row.name, row.count]);
      const sourceTypes = database.prepare(`
        SELECT a.source_group AS name, COUNT(*) AS count
        FROM assets a
        WHERE a.project_id = ? AND a.archived = 0
        GROUP BY name
        HAVING name != ''
        ORDER BY count DESC, name COLLATE NOCASE
      `).all(cleanProjectId).map((row) => [row.name, Number(row.count || 0)]);
      const categories = countNamedValues(database, cleanProjectId, "category");
      // The filter panel searches this list client-side, so it has to reach past
      // the handful of most-used styles. `styleTotal` reports the real distinct
      // count so a truncated list can say so instead of looking complete.
      const styles = countNamedValues(database, cleanProjectId, "style", STYLE_FACET_LIMIT);
      const styleTotal = database.prepare(`
        SELECT COUNT(DISTINCT style) AS count FROM assets
        WHERE project_id = ? AND archived = 0 AND style != ''
      `).get(cleanProjectId).count;
      return {
        total: Number(stats.total || 0),
        favorites: Number(stats.favorites || 0),
        recent: Number(stats.recent || 0),
        codex: Number(stats.codex || 0),
        cowart: Number(stats.cowart || 0),
        grok: Number(stats.grok || 0),
        sourceTypes,
        groups,
        categories,
        styles,
        styleTotal: Number(styleTotal || 0),
      };
    },
    async createGroup(input = {}) {
      const projectId = await this.ensureProject(input.projectId || DEFAULT_PROJECT_ID);
      const name = normalizeGroupName(input.name);
      if (!name) throw assetStoreError("GROUP_NAME_REQUIRED", "Group name is required.");
      const result = database.prepare("INSERT OR IGNORE INTO groups (project_id, name, created_at) VALUES (?, ?, ?)").run(projectId, name, now());
      if (!result.changes) throw assetStoreError("GROUP_ALREADY_EXISTS", `Group already exists: ${name}`);
      invalidateFtsPageCache();
      return { name, count: 0 };
    },
    async deleteGroup(projectId, groupName) {
      const pid = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const name = normalizeGroupName(groupName);
      if (!name) throw assetStoreError("GROUP_NAME_REQUIRED", "Group name is required.");

      const selectAssignedAssets = database.prepare("SELECT * FROM assets WHERE project_id = ? AND group_name = ?");
      const clearAssignment = database.prepare(`
        UPDATE assets
        SET group_name = '', search_text = ?, updated_at = ?
        WHERE project_id = ? AND id = ?
      `);
      const deleteFtsEntry = database.prepare("DELETE FROM asset_fts WHERE project_id = ? AND asset_id = ?");
      const insertFtsEntry = database.prepare("INSERT INTO asset_fts (project_id, asset_id, content) VALUES (?, ?, ?)");
      const deleteGroup = database.prepare("DELETE FROM groups WHERE project_id = ? AND name = ?");
      const timestamp = now();

      database.transaction(() => {
        for (const row of selectAssignedAssets.all(pid, name)) {
          const metadata = rowToAsset(database, row);
          metadata.group = "";
          const searchText = searchableText(metadata);
          clearAssignment.run(searchText, timestamp, pid, row.id);
          deleteFtsEntry.run(pid, row.id);
          insertFtsEntry.run(pid, row.id, searchText);
        }

        const result = deleteGroup.run(pid, name);
        if (!result.changes) throw assetStoreError("GROUP_NOT_FOUND", `Group not found: ${name}`);
      })();
      invalidateFtsPageCache();

      return { success: true, name };
    },
    /**
     * Content-hash lookup served by `assets_project_hash_idx` instead of listing the project.
     * Archived rows are included, and the ordering matches the JSON store: active before
     * archived, newest first.
     *
     * `INDEXED BY` is deliberate. Left to choose, the planner prefers `assets_project_created_idx`
     * because it also satisfies the ORDER BY — and then walks every row in the project, which is
     * the whole cost this method exists to avoid and is worst on a miss, the common case while
     * ingesting. Pinning the index keeps the lookup proportional to the number of assets sharing
     * the hash, and makes a dropped index fail loudly instead of silently degrading.
     */
    async findAssetByContentHash(projectId, contentHash) {
      const hash = String(contentHash || "");
      if (!hash) return null;
      const row = database.prepare(`
        SELECT * FROM assets INDEXED BY assets_project_hash_idx
        WHERE project_id = ? AND content_sha256 = ?
        ORDER BY archived ASC, mosa_normalize_created_at(created_at) DESC, id DESC LIMIT 1
      `).get(sanitizeProjectId(projectId || DEFAULT_PROJECT_ID), hash);
      return row ? rowToAsset(database, row) : null;
    },
    /**
     * Bridge reconciliation needs to answer "has this exact source file already
     * been archived?" without materialising the entire library. `source_path`
     * mirrors `source.path` into an indexed scalar column for that hot lookup.
     * Archived rows are intentionally included because automatic bridges must
     * never re-import an asset merely because the user archived it.
     */
    async findAssetBySourcePath(projectId, sourcePath) {
      const path = String(sourcePath || "");
      if (!path) return null;
      const row = database.prepare(`
        SELECT * FROM assets INDEXED BY assets_project_source_path_idx
        WHERE project_id = ? AND source_path = ?
        ORDER BY archived ASC, mosa_normalize_created_at(created_at) DESC, id DESC LIMIT 1
      `).get(sanitizeProjectId(projectId || DEFAULT_PROJECT_ID), path);
      return row ? rowToAsset(database, row, { includeRelations: false }) : null;
    },
    async findAssetByPixelHash(projectId, pixelHash) {
      const hash = String(pixelHash || "");
      if (!hash) return null;
      const row = database.prepare(`
        SELECT * FROM assets INDEXED BY assets_project_pixel_hash_idx
        WHERE project_id = ? AND pixel_sha256 = ?
          AND json_extract(source_json, '$.pixel_hash_version') = ?
        ORDER BY archived ASC, mosa_normalize_created_at(created_at) DESC, id DESC LIMIT 1
      `).get(sanitizeProjectId(projectId || DEFAULT_PROJECT_ID), hash, PIXEL_HASH_VERSION);
      return row ? rowToAsset(database, row) : null;
    },
    async findAutomaticIngestSuppression(projectId = DEFAULT_PROJECT_ID, hashes = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const normalized = normalizeSuppressionHashes(hashes);
      if (!normalized.content_sha256 && !normalized.pixel_sha256) return null;
      const byContent = normalized.content_sha256
        ? database.prepare(`
          SELECT project_id, content_sha256, pixel_sha256, pixel_hash_version, deleted_at, reason
          FROM automatic_ingest_suppressions INDEXED BY automatic_suppressions_project_content_idx
          WHERE project_id = ? AND content_sha256 = ?
          ORDER BY deleted_at DESC LIMIT 1
        `).get(cleanProjectId, normalized.content_sha256)
        : null;
      if (byContent) return suppressionRowToObject(byContent);
      const byPixel = normalized.pixel_sha256
        ? database.prepare(`
          SELECT project_id, content_sha256, pixel_sha256, pixel_hash_version, deleted_at, reason
          FROM automatic_ingest_suppressions INDEXED BY automatic_suppressions_project_pixel_idx
          WHERE project_id = ? AND pixel_sha256 = ?
            AND (? = '' OR pixel_hash_version = ?)
          ORDER BY deleted_at DESC LIMIT 1
        `).get(cleanProjectId, normalized.pixel_sha256, normalized.pixel_hash_version, normalized.pixel_hash_version)
        : null;
      return byPixel ? suppressionRowToObject(byPixel) : null;
    },
    async listAutomaticIngestSuppressions(projectId = DEFAULT_PROJECT_ID) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      return database.prepare(`
        SELECT project_id, content_sha256, pixel_sha256, pixel_hash_version, deleted_at, reason
        FROM automatic_ingest_suppressions INDEXED BY automatic_suppressions_project_deleted_idx
        WHERE project_id = ?
        ORDER BY deleted_at DESC, content_sha256, pixel_sha256, pixel_hash_version
      `).all(cleanProjectId).map(suppressionRowToObject);
    },
    async listAutomaticIngestSuppressionPage(projectId = DEFAULT_PROJECT_ID, options = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const limit = normalizeSuppressionPageLimit(options.limit);
      const cursor = parseSuppressionCursor(options.cursor);
      const params = { projectId: cleanProjectId };
      const conditions = ["project_id = @projectId"];
      if (cursor) {
        conditions.push(`(
          deleted_at < @cursorDeletedAt
          OR (deleted_at = @cursorDeletedAt AND (
            content_sha256 > @cursorContentHash
            OR (content_sha256 = @cursorContentHash AND (
              pixel_sha256 > @cursorPixelHash
              OR (pixel_sha256 = @cursorPixelHash AND pixel_hash_version > @cursorPixelHashVersion)
            ))
          ))
        )`);
        params.cursorDeletedAt = cursor.deletedAt;
        params.cursorContentHash = cursor.contentHash;
        params.cursorPixelHash = cursor.pixelHash;
        params.cursorPixelHashVersion = cursor.pixelHashVersion;
      }
      const rows = database.prepare(`
        SELECT project_id, content_sha256, pixel_sha256, pixel_hash_version, deleted_at, reason
        FROM automatic_ingest_suppressions INDEXED BY automatic_suppressions_project_deleted_idx
        WHERE ${conditions.join(" AND ")}
        ORDER BY deleted_at DESC, content_sha256, pixel_sha256, pixel_hash_version
        LIMIT @limit
      `).all({ ...params, limit: limit + 1 });
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const last = pageRows.at(-1);
      return {
        suppressions: pageRows.map(suppressionRowToObject),
        page: {
          limit,
          nextCursor: hasMore && last ? encodeSuppressionCursor(last) : null,
        },
      };
    },
    async clearAutomaticIngestSuppression(projectId = DEFAULT_PROJECT_ID, hashes = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const normalized = normalizeSuppressionHashes(hashes);
      if (!normalized.content_sha256 && !normalized.pixel_sha256) return 0;
      const result = database.prepare(`
        DELETE FROM automatic_ingest_suppressions
        WHERE project_id = ?
          AND ((? != '' AND content_sha256 = ?)
            OR (? != '' AND pixel_sha256 = ? AND (? = '' OR pixel_hash_version = ?)))
      `).run(
        cleanProjectId,
        normalized.content_sha256,
        normalized.content_sha256,
        normalized.pixel_sha256,
        normalized.pixel_sha256,
        normalized.pixel_hash_version,
        normalized.pixel_hash_version,
      );
      return result.changes;
    },
    async recordAutomaticIngestSuppression(projectId = DEFAULT_PROJECT_ID, record = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const normalized = normalizeSuppressionRecord({ ...record, project_id: cleanProjectId });
      if (!normalized.content_sha256 && !normalized.pixel_sha256) return null;
      database.prepare(`
        INSERT INTO automatic_ingest_suppressions (project_id, content_sha256, pixel_sha256, pixel_hash_version, deleted_at, reason)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, content_sha256, pixel_sha256, pixel_hash_version) DO UPDATE SET
          deleted_at = excluded.deleted_at,
          reason = excluded.reason
      `).run(
        normalized.project_id,
        normalized.content_sha256,
        normalized.pixel_sha256,
        normalized.pixel_hash_version,
        normalized.deleted_at,
        normalized.reason,
      );
      return normalized;
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
      const contentHash = await sha256File(readablePath);
      const claimedContentHash = normalizeHash(input.source?.content_sha256);
      let pixelHash = normalizeHash(input.source?.pixel_sha256);
      let pixelHashVersion = String(input.source?.pixel_hash_version || "").trim();
      let pixelIdentityRecomputed = false;
      const preflightPixelHash = context?.ingestMode === "automatic"
        && pixelHashVersion === PIXEL_HASH_VERSION
        && claimedContentHash !== contentHash
        ? ""
        : pixelHash;
      const preflightPixelHashVersion = preflightPixelHash ? pixelHashVersion : "";
      if (context?.ingestMode === "automatic") {
        const suppression = await this.findAutomaticIngestSuppression(projectId, {
          content_sha256: contentHash,
          pixel_sha256: preflightPixelHash,
          pixel_hash_version: preflightPixelHashVersion,
        });
        if (suppression) throw automaticImportSuppressedError();
      }
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
      const managedContentHash = await sha256File(imagePath);
      if (managedContentHash !== contentHash) {
        await unlink(imagePath).catch(() => {});
        const error = new Error("Source file changed while MOSA was importing it.");
        error.code = "SOURCE_CHANGED_DURING_IMPORT";
        throw error;
      }
      if (context?.ingestMode === "automatic"
        && pixelHash
        && pixelHashVersion === PIXEL_HASH_VERSION
        && claimedContentHash !== contentHash) {
        pixelHash = await safePixelDigest(imagePath).catch(() => "");
        pixelHashVersion = pixelHash ? PIXEL_HASH_VERSION : "";
        pixelIdentityRecomputed = true;
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
          ...(pixelIdentityRecomputed ? {
            pixel_sha256: pixelHash || null,
            pixel_hash_version: pixelHash ? pixelHashVersion : null,
          } : {}),
          content_sha256: contentHash,
          storage_mode: storageMode,
        },
      });
      try {
        const enqueueDerivative = !VIDEO_EXTENSIONS.has(extname(imagePath).toLowerCase());
        saveAsset(database, metadata, {
          enqueueDerivative,
          insertOnly: true,
          recipeSnapshot: buildRecipeSnapshot(metadata, {
            createdAt: metadata.created_at,
            changeSummary: versionChange || "Initial recipe",
          }),
          rejectAutomaticIngestSuppression: context?.ingestMode === "automatic"
            ? { content_sha256: contentHash, pixel_sha256: pixelHash, pixel_hash_version: pixelHashVersion }
            : null,
          rejectAutomaticIngestDuplicate: context?.ingestMode === "automatic"
            ? { content_sha256: contentHash, pixel_sha256: pixelHash, pixel_hash_version: pixelHashVersion }
            : null,
          clearAutomaticIngestSuppression: context?.ingestMode !== "automatic"
            ? { content_sha256: contentHash, pixel_sha256: pixelHash, pixel_hash_version: pixelHashVersion }
            : null,
        });
      } catch (error) {
        await unlink(imagePath).catch(() => {});
        if (isSqliteDuplicateError(error)) throw assetAlreadyExistsError(assetId);
        throw error;
      }
      invalidateFtsPageCache();
      return rowToAsset(database, database.prepare("SELECT * FROM assets WHERE project_id = ? AND id = ?").get(projectId, assetId));
    },
    /**
     * `mosa migrate` re-imports every legacy record from the JSON library file rather than the
     * Codex original, so a library that was hard-linked before migrating arrives here holding a
     * second copy of every Codex asset. This reclaims that space; new imports are already linked
     * by `createAsset`.
     */
    async migrateCodexAssetsToHardLinks(projectId = DEFAULT_PROJECT_ID) {
      return relinkCodexAssets(this, await this.ensureProject(projectId));
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
      saveAsset(database, metadata, {
        enqueueDerivative: false,
        recipeSnapshot: buildRecipeSnapshot(metadata, {
          createdAt: metadata.updated_at,
          changeSummary: patch.recipe_change_summary || "Recipe updated",
        }),
      });
      invalidateFtsPageCache();
      return this.getAsset(metadata.project_id, metadata.id);
    },
    async toggleFavorite(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      // Keep favorite as a lightweight presentation preference rather than a
      // recipe edit: one SQL statement makes the read/flip/write atomic, while
      // deliberately leaving updated_at untouched prevents background polling
      // from treating a star click as a full-card content change.
      const row = database.prepare(`
        UPDATE assets
        SET favorite = CASE WHEN favorite = 1 THEN 0 ELSE 1 END
        WHERE project_id = ? AND id = ?
        RETURNING *
      `).get(cleanProjectId, cleanAssetId);
      if (!row) throw assetNotFoundError(cleanAssetId);
      // Cached FTS pages carry the row's favorite value and may also be scoped
      // to Favorites, so membership/state must be invalidated even though the
      // searchable document itself did not change.
      invalidateFtsPageCache();
      return rowToAsset(database, row);
    },
    async archiveAsset(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const current = await this.getAsset(cleanProjectId, cleanAssetId);
      const membership = database.prepare("SELECT stack_id FROM asset_stack_members WHERE project_id = ? AND asset_id = ?").get(cleanProjectId, cleanAssetId);
      const metadata = normalizeAssetMetadata({
        ...current,
        archived: true,
        id: current.id,
        project_id: current.project_id,
        asset: current.asset,
        image_path: current.image_path,
        prompt_path: current.prompt_path,
        source: current.source,
        updated_at: now(),
      });
      database.transaction(() => {
        saveAsset(database, metadata, {
          enqueueDerivative: false,
          recipeSnapshot: buildRecipeSnapshot(metadata, {
            createdAt: metadata.updated_at,
            changeSummary: "Recipe updated",
          }),
        });
        if (membership) {
          database.prepare("DELETE FROM asset_stack_members WHERE project_id = ? AND asset_id = ?").run(cleanProjectId, cleanAssetId);
          compactAssetStack(database, cleanProjectId, membership.stack_id);
        }
      })();
      invalidateFtsPageCache();
      return this.getAsset(cleanProjectId, cleanAssetId);
    },
    async deleteAsset(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const asset = await this.getAsset(cleanProjectId, cleanAssetId);
      const stackMembership = database.prepare("SELECT stack_id FROM asset_stack_members WHERE project_id = ? AND asset_id = ?").get(cleanProjectId, cleanAssetId);
      // A version parent must be removed through its children: deleting the
      // parent would leave every descendant's parent_asset_id dangling and
      // break their version history permanently (no FK cascade, no repair UI).
      const child = database.prepare("SELECT id FROM assets WHERE project_id = ? AND parent_asset_id = ? LIMIT 1").get(cleanProjectId, cleanAssetId);
      if (child) {
        throw assetStoreError(
          "VERSION_PARENT_HAS_CHILDREN",
          `Cannot delete version parent ${cleanAssetId}; it has child versions (e.g. ${child.id}). Delete or detach them first.`,
        );
      }
      const managedPaths = [
        [this.imagesDir(cleanProjectId), asset.image_path],
        [this.previewsDir(cleanProjectId), asset.preview_path],
        [this.mediumsDir(cleanProjectId), asset.medium_path],
        [this.thumbnailsDir(cleanProjectId), asset.thumbnail_path],
      ].filter(([, filePath]) => Boolean(filePath)).map(([root, filePath]) => ({ root, filePath }));
      const filesToUnlink = [];
      for (const { root, filePath } of managedPaths) {
        try {
          await assertStoredPath(root, filePath);
          filesToUnlink.push(filePath);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      const contentHash = await contentHashForAsset(asset, filesToUnlink);
      const storedPixelHash = normalizeHash(asset.source?.pixel_sha256);
      const storedPixelHashVersion = String(asset.source?.pixel_hash_version || "").trim();
      const recomputedPixelHash = asset.image_path
        ? await safePixelDigest(asset.image_path).catch(() => "")
        : "";
      const pixelHash = recomputedPixelHash
        || (storedPixelHashVersion === PIXEL_HASH_VERSION ? "" : storedPixelHash);
      const pixelHashVersion = recomputedPixelHash
        ? PIXEL_HASH_VERSION
        : (pixelHash ? storedPixelHashVersion : "");
      database.transaction(() => {
        if (stackMembership) {
          database.prepare("DELETE FROM asset_stack_members WHERE project_id = ? AND asset_id = ?").run(cleanProjectId, cleanAssetId);
        }
        database.prepare("DELETE FROM asset_tags WHERE project_id = ? AND asset_id = ?").run(cleanProjectId, cleanAssetId);
        database.prepare("DELETE FROM asset_versions WHERE project_id = ? AND asset_id = ?").run(cleanProjectId, cleanAssetId);
        // Detach any stale version rows still pointing at this asset as parent
        // (only possible after children were deleted individually).
        database.prepare("DELETE FROM asset_versions WHERE project_id = ? AND parent_asset_id = ?").run(cleanProjectId, cleanAssetId);
        database.prepare("DELETE FROM derivative_jobs WHERE project_id = ? AND asset_id = ?").run(cleanProjectId, cleanAssetId);
        database.prepare("DELETE FROM asset_fts WHERE project_id = ? AND asset_id = ?").run(cleanProjectId, cleanAssetId);
        database.prepare("DELETE FROM assets WHERE project_id = ? AND id = ?").run(cleanProjectId, cleanAssetId);
        if (stackMembership) compactAssetStack(database, cleanProjectId, stackMembership.stack_id);
        if (contentHash || pixelHash) {
          database.prepare(`
            INSERT INTO automatic_ingest_suppressions (project_id, content_sha256, pixel_sha256, pixel_hash_version, deleted_at, reason)
            VALUES (?, ?, ?, ?, ?, 'user-deleted')
            ON CONFLICT(project_id, content_sha256, pixel_sha256, pixel_hash_version) DO UPDATE SET
              deleted_at = excluded.deleted_at,
              reason = excluded.reason
          `).run(cleanProjectId, contentHash, pixelHash, pixelHashVersion, now());
        }
      })();
      invalidateFtsPageCache();
      // Row is committed; leftover originals are swept by verify/thumbnails repair.
      for (const filePath of filesToUnlink) {
        await unlink(filePath).catch(() => {});
      }
      return { id: cleanAssetId, project_id: cleanProjectId, deleted: true };
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
    async getRecipeSnapshotHistory(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const row = database.prepare("SELECT * FROM assets WHERE project_id = ? AND id = ?").get(cleanProjectId, cleanAssetId);
      if (!row) throw assetNotFoundError(cleanAssetId);
      return sqliteRecipeHistory(database, row);
    },
    async recordGenerationEvent(input = {}) {
      const event = normalizeGenerationEvent(input);
      const asset = database.prepare("SELECT id FROM assets WHERE project_id = ? AND id = ?").get(event.project_id, event.output_asset_id);
      if (!asset) throw assetNotFoundError(event.output_asset_id);
      const existing = database.prepare("SELECT * FROM generation_events WHERE project_id = ? AND id = ?").get(event.project_id, event.id);
      const storedEvent = existing ? preserveTrustedGenerationEvent(generationEventFromRow(existing), event) : event;
      database.prepare(`
        INSERT INTO generation_events (
          project_id, id, output_asset_id, provider, capture_context_id,
          provider_tool_call_id, provider_generation_call_id, provider_response_id, provider_asset_id,
          conversation_id, message_id, batch_id, model, user_prompt, effective_prompt,
          prompt_status, capture_channel, verification_level, references_json,
          evidence_json, created_at
        ) VALUES (
          @project_id, @id, @output_asset_id, @provider, @capture_context_id,
          @provider_tool_call_id, @provider_generation_call_id, @provider_response_id, @provider_asset_id,
          @conversation_id, @message_id, @batch_id, @model, @user_prompt, @effective_prompt,
          @prompt_status, @capture_channel, @verification_level, @references_json,
          @evidence_json, @created_at
        )
        ON CONFLICT(project_id, id) DO UPDATE SET
          output_asset_id = excluded.output_asset_id,
          provider = excluded.provider,
          capture_context_id = excluded.capture_context_id,
          provider_tool_call_id = excluded.provider_tool_call_id,
          provider_generation_call_id = excluded.provider_generation_call_id,
          provider_response_id = excluded.provider_response_id,
          provider_asset_id = excluded.provider_asset_id,
          conversation_id = excluded.conversation_id,
          message_id = excluded.message_id,
          batch_id = excluded.batch_id,
          model = excluded.model,
          user_prompt = excluded.user_prompt,
          effective_prompt = excluded.effective_prompt,
          prompt_status = excluded.prompt_status,
          capture_channel = excluded.capture_channel,
          verification_level = excluded.verification_level,
          references_json = excluded.references_json,
          evidence_json = excluded.evidence_json
      `).run({
        ...storedEvent,
        references_json: JSON.stringify(storedEvent.references || []),
        evidence_json: JSON.stringify(storedEvent.evidence || {}),
      });
      syncSqliteGenerationRelationCandidates(database, event.project_id);
      return storedEvent;
    },
    async listGenerationEvents(projectId, filters = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const conditions = ["project_id = @projectId"];
      const params = { projectId: cleanProjectId };
      if (filters.assetId) {
        conditions.push("output_asset_id = @assetId");
        params.assetId = sanitizeId(filters.assetId, "asset");
      }
      if (filters.captureContextId) {
        conditions.push("capture_context_id = @captureContextId");
        params.captureContextId = String(filters.captureContextId);
      }
      if (filters.providerToolCallId) {
        conditions.push("provider_tool_call_id = @providerToolCallId");
        params.providerToolCallId = String(filters.providerToolCallId);
      }
      if (filters.providerGenerationCallId) {
        conditions.push("provider_generation_call_id = @providerGenerationCallId");
        params.providerGenerationCallId = String(filters.providerGenerationCallId);
      }
      const rawLimit = Number(filters.limit);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 251) : 0;
      const rawOffset = Number(filters.offset);
      const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
      if (limit) {
        params.limit = limit;
        params.offset = offset;
      }
      return database.prepare(`
        SELECT * FROM generation_events
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at ASC, id ASC
        ${limit ? "LIMIT @limit OFFSET @offset" : ""}
      `).all(params).map(generationEventFromRow);
    },
    async recordGenerationRelation(input = {}) {
      const relation = normalizeGenerationRelation(input);
      const rows = database.prepare(`
        SELECT id FROM generation_events
        WHERE project_id = ? AND id IN (?, ?)
      `).all(relation.project_id, relation.child_generation_id, relation.parent_generation_id);
      if (rows.length !== 2) {
        throw generationHistoryError("Generation relation references a missing event.", "GENERATION_RELATION_EVENT_NOT_FOUND", 409);
      }
      const existingRelations = database.prepare("SELECT * FROM generation_relations WHERE project_id = ?").all(relation.project_id).map(generationRelationFromRow);
      assertGenerationRelationAcyclic(relation, existingRelations);
      const existingRelation = existingRelations.find((item) => (
        item.child_generation_id === relation.child_generation_id
        && item.parent_generation_id === relation.parent_generation_id
        && item.relation_type === relation.relation_type
      ));
      const storedRelation = preserveTrustedGenerationRelation(existingRelation, relation);
      database.prepare(`
        INSERT INTO generation_relations (
          project_id, child_generation_id, parent_generation_id, relation_type,
          verification_level, evidence_json, created_at
        ) VALUES (
          @project_id, @child_generation_id, @parent_generation_id, @relation_type,
          @verification_level, @evidence_json, @created_at
        )
        ON CONFLICT(project_id, child_generation_id, parent_generation_id, relation_type) DO UPDATE SET
          verification_level = excluded.verification_level,
          evidence_json = excluded.evidence_json
      `).run({
        ...storedRelation,
        evidence_json: JSON.stringify(storedRelation.evidence || {}),
      });
      database.prepare(`
        UPDATE generation_relation_candidates
        SET status = 'confirmed', updated_at = ?
        WHERE project_id = ? AND child_generation_id = ? AND parent_generation_id = ?
      `).run(now(), relation.project_id, relation.child_generation_id, relation.parent_generation_id);
      return storedRelation;
    },
    async updateGenerationRelationCandidate(input = {}) {
      const projectId = sanitizeProjectId(input.project_id || input.projectId || DEFAULT_PROJECT_ID);
      const childGenerationId = String(input.child_generation_id || input.childGenerationId || "").trim();
      const parentGenerationId = String(input.parent_generation_id || input.parentGenerationId || "").trim();
      if (!childGenerationId || !parentGenerationId) {
        throw generationHistoryError("Generation relation candidate requires child and parent generation IDs.", "GENERATION_RELATION_CANDIDATE_IDS_REQUIRED");
      }
      const row = database.prepare(`
        SELECT * FROM generation_relation_candidates
        WHERE project_id = ? AND child_generation_id = ? AND parent_generation_id = ?
      `).get(projectId, childGenerationId, parentGenerationId);
      if (!row) {
        throw generationHistoryError("Generation relation candidate was not found.", "GENERATION_RELATION_CANDIDATE_NOT_FOUND", 404);
      }
      const existing = generationRelationCandidateFromRow(row);
      const updated = normalizeGenerationRelationCandidate({
        ...existing,
        status: input.status || existing.status,
        created_at: existing.created_at,
        updated_at: now(),
      });
      database.prepare(`
        UPDATE generation_relation_candidates
        SET suggested_relation_type = @suggested_relation_type,
            confidence = @confidence,
            verification_level = @verification_level,
            evidence_json = @evidence_json,
            status = @status,
            updated_at = @updated_at
        WHERE project_id = @project_id
          AND child_generation_id = @child_generation_id
          AND parent_generation_id = @parent_generation_id
      `).run({ ...updated, evidence_json: JSON.stringify(updated.evidence || {}) });
      return updated;
    },
    async deleteGenerationRelation(input = {}) {
      const relation = normalizeGenerationRelation(input);
      const row = database.prepare(`
        SELECT * FROM generation_relations
        WHERE project_id = ? AND child_generation_id = ? AND parent_generation_id = ? AND relation_type = ?
      `).get(relation.project_id, relation.child_generation_id, relation.parent_generation_id, relation.relation_type);
      const existing = row ? generationRelationFromRow(row) : null;
      assertGenerationRelationUserMutable(existing);
      database.prepare(`
        DELETE FROM generation_relations
        WHERE project_id = ? AND child_generation_id = ? AND parent_generation_id = ? AND relation_type = ?
      `).run(relation.project_id, relation.child_generation_id, relation.parent_generation_id, relation.relation_type);
      database.prepare(`
        UPDATE generation_relation_candidates
        SET status = 'dismissed', updated_at = ?
        WHERE project_id = ? AND child_generation_id = ? AND parent_generation_id = ?
      `).run(now(), relation.project_id, relation.child_generation_id, relation.parent_generation_id);
      return existing;
    },
    async updateGenerationRelation(input = {}) {
      const relation = normalizeGenerationRelation(input);
      const previousRelationType = String(input.previous_relation_type || input.previousRelationType || relation.relation_type).trim();
      const update = database.transaction(() => {
        const eventRows = database.prepare(`
          SELECT id FROM generation_events
          WHERE project_id = ? AND id IN (?, ?)
        `).all(relation.project_id, relation.child_generation_id, relation.parent_generation_id);
        if (eventRows.length !== 2) {
          throw generationHistoryError("Generation relation references a missing event.", "GENERATION_RELATION_EVENT_NOT_FOUND", 409);
        }
        const rows = database.prepare("SELECT * FROM generation_relations WHERE project_id = ?").all(relation.project_id);
        const relations = rows.map(generationRelationFromRow);
        const existing = relations.find((item) => (
          item.child_generation_id === relation.child_generation_id
          && item.parent_generation_id === relation.parent_generation_id
          && item.relation_type === previousRelationType
        ));
        assertGenerationRelationUserMutable(existing);
        const withoutExisting = relations.filter((item) => item !== existing);
        assertGenerationRelationAcyclic(relation, withoutExisting);
        const target = withoutExisting.find((item) => (
          item.child_generation_id === relation.child_generation_id
          && item.parent_generation_id === relation.parent_generation_id
          && item.relation_type === relation.relation_type
        ));
        if (target) assertGenerationRelationUserMutable(target);
        database.prepare(`
          DELETE FROM generation_relations
          WHERE project_id = ? AND child_generation_id = ? AND parent_generation_id = ? AND relation_type IN (?, ?)
        `).run(relation.project_id, relation.child_generation_id, relation.parent_generation_id, previousRelationType, relation.relation_type);
        database.prepare(`
          INSERT INTO generation_relations (
            project_id, child_generation_id, parent_generation_id, relation_type,
            verification_level, evidence_json, created_at
          ) VALUES (
            @project_id, @child_generation_id, @parent_generation_id, @relation_type,
            @verification_level, @evidence_json, @created_at
          )
        `).run({
          ...relation,
          evidence_json: JSON.stringify(relation.evidence || {}),
        });
        return relation;
      });
      return update();
    },
    async getGenerationLineage(projectId, generationId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const events = database.prepare("SELECT * FROM generation_events WHERE project_id = ?").all(cleanProjectId).map(generationEventFromRow);
      const relations = database.prepare("SELECT * FROM generation_relations WHERE project_id = ? ORDER BY created_at, child_generation_id, parent_generation_id").all(cleanProjectId).map(generationRelationFromRow);
      return buildGenerationLineage({
        projectId: cleanProjectId,
        selectedGenerationId: String(generationId || ""),
        events,
        relations,
      });
    },
    async getAssetGenerationHistory(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const asset = database.prepare("SELECT id FROM assets WHERE project_id = ? AND id = ?").get(cleanProjectId, cleanAssetId);
      if (!asset) throw assetNotFoundError(cleanAssetId);
      const events = database.prepare("SELECT * FROM generation_events WHERE project_id = ?").all(cleanProjectId).map(generationEventFromRow);
      const relations = database.prepare("SELECT * FROM generation_relations WHERE project_id = ? ORDER BY created_at, child_generation_id, parent_generation_id").all(cleanProjectId).map(generationRelationFromRow);
      const history = buildAssetGenerationHistory({
        projectId: cleanProjectId,
        assetId: cleanAssetId,
        events,
        relations,
        candidates: database.prepare(`
          SELECT * FROM generation_relation_candidates
          WHERE project_id = ?
          ORDER BY child_generation_id, confidence DESC, parent_generation_id
        `).all(cleanProjectId).map(generationRelationCandidateFromRow),
      });
      const outputIds = new Set([...history.events, ...(history.context_events || [])].map((event) => event.output_asset_id).filter(Boolean));
      const readOutputAsset = database.prepare("SELECT * FROM assets WHERE project_id = ? AND id = ?");
      const outputAssets = [...outputIds].map((outputId) => {
        const row = readOutputAsset.get(cleanProjectId, outputId);
        return row ? rowToAsset(database, row, { includeRelations: false }) : null;
      }).filter(Boolean);
      return { ...history, output_assets: outputAssets };
    },
    async assetFileInfo(projectId, fileName) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const safeName = sanitizeFileName(fileName);
      const row = database.prepare("SELECT original_path FROM assets WHERE project_id = ? AND asset = ?").get(cleanProjectId, safeName);
      if (!row?.original_path) throw new Error("Asset not found.");
      await assertStoredPath(this.imagesDir(cleanProjectId), row.original_path);
      const fileStat = await stat(row.original_path);
      return { size: fileStat.size };
    },
    async assetReadStream(projectId, fileName, options = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const safeName = sanitizeFileName(fileName);
      const row = database.prepare("SELECT original_path FROM assets WHERE project_id = ? AND asset = ?").get(cleanProjectId, safeName);
      if (!row?.original_path) throw new Error("Asset not found.");
      await assertStoredPath(this.imagesDir(cleanProjectId), row.original_path);
      const streamOptions = Number.isSafeInteger(options.start) && Number.isSafeInteger(options.end)
        ? { start: options.start, end: options.end }
        : undefined;
      return createReadStream(row.original_path, streamOptions);
    },
    async derivativeReadStream(projectId, assetId, kind) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const column = DERIVATIVE_COLUMNS.get(kind);
      if (!column) throw new Error(`Invalid derivative kind: ${kind}`);
      const root = kind === "preview"
        ? this.previewsDir(cleanProjectId)
        : kind === "medium"
          ? this.mediumsDir(cleanProjectId)
          : this.thumbnailsDir(cleanProjectId);
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
      const rows = database.prepare(`
        SELECT project_id, id FROM assets
        WHERE archived = 0
          AND mosa_media_kind(business_fields_json, source_json, original_path) != 'video'
          AND (
            thumbnail_path IS NULL OR medium_path IS NULL OR preview_path IS NULL
            OR COALESCE(CAST(json_extract(business_fields_json, '$.width') AS REAL), 0) <= 0
            OR COALESCE(CAST(json_extract(business_fields_json, '$.height') AS REAL), 0) <= 0
          )
      `).all();
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
        const retryBefore = new Date(Date.now() - 30 * 1000).toISOString();
        const job = database.prepare(`
          SELECT j.project_id, j.asset_id, j.attempts, a.original_path, a.id
          FROM derivative_jobs j JOIN assets a ON a.project_id = j.project_id AND a.id = j.asset_id
          WHERE j.status = 'pending'
            OR (j.status = 'running' AND j.updated_at < @staleRunningBefore)
            OR (j.status = 'failed' AND j.attempts < 3 AND j.updated_at < @retryBefore)
          ORDER BY j.created_at ASC LIMIT 1
        `).get({
          staleRunningBefore: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          retryBefore,
        });
        if (!job) return null;
        database.prepare("UPDATE derivative_jobs SET status = 'running', attempts = attempts + 1, error = NULL, updated_at = ? WHERE project_id = ? AND asset_id = ?").run(now(), job.project_id, job.asset_id);
        return {
          ...job,
          previewPath: join(store.previewsDir(job.project_id), `${job.asset_id}.webp`),
          mediumPath: join(store.mediumsDir(job.project_id), `${job.asset_id}.webp`),
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
        const current = database.prepare("SELECT business_fields_json FROM assets WHERE project_id = ? AND id = ?").get(job.project_id, job.asset_id);
        const businessFields = parseJson(current?.business_fields_json, {});
        const width = Number(result.width);
        const height = Number(result.height);
        if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
          businessFields.width = width;
          businessFields.height = height;
        }
        database.prepare("UPDATE assets SET preview_path = ?, medium_path = ?, thumbnail_path = ?, business_fields_json = ?, business_search_text = ?, updated_at = ? WHERE project_id = ? AND id = ?")
          .run(result.previewPath, result.mediumPath, result.thumbnailPath, JSON.stringify(businessFields), searchableObjectText(businessFields), timestamp, job.project_id, job.asset_id);
        database.prepare("UPDATE derivative_jobs SET status = 'completed', error = NULL, updated_at = ? WHERE project_id = ? AND asset_id = ?").run(timestamp, job.project_id, job.asset_id);
      })();
      if (!result.error) invalidateFtsPageCache();
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
          const actual = await sha256File(row.original_path);
          if (actual !== row.content_sha256) failures.push({ projectId: row.project_id, assetId: row.id, reason: "content-hash-mismatch" });
        } catch {
          failures.push({ projectId: row.project_id, assetId: row.id, reason: "original-missing" });
        }
      }
      return { assets: rows.length, failures, ok: failures.length === 0 };
    },
    async cleanupOrphanedManagedFiles({ olderThanMs = 24 * 60 * 60 * 1000 } = {}) {
      const referenced = new Set();
      for (const row of database.prepare("SELECT original_path, preview_path, medium_path, thumbnail_path FROM assets").all()) {
        for (const value of [row.original_path, row.preview_path, row.medium_path, row.thumbnail_path]) {
          if (value) referenced.add(resolve(value));
        }
      }
      const cutoff = Date.now() - Math.max(0, Number(olderThanMs) || 0);
      let removed = 0;
      let failed = 0;
      const projects = database.prepare("SELECT id FROM projects").all();
      for (const { id } of projects) {
        for (const dir of [this.imagesDir(id), this.previewsDir(id), this.mediumsDir(id), this.thumbnailsDir(id)]) {
          let names;
          try { names = await readdir(dir); } catch (error) { if (error?.code === "ENOENT") continue; throw error; }
          for (const name of names) {
            const path = resolve(join(dir, name));
            if (referenced.has(path)) continue;
            try {
              const info = await lstat(path);
              if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs > cutoff) continue;
              await unlink(path);
              removed += 1;
            } catch (error) {
              if (error?.code !== "ENOENT") failed += 1;
            }
          }
        }
      }
      return { removed, failed };
    },
    close() {
      database.close();
    },
  };

  return store;
}

/**
 * `created_at` is TEXT, so a `recent` predicate has to parse it, and a parsed predicate cannot use
 * an index — on a 100k-row library that turns a sub-millisecond lookup into a ~20ms scan that runs
 * on every gallery refresh. The parsed instant is therefore materialised into an indexed column.
 *
 * This is an idempotent structural repair rather than a numbered migration: the column is added
 * when missing, parseable legacy text is canonicalised, and every derived value is checked on
 * open. Raw SQL can therefore leave the pair inconsistent only until the next store open.
 */
function ensureCreatedAtEpoch(database) {
  const hasColumn = database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('assets') WHERE name = 'created_at_epoch'").get().count > 0;
  if (!hasColumn) database.exec("ALTER TABLE assets ADD COLUMN created_at_epoch REAL");
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_epoch_idx ON assets(project_id, archived, created_at_epoch DESC, id DESC)");
  // The repair only ever needs to write when a row is actually stale. Probe
  // first so a consistent library avoids the full-table UPDATE's write lock
  // on every open; raw SQL edits are still canonicalised on the next open.
  const needsRepair = database.prepare("SELECT 1 FROM assets WHERE created_at_epoch IS NULL LIMIT 1").get()
    || database.prepare("SELECT 1 FROM assets WHERE created_at != mosa_normalize_created_at(created_at) OR created_at_epoch IS NOT mosa_created_at_epoch(created_at) LIMIT 1").get();
  if (!needsRepair) return;
  database.prepare(`
    UPDATE assets SET
      created_at = mosa_normalize_created_at(created_at),
      created_at_epoch = mosa_created_at_epoch(created_at)
    WHERE created_at != mosa_normalize_created_at(created_at)
      OR created_at_epoch IS NOT mosa_created_at_epoch(created_at)
  `).run();
  database.prepare(`
    UPDATE asset_versions SET created_at = (
      SELECT assets.created_at FROM assets
      WHERE assets.project_id = asset_versions.project_id AND assets.id = asset_versions.asset_id
    )
    WHERE EXISTS (
      SELECT 1 FROM assets
      WHERE assets.project_id = asset_versions.project_id
        AND assets.id = asset_versions.asset_id
        AND assets.created_at != asset_versions.created_at
    )
  `).run();
}

function ensurePixelHashColumn(database) {
  const hasColumn = database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('assets') WHERE name = 'pixel_sha256'").get().count > 0;
  if (!hasColumn) database.exec("ALTER TABLE assets ADD COLUMN pixel_sha256 TEXT NOT NULL DEFAULT ''");
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_pixel_hash_idx ON assets(project_id, pixel_sha256)");
  database.prepare(`
    UPDATE assets
    SET pixel_sha256 = COALESCE(json_extract(source_json, '$.pixel_sha256'), '')
    WHERE pixel_sha256 = '' AND COALESCE(json_extract(source_json, '$.pixel_sha256'), '') != ''
  `).run();
}

function ensureSourcePathColumn(database) {
  const hasColumn = database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('assets') WHERE name = 'source_path'").get().count > 0;
  if (!hasColumn) database.exec("ALTER TABLE assets ADD COLUMN source_path TEXT NOT NULL DEFAULT ''");
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_source_path_idx ON assets(project_id, source_path)");
  const needsRepair = database.prepare(`
    SELECT 1 FROM assets
    WHERE source_path IS NOT COALESCE(CAST(json_extract(source_json, '$.path') AS TEXT), '')
    LIMIT 1
  `).get();
  if (!needsRepair) return;
  database.prepare(`
    UPDATE assets
    SET source_path = COALESCE(CAST(json_extract(source_json, '$.path') AS TEXT), '')
    WHERE source_path IS NOT COALESCE(CAST(json_extract(source_json, '$.path') AS TEXT), '')
  `).run();
}

function ensureSuppressionPixelHashVersion(database) {
  const hasColumn = database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('automatic_ingest_suppressions') WHERE name = 'pixel_hash_version'").get().count > 0;
  if (!hasColumn) database.exec("ALTER TABLE automatic_ingest_suppressions ADD COLUMN pixel_hash_version TEXT NOT NULL DEFAULT ''");
  const primaryKey = database.prepare("SELECT name FROM pragma_table_info('automatic_ingest_suppressions') WHERE pk > 0 ORDER BY pk").all().map((row) => row.name);
  if (primaryKey.join(",") === "project_id,content_sha256,pixel_sha256,pixel_hash_version") return;
  database.exec(`
    DROP INDEX IF EXISTS automatic_suppressions_project_content_idx;
    DROP INDEX IF EXISTS automatic_suppressions_project_pixel_idx;
    DROP INDEX IF EXISTS automatic_suppressions_project_deleted_idx;
    ALTER TABLE automatic_ingest_suppressions RENAME TO automatic_ingest_suppressions_legacy;
    CREATE TABLE automatic_ingest_suppressions (
      project_id TEXT NOT NULL,
      content_sha256 TEXT NOT NULL DEFAULT '',
      pixel_sha256 TEXT NOT NULL DEFAULT '',
      pixel_hash_version TEXT NOT NULL DEFAULT '',
      deleted_at TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'user-deleted',
      PRIMARY KEY (project_id, content_sha256, pixel_sha256, pixel_hash_version),
      CHECK (content_sha256 != '' OR pixel_sha256 != '')
    );
    INSERT INTO automatic_ingest_suppressions
      (project_id, content_sha256, pixel_sha256, pixel_hash_version, deleted_at, reason)
    SELECT project_id, content_sha256, pixel_sha256, COALESCE(pixel_hash_version, ''), deleted_at, reason
    FROM automatic_ingest_suppressions_legacy;
    DROP TABLE automatic_ingest_suppressions_legacy;
    CREATE INDEX automatic_suppressions_project_content_idx ON automatic_ingest_suppressions(project_id, content_sha256, deleted_at DESC);
    CREATE INDEX automatic_suppressions_project_pixel_idx ON automatic_ingest_suppressions(project_id, pixel_sha256, deleted_at DESC);
    CREATE INDEX automatic_suppressions_project_deleted_idx ON automatic_ingest_suppressions(project_id, deleted_at DESC, content_sha256, pixel_sha256, pixel_hash_version);
  `);
}

/**
 * Name ordering keys on the same string the gallery labels a card with, which
 * lives across two columns. Sorting that expression inline cannot use an index,
 * so on a 50k library it degrades the paged query into a full scan plus sort —
 * the exact cost `assets_project_created_idx` exists to avoid for the default
 * order. The key is therefore materialised and indexed like `created_at_epoch`,
 * as an idempotent structural repair rather than a numbered migration.
 */
function ensureSortName(database) {
  const hasColumn = database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('assets') WHERE name = 'sort_name'").get().count > 0;
  if (!hasColumn) database.exec("ALTER TABLE assets ADD COLUMN sort_name TEXT");
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_name_idx ON assets(project_id, archived, sort_name ASC, id ASC)");
  // See ensureCreatedAtEpoch: probe before the full-table repair write.
  const needsRepair = database.prepare("SELECT 1 FROM assets WHERE sort_name IS NULL LIMIT 1").get()
    || database.prepare("SELECT 1 FROM assets WHERE sort_name IS NOT mosa_sort_name(theme, asset, id) LIMIT 1").get();
  if (!needsRepair) return;
  database.prepare(`
    UPDATE assets SET sort_name = mosa_sort_name(theme, asset, id)
    WHERE sort_name IS NOT mosa_sort_name(theme, asset, id)
  `).run();
}

function ensureAssetStackSortColumns(database) {
  const columns = new Set(database.prepare("SELECT name FROM pragma_table_info('asset_stacks')").all().map((row) => row.name));
  if (!columns.has("sort_created_at")) database.exec("ALTER TABLE asset_stacks ADD COLUMN sort_created_at TEXT NOT NULL DEFAULT ''");
  if (!columns.has("sort_name")) database.exec("ALTER TABLE asset_stacks ADD COLUMN sort_name TEXT NOT NULL DEFAULT ''");
  database.exec("CREATE INDEX IF NOT EXISTS asset_stacks_project_sort_created_idx ON asset_stacks(project_id, sort_created_at DESC, id DESC)");
  database.exec("CREATE INDEX IF NOT EXISTS asset_stacks_project_sort_name_idx ON asset_stacks(project_id, sort_name ASC, id ASC)");
  database.prepare(`
    UPDATE asset_stacks
    SET sort_created_at = COALESCE(NULLIF(sort_created_at, ''), (
          SELECT a.created_at
          FROM asset_stack_members sm
          JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
          WHERE sm.project_id = asset_stacks.project_id AND sm.stack_id = asset_stacks.id AND sm.position = 0
        ), created_at),
        sort_name = COALESCE(NULLIF(sort_name, ''), (
          SELECT a.sort_name
          FROM asset_stack_members sm
          JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
          WHERE sm.project_id = asset_stacks.project_id AND sm.stack_id = asset_stacks.id AND sm.position = 0
        ), '')
    WHERE sort_created_at = '' OR sort_name = ''
  `).run();
}

function ensureMediumPathColumn(database) {
  const hasColumn = database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('assets') WHERE name = 'medium_path'").get().count > 0;
  if (!hasColumn) database.exec("ALTER TABLE assets ADD COLUMN medium_path TEXT");
}

function ensureSearchScalarColumns(database, forceBackfill = false) {
  const columns = new Map(database.prepare("SELECT name FROM pragma_table_info('assets')").all().map((row) => [row.name, true]));
  const additions = [
    ["tags_text", "TEXT NOT NULL DEFAULT ''"],
    ["business_search_text", "TEXT NOT NULL DEFAULT ''"],
    ["source_search_text", "TEXT NOT NULL DEFAULT ''"],
    ["media_kind", "TEXT NOT NULL DEFAULT 'unknown'"],
    ["source_group", "TEXT NOT NULL DEFAULT ''"],
    ["conversation_id", "TEXT NOT NULL DEFAULT ''"],
    ["generation_batch", "TEXT NOT NULL DEFAULT ''"],
  ];
  let added = false;
  for (const [name, definition] of additions) {
    if (columns.has(name)) continue;
    database.exec(`ALTER TABLE assets ADD COLUMN ${name} ${definition}`);
    added = true;
  }
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_media_kind_idx ON assets(project_id, archived, media_kind, created_at DESC, id DESC)");
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_source_group_idx ON assets(project_id, archived, source_group, created_at DESC, id DESC)");
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_conversation_idx ON assets(project_id, archived, conversation_id, created_at DESC, id DESC)");
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_generation_batch_idx ON assets(project_id, archived, generation_batch, created_at DESC, id DESC)");
  database.exec("CREATE INDEX IF NOT EXISTS assets_project_conversation_batch_idx ON assets(project_id, archived, conversation_id, generation_batch, created_at DESC, id DESC)");
  if (!added && !forceBackfill) return;
  database.prepare(`
    UPDATE assets SET
      tags_text = COALESCE((
        SELECT group_concat(t.name, char(31)) FROM tags t
        JOIN asset_tags at ON at.tag_id = t.id
        WHERE at.project_id = assets.project_id AND at.asset_id = assets.id
      ), ''),
      business_search_text = mosa_search_object_text(business_fields_json),
      source_search_text = mosa_search_object_text(source_json),
      media_kind = mosa_media_kind(business_fields_json, source_json, original_path),
      source_group = mosa_canonical_source_type(source_type, business_fields_json, source_json),
      conversation_id = COALESCE(CAST(json_extract(source_json, '$.conversation_id') AS TEXT), ''),
      generation_batch = COALESCE(CAST(json_extract(source_json, '$.message_id') AS TEXT), '')
  `).run();
}

function ensureGenerationEventColumns(database) {
  const columns = new Set(database.prepare("SELECT name FROM pragma_table_info('generation_events')").all().map((row) => row.name));
  if (!columns.has("provider_tool_call_id")) {
    database.exec("ALTER TABLE generation_events ADD COLUMN provider_tool_call_id TEXT NOT NULL DEFAULT ''");
  }
  database.exec("CREATE INDEX IF NOT EXISTS generation_events_tool_call_idx ON generation_events(project_id, provider, provider_tool_call_id, created_at, id)");
}

function openDatabase(databasePath) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  // `recent` must not be decided by lexicographic TEXT comparison: SQL NULL is excluded by a
  // `>=` test, but an arbitrary TEXT date is never format-checked, so legacy values such as
  // "Sat, 01 Jan 2000 00:00:00 GMT" used to compare above an ISO cutoff. Exposing the shared
  // parser to SQL keeps this store's answers identical to the JSON store's. Unusable values
  // return NULL, which no comparison can satisfy.
  database.function("mosa_created_at_epoch", { deterministic: true }, (value) => createdAtTimestamp(value));
  database.function("mosa_normalize_created_at", { deterministic: true }, (value) => {
    if (typeof value !== "string") return value == null ? null : String(value);
    return normalizeCreatedAt(value, value);
  });
  // Name ordering has to agree with the label the gallery renders, and with the
  // JS comparator the JSON store uses, so the key is computed by one shared
  // helper rather than reimplemented in SQL.
  database.function("mosa_sort_name", { deterministic: true }, (theme, asset, id) => assetSortName({ theme, asset, id }));
  database.function("mosa_search_object_text", { deterministic: true }, (json) => searchableObjectText(parseJson(json, {})));
  database.function("mosa_canonical_source_type", { deterministic: true }, (sourceType, businessFieldsJson, sourceJson) => canonicalSourceTypeOf({
    source_type: sourceType,
    source: parseJson(sourceJson, {}),
    business_fields: parseJson(businessFieldsJson, {}),
  }));
  database.function("mosa_asset_matches_search_kind", { deterministic: true }, (
    kind, asset, id, prompt, skill, style, theme, group, category, tagsText,
  ) => assetMatchesSearchKind({
    asset,
    id,
    prompt,
    skill,
    style,
    theme,
    group,
    category,
    tags: String(tagsText || "").split("\u001f").filter(Boolean),
  }, String(kind || "")) ? 1 : 0);
  // V2 FilterBar type filter: classify media in SQL with the same rule the gallery
  // uses (business_fields/source media_kind first, then the file extension), so the
  // server-side count and page agree with what the cards render.
  database.function("mosa_media_kind", { deterministic: true }, (businessFieldsJson, sourceJson, originalPath) => mediaKindOf({ business_fields: parseJson(businessFieldsJson), source: parseJson(sourceJson), image_path: originalPath }));
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
      medium_path TEXT,
      thumbnail_path TEXT,
      content_sha256 TEXT NOT NULL,
      pixel_sha256 TEXT NOT NULL DEFAULT '',
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
      source_path TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL,
      search_text TEXT NOT NULL,
      tags_text TEXT NOT NULL DEFAULT '',
      business_search_text TEXT NOT NULL DEFAULT '',
      source_search_text TEXT NOT NULL DEFAULT '',
      media_kind TEXT NOT NULL DEFAULT 'unknown',
      source_group TEXT NOT NULL DEFAULT '',
      conversation_id TEXT NOT NULL DEFAULT '',
      generation_batch TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, id),
      UNIQUE (project_id, asset)
    );
    CREATE INDEX IF NOT EXISTS assets_project_created_idx ON assets(project_id, archived, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS assets_project_hash_idx ON assets(project_id, content_sha256);
    CREATE INDEX IF NOT EXISTS assets_project_source_path_idx ON assets(project_id, source_path);
    CREATE INDEX IF NOT EXISTS assets_project_group_created_idx ON assets(project_id, archived, group_name, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS assets_project_category_created_idx ON assets(project_id, archived, category, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS assets_project_style_created_idx ON assets(project_id, archived, style, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS assets_project_favorite_created_idx ON assets(project_id, archived, created_at DESC, id DESC)
      WHERE rating > 0 OR favorite = 1;
    CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, normalized_name TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS asset_tags (project_id TEXT NOT NULL, asset_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (project_id, asset_id, tag_id));
    CREATE TABLE IF NOT EXISTS asset_versions (project_id TEXT NOT NULL, asset_id TEXT NOT NULL, parent_asset_id TEXT, change_summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, PRIMARY KEY (project_id, asset_id));
    CREATE TABLE IF NOT EXISTS asset_stacks (
      project_id TEXT NOT NULL,
      id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sort_created_at TEXT NOT NULL DEFAULT '',
      sort_name TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (project_id, id)
    );
    CREATE TABLE IF NOT EXISTS asset_stack_members (
      project_id TEXT NOT NULL,
      stack_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (project_id, asset_id),
      UNIQUE (project_id, stack_id, position),
      FOREIGN KEY (project_id, stack_id) REFERENCES asset_stacks(project_id, id) ON DELETE CASCADE,
      FOREIGN KEY (project_id, asset_id) REFERENCES assets(project_id, id) ON DELETE CASCADE,
      CHECK (position >= 0)
    );
    CREATE INDEX IF NOT EXISTS asset_stack_members_stack_position_idx ON asset_stack_members(project_id, stack_id, position, asset_id);
    CREATE TABLE IF NOT EXISTS generation_events (
      project_id TEXT NOT NULL,
      id TEXT NOT NULL,
      output_asset_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT '',
      capture_context_id TEXT NOT NULL DEFAULT '',
      provider_tool_call_id TEXT NOT NULL DEFAULT '',
      provider_generation_call_id TEXT NOT NULL DEFAULT '',
      provider_response_id TEXT NOT NULL DEFAULT '',
      provider_asset_id TEXT NOT NULL DEFAULT '',
      conversation_id TEXT NOT NULL DEFAULT '',
      message_id TEXT NOT NULL DEFAULT '',
      batch_id TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      user_prompt TEXT NOT NULL DEFAULT '',
      effective_prompt TEXT NOT NULL DEFAULT '',
      prompt_status TEXT NOT NULL DEFAULT '',
      capture_channel TEXT NOT NULL DEFAULT '',
      verification_level TEXT NOT NULL DEFAULT 'observed',
      references_json TEXT NOT NULL DEFAULT '[]',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, id),
      FOREIGN KEY (project_id, output_asset_id) REFERENCES assets(project_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS generation_events_asset_idx ON generation_events(project_id, output_asset_id, created_at, id);
    CREATE INDEX IF NOT EXISTS generation_events_context_idx ON generation_events(project_id, capture_context_id, created_at, id);
    CREATE INDEX IF NOT EXISTS generation_events_provider_call_idx ON generation_events(project_id, provider, provider_generation_call_id, created_at, id);
    CREATE TABLE IF NOT EXISTS generation_relations (
      project_id TEXT NOT NULL,
      child_generation_id TEXT NOT NULL,
      parent_generation_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      verification_level TEXT NOT NULL DEFAULT 'inferred',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, child_generation_id, parent_generation_id, relation_type),
      FOREIGN KEY (project_id, child_generation_id) REFERENCES generation_events(project_id, id) ON DELETE CASCADE,
      FOREIGN KEY (project_id, parent_generation_id) REFERENCES generation_events(project_id, id) ON DELETE CASCADE,
      CHECK (child_generation_id != parent_generation_id)
    );
    CREATE INDEX IF NOT EXISTS generation_relations_parent_idx ON generation_relations(project_id, parent_generation_id, created_at, child_generation_id);
    CREATE INDEX IF NOT EXISTS generation_relations_child_idx ON generation_relations(project_id, child_generation_id, created_at, parent_generation_id);
    CREATE TABLE IF NOT EXISTS generation_relation_candidates (
      project_id TEXT NOT NULL,
      child_generation_id TEXT NOT NULL,
      parent_generation_id TEXT NOT NULL,
      suggested_relation_type TEXT NOT NULL DEFAULT 'derived_from',
      confidence REAL NOT NULL DEFAULT 0,
      verification_level TEXT NOT NULL DEFAULT 'inferred',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'suggested',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, child_generation_id, parent_generation_id),
      FOREIGN KEY (project_id, child_generation_id) REFERENCES generation_events(project_id, id) ON DELETE CASCADE,
      FOREIGN KEY (project_id, parent_generation_id) REFERENCES generation_events(project_id, id) ON DELETE CASCADE,
      CHECK (child_generation_id != parent_generation_id),
      CHECK (status IN ('suggested', 'dismissed', 'confirmed'))
    );
    CREATE INDEX IF NOT EXISTS generation_relation_candidates_child_idx ON generation_relation_candidates(project_id, child_generation_id, status, confidence DESC);
    CREATE INDEX IF NOT EXISTS generation_relation_candidates_parent_idx ON generation_relation_candidates(project_id, parent_generation_id, status, confidence DESC);
    CREATE TABLE IF NOT EXISTS recipe_snapshots (
      project_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      recipe_digest TEXT NOT NULL,
      prompt_digest TEXT NOT NULL,
      effective_prompt TEXT NOT NULL,
      user_prompt TEXT NOT NULL,
      negative_prompt TEXT NOT NULL,
      prompt_status TEXT NOT NULL,
      generation_tool TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      skill TEXT NOT NULL,
      style TEXT NOT NULL,
      ratio TEXT NOT NULL,
      theme TEXT NOT NULL,
      references_json TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      change_summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, asset_id, snapshot_id),
      FOREIGN KEY (project_id, asset_id) REFERENCES assets(project_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS derivative_jobs (project_id TEXT NOT NULL, asset_id TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (project_id, asset_id));
    CREATE INDEX IF NOT EXISTS derivative_jobs_status_idx ON derivative_jobs(status, created_at);
    CREATE TABLE IF NOT EXISTS migration_issues (id TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS automatic_ingest_suppressions (
      project_id TEXT NOT NULL,
      content_sha256 TEXT NOT NULL DEFAULT '',
      pixel_sha256 TEXT NOT NULL DEFAULT '',
      pixel_hash_version TEXT NOT NULL DEFAULT '',
      deleted_at TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'user-deleted',
      PRIMARY KEY (project_id, content_sha256, pixel_sha256, pixel_hash_version),
      CHECK (content_sha256 != '' OR pixel_sha256 != '')
    );
    CREATE INDEX IF NOT EXISTS automatic_suppressions_project_content_idx ON automatic_ingest_suppressions(project_id, content_sha256, deleted_at DESC);
    CREATE INDEX IF NOT EXISTS automatic_suppressions_project_pixel_idx ON automatic_ingest_suppressions(project_id, pixel_sha256, deleted_at DESC);
    CREATE INDEX IF NOT EXISTS automatic_suppressions_project_deleted_idx ON automatic_ingest_suppressions(project_id, deleted_at DESC, content_sha256, pixel_sha256, pixel_hash_version);
    CREATE VIRTUAL TABLE IF NOT EXISTS asset_fts USING fts5(project_id UNINDEXED, asset_id UNINDEXED, content, tokenize='trigram');
  `);
  ensureCreatedAtEpoch(database);
  ensurePixelHashColumn(database);
  ensureSourcePathColumn(database);
  ensureSuppressionPixelHashVersion(database);
  ensureSortName(database);
  ensureAssetStackSortColumns(database);
  ensureMediumPathColumn(database);
  ensureSearchScalarColumns(database, existingVersion < 8);
  ensureGenerationEventColumns(database);
  const timestamp = now();
  database.transaction(() => {
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(timestamp);
    database.exec("CREATE INDEX IF NOT EXISTS asset_versions_parent_idx ON asset_versions(project_id, parent_asset_id, created_at, asset_id)");
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?)").run(timestamp);
    database.exec("CREATE INDEX IF NOT EXISTS recipe_snapshots_asset_idx ON recipe_snapshots(project_id, asset_id, created_at, snapshot_id)");
    if (existingVersion < 3) backfillRecipeSnapshots(database);
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (3, ?)").run(timestamp);
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (4, ?)").run(timestamp);
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (5, ?)").run(timestamp);
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (6, ?)").run(timestamp);
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (7, ?)").run(timestamp);
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (8, ?)").run(timestamp);
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (9, ?)").run(timestamp);
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (10, ?)").run(timestamp);
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (11, ?)").run(timestamp);
    database.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (12, ?)").run(timestamp);
    database.prepare(`
      INSERT INTO library_meta (key, value, updated_at) VALUES ('schema_version', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      WHERE library_meta.value != excluded.value
    `).run(String(CURRENT_SCHEMA_VERSION), timestamp);
    database.prepare("INSERT OR IGNORE INTO library_meta (key, value, updated_at) VALUES ('migration_state', 'unmigrated', ?)").run(timestamp);
  })();
  if (existingVersion < 10) {
    const projectIds = database.prepare("SELECT id FROM projects ORDER BY id").all().map((row) => row.id);
    for (const projectId of projectIds) syncSqliteGenerationRelationCandidates(database, projectId);
  }
}

function saveAsset(database, metadata, options = {}) {
  const source = metadata.source || {};
  const searchText = searchableText(metadata);
  const tagsText = tagsSearchText(metadata.tags);
  const businessSearchText = searchableObjectText(metadata.business_fields);
  const sourceSearchText = searchableObjectText(source);
  const sourcePath = source.path == null ? "" : String(source.path);
  const mediaKind = mediaKindOf(metadata);
  const sourceGroup = canonicalSourceTypeOf(metadata);
  const conversationId = source.conversation_id == null ? "" : String(source.conversation_id);
  const generationBatch = source.message_id == null ? "" : String(source.message_id);
  const unknownMetadata = unknownFields(metadata);
  const write = database.transaction(() => {
    if (options.rejectAutomaticIngestDuplicate) {
      const hashes = normalizeSuppressionHashes(options.rejectAutomaticIngestDuplicate);
      let duplicate = null;
      let duplicateKind = "content";
      if (hashes.content_sha256) {
        duplicate = database.prepare(`
          SELECT id FROM assets INDEXED BY assets_project_hash_idx
          WHERE project_id = ? AND content_sha256 = ?
          ORDER BY archived ASC, created_at DESC, id DESC
          LIMIT 1
        `).get(metadata.project_id, hashes.content_sha256);
      }
      if (!duplicate && hashes.pixel_sha256) {
        duplicateKind = "pixel";
        duplicate = database.prepare(`
          SELECT id FROM assets INDEXED BY assets_project_pixel_hash_idx
          WHERE project_id = ? AND pixel_sha256 = ?
            AND (? = '' OR json_extract(source_json, '$.pixel_hash_version') = ?)
          ORDER BY archived ASC, created_at DESC, id DESC
          LIMIT 1
        `).get(metadata.project_id, hashes.pixel_sha256, hashes.pixel_hash_version, hashes.pixel_hash_version);
      }
      if (duplicate) {
        throw automaticIngestDuplicateError(duplicate.id, duplicateKind);
      }
    }
    if (options.rejectAutomaticIngestSuppression) {
      const hashes = normalizeSuppressionHashes(options.rejectAutomaticIngestSuppression);
      const suppression = database.prepare(`
        SELECT 1
        FROM automatic_ingest_suppressions
        WHERE project_id = ?
          AND ((? != '' AND content_sha256 = ?)
            OR (? != '' AND pixel_sha256 = ? AND (? = '' OR pixel_hash_version = ?)))
        LIMIT 1
      `).get(
        metadata.project_id,
        hashes.content_sha256,
        hashes.content_sha256,
        hashes.pixel_sha256,
        hashes.pixel_sha256,
        hashes.pixel_hash_version,
        hashes.pixel_hash_version,
      );
      if (suppression) throw automaticImportSuppressedError();
    }
    database.prepare("INSERT OR IGNORE INTO projects (id, created_at) VALUES (?, ?)").run(metadata.project_id, metadata.created_at);
    const updateOnConflict = options.insertOnly ? "" : `
      ON CONFLICT(project_id, id) DO UPDATE SET
        prompt = excluded.prompt, skill = excluded.skill, style = excluded.style, ratio = excluded.ratio,
        business_fields_json = excluded.business_fields_json, theme = excluded.theme, favorite = excluded.favorite,
        archived = excluded.archived, group_name = excluded.group_name, category = excluded.category, rating = excluded.rating,
        parent_asset_id = excluded.parent_asset_id, version_change = excluded.version_change, source_type = excluded.source_type,
        pixel_sha256 = excluded.pixel_sha256, source_json = excluded.source_json, source_path = excluded.source_path, metadata_json = excluded.metadata_json, search_text = excluded.search_text,
        tags_text = excluded.tags_text, business_search_text = excluded.business_search_text, source_search_text = excluded.source_search_text,
        media_kind = excluded.media_kind, source_group = excluded.source_group,
        conversation_id = excluded.conversation_id, generation_batch = excluded.generation_batch,
        created_at = excluded.created_at, created_at_epoch = excluded.created_at_epoch, updated_at = excluded.updated_at,
        sort_name = excluded.sort_name
    `;
    database.prepare(`
      INSERT INTO assets (
        project_id, id, asset, original_path, preview_path, thumbnail_path, content_sha256, pixel_sha256, prompt, skill, style, ratio,
        business_fields_json, theme, favorite, archived, group_name, category, rating, parent_asset_id, version_change,
        source_type, source_json, source_path, metadata_json, search_text, tags_text, business_search_text, source_search_text, media_kind, source_group,
        conversation_id, generation_batch,
        created_at, created_at_epoch, updated_at, sort_name
      ) VALUES (
        @project_id, @id, @asset, @image_path, NULL, NULL, @content_sha256, @pixel_sha256, @prompt, @skill, @style, @ratio,
        @business_fields_json, @theme, @favorite, @archived, @group_name, @category, @rating, @parent_asset_id, @version_change,
        @source_type, @source_json, @source_path, @metadata_json, @search_text, @tags_text, @business_search_text, @source_search_text, @media_kind, @source_group,
        @conversation_id, @generation_batch,
        @created_at, @created_at_epoch, @updated_at, @sort_name
      )
      ${updateOnConflict}
    `).run({
      project_id: metadata.project_id,
      id: metadata.id,
      asset: metadata.asset,
      image_path: metadata.image_path,
      content_sha256: source.content_sha256 || "",
      pixel_sha256: source.pixel_sha256 || "",
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
      source_path: sourcePath,
      metadata_json: JSON.stringify(unknownMetadata),
      search_text: searchText,
      tags_text: tagsText,
      business_search_text: businessSearchText,
      source_search_text: sourceSearchText,
      media_kind: mediaKind,
      source_group: sourceGroup,
      conversation_id: conversationId,
      generation_batch: generationBatch,
      created_at: metadata.created_at,
      created_at_epoch: createdAtTimestamp(metadata.created_at),
      updated_at: metadata.updated_at,
      sort_name: assetSortName(metadata),
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
      ON CONFLICT(project_id, asset_id) DO UPDATE SET
        parent_asset_id = excluded.parent_asset_id,
        change_summary = excluded.change_summary,
        created_at = excluded.created_at
    `).run(metadata.project_id, metadata.id, metadata.parent_asset_id, metadata.version_change, metadata.created_at);
    database.prepare("DELETE FROM asset_fts WHERE project_id = ? AND asset_id = ?").run(metadata.project_id, metadata.id);
    database.prepare("INSERT INTO asset_fts (project_id, asset_id, content) VALUES (?, ?, ?)").run(metadata.project_id, metadata.id, searchText);
    if (options.recipeSnapshot) insertRecipeSnapshot(database, options.recipeSnapshot);
    if (options.enqueueDerivative) {
      database.prepare(`
        INSERT INTO derivative_jobs (project_id, asset_id, status, attempts, created_at, updated_at)
        VALUES (?, ?, 'pending', 0, ?, ?)
        ON CONFLICT(project_id, asset_id) DO UPDATE SET status = 'pending', error = NULL, updated_at = excluded.updated_at
      `).run(metadata.project_id, metadata.id, metadata.updated_at, metadata.updated_at);
    }
    if (options.clearAutomaticIngestSuppression) {
      const hashes = normalizeSuppressionHashes(options.clearAutomaticIngestSuppression);
      database.prepare(`
        DELETE FROM automatic_ingest_suppressions
        WHERE project_id = ?
          AND ((? != '' AND content_sha256 = ?)
            OR (? != '' AND pixel_sha256 = ? AND (? = '' OR pixel_hash_version = ?)))
      `).run(
        metadata.project_id,
        hashes.content_sha256,
        hashes.content_sha256,
        hashes.pixel_sha256,
        hashes.pixel_sha256,
        hashes.pixel_hash_version,
        hashes.pixel_hash_version,
      );
    }
  });
  // The suppression lookup and the insert must share one write lock. Otherwise
  // a deletion can commit its suppression between the preflight lookup and the
  // asset row insert, which would resurrect a deleted automatic capture.
  if (options.rejectAutomaticIngestSuppression) write.immediate();
  else write();
}

/**
 * Only `references_json` is refreshed on conflict, and only so that rights
 * recorded after archival reach the stored snapshot. Every other column is part
 * of the frozen recipe and must stay immutable. See `refreshReferenceRights` in
 * `lib/recipe-snapshot.mjs`; the previous `INSERT OR IGNORE` silently discarded
 * those annotations.
 */
function insertRecipeSnapshot(database, snapshot) {
  database.prepare(`
    INSERT INTO recipe_snapshots (
      project_id, asset_id, snapshot_id, schema_version, recipe_digest, prompt_digest,
      effective_prompt, user_prompt, negative_prompt, prompt_status, generation_tool,
      model, provider, skill, style, ratio, theme, references_json, provenance_json,
      change_summary, created_at
    ) VALUES (
      @project_id, @asset_id, @snapshot_id, @schema_version, @recipe_digest, @prompt_digest,
      @effective_prompt, @user_prompt, @negative_prompt, @prompt_status, @generation_tool,
      @model, @provider, @skill, @style, @ratio, @theme, @references_json, @provenance_json,
      @change_summary, @created_at
    )
    ON CONFLICT (project_id, asset_id, snapshot_id) DO UPDATE SET
      references_json = excluded.references_json
  `).run({
    ...snapshot,
    references_json: JSON.stringify(snapshot.references || []),
    provenance_json: JSON.stringify(snapshot.provenance || {}),
  });
}

function backfillRecipeSnapshots(database) {
  const rows = database.prepare(`
    SELECT a.* FROM assets a
    LEFT JOIN recipe_snapshots r ON r.project_id = a.project_id AND r.asset_id = a.id
    WHERE r.snapshot_id IS NULL
    ORDER BY a.project_id, a.created_at, a.id
  `).all();
  for (const row of rows) {
    const asset = recipeAssetFromRow(row);
    insertRecipeSnapshot(database, buildRecipeSnapshot(asset, {
      createdAt: row.updated_at || row.created_at,
      changeSummary: row.version_change || "Backfilled current recipe",
    }));
  }
}

function sqliteRecipeHistory(database, assetRow) {
  const snapshots = database.prepare(`
    SELECT * FROM recipe_snapshots
    WHERE project_id = ? AND asset_id = ?
    ORDER BY created_at, rowid
  `).all(assetRow.project_id, assetRow.id).map(snapshotRowToObject);
  const current = buildRecipeSnapshot(recipeAssetFromRow(assetRow));
  const active = snapshots.find((snapshot) => snapshot.recipe_digest === current.recipe_digest)
    || snapshots.at(-1)
    || current;
  return {
    project_id: assetRow.project_id,
    asset_id: assetRow.id,
    active_snapshot_id: active.snapshot_id,
    snapshots: snapshots.length ? snapshots : [current],
  };
}

function snapshotRowToObject(row) {
  return {
    snapshot_id: row.snapshot_id,
    schema_version: row.schema_version,
    project_id: row.project_id,
    asset_id: row.asset_id,
    recipe_digest: row.recipe_digest,
    prompt_digest: row.prompt_digest,
    effective_prompt: row.effective_prompt,
    user_prompt: row.user_prompt,
    negative_prompt: row.negative_prompt,
    prompt_status: row.prompt_status,
    generation_tool: row.generation_tool,
    model: row.model,
    provider: row.provider,
    skill: row.skill,
    style: row.style,
    ratio: row.ratio,
    theme: row.theme,
    // Normalised on read so a snapshot written before the rights matrix comes
    // back with the same shape the JSON store produces. Without this, "nobody
    // has reviewed this reference yet" would be absent from SQLite rows rather
    // than visibly unknown, and the two stores would disagree.
    references: normalizeSnapshotReferences(parseJson(row.references_json, [])),
    provenance: parseJson(row.provenance_json, {}),
    change_summary: row.change_summary,
    created_at: row.created_at,
  };
}

function recipeAssetFromRow(row) {
  const metadata = parseJson(row.metadata_json, {});
  return {
    ...metadata,
    id: row.id,
    project_id: row.project_id,
    prompt: row.prompt,
    skill: row.skill,
    style: row.style,
    ratio: row.ratio,
    business_fields: parseJson(row.business_fields_json, {}),
    theme: row.theme,
    version_change: row.version_change,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source: parseJson(row.source_json, {}),
  };
}

function rowToAsset(database, row, options = {}) {
  const metadata = parseJson(row.metadata_json, {});
  const source = parseJson(row.source_json, {});
  const includeRelations = options.includeRelations !== false;
  const asset = {
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
    tags: [],
    favorite: Boolean(row.favorite),
    archived: Boolean(row.archived),
    group: row.group_name,
    category: row.category,
    rating: row.rating,
    parent_asset_id: row.parent_asset_id,
    version_change: row.version_change,
    child_asset_ids: [],
    created_at: row.created_at,
    updated_at: row.updated_at,
    source,
    preview_path: row.preview_path,
    medium_path: row.medium_path,
    thumbnail_path: row.thumbnail_path,
  };
  if (!includeRelations) return withRuntimeUrls(asset);

  const recipe = sqliteRecipeHistory(database, row);
  asset.tags = database.prepare(`
    SELECT t.name FROM tags t JOIN asset_tags at ON at.tag_id = t.id
    WHERE at.project_id = ? AND at.asset_id = ? ORDER BY t.name COLLATE NOCASE
  `).all(row.project_id, row.id).map((tag) => tag.name);
  asset.child_asset_ids = database.prepare("SELECT asset_id FROM asset_versions WHERE project_id = ? AND parent_asset_id = ? ORDER BY created_at, asset_id").all(row.project_id, row.id).map((child) => child.asset_id);
  asset.recipe_snapshots = recipe.snapshots;
  asset.active_recipe_snapshot_id = recipe.active_snapshot_id;
  return withRuntimeUrls(asset);
}

function withRuntimeUrls(asset) {
  const base = `/library/${encodeURIComponent(asset.project_id)}`;
  const original = `${base}/images/${encodeURIComponent(asset.asset)}`;
  return {
    ...asset,
    image_url: original,
    preview_url: asset.preview_path ? `${base}/previews/${encodeURIComponent(asset.id)}.webp` : original,
    medium_url: asset.medium_path ? `${base}/mediums/${encodeURIComponent(asset.id)}.webp` : (asset.preview_path ? `${base}/previews/${encodeURIComponent(asset.id)}.webp` : original),
    thumbnail_url: asset.thumbnail_path ? `${base}/thumbnails/${encodeURIComponent(asset.id)}.webp` : original,
    preview_ready: Boolean(asset.preview_path),
    medium_ready: Boolean(asset.medium_path),
    thumbnail_ready: Boolean(asset.thumbnail_path),
    prompt_file: null,
  };
}

function annotateAssetStackCovers(database, assets, projectId) {
  if (!assets.length) return assets;
  const ids = assets.map((asset) => asset.id);
  const placeholders = ids.map(() => "?").join(", ");
  const rows = database.prepare(`
    SELECT sm.asset_id, sm.stack_id, counts.member_count
    FROM asset_stack_members sm
    JOIN (
      SELECT project_id, stack_id, COUNT(*) AS member_count
      FROM asset_stack_members
      WHERE project_id = ?
      GROUP BY project_id, stack_id
    ) counts ON counts.project_id = sm.project_id AND counts.stack_id = sm.stack_id
    WHERE sm.project_id = ? AND sm.position = 0 AND sm.asset_id IN (${placeholders})
  `).all(projectId, projectId, ...ids);
  const byAssetId = new Map(rows.map((row) => [row.asset_id, row]));
  return assets.map((asset) => {
    const row = byAssetId.get(asset.id);
    if (!row || Number(row.member_count) < 2) return asset;
    return {
      ...asset,
      stack: { id: row.stack_id, count: Number(row.member_count) },
    };
  });
}

function stackSummary(database, projectId, stackId) {
  const row = database.prepare(`
    SELECT s.id, s.created_at, s.updated_at,
      COUNT(sm.asset_id) AS member_count,
      MAX(CASE WHEN sm.position = 0 THEN sm.asset_id ELSE NULL END) AS cover_asset_id
    FROM asset_stacks s
    LEFT JOIN asset_stack_members sm
      ON sm.project_id = s.project_id AND sm.stack_id = s.id
    WHERE s.project_id = ? AND s.id = ?
    GROUP BY s.project_id, s.id
  `).get(projectId, stackId);
  if (!row) return null;
  return {
    id: row.id,
    count: Number(row.member_count || 0),
    cover_asset_id: row.cover_asset_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function compactAssetStack(database, projectId, stackId) {
  const rows = database.prepare(`
    SELECT asset_id FROM asset_stack_members
    WHERE project_id = ? AND stack_id = ?
    ORDER BY position, asset_id
  `).all(projectId, stackId);
  if (rows.length <= 1) {
    database.prepare("DELETE FROM asset_stacks WHERE project_id = ? AND id = ?").run(projectId, stackId);
    return { dissolved: true, remainingAssetId: rows[0]?.asset_id || null };
  }
  database.prepare(`
    UPDATE asset_stack_members SET position = position + 1000000
    WHERE project_id = ? AND stack_id = ?
  `).run(projectId, stackId);
  const update = database.prepare(`
    UPDATE asset_stack_members SET position = ?
    WHERE project_id = ? AND stack_id = ? AND asset_id = ?
  `);
  rows.forEach((row, index) => update.run(index, projectId, stackId, row.asset_id));
  database.prepare("UPDATE asset_stacks SET updated_at = ? WHERE project_id = ? AND id = ?").run(now(), projectId, stackId);
  return { dissolved: false, remainingAssetId: null };
}

function appendFilterConditions(conditions, params, filters, alias = "a") {
  const column = (name) => `${alias}.${name}`;
  if (filters.source) {
    conditions.push(`${column("source_group")} = @source`);
    params.source = filters.source;
  }
  if (filters.group) {
    conditions.push(`${column("group_name")} = @group`);
    params.group = filters.group;
  }
  if (filters.conversation) {
    conditions.push(`${column("conversation_id")} = @conversation`);
    params.conversation = filters.conversation;
  }
  if (filters.generationBatch) {
    conditions.push(`${column("generation_batch")} = @generationBatch`);
    params.generationBatch = filters.generationBatch;
  }
  if (filters.category) {
    conditions.push(`${column("category")} = @category`);
    params.category = filters.category;
  }
  if (filters.style) {
    conditions.push(`${column("style")} = @style`);
    params.style = filters.style;
  }
  if (filters.favorite) conditions.push(`(${column("rating")} > 0 OR ${column("favorite")} = 1)`);
  if (filters.mediaKind === "img") conditions.push(`${column("media_kind")} = 'image'`);
  if (filters.mediaKind === "video") conditions.push(`${column("media_kind")} = 'video'`);
  if (filters.recent) {
    conditions.push(`${column("created_at_epoch")} >= @recentSince`);
    params.recentSince = Number.isFinite(filters.recentSince) ? filters.recentSince : recentCutoffTimestamp();
  }
}

function appendSearchConditions(conditions, params, query, { alias = "a", prefix = "search" } = {}) {
  const normalized = normalizeAssetSearchQuery(query);
  const terms = normalized.split(/\s+/u).filter(Boolean);
  if (!terms.length) return { terms, searchKind: "", scoreSql: "1" };
  const searchKind = assetSearchKind(normalized);
  const ftsTerms = terms.filter((term) => [...term].length >= 3);
  const shortTerms = terms.filter((term) => [...term].length < 3);
  if (ftsTerms.length) {
    const key = `${prefix}FtsQuery`;
    params[key] = buildFtsQuery(ftsTerms.join(" "));
    conditions.push(`${alias}.id IN (SELECT asset_id FROM asset_fts WHERE project_id = @projectId AND content MATCH @${key})`);
  }
  const likeTerms = ftsTerms.length ? shortTerms : terms;
  likeTerms.forEach((term, index) => {
    const key = `${prefix}Like${index}`;
    conditions.push(`LOWER(${alias}.search_text) LIKE @${key} ESCAPE '\\'`);
    params[key] = `%${escapeLikePattern(term)}%`;
  });
  if (searchKind) {
    const key = `${prefix}SearchKind`;
    params[key] = searchKind;
    conditions.push(`mosa_asset_matches_search_kind(
      @${key}, ${alias}.asset, ${alias}.id, ${alias}.prompt, ${alias}.skill, ${alias}.style, ${alias}.theme,
      ${alias}.group_name, ${alias}.category, ${alias}.tags_text
    ) = 1`);
  }
  return { terms, searchKind, scoreSql: searchKind ? buildSearchScoreSql(terms, params, alias) : "1" };
}

function listCollapsedAssetPage(database, { filters, projectId, limit, sort, searchQuery, cursor }) {
  const params = { projectId };
  const memberConditions = ["m.project_id = @projectId", "m.archived = 0"];
  appendFilterConditions(memberConditions, params, filters, "m");
  const search = appendSearchConditions(memberConditions, params, searchQuery, { alias: "m", prefix: "node" });

  const matchedCte = `matched AS MATERIALIZED (
    SELECT
      COALESCE(sm.stack_id, 'asset:' || m.id) AS node_key,
      COALESCE(cover.asset_id, m.id) AS node_asset_id,
      sm.stack_id AS stack_id,
      MAX(${search.scoreSql}) AS _search_score
    FROM assets m
    LEFT JOIN asset_stack_members sm
      ON sm.project_id = m.project_id AND sm.asset_id = m.id
    LEFT JOIN asset_stack_members cover
      ON cover.project_id = sm.project_id AND cover.stack_id = sm.stack_id AND cover.position = 0
    WHERE ${memberConditions.join(" AND ")}
    GROUP BY node_key, node_asset_id, sm.stack_id
  )`;

  const rowsCte = `node_rows AS MATERIALIZED (
    SELECT ${PAGE_ASSET_COLUMNS}, matched._search_score,
      COALESCE(NULLIF(s.sort_created_at, ''), a.created_at) AS _node_created_at,
      COALESCE(NULLIF(s.sort_name, ''), a.sort_name) AS _node_sort_name
    FROM matched
    JOIN assets a ON a.project_id = @projectId AND a.id = matched.node_asset_id
    LEFT JOIN asset_stacks s ON s.project_id = @projectId AND s.id = matched.stack_id
  )`;

  const pageConditions = [];
  if (cursor) {
    params.cursorId = cursor.id;
    params.cursorCreatedAt = cursor.createdAt;
    params.cursorSortName = cursor.sortName;
    const secondary = sort === "name"
      ? "(r._node_sort_name > @cursorSortName OR (r._node_sort_name = @cursorSortName AND r.id > @cursorId))"
      : sort === "oldest"
        ? "(r._node_created_at > @cursorCreatedAt OR (r._node_created_at = @cursorCreatedAt AND r.id > @cursorId))"
        : "(r._node_created_at < @cursorCreatedAt OR (r._node_created_at = @cursorCreatedAt AND r.id < @cursorId))";
    if (search.searchKind) {
      params.cursorSearchScore = cursor.searchScore;
      pageConditions.push(`(r._search_score < @cursorSearchScore OR (r._search_score = @cursorSearchScore AND ${secondary}))`);
    } else {
      pageConditions.push(secondary);
    }
  }

  const orderBy = search.searchKind
    ? `r._search_score DESC, ${sort === "name"
      ? "r._node_sort_name ASC, r.id ASC"
      : sort === "oldest"
        ? "r._node_created_at ASC, r.id ASC"
        : "r._node_created_at DESC, r.id DESC"}`
    : sort === "name"
      ? "r._node_sort_name ASC, r.id ASC"
      : sort === "oldest"
        ? "r._node_created_at ASC, r.id ASC"
        : "r._node_created_at DESC, r.id DESC";
  const where = pageConditions.length ? `WHERE ${pageConditions.join(" AND ")}` : "";
  const sql = `WITH ${matchedCte}, ${rowsCte}
    SELECT r.* FROM node_rows r ${where}
    ORDER BY ${orderBy}`;
  const rows = limit > 0
    ? database.prepare(`${sql} LIMIT @limit`).all({ ...params, limit: limit + 1 })
    : database.prepare(sql).all(params);
  const hasMore = limit > 0 && rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const assets = annotateAssetStackCovers(
    database,
    pageRows.map((row) => rowToAsset(database, row, { includeRelations: false })),
    projectId,
  );
  const total = Number(database.prepare(`WITH ${matchedCte} SELECT COUNT(*) AS count FROM matched`).get(params).count || 0);
  const last = pageRows.at(-1);
  return {
    assets,
    page: {
      total,
      nextCursor: hasMore && last ? encodeCursor(last, sort, searchQuery) : null,
      limit: limit || total,
      sort,
    },
  };
}

const ALLOWED_GROUP_COLUMNS = new Set(["category", "style", "group_name"]);
const DERIVATIVE_COLUMNS = new Map([
  ["preview", "preview_path"],
  ["medium", "medium_path"],
  ["thumbnail", "thumbnail_path"],
]);

function countNamedValues(database, projectId, column, limit = 0) {
  if (!ALLOWED_GROUP_COLUMNS.has(column)) throw new Error(`Unsafe column name: ${column}`);
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
    user_prompt: String(input.user_prompt || ""),
    negative_prompt: String(input.negative_prompt || ""),
    references: Array.isArray(input.references) ? input.references : [],
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
    created_at: normalizeCreatedAt(input.created_at, now()),
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

function buildSearchScoreSql(terms, params, alias = "a") {
  const lower = (column) => `lower(COALESCE(${column}, ''))`;
  const column = (name) => `${alias}.${name}`;
  const tagExact = (key) => `instr(char(31) || ${lower(column("tags_text"))} || char(31), char(31) || @${key} || char(31)) > 0`;
  const contains = (column, key) => `instr(${lower(column)}, @${key}) > 0`;
  const promptOccurrences = (key) => `(
    (length(${lower(column("prompt"))}) - length(replace(${lower(column("prompt"))}, @${key}, ''))) / length(@${key})
  )`;
  const promptScore = (key) => `(
    ${ASSET_SEARCH_WEIGHTS.promptContains}
    + min(${ASSET_SEARCH_WEIGHTS.promptFrequencyCap}, max(0, (${promptOccurrences(key)} - 1) * ${ASSET_SEARCH_WEIGHTS.promptFrequencyStep}))
    + CASE WHEN ltrim(${lower(column("prompt"))}) LIKE @${key} || '%' THEN ${ASSET_SEARCH_WEIGHTS.promptPrefixBonus} ELSE 0 END
  )`;
  const bestTermScore = (key) => `CASE
    WHEN ${lower(column("asset"))} = @${key} THEN ${ASSET_SEARCH_WEIGHTS.assetExact}
    WHEN ${lower(column("id"))} = @${key} THEN ${ASSET_SEARCH_WEIGHTS.idExact}
    WHEN ${tagExact(key)} THEN ${ASSET_SEARCH_WEIGHTS.tagExact}
    WHEN ${lower(column("category"))} = @${key} THEN ${ASSET_SEARCH_WEIGHTS.categoryExact}
    WHEN ${lower(column("group_name"))} = @${key} THEN ${ASSET_SEARCH_WEIGHTS.groupExact}
    WHEN ${contains(column("asset"), key)} THEN ${ASSET_SEARCH_WEIGHTS.assetContains}
    WHEN ${contains(column("id"), key)} THEN ${ASSET_SEARCH_WEIGHTS.idContains}
    WHEN ${contains(column("tags_text"), key)} THEN ${ASSET_SEARCH_WEIGHTS.tagContains}
    WHEN ${contains(column("category"), key)} THEN ${ASSET_SEARCH_WEIGHTS.categoryContains}
    WHEN ${contains(column("group_name"), key)} THEN ${ASSET_SEARCH_WEIGHTS.groupContains}
    WHEN ${lower(column("style"))} = @${key} THEN ${ASSET_SEARCH_WEIGHTS.styleExact}
    WHEN ${lower(column("theme"))} = @${key} THEN ${ASSET_SEARCH_WEIGHTS.themeExact}
    WHEN ${lower(column("skill"))} = @${key} THEN ${ASSET_SEARCH_WEIGHTS.skillExact}
    WHEN ${contains(column("style"), key)} THEN ${ASSET_SEARCH_WEIGHTS.styleContains}
    WHEN ${contains(column("theme"), key)} THEN ${ASSET_SEARCH_WEIGHTS.themeContains}
    WHEN ${contains(column("skill"), key)} THEN ${ASSET_SEARCH_WEIGHTS.skillContains}
    WHEN ${lower(column("prompt"))} = @${key} THEN ${ASSET_SEARCH_WEIGHTS.promptExact}
    WHEN ${contains(column("prompt"), key)} THEN ${promptScore(key)}
    WHEN ${contains(column("business_search_text"), key)} THEN ${ASSET_SEARCH_WEIGHTS.businessContains}
    WHEN ${contains(column("source_search_text"), key)} THEN ${ASSET_SEARCH_WEIGHTS.sourceContains}
    ELSE 0
  END`;
  const termScores = terms.map((term, index) => {
    const key = `searchTerm${index}`;
    params[key] = term;
    return bestTermScore(key);
  });
  // Candidate generation already applies AND semantics to every term against
  // search_text/FTS. search_text is assembled from the exact same fields scored
  // below, so re-evaluating every CASE once for "is non-zero" and again for its
  // value only doubles CPU without filtering any additional rows.
  const termScoreSum = termScores.map((score) => `(${score})`).join(" + ");

  const phrase = terms.join(" ");
  params.searchPhrase = phrase;
  const phraseBonus = `CASE
    WHEN instr(${lower(column("asset"))}, @searchPhrase) > 0 THEN ${ASSET_SEARCH_WEIGHTS.phraseAssetBonus}
    WHEN instr(${lower(column("tags_text"))}, @searchPhrase) > 0 THEN ${ASSET_SEARCH_WEIGHTS.phraseTagBonus}
    WHEN instr(${lower(column("category"))}, @searchPhrase) > 0 THEN ${ASSET_SEARCH_WEIGHTS.phraseCategoryBonus}
    WHEN instr(${lower(column("group_name"))}, @searchPhrase) > 0 THEN ${ASSET_SEARCH_WEIGHTS.phraseGroupBonus}
    WHEN instr(${lower(column("prompt"))}, @searchPhrase) > 0 THEN ${ASSET_SEARCH_WEIGHTS.phrasePromptBonus}
    ELSE 0
  END`;
  return `((${termScoreSum}) + (${phraseBonus}))`;
}

function escapeLikePattern(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function plainAsciiSearchTerms(query) {
  const value = String(query || "").trim();
  if ([...value].length < 3) return [];
  const terms = value.split(/\s+/).filter(Boolean);
  if (!terms.length || terms.some((term) => !/^[a-z0-9][a-z0-9._-]*$/i.test(term))) return [];
  return terms.map((term) => term.toLowerCase());
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

function normalizeSuppressionPageLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(parsed), MAX_PAGE_SIZE);
}

function encodeSuppressionCursor(row) {
  return Buffer.from(JSON.stringify({
    deletedAt: row.deleted_at,
    contentHash: row.content_sha256,
    pixelHash: row.pixel_sha256,
    pixelHashVersion: row.pixel_hash_version || "",
  })).toString("base64url");
}

function parseSuppressionCursor(value) {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (typeof cursor?.deletedAt !== "string" || typeof cursor?.contentHash !== "string" || typeof cursor?.pixelHash !== "string") throw new Error();
    return { ...cursor, pixelHashVersion: typeof cursor.pixelHashVersion === "string" ? cursor.pixelHashVersion : "" };
  } catch {
    throw assetStoreError("INVALID_SUPPRESSION_CURSOR", "Invalid suppression cursor.");
  }
}

function encodeCursor(row, sort, searchQuery = "") {
  return Buffer.from(JSON.stringify({
    createdAt: row._node_created_at ?? row.created_at,
    id: row.id,
    sortName: row._node_sort_name ?? row.sort_name ?? assetSortName(row),
    sort: normalizeAssetSort(sort),
    searchQuery: normalizeAssetSearchQuery(searchQuery),
    searchScore: Number(row._search_score || 0),
  })).toString("base64url");
}

/**
 * The cursor carries the order it was issued under. Resuming a `newest` cursor
 * under a `name` sort would compare the wrong key and silently return a page
 * from the middle of an unrelated ordering, so the mismatch is rejected and the
 * caller restarts the query instead.
 */
function parseCursor(value, sort, searchQuery = "") {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (typeof cursor?.createdAt !== "string" || typeof cursor?.id !== "string") throw new Error();
    // Cursors minted before sorting existed carry no sort and are chronological.
    const cursorSort = normalizeAssetSort(cursor.sort);
    if (cursorSort !== normalizeAssetSort(sort)) throw new Error();
    if (cursorSort === "name" && typeof cursor.sortName !== "string") throw new Error();
    const normalizedQuery = normalizeAssetSearchQuery(searchQuery);
    if (normalizeAssetSearchQuery(cursor.searchQuery) !== normalizedQuery) throw new Error();
    if (normalizedQuery && !Number.isFinite(Number(cursor.searchScore))) throw new Error();
    return cursor;
  } catch {
    throw assetStoreError("INVALID_ASSET_CURSOR", "Invalid asset cursor.");
  }
}

async function resolveReadableImagePath(store, value, trustedSourceRoots = []) {
  const requestedPath = resolveRequiredPath(value, "imagePath");
  if (!MEDIA_EXTENSIONS.has(extname(requestedPath).toLowerCase())) throw assetStoreError("IMAGE_PATH_UNSUPPORTED_TYPE", `Unsupported media type: ${requestedPath}`);
  // Messages match the JSON store; only the machine-readable code is new, so the
  // import form can attribute each rejection to the path field.
  const requestedStat = await statForImport(requestedPath);
  if (requestedStat.isSymbolicLink()) throw assetStoreError("IMAGE_PATH_NOT_READABLE", `Refusing to import symbolic links: ${requestedPath}`);
  if (!requestedStat.isFile()) throw assetStoreError("IMAGE_PATH_NOT_READABLE", `imagePath is not a file: ${requestedPath}`);
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
  if (!roots.some((root) => filePath === root || isSafeChildPath(root, filePath))) throw assetStoreError("IMAGE_PATH_NOT_READABLE", `Refusing to import outside the project roots: ${filePath}`);
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

function generationEventFromRow(row) {
  return {
    project_id: row.project_id,
    id: row.id,
    output_asset_id: row.output_asset_id,
    provider: row.provider,
    capture_context_id: row.capture_context_id,
    provider_tool_call_id: row.provider_tool_call_id,
    provider_generation_call_id: row.provider_generation_call_id,
    provider_response_id: row.provider_response_id,
    provider_asset_id: row.provider_asset_id,
    conversation_id: row.conversation_id,
    message_id: row.message_id,
    batch_id: row.batch_id,
    model: row.model,
    user_prompt: row.user_prompt,
    effective_prompt: row.effective_prompt,
    prompt_status: row.prompt_status,
    capture_channel: row.capture_channel,
    verification_level: row.verification_level,
    references: parseJson(row.references_json, []),
    evidence: parseJson(row.evidence_json, {}),
    created_at: row.created_at,
  };
}

function generationRelationFromRow(row) {
  return {
    project_id: row.project_id,
    child_generation_id: row.child_generation_id,
    parent_generation_id: row.parent_generation_id,
    relation_type: row.relation_type,
    verification_level: row.verification_level,
    evidence: parseJson(row.evidence_json, {}),
    created_at: row.created_at,
  };
}

function generationRelationCandidateFromRow(row) {
  return {
    project_id: row.project_id,
    child_generation_id: row.child_generation_id,
    parent_generation_id: row.parent_generation_id,
    suggested_relation_type: row.suggested_relation_type,
    confidence: Number(row.confidence || 0),
    verification_level: row.verification_level,
    evidence: parseJson(row.evidence_json, {}),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function syncSqliteGenerationRelationCandidates(database, projectId) {
  const events = database.prepare("SELECT * FROM generation_events WHERE project_id = ? ORDER BY created_at, id").all(projectId).map(generationEventFromRow);
  const relations = database.prepare("SELECT * FROM generation_relations WHERE project_id = ? ORDER BY created_at, child_generation_id, parent_generation_id").all(projectId).map(generationRelationFromRow);
  const candidates = database.prepare("SELECT * FROM generation_relation_candidates WHERE project_id = ?").all(projectId).map(generationRelationCandidateFromRow);
  const resolved = resolveGenerationRelationCandidates({ projectId, events, relations, candidates, now: now() });
  const write = database.transaction(() => {
    database.prepare("DELETE FROM generation_relation_candidates WHERE project_id = ?").run(projectId);
    const insert = database.prepare(`
      INSERT INTO generation_relation_candidates (
        project_id, child_generation_id, parent_generation_id, suggested_relation_type,
        confidence, verification_level, evidence_json, status, created_at, updated_at
      ) VALUES (
        @project_id, @child_generation_id, @parent_generation_id, @suggested_relation_type,
        @confidence, @verification_level, @evidence_json, @status, @created_at, @updated_at
      )
    `);
    for (const candidate of resolved) {
      insert.run({ ...candidate, evidence_json: JSON.stringify(candidate.evidence || {}) });
    }
  });
  write();
  return resolved;
}

function normalizeHash(value) {
  const hash = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : "";
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectHash);
    stream.once("end", resolveHash);
  });
  return hash.digest("hex");
}

function normalizeSuppressionHashes(input = {}) {
  return {
    content_sha256: normalizeHash(input.content_sha256 ?? input.contentSha256),
    pixel_sha256: normalizeHash(input.pixel_sha256 ?? input.pixelSha256),
    pixel_hash_version: String(input.pixel_hash_version ?? input.pixelHashVersion ?? "").trim(),
  };
}

function normalizeSuppressionRecord(input = {}) {
  return {
    project_id: sanitizeProjectId(input.project_id || DEFAULT_PROJECT_ID),
    ...normalizeSuppressionHashes(input),
    deleted_at: String(input.deleted_at || now()),
    reason: String(input.reason || "user-deleted").trim().slice(0, 120) || "user-deleted",
  };
}

function suppressionRowToObject(row) {
  return {
    project_id: row.project_id,
    content_sha256: row.content_sha256,
    pixel_sha256: row.pixel_sha256,
    pixel_hash_version: row.pixel_hash_version || "",
    deleted_at: row.deleted_at,
    reason: row.reason,
  };
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
function resolveRequiredPath(value, label) { if (!value || typeof value !== "string") throw assetStoreError("IMAGE_PATH_REQUIRED", `${label} is required.`); return resolve(value); }
/** A missing file is an ordinary form mistake, not a 500. */
async function statForImport(requestedPath) {
  try {
    return await lstat(requestedPath);
  } catch (error) {
    if (error?.code === "ENOENT") throw assetStoreError("IMAGE_PATH_NOT_FOUND", `imagePath does not exist: ${requestedPath}`);
    throw error;
  }
}
function isSafeChildPath(parent, child) { return isPathInside(parent, child); }
function now() { return new Date().toISOString(); }

async function contentHashForAsset(asset, filesToUnlink) {
  const recorded = normalizeHash(asset.source?.content_sha256);
  if (recorded) return recorded;
  const originalPath = filesToUnlink.find((filePath) => filePath === asset.image_path) || "";
  if (!originalPath) return "";
  try {
    return await sha256File(originalPath);
  } catch {
    return "";
  }
}
