import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveAllowedFolderPath } from "../server-security.js";
import { readJson, sendJson } from "../http-response.mjs";

export async function handleLibraryRoute({ req, res, url, context }) {
  const { store, grokSessionsDir, supportedMediaExtensions, libraryDir, libraryChangeStream } = context;

  if (req.method === "GET" && url.pathname === "/api/library-events") {
    if (!libraryChangeStream?.attach) {
      sendJson(res, 503, { error: "Library event stream unavailable" });
      return true;
    }
    await libraryChangeStream.attach(req, res, url.searchParams.get("project") || "default");
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/projects") {
    sendJson(res, 200, { projects: await store.listProjects() });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/groups") {
    sendJson(res, 200, {
      groups: await store.listGroups(url.searchParams.get("project") || "default"),
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/library-revision") {
    const projectId = url.searchParams.get("project") || "default";
    sendJson(res, 200, {
      revision: typeof store.libraryRevision === "function" ? await store.libraryRevision(projectId) : null,
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/groups") {
    const body = await readJson(req);
    sendJson(res, 201, {
      group: await store.createGroup(body),
    });
    return true;
  }

  const groupMatch = /^\/api\/groups\/([^/]+)$/.exec(url.pathname);
  if (groupMatch && req.method === "DELETE") {
    const projectId = url.searchParams.get("project") || "default";
    const groupName = decodeURIComponent(groupMatch[1]);
    sendJson(res, 200, await store.deleteGroup(projectId, groupName));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/library-path") {
    const projectId = url.searchParams.get("project") || "default";
    sendJson(res, 200, {
      path: store.projectDir(projectId),
      codexGeneratedImagesDir: store.codexImagesDir,
      grokSessionsDir,
      storage: store.storageKind || "json",
      libraryDir: context.libraryDir,
      supportedMediaExtensions,
    });
    return true;
  }

  if (req.method !== "POST" || url.pathname !== "/api/open-folder") return false;

  const body = await readJson(req);
  const projects = await store.listProjects();
  const allowedPaths = [
    libraryDir,
    store.managerDir,
    store.codexImagesDir,
    grokSessionsDir,
    ...projects.map((projectId) => store.projectDir(projectId)),
  ].filter(Boolean);

  // Support both file and folder paths
  const requestedPath = body.path;
  const revealFile = body.reveal === true; // If true, reveal the file in Finder

  const resolvedPath = resolveAllowedFolderPath(requestedPath, allowedPaths);

  if (!resolvedPath) {
    sendJson(res, 403, { error: "Path not allowed" });
    return true;
  }

  let pathStat;
  try {
    pathStat = await stat(resolvedPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      sendJson(res, 404, { error: "Path does not exist" });
      return true;
    }
    throw error;
  }

  try {
    const { spawn } = await import("node:child_process");
    if (!pathStat.isDirectory() && !(revealFile && pathStat.isFile())) {
      sendJson(res, 400, { error: "Path is not a file or directory" });
      return true;
    }
    let command;
    let args;
    if (process.platform === "win32") {
      command = "explorer.exe";
      args = revealFile && pathStat.isFile() ? [`/select,${resolvedPath}`] : [resolvedPath];
    } else if (process.platform === "darwin") {
      command = "open";
      args = revealFile && pathStat.isFile() ? ["-R", resolvedPath] : [resolvedPath];
    } else {
      command = "xdg-open";
      args = [revealFile && pathStat.isFile() ? dirname(resolvedPath) : resolvedPath];
    }
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    await new Promise((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    child.unref();
    sendJson(res, 200, { ok: true });
  } catch (error) {
    console.error("Failed to open library path:", error);
    sendJson(res, 500, { error: "Unable to open this location." });
  }
  return true;
}
