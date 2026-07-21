import assert from "node:assert/strict";
import test from "node:test";
import { chooseCowartInsertTarget, verifyCowartInsert } from "../lib/cowart-insert.mjs";

function canvasState() {
  return {
    viewState: { currentPageId: "page:main", camera: { x: 0, y: 0, z: 1 } },
    snapshot: {
      schema: { schemaVersion: 2 },
      store: {
        "page:main": { id: "page:main", typeName: "page", index: "a1" },
        "shape:near": { id: "shape:near", typeName: "shape", parentId: "page:main", x: 40, y: 80, props: { w: 200, h: 120 } },
        "shape:far": { id: "shape:far", typeName: "shape", parentId: "page:main", x: 12000, y: 0, props: { w: 200, h: 120 } },
      },
    },
  };
}

test("uses the current canvas selection as the insertion anchor", () => {
  const target = chooseCowartInsertTarget(canvasState(), { selection: { selectedShapes: ["shape:far"] } });
  assert.deepEqual(target, { pageId: "page:main", anchorShapeId: "shape:far", anchorSource: "selection" });
});

test("uses the current viewport's nearest page shape when no shape is selected", () => {
  const target = chooseCowartInsertTarget(canvasState(), { selection: { selectedShapes: [] } });
  assert.deepEqual(target, { pageId: "page:main", anchorShapeId: "shape:near", anchorSource: "viewport" });
});

test("only verifies a persisted Cowart image with matching MOSA provenance", () => {
  const state = canvasState();
  state.snapshot.store["asset:inserted"] = {
    id: "asset:inserted",
    typeName: "asset",
    type: "image",
    meta: { mosaAssetId: "mosa-asset", mosaProjectId: "default" },
  };
  state.snapshot.store["shape:inserted"] = {
    id: "shape:inserted",
    typeName: "shape",
    type: "image",
    parentId: "page:main",
    props: { assetId: "asset:inserted" },
  };
  const result = {
    pageId: "page:main",
    assetId: "asset:inserted",
    shapeId: "shape:inserted",
    bounds: { x: 280, y: 80, w: 512, h: 320 },
  };

  assert.deepEqual(
    verifyCowartInsert(state, result, { id: "mosa-asset", projectId: "default" }),
    result,
  );
  assert.equal(verifyCowartInsert(state, result, { id: "other-asset", projectId: "default" }), null);
});
