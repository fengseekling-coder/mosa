import { stat } from "node:fs/promises";
import { resolveAllowedFolderPath } from "../server-security.js";
import { readJson, sendJson } from "../http-response.mjs";

export async function handleLibraryRoute({ req, res, url, context }) {
  const { store, grokSessionsDir, supportedMediaExtensions, libraryDir } = context;

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
    // If reveal is true and path is a file, use -R flag to reveal in Finder
    // Otherwise just open the folder
    if (revealFile && pathStat.isFile()) {
      const child = spawn("open", ["-R", resolvedPath], { stdio: "ignore" });
      child.unref();
    } else if (pathStat.isDirectory()) {
      const child = spawn("open", [resolvedPath], { stdio: "ignore" });
      child.unref();
    } else {
      sendJson(res, 400, { error: "Path is not a file or directory" });
      return true;
    }
    sendJson(res, 200, { ok: true });
  } catch (error) {
    console.error("Failed to open Finder path:", error);
    sendJson(res, 500, { error: "Unable to open this location." });
  }
  return true;
}
