import assert from "node:assert/strict";
import test from "node:test";

import { createVisualRelationshipService } from "../lib/visual-relationship-service.mjs";

test("visual relationship service turns exact neighbors into provider-neutral relationship candidates", async () => {
  const assets = new Map([
    ["anchor", { id: "anchor", parent_asset_id: null, child_asset_ids: ["child"] }],
    ["child", { id: "child", parent_asset_id: "anchor", child_asset_ids: [] }],
    ["candidate", { id: "candidate", parent_asset_id: null, child_asset_ids: [] }],
  ]);
  const index = {
    indexStatus() { return { count: 3 }; },
    similarToAsset() {
      return [
        { asset_id: "child", score: 0.99 },
        { asset_id: "candidate", score: 0.95 },
      ];
    },
    embeddingState() { return { state: "current" }; },
    upsertEmbedding() { return { ok: true }; },
    deleteAsset() { return 1; },
    clearModel() { return 3; },
  };
  const assetStore = {
    async getAsset(_projectId, assetId) {
      return assets.get(assetId);
    },
  };
  const service = createVisualRelationshipService({
    index,
    assetStore,
    model: { id: "example/model", revision: "r1", dimension: 512 },
  });
  const candidates = await service.relationshipCandidates("default", "anchor");
  assert.ok(!candidates[0].kinds.includes("version_candidate"), "existing child relation is not suggested again");
  assert.ok(candidates[1].kinds.includes("version_candidate"));
  assert.ok(candidates[1].kinds.includes("stack_candidate"));
});

test("visual relationship service fails closed when candidate metadata is unavailable", async () => {
  const service = createVisualRelationshipService({
    index: {
      indexStatus() { return { count: 0 }; },
      similarToAsset() { return []; },
      embeddingState() { return { state: "missing" }; },
      upsertEmbedding() {},
      deleteAsset() { return 0; },
      clearModel() { return 0; },
    },
    model: { id: "example/model", revision: "r1", dimension: 512 },
  });
  await assert.rejects(
    () => service.relationshipCandidates("default", "anchor"),
    /requires an asset store/,
  );
});

test("visual relationship service uses one pinned vector space for text-to-image search", async () => {
  const calls = [];
  const service = createVisualRelationshipService({
    index: {
      indexStatus() { return { count: 2 }; },
      querySimilar(projectId, vector, options) {
        calls.push([projectId, Array.from(vector), options]);
        return [{ asset_id: "asset-a", score: 0.91 }];
      },
      similarToAsset() { return []; },
      embeddingState() { return { state: "missing" }; },
      upsertEmbedding() {},
      deleteAsset() { return 0; },
      clearModel() { return 0; },
    },
    provider: {
      model: { id: "example/model", revision: "r1", dimension: 3 },
      async encodeText(query) {
        assert.equal(query, "蓝色人物");
        return new Float32Array([1, 0, 0]);
      },
    },
    model: { id: "example/model", revision: "r1", dimension: 3 },
  });
  const result = await service.searchByText("default", "蓝色人物", { limit: 5, minScore: 0.7 });
  assert.deepEqual(result.map((item) => item.asset_id), ["asset-a"]);
  assert.deepEqual(calls, [[
    "default",
    [1, 0, 0],
    { id: "example/model", revision: "r1", dimension: 3, limit: 5, minScore: 0.7 },
  ]]);
  assert.equal(service.status("default").capabilities.text_visual_search, true);
});

test("visual relationship service rejects a provider from a different model revision", () => {
  assert.throws(() => createVisualRelationshipService({
    index: {
      indexStatus() { return { count: 0 }; },
      similarToAsset() { return []; },
    },
    provider: {
      model: { id: "example/model", revision: "r2", dimension: 3 },
      encodeText() { return [1, 0, 0]; },
    },
    model: { id: "example/model", revision: "r1", dimension: 3 },
  }), /does not match/);
});
