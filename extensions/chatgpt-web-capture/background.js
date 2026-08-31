const DEFAULTS = {
  mosaBaseUrl: "http://127.0.0.1:43517",
  mosaToken: "",
  autoCapture: false,
};
const DISCOVERY_PORTS = [43517, 43518, 43519, 43520, 43521];
const STORAGE_KEYS = ["mosaBaseUrl", "mosaToken", "autoCapture"];
const LEGACY_DEV_TOKEN = "mosa-web-capture-dev";
const WEB_IMAGE_PROVIDERS = new Set(["chatgpt", "gemini", "flow", "google-ai-studio"]);
const WEB_VIDEO_PROVIDERS = new Set(["flow", "google-ai-studio"]);
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_BYTES = 96 * 1024 * 1024;
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "mosa.ingest") {
    ingestToMosa(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
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

async function fetchMediaAsBase64(url, { publicMedia = false, mediaKind = "image" } = {}) {
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
      return { mimeType, mediaBase64: bufferToBase64(buffer) };
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

async function ingestToMosa(payload = {}) {
  const settings = await getSettings();
  let baseUrl = normalizeBaseUrl(settings.mosaBaseUrl || DEFAULTS.mosaBaseUrl);
  let token = String(settings.mosaToken || "").trim();
  if (!token) throw new Error("Web Capture Token 未配置。请在扩展选项中填写与 MOSA 服务相同的随机 Token。");

  const mediaKind = payload.mediaKind === "video" ? "video" : "image";
  let mediaBase64 = mediaKind === "video" ? payload.mediaBase64 : payload.imageBase64;
  let mimeType = payload.mimeType || (mediaKind === "video" ? "video/mp4" : "image/png");
  const provider = String(payload.provider || "chatgpt").trim().toLowerCase();
  if (!WEB_IMAGE_PROVIDERS.has(provider)) throw new Error("Unsupported web image provider.");
  if (mediaKind === "video" && !WEB_VIDEO_PROVIDERS.has(provider)) throw new Error("Unsupported web video provider.");

  // Prefer server-side (extension background) download for remote URLs.
  const mediaUrl = mediaKind === "video" ? payload.mediaUrl : payload.imageUrl;
  if (!mediaBase64 && mediaUrl) {
    const fetched = await fetchMediaAsBase64(mediaUrl, { publicMedia: false, mediaKind });
    mediaBase64 = fetched.mediaBase64;
    mimeType = fetched.mimeType || mimeType;
  }
  if (!mediaBase64) throw new Error(`No ${mediaKind} bytes to ingest.`);
  const requestIngest = () => fetchWithTimeout(`${baseUrl}/api/ingest/web-capture`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
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
        ...(mediaKind === "video" ? { mediaBase64 } : { imageBase64: mediaBase64 }),
        mimeType,
        width: Number(payload.width) || 0,
        height: Number(payload.height) || 0,
        durationSeconds: Number.isFinite(Number(payload.durationSeconds)) ? Number(payload.durationSeconds) : null,
        pageUrl: payload.pageUrl || "",
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
      }),
    }, mediaKind === "video" ? 90_000 : 30_000);

  let response;
  try {
    response = await requestIngest();
  } catch (error) {
    const repaired = await repairPairing().catch(() => null);
    if (!repaired) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`无法连接 MOSA (${baseUrl})：${msg}。请确认 MOSA App 正在运行。`);
    }
    baseUrl = repaired.baseUrl;
    token = repaired.token;
    response = await requestIngest();
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
