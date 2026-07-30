import { extractBearerToken, WEB_CAPTURE_MAX_BODY_BYTES } from "../web-capture-ingest.js";
import { readJson, sendJson } from "../http-response.mjs";

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
    sendJson(res, 200, {
      product: "mosa",
      libraryDir,
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
