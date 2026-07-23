import { createHash } from "node:crypto";
import { createReadStream, watch } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

const IMAGE_EXTENSIONS = new Set([".apng", ".avif", ".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".m4v", ".mov", ".mp4", ".webm"]);
const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);
const MEDIA_TOOLS = new Set(["image_gen", "image_edit", "image_to_video", "reference_to_video"]);
const MEDIA_FOLDERS = new Set(["images", "videos"]);
const DEFAULT_PROJECT_ID = "default";
const SESSION_ID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PROMPT_RANK = {
  "not-available": 0,
  "session-user-prompt": 1,
  "generation-tool-prompt": 2,
};

/**
 * Watches the local Grok Build CLI sessions root and archives generated images
 * and videos with their tool prompts when chat_history metadata is available.
 * Discovery is confined to GROK_SESSIONS_DIR (default ~/.grok/sessions).
 */
export function createGrokMediaBridge(options = {}) {
  const store = options.store;
  if (!store || typeof store.createAsset !== "function" || typeof store.listAssets !== "function") {
    throw new Error("Grok media bridge requires a MOSA store.");
  }

  const sessionsDir = resolve(options.sessionsDir || process.env.GROK_SESSIONS_DIR || join(homedir(), ".grok", "sessions"));
  const projectId = options.projectId || DEFAULT_PROJECT_ID;
  const debounceMs = Number.isFinite(options.debounceMs) ? Math.max(0, options.debounceMs) : 500;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? Math.max(250, options.pollIntervalMs) : 2500;
  let watcher = null;
  let poller = null;
  let timer = null;
  let reconciling = false;
  let reconcileAgain = false;
  let knownHashes = null;
  const state = {
    sessionsDir,
    enabled: false,
    lastScanAt: null,
    lastImportedAt: null,
    lastImportCount: 0,
    totalImported: 0,
    lastSkippedCount: 0,
    lastError: null,
    lastWarning: null,
  };

  async function reconcile() {
    if (reconciling) {
      reconcileAgain = true;
      return { imported: [], skipped: [], queued: true };
    }
    reconciling = true;
    try {
      if (!knownHashes) knownHashes = await existingContentHashes(store, projectId);
      const result = await reconcileGrokMedia({ store, sessionsDir, projectId, knownHashes });
      state.lastScanAt = new Date().toISOString();
      state.lastImportCount = result.imported.length;
      state.lastSkippedCount = result.skipped.length;
      state.totalImported += result.imported.length;
      state.lastError = null;
      state.lastWarning = result.warnings?.length ? result.warnings.slice(0, 5).join("; ") : null;
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
    await mkdir(sessionsDir, { recursive: true });
    await reconcile();
    try {
      watcher = watch(sessionsDir, { recursive: true }, () => scheduleReconcile());
      watcher.on("error", () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      watcher = null;
    }
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

export async function reconcileGrokMedia({ store, sessionsDir, projectId = DEFAULT_PROJECT_ID, knownHashes = null }) {
  const root = resolve(sessionsDir);
  let rootReal;
  try {
    rootReal = await realpath(root);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { imported: [], skipped: [], updated: [], candidates: 0, warnings: [] };
    }
    throw error;
  }

  const { candidates, skipped: discoverySkipped } = await readGrokMediaCandidates(root, rootReal);
  const [activeAssets, archivedAssets] = await Promise.all([
    store.listAssets({ projectId }),
    store.listAssets({ projectId, archived: true }),
  ]);
  const allAssets = [...activeAssets, ...archivedAssets];
  const knownPaths = new Set();
  const assetsBySourcePath = new Map();
  const assetsByContentHash = new Map();
  for (const asset of allAssets) {
    for (const path of [asset.source?.path, asset.source?.grok_media_path].filter(Boolean)) {
      const resolved = resolve(path);
      knownPaths.add(resolved);
      assetsBySourcePath.set(resolved, asset);
    }
    if (asset.source?.content_sha256) assetsByContentHash.set(asset.source.content_sha256, asset);
  }
  const contentHashes = knownHashes || await existingContentHashes(store, projectId, allAssets);
  const sessionIds = new Set(candidates.map((candidate) => candidate.sessionId).filter(Boolean));
  const { sessions: sessionMetadata, warnings } = await readGrokSessionMetadata(rootReal, sessionIds, candidates);
  const imported = [];
  const skipped = [...discoverySkipped];
  const updated = [];

  for (const candidate of candidates) {
    if (!(await isCanonicalChildPath(rootReal, candidate.mediaPath))) {
      skipped.push({ path: candidate.mediaPath, reason: "out-of-root" });
      continue;
    }
    const generation = metadataForCandidate(sessionMetadata.get(candidate.sessionId), candidate);
    if (knownPaths.has(candidate.mediaPath)) {
      const existingAsset = assetsBySourcePath.get(candidate.mediaPath);
      if (existingAsset && await upgradeGenerationMetadata(store, existingAsset, generation, candidate)) {
        updated.push(existingAsset.id);
      }
      skipped.push({ path: candidate.mediaPath, reason: "already-archived" });
      continue;
    }

    let contentHash;
    try {
      contentHash = await sha256File(candidate.mediaPath);
    } catch (error) {
      skipped.push({
        path: candidate.mediaPath,
        reason: "not-ready",
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (contentHashes.has(contentHash)) {
      const existingAsset = assetsByContentHash.get(contentHash)
        || [...assetsBySourcePath.values()].find((asset) => asset.source?.content_sha256 === contentHash);
      if (existingAsset && await upgradeGenerationMetadata(store, existingAsset, generation, candidate)) {
        updated.push(existingAsset.id);
        assetsBySourcePath.set(candidate.mediaPath, existingAsset);
      }
      skipped.push({ path: candidate.mediaPath, reason: "already-archived-same-content" });
      knownPaths.add(candidate.mediaPath);
      continue;
    }

    const mediaInfo = await readMediaInfo(candidate.mediaPath, candidate.fileStat, candidate.mediaKind);
    try {
      const asset = await store.createAsset(
        {
          projectId,
          imagePath: candidate.mediaPath,
          asset: candidate.fileName,
          assetId: buildGrokAssetId(candidate),
          prompt: generation.prompt,
          skill: "Grok automatic archive",
          ratio: mediaInfo.ratio || generation.aspectRatio || "",
          theme: promptTheme(generation.prompt),
          tags: ["grok", "auto-archived", candidate.mediaKind],
          created_at: candidate.generatedAt,
          sourceType: "grok-generated",
          business_fields: {
            auto_archived: true,
            media_kind: candidate.mediaKind,
            prompt_status: generation.promptStatus,
            file_bytes: candidate.fileStat.size,
            width: mediaInfo.width,
            height: mediaInfo.height,
            mime_type: mediaInfo.mimeType,
          },
          source: {
            generation_tool: generation.toolName || `grok-${candidate.mediaKind}`,
            media_kind: candidate.mediaKind,
            grok_media_path: candidate.mediaPath,
            grok_session_id: candidate.sessionId || null,
            grok_session_path: generation.sessionPath || candidate.sessionPath || null,
            grok_session_folder: candidate.mediaFolder,
            grok_output_file: candidate.fileName,
            grok_generated_at: candidate.generatedAt,
            grok_tool_call_id: generation.callId,
            model: generation.model,
            prompt_status: generation.promptStatus,
            content_sha256: contentHash,
            media_metadata: mediaInfo,
          },
        },
        { trustedSourceRoots: [rootReal] },
      );
      knownPaths.add(candidate.mediaPath);
      contentHashes.add(contentHash);
      assetsBySourcePath.set(candidate.mediaPath, asset);
      assetsByContentHash.set(contentHash, asset);
      imported.push(asset);
    } catch (error) {
      skipped.push({
        path: candidate.mediaPath,
        reason: "import-failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { imported, skipped, updated, candidates: candidates.length, warnings };
}

export function buildGrokAssetId(candidate) {
  const sessionId = String(candidate.sessionId || "session").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40);
  const mediaKind = candidate.mediaKind === "video" ? "video" : "image";
  // Stable identity comes from the canonical relative path under the sessions root
  // (or a session-local media key), not from a truncated normalized basename alone.
  const pathKey = String(
    candidate.relativePath
    || (candidate.sessionId && candidate.mediaFolder && candidate.fileName
      ? `${candidate.sessionId}/${candidate.mediaFolder}/${candidate.fileName}`
      : candidate.mediaPath || candidate.fileName || "media"),
  );
  const pathHash = createHash("sha256").update(pathKey).digest("hex").slice(0, 12);
  const fileHint = String(candidate.fileName || candidate.fileStem || "media")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/\./g, "-")
    .slice(0, 24) || "media";
  return `grok-${sessionId}-${mediaKind}-${fileHint}-${pathHash}`.slice(0, 96);
}

export async function readGrokMediaCandidates(sessionsDir, rootReal = null) {
  const root = resolve(sessionsDir);
  const canonicalRoot = rootReal || await realpath(root).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!canonicalRoot) return { candidates: [], skipped: [] };

  const files = await walkFiles(root);
  const candidates = [];
  const skipped = [];
  for (const mediaPath of files) {
    if (!MEDIA_EXTENSIONS.has(extname(mediaPath).toLowerCase())) continue;
    if (!isSafeChildPath(root, mediaPath) && !isSafeChildPath(canonicalRoot, mediaPath)) continue;

    let linkStat;
    try {
      linkStat = await lstat(mediaPath);
    } catch {
      continue;
    }
    if (linkStat.isSymbolicLink()) {
      skipped.push({ path: mediaPath, reason: "symlink-rejected" });
      continue;
    }
    if (!linkStat.isFile() || linkStat.size <= 0) continue;

    let canonicalPath;
    try {
      canonicalPath = await realpath(mediaPath);
    } catch (error) {
      skipped.push({
        path: mediaPath,
        reason: "not-ready",
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!(await isCanonicalChildPath(canonicalRoot, canonicalPath))) {
      skipped.push({ path: mediaPath, reason: "out-of-root", resolvedPath: canonicalPath });
      continue;
    }

    const location = sessionMediaLocation(canonicalRoot, canonicalPath)
      || sessionMediaLocation(root, mediaPath);
    if (!location) continue;

    let fileStat;
    try {
      fileStat = await stat(canonicalPath);
    } catch (error) {
      skipped.push({
        path: mediaPath,
        reason: "not-ready",
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!fileStat.isFile() || fileStat.size <= 0) continue;

    const fileName = basename(canonicalPath);
    candidates.push({
      mediaPath: canonicalPath,
      discoveredPath: mediaPath,
      relativePath: relative(canonicalRoot, canonicalPath),
      sessionId: location.sessionId,
      sessionPath: location.sessionPath,
      mediaFolder: location.mediaFolder,
      mediaKind: location.mediaKind,
      fileName,
      fileStem: fileName.replace(/\.[^.]+$/, ""),
      fileStat,
      generatedAt: fileStat.birthtime?.toISOString?.() || fileStat.mtime.toISOString(),
    });
  }
  return {
    candidates: candidates.sort((left, right) => left.generatedAt.localeCompare(right.generatedAt)),
    skipped,
  };
}

function sessionMediaLocation(sessionsRoot, mediaPath) {
  const relativePath = relative(resolve(sessionsRoot), resolve(mediaPath));
  if (!relativePath || relativePath.startsWith("..") || relativePath.includes(`..${sep}`)) return null;
  const parts = relativePath.split(sep);
  // Expected: <encoded-cwd>/<session-id>/(images|videos)/file
  if (parts.length < 3) return null;
  const mediaFolder = parts[parts.length - 2];
  if (!MEDIA_FOLDERS.has(mediaFolder)) return null;
  const sessionId = parts[parts.length - 3];
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const sessionPath = join(resolve(sessionsRoot), ...parts.slice(0, -2));
  const mediaKind = mediaFolder === "videos" || VIDEO_EXTENSIONS.has(extname(mediaPath).toLowerCase())
    ? "video"
    : "image";
  return { sessionId, sessionPath, mediaFolder, mediaKind };
}

async function existingContentHashes(store, projectId, assets = null) {
  const allAssets = assets || [
    ...(await store.listAssets({ projectId })),
    ...(await store.listAssets({ projectId, archived: true })),
  ];
  const hashes = new Set(allAssets.map((asset) => asset.source?.content_sha256).filter(Boolean));
  for (const asset of allAssets) {
    if (asset.source?.content_sha256 || !asset.image_path) continue;
    try {
      hashes.add(await sha256File(asset.image_path));
    } catch {
      // Missing library copies must not block automatic archiving.
    }
  }
  return hashes;
}

async function upgradeGenerationMetadata(store, asset, generation, candidate = null) {
  const currentRank = PROMPT_RANK[asset.source?.prompt_status] ?? 0;
  const nextRank = PROMPT_RANK[generation.promptStatus] ?? 0;
  const canUpgradePrompt = nextRank > currentRank
    || (nextRank === currentRank && nextRank > 0 && generation.prompt && generation.prompt !== asset.prompt);
  const nextTheme = promptTheme(generation.prompt);
  const promptChanged = canUpgradePrompt && Boolean(generation.prompt) && asset.prompt !== generation.prompt;
  const themeChanged = Boolean(nextTheme) && asset.theme !== nextTheme;

  const nextSource = {
    ...(asset.source || {}),
    grok_session_path: generation.sessionPath || asset.source?.grok_session_path || null,
    grok_tool_call_id: generation.callId || asset.source?.grok_tool_call_id || null,
    model: generation.model || asset.source?.model || null,
    generation_tool: generation.toolName || asset.source?.generation_tool || null,
    media_kind: candidate?.mediaKind || asset.source?.media_kind || null,
  };
  if (canUpgradePrompt && generation.promptStatus) {
    nextSource.prompt_status = generation.promptStatus;
  }
  if (candidate?.mediaPath && !asset.source?.grok_media_path) {
    nextSource.grok_media_path = candidate.mediaPath;
  } else if (candidate?.mediaPath && asset.source?.grok_media_path !== candidate.mediaPath) {
    nextSource.grok_alternate_paths = uniquePaths([
      ...(asset.source?.grok_alternate_paths || []),
      candidate.mediaPath,
    ].filter((path) => path !== asset.source?.grok_media_path && path !== asset.source?.path));
  }

  const sourceChanged = [
    "grok_session_path",
    "grok_tool_call_id",
    "model",
    "generation_tool",
    "prompt_status",
    "grok_media_path",
  ].some((key) => asset.source?.[key] !== nextSource[key])
    || JSON.stringify(asset.source?.grok_alternate_paths || []) !== JSON.stringify(nextSource.grok_alternate_paths || []);

  const businessStatusChanged = canUpgradePrompt
    && generation.promptStatus
    && asset.business_fields?.prompt_status !== generation.promptStatus;

  if (!promptChanged && !themeChanged && !sourceChanged && !businessStatusChanged) return false;

  await store.updateMetadata(asset.project_id, asset.id, {
    ...(promptChanged ? { prompt: generation.prompt } : {}),
    ...(themeChanged ? { theme: nextTheme } : {}),
    business_fields: {
      ...(asset.business_fields || {}),
      ...(businessStatusChanged ? { prompt_status: generation.promptStatus } : {}),
    },
    source: nextSource,
  });
  return true;
}

function uniquePaths(paths) {
  return [...new Set(paths.map((path) => resolve(path)))];
}

function metadataForCandidate(sessionMeta, candidate) {
  if (!sessionMeta) {
    return emptyGenerationMetadata(candidate.sessionId, candidate.sessionPath);
  }
  return sessionMeta.mediaPrompts.get(candidate.mediaPath)
    || sessionMeta.mediaPrompts.get(candidate.discoveredPath)
    || emptyGenerationMetadata(candidate.sessionId, candidate.sessionPath || sessionMeta.sessionPath);
}

function promptTheme(prompt) {
  const text = String(prompt || "").trim();
  if (!text) return "";
  return text.split(/\r?\n/, 1)[0].slice(0, 120);
}

async function readGrokSessionMetadata(sessionsRoot, sessionIds, candidates) {
  const result = new Map();
  const warnings = [];
  if (!sessionIds.size) return { sessions: result, warnings };
  const sessionPaths = new Map();
  for (const candidate of candidates) {
    if (candidate.sessionId && candidate.sessionPath && !sessionPaths.has(candidate.sessionId)) {
      sessionPaths.set(candidate.sessionId, candidate.sessionPath);
    }
  }
  await Promise.all([...sessionIds].map(async (sessionId) => {
    const parsed = await readSessionMetadataFile(sessionId, sessionPaths.get(sessionId), sessionsRoot);
    result.set(sessionId, parsed.metadata);
    warnings.push(...parsed.warnings);
  }));
  return { sessions: result, warnings };
}

async function readSessionMetadataFile(sessionId, sessionPath, sessionsRoot) {
  const warnings = [];
  if (!sessionPath || !isSafeChildPath(sessionsRoot, sessionPath)) {
    return { metadata: emptySessionMetadata(sessionId, null), warnings };
  }
  const chatPath = join(sessionPath, "chat_history.jsonl");
  const summaryPath = join(sessionPath, "summary.json");

  const chatSafe = await openSafeSessionTextFile(chatPath, sessionsRoot, sessionId, "chat_history.jsonl", warnings);
  if (!chatSafe.ok) {
    return { metadata: emptySessionMetadata(sessionId, sessionPath), warnings };
  }
  const summarySafe = await openSafeSessionJsonFile(summaryPath, sessionsRoot, sessionId, "summary.json", warnings);
  // Fail closed: an existing but unsafe summary must not pair with chat provenance.
  // Missing optional summary.json and malformed JSON remain non-fatal.
  if (!summarySafe.ok && isUnsafeSessionFileReason(summarySafe.reason)) {
    return { metadata: emptySessionMetadata(sessionId, sessionPath), warnings };
  }

  const raw = chatSafe.text;
  const chatStat = chatSafe.stat;
  const summary = summarySafe.ok ? summarySafe.value : null;

  const mediaPrompts = new Map();
  const pendingCalls = new Map();
  const unmatchedResults = [];
  let currentModel = summary?.current_model_id || summary?.info?.model || null;
  let latestUserPrompt = "";
  let parseFailures = 0;

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      parseFailures += 1;
      continue;
    }
    if (event?.type === "user") {
      // Capture user text in event order so a later prompt cannot be back-applied
      // to an earlier tool call that had no tool arguments.prompt.
      const text = extractUserPromptText(event);
      if (text) latestUserPrompt = text;
      continue;
    }
    if (event?.type === "assistant") {
      currentModel = String(event.model_id || currentModel || "").trim() || currentModel;
      for (const call of event.tool_calls || []) {
        const name = String(call?.name || "").trim();
        if (!MEDIA_TOOLS.has(name)) continue;
        const callId = String(call?.id || "").trim();
        // Empty tool_call ids are not used as map keys; they cannot be matched safely.
        if (!callId) {
          warnings.push(`session ${sessionId}: skipped media tool call without id`);
          continue;
        }
        const args = parseJsonObject(call.arguments);
        const toolPrompt = String(args.prompt || "").trim();
        pendingCalls.set(callId, {
          toolName: name,
          prompt: toolPrompt,
          // Snapshot the user prompt in force when this call was issued. Never use a
          // session-final user prompt after the fact.
          contextUserPrompt: toolPrompt ? "" : latestUserPrompt,
          aspectRatio: String(args.aspect_ratio || args.aspectRatio || "").trim() || null,
          model: currentModel,
          callId,
        });
      }
      continue;
    }
    if (event?.type !== "tool_result") continue;
    const callId = String(event.tool_call_id || "").trim();
    if (!callId) {
      warnings.push(`session ${sessionId}: skipped tool_result without tool_call_id`);
      continue;
    }
    const pending = pendingCalls.get(callId);
    const result = parseJsonObject(event.content);
    if (typeof result.path !== "string" || !result.path.trim()) continue;

    const resolved = await resolveMediaResultPath(result.path, sessionsRoot);
    if (!resolved.ok) {
      if (resolved.reason === "out-of-root" || resolved.reason === "symlink-rejected") {
        warnings.push(`session ${sessionId}: rejected tool_result path (${resolved.reason})`);
      }
      unmatchedResults.push({ callId, reason: resolved.reason });
      continue;
    }

    const toolPrompt = pending?.prompt || "";
    let prompt = toolPrompt;
    let promptStatus = toolPrompt ? "generation-tool-prompt" : "not-available";
    // Ordered, call-scoped user fallback only: the user text that preceded this
    // specific tool call. Orphan media never receives a user prompt.
    if (!toolPrompt && pending?.contextUserPrompt) {
      prompt = pending.contextUserPrompt;
      promptStatus = "session-user-prompt";
    }

    const entry = {
      sessionId,
      prompt,
      promptStatus,
      sessionPath,
      sessionUpdatedAt: chatStat.mtime.toISOString(),
      callId,
      generatedAt: null,
      model: pending?.model || currentModel,
      toolName: pending?.toolName || null,
      aspectRatio: pending?.aspectRatio || null,
      matched: Boolean(pending),
    };

    const prior = mediaPrompts.get(resolved.path);
    if (prior && prior.promptStatus === "generation-tool-prompt" && entry.promptStatus !== "generation-tool-prompt") {
      // Keep the stronger existing match.
    } else if (prior && prior.callId && prior.callId !== entry.callId && prior.prompt && entry.prompt && prior.prompt !== entry.prompt) {
      warnings.push(`session ${sessionId}: ambiguous tool matches for ${basename(resolved.path)}`);
      mediaPrompts.set(resolved.path, emptyGenerationMetadata(sessionId, sessionPath));
    } else {
      mediaPrompts.set(resolved.path, entry);
    }
    if (pending) pendingCalls.delete(callId);
  }

  if (parseFailures > 0) {
    warnings.push(`session ${sessionId}: ignored ${parseFailures} malformed chat_history line(s)`);
  }
  if (unmatchedResults.some((item) => item.reason === "ambiguous-match")) {
    warnings.push(`session ${sessionId}: one or more tool results were ambiguous and left without prompts`);
  }

  return {
    metadata: {
      sessionId,
      sessionPath,
      mediaPrompts,
    },
    warnings,
  };
}

async function openSafeSessionTextFile(filePath, sessionsRoot, sessionId, label, warnings) {
  const safety = await assertSafeSessionFile(filePath, sessionsRoot);
  if (!safety.ok) {
    if (safety.reason !== "missing") {
      warnings.push(`session ${sessionId}: rejected ${label} (${safety.reason})`);
    }
    return { ok: false, reason: safety.reason };
  }
  try {
    const text = await readFile(safety.path, "utf8");
    const fileStat = await stat(safety.path);
    return { ok: true, text, stat: fileStat, path: safety.path };
  } catch (error) {
    warnings.push(`session ${sessionId}: failed to read ${label} (${error instanceof Error ? error.message : String(error)})`);
    return { ok: false, reason: "read-failed" };
  }
}

async function openSafeSessionJsonFile(filePath, sessionsRoot, sessionId, label, warnings) {
  const safety = await assertSafeSessionFile(filePath, sessionsRoot);
  if (!safety.ok) {
    if (safety.reason !== "missing") {
      warnings.push(`session ${sessionId}: rejected ${label} (${safety.reason})`);
    }
    return { ok: false, reason: safety.reason };
  }
  try {
    return { ok: true, value: JSON.parse(await readFile(safety.path, "utf8")), path: safety.path };
  } catch {
    // Optional summary metadata; a corrupt file should not fail the session.
    return { ok: false, reason: "invalid-json" };
  }
}

async function assertSafeSessionFile(filePath, sessionsRoot) {
  try {
    const linkStat = await lstat(filePath);
    if (linkStat.isSymbolicLink()) return { ok: false, reason: "symlink-rejected" };
    if (!linkStat.isFile()) return { ok: false, reason: "not-a-file" };
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: false, reason: "missing" };
    return { ok: false, reason: "stat-failed" };
  }
  let canonical;
  try {
    canonical = await realpath(filePath);
  } catch {
    return { ok: false, reason: "not-ready" };
  }
  if (!isSafeChildPath(sessionsRoot, canonical)) {
    return { ok: false, reason: "out-of-root" };
  }
  return { ok: true, path: canonical };
}

const UNSAFE_SESSION_FILE_REASONS = new Set([
  "symlink-rejected",
  "out-of-root",
  "not-a-file",
  "stat-failed",
  "not-ready",
]);

function isUnsafeSessionFileReason(reason) {
  return UNSAFE_SESSION_FILE_REASONS.has(String(reason || ""));
}

async function resolveMediaResultPath(rawPath, sessionsRoot) {
  const requested = resolve(String(rawPath));
  try {
    const linkStat = await lstat(requested);
    if (linkStat.isSymbolicLink()) return { ok: false, reason: "symlink-rejected" };
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: false, reason: "missing" };
    return { ok: false, reason: "not-ready", error: error instanceof Error ? error.message : String(error) };
  }
  let canonical;
  try {
    canonical = await realpath(requested);
  } catch (error) {
    return { ok: false, reason: "not-ready", error: error instanceof Error ? error.message : String(error) };
  }
  if (!(await isCanonicalChildPath(sessionsRoot, canonical))) {
    return { ok: false, reason: "out-of-root", path: canonical };
  }
  return { ok: true, path: canonical };
}

function emptySessionMetadata(sessionId, sessionPath) {
  return {
    sessionId,
    sessionPath: sessionPath || null,
    mediaPrompts: new Map(),
  };
}

function emptyGenerationMetadata(sessionId, sessionPath) {
  return {
    sessionId,
    prompt: "",
    promptStatus: "not-available",
    sessionPath: sessionPath || null,
    sessionUpdatedAt: null,
    callId: null,
    generatedAt: null,
    model: null,
    toolName: null,
    aspectRatio: null,
    matched: false,
  };
}

function extractUserPromptText(event) {
  if (event?.synthetic_reason) return "";
  const parts = Array.isArray(event?.content) ? event.content : [];
  const texts = [];
  for (const part of parts) {
    const text = String(part?.text || "").trim();
    if (!text || part?.type !== "text") continue;
    const queryMatch = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i.exec(text);
    const body = (queryMatch?.[1] || text).trim();
    if (isUserPrompt(body)) texts.push(body);
  }
  if (typeof event?.content === "string" && isUserPrompt(event.content.trim())) {
    texts.push(event.content.trim());
  }
  return texts.at(-1) || "";
}

function isUserPrompt(text) {
  return Boolean(text)
    && text.length <= 12000
    && !text.startsWith("<system-reminder>")
    && !text.startsWith("<action_safety>")
    && !text.startsWith("# ");
}

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function readMediaInfo(mediaPath, fileStat, mediaKind) {
  const extension = extname(mediaPath).toLowerCase();
  const info = {
    width: null,
    height: null,
    ratio: "",
    mimeType: mimeTypeForExtension(extension),
    bytes: fileStat.size,
    media_kind: mediaKind,
  };
  if (mediaKind === "video") return info;
  try {
    const buffer = await readFile(mediaPath);
    if (extension === ".png" && buffer.length >= 24 && buffer.subarray(1, 4).toString("ascii") === "PNG") {
      info.width = buffer.readUInt32BE(16);
      info.height = buffer.readUInt32BE(20);
    } else if ((extension === ".jpg" || extension === ".jpeg") && buffer.length > 4) {
      const dims = jpegDimensions(buffer);
      if (dims) {
        info.width = dims.width;
        info.height = dims.height;
      }
    } else if (extension === ".gif" && buffer.length >= 10) {
      info.width = buffer.readUInt16LE(6);
      info.height = buffer.readUInt16LE(8);
    }
    info.ratio = ratioFromDimensions(info.width, info.height);
  } catch {
    // Optional dimensions must never block a valid media import.
  }
  return info;
}

function jpegDimensions(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    const size = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + size;
  }
  return null;
}

function ratioFromDimensions(width, height) {
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

function mimeTypeForExtension(extension) {
  return {
    ".apng": "image/apng",
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".m4v": "video/x-m4v",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
  }[extension] || "application/octet-stream";
}

async function walkFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    // Skip lock files and SQLite indexes at the sessions root.
    if (entry.name.startsWith(".") || entry.name.endsWith(".lock")) continue;
    const entryPath = join(root, entry.name);
    // Never walk through directory symlinks. File symlinks are returned so the
    // candidate scanner can reject them explicitly without following their targets.
    if (entry.isSymbolicLink()) {
      if (!entry.isDirectory()) files.push(entryPath);
      continue;
    }
    if (entry.isDirectory()) files.push(...await walkFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

function isSafeChildPath(parent, child) {
  const pathToChild = relative(resolve(parent), resolve(child));
  return Boolean(pathToChild) && !pathToChild.startsWith("..") && !pathToChild.includes(`..${sep}`);
}

async function isCanonicalChildPath(parentReal, childPath) {
  try {
    const childReal = await realpath(childPath);
    return isSafeChildPath(parentReal, childReal);
  } catch {
    return false;
  }
}

// Exported for focused unit tests.
export const __test = {
  isSafeChildPath,
  isCanonicalChildPath,
  sessionMediaLocation,
  buildGrokAssetId,
  sha256File,
  assertSafeSessionFile,
  MEDIA_EXTENSIONS,
  VIDEO_EXTENSIONS,
  dirname,
};
