import { copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

const IMAGE_EXTENSIONS = new Set([".apng", ".avif", ".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp"]);
const DEFAULT_PROJECT_ID = "default";
const GROUP_LOCK_TIMEOUT_MS = 5000;
const GROUP_LOCK_STALE_MS = 30_000;

export function createAssetStore(options = {}) {
  const projectRoot = resolve(options.projectRoot || process.cwd());
  const managerDir = resolve(options.managerDir || join(projectRoot, "mosa"));
  const assetsRoot = resolve(options.assetsRoot || join(managerDir, "assets"));
  const generatedImagesDir = resolve(options.generatedImagesDir || join(projectRoot, "generated-images"));
  const codexImagesDir = resolve(options.codexImagesDir || process.env.CODEX_GENERATED_IMAGES_DIR || join(homedir(), ".codex", "generated_images"));
  const cowartCanvasDir = resolve(options.cowartCanvasDir || process.env.COWART_MOSA_CANVAS_DIR || join(homedir(), ".codex", "cowart-data", "mosa"));
  const cowartPageAssetsDir = join(cowartCanvasDir, "pages");

  return {
    projectRoot,
    managerDir,
    assetsRoot,
    generatedImagesDir,
    codexImagesDir,
    cowartCanvasDir,
    cowartPageAssetsDir,
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
      const dir = this.metadataDir(projectId);
      const entries = await readdir(dir, { withFileTypes: true });
      const assets = [];
      for (const entry of entries) {
        if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".json") continue;
        try {
          const asset = JSON.parse(await readFile(join(dir, entry.name), "utf8"));
          assets.push(withRuntimeUrls(asset));
        } catch {
          continue;
        }
      }

      return assets
        .filter((asset) => matchesQuery(asset, filters.query))
        .filter((asset) => (filters.archived ? Boolean(asset.archived) : !asset.archived))
        .filter((asset) => {
          if (filters.source) return asset.source?.type === filters.source;
          if (filters.group) return asset.group === filters.group;
          if (filters.category) return asset.category === filters.category;
          if (filters.style) return asset.style === filters.style;
          // 收藏：rating > 0 或 favorite 标记为 true
          if (filters.favorite) return asset.rating > 0 || asset.favorite === true;
          if (filters.recent) {
            const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
            return asset.created_at >= weekAgo;
          }
          return true;
        })
        .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    },
    async listGroups(projectId = DEFAULT_PROJECT_ID) {
      const cleanProjectId = await this.ensureProject(projectId);
      const assets = await this.listAssets({ projectId: cleanProjectId });
      const manualGroups = await readGroupNames(this, cleanProjectId);
      const groups = {};
      const categories = {};
      const styles = {};
      let total = 0;
      let favorites = 0;
      let recent = 0;
      let codex = 0;
      let cowart = 0;

      for (const name of manualGroups) groups[name] = 0;
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      for (const asset of assets) {
        total++;
        // 收藏：rating > 0 或 favorite 标记为 true
        if (asset.rating > 0 || asset.favorite === true) favorites++;
        if (asset.created_at >= weekAgo) recent++;
        if (asset.source?.type === "codex-generated") codex++;
        if (asset.source?.type === "cowart-generated") cowart++;
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
        groups: Object.entries(groups).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
        categories: Object.entries(categories).sort((a, b) => b[1] - a[1]),
        styles: Object.entries(styles).sort((a, b) => b[1] - a[1]).slice(0, 20)
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
    async getAsset(projectId, assetId) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const cleanAssetId = sanitizeId(assetId, "asset");
      const file = join(this.metadataDir(cleanProjectId), `${cleanAssetId}.json`);
      const asset = JSON.parse(await readFile(file, "utf8"));
      return withRuntimeUrls(asset);
    },
    async createAsset(input = {}) {
      const projectId = await this.ensureProject(input.projectId || DEFAULT_PROJECT_ID);
      const { sourcePath, readablePath } = await resolveReadableImagePath(this, input.imagePath);
      const contentHash = createHash("sha256").update(await readFile(readablePath)).digest("hex");

      const codexSource = await codexSourceMetadata(this, readablePath);
      const originalName = sanitizeFileName(input.asset || input.fileName || basename(sourcePath));
      const assetId = sanitizeId(input.assetId || `${slugName(originalName)}-${shortStamp()}`, "asset");
      const imageName = await uniqueFileName(this.imagesDir(projectId), `${assetId}${extname(originalName) || extname(sourcePath) || ".png"}`);
      const imagePath = join(this.imagesDir(projectId), imageName);
      const storageMode = codexSource ? await hardLinkOrCopy(readablePath, imagePath) : (await copyFile(readablePath, imagePath), "copy");

      const prompt = String(input.prompt || "").trim();
      const promptPath = join(this.promptsDir(projectId), `${assetId}.md`);
      await writeFile(promptPath, promptFileContent({ ...input, id: assetId }, prompt), "utf8");

      const now = new Date().toISOString();
      const metadata = normalizeAssetMetadata({
        ...input,
        id: assetId,
        project_id: projectId,
        asset: imageName,
        image_path: imagePath,
        prompt_path: promptPath,
        prompt,
        created_at: input.created_at || now,
        updated_at: now,
        source: {
          type: input.sourceType || (codexSource ? "codex-generated" : "local-file"),
          path: sourcePath,
          copied_at: now,
          ...(codexSource || {}),
          ...(input.source && typeof input.source === "object" ? input.source : {}),
          content_sha256: contentHash,
          storage_mode: storageMode,
        }
      });

      await writeMetadata(this, metadata);
      if (metadata.group) await ensureGroup(this, projectId, metadata.group);
      if (metadata.parent_asset_id) await attachChildVersion(this, metadata);
      return withRuntimeUrls(metadata);
    },
    async migrateCodexAssetsToHardLinks(projectId = DEFAULT_PROJECT_ID) {
      const cleanProjectId = await this.ensureProject(projectId);
      const assets = [
        ...(await this.listAssets({ projectId: cleanProjectId })),
        ...(await this.listAssets({ projectId: cleanProjectId, archived: true })),
      ];
      const result = { migrated: [], alreadyLinked: [], skipped: [] };
      for (const asset of assets) {
        if (asset.source?.type !== "codex-generated") continue;
        const migration = await migrateCodexAssetToHardLink(asset);
        if (migration.status === "migrated") {
          await this.updateMetadata(cleanProjectId, asset.id, {
            source: {
              ...asset.source,
              storage_mode: "hard-link",
              storage_linked_at: new Date().toISOString(),
            },
          });
          result.migrated.push(asset.id);
        } else if (migration.status === "already-linked") result.alreadyLinked.push(asset.id);
        else result.skipped.push({ assetId: asset.id, reason: migration.status });
      }
      return result;
    },
    async updateMetadata(projectId, assetId, patch = {}) {
      const current = await this.getAsset(projectId, assetId);
      const prompt = Object.hasOwn(patch, "prompt") ? String(patch.prompt || "").trim() : current.prompt;
      const next = normalizeAssetMetadata({
        ...current,
        ...patch,
        id: current.id,
        project_id: current.project_id,
        asset: current.asset,
        image_path: current.image_path,
        prompt_path: current.prompt_path,
        prompt,
        business_fields: parseBusinessFields(patch.business_fields ?? current.business_fields),
        updated_at: new Date().toISOString()
      });
      await writeFile(next.prompt_path, promptFileContent(next, prompt), "utf8");
      await writeMetadata(this, next);
      if (next.group) await ensureGroup(this, next.project_id, next.group);
      return withRuntimeUrls(next);
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
    default:
      return "application/octet-stream";
  }
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
    parent_asset_id: input.parent_asset_id || input.parentAssetId || null,
    version_change: String(input.version_change || input.changeSummary || ""),
    child_asset_ids: uniqueArray(input.child_asset_ids || []),
    created_at: input.created_at || new Date().toISOString(),
    updated_at: input.updated_at || new Date().toISOString(),
    source: input.source && typeof input.source === "object" ? input.source : {}
  };
}

function withRuntimeUrls(asset) {
  return {
    ...asset,
    image_url: `/library/${encodeURIComponent(asset.project_id)}/images/${encodeURIComponent(asset.asset)}`,
    prompt_file: asset.prompt_path
  };
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
    await lock.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

async function acquireGroupLock(lockPath) {
  const deadline = Date.now() + GROUP_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      return await open(lockPath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await removeStaleGroupLock(lockPath);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
  }
  throw new Error("Timed out waiting to update groups.");
}

async function removeStaleGroupLock(lockPath) {
  try {
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs > GROUP_LOCK_STALE_MS) await unlink(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function attachChildVersion(store, child) {
  try {
    const parent = await store.getAsset(child.project_id, child.parent_asset_id);
    if (!parent.child_asset_ids.includes(child.id)) {
      parent.child_asset_ids.push(child.id);
      parent.updated_at = new Date().toISOString();
      await writeMetadata(store, parent);
    }
  } catch {
    return;
  }
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

async function migrateCodexAssetToHardLink(asset) {
  const sourcePath = asset.source?.path ? resolve(asset.source.path) : null;
  const targetPath = asset.image_path ? resolve(asset.image_path) : null;
  if (!sourcePath || !targetPath) return { status: "missing-path" };
  let sourceStat;
  let targetStat;
  try {
    [sourceStat, targetStat] = await Promise.all([stat(sourcePath), stat(targetPath)]);
  } catch {
    return { status: "source-or-library-file-missing" };
  }
  if (!sourceStat.isFile() || !targetStat.isFile()) return { status: "not-a-file" };
  if (sourceStat.dev !== targetStat.dev) return { status: "different-filesystem" };
  if (sourceStat.ino === targetStat.ino) return { status: "already-linked" };

  const [sourceHash, targetHash] = await Promise.all([
    createHash("sha256").update(await readFile(sourcePath)).digest("hex"),
    createHash("sha256").update(await readFile(targetPath)).digest("hex"),
  ]);
  if (sourceHash !== targetHash) return { status: "content-mismatch" };

  const temporaryPath = join(dirname(targetPath), `.${basename(targetPath)}.${randomUUID()}.hardlink`);
  try {
    await link(sourcePath, temporaryPath);
    await rename(temporaryPath, targetPath);
    return { status: "migrated" };
  } finally {
    await unlink(temporaryPath).catch(() => {});
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
  return Date.now().toString(36);
}

function uniqueArray(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map(String))];
}

function resolveRequiredPath(value, label) {
  if (!value || typeof value !== "string") throw new Error(`${label} is required.`);
  return resolve(value);
}

async function resolveReadableImagePath(store, value) {
  const requestedPath = resolveRequiredPath(value, "imagePath");
  if (!IMAGE_EXTENSIONS.has(extname(requestedPath).toLowerCase())) {
    throw new Error(`Unsupported image type: ${requestedPath}`);
  }

  const requestedStat = await lstat(requestedPath);
  if (requestedStat.isSymbolicLink()) throw new Error(`Refusing to import symbolic links: ${requestedPath}`);
  if (!requestedStat.isFile()) throw new Error(`imagePath is not a file: ${requestedPath}`);

  const readablePath = await realpath(requestedPath);
  await assertWithinReadableProject(store, readablePath);
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

async function assertWithinReadableProject(store, filePath) {
  const allowedRoots = [
    store.projectRoot,
    store.generatedImagesDir,
    store.codexImagesDir,
    store.assetsRoot,
    store.cowartPageAssetsDir
  ];
  const resolvedRoots = (await Promise.all(allowedRoots.map(async (root) => {
    try {
      return await realpath(root);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }))).filter(Boolean);
  if (!resolvedRoots.some((root) => filePath === root || isSafeChildPath(root, filePath))) {
    throw new Error(`Refusing to import outside the project roots: ${filePath}`);
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
