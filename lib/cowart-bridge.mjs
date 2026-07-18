import { watch } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";

const IMAGE_EXTENSIONS = new Set([".apng", ".avif", ".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp"]);
const DEFAULT_PROJECT_ID = "default";

/**
 * Reconciles Cowart's project-local page assets into an Asset Manager library.
 * The bridge is deliberately project-scoped: it reads one configured canvas
 * directory, deduplicates by original page-asset path, and never scans a
 * global image directory.
 */
export function createCowartAssetBridge(options = {}) {
  const store = options.store;
  if (!store || typeof store.createAsset !== "function" || typeof store.listAssets !== "function") {
    throw new Error("Cowart bridge requires an Asset Manager store.");
  }

  const canvasDir = resolve(options.canvasDir || store.cowartCanvasDir);
  const projectId = options.projectId || DEFAULT_PROJECT_ID;
  const debounceMs = Number.isFinite(options.debounceMs) ? Math.max(0, options.debounceMs) : 300;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? Math.max(100, options.pollIntervalMs) : 2000;
  let watcher = null;
  let poller = null;
  let timer = null;
  let reconciling = false;
  let reconcileAgain = false;
  const state = {
    canvasDir,
    enabled: false,
    lastScanAt: null,
    lastImportedAt: null,
    lastImportCount: 0,
    totalImported: 0,
    lastSkippedCount: 0,
    lastError: null,
  };

  async function reconcile() {
    if (reconciling) {
      reconcileAgain = true;
      return { imported: [], skipped: [], queued: true };
    }

    reconciling = true;
    try {
      const result = await reconcileCowartAssets({ store, canvasDir, projectId });
      state.lastScanAt = new Date().toISOString();
      state.lastImportCount = result.imported.length;
      state.lastSkippedCount = result.skipped.length;
      state.totalImported += result.imported.length;
      state.lastError = null;
      if (result.imported.length > 0) state.lastImportedAt = state.lastScanAt;
      return result;
    } catch (error) {
      state.lastScanAt = new Date().toISOString();
      state.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      reconciling = false;
      if (reconcileAgain) {
        reconcileAgain = false;
        scheduleReconcile();
      }
    }
  }

  function scheduleReconcile() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      reconcile().catch(() => {});
    }, debounceMs);
  }

  async function start() {
    await mkdir(canvasDir, { recursive: true });
    await reconcile();
    try {
      watcher = watch(canvasDir, { recursive: true }, () => scheduleReconcile());
      watcher.on("error", () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      watcher = null;
    }
    // fs.watch can miss a nested write on some environments. Reconciliation is
    // cheap and makes the bridge reliable without broadening its watched scope.
    poller = setInterval(() => reconcile().catch(() => {}), pollIntervalMs);
    state.enabled = true;
    return apiStatus();
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (poller) clearInterval(poller);
    poller = null;
    watcher?.close();
    watcher = null;
    state.enabled = false;
  }

  function apiStatus() {
    return { ...state, watching: Boolean(watcher), polling: Boolean(poller) };
  }

  return { start, stop, reconcile, scheduleReconcile, status: apiStatus };
}

export async function reconcileCowartAssets({ store, canvasDir, projectId = DEFAULT_PROJECT_ID }) {
  const candidates = await readCowartAssetCandidates(canvasDir);
  const currentAssets = await store.listAssets({ projectId });
  const knownSourcePaths = new Set(
    currentAssets
      .map((asset) => asset.source?.cowart_page_asset_path || asset.source?.path)
      .filter(Boolean)
      .map((value) => resolve(value)),
  );
  const imported = [];
  const skipped = [];

  for (const candidate of candidates) {
    if (candidate.assetManagerAssetId) {
      skipped.push({ path: candidate.imagePath, reason: "asset-manager-origin" });
      continue;
    }
    if (knownSourcePaths.has(candidate.imagePath)) {
      skipped.push({ path: candidate.imagePath, reason: "already-archived" });
      continue;
    }

    const asset = await store.createAsset({
      projectId,
      imagePath: candidate.imagePath,
      prompt: candidate.altText,
      skill: "Cowart automatic bridge",
      ratio: candidate.ratio,
      theme: candidate.altText,
      sourceType: "cowart-generated",
      business_fields: {
        auto_archived: true,
        prompt_status: "Cowart canvas only provides alt text; attach the original generation prompt when available.",
      },
      source: {
        generation_tool: "cowart",
        cowart_canvas_dir: candidate.canvasDir,
        cowart_page_id: candidate.pageId,
        cowart_page_asset_path: candidate.imagePath,
        cowart_page_asset_url: candidate.assetUrl,
        cowart_asset_id: candidate.cowartAssetId,
        cowart_shape_id: candidate.shapeId,
        cowart_shape_meta: candidate.shapeMeta,
        cowart_annotation_source_shape_id: candidate.annotationSourceShapeId || null,
        replaced_ai_image_holder: candidate.replacedAiImageHolder || null,
        prompt_status: "canvas-alt-text-only",
      },
    });
    knownSourcePaths.add(candidate.imagePath);
    imported.push(asset);
  }

  return { imported, skipped, candidates: candidates.length };
}

async function readCowartAssetCandidates(canvasDir) {
  const root = resolve(canvasDir);
  const pagesDir = join(root, "pages");
  let pageEntries = [];
  try {
    pageEntries = await readdir(pagesDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const candidates = [];
  for (const pageEntry of pageEntries) {
    if (!pageEntry.isDirectory()) continue;
    const pageDir = pageEntry.name;
    const snapshotPath = join(pagesDir, pageDir, "cowart-canvas.json");
    let snapshot;
    try {
      snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) continue;
      throw error;
    }
    const records = snapshot?.store;
    if (!records || typeof records !== "object") continue;

    const shapesByAssetId = new Map();
    for (const record of Object.values(records)) {
      if (record?.typeName !== "shape" || record.type !== "image" || !record.props?.assetId) continue;
      const list = shapesByAssetId.get(record.props.assetId) || [];
      list.push(record);
      shapesByAssetId.set(record.props.assetId, list);
    }

    for (const record of Object.values(records)) {
      if (record?.typeName !== "asset" || record.type !== "image") continue;
      const parsed = parseCowartAssetUrl(record.props?.src, pageDir);
      if (!parsed || !IMAGE_EXTENSIONS.has(extname(parsed.fileName).toLowerCase())) continue;

      const imagePath = resolve(pagesDir, parsed.pageDir, "assets", parsed.fileName);
      if (!isSafeChildPath(root, imagePath)) continue;
      try {
        if (!(await stat(imagePath)).isFile()) continue;
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }

      const shape = (shapesByAssetId.get(record.id) || [])[0] || null;
      const shapeMeta = shape?.meta && typeof shape.meta === "object" ? shape.meta : {};
      const assetMeta = record.meta && typeof record.meta === "object" ? record.meta : {};
      const assetManagerAssetId = assetMeta.assetManagerAssetId
        || assetMeta.asset_manager_asset_id
        || shapeMeta.assetManagerAssetId
        || shapeMeta.asset_manager_asset_id
        || null;
      candidates.push({
        canvasDir: root,
        pageId: `page:${parsed.pageDir}`,
        imagePath,
        assetUrl: record.props.src,
        cowartAssetId: record.id,
        shapeId: shape?.id || null,
        shapeMeta,
        annotationSourceShapeId: shapeMeta.cowartAnnotationSourceShapeId || null,
        replacedAiImageHolder: shapeMeta.cowartGeneratedForAiImageHolder || null,
        assetManagerAssetId,
        altText: String(shape?.props?.altText || record.props?.name || "Cowart image"),
        ratio: ratioFromShape(shape),
      });
    }
  }
  return candidates;
}

function parseCowartAssetUrl(value, expectedPageDir) {
  const match = /^\/page-assets\/([^/]+)\/([^/]+)$/.exec(String(value || ""));
  if (!match) return null;
  const pageDir = decodeURIComponent(match[1]);
  const fileName = basename(decodeURIComponent(match[2]));
  if (pageDir !== expectedPageDir || !fileName) return null;
  return { pageDir, fileName };
}

function ratioFromShape(shape) {
  const width = Math.round(Number(shape?.props?.w));
  const height = Math.round(Number(shape?.props?.h));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "";
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function gcd(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function isSafeChildPath(parent, child) {
  const pathToChild = relative(parent, child);
  return pathToChild && !pathToChild.startsWith("..") && !pathToChild.includes(`..${sep}`);
}
