import { basename } from "node:path";
import {
  chooseCowartInsertTarget,
  normalizeCowartInsertResult,
  resolveCowartInsertCanvas,
  verifyCowartInsert,
} from "../cowart-insert.js";
import { normalizeAssetSort } from "../asset-sort.js";
import { readJson, sendJson } from "../http-response.mjs";

export async function handleAssetRoute({ req, res, url, context }) {
  const { store, cowartBridge, cowartMcpClient, derivativeWorker } = context;

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
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/assets/create") {
    const body = await readJson(req);
    sendJson(res, 200, { asset: await store.createAsset(body) });
    derivativeWorker.wake();
    return true;
  }

  const insertMatch = /^\/api\/assets\/([^/]+)\/([^/]+)\/insert-cowart$/.exec(url.pathname);
  if (insertMatch && req.method === "POST") {
    const projectId = decodeURIComponent(insertMatch[1]);
    const assetId = decodeURIComponent(insertMatch[2]);
    const asset = await store.getAsset(projectId, assetId);
    if (!cowartMcpClient.status().available) {
      sendJson(res, 503, { error: "Cowart MCP server is unavailable." });
      return true;
    }
    const body = await readJson(req);
    const placement = ["right", "left", "below"].includes(body.placement) ? body.placement : "right";
    const targetCanvas = resolveCowartInsertCanvas(cowartBridge.sources(), body.targetId);
    if (!targetCanvas) {
      sendJson(res, 400, { error: "Cowart insertion target is not registered." });
      return true;
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
