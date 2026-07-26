import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { createdAtTimestamp } from "./recent-window.mjs";

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
  const promptSource = String(input.prompt_source || input.promptSource || "").trim();
  const trustedGenerationPrompt = ["generation-tool-prompt", "visible-caption"].includes(suppliedPromptStatus);
  // A ChatGPT user turn is provenance, not the model's revised generation prompt.
  if (!trustedGenerationPrompt) prompt = "";
  let promptStatus = PROMPT_STATUSES.has(suppliedPromptStatus)
    ? suppliedPromptStatus
    : prompt
      ? "user-message"
      : "not-available";
  if (!prompt) promptStatus = "not-available";
  const normalizedPromptStatus = trustedGenerationPrompt
    ? (prompt ? suppliedPromptStatus : "not-available")
    : promptStatus;

  const pixelHash = imageMetadata.pixelHash || "";
  // One lazy project listing per ingest, shared by the pixel fallback and the
  // turn-reference lookup, so neither reintroduces a scan of its own.
  const projectAssets = onceProjectListing(store, projectId);
  const existing = await findArchivedDuplicate(store, projectId, contentHash, pixelHash, projectAssets);
  if (existing) {
    const upgraded = await maybeUpgradePrompt(store, existing, {
      prompt,
      promptStatus: normalizedPromptStatus,
      userMessage: String(input.user_message || input.userMessage || "").trim(),
      promptSource: String(input.prompt_source || input.promptSource || "").trim(),
      model: String(input.model || "").trim(),
    });
    const sameBytes = existing.source?.content_sha256 === contentHash;
    return {
      status: "skipped",
      reason: upgraded
        ? "already-archived-prompt-upgraded"
        : sameBytes ? "already-archived-same-content" : "already-archived-same-pixels",
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
    const capturedAt = String(input.capturedAt || input.captured_at || new Date().toISOString());
    const assetId = sanitizeAssetId(input.assetId || `web-chatgpt-${contentHash.slice(0, 12)}`);
    // A photo the user uploaded as a generation reference, not a model output.
    const isReference = Boolean(input.is_reference ?? input.isReference);
    // A generated image records the references its own turn supplied, so the
    // library can answer "which pictures fed this one" instead of holding two
    // unrelated rows that merely share a conversation.
    const references = isReference
      ? []
      : await turnReferences(projectAssets, { conversationId, capturedAt, selfAssetId: assetId });

    const asset = await store.createAsset(
      {
        projectId,
        imagePath: tempPath,
        assetId,
        fileName: tempName,
        prompt,
        skill: "ChatGPT web capture",
        theme: promptTheme(prompt),
        tags: isReference
          ? ["chatgpt", "web-capture", "auto-archived", "reference"]
          : ["chatgpt", "web-capture", "auto-archived"],
        category: isReference ? "reference" : "",
        references,
        created_at: capturedAt,
        sourceType: "web-chatgpt",
        business_fields: {
          auto_archived: true,
          is_reference: isReference,
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
          pixel_sha256: pixelHash || null,
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
    if (!width || !height || width * height > WEB_CAPTURE_MAX_IMAGE_PIXELS) {
      const error = new Error(`Image exceeds ${WEB_CAPTURE_MAX_IMAGE_PIXELS.toLocaleString("en-US")} pixel limit.`);
      error.statusCode = 413;
      error.code = "WEB_CAPTURE_PIXEL_LIMIT";
      throw error;
    }
    return { format: String(metadata.format || ""), width, height, pixelHash: await pixelDigest(imageBytes) };
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

/**
 * A browser capture reaches MOSA either as the file the site served or as a
 * canvas re-encode of the very same picture. Those differ byte for byte, so the
 * file hash alone archived one image twice. The decoded pixels do not differ.
 * Alpha is dropped because a canvas snapshot always carries an opaque channel.
 */
async function pixelDigest(imageBytes) {
  try {
    const { data, info } = await sharp(imageBytes, {
      failOn: "error",
      limitInputPixels: WEB_CAPTURE_MAX_IMAGE_PIXELS,
    })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return createHash("sha256")
      .update(`${info.width}x${info.height}x${info.channels}:`)
      .update(data)
      .digest("hex");
  } catch {
    // Pixel dedupe is an optimisation; a failed decode falls back to the file hash.
    return "";
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

/** Active plus archived assets, fetched at most once per ingest. */
function onceProjectListing(store, projectId) {
  let pending = null;
  return () => {
    if (!pending) {
      pending = Promise.all([
        store.listAssets({ projectId }),
        store.listAssets({ projectId, archived: true }).catch(() => []),
      ]).then(([active, archived]) => [...active, ...archived]);
    }
    return pending;
  };
}

/**
 * Resolve "do I already hold this picture?" through two layers.
 *
 * Identical bytes are answered by the store's indexed lookup and must stay
 * indexed: every ingest asks this, and the scan it replaced was worst on a
 * miss, which is the normal case while capturing new images. Identical pixels
 * then catch the other encoding of one image, since a canvas snapshot carries
 * an opaque alpha channel the served file does not.
 *
 * The pixel layer runs only after the byte layer misses. `pixel_sha256` lives
 * inside `source_json` and cannot be indexed without promoting it to its own
 * column, so that layer still costs one project listing; the listing is shared
 * with the turn-reference lookup and is deliberately left un-indexed until a
 * later schema version.
 */
async function findArchivedDuplicate(store, projectId, contentHash, pixelHash, projectAssets) {
  const byBytes = typeof store.findAssetByContentHash === "function"
    ? await store.findAssetByContentHash(projectId, contentHash)
    : (await projectAssets()).find((asset) => asset.source?.content_sha256 === contentHash);
  if (byBytes) return byBytes;
  if (!pixelHash) return null;
  return (await projectAssets()).find((asset) => asset.source?.pixel_sha256 === pixelHash) || null;
}

/** At most this many references are attached to one generated image. */
const MAX_TURN_REFERENCES = 8;

/**
 * Find the reference images that belong to this generation's own turn.
 *
 * A conversation carries many uploads over its lifetime, and attaching all of
 * them would claim the model saw pictures it never received. The turn is
 * therefore bounded on both sides: a reference counts when it was captured
 * before this image and after the previous generated image in the same
 * conversation. A capture with no conversation identifier is never linked,
 * because nothing ties it to a turn.
 */
async function turnReferences(projectAssets, { conversationId, capturedAt, selfAssetId }) {
  if (!conversationId) return [];
  const now = createdAtTimestamp(capturedAt);
  if (!Number.isFinite(now)) return [];

  const members = (await projectAssets()).filter((asset) =>
    asset.id !== selfAssetId && asset.source?.conversation_id === conversationId);
  const timeOf = (asset) => createdAtTimestamp(asset.source?.captured_at || asset.created_at);

  let previousGeneration = -Infinity;
  for (const asset of members) {
    if (asset.business_fields?.is_reference) continue;
    const at = timeOf(asset);
    if (Number.isFinite(at) && at < now && at > previousGeneration) previousGeneration = at;
  }

  return members
    .filter((asset) => asset.business_fields?.is_reference)
    .map((asset) => ({ asset, at: timeOf(asset) }))
    .filter(({ at }) => Number.isFinite(at) && at <= now && at > previousGeneration)
    .sort((left, right) => left.at - right.at)
    .slice(0, MAX_TURN_REFERENCES)
    .map(({ asset }) => ({
      asset_id: asset.id,
      sha256: asset.source?.content_sha256 || "",
      // The capture cannot know what the reference was for, and guessing would
      // put an unearned declaration into the record. The creator names its
      // purpose and rights in the inspector.
      role: "",
      scope: [],
      applied: true,
    }));
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
  const userMsg = String(next.userMessage || next.user_message || "").trim();
  const currentUserMessage = String(existing.source?.user_message || existing.business_fields?.user_message || "").trim();
  if (!nextPrompt) {
    if (!userMsg || userMsg === currentUserMessage) return null;
    const source = {
      ...(existing.source || {}),
      prompt_source: next.promptSource || existing.source?.prompt_source || null,
      user_message: userMsg,
    };
    const business_fields = {
      ...(existing.business_fields || {}),
      prompt_source: next.promptSource || existing.business_fields?.prompt_source || null,
      user_message: userMsg,
    };
    return store.updateMetadata(existing.project_id, existing.id, { source, business_fields });
  }

  const currentPrompt = String(existing.prompt || "").trim();
  const currentStatus = existing.source?.prompt_status || existing.business_fields?.prompt_status || (currentPrompt ? "user-message" : "not-available");
  const nextStatus = next.promptStatus || "user-message";
  const currentRank = promptRank(currentStatus, currentPrompt);
  const nextRank = promptRank(nextStatus, nextPrompt);
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
