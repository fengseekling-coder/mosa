import assert from "node:assert/strict";
import test from "node:test";

import {
  conversationalAssetSearchPlan,
  finalizeConversationalSearchPlan,
} from "../lib/asset-search-query-plan.mjs";

test("query planner leaves ordinary keyword searches untouched", () => {
  assert.equal(conversationalAssetSearchPlan("金色 未来城市 海报"), null);
  assert.equal(conversationalAssetSearchPlan("editorial portrait"), null);
});

test("query planner removes conversational scaffolding and keeps deterministic CJK pairs", () => {
  const plan = conversationalAssetSearchPlan("找一下之前做过的金色未来城市海报");
  assert.ok(plan);
  assert.deepEqual(plan.cjkTerms, ["金色", "未来", "城市", "海报"]);
  const final = finalizeConversationalSearchPlan(plan, new Set(["金色", "未来", "城市", "海报"]));
  assert.equal(final.query, "金色 未来 城市 海报");
});

test("query planner respects punctuation boundaries and generic designer phrasing", () => {
  const plan = conversationalAssetSearchPlan("那个留白很多、蓝色背景的人物设计");
  assert.ok(plan);
  assert.deepEqual(plan.cjkTerms, ["留白", "蓝色", "背景", "人物"]);
  const final = finalizeConversationalSearchPlan(plan, new Set(["留白", "蓝色", "背景", "人物"]));
  assert.equal(final.query, "留白 蓝色 背景 人物");
});

test("query planner preserves short design abbreviations next to Chinese intent", () => {
  const plan = conversationalAssetSearchPlan("我之前精选过适合继续做品牌KV的版本");
  assert.ok(plan);
  assert.deepEqual(plan.cjkTerms, ["适合", "继续", "品牌"]);
  assert.ok(plan.asciiTerms.includes("kv"));
  const final = finalizeConversationalSearchPlan(plan, new Set(["适合", "继续", "品牌"]));
  assert.equal(final.query, "适合 继续 品牌 kv");
});
