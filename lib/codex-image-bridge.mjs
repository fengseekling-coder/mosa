import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve, sep } from "node:path";

const IMAGE_EXTENSIONS = new Set([".apng", ".avif", ".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp"]);
const DEFAULT_PROJECT_ID = "default";

/**
 * Watches Codex's standard generated-images root. Each image is copied into
 * MOSA together with its task ID, original path, timestamp, dimensions and
 * the task's user prompt when the matching local session file is available.
 */
export function createCodexImageBridge(options = {}) {
  const store = options.store;
  if (!store || typeof store.createAsset !== "function" || typeof store.listAssets !== "function") {
    throw new Error("Codex image bridge requires a MOSA store.");
  }

  const imagesDir = resolve(options.imagesDir || store.codexImagesDir);
  const sessionsDir = resolve(options.sessionsDir || join(homedir(), ".codex", "sessions"));
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
    imagesDir,
    sessionsDir,
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
      if (!knownHashes) knownHashes = await existingContentHashes(store, projectId);
      const result = await reconcileCodexGeneratedImages({ store, imagesDir, sessionsDir, projectId, knownHashes });
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
    await mkdir(imagesDir, { recursive: true });
    await reconcile();
    try {
      watcher = watch(imagesDir, { recursive: true }, () => scheduleReconcile());
      watcher.on("error", () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      watcher = null;
    }
    // Polling covers filesystems where recursive fs.watch misses nested writes
    // and retries a picture observed before the image writer closes it.
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

export async function reconcileCodexGeneratedImages({ store, imagesDir, sessionsDir, projectId = DEFAULT_PROJECT_ID, knownHashes = null }) {
  const root = resolve(imagesDir || store.codexImagesDir);
  const candidates = await readCodexImageCandidates(root);
  const [activeAssets, archivedAssets] = await Promise.all([
    store.listAssets({ projectId }),
    store.listAssets({ projectId, archived: true }),
  ]);
  const knownPaths = new Set(
    [...activeAssets, ...archivedAssets]
      .flatMap((asset) => [asset.source?.path, asset.source?.codex_image_path])
      .filter(Boolean)
      .map((value) => resolve(value)),
  );
  const contentHashes = knownHashes || await existingContentHashes(store, projectId, [...activeAssets, ...archivedAssets]);
  const taskMetadata = await readCodexTaskMetadata(sessionsDir, new Set(candidates.map((candidate) => candidate.taskId).filter(Boolean)));
  const imported = [];
  const skipped = [];

  for (const candidate of candidates) {
    if (knownPaths.has(candidate.imagePath)) {
      skipped.push({ path: candidate.imagePath, reason: "already-archived" });
      continue;
    }
    let contentHash;
    try {
      contentHash = await sha256File(candidate.imagePath);
    } catch (error) {
      skipped.push({ path: candidate.imagePath, reason: "not-ready", error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (contentHashes.has(contentHash)) {
      skipped.push({ path: candidate.imagePath, reason: "already-archived-same-content" });
      knownPaths.add(candidate.imagePath);
      continue;
    }

    const task = taskMetadata.get(candidate.taskId) || emptyTaskMetadata(candidate.taskId);
    const imageInfo = await readImageInfo(candidate.imagePath, candidate.fileStat);
    try {
      const asset = await store.createAsset({
        projectId,
        imagePath: candidate.imagePath,
        asset: candidate.fileName,
        assetId: `codex-${candidate.taskId || "image"}-${candidate.fileStem}`,
        prompt: task.prompt,
        skill: "Codex automatic archive",
        ratio: imageInfo.ratio,
        theme: task.prompt,
        tags: ["codex", "auto-archived"],
        created_at: candidate.generatedAt,
        sourceType: "codex-generated",
        business_fields: {
          auto_archived: true,
          prompt_status: task.promptStatus,
          file_bytes: candidate.fileStat.size,
          width: imageInfo.width,
          height: imageInfo.height,
          mime_type: imageInfo.mimeType,
        },
        source: {
          generation_tool: "codex-imagegen",
          codex_image_path: candidate.imagePath,
          codex_task_id: candidate.taskId || null,
          codex_output_file: candidate.fileName,
          codex_generated_at: candidate.generatedAt,
          codex_session_path: task.sessionPath,
          codex_session_updated_at: task.sessionUpdatedAt,
          prompt_status: task.promptStatus,
          content_sha256: contentHash,
          image_metadata: imageInfo,
        },
      });
      knownPaths.add(candidate.imagePath);
      contentHashes.add(contentHash);
      imported.push(asset);
    } catch (error) {
      skipped.push({ path: candidate.imagePath, reason: "import-failed", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { imported, skipped, candidates: candidates.length };
}

async function readCodexImageCandidates(imagesDir) {
  const files = await walkFiles(imagesDir);
  const candidates = [];
  for (const imagePath of files) {
    if (!IMAGE_EXTENSIONS.has(extname(imagePath).toLowerCase()) || !isSafeChildPath(imagesDir, imagePath)) continue;
    let fileStat;
    try {
      fileStat = await stat(imagePath);
    } catch {
      continue;
    }
    if (!fileStat.isFile()) continue;
    const relativePath = relative(imagesDir, imagePath);
    const [taskId] = relativePath.split(sep);
    const fileName = basename(imagePath);
    candidates.push({
      imagePath,
      taskId: taskId || null,
      fileName,
      fileStem: fileName.replace(/\.[^.]+$/, ""),
      fileStat,
      generatedAt: fileStat.birthtime.toISOString?.() || fileStat.mtime.toISOString(),
    });
  }
  return candidates.sort((left, right) => left.generatedAt.localeCompare(right.generatedAt));
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
      // A missing legacy library copy must not block automatic archiving.
    }
  }
  return hashes;
}

async function readCodexTaskMetadata(sessionsDir, taskIds) {
  const result = new Map();
  if (!taskIds.size) return result;
  const sessionFiles = await walkFiles(sessionsDir);
  const matching = new Map();
  for (const filePath of sessionFiles) {
    const match = /([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.jsonl$/i.exec(filePath);
    if (match && taskIds.has(match[1])) matching.set(match[1], filePath);
  }
  await Promise.all([...taskIds].map(async (taskId) => {
    result.set(taskId, await readTaskMetadataFile(taskId, matching.get(taskId)));
  }));
  return result;
}

async function readTaskMetadataFile(taskId, sessionPath) {
  if (!sessionPath) return emptyTaskMetadata(taskId);
  try {
    const [raw, sessionStat] = await Promise.all([readFile(sessionPath, "utf8"), stat(sessionPath)]);
    const userTexts = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const message = event?.type === "response_item" && event.payload?.type === "message" && event.payload?.role === "user" ? event.payload : null;
      if (!message) continue;
      for (const part of message.content || []) {
        const text = String(part?.text || "").trim();
        if (part?.type === "input_text" && isUserPrompt(text)) userTexts.push(text);
      }
    }
    return {
      taskId,
      prompt: userTexts.at(-1) || "",
      promptStatus: userTexts.length ? "task-user-prompt" : "not-available-in-session",
      sessionPath,
      sessionUpdatedAt: sessionStat.mtime.toISOString(),
    };
  } catch {
    return emptyTaskMetadata(taskId);
  }
}

function isUserPrompt(text) {
  return Boolean(text)
    && text.length <= 12000
    && !text.startsWith("<")
    && !text.startsWith("# AGENTS.md instructions")
    && !text.startsWith("<environment_context>")
    && !text.startsWith("<recommended_plugins>");
}

function emptyTaskMetadata(taskId) {
  return { taskId, prompt: "", promptStatus: "not-available", sessionPath: null, sessionUpdatedAt: null };
}

async function readImageInfo(imagePath, fileStat) {
  const extension = extname(imagePath).toLowerCase();
  const imageInfo = { width: null, height: null, ratio: "", mimeType: mimeTypeForExtension(extension), bytes: fileStat.size };
  try {
    const buffer = await readFile(imagePath);
    if (extension === ".png" && buffer.length >= 24 && buffer.subarray(1, 4).toString("ascii") === "PNG") {
      imageInfo.width = buffer.readUInt32BE(16);
      imageInfo.height = buffer.readUInt32BE(20);
    } else if (extension === ".gif" && buffer.length >= 10) {
      imageInfo.width = buffer.readUInt16LE(6);
      imageInfo.height = buffer.readUInt16LE(8);
    }
    imageInfo.ratio = ratioFromDimensions(imageInfo.width, imageInfo.height);
  } catch {
    // Optional image dimensions should never prevent a valid asset import.
  }
  return imageInfo;
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
    ".apng": "image/apng", ".avif": "image/avif", ".gif": "image/gif", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp",
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
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function isSafeChildPath(parent, child) {
  const pathToChild = relative(parent, child);
  return pathToChild && !pathToChild.startsWith("..") && !pathToChild.includes(`..${sep}`);
}
