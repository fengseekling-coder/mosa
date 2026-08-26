import { normalizeAssetSort } from "../asset-sort.js";
import { readJson, sendJson } from "../http-response.mjs";
import { removeStagedImport } from "../import-staging.mjs";

export async function handleAssetRoute({ req, res, url, context }) {
  const { store, derivativeWorker } = context;

  if (req.method === "GET" && url.pathname === "/api/assets") {
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
      mediaKind: url.searchParams.get("mediaKind") === "img" || url.searchParams.get("mediaKind") === "video" ? url.searchParams.get("mediaKind") : "",
      sort: normalizeAssetSort(url.searchParams.get("sort")),
      limit: url.searchParams.get("limit") || undefined,
      cursor: url.searchParams.get("cursor") || undefined,
    };
    const page = typeof store.listAssetPage === "function"
      ? await store.listAssetPage(filters)
      : { assets: await store.listAssets(filters), page: { total: 0, nextCursor: null } };
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
    // The store has copied the bytes into the library, so the staged copy can
    // be removed now. A failed cleanup must never fail a successful import;
    // it is logged by the helper result and swept later by the startup TTL.
    if (context.importStagingRoot) {
      removeStagedImport(context.importStagingRoot, body.imagePath).then((result) => {
        if (!result.ok && result.reason !== "no-op") {
          console.warn(`[MOSA] import-staging cleanup: ${result.reason}${result.error ? ` (${result.error})` : ""}`);
        }
      });
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
    sendJson(res, 200, { result: await store.deleteAsset(projectId, assetId) });
    return true;
  }

  const favoriteMatch = /^\/api\/assets\/([^/]+)\/([^/]+)\/favorite$/.exec(url.pathname);
  if (favoriteMatch && req.method === "POST") {
    const projectId = decodeURIComponent(favoriteMatch[1]);
    const assetId = decodeURIComponent(favoriteMatch[2]);
    const current = await store.getAsset(projectId, assetId);
    const updated = await store.updateMetadata(projectId, assetId, { favorite: !current.favorite });
    sendJson(res, 200, { asset: updated });
    return true;
  }

  if (req.method !== "POST" || url.pathname !== "/api/assets/batch") return false;

  const body = await readJson(req);
  const { action, assetIds } = body;
  if (!["favorite", "archive"].includes(action)) {
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
  await Promise.all(uniqueAssetIds.map((assetId) => store.getAsset(projectId, assetId)));
  const results = [];
  for (const assetId of uniqueAssetIds) {
    if (action === "favorite") {
      const updated = await store.updateMetadata(projectId, assetId, { favorite: true });
      results.push({ id: assetId, favorite: updated.favorite });
    } else {
      await store.archiveAsset(projectId, assetId);
      results.push({ id: assetId, archived: true });
    }
  }
  if (action === "archive") derivativeWorker.wake();
  sendJson(res, 200, { results });
  return true;
}
