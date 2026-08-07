import { isAbsolute } from "node:path";
import { HttpError, readJson, sendJson } from "../http-response.mjs";
import { inspectTrustedExternalCanvas } from "../cowart-canvas-discovery.js";
import { extractBearerToken, WEB_CAPTURE_MAX_BODY_BYTES } from "../web-capture-ingest.js";
import { getBuildIdentity } from "../build-identity.mjs";

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

export async function handleBridgeRoute({ req, res, url, context }) {
  const {
    libraryDir,
    store,
    cowartBridge,
    codexBridge,
    grokBridge,
    webCaptureIngest,
    cowartCanvasDiscovery,
    cowartMcpClient,
    derivativeWorker,
  } = context;

  if (req.method === "GET" && url.pathname === "/api/health") {
    const identity = getBuildIdentity(context.appDir);
    sendJson(res, 200, {
      product: "mosa",
      libraryDir,
      storage: store?.storageKind || "json",
      productVersion: identity.productVersion,
      gitSha: identity.gitSha,
      uiFingerprint: identity.uiFingerprint,
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

  if (req.method === "POST" && url.pathname === "/api/ingest/web-capture") {
    // Base64 images need a larger body budget than ordinary JSON metadata posts.
    const body = await readJson(req, WEB_CAPTURE_MAX_BODY_BYTES);
    const result = await webCaptureIngest.ingest(body, extractBearerToken(req));
    if (result.status === "imported") derivativeWorker.wake();
    sendJson(res, result.status === "imported" ? 201 : 200, result);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/bridges") {
    sendJson(res, 200, {
      codex: codexBridge.status(),
      grok: grokBridge.status(),
      webCapture: webCaptureIngest.status(),
      cowart: cowartBridge.status(),
      cowartDiscovery: cowartCanvasDiscovery.status(),
      cowartInsert: cowartMcpClient.status(),
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
    const result = await cowartBridge.addProject({ projectDir: body.projectDir });
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
