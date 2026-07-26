const DEFAULTS = {
  mosaBaseUrl: "http://127.0.0.1:43517",
  mosaToken: "",
  autoCapture: true, // always default on
};
const STORAGE_KEYS = ["mosaBaseUrl", "mosaToken", "autoCapture"];
const LEGACY_DEV_TOKEN = "mosa-web-capture-dev";
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

  return false;
});

async function getSettings() {
  await migrateSettingsToLocal();
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
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
  })();
  return settingsMigration;
}

function normalizeStoredToken(value) {
  const token = String(value || "").trim();
  return token === LEGACY_DEV_TOKEN ? "" : token;
}

async function fetchImageAsBase64(url) {
  if (!url || typeof url !== "string") throw new Error("Image URL is required.");
  if (url.startsWith("data:")) {
    const match = /^data:([^;]+);base64,(.+)$/i.exec(url);
    if (!match) throw new Error("Unsupported data URL.");
    return { mimeType: match[1], imageBase64: match[2] };
  }

  const attempts = [
    { credentials: "include", cache: "no-cache" },
    { credentials: "omit", cache: "no-cache" },
    { credentials: "include", cache: "force-cache" },
  ];
  let lastError = null;
  for (const init of attempts) {
    try {
      const response = await fetch(url, init);
      if (!response.ok) {
        lastError = new Error(`Failed to download image (${response.status})`);
        continue;
      }
      const blob = await response.blob();
      if (!blob || blob.size < 100) {
        lastError = new Error("Downloaded image empty/too small");
        continue;
      }
      const mimeType = blob.type || guessMime(url) || "image/png";
      const buffer = await blob.arrayBuffer();
      return { mimeType, imageBase64: bufferToBase64(buffer) };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError || new Error("Failed to download image");
}

async function ingestToMosa(payload = {}) {
  const settings = await getSettings();
  const baseUrl = normalizeBaseUrl(settings.mosaBaseUrl || DEFAULTS.mosaBaseUrl);
  const token = String(settings.mosaToken || "").trim();
  if (!token) throw new Error("Web Capture Token 未配置。请在扩展选项中填写与 MOSA 服务相同的随机 Token。");

  let imageBase64 = payload.imageBase64;
  let mimeType = payload.mimeType || "image/png";

  // Prefer server-side (extension background) download for remote URLs.
  if (!imageBase64 && payload.imageUrl) {
    const fetched = await fetchImageAsBase64(payload.imageUrl);
    imageBase64 = fetched.imageBase64;
    mimeType = fetched.mimeType || mimeType;
  }
  if (!imageBase64) throw new Error("No image bytes to ingest.");

  let response;
  try {
    response = await fetch(`${baseUrl}/api/ingest/web-capture`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        provider: "chatgpt",
        prompt: payload.prompt || "",
        prompt_status: payload.promptStatus || (payload.prompt ? "user-message" : "not-available"),
        user_message: payload.userMessage || payload.user_message || "",
        prompt_source: payload.promptSource || payload.prompt_source || "",
        is_reference: Boolean(payload.isReference),
        imageBase64,
        mimeType,
        pageUrl: payload.pageUrl || "",
        conversationId: payload.conversationId || "",
        messageId: payload.messageId || "",
        model: payload.model || "",
        capturedAt: payload.capturedAt || new Date().toISOString(),
        extensionVersion: chrome.runtime.getManifest().version,
      }),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`无法连接 MOSA (${baseUrl})：${msg}。请确认服务在运行，并检查扩展选项中的本机端口。`);
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

function guessMime(url) {
  const lower = String(url).toLowerCase();
  if (lower.includes(".jpg") || lower.includes(".jpeg")) return "image/jpeg";
  if (lower.includes(".webp")) return "image/webp";
  if (lower.includes(".gif")) return "image/gif";
  if (lower.includes(".png")) return "image/png";
  return "";
}

chrome.runtime.onInstalled.addListener(async () => {
  await migrateSettingsToLocal();
});
