import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssetStore, mimeTypeForFile } from "./lib/asset-store.mjs";

const managerDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const projectRoot = resolve(process.env.ASSET_MANAGER_PROJECT_DIR || join(managerDir, ".."));
const port = Number(process.env.ASSET_MANAGER_PORT || 43517);
const store = createAssetStore({ projectRoot, managerDir });
const appDir = join(managerDir, "app");

await store.ensureProject("default");

const server = createServer(async (req, res) => {
  try {
    // 添加 CORS 头，允许本地开发
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    // 处理 CORS 预检请求
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
  console.log(`GPT Asset Manager: http://127.0.0.1:${port}`);
});

async function handleApi(req, res, url) {
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
    // 白名单验证：只允许打开已知的项目目录
    const allowedPaths = [
      store.projectRoot,
      store.managerDir,
      ...store.listProjects().then(projects => projects.map(p => store.projectDir(p))).catch(() => [])
    ].filter(Boolean);

    const isAllowed = allowedPaths.some(allowed => {
      try {
        const normalized = path.resolve(body.path);
        return normalized === path.resolve(allowed) || normalized.startsWith(path.resolve(allowed) + path.sep);
      } catch { return false; }
    });

    if (!isAllowed) {
      sendJson(res, 403, { error: "Path not allowed" });
      return;
    }

    try {
      const { spawn } = await import("node:child_process");
      const child = spawn("open", [body.path], { stdio: "ignore" });
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

  if (req.method === "POST" && url.pathname === "/api/assets/sync-cowart") {
    const body = await readJson(req);
    sendJson(res, 200, await store.syncCowartAssets(body.projectId || "default"));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/assets/canvas-insert") {
    const body = await readJson(req);
    sendJson(res, 200, await store.insertAssetIntoCowart(body));
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
  res.statusCode = 200;
  res.setHeader("content-type", mimeTypeForFile(fileName));
  store.assetReadStream(decodeURIComponent(match[1]), fileName).pipe(res);
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
