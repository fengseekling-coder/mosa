import assert from "node:assert/strict";
import test from "node:test";

import { evaluateRetrievalFixture, loadRetrievalAcceptanceFixture } from "../scripts/retrieval-baseline-lib.mjs";

test("retrieval acceptance fixture keeps explicit lexical anchors in the top five", async () => {
  const fixture = await loadRetrievalAcceptanceFixture();
  const report = await evaluateRetrievalFixture(fixture);
  const enforced = report.enforced;
  assert.ok(enforced.length >= 5, "the acceptance set should guard several independent lexical intents");
  for (const item of enforced) {
    assert.ok(
      item.rank != null && item.rank <= 5,
      item.id + " expected one of [" + item.expected_any.join(", ") + "] in top five; got [" + item.result_ids.join(", ") + "]",
    );
  }
  assert.equal(report.tiers.lexical.hitAt5, 1);
});

test("retrieval acceptance set keeps semantic probes diagnostic rather than pretending lexical search is semantic", async () => {
  const fixture = await loadRetrievalAcceptanceFixture();
  const diagnostic = fixture.queries.filter((item) => !item.enforce);
  assert.ok(diagnostic.some((item) => item.tier === "conversational"));
  assert.ok(diagnostic.some((item) => item.tier === "semantic"));
  assert.ok(diagnostic.some((item) => item.tier === "visual"));
});
