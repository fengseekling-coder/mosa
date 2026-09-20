import assert from "node:assert/strict";
import test from "node:test";

import { createVisualEmbeddingWorker } from "../lib/visual-embedding-worker.mjs";

test("visual embedding worker incrementally indexes missing assets and skips current embeddings", async () => {
  const recorded = [];
  const states = new Map([["current", "current"]]);
  let listed = 0;
  const worker = createVisualEmbeddingWorker({
    provider: {
      async encodeImage(path) {
        return path.endsWith("missing.png") ? [1, 0] : [0, 1];
      },
    },
    relationshipService: {
      embeddingState(_projectId, assetId) { return { state: states.get(assetId) || "missing" }; },
      recordEmbedding(_projectId, assetId, value) { recorded.push([assetId, value.vector]); states.set(assetId, "current"); },
    },
    async listCandidates() {
      listed += 1;
      if (listed > 1) return [];
      return [
        { assetId: "current", imagePath: "/tmp/current.png", contentSha256: "a".repeat(64) },
        { assetId: "missing", imagePath: "/tmp/missing.png", contentSha256: "b".repeat(64) },
      ];
    },
  });
  await worker.start();
  assert.deepEqual(recorded, [["missing", [1, 0]]]);
  assert.deepEqual(worker.status(), {
    state: "idle",
    processed: 2,
    indexed: 1,
    skipped: 1,
    failed: 0,
    last_error: "",
  });
});

test("visual embedding worker contains per-asset failures and can pause/resume", async () => {
  let batch = 0;
  const worker = createVisualEmbeddingWorker({
    provider: {
      async encodeImage(path) {
        if (path.includes("bad")) throw new Error("decode failed");
        return [1, 0];
      },
    },
    relationshipService: {
      embeddingState() { return { state: "missing" }; },
      recordEmbedding() {},
    },
    async listCandidates() {
      batch += 1;
      if (batch > 1) return [];
      return [
        { assetId: "bad", imagePath: "/tmp/bad.png" },
        { assetId: "good", imagePath: "/tmp/good.png" },
      ];
    },
  });
  worker.pause();
  assert.equal(worker.status().state, "paused");
  await worker.resume();
  const status = worker.status();
  assert.equal(status.processed, 2);
  assert.equal(status.indexed, 1);
  assert.equal(status.failed, 1);
  assert.match(status.last_error, /decode failed/);
  await worker.stop();
  assert.equal(worker.status().state, "stopped");
});
