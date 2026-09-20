import { buildVisualRelationshipCandidates } from "./visual-relationship-candidates.mjs";

export function createVisualRelationshipService({ index, model, assetStore, provider } = {}) {
  if (!index || typeof index.indexStatus !== "function" || typeof index.similarToAsset !== "function") {
    throw new Error("Visual relationship service requires a relationship index.");
  }
  const identity = normalizeModel(model);
  if (provider?.model) assertMatchingModel(provider.model, identity);
  return {
    model: Object.freeze({ ...identity }),
    status(projectId = "default") {
      return {
        available: true,
        capabilities: {
          image_similarity: true,
          relationship_candidates: Boolean(assetStore && typeof assetStore.getAsset === "function"),
          text_visual_search: Boolean(provider && typeof provider.encodeText === "function"),
        },
        index: index.indexStatus(projectId, identity),
      };
    },
    async similarAssets(projectId, assetId, options = {}) {
      const similar = index.similarToAsset(projectId, assetId, {
        ...identity,
        limit: options.limit,
        minScore: options.minScore,
        excludeAssetIds: options.excludeAssetIds,
      });
      return filterLiveAssets(projectId, similar);
    },
    async searchByText(projectId, query, options = {}) {
      if (!provider || typeof provider.encodeText !== "function") {
        throw new Error("Visual text search requires an image-text embedding provider.");
      }
      const vector = await provider.encodeText(query, { projectId });
      const similar = index.querySimilar(projectId, vector, {
        ...identity,
        limit: options.limit,
        minScore: options.minScore,
      });
      return filterLiveAssets(projectId, similar);
    },
    async relationshipCandidates(projectId, assetId, options = {}) {
      if (!assetStore || typeof assetStore.getAsset !== "function") {
        throw new Error("Visual relationship candidate generation requires an asset store.");
      }
      const anchor = await assetStore.getAsset(projectId, assetId);
      const similar = await this.similarAssets(projectId, assetId, {
        ...identity,
        limit: options.limit || 40,
        minScore: options.minScore,
      });
      const neighbors = await Promise.all(similar.map(async (item) => ({
        ...item,
        asset: await assetStore.getAsset(projectId, item.asset_id),
      })));
      return buildVisualRelationshipCandidates(anchor, neighbors, { thresholds: options.thresholds });
    },
    embeddingState(projectId, assetId, contentSha256 = "") {
      return index.embeddingState(projectId, assetId, { ...identity, contentSha256 });
    },
    recordEmbedding(projectId, assetId, { contentSha256 = "", vector } = {}) {
      return index.upsertEmbedding(projectId, assetId, { ...identity, contentSha256, vector });
    },
    removeAsset(projectId, assetId) {
      return index.deleteAsset(projectId, assetId);
    },
    clear(projectId = "default") {
      return index.clearModel(projectId, identity);
    },
    async close() {
      if (typeof provider?.close === "function") await provider.close();
    },
  };

  async function filterLiveAssets(projectId, similar) {
    if (!assetStore || typeof assetStore.getAsset !== "function") return similar;
    const alive = [];
    const staleIds = [];
    for (const item of similar) {
      try {
        await assetStore.getAsset(projectId, item.asset_id);
        alive.push(item);
      } catch (error) {
        if (error?.code === "ASSET_NOT_FOUND" || /not found/i.test(String(error?.message || error))) staleIds.push(item.asset_id);
        else throw error;
      }
    }
    if (staleIds.length && typeof index.pruneAssets === "function") index.pruneAssets(projectId, staleIds);
    return alive;
  }
}

function assertMatchingModel(candidate, expected) {
  const actual = normalizeModel(candidate);
  if (
    actual.id !== expected.id
    || actual.revision !== expected.revision
    || actual.dimension !== expected.dimension
  ) {
    throw new Error("Visual relationship provider model does not match the configured index model.");
  }
}

function normalizeModel(model = {}) {
  const id = String(model.id || model.modelId || "").trim();
  const revision = String(model.revision || model.modelRevision || "").trim();
  const dimension = Number(model.dimension);
  if (!id || !revision || !Number.isInteger(dimension) || dimension <= 0) {
    throw new Error("Visual relationship service requires model id, revision, and dimension.");
  }
  return { id, revision, dimension };
}
