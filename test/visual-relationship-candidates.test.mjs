import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVisualRelationshipCandidates,
  DEFAULT_VISUAL_RELATIONSHIP_THRESHOLDS,
} from "../lib/visual-relationship-candidates.mjs";

test("visual relationship candidates separate near-duplicate, version, stack, and generic neighbor semantics", () => {
  const anchor = { id: "anchor", parent_asset_id: null, child_asset_ids: [] };
  const result = buildVisualRelationshipCandidates(anchor, [
    { asset_id: "almost-same", score: 0.99, asset: { id: "almost-same" } },
    { asset_id: "versionish", score: 0.95, asset: { id: "versionish" } },
    { asset_id: "stackish", score: 0.91, asset: { id: "stackish" } },
    { asset_id: "neighbor", score: 0.7, asset: { id: "neighbor" } },
  ]);
  assert.deepEqual(result[0].kinds, ["near_duplicate_candidate", "version_candidate", "stack_candidate"]);
  assert.deepEqual(result[1].kinds, ["version_candidate", "stack_candidate"]);
  assert.deepEqual(result[2].kinds, ["stack_candidate"]);
  assert.deepEqual(result[3].kinds, ["visual_neighbor"]);
});

test("existing direct version relations are never re-proposed as version candidates", () => {
  const anchor = { id: "anchor", parent_asset_id: "parent", child_asset_ids: ["child"] };
  const result = buildVisualRelationshipCandidates(anchor, [
    { asset_id: "parent", score: 0.99, asset: { id: "parent" } },
    { asset_id: "child", score: 0.98, asset: { id: "child", parent_asset_id: "anchor" } },
  ]);
  assert.ok(result.every((item) => !item.kinds.includes("version_candidate")));
  assert.ok(result.every((item) => item.evidence.existing_direct_version_relation === true));
});

test("candidate thresholds are explicit, ordered, and configurable", () => {
  const custom = buildVisualRelationshipCandidates(
    { id: "anchor", child_asset_ids: [] },
    [{ asset_id: "candidate", score: 0.8, asset: { id: "candidate" } }],
    { thresholds: { nearDuplicate: 0.95, versionCandidate: 0.85, stackCandidate: 0.75 } },
  );
  assert.deepEqual(custom[0].kinds, ["stack_candidate"]);
  assert.equal(DEFAULT_VISUAL_RELATIONSHIP_THRESHOLDS.nearDuplicate, 0.985);
  assert.throws(
    () => buildVisualRelationshipCandidates(
      { id: "anchor" },
      [],
      { thresholds: { nearDuplicate: 0.8, versionCandidate: 0.9, stackCandidate: 0.7 } },
    ),
    /must satisfy/,
  );
});
