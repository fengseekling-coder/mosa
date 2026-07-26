import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssetStore, mimeTypeForFile, SUPPORTED_MEDIA_EXTENSIONS } from "./asset-store.mjs";
import { createCodexImageBridge } from "./codex-image-bridge.mjs";
import { createCowartBridgeManager } from "./cowart-bridge-manager.mjs";
import { createCowartCanvasDiscovery } from "./cowart-canvas-discovery.mjs";
import { createCowartProjectRegistry } from "./cowart-project-registry.mjs";
import { createCowartMcpClient } from "./cowart-mcp-client.mjs";
import { createGrokMediaBridge } from "./grok-media-bridge.mjs";
import { chooseCowartInsertTarget, normalizeCowartInsertResult, resolveCowartInsertCanvas, verifyCowartInsert } from "./cowart-insert.mjs";
import { isAllowedIngestOrigin, isAllowedLocalOrigin, parseAllowedIngestOrigins, resolveAllowedFolderPath } from "./server-security.mjs";
import { createDerivativeWorker } from "./derivative-worker.mjs";
import { acquireMosaRuntimeLock } from "./runtime-lock.mjs";
import { createWebCaptureIngest, extractBearerToken, WEB_CAPTURE_MAX_BODY_BYTES } from "./web-capture-ingest.mjs";
import { normalizeAssetSort } from "./asset-sort.mjs";

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
  port = normalizePort(options.port ?? env.MOSA_PORT ?? 43517);
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
      await handleApi(req, res, url);
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

function normalizePort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error("MOSA port must be an integer from 0 to 65535.");
  }
  return parsed;
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

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      product: "mosa",
      libraryDir,
      storage: store?.storageKind || "json",
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/cowart-bridge") {
    sendJson(res, 200, { bridge: cowartBridge.status() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/codex-bridge") {
    sendJson(res, 200, { bridge: codexBridge.status() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/grok-bridge") {
    sendJson(res, 200, { bridge: grokBridge.status() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/web-capture") {
    sendJson(res, 200, { bridge: webCaptureIngest.status() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/ingest/web-capture") {
    // Base64 images need a larger body budget than ordinary JSON metadata posts.
    const body = await readJson(req, WEB_CAPTURE_MAX_BODY_BYTES);
    const result = await webCaptureIngest.ingest(body, extractBearerToken(req));
    if (result.status === "imported") derivativeWorker.wake();
    sendJson(res, result.status === "imported" ? 201 : 200, result);
    return;
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
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/cowart-canvases") {
    await cowartCanvasDiscovery.reconcile();
    sendJson(res, 200, { canvases: cowartBridge.sources() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cowart-canvases") {
    const body = await readJson(req);
    const result = await cowartBridge.addProject({ projectDir: body.projectDir });
    sendJson(res, result.created ? 201 : 200, result);
    return;
  }

  const cowartCanvasMatch = /^\/api\/cowart-canvases\/([^/]+)$/.exec(url.pathname);
  if (cowartCanvasMatch && req.method === "DELETE") {
    const canvas = await cowartBridge.removeProject(decodeURIComponent(cowartCanvasMatch[1]));
    sendJson(res, 200, { canvas });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/projects") {
    sendJson(res, 200, { projects: await store.listProjects() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/groups") {
    sendJson(res, 200, {
      groups: await store.listGroups(url.searchParams.get("project") || "default")
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/groups") {
    const body = await readJson(req);
    sendJson(res, 201, {
      group: await store.createGroup(body)
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/library-path") {
    const projectId = url.searchParams.get("project") || "default";
    sendJson(res, 200, {
      path: store.projectDir(projectId),
      codexGeneratedImagesDir: store.codexImagesDir,
      grokSessionsDir,
      storage: store.storageKind || "json",
      libraryDir: store.libraryDir || null,
      supportedMediaExtensions: SUPPORTED_MEDIA_EXTENSIONS,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/open-folder") {
    const body = await readJson(req);
    const projects = await store.listProjects();
    const allowedPaths = [
      store.managerDir,
      ...projects.map((projectId) => store.projectDir(projectId)),
    ].filter(Boolean);
    const folderPath = resolveAllowedFolderPath(body.path, allowedPaths);

    if (!folderPath) {
      sendJson(res, 403, { error: "Path not allowed" });
      return;
    }

    let folderStat;
    try {
      folderStat = await stat(folderPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        sendJson(res, 404, { error: "Path does not exist" });
        return;
      }
      throw error;
    }
    if (!folderStat.isDirectory()) {
      sendJson(res, 400, { error: "Path is not a directory" });
      return;
    }

    try {
      const { spawn } = await import("node:child_process");
      const child = spawn("open", [folderPath], { stdio: "ignore" });
      child.unref();
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/assets") {
    const filters = {
      projectId: url.searchParams.get("project") || "default",
      query: url.searchParams.get("q") || "",
      group: url.searchParams.get("group") || "",
      category: url.searchParams.get("category") || "",
      style: url.searchParams.get("style") || "",
      source: url.searchParams.get("source") || "",
      favorite: url.searchParams.get("favorite") === "1",
      recent: url.searchParams.get("recent") === "1",
      sort: normalizeAssetSort(url.searchParams.get("sort")),
      limit: url.searchParams.get("limit") || undefined,
      cursor: url.searchParams.get("cursor") || undefined,
    };
    const page = typeof store.listAssetPage === "function"
      ? await store.listAssetPage(filters)
      : { assets: await store.listAssets(filters), page: { total: 0, nextCursor: null } };
    sendJson(res, 200, page);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/assets/create") {
    const body = await readJson(req);
    sendJson(res, 200, { asset: await store.createAsset(body) });
    derivativeWorker.wake();
    return;
  }

  const insertMatch = /^\/api\/assets\/([^/]+)\/([^/]+)\/insert-cowart$/.exec(url.pathname);
  if (insertMatch && req.method === "POST") {
    const projectId = decodeURIComponent(insertMatch[1]);
    const assetId = decodeURIComponent(insertMatch[2]);
    const asset = await store.getAsset(projectId, assetId);
    if (!cowartMcpClient.status().available) {
      sendJson(res, 503, { error: "Cowart MCP server is unavailable." });
      return;
    }
    const body = await readJson(req);
    const placement = ["right", "left", "below"].includes(body.placement) ? body.placement : "right";
    const targetCanvas = resolveCowartInsertCanvas(cowartBridge.sources(), body.targetId);
    if (!targetCanvas) {
      sendJson(res, 400, { error: "Cowart insertion target is not registered." });
      return;
    }
    const cowartTargetArgs = { projectDir: targetCanvas.projectDir, canvasDir: targetCanvas.canvasDir };
    const [canvasStateResult, selectionResult] = await Promise.all([
      cowartMcpClient.callTool("get_cowart_canvas_state", cowartTargetArgs),
      cowartMcpClient.callTool("get_cowart_selection", cowartTargetArgs),
    ]);
    const target = chooseCowartInsertTarget(canvasStateResult.structuredContent || {}, selectionResult.structuredContent || {});
    const result = await cowartMcpClient.callTool("insert_cowart_image", {
      imagePath: asset.image_path,
      ...cowartTargetArgs,
      fileName: basename(asset.image_path),
      placement,
      pageId: target.pageId || undefined,
      anchorShapeId: target.anchorShapeId || undefined,
      matchAnchor: false,
      replaceAiImageHolder: false,
      altText: asset.theme || asset.asset || asset.id,
      assetMeta: { mosaAssetId: asset.id, mosaProjectId: asset.project_id },
    });
    const insertion = normalizeCowartInsertResult(result.structuredContent);
    if (!insertion) throw new Error("Cowart did not confirm a persisted image shape.");

    const persistedState = await cowartMcpClient.callTool("get_cowart_canvas_state", cowartTargetArgs);
    const verified = verifyCowartInsert(persistedState.structuredContent || {}, insertion, {
      id: asset.id,
      projectId: asset.project_id,
    });
    if (!verified) throw new Error("Cowart did not persist the inserted image on the target canvas.");

    sendJson(res, 200, {
      ok: true,
      assetId: asset.id,
      result: insertion,
      canvas: {
        ...verified,
        sourceId: targetCanvas.id,
        projectDir: targetCanvas.projectDir,
        canvasDir: targetCanvas.canvasDir,
        anchorSource: target.anchorSource,
      },
    });
    return;
  }

  const assetMatch = /^\/api\/assets\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  const archiveMatch = /^\/api\/assets\/([^/]+)\/([^/]+)\/archive$/.exec(url.pathname);
  if (archiveMatch && req.method === "POST") {
    if (typeof store.archiveAsset !== "function") throw new Error("Asset archival is unavailable.");
    sendJson(res, 200, { asset: await store.archiveAsset(decodeURIComponent(archiveMatch[1]), decodeURIComponent(archiveMatch[2])) });
    return;
  }
  const duplicateMatch = /^\/api\/assets\/([^/]+)\/([^/]+)\/duplicate$/.exec(url.pathname);
  if (duplicateMatch && req.method === "POST") {
    if (typeof store.duplicateAsset !== "function") throw new Error("Asset duplication is unavailable.");
    const body = await readJson(req);
    sendJson(res, 201, { asset: await store.duplicateAsset(decodeURIComponent(duplicateMatch[1]), decodeURIComponent(duplicateMatch[2]), body) });
    derivativeWorker.wake();
    return;
  }
  const versionsMatch = /^\/api\/assets\/([^/]+)\/([^/]+)\/versions$/.exec(url.pathname);
  if (versionsMatch && req.method === "GET") {
    if (typeof store.getAssetVersionHistory !== "function") throw new Error("Asset version history is unavailable.");
    const projectId = decodeURIComponent(versionsMatch[1]);
    const assetId = decodeURIComponent(versionsMatch[2]);
    sendJson(res, 200, { history: await store.getAssetVersionHistory(projectId, assetId) });
    return;
  }
  if (versionsMatch && req.method === "POST") {
    if (typeof store.createAssetVersion !== "function") throw new Error("Asset version creation is unavailable.");
    const projectId = decodeURIComponent(versionsMatch[1]);
    const assetId = decodeURIComponent(versionsMatch[2]);
    const body = await readJson(req);
    sendJson(res, 201, { asset: await store.createAssetVersion(projectId, assetId, body) });
    derivativeWorker.wake();
    return;
  }
  const recipesMatch = /^\/api\/assets\/([^/]+)\/([^/]+)\/recipes$/.exec(url.pathname);
  if (recipesMatch && req.method === "GET") {
    if (typeof store.getRecipeSnapshotHistory !== "function") throw new Error("Recipe snapshot history is unavailable.");
    const projectId = decodeURIComponent(recipesMatch[1]);
    const assetId = decodeURIComponent(recipesMatch[2]);
    sendJson(res, 200, { history: await store.getRecipeSnapshotHistory(projectId, assetId) });
    return;
  }
  if (assetMatch && req.method === "GET") {
    sendJson(res, 200, { asset: await store.getAsset(decodeURIComponent(assetMatch[1]), decodeURIComponent(assetMatch[2])) });
    return;
  }

  if (assetMatch && req.method === "PATCH") {
    const body = await readJson(req);
    sendJson(res, 200, { asset: await store.updateMetadata(decodeURIComponent(assetMatch[1]), decodeURIComponent(assetMatch[2]), body) });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
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

class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function readJson(req, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let totalBytes = 0;
    let rejected = false;
    const MAX_SIZE = Number.isFinite(maxBytes) ? Math.max(1024, maxBytes) : 5 * 1024 * 1024;
    req.on("data", (chunk) => {
      if (rejected) return;
      totalBytes += Buffer.byteLength(chunk);
      if (totalBytes > MAX_SIZE) {
        rejected = true;
        rejectBody(new HttpError(413, "REQUEST_BODY_TOO_LARGE", "Request body too large."));
        req.resume();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => {
      if (rejected) return;
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolveBody(body ? JSON.parse(body) : {});
      } catch {
        rejectBody(new HttpError(400, "INVALID_JSON_BODY", "Invalid JSON in request body."));
      }
    });
    req.on("error", (error) => {
      if (!rejected) rejectBody(error);
    });
  });
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function staticMime(filePath) {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}
