// navigation-history.mjs 单测：push/back/forward/canBack/canForward、
// 中间位置 push 截断前进记录、上限 50、恢复（back/forward）不产生新记录。
import assert from "node:assert/strict";
import test from "node:test";

import { NAVIGATION_HISTORY_LIMIT, createNavigationHistory } from "../web/app/navigation-history.mjs";

const snap = (label) => ({ scope: "all", facets: {}, mediaKind: "all", query: label });

test("fresh history has no back/forward and empty current", () => {
  const history = createNavigationHistory();
  assert.equal(history.size, 0);
  assert.equal(history.current(), null);
  assert.equal(history.canBack(), false);
  assert.equal(history.canForward(), false);
  assert.equal(history.back(), null);
  assert.equal(history.forward(), null);
});

test("push records positions; the first entry cannot be backed out of", () => {
  const history = createNavigationHistory();
  history.push(snap("a"));
  assert.equal(history.size, 1);
  assert.equal(history.current().query, "a");
  assert.equal(history.canBack(), false, "the initial position has nothing behind it");
  assert.equal(history.canForward(), false);
  history.push(snap("b"));
  assert.equal(history.canBack(), true);
  assert.equal(history.canForward(), false);
  assert.equal(history.peekBack().query, "a");
});

test("back/forward move the cursor and return the target snapshot", () => {
  const history = createNavigationHistory();
  history.push(snap("a"));
  history.push(snap("b"));
  history.push(snap("c"));
  assert.equal(history.back().query, "b");
  assert.equal(history.current().query, "b");
  assert.equal(history.canBack(), true);
  assert.equal(history.canForward(), true);
  assert.equal(history.forward().query, "c");
  assert.equal(history.canForward(), false);
  assert.equal(history.back().query, "b");
  assert.equal(history.back().query, "a");
  assert.equal(history.canBack(), false);
});

test("restoring (back/forward) never grows the history", () => {
  const history = createNavigationHistory();
  history.push(snap("a"));
  history.push(snap("b"));
  for (let round = 0; round < 5; round += 1) {
    assert.equal(history.size, 2, `round ${round}: back must not push`);
    history.back();
    assert.equal(history.size, 2, `round ${round}: the restore itself must not record`);
    history.forward();
  }
  assert.equal(history.current().query, "b");
});

test("pushing at a middle position drops every forward entry", () => {
  const history = createNavigationHistory();
  history.push(snap("a"));
  history.push(snap("b"));
  history.push(snap("c"));
  history.back(); // 光标停在 b
  history.push(snap("d"));
  assert.equal(history.size, 3, "a/b stay, c is dropped, d is appended");
  assert.equal(history.current().query, "d");
  assert.equal(history.canForward(), false);
  assert.equal(history.back().query, "b", "the trail still runs through the branching position");
  assert.equal(history.back().query, "a");
  assert.equal(history.canBack(), false);
});

test("history keeps at most the last `limit` entries", () => {
  assert.equal(NAVIGATION_HISTORY_LIMIT, 50);
  const history = createNavigationHistory();
  for (let index = 0; index < 70; index += 1) history.push(snap(`p${index}`));
  assert.equal(history.size, NAVIGATION_HISTORY_LIMIT);
  assert.equal(history.current().query, "p69");
  // 最早的 20 条被丢弃：一路 back 只能回到 p20。
  let steps = 0;
  while (history.canBack()) {
    history.back();
    steps += 1;
  }
  assert.equal(steps, NAVIGATION_HISTORY_LIMIT - 1);
  assert.equal(history.current().query, "p20");
  assert.equal(history.size, NAVIGATION_HISTORY_LIMIT, "walking back never resizes the window");
});

test("custom smaller limit and clear() behave", () => {
  const history = createNavigationHistory({ limit: 2 });
  history.push(snap("a"));
  history.push(snap("b"));
  history.push(snap("c"));
  assert.equal(history.size, 2);
  assert.equal(history.back().query, "b");
  assert.equal(history.canBack(), false);
  history.clear();
  assert.equal(history.size, 0);
  assert.equal(history.current(), null);
  assert.equal(history.canBack(), false);
  assert.equal(history.canForward(), false);
});
