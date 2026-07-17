import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

const IMAGE_EXTENSIONS = new Set([".apng", ".avif", ".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp"]);
const DEFAULT_PROJECT_ID = "default";
const CANVAS_FILE_NAME = "cowart-canvas.json";
const PAGE_ID_PREFIX = "page:";

export function createAssetStore(options = {}) {
  const projectRoot = resolve(options.projectRoot || process.cwd());
  const managerDir = resolve(options.managerDir || join(projectRoot, "asset-manager"));
  const assetsRoot = resolve(options.assetsRoot || join(managerDir, "assets"));
  const canvasDir = resolve(options.canvasDir || join(projectRoot, "canvas"));
  const generatedImagesDir = resolve(options.generatedImagesDir || join(projectRoot, "generated-images"));
  const codexImagesDir = resolve(options.codexImagesDir || process.env.CODEX_GENERATED_IMAGES_DIR || join(homedir(), ".codex", "generated_images"));

  return {
    projectRoot,
    managerDir,
    assetsRoot,
    canvasDir,
    generatedImagesDir,
    codexImagesDir,
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
      const assets = await this.listAssets({ projectId });
      const groups = {};
      const categories = {};
      const styles = {};
      let total = 0;
      let favorites = 0;
      let recent = 0;
      let codex = 0;
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      for (const asset of assets) {
        total++;
        // 收藏：rating > 0 或 favorite 标记为 true
        if (asset.rating > 0 || asset.favorite === true) favorites++;
        if (asset.created_at >= weekAgo) recent++;
        if (asset.source?.type === "codex-generated") codex++;
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
        groups: Object.entries(groups).sort((a, b) => b[1] - a[1]),
        categories: Object.entries(categories).sort((a, b) => b[1] - a[1]),
        styles: Object.entries(styles).sort((a, b) => b[1] - a[1]).slice(0, 20)
      };
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
      const sourcePath = resolveRequiredPath(input.imagePath, "imagePath");
      assertWithinReadableProject(this, sourcePath);

      const sourceStat = await stat(sourcePath);
      if (!sourceStat.isFile()) throw new Error(`imagePath is not a file: ${sourcePath}`);

      const originalName = sanitizeFileName(input.asset || input.fileName || basename(sourcePath));
      const assetId = sanitizeId(input.assetId || `${slugName(originalName)}-${shortStamp()}`, "asset");
      const imageName = await uniqueFileName(this.imagesDir(projectId), `${assetId}${extname(originalName) || extname(sourcePath) || ".png"}`);
      const imagePath = join(this.imagesDir(projectId), imageName);
      await copyFile(sourcePath, imagePath);

      const prompt = String(input.prompt || "").trim();
      const promptPath = join(this.promptsDir(projectId), `${assetId}.md`);
      await writeFile(promptPath, promptFileContent({ ...input, id: assetId }, prompt), "utf8");

      const now = new Date().toISOString();
      const codexSource = codexSourceMetadata(this, sourcePath);
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
          ...(input.source && typeof input.source === "object" ? input.source : {})
        }
      });

      await writeMetadata(this, metadata);
      if (metadata.parent_asset_id) await attachChildVersion(this, metadata);
      return withRuntimeUrls(metadata);
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
      return withRuntimeUrls(next);
    },
    async syncCowartAssets(projectId = DEFAULT_PROJECT_ID) {
      const cleanProjectId = await this.ensureProject(projectId);
      const snapshot = await loadCowartSnapshot(this.canvasDir);
      const imported = [];
      const skipped = [];
      const assets = Object.values(snapshot.store).filter((record) => record?.typeName === "asset" && record.type === "image");

      for (const record of assets) {
        const src = record.props?.src;
        if (typeof src !== "string" || !src.startsWith("/page-assets/")) {
          skipped.push({ recordId: record.id, reason: "unsupported-src", src });
          continue;
        }

        const sourcePath = cowartSourcePathFromUrl(this.canvasDir, src);
        try {
          await stat(sourcePath);
        } catch {
          skipped.push({ recordId: record.id, reason: "missing-file", src });
          continue;
        }

        const existing = await findExistingBySource(this, cleanProjectId, sourcePath);
        if (existing) {
          skipped.push({ recordId: record.id, reason: "already-imported", assetId: existing.id });
          continue;
        }

        const shape = Object.values(snapshot.store).find(
          (candidate) => candidate?.typeName === "shape" && candidate.props?.assetId === record.id
        );
        const meta = { ...(record.meta || {}), ...(shape?.meta || {}) };
        const created = await this.createAsset({
          projectId: cleanProjectId,
          imagePath: sourcePath,
          assetId: sanitizeId(record.id.replace(/^asset:/, ""), "asset"),
          fileName: record.props?.name || basename(sourcePath),
          prompt: meta.prompt || "",
          skill: meta.skill || "",
          style: meta.style || "",
          ratio: ratioFromDimensions(record.props?.w, record.props?.h),
          theme: meta.theme || themeFromFileName(record.props?.name || basename(sourcePath)),
          tags: uniqueArray([meta.theme, meta.style].filter(Boolean)),
          business_fields: meta.business_fields || {},
          sourceType: "cowart-page-asset",
          source: { cowart_asset_id: record.id, cowart_shape_id: shape?.id || null }
        });
        imported.push(created);
      }

      return { imported, skipped };
    },
    async insertAssetIntoCowart(input = {}) {
      const asset = await this.getAsset(input.projectId || DEFAULT_PROJECT_ID, input.assetId);
      const result = await insertIntoCowart({
        store: this,
        asset,
        cowartUrl: input.cowartUrl || "http://127.0.0.1:43217",
        pageId: input.pageId,
        placement: input.placement,
        displayWidth: input.displayWidth,
        displayHeight: input.displayHeight
      });
      return { asset, canvas: result };
    },
    assetReadStream(projectId, fileName) {
      const cleanProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID);
      const safeName = sanitizeFileName(fileName);
      const fullPath = join(this.imagesDir(cleanProjectId), safeName);
      if (!isSafeChildPath(this.imagesDir(cleanProjectId), fullPath)) {
        throw new Error("Unsafe asset path.");
      }
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

export async function getImageDimensions(filePath) {
  const buffer = await readFile(filePath);
  if (buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const size = buffer.readUInt16BE(offset + 2);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + size;
    }
  }
  if (buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    }
  }
  return { width: 512, height: 512 };
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

async function writeMetadata(store, metadata) {
  await store.ensureProject(metadata.project_id);
  await writeFile(join(store.metadataDir(metadata.project_id), `${metadata.id}.json`), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
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

async function findExistingBySource(store, projectId, sourcePath) {
  const assets = await store.listAssets({ projectId });
  return assets.find((asset) => resolve(asset.source?.path || "") === resolve(sourcePath));
}

async function loadCowartSnapshot(canvasDir) {
  const manifestPath = join(canvasDir, "pages", "manifest.json");
  let canvasFile = join(canvasDir, "pages", "page", CANVAS_FILE_NAME);
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const page = manifest.pages?.[0];
    if (page?.path) canvasFile = join(canvasDir, page.path);
  } catch {
    canvasFile = join(canvasDir, CANVAS_FILE_NAME);
  }
  const snapshot = JSON.parse(await readFile(canvasFile, "utf8"));
  return snapshot?.snapshot || snapshot;
}

async function saveCowartSnapshot(canvasDir, snapshot) {
  const manifestPath = join(canvasDir, "pages", "manifest.json");
  let canvasFile = join(canvasDir, "pages", "page", CANVAS_FILE_NAME);
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const page = manifest.pages?.[0];
    if (page?.path) canvasFile = join(canvasDir, page.path);
  } catch {
    canvasFile = join(canvasDir, CANVAS_FILE_NAME);
  }
  await writeFile(canvasFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return canvasFile;
}

async function insertIntoCowart({ store, asset, cowartUrl, pageId, placement = "right", displayWidth, displayHeight }) {
  const sourcePath = asset.image_path;
  const sourceStat = await stat(sourcePath);
  const imageSize = await getImageDimensions(sourcePath);
  let snapshot = null;
  let usedApi = false;

  try {
    const response = await fetch(`${cowartUrl.replace(/\/+$/, "")}/api/canvas`);
    if (response.ok) {
      const payload = await response.json();
      snapshot = payload.snapshot || payload;
      usedApi = true;
    }
  } catch {
    snapshot = null;
  }

  if (!snapshot) snapshot = await loadCowartSnapshot(store.canvasDir);

  const targetPageId = pageId || await currentCowartPageId(store.canvasDir) || Object.values(snapshot.store).find((record) => record?.typeName === "page")?.id || "page:page";
  const targetPageDir = join(store.canvasDir, "pages", pageDirName(targetPageId), "assets");
  await mkdir(targetPageDir, { recursive: true });
  const canvasFileName = await uniqueFileName(targetPageDir, asset.asset);
  const canvasFilePath = join(targetPageDir, canvasFileName);
  await copyFile(sourcePath, canvasFilePath);

  const assetRecordId = uniqueRecordId(snapshot.store, "asset", asset.id);
  const shapeRecordId = uniqueRecordId(snapshot.store, "shape", asset.id);
  const width = finiteNumber(displayWidth, Math.min(imageSize.width, 520));
  const height = finiteNumber(displayHeight, Math.round(width * (imageSize.height / imageSize.width)));
  const position = chooseCanvasPosition(snapshot.store, targetPageId, width, height, placement);

  snapshot.store[assetRecordId] = {
    id: assetRecordId,
    typeName: "asset",
    type: "image",
    props: {
      name: canvasFileName,
      src: `/page-assets/${pageDirName(targetPageId)}/${encodeURIComponent(canvasFileName)}`,
      w: imageSize.width,
      h: imageSize.height,
      fileSize: sourceStat.size,
      mimeType: mimeTypeForFile(sourcePath),
      isAnimated: false
    },
    meta: {
      gptAssetManagerId: asset.id,
      skill: asset.skill,
      style: asset.style,
      theme: asset.theme
    }
  };
  snapshot.store[shapeRecordId] = {
    x: position.x,
    y: position.y,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {
      gptAssetManagerId: asset.id,
      prompt: asset.prompt,
      skill: asset.skill,
      style: asset.style,
      theme: asset.theme,
      business_fields: asset.business_fields
    },
    id: shapeRecordId,
    type: "image",
    props: {
      w: width,
      h: height,
      assetId: assetRecordId,
      playing: true,
      url: "",
      crop: null,
      flipX: false,
      flipY: false,
      altText: `${asset.theme || asset.id} asset`
    },
    parentId: targetPageId,
    index: chooseIndex(snapshot.store, targetPageId),
    typeName: "shape"
  };

  if (usedApi) {
    try {
      const response = await fetch(`${cowartUrl.replace(/\/+$/, "")}/api/canvas`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(snapshot)
      });
      if (!response.ok) throw new Error(await response.text());
    } catch {
      usedApi = false;
      await saveCowartSnapshot(store.canvasDir, snapshot);
    }
  } else {
    await saveCowartSnapshot(store.canvasDir, snapshot);
  }

  return {
    pageId: targetPageId,
    assetId: assetRecordId,
    shapeId: shapeRecordId,
    assetFile: canvasFilePath,
    bounds: { ...position, w: width, h: height },
    cowartUrl,
    usedApi
  };
}

async function currentCowartPageId(canvasDir) {
  try {
    const manifestPath = join(canvasDir, "pages", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const currentPage = manifest.currentPage || manifest.pages?.[0];
    if (currentPage?.id) return currentPage.id;
    if (currentPage?.path) {
      const match = currentPage.path.match(/([^/]+)\.json$/);
      if (match) return match[1].startsWith(PAGE_ID_PREFIX) ? match[1] : PAGE_ID_PREFIX + match[1];
    }
    return null;
  } catch {
    return null;
  }
}

function cowartSourcePathFromUrl(canvasDir, src) {
  const parts = src.split("/").filter(Boolean);
  const pageDir = decodeURIComponent(parts[1] || "page");
  const fileName = decodeURIComponent(parts.slice(2).join("/") || "");
  const fullPath = join(canvasDir, "pages", pageDir, "assets", fileName);
  if (!isSafeChildPath(canvasDir, fullPath)) throw new Error(`Unsafe Cowart asset path: ${src}`);
  return fullPath;
}

function chooseCanvasPosition(store, pageId, width, height, placement = "right") {
  const shapes = Object.values(store).filter((record) => record?.typeName === "shape" && record.parentId === pageId);

  if (shapes.length === 0) {
    // 新页面，第一个元素放在 (0, 0)
    return { x: 0, y: 0 };
  }

  const finiteShapes = shapes.map(shape => ({
    x: finiteNumber(shape.x, 0),
    y: finiteNumber(shape.y, 0),
    w: finiteNumber(shape.props?.w, 300),
    h: finiteNumber(shape.props?.h, 200)
  }));

  if (placement === "below") {
    // 放在最下方元素下面
    const maxBottom = Math.max(...finiteShapes.map(s => s.y + s.h));
    const minX = Math.min(...finiteShapes.map(s => s.x));
    return { x: minX, y: maxBottom + 80 };
  } else if (placement === "center") {
    // 放在画布中心附近
    const minX = Math.min(...finiteShapes.map(s => s.x));
    const maxRight = Math.max(...finiteShapes.map(s => s.x + s.w));
    const centerX = (minX + maxRight) / 2;
    const maxBottom = Math.max(...finiteShapes.map(s => s.y + s.h));
    return { x: centerX - width / 2, y: maxBottom + 80 };
  } else {
    // 默认 "right" - 放在最右侧元素右边
    const maxRight = Math.max(...finiteShapes.map(s => s.x + s.w));
    const minY = Math.min(...finiteShapes.map(s => s.y));
    return { x: maxRight + 80, y: minY };
  }
}

function chooseIndex(store, parentId) {
  const used = new Set(Object.values(store).filter((record) => record?.typeName === "shape" && record.parentId === parentId).map((record) => record.index));
  for (let i = used.size + 1; i < used.size + 1000; i += 1) {
    const candidate = `a${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `a${Date.now().toString(36)}`;
}

function uniqueRecordId(store, prefix, seed) {
  const base = `${prefix}:${sanitizeId(seed, prefix)}`;
  let candidate = base;
  let counter = 2;
  while (store[candidate]) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
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

function promptFileContent(input, prompt) {
  const header = [
    "---",
    `asset_id: ${input.id || ""}`,
    `skill: ${input.skill || ""}`,
    `style: ${input.style || ""}`,
    `ratio: ${input.ratio || ""}`,
    `theme: ${input.theme || ""}`,
    "---",
    ""
  ].join("\n");
  return `${header}${prompt || ""}\n`;
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

function ratioFromDimensions(w, h) {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return "";
  const divisor = gcd(Math.round(w), Math.round(h));
  return `${Math.round(w) / divisor}:${Math.round(h) / divisor}`;
}

function gcd(a, b) {
  while (b) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1;
}

function themeFromFileName(fileName) {
  return String(fileName || "")
    .replace(/\.[^.]+$/, "")
    .replace(/^\d+[-_]/, "")
    .replace(/[-_]+/g, "-");
}

function uniqueArray(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map(String))];
}

function finiteNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function pageDirName(pageId) {
  return encodeURIComponent(String(pageId || "page:page").replace(PAGE_ID_PREFIX, ""));
}

function resolveRequiredPath(value, label) {
  if (!value || typeof value !== "string") throw new Error(`${label} is required.`);
  return resolve(value);
}

function assertWithinReadableProject(store, filePath) {
  const allowedRoots = [store.projectRoot, store.generatedImagesDir, store.codexImagesDir, store.canvasDir, store.assetsRoot].map((root) => resolve(root));
  if (!allowedRoots.some((root) => filePath === root || isSafeChildPath(root, filePath))) {
    throw new Error(`Refusing to import outside the project roots: ${filePath}`);
  }
  if (!IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase())) {
    throw new Error(`Unsupported image type: ${filePath}`);
  }
}

function isSafeChildPath(parent, child) {
  const pathToChild = relative(parent, child);
  return pathToChild && !pathToChild.startsWith("..") && !pathToChild.includes(`..${sep}`);
}

function codexSourceMetadata(store, filePath) {
  const root = resolve(store.codexImagesDir);
  if (!isSafeChildPath(root, filePath)) return null;

  const relativePath = relative(root, filePath);
  const [taskId] = relativePath.split(sep);
  return {
    codex_generated_images_root: root,
    codex_task_id: taskId || null,
    codex_relative_path: relativePath
  };
}
