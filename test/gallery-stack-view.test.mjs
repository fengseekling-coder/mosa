import assert from "node:assert/strict";
import test from "node:test";

import { galleryCollapsesStacks, gallerySearchFlattens } from "../lib/api/gallery-stack-view.mjs";

test("gallery stacks collapse for the plain gallery view without a query", () => {
  assert.equal(galleryCollapsesStacks({ view: "gallery", scope: "all", query: "" }), true);
});

test("a non-empty search query flattens the gallery instead of stacking", () => {
  assert.equal(galleryCollapsesStacks({ view: "gallery", scope: "all", query: "aurora" }), false);
});

test("a whitespace-only query still collapses like an empty one", () => {
  assert.equal(galleryCollapsesStacks({ view: "gallery", scope: "all", query: "   " }), true);
  assert.equal(galleryCollapsesStacks({ view: "gallery", scope: "all", query: "\t\n" }), true);
});

test("the trash scope never collapses stacks", () => {
  assert.equal(galleryCollapsesStacks({ view: "gallery", scope: "trash", query: "" }), false);
});

test("non-gallery views and missing fields never collapse", () => {
  assert.equal(galleryCollapsesStacks({ view: "", scope: "all", query: "" }), false);
  assert.equal(galleryCollapsesStacks({ view: "gallery", scope: "favorite", query: "" }), true);
  assert.equal(galleryCollapsesStacks({}), false);
});

test("search flattening mirrors the collapse rule with an inverted query clause", () => {
  // 画廊 + 非回收站 + 有搜索词：本来要合成，因为搜索词才平铺。
  assert.equal(gallerySearchFlattens({ view: "gallery", scope: "all", query: "aurora" }), true);
  // 无搜索词或纯空白：不平铺，照常合成堆叠。
  assert.equal(gallerySearchFlattens({ view: "gallery", scope: "all", query: "" }), false);
  assert.equal(gallerySearchFlattens({ view: "gallery", scope: "all", query: "   " }), false);
  assert.equal(gallerySearchFlattens({ view: "gallery", scope: "all", query: "\t\n" }), false);
  // 回收站、非画廊视图、缺字段：一律不平铺。
  assert.equal(gallerySearchFlattens({ view: "gallery", scope: "trash", query: "aurora" }), false);
  assert.equal(gallerySearchFlattens({ view: "", scope: "all", query: "aurora" }), false);
  assert.equal(gallerySearchFlattens({}), false);
});
