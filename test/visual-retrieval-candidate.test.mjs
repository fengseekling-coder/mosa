import assert from "node:assert/strict";
import test from "node:test";

import { loadRetrievalAcceptanceFixture } from "../scripts/retrieval-baseline-lib.mjs";
import {
  DEFAULT_VISUAL_RETRIEVAL_THRESHOLDS,
  evaluateVisualRetrievalCandidate,
} from "../scripts/visual-retrieval-candidate-lib.mjs";

function passingReport(visualQueries) {
  return {
    schema: "mosa.visual-retrieval-candidate/1",
    candidate: {
      id: "example-local-model",
      model_id: "example/model",
      license_id: "apache-2.0",
      license_source: "https://example.invalid/license",
      commercial_product_use: true,
      model_pack_bytes: 300 * 1024 * 1024,
      runtime_bytes: 80 * 1024 * 1024,
    },
    environment: { platform: "darwin", arch: "arm64", device: "test-device" },
    measurements: {
      cold_start_ms: 1800,
      warm_query_ms: [90, 110, 120, 130, 140],
      image_index_ms: [100, 120, 130, 140, 150],
      vector_search_ms: [30, 35, 40, 42, 45],
      peak_rss_mb: 900,
    },
    queries: visualQueries.map((query) => ({
      id: query.id,
      ranked_asset_ids: [query.expected_any[0], "other"],
    })),
  };
}

test("visual candidate gate accepts a licensed candidate that meets retrieval and local performance budgets", async () => {
  const fixture = await loadRetrievalAcceptanceFixture();
  const visualQueries = fixture.queries.filter((query) => query.tier === "visual");
  const evaluation = evaluateVisualRetrievalCandidate(passingReport(visualQueries), fixture);
  assert.equal(evaluation.metrics.hitAt1, 1);
  assert.equal(evaluation.metrics.hitAt5, 1);
  assert.equal(evaluation.decision.eligible_for_next_stage, true);
  assert.ok(evaluation.decision.warnings.some((warning) => /small synthetic gate/i.test(warning)));
});

test("visual candidate gate rejects research-only or oversized candidates before model quality can justify them", async () => {
  const fixture = await loadRetrievalAcceptanceFixture();
  const visualQueries = fixture.queries.filter((query) => query.tier === "visual");
  const report = passingReport(visualQueries);
  report.candidate.commercial_product_use = false;
  report.candidate.model_pack_bytes = DEFAULT_VISUAL_RETRIEVAL_THRESHOLDS.maxModelPackBytes + 1;
  const evaluation = evaluateVisualRetrievalCandidate(report, fixture);
  assert.equal(evaluation.decision.eligible_for_next_stage, false);
  assert.ok(evaluation.decision.failures.some((failure) => /license/i.test(failure)));
  assert.ok(evaluation.decision.failures.some((failure) => /size budget/i.test(failure)));
});

test("visual candidate gate reports ranking and latency failures separately", async () => {
  const fixture = await loadRetrievalAcceptanceFixture();
  const visualQueries = fixture.queries.filter((query) => query.tier === "visual");
  const report = passingReport(visualQueries);
  report.queries[0].ranked_asset_ids = ["wrong-1", "wrong-2", "wrong-3", "wrong-4", "wrong-5"];
  report.queries[1].ranked_asset_ids = ["wrong", report.queries[1].ranked_asset_ids[0]];
  report.measurements.warm_query_ms.push(DEFAULT_VISUAL_RETRIEVAL_THRESHOLDS.maxWarmQueryP95Ms + 100);
  const evaluation = evaluateVisualRetrievalCandidate(report, fixture);
  assert.ok(evaluation.metrics.hitAt1 < 1);
  assert.ok(evaluation.metrics.hitAt5 < 1);
  assert.ok(evaluation.decision.failures.some((failure) => /hit@5/i.test(failure)));
  assert.ok(evaluation.decision.failures.some((failure) => /warm query/i.test(failure)));
});
