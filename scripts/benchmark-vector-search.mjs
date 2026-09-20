#!/usr/bin/env node

import { performance } from "node:perf_hooks";

import { normalizeEmbedding, topKNormalizedEmbeddings } from "../lib/embedding-search.mjs";

const assetCount = positiveInteger(process.env.MOSA_VECTOR_BENCH_ASSETS, 50_000);
const dimension = positiveInteger(process.env.MOSA_VECTOR_BENCH_DIMENSION, 512);
const measuredRuns = positiveInteger(process.env.MOSA_VECTOR_BENCH_RUNS, 12);
const warmupRuns = 3;
const topK = 20;

const matrix = new Float32Array(assetCount * dimension);
let state = 0x9e3779b9;
for (let row = 0; row < assetCount; row += 1) {
  let sumSquares = 0;
  const offset = row * dimension;
  for (let col = 0; col < dimension; col += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const value = (state / 0xffffffff) * 2 - 1;
    matrix[offset + col] = value;
    sumSquares += value * value;
  }
  const scale = 1 / Math.sqrt(sumSquares);
  for (let col = 0; col < dimension; col += 1) matrix[offset + col] *= scale;
}

const timings = [];
for (let run = 0; run < warmupRuns + measuredRuns; run += 1) {
  const query = new Float32Array(dimension);
  const sourceRow = (run * 7919) % assetCount;
  const sourceOffset = sourceRow * dimension;
  for (let col = 0; col < dimension; col += 1) query[col] = matrix[sourceOffset + col] + ((col % 7) - 3) * 0.0001;
  normalizeEmbedding(query);
  const started = performance.now();
  const result = topKNormalizedEmbeddings(matrix, dimension, query, topK);
  const elapsed = performance.now() - started;
  if (run >= warmupRuns) timings.push(elapsed);
  if (result[0]?.index !== sourceRow) throw new Error("Vector search benchmark failed to recover the source vector.");
}

const sorted = [...timings].sort((a, b) => a - b);
const report = {
  schema: "mosa.vector-search-benchmark/1",
  assets: assetCount,
  dimension,
  top_k: topK,
  embedding_bytes: matrix.byteLength,
  runs: measuredRuns,
  p50_ms: percentile(sorted, 0.5),
  p95_ms: percentile(sorted, 0.95),
  max_ms: sorted.at(-1) || 0,
};
process.stdout.write(JSON.stringify(report, null, 2) + "\n");

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return Number(sorted[index].toFixed(3));
}
