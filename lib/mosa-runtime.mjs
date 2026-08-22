import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
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
import { parseDisabledBridges } from "./runtime-bridges.mjs";
import { validateRuntimeIsolation } from "./runtime-isolation-guard.mjs";

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
// BUG-01 fix: exact import staging root trusted for the desktop shell's
// staged imports; null outside Electron so the default boundary is unchanged.
let importStagingRoot = null;
let server;
let activeRuntime = null;
let shutdownPromise = null;
let startupInProgress = false;
let actualUserData = null;

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
  // The isolation context resolved by the desktop shell (or the web server
  // CLI) carries the QA parameters through every layer; it wins over loose
  // per-call options so the same verified values reach the guard here.
  const isolation = options.isolationContext || {};
  managerDir = resolve(options.managerDir || join(moduleDir, ".."));
  cowartProjectDir = resolve(options.cowartProjectDir || managerDir);
  projectRoot = resolve(options.projectRoot || env.MOSA_PROJECT_DIR || join(managerDir, ".."));
  port = normalizeMosaPort(options.port ?? env.MOSA_PORT ?? DEFAULT_MOSA_PORT, { allowZero: true });
  // `libraryDir` always exists (defaulting to ~/MOSA Library) so SQLite detection,
  // the runtime lock, and health reporting keep working. `explicitLibraryDir` records
  // whether the caller actually configured a location; the JSON store must only reroot
  // its assets away from managerDir/assets when this is set.
  const explicitLibraryDir = options.libraryDir || env.MOSA_LIBRARY_DIR || null;
  libraryDir = resolve(explicitLibraryDir || join(homedir(), "MOSA Library"));
  codexSessionsDir = resolve(options.codexSessionsDir || env.CODEX_SESSIONS_DIR || join(homedir(), ".codex", "sessions"));
  grokSessionsDir = resolve(options.grokSessionsDir || env.GROK_SESSIONS_DIR || join(homedir(), ".grok", "sessions"));
  webCaptureOrigins = parseAllowedIngestOrigins(options.webCaptureOrigins || env.MOSA_WEB_CAPTURE_ORIGINS);
  appDir = resolve(options.appDir || join(managerDir, "app"));
  importStagingRoot = options.importStagingRoot ? resolve(options.importStagingRoot) : null;
  // `disabledBridges` is validated through the shared helper so the server CLI
  // and the desktop shell can never silently accept an unknown bridge name. An
  // explicit array wins over the MOSA_DISABLE_BRIDGES environment variable.
  const disabledBridges = parseDisabledBridges({
    explicit: options.disabledBridges,
    env,
  });
  const disabledBridgeSet = new Set(disabledBridges);
  const isBridgeEnabled = (name) => !disabledBridgeSet.has(name);
  shutdownPromise = null;
  startupInProgress = true;

  // ---- Runtime isolation guard: fail closed before any production write ----
  const guard = validateRuntimeIsolation({
    libraryDir: explicitLibraryDir,
    port,
    runtimeMode: isolation.runtimeMode ?? options.runtimeMode ?? env.MOSA_RUNTIME_MODE,
    qaRun: isolation.qaRun ?? options.qaRun ?? env.MOSA_QA_RUN,
    userData: isolation.expectedUserData ?? options.userData ?? env.MOSA_USER_DATA,
    actualUserData: isolation.actualUserData ?? options.actualUserData,
    argv: isolation.argv ?? options.argv ?? process.argv,
    defaultUserData: isolation.productionDefaultUserData,
    runtimeKind: isolation.runtimeKind,
    productionLibraryDir: join(homedir(), "MOSA Library"),
    productionPorts: [43517, 43519, 43637],
  });
  if (!guard.ok) {
    const err = new Error(`ISOLATION_GUARD_REJECTED: ${guard.field} ${guard.reason}`);
    err.code = "ERR_ISOLATION_GUARD";
    err.field = guard.field;
    startupInProgress = false;
    throw err;
  }

  actualUserData = isolation.actualUserData ?? options.actualUserData ?? env.MOSA_USER_DATA ?? null;

  try {
    runtimeLock = await acquireMosaRuntimeLock({ libraryDir });
    store = createAssetStore({
      projectRoot,
      managerDir,
      libraryDir,
      explicitLibraryDir: explicitLibraryDir ? resolve(explicitLibraryDir) : null,
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
  if (isBridgeEnabled("cowart")) await cowartBridge.start();
  if (isBridgeEnabled("cowartDiscovery")) await cowartCanvasDiscovery.start();
  if (isBridgeEnabled("codex")) await codexBridge.start();
  if (isBridgeEnabled("grok")) await grokBridge.start();
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
  importStagingRoot = null;
  actualUserData = null;
  if (!server?.listening) server = null;

  const bridgeResults = await Promise.allSettled([
    () => resources.derivativeWorker?.stop?.(),
    () => resources.grokBridge?.stop?.(),
    () => resources.codexBridge?.stop?.(),
    () => resources.cowartCanvasDiscovery?.stop?.(),
    () => resources.cowartBridge?.stop?.(),
  ].map(async (cleanup) => cleanup()));
  // Cowart shutdown can still be importing an asset when stop() begins. Close
  // the store only after every bridge has drained its active reconciliation.
  const storageResults = await Promise.allSettled([
    () => resources.store?.close?.(),
    () => resources.runtimeLock?.release?.(),
  ].map(async (cleanup) => cleanup()));
  const results = [...bridgeResults, ...storageResults];
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
  // Compute effectiveLibraryDir on-the-fly from store, which is module-level scope.
  // SQLite uses store.libraryDir; JSON fallback uses dirname(store.assetsRoot).
  const effectiveLibraryDir = store?.libraryDir || (store?.assetsRoot ? dirname(store.assetsRoot) : libraryDir);
  return {
    appDir,
    libraryDir: effectiveLibraryDir,
    actualUserData,
    grokSessionsDir,
    supportedMediaExtensions: SUPPORTED_MEDIA_EXTENSIONS,
    // BUG-01 fix: only the desktop shell's exact staging root is trusted for
    // asset creation; Web/server runs keep an empty array (unchanged default).
    trustedSourceRoots: importStagingRoot ? [importStagingRoot] : [],
    importStagingRoot,
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
  const referenceMatch = /^\/library\/([^/]+)\/references\/([^/]+)$/.exec(url.pathname);
  if (referenceMatch) {
    try {
      const reference = await webCaptureIngest.readReference(decodeURIComponent(referenceMatch[1]), decodeURIComponent(referenceMatch[2]));
      res.statusCode = 200;
      res.setHeader("content-type", mimeTypeForFile(reference.fileName));
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      reference.stream.pipe(res);
    } catch {
      sendJson(res, 404, { error: "Reference attachment not found" });
    }
    return;
  }
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
    // Explicit cache control for UI static files to prevent stale content issues.
    // index.html, CSS, JS, MJS, SVG etc. should be revalidated on each request
    // since they lack content hash in the URL (versioned URLs are a future optimization).
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
    res.end(content);
  } catch {
    // SPA fallback to index.html with the same cache policy.
    const content = await readFile(join(appDir, "index.html"));
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
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
