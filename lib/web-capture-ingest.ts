import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import sharp from "sharp";
import { createdAtTimestamp } from "./recent-window.js";
import { createReferenceAttachmentStore, type ReferenceAttachment } from "./reference-attachment-store.js";
import { PIXEL_HASH_VERSION, safePixelDigest } from "./image-pixel-hash.js";

const DEFAULT_PROJECT_ID = "default";
const PROVIDER_CONFIG = {
  chatgpt: {
    label: "ChatGPT",
    sourceType: "web-chatgpt",
    skill: "ChatGPT web capture",
    tempPrefix: "chatgpt",
    assetIdPrefix: "web-chatgpt",
  },
  gemini: {
    label: "Gemini",
    sourceType: "web-gemini",
    skill: "Gemini web capture",
    tempPrefix: "gemini",
    assetIdPrefix: "web-gemini",
  },
  flow: {
    label: "Flow",
    sourceType: "web-flow",
    skill: "Flow web capture",
    tempPrefix: "flow",
    assetIdPrefix: "web-flow",
  },
  "google-ai-studio": {
    label: "Google AI Studio",
    sourceType: "web-google-ai-studio",
    skill: "Google AI Studio web capture",
    tempPrefix: "google-ai-studio",
    assetIdPrefix: "web-google-ai-studio",
  },
} as const;
const ALLOWED_PROVIDERS = new Set(Object.keys(PROVIDER_CONFIG));
type ProviderId = keyof typeof PROVIDER_CONFIG;
const MIME_TO_EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif" };
const VIDEO_MIME_TO_EXT: Record<string, string> = { "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov", "video/x-m4v": ".m4v" };
const VIDEO_PROVIDERS = new Set(["flow", "google-ai-studio"]);
const PROMPT_STATUSES = new Set(["user-message", "visible-caption", "not-available", "generation-tool-prompt", "provider-visible-prompt"]);
const MIME_TO_FORMATS: Record<string, Set<string>> = { "image/png": new Set(["png"]), "image/jpeg": new Set(["jpeg"]), "image/webp": new Set(["webp"]), "image/gif": new Set(["gif"]), "image/avif": new Set(["avif", "heif"]) };
export const WEB_CAPTURE_MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const WEB_CAPTURE_MAX_VIDEO_BYTES = 96 * 1024 * 1024;
export const WEB_CAPTURE_MAX_IMAGE_PIXELS = 40_000_000;
export const WEB_CAPTURE_MAX_BODY_BYTES = Math.ceil(Math.max(WEB_CAPTURE_MAX_IMAGE_BYTES, WEB_CAPTURE_MAX_VIDEO_BYTES) / 3) * 4 + 1024 * 1024;

type Metadata = Record<string, unknown>;

interface StoredAsset {
  id: string;
  project_id: string;
  prompt?: string;
  theme?: string;
  source?: Metadata;
  business_fields?: Metadata;
  created_at?: string;
  [key: string]: unknown;
}

interface Store {
  createAsset(params: Metadata, options?: Metadata): Promise<StoredAsset>;
  listAssets(filters: Metadata): Promise<StoredAsset[]>;
  updateMetadata?(projectId: string, assetId: string, metadata: Metadata): Promise<StoredAsset>;
  recordGenerationEvent?(input: Metadata): Promise<Metadata>;
  findAssetByContentHash?(projectId: string, contentHash: string): Promise<StoredAsset | null>;
  findAssetByPixelHash?(projectId: string, pixelHash: string): Promise<StoredAsset | null>;
  libraryDir?: string;
  assetsRoot?: string;
  [key: string]: unknown;
}
interface WebCaptureInput { provider?: string; mediaKind?: string; media_kind?: string; mimeType?: string; mime_type?: string; imageBase64?: string; image_base64?: string; imageBytes?: Buffer | Uint8Array; mediaBase64?: string; media_base64?: string; mediaBytes?: Buffer | Uint8Array; width?: number; height?: number; durationSeconds?: number; duration_seconds?: number; prompt?: string; prompt_status?: string; promptStatus?: string; prompt_source?: string; promptSource?: string; user_message?: string; userMessage?: string; pageUrl?: string; page_url?: string; conversationId?: string; conversation_id?: string; messageId?: string; message_id?: string; generationContextId?: string; generation_context_id?: string; providerToolCallId?: string; provider_tool_call_id?: string; providerGenerationCallId?: string; provider_generation_call_id?: string; providerResponseId?: string; provider_response_id?: string; providerAssetId?: string; provider_asset_id?: string; model?: string; capturedAt?: string; captured_at?: string; captureMode?: string; capture_mode?: string; assetId?: string; is_reference?: boolean; isReference?: boolean; extensionVersion?: string; extension_version?: string; }
interface IngestResult { status: string; reason?: string; asset?: StoredAsset; attachment?: ReferenceAttachment; contentHash: string; upgraded?: boolean; recipeMerged?: boolean; }
interface WebCaptureIngest { ingest(input: WebCaptureInput, authToken?: string): Promise<IngestResult>; status(): Record<string, unknown>; assertToken(provided: string): void; readReference(projectId: string, fileName: string): Promise<{ stream: NodeJS.ReadableStream; fileName: string }>; pruneReferences(projectId: string, referencedIds: Iterable<string>): Promise<{ removed: number; retained: number; failed: number }>; tempRoot: string; token: string; }

export function createWebCaptureIngest(options: { store?: Store; libraryDir?: string; tempRoot?: string; projectId?: string; token?: string; allowedOrigins?: string[]; } = {}): WebCaptureIngest {
  const store = options.store as Store;
  if (!store || typeof store.createAsset !== "function" || typeof store.listAssets !== "function") throw new Error("Web capture ingest requires a MOSA store.");
  const libraryDir = resolve(options.libraryDir || store.libraryDir || store.assetsRoot!);
  const tempRoot = resolve(options.tempRoot || join(libraryDir, ".web-capture-tmp"));
  const referenceStore = createReferenceAttachmentStore(libraryDir);
  const projectId = options.projectId || DEFAULT_PROJECT_ID;
  const tokenSource = Object.hasOwn(options, "token") ? options.token : process.env.MOSA_WEB_CAPTURE_TOKEN;
  const token = String(tokenSource || "").trim();
  const allowedOriginCount = Array.isArray(options.allowedOrigins) ? options.allowedOrigins.length : 0;
  let ingestQueue: Promise<void> = Promise.resolve();
  const state: { enabled: boolean; providers: string[]; lastIngestAt: string | null; lastImportCount: number; totalImported: number; totalSkipped: number; lastError: string | null; lastSkippedReason: string | null } = { enabled: Boolean(token) && allowedOriginCount > 0, providers: Object.keys(PROVIDER_CONFIG), lastIngestAt: null, lastImportCount: 0, totalImported: 0, totalSkipped: 0, lastError: null, lastSkippedReason: null };
  function status(): Record<string, unknown> { return { ...state, tokenConfigured: Boolean(token), originConfigured: allowedOriginCount > 0, allowedOriginCount }; }
  function assertToken(provided: string): void {
    if (!token) { const e = new Error("Web capture is disabled until MOSA_WEB_CAPTURE_TOKEN is configured.") as Error & { statusCode: number; code: string; expose: boolean }; e.statusCode = 503; e.code = "WEB_CAPTURE_DISABLED"; e.expose = true; throw e; }
    if (!safeTokenEqual(String(provided || "").trim(), token)) { const e = new Error("Unauthorized web capture token.") as Error & { statusCode: number; code: string }; e.statusCode = 401; e.code = "WEB_CAPTURE_UNAUTHORIZED"; throw e; }
  }
  async function ingest(input: WebCaptureInput = {}, authToken = ""): Promise<IngestResult> {
    assertToken(authToken);
    const run = ingestQueue.then(() => ingestWebCapture({ store, referenceStore, tempRoot, projectId, input }));
    ingestQueue = run.then(() => undefined, () => undefined);
    try { const result = await run; state.lastIngestAt = new Date().toISOString(); state.lastError = null; if (result.status === "imported") { state.lastImportCount = 1; state.totalImported += 1; state.lastSkippedReason = null; } else { state.lastImportCount = 0; state.totalSkipped += 1; state.lastSkippedReason = result.reason || "skipped"; } return result; } catch (error) { state.lastError = error instanceof Error ? error.message : String(error); throw error; }
  }
  return { ingest, status, assertToken, readReference: referenceStore.read, pruneReferences: referenceStore.pruneUnused, tempRoot, token };
}

export async function ingestWebCapture(options: { store: Store; referenceStore?: ReturnType<typeof createReferenceAttachmentStore>; tempRoot: string; projectId?: string; input?: WebCaptureInput; }): Promise<IngestResult> {
  const { store, tempRoot, projectId = DEFAULT_PROJECT_ID, input = {} } = options;
  const provider = String(input.provider || "").trim().toLowerCase();
  if (!ALLOWED_PROVIDERS.has(provider)) { const e = new Error(`Unsupported provider: ${provider || "(empty)"}.`) as Error & { statusCode: number; code: string }; e.statusCode = 400; e.code = "WEB_CAPTURE_BAD_PROVIDER"; throw e; }
  const mediaKind = String(input.mediaKind || input.media_kind || "image").trim().toLowerCase();
  if (mediaKind === "video") return ingestWebVideoCapture({ ...options, projectId, input, provider });
  if (mediaKind !== "image") throw webCaptureError(`Unsupported media kind: ${mediaKind}.`, 400, "WEB_CAPTURE_BAD_MEDIA_KIND");
  const providerConfig = PROVIDER_CONFIG[provider as ProviderId];
  const mimeType = normalizeMime(input.mimeType || input.mime_type || "image/png"); const ext = MIME_TO_EXT[mimeType];
  if (!ext) { const e = new Error(`Unsupported image mime type: ${mimeType}`) as Error & { statusCode: number; code: string }; e.statusCode = 400; e.code = "WEB_CAPTURE_BAD_MIME"; throw e; }
  const imageBytes = decodeImageBytes(input);
  if (!imageBytes.length) { const e = new Error("imageBase64 is required.") as Error & { statusCode: number; code: string }; e.statusCode = 400; e.code = "WEB_CAPTURE_BAD_IMAGE"; throw e; }
  const isReference = Boolean(input.is_reference ?? input.isReference);
  const MIN_IMAGE_BYTES = 20 * 1024;
  if (!isReference && imageBytes.length < MIN_IMAGE_BYTES) { const e = new Error(`Image too small (${imageBytes.length} < ${MIN_IMAGE_BYTES}).`) as Error & { statusCode: number; code: string }; e.statusCode = 400; e.code = "WEB_CAPTURE_IMAGE_TOO_SMALL"; throw e; }
  if (imageBytes.length > WEB_CAPTURE_MAX_IMAGE_BYTES) { const e = new Error("Image exceeds 15 MiB limit.") as Error & { statusCode: number; code: string }; e.statusCode = 413; e.code = "WEB_CAPTURE_IMAGE_TOO_LARGE"; throw e; }
  const imageMetadata = await inspectImageBytes(imageBytes);
  if (!MIME_TO_FORMATS[mimeType]?.has(imageMetadata.format)) { const e = new Error(`MIME mismatch: ${mimeType} vs ${imageMetadata.format}`) as Error & { statusCode: number; code: string }; e.statusCode = 400; e.code = "WEB_CAPTURE_MIME_MISMATCH"; throw e; }
  const contentHash = createHash("sha256").update(imageBytes).digest("hex");
  let prompt = String(input.prompt || "").trim(); const userMessage = String(input.user_message || input.userMessage || "").trim();
  const suppliedPromptStatus = String(input.prompt_status || input.promptStatus || "").trim();
  const promptSource = String(input.prompt_source || input.promptSource || "").trim();
  const trustedGenerationPrompt = ["generation-tool-prompt", "visible-caption"].includes(suppliedPromptStatus);
  // Gemini, Flow, and AI Studio can expose a narrowly associated visible user
  // prompt. None is verified to be the exact prompt executed by the provider.
  const providerVisiblePrompt = ["gemini", "flow", "google-ai-studio"].includes(provider)
    && suppliedPromptStatus === "provider-visible-prompt";
  if (!trustedGenerationPrompt && !providerVisiblePrompt) prompt = "";
  let promptStatus = PROMPT_STATUSES.has(suppliedPromptStatus) ? suppliedPromptStatus : prompt ? "user-message" : "not-available";
  if (!prompt) promptStatus = "not-available";
  const normalizedPromptStatus = trustedGenerationPrompt || providerVisiblePrompt
    ? (prompt ? suppliedPromptStatus : "not-available")
    : promptStatus;
  const pixelHash = imageMetadata.pixelHash || "";
  const projectAssets = onceProjectListing(store, projectId);
  const pageUrl = String(input.pageUrl || input.page_url || "").trim(); const conversationId = String(input.conversationId || input.conversation_id || "").trim();
  const messageId = String(input.messageId || input.message_id || "").trim(); const model = String(input.model || "").trim();
  const generationContextId = String(input.generationContextId || input.generation_context_id || "").trim();
  const providerToolCallId = String(input.providerToolCallId || input.provider_tool_call_id || "").trim();
  const providerGenerationCallId = String(input.providerGenerationCallId || input.provider_generation_call_id || "").trim();
  const providerResponseId = String(input.providerResponseId || input.provider_response_id || "").trim();
  const providerAssetId = String(input.providerAssetId || input.provider_asset_id || "").trim();
  const captureSessionId = conversationId ? `${provider}:${conversationId}` : "";
  const generationBatchId = captureSessionId && messageId ? `${captureSessionId}:${messageId}` : "";
  const capturedAt = String(input.capturedAt || input.captured_at || new Date().toISOString());
  const captureMode = String(input.captureMode || input.capture_mode || "automatic").trim().toLowerCase() === "manual" ? "manual" : "automatic";
  const captureOccurrence = {
    provider,
    type: providerConfig.sourceType,
    page_url: pageUrl || null,
    conversation_id: conversationId || null,
    message_id: messageId || null,
    model: model || null,
    captured_at: capturedAt,
    capture_mode: captureMode,
    generation_context_id: generationContextId || null,
  };
  const referenceLibraryDir = store.libraryDir || (store.assetsRoot ? dirname(store.assetsRoot) : dirname(tempRoot));
  const referenceStore = options.referenceStore || createReferenceAttachmentStore(resolve(referenceLibraryDir));
  if (isReference) {
    const saved = await referenceStore.save({
      projectId, bytes: imageBytes, extension: ext, mimeType, width: imageMetadata.width, height: imageMetadata.height,
      provider, pageUrl, conversationId, messageId, generationContextId, providerAssetId, capturedAt, userMessage,
    });
    return {
      status: saved.created ? "imported" : "skipped",
      reason: saved.created
        ? undefined
        : saved.duplicateKind === "pixel"
          ? "reference-already-archived-same-pixels"
          : "reference-already-archived-same-content",
      attachment: saved.attachment,
      contentHash,
    };
  }
  const finalizeDuplicate = async (duplicate: StoredAsset): Promise<IngestResult> => {
    const existingWithOccurrence = await recordCaptureOccurrence(store, duplicate, captureOccurrence) || duplicate;
    // A provider-visible prompt must not upgrade an asset archived from a
    // different provider when the bytes happen to be identical.
    const existingProvider = String(existingWithOccurrence.source?.provider || "").trim().toLowerCase();
    const duplicatePromptAllowed = normalizedPromptStatus !== "provider-visible-prompt" || existingProvider === provider;
    const mergedRecipe = await mergeDuplicateGenerationRecipe(store, existingWithOccurrence, {
      projectAssets,
      referenceStore,
      projectId,
      conversationId,
      generationContextId,
      providerToolCallId,
      providerGenerationCallId,
      providerResponseId,
      providerAssetId,
      capturedAt,
      messageId,
      prompt: duplicatePromptAllowed ? prompt : "",
      promptStatus: duplicatePromptAllowed ? normalizedPromptStatus : "not-available",
      promptSource,
      userMessage,
      model,
      provider,
    });
    const upgraded = await maybeUpgradePrompt(store, mergedRecipe.asset, {
      prompt: duplicatePromptAllowed ? prompt : "",
      promptStatus: duplicatePromptAllowed ? normalizedPromptStatus : "not-available",
      userMessage,
      promptSource,
      model,
      provider,
    });
    const asset = upgraded || mergedRecipe.asset;
    await recordCapturedGeneration(store, asset, {
      projectId,
      provider,
      generationContextId,
      providerToolCallId,
      providerGenerationCallId,
      providerResponseId,
      providerAssetId,
      conversationId,
      messageId,
      generationBatchId,
      model,
      userMessage,
      prompt,
      promptStatus: normalizedPromptStatus,
      references: asset.references,
      capturedAt,
    });
    const sameBytes = asset.source?.content_sha256 === contentHash;
    return {
      status: "skipped",
      reason: upgraded
        ? "already-archived-prompt-upgraded"
        : mergedRecipe.merged
          ? "already-archived-recipe-merged"
          : sameBytes ? "already-archived-same-content" : "already-archived-same-pixels",
      asset,
      contentHash,
      upgraded: Boolean(upgraded),
      recipeMerged: mergedRecipe.merged,
    };
  };
  const existing = await findArchivedDuplicate(store, projectId, contentHash, pixelHash, projectAssets);
  if (existing) return finalizeDuplicate(existing);
  await mkdir(tempRoot, { recursive: true });
  const tempName = `${providerConfig.tempPrefix}-${Date.now()}-${randomBytes(4).toString("hex")}${ext}`; const tempPath = join(tempRoot, tempName);
  await writeFile(tempPath, imageBytes);
  try {
    const explicitAssetId = String(input.assetId || "").trim();
    let assetId = sanitizeAssetId(explicitAssetId || `${providerConfig.assetIdPrefix}-${contentHash.slice(0, 12)}`, providerConfig.assetIdPrefix);
    const references = await turnReferences(projectAssets, referenceStore, projectId, { conversationId, generationContextId, capturedAt, selfAssetId: assetId });
    const assetInput = {
      projectId,
      imagePath: tempPath,
      assetId,
      fileName: tempName,
      prompt,
      skill: providerConfig.skill,
      theme: promptTheme(prompt, providerConfig.label),
      tags: [provider, "web-capture", captureMode === "manual" ? "manual-capture" : "auto-archived"],
      category: "",
      references,
      created_at: capturedAt,
      sourceType: providerConfig.sourceType,
      business_fields: {
        auto_archived: captureMode !== "manual",
        capture_mode: captureMode,
        generation_context_id: generationContextId || null,
        capture_context_id: generationContextId || null,
        verification_level: "observed",
        is_reference: false,
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
        provider,
        type: providerConfig.sourceType,
        capture_mode: captureMode,
        generation_context_id: generationContextId || null,
        capture_context_id: generationContextId || null,
        provider_tool_call_id: providerToolCallId || null,
        provider_generation_call_id: providerGenerationCallId || null,
        provider_response_id: providerResponseId || null,
        provider_asset_id: providerAssetId || null,
        verification_level: "observed",
        capture_occurrences: [captureOccurrence],
        model: model || null,
        page_url: pageUrl || null,
        conversation_id: conversationId || null,
        message_id: messageId || null,
        capture_session_id: captureSessionId || null,
        generation_batch_id: generationBatchId || null,
        prompt_status: normalizedPromptStatus,
        prompt_source: promptSource || null,
        user_message: userMessage || null,
        captured_at: capturedAt,
        capture_extension_version: String(input.extensionVersion || input.extension_version || ""),
        content_sha256: contentHash,
        pixel_sha256: pixelHash || null,
        pixel_hash_version: pixelHash ? PIXEL_HASH_VERSION : null,
      },
    };
    let asset: StoredAsset;
    try {
      asset = await store.createAsset(assetInput, { trustedSourceRoots: [tempRoot], ingestMode: captureMode === "manual" ? "manual" : "automatic" });
    } catch (error) {
      // The compact deterministic ID is useful for ordinary captures, but two
      // independent runtimes can reserve the same filename before either one
      // publishes metadata. A unique candidate lets both attempts reach the
      // store's transactional content/pixel identity check. It also keeps a
      // genuine short-hash collision importable instead of misclassifying it.
      if (explicitAssetId || !isAssetAlreadyExists(error)) throw error;
      assetId = sanitizeAssetId(`${providerConfig.assetIdPrefix}-${contentHash.slice(0, 24)}-${randomBytes(4).toString("hex")}`, providerConfig.assetIdPrefix);
      asset = await store.createAsset({ ...assetInput, assetId }, { trustedSourceRoots: [tempRoot], ingestMode: captureMode === "manual" ? "manual" : "automatic" });
    }
    await recordCapturedGeneration(store, asset, {
      projectId,
      provider,
      generationContextId,
      providerToolCallId,
      providerGenerationCallId,
      providerResponseId,
      providerAssetId,
      conversationId,
      messageId,
      generationBatchId,
      model,
      userMessage,
      prompt,
      promptStatus: normalizedPromptStatus,
      references: asset.references,
      capturedAt,
    });
    return { status: "imported", asset, contentHash };
  } catch (error) {
    if (isAutomaticImportSuppressed(error)) return { status: "skipped", reason: "suppressed-after-delete", contentHash };
    if (isAutomaticIngestDuplicate(error)) {
      const duplicateId = String((error as { assetId?: unknown }).assetId || "");
      const duplicate = duplicateId
        ? (await projectAssets()).find((asset) => asset.id === duplicateId)
          || await findArchivedDuplicate(store, projectId, contentHash, pixelHash, projectAssets)
        : await findArchivedDuplicate(store, projectId, contentHash, pixelHash, projectAssets);
      if (duplicate) {
        return finalizeDuplicate(duplicate);
      }
    }
    throw error;
  } finally { await rm(tempPath, { force: true }).catch(() => {}); }
}

async function ingestWebVideoCapture(options: {
  store: Store;
  referenceStore?: ReturnType<typeof createReferenceAttachmentStore>;
  tempRoot: string;
  projectId: string;
  input: WebCaptureInput;
  provider: string;
}): Promise<IngestResult> {
  const { store, tempRoot, projectId, input, provider } = options;
  if (!VIDEO_PROVIDERS.has(provider)) throw webCaptureError(`Provider does not support web video capture: ${provider}.`, 400, "WEB_CAPTURE_BAD_VIDEO_PROVIDER");
  if (Boolean(input.is_reference ?? input.isReference)) throw webCaptureError("Video reference capture is not supported.", 400, "WEB_CAPTURE_BAD_VIDEO_REFERENCE");
  const providerConfig = PROVIDER_CONFIG[provider as ProviderId];
  const mimeType = normalizeMime(input.mimeType || input.mime_type || "video/mp4");
  const ext = VIDEO_MIME_TO_EXT[mimeType];
  if (!ext) throw webCaptureError(`Unsupported video mime type: ${mimeType}`, 400, "WEB_CAPTURE_BAD_MIME");
  const videoBytes = decodeMediaBytes(input);
  if (!videoBytes.length) throw webCaptureError("mediaBase64 is required for video capture.", 400, "WEB_CAPTURE_BAD_VIDEO");
  const MIN_VIDEO_BYTES = 64 * 1024;
  if (videoBytes.length < MIN_VIDEO_BYTES) throw webCaptureError(`Video too small (${videoBytes.length} < ${MIN_VIDEO_BYTES}).`, 400, "WEB_CAPTURE_VIDEO_TOO_SMALL");
  if (videoBytes.length > WEB_CAPTURE_MAX_VIDEO_BYTES) throw webCaptureError("Video exceeds 96 MiB limit.", 413, "WEB_CAPTURE_VIDEO_TOO_LARGE");
  assertVideoContainer(videoBytes, mimeType);

  const contentHash = createHash("sha256").update(videoBytes).digest("hex");
  let prompt = String(input.prompt || "").trim();
  const userMessage = String(input.user_message || input.userMessage || "").trim();
  const suppliedPromptStatus = String(input.prompt_status || input.promptStatus || "").trim();
  const promptSource = String(input.prompt_source || input.promptSource || "").trim();
  const trustedGenerationPrompt = ["generation-tool-prompt", "visible-caption"].includes(suppliedPromptStatus);
  const providerVisiblePrompt = suppliedPromptStatus === "provider-visible-prompt";
  if (!trustedGenerationPrompt && !providerVisiblePrompt) prompt = "";
  const normalizedPromptStatus = prompt && (trustedGenerationPrompt || providerVisiblePrompt)
    ? suppliedPromptStatus
    : "not-available";
  const projectAssets = onceProjectListing(store, projectId);
  const pageUrl = String(input.pageUrl || input.page_url || "").trim();
  const conversationId = String(input.conversationId || input.conversation_id || "").trim();
  const messageId = String(input.messageId || input.message_id || "").trim();
  const model = String(input.model || "").trim();
  const generationContextId = String(input.generationContextId || input.generation_context_id || "").trim();
  const providerToolCallId = String(input.providerToolCallId || input.provider_tool_call_id || "").trim();
  const providerGenerationCallId = String(input.providerGenerationCallId || input.provider_generation_call_id || "").trim();
  const providerResponseId = String(input.providerResponseId || input.provider_response_id || "").trim();
  const providerAssetId = String(input.providerAssetId || input.provider_asset_id || "").trim();
  const captureSessionId = conversationId ? `${provider}:${conversationId}` : "";
  const generationBatchId = captureSessionId && messageId ? `${captureSessionId}:${messageId}` : "";
  const capturedAt = String(input.capturedAt || input.captured_at || new Date().toISOString());
  const captureMode = String(input.captureMode || input.capture_mode || "automatic").trim().toLowerCase() === "manual" ? "manual" : "automatic";
  const width = normalizeMediaMetric(input.width, 16_384);
  const height = normalizeMediaMetric(input.height, 16_384);
  const durationSeconds = normalizeMediaMetric(input.durationSeconds ?? input.duration_seconds, 3600, true);
  const captureOccurrence = {
    provider,
    type: providerConfig.sourceType,
    media_kind: "video",
    page_url: pageUrl || null,
    conversation_id: conversationId || null,
    message_id: messageId || null,
    model: model || null,
    captured_at: capturedAt,
    capture_mode: captureMode,
    generation_context_id: generationContextId || null,
  };
  const referenceLibraryDir = store.libraryDir || (store.assetsRoot ? dirname(store.assetsRoot) : dirname(tempRoot));
  const referenceStore = options.referenceStore || createReferenceAttachmentStore(resolve(referenceLibraryDir));

  const finalizeDuplicate = async (duplicate: StoredAsset): Promise<IngestResult> => {
    const existingWithOccurrence = await recordCaptureOccurrence(store, duplicate, captureOccurrence) || duplicate;
    const mergedRecipe = await mergeDuplicateGenerationRecipe(store, existingWithOccurrence, {
      projectAssets,
      referenceStore,
      projectId,
      conversationId,
      generationContextId,
      providerToolCallId,
      providerGenerationCallId,
      providerResponseId,
      providerAssetId,
      capturedAt,
      messageId,
      prompt,
      promptStatus: normalizedPromptStatus,
      promptSource,
      userMessage,
      model,
      provider,
    });
    const upgraded = await maybeUpgradePrompt(store, mergedRecipe.asset, {
      prompt,
      promptStatus: normalizedPromptStatus,
      userMessage,
      promptSource,
      model,
      provider,
    });
    const asset = upgraded || mergedRecipe.asset;
    await recordCapturedGeneration(store, asset, {
      projectId,
      provider,
      generationContextId,
      providerToolCallId,
      providerGenerationCallId,
      providerResponseId,
      providerAssetId,
      conversationId,
      messageId,
      generationBatchId,
      model,
      userMessage,
      prompt,
      promptStatus: normalizedPromptStatus,
      references: asset.references,
      capturedAt,
    });
    return {
      status: "skipped",
      reason: upgraded
        ? "already-archived-prompt-upgraded"
        : mergedRecipe.merged
          ? "already-archived-recipe-merged"
          : "already-archived-same-content",
      asset,
      contentHash,
      upgraded: Boolean(upgraded),
      recipeMerged: mergedRecipe.merged,
    };
  };

  const existing = await findArchivedDuplicate(store, projectId, contentHash, "", projectAssets);
  if (existing) return finalizeDuplicate(existing);
  await mkdir(tempRoot, { recursive: true });
  const tempName = `${providerConfig.tempPrefix}-video-${Date.now()}-${randomBytes(4).toString("hex")}${ext}`;
  const tempPath = join(tempRoot, tempName);
  await writeFile(tempPath, videoBytes);
  try {
    const explicitAssetId = String(input.assetId || "").trim();
    let assetId = sanitizeAssetId(explicitAssetId || `${providerConfig.assetIdPrefix}-video-${contentHash.slice(0, 12)}`, providerConfig.assetIdPrefix);
    const references = await turnReferences(projectAssets, referenceStore, projectId, { conversationId, generationContextId, capturedAt, selfAssetId: assetId });
    const assetInput = {
      projectId,
      imagePath: tempPath,
      assetId,
      fileName: tempName,
      prompt,
      skill: providerConfig.skill,
      theme: promptTheme(prompt, providerConfig.label),
      tags: [provider, "web-capture", "video", captureMode === "manual" ? "manual-capture" : "auto-archived"],
      category: "",
      references,
      created_at: capturedAt,
      sourceType: providerConfig.sourceType,
      business_fields: {
        auto_archived: captureMode !== "manual",
        capture_mode: captureMode,
        generation_context_id: generationContextId || null,
        capture_context_id: generationContextId || null,
        verification_level: "observed",
        is_reference: false,
        capture_channel: "chrome-extension",
        media_kind: "video",
        prompt_status: normalizedPromptStatus,
        prompt_source: promptSource || null,
        user_message: userMessage || null,
        file_bytes: videoBytes.length,
        mime_type: mimeType,
        width: width || null,
        height: height || null,
        duration_seconds: durationSeconds || null,
      },
      source: {
        generation_tool: "web-ui",
        provider,
        type: providerConfig.sourceType,
        media_kind: "video",
        capture_mode: captureMode,
        generation_context_id: generationContextId || null,
        capture_context_id: generationContextId || null,
        provider_tool_call_id: providerToolCallId || null,
        provider_generation_call_id: providerGenerationCallId || null,
        provider_response_id: providerResponseId || null,
        provider_asset_id: providerAssetId || null,
        verification_level: "observed",
        capture_occurrences: [captureOccurrence],
        model: model || null,
        page_url: pageUrl || null,
        conversation_id: conversationId || null,
        message_id: messageId || null,
        capture_session_id: captureSessionId || null,
        generation_batch_id: generationBatchId || null,
        prompt_status: normalizedPromptStatus,
        prompt_source: promptSource || null,
        user_message: userMessage || null,
        captured_at: capturedAt,
        capture_extension_version: String(input.extensionVersion || input.extension_version || ""),
        content_sha256: contentHash,
        pixel_sha256: null,
        pixel_hash_version: null,
      },
    };
    let asset: StoredAsset;
    try {
      asset = await store.createAsset(assetInput, { trustedSourceRoots: [tempRoot], ingestMode: captureMode === "manual" ? "manual" : "automatic" });
    } catch (error) {
      if (explicitAssetId || !isAssetAlreadyExists(error)) throw error;
      assetId = sanitizeAssetId(`${providerConfig.assetIdPrefix}-video-${contentHash.slice(0, 24)}-${randomBytes(4).toString("hex")}`, providerConfig.assetIdPrefix);
      asset = await store.createAsset({ ...assetInput, assetId }, { trustedSourceRoots: [tempRoot], ingestMode: captureMode === "manual" ? "manual" : "automatic" });
    }
    await recordCapturedGeneration(store, asset, {
      projectId,
      provider,
      generationContextId,
      providerToolCallId,
      providerGenerationCallId,
      providerResponseId,
      providerAssetId,
      conversationId,
      messageId,
      generationBatchId,
      model,
      userMessage,
      prompt,
      promptStatus: normalizedPromptStatus,
      references: asset.references,
      capturedAt,
    });
    return { status: "imported", asset, contentHash };
  } catch (error) {
    if (isAutomaticImportSuppressed(error)) return { status: "skipped", reason: "suppressed-after-delete", contentHash };
    if (isAutomaticIngestDuplicate(error)) {
      const duplicateId = String((error as { assetId?: unknown }).assetId || "");
      const duplicate = duplicateId
        ? (await projectAssets()).find((asset) => asset.id === duplicateId) || await findArchivedDuplicate(store, projectId, contentHash, "", projectAssets)
        : await findArchivedDuplicate(store, projectId, contentHash, "", projectAssets);
      if (duplicate) return finalizeDuplicate(duplicate);
    }
    throw error;
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

export function extractBearerToken(req: { headers?: Record<string, unknown> } | undefined | null): string {
  const authorization = String(req?.headers?.authorization || "");
  if (authorization.startsWith("Bearer ")) return authorization.slice("Bearer ".length).trim();
  return String(req?.headers?.["x-mosa-token"] || "").trim();
}

async function recordCapturedGeneration(store: Store, asset: StoredAsset, input: {
  projectId: string;
  provider: string;
  generationContextId: string;
  providerToolCallId?: string;
  providerGenerationCallId?: string;
  providerResponseId?: string;
  providerAssetId?: string;
  conversationId: string;
  messageId: string;
  generationBatchId: string;
  model: string;
  userMessage: string;
  prompt: string;
  promptStatus: string;
  references?: unknown;
  capturedAt: string;
}): Promise<Metadata | null> {
  if (typeof store.recordGenerationEvent !== "function" || !asset?.id) return null;
  return store.recordGenerationEvent({
    project_id: input.projectId,
    output_asset_id: asset.id,
    provider: input.provider,
    capture_context_id: input.generationContextId,
    provider_tool_call_id: input.providerToolCallId || "",
    provider_generation_call_id: input.providerGenerationCallId || "",
    provider_response_id: input.providerResponseId || "",
    provider_asset_id: input.providerAssetId || "",
    conversation_id: input.conversationId,
    message_id: input.messageId,
    batch_id: input.generationBatchId,
    model: input.model,
    user_prompt: input.userMessage,
    effective_prompt: input.prompt,
    prompt_status: input.promptStatus,
    capture_channel: "chrome-extension",
    verification_level: "observed",
    references: Array.isArray(input.references) ? input.references : [],
    evidence: {
      source: "web-capture",
      relation_status: "unresolved",
      note: "Observed from provider web UI/runtime metadata; not provider-API verified.",
    },
    created_at: input.capturedAt,
  });
}

function webCaptureError(message: string, statusCode: number, code: string): Error & { statusCode: number; code: string } {
  const error = new Error(message) as Error & { statusCode: number; code: string };
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function isAutomaticImportSuppressed(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "AUTOMATIC_IMPORT_SUPPRESSED");
}

function isAutomaticIngestDuplicate(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "AUTOMATIC_INGEST_DUPLICATE");
}

function isAssetAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "ASSET_ALREADY_EXISTS");
}

async function inspectImageBytes(imageBytes: Buffer): Promise<{ format: string; width: number; height: number; pixelHash: string }> {
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
      throw webCaptureError(
        "Image exceeds " + WEB_CAPTURE_MAX_IMAGE_PIXELS.toLocaleString("en-US") + " pixel limit.",
        413,
        "WEB_CAPTURE_PIXEL_LIMIT",
      );
    }
    return {
      format: String(metadata.format || ""),
      width,
      height: frameHeight,
      pixelHash: await safePixelDigest(imageBytes, { limitInputPixels: WEB_CAPTURE_MAX_IMAGE_PIXELS }),
    };
  } catch (error: unknown) {
    if ((error as { code?: string })?.code === "WEB_CAPTURE_PIXEL_LIMIT") throw error;
    const detail = error instanceof Error ? error.message : String(error);
    if (/pixel limit|exceeds.*pixels|input image exceeds/i.test(detail)) {
      throw webCaptureError(
        "Image exceeds " + WEB_CAPTURE_MAX_IMAGE_PIXELS.toLocaleString("en-US") + " pixel limit.",
        413,
        "WEB_CAPTURE_PIXEL_LIMIT",
      );
    }
    throw webCaptureError(
      "Image bytes are invalid, truncated, or exceed the decoded pixel limit.",
      400,
      "WEB_CAPTURE_BAD_IMAGE_BYTES",
    );
  }
}

function decodeImageBytes(input: WebCaptureInput): Buffer {
  if (Buffer.isBuffer(input.imageBytes)) return input.imageBytes;
  if (input.imageBytes instanceof Uint8Array) return Buffer.from(input.imageBytes);
  let raw = String(input.imageBase64 || input.image_base64 || "").trim(); if (!raw) return Buffer.alloc(0);
  const dataUrl = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(raw); if (dataUrl) raw = dataUrl[1];
  try { return Buffer.from(raw, "base64"); } catch { return Buffer.alloc(0); }
}

function decodeMediaBytes(input: WebCaptureInput): Buffer {
  if (Buffer.isBuffer(input.mediaBytes)) return input.mediaBytes;
  if (input.mediaBytes instanceof Uint8Array) return Buffer.from(input.mediaBytes);
  let raw = String(input.mediaBase64 || input.media_base64 || "").trim();
  if (!raw) return Buffer.alloc(0);
  const dataUrl = /^data:video\/[a-z0-9.+-]+;base64,(.+)$/i.exec(raw);
  if (dataUrl) raw = dataUrl[1];
  try { return Buffer.from(raw, "base64"); } catch { return Buffer.alloc(0); }
}

function assertVideoContainer(bytes: Buffer, mimeType: string): void {
  const header = bytes.subarray(0, 32);
  if (mimeType === "video/webm") {
    if (header.length < 4 || header[0] !== 0x1a || header[1] !== 0x45 || header[2] !== 0xdf || header[3] !== 0xa3) {
      throw webCaptureError("Video bytes do not match WebM container.", 400, "WEB_CAPTURE_MIME_MISMATCH");
    }
    return;
  }
  if (["video/mp4", "video/quicktime", "video/x-m4v"].includes(mimeType)) {
    const marker = header.subarray(4, 12).toString("ascii");
    if (!marker.includes("ftyp")) {
      throw webCaptureError("Video bytes do not match ISO BMFF container.", 400, "WEB_CAPTURE_MIME_MISMATCH");
    }
  }
}

function normalizeMediaMetric(value: unknown, max: number, allowFraction = false): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > max) return 0;
  return allowFraction ? number : Math.round(number);
}

function safeTokenEqual(provided: string, configured: string): boolean { if (!provided || !configured) return false; const a = Buffer.from(provided); const b = Buffer.from(configured); return a.length === b.length && timingSafeEqual(a, b); }
function normalizeMime(value: string): string { const m = String(value || "image/png").trim().toLowerCase(); return m === "image/jpg" ? "image/jpeg" : m; }
function onceProjectListing(store: Store, projectId: string): () => Promise<StoredAsset[]> { let pending: Promise<StoredAsset[]> | null = null; return () => { if (!pending) pending = Promise.all([store.listAssets({ projectId }), store.listAssets({ projectId, archived: true }).catch(() => [])]).then(([a, b]) => [...a, ...b]); return pending; }; }
async function findArchivedDuplicate(store: Store, projectId: string, contentHash: string, pixelHash: string, projectAssets: () => Promise<StoredAsset[]>): Promise<StoredAsset | null> {
  const byBytes = typeof store.findAssetByContentHash === "function" ? await store.findAssetByContentHash(projectId, contentHash) : (await projectAssets()).find((a) => a.source?.content_sha256 === contentHash) || null;
  if (byBytes) return byBytes;
  if (!pixelHash) return null;
  const indexedMatch = typeof store.findAssetByPixelHash === "function"
    ? await store.findAssetByPixelHash(projectId, pixelHash)
    : (await projectAssets()).find((a) => a.source?.pixel_sha256 === pixelHash) || null;
  if (indexedMatch && await isTrustedPixelMatch(store, indexedMatch, pixelHash)) return indexedMatch;
  const candidates = (await projectAssets()).filter((asset) => asset.source?.pixel_sha256 === pixelHash && asset.id !== indexedMatch?.id);
  for (const candidate of candidates) if (await isTrustedPixelMatch(store, candidate, pixelHash)) return candidate;
  return null;
}

async function isTrustedPixelMatch(store: Store, asset: StoredAsset, pixelHash: string): Promise<boolean> {
  if (asset.source?.pixel_hash_version === PIXEL_HASH_VERSION) return true;
  const imagePath = typeof asset.image_path === "string" ? asset.image_path : "";
  if (!imagePath) return false;
  const trusted = await safePixelDigest(imagePath, { limitInputPixels: WEB_CAPTURE_MAX_IMAGE_PIXELS }).then((hash) => hash === pixelHash, () => false);
  if (!trusted) return false;
  if (typeof store.updateMetadata === "function") {
    const nextSource = { ...(asset.source || {}), pixel_sha256: pixelHash, pixel_hash_version: PIXEL_HASH_VERSION };
    await store.updateMetadata(asset.project_id, asset.id, { source: nextSource }).then(() => { asset.source = nextSource; }, () => {});
  }
  return true;
}

const MAX_TURN_REFERENCES = 8;

async function turnReferences(projectAssets: () => Promise<StoredAsset[]>, referenceStore: ReturnType<typeof createReferenceAttachmentStore>, projectId: string, { conversationId, generationContextId, capturedAt, selfAssetId }: { conversationId: string; generationContextId: string; capturedAt: string; selfAssetId: string }): Promise<Metadata[]> {
  if (!conversationId && !generationContextId) return [];
  const now = createdAtTimestamp(capturedAt);
  if (now === null) return [];

  const attachments = await referenceStore.list(projectId);
  if (generationContextId) {
    return attachments
      .map((attachment) => ({
        attachment,
        usage: attachment.usages?.find((usage) => usage.generation_context_id === generationContextId),
      }))
      .filter((entry): entry is { attachment: ReferenceAttachment; usage: ReferenceAttachment["usages"][number] } => Boolean(entry.usage))
      .slice(0, MAX_TURN_REFERENCES)
      .map(({ attachment, usage }) => referenceMetadata(attachment, usage));
  }

  const members = (await projectAssets()).filter((asset) =>
    asset.id !== selfAssetId && asset.source?.conversation_id === conversationId);
  const timeOf = (asset: StoredAsset) => createdAtTimestamp(asset.source?.captured_at || asset.created_at);

  let previousGeneration = -Infinity;
  for (const asset of members) {
    if (asset.business_fields?.is_reference) continue;
    const at = timeOf(asset);
    if (at !== null && at < now && at > previousGeneration) previousGeneration = at;
  }

  return attachments
    .flatMap((attachment) => (attachment.usages?.length ? attachment.usages : [{
      generation_context_id: "",
      provider: attachment.provider,
      page_url: attachment.page_url,
      conversation_id: attachment.conversation_id,
      message_id: attachment.message_id,
      provider_asset_id: attachment.provider_asset_id,
      captured_at: attachment.captured_at,
      user_message: attachment.user_message,
    }])
      .filter((usage) => usage.conversation_id === conversationId)
      .map((usage) => ({ attachment, usage, at: createdAtTimestamp(usage.captured_at) })))
    .filter((entry): entry is { attachment: ReferenceAttachment; usage: ReferenceAttachment["usages"][number]; at: number } => entry.at !== null && entry.at <= now && entry.at > previousGeneration)
    .sort((left, right) => left.at - right.at)
    .slice(0, MAX_TURN_REFERENCES)
    .map(({ attachment, usage }) => referenceMetadata(attachment, usage));
}

function referenceMetadata(attachment: ReferenceAttachment, usage?: ReferenceAttachment["usages"][number]): Metadata {
  return {
    reference_id: attachment.id,
    asset_id: attachment.id,
    provider_asset_id: usage?.provider_asset_id || attachment.provider_asset_id,
    sha256: attachment.content_sha256,
    attachment_url: attachment.attachment_url,
    mime_type: attachment.mime_type,
    width: attachment.width,
    height: attachment.height,
    role: "",
    scope: [],
    applied: true,
    application_status: "observed_input",
    verification_level: "observed",
  };
}

async function mergeDuplicateGenerationRecipe(
  store: Store,
  existing: StoredAsset,
  input: {
    projectAssets: () => Promise<StoredAsset[]>;
    referenceStore: ReturnType<typeof createReferenceAttachmentStore>;
    projectId: string;
    conversationId: string;
    generationContextId: string;
    providerToolCallId?: string;
    providerGenerationCallId?: string;
    providerResponseId?: string;
    providerAssetId?: string;
    capturedAt: string;
    messageId: string;
    prompt: string;
    promptStatus: string;
    promptSource: string;
    userMessage: string;
    model: string;
    provider: string;
  },
): Promise<{ asset: StoredAsset; merged: boolean }> {
  if (typeof store.updateMetadata !== "function") return { asset: existing, merged: false };
  const references = await turnReferences(input.projectAssets, input.referenceStore, input.projectId, {
    conversationId: input.conversationId,
    generationContextId: input.generationContextId,
    capturedAt: input.capturedAt,
    selfAssetId: existing.id,
  });
  const currentReferences = Array.isArray(existing.references) ? existing.references : [];
  const currentContext = String(existing.source?.generation_context_id || existing.business_fields?.generation_context_id || "");
  const contextChanged = Boolean(input.generationContextId && input.generationContextId !== currentContext);
  const referencesChanged = referenceIdentityList(currentReferences) !== referenceIdentityList(references);
  // Plain prompt/user-message upgrades are handled by maybeUpgradePrompt below.
  // This merge exists specifically for a distinct generation occurrence or a
  // late-arriving reference set, otherwise it would swallow the normal upgrade signal.
  if (!contextChanged && !referencesChanged) return { asset: existing, merged: false };

  const updated = await store.updateMetadata(existing.project_id, existing.id, {
    ...(input.prompt ? { prompt: input.prompt, theme: promptTheme(input.prompt, providerLabelFor(input.provider)) } : {}),
    references,
    source: {
      ...(existing.source || {}),
      generation_context_id: input.generationContextId || existing.source?.generation_context_id || null,
      capture_context_id: input.generationContextId || existing.source?.capture_context_id || existing.source?.generation_context_id || null,
      provider_tool_call_id: input.providerToolCallId || existing.source?.provider_tool_call_id || null,
      provider_generation_call_id: input.providerGenerationCallId || existing.source?.provider_generation_call_id || null,
      provider_response_id: input.providerResponseId || existing.source?.provider_response_id || null,
      provider_asset_id: input.providerAssetId || existing.source?.provider_asset_id || null,
      verification_level: existing.source?.verification_level || "observed",
      message_id: input.messageId || existing.source?.message_id || null,
      prompt_status: input.prompt ? input.promptStatus : existing.source?.prompt_status || "not-available",
      prompt_source: input.promptSource || existing.source?.prompt_source || null,
      user_message: input.userMessage || existing.source?.user_message || null,
      model: input.model || existing.source?.model || null,
    },
    business_fields: {
      ...(existing.business_fields || {}),
      generation_context_id: input.generationContextId || existing.business_fields?.generation_context_id || null,
      capture_context_id: input.generationContextId || existing.business_fields?.capture_context_id || existing.business_fields?.generation_context_id || null,
      verification_level: existing.business_fields?.verification_level || "observed",
      prompt_status: input.prompt ? input.promptStatus : existing.business_fields?.prompt_status || "not-available",
      prompt_source: input.promptSource || existing.business_fields?.prompt_source || null,
      user_message: input.userMessage || existing.business_fields?.user_message || null,
    },
    recipe_change_summary: contextChanged ? "Generation occurrence merged" : "Generation references merged",
  });
  return { asset: updated, merged: true };
}

function referenceIdentityList(references: unknown): string {
  if (!Array.isArray(references)) return "";
  return references.map((reference) => {
    const item = reference && typeof reference === "object" ? reference as Record<string, unknown> : {};
    return String(item.reference_id || item.asset_id || item.sha256 || item.attachment_url || "");
  }).filter(Boolean).sort().join("|");
}

const PROMPT_STATUS_RANK: Record<string, number> = {
  "not-available": 0,
  "user-message": 1,
  "provider-visible-prompt": 1,
  "visible-caption": 2,
  "generation-tool-prompt": 3,
};

function promptRank(status: string, text: unknown): number {
  const base = PROMPT_STATUS_RANK[status] ?? 0;
  return base * 10000 + Math.min(String(text || "").trim().length, 5000);
}

function placeHints(text: unknown): string[] {
  const value = String(text || "");
  const hints: string[] = [];
  const rules: Array<[RegExp, string]> = [
    [/北京|beijing/i, "beijing"],
    [/上海|shanghai/i, "shanghai"],
    [/东京|tokyo/i, "tokyo"],
    [/曼谷|bangkok/i, "bangkok"],
    [/首尔|seoul/i, "seoul"],
    [/巴黎|paris/i, "paris"],
    [/伦敦|london/i, "london"],
  ];
  for (const [pattern, key] of rules) {
    if (pattern.test(value)) hints.push(key);
  }
  return hints;
}

function mentionsAnyPlace(text: unknown, hints: string[]): boolean {
  if (!hints.length) return false;
  const lower = String(text || "").toLowerCase();
  return hints.some((hint) => lower.includes(hint));
}

function captureOccurrenceKey(value: Record<string, unknown>): string {
  return [
    value.provider,
    value.type,
    value.page_url,
    value.conversation_id,
    value.message_id,
    value.generation_context_id,
    value.capture_mode,
  ].map((part) => String(part || "")).join("|");
}

async function recordCaptureOccurrence(
  store: Store,
  existing: StoredAsset,
  occurrence: Record<string, unknown>,
): Promise<StoredAsset | null> {
  if (typeof store.updateMetadata !== "function") return null;
  const current = Array.isArray(existing.source?.capture_occurrences)
    ? existing.source.capture_occurrences.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    : [];
  const key = captureOccurrenceKey(occurrence);
  if (current.some((entry) => captureOccurrenceKey(entry) === key)) return existing;
  return store.updateMetadata(existing.project_id, existing.id, {
    source: {
      ...(existing.source || {}),
      capture_occurrences: [...current, occurrence].slice(-40),
    },
  });
}

interface PromptUpgrade {
  prompt?: string;
  promptStatus?: string;
  userMessage?: string;
  user_message?: string;
  promptSource?: string;
  model?: string;
  provider?: string;
}

async function maybeUpgradePrompt(store: Store, existing: StoredAsset, next: PromptUpgrade = {}): Promise<StoredAsset | null> {
  if (typeof store.updateMetadata !== "function") return null;
  const nextPrompt = String(next.prompt || "").trim();
  const userMessage = String(next.userMessage || next.user_message || "").trim();
  const currentUserMessage = String(existing.source?.user_message || existing.business_fields?.user_message || "").trim();
  if (!nextPrompt) {
    if (!userMessage || userMessage === currentUserMessage) return null;
    return store.updateMetadata(existing.project_id, existing.id, {
      source: {
        ...(existing.source || {}),
        prompt_source: next.promptSource || existing.source?.prompt_source || null,
        user_message: userMessage,
      },
      business_fields: {
        ...(existing.business_fields || {}),
        prompt_source: next.promptSource || existing.business_fields?.prompt_source || null,
        user_message: userMessage,
      },
    });
  }

  const currentPrompt = String(existing.prompt || "").trim();
  const currentStatus = String(
    existing.source?.prompt_status
      || existing.business_fields?.prompt_status
      || (currentPrompt ? "user-message" : "not-available"),
  );
  const nextStatus = next.promptStatus || "user-message";
  const currentRank = promptRank(currentStatus, currentPrompt);
  const nextRank = promptRank(nextStatus, nextPrompt);
  const places = placeHints(userMessage || nextPrompt);
  const placeUpgrade = places.length > 0
    && mentionsAnyPlace(userMessage || nextPrompt, places)
    && !mentionsAnyPlace(currentPrompt, places)
    && (mentionsAnyPlace(nextPrompt, places) || /user edit|Generation caption|requested a different region/i.test(nextPrompt));
  if (!placeUpgrade && nextRank <= currentRank && !(nextPrompt.length > currentPrompt.length + 40 && nextRank >= currentRank)) {
    return null;
  }

  return store.updateMetadata(existing.project_id, existing.id, {
    prompt: nextPrompt,
    theme: promptTheme(nextPrompt, providerLabelFor(next.provider || existing.source?.provider)),
    source: {
      ...(existing.source || {}),
      prompt_status: nextStatus,
      prompt_source: next.promptSource || existing.source?.prompt_source || null,
      user_message: next.userMessage || existing.source?.user_message || null,
      model: next.model || existing.source?.model || null,
    },
    business_fields: {
      ...(existing.business_fields || {}),
      prompt_status: nextStatus,
      prompt_source: next.promptSource || existing.business_fields?.prompt_source || null,
      user_message: next.userMessage || existing.business_fields?.user_message || null,
    },
  });
}

const LEADING_UI_GLYPH_TOKENS = new Set([
  "play_circle", "play_arrow", "pause_circle", "stop_circle",
  "more_vert", "more_horiz", "fullscreen_exit", "open_in_full",
  "download_for_offline", "file_download", "volume_up", "volume_off",
]);

function stripLeadingUiGlyphTokens(value: string): string {
  const parts = String(value || "").trim().split(/\s+/);
  while (parts.length && LEADING_UI_GLYPH_TOKENS.has(parts[0].toLowerCase())) parts.shift();
  return parts.join(" ").trim();
}

function promptTheme(prompt: string, providerLabel: string = PROVIDER_CONFIG.chatgpt.label): string {
  const text = stripLeadingUiGlyphTokens(String(prompt || "")
    .replace(/<\|has_watermark\|>/g, "")
    .replace(/\n?展开\s*$/g, "")
    .trim()
    .replace(/\s+/g, " "));
  if (!text) return `${providerLabel} web image`;
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
function sanitizeAssetId(value: string, fallbackPrefix: string = PROVIDER_CONFIG.chatgpt.assetIdPrefix): string { return String(value || fallbackPrefix).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || `${fallbackPrefix}-${Date.now()}`; }
function providerLabelFor(value: unknown): string { const config = PROVIDER_CONFIG[String(value || "").trim().toLowerCase() as ProviderId]; return config?.label || PROVIDER_CONFIG.chatgpt.label; }
