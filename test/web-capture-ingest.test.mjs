import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { removeTestPath as rm } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import sharp from "sharp";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { createReferenceAttachmentStore } from "../lib/reference-attachment-store.js";
import {
  cleanupWebCaptureTemp,
  createWebCaptureIngest,
  ingestWebCapture,
  WEB_CAPTURE_MAX_BODY_BYTES,
  WEB_CAPTURE_MAX_IMAGE_BYTES,
  WEB_CAPTURE_MAX_VIDEO_BYTES,
} from "../lib/web-capture-ingest.js";
import { isAllowedIngestOrigin, parseAllowedIngestOrigins } from "../lib/server-security.js";

// High-entropy raster so compressed size exceeds the logo gate (~20KiB).
const SAMPLE_PNG_BASE64 = await (async () => {
  const width = 720;
  const height = 960;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 37 + (i % 251)) & 255;
  const buf = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
  return buf.toString("base64");
})();

test("web capture temp cleanup removes stale crash leftovers without touching fresh files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-temp-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tempRoot = join(root, ".web-capture-tmp");
  await mkdir(tempRoot, { recursive: true });
  const stale = join(tempRoot, "chatgpt-stale.png");
  const fresh = join(tempRoot, "chatgpt-fresh.png");
  await writeFile(stale, "stale");
  await writeFile(fresh, "fresh");
  const now = Date.now();
  const staleTime = new Date(now - 48 * 60 * 60 * 1000);
  await utimes(stale, staleTime, staleTime);
  const removed = await cleanupWebCaptureTemp(tempRoot, { ttlMs: 24 * 60 * 60 * 1000, now: () => now });
  assert.equal(removed, 1);
  assert.deepEqual(await readdir(tempRoot), ["chatgpt-fresh.png"]);
});

const LOGO_PNG_BASE64 = (
  await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 220, g: 30, b: 30 } },
  })
    .png()
    .toBuffer()
).toString("base64");

function sampleMp4Bytes() {
  const bytes = Buffer.alloc(96 * 1024, 0);
  bytes.writeUInt32BE(24, 0);
  bytes.write("ftyp", 4, "ascii");
  bytes.write("isom", 8, "ascii");
  bytes.writeUInt32BE(0x200, 12);
  bytes.write("isom", 16, "ascii");
  bytes.write("mp42", 20, "ascii");
  return bytes;
}

test("allows only configured extension origins for ingest routes", () => {
  const allowed = parseAllowedIngestOrigins("chrome-extension://abcdef,moz-extension://firefox");
  assert.equal(isAllowedIngestOrigin(undefined, 43517, allowed), true);
  assert.equal(isAllowedIngestOrigin("http://127.0.0.1:43517", 43517, allowed), true);
  assert.equal(isAllowedIngestOrigin("chrome-extension://abcdef", 43517, allowed), true);
  assert.equal(isAllowedIngestOrigin("moz-extension://firefox", 43517, allowed), true);
  assert.equal(isAllowedIngestOrigin("chrome-extension://other", 43517, allowed), false);
  assert.equal(isAllowedIngestOrigin("https://chatgpt.com", 43517, allowed), false);
});

test("request body budget includes a maximum-size base64 image envelope", () => {
  const imageBase64 = Buffer.alloc(WEB_CAPTURE_MAX_IMAGE_BYTES).toString("base64");
  const envelopeBytes = Buffer.byteLength(JSON.stringify({
    provider: "chatgpt",
    imageBase64,
    mimeType: "image/jpeg",
  }));
  assert.ok(envelopeBytes < WEB_CAPTURE_MAX_BODY_BYTES);
  assert.ok(WEB_CAPTURE_MAX_BODY_BYTES - envelopeBytes > 512 * 1024);
});

test("request body budget also covers supported generated video captures", () => {
  const videoBase64 = Buffer.alloc(WEB_CAPTURE_MAX_VIDEO_BYTES).toString("base64");
  const envelopeBytes = Buffer.byteLength(JSON.stringify({
    provider: "flow",
    mediaKind: "video",
    mediaBase64: videoBase64,
    mimeType: "video/mp4",
  }));
  assert.ok(envelopeBytes < WEB_CAPTURE_MAX_BODY_BYTES);
});

test("ingests Flow generated video bytes and dedupes them by content hash", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-video-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  const tempRoot = join(libraryDir, ".web-capture-tmp");
  const mediaBase64 = sampleMp4Bytes().toString("base64");

  const first = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: {
      provider: "flow",
      mediaKind: "video",
      mediaBase64,
      mimeType: "video/mp4",
      prompt: "play_circle Cinematic camera move across a futuristic city at dusk",
      prompt_status: "provider-visible-prompt",
      prompt_source: "flow-visible-prompt",
      width: 1280,
      height: 720,
      durationSeconds: 8,
      pageUrl: "https://labs.google/fx/tools/flow/demo",
    },
  });
  assert.equal(first.status, "imported");
  assert.equal(first.asset.source?.provider, "flow");
  assert.equal(first.asset.source?.media_kind, "video");
  assert.equal(first.asset.business_fields?.media_kind, "video");
  assert.equal(first.asset.business_fields?.mime_type, "video/mp4");
  assert.equal(first.asset.business_fields?.duration_seconds, 8);
  assert.equal(first.asset.theme, "Cinematic camera move across a futuristic city at dusk");
  assert.match(first.asset.asset, /\.mp4$/);

  const second = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: { provider: "flow", mediaKind: "video", mediaBase64, mimeType: "video/mp4" },
  });
  assert.equal(second.status, "skipped");
  assert.equal(second.reason, "already-archived-same-content");
  assert.equal(second.asset.id, first.asset.id);
});

test("rejects video capture from unsupported providers and mismatched bytes", async () => {
  const store = { createAsset: async () => { throw new Error("must not create"); }, listAssets: async () => [] };
  const mediaBase64 = sampleMp4Bytes().toString("base64");
  await assert.rejects(
    () => ingestWebCapture({ store, tempRoot: "/tmp/mosa-video-provider", input: { provider: "chatgpt", mediaKind: "video", mediaBase64, mimeType: "video/mp4" } }),
    (error) => error?.code === "WEB_CAPTURE_BAD_VIDEO_PROVIDER",
  );
  await assert.rejects(
    () => ingestWebCapture({ store, tempRoot: "/tmp/mosa-video-mime", input: { provider: "flow", mediaKind: "video", mediaBase64: Buffer.alloc(96 * 1024).toString("base64"), mimeType: "video/mp4" } }),
    (error) => error?.code === "WEB_CAPTURE_MIME_MISMATCH",
  );
});

test("ingests chatgpt web capture bytes and dedupes by content hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-capture-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  // Force sqlite path by creating completed migration marker via store bootstrap helper:
  // createSqliteAssetStore works directly for unit tests.
  const store = createSqliteAssetStore({
    projectRoot: root,
    managerDir: root,
    libraryDir,
  });

  try {
    await store.ensureProject("default");
    const tempRoot = join(libraryDir, ".web-capture-tmp");
    const first = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: {
        provider: "chatgpt",
        prompt: "Model caption: A poster-style vector illustration travel poster of Bangkok with bold typography, limited red and cream palette, geometric flat layout.",
        prompt_status: "generation-tool-prompt",
        prompt_scope: "output",
        generation_status: "completed",
        user_message: "做一张曼谷海报",
        imageBase64: SAMPLE_PNG_BASE64,
        mimeType: "image/jpeg",
        pageUrl: "https://chatgpt.com/c/demo",
        conversationId: "demo",
        messageId: "turn-42",
        generationContextId: "chatgpt:demo:call-web-42",
        providerToolCallId: "call-web-42",
        providerResponseId: "resp-web-42",
        providerAssetId: "file-web-42",
      },
    });
    assert.equal(first.status, "imported");
    assert.equal(first.asset.source?.type, "web-chatgpt");
    assert.match(first.asset.prompt, /poster-style vector illustration/i);
    assert.equal(first.asset.source?.provider, "chatgpt");
    assert.equal(first.asset.source?.user_message, "做一张曼谷海报");
    assert.equal(first.asset.source?.capture_session_id, "chatgpt:demo");
    assert.equal(first.asset.source?.generation_batch_id, "chatgpt:demo:turn-42");
    assert.equal(first.asset.source?.provider_tool_call_id, "call-web-42");
    assert.equal(first.asset.source?.provider_generation_call_id, null);
    assert.equal(first.asset.source?.prompt_scope, "output");
    assert.equal(first.asset.source?.generation_status, "completed");
    assert.equal(first.asset.business_fields?.prompt_scope, "output");
    assert.equal(first.asset.business_fields?.generation_status, "completed");
    const [generation] = await store.listGenerationEvents("default", { captureContextId: "chatgpt:demo:call-web-42" });
    assert.equal(generation.provider_tool_call_id, "call-web-42");
    assert.equal(generation.provider_generation_call_id, "");
    assert.equal(generation.provider_response_id, "resp-web-42");
    assert.equal(generation.prompt_scope, "output");
    assert.equal(generation.generation_status, "completed");
    assert.equal(generation.verification_level, "observed");
    assert.ok(first.contentHash);

    const second = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: {
        provider: "chatgpt",
        prompt: "duplicate upload",
        imageBase64: SAMPLE_PNG_BASE64,
        mimeType: "image/jpeg",
      },
    });
    assert.equal(second.status, "skipped");
    assert.equal(second.reason, "already-archived-same-content");
    assert.equal(second.asset.id, first.asset.id);
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("deduplicated ChatGPT output advances generation status from partial to completed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-generation-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  const tempRoot = join(libraryDir, ".web-capture-tmp");
  const baseInput = {
    provider: "chatgpt",
    imageBase64: SAMPLE_PNG_BASE64,
    mimeType: "image/jpeg",
    conversationId: "status-conversation",
    messageId: "status-message",
    generationContextId: "chatgpt:status-conversation:call-status",
    providerToolCallId: "call-status",
    providerGenerationCallId: "gen-status",
    providerAssetId: "file-status",
    prompt_scope: "attempt",
  };

  const partial = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: { ...baseInput, generation_status: "partial", capturedAt: "2026-08-31T00:00:00.000Z" },
  });
  assert.equal(partial.status, "imported");
  assert.equal(partial.asset.source?.generation_status, "partial");

  const completed = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: { ...baseInput, generation_status: "completed", capturedAt: "2026-08-31T00:00:01.000Z" },
  });
  assert.equal(completed.status, "skipped");
  assert.equal(completed.reason, "already-archived-recipe-merged");
  assert.equal(completed.asset.source?.generation_status, "completed");
  assert.equal(completed.asset.business_fields?.generation_status, "completed");
  const events = await store.listGenerationEvents("default", { assetId: partial.asset.id });
  assert.equal(events.length, 1);
  assert.equal(events[0].generation_status, "completed");
  assert.equal(events[0].provider_generation_call_id, "gen-status");
});

test("records a reliable capture session without inventing a generation batch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-session-only-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let created;
  let createOptions;
  const store = {
    createAsset: async (input, options) => { created = input; createOptions = options; return { id: input.assetId, ...input, source: { ...input.source } }; },
    listAssets: async () => [],
    findAssetByContentHash: async () => null,
  };
  await ingestWebCapture({
    store,
    tempRoot: join(root, "capture"),
    input: {
      provider: "chatgpt",
      imageBase64: SAMPLE_PNG_BASE64,
      mimeType: "image/jpeg",
      conversationId: "conversation-without-turn",
      captureMode: "manual",
    },
  });
  assert.equal(created.source.capture_session_id, "chatgpt:conversation-without-turn");
  assert.equal(created.source.message_id, null);
  assert.equal(created.source.generation_batch_id, null);
  assert.equal(created.source.capture_mode, "manual");
  assert.equal(created.business_fields.auto_archived, false);
  assert.equal(created.business_fields.capture_mode, "manual");
  assert.ok(created.tags.includes("manual-capture"));
  assert.equal(created.tags.includes("auto-archived"), false);
  assert.deepEqual(createOptions, { trustedSourceRoots: [join(root, "capture")], ingestMode: "manual" });
});

test("skips suppressed web captures and removes their temporary file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-suppressed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tempRoot = join(root, "capture");
  let createOptions;
  const store = {
    createAsset: async (_input, options) => {
      createOptions = options;
      throw Object.assign(new Error("suppressed"), { code: "AUTOMATIC_IMPORT_SUPPRESSED" });
    },
    listAssets: async () => [],
    findAssetByContentHash: async () => null,
  };

  const result = await ingestWebCapture({
    store,
    tempRoot,
    input: { provider: "chatgpt", imageBase64: SAMPLE_PNG_BASE64, mimeType: "image/jpeg" },
  });
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "suppressed-after-delete");
  assert.ok(result.contentHash);
  assert.deepEqual(createOptions, { trustedSourceRoots: [tempRoot], ingestMode: "automatic" });
  assert.deepEqual(await readdir(tempRoot), []);
});

test("accepts the allowlisted generic providers with provider-derived metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-providers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expected = [
    ["gemini", "Gemini", "web-gemini", "Gemini web capture"],
    ["flow", "Flow", "web-flow", "Flow web capture"],
    ["google-ai-studio", "Google AI Studio", "web-google-ai-studio", "Google AI Studio web capture"],
  ];

  for (const [index, [provider, label, sourceType, skill]] of expected.entries()) {
    let created;
    const store = {
      createAsset: async (input) => { created = input; return { id: input.assetId, ...input, source: { ...input.source } }; },
      listAssets: async () => [],
      findAssetByContentHash: async () => null,
    };
    const image = await noiseImage(index + 20);
    await ingestWebCapture({
      store,
      tempRoot: join(root, provider),
      input: { provider, imageBytes: image, mimeType: "image/png" },
    });

    assert.equal(created.sourceType, sourceType);
    assert.equal(created.source.type, sourceType);
    assert.equal(created.source.provider, provider);
    assert.equal(created.skill, skill);
    assert.equal(created.theme, `${label} web image`);
    assert.deepEqual(created.tags, [provider, "web-capture", "auto-archived"]);
    assert.match(created.fileName, new RegExp(`^${provider}-[0-9]+-[a-f0-9]{8}\\.png$`));
    assert.match(created.assetId, new RegExp(`^web-${provider}-[a-f0-9]{12}$`));
  }
});

test("persists Gemini, Flow, and AI Studio provider-visible prompts as unverified", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-flow-prompt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const image = await noiseImage(42);
  const created = [];
  const store = {
    createAsset: async (input) => {
      const asset = { id: input.assetId, project_id: "default", ...input, source: { ...input.source } };
      created.push(asset);
      return asset;
    },
    listAssets: async () => created,
    findAssetByContentHash: async (_projectId, hash) => created.find((asset) => asset.source?.content_sha256 === hash) || null,
    updateMetadata: async (_projectId, assetId, metadata) => {
      const asset = created.find((entry) => entry.id === assetId);
      Object.assign(asset, metadata, { source: { ...asset.source, ...(metadata.source || {}) }, business_fields: { ...asset.business_fields, ...(metadata.business_fields || {}) } });
      return asset;
    },
  };

  const flow = await ingestWebCapture({
    store,
    tempRoot: join(root, "flow"),
    input: {
      provider: "flow",
      imageBytes: image,
      mimeType: "image/png",
      prompt: "A visible Flow prompt for a cinematic mountain landscape",
      prompt_status: "provider-visible-prompt",
      prompt_source: "flow-visible-composer",
    },
  });
  assert.equal(flow.status, "imported");
  assert.equal(flow.asset.prompt, "A visible Flow prompt for a cinematic mountain landscape");
  assert.equal(flow.asset.source?.prompt_status, "provider-visible-prompt");
  assert.equal(flow.asset.source?.prompt_source, "flow-visible-composer");
  assert.equal(flow.asset.business_fields?.prompt_status, "provider-visible-prompt");

  const aiStudio = await ingestWebCapture({
    store,
    tempRoot: join(root, "google-ai-studio"),
    input: {
      provider: "google-ai-studio",
      imageBytes: await noiseImage(101),
      mimeType: "image/png",
      prompt: "A visible AI Studio user prompt associated with the image turn",
      prompt_status: "provider-visible-prompt",
      prompt_source: "google-ai-studio-visible-user-prompt",
    },
  });
  assert.equal(aiStudio.status, "imported");
  assert.equal(aiStudio.asset.prompt, "A visible AI Studio user prompt associated with the image turn");
  assert.equal(aiStudio.asset.source?.prompt_status, "provider-visible-prompt");
  assert.equal(aiStudio.asset.source?.prompt_source, "google-ai-studio-visible-user-prompt");

  const gemini = await ingestWebCapture({
    store,
    tempRoot: join(root, "gemini"),
    input: {
      provider: "gemini",
      imageBytes: await noiseImage(149),
      mimeType: "image/png",
      prompt: "A visible Gemini user prompt structurally associated with the image",
      prompt_status: "provider-visible-prompt",
      prompt_source: "gemini-visible-user-prompt",
    },
  });
  assert.equal(gemini.status, "imported");
  assert.equal(gemini.asset.prompt, "A visible Gemini user prompt structurally associated with the image");
  assert.equal(gemini.asset.source?.prompt_status, "provider-visible-prompt");
  assert.equal(gemini.asset.source?.prompt_source, "gemini-visible-user-prompt");

  // An unrelated provider cannot claim the Google visible-prompt status.
  const other = await ingestWebCapture({
    store,
    tempRoot: join(root, "chatgpt"),
    input: {
      provider: "chatgpt",
      imageBytes: await noiseImage(150),
      mimeType: "image/png",
      prompt: "This must not be persisted",
      prompt_status: "provider-visible-prompt",
      prompt_source: "gemini-visible-user-prompt",
    },
  });
  assert.equal(other.status, "imported");
  assert.equal(other.asset.prompt, "");
  assert.equal(other.asset.source?.prompt_status, "not-available");
  assert.equal(other.asset.source?.prompt_source, "gemini-visible-user-prompt");
});

test("does not let a Flow-only prompt upgrade a same-image asset from another provider", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-flow-prompt-dedupe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const image = await noiseImage(44);
  const assets = [];
  const store = {
    createAsset: async (input) => {
      const asset = { id: input.assetId, project_id: "default", ...input, source: { ...input.source } };
      assets.push(asset);
      return asset;
    },
    listAssets: async () => assets,
    findAssetByContentHash: async (_projectId, hash) => assets.find((asset) => asset.source?.content_sha256 === hash) || null,
    updateMetadata: async (_projectId, assetId, metadata) => {
      const asset = assets.find((entry) => entry.id === assetId);
      Object.assign(asset, metadata, { source: { ...asset.source, ...(metadata.source || {}) }, business_fields: { ...asset.business_fields, ...(metadata.business_fields || {}) } });
      return asset;
    },
  };
  const first = await ingestWebCapture({
    store,
    tempRoot: join(root, "chatgpt"),
    input: { provider: "chatgpt", imageBytes: image, mimeType: "image/png" },
  });
  const repeat = await ingestWebCapture({
    store,
    tempRoot: join(root, "flow"),
    input: {
      provider: "flow",
      imageBytes: image,
      mimeType: "image/png",
      prompt: "Do not cross provider boundary",
      prompt_status: "provider-visible-prompt",
    },
  });
  assert.equal(repeat.status, "skipped");
  assert.equal(repeat.upgraded, false);
  assert.equal(repeat.asset.id, first.asset.id);
  assert.equal(repeat.asset.prompt, "");
  assert.equal(repeat.asset.source?.provider, "chatgpt");
  assert.deepEqual(
    repeat.asset.source?.capture_occurrences?.map((entry) => entry.provider),
    ["chatgpt", "flow"],
  );
});

test("rejects provider values outside the exact allowlist", async () => {
  const store = {
    createAsset: async () => { throw new Error("must not create an asset"); },
    listAssets: async () => [],
  };
  await assert.rejects(
    () => ingestWebCapture({ store, tempRoot: "/tmp/mosa-web-provider-invalid", input: { provider: "google-ai-studio.example", imageBase64: SAMPLE_PNG_BASE64 } }),
    (error) => error?.statusCode === 400 && error?.code === "WEB_CAPTURE_BAD_PROVIDER",
  );
});

test("archives one asset when the same picture arrives in two encodings", async () => {
  // The extension uploads either the file ChatGPT served or a canvas re-encode
  // of it. Same pixels, different bytes — the file hash alone imported both.
  const width = 720;
  const height = 960;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 37 + (i % 251)) & 255;
  const servedPng = await sharp(raw, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  // What a browser canvas produces: an opaque alpha channel, lighter compression.
  const canvasPng = await sharp(raw, { raw: { width, height, channels: 3 } })
    .ensureAlpha()
    .png({ compressionLevel: 3 })
    .toBuffer();
  assert.notEqual(servedPng.toString("base64"), canvasPng.toString("base64"));

  const root = await mkdtemp(join(tmpdir(), "mosa-web-pixels-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const tempRoot = join(libraryDir, ".web-capture-tmp");
    const served = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: { provider: "chatgpt", imageBase64: servedPng.toString("base64"), mimeType: "image/png" },
    });
    assert.equal(served.status, "imported");
    assert.ok(served.asset.source?.pixel_sha256);

    const reEncoded = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: { provider: "chatgpt", imageBase64: canvasPng.toString("base64"), mimeType: "image/png" },
    });
    assert.equal(reEncoded.status, "skipped");
    assert.equal(reEncoded.reason, "already-archived-same-pixels");
    assert.equal(reEncoded.asset.id, served.asset.id);
    assert.equal((await store.listAssets({ projectId: "default" })).length, 1);
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes concurrent web captures so identical content is imported once", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-concurrent-dedupe-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const capture = createWebCaptureIngest({
      store,
      libraryDir,
      projectId: "default",
      token: "test-token",
      allowedOrigins: ["chrome-extension://test"],
    });
    const input = { provider: "chatgpt", imageBase64: SAMPLE_PNG_BASE64, mimeType: "image/jpeg" };
    const results = await Promise.all([
      capture.ingest(input, "test-token"),
      capture.ingest(input, "test-token"),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["imported", "skipped"]);
    assert.equal(results.find((result) => result.status === "skipped")?.reason, "already-archived-same-content");
    assert.equal((await store.listAssets({ projectId: "default" })).length, 1);
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("independent web capture queues remain idempotent for the same deterministic asset id", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-independent-race-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const tempRoot = join(libraryDir, ".web-capture-tmp");
    const input = { provider: "chatgpt", imageBase64: SAMPLE_PNG_BASE64, mimeType: "image/jpeg" };
    const results = await Promise.all([
      ingestWebCapture({ store, tempRoot, projectId: "default", input }),
      ingestWebCapture({ store, tempRoot, projectId: "default", input }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["imported", "skipped"]);
    assert.equal(results.find((result) => result.status === "skipped")?.reason, "already-archived-same-content");
    assert.equal((await store.listAssets({ projectId: "default" })).length, 1);
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("archives a reference as a deduplicated attachment without adding a library asset", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-reference-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const tempRoot = join(libraryDir, ".web-capture-tmp");
    const reference = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: {
        provider: "chatgpt",
        is_reference: true,
        imageBase64: SAMPLE_PNG_BASE64,
        mimeType: "image/jpeg",
        user_message: "Use the uploaded photo as the exact identity reference.",
        conversationId: "reference-demo",
        providerAssetId: "file-reference-demo",
        capturedAt: "2026-08-13T10:00:00.000Z",
      },
    });
    assert.equal(reference.status, "imported");
    assert.equal(reference.asset, undefined);
    assert.match(reference.attachment.id, /^ref-[a-f0-9]{24}$/);
    assert.equal(reference.attachment.conversation_id, "reference-demo");
    assert.equal(reference.attachment.provider_asset_id, "file-reference-demo");
    assert.match(reference.attachment.attachment_url, /^\/library\/default\/references\//);
    assert.equal((await store.listAssets({ projectId: "default" })).length, 0);
    assert.deepEqual(await readFile(join(libraryDir, "reference-attachments", "default", "files", reference.attachment.file_name)), Buffer.from(SAMPLE_PNG_BASE64, "base64"));

    // The same upload arriving again (another URL variant) must not add a row.
    const repeat = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: {
        provider: "chatgpt",
        is_reference: true,
        imageBase64: SAMPLE_PNG_BASE64,
        mimeType: "image/jpeg",
      },
    });
    assert.equal(repeat.status, "skipped");
    assert.equal(repeat.reason, "reference-already-archived-same-content");
    assert.equal(repeat.attachment.id, reference.attachment.id);
    assert.equal((await store.listAssets({ projectId: "default" })).length, 0);

    const generation = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: {
        provider: "chatgpt",
        imageBytes: await noiseImage(77),
        mimeType: "image/png",
        conversationId: "reference-demo",
        capturedAt: "2026-08-13T10:01:00.000Z",
      },
    });
    assert.equal(generation.status, "imported");
    assert.equal((await store.listAssets({ projectId: "default" })).length, 1);
    assert.equal(generation.asset.references.length, 1);
    assert.equal(generation.asset.references[0].reference_id, reference.attachment.id);
    assert.equal(generation.asset.references[0].attachment_url, reference.attachment.attachment_url);
    assert.equal(generation.asset.references[0].provider_asset_id, "file-reference-demo");
    const history = await store.getRecipeSnapshotHistory("default", generation.asset.id);
    assert.equal(history.snapshots[0].references[0].attachment_url, reference.attachment.attachment_url);
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("generation contexts keep one reference blob but record every use and bind every output", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-reference-context-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const tempRoot = join(libraryDir, ".web-capture-tmp");
    const referenceBytes = await noiseImage(81);
    const saveReference = (generationContextId, capturedAt, providerAssetId = "") => ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "chatgpt",
        isReference: true,
        imageBytes: referenceBytes,
        mimeType: "image/png",
        conversationId: "context-demo",
        messageId: `user-${generationContextId}`,
        generationContextId,
        providerAssetId,
        capturedAt,
      },
    });
    const firstReference = await saveReference("chatgpt:context-demo:gen-a", "2026-08-20T10:00:00.000Z");
    const enrichedReference = await saveReference("chatgpt:context-demo:gen-a", "2026-08-20T10:00:01.000Z", "file-reference-a");
    assert.equal(enrichedReference.status, "skipped", "late provider metadata enriches the existing reference instead of creating another blob");
    assert.equal(enrichedReference.attachment.provider_asset_id, "file-reference-a");
    assert.equal(enrichedReference.attachment.usages[0].provider_asset_id, "file-reference-a");

    const output = async (seed, generationContextId, capturedAt) => ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "chatgpt",
        imageBytes: await noiseImage(seed),
        mimeType: "image/png",
        conversationId: "context-demo",
        messageId: generationContextId.endsWith("gen-a") ? "tool-a" : "tool-b",
        generationContextId,
        capturedAt,
      },
    });

    const firstOutput = await output(82, "chatgpt:context-demo:gen-a", "2026-08-20T10:01:00.000Z");
    const secondOutput = await output(83, "chatgpt:context-demo:gen-a", "2026-08-20T10:01:01.000Z");
    assert.deepEqual(firstOutput.asset.references.map((item) => item.reference_id), [firstReference.attachment.id]);
    assert.deepEqual(secondOutput.asset.references.map((item) => item.reference_id), [firstReference.attachment.id], "every output in one generation context keeps the references");
    assert.equal(firstOutput.asset.references[0].provider_asset_id, "file-reference-a");
    assert.equal(firstOutput.asset.references[0].application_status, "observed_input");
    assert.equal(firstOutput.asset.references[0].verification_level, "observed");

    const repeatedReference = await saveReference("chatgpt:context-demo:gen-b", "2026-08-20T10:05:00.000Z", "file-reference-b");
    assert.equal(repeatedReference.status, "skipped", "the physical reference file remains deduplicated");
    assert.equal(repeatedReference.attachment.id, firstReference.attachment.id);
    assert.deepEqual(repeatedReference.attachment.usages.map((usage) => usage.generation_context_id), [
      "chatgpt:context-demo:gen-a",
      "chatgpt:context-demo:gen-b",
    ]);

    const thirdOutput = await output(84, "chatgpt:context-demo:gen-b", "2026-08-20T10:06:00.000Z");
    assert.deepEqual(thirdOutput.asset.references.map((item) => item.reference_id), [firstReference.attachment.id], "reusing the same reference in a later generation remains traceable");
    assert.equal(thirdOutput.asset.references[0].provider_asset_id, "file-reference-b", "relation evidence uses the provider asset ID from this generation context, not the attachment's first-ever ID");
    assert.equal((await store.listAssets({ projectId: "default" })).length, 3, "reference usages never become gallery assets");
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("deduplicated output preserves a new generation recipe and reference set", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-duplicate-recipe-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const tempRoot = join(libraryDir, ".web-capture-tmp");
    const firstReference = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "chatgpt",
        isReference: true,
        imageBytes: await noiseImage(91),
        mimeType: "image/png",
        conversationId: "duplicate-recipe",
        generationContextId: "chatgpt:duplicate-recipe:gen-a",
        capturedAt: "2026-08-20T11:00:00.000Z",
      },
    });
    const outputBytes = await noiseImage(92);
    const firstOutput = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "chatgpt",
        imageBytes: outputBytes,
        mimeType: "image/png",
        prompt: "first recipe prompt with cinematic lighting and detailed composition",
        prompt_status: "generation-tool-prompt",
        conversationId: "duplicate-recipe",
        messageId: "tool-a",
        generationContextId: "chatgpt:duplicate-recipe:gen-a",
        capturedAt: "2026-08-20T11:01:00.000Z",
      },
    });
    const secondReference = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "chatgpt",
        isReference: true,
        imageBytes: await noiseImage(93),
        mimeType: "image/png",
        conversationId: "duplicate-recipe",
        generationContextId: "chatgpt:duplicate-recipe:gen-b",
        capturedAt: "2026-08-20T11:05:00.000Z",
      },
    });
    const duplicateOutput = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "chatgpt",
        imageBytes: outputBytes,
        mimeType: "image/png",
        prompt: "second recipe prompt with rainy night atmosphere and neon reflections",
        prompt_status: "generation-tool-prompt",
        conversationId: "duplicate-recipe",
        messageId: "tool-b",
        generationContextId: "chatgpt:duplicate-recipe:gen-b",
        capturedAt: "2026-08-20T11:06:00.000Z",
      },
    });

    assert.equal(firstOutput.status, "imported");
    assert.equal(duplicateOutput.status, "skipped");
    assert.equal(duplicateOutput.recipeMerged, true);
    assert.equal(duplicateOutput.asset.id, firstOutput.asset.id);
    assert.deepEqual(duplicateOutput.asset.references.map((item) => item.reference_id), [secondReference.attachment.id]);
    const history = await store.getRecipeSnapshotHistory("default", firstOutput.asset.id);
    assert.ok(history.snapshots.some((snapshot) => snapshot.references.some((item) => item.reference_id === firstReference.attachment.id)));
    assert.ok(history.snapshots.some((snapshot) => snapshot.references.some((item) => item.reference_id === secondReference.attachment.id)));
    assert.ok(history.snapshots.some((snapshot) => snapshot.effective_prompt.includes("first recipe prompt")));
    assert.ok(history.snapshots.some((snapshot) => snapshot.effective_prompt.includes("second recipe prompt")));
    assert.ok(history.snapshots.some((snapshot) => snapshot.provenance.capture_context_id === "chatgpt:duplicate-recipe:gen-a"));
    assert.ok(history.snapshots.some((snapshot) => snapshot.provenance.capture_context_id === "chatgpt:duplicate-recipe:gen-b"));
    assert.ok(history.snapshots.every((snapshot) => snapshot.provenance.provider_generation_call_id === ""));
    const generationEvents = await store.listGenerationEvents("default", { assetId: firstOutput.asset.id });
    assert.equal(generationEvents.length, 2, "one deduplicated asset keeps both generation occurrences");
    assert.deepEqual(generationEvents.map((event) => event.capture_context_id), [
      "chatgpt:duplicate-recipe:gen-a",
      "chatgpt:duplicate-recipe:gen-b",
    ]);
    assert.ok(generationEvents.every((event) => event.verification_level === "observed"));
    assert.equal((await store.listAssets({ projectId: "default" })).length, 1, "identical output bytes remain one gallery asset");
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("small valid reference images bypass output-logo size filtering", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-small-reference-"));
  const small = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 24, g: 48, b: 72, alpha: 1 } } }).png().toBuffer();
  assert.ok(small.length < 20 * 1024, "fixture must exercise the reference exception");
  let createCalls = 0;
  const store = {
    createAsset: async () => { createCalls += 1; throw new Error("reference must not become an asset"); },
    listAssets: async () => [],
    findAssetByContentHash: async () => null,
  };
  try {
    const result = await ingestWebCapture({
      store,
      tempRoot: join(root, "tmp"),
      input: { provider: "chatgpt", isReference: true, imageBytes: small, mimeType: "image/png", generationContextId: "small-ref-context" },
    });
    assert.equal(result.status, "imported");
    assert.equal(createCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects tiny logo images, blanks unbound short prompts, and preserves user instructions separately", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-logo-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const tempRoot = join(libraryDir, ".web-capture-tmp");
    await assert.rejects(
      () => ingestWebCapture({
        store,
        tempRoot,
        input: { provider: "chatgpt", imageBase64: LOGO_PNG_BASE64, mimeType: "image/png", prompt: "在做一版 香港 的" },
      }),
      /too small|IMAGE_TOO_SMALL/i,
    );

    const result = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "chatgpt",
        imageBase64: SAMPLE_PNG_BASE64,
        mimeType: "image/jpeg",
        prompt: "在做一版 香港 的",
        user_message: "在做一版 香港 的",
      },
    });
    assert.equal(result.status, "imported");
    assert.equal(result.asset.prompt, "");
    assert.equal(result.asset.source?.prompt_status, "not-available");
    assert.equal(result.asset.source?.user_message, "在做一版 香港 的");

    const userInstructionUpdate = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "chatgpt",
        imageBase64: SAMPLE_PNG_BASE64,
        mimeType: "image/jpeg",
        prompt: "生成一张 西藏 的",
        prompt_status: "user-message",
        prompt_source: "awaiting-generation-caption",
        user_message: "生成一张 西藏 的",
      },
    });
    assert.equal(userInstructionUpdate.status, "skipped");
    assert.equal(userInstructionUpdate.upgraded, true);
    assert.equal(userInstructionUpdate.asset.prompt, "");
    assert.equal(userInstructionUpdate.asset.source?.prompt_status, "not-available");
    assert.equal(userInstructionUpdate.asset.source?.prompt_source, "awaiting-generation-caption");
    assert.equal(userInstructionUpdate.asset.source?.user_message, "生成一张 西藏 的");

    const upgraded = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "chatgpt",
        imageBase64: SAMPLE_PNG_BASE64,
        mimeType: "image/jpeg",
        prompt: "red sun",
        prompt_status: "generation-tool-prompt",
      },
    });
    assert.equal(upgraded.status, "skipped");
    assert.equal(upgraded.upgraded, true);
    assert.equal(upgraded.asset.prompt, "red sun");
    assert.equal(upgraded.asset.source?.prompt_status, "generation-tool-prompt");
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("provider prompt priority prevents a later lower-quality generation field from downgrading an archived prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-prompt-priority-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const tempRoot = join(libraryDir, ".web-capture-tmp");
    const first = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "chatgpt",
        imageBase64: SAMPLE_PNG_BASE64,
        mimeType: "image/jpeg",
        prompt: "provider revised prompt",
        prompt_status: "generation-tool-prompt",
        prompt_source: "revised_prompt",
        prompt_priority: 700,
        generationContextId: "chatgpt:test:revised",
      },
    });
    assert.equal(first.status, "imported");
    assert.equal(first.asset.prompt, "provider revised prompt");
    assert.equal(first.asset.business_fields?.prompt_priority, 700);

    const lower = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "chatgpt",
        imageBase64: SAMPLE_PNG_BASE64,
        mimeType: "image/jpeg",
        prompt: "a much longer generation prompt that arrived later but comes from a lower-priority provider field and must not replace revised_prompt",
        prompt_status: "generation-tool-prompt",
        prompt_source: "generation_prompt",
        prompt_priority: 650,
        generationContextId: "chatgpt:test:lower",
      },
    });
    assert.equal(lower.status, "skipped");
    assert.equal(lower.asset.prompt, "provider revised prompt");
    assert.equal(lower.asset.business_fields?.prompt_priority, 700);
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("web capture token gate rejects bad credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-token-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const disabled = createWebCaptureIngest({ store, libraryDir, token: "", allowedOrigins: ["chrome-extension://approved"] });
    assert.equal(disabled.status().enabled, false);
    assert.equal(disabled.status().tokenConfigured, false);
    assert.deepEqual(disabled.status().providers, ["chatgpt", "gemini", "flow", "google-ai-studio"]);
    await assert.rejects(
      () => disabled.ingest({ provider: "chatgpt", imageBase64: SAMPLE_PNG_BASE64 }, ""),
      (error) => error?.statusCode === 503 && error?.code === "WEB_CAPTURE_DISABLED",
    );

    const ingest = createWebCaptureIngest({
      store,
      libraryDir,
      token: "secret-token",
      allowedOrigins: ["chrome-extension://approved"],
    });
    assert.equal(ingest.status().enabled, true);
    await assert.rejects(
      () => ingest.ingest({ provider: "chatgpt", imageBase64: SAMPLE_PNG_BASE64 }, "wrong"),
      /Unauthorized/,
    );
    const ok = await ingest.ingest({
      provider: "chatgpt",
      imageBase64: SAMPLE_PNG_BASE64,
      mimeType: "image/jpeg",
      prompt: "token ok",
    }, "secret-token");
    assert.equal(ok.status, "imported");
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("validates decoded image bytes, declared MIME, size, and pixel limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-image-validation-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const tempRoot = join(libraryDir, ".web-capture-tmp");
    await assert.rejects(
      () => ingestWebCapture({
        store,
        tempRoot,
        input: { provider: "chatgpt", imageBase64: SAMPLE_PNG_BASE64, mimeType: "image/png" },
      }),
      (error) => error?.code === "WEB_CAPTURE_MIME_MISMATCH",
    );
    await assert.rejects(
      () => ingestWebCapture({
        store,
        tempRoot,
        input: { provider: "chatgpt", imageBytes: Buffer.alloc(24 * 1024, 7), mimeType: "image/png" },
      }),
      (error) => error?.code === "WEB_CAPTURE_BAD_IMAGE_BYTES",
    );
    await assert.rejects(
      () => ingestWebCapture({
        store,
        tempRoot,
        input: { provider: "chatgpt", imageBytes: Buffer.alloc(WEB_CAPTURE_MAX_IMAGE_BYTES + 1), mimeType: "image/png" },
      }),
      (error) => error?.statusCode === 413 && error?.code === "WEB_CAPTURE_IMAGE_TOO_LARGE",
    );

    const oversizedPng = await sharp(Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="6500" height="6500"><rect width="100%" height="100%" fill="red"/></svg>',
    )).png().toBuffer();
    const paddedOversizedPng = Buffer.concat([
      oversizedPng,
      Buffer.alloc(Math.max(0, 20 * 1024 - oversizedPng.length)),
    ]);
    await assert.rejects(
      () => ingestWebCapture({
        store,
        tempRoot,
        input: { provider: "chatgpt", imageBytes: paddedOversizedPng, mimeType: "image/png" },
      }),
      (error) => error?.statusCode === 413 && error?.code === "WEB_CAPTURE_PIXEL_LIMIT",
    );
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP ingest endpoint accepts chrome-extension origin with token", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-http-"));
  const sessionsDir = join(root, "sessions");
  const libraryDir = join(root, "library");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, "empty.jsonl"), "\n");

  // Force SQLite runtime so the server does not fall back to the repo JSON assets tree.
  const seeded = createSqliteAssetStore({ projectRoot: root, managerDir: process.cwd(), libraryDir });
  await seeded.ensureProject("default");
  await seeded.setMigrationState("completed", { test: true });
  seeded.close();

  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PORT: "0",
      MOSA_PROJECT_DIR: root,
      MOSA_LIBRARY_DIR: libraryDir,
      CODEX_GENERATED_IMAGES_DIR: join(root, "generated-images"),
      CODEX_SESSIONS_DIR: sessionsDir,
      GROK_SESSIONS_DIR: join(root, "grok-sessions"),
      COWART_MOSA_CANVAS_DIR: join(root, "cowart-data"),
      MOSA_COWART_REGISTRY_PATH: join(root, "state", "cowart-projects.json"),
      MOSA_WEB_CAPTURE_TOKEN: "test-token",
      MOSA_WEB_CAPTURE_ORIGINS: "chrome-extension://abc123",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      // A wedged server would otherwise hang the whole suite instead of
      // failing. Re-applied from ea347c6 after a wholesale file copy from the
      // retired checkout reverted it.
      const forceKill = setTimeout(() => {
        if (server.exitCode === null) server.kill("SIGKILL");
      }, 5_000);
      try {
        const [, signal] = await exited;
        assert.notEqual(signal, "SIGKILL", "MOSA test server did not shut down within 5 seconds");
      } finally {
        clearTimeout(forceKill);
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  const port = await waitForServerPort(server);
  await waitForServer(port, server);

  const extensionHealth = await fetch(`http://127.0.0.1:${port}/api/health`, {
    headers: { origin: "chrome-extension://abc123" },
  });
  assert.equal(extensionHealth.status, 200, "approved extension origin can discover MOSA through health");
  assert.equal(extensionHealth.headers.get("access-control-allow-origin"), "chrome-extension://abc123");
  assert.equal((await extensionHealth.json()).product, "mosa");

  const blockedExtensionHealth = await fetch(`http://127.0.0.1:${port}/api/health`, {
    headers: { origin: "chrome-extension://other" },
  });
  assert.equal(blockedExtensionHealth.status, 403, "unapproved extension origins stay blocked from health");
  await blockedExtensionHealth.arrayBuffer();

  const blocked = await fetch(`http://127.0.0.1:${port}/api/ingest/web-capture`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://chatgpt.com",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({
      provider: "chatgpt",
      imageBase64: SAMPLE_PNG_BASE64,
      mimeType: "image/jpeg",
    }),
  });
  assert.equal(blocked.status, 403);
  await blocked.arrayBuffer();

  const unapprovedExtension = await fetch(`http://127.0.0.1:${port}/api/ingest/web-capture`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "chrome-extension://other",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({ provider: "chatgpt", imageBase64: SAMPLE_PNG_BASE64, mimeType: "image/jpeg" }),
  });
  assert.equal(unapprovedExtension.status, 403);
  await unapprovedExtension.arrayBuffer();

  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/ingest/web-capture`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "chrome-extension://abc123",
      authorization: "Bearer wrong",
    },
    body: JSON.stringify({
      provider: "chatgpt",
      imageBase64: SAMPLE_PNG_BASE64,
      mimeType: "image/jpeg",
    }),
  });
  assert.equal(unauthorized.status, 401);
  await unauthorized.arrayBuffer();
  assert.equal(unauthorized.headers.get("access-control-allow-origin"), "chrome-extension://abc123");

  const blockedPairing = await fetch(`http://127.0.0.1:${port}/api/web-capture/pair`, {
    method: "POST",
    headers: { origin: "chrome-extension://other", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(blockedPairing.status, 403);
  await blockedPairing.arrayBuffer();

  const paired = await fetch(`http://127.0.0.1:${port}/api/web-capture/pair`, {
    method: "POST",
    headers: { origin: "chrome-extension://abc123", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(paired.status, 200);
  assert.equal(paired.headers.get("access-control-allow-origin"), "chrome-extension://abc123");
  assert.deepEqual(await paired.json(), { product: "mosa", token: "test-token" });

  const imported = await fetch(`http://127.0.0.1:${port}/api/ingest/web-capture`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "chrome-extension://abc123",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({
      provider: "chatgpt",
      prompt: "Model caption: A detailed travel poster illustration with bold typography and limited color palette for Hong Kong skyline.",
      prompt_status: "generation-tool-prompt",
      user_message: "在做一版 香港 的",
      imageBase64: SAMPLE_PNG_BASE64,
      mimeType: "image/jpeg",
      pageUrl: "https://chatgpt.com/c/test",
    }),
  });
  assert.equal(imported.status, 201);
  const body = await imported.json();
  assert.equal(body.status, "imported");
  assert.equal(body.asset?.source?.type, "web-chatgpt");
  assert.match(body.asset?.prompt || "", /Hong Kong/i);
  assert.equal(body.asset?.source?.user_message, "在做一版 香港 的");

  const referenceResponse = await fetch(`http://127.0.0.1:${port}/api/ingest/web-capture`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "chrome-extension://abc123",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({
      provider: "chatgpt",
      is_reference: true,
      imageBase64: (await noiseImage(88)).toString("base64"),
      mimeType: "image/png",
      conversationId: "http-reference-demo",
      capturedAt: "2026-08-13T10:00:00.000Z",
    }),
  });
  assert.equal(referenceResponse.status, 201);
  const referenceBody = await referenceResponse.json();
  assert.equal(referenceBody.status, "imported");
  assert.equal(referenceBody.asset, undefined);
  assert.match(referenceBody.attachment?.attachment_url || "", /^\/library\/default\/references\//);

  const attachmentResponse = await fetch(`http://127.0.0.1:${port}${referenceBody.attachment.attachment_url}`);
  assert.equal(attachmentResponse.status, 200);
  assert.equal(attachmentResponse.headers.get("content-type"), "image/png");
  assert.ok((await attachmentResponse.arrayBuffer()).byteLength > 20 * 1024);

  const missingAttachment = await fetch(`http://127.0.0.1:${port}/library/default/references/not-present.png`);
  assert.equal(missingAttachment.status, 404);
  await missingAttachment.arrayBuffer();

  const bridges = await fetch(`http://127.0.0.1:${port}/api/bridges`, {
    headers: { origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(bridges.status, 200);
  const bridgeBody = await bridges.json();
  assert.equal(bridgeBody.webCapture?.enabled, true);
  assert.ok(bridgeBody.webCapture?.providers?.includes("chatgpt"));
});

async function waitForServerPort(server) {
  let buffer = "";
  for await (const chunk of server.stdout) {
    buffer += chunk.toString("utf8");
    const match = buffer.match(/MOSA: http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) return Number(match[1]);
  }
  throw new Error(`Server exited before printing port: ${buffer}`);
}

async function waitForServer(port, server, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    if (server.exitCode !== null) throw new Error(`Server exited early with code ${server.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/bridges`, {
        headers: { origin: `http://127.0.0.1:${port}` },
      });
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Server did not become ready");
}

// Solid colours compress below the 20 KiB floor the ingest uses to reject UI
// logos, so fixtures need incompressible content.
async function noiseImage(seed) {
  const width = 720;
  const height = 960;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * (37 + seed) + (i % 251) + seed * 13) & 255;
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

function referenceFixture(bytes, conversationId, capturedAt) {
  return {
    projectId: "default",
    bytes,
    extension: ".png",
    mimeType: "image/png",
    width: 720,
    height: 960,
    provider: "chatgpt",
    conversationId,
    capturedAt,
  };
}

test("prefers the store's indexed content-hash lookup over a project scan", async (t) => {
  // The scan this replaced was worst on a miss, which is the normal case while
  // capturing new images. A store that offers the indexed lookup must have it
  // used, and the listing must not be pulled just to answer the byte question.
  const root = await mkdtemp(join(tmpdir(), "mosa-ingest-indexed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const image = await noiseImage(5);

  let indexedCalls = 0;
  let listCalls = 0;
  const store = {
    createAsset: async (input) => ({ id: input.assetId, ...input, source: { ...input.source } }),
    listAssets: async () => { listCalls += 1; return []; },
    findAssetByContentHash: async () => { indexedCalls += 1; return null; },
  };

  await ingestWebCapture({
    store,
    tempRoot: join(root, "tmp"),
    input: { provider: "chatgpt", imageBase64: image.toString("base64"), mimeType: "image/png" },
  });

  assert.equal(indexedCalls, 1, "the indexed lookup answers the byte-hash question");
  // One listing pass is two calls, active and archived. Seeing four would mean
  // the pixel fallback and the turn-reference lookup each pulled their own.
  assert.equal(listCalls, 2, `the pixel fallback reuses one shared listing, saw ${listCalls} calls`);
});

test("links only the references from the generation's own turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-ingest-turn-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const archived = [
    { id: "old-gen", source: { conversation_id: "c1", captured_at: "2026-07-26T10:01:00.000Z" }, business_fields: { is_reference: false } },
  ];
  const referenceStore = createReferenceAttachmentStore(root);
  await referenceStore.save(referenceFixture(await noiseImage(30), "c1", "2026-07-26T10:00:00.000Z"));
  const refA = await referenceStore.save(referenceFixture(await noiseImage(31), "c1", "2026-07-26T10:05:00.000Z"));
  const refB = await referenceStore.save(referenceFixture(await noiseImage(32), "c1", "2026-07-26T10:06:00.000Z"));
  await referenceStore.save(referenceFixture(await noiseImage(33), "c2", "2026-07-26T10:05:30.000Z"));

  let created;
  const store = {
    createAsset: async (input) => { created = input; return { id: input.assetId, ...input }; },
    listAssets: async ({ archived: wantArchived } = {}) => (wantArchived ? [] : archived),
    findAssetByContentHash: async () => null,
  };
  const image = await noiseImage(3);

  await ingestWebCapture({
    store,
    referenceStore,
    tempRoot: join(root, "tmp"),
    input: {
      provider: "chatgpt", imageBase64: image.toString("base64"), mimeType: "image/png",
      conversationId: "c1", capturedAt: "2026-07-26T10:07:00.000Z",
    },
  });

  assert.deepEqual(created.references.map((item) => item.asset_id), [refA.attachment.id, refB.attachment.id]);
  assert.deepEqual(created.references.map((item) => item.sha256), [refA.attachment.content_sha256, refB.attachment.content_sha256]);
  assert.equal(created.references[0].applied, true);
  assert.equal(created.references[0].role, "", "the capture cannot know the purpose and must not invent one");
});

test("a reference upload never calls createAsset", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-ingest-ref-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const image = await noiseImage(0);

  let createCalls = 0;
  const store = {
    createAsset: async () => { createCalls += 1; throw new Error("must not create an asset"); },
    listAssets: async () => [],
    findAssetByContentHash: async () => null,
  };

  const result = await ingestWebCapture({
    store,
    tempRoot: join(root, "tmp"),
    input: {
      provider: "chatgpt", imageBase64: image.toString("base64"), mimeType: "image/png",
      conversationId: "c1", capturedAt: "2026-07-26T10:01:00.000Z", is_reference: true,
    },
  });

  assert.equal(result.status, "imported");
  assert.ok(result.attachment);
  assert.equal(result.asset, undefined);
  assert.equal(createCalls, 0);
});

test("serializes concurrent reference attachment index updates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-reference-concurrent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const referenceStore = createReferenceAttachmentStore(root);
  const independentStore = createReferenceAttachmentStore(root);
  const [first, second] = await Promise.all([
    referenceStore.save(referenceFixture(await noiseImage(60), "c1", "2026-08-13T10:00:00.000Z")),
    independentStore.save(referenceFixture(await noiseImage(61), "c1", "2026-08-13T10:00:01.000Z")),
  ]);
  assert.equal(first.created, true);
  assert.equal(second.created, true);
  assert.deepEqual(new Set((await referenceStore.list("default")).map((item) => item.id)), new Set([first.attachment.id, second.attachment.id]));
});

test("reference attachment pruning keeps reachable shared references and removes unreachable files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-reference-prune-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const referenceStore = createReferenceAttachmentStore(root);
  const first = await referenceStore.save(referenceFixture(await noiseImage(62), "c1", "2026-08-13T10:00:00.000Z"));
  const second = await referenceStore.save(referenceFixture(await noiseImage(63), "c2", "2026-08-13T10:00:01.000Z"));

  const result = await referenceStore.pruneUnused("default", new Set([first.attachment.id]));
  assert.deepEqual(result, { removed: 1, retained: 1, failed: 0 });
  assert.deepEqual((await referenceStore.list("default")).map((item) => item.id), [first.attachment.id]);
  const files = await readdir(join(root, "reference-attachments", "default", "files"));
  assert.deepEqual(files, [first.attachment.file_name]);
  assert.notEqual(first.attachment.id, second.attachment.id);
});

test("reference attachments dedupe re-encodes by current display pixels", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-reference-pixels-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const raw = Buffer.alloc(32 * 24 * 4);
  for (let i = 0; i < raw.length; i += 4) {
    raw[i] = (i * 17) & 255;
    raw[i + 1] = (i * 29) & 255;
    raw[i + 2] = (i * 43) & 255;
    raw[i + 3] = i % 20 === 0 ? 128 : 255;
  }
  const firstBytes = await sharp(raw, { raw: { width: 32, height: 24, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
  const secondBytes = await sharp(raw, { raw: { width: 32, height: 24, channels: 4 } }).png({ compressionLevel: 1 }).toBuffer();
  assert.notDeepEqual(firstBytes, secondBytes);

  const referenceStore = createReferenceAttachmentStore(root);
  const first = await referenceStore.save(referenceFixture(firstBytes, "c1", "2026-08-13T10:00:00.000Z"));
  const second = await referenceStore.save(referenceFixture(secondBytes, "c1", "2026-08-13T10:00:01.000Z"));
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.duplicateKind, "pixel");
  assert.equal(second.attachment.id, first.attachment.id);
  assert.equal((await referenceStore.list("default")).length, 1);
});

test("a capture with no conversation identifier links nothing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-ingest-noconv-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const image = await noiseImage(6);

  let created;
  const store = {
    createAsset: async (input) => { created = input; return { id: input.assetId, ...input }; },
    listAssets: async () => [
      { id: "loose-ref", source: { captured_at: "2026-07-26T10:00:00.000Z" }, business_fields: { is_reference: true } },
    ],
    findAssetByContentHash: async () => null,
  };

  await ingestWebCapture({
    store,
    tempRoot: join(root, "tmp"),
    input: { provider: "chatgpt", imageBase64: image.toString("base64"), mimeType: "image/png", capturedAt: "2026-07-26T10:01:00.000Z" },
  });

  assert.deepEqual(created.references, [], "nothing ties a loose capture to a turn");
});
