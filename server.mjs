import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssetStore, mimeTypeForFile } from "./lib/asset-store.mjs";
import { createCodexImageBridge } from "./lib/codex-image-bridge.mjs";
import { createCowartBridgeManager } from "./lib/cowart-bridge-manager.mjs";
import { createCowartProjectRegistry } from "./lib/cowart-project-registry.mjs";
import { createCowartMcpClient } from "./lib/cowart-mcp-client.mjs";
import { chooseCowartInsertTarget, normalizeCowartInsertResult, verifyCowartInsert } from "./lib/cowart-insert.mjs";
import { isAllowedLocalOrigin, resolveAllowedFolderPath } from "./lib/server-security.mjs";

const managerDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const projectRoot = resolve(process.env.MOSA_PROJECT_DIR || join(managerDir, ".."));
const port = Number(process.env.MOSA_PORT || 43517);
const store = createAssetStore({ projectRoot, managerDir });
const cowartProjectRegistry = createCowartProjectRegistry({
  managerDir,
  registryPath: process.env.MOSA_COWART_REGISTRY_PATH,
});
const cowartBridge = createCowartBridgeManager({
  store,
  registry: cowartProjectRegistry,
  managerDir,
  canvasDir: store.cowartCanvasDir,
});
const codexBridge = createCodexImageBridge({
  store,
  imagesDir: store.codexImagesDir,
  sessionsDir: process.env.CODEX_SESSIONS_DIR,
});
const cowartMcpClient = createCowartMcpClient({ serverPath: process.env.COWART_MCP_SERVER_PATH });
const appDir = join(managerDir, "app");

await store.ensureProject("default");
await cowartBridge.start();
await codexBridge.start();

const server = createServer(async (req, res) => {
  try {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");

    if (!isAllowedLocalOrigin(req.headers.origin, boundPortFor(server, port))) {
      sendJson(res, 403, { error: "Cross-origin requests are not allowed." });
      return;
    }

    // The app is same-origin; do not grant cross-origin preflight access.
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

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
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`MOSA: http://127.0.0.1:${boundPortFor(server, port)}`);
});

function boundPortFor(serverInstance, fallbackPort) {
  const address = serverInstance.address();
  return typeof address === "object" && address ? address.port : fallbackPort;
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/cowart-bridge") {
    sendJson(res, 200, { bridge: cowartBridge.status() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/codex-bridge") {
    sendJson(res, 200, { bridge: codexBridge.status() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/bridges") {
    sendJson(res, 200, { codex: codexBridge.status(), cowart: cowartBridge.status(), cowartInsert: cowartMcpClient.status() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/cowart-canvases") {
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
      codexGeneratedImagesDir: store.codexImagesDir
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
    sendJson(res, 200, {
      assets: await store.listAssets({
        projectId: url.searchParams.get("project") || "default",
        query: url.searchParams.get("q") || "",
        group: url.searchParams.get("group") || "",
        category: url.searchParams.get("category") || "",
        style: url.searchParams.get("style") || "",
        source: url.searchParams.get("source") || "",
        favorite: url.searchParams.get("favorite") === "1",
        recent: url.searchParams.get("recent") === "1"
      })
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/assets/create") {
    const body = await readJson(req);
    sendJson(res, 200, { asset: await store.createAsset(body) });
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
    const cowartTargetArgs = { projectDir: managerDir, canvasDir: store.cowartCanvasDir };
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
      canvas: { ...verified, anchorSource: target.anchorSource },
    });
    return;
  }

  const assetMatch = /^\/api\/assets\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (assetMatch && req.method === "GET") {
    sendJson(res, 200, { asset: await store.getAsset(assetMatch[1], assetMatch[2]) });
    return;
  }

  if (assetMatch && req.method === "PATCH") {
    const body = await readJson(req);
    sendJson(res, 200, { asset: await store.updateMetadata(assetMatch[1], assetMatch[2], body) });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function handleLibrary(res, url) {
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
  const fileName = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  // 使用 path.normalize 安全处理路径，防止路径遍历攻击
  const normalized = fileName.replace(/\.\./g, ".");
  const safeFile = normalized.includes("..") ? "index.html" : normalized;
  const filePath = join(appDir, safeFile);

  // 确保解析后的路径在 appDir 内
  const resolvedPath = resolve(filePath);
  if (!resolvedPath.startsWith(resolve(appDir))) {
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

function readJson(req) {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";
    const MAX_SIZE = 5 * 1024 * 1024; // 5MB
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      // 在累加前检查单个 chunk 大小，防止超大 chunk 绕过限制
      if (chunk.length > MAX_SIZE) {
        rejectBody(new Error("Request body too large."));
        req.destroy();
        return;
      }
      if (body.length + chunk.length > MAX_SIZE) {
        rejectBody(new Error("Request body too large."));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolveBody(body ? JSON.parse(body) : {});
      } catch (error) {
        rejectBody(error);
      }
    });
    req.on("error", rejectBody);
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
