import { copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { createSqliteAssetStore, hasCompletedSqliteLibrary, sqliteDatabasePath, STYLE_FACET_LIMIT } from "./sqlite-asset-store.mjs";
import { relinkCodexAssets } from "./codex-hardlink.js";
import { isRecentCreatedAt, normalizeCreatedAt, recentCutoffTimestamp } from "./recent-window.js";
import { PIXEL_HASH_VERSION, safePixelDigest } from "./image-pixel-hash.js";
import { isPathInside } from "./path-safety.mjs";
import { resolveSourceLocations } from "./source-locations.js";
import {
  assertGenerationRelationUserMutable,
  assertGenerationRelationAcyclic,
  buildAssetGenerationHistory,
  buildGenerationLineage,
  generationHistoryError,
  generationCandidatePairKey,
  normalizeGenerationEvent,
  normalizeGenerationRelation,
  normalizeGenerationRelationCandidate,
  preserveTrustedGenerationEvent,
  preserveTrustedGenerationRelation,
  resolveGenerationRelationCandidates,
} from "./generation-history.mjs";
// Same media classification as the SQLite store's mosa_media_kind: explicit
// media_kind first, then the file extension. Powers the V2 type filter.
const MEDIA_KIND_IMAGE_EXT = new Set([".apng", ".avif", ".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp"]);
const MEDIA_KIND_VIDEO_EXT = new Set([".m4v", ".mov", ".mp4", ".webm"]);
function mediaKindOfAsset(asset = {}) {
  const kind = asset.source?.media_kind || asset.business_fields?.media_kind;
  if (kind === "video") return "video";
  if (kind === "image") return "image";
  const match = /\.([a-z0-9]+)(?:$|\?)/i.exec(String(asset.image_path || asset.asset || ""));
  const ext = match ? `.${match[1].toLowerCase()}` : "";
  if (MEDIA_KIND_VIDEO_EXT.has(ext)) return "video";
  if (MEDIA_KIND_IMAGE_EXT.has(ext)) return "image";
  return "unknown";
}
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
import { appendRecipeSnapshot, ensureRecipeSnapshots, recipeHistory } from "./recipe-snapshot.js";
import { assetSortName, compareAssets, normalizeAssetSort } from "./asset-sort.js";
import { assetSearchScore, compareAssetSearchResults, normalizeAssetSearchQuery } from "./asset-search.mjs";

const IMAGE_EXTENSIONS = new Set([".apng", ".avif", ".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".m4v", ".mov", ".mp4", ".webm"]);
const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);
/** Served to the import form so its "supported formats" hint cannot drift from what is accepted. */
export const SUPPORTED_MEDIA_EXTENSIONS = [...MEDIA_EXTENSIONS].sort();
const DEFAULT_PROJECT_ID = "default";
const CANONICAL_SOURCE_TYPES = new Set([
  "web-chatgpt",
  "web-gemini",
  "web-flow",
  "web-google-ai-studio",
  "codex-generated",
  "grok-generated",
  "cowart-generated",
]);
const WEB_SOURCE_TYPE_BY_PROVIDER = new Map([
  ["chatgpt", "web-chatgpt"],
  ["gemini", "web-gemini"],
  ["flow", "web-flow"],
  ["google-ai-studio", "web-google-ai-studio"],
]);
const GROUP_LOCK_TIMEOUT_MS = 5000;
const GROUP_LOCK_STALE_MS = 30_000;
const GROUP_CLEANUP_LOCK_STALE_MS = 5000;
// Corrupt metadata is reported once per store instance so repeated gallery scans cannot flood the caller.
const warnedMetadataPaths = new WeakMap();

function canonicalAssetSourceType(asset = {}) {
  const source = asset.source && typeof asset.source === "object" ? asset.source : {};
  const rawType = String(source.type || asset.sourceType || "").trim();
  if (CANONICAL_SOURCE_TYPES.has(rawType)) return rawType;

  const provider = String(source.provider || asset.business_fields?.provider || "").trim().toLowerCase();
  const webSourceType = WEB_SOURCE_TYPE_BY_PROVIDER.get(provider);
  if (webSourceType) return webSourceType;

  const generationTool = String(source.generation_tool || asset.business_fields?.generation_tool || "").trim().toLowerCase();
  if (generationTool === "codex") return "codex-generated";
  if (generationTool === "grok") return "grok-generated";
  if (generationTool === "cowart") return "cowart-generated";
  return rawType;
}

/**
 * Selects SQLite for completed migrations and genuinely fresh libraries.
 * Legacy JSON state always wins until the explicit migration has completed, so
 * an upgrade can never silently strand existing metadata or media.
 */
export function createAssetStore(options = {}) {
  const libraryDir = options.libraryDir || process.env.MOSA_LIBRARY_DIR;
  if (libraryDir && hasCompletedSqliteLibrary(libraryDir)) {
    return createSqliteAssetStore({ ...options, libraryDir });
  }
  if (libraryDir && !existsSync(sqliteDatabasePath(libraryDir))
    && (existsSync(join(resolve(libraryDir), ".sqlite-migration-completed"))
      || existsSync(join(resolve(libraryDir), "legacy-json-backup")))) {
    const error = new Error("The migrated SQLite library is missing. Restore mosa.db instead of falling back to the legacy JSON snapshot.");
    error.code = "SQLITE_LIBRARY_MISSING";
    throw error;
  }
  // A database that already exists but is not marked completed is never a
  // fresh-library signal. It may be a failed/interrupted migration, so fail
  // closed to the legacy store until migration is explicitly completed.
  if (libraryDir && existsSync(sqliteDatabasePath(libraryDir))) {
    return createJsonAssetStore(options);
  }
  if (libraryDir && !hasLegacyJsonState(options)) {
    return createSqliteAssetStore({ ...options, libraryDir, initializeFreshLibrary: true });
  }
  return createJsonAssetStore(options);
}

/**
 * A fresh runtime may have created the legacy directory skeleton without ever
 * storing user data. Treat only meaningful entries as legacy state. If the
 * scan itself fails, fail closed and keep JSON so uncertain data is never
 * bypassed by an automatic SQLite selection.
 */
function hasLegacyJsonState(options = {}) {
  const projectRoot = resolve(options.projectRoot || process.cwd());
  const managerDir = resolve(options.managerDir || join(projectRoot, "mosa"));
  const configuredLibraryDir = options.libraryDir || process.env.MOSA_LIBRARY_DIR || null;
  const explicitLibraryDir = Object.hasOwn(options, "explicitLibraryDir")
    ? options.explicitLibraryDir
    : configuredLibraryDir;
  const legacyAssetsRoot = resolve(options.assetsRoot || (explicitLibraryDir
    ? join(resolve(explicitLibraryDir), "assets")
    : join(managerDir, "assets")));

  if (!existsSync(legacyAssetsRoot)) return false;
  try {
    for (const projectEntry of readdirSync(legacyAssetsRoot, { withFileTypes: true })) {
      if (!projectEntry.isDirectory()) return true;
      const projectDir = join(legacyAssetsRoot, projectEntry.name);
      for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (readdirSync(join(projectDir, entry.name)).length > 0) return true;
          continue;
        }
        // Lock files are transient coordination state, not user library data.
        if (!entry.name.endsWith(".lock") && !entry.name.endsWith(".cleanup")) return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

export function createJsonAssetStore(options = {}) {
  const projectRoot = resolve(options.projectRoot || process.cwd());
  const managerDir = resolve(options.managerDir || join(projectRoot, "mosa"));
  // Only an explicitly configured library location roots JSON assets inside it. Direct
  // callers treat options.libraryDir / MOSA_LIBRARY_DIR as explicit; the runtime always
  // computes a *default* libraryDir for SQLite detection and lock management, so it
  // passes `explicitLibraryDir` to record whether the user actually configured one.
  // Without that signal the bundled managerDir/assets stays in use.
  const explicitLibraryDir = Object.hasOwn(options, "explicitLibraryDir")
    ? options.explicitLibraryDir
    : options.libraryDir || process.env.MOSA_LIBRARY_DIR || null;
  const resolvedLibraryDir = explicitLibraryDir ? resolve(explicitLibraryDir) : null;
  const assetsRoot = resolve(options.assetsRoot || (resolvedLibraryDir ? join(resolvedLibraryDir, "assets") : join(managerDir, "assets")));
  const generatedImagesDir = resolve(options.generatedImagesDir || join(projectRoot, "generated-images"));
  const { codexImagesDir, cowartCanvasDir } = resolveSourceLocations({
    env: process.env,
    overrides: {
      codexImagesDir: options.codexImagesDir,
      cowartCanvasDir: options.cowartCanvasDir,
    },
  });
  const cowartPageAssetsDir = join(cowartCanvasDir, "pages");
  const onWarning = typeof options.onWarning === "function" ? options.onWarning : null;

  return {
    storageKind: "json",
    projectRoot,
    managerDir,
    libraryDir: resolvedLibraryDir,
    assetsRoot,
    generatedImagesDir,
    codexImagesDir,
    cowartCanvasDir,
    cowartPageAssetsDir,
    onWarning,
    projectId(value) {
      return sanitizeProjectId(value);
    },
    projectDir(projectId = DEFAULT_PROJECT_ID) {
      return join(assetsRoot, sanitizeProjectId(projectId));
    },
    imagesDir(projectId = DEFAULT_PROJECT_ID) {
      return join(assetsRoot, sanitizeProjectId(projectId), "images");
    },
    promptsDir(projectId = DEFAULT_PROJECT_ID) {
      return join(assetsRoot, sanitizeProjectId(projectId), "prompts");
    },
    metadataDir(projectId = DEFAULT_PROJECT_ID) {
      return join(assetsRoot, sanitizeProjectId(projectId), "metadata");
    },
    groupsFile(projectId = DEFAULT_PROJECT_ID) {
      return join(this.projectDir(projectId), "groups.json");
    },
    automaticIngestSuppressionsFile(projectId = DEFAULT_PROJECT_ID) {
      return join(this.projectDir(projectId), "automatic-ingest-suppressions.json");
    },
    generationEventsFile(projectId = DEFAULT_PROJECT_ID) {
      return join(this.projectDir(projectId), "generation-events.json");
    },
    generationRelationsFile(projectId = DEFAULT_PROJECT_ID) {
      return join(this.projectDir(projectId), "generation-relations.json");
    },
    generationRelationCandidatesFile(projectId = DEFAULT_PROJECT_ID) {
      return join(this.projectDir(projectId), "generation-relation-candidates.json");
    },
    async ensureProject(projectId = DEFAULT_PROJECT_ID) {
      const cleanProjectId = sanitizeProjectId(projectId);
      await mkdir(this.imagesDir(cleanProjectId), { recursive: true });
      await mkdir(this.promptsDir(cleanProjectId), { recursive: true });
      await mkdir(this.metadataDir(cleanProjectId), { recursive: true });
      return cleanProjectId;
    },
    async listProjects() {
      await mkdir(assetsRoot, { recursive: true });
      const entries = await readdir(assetsRoot, { withFileTypes: true });
      const projects = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
      if (!projects.includes(DEFAULT_PROJECT_ID)) {
        await this.ensureProject(DEFAULT_PROJECT_ID);
        projects.unshift(DEFAULT_PROJECT_ID);
      }
      return [...new Set(projects)];
    },
    async listAssets(filters = {}) {
      const projectId = await this.ensureProject(filters.projectId || DEFAULT_PROJECT_ID);
      const assets = deriveChildAssetIds(await readProjectAssets(this, projectId)).map(withRuntimeUrls);
      const recentSince = Number.isFinite(filters.recentSince) ? filters.recentSince : recentCutoffTimestamp();
      const searchQuery = normalizeAssetSearchQuery(filters.query);

      return assets
        .filter((asset) => !searchQuery || assetSearchScore(asset, searchQuery) > 0)
        .filter((asset) => (filters.archived ? Boolean(asset.archived) : !asset.archived))
        .filter((asset) => {
          if (filters.source && canonicalAssetSourceType(asset) !== filters.source) return false;
          if (filters.conversation && asset.source?.conversation_id !== filters.conversation) return false;
          if (filters.generationBatch && asset.source?.message_id !== filters.generationBatch) return false;
          if (filters.group && asset.group !== filters.group) return false;
          if (filters.category && asset.category !== filters.category) return false;
          if (filters.style && asset.style !== filters.style) return false;
          if (filters.favorite && !(asset.rating > 0 || asset.favorite === true)) return false;
          if (filters.mediaKind === "img" && mediaKindOfAsset(asset) !== "image") return false;
          if (filters.mediaKind === "video" && mediaKindOfAsset(asset) !== "video") return false;
          if (filters.recent && !isRecentCreatedAt(asset.created_at, recentSince)) return false;
          return true;
        })
        .sort((left, right) => searchQuery
          ? compareAssetSearchResults(searchQuery, filters.sort, left, right)
          : compareAssets(filters.sort, left, right));
    },
    async listAssetPage(filters = {}) {
      const sort = normalizeAssetSort(filters.sort);
      const searchQuery = normalizeAssetSearchQuery(filters.query);
      const assets = await this.listAssets(filters);
      const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 250);
      let start = 0;
      if (filters.cursor) {
        const cursor = parseAssetCursor(filters.cursor, sort, searchQuery);
        const boundary = cursorRow(cursor);
        start = assets.findIndex((asset) => {
          if (!searchQuery) return compareAssets(sort, asset, boundary) > 0;
          const score = assetSearchScore(asset, searchQuery);
          if (score !== cursor.searchScore) return score < cursor.searchScore;
          return compareAssets(sort, asset, boundary) > 0;
        });
        if (start < 0) start = assets.length;
      }
      const pageAssets = assets.slice(start, start + limit);
      const last = pageAssets.at(-1);
      return {
        assets: pageAssets,
        page: {
          total: assets.length,
          limit,
          nextCursor: start + limit < assets.length && last
            ? Buffer.from(JSON.stringify({
              createdAt: last.created_at,
              id: last.id,
              sortName: assetSortName(last),
              sort,
              searchQuery,
              searchScore: searchQuery ? assetSearchScore(last, searchQuery) : 0,
            })).toString("base64url")
            : null,
          sort,
        },
      };
    },
    async listGroups(projectId = DEFAULT_PROJECT_ID) {
      const cleanProjectId = await this.ensureProject(projectId);
      // One cutoff for the whole call: the scan below and the recent counter must not
      // read the clock twice, or a boundary asset could be counted inconsistently.
      const recentSince = recentCutoffTimestamp();
      const assets = await this.listAssets({ projectId: cleanProjectId, recentSince });
      const manualGroups = await readGroupNames(this, cleanProjectId);
      const groups = {};
      const sourceTypes = {};
      const categories = {};
      const styles = {};
      let total = 0;
      let favorites = 0;
      let recent = 0;
      let codex = 0;
      let cowart = 0;
      let grok = 0;

      for (const name of manualGroups) groups[name] = 0;

      for (const asset of assets) {
        total++;
        // 收藏：rating > 0 或 favorite 标记为 true
        if (asset.rating > 0 || asset.favorite === true) favorites++;
        if (isRecentCreatedAt(asset.created_at, recentSince)) recent++;
        if (asset.source?.type === "codex-generated") codex++;
        if (asset.source?.type === "cowart-generated") cowart++;
        if (asset.source?.type === "grok-generated") grok++;
        const sourceType = canonicalAssetSourceType(asset);
        if (sourceType) sourceTypes[sourceType] = (sourceTypes[sourceType] || 0) + 1;
        const g = asset.group || "";
        if (g) groups[g] = (groups[g] || 0) + 1;
        const c = asset.category || "";
        if (c) categories[c] = (categories[c] || 0) + 1;
        const s = asset.style || "";
        if (s) styles[s] = (styles[s] || 0) + 1;
      }

      return {
        total,
        favorites,
        recent,
        codex,
        cowart,
        grok,
        sourceTypes: Object.entries(sourceTypes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
        groups: Object.entries(groups).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
        categories: Object.entries(categories).sort((a, b) => b[1] - a[1]),
        // Matches the SQLite store: the panel searches this list client-side, and
        // `styleTotal` keeps a truncated list honest about what it is hiding.
        styles: Object.entries(styles).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, STYLE_FACET_LIMIT),
        styleTotal: Object.keys(styles).length,
      };
    },
    async createGroup(input = {}) {
      const projectId = await this.ensureProject(input.projectId || DEFAULT_PROJECT_ID);
      return withGroupWriteLock(this, projectId, async () => {
        const name = normalizeGroupName(input.name);
        if (!name) throw assetStoreError("GROUP_NAME_REQUIRED", "Group name is required.");
        const names = await readGroupNames(this, projectId);
        const assets = await this.listAssets({ projectId });
        if ([...names, ...assets.map((asset) => asset.group)].some((item) => String(item || "").toLocaleLowerCase() === name.toLocaleLowerCase())) {
          throw assetStoreError("GROUP_ALREADY_EXISTS", `Group already exists: ${name}`);
        }
        names.push(name);
        await writeGroupNames(this, projectId, names);
        return { name, count: 0 };
      });
    },
    async deleteGroup(projectId, groupName) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      return withGroupWriteLock(this, cleanProjectId, async () => {
        const name = normalizeGroupName(groupName);
        if (!name) throw assetStoreError("GROUP_NAME_REQUIRED", "Group name is required.");

        const names = await readGroupNames(this, cleanProjectId);
        const index = names.findIndex((item) => item.toLocaleLowerCase() === name.toLocaleLowerCase());
        if (index === -1) throw assetStoreError("GROUP_NOT_FOUND", `Group not found: ${name}`);

        // Remove group from the list
        names.splice(index, 1);
        await writeGroupNames(this, cleanProjectId, names);

        // Remove group assignment from all assets
        const assets = await this.listAssets({ projectId: cleanProjectId });
        for (const asset of assets) {
          if (asset.group?.toLocaleLowerCase() === name.toLocaleLowerCase()) {
            // Group membership is library organization, not a recipe revision.
            // Write the metadata directly so deleting a group does not append a
            // misleading "Recipe updated" snapshot to every member.
            await writeMetadata(this, normalizeAssetMetadata({
              ...asset,
              group: null,
              updated_at: new Date().toISOString(),
            }));
          }
        }

        return { success: true, name };
      });
    },
    /**
     * Looks up an asset by the SHA-256 of its bytes, archived entries included. Callers used to
     * do this by listing the whole project twice and scanning in memory; this reads the metadata
     * directory once and decorates only the match.
     */
    async findAssetByContentHash(projectId, contentHash) {
      const hash = String(contentHash || "");
      if (!hash) return null;
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const assets = await readProjectAssets(this, cleanProjectId);
      const match = pickContentHashMatch(assets.filter((asset) => asset.source?.content_sha256 === hash));
      if (!match) return null;
      return withRuntimeUrls(deriveChildAssetIds(assets).find((asset) => asset.id === match.id));
    },
    async findAssetByPixelHash(projectId, pixelHash) {
      const hash = String(pixelHash || "");
      if (!hash) return null;
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const assets = await readProjectAssets(this, cleanProjectId);
      const match = pickContentHashMatch(assets.filter((asset) => asset.source?.pixel_sha256 === hash));
      if (!match) return null;
      return withRuntimeUrls(deriveChildAssetIds(assets).find((asset) => asset.id === match.id));
    },
    async findAutomaticIngestSuppression(projectId = DEFAULT_PROJECT_ID, hashes = {}) {
      const cleanProjectId = await this.ensureProject(projectId);
      const normalized = normalizeSuppressionHashes(hashes);
      if (!normalized.content_sha256 && !normalized.pixel_sha256) return null;
      const records = await readAutomaticIngestSuppressions(this, cleanProjectId);
      return records.find((record) => suppressionMatches(record, normalized)) || null;
    },
    async listAutomaticIngestSuppressions(projectId = DEFAULT_PROJECT_ID) {
      const cleanProjectId = await this.ensureProject(projectId);
      return readAutomaticIngestSuppressions(this, cleanProjectId);
    },
    async listAutomaticIngestSuppressionPage(projectId = DEFAULT_PROJECT_ID, options = {}) {
      const cleanProjectId = await this.ensureProject(projectId);
      const records = await readAutomaticIngestSuppressions(this, cleanProjectId);
      const limit = normalizeSuppressionPageLimit(options.limit);
      const cursor = parseSuppressionCursor(options.cursor);
      const sorted = records.sort(compareSuppressions);
      const cursorIndex = cursor
        ? sorted.findIndex((record) => compareSuppressions(record, suppressionCursorRow(cursor)) > 0)
        : -1;
      const start = cursor ? (cursorIndex < 0 ? sorted.length : cursorIndex) : 0;
      const pageRecords = sorted.slice(start, start + limit);
      const last = pageRecords.at(-1);
      return {
        suppressions: pageRecords,
        page: {
          limit,
          nextCursor: start + limit < sorted.length && last ? encodeSuppressionCursor(last) : null,
        },
      };
    },
    async clearAutomaticIngestSuppression(projectId = DEFAULT_PROJECT_ID, hashes = {}) {
      const cleanProjectId = await this.ensureProject(projectId);
      const normalized = normalizeSuppressionHashes(hashes);
      if (!normalized.content_sha256 && !normalized.pixel_sha256) return 0;
      return withSuppressionWriteLock(this, cleanProjectId, async () => {
        const records = await readAutomaticIngestSuppressions(this, cleanProjectId);
        const remaining = records.filter((record) => !suppressionMatches(record, normalized));
        if (remaining.length !== records.length) await writeAutomaticIngestSuppressions(this, cleanProjectId, remaining);
        return records.length - remaining.length;
      });
    },
    async recordAutomaticIngestSuppression(projectId = DEFAULT_PROJECT_ID, record = {}) {
      const cleanProjectId = await this.ensureProject(projectId);
      const normalized = normalizeSuppressionRecord({ ...record, project_id: cleanProjectId });
      if (!normalized.content_sha256 && !normalized.pixel_sha256) return null;
      return withSuppressionWriteLock(this, cleanProjectId, async () => {
        const records = await readAutomaticIngestSuppressions(this, cleanProjectId);
        const existing = records.find((item) => item.content_sha256 === normalized.content_sha256
          && item.pixel_sha256 === normalized.pixel_sha256);
        const next = existing
          ? records.map((item) => item === existing ? normalized : item)
          : [...records, normalized];
        await writeAutomaticIngestSuppressions(this, cleanProjectId, next);
        return normalized;
      });
    },
    async getAsset(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const asset = await readAssetMetadata(this, cleanProjectId, cleanAssetId);
      const projectAssets = await readProjectAssets(this, cleanProjectId);
      const assets = deriveChildAssetIds([
        ...projectAssets.filter((item) => item.id !== cleanAssetId),
        asset,
      ]);
      return withRuntimeUrls(assets.find((item) => item.id === cleanAssetId));
    },
    async createAsset(input = {}, context = {}) {
      const projectId = await this.ensureProject(input.projectId || DEFAULT_PROJECT_ID);
      const { sourcePath, readablePath } = await resolveReadableImagePath(this, input.imagePath, context?.trustedSourceRoots);
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

      const codexSource = await codexSourceMetadata(this, readablePath);
      const originalName = sanitizeFileName(input.asset || input.fileName || basename(sourcePath));
      const assetId = sanitizeId(input.assetId || `${slugName(originalName)}-${shortStamp()}`, "asset");
      const parentAssetId = normalizeParentAssetId(input.parent_asset_id ?? input.parentAssetId);
      const lockPath = join(this.metadataDir(projectId), `.${assetId}.create.lock`);
      const assetLock = await acquireGroupLock(lockPath);
      try {
        try {
          await lstat(join(this.metadataDir(projectId), `${assetId}.json`));
          throw assetAlreadyExistsError(assetId);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        const projectAssets = await readProjectAssets(this, projectId);
        if (projectAssets.some((asset) => asset.id === assetId)) throw assetAlreadyExistsError(assetId);
        await assertJsonVersionParent(this, projectId, assetId, parentAssetId, projectAssets);
        const versionChange = parentAssetId && !context?.allowMissingVersionChange
          ? requireVersionChange(input)
          : String(input.version_change ?? input.changeSummary ?? "").trim();
        const imageName = await uniqueFileName(this.imagesDir(projectId), `${assetId}${extname(sourcePath) || extname(originalName) || ".png"}`);
        const imagePath = join(this.imagesDir(projectId), imageName);
        const storageMode = codexSource ? await hardLinkOrCopy(readablePath, imagePath) : (await copyFile(readablePath, imagePath), "copy");
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

        const prompt = String(input.prompt || "").trim();
        const promptPath = join(this.promptsDir(projectId), `${assetId}.md`);
        try {
          await atomicWriteFile(promptPath, promptFileContent({ ...input, id: assetId }, prompt));
        } catch (error) {
          await unlinkIfPresent(imagePath);
          throw error;
        }

        const timestamp = new Date().toISOString();
        const metadata = appendRecipeSnapshot({}, normalizeAssetMetadata({
          ...input,
          id: assetId,
          project_id: projectId,
          asset: imageName,
          image_path: imagePath,
          prompt_path: promptPath,
          prompt,
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
          }
        }), {
          createdAt: input.created_at || timestamp,
          changeSummary: versionChange || "Initial recipe",
        });

        try {
          if (metadata.group) await ensureGroup(this, projectId, metadata.group);
        } catch (error) {
          await Promise.all([unlinkIfPresent(imagePath), unlinkIfPresent(promptPath)]);
          throw error;
        }

        if (context?.ingestMode === "automatic") {
          // JSON has no database transaction. Share the suppression write lock
          // with deleteAsset and recheck immediately before metadata becomes
          // visible, so a concurrent deletion cannot be bypassed.
          try {
            await withSuppressionWriteLock(this, projectId, async () => {
              const suppressions = await readAutomaticIngestSuppressions(this, projectId);
              if (suppressions.some((record) => suppressionMatches(record, {
                content_sha256: contentHash,
                pixel_sha256: pixelHash,
                pixel_hash_version: pixelHashVersion,
              }))) throw automaticImportSuppressedError();
              const currentAssets = await readProjectAssets(this, projectId);
              const duplicate = currentAssets.find((asset) =>
                asset.source?.content_sha256 === contentHash
                || (pixelHash
                  && asset.source?.pixel_sha256 === pixelHash
                  && (!pixelHashVersion || asset.source?.pixel_hash_version === pixelHashVersion)));
              if (duplicate) {
                throw automaticIngestDuplicateError(
                  duplicate.id,
                  duplicate.source?.content_sha256 === contentHash ? "content" : "pixel",
                );
              }
              await writeMetadata(this, metadata);
            });
          } catch (error) {
            await Promise.all([unlinkIfPresent(imagePath), unlinkIfPresent(promptPath)]);
            throw error;
          }
        } else {
          // Keep a manual re-import's metadata and suppression removal under the
          // same lock. If the suppression file cannot be updated, remove the
          // just-written metadata and managed copies instead of reporting a
          // failed import that nevertheless remains in the library.
          const metadataPath = join(this.metadataDir(projectId), `${assetId}.json`);
          try {
            await withSuppressionWriteLock(this, projectId, async () => {
              const records = await readAutomaticIngestSuppressions(this, projectId);
              const remaining = records.filter((record) => !suppressionMatches(record, {
                content_sha256: contentHash,
                pixel_sha256: pixelHash,
                pixel_hash_version: pixelHashVersion,
              }));
              let metadataWritten = false;
              try {
                await writeMetadata(this, metadata);
                metadataWritten = true;
                if (remaining.length !== records.length) {
                  await writeAutomaticIngestSuppressions(this, projectId, remaining);
                }
              } catch (error) {
                if (metadataWritten) await unlinkIfPresent(metadataPath);
                throw error;
              }
            });
          } catch (error) {
            await Promise.all([unlinkIfPresent(imagePath), unlinkIfPresent(promptPath)]);
            throw error;
          }
        }
        return withRuntimeUrls(metadata);
      } finally {
        await assetLock.handle.close().catch(() => {});
        await releaseGroupLock(lockPath, assetLock.token);
      }
    },
    async migrateCodexAssetsToHardLinks(projectId = DEFAULT_PROJECT_ID) {
      return relinkCodexAssets(this, await this.ensureProject(projectId));
    },
    async updateMetadata(projectId, assetId, patch = {}) {
      assertMutableVersionPatch(patch);
      const current = await this.getAsset(projectId, assetId);
      const prompt = Object.hasOwn(patch, "prompt") ? String(patch.prompt || "").trim() : current.prompt;
      const next = appendRecipeSnapshot(current, normalizeAssetMetadata({
        ...current,
        ...patch,
        id: current.id,
        project_id: current.project_id,
        asset: current.asset,
        image_path: current.image_path,
        prompt_path: current.prompt_path,
        prompt,
        business_fields: parseBusinessFields(patch.business_fields ?? current.business_fields),
        source: patch.source && typeof patch.source === "object"
          ? { ...current.source, ...patch.source }
          : current.source,
        updated_at: new Date().toISOString()
      }), {
        changeSummary: patch.recipe_change_summary || "Recipe updated",
      });
      await atomicWriteFile(next.prompt_path, promptFileContent(next, prompt));
      await writeMetadata(this, next);
      if (next.group) await ensureGroup(this, next.project_id, next.group);
      return withRuntimeUrls(next);
    },
    async toggleFavorite(projectId, assetId) {
      const cleanProjectId = await this.ensureProject(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const lockPath = join(this.metadataDir(cleanProjectId), `.${cleanAssetId}.favorite.lock`);
      const lock = await acquireGroupLock(lockPath);
      try {
        // Re-read only after owning the per-asset lock. Concurrent favorite
        // requests therefore observe each other's committed value instead of
        // both flipping the same stale snapshot. This legacy JSON path mirrors
        // SQLite's atomic toggle semantics as closely as the file store allows.
        const current = await readAssetMetadata(this, cleanProjectId, cleanAssetId);
        const next = normalizeAssetMetadata({
          ...current,
          favorite: !current.favorite,
          // Favorite is UI state, not a recipe revision. Preserve updated_at so
          // the gallery poller does not rebuild every card after a star click.
          updated_at: current.updated_at,
        });
        await writeMetadata(this, next);
        return withRuntimeUrls(next);
      } finally {
        await lock.handle.close().catch(() => {});
        await releaseGroupLock(lockPath, lock.token);
      }
    },
    async archiveAsset(projectId, assetId) {
      return this.updateMetadata(projectId, assetId, { archived: true });
    },
    async deleteAsset(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const asset = await readAssetMetadata(this, cleanProjectId, cleanAssetId);
      const siblings = await readProjectAssets(this, cleanProjectId);
      const child = siblings.find((candidate) => candidate.parent_asset_id === cleanAssetId);
      if (child) {
        throw assetStoreError(
          "VERSION_PARENT_HAS_CHILDREN",
          `Cannot delete version parent ${cleanAssetId}; it has child versions (e.g. ${child.id}). Delete or detach them first.`,
        );
      }
      const metadataPath = join(this.metadataDir(cleanProjectId), `${cleanAssetId}.json`);
      const projectDir = this.projectDir(cleanProjectId);
      const managedPaths = [asset.image_path, asset.prompt_path]
        .filter((filePath) => filePath && isSafeChildPath(projectDir, resolve(filePath)))
        .map((filePath) => resolve(filePath));
      const contentHash = await contentHashForAsset(asset, managedPaths);
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
      await withSuppressionWriteLock(this, cleanProjectId, async () => {
        const previous = contentHash || pixelHash
          ? await readAutomaticIngestSuppressions(this, cleanProjectId)
          : null;
        if (previous) {
          const normalized = normalizeSuppressionRecord({
            project_id: cleanProjectId,
            content_sha256: contentHash,
            pixel_sha256: pixelHash,
            pixel_hash_version: pixelHashVersion,
            deleted_at: new Date().toISOString(),
            reason: "user-deleted",
          });
          const existing = previous.find((item) => item.content_sha256 === normalized.content_sha256
            && item.pixel_sha256 === normalized.pixel_sha256);
          const next = existing
            ? previous.map((item) => item === existing ? normalized : item)
            : [...previous, normalized];
          await writeAutomaticIngestSuppressions(this, cleanProjectId, next);
        }
        try {
          await unlink(metadataPath);
        } catch (error) {
          if (previous) await writeAutomaticIngestSuppressions(this, cleanProjectId, previous);
          throw error;
        }
      });
      await withGenerationHistoryLock(this, cleanProjectId, async () => {
        const events = await readJsonArray(this.generationEventsFile(cleanProjectId));
        const removedEventIds = new Set(events
          .filter((event) => event?.output_asset_id === cleanAssetId)
          .map((event) => String(event?.id || ""))
          .filter(Boolean));
        if (removedEventIds.size) {
          const nextEvents = events.filter((event) => !removedEventIds.has(String(event?.id || "")));
          const relations = await readJsonArray(this.generationRelationsFile(cleanProjectId));
          const nextRelations = relations.filter((relation) => (
            !removedEventIds.has(String(relation?.child_generation_id || ""))
            && !removedEventIds.has(String(relation?.parent_generation_id || ""))
          ));
          const candidates = await readJsonArray(this.generationRelationCandidatesFile(cleanProjectId));
          const nextCandidates = candidates.filter((candidate) => (
            !removedEventIds.has(String(candidate?.child_generation_id || ""))
            && !removedEventIds.has(String(candidate?.parent_generation_id || ""))
          ));
          await Promise.all([
            atomicWriteFile(this.generationEventsFile(cleanProjectId), `${JSON.stringify(nextEvents, null, 2)}\n`),
            atomicWriteFile(this.generationRelationsFile(cleanProjectId), `${JSON.stringify(nextRelations, null, 2)}\n`),
            atomicWriteFile(this.generationRelationCandidatesFile(cleanProjectId), `${JSON.stringify(nextCandidates, null, 2)}\n`),
          ]);
        }
      });
      await Promise.all(managedPaths.map((filePath) => unlinkIfPresent(filePath)));
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
      const selectedAsset = await readAssetMetadata(this, cleanProjectId, cleanAssetId);
      const projectAssets = await readProjectAssets(this, cleanProjectId);
      const assets = deriveChildAssetIds([
        ...projectAssets.filter((item) => item.id !== cleanAssetId),
        selectedAsset,
      ]).map(withRuntimeUrls);
      const foreignProjectsByAssetId = await findForeignVersionParents(this, cleanProjectId, assets);
      return buildAssetVersionHistory({
        projectId: cleanProjectId,
        selectedAssetId: cleanAssetId,
        assets,
        foreignProjectsByAssetId,
      });
    },
    async getRecipeSnapshotHistory(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      return recipeHistory(await readAssetMetadata(this, cleanProjectId, cleanAssetId));
    },
    async recordGenerationEvent(input = {}) {
      const event = normalizeGenerationEvent(input);
      await readAssetMetadata(this, event.project_id, event.output_asset_id);
      return withGenerationHistoryLock(this, event.project_id, async () => {
        const events = await readJsonArray(this.generationEventsFile(event.project_id));
        const index = events.findIndex((item) => item?.id === event.id);
        const storedEvent = index >= 0 ? preserveTrustedGenerationEvent(events[index], event) : event;
        const next = index >= 0
          ? events.map((item, itemIndex) => itemIndex === index ? storedEvent : item)
          : [...events, storedEvent];
        await atomicWriteFile(this.generationEventsFile(event.project_id), `${JSON.stringify(next, null, 2)}\n`);
        const relations = await readJsonArray(this.generationRelationsFile(event.project_id));
        const candidates = await readJsonArray(this.generationRelationCandidatesFile(event.project_id));
        const nextCandidates = resolveGenerationRelationCandidates({
          projectId: event.project_id,
          events: next,
          relations,
          candidates,
        });
        await atomicWriteFile(this.generationRelationCandidatesFile(event.project_id), `${JSON.stringify(nextCandidates, null, 2)}\n`);
        return storedEvent;
      });
    },
    async listGenerationEvents(projectId, filters = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const events = (await readJsonArray(this.generationEventsFile(cleanProjectId)))
        .filter((event) => !filters.assetId || event.output_asset_id === filters.assetId)
        .filter((event) => !filters.captureContextId || event.capture_context_id === filters.captureContextId)
        .filter((event) => !filters.providerToolCallId || event.provider_tool_call_id === filters.providerToolCallId)
        .filter((event) => !filters.providerGenerationCallId || event.provider_generation_call_id === filters.providerGenerationCallId)
        .sort((left, right) => String(left.created_at || "").localeCompare(String(right.created_at || "")) || String(left.id || "").localeCompare(String(right.id || "")));
      const rawLimit = Number(filters.limit);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 251) : 0;
      const rawOffset = Number(filters.offset);
      const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
      return limit ? events.slice(offset, offset + limit) : events;
    },
    async recordGenerationRelation(input = {}) {
      const relation = normalizeGenerationRelation(input);
      return withGenerationHistoryLock(this, relation.project_id, async () => {
        const events = await readJsonArray(this.generationEventsFile(relation.project_id));
        const ids = new Set(events.map((event) => event?.id));
        if (!ids.has(relation.child_generation_id) || !ids.has(relation.parent_generation_id)) {
          throw generationHistoryError("Generation relation references a missing event.", "GENERATION_RELATION_EVENT_NOT_FOUND", 409);
        }
        const relations = await readJsonArray(this.generationRelationsFile(relation.project_id));
        assertGenerationRelationAcyclic(relation, relations);
        const key = generationRelationKey(relation);
        const index = relations.findIndex((item) => generationRelationKey(item) === key);
        const storedRelation = index >= 0 ? preserveTrustedGenerationRelation(relations[index], relation) : relation;
        const next = index >= 0
          ? relations.map((item, itemIndex) => itemIndex === index ? storedRelation : item)
          : [...relations, storedRelation];
        await atomicWriteFile(this.generationRelationsFile(relation.project_id), `${JSON.stringify(next, null, 2)}\n`);
        const candidates = await readJsonArray(this.generationRelationCandidatesFile(relation.project_id));
        const pairKey = generationCandidatePairKey(relation);
        const nextCandidates = candidates.map((candidate) => (
          generationCandidatePairKey(candidate) === pairKey
            ? normalizeGenerationRelationCandidate({ ...candidate, status: "confirmed", updated_at: new Date().toISOString() })
            : candidate
        ));
        await atomicWriteFile(this.generationRelationCandidatesFile(relation.project_id), `${JSON.stringify(nextCandidates, null, 2)}\n`);
        return storedRelation;
      });
    },
    async updateGenerationRelationCandidate(input = {}) {
      const projectId = sanitizeProjectId(input.project_id || input.projectId || DEFAULT_PROJECT_ID);
      const childGenerationId = String(input.child_generation_id || input.childGenerationId || "").trim();
      const parentGenerationId = String(input.parent_generation_id || input.parentGenerationId || "").trim();
      if (!childGenerationId || !parentGenerationId) {
        throw generationHistoryError("Generation relation candidate requires child and parent generation IDs.", "GENERATION_RELATION_CANDIDATE_IDS_REQUIRED");
      }
      return withGenerationHistoryLock(this, projectId, async () => {
        const candidates = await readJsonArray(this.generationRelationCandidatesFile(projectId));
        const pairKey = generationCandidatePairKey({ child_generation_id: childGenerationId, parent_generation_id: parentGenerationId });
        const index = candidates.findIndex((item) => generationCandidatePairKey(item) === pairKey);
        if (index < 0) {
          throw generationHistoryError("Generation relation candidate was not found.", "GENERATION_RELATION_CANDIDATE_NOT_FOUND", 404);
        }
        const existing = normalizeGenerationRelationCandidate(candidates[index]);
        const updated = normalizeGenerationRelationCandidate({
          ...existing,
          status: input.status || existing.status,
          created_at: existing.created_at,
          updated_at: new Date().toISOString(),
        });
        const next = candidates.map((item, itemIndex) => itemIndex === index ? updated : item);
        await atomicWriteFile(this.generationRelationCandidatesFile(projectId), `${JSON.stringify(next, null, 2)}\n`);
        return updated;
      });
    },
    async deleteGenerationRelation(input = {}) {
      const relation = normalizeGenerationRelation(input);
      return withGenerationHistoryLock(this, relation.project_id, async () => {
        const relations = await readJsonArray(this.generationRelationsFile(relation.project_id));
        const key = generationRelationKey(relation);
        const index = relations.findIndex((item) => generationRelationKey(item) === key);
        const existing = index >= 0 ? relations[index] : null;
        assertGenerationRelationUserMutable(existing);
        const next = relations.filter((_, itemIndex) => itemIndex !== index);
        await atomicWriteFile(this.generationRelationsFile(relation.project_id), `${JSON.stringify(next, null, 2)}\n`);
        const candidates = await readJsonArray(this.generationRelationCandidatesFile(relation.project_id));
        const pairKey = generationCandidatePairKey(relation);
        const nextCandidates = candidates.map((candidate) => (
          generationCandidatePairKey(candidate) === pairKey
            ? normalizeGenerationRelationCandidate({ ...candidate, status: "dismissed", updated_at: new Date().toISOString() })
            : candidate
        ));
        await atomicWriteFile(this.generationRelationCandidatesFile(relation.project_id), `${JSON.stringify(nextCandidates, null, 2)}\n`);
        return existing;
      });
    },
    async updateGenerationRelation(input = {}) {
      const relation = normalizeGenerationRelation(input);
      const previousRelationType = String(input.previous_relation_type || input.previousRelationType || relation.relation_type).trim();
      return withGenerationHistoryLock(this, relation.project_id, async () => {
        const events = await readJsonArray(this.generationEventsFile(relation.project_id));
        const ids = new Set(events.map((event) => event?.id));
        if (!ids.has(relation.child_generation_id) || !ids.has(relation.parent_generation_id)) {
          throw generationHistoryError("Generation relation references a missing event.", "GENERATION_RELATION_EVENT_NOT_FOUND", 409);
        }
        const relations = await readJsonArray(this.generationRelationsFile(relation.project_id));
        const existingIndex = relations.findIndex((item) => (
          item?.child_generation_id === relation.child_generation_id
          && item?.parent_generation_id === relation.parent_generation_id
          && item?.relation_type === previousRelationType
        ));
        const existing = existingIndex >= 0 ? relations[existingIndex] : null;
        assertGenerationRelationUserMutable(existing);
        const withoutExisting = relations.filter((_, itemIndex) => itemIndex !== existingIndex);
        assertGenerationRelationAcyclic(relation, withoutExisting);
        const targetIndex = withoutExisting.findIndex((item) => generationRelationKey(item) === generationRelationKey(relation));
        if (targetIndex >= 0) assertGenerationRelationUserMutable(withoutExisting[targetIndex]);
        const next = targetIndex >= 0
          ? withoutExisting.map((item, itemIndex) => itemIndex === targetIndex ? relation : item)
          : [...withoutExisting, relation];
        await atomicWriteFile(this.generationRelationsFile(relation.project_id), `${JSON.stringify(next, null, 2)}\n`);
        return relation;
      });
    },
    async getGenerationLineage(projectId, generationId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      return buildGenerationLineage({
        projectId: cleanProjectId,
        selectedGenerationId: String(generationId || ""),
        events: await readJsonArray(this.generationEventsFile(cleanProjectId)),
        relations: await readJsonArray(this.generationRelationsFile(cleanProjectId)),
      });
    },
    async getAssetGenerationHistory(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      await readAssetMetadata(this, cleanProjectId, cleanAssetId);
      if (!existsSync(this.generationRelationCandidatesFile(cleanProjectId))) {
        await withGenerationHistoryLock(this, cleanProjectId, async () => {
          const events = await readJsonArray(this.generationEventsFile(cleanProjectId));
          const relations = await readJsonArray(this.generationRelationsFile(cleanProjectId));
          const candidates = resolveGenerationRelationCandidates({ projectId: cleanProjectId, events, relations, candidates: [] });
          await atomicWriteFile(this.generationRelationCandidatesFile(cleanProjectId), `${JSON.stringify(candidates, null, 2)}\n`);
        });
      }
      const history = buildAssetGenerationHistory({
        projectId: cleanProjectId,
        assetId: cleanAssetId,
        events: await readJsonArray(this.generationEventsFile(cleanProjectId)),
        relations: await readJsonArray(this.generationRelationsFile(cleanProjectId)),
        candidates: await readJsonArray(this.generationRelationCandidatesFile(cleanProjectId)),
      });
      const outputIds = new Set([...history.events, ...(history.context_events || [])].map((event) => event.output_asset_id).filter(Boolean));
      const outputAssets = (await readProjectAssets(this, cleanProjectId))
        .filter((asset) => outputIds.has(asset.id))
        .map(withRuntimeUrls);
      return { ...history, output_assets: outputAssets };
    },
    async assetFileInfo(projectId, fileName) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const safeName = sanitizeFileName(fileName);
      const fullPath = await resolveStoredAssetPath(this, cleanProjectId, safeName);
      const fileStat = await stat(fullPath);
      return { size: fileStat.size };
    },
    async assetReadStream(projectId, fileName, options = {}) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const safeName = sanitizeFileName(fileName);
      const fullPath = await resolveStoredAssetPath(this, cleanProjectId, safeName);
      const streamOptions = Number.isSafeInteger(options.start) && Number.isSafeInteger(options.end)
        ? { start: options.start, end: options.end }
        : undefined;
      return createReadStream(fullPath, streamOptions);
    }
  };
}

export function mimeTypeForFile(filePath) {
  switch (extname(filePath).toLowerCase()) {
    case ".apng":
      return "image/apng";
    case ".avif":
      return "image/avif";
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    case ".mp4":
      return "video/mp4";
    case ".m4v":
      return "video/x-m4v";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    default:
      return "application/octet-stream";
  }
}

export function isVideoMediaPath(filePath) {
  return VIDEO_EXTENSIONS.has(extname(String(filePath || "")).toLowerCase());
}

export function isImageMediaPath(filePath) {
  return IMAGE_EXTENSIONS.has(extname(String(filePath || "")).toLowerCase());
}

function normalizeAssetMetadata(input) {
  const businessFields = parseBusinessFields(input.business_fields);
  return {
    id: sanitizeId(input.id, "asset"),
    project_id: sanitizeProjectId(input.project_id || input.projectId || DEFAULT_PROJECT_ID),
    asset: sanitizeFileName(input.asset),
    image_path: resolve(input.image_path),
    prompt_path: resolve(input.prompt_path),
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
    created_at: normalizeCreatedAt(input.created_at, new Date().toISOString()),
    updated_at: input.updated_at || new Date().toISOString(),
    source: input.source && typeof input.source === "object" ? input.source : {}
  };
}

function withRuntimeUrls(asset) {
  const normalized = ensureRecipeSnapshots(asset);
  return {
    ...normalized,
    image_url: `/library/${encodeURIComponent(normalized.project_id)}/images/${encodeURIComponent(normalized.asset)}`,
    prompt_file: normalized.prompt_path
  };
}

/**
 * Duplicating an asset copies its bytes, so one content hash can legitimately match several
 * records. Both stores resolve that the same way: prefer an active asset over an archived one,
 * then the newest, using the comparator `listAssets` already sorts by.
 */
function pickContentHashMatch(matches) {
  return [...matches].sort((left, right) => Number(Boolean(left.archived)) - Number(Boolean(right.archived))
    || String(right.created_at || "").localeCompare(String(left.created_at || ""))
    || String(right.id || "").localeCompare(String(left.id || "")))[0] || null;
}

async function readGroupNames(store, projectId) {
  try {
    const raw = await readFile(store.groupsFile(projectId), "utf8");
    const groups = JSON.parse(raw);
    return Array.isArray(groups) ? uniqueArray(groups.map(normalizeGroupName).filter(Boolean)) : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function ensureGroup(store, projectId, name) {
  const normalized = normalizeGroupName(name);
  if (!normalized) return;
  await withGroupWriteLock(store, projectId, async () => {
    const names = await readGroupNames(store, projectId);
    if (names.some((item) => item.toLocaleLowerCase() === normalized.toLocaleLowerCase())) return;
    names.push(normalized);
    await writeGroupNames(store, projectId, names);
  });
}

function normalizeGroupName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

/**
 * Mirrors the SQLite store: a cursor is only valid for the order that issued it,
 * so switching sorts restarts the query rather than resuming against the wrong key.
 */
function parseAssetCursor(value, sort, searchQuery = "") {
  try {
    const cursor = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (typeof cursor?.createdAt !== "string" || typeof cursor?.id !== "string") throw new Error();
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

/** Shapes a decoded cursor back into the minimal asset the secondary comparator needs. */
function cursorRow(cursor) {
  return { created_at: cursor.createdAt, id: cursor.id, theme: "", asset: cursor.sortName || "" };
}

async function unlinkIfPresent(filePath) {
  await unlink(filePath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function writeMetadata(store, metadata) {
  await store.ensureProject(metadata.project_id);
  await atomicWriteFile(join(store.metadataDir(metadata.project_id), `${metadata.id}.json`), `${JSON.stringify(metadata, null, 2)}\n`);
}

async function atomicWriteFile(targetPath, content) {
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, "utf8");
    const handle = await open(temporaryPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, targetPath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
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

function normalizeHash(value) {
  const hash = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : "";
}

function normalizeSuppressionHashes(input = {}) {
  return {
    content_sha256: normalizeHash(input.content_sha256 ?? input.contentSha256),
    pixel_sha256: normalizeHash(input.pixel_sha256 ?? input.pixelSha256),
    pixel_hash_version: String(input.pixel_hash_version ?? input.pixelHashVersion ?? "").trim(),
  };
}

function normalizeSuppressionRecord(input = {}) {
  const hashes = normalizeSuppressionHashes(input);
  return {
    project_id: sanitizeProjectId(input.project_id || DEFAULT_PROJECT_ID),
    ...hashes,
    deleted_at: String(input.deleted_at || new Date().toISOString()),
    reason: String(input.reason || "user-deleted").trim().slice(0, 120) || "user-deleted",
  };
}

function normalizeSuppressionPageLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.min(Math.floor(parsed), 250);
}

function compareSuppressions(left, right) {
  return String(right.deleted_at || "").localeCompare(String(left.deleted_at || ""))
    || String(left.content_sha256 || "").localeCompare(String(right.content_sha256 || ""))
    || String(left.pixel_sha256 || "").localeCompare(String(right.pixel_sha256 || ""));
}

function encodeSuppressionCursor(record) {
  return Buffer.from(JSON.stringify({
    deletedAt: record.deleted_at,
    contentHash: record.content_sha256,
    pixelHash: record.pixel_sha256,
  })).toString("base64url");
}

function parseSuppressionCursor(value) {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (typeof cursor?.deletedAt !== "string" || typeof cursor?.contentHash !== "string" || typeof cursor?.pixelHash !== "string") throw new Error();
    return cursor;
  } catch {
    throw assetStoreError("INVALID_SUPPRESSION_CURSOR", "Invalid suppression cursor.");
  }
}

function suppressionCursorRow(cursor) {
  return {
    deleted_at: cursor.deletedAt,
    content_sha256: cursor.contentHash,
    pixel_sha256: cursor.pixelHash,
  };
}

function suppressionMatches(record, hashes) {
  return Boolean(
    (hashes.content_sha256 && record.content_sha256 === hashes.content_sha256)
      || (hashes.pixel_sha256
        && record.pixel_sha256 === hashes.pixel_sha256
        && (!hashes.pixel_hash_version || record.pixel_hash_version === hashes.pixel_hash_version)),
  );
}

async function readAutomaticIngestSuppressions(store, projectId) {
  try {
    const parsed = JSON.parse(await readFile(store.automaticIngestSuppressionsFile(projectId), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((record) => normalizeSuppressionRecord({ ...record, project_id: projectId }))
      .filter((record) => record.content_sha256 || record.pixel_sha256);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function writeAutomaticIngestSuppressions(store, projectId, records) {
  await store.ensureProject(projectId);
  await atomicWriteFile(store.automaticIngestSuppressionsFile(projectId), `${JSON.stringify(records, null, 2)}\n`);
}

async function withSuppressionWriteLock(store, projectId, callback) {
  const lockPath = join(store.projectDir(projectId), ".automatic-ingest-suppressions.lock");
  const lock = await acquireGroupLock(lockPath);
  try {
    return await callback();
  } finally {
    await lock.handle.close().catch(() => {});
    await releaseGroupLock(lockPath, lock.token);
  }
}

async function contentHashForAsset(asset, managedPaths) {
  const recorded = normalizeHash(asset.source?.content_sha256);
  if (recorded) return recorded;
  const imagePath = resolve(String(asset.image_path || ""));
  if (!managedPaths.includes(imagePath)) return "";
  try {
    return await sha256File(imagePath);
  } catch {
    return "";
  }
}

async function writeGroupNames(store, projectId, names) {
  await atomicWriteFile(store.groupsFile(projectId), `${JSON.stringify(names, null, 2)}\n`);
}

async function withGroupWriteLock(store, projectId, callback) {
  const lockPath = join(store.projectDir(projectId), ".groups.lock");
  const lock = await acquireGroupLock(lockPath);
  try {
    return await callback();
  } finally {
    await lock.handle.close().catch(() => {});
    await releaseGroupLock(lockPath, lock.token);
  }
}

async function withGenerationHistoryLock(store, projectId, callback) {
  const lockPath = join(store.projectDir(projectId), ".generation-history.lock");
  const lock = await acquireGroupLock(lockPath);
  try {
    return await callback();
  } finally {
    await lock.handle.close().catch(() => {});
    await releaseGroupLock(lockPath, lock.token);
  }
}

async function readJsonArray(filePath) {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function generationRelationKey(value = {}) {
  return [value.project_id, value.child_generation_id, value.parent_generation_id, value.relation_type].map(String).join("\u0000");
}

async function acquireGroupLock(lockPath) {
  const deadline = Date.now() + GROUP_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const handle = await open(lockPath, "wx");
      const token = randomUUID();
      try {
        await handle.writeFile(JSON.stringify({ token, pid: process.pid }));
        return { handle, token };
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await removeStaleGroupLock(lockPath);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
  }
  throw new Error("Timed out waiting to update groups.");
}

async function removeStaleGroupLock(lockPath) {
  const cleanupPath = `${lockPath}.cleanup`;
  if (!(await acquireGroupCleanupLock(cleanupPath))) return;
  try {
    const lock = await readGroupLock(lockPath);
    if (!lock || lock.ageMs <= GROUP_LOCK_STALE_MS || isGroupLockOwnerAlive(lock.owner)) return;
    await releaseGroupLock(lockPath, lock.owner?.token);
  } finally {
    await rmdir(cleanupPath).catch(() => {});
  }
}

async function acquireGroupCleanupLock(cleanupPath) {
  try {
    await mkdir(cleanupPath);
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      const cleanupStat = await stat(cleanupPath);
      if (Date.now() - cleanupStat.mtimeMs > GROUP_CLEANUP_LOCK_STALE_MS) await rmdir(cleanupPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    }
    return false;
  }
}

async function releaseGroupLock(lockPath, token) {
  const lock = await readGroupLock(lockPath);
  if (!lock || lock.owner?.token !== token) return false;
  await unlink(lockPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  return true;
}

async function readGroupLock(lockPath) {
  try {
    const [raw, lockStat] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
    let owner = null;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.token === "string" && Number.isInteger(parsed?.pid)) owner = parsed;
    } catch {
      // Locks written by interrupted or older processes are recovered after the stale timeout.
    }
    return { owner, ageMs: Date.now() - lockStat.mtimeMs };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function isGroupLockOwnerAlive(owner) {
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readProjectAssets(store, projectId) {
  const directory = store.metadataDir(projectId);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const assets = [];
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".json") continue;
    const filePath = join(directory, entry.name);
    let raw = null;
    try {
      raw = await readFile(filePath, "utf8");
      assets.push(withCanonicalCreatedAt(JSON.parse(raw)));
    } catch (error) {
      await warnCorruptMetadata(store, projectId, filePath, error, raw);
    }
  }
  return assets;
}

/**
 * Presents `created_at` in its canonical ISO form on the way out, without touching the file.
 * Writes have been normalised since this store learned to do so, but records last written by an
 * older build keep whatever text they were saved with, and sorting plus cursor pagination still
 * compare those strings — so a legacy "Sat, 01 Jan 2000 00:00:00 GMT" would sort as if it were
 * newer than every ISO date. Canonicalising on read fixes their placement immediately; the file
 * itself is only rewritten when the asset is next edited, and unparseable text is left alone.
 */
function withCanonicalCreatedAt(asset) {
  const createdAt = normalizeCreatedAt(asset?.created_at, asset?.created_at);
  return createdAt === asset?.created_at ? asset : { ...asset, created_at: createdAt };
}

/**
 * Reports an unreadable metadata file at most once per store instance per file *revision*, because
 * the gallery re-scans the library on every refresh and a permanently corrupt file would otherwise
 * warn on every scan. The key is the hash of the bytes that failed to parse, so a file that is
 * repaired and later damaged again is still reported — even when the new damage happens to have
 * the same size and modification time as the old.
 *
 * The payload deliberately never forwards `error.message`: JSON parser messages quote the head
 * of the offending document (V8 renders `Unexpected token 'h', "hunter2 se"... is not valid
 * JSON`), which would leak prompts, tokens, or other private fields into logs.
 */
async function warnCorruptMetadata(store, projectId, filePath, error, raw) {
  if (!store.onWarning) return;
  let warnedRevisions = warnedMetadataPaths.get(store);
  if (!warnedRevisions) {
    warnedRevisions = new Set();
    warnedMetadataPaths.set(store, warnedRevisions);
  }
  const revision = await corruptMetadataRevision(filePath, raw);
  if (warnedRevisions.has(revision)) return;
  warnedRevisions.add(revision);
  try {
    Promise.resolve(store.onWarning({
      code: "CORRUPT_METADATA",
      projectId,
      filePath,
      message: `Failed to parse metadata JSON (${error?.name || "Error"})`,
    })).catch(() => {});
  } catch {
    // Warning sinks are observational only. A broken logger must not make a tolerant gallery scan
    // fail; rejected async sinks are handled by the attached catch without delaying the scan.
  }
}

async function corruptMetadataRevision(filePath, raw) {
  if (typeof raw === "string") return `${filePath}:sha256:${createHash("sha256").update(raw).digest("hex")}`;
  try {
    // The read itself failed, so there are no bytes to hash: fall back to the file's identity.
    const fileStat = await stat(filePath);
    return `${filePath}:${fileStat.size}:${fileStat.mtimeMs}`;
  } catch {
    // A file that vanished between the failed read and this stat can only be keyed by path.
    return filePath;
  }
}

async function readAssetMetadata(store, projectId, assetId) {
  try {
    return withCanonicalCreatedAt(JSON.parse(await readFile(join(store.metadataDir(projectId), `${assetId}.json`), "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") throw assetNotFoundError(assetId);
    throw error;
  }
}

function deriveChildAssetIds(assets) {
  const childrenByParent = new Map();
  for (const asset of assets) {
    if (!asset.parent_asset_id) continue;
    const children = childrenByParent.get(asset.parent_asset_id) || [];
    children.push(asset);
    childrenByParent.set(asset.parent_asset_id, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) => String(left.created_at || "").localeCompare(String(right.created_at || "")) || String(left.id || "").localeCompare(String(right.id || "")));
  }
  return assets.map((asset) => ({ ...asset, child_asset_ids: (childrenByParent.get(asset.id) || []).map((child) => child.id) }));
}

async function assertJsonVersionParent(store, projectId, assetId, parentAssetId, projectAssets) {
  if (!parentAssetId) return;
  if (parentAssetId === assetId) throw assetStoreError("VERSION_CYCLE", `Asset cannot be its own version parent: ${assetId}`);
  if (projectAssets.some((asset) => asset.id === parentAssetId)) return;
  const foreign = await findAssetProjects(store, projectId, new Set([parentAssetId]));
  throw versionParentError(parentAssetId, foreign.get(parentAssetId));
}

async function findForeignVersionParents(store, projectId, assets) {
  const localIds = new Set(assets.map((asset) => asset.id));
  const missingParentIds = new Set(assets.map((asset) => asset.parent_asset_id).filter((id) => id && !localIds.has(id)));
  return findAssetProjects(store, projectId, missingParentIds);
}

async function findAssetProjects(store, projectId, assetIds) {
  const matches = new Map();
  if (!assetIds.size) return matches;
  for (const otherProjectId of await store.listProjects()) {
    if (otherProjectId === projectId) continue;
    for (const asset of await readProjectAssets(store, otherProjectId)) {
      if (!assetIds.has(asset.id)) continue;
      const projects = matches.get(asset.id) || [];
      projects.push(otherProjectId);
      matches.set(asset.id, projects);
    }
  }
  return matches;
}

function normalizeParentAssetId(value) {
  return value ? sanitizeId(value, "asset") : null;
}

async function uniqueFileName(directory, preferredName) {
  const safe = sanitizeFileName(preferredName);
  const extension = extname(safe);
  const base = safe.slice(0, safe.length - extension.length);
  for (let i = 0; i < 1000; i += 1) {
    const candidate = i === 0 ? safe : `${base}-${i + 1}${extension}`;
    try {
      await stat(join(directory, candidate));
    } catch (error) {
      if (error.code === "ENOENT") return candidate;
      throw error;
    }
  }
  throw new Error(`Could not create unique filename for ${preferredName}`);
}

async function hardLinkOrCopy(sourcePath, targetPath) {
  try {
    await link(sourcePath, targetPath);
    return "hard-link";
  } catch (error) {
    // Hard links require the source and target to be on the same filesystem.
    // Keep the old copy behavior as a safe fallback for external volumes.
    if (!["EXDEV", "EPERM", "EOPNOTSUPP", "ENOTSUP", "EMLINK"].includes(error?.code)) throw error;
    await copyFile(sourcePath, targetPath);
    return "copy";
  }
}

function promptFileContent(input, prompt) {
  const header = [
    "---",
    promptHeaderField("asset_id", input.id),
    promptHeaderField("skill", input.skill),
    promptHeaderField("style", input.style),
    promptHeaderField("ratio", input.ratio),
    promptHeaderField("theme", input.theme),
    "---",
    ""
  ].join("\n");
  return `${header}${prompt || ""}\n`;
}

function promptHeaderField(key, value) {
  const text = String(value || "");
  return text ? `${key}: ${text}` : `${key}:`;
}

function parseBusinessFields(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sanitizeProjectId(value) {
  return sanitizeId(value || DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ID);
}

function sanitizeId(value, fallback) {
  return String(value || fallback)
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || fallback;
}

function sanitizeFileName(value) {
  const raw = basename(String(value || "asset.png"));
  const extension = extname(raw) || ".png";
  const base = raw
    .slice(0, raw.length - extname(raw).length)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "asset"}${extension}`;
}

function slugName(value) {
  return sanitizeId(String(value || "asset").replace(/\.[^.]+$/, ""), "asset").slice(0, 56);
}

function shortStamp() {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function uniqueArray(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map(String))];
}

function resolveRequiredPath(value, label) {
  if (!value || typeof value !== "string") throw assetStoreError("IMAGE_PATH_REQUIRED", `${label} is required.`);
  return resolve(value);
}

async function resolveReadableImagePath(store, value, trustedSourceRoots = []) {
  const requestedPath = resolveRequiredPath(value, "imagePath");
  if (!MEDIA_EXTENSIONS.has(extname(requestedPath).toLowerCase())) {
    throw assetStoreError("IMAGE_PATH_UNSUPPORTED_TYPE", `Unsupported media type: ${requestedPath}`);
  }

  // Messages are unchanged; only the machine-readable code is new, so the import
  // form can attribute each rejection to the path field.
  const requestedStat = await statForImport(requestedPath);
  if (requestedStat.isSymbolicLink()) throw assetStoreError("IMAGE_PATH_NOT_READABLE", `Refusing to import symbolic links: ${requestedPath}`);
  if (!requestedStat.isFile()) throw assetStoreError("IMAGE_PATH_NOT_READABLE", `imagePath is not a file: ${requestedPath}`);

  const readablePath = await realpath(requestedPath);
  await assertWithinReadableProject(store, readablePath, trustedSourceRoots);
  return { sourcePath: requestedPath, readablePath };
}

async function resolveStoredAssetPath(store, projectId, fileName) {
  const imagesDir = store.imagesDir(projectId);
  const requestedPath = join(imagesDir, fileName);
  if (!isSafeChildPath(imagesDir, requestedPath)) throw new Error("Unsafe asset path.");

  const requestedStat = await lstat(requestedPath);
  if (requestedStat.isSymbolicLink() || !requestedStat.isFile()) throw new Error("Unsafe asset path.");

  const [imagesRoot, assetPath] = await Promise.all([realpath(imagesDir), realpath(requestedPath)]);
  if (!isSafeChildPath(imagesRoot, assetPath)) throw new Error("Unsafe asset path.");
  return assetPath;
}

async function assertWithinReadableProject(store, filePath, trustedSourceRoots = []) {
  const allowedRoots = [
    store.projectRoot,
    store.generatedImagesDir,
    store.codexImagesDir,
    store.assetsRoot,
    store.cowartPageAssetsDir,
    ...(Array.isArray(trustedSourceRoots) ? trustedSourceRoots : []),
  ].filter((root) => typeof root === "string" && root);
  const resolvedRoots = (await Promise.all(allowedRoots.map(async (root) => {
    try {
      return await realpath(root);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }))).filter(Boolean);
  if (!resolvedRoots.some((root) => filePath === root || isSafeChildPath(root, filePath))) {
    throw assetStoreError("IMAGE_PATH_NOT_READABLE", `Refusing to import outside the project roots: ${filePath}`);
  }
}

/** A missing file is an ordinary form mistake, not a 500. */
async function statForImport(requestedPath) {
  try {
    return await lstat(requestedPath);
  } catch (error) {
    if (error?.code === "ENOENT") throw assetStoreError("IMAGE_PATH_NOT_FOUND", `imagePath does not exist: ${requestedPath}`);
    throw error;
  }
}

function isSafeChildPath(parent, child) {
  return isPathInside(parent, child);
}

async function codexSourceMetadata(store, filePath) {
  const configuredRoot = resolve(store.codexImagesDir);
  let root;
  try {
    root = await realpath(configuredRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!isSafeChildPath(root, filePath)) return null;

  const relativePath = relative(root, filePath);
  const [taskId] = relativePath.split(sep);
  return {
    codex_generated_images_root: configuredRoot,
    codex_task_id: taskId || null,
    codex_relative_path: relativePath
  };
}
