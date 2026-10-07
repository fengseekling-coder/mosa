// 任务 75：检视器「版本树与上下文」轮次计算。computeConversationRounds 纯函数
// 直接测：A 级（ChatGPT 真实轮次，条件全满足才显示）、C 级（只张数，截断时连
// 张数也不显示）、无对话（保持 73 单行）三级判定与取 3 行窗口；另经
// generationContextBoxMarkup 锁每行两行新文案与英文单复数。Node 标准库，零网络。
import assert from "node:assert/strict";
import test from "node:test";

import { computeConversationRounds } from "../web/app/conversation-rounds.mjs";
import { createInspectorMarkup } from "../web/app/inspector-markup.mjs";

const SYNC = "2026-10-07T09:00:00.000Z";
const CONVERSATION = "conv-1";
// 「N 秒前」：数字越大时间越早，与生成树的 e2e 助手同一口径。
const iso = (secondsAgo) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) - secondsAgo * 1000).toISOString();

const asset = (id, extra = {}) => ({ id, deleted_at: null, thumbnail_url: `thumb://${id}`, thumbnail_ready: true, ...extra });

const event = (id, outputAssetId, { conversation = CONVERSATION, provider = "chatgpt", message = `msg-${id}`, turn = null, synced = SYNC, model = "gpt-5-4-thinking", created, ...rest } = {}) => (
  { id, output_asset_id: outputAssetId, provider, conversation_id: conversation, message_id: message, turn_index: turn, turn_synced_at: turn === null ? null : synced, model, created_at: created, ...rest }
);

const conversationEntry = (turnCount, syncedAt = SYNC) => ({ provider: "chatgpt", conversation_id: CONVERSATION, turn_count: turnCount, synced_at: syncedAt });

const historyOf = (events, { assets, conversations = [], truncated = false } = {}) => ({
  events,
  context_events: [],
  output_assets: (assets ?? events.map((item) => asset(item.output_asset_id))),
  conversations,
  context_truncated: truncated,
});

// 主场景：5 张图 3 轮（第 2 轮 2 张、第 3 轮 2 张），当前素材 a3 在第 2 轮，
// 对话共 5 轮。turn_count 是 5，但只轮 1/2/3 有已收录图。
function aLevelHistory() {
  const events = [
    event("e1", "a1", { turn: 1, created: iso(50) }),
    event("e2", "a2", { turn: 2, created: iso(40) }),
    event("e3", "a3", { turn: 2, created: iso(30) }),
    event("e4", "a4", { turn: 3, created: iso(20) }),
    event("e5", "a5", { turn: 3, created: iso(10) }),
  ];
  return historyOf(events, { conversations: [conversationEntry(5)] });
}

test("A level: real turns render with turn_count, per-turn rows and the earliest asset per other turn", () => {
  const rounds = computeConversationRounds(aLevelHistory(), "a3");
  assert.equal(rounds.mode, "turns");
  assert.equal(rounds.turns, 5);
  assert.equal(rounds.images, 5);
  assert.deepEqual(rounds.rows.map((row) => row.turnIndex), [1, 2, 3]);
  assert.deepEqual(rounds.rows.map((row) => row.event.output_asset_id), ["a1", "a3", "a4"], "current turn shows the current asset, other turns the earliest asset");
  assert.deepEqual(rounds.rows.map((row) => row.isCurrent), [false, true, false]);
});

test("A level degrades to C when any turn_index exceeds turn_count", () => {
  const history = aLevelHistory();
  history.events[4] = event("e5", "a5", { turn: 6, created: iso(10) });
  const rounds = computeConversationRounds(history, "a3");
  assert.equal(rounds.mode, "assets");
  assert.equal(rounds.turns, null);
  assert.equal(rounds.images, 5);
});

test("A level degrades to C when a counted asset lacks turn_index", () => {
  const history = aLevelHistory();
  history.events[0] = event("e1", "a1", { turn: null, created: iso(50) });
  assert.equal(computeConversationRounds(history, "a3").mode, "assets");
});

test("A level degrades to C when an asset's turn_synced_at is older than the conversation's synced_at (stale snapshot)", () => {
  const history = aLevelHistory();
  history.events[1] = event("e2", "a2", { turn: 2, synced: "2026-10-07T08:00:00.000Z", created: iso(40) });
  const rounds = computeConversationRounds(history, "a3");
  assert.equal(rounds.mode, "assets");
});

test("A level degrades to C when one asset carries records with different turn_index (inconsistent)", () => {
  const history = aLevelHistory();
  history.events.push(event("e6", "a2", { turn: 3, created: iso(9) }));
  assert.equal(computeConversationRounds(history, "a3").mode, "assets");
});

test("context_truncated degrades to C and hides the captured-image count", () => {
  const history = aLevelHistory();
  history.context_truncated = true;
  const rounds = computeConversationRounds(history, "a3");
  assert.equal(rounds.mode, "assets");
  assert.equal(rounds.images, null, "truncated counts may undercount, so no number is shown");
});

test("records of the current asset spanning two conversations fall back to no conversation", () => {
  const history = aLevelHistory();
  history.events.push(event("e6", "a3", { conversation: "conv-2", turn: 4, created: iso(8) }));
  history.conversations.push({ provider: "chatgpt", conversation_id: "conv-2", turn_count: 9, synced_at: SYNC });
  assert.equal(computeConversationRounds(history, "a3").mode, "plain");
});

test("message ids without turn indexes give C level (the old B level is gone)", () => {
  const history = aLevelHistory();
  for (const [index, item] of history.events.entries()) {
    history.events[index] = event(item.id, item.output_asset_id, { turn: null, message: `m-${index}`, created: item.created_at });
  }
  const rounds = computeConversationRounds(history, "a3");
  assert.equal(rounds.mode, "assets");
  assert.equal(rounds.images, 5, "message ids never affect the count");
});

test("trashed assets are not counted, but the current asset counts even when trashed", () => {
  const history = aLevelHistory();
  history.output_assets.find((item) => item.id === "a5").deleted_at = "2026-10-07T10:00:00.000Z";
  const trashedCurrent = computeConversationRounds(history, "a2");
  assert.equal(trashedCurrent.mode, "turns", "A level still holds: the stale row just leaves the counted set");
  assert.equal(trashedCurrent.images, 4);
  assert.deepEqual(trashedCurrent.rows.map((row) => row.event.output_asset_id), ["a1", "a2", "a4"], "current asset stays the row even though it is trashed");
  // 当前素材本身在回收站：仍然计入且可作 A 级中心。
  history.output_assets.find((item) => item.id === "a2").deleted_at = "2026-10-07T10:00:00.000Z";
  const currentTrashed = computeConversationRounds(history, "a2");
  assert.equal(currentTrashed.mode, "turns");
  assert.equal(currentTrashed.images, 4, "the trashed current asset is still counted (a1..a4)");
});

test("records without a matching output_assets entry are not counted", () => {
  const history = aLevelHistory();
  history.events.push(event("e6", "ghost", { turn: 4, created: iso(8) }));
  const rounds = computeConversationRounds(history, "a3");
  assert.equal(rounds.mode, "turns");
  assert.equal(rounds.images, 5);
  assert.ok(rounds.rows.every((row) => row.event.output_asset_id !== "ghost"));
});

test("the three-row window over turns: middle, first, last, and fewer than three turns", () => {
  const build = (turnNumbers, currentTurn, turnCount) => {
    const events = turnNumbers.map((turn, index) => event(`e${turn}`, `a${turn}`, { turn, created: iso(50 - index * 10) }));
    return historyOf(events, { conversations: [conversationEntry(turnCount)] });
  };
  const middle = computeConversationRounds(build([3, 4, 5, 6, 7], 5, 9), "a5");
  assert.deepEqual(middle.rows.map((row) => row.turnIndex), [4, 5, 6]);
  const first = computeConversationRounds(build([3, 4, 5, 6, 7], 3, 9), "a3");
  assert.deepEqual(first.rows.map((row) => row.turnIndex), [3, 4, 5], "at the start the window extends downward");
  assert.equal(first.rows[0].isCurrent, true);
  const last = computeConversationRounds(build([3, 4, 5, 6, 7], 7, 9), "a7");
  assert.deepEqual(last.rows.map((row) => row.turnIndex), [5, 6, 7], "at the end the window extends upward");
  const single = computeConversationRounds(build([4], 4, 9), "a4");
  assert.deepEqual(single.rows.map((row) => row.turnIndex), [4]);
  const pair = computeConversationRounds(build([4, 5], 4, 9), "a4");
  assert.deepEqual(pair.rows.map((row) => row.turnIndex), [4, 5]);
});

test("no conversation: non-chatgpt providers, empty conversation ids and unrecorded assets stay plain", () => {
  const flowHistory = historyOf([event("e1", "a1", { provider: "flow", turn: 1, created: iso(10) })], { conversations: [conversationEntry(5)] });
  assert.equal(computeConversationRounds(flowHistory, "a1").mode, "plain");
  const manualHistory = historyOf([event("e1", "a1", { conversation: "", turn: null, created: iso(10) })]);
  assert.equal(computeConversationRounds(manualHistory, "a1").mode, "plain");
  const unrecorded = computeConversationRounds(aLevelHistory(), "zz");
  assert.equal(unrecorded.mode, "plain");
  assert.equal(unrecorded.rows.length, 0, "plain rows come from generationContextRows at the call site (73 keeps ownership)");
});

test("the A-level box markup shows the turn lines and the totals line on every row", () => {
  const helpers = createInspectorMarkup({ state: { locale: "zh-CN", assets: [] }, t: zhT, referenceRightsMarkup: () => "" });
  const markup = helpers.generationContextBoxMarkup(aLevelHistory(), "a3");
  assert.ok(markup.includes("第 1 轮生成") && markup.includes("第 3 轮生成"));
  assert.equal((markup.match(/当前素材——第 2 轮生成/g) || []).length, 1, "only the current row carries the merged marker");
  assert.equal((markup.match(/共 5 轮 \/ 已收录 5 张图/g) || []).length, 3, "the totals line repeats on every row like the mock");
  assert.ok(!markup.includes("当前素材</span>"), "the bare current marker is replaced by the merged turn line");
  assert.equal((markup.match(/<button class="detail-version-context-row/g) || []).length, 3, "rows are buttons reusing the open-output action");
  assert.equal((markup.match(/data-action="open-generation-output"/g) || []).length, 3);
  assert.ok(markup.includes('data-output-asset-id="a1"'));
  assert.ok(/<button class="detail-version-context-row is-current"[^>]* disabled>/.test(markup), "the current row is disabled like the generation tree's own entry");
});

test("the C-level box markup shows the bare marker on the current row and the count only", () => {
  const helpers = createInspectorMarkup({ state: { locale: "zh-CN", assets: [] }, t: zhT, referenceRightsMarkup: () => "" });
  const history = aLevelHistory();
  history.events[0] = event("e1", "a1", { turn: null, created: iso(50) });
  const markup = helpers.generationContextBoxMarkup(history, "a3");
  assert.ok(!markup.includes("轮生成"), "no turn numbers without a trusted snapshot");
  assert.equal((markup.match(/>当前素材</g) || []).length, 1, "only the current row shows the bare marker");
  assert.equal((markup.match(/已收录 5 张图/g) || []).length, 3);
  // 截断时连张数也不显示。
  const truncated = helpers.generationContextBoxMarkup({ ...history, context_truncated: true }, "a3");
  assert.ok(!truncated.includes("已收录"), "a truncated context must not show a possibly undercounted number");
  assert.ok(truncated.includes(">当前素材<"));
});

test("the plain box keeps 73's single line with the current marker and no totals", () => {
  const helpers = createInspectorMarkup({ state: { locale: "zh-CN", assets: [] }, t: zhT, referenceRightsMarkup: () => "" });
  const markup = helpers.generationContextBoxMarkup(historyOf([
    event("e1", "a1", { provider: "flow", conversation: "", turn: null, created: iso(20) }),
    event("e2", "a2", { provider: "flow", conversation: "", turn: null, created: iso(10) }),
  ]), "a2");
  assert.ok(markup.includes("模型：flow · gpt-5-4-thinking"));
  assert.ok(markup.includes("当前素材"), "73's marker stays");
  assert.ok(!markup.includes("轮生成") && !markup.includes("已收录"));
});

test("English uses singular turn/image when a number is 1", () => {
  const helpers = createInspectorMarkup({ state: { locale: "en", assets: [] }, t: enT, referenceRightsMarkup: () => "" });
  // 合计行的单复数与轮次行经真实 markup 断言（键选择与渲染共用同一条路径）。
  const oneOne = helpers.generationContextBoxMarkup(turnImageHistory(1, 1), "a1");
  assert.ok(oneOne.includes("1 turn · 1 captured image"), oneOne);
  assert.ok(oneOne.includes("This asset — turn 1"));
  const manyMany = helpers.generationContextBoxMarkup(turnImageHistory(5, 4), "a3");
  assert.ok(manyMany.includes("5 turns · 4 captured images"));
  const oneTurn = helpers.generationContextBoxMarkup(turnImageHistory(1, 4), "a1");
  assert.ok(oneTurn.includes("1 turn · 4 captured images"));
  const oneImage = helpers.generationContextBoxMarkup(turnImageHistory(5, 1), "a1");
  assert.ok(oneImage.includes("5 turns · 1 captured image"));
  const cOne = helpers.generationContextBoxMarkup(turnImageHistory(5, 1, { degrade: true }), "a1");
  assert.ok(cOne.includes("1 captured image") && !cOne.includes("Turn"));
  const cMany = helpers.generationContextBoxMarkup(turnImageHistory(5, 4, { degrade: true }), "a3");
  assert.ok(cMany.includes("4 captured images"));
  const threeTurns = helpers.generationContextBoxMarkup(turnImageHistory(3, 3), "a2");
  assert.ok(threeTurns.includes("This asset — turn 2"));
  assert.ok(threeTurns.includes("Turn 1") && threeTurns.includes("Turn 3"));
});

// 造一个「turns 轮、images 张图、对话共 turns 轮」的历史（第 image 张图归
// min(turns, image) 轮）；degrade 为 true 时去掉对话快照让它降为 C 级。
// 返回的历史里当前素材由调用方指定（必须是真实存在的 a1..a{images}）。
function turnImageHistory(turns, images, { degrade = false } = {}) {
  const events = [];
  const assets = [];
  for (let image = 1; image <= images; image += 1) {
    const turn = Math.min(turns, image);
    const id = `a${image}`;
    events.push(event(`e${image}`, id, { turn: degrade ? null : turn, created: iso(60 - image) }));
    assets.push(asset(id));
  }
  return historyOf(events, { assets, conversations: degrade ? [] : [conversationEntry(turns)] });
}

const zhT = (key, params = {}) => ({
  generationModelLine: `模型：${params.value}`,
  generationCurrentAsset: "当前素材",
  generationTurnLine: `第 ${params.n} 轮生成`,
  generationCurrentTurnLine: `当前素材——第 ${params.n} 轮生成`,
  generationRoundsSummary: `共 ${params.turns} 轮 / 已收录 ${params.images} 张图`,
  generationRoundsSummaryTurnOne: `共 ${params.turns} 轮 / 已收录 ${params.images} 张图`,
  generationRoundsSummaryImageOne: `共 ${params.turns} 轮 / 已收录 ${params.images} 张图`,
  generationRoundsSummaryTurnOneImageOne: `共 ${params.turns} 轮 / 已收录 ${params.images} 张图`,
  generationImagesSummary: `已收录 ${params.images} 张图`,
  generationImagesSummaryOne: `已收录 ${params.images} 张图`,
  generationHistoryEmpty: "暂无生成记录",
  sourceUnknown: "未知来源",
})[key] ?? key;

const enT = (key, params = {}) => ({
  generationModelLine: `Model: ${params.value}`,
  generationCurrentAsset: "This asset",
  generationTurnLine: `Turn ${params.n}`,
  generationCurrentTurnLine: `This asset — turn ${params.n}`,
  generationRoundsSummary: `${params.turns} turns · ${params.images} captured images`,
  generationRoundsSummaryTurnOne: `${params.turns} turn · ${params.images} captured images`,
  generationRoundsSummaryImageOne: `${params.turns} turns · ${params.images} captured image`,
  generationRoundsSummaryTurnOneImageOne: `${params.turns} turn · ${params.images} captured image`,
  generationImagesSummary: `${params.images} captured images`,
  generationImagesSummaryOne: `${params.images} captured image`,
  generationHistoryEmpty: "No generation history recorded",
  sourceUnknown: "Unknown source",
})[key] ?? key;
