import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PIXEL_HASH_VERSION, safePixelDigest } from "./image-pixel-hash.js";
import { resolveSourceLocations } from "./source-locations.js";

const IMAGE_EXTENSIONS = new Set([".apng", ".avif", ".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp"]);
const DEFAULT_PROJECT_ID = "default";
interface ImageCandidate { imagePath: string; taskId: string | null; fileName: string; fileStem: string; fileStat: Stats; generatedAt: string; }
interface TaskMetadataEntry { taskId: string; fallback: GenerationMetadata; imagePrompts: Map<string, GenerationMetadata>; }
interface CachedTaskMetadata { mtimeMs: number; size: number; metadata: TaskMetadataEntry; }
interface GenerationMetadata { taskId: string; prompt: string; promptStatus: string; sessionPath: string | null; sessionUpdatedAt: string | null; callId: string | null; generatedAt: string | null; model: string | null; }
interface ImageInfo { width: number | null; height: number | null; ratio: string; mimeType: string; bytes: number; }
interface StoredAsset {
  id: string;
  project_id: string;
  prompt?: string;
  theme?: string;
  source?: Record<string, unknown>;
  business_fields?: Record<string, unknown>;
  image_path?: string;
  [key: string]: unknown;
}
interface Store { createAsset(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<StoredAsset>; listAssets(filters: Record<string, unknown>): Promise<StoredAsset[]>; findAssetBySourcePath?(projectId: string, sourcePath: string): Promise<StoredAsset | null>; findAssetByContentHash?(projectId: string, contentHash: string): Promise<StoredAsset | null>; findAssetByPixelHash?(projectId: string, pixelHash: string): Promise<StoredAsset | null>; updateMetadata(projectId: string, assetId: string, metadata: Record<string, unknown>): Promise<void>; codexImagesDir: string; [key: string]: unknown; }
interface BridgeStatus { imagesDir: string; sessionsDir: string; enabled: boolean; watching: boolean; polling: boolean; busy: boolean; lastScanAt: string | null; lastImportedAt: string | null; lastImportCount: number; totalImported: number; lastSkippedCount: number; lastError: string | null; }
interface ReconcileResult { imported: unknown[]; skipped: Array<{ path: string; reason: string; error?: string }>; updated?: string[]; candidates: number; queued?: boolean; }
interface Bridge { start(): Promise<BridgeStatus>; stop(): Promise<void>; reconcile(): Promise<ReconcileResult>; scheduleReconcile(): void; status(): BridgeStatus; }

export function createCodexImageBridge(options: { store?: Store; imagesDir?: string; sessionsDir?: string; projectId?: string; debounceMs?: number; pollIntervalMs?: number; } = {}): Bridge {
  const store = options.store;
  if (!store || typeof store.createAsset !== "function" || typeof store.listAssets !== "function") throw new Error("Codex image bridge requires a MOSA store.");
  const imagesDir = resolve(options.imagesDir || store.codexImagesDir);
  const { codexSessionsDir: sessionsDir } = resolveSourceLocations({
    overrides: { codexSessionsDir: options.sessionsDir },
  });
  const projectId = options.projectId || DEFAULT_PROJECT_ID;
  const debounceMs = options.debounceMs != null && Number.isFinite(options.debounceMs) ? Math.max(0, options.debounceMs) : 500;
  const pollIntervalMs = options.pollIntervalMs != null && Number.isFinite(options.pollIntervalMs) ? Math.max(250, options.pollIntervalMs) : 30000;
  const processedSignatures = new Map<string, string>();
  const sessionPathCache = new Map<string, string>();
  const sessionMetadataCache = new Map<string, CachedTaskMetadata>();
  let watcher: FSWatcher | null = null; let poller: ReturnType<typeof setInterval> | null = null; let timer: ReturnType<typeof setTimeout> | null = null;
  let enabled = false; let reconciling = false; let reconcileAgain = false;
  let activeReconcile: Promise<ReconcileResult> | null = null; let stopPromise: Promise<void> | null = null;
  const state: Omit<BridgeStatus, "watching" | "polling" | "busy"> = { imagesDir, sessionsDir, enabled: false, lastScanAt: null, lastImportedAt: null, lastImportCount: 0, totalImported: 0, lastSkippedCount: 0, lastError: null };
  async function reconcile(): Promise<ReconcileResult> {
    if (!enabled) return { imported: [], skipped: [], queued: true, candidates: 0 };
    if (reconciling) { reconcileAgain = true; return { imported: [], skipped: [], queued: true, candidates: 0 }; }
    reconciling = true;
    const run = (async (): Promise<ReconcileResult> => {
      try { const result = await reconcileCodexGeneratedImages({ store: store!, imagesDir, sessionsDir, projectId, processedSignatures, sessionPathCache, sessionMetadataCache }); state.lastScanAt = new Date().toISOString(); state.lastImportCount = result.imported.length; state.lastSkippedCount = result.skipped.length; state.totalImported += result.imported.length; state.lastError = null; if (result.imported.length > 0) state.lastImportedAt = state.lastScanAt; return result; } catch (error) { state.lastScanAt = new Date().toISOString(); state.lastError = error instanceof Error ? error.message : String(error); throw error; } finally { reconciling = false; activeReconcile = null; if (reconcileAgain && enabled) { reconcileAgain = false; scheduleReconcile(); } else reconcileAgain = false; }
    })();
    activeReconcile = run;
    return run;
  }
  function scheduleReconcile(): void { if (!enabled) return; if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; if (enabled) reconcile().catch(() => {}); }, debounceMs); }
  async function start(): Promise<BridgeStatus> { if (enabled) return apiStatus(); enabled = true; state.enabled = true; try { await mkdir(imagesDir, { recursive: true }); if (!enabled) return apiStatus(); await reconcile(); if (!enabled) return apiStatus(); try { watcher = watch(imagesDir, { recursive: true }, () => scheduleReconcile()); watcher.on("error", () => { watcher?.close(); watcher = null; }); } catch { watcher = null; } if (!enabled) { watcher?.close(); watcher = null; return apiStatus(); } poller = setInterval(() => { if (enabled) reconcile().catch(() => {}); }, pollIntervalMs); return apiStatus(); } catch (error) { enabled = false; state.enabled = false; throw error; } }
  function stop(): Promise<void> { if (stopPromise) return stopPromise; enabled = false; state.enabled = false; reconcileAgain = false; if (timer) clearTimeout(timer); timer = null; if (poller) clearInterval(poller); poller = null; watcher?.close(); watcher = null; const currentReconcile = activeReconcile; stopPromise = Promise.resolve(currentReconcile).catch(() => {}).then(() => {}).finally(() => { stopPromise = null; }); return stopPromise; }
  function apiStatus(): BridgeStatus { return { ...state, watching: Boolean(watcher), polling: Boolean(poller), busy: reconciling || reconcileAgain || Boolean(timer) }; }
  return { start, stop, reconcile, scheduleReconcile, status: apiStatus };
}

export async function reconcileCodexGeneratedImages(options: { store: Store; imagesDir?: string; sessionsDir?: string; projectId?: string; knownHashes?: Set<string> | null; processedSignatures?: Map<string, string> | null; sessionPathCache?: Map<string, string> | null; sessionMetadataCache?: Map<string, CachedTaskMetadata> | null; }): Promise<ReconcileResult> {
  const { store, imagesDir: imagesDirOpt, sessionsDir: sessionsDirOpt, projectId = DEFAULT_PROJECT_ID, knownHashes: knownHashesOpt, processedSignatures = null, sessionPathCache = null, sessionMetadataCache = null } = options;
  const root = resolve(imagesDirOpt || store.codexImagesDir);
  const candidates = await readCodexImageCandidates(root);
  if (processedSignatures) pruneProcessedSignatures(processedSignatures, candidates.map((candidate) => candidate.imagePath));
  const { codexSessionsDir: sessionsDir } = resolveSourceLocations({
    overrides: { codexSessionsDir: sessionsDirOpt },
  });
  const lookup = createBridgeAssetLookup(store, projectId);
  const contentHashes = knownHashesOpt || new Set<string>();
  const taskIds = new Set(candidates.map((c) => c.taskId).filter(Boolean) as string[]);
  pruneCodexSessionCaches(taskIds, sessionPathCache, sessionMetadataCache);
  const taskMetadata = await readCodexTaskMetadata(sessionsDir, taskIds, sessionPathCache, sessionMetadataCache);
  const imported: unknown[] = []; const skipped: Array<{ path: string; reason: string; error?: string }> = []; const updated: string[] = [];
  for (const candidate of candidates) {
    const task = taskMetadata.get(candidate.taskId || "") || emptyTaskMetadata(candidate.taskId || "");
    const generation = metadataForCandidate(task, candidate);
    const signature = candidateSignature(candidate, generation);
    if (processedSignatures?.get(candidate.imagePath) === signature) {
      skipped.push({ path: candidate.imagePath, reason: "unchanged" });
      continue;
    }
    const existingAtPath = await lookup.bySourcePath(candidate.imagePath);
    if (existingAtPath) {
      if (await upgradeGenerationMetadata(store, existingAtPath, generation)) updated.push(existingAtPath.id);
      skipped.push({ path: candidate.imagePath, reason: "already-archived" });
      processedSignatures?.set(candidate.imagePath, signature);
      continue;
    }
    let contentHash: string; try { contentHash = await sha256File(candidate.imagePath); } catch (error) { skipped.push({ path: candidate.imagePath, reason: "not-ready", error: error instanceof Error ? error.message : String(error) }); continue; }
    const existingByContent = contentHashes.has(contentHash) ? true : await lookup.byContentHash(contentHash);
    if (existingByContent) { skipped.push({ path: candidate.imagePath, reason: "already-archived-same-content" }); contentHashes.add(contentHash); processedSignatures?.set(candidate.imagePath, signature); continue; }
    const pixelHash = extname(candidate.imagePath).toLowerCase() === ".svg" ? "" : await safePixelDigest(candidate.imagePath).catch(() => "");
    if (pixelHash && await lookup.byPixelHash(pixelHash)) { skipped.push({ path: candidate.imagePath, reason: "already-archived-same-pixels" }); processedSignatures?.set(candidate.imagePath, signature); continue; }
    const imageInfo = await readImageInfo(candidate.imagePath, candidate.fileStat);
    try { const asset = await createAutomaticAssetWithCollisionFallback(store, { projectId, imagePath: candidate.imagePath, asset: candidate.fileName, assetId: `codex-${candidate.taskId || "image"}-${candidate.fileStem}`, prompt: generation.prompt, skill: "Codex automatic archive", ratio: imageInfo.ratio, theme: promptTheme(String(generation.prompt || "")), tags: ["codex", "auto-archived"], created_at: candidate.generatedAt, sourceType: "codex-generated", business_fields: { auto_archived: true, prompt_status: generation.promptStatus, file_bytes: candidate.fileStat.size, width: imageInfo.width, height: imageInfo.height, mime_type: imageInfo.mimeType }, source: { generation_tool: "codex-imagegen", codex_image_path: candidate.imagePath, codex_task_id: candidate.taskId || null, codex_output_file: candidate.fileName, codex_generated_at: candidate.generatedAt, codex_session_path: generation.sessionPath, codex_session_updated_at: generation.sessionUpdatedAt, codex_image_generation_call_id: generation.callId, codex_image_generated_at: generation.generatedAt, model: generation.model, prompt_status: generation.promptStatus, content_sha256: contentHash, pixel_sha256: pixelHash || null, pixel_hash_version: pixelHash ? PIXEL_HASH_VERSION : null, image_metadata: imageInfo } }, { trustedSourceRoots: [root], ingestMode: "automatic" }); lookup.remember(asset); contentHashes.add(contentHash); processedSignatures?.set(candidate.imagePath, signature); imported.push(asset); } catch (error) { if (isAutomaticImportSuppressed(error)) { skipped.push({ path: candidate.imagePath, reason: "suppressed-after-delete" }); processedSignatures?.set(candidate.imagePath, signature); } else if (isAutomaticIngestDuplicate(error)) { skipped.push({ path: candidate.imagePath, reason: automaticDuplicateReason(error) }); processedSignatures?.set(candidate.imagePath, signature); } else skipped.push({ path: candidate.imagePath, reason: "import-failed", error: error instanceof Error ? error.message : String(error) }); }
  }
  return { imported, skipped, updated, candidates: candidates.length };
}

async function readCodexImageCandidates(imagesDir: string): Promise<ImageCandidate[]> {
  const files = await walkFiles(imagesDir); const candidates: ImageCandidate[] = [];
  for (const imagePath of files) { if (!IMAGE_EXTENSIONS.has(extname(imagePath).toLowerCase()) || !isSafeChildPath(imagesDir, imagePath)) continue; let fileStat: Stats; try { fileStat = await stat(imagePath); } catch { continue; } if (!fileStat.isFile()) continue; const relativePath = relative(imagesDir, imagePath); const [taskId] = relativePath.split(sep); const fileName = basename(imagePath); candidates.push({ imagePath, taskId: taskId || null, fileName, fileStem: fileName.replace(/\.[^.]+$/, ""), fileStat, generatedAt: fileStat.birthtime.toISOString?.() || fileStat.mtime.toISOString() }); }
  return candidates.sort((l, r) => l.generatedAt.localeCompare(r.generatedAt));
}

function createBridgeAssetLookup(store: Store, projectId: string) {
  let fallbackAssets: Promise<StoredAsset[]> | null = null;
  const listed = () => fallbackAssets ||= Promise.all([store.listAssets({ projectId }), store.listAssets({ projectId, archived: true })]).then(([active, archived]) => [...active, ...archived]);
  const remembered: StoredAsset[] = [];
  return {
    async bySourcePath(path: string) {
      const direct = typeof store.findAssetBySourcePath === "function" ? await store.findAssetBySourcePath(projectId, path) : null;
      if (direct) return direct;
      const resolved = resolve(path);
      const local = remembered.find((asset) => [asset.source?.path, asset.source?.codex_image_path].some((value) => typeof value === "string" && resolve(value) === resolved));
      if (local) return local;
      if (typeof store.findAssetBySourcePath === "function") return null;
      return (await listed()).find((asset) => [asset.source?.path, asset.source?.codex_image_path].some((value) => typeof value === "string" && resolve(value) === resolved)) || null;
    },
    async byContentHash(hash: string) {
      const local = remembered.find((asset) => asset.source?.content_sha256 === hash);
      if (local) return local;
      if (typeof store.findAssetByContentHash === "function") return store.findAssetByContentHash(projectId, hash);
      return (await listed()).find((asset) => asset.source?.content_sha256 === hash) || null;
    },
    async byPixelHash(hash: string) {
      const local = remembered.find((asset) => asset.source?.pixel_hash_version === PIXEL_HASH_VERSION && asset.source?.pixel_sha256 === hash);
      if (local) return local;
      if (typeof store.findAssetByPixelHash === "function") return store.findAssetByPixelHash(projectId, hash);
      return (await listed()).find((asset) => asset.source?.pixel_hash_version === PIXEL_HASH_VERSION && asset.source?.pixel_sha256 === hash) || null;
    },
    remember(asset: StoredAsset) { remembered.push(asset); },
  };
}

async function upgradeGenerationMetadata(store: Store, asset: StoredAsset, generation: GenerationMetadata): Promise<boolean> {
  if (generation.promptStatus !== "image-generation-revised-prompt") return false;

  const nextTheme = promptTheme(generation.prompt);
  const promptChanged = asset.prompt !== generation.prompt;
  const themeChanged = Boolean(nextTheme) && asset.theme !== nextTheme;
  const nextSource: Record<string, unknown> = {
    ...(asset.source || {}),
    codex_session_path: generation.sessionPath || asset.source?.codex_session_path || null,
    codex_image_generation_call_id: generation.callId || asset.source?.codex_image_generation_call_id || null,
    codex_image_generated_at: generation.generatedAt || asset.source?.codex_image_generated_at || null,
    model: generation.model || asset.source?.model || null,
    prompt_status: generation.promptStatus,
  };
  const sourceChanged = [
    "codex_session_path",
    "codex_image_generation_call_id",
    "codex_image_generated_at",
    "model",
    "prompt_status",
  ].some((key) => asset.source?.[key] !== nextSource[key]);
  const businessStatusChanged = asset.business_fields?.prompt_status !== generation.promptStatus;
  if (!promptChanged && !themeChanged && !sourceChanged && !businessStatusChanged) return false;

  // Session mtime is provenance, not business identity. Record the freshest
  // value only when a real prompt/call/model/provenance upgrade already
  // warrants a write; mtime churn alone must never create a library revision.
  if (generation.sessionUpdatedAt) nextSource.codex_session_updated_at = generation.sessionUpdatedAt;

  await store.updateMetadata(asset.project_id, asset.id, {
    ...(promptChanged ? { prompt: generation.prompt } : {}),
    ...(themeChanged ? { theme: nextTheme } : {}),
    business_fields: {
      ...(asset.business_fields || {}),
      prompt_status: generation.promptStatus,
    },
    source: nextSource,
  });
  return true;
}

function metadataForCandidate(task: TaskMetadataEntry, candidate: ImageCandidate): GenerationMetadata { return task.imagePrompts.get(candidate.imagePath) || task.fallback; }
function candidateSignature(candidate: ImageCandidate, generation: GenerationMetadata): string {
  return [candidate.fileStat.size, candidate.fileStat.mtimeMs, generation.promptStatus, generation.sessionPath || "", generation.callId || "", generation.generatedAt || "", generation.model || "", generation.prompt].join("\u001f");
}
function pruneProcessedSignatures(cache: Map<string, string>, livePaths: string[]): void {
  const live = new Set(livePaths);
  for (const path of cache.keys()) if (!live.has(path)) cache.delete(path);
}
function promptTheme(prompt: string): string { const match = /^Asset type:\s*(.+)$/mi.exec(String(prompt || "")); return match?.[1]?.trim() || ""; }

function pruneCodexSessionCaches(taskIds: Set<string>, sessionPathCache: Map<string, string> | null, sessionMetadataCache: Map<string, CachedTaskMetadata> | null): void {
  if (!sessionPathCache) return;
  const livePaths = new Set<string>();
  for (const [taskId, sessionPath] of sessionPathCache) {
    if (!taskIds.has(taskId)) sessionPathCache.delete(taskId);
    else livePaths.add(sessionPath);
  }
  if (sessionMetadataCache) {
    for (const sessionPath of sessionMetadataCache.keys()) if (!livePaths.has(sessionPath)) sessionMetadataCache.delete(sessionPath);
  }
}

async function findCodexSessionPaths(sessionsDir: string, taskIds: Set<string>): Promise<Map<string, string>> {
  const matching = new Map<string, string>();
  if (!taskIds.size) return matching;
  const sessionFiles = await walkFiles(sessionsDir);
  for (const filePath of sessionFiles) {
    const match = /([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.jsonl$/i.exec(filePath);
    if (match && taskIds.has(match[1])) matching.set(match[1], filePath);
    if (matching.size === taskIds.size) break;
  }
  return matching;
}

async function readCodexTaskMetadata(sessionsDir: string, taskIds: Set<string>, sessionPathCache: Map<string, string> | null = null, sessionMetadataCache: Map<string, CachedTaskMetadata> | null = null): Promise<Map<string, TaskMetadataEntry>> {
  const result = new Map<string, TaskMetadataEntry>(); if (!taskIds.size) return result;
  const matching = new Map<string, string>();
  const unresolved = new Set<string>();
  for (const taskId of taskIds) {
    const cachedPath = sessionPathCache?.get(taskId);
    if (cachedPath) matching.set(taskId, cachedPath);
    else unresolved.add(taskId);
  }
  if (unresolved.size) {
    const discovered = await findCodexSessionPaths(sessionsDir, unresolved);
    for (const [taskId, sessionPath] of discovered) {
      matching.set(taskId, sessionPath);
      sessionPathCache?.set(taskId, sessionPath);
    }
  }
  await Promise.all([...taskIds].map(async (taskId) => {
    const sessionPath = matching.get(taskId);
    const metadata = await readTaskMetadataFile(taskId, sessionPath, sessionMetadataCache);
    if (sessionPath && metadata.fallback.sessionPath === null) {
      sessionPathCache?.delete(taskId);
      sessionMetadataCache?.delete(sessionPath);
    }
    result.set(taskId, metadata);
  }));
  return result;
}

async function readTaskMetadataFile(taskId: string, sessionPath: string | undefined, sessionMetadataCache: Map<string, CachedTaskMetadata> | null = null): Promise<TaskMetadataEntry> {
  if (!sessionPath) return emptyTaskMetadata(taskId);
  try {
    const sessionStat = await stat(sessionPath);
    const cached = sessionMetadataCache?.get(sessionPath);
    if (cached?.mtimeMs === sessionStat.mtimeMs && cached?.size === sessionStat.size) return cached.metadata;
    const raw = await readFile(sessionPath, "utf8"); const userTexts: string[] = []; const imagePrompts = new Map<string, GenerationMetadata>(); let currentModel: string | null = null;
    for (const line of raw.split("\n")) { if (!line) continue; let event: Record<string, unknown>; try { event = JSON.parse(line); } catch { continue; }
      const turnContext = event?.type === "turn_context" ? event.payload as Record<string, unknown> | null : null; if (turnContext) { currentModel = String(turnContext.model || "").trim() || currentModel; continue; }
      const generatedImage = event?.type === "event_msg" && (event.payload as Record<string, unknown>)?.type === "image_generation_end" ? event.payload as Record<string, unknown> : null;
      if (generatedImage) { const imagePath = typeof generatedImage.saved_path === "string" ? resolve(generatedImage.saved_path) : null; const prompt = String(generatedImage.revised_prompt || "").trim(); if (imagePath && prompt) { imagePrompts.set(imagePath, { taskId, prompt, promptStatus: "image-generation-revised-prompt", sessionPath, sessionUpdatedAt: sessionStat.mtime.toISOString(), callId: String(generatedImage.call_id || "") || null, generatedAt: String(event.timestamp || "") || null, model: currentModel }); } continue; }
      const message = event?.type === "response_item" && (event.payload as Record<string, unknown>)?.type === "message" && (event.payload as Record<string, unknown>)?.role === "user" ? event.payload as Record<string, unknown> : null; if (!message) continue;
      for (const part of (message.content as Array<Record<string, unknown>>) || []) { const text = String(part?.text || "").trim(); if (part?.type === "input_text" && isUserPrompt(text)) userTexts.push(text); }
    }
    const fallback: GenerationMetadata = { taskId, prompt: userTexts.at(-1) || "", promptStatus: userTexts.length ? "task-user-prompt" : "not-available-in-session", sessionPath, sessionUpdatedAt: sessionStat.mtime.toISOString(), callId: null, generatedAt: null, model: null };
    const metadata = { taskId, fallback, imagePrompts };
    sessionMetadataCache?.set(sessionPath, { mtimeMs: sessionStat.mtimeMs, size: sessionStat.size, metadata });
    return metadata;
  } catch { return emptyTaskMetadata(taskId); }
}

function isUserPrompt(text: string): boolean { return Boolean(text) && text.length <= 12000 && !text.startsWith("<") && !text.startsWith("# AGENTS.md instructions") && !text.startsWith("<environment_context>") && !text.startsWith("<recommended_plugins>"); }
function emptyTaskMetadata(taskId: string): TaskMetadataEntry { return { taskId, fallback: { taskId, prompt: "", promptStatus: "not-available", sessionPath: null, sessionUpdatedAt: null, callId: null, generatedAt: null, model: null }, imagePrompts: new Map() }; }

async function readImageInfo(imagePath: string, fileStat: Stats): Promise<ImageInfo> {
  const extension = extname(imagePath).toLowerCase(); const imageInfo: ImageInfo = { width: null, height: null, ratio: "", mimeType: mimeTypeForExtension(extension), bytes: fileStat.size };
  try { const buffer = await readFile(imagePath); if (extension === ".png" && buffer.length >= 24 && buffer.subarray(1, 4).toString("ascii") === "PNG") { imageInfo.width = buffer.readUInt32BE(16); imageInfo.height = buffer.readUInt32BE(20); } else if (extension === ".gif" && buffer.length >= 10) { imageInfo.width = buffer.readUInt16LE(6); imageInfo.height = buffer.readUInt16LE(8); } imageInfo.ratio = ratioFromDimensions(imageInfo.width ?? 0, imageInfo.height ?? 0); } catch {}
  return imageInfo;
}

function ratioFromDimensions(width: number | null, height: number | null): string { if (!Number.isFinite(width) || !Number.isFinite(height) || width! <= 0 || height! <= 0) return ""; const d = gcd(width!, height!); return `${width! / d}:${height! / d}`; }
function gcd(l: number, r: number): number { let a = Math.abs(l); let b = Math.abs(r); while (b) [a, b] = [b, a % b]; return a || 1; }
function mimeTypeForExtension(ext: string): string { return ({ ".apng": "image/apng", ".avif": "image/avif", ".gif": "image/gif", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp" } as Record<string, string>)[ext] || "application/octet-stream"; }
async function walkFiles(root: string): Promise<string[]> { let entries; try { entries = await readdir(root, { withFileTypes: true }); } catch (error: unknown) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return []; throw error; } const files: string[] = []; for (const entry of entries) { const entryPath = join(root, entry.name); if (entry.isDirectory()) files.push(...await walkFiles(entryPath)); else if (entry.isFile()) files.push(entryPath); } return files; }
export async function sha256File(filePath: string): Promise<string> { return createHash("sha256").update(await readFile(filePath)).digest("hex"); }
function isSafeChildPath(parent: string, child: string): boolean { const p = relative(parent, child); return Boolean(p) && !p.startsWith("..") && !p.includes(`..${sep}`) && !isAbsolute(p); }
function isAutomaticImportSuppressed(error: unknown): boolean { return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "AUTOMATIC_IMPORT_SUPPRESSED"); }
function isAutomaticIngestDuplicate(error: unknown): boolean { return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "AUTOMATIC_INGEST_DUPLICATE"); }
function automaticDuplicateReason(error: unknown): string { return (error as { identityKind?: unknown })?.identityKind === "pixel" ? "already-archived-same-pixels" : "already-archived-same-content"; }
async function createAutomaticAssetWithCollisionFallback(store: Store, input: Record<string, unknown>, options: Record<string, unknown>): Promise<StoredAsset> {
  try {
    return await store.createAsset(input, options);
  } catch (error) {
    if (!error || typeof error !== "object" || (error as { code?: unknown }).code !== "ASSET_ALREADY_EXISTS") throw error;
    const baseId = String(input.assetId || "codex-image").slice(0, 140);
    return store.createAsset({ ...input, assetId: `${baseId}-${randomUUID().slice(0, 8)}` }, options);
  }
}
