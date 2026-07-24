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

test("rejects tiny logo images and blanks weak chat-only prompts", async () => {
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
      await exited;
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
