import assert from "node:assert/strict";
import test from "node:test";

import { normalizeEmbedding, topKNormalizedEmbeddings } from "../lib/embedding-search.mjs";

test("exact normalized embedding search returns deterministic top-k ordering", () => {
  const matrix = new Float32Array([
    1, 0,
    0, 1,
    0.8, 0.6,
    -1, 0,
  ]);
  for (let row = 0; row < 4; row += 1) {
    normalizeEmbedding(matrix.subarray(row * 2, row * 2 + 2));
  }
  const query = normalizeEmbedding(new Float32Array([1, 0.1]));
  const result = topKNormalizedEmbeddings(matrix, 2, query, 3);
  assert.deepEqual(result.map((item) => item.index), [0, 2, 1]);
  assert.ok(result[0].score > result[1].score);
  assert.ok(result[1].score > result[2].score);
});

test("embedding search validates dimensions and caps k to available rows", () => {
  assert.throws(() => topKNormalizedEmbeddings(new Float32Array(3), 2, new Float32Array(2)), /divisible/);
  const result = topKNormalizedEmbeddings(new Float32Array([1, 0, 0, 1]), 2, new Float32Array([1, 0]), 10);
  assert.equal(result.length, 2);
});
