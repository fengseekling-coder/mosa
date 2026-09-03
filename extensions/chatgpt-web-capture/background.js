import "./provider-policy.js";

const DEFAULTS = {
  mosaBaseUrl: "http://127.0.0.1:43517",
  mosaToken: "",
  autoCapture: false,
};
const DISCOVERY_PORTS = [43517, 43518, 43519, 43520, 43521];
const STORAGE_KEYS = ["mosaBaseUrl", "mosaToken", "autoCapture"];
const CAPTURE_QUEUE_KEY = "mosaCaptureQueueV1";
const CAPTURE_QUEUE_ALARM = "mosa-capture-queue";
const CAPTURE_QUEUE_MAX_ITEMS = 256;
const CAPTURE_QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CAPTURE_QUEUE_MAX_ATTEMPTS = 3;
const LEGACY_DEV_TOKEN = "mosa-web-capture-dev";
const WEB_IMAGE_PROVIDERS = new Set(["chatgpt", "gemini", "flow", "google-ai-studio"]);
const WEB_VIDEO_PROVIDERS = new Set(["flow", "google-ai-studio"]);
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_BYTES = 96 * 1024 * 1024;
const MAX_VIDEO_CHUNKS = 40;
const REMOTE_MEDIA_HOSTS = new Set([
  "chatgpt.com",
  "chat.openai.com",
  "images.openai.com",
  "labs.google",
  "aistudio.google.com",
  "storage.googleapis.com",
  "generativelanguage.googleapis.com",
  "flow-content.google",
]);
let settingsMigration;
let queueDrainPromise;
let queueMutationPromise = Promise.resolve();
const chunkedVideoTransfers = new Map();
const VIDEO_TRANSFER_TTL_MS = 10 * 60 * 1000;

function providerForPageUrl(value) {
  return globalThis.MosaProviderPolicy?.providerForPageUrl(value) || "";
}

function extensionPageSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id || sender.tab) return false;
  return String(sender.url || "").startsWith(`chrome-extension://${chrome.runtime.id}/`);
}

function pageSenderContext(sender) {
  if (!sender || sender.id !== chrome.runtime.id || !sender.tab) return null;
  if (Number(sender.frameId ?? 0) !== 0) return null;
  const pageUrl = String(sender.url || sender.tab.url || "");
  const provider = providerForPageUrl(pageUrl);
  if (!provider) return null;
  return { provider, pageUrl, tabId: Number(sender.tab.id) };
}

function senderKey(sender) {
  const context = pageSenderContext(sender);
  return context && Number.isInteger(context.tabId)
    ? `${context.tabId}:${Number(sender.frameId ?? 0)}:${context.provider}`
    : "";
}

function senderAllowedForMessage(message, sender) {
  if (message?.type === "mosa.getSettings") {
    return extensionPageSender(sender) || Boolean(pageSenderContext(sender));
  }
  const context = pageSenderContext(sender);
  if (!context) return false;
  if (message.type === "mosa.fetchImage") return context.provider === "chatgpt";
  if (message.type === "mosa.probeFlowMedia") return context.provider === "flow";
  if (["mosa.beginVideoTransfer", "mosa.videoTransferChunk", "mosa.commitVideoTransfer"].includes(message.type)) {
    return context.provider === "flow" || context.provider === "google-ai-studio";
  }
  if (message.type === "mosa.openOptions") return true;
  if (message.type !== "mosa.ingest") return true;
  const declaredProvider = String(message.payload?.provider || (context.provider === "chatgpt" ? "chatgpt" : "")).trim().toLowerCase();
  return declaredProvider === context.provider;
}

function pruneChunkedVideoTransfers() {
  const cutoff = Date.now() - VIDEO_TRANSFER_TTL_MS;
  for (const [id, transfer] of chunkedVideoTransfers) {
    if (Number(transfer?.createdAt || 0) < cutoff) chunkedVideoTransfers.delete(id);
  }
}

function stableCaptureKey(payload = {}) {
  const mediaUrl = payload.mediaKind === "video" ? payload.mediaUrl : payload.imageUrl;
  const identity = [
    String(payload.provider || ""),
    String(payload.mediaKind || "image"),
    String(mediaUrl || ""),
    String(payload.providerAssetId || ""),
    String(payload.providerGenerationCallId || ""),
    String(payload.generationContextId || ""),
    String(payload.pageUrl || ""),
  ].join("\u001f");
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `capture-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function isPersistableCapture(payload = {}) {
  const mediaUrl = payload.mediaKind === "video" ? payload.mediaUrl : payload.imageUrl;
  return typeof mediaUrl === "string" && mediaUrl.startsWith("https:")
    && !payload.mediaBase64 && !payload.imageBase64;
}

async function readCaptureQueue() {
  const stored = await chrome.storage.local.get({ [CAPTURE_QUEUE_KEY]: [] });
  const now = Date.now();
  return (Array.isArray(stored[CAPTURE_QUEUE_KEY]) ? stored[CAPTURE_QUEUE_KEY] : [])
    .filter((item) => item && item.payload && now - Number(item.createdAt || 0) <= CAPTURE_QUEUE_MAX_AGE_MS)
    .slice(-CAPTURE_QUEUE_MAX_ITEMS);
}

async function pruneStoredCaptureQueue() {
  queueMutationPromise = queueMutationPromise.then(async () => {
    const stored = await chrome.storage.local.get({ [CAPTURE_QUEUE_KEY]: [] });
    const raw = Array.isArray(stored[CAPTURE_QUEUE_KEY]) ? stored[CAPTURE_QUEUE_KEY] : [];
    const now = Date.now();
    const next = raw
      .filter((item) => item && item.payload && now - Number(item.createdAt || 0) <= CAPTURE_QUEUE_MAX_AGE_MS)
      .slice(-CAPTURE_QUEUE_MAX_ITEMS);
    if (next.length !== raw.length) await writeCaptureQueue(next);
  });
  await queueMutationPromise;
}

async function writeCaptureQueue(queue) {
  await chrome.storage.local.set({ [CAPTURE_QUEUE_KEY]: queue.slice(-CAPTURE_QUEUE_MAX_ITEMS) });
}

async function enqueueCapture(payload) {
  if (!isPersistableCapture(payload)) return null;
  const id = stableCaptureKey(payload);
  queueMutationPromise = queueMutationPromise.then(async () => {
    const queue = await readCaptureQueue();
    const existing = queue.find((item) => item.id === id);
    if (!existing) {
      queue.push({ id, payload, createdAt: Date.now(), attempts: 0, lastError: "" });
      await writeCaptureQueue(queue);
    }
  });
  await queueMutationPromise;
  return id;
}

async function removeQueuedCapture(id) {
  if (!id) return;
  queueMutationPromise = queueMutationPromise.then(async () => {
    const queue = await readCaptureQueue();
    const next = queue.filter((item) => item.id !== id);
    if (next.length !== queue.length) await writeCaptureQueue(next);
  });
  await queueMutationPromise;
}

async function markQueuedCaptureFailure(id, error) {
  if (!id) return;
  queueMutationPromise = queueMutationPromise.then(async () => {
    const queue = await readCaptureQueue();
    const index = queue.findIndex((item) => item.id === id);
    if (index < 0) return;
    queue[index] = {
      ...queue[index],
      attempts: Number(queue[index].attempts || 0) + 1,
      lastError: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
    };
    await writeCaptureQueue(queue);
  });
  await queueMutationPromise;
}

function mosaUnavailableError(message) {
  const error = new Error(message);
  error.code = "MOSA_UNAVAILABLE";
  return error;
}

async function ingestWithQueue(payload = {}) {
  const queueId = await enqueueCapture(payload);
  try {
    const result = await ingestToMosa(payload);
    await removeQueuedCapture(queueId);
    return result;
  } catch (error) {
    throw error;
  }
}

function drainCaptureQueue() {
  if (queueDrainPromise) return queueDrainPromise;
  queueDrainPromise = (async () => {
    await pruneStoredCaptureQueue();
    const queue = await readCaptureQueue();
    if (!queue.length) return;
    for (const item of queue) {
      try {
        await ingestToMosa(item.payload);
        await removeQueuedCapture(item.id);
      } catch (error) {
        await markQueuedCaptureFailure(item.id, error);
        if (error?.code === "MOSA_UNAVAILABLE") break;
        if (Number(item.attempts || 0) + 1 >= CAPTURE_QUEUE_MAX_ATTEMPTS) {
          await removeQueuedCapture(item.id);
        }
      }
    }
  })().finally(() => { queueDrainPromise = undefined; });
  return queueDrainPromise;
}

chrome.runtime.onStartup?.addListener(() => { void drainCaptureQueue(); });
chrome.runtime.onInstalled?.addListener(() => {
  chrome.alarms?.create?.(CAPTURE_QUEUE_ALARM, { periodInMinutes: 1 });
  void drainCaptureQueue();
});
chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm?.name === CAPTURE_QUEUE_ALARM) void drainCaptureQueue();
});
chrome.alarms?.create?.(CAPTURE_QUEUE_ALARM, { periodInMinutes: 1 });
void drainCaptureQueue();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;
  if (!senderAllowedForMessage(message, sender)) {
    sendResponse({ ok: false, error: "MOSA rejected a message from an unsupported sender." });
    return false;
  }

  if (message.type === "mosa.ingest") {
    ingestWithQueue(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }

  if (message.type === "mosa.beginVideoTransfer") {
    try {
      pruneChunkedVideoTransfers();
      const transferId = String(message.transferId || "").trim();
      const totalBytes = Number(message.totalBytes || 0);
      const totalChunks = Number(message.totalChunks || 0);
      if (!transferId || totalBytes < 1024 || totalBytes > MAX_VIDEO_BYTES
        || !Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_VIDEO_CHUNKS) {
        throw new Error("Invalid chunked video transfer.");
      }
      chunkedVideoTransfers.set(transferId, {
        payload: { ...(message.payload || {}), mediaKind: "video" },
        senderKey: senderKey(sender),
        totalBytes,
        totalChunks,
        chunks: new Array(totalChunks),
        receivedBytes: 0,
        createdAt: Date.now(),
      });
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return false;
  }

  if (message.type === "mosa.videoTransferChunk") {
    try {
      const transferId = String(message.transferId || "").trim();
      const transfer = chunkedVideoTransfers.get(transferId);
      const index = Number(message.index);
      const chunkBase64 = String(message.chunkBase64 || "");
      if (!transfer || transfer.senderKey !== senderKey(sender)
        || !Number.isInteger(index) || index < 0 || index >= transfer.totalChunks || !chunkBase64) {
        throw new Error("Unknown or invalid video transfer chunk.");
      }
      if (!transfer.chunks[index]) {
        const chunkBytes = base64ToBytes(chunkBase64);
        transfer.receivedBytes += chunkBytes.byteLength;
        if (transfer.receivedBytes > transfer.totalBytes || transfer.receivedBytes > MAX_VIDEO_BYTES) {
          chunkedVideoTransfers.delete(transferId);
          throw new Error("Chunked video exceeds declared size.");
        }
        // Decode each chunk immediately so the service worker never retains a
        // full-video Base64 copy alongside the binary payload.
        transfer.chunks[index] = chunkBytes;
      }
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return false;
  }

  if (message.type === "mosa.commitVideoTransfer") {
    const transferId = String(message.transferId || "").trim();
    const transfer = chunkedVideoTransfers.get(transferId);
    if (!transfer || transfer.senderKey !== senderKey(sender)
      || transfer.chunks.some((chunk) => !chunk) || transfer.receivedBytes !== transfer.totalBytes) {
      sendResponse({ ok: false, error: "Chunked video transfer is incomplete." });
      return false;
    }
    chunkedVideoTransfers.delete(transferId);
    ingestToMosa(transfer.payload, { binaryParts: transfer.chunks })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (message.type === "mosa.fetchImage") {
    fetchImageAsBase64(message.url)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }

  if (message.type === "mosa.getSettings") {
    getSettings()
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }

  if (message.type === "mosa.probeFlowMedia") {
    probeFlowMedia(message.url)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }

  if (message.type === "mosa.openOptions") {
    chrome.runtime.openOptionsPage()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }

  return false;
});

async function getSettings() {
  await migrateSettingsToLocal();
  let stored = await chrome.storage.local.get(DEFAULTS);
  let settings = { ...DEFAULTS, ...stored };
  if (!String(settings.mosaToken || "").trim()) {
    const paired = await discoverAndPairMosa().catch(() => null);
    if (paired) {
      await chrome.storage.local.set({ mosaBaseUrl: paired.baseUrl, mosaToken: paired.token });
      stored = await chrome.storage.local.get(DEFAULTS);
      settings = { ...DEFAULTS, ...stored };
    }
  }
  return settings;
}

async function discoverAndPairMosa() {
  for (const port of DISCOVERY_PORTS) {
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const health = await fetchWithTimeout(`${baseUrl}/api/health`, { cache: "no-cache" }, 700);
      if (!health.ok) continue;
      const identity = await health.json();
      if (identity?.product !== "mosa") continue;

      const pair = await fetchWithTimeout(`${baseUrl}/api/web-capture/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        cache: "no-cache",
      }, 900);
      if (!pair.ok) continue;
      const body = await pair.json();
      const token = String(body?.token || "").trim();
      if (body?.product !== "mosa" || !token) continue;
      return { baseUrl, token };
    } catch {
      // Try the next local discovery port.
    }
  }
  return null;
}

async function repairPairing() {
  const paired = await discoverAndPairMosa();
  if (!paired) return null;
  await chrome.storage.local.set({ mosaBaseUrl: paired.baseUrl, mosaToken: paired.token });
  return paired;
}

async function ensureMosaAvailable(baseUrl) {
  try {
    const response = await fetchWithTimeout(`${baseUrl}/api/health`, { cache: "no-cache" }, 900);
    if (!response.ok) return false;
    const body = await response.json();
    return body?.product === "mosa";
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probeFlowMedia(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch {
    throw new Error("Invalid Flow media URL.");
  }
  if (parsed.origin !== "https://labs.google"
    || parsed.pathname !== "/fx/api/trpc/media.getMediaUrlRedirect"
    || !parsed.searchParams.get("name")) {
    throw new Error("Unsupported Flow media probe URL.");
  }

  const attempts = [
    { method: "GET", credentials: "include", cache: "no-cache", redirect: "follow", headers: { Range: "bytes=0-31" } },
    { method: "GET", credentials: "omit", cache: "no-cache", redirect: "follow", headers: { Range: "bytes=0-31" } },
  ];
  let lastError = null;
  for (const init of attempts) {
    try {
      const response = await fetchWithTimeout(parsed.href, init, 5_000);
      if (!response.ok && response.status !== 206) {
        lastError = new Error(`Flow media probe failed (${response.status})`);
        continue;
      }
      const contentType = String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
      const finalUrl = String(response.url || parsed.href);
      let finalParsed;
      try { finalParsed = new URL(finalUrl); } catch { finalParsed = null; }
      const finalHost = String(finalParsed?.hostname || "").toLowerCase();
      const finalPath = String(finalParsed?.pathname || "").toLowerCase();
      const trustedFinalHost = finalHost === "flow-content.google"
        || finalHost === "storage.googleapis.com"
        || finalHost.endsWith(".googleusercontent.com")
        || finalParsed?.origin === "https://labs.google";
      if (!trustedFinalHost) throw new Error("Flow media redirected to an unsupported host.");
      const mediaKind = contentType.startsWith("video/") || finalPath.includes("/video/")
        ? "video"
        : contentType.startsWith("image/") || finalPath.includes("/image/")
          ? "image"
          : "unknown";
      response.body?.cancel?.().catch?.(() => {});
      return { mediaKind, mimeType: contentType, mediaUrl: finalUrl };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError || new Error("Flow media probe failed.");
}

function migrateSettingsToLocal() {
  if (settingsMigration) return settingsMigration;
  settingsMigration = (async () => {
    const [local, synced] = await Promise.all([
      chrome.storage.local.get(null),
      chrome.storage.sync.get(STORAGE_KEYS),
    ]);
    const localToken = normalizeStoredToken(local.mosaToken);
    const migratedToken = normalizeStoredToken(synced.mosaToken);
    const patch = {
      mosaBaseUrl: local.mosaBaseUrl || synced.mosaBaseUrl || DEFAULTS.mosaBaseUrl,
      mosaToken: localToken || migratedToken || DEFAULTS.mosaToken,
      autoCapture: local.autoCapture ?? synced.autoCapture ?? DEFAULTS.autoCapture,
    };
    await chrome.storage.local.set(patch);
    await chrome.storage.sync.remove(STORAGE_KEYS);
  })().catch((error) => {
    settingsMigration = undefined;
    throw error;
  });
  return settingsMigration;
}

function normalizeStoredToken(value) {
  const token = String(value || "").trim();
  return token === LEGACY_DEV_TOKEN ? "" : token;
}

async function fetchImageAsBase64(url, { publicImage = false } = {}) {
  const result = await fetchMediaAsBase64(url, { publicMedia: publicImage, mediaKind: "image" });
  return { mimeType: result.mimeType, imageBase64: result.mediaBase64 };
}

async function fetchMediaAsBase64(url, { publicMedia = false, mediaKind = "image", binary = false } = {}) {
  const label = mediaKind === "video" ? "video" : "image";
  if (!url || typeof url !== "string") throw new Error(`${label === "video" ? "Video" : "Image"} URL is required.`);
  if (url.startsWith("data:")) {
    const match = /^data:([^;]+);base64,(.+)$/i.exec(url);
    if (!match) throw new Error("Unsupported data URL.");
    return { mimeType: match[1], mediaBase64: match[2] };
  }

  assertAllowedRemoteMediaUrl(url);
  const maxBytes = mediaKind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;

  const attempts = [
    ...(publicMedia ? [] : [{ credentials: "include", cache: "no-cache" }]),
    { credentials: "omit", cache: "no-cache" },
    ...(publicMedia ? [] : [{ credentials: "include", cache: "force-cache" }]),
  ];
  let lastError = null;
  for (const init of attempts) {
    try {
      const response = await fetchWithTimeout(url, init, mediaKind === "video" ? 45_000 : 15_000);
      if (!response.ok) {
        lastError = new Error(`Failed to download ${label} (${response.status})`);
        continue;
      }
      // Redirects are followed by fetch. Re-validate the final destination so
      // an allow-listed bootstrap URL cannot bounce the extension to an
      // arbitrary host.
      assertAllowedRemoteMediaUrl(response.url || url);
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        response.body?.cancel?.().catch?.(() => {});
        throw new Error(`${label === "video" ? "Video" : "Image"} exceeds MOSA capture size limit.`);
      }
      const blob = await response.blob();
      if (!blob || blob.size < 100) {
        lastError = new Error(`Downloaded ${label} empty/too small`);
        continue;
      }
      if (blob.size > maxBytes) {
        throw new Error(`${label === "video" ? "Video" : "Image"} exceeds MOSA capture size limit.`);
      }
      const mimeType = blob.type || guessMime(url, mediaKind) || (mediaKind === "video" ? "video/mp4" : "image/png");
      const buffer = await blob.arrayBuffer();
      return binary
        ? { mimeType, mediaBytes: buffer, finalUrl: response.url || url }
        : { mimeType, mediaBase64: bufferToBase64(buffer), finalUrl: response.url || url };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError || new Error(`Failed to download ${label}`);
}

function assertAllowedRemoteMediaUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("Invalid media URL.");
  }
  if (url.protocol !== "https:") throw new Error("Unsupported media URL protocol.");
  const host = url.hostname.toLowerCase();
  const allowed = REMOTE_MEDIA_HOSTS.has(host)
    || host.endsWith(".oaiusercontent.com")
    || host.endsWith(".blob.core.windows.net")
    || host.endsWith(".googleusercontent.com")
    || host.endsWith(".ggpht.com");
  if (!allowed) throw new Error("Unsupported media host.");
}

function sanitizeProvenanceUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:") return "";
    const retained = new URLSearchParams();
    for (const key of ["id", "cid", "name", "asset_id", "assetId", "media_id", "mediaId"]) {
      const entry = url.searchParams.get(key);
      if (entry) retained.set(key, entry.slice(0, 512));
    }
    url.search = retained.toString();
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function binaryCaptureEnvelope(metadata, parts) {
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  if (metadataBytes.byteLength > 256 * 1024) throw new Error("Capture metadata is too large.");
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, metadataBytes.byteLength, false);
  return new Blob([header, metadataBytes, ...parts], { type: "application/octet-stream" });
}

function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function ingestToMosa(payload = {}, { binaryParts = null } = {}) {
  const settings = await getSettings();
  let baseUrl = normalizeBaseUrl(settings.mosaBaseUrl || DEFAULTS.mosaBaseUrl);
  let token = String(settings.mosaToken || "").trim();
  if (!token) throw new Error("Web Capture Token 未配置。请在扩展选项中填写与 MOSA 服务相同的随机 Token。");

  const mediaKind = payload.mediaKind === "video" ? "video" : "image";
  let mediaBase64 = mediaKind === "video" ? payload.mediaBase64 : payload.imageBase64;
  let mediaBinaryParts = Array.isArray(binaryParts) && binaryParts.length ? binaryParts : null;
  let mimeType = payload.mimeType || (mediaKind === "video" ? "video/mp4" : "image/png");
  const provider = String(payload.provider || "chatgpt").trim().toLowerCase();
  if (!WEB_IMAGE_PROVIDERS.has(provider)) throw new Error("Unsupported web image provider.");
  if (mediaKind === "video" && !WEB_VIDEO_PROVIDERS.has(provider)) throw new Error("Unsupported web video provider.");

  // Prefer server-side (extension background) download for remote URLs.
  const mediaUrl = mediaKind === "video" ? payload.mediaUrl : payload.imageUrl;
  let finalMediaUrl = mediaUrl || "";
  if (!mediaBase64 && !mediaBinaryParts && mediaUrl) {
    if (!await ensureMosaAvailable(baseUrl)) {
      const repaired = await repairPairing().catch(() => null);
      if (!repaired) throw mosaUnavailableError(`无法连接 MOSA (${baseUrl})。请确认 MOSA App 正在运行。`);
      baseUrl = repaired.baseUrl;
      token = repaired.token;
    }
    const fetched = await fetchMediaAsBase64(mediaUrl, { publicMedia: false, mediaKind, binary: mediaKind === "video" });
    if (mediaKind === "video" && fetched.mediaBytes) mediaBinaryParts = [fetched.mediaBytes];
    else mediaBase64 = fetched.mediaBase64;
    mimeType = fetched.mimeType || mimeType;
    finalMediaUrl = fetched.finalUrl || mediaUrl;
  }
  if (!mediaBase64 && !mediaBinaryParts) throw new Error(`No ${mediaKind} bytes to ingest.`);
  const requestPayload = {
    provider,
    prompt: payload.prompt || "",
    prompt_status: payload.promptStatus || (payload.prompt ? "user-message" : "not-available"),
    user_message: payload.userMessage || payload.user_message || "",
    prompt_source: payload.promptSource || payload.prompt_source || "",
    prompt_priority: Number(payload.promptPriority || payload.prompt_priority) || 0,
    prompt_scope: payload.promptScope || payload.prompt_scope || "",
    generation_status: payload.generationStatus || payload.generation_status || "unknown",
    is_reference: Boolean(payload.isReference),
    mediaKind,
    mimeType,
    width: Number(payload.width) || 0,
    height: Number(payload.height) || 0,
    durationSeconds: Number.isFinite(Number(payload.durationSeconds)) ? Number(payload.durationSeconds) : null,
    pageUrl: payload.pageUrl || "",
    sourceMediaUrl: sanitizeProvenanceUrl(mediaUrl || payload.sourceMediaUrl || ""),
    finalMediaUrl: sanitizeProvenanceUrl(finalMediaUrl || payload.finalMediaUrl || ""),
    conversationId: payload.conversationId || "",
    messageId: payload.messageId || "",
    generationContextId: payload.generationContextId || "",
    providerToolCallId: payload.providerToolCallId || "",
    providerGenerationCallId: payload.providerGenerationCallId || "",
    providerResponseId: payload.providerResponseId || "",
    providerAssetId: payload.providerAssetId || "",
    model: payload.model || "",
    captureMode: payload.captureMode === "manual" ? "manual" : "automatic",
    capturedAt: payload.capturedAt || new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
  };
  const requestIngest = () => mediaBinaryParts
    ? fetchWithTimeout(`${baseUrl}/api/ingest/web-capture-binary`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        authorization: `Bearer ${token}`,
      },
      body: binaryCaptureEnvelope(requestPayload, mediaBinaryParts),
    }, 90_000)
    : fetchWithTimeout(`${baseUrl}/api/ingest/web-capture`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ...requestPayload,
        ...(mediaKind === "video" ? { mediaBase64 } : { imageBase64: mediaBase64 }),
      }),
    }, mediaKind === "video" ? 90_000 : 30_000);

  let response;
  try {
    response = await requestIngest();
  } catch (error) {
    const repaired = await repairPairing().catch(() => null);
    if (!repaired) {
      const msg = error instanceof Error ? error.message : String(error);
      throw mosaUnavailableError(`无法连接 MOSA (${baseUrl})：${msg}。请确认 MOSA App 正在运行。`);
    }
    baseUrl = repaired.baseUrl;
    token = repaired.token;
    try {
      response = await requestIngest();
    } catch (retryError) {
      const msg = retryError instanceof Error ? retryError.message : String(retryError);
      throw mosaUnavailableError(`无法连接 MOSA (${baseUrl})：${msg}。请确认 MOSA App 正在运行。`);
    }
  }

  if (response.status === 401 || response.status === 403) {
    await response.arrayBuffer().catch(() => {});
    const repaired = await repairPairing().catch(() => null);
    if (repaired && (repaired.baseUrl !== baseUrl || repaired.token !== token)) {
      baseUrl = repaired.baseUrl;
      token = repaired.token;
      response = await requestIngest();
    }
  }

  // A cached discovery port may later be occupied by another local service,
  // or an older MOSA runtime may no longer expose the ingest route. Repair the
  // pairing once for endpoint-level failures, but never retry normal 4xx media
  // validation errors because those belong to the current capture itself.
  if ([404, 405, 500, 502, 503, 504].includes(response.status)) {
    await response.arrayBuffer().catch(() => {});
    const repaired = await repairPairing().catch(() => null);
    if (repaired && (repaired.baseUrl !== baseUrl || repaired.token !== token)) {
      baseUrl = repaired.baseUrl;
      token = repaired.token;
      response = await requestIngest();
    }
  }

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`MOSA returned non-JSON (${response.status}): ${text.slice(0, 180)}`);
  }
  if (!response.ok) {
    throw new Error(data.error || `MOSA ingest failed (${response.status})`);
  }
  return data;
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("MOSA 地址无效。");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username || url.password) {
    throw new Error("MOSA 地址必须是 http://127.0.0.1:端口 或 http://localhost:端口。");
  }
  return url.origin;
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function guessMime(url, mediaKind = "image") {
  const lower = String(url).toLowerCase();
  if (mediaKind === "video") {
    if (lower.includes(".webm")) return "video/webm";
    if (lower.includes(".mov")) return "video/quicktime";
    if (lower.includes(".m4v")) return "video/x-m4v";
    if (lower.includes(".mp4")) return "video/mp4";
    return "";
  }
  if (lower.includes(".jpg") || lower.includes(".jpeg")) return "image/jpeg";
  if (lower.includes(".webp")) return "image/webp";
  if (lower.includes(".gif")) return "image/gif";
  if (lower.includes(".png")) return "image/png";
  return "";
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await migrateSettingsToLocal();
  await updateBadge();
  await refreshContextMenus();
  if (details?.reason === "install") await chrome.runtime.openOptionsPage();
});

async function updateBadge() {
  const settings = await getSettings();
  await chrome.action.setBadgeText({ text: settings.autoCapture ? "ON" : "OFF" });
  await chrome.action.setBadgeBackgroundColor({ color: settings.autoCapture ? "#84cc16" : "#71717a" });
}

// Context menus persist across service-worker restarts, so only (re)create them
// on install/update. removeAll() first avoids "Cannot create item with
// duplicate id" errors when the extension is updated or reloaded during dev.
async function refreshContextMenus() {
  if (!chrome.contextMenus) return;
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "mosa-save-image",
    title: "保存图片到 MOSA",
    contexts: ["image"],
    documentUrlPatterns: [
      "https://chatgpt.com/*",
      "https://chat.openai.com/*",
      "https://gemini.google.com/*",
      "https://labs.google/*",
      "https://aistudio.google.com/*",
    ],
  });
  chrome.contextMenus.create({
    id: "mosa-save-video",
    title: "保存视频到 MOSA",
    contexts: ["video"],
    documentUrlPatterns: [
      "https://labs.google/*",
      "https://aistudio.google.com/*",
    ],
  });
}

chrome.commands?.onCommand?.addListener(async (command) => {
  if (command !== "toggle-auto-capture") return;
  const current = await getSettings();
  await chrome.storage.local.set({ autoCapture: !current.autoCapture });
  await updateBadge();
});

chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area === "local" && changes.autoCapture) updateBadge();
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "mosa.capture.togglePanel" });
    if (!response?.ok) await chrome.runtime.openOptionsPage();
  } catch {
    // Google adapters intentionally keep no floating panel; settings are the
    // useful fallback instead of making the toolbar click a silent no-op.
    await chrome.runtime.openOptionsPage();
  }
});

chrome.contextMenus?.onClicked?.addListener(async (info, tab) => {
  if (!tab?.id) return;
  try {
    if (info.menuItemId === "mosa-save-video") {
      await chrome.tabs.sendMessage(tab.id, {
        type: "mosa.capture.saveVideoWithPrompt",
        videoUrl: info.srcUrl || "",
      });
      return;
    }
    if (info.menuItemId === "mosa-save-image") {
      await chrome.tabs.sendMessage(tab.id, {
        type: "mosa.capture.saveImageWithPrompt",
        imageUrl: info.srcUrl || "",
      });
    }
  } catch {
    // Page is not ready or not a supported tab — nothing to surface here.
  }
});
