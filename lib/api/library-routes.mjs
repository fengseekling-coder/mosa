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
    ...projects.map((projectId) => store.projectDir(projectId)),
  ].filter(Boolean);
  const folderPath = resolveAllowedFolderPath(body.path, allowedPaths);

  if (!folderPath) {
    sendJson(res, 403, { error: "Path not allowed" });
    return true;
  }

  let folderStat;
  try {
    folderStat = await stat(folderPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      sendJson(res, 404, { error: "Path does not exist" });
      return true;
    }
    throw error;
  }
  if (!folderStat.isDirectory()) {
    sendJson(res, 400, { error: "Path is not a directory" });
    return true;
  }

  try {
    const { spawn } = await import("node:child_process");
    const child = spawn("open", [folderPath], { stdio: "ignore" });
    child.unref();
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
  return true;
}
