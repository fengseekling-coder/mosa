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
import { createGrokMediaBridge } from "./grok-media-bridge.js";
import { isAllowedIngestOrigin, isAllowedLocalOrigin, isApprovedExtensionOrigin, parseAllowedIngestOrigins } from "./server-security.js";
import { createDerivativeWorker } from "./derivative-worker.js";
import { getBuildIdentity } from "./build-identity.mjs";
import { acquireMosaRuntimeLock } from "./runtime-lock.js";
import { cleanupWebCaptureTemp, createWebCaptureIngest } from "./web-capture-ingest.js";
import { handleApiRequest } from "./api-routes.mjs";
import { pipeStreamToResponse, sendJson } from "./http-response.mjs";
import { cleanupOrphanStagedFiles, importStagingDir } from "./import-staging.mjs";
import { createLibraryChangeStream } from "./library-change-stream.mjs";
import { DEFAULT_MOSA_PORT, MOSA_RESERVED_PRODUCTION_PORTS, normalizeMosaPort } from "./runtime-defaults.mjs";
import { parseDisabledBridges } from "./runtime-bridges.mjs";
import { validateRuntimeIsolation } from "./runtime-isolation-guard.mjs";
import { resolveSourceLocations } from "./source-locations.js";

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
let derivativeWorker;
let libraryChangeStream;
let trashPurgeTimer = null;
let appDir;
let runtimeBuildIdentity = null;
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
  ({ codexSessionsDir, grokSessionsDir } = resolveSourceLocations({
    env,
    overrides: {
      codexSessionsDir: options.codexSessionsDir,
      grokSessionsDir: options.grokSessionsDir,
    },
  }));
  webCaptureOrigins = parseAllowedIngestOrigins(options.webCaptureOrigins || env.MOSA_WEB_CAPTURE_ORIGINS);
  appDir = resolve(options.appDir || join(managerDir, "app"));
  // Freeze the identity of the code/UI pair this process started with. Static
  // assets are deliberately read from disk on every request, so without this
  // snapshot a long-lived old runtime could read a newly-written
  // build-identity.json later and falsely report itself as the new build.
  runtimeBuildIdentity = Object.freeze({ ...getBuildIdentity(appDir) });
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
    productionPorts: MOSA_RESERVED_PRODUCTION_PORTS,
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
    libraryChangeStream = createLibraryChangeStream({ store });
    // Browser/manual uploads use a server-owned staging directory below the
    // library assets root. Sweep only stale plain files there so cancelled or
    // interrupted imports cannot accumulate indefinitely.
    cleanupOrphanStagedFiles(importStagingDir(store.assetsRoot)).catch((error) => {
      console.warn(`[MOSA] browser import-staging orphan sweep failed: ${error?.message || error}`);
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
    onLibraryChange: (projectId) => libraryChangeStream?.checkNow?.(projectId),
  });
  cleanupWebCaptureTemp(webCaptureIngest.tempRoot).catch((error) => {
    console.warn(`[MOSA] web-capture temp orphan sweep failed: ${error?.message || error}`);
  });
  if (typeof store.purgeExpiredTrash === "function") {
    const purgeTrash = async () => {
      if (typeof store.cleanupPermanentDeletionStaging === "function") {
        const staged = await store.cleanupPermanentDeletionStaging();
        if (staged?.failed) console.warn(`[MOSA] permanent-delete staging cleanup deferred ${staged.failed} item(s).`);
      }
      const result = await store.purgeExpiredTrash();
      if (result?.failed) console.warn(`[MOSA] trash purge deferred ${result.failed} busy item(s); they will be retried.`);
      if (result?.removed && typeof webCaptureIngest?.pruneReferences === "function" && typeof store.listReferencedAttachmentIds === "function") {
        for (const projectId of result.projects || []) {
          const referencedIds = await store.listReferencedAttachmentIds(projectId);
          await webCaptureIngest.pruneReferences(projectId, referencedIds);
        }
      }
      return result;
    };
    void purgeTrash().catch((error) => {
      console.warn(`[MOSA] trash purge failed: ${error?.message || error}`);
    });
    trashPurgeTimer = setInterval(() => {
      void purgeTrash().catch((error) => console.warn(`[MOSA] trash purge failed: ${error?.message || error}`));
    }, 60 * 60 * 1000);
    trashPurgeTimer.unref?.();
  }
  cowartCanvasDiscovery = createCowartCanvasDiscovery({
    sessionsDir: codexSessionsDir,
    managerDir: cowartProjectDir,
    dedicatedCanvasDir: store.cowartCanvasDir,
    knownProjectDirs: () => cowartBridge.sources().map((source) => source.projectDir),
    onDiscover: ({ projectDir }) => cowartBridge.addProject({ projectDir }),
  });
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
    // DNS-rebinding guard: the origin checks below only protect cross-origin
    // requests, but a rebinding page is "same-origin" to this loopback service
    // and sends no Origin header at all. The Host header is the last line of
    // defense, so requests must name a loopback host on the actual bound port.
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const hostPort = url.port ? Number(url.port) : 0;
    const loopbackHost = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
    if (!req.headers.host || !loopbackHost || (hostPort !== 0 && hostPort !== activePort)) {
      sendJson(res, 403, { error: "Forbidden host." });
      return;
    }
    const isWebCapturePairRoute = url.pathname === "/api/web-capture/pair";
    const isWebCaptureHealthRoute = url.pathname === "/api/health" && isApprovedExtensionOrigin(req.headers.origin, webCaptureOrigins);
    const isWebCaptureRoute = isWebCapturePairRoute || isWebCaptureHealthRoute
      || url.pathname === "/api/ingest/web-capture"
      || url.pathname === "/api/ingest/web-capture-binary"
      || url.pathname.startsWith("/api/ingest/web-capture-upload/")
      || url.pathname === "/api/web-capture";

    if (isWebCaptureRoute) {
      const originAllowed = isWebCapturePairRoute || isWebCaptureHealthRoute
        ? isApprovedExtensionOrigin(req.headers.origin, webCaptureOrigins)
        : isAllowedIngestOrigin(req.headers.origin, activePort, webCaptureOrigins);
      if (!originAllowed) {
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
      const webCapturePreflightAllowed = isWebCapturePairRoute || isWebCaptureHealthRoute
        ? isApprovedExtensionOrigin(req.headers.origin, webCaptureOrigins)
        : isAllowedIngestOrigin(req.headers.origin, activePort, webCaptureOrigins);
      if (isWebCaptureRoute && webCapturePreflightAllowed) {
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
      await handleLibrary(req, res, url);
      return;
    }

    await handleStatic(res, url.pathname);
  } catch (error) {
    const statusCode = error instanceof URIError ? 400 : (Number(error?.statusCode) || 500);
    const internal = statusCode >= 500;
    if (internal) console.error("MOSA request failed:", error);
    const exposeMessage = !internal || error?.expose === true;
    const payload = { error: exposeMessage ? (error instanceof Error ? error.message : String(error)) : "Internal server error." };
    if (error instanceof URIError) payload.code = "MALFORMED_URL_ENCODING";
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
  if (typeof store.cleanupOrphanedManagedFiles === "function") {
    // Managed-file cleanup is maintenance, not a prerequisite for serving the
    // library. Start it only after the runtime is listening so large/external
    // libraries cannot turn directory enumeration into startup latency.
    void store.cleanupOrphanedManagedFiles().catch((error) => {
      console.warn(`[MOSA] managed-file orphan sweep failed: ${error?.message || error}`);
    });
  }
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
    libraryChangeStream,
    derivativeWorker,
    grokBridge,
    codexBridge,
    cowartCanvasDiscovery,
    cowartBridge,
    store,
    runtimeLock,
    trashPurgeTimer,
  };
  if (trashPurgeTimer) clearInterval(trashPurgeTimer);
  derivativeWorker = null;
  libraryChangeStream = null;
  trashPurgeTimer = null;
  grokBridge = null;
  codexBridge = null;
  cowartCanvasDiscovery = null;
  cowartBridge = null;
  cowartProjectRegistry = null;
  webCaptureIngest = null;
  store = null;
  runtimeLock = null;
  importStagingRoot = null;
  runtimeBuildIdentity = null;
  actualUserData = null;
  if (!server?.listening) server = null;

  const bridgeResults = await Promise.allSettled([
    () => resources.libraryChangeStream?.close?.(),
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
    buildIdentity: runtimeBuildIdentity,
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
    derivativeWorker,
    libraryChangeStream,
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

async function handleLibrary(req, res, url) {
  const referenceMatch = /^\/library\/([^/]+)\/references\/([^/]+)$/.exec(url.pathname);
  if (referenceMatch) {
    try {
      const reference = await webCaptureIngest.readReference(decodeURIComponent(referenceMatch[1]), decodeURIComponent(referenceMatch[2]));
      res.statusCode = 200;
      res.setHeader("content-type", mimeTypeForFile(reference.fileName));
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      pipeStreamToResponse(reference.stream, res, {
        errorPayload: { error: "Reference attachment unavailable" },
      });
    } catch {
      sendJson(res, 404, { error: "Reference attachment not found" });
    }
    return;
  }
  const derivativeMatch = /^\/library\/([^/]+)\/(thumbnails|mediums|previews)\/([^/]+)\.webp$/.exec(url.pathname);
  if (derivativeMatch) {
    const kind = derivativeMatch[2] === "previews" ? "preview" : derivativeMatch[2] === "mediums" ? "medium" : "thumbnail";
    try {
      if (typeof store.derivativeReadStream !== "function") throw new Error("Derivatives unavailable.");
      const imageStream = await store.derivativeReadStream(decodeURIComponent(derivativeMatch[1]), decodeURIComponent(derivativeMatch[3]), kind);
      res.statusCode = 200;
      res.setHeader("content-type", "image/webp");
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      pipeStreamToResponse(imageStream, res, {
        errorStatusCode: 404,
        errorPayload: { error: "Derivative not found" },
      });
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
  const projectId = decodeURIComponent(match[1]);
  let fileInfo;
  try {
    if (typeof store.assetFileInfo !== "function") throw new Error("Asset file info unavailable.");
    fileInfo = await store.assetFileInfo(projectId, fileName);
  } catch {
    sendJson(res, 404, { error: "Asset not found" });
    return;
  }

  const size = Number(fileInfo?.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    sendJson(res, 500, { error: "Asset size unavailable" });
    return;
  }
  const range = parseSingleByteRange(req.headers.range, size);
  res.setHeader("content-type", mimeTypeForFile(fileName));
  res.setHeader("Accept-Ranges", "bytes");
  // Library media are copied under unique asset filenames and never mutate in place.
  // Keep a loaded gallery item available for the inspector without another network round trip.
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  if (range?.unsatisfiable) {
    res.statusCode = 416;
    res.setHeader("Content-Range", `bytes */${size}`);
    res.setHeader("Content-Length", "0");
    res.end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, size - 1);
  const contentLength = range ? end - start + 1 : size;
  res.statusCode = range ? 206 : 200;
  res.setHeader("Content-Length", String(contentLength));
  if (range) res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  if (req.method === "HEAD" || size === 0) {
    res.end();
    return;
  }

  let imageStream;
  try {
    imageStream = await store.assetReadStream(projectId, fileName, range ? { start, end } : undefined);
  } catch {
    if (!res.headersSent) sendJson(res, 404, { error: "Asset not found" });
    else res.destroy();
    return;
  }
  pipeStreamToResponse(imageStream, res, {
    errorStatusCode: 404,
    errorPayload: { error: "Asset not found" },
  });
}

/**
 * Chromium's media stack only needs a single byte range for normal metadata,
 * playback, and seeking. Multiple ranges are intentionally rejected instead
 * of buffering multipart responses in the local runtime.
 */
function parseSingleByteRange(header, size) {
  if (!header) return null;
  const value = Array.isArray(header) ? header[0] : String(header);
  if (!value.toLowerCase().startsWith("bytes=")) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || size <= 0 || (!match[1] && !match[2])) return { unsatisfiable: true };

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { unsatisfiable: true };
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(match[1]);
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    return { unsatisfiable: true };
  }
  end = Math.min(end, size - 1);
  return { start, end };
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
