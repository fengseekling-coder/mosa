export const DEFAULT_VISUAL_RELATIONSHIP_THRESHOLDS = Object.freeze({
  nearDuplicate: 0.985,
  versionCandidate: 0.94,
  stackCandidate: 0.9,
});

export function buildVisualRelationshipCandidates(anchor, neighbors, options = {}) {
  const thresholds = normalizeThresholds(options.thresholds);
  const anchorId = String(anchor?.id || "").trim();
  if (!anchorId) throw new Error("Visual relationship candidates require an anchor asset id.");
  const anchorParent = String(anchor?.parent_asset_id || "").trim();
  const anchorChildren = new Set((anchor?.child_asset_ids || []).map((id) => String(id || "").trim()).filter(Boolean));

  return (Array.isArray(neighbors) ? neighbors : []).map((neighbor) => {
    const asset = neighbor?.asset || {};
    const assetId = String(asset.id || neighbor?.asset_id || "").trim();
    const score = Number(neighbor?.score);
    if (!assetId || assetId === anchorId || !Number.isFinite(score)) return null;
    const candidateParent = String(asset.parent_asset_id || "").trim();
    const directVersion = assetId === anchorParent
      || anchorChildren.has(assetId)
      || candidateParent === anchorId
      || (Boolean(anchorParent) && candidateParent === anchorParent);
    const kinds = [];
    if (score >= thresholds.nearDuplicate) kinds.push("near_duplicate_candidate");
    if (!directVersion && score >= thresholds.versionCandidate) kinds.push("version_candidate");
    if (score >= thresholds.stackCandidate) kinds.push("stack_candidate");
    if (!kinds.length) kinds.push("visual_neighbor");
    return {
      asset_id: assetId,
      score: Number(score.toFixed(6)),
      kinds,
      evidence: {
        source: "visual_embedding_similarity",
        thresholds,
        existing_direct_version_relation: directVersion,
      },
    };
  }).filter(Boolean);
}

function normalizeThresholds(input = {}) {
  const thresholds = {
    nearDuplicate: finiteScore(input.nearDuplicate, DEFAULT_VISUAL_RELATIONSHIP_THRESHOLDS.nearDuplicate),
    versionCandidate: finiteScore(input.versionCandidate, DEFAULT_VISUAL_RELATIONSHIP_THRESHOLDS.versionCandidate),
    stackCandidate: finiteScore(input.stackCandidate, DEFAULT_VISUAL_RELATIONSHIP_THRESHOLDS.stackCandidate),
  };
  if (!(thresholds.nearDuplicate >= thresholds.versionCandidate && thresholds.versionCandidate >= thresholds.stackCandidate)) {
    throw new Error("Visual relationship thresholds must satisfy nearDuplicate >= versionCandidate >= stackCandidate.");
  }
  return thresholds;
}

function finiteScore(value, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < -1 || number > 1) {
    throw new Error("Visual relationship thresholds must be finite scores between -1 and 1.");
  }
  return number;
}
