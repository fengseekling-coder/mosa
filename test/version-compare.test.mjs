import assert from "node:assert/strict";
import test from "node:test";

import { selectVersionComparisonPair, versionComparisonFields } from "../app/version-compare.mjs";

test("version comparison reports persisted field changes without inventing values", () => {
  const fields = versionComparisonFields(
    { prompt: "red poster", style: "editorial", tags: ["red", "poster"], ratio: "1:1" },
    { prompt: "blue poster", style: "editorial", tags: ["blue", "poster"], ratio: "1:1" },
  );
  assert.equal(fields.find((field) => field.key === "prompt").changed, true);
  assert.equal(fields.find((field) => field.key === "style").changed, false);
  assert.deepEqual(fields.find((field) => field.key === "tags"), { key: "tags", before: "red, poster", after: "blue, poster", changed: true });
  assert.equal(fields.find((field) => field.key === "theme").before, "");
});

test("version comparison defaults to the selected version and its explicit parent", () => {
  const history = { versions: [
    { id: "root", version_index: 1 },
    { id: "branch", version_index: 2, parent_asset_id: "root" },
    { id: "child", version_index: 3, parent_asset_id: "branch" },
  ] };
  const pair = selectVersionComparisonPair(history, "child");
  assert.equal(pair.base.id, "branch");
  assert.equal(pair.target.id, "child");
});

test("version comparison honors an explicit pair and refuses a single-version history", () => {
  const history = { versions: [{ id: "a" }, { id: "b" }, { id: "c" }] };
  const pair = selectVersionComparisonPair(history, "c", "a", "b");
  assert.equal(pair.base.id, "a");
  assert.equal(pair.target.id, "b");
  assert.equal(selectVersionComparisonPair({ versions: [{ id: "only" }] }, "only"), null);
});
