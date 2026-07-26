import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";

const DEFAULT_PROJECT_ID = "default";
const ALLOWED_PROVIDERS = new Set(["chatgpt"]);
const MIME_TO_EXT = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
};
const PROMPT_STATUSES = new Set(["user-message", "visible-caption", "not-available", "generation-tool-prompt"]);
const MIME_TO_FORMATS = {
  "image/png": new Set(["png"]),
  "image/jpeg": new Set(["jpeg"]),
  "image/webp": new Set(["webp"]),
  "image/gif": new Set(["gif"]),
  "image/avif": new Set(["avif", "heif"]),
};

export const WEB_CAPTURE_MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const WEB_CAPTURE_MAX_IMAGE_PIXELS = 40_000_000;
export const WEB_CAPTURE_MAX_BODY_BYTES = Math.ceil(WEB_CAPTURE_MAX_IMAGE_BYTES / 3) * 4 + 1024 * 1024;

/**
 * Ingest browser-captured images (ChatGPT web MVP) into the MOSA library.
 * Images arrive as base64 from a local Chrome extension; files land under a
 * library-owned temp root that is passed as a trusted createAsset source root.
 */
export function createWebCaptureIngest(options = {}) {
  const store = options.store;
  if (!store || typeof store.createAsset !== "function" || typeof store.listAssets !== "function") {
    throw new Error("Web capture ingest requires a MOSA store.");
  }

  const libraryDir = resolve(options.libraryDir || store.libraryDir || store.assetsRoot);
  const tempRoot = resolve(options.tempRoot || join(libraryDir, ".web-capture-tmp"));
  const projectId = options.projectId || DEFAULT_PROJECT_ID;
  const tokenSource = Object.hasOwn(options, "token") ? options.token : process.env.MOSA_WEB_CAPTURE_TOKEN;
  const token = String(tokenSource || "").trim();
  const allowedOriginCount = Array.isArray(options.allowedOrigins) ? options.allowedOrigins.length : 0;

  const state = {
    enabled: Boolean(token) && allowedOriginCount > 0,
    providers: ["chatgpt"],
    lastIngestAt: null,
    lastImportCount: 0,
    totalImported: 0,
    totalSkipped: 0,
    lastError: null,
    lastSkippedReason: null,
  };

  function status() {
    return {
      ...state,
      tokenConfigured: Boolean(token),
      originConfigured: allowedOriginCount > 0,
      allowedOriginCount,
      // Never return the raw token in status APIs.
    };
  }

  function assertToken(provided) {
    if (!token) {
      const error = new Error("Web capture is disabled until MOSA_WEB_CAPTURE_TOKEN is configured.");
      error.statusCode = 503;
      error.code = "WEB_CAPTURE_DISABLED";
      throw error;
    }
    const value = String(provided || "").trim();
    if (!safeTokenEqual(value, token)) {
      const error = new Error("Unauthorized web capture token.");
      error.statusCode = 401;
      error.code = "WEB_CAPTURE_UNAUTHORIZED";
      throw error;
    }
  }

  async function ingest(input = {}, authToken = "") {
    assertToken(authToken);
    try {
      const result = await ingestWebCapture({ store, tempRoot, projectId, input });
      state.lastIngestAt = new Date().toISOString();
      state.lastError = null;
      if (result.status === "imported") {
        state.lastImportCount = 1;
        state.totalImported += 1;
        state.lastSkippedReason = null;
      } else {
        state.lastImportCount = 0;
        state.totalSkipped += 1;
        state.lastSkippedReason = result.reason || "skipped";
      }
      return result;
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  return { ingest, status, assertToken, tempRoot, token };
}

export async function ingestWebCapture({ store, tempRoot, projectId = DEFAULT_PROJECT_ID, input = {} }) {
  const provider = String(input.provider || "").trim().toLowerCase();
  if (!ALLOWED_PROVIDERS.has(provider)) {
    const error = new Error(`Unsupported provider: ${provider || "(empty)"}. MVP allows: chatgpt`);
    error.statusCode = 400;
    error.code = "WEB_CAPTURE_BAD_PROVIDER";
    throw error;
  }

  const mimeType = normalizeMime(input.mimeType || input.mime_type || "image/png");
  const ext = MIME_TO_EXT[mimeType];
  if (!ext) {
    const error = new Error(`Unsupported image mime type: ${mimeType}`);
    error.statusCode = 400;
    error.code = "WEB_CAPTURE_BAD_MIME";
    throw error;
  }

  const imageBytes = decodeImageBytes(input);
  if (!imageBytes.length) {
    const error = new Error("imageBase64 is required and must decode to image bytes.");
    error.statusCode = 400;
    error.code = "WEB_CAPTURE_BAD_IMAGE";
    throw error;
  }
  // Reject favicons / chat UI logos / tiny sprites (typical junk from aggressive web capture).
  // UI logos in ChatGPT capture were ~3–12KiB; real generations are typically hundreds of KiB+.
  const MIN_IMAGE_BYTES = 20 * 1024;
  if (imageBytes.length < MIN_IMAGE_BYTES) {
    const error = new Error(`Image too small for archive (${imageBytes.length} bytes < ${MIN_IMAGE_BYTES}). Likely a UI logo/icon.`);
    error.statusCode = 400;
    error.code = "WEB_CAPTURE_IMAGE_TOO_SMALL";
    throw error;
  }
  if (imageBytes.length > WEB_CAPTURE_MAX_IMAGE_BYTES) {
    const error = new Error("Image exceeds 15 MiB limit.");
    error.statusCode = 413;
    error.code = "WEB_CAPTURE_IMAGE_TOO_LARGE";
    throw error;
  }
  const imageMetadata = await inspectImageBytes(imageBytes);
  if (!MIME_TO_FORMATS[mimeType]?.has(imageMetadata.format)) {
    const error = new Error(`Declared MIME type ${mimeType} does not match decoded ${imageMetadata.format || "unknown"} image bytes.`);
    error.statusCode = 400;
    error.code = "WEB_CAPTURE_MIME_MISMATCH";
    throw error;
  }

  const contentHash = createHash("sha256").update(imageBytes).digest("hex");
  let prompt = String(input.prompt || "").trim();
  const userMessage = String(input.user_message || input.userMessage || "").trim();
  const suppliedPromptStatus = String(input.prompt_status || input.promptStatus || "").trim();
  const trustedGenerationPrompt = suppliedPromptStatus === "generation-tool-prompt";
  // Short chat instructions must not become the primary prompt alone.
  // A trusted revised/generation prompt is authoritative even when it is short.
  if (!trustedGenerationPrompt && isWeakChatPrompt(prompt) && !looksLikeGenerationCaption(prompt)) {
    if (looksLikeGenerationCaption(userMessage)) {
      prompt = userMessage;
    } else {
      prompt = "";
    }
  }
  let promptStatus = PROMPT_STATUSES.has(suppliedPromptStatus)
    ? suppliedPromptStatus
    : prompt
      ? "user-message"
      : "not-available";
  if (!prompt) promptStatus = "not-available";
  // Accept generation-tool-prompt as a first-class status (Grok parity).
  const normalizedPromptStatus = promptStatus === "generation-tool-prompt" || suppliedPromptStatus === "generation-tool-prompt"
    ? (prompt ? "generation-tool-prompt" : "not-available")
    : promptStatus;

  const existing = await findAssetByContentHash(store, projectId, contentHash);
  if (existing) {
    const upgraded = await maybeUpgradePrompt(store, existing, {
      prompt,
      promptStatus: normalizedPromptStatus,
      userMessage: String(input.user_message || input.userMessage || "").trim(),
      promptSource: String(input.prompt_source || input.promptSource || "").trim(),
      model: String(input.model || "").trim(),
    });
    return {
      status: "skipped",
      reason: upgraded ? "already-archived-prompt-upgraded" : "already-archived-same-content",
      asset: upgraded || existing,
      contentHash,
      upgraded: Boolean(upgraded),
    };
  }

  await mkdir(tempRoot, { recursive: true });
  const tempName = `chatgpt-${Date.now()}-${randomBytes(4).toString("hex")}${ext}`;
  const tempPath = join(tempRoot, tempName);
  await writeFile(tempPath, imageBytes);

  try {
    const pageUrl = String(input.pageUrl || input.page_url || "").trim();
    const conversationId = String(input.conversationId || input.conversation_id || "").trim();
    const messageId = String(input.messageId || input.message_id || "").trim();
    const model = String(input.model || "").trim();
    // userMessage already parsed above for prompt hygiene
    const promptSource = String(input.prompt_source || input.promptSource || "").trim();
    const capturedAt = String(input.capturedAt || input.captured_at || new Date().toISOString());
    const assetId = sanitizeAssetId(input.assetId || `web-chatgpt-${contentHash.slice(0, 12)}`);

    const asset = await store.createAsset(
      {
        projectId,
        imagePath: tempPath,
        assetId,
        fileName: tempName,
        prompt,
        skill: "ChatGPT web capture",
        theme: promptTheme(prompt),
        tags: ["chatgpt", "web-capture", "auto-archived"],
        created_at: capturedAt,
        sourceType: "web-chatgpt",
        business_fields: {
          auto_archived: true,
          capture_channel: "chrome-extension",
          prompt_status: normalizedPromptStatus,
          prompt_source: promptSource || null,
          user_message: userMessage || null,
          file_bytes: imageBytes.length,
          mime_type: mimeType,
          width: imageMetadata.width,
          height: imageMetadata.height,
        },
        source: {
          generation_tool: "web-ui",
          provider: "chatgpt",
          model: model || null,
          page_url: pageUrl || null,
          conversation_id: conversationId || null,
          message_id: messageId || null,
          prompt_status: normalizedPromptStatus,
          prompt_source: promptSource || null,
          user_message: userMessage || null,
          captured_at: capturedAt,
          capture_extension_version: String(input.extensionVersion || input.extension_version || ""),
          content_sha256: contentHash,
        },
      },
      { trustedSourceRoots: [tempRoot] },
    );

    return {
      status: "imported",
      asset,
      contentHash,
    };
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

async function inspectImageBytes(imageBytes) {
  try {
    const metadata = await sharp(imageBytes, {
      failOn: "error",
      limitInputPixels: WEB_CAPTURE_MAX_IMAGE_PIXELS,
    }).metadata();
    const width = Number(metadata.width) || 0;
    const height = Number(metadata.height) || 0;
    const pages = Number(metadata.pages) || 1;
    const frameHeight = Number(metadata.pageHeight) || height;
    const totalPixels = width * frameHeight * pages;
    if (!width || !height || totalPixels > WEB_CAPTURE_MAX_IMAGE_PIXELS) {
      const error = new Error(`Image exceeds ${WEB_CAPTURE_MAX_IMAGE_PIXELS.toLocaleString("en-US")} pixel limit.`);
      error.statusCode = 413;
      error.code = "WEB_CAPTURE_PIXEL_LIMIT";
      throw error;
    }
    return { format: String(metadata.format || ""), width, height: frameHeight };
  } catch (error) {
    if (error?.code === "WEB_CAPTURE_PIXEL_LIMIT") throw error;
    if (/pixel limit|exceeds.*pixels|input image exceeds/i.test(String(error?.message || ""))) {
      const tooLarge = new Error(`Image exceeds ${WEB_CAPTURE_MAX_IMAGE_PIXELS.toLocaleString("en-US")} pixel limit.`);
      tooLarge.statusCode = 413;
      tooLarge.code = "WEB_CAPTURE_PIXEL_LIMIT";
      throw tooLarge;
    }
    const invalid = new Error("Image bytes are invalid, truncated, or exceed the decoded pixel limit.");
    invalid.statusCode = 400;
    invalid.code = "WEB_CAPTURE_BAD_IMAGE_BYTES";
    throw invalid;
  }
}

export function extractBearerToken(req) {
  const authorization = String(req?.headers?.authorization || "");
  if (authorization.startsWith("Bearer ")) return authorization.slice("Bearer ".length).trim();
  return String(req?.headers?.["x-mosa-token"] || "").trim();
}

function decodeImageBytes(input = {}) {
  if (Buffer.isBuffer(input.imageBytes)) return input.imageBytes;
  if (input.imageBytes instanceof Uint8Array) return Buffer.from(input.imageBytes);

  let raw = String(input.imageBase64 || input.image_base64 || "").trim();
  if (!raw) return Buffer.alloc(0);
  const dataUrl = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(raw);
  if (dataUrl) raw = dataUrl[1];
  try {
    return Buffer.from(raw, "base64");
  } catch {
    return Buffer.alloc(0);
  }
}

function safeTokenEqual(provided, configured) {
  if (!provided || !configured) return false;
  const providedBytes = Buffer.from(provided);
  const configuredBytes = Buffer.from(configured);
  return providedBytes.length === configuredBytes.length
    && timingSafeEqual(providedBytes, configuredBytes);
}

function normalizeMime(value) {
  const mime = String(value || "image/png").trim().toLowerCase();
  if (mime === "image/jpg") return "image/jpeg";
  return mime;
}

async function findAssetByContentHash(store, projectId, contentHash) {
  // Every ingest asks this question, so it must not cost a full project listing. Stores expose an
  // indexed lookup; the scan below only exists for store doubles that predate it.
  if (typeof store.findAssetByContentHash === "function") {
    return (await store.findAssetByContentHash(projectId, contentHash)) || null;
  }
  const [active, archived] = await Promise.all([
    store.listAssets({ projectId }),
    store.listAssets({ projectId, archived: true }).catch(() => []),
  ]);
  return [...active, ...archived].find((asset) => asset.source?.content_sha256 === contentHash) || null;
}

const PROMPT_STATUS_RANK = {
  "not-available": 0,
  "user-message": 1,
  "visible-caption": 2,
  "generation-tool-prompt": 3,
};

function promptRank(status, text) {
  const base = PROMPT_STATUS_RANK[status] ?? 0;
  return base * 10000 + Math.min(String(text || "").trim().length, 5000);
}

function placeHints(text) {
  const t = String(text || "");
  const hints = [];
  const rules = [
    [/北京|beijing/i, "beijing"],
    [/上海|shanghai/i, "shanghai"],
    [/东京|tokyo/i, "tokyo"],
    [/曼谷|bangkok/i, "bangkok"],
    [/首尔|seoul/i, "seoul"],
    [/巴黎|paris/i, "paris"],
    [/伦敦|london/i, "london"],
  ];
  for (const [re, key] of rules) {
    if (re.test(t)) hints.push(key);
  }
  return hints;
}

function mentionsAnyPlace(text, hints) {
  if (!hints.length) return false;
  const lower = String(text || "").toLowerCase();
  return hints.some((h) => lower.includes(h));
}

async function maybeUpgradePrompt(store, existing, next = {}) {
  if (!existing || typeof store.updateMetadata !== "function") return null;
  const nextPrompt = String(next.prompt || "").trim();
  if (!nextPrompt) return null;

  const currentPrompt = String(existing.prompt || "").trim();
  const currentStatus = existing.source?.prompt_status || existing.business_fields?.prompt_status || (currentPrompt ? "user-message" : "not-available");
  const nextStatus = next.promptStatus || "user-message";
  const currentRank = promptRank(currentStatus, currentPrompt);
  const nextRank = promptRank(nextStatus, nextPrompt);
  const userMsg = String(next.userMessage || next.user_message || "").trim();
  const places = placeHints(userMsg || nextPrompt);
  // Prefer a prompt that matches the user's requested place over a high-rank stale caption
  // (e.g. Bangkok caption while user asked for 北京).
  const placeUpgrade = places.length
    && mentionsAnyPlace(userMsg || nextPrompt, places)
    && !mentionsAnyPlace(currentPrompt, places)
    && (mentionsAnyPlace(nextPrompt, places) || /user edit|Generation caption|requested a different region/i.test(nextPrompt));
  // Only upgrade when clearly better (higher status, much longer, or place-consistency fix).
  if (!placeUpgrade && nextRank <= currentRank && !(nextPrompt.length > currentPrompt.length + 40 && nextRank >= currentRank)) {
    return null;
  }

  const source = {
    ...(existing.source || {}),
    prompt_status: nextStatus,
    prompt_source: next.promptSource || existing.source?.prompt_source || null,
    user_message: next.userMessage || existing.source?.user_message || null,
    model: next.model || existing.source?.model || null,
  };
  const business_fields = {
    ...(existing.business_fields || {}),
    prompt_status: nextStatus,
    prompt_source: next.promptSource || existing.business_fields?.prompt_source || null,
    user_message: next.userMessage || existing.business_fields?.user_message || null,
  };

  return store.updateMetadata(existing.project_id, existing.id, {
    prompt: nextPrompt,
    theme: promptTheme(nextPrompt),
    source,
    business_fields,
  });
}

function isWeakChatPrompt(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  if (t.length >= 120) return false;
  if (/^model caption:/i.test(t)) return false;
  // Short conversational / edit instructions.
  if (t.length < 80) return true;
  if (/^(换|改|再|做|来|在做|生成|请|帮|版本)/.test(t)) return true;
  return false;
}

function looksLikeGenerationCaption(text) {
  const t = String(text || "").trim();
  if (t.length < 80) return false;
  if (/^model caption:/i.test(t)) return true;
  const hits = [
    "poster", "illustration", "typography", "vector", "composition", "palette",
    "layout", "scene", "graphic", "cinematic", "海报", "插画", "构图", "风格",
  ].filter((w) => t.toLowerCase().includes(w.toLowerCase()));
  return hits.length >= 2 || (t.length > 200 && hits.length >= 1);
}

function promptTheme(prompt) {
  const text = String(prompt || "")
    .replace(/<\|has_watermark\|>/g, "")
    .replace(/\n?展开\s*$/g, "")
    .trim()
    .replace(/\s+/g, " ");
  if (!text) return "ChatGPT web image";
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function sanitizeAssetId(value) {
  return String(value || "web-chatgpt")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || `web-chatgpt-${Date.now()}`;
}
