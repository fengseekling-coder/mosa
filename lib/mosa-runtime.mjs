import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssetStore, mimeTypeForFile, SUPPORTED_MEDIA_EXTENSIONS } from "./asset-store.mjs";
import { createCodexImageBridge } from "./codex-image-bridge.js";
import { createCowartBridgeManager } from "./cowart-bridge-manager.js";
import { createCowartCanvasDiscovery } from "./cowart-canvas-discovery.js";
import { createCowartProjectRegistry } from "./cowart-project-registry.js";
import { createCowartMcpClient } from "./cowart-mcp-client.js";
import { createGrokMediaBridge } from "./grok-media-bridge.js";
import { isAllowedIngestOrigin, isAllowedLocalOrigin, parseAllowedIngestOrigins } from "./server-security.js";
import { createDerivativeWorker } from "./derivative-worker.js";
import { acquireMosaRuntimeLock } from "./runtime-lock.js";
import { createWebCaptureIngest } from "./web-capture-ingest.js";
import { handleApiRequest } from "./api-routes.mjs";
import { sendJson } from "./http-response.mjs";
import { DEFAULT_MOSA_PORT, normalizeMosaPort } from "./runtime-defaults.mjs";

const moduleDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
].join("; ");
let managerDir;
let cowartProjectDir;
let projectRoot;
let port;
let libraryDir;
let codexSessionsDir;
let grokSessionsDir;
let webCaptureOrigins;
let runtimeLock;
let store;
let cowartProjectRegistry;
let cowartBridge;
let codexBridge;
let grokBridge;
let webCaptureIngest;
let cowartCanvasDiscovery;
let cowartMcpClient;
let derivativeWorker;
let appDir;
let server;
let activeRuntime = null;
let shutdownPromise = null;
let startupInProgress = false;

/**
 * Starts the HTTP server, bridge watchers, and derivative worker without
 * installing process signal handlers. CLI and desktop hosts own their own
 * shutdown policy through the returned stop function.
 */
export async function startMosaRuntime(options = {}) {
  if (activeRuntime || startupInProgress) {
    throw new Error("A MOSA runtime is already active in this process.");
  }

  const env = options.env || process.env;
  managerDir = resolve(options.managerDir || join(moduleDir, ".."));
  cowartProjectDir = resolve(options.cowartProjectDir || managerDir);
  projectRoot = resolve(options.projectRoot || env.MOSA_PROJECT_DIR || join(managerDir, ".."));
  port = normalizeMosaPort(options.port ?? env.MOSA_PORT ?? DEFAULT_MOSA_PORT, { allowZero: true });
  libraryDir = resolve(options.libraryDir || env.MOSA_LIBRARY_DIR || join(homedir(), "MOSA Library"));
  codexSessionsDir = resolve(options.codexSessionsDir || env.CODEX_SESSIONS_DIR || join(homedir(), ".codex", "sessions"));
  grokSessionsDir = resolve(options.grokSessionsDir || env.GROK_SESSIONS_DIR || join(homedir(), ".grok", "sessions"));
  webCaptureOrigins = parseAllowedIngestOrigins(options.webCaptureOrigins || env.MOSA_WEB_CAPTURE_ORIGINS);
  appDir = resolve(options.appDir || join(managerDir, "app"));
  shutdownPromise = null;
  startupInProgress = true;

  try {
    runtimeLock = await acquireMosaRuntimeLock({ libraryDir });
    store = createAssetStore({
      projectRoot,
      managerDir,
      libraryDir,
      assetsRoot: options.assetsRoot,
      generatedImagesDir: options.generatedImagesDir,
      codexImagesDir: options.codexImagesDir,
      cowartCanvasDir: options.cowartCanvasDir,
    });
  cowartProjectRegistry = createCowartProjectRegistry({
    managerDir: cowartProjectDir,
    registryPath: options.cowartRegistryPath || env.MOSA_COWART_REGISTRY_PATH,
  });
  cowartBridge = createCowartBridgeManager({
    store,
    registry: cowartProjectRegistry,
    managerDir: cowartProjectDir,
    canvasDir: store.cowartCanvasDir,
  });
  codexBridge = createCodexImageBridge({
    store,
    imagesDir: store.codexImagesDir,
    sessionsDir: codexSessionsDir,
  });
  grokBridge = createGrokMediaBridge({
    store,
    sessionsDir: grokSessionsDir,
  });
  webCaptureIngest = createWebCaptureIngest({
    store,
    libraryDir,
    token: options.webCaptureToken || env.MOSA_WEB_CAPTURE_TOKEN,
    allowedOrigins: webCaptureOrigins,
  });
  cowartCanvasDiscovery = createCowartCanvasDiscovery({
    sessionsDir: codexSessionsDir,
    managerDir: cowartProjectDir,
    dedicatedCanvasDir: store.cowartCanvasDir,
    knownProjectDirs: () => cowartBridge.sources().map((source) => source.projectDir),
    onDiscover: ({ projectDir }) => cowartBridge.addProject({ projectDir }),
  });
  cowartMcpClient = createCowartMcpClient({ serverPath: options.cowartMcpServerPath || env.COWART_MCP_SERVER_PATH });
  derivativeWorker = createDerivativeWorker({ store });

  await store.ensureProject("default");
  await cowartBridge.start();
  await cowartCanvasDiscovery.start();
  await codexBridge.start();
  await grokBridge.start();
  derivativeWorker.start();
  server = createServer(async (req, res) => {
  try {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);

    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    const activePort = boundPortFor(server, port);
    const isWebCaptureRoute = url.pathname === "/api/ingest/web-capture" || url.pathname === "/api/web-capture";

    if (isWebCaptureRoute) {
      if (!isAllowedIngestOrigin(req.headers.origin, activePort, webCaptureOrigins)) {
        sendJson(res, 403, { error: "Cross-origin requests are not allowed." });
        return;
      }
      if (req.headers.origin) {
        res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        res.setHeader("Vary", "Origin");
      }
    } else if (!isAllowedLocalOrigin(req.headers.origin, activePort)) {
      sendJson(res, 403, { error: "Cross-origin requests are not allowed." });
      return;
    }

    // Web-capture allows chrome-extension preflight; other routes stay same-origin only.
    if (req.method === "OPTIONS") {
      if (isWebCaptureRoute && isAllowedIngestOrigin(req.headers.origin, activePort, webCaptureOrigins)) {
        res.statusCode = 204;
        if (req.headers.origin) res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, x-mosa-token");
        res.setHeader("Access-Control-Max-Age", "600");
        res.end();
        return;
      }
      res.statusCode = 204;
      res.end();
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApiRequest({ req, res, url, context: apiContext() });
      if (!handled) sendJson(res, 404, { error: "Not found" });
      return;
    }

    if (url.pathname.startsWith("/library/")) {
      await handleLibrary(res, url);
      return;
    }

    await handleStatic(res, url.pathname);
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 500;
    const payload = { error: error instanceof Error ? error.message : String(error) };
    if (error?.statusCode && error?.code) payload.code = error.code;
    sendJson(res, statusCode, payload);
  }
  });
  await listen(server, port);
  const boundPort = boundPortFor(server, port);
  const runtime = {
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    libraryDir,
    storage: store?.storageKind || "json",
    stop: shutdown,
  };
  activeRuntime = runtime;
  server.once("error", (error) => {
    console.error(error);
    void shutdown();
  });
  return runtime;
  } catch (error) {
    await cleanupRuntime();
    throw error;
  } finally {
    startupInProgress = false;
  }
}

async function cleanupRuntime() {
  const resources = {
    derivativeWorker,
    grokBridge,
    codexBridge,
    cowartCanvasDiscovery,
    cowartBridge,
    store,
    runtimeLock,
  };
  derivativeWorker = null;
  grokBridge = null;
  codexBridge = null;
  cowartCanvasDiscovery = null;
  cowartBridge = null;
  cowartProjectRegistry = null;
  cowartMcpClient = null;
  webCaptureIngest = null;
  store = null;
  runtimeLock = null;
  if (!server?.listening) server = null;

  const results = await Promise.allSettled([
    () => resources.derivativeWorker?.stop?.(),
    () => resources.grokBridge?.stop?.(),
    () => resources.codexBridge?.stop?.(),
    () => resources.cowartCanvasDiscovery?.stop?.(),
    () => resources.cowartBridge?.stop?.(),
    () => resources.store?.close?.(),
    () => resources.runtimeLock?.release?.(),
  ].map(async (cleanup) => cleanup()));
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(failures.map((result) => result.reason), "MOSA runtime cleanup failed.");
  }
}

function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    const serverToClose = server;
    server = null;
    try {
      if (serverToClose?.listening) await closeServer(serverToClose);
    } finally {
      try {
        await cleanupRuntime();
      } finally {
        activeRuntime = null;
      }
    }
  })();
  return shutdownPromise;
}

function closeServer(serverInstance) {
  return new Promise((resolveClose, rejectClose) => {
    serverInstance.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") rejectClose(error);
      else resolveClose();
    });
  });
}

function boundPortFor(serverInstance, fallbackPort) {
  const address = serverInstance.address();
  return typeof address === "object" && address ? address.port : fallbackPort;
}

function apiContext() {
  return {
    libraryDir,
    grokSessionsDir,
    supportedMediaExtensions: SUPPORTED_MEDIA_EXTENSIONS,
    store,
    cowartBridge,
    codexBridge,
    grokBridge,
    webCaptureIngest,
    cowartCanvasDiscovery,
    cowartMcpClient,
    derivativeWorker,
  };
}

function listen(serverInstance, requestedPort) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      serverInstance.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      serverInstance.off("error", onError);
      resolveListen();
    };
    serverInstance.once("error", onError);
    serverInstance.once("listening", onListening);
    serverInstance.listen(requestedPort, "127.0.0.1");
  });
}

async function handleLibrary(res, url) {
  const derivativeMatch = /^\/library\/([^/]+)\/(thumbnails|previews)\/([^/]+)\.webp$/.exec(url.pathname);
  if (derivativeMatch) {
    const kind = derivativeMatch[2] === "previews" ? "preview" : "thumbnail";
    try {
      if (typeof store.derivativeReadStream !== "function") throw new Error("Derivatives unavailable.");
      const imageStream = await store.derivativeReadStream(decodeURIComponent(derivativeMatch[1]), decodeURIComponent(derivativeMatch[3]), kind);
      imageStream.on("error", () => { if (!res.headersSent) sendJson(res, 404, { error: "Derivative not found" }); });
      res.statusCode = 200;
      res.setHeader("content-type", "image/webp");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      imageStream.pipe(res);
    } catch {
      sendJson(res, 404, { error: "Derivative not found" });
    }
    return;
  }
  const match = /^\/library\/([^/]+)\/images\/([^/]+)$/.exec(url.pathname);
  if (!match) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const fileName = decodeURIComponent(match[2]);
  let imageStream;
  try {
    imageStream = await store.assetReadStream(decodeURIComponent(match[1]), fileName);
  } catch {
    sendJson(res, 404, { error: "Asset not found" });
    return;
  }

  imageStream.on("error", (error) => {
    if (res.writableEnded) return;
    if (!res.headersSent) {
      sendJson(res, 404, { error: "Asset not found" });
      return;
    }
    res.destroy(error);
  });
  res.statusCode = 200;
  res.setHeader("content-type", mimeTypeForFile(fileName));
  // Library images are copied under unique asset filenames and never mutate in place.
  // Keep a loaded gallery thumbnail available for the inspector without another network round trip.
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  imageStream.pipe(res);
}

async function handleStatic(res, pathname) {
  const fileName = pathname === "/" ? "index.html" : basename(pathname);
  const filePath = join(appDir, fileName);
  if (resolve(filePath) !== join(appDir, fileName)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const content = await readFile(filePath);
    res.statusCode = 200;
    res.setHeader("content-type", staticMime(filePath));
    res.end(content);
  } catch {
    const content = await readFile(join(appDir, "index.html"));
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(content);
  }
}

function staticMime(filePath) {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}
