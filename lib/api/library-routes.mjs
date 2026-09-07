import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeAssetSort } from "../asset-sort.js";
import { resolveAllowedFolderPath } from "../server-security.js";
import { readJson, sendJson } from "../http-response.mjs";

export function buildRevealSpawnPlan({ platform = process.platform, revealFile, isFile, resolvedPath }) {
  if (platform === "win32") {
    if (revealFile && isFile) {
      // Explorer requires the quote pair around the path portion specifically:
      //   /select,"C:\\path with spaces\\file.png"
      // With Node's default Windows argument quoting, a spaced path would turn
      // the entire argument into "/select,C:\\...", which Explorer silently
      // misparses and may fall back to Documents. Keep the exact Explorer
      // command-line grammar and disable Node's additional Windows escaping for
      // this already-quoted single argument. shell remains disabled by caller.
      return {
        command: "explorer.exe",
        args: [`/select,"${resolvedPath}"`],
        options: { windowsVerbatimArguments: true },
      };
    }
    return { command: "explorer.exe", args: [resolvedPath], options: {} };
  }
  if (platform === "darwin") {
    return {
      command: "open",
      args: revealFile && isFile ? ["-R", resolvedPath] : [resolvedPath],
      options: {},
    };
  }
  return {
    command: "xdg-open",
    args: [revealFile && isFile ? dirname(resolvedPath) : resolvedPath],
    options: {},
  };
}

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

  if (req.method === "GET" && url.pathname === "/api/navigation") {
    const projectId = url.searchParams.get("project") || "default";
    const navigation = typeof store.listNavigationStats === "function"
      ? await store.listNavigationStats(projectId)
      : await store.listGroups(projectId);
    sendJson(res, 200, { navigation });
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

  // Authoritative revision-delta feed. Clients replay the journaled changes
  // between their applied baseline and the current revision; `complete: false`
  // means the requested baseline has already been pruned and only a full
  // reconciliation can recover the gap.
  if (req.method === "GET" && url.pathname === "/api/library-changes") {
    if (typeof store.listLibraryChangesSince !== "function") {
      sendJson(res, 503, { error: "Library change journal unavailable" });
      return true;
    }
    const projectId = url.searchParams.get("project") || "default";
    const since = Number.parseInt(url.searchParams.get("since") ?? "", 10);
    const delta = await store.listLibraryChangesSince(projectId, Number.isFinite(since) ? since : null);
    // revisionToken mirrors /api/library-revision so clients can keep a full
    // revision token as their baseline while using the integer counter as the
    // delta cursor.
    const revisionToken = typeof store.libraryRevision === "function" ? await store.libraryRevision(projectId) : null;
    sendJson(res, 200, { project: projectId, revisionToken, ...delta });
    return true;
  }

  // Incremental reconciliation fetch: view rows for a bounded set of affected
  // asset ids under the caller's current gallery request semantics. Bounded by
  // the affected id count, never by the library size.
  if (req.method === "POST" && url.pathname === "/api/gallery-rows") {
    if (typeof store.listGalleryRowsForAssets !== "function") {
      sendJson(res, 503, { error: "Gallery row reconciliation unavailable" });
      return true;
    }
    const body = await readJson(req);
    const assetIds = Array.isArray(body?.assetIds) ? body.assetIds.filter((assetId) => typeof assetId === "string" && assetId.trim()) : [];
    if (!assetIds.length) {
      sendJson(res, 400, { error: "assetIds must be a non-empty array" });
      return true;
    }
    if (assetIds.length > 1000) {
      sendJson(res, 413, { error: "Too many assetIds in one request; chunk the reconciliation." });
      return true;
    }
    const request = body?.request && typeof body.request === "object" ? body.request : {};
    const scope = String(request.scope || "all");
    const filters = {
      projectId: body?.projectId || body?.project || request.project || "default",
      query: String(request.query || ""),
      group: String(request.facets?.group || ""),
      category: String(request.facets?.category || ""),
      style: String(request.facets?.style || ""),
      source: String(request.facets?.source || ""),
      conversation: String(request.facets?.conversation || ""),
      generationBatch: String(request.facets?.generationBatch || ""),
      favorite: scope === "favorite",
      unorganized: scope === "unorganized",
      trash: scope === "trash",
      mediaKind: request.mediaKind === "img" || request.mediaKind === "video" ? request.mediaKind : "",
      sort: normalizeAssetSort(request.sort),
      stackId: request.stackId ? String(request.stackId) : undefined,
      collapseStacks: request.view === "gallery" && scope !== "trash",
      boundaryCursor: request.boundaryCursor ? String(request.boundaryCursor) : undefined,
    };
    const result = await store.listGalleryRowsForAssets(filters, assetIds);
    sendJson(res, 200, result);
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
  if (groupMatch && req.method === "PATCH") {
    const body = await readJson(req);
    const projectId = body.projectId || url.searchParams.get("project") || "default";
    const groupName = decodeURIComponent(groupMatch[1]);
    sendJson(res, 200, {
      group: await store.renameGroup(projectId, groupName, body.name),
    });
    return true;
  }
  if (groupMatch && req.method === "DELETE") {
    const projectId = url.searchParams.get("project") || "default";
    const groupName = decodeURIComponent(groupMatch[1]);
    const deleteAssets = url.searchParams.get("deleteAssets") === "true";
    sendJson(res, 200, await store.deleteGroup(projectId, groupName, { deleteAssets }));
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
    const plan = buildRevealSpawnPlan({
      platform: context.platform || process.platform,
      revealFile,
      isFile: pathStat.isFile(),
      resolvedPath,
    });
    const spawnImpl = context.spawnImpl || spawn;
    const child = spawnImpl(plan.command, plan.args, {
      stdio: "ignore",
      windowsHide: true,
      shell: false,
      ...plan.options,
    });
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
