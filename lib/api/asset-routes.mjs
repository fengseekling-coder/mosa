import { normalizeAssetSort } from "../asset-sort.js";
import { readJson, sendJson } from "../http-response.mjs";
import {
  ImportStagingError,
  importStagingDir,
  isWithinStagingRoot,
  MAX_STREAMED_IMPORT_BYTES,
  removeStagedImport,
  stageReadableForImport,
} from "../import-staging.mjs";

function decodedUploadFileName(value) {
  if (Array.isArray(value)) value = value[0];
  if (typeof value !== "string" || !value) return "";
  try {
    return decodeURIComponent(value).slice(0, 512);
  } catch {
    return "";
  }
}

function importStagingHttpError(error) {
  if (!(error instanceof ImportStagingError)) return null;
  if (error.code === "STAGING_FILE_TOO_LARGE") {
    return { status: 413, error: "Selected file is too large to import.", code: error.code };
  }
  if (error.code === "STAGING_UNSUPPORTED_TYPE") {
    return { status: 400, error: "Selected file type is not supported.", code: error.code };
  }
  if (error.code === "STAGING_FILE_EMPTY") {
    return { status: 400, error: "Selected file is empty.", code: error.code };
  }
  return { status: 400, error: "Selected file could not be prepared for import.", code: error.code };
}

async function readStableAssetSnapshot(store, projectId, loadPage) {
  if (typeof store.libraryRevision !== "function") return loadPage();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = String(await store.libraryRevision(projectId));
    const page = await loadPage();
    const after = String(await store.libraryRevision(projectId));
    if (before === after) return { ...page, revision: after };
  }
  return { ...(await loadPage()), revision: null };
}

export async function handleAssetRoute({ req, res, url, context }) {
  const { store, derivativeWorker, webCaptureIngest } = context;

  if (req.method === "POST" && url.pathname === "/api/import/stage") {
    const fileName = decodedUploadFileName(req.headers["x-mosa-file-name"]);
    const contentLength = Number(req.headers["content-length"] || 0);
    if (contentLength > MAX_STREAMED_IMPORT_BYTES) {
      sendJson(res, 413, { error: "Selected file is too large to import.", code: "STAGING_FILE_TOO_LARGE" });
      return true;
    }
    try {
      const stagingRoot = importStagingDir(store.assetsRoot);
      const path = await stageReadableForImport({ readable: req, fileName, stagingRoot });
      sendJson(res, 201, { path });
    } catch (error) {
      const mapped = importStagingHttpError(error);
      if (!mapped) throw error;
      sendJson(res, mapped.status, { error: mapped.error, code: mapped.code });
    }
    return true;
  }

  // Cleanup orphaned staged file on import modal cancel (P1-2)
  if (req.method === "DELETE" && url.pathname === "/api/import/stage") {
    const body = await readJson(req);
    const stagedPath = body?.path;
    if (!stagedPath || typeof stagedPath !== "string") {
      sendJson(res, 400, { error: "Missing or invalid staged path." });
      return true;
    }
    try {
      const stagingRoot = importStagingDir(store.assetsRoot);
      // Clean up both roots: server staging and Electron staging if available
      const electronStagingRoot = context.importStagingRoot;
      const stagingRoots = electronStagingRoot && electronStagingRoot !== stagingRoot
        ? [stagingRoot, electronStagingRoot]
        : [stagingRoot];
      for (const root of stagingRoots) {
        if (isWithinStagingRoot(root, stagedPath)) {
          const result = await removeStagedImport(root, stagedPath);
          // Log non-fatal failures but don't fail the request
          if (!result.ok && result.reason !== "already-removed") {
            console.warn(`[MOSA] staged file cleanup failed for ${stagedPath}: ${result.reason}${result.error ? ` (${result.error})` : ""}`);
          }
        }
      }
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 500, { error: "Failed to clean up staged file.", code: error?.code || "STAGING_CLEANUP_FAILED" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/asset-stacks") {
    if (typeof store.createAssetStack !== "function") throw new Error("Asset stacks are unavailable.");
    const body = await readJson(req);
    const stack = await store.createAssetStack(body.projectId || "default", body.assetIds, { coverAssetId: body.coverAssetId });
    sendJson(res, 201, { stack });
    return true;
  }

  const stackAssetsMatch = /^\/api\/asset-stacks\/([^/]+)\/assets$/.exec(url.pathname);
  const stackOrderMatch = /^\/api\/asset-stacks\/([^/]+)\/order$/.exec(url.pathname);
  const stackMatch = /^\/api\/asset-stacks\/([^/]+)$/.exec(url.pathname);
  if (stackAssetsMatch && req.method === "GET") {
    if (typeof store.listAssetStackAssets !== "function") throw new Error("Asset stacks are unavailable.");
    const stackId = decodeURIComponent(stackAssetsMatch[1]);
    const requestedLimit = Number(url.searchParams.get("limit"));
    const apiLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.floor(requestedLimit), 250)
      : 100;
    const filters = {
      query: url.searchParams.get("q") || "",
      group: url.searchParams.get("group") || "",
      category: url.searchParams.get("category") || "",
      style: url.searchParams.get("style") || "",
      source: url.searchParams.get("source") || "",
      conversation: url.searchParams.get("conversation") || "",
      generationBatch: url.searchParams.get("generationBatch") || "",
      favorite: url.searchParams.get("favorite") === "1",
      recent: url.searchParams.get("recent") === "1",
      unorganized: url.searchParams.get("unorganized") === "1",
      mediaKind: url.searchParams.get("mediaKind") === "img" || url.searchParams.get("mediaKind") === "video" ? url.searchParams.get("mediaKind") : "",
      sort: url.searchParams.get("sort") || "manual",
      limit: apiLimit,
      cursor: url.searchParams.get("cursor") || undefined,
      includeTotal: url.searchParams.get("includeTotal") !== "0",
    };
    const projectId = url.searchParams.get("project") || "default";
    sendJson(res, 200, await readStableAssetSnapshot(
      store,
      projectId,
      () => store.listAssetStackAssets(projectId, stackId, filters),
    ));
    return true;
  }
  if (stackAssetsMatch && req.method === "POST") {
    if (typeof store.addAssetsToStack !== "function") throw new Error("Asset stacks are unavailable.");
    const stackId = decodeURIComponent(stackAssetsMatch[1]);
    const body = await readJson(req);
    sendJson(res, 200, { stack: await store.addAssetsToStack(body.projectId || "default", stackId, body.assetIds) });
    return true;
  }
  if (stackAssetsMatch && req.method === "DELETE") {
    if (typeof store.removeAssetsFromStack !== "function") throw new Error("Asset stacks are unavailable.");
    const stackId = decodeURIComponent(stackAssetsMatch[1]);
    const body = await readJson(req);
    sendJson(res, 200, await store.removeAssetsFromStack(body.projectId || "default", stackId, body.assetIds));
    return true;
  }
  if (stackOrderMatch && req.method === "PATCH") {
    if (typeof store.reorderAssetStack !== "function") throw new Error("Asset stacks are unavailable.");
    const stackId = decodeURIComponent(stackOrderMatch[1]);
    const body = await readJson(req);
    sendJson(res, 200, { stack: await store.reorderAssetStack(body.projectId || "default", stackId, body.assetIds) });
    return true;
  }
  if (stackMatch && req.method === "GET") {
    if (typeof store.getAssetStack !== "function") throw new Error("Asset stacks are unavailable.");
    sendJson(res, 200, { stack: await store.getAssetStack(url.searchParams.get("project") || "default", decodeURIComponent(stackMatch[1])) });
    return true;
  }
  if (stackMatch && req.method === "DELETE") {
    if (typeof store.dissolveAssetStack !== "function") throw new Error("Asset stacks are unavailable.");
    const body = await readJson(req);
    sendJson(res, 200, await store.dissolveAssetStack(body.projectId || "default", decodeURIComponent(stackMatch[1])));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/assets") {
    const requestedLimit = Number(url.searchParams.get("limit"));
    const apiLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.floor(requestedLimit), 250)
      : 100;
    const filters = {
      projectId: url.searchParams.get("project") || "default",
      query: url.searchParams.get("q") || "",
      group: url.searchParams.get("group") || "",
      category: url.searchParams.get("category") || "",
      style: url.searchParams.get("style") || "",
      source: url.searchParams.get("source") || "",
      conversation: url.searchParams.get("conversation") || "",
      generationBatch: url.searchParams.get("generationBatch") || "",
      favorite: url.searchParams.get("favorite") === "1",
      recent: url.searchParams.get("recent") === "1",
      unorganized: url.searchParams.get("unorganized") === "1",
      trash: url.searchParams.get("trash") === "1",
      mediaKind: url.searchParams.get("mediaKind") === "img" || url.searchParams.get("mediaKind") === "video" ? url.searchParams.get("mediaKind") : "",
      sort: normalizeAssetSort(url.searchParams.get("sort")),
      limit: apiLimit,
      cursor: url.searchParams.get("cursor") || undefined,
      collapseStacks: url.searchParams.get("view") === "gallery",
      includeTotal: url.searchParams.get("includeTotal") !== "0",
    };
    const page = await readStableAssetSnapshot(store, filters.projectId, () => (
      typeof store.listAssetPage === "function"
        ? store.listAssetPage(filters)
        : store.listAssets(filters).then((assets) => ({ assets, page: { total: 0, nextCursor: null } }))
    ));
    sendJson(res, 200, page);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/ingest-suppressions") {
    if (typeof store.listAutomaticIngestSuppressionPage !== "function") throw new Error("Automatic ingest suppression is unavailable.");
    const projectId = url.searchParams.get("project") || "default";
    sendJson(res, 200, await store.listAutomaticIngestSuppressionPage(projectId, {
      limit: url.searchParams.get("limit") || undefined,
      cursor: url.searchParams.get("cursor") || undefined,
    }));
    return true;
  }

  if (req.method === "DELETE" && url.pathname === "/api/ingest-suppressions") {
    if (typeof store.clearAutomaticIngestSuppression !== "function") throw new Error("Automatic ingest suppression is unavailable.");
    const body = await readJson(req);
    const projectId = String(body?.projectId || body?.project_id || url.searchParams.get("project") || "default");
    const removed = await store.clearAutomaticIngestSuppression(projectId, {
      content_sha256: body?.content_sha256 || body?.contentSha256 || url.searchParams.get("content_sha256") || "",
      pixel_sha256: body?.pixel_sha256 || body?.pixelSha256 || url.searchParams.get("pixel_sha256") || "",
      pixel_hash_version: body?.pixel_hash_version || body?.pixelHashVersion || url.searchParams.get("pixel_hash_version") || "",
    });
    sendJson(res, 200, { removed });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/assets/create") {
    const body = await readJson(req);
    // BUG-01 fix: the desktop shell's import staging root is trusted for
    // creation via the runtime context; Web/server runs pass an empty array.
    const trustedSourceRoots = Array.isArray(context.trustedSourceRoots) ? context.trustedSourceRoots : [];
    const asset = await store.createAsset(body, { trustedSourceRoots, ingestMode: "manual" });
    sendJson(res, 200, { asset });
    derivativeWorker.wake();
    // The store has copied the bytes into the library, so either staging flavor
    // can be removed now. Browser uploads are staged below assetsRoot (already a
    // trusted store root); Electron may also provide its explicit staging root.
    // Only a path proven to be inside a staging root is ever considered.
    const stagingRoots = [importStagingDir(store.assetsRoot), context.importStagingRoot]
      .filter((root, index, roots) => root && roots.indexOf(root) === index);
    for (const stagingRoot of stagingRoots) {
      if (!isWithinStagingRoot(stagingRoot, body.imagePath)) continue;
      removeStagedImport(stagingRoot, body.imagePath).then((result) => {
        if (!result.ok && result.reason !== "no-op") {
          console.warn(`[MOSA] import-staging cleanup: ${result.reason}${result.error ? ` (${result.error})` : ""}`);
        }
      });
      break;
    }
    return true;
  }

  const assetMatch = /^\/api\/assets\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  const archiveMatch = /^\/api\/assets\/([^/]+)\/([^/]+)\/archive$/.exec(url.pathname);
  if (archiveMatch && req.method === "POST") {
    if (typeof store.archiveAsset !== "function") throw new Error("Asset archival is unavailable.");
    sendJson(res, 200, { asset: await store.archiveAsset(decodeURIComponent(archiveMatch[1]), decodeURIComponent(archiveMatch[2])) });
    return true;
  }

  const duplicateMatch = /^\/api\/assets\/([^/]+)\/([^/]+)\/duplicate$/.exec(url.pathname);
  if (duplicateMatch && req.method === "POST") {
    if (typeof store.duplicateAsset !== "function") throw new Error("Asset duplication is unavailable.");
    const body = await readJson(req);
    sendJson(res, 201, { asset: await store.duplicateAsset(decodeURIComponent(duplicateMatch[1]), decodeURIComponent(duplicateMatch[2]), body) });
    derivativeWorker.wake();
    return true;
  }

  const versionsMatch = /^\/api\/assets\/([^/]+)\/([^/]+)\/versions$/.exec(url.pathname);
  if (versionsMatch && req.method === "GET") {
    if (typeof store.getAssetVersionHistory !== "function") throw new Error("Asset version history is unavailable.");
    const projectId = decodeURIComponent(versionsMatch[1]);
    const assetId = decodeURIComponent(versionsMatch[2]);
    sendJson(res, 200, { history: await store.getAssetVersionHistory(projectId, assetId) });
    return true;
  }
  if (versionsMatch && req.method === "POST") {
    if (typeof store.createAssetVersion !== "function") throw new Error("Asset version creation is unavailable.");
    const projectId = decodeURIComponent(versionsMatch[1]);
    const assetId = decodeURIComponent(versionsMatch[2]);
    const body = await readJson(req);
    sendJson(res, 201, { asset: await store.createAssetVersion(projectId, assetId, body) });
    derivativeWorker.wake();
    return true;
  }

  const recipesMatch = /^\/api\/assets\/([^/]+)\/([^/]+)\/recipes$/.exec(url.pathname);
  if (recipesMatch && req.method === "GET") {
    if (typeof store.getRecipeSnapshotHistory !== "function") throw new Error("Recipe snapshot history is unavailable.");
    const projectId = decodeURIComponent(recipesMatch[1]);
    const assetId = decodeURIComponent(recipesMatch[2]);
    sendJson(res, 200, { history: await store.getRecipeSnapshotHistory(projectId, assetId) });
    return true;
  }

  if (assetMatch && req.method === "GET") {
    sendJson(res, 200, { asset: await store.getAsset(decodeURIComponent(assetMatch[1]), decodeURIComponent(assetMatch[2])) });
    return true;
  }

  if (assetMatch && req.method === "PATCH") {
    const body = await readJson(req);
    sendJson(res, 200, { asset: await store.updateMetadata(decodeURIComponent(assetMatch[1]), decodeURIComponent(assetMatch[2]), body) });
    return true;
  }

  if (assetMatch && req.method === "DELETE") {
    if (typeof store.deleteAsset !== "function") throw new Error("Asset deletion is unavailable.");
    const projectId = decodeURIComponent(assetMatch[1]);
    const assetId = decodeURIComponent(assetMatch[2]);
    const result = await store.deleteAsset(projectId, assetId);
    sendJson(res, 200, { result });
    return true;
  }

  const restoreMatch = /^\/api\/assets\/([^/]+)\/([^/]+)\/restore$/.exec(url.pathname);
  if (restoreMatch && req.method === "POST") {
    if (typeof store.restoreAsset !== "function") throw new Error("Trash restore is unavailable.");
    const projectId = decodeURIComponent(restoreMatch[1]);
    const assetId = decodeURIComponent(restoreMatch[2]);
    const asset = await store.restoreAsset(projectId, assetId);
    derivativeWorker?.wake?.();
    sendJson(res, 200, { asset });
    return true;
  }

  const permanentMatch = /^\/api\/assets\/([^/]+)\/([^/]+)\/permanent$/.exec(url.pathname);
  if (permanentMatch && req.method === "DELETE") {
    if (typeof store.permanentlyDeleteAsset !== "function") throw new Error("Permanent deletion is unavailable.");
    const projectId = decodeURIComponent(permanentMatch[1]);
    const assetId = decodeURIComponent(permanentMatch[2]);
    const result = await store.permanentlyDeleteAsset(projectId, assetId);
    if (typeof webCaptureIngest?.pruneReferences === "function") {
      try {
        const referencedIds = typeof store.listReferencedAttachmentIds === "function"
          ? await store.listReferencedAttachmentIds(projectId)
          : await referencedAttachmentIds(store, projectId);
        await webCaptureIngest.pruneReferences(projectId, referencedIds);
      } catch (error) {
        console.warn(`[MOSA] reference attachment cleanup failed: ${error?.message || error}`);
      }
    }
    sendJson(res, 200, { result });
    return true;
  }

  if (req.method === "DELETE" && url.pathname === "/api/trash") {
    if (typeof store.emptyTrash !== "function") throw new Error("Empty Trash is unavailable.");
    const body = await readJson(req);
    const projectId = body?.projectId || "default";
    const result = await store.emptyTrash(projectId);
    if (result.removed && typeof webCaptureIngest?.pruneReferences === "function") {
      try {
        const referencedIds = typeof store.listReferencedAttachmentIds === "function"
          ? await store.listReferencedAttachmentIds(projectId)
          : await referencedAttachmentIds(store, projectId);
        await webCaptureIngest.pruneReferences(projectId, referencedIds);
      } catch (error) {
        console.warn(`[MOSA] reference attachment cleanup failed: ${error?.message || error}`);
      }
    }
    sendJson(res, 200, result);
    return true;
  }

  const favoriteMatch = /^\/api\/assets\/([^/]+)\/([^/]+)\/favorite$/.exec(url.pathname);
  if (favoriteMatch && req.method === "POST") {
    if (typeof store.toggleFavorite !== "function") throw new Error("Favorite toggling is unavailable.");
    const projectId = decodeURIComponent(favoriteMatch[1]);
    const assetId = decodeURIComponent(favoriteMatch[2]);
    const updated = await store.toggleFavorite(projectId, assetId);
    sendJson(res, 200, { asset: updated });
    return true;
  }

  if (req.method !== "POST" || url.pathname !== "/api/assets/batch") return false;

  const body = await readJson(req);
  const { action, assetIds } = body;
  if (!["favorite", "archive", "trash"].includes(action)) {
    sendJson(res, 400, { error: `Unknown batch action: ${action}` });
    return true;
  }
  if (!Array.isArray(assetIds) || !assetIds.length || assetIds.some((assetId) => typeof assetId !== "string" || !assetId.trim())) {
    sendJson(res, 400, { error: "assetIds must be a non-empty array" });
    return true;
  }
  const projectId = body.projectId || "default";
  const uniqueAssetIds = [...new Set(assetIds)];
  // Resolve every asset before mutating one, so a malformed selection cannot
  // report a complete-looking batch after only its first few rows changed.
  const currentAssets = await Promise.all(uniqueAssetIds.map((assetId) => store.getAsset(projectId, assetId)));
  const favoriteValue = action === "favorite" && typeof body.favorite === "boolean" ? body.favorite : true;

  if (action === "trash") {
    // Versions must enter Trash from leaves toward their parents. Within each
    // independent depth we use bounded concurrency: one HTTP mutation stays
    // fast for large selections without creating an unbounded burst of file
    // hashing/I/O, and a parent is never checked while its selected child is
    // still active.
    const assetsById = new Map(currentAssets.map((asset) => [asset.id, asset]));
    const selectedIds = new Set(uniqueAssetIds);
    const depthCache = new Map();
    const depthOf = (assetId, visiting = new Set()) => {
      if (depthCache.has(assetId)) return depthCache.get(assetId);
      if (visiting.has(assetId)) return 0;
      const parentId = assetsById.get(assetId)?.parent_asset_id;
      if (!parentId || !selectedIds.has(parentId)) {
        depthCache.set(assetId, 0);
        return 0;
      }
      const nextVisiting = new Set(visiting);
      nextVisiting.add(assetId);
      const depth = depthOf(parentId, nextVisiting) + 1;
      depthCache.set(assetId, depth);
      return depth;
    };
    const idsByDepth = new Map();
    for (const assetId of uniqueAssetIds) {
      const depth = depthOf(assetId);
      if (!idsByDepth.has(depth)) idsByDepth.set(depth, []);
      idsByDepth.get(depth).push(assetId);
    }

    const resultById = new Map();
    let failures = 0;
    for (const depth of [...idsByDepth.keys()].sort((a, b) => b - a)) {
      const idsAtDepth = idsByDepth.get(depth);
      let nextIndex = 0;
      const worker = async () => {
        while (nextIndex < idsAtDepth.length) {
          const assetId = idsAtDepth[nextIndex];
          nextIndex += 1;
          try {
            const deleted = await store.deleteAsset(projectId, assetId);
            resultById.set(assetId, { id: assetId, trashed: true, deleted_at: deleted?.deleted_at || null });
          } catch (error) {
            failures += 1;
            resultById.set(assetId, { id: assetId, ok: false, code: error?.code || "BATCH_ITEM_FAILED", error: error instanceof Error ? error.message : String(error) });
          }
        }
      };
      const workerCount = Math.min(6, idsAtDepth.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
    }
    const results = uniqueAssetIds.map((assetId) => resultById.get(assetId));
    sendJson(res, failures ? 207 : 200, { results, partial: failures > 0 });
    return true;
  }

  const results = [];
  let failures = 0;
  for (let index = 0; index < uniqueAssetIds.length; index += 1) {
    const assetId = uniqueAssetIds[index];
    try {
      if (action === "favorite") {
        const current = currentAssets[index];
        const updated = Boolean(current.favorite) === favoriteValue
          ? current
          : await store.toggleFavorite(projectId, assetId);
        results.push({ id: assetId, favorite: Boolean(updated.favorite) });
      } else {
        await store.archiveAsset(projectId, assetId);
        results.push({ id: assetId, archived: true });
      }
    } catch (error) {
      failures += 1;
      results.push({ id: assetId, ok: false, code: error?.code || "BATCH_ITEM_FAILED", error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (action === "archive") derivativeWorker.wake();
  sendJson(res, failures ? 207 : 200, { results, partial: failures > 0 });
  return true;
}

async function referencedAttachmentIds(store, projectId) {
  const [active, archived, events] = await Promise.all([
    store.listAssets({ projectId }),
    store.listAssets({ projectId, archived: true }),
    typeof store.listGenerationEvents === "function" ? store.listGenerationEvents(projectId) : Promise.resolve([]),
  ]);
  const ids = new Set();
  for (const owner of [...active, ...archived, ...events]) {
    for (const reference of Array.isArray(owner?.references) ? owner.references : []) {
      const id = String(reference?.reference_id || reference?.asset_id || "").trim();
      if (id) ids.add(id);
    }
  }
  return ids;
}
