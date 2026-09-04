import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { HttpError, readBytes, readJson, sendJson } from "../http-response.mjs";
import { inspectTrustedExternalCanvas } from "../cowart-canvas-discovery.js";
import {
  extractBearerToken,
  WEB_CAPTURE_MAX_BODY_BYTES,
  WEB_CAPTURE_MAX_IMAGE_BYTES,
  WEB_CAPTURE_MAX_VIDEO_BYTES,
} from "../web-capture-ingest.js";
import { getBuildIdentity } from "../build-identity.mjs";
import { MCP_SERVER_VERSION, MOSA_SERVICE_PROTOCOL_VERSION } from "../version-identities.mjs";

// Shared trust bar with the registry and the bridge manager: the canvas must
// be a real, non-symlink direct child of the project holding a Cowart marker.
const COWART_TRUST_FAILURE_CODES = {
  "project-missing": "COWART_CANVAS_DIR_MISSING",
  "project-not-directory": "COWART_CANVAS_DIR_MISSING",
  "canvas-missing": "COWART_CANVAS_DIR_MISSING",
  "canvas-not-directory": "COWART_CANVAS_DIR_MISSING",
  "canvas-symlink": "COWART_CANVAS_SYMLINK",
  "canvas-outside-project": "COWART_CANVAS_OUTSIDE_PROJECT",
  "canvas-no-markers": "COWART_CANVAS_NO_MARKERS",
};
const WEB_CAPTURE_BINARY_META_BYTES = 256 * 1024;
const WEB_CAPTURE_UPLOAD_TTL_MS = 10 * 60 * 1000;
const WEB_CAPTURE_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const WEB_CAPTURE_UPLOAD_VIDEO_EXT = new Map([
  ["video/mp4", ".mp4"],
  ["video/webm", ".webm"],
  ["video/quicktime", ".mov"],
  ["video/x-m4v", ".m4v"],
]);
const webCaptureUploads = new Map();

async function pruneWebCaptureUploads(now = Date.now()) {
  for (const [id, upload] of webCaptureUploads) {
    if (upload.expiresAt > now) continue;
    webCaptureUploads.delete(id);
    await rm(upload.path, { force: true }).catch(() => {});
  }
}

export async function handleBridgeRoute({ req, res, url, context }) {
  const {
    libraryDir,
    store,
    cowartBridge,
    codexBridge,
    grokBridge,
    webCaptureIngest,
    cowartCanvasDiscovery,
    derivativeWorker,
  } = context;

  if (req.method === "GET" && url.pathname === "/api/health") {
    const identity = context.buildIdentity || getBuildIdentity(context.appDir);
    sendJson(res, 200, {
      product: "mosa",
      libraryDir,
      storage: store?.storageKind || "json",
      serviceProtocolVersion: MOSA_SERVICE_PROTOCOL_VERSION,
      productVersion: identity.productVersion,
      mcpServerVersion: MCP_SERVER_VERSION,
      gitSha: identity.gitSha,
      uiFingerprint: identity.uiFingerprint,
      runtimeFingerprint: identity.runtimeFingerprint,
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/diagnostics") {
    sendJson(res, 200, {
      libraryDir,
      actualUserData: context.actualUserData || null,
      storage: store?.storageKind || "json",
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/cowart-bridge") {
    sendJson(res, 200, { bridge: cowartBridge.status() });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/codex-bridge") {
    sendJson(res, 200, { bridge: codexBridge.status() });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/grok-bridge") {
    sendJson(res, 200, { bridge: grokBridge.status() });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/web-capture") {
    sendJson(res, 200, { bridge: webCaptureIngest.status() });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/web-capture/pair") {
    const status = webCaptureIngest.status();
    const token = String(webCaptureIngest.token || "").trim();
    if (!status.enabled || !token) {
      sendJson(res, 503, {
        error: "Web capture pairing is unavailable for this MOSA runtime.",
        code: "WEB_CAPTURE_PAIRING_UNAVAILABLE",
      });
      return true;
    }
    sendJson(res, 200, { product: "mosa", token });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/ingest/web-capture") {
    // Base64 images need a larger body budget than ordinary JSON metadata posts.
    const body = await readJson(req, WEB_CAPTURE_MAX_BODY_BYTES);
    const result = await webCaptureIngest.ingest(body, extractBearerToken(req));
    if (result.status === "imported" && result.asset) derivativeWorker.wake();
    sendJson(res, result.status === "imported" ? 201 : 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/ingest/web-capture-metadata") {
    const body = await readJson(req, WEB_CAPTURE_BINARY_META_BYTES);
    const result = await webCaptureIngest.upgradeMetadata(body, extractBearerToken(req));
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/ingest/web-capture-binary") {
    // Binary envelope: uint32be metadata length, UTF-8 JSON metadata, then raw
    // media bytes. Videos no longer need a 4/3-size Base64 JSON representation.
    const body = await readBytes(req, WEB_CAPTURE_MAX_VIDEO_BYTES + WEB_CAPTURE_BINARY_META_BYTES + 4);
    if (body.length < 5) throw new HttpError(400, "WEB_CAPTURE_BINARY_INVALID", "Invalid web capture binary envelope.");
    const metadataBytes = body.readUInt32BE(0);
    if (metadataBytes < 2 || metadataBytes > WEB_CAPTURE_BINARY_META_BYTES || 4 + metadataBytes >= body.length) {
      throw new HttpError(400, "WEB_CAPTURE_BINARY_INVALID", "Invalid web capture metadata length.");
    }
    let metadata;
    try {
      metadata = JSON.parse(body.subarray(4, 4 + metadataBytes).toString("utf8"));
    } catch {
      throw new HttpError(400, "WEB_CAPTURE_BINARY_INVALID", "Invalid web capture metadata JSON.");
    }
    const mediaBytes = body.subarray(4 + metadataBytes);
    const mediaKind = metadata?.mediaKind === "video" ? "video" : "image";
    const maxMediaBytes = mediaKind === "video" ? WEB_CAPTURE_MAX_VIDEO_BYTES : WEB_CAPTURE_MAX_IMAGE_BYTES;
    if (mediaBytes.length > maxMediaBytes) {
      throw new HttpError(413, "WEB_CAPTURE_BINARY_TOO_LARGE", "Web capture media exceeds the supported size limit.");
    }
    const input = mediaKind === "video"
      ? { ...metadata, mediaBytes }
      : { ...metadata, imageBytes: mediaBytes };
    const result = await webCaptureIngest.ingest(input, extractBearerToken(req));
    if (result.status === "imported" && result.asset) derivativeWorker.wake();
    sendJson(res, result.status === "imported" ? 201 : 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/ingest/web-capture-upload/begin") {
    webCaptureIngest.assertToken(extractBearerToken(req));
    await pruneWebCaptureUploads();
    const body = await readJson(req, WEB_CAPTURE_BINARY_META_BYTES);
    const totalBytes = Number(body?.totalBytes || 0);
    const totalChunks = Number(body?.totalChunks || 0);
    const metadata = body?.metadata;
    const uploadExt = WEB_CAPTURE_UPLOAD_VIDEO_EXT.get(String(metadata?.mimeType || "").toLowerCase());
    const exactSize = Number.isInteger(totalBytes) && totalBytes > 0;
    const exactChunks = Number.isInteger(totalChunks) && totalChunks > 0;
    if (!metadata || metadata.mediaKind !== "video" || !Number.isInteger(totalBytes)
      || totalBytes < 0 || totalBytes > WEB_CAPTURE_MAX_VIDEO_BYTES
      || !Number.isInteger(totalChunks) || totalChunks < 0 || totalChunks > 64
      || exactSize !== exactChunks || (exactSize && totalBytes < 64 * 1024) || !uploadExt) {
      throw new HttpError(400, "WEB_CAPTURE_UPLOAD_INVALID", "Invalid Web Capture upload declaration.");
    }
    const uploadId = randomUUID();
    await mkdir(webCaptureIngest.tempRoot, { recursive: true });
    const path = join(webCaptureIngest.tempRoot, `upload-${uploadId}${uploadExt}`);
    await writeFile(path, Buffer.alloc(0), { flag: "wx" });
    webCaptureUploads.set(uploadId, {
      path, metadata, totalBytes, totalChunks, nextIndex: 0, receivedBytes: 0,
      expiresAt: Date.now() + WEB_CAPTURE_UPLOAD_TTL_MS,
    });
    sendJson(res, 201, { uploadId });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/ingest/web-capture-upload/chunk") {
    webCaptureIngest.assertToken(extractBearerToken(req));
    await pruneWebCaptureUploads();
    const uploadId = String(req.headers["x-mosa-upload-id"] || "").trim();
    const index = Number(req.headers["x-mosa-chunk-index"]);
    const upload = webCaptureUploads.get(uploadId);
    if (!upload || !Number.isInteger(index) || index !== upload.nextIndex) {
      throw new HttpError(409, "WEB_CAPTURE_UPLOAD_SEQUENCE", "Unknown upload or out-of-order chunk.");
    }
    const chunk = await readBytes(req, WEB_CAPTURE_UPLOAD_CHUNK_BYTES);
    const nextBytes = upload.receivedBytes + chunk.length;
    if (!chunk.length || nextBytes > WEB_CAPTURE_MAX_VIDEO_BYTES
      || (upload.totalBytes > 0 && nextBytes > upload.totalBytes)) {
      throw new HttpError(400, "WEB_CAPTURE_UPLOAD_CHUNK_INVALID", "Invalid Web Capture upload chunk.");
    }
    await appendFile(upload.path, chunk);
    upload.receivedBytes += chunk.length;
    upload.nextIndex += 1;
    upload.expiresAt = Date.now() + WEB_CAPTURE_UPLOAD_TTL_MS;
    sendJson(res, 200, { receivedBytes: upload.receivedBytes, nextIndex: upload.nextIndex });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/ingest/web-capture-upload/commit") {
    const authToken = extractBearerToken(req);
    webCaptureIngest.assertToken(authToken);
    await pruneWebCaptureUploads();
    const body = await readJson(req, 16 * 1024);
    const uploadId = String(body?.uploadId || "").trim();
    const upload = webCaptureUploads.get(uploadId);
    const exactUploadComplete = upload && upload.totalBytes > 0
      ? upload.receivedBytes === upload.totalBytes && upload.nextIndex === upload.totalChunks
      : upload && upload.receivedBytes >= 64 * 1024 && upload.receivedBytes <= WEB_CAPTURE_MAX_VIDEO_BYTES;
    if (!upload || !exactUploadComplete) {
      throw new HttpError(409, "WEB_CAPTURE_UPLOAD_INCOMPLETE", "Web Capture upload is incomplete.");
    }
    webCaptureUploads.delete(uploadId);
    const result = await webCaptureIngest.ingestFile(upload.metadata, upload.path, authToken);
    if (result.status === "imported" && result.asset) derivativeWorker.wake();
    sendJson(res, result.status === "imported" ? 201 : 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/ingest/web-capture-upload/abort") {
    webCaptureIngest.assertToken(extractBearerToken(req));
    const body = await readJson(req, 16 * 1024);
    const uploadId = String(body?.uploadId || "").trim();
    const upload = webCaptureUploads.get(uploadId);
    if (upload) {
      webCaptureUploads.delete(uploadId);
      await rm(upload.path, { force: true }).catch(() => {});
    }
    sendJson(res, 200, { aborted: Boolean(upload) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/bridges") {
    sendJson(res, 200, {
      codex: codexBridge.status(),
      grok: grokBridge.status(),
      webCapture: webCaptureIngest.status(),
      cowart: cowartBridge.status(),
      cowartDiscovery: cowartCanvasDiscovery.status(),
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/cowart-canvases") {
    await cowartCanvasDiscovery.reconcile();
    sendJson(res, 200, { canvases: cowartBridge.sources() });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/cowart-canvases") {
    const body = await readJson(req);
    const rawPath = String(body.projectDir || "").trim();
    if (!rawPath) {
      sendJson(res, 400, { error: "Cowart project path is required.", code: "COWART_PROJECT_PATH_REQUIRED" });
      return true;
    }
    if (!isAbsolute(rawPath)) {
      sendJson(res, 400, { error: "Cowart project path must be an absolute directory.", code: "COWART_PROJECT_PATH_NOT_ABSOLUTE" });
      return true;
    }
    if (rawPath.split(/[\\/]/).includes("..")) {
      sendJson(res, 400, { error: "Cowart project path must not contain '..' path segments.", code: "COWART_PROJECT_PATH_UNSAFE" });
      return true;
    }
    const inspection = await inspectTrustedExternalCanvas(rawPath);
    if (!inspection.trusted) {
      sendJson(res, 400, { error: inspection.message, code: COWART_TRUST_FAILURE_CODES[inspection.reason] || "COWART_CANVAS_UNTRUSTED" });
      return true;
    }
    const result = await cowartBridge.addProject({ projectDir: rawPath });
    sendJson(res, result.created ? 201 : 200, result);
    return true;
  }

  const cowartCanvasMatch = /^\/api\/cowart-canvases\/([^/]+)$/.exec(url.pathname);
  if (cowartCanvasMatch && req.method === "DELETE") {
    const canvas = await cowartBridge.removeProject(decodeURIComponent(cowartCanvasMatch[1]));
    sendJson(res, 200, { canvas });
    return true;
  }

  return false;
}
