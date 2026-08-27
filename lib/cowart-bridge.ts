import { watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PIXEL_HASH_VERSION, safePixelDigest } from "./image-pixel-hash.js";

const IMAGE_EXTENSIONS = new Set([".apng", ".avif", ".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp"]);
const DEFAULT_PROJECT_ID = "default";

interface Store { createAsset(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>; listAssets(filters: Record<string, unknown>): Promise<Array<{ source?: Record<string, unknown>; [key: string]: unknown }>>; cowartCanvasDir: string; [key: string]: unknown; }
interface AssetCandidate { canvasDir: string; pageId: string; imagePath: string; assetUrl: string; cowartAssetId: string; shapeId: string | null; shapeMeta: Record<string, unknown>; annotationSourceShapeId: string | null; replacedAiImageHolder: string | null; mosaAssetId: string | null; altText: string; ratio: string; }
interface ReconcileResult { imported: unknown[]; skipped: Array<{ path: string; reason: string }>; candidates: number; queued?: boolean; }
interface BridgeStatus { canvasDir: string; cowartProjectDir: string | null; sourceId: string | null; enabled: boolean; watching: boolean; polling: boolean; lastScanAt: string | null; lastImportedAt: string | null; lastImportCount: number; totalImported: number; lastSkippedCount: number; lastError: string | null; }
interface Bridge { start(): Promise<BridgeStatus>; stop(): Promise<void>; reconcile(): Promise<ReconcileResult>; scheduleReconcile(): void; status(): BridgeStatus; }
interface CanvasStoreRecord { typeName?: string; type?: string; id?: string; meta?: Record<string, unknown>; props?: Record<string, unknown>; [key: string]: unknown; }
interface CanvasSnapshot { store?: Record<string, CanvasStoreRecord>; }

export function createCowartAssetBridge(options: { store?: Store; canvasDir?: string; projectId?: string; cowartProjectDir?: string | null; sourceId?: string | null; debounceMs?: number; pollIntervalMs?: number; } = {}): Bridge {
  const store = options.store as Store;
  if (!store || typeof store.createAsset !== "function" || typeof store.listAssets !== "function") throw new Error("Cowart bridge requires a MOSA store.");
  const canvasDir = resolve(options.canvasDir || store.cowartCanvasDir);
  const projectId = options.projectId || DEFAULT_PROJECT_ID;
  const cowartProjectDir = options.cowartProjectDir ? resolve(options.cowartProjectDir) : null;
  const sourceId = options.sourceId || null;
  const debounceMs = options.debounceMs != null && Number.isFinite(options.debounceMs) ? Math.max(0, options.debounceMs) : 300;
  const pollIntervalMs = options.pollIntervalMs != null && Number.isFinite(options.pollIntervalMs) ? Math.max(100, options.pollIntervalMs) : 2000;
  let watcher: FSWatcher | null = null; let poller: ReturnType<typeof setInterval> | null = null; let timer: ReturnType<typeof setTimeout> | null = null; let reconciling = false; let reconcileAgain = false; let enabled = false; let activeReconcile: Promise<ReconcileResult> | null = null; let stopPromise: Promise<void> | null = null;
  const state: Omit<BridgeStatus, "watching" | "polling"> = { canvasDir, cowartProjectDir, sourceId, enabled: false, lastScanAt: null, lastImportedAt: null, lastImportCount: 0, totalImported: 0, lastSkippedCount: 0, lastError: null };

  async function reconcile(): Promise<ReconcileResult> {
    if (!enabled) return { imported: [], skipped: [], queued: true, candidates: 0 };
    if (reconciling) { reconcileAgain = true; return { imported: [], skipped: [], queued: true, candidates: 0 }; }
    reconciling = true;
    const run = (async (): Promise<ReconcileResult> => {
      try {
        const result = await reconcileCowartAssets({ store, canvasDir, projectId, cowartProjectDir, sourceId });
        state.lastScanAt = new Date().toISOString(); state.lastImportCount = result.imported.length; state.lastSkippedCount = result.skipped.length; state.totalImported += result.imported.length; state.lastError = null;
        if (result.imported.length > 0) state.lastImportedAt = state.lastScanAt;
        return result;
      } catch (error) { state.lastScanAt = new Date().toISOString(); state.lastError = error instanceof Error ? error.message : String(error); throw error; } finally {
        reconciling = false;
        activeReconcile = null;
        if (reconcileAgain && enabled) { reconcileAgain = false; scheduleReconcile(); } else reconcileAgain = false;
      }
    })();
    activeReconcile = run;
    return run;
  }
  function scheduleReconcile(): void { if (!enabled) return; if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; if (enabled) reconcile().catch(() => {}); }, debounceMs); }
  async function start(): Promise<BridgeStatus> {
    if (enabled) return apiStatus();
    enabled = true; state.enabled = true;
    try {
      await mkdir(canvasDir, { recursive: true });
      if (!enabled) return apiStatus();
      await reconcile();
      if (!enabled) return apiStatus();
    } catch (error) { enabled = false; state.enabled = false; throw error; }
    try { watcher = watch(canvasDir, { recursive: true }, () => scheduleReconcile()); watcher.on("error", () => { watcher?.close(); watcher = null; }); } catch { watcher = null; }
    if (!enabled) { watcher?.close(); watcher = null; return apiStatus(); }
    poller = setInterval(() => { if (enabled) reconcile().catch(() => {}); }, pollIntervalMs); return apiStatus();
  }
  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    enabled = false; state.enabled = false; reconcileAgain = false;
    if (timer) clearTimeout(timer); timer = null;
    if (poller) clearInterval(poller); poller = null;
    watcher?.close(); watcher = null;
    const currentReconcile = activeReconcile;
    stopPromise = Promise.resolve(currentReconcile).catch(() => {}).then(() => {}).finally(() => { stopPromise = null; });
    return stopPromise;
  }
  function apiStatus(): BridgeStatus { return { ...state, watching: Boolean(watcher), polling: Boolean(poller) }; }
  return { start, stop, reconcile, scheduleReconcile, status: apiStatus };
}

export async function reconcileCowartAssets(options: { store: Store; canvasDir: string; projectId?: string; cowartProjectDir?: string | null; sourceId?: string | null; }): Promise<ReconcileResult> {
  const { store, canvasDir, projectId = DEFAULT_PROJECT_ID, cowartProjectDir = null, sourceId = null } = options;
  const candidates = await readCowartAssetCandidates(canvasDir);
  const trustedPagesRoot = join(resolve(canvasDir), "pages");
  const [currentAssets, archivedAssets] = await Promise.all([store.listAssets({ projectId }), store.listAssets({ projectId, archived: true })]);
  const allAssets = [...currentAssets, ...archivedAssets];
  const assetsBySourcePath = new Map<string, typeof allAssets[number]>();
  for (const asset of allAssets) {
    const sourcePath = (asset.source?.cowart_page_asset_path || asset.source?.path) as string;
    if (sourcePath) assetsBySourcePath.set(resolve(sourcePath), asset);
  }
  const knownContentHashes = new Set(allAssets.map((asset) => asset.source?.content_sha256 as string).filter(Boolean));
  const knownPixelHashes = new Set(allAssets
    .filter((asset) => asset.source?.pixel_hash_version === PIXEL_HASH_VERSION)
    .map((asset) => asset.source?.pixel_sha256 as string)
    .filter(Boolean));
  const imported: unknown[] = []; const skipped: Array<{ path: string; reason: string }> = [];

  for (const candidate of candidates) {
    if (candidate.mosaAssetId) { skipped.push({ path: candidate.imagePath, reason: "mosa-origin" }); continue; }
    let contentHash: string;
    try { contentHash = createHash("sha256").update(await readFile(candidate.imagePath)).digest("hex"); }
    catch { skipped.push({ path: candidate.imagePath, reason: "not-ready" }); continue; }
    const existingAtPath = assetsBySourcePath.get(candidate.imagePath);
    const existingPathHash = String(existingAtPath?.source?.content_sha256 || "");
    if (existingAtPath && (!existingPathHash || existingPathHash === contentHash)) { skipped.push({ path: candidate.imagePath, reason: "already-archived" }); continue; }
    if (knownContentHashes.has(contentHash)) { skipped.push({ path: candidate.imagePath, reason: "already-archived-same-content" }); continue; }
    const pixelHash = extname(candidate.imagePath).toLowerCase() === ".svg"
      ? ""
      : await safePixelDigest(candidate.imagePath).catch(() => "");
    if (pixelHash && knownPixelHashes.has(pixelHash)) { skipped.push({ path: candidate.imagePath, reason: "already-archived-same-pixels" }); continue; }
    try {
      const asset = await store.createAsset({ projectId, imagePath: candidate.imagePath, prompt: candidate.altText, skill: "Cowart automatic bridge", ratio: candidate.ratio, theme: candidate.altText, sourceType: "cowart-generated", business_fields: { auto_archived: true, prompt_status: "Cowart canvas only provides alt text" }, source: { generation_tool: "cowart", cowart_source_id: sourceId, cowart_project_dir: cowartProjectDir, cowart_canvas_dir: candidate.canvasDir, cowart_page_id: candidate.pageId, cowart_page_asset_path: candidate.imagePath, cowart_page_asset_url: candidate.assetUrl, cowart_asset_id: candidate.cowartAssetId, cowart_shape_id: candidate.shapeId, cowart_shape_meta: candidate.shapeMeta, cowart_annotation_source_shape_id: candidate.annotationSourceShapeId || null, replaced_ai_image_holder: candidate.replacedAiImageHolder || null, prompt_status: "canvas-alt-text-only", content_sha256: contentHash, pixel_sha256: pixelHash || null, pixel_hash_version: pixelHash ? PIXEL_HASH_VERSION : null } }, { trustedSourceRoots: [trustedPagesRoot], ingestMode: "automatic" });
      knownContentHashes.add(contentHash); if (pixelHash) knownPixelHashes.add(pixelHash); imported.push(asset);
    } catch (error) {
      skipped.push({ path: candidate.imagePath, reason: isAutomaticImportSuppressed(error) ? "suppressed-after-delete" : isAutomaticIngestDuplicate(error) ? automaticDuplicateReason(error) : "import-failed" });
    }
  }
  return { imported, skipped, candidates: candidates.length };
}

async function readCowartAssetCandidates(canvasDir: string): Promise<AssetCandidate[]> {
  const root = resolve(canvasDir); const pagesDir = join(root, "pages");
  let pageEntries; try { pageEntries = await readdir(pagesDir, { withFileTypes: true }); } catch (error: unknown) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return []; throw error; }
  const candidates: AssetCandidate[] = [];
  for (const pageEntry of pageEntries) {
    if (!pageEntry.isDirectory()) continue;
    const pageDir = pageEntry.name; const snapshotPath = join(pagesDir, pageDir, "cowart-canvas.json");
    let snapshot: CanvasSnapshot; try { snapshot = JSON.parse(await readFile(snapshotPath, "utf8")); } catch (error: unknown) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT" || error instanceof SyntaxError) continue; throw error; }
    const records = snapshot?.store; if (!records || typeof records !== "object") continue;
    const shapesByAssetId = new Map<string, CanvasStoreRecord[]>();
    for (const record of Object.values(records)) { if (record?.typeName !== "shape" || record.type !== "image" || !record.props?.assetId) continue; const assetId = record.props.assetId as string; const list = shapesByAssetId.get(assetId) || []; list.push(record); shapesByAssetId.set(assetId, list); }
    for (const record of Object.values(records)) {
      if (record?.typeName !== "asset" || record.type !== "image" || !record.props) continue;
      const parsed = parseCowartAssetUrl(record.props?.src, pageDir);
      if (!parsed || !IMAGE_EXTENSIONS.has(extname(parsed.fileName).toLowerCase())) continue;
      const imagePath = resolve(pagesDir, parsed.pageDir, "assets", parsed.fileName);
      if (!isSafeChildPath(root, imagePath)) continue;
      try { if (!(await stat(imagePath)).isFile()) continue; } catch (error: unknown) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue; throw error; }
      const shape = (shapesByAssetId.get(record.id || "") || [])[0] || null;
      const shapeMeta = shape?.meta && typeof shape.meta === "object" ? shape.meta : {};
      const assetMeta = record.meta && typeof record.meta === "object" ? record.meta : {};
      const mosaAssetId = (assetMeta.mosaAssetId as string) || (assetMeta.mosa_asset_id as string) || (shapeMeta.mosaAssetId as string) || (shapeMeta.mosa_asset_id as string) || null;
      candidates.push({ canvasDir: root, pageId: `page:${parsed.pageDir}`, imagePath, assetUrl: record.props.src as string, cowartAssetId: record.id || "", shapeId: shape?.id || null, shapeMeta: shapeMeta as Record<string, unknown>, annotationSourceShapeId: (shapeMeta.cowartAnnotationSourceShapeId as string) || null, replacedAiImageHolder: (shapeMeta.cowartGeneratedForAiImageHolder as string) || null, mosaAssetId, altText: String(shape?.props?.altText || record.props?.name || "Cowart image"), ratio: ratioFromShape(shape) });
    }
  }
  return candidates;
}

function parseCowartAssetUrl(value: unknown, expectedPageDir: string): { pageDir: string; fileName: string } | null {
  const match = /^\/page-assets\/([^/]+)\/([^/]+)$/.exec(String(value || ""));
  if (!match) return null;
  const pageDir = decodeURIComponent(match[1]); const fileName = basename(decodeURIComponent(match[2]));
  if (pageDir !== expectedPageDir || !fileName) return null;
  return { pageDir, fileName };
}

function ratioFromShape(shape: CanvasStoreRecord | null): string {
  const width = Math.round(Number(shape?.props?.w)); const height = Math.round(Number(shape?.props?.h));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "";
  const divisor = gcd(width, height); return `${width / divisor}:${height / divisor}`;
}

function gcd(left: number, right: number): number { let a = Math.abs(left); let b = Math.abs(right); while (b) [a, b] = [b, a % b]; return a || 1; }
function isSafeChildPath(parent: string, child: string): boolean { const p = relative(parent, child); return Boolean(p) && !p.startsWith("..") && !p.includes(`..${sep}`) && !isAbsolute(p); }
function isAutomaticImportSuppressed(error: unknown): boolean { return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "AUTOMATIC_IMPORT_SUPPRESSED"); }
function isAutomaticIngestDuplicate(error: unknown): boolean { return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "AUTOMATIC_INGEST_DUPLICATE"); }
function automaticDuplicateReason(error: unknown): string { return (error as { identityKind?: unknown })?.identityKind === "pixel" ? "already-archived-same-pixels" : "already-archived-same-content"; }
