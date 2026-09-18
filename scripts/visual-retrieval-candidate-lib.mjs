export const VISUAL_RETRIEVAL_CANDIDATE_SCHEMA = "mosa.visual-retrieval-candidate/1";

export const DEFAULT_VISUAL_RETRIEVAL_THRESHOLDS = Object.freeze({
  maxModelPackBytes: 512 * 1024 * 1024,
  maxRuntimeBytes: 256 * 1024 * 1024,
  maxPeakRssMb: 1536,
  maxColdStartMs: 8000,
  maxWarmQueryP95Ms: 250,
  maxImageIndexP95Ms: 250,
  maxVectorSearchP95Ms: 60,
  minVisualHitAt1: 0.75,
  minVisualHitAt5: 1,
});

export function evaluateVisualRetrievalCandidate(report, fixture, thresholds = DEFAULT_VISUAL_RETRIEVAL_THRESHOLDS) {
  validateReport(report);
  validateFixture(fixture);
  const visualQueries = fixture.queries.filter((query) => query.tier === "visual");
  if (!visualQueries.length) throw new Error("Visual retrieval fixture has no visual queries.");
  const resultById = new Map(report.queries.map((query) => [query.id, query]));
  const cases = visualQueries.map((query) => {
    const result = resultById.get(query.id);
    const rankedAssetIds = Array.isArray(result?.ranked_asset_ids) ? result.ranked_asset_ids.map(String) : [];
    const rankIndex = rankedAssetIds.findIndex((id) => query.expected_any.includes(id));
    return {
      id: query.id,
      query: query.query,
      expected_any: query.expected_any,
      rank: rankIndex >= 0 ? rankIndex + 1 : null,
      ranked_asset_ids: rankedAssetIds,
    };
  });
  const hitAt1 = cases.filter((item) => item.rank === 1).length / cases.length;
  const hitAt5 = cases.filter((item) => item.rank != null && item.rank <= 5).length / cases.length;
  const mrr = cases.reduce((sum, item) => sum + (item.rank ? 1 / item.rank : 0), 0) / cases.length;

  const measurements = {
    cold_start_ms: finiteNumber(report.measurements.cold_start_ms),
    warm_query_p95_ms: percentile(report.measurements.warm_query_ms),
    image_index_p95_ms: percentile(report.measurements.image_index_ms),
    vector_search_p95_ms: percentile(report.measurements.vector_search_ms),
    peak_rss_mb: finiteNumber(report.measurements.peak_rss_mb),
  };

  const failures = [];
  const warnings = [];
  if (report.candidate.commercial_product_use !== true) failures.push("candidate license is not confirmed for product/commercial use");
  if (!String(report.candidate.license_id || "").trim()) failures.push("candidate license identifier is missing");
  if (!String(report.candidate.license_source || "").trim()) failures.push("candidate license source is missing");
  if (finiteNumber(report.candidate.model_pack_bytes) > thresholds.maxModelPackBytes) failures.push("model pack exceeds size budget");
  if (finiteNumber(report.candidate.runtime_bytes) > thresholds.maxRuntimeBytes) failures.push("runtime exceeds size budget");
  if (measurements.peak_rss_mb > thresholds.maxPeakRssMb) failures.push("peak RSS exceeds memory budget");
  if (measurements.cold_start_ms > thresholds.maxColdStartMs) failures.push("cold start exceeds budget");
  if (measurements.warm_query_p95_ms > thresholds.maxWarmQueryP95Ms) failures.push("warm query P95 exceeds budget");
  if (measurements.image_index_p95_ms > thresholds.maxImageIndexP95Ms) failures.push("image indexing P95 exceeds budget");
  if (measurements.vector_search_p95_ms > thresholds.maxVectorSearchP95Ms) failures.push("vector search P95 exceeds budget");
  if (hitAt1 < thresholds.minVisualHitAt1) failures.push("visual hit@1 is below acceptance threshold");
  if (hitAt5 < thresholds.minVisualHitAt5) failures.push("visual hit@5 is below acceptance threshold");

  if (cases.length < 20) warnings.push("visual fixture is still a small synthetic gate; passing it is not sufficient for release");
  if (!String(report.environment?.device || "").trim()) warnings.push("benchmark device is not recorded");

  return {
    schema: VISUAL_RETRIEVAL_CANDIDATE_SCHEMA,
    candidate: report.candidate,
    metrics: { total: cases.length, hitAt1, hitAt5, mrr },
    measurements,
    thresholds,
    cases,
    decision: {
      eligible_for_next_stage: failures.length === 0,
      failures,
      warnings,
    },
  };
}

export function percentile(values, fraction = 0.95) {
  const numbers = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!numbers.length) return Number.POSITIVE_INFINITY;
  const index = Math.min(numbers.length - 1, Math.max(0, Math.ceil(numbers.length * fraction) - 1));
  return Number(numbers[index].toFixed(3));
}

function validateReport(report) {
  if (!report || report.schema !== VISUAL_RETRIEVAL_CANDIDATE_SCHEMA) throw new Error("Unsupported visual retrieval candidate report.");
  if (!report.candidate || !String(report.candidate.id || "").trim()) throw new Error("Candidate id is required.");
  if (!Array.isArray(report.queries)) throw new Error("Candidate queries must be an array.");
  if (!report.measurements || typeof report.measurements !== "object") throw new Error("Candidate measurements are required.");
  for (const key of ["model_pack_bytes", "runtime_bytes"]) {
    const value = finiteNumber(report.candidate[key]);
    if (!(value >= 0)) throw new Error("Candidate " + key + " must be a non-negative finite number.");
  }
  for (const key of ["cold_start_ms", "peak_rss_mb"]) {
    const value = finiteNumber(report.measurements[key]);
    if (!(value >= 0)) throw new Error("Measurement " + key + " must be a non-negative finite number.");
  }
  for (const key of ["warm_query_ms", "image_index_ms", "vector_search_ms"]) {
    if (!Array.isArray(report.measurements[key]) || !report.measurements[key].length) {
      throw new Error("Measurement " + key + " must contain samples.");
    }
  }
}

function validateFixture(fixture) {
  if (!fixture || fixture.schema !== "mosa.retrieval-acceptance/1" || !Array.isArray(fixture.queries)) {
    throw new Error("Unsupported retrieval acceptance fixture.");
  }
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.POSITIVE_INFINITY;
}
