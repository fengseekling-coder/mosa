import { sendJson } from "../http-response.mjs";

const SIMILAR_ASSET_RE = /^\/api\/visual\/assets\/([^/]+)\/similar$/;
const CANDIDATE_ASSET_RE = /^\/api\/visual\/assets\/([^/]+)\/candidates$/;

export async function handleVisualRoute({ req, res, url, context }) {
  if (!url.pathname.startsWith("/api/visual/")) return false;
  const service = context.visualRelationshipService;
  const projectId = url.searchParams.get("project") || "default";

  if (req.method === "GET" && url.pathname === "/api/visual/status") {
    if (!service) {
      sendJson(res, 200, { visual: { available: false, reason: "model-not-configured" } });
      return true;
    }
    sendJson(res, 200, { visual: await service.status(projectId) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/visual/search") {
    if (!service || typeof service.searchByText !== "function") {
      sendJson(res, 409, {
        error: "Local visual text search is not enabled.",
        code: "VISUAL_TEXT_SEARCH_UNAVAILABLE",
      });
      return true;
    }
    const query = visualQuery(url.searchParams.get("q"));
    const limit = positiveInteger(url.searchParams.get("limit"), 20, 100);
    const minScore = optionalScore(url.searchParams.get("minScore"));
    try {
      const results = await service.searchByText(projectId, query, { limit, minScore });
      sendJson(res, 200, {
        query,
        project_id: projectId,
        model: service.model,
        results,
      });
    } catch (error) {
      if (/requires an image-text embedding provider/i.test(String(error?.message || error))) {
        sendJson(res, 409, {
          error: "Local visual text search is not enabled.",
          code: "VISUAL_TEXT_SEARCH_UNAVAILABLE",
        });
      } else {
        throw error;
      }
    }
    return true;
  }

  const similarMatch = SIMILAR_ASSET_RE.exec(url.pathname);
  if (req.method === "GET" && similarMatch) {
    if (!service) {
      sendJson(res, 409, {
        error: "Local visual relationships are not enabled.",
        code: "VISUAL_RELATIONSHIPS_UNAVAILABLE",
      });
      return true;
    }
    const assetId = decodeURIComponent(similarMatch[1]);
    const limit = positiveInteger(url.searchParams.get("limit"), 20, 100);
    const minScore = optionalScore(url.searchParams.get("minScore"));
    const similar = await service.similarAssets(projectId, assetId, { limit, minScore });
    sendJson(res, 200, { asset_id: assetId, project_id: projectId, model: service.model, similar });
    return true;
  }

  const candidateMatch = CANDIDATE_ASSET_RE.exec(url.pathname);
  if (req.method === "GET" && candidateMatch) {
    if (!service || typeof service.relationshipCandidates !== "function") {
      sendJson(res, 409, {
        error: "Local visual relationship candidates are not enabled.",
        code: "VISUAL_RELATIONSHIP_CANDIDATES_UNAVAILABLE",
      });
      return true;
    }
    const assetId = decodeURIComponent(candidateMatch[1]);
    const limit = positiveInteger(url.searchParams.get("limit"), 40, 100);
    const minScore = optionalScore(url.searchParams.get("minScore"));
    const candidates = await service.relationshipCandidates(projectId, assetId, { limit, minScore });
    sendJson(res, 200, {
      asset_id: assetId,
      project_id: projectId,
      model: service.model,
      candidates,
    });
    return true;
  }

  if (req.method === "DELETE" && url.pathname === "/api/visual/index") {
    if (!service) {
      sendJson(res, 409, {
        error: "Local visual relationships are not enabled.",
        code: "VISUAL_RELATIONSHIPS_UNAVAILABLE",
      });
      return true;
    }
    const removed = await service.clear(projectId);
    sendJson(res, 200, { ok: true, project_id: projectId, removed });
    return true;
  }

  return false;
}

function positiveInteger(value, fallback, max) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    const error = new Error("Visual similarity limit must be a positive integer.");
    error.statusCode = 400;
    error.code = "VISUAL_LIMIT_INVALID";
    error.expose = true;
    throw error;
  }
  return Math.min(max, number);
}

function optionalScore(value) {
  if (value == null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < -1 || number > 1) {
    const error = new Error("Visual similarity minScore must be between -1 and 1.");
    error.statusCode = 400;
    error.code = "VISUAL_SCORE_INVALID";
    error.expose = true;
    throw error;
  }
  return number;
}

function visualQuery(value) {
  const query = String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!query) {
    const error = new Error("Visual search query is required.");
    error.statusCode = 400;
    error.code = "VISUAL_QUERY_REQUIRED";
    error.expose = true;
    throw error;
  }
  if (query.length > 2000) {
    const error = new Error("Visual search query exceeds the 2000-character limit.");
    error.statusCode = 400;
    error.code = "VISUAL_QUERY_TOO_LONG";
    error.expose = true;
    throw error;
  }
  return query;
}
