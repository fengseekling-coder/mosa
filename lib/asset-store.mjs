import { copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { createSqliteAssetStore, hasCompletedSqliteLibrary, STYLE_FACET_LIMIT } from "./sqlite-asset-store.mjs";
import { relinkCodexAssets } from "./codex-hardlink.js";
import { isRecentCreatedAt, normalizeCreatedAt, recentCutoffTimestamp } from "./recent-window.js";
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
  assertMutableVersionPatch,
  buildAssetVersionHistory,
  derivedAssetSource,
  pickVersionOverrides,
  requireVersionChange,
  versionParentError,
} from "./asset-version-history.mjs";
import { appendRecipeSnapshot, ensureRecipeSnapshots, recipeHistory } from "./recipe-snapshot.js";
import { assetSortName, compareAssets, normalizeAssetSort } from "./asset-sort.js";

const IMAGE_EXTENSIONS = new Set([".apng", ".avif", ".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".m4v", ".mov", ".mp4", ".webm"]);
const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);
/** Served to the import form so its "supported formats" hint cannot drift from what is accepted. */
export const SUPPORTED_MEDIA_EXTENSIONS = [...MEDIA_EXTENSIONS].sort();
const DEFAULT_PROJECT_ID = "default";
const GROUP_LOCK_TIMEOUT_MS = 5000;
const GROUP_LOCK_STALE_MS = 30_000;
const GROUP_CLEANUP_LOCK_STALE_MS = 5000;
// Corrupt metadata is reported once per store instance so repeated gallery scans cannot flood the caller.
const warnedMetadataPaths = new WeakMap();

/**
 * Selects the verified SQLite library when one is explicitly configured.
 * A fresh install continues to use the legacy JSON store until `mosa migrate`
 * has completed its hash verification, so upgrading the application is safe.
 */
export function createAssetStore(options = {}) {
  const libraryDir = options.libraryDir || process.env.MOSA_LIBRARY_DIR;
  if (libraryDir && hasCompletedSqliteLibrary(libraryDir)) {
    return createSqliteAssetStore({ ...options, libraryDir });
  }
  return createJsonAssetStore(options);
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
  const codexImagesDir = resolve(options.codexImagesDir || process.env.CODEX_GENERATED_IMAGES_DIR || join(homedir(), ".codex", "generated_images"));
  const cowartCanvasDir = resolve(options.cowartCanvasDir || process.env.COWART_MOSA_CANVAS_DIR || join(homedir(), ".codex", "cowart-data", "mosa"));
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

      return assets
        .filter((asset) => matchesQuery(asset, filters.query))
        .filter((asset) => (filters.archived ? Boolean(asset.archived) : !asset.archived))
        .filter((asset) => {
          if (filters.source && asset.source?.type !== filters.source) return false;
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
        .sort((left, right) => compareAssets(filters.sort, left, right));
    },
    async listAssetPage(filters = {}) {
      const sort = normalizeAssetSort(filters.sort);
      const assets = await this.listAssets(filters);
      const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 250);
      let start = 0;
      if (filters.cursor) {
        const cursor = parseAssetCursor(filters.cursor, sort);
        // The list is already ordered by `sort`, so the resume point is simply the
        // first asset that sorts strictly after the cursor row under that order.
        start = assets.findIndex((asset) => compareAssets(sort, asset, cursorRow(cursor)) > 0);
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
            ? Buffer.from(JSON.stringify({ createdAt: last.created_at, id: last.id, sortName: assetSortName(last), sort })).toString("base64url")
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
        if (!name) throw new Error("Group name is required.");
        const names = await readGroupNames(this, projectId);
        const assets = await this.listAssets({ projectId });
        if ([...names, ...assets.map((asset) => asset.group)].some((item) => String(item || "").toLocaleLowerCase() === name.toLocaleLowerCase())) {
          throw new Error(`Group already exists: ${name}`);
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
        if (!name) throw new Error("Group name is required.");
        
        const names = await readGroupNames(this, cleanProjectId);
        const index = names.findIndex((item) => item.toLocaleLowerCase() === name.toLocaleLowerCase());
        if (index === -1) throw new Error(`Group not found: ${name}`);
        
        // Remove group from the list
        names.splice(index, 1);
        await writeGroupNames(this, cleanProjectId, names);
        
        // Remove group assignment from all assets
        const assets = await this.listAssets({ projectId: cleanProjectId });
        for (const asset of assets) {
          if (asset.group?.toLocaleLowerCase() === name.toLocaleLowerCase()) {
            await this.updateMetadata(cleanProjectId, asset.id, { group: null });
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
      const contentHash = createHash("sha256").update(await readFile(readablePath)).digest("hex");

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

        const prompt = String(input.prompt || "").trim();
        const promptPath = join(this.promptsDir(projectId), `${assetId}.md`);
        await writeFile(promptPath, promptFileContent({ ...input, id: assetId }, prompt), "utf8");

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
            content_sha256: contentHash,
            storage_mode: storageMode,
          }
        }), {
          createdAt: input.created_at || timestamp,
          changeSummary: versionChange || "Initial recipe",
        });

        await writeMetadata(this, metadata);
        if (metadata.group) await ensureGroup(this, projectId, metadata.group);
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
      await writeFile(next.prompt_path, promptFileContent(next, prompt), "utf8");
      await writeMetadata(this, next);
      if (next.group) await ensureGroup(this, next.project_id, next.group);
      return withRuntimeUrls(next);
    },
    async archiveAsset(projectId, assetId) {
      return this.updateMetadata(projectId, assetId, { archived: true });
    },
    async deleteAsset(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const asset = await readAssetMetadata(this, cleanProjectId, cleanAssetId);
      const metadataPath = join(this.metadataDir(cleanProjectId), `${cleanAssetId}.json`);
      const projectDir = this.projectDir(cleanProjectId);
      const managedPaths = [asset.image_path, asset.prompt_path]
        .filter((filePath) => filePath && isSafeChildPath(projectDir, resolve(filePath)))
        .map((filePath) => resolve(filePath));
      await Promise.all(managedPaths.map((filePath) => unlinkIfPresent(filePath)));
      await unlink(metadataPath);
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
    async assetReadStream(projectId, fileName) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const safeName = sanitizeFileName(fileName);
      const fullPath = await resolveStoredAssetPath(this, cleanProjectId, safeName);
      return createReadStream(fullPath);
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

function matchesQuery(asset, query) {
  const value = String(query || "").trim().toLowerCase();
  if (!value) return true;
  const haystack = [
    asset.id,
    asset.asset,
    asset.prompt,
    asset.skill,
    asset.style,
    asset.theme,
    ...(asset.tags || []),
    ...Object.values(asset.business_fields || {})
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(value);
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
function parseAssetCursor(value, sort) {
  try {
    const cursor = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (typeof cursor?.createdAt !== "string" || typeof cursor?.id !== "string") throw new Error();
    const cursorSort = normalizeAssetSort(cursor.sort);
    if (cursorSort !== normalizeAssetSort(sort)) throw new Error();
    if (cursorSort === "name" && typeof cursor.sortName !== "string") throw new Error();
    return cursor;
  } catch {
    throw assetStoreError("INVALID_ASSET_CURSOR", "Invalid asset cursor.");
  }
}

/** Shapes a decoded cursor back into the minimal asset the comparator needs. */
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
  await writeFile(join(store.metadataDir(metadata.project_id), `${metadata.id}.json`), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

async function writeGroupNames(store, projectId, names) {
  const targetPath = store.groupsFile(projectId);
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(names, null, 2)}\n`, "utf8");
    await rename(temporaryPath, targetPath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
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
  const pathToChild = relative(parent, child);
  return pathToChild && !pathToChild.startsWith("..") && !pathToChild.includes(`..${sep}`);
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
