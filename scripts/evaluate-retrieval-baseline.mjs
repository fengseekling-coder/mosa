#!/usr/bin/env node

import { evaluateRetrievalFixture, loadRetrievalAcceptanceFixture } from "./retrieval-baseline-lib.mjs";

const json = process.argv.includes("--json");
const enforce = process.argv.includes("--enforce");
const fixture = await loadRetrievalAcceptanceFixture();
const report = await evaluateRetrievalFixture(fixture);

if (json) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  process.stdout.write("MOSA retrieval baseline\n\n");
  for (const [tier, metrics] of Object.entries(report.tiers)) {
    process.stdout.write(
      tier.padEnd(15)
        + " hit@1=" + percent(metrics.hitAt1)
        + " hit@5=" + percent(metrics.hitAt5)
        + " MRR=" + metrics.mrr.toFixed(2)
        + " n=" + metrics.total
        + "\n",
    );
  }
  process.stdout.write("\n");
  for (const item of report.cases) {
    const status = item.rank == null ? "MISS" : "#" + item.rank;
    process.stdout.write(status.padEnd(5) + " [" + item.tier + "] " + item.query + " -> " + item.expected_any.join(" | ") + "\n");
  }
}

if (enforce) {
  const failures = report.enforced.filter((item) => item.rank == null || item.rank > 5);
  if (failures.length) {
    process.stderr.write("\n" + failures.length + " enforced retrieval case(s) missed top 5.\n");
    process.exitCode = 1;
  }
}

function percent(value) {
  return (Number(value || 0) * 100).toFixed(0) + "%";
}
