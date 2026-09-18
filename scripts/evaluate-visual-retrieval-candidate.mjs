#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadRetrievalAcceptanceFixture } from "./retrieval-baseline-lib.mjs";
import { evaluateVisualRetrievalCandidate } from "./visual-retrieval-candidate-lib.mjs";

const input = argumentValue("--input");
if (!input) {
  process.stderr.write("Usage: node scripts/evaluate-visual-retrieval-candidate.mjs --input /path/to/report.json\n");
  process.exitCode = 2;
} else {
  const report = JSON.parse(await readFile(resolve(input), "utf8"));
  const fixture = await loadRetrievalAcceptanceFixture();
  const evaluation = evaluateVisualRetrievalCandidate(report, fixture);
  process.stdout.write(JSON.stringify(evaluation, null, 2) + "\n");
  if (!evaluation.decision.eligible_for_next_stage) process.exitCode = 1;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}
