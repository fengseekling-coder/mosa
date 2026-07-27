import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import sharp from "sharp";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import {
  createWebCaptureIngest,
  ingestWebCapture,
  WEB_CAPTURE_MAX_BODY_BYTES,
  WEB_CAPTURE_MAX_IMAGE_BYTES,
} from "../lib/web-capture-ingest.mjs";
import { isAllowedIngestOrigin, parseAllowedIngestOrigins } from "../lib/server-security.mjs";

// High-entropy raster so compressed size exceeds the logo gate (~20KiB).
const SAMPLE_PNG_BASE64 = await (async () => {
  const width = 720;
  const height = 960;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 37 + (i % 251)) & 255;
  const buf = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
  return buf.toString("base64");
})();

const LOGO_PNG_BASE64 = (
  await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 220, g: 30, b: 30 } },
  })
    .png()
    .toBuffer()
).toString("base64");

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
        user_message: "做一张曼谷海报",
        imageBase64: SAMPLE_PNG_BASE64,
        mimeType: "image/jpeg",
        pageUrl: "https://chatgpt.com/c/demo",
        conversationId: "demo",
      },
    });
    assert.equal(first.status, "imported");
    assert.equal(first.asset.source?.type, "web-chatgpt");
    assert.match(first.asset.prompt, /poster-style vector illustration/i);
    assert.equal(first.asset.source?.provider, "chatgpt");
    assert.equal(first.asset.source?.user_message, "做一张曼谷海报");
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

test("marks an uploaded reference photo so it stays filterable next to generations", async () => {
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
      },
    });
    assert.equal(reference.status, "imported");
    assert.equal(reference.asset.category, "reference");
    assert.ok(reference.asset.tags.includes("reference"));
    assert.equal(reference.asset.business_fields?.is_reference, true);

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
    assert.equal(repeat.asset.id, reference.asset.id);
    assert.equal((await store.listAssets({ projectId: "default" })).length, 1);
  } finally {
    store.close?.();
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
    // An earlier turn in the same conversation: its reference and its result.
    { id: "old-ref", source: { conversation_id: "c1", captured_at: "2026-07-26T10:00:00.000Z", content_sha256: "a1" }, business_fields: { is_reference: true } },
    { id: "old-gen", source: { conversation_id: "c1", captured_at: "2026-07-26T10:01:00.000Z" }, business_fields: { is_reference: false } },
    // This turn's uploads.
    { id: "ref-a", source: { conversation_id: "c1", captured_at: "2026-07-26T10:05:00.000Z", content_sha256: "a2" }, business_fields: { is_reference: true } },
    { id: "ref-b", source: { conversation_id: "c1", captured_at: "2026-07-26T10:06:00.000Z", content_sha256: "a3" }, business_fields: { is_reference: true } },
    // A different conversation must never be pulled in.
    { id: "other", source: { conversation_id: "c2", captured_at: "2026-07-26T10:05:30.000Z", content_sha256: "a4" }, business_fields: { is_reference: true } },
  ];

  let created;
  const store = {
    createAsset: async (input) => { created = input; return { id: input.assetId, ...input }; },
    listAssets: async ({ archived: wantArchived } = {}) => (wantArchived ? [] : archived),
    findAssetByContentHash: async () => null,
  };
  const image = await noiseImage(3);

  await ingestWebCapture({
    store,
    tempRoot: join(root, "tmp"),
    input: {
      provider: "chatgpt", imageBase64: image.toString("base64"), mimeType: "image/png",
      conversationId: "c1", capturedAt: "2026-07-26T10:07:00.000Z",
    },
  });

  assert.deepEqual(created.references.map((item) => item.asset_id), ["ref-a", "ref-b"]);
  assert.deepEqual(created.references.map((item) => item.sha256), ["a2", "a3"]);
  assert.equal(created.references[0].applied, true);
  assert.equal(created.references[0].role, "", "the capture cannot know the purpose and must not invent one");
});

test("a reference upload records no references of its own", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-ingest-ref-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const image = await noiseImage(0);

  let created;
  const store = {
    createAsset: async (input) => { created = input; return { id: input.assetId, ...input }; },
    listAssets: async () => [
      { id: "sibling", source: { conversation_id: "c1", captured_at: "2026-07-26T10:00:00.000Z" }, business_fields: { is_reference: true } },
    ],
    findAssetByContentHash: async () => null,
  };

  await ingestWebCapture({
    store,
    tempRoot: join(root, "tmp"),
    input: {
      provider: "chatgpt", imageBase64: image.toString("base64"), mimeType: "image/png",
      conversationId: "c1", capturedAt: "2026-07-26T10:01:00.000Z", is_reference: true,
    },
  });

  assert.deepEqual(created.references, []);
  assert.equal(created.category, "reference");
  assert.ok(created.tags.includes("reference"));
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
