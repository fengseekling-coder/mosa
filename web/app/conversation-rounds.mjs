// ===== 任务 75：检视器「版本树与上下文」的轮次计算（纯函数，可直接单测） =====
//
// 输入是生成历史接口（GET /api/assets/:p/:a/generation-history）的 history：
// - events + context_events：当前素材所在对话里已收录的全部生成记录（每条有
//   provider / conversation_id / message_id / turn_index / turn_synced_at /
//   created_at / output_asset_id / model）。
// - output_assets：这些记录对应的素材（完整素材对象，含 deleted_at）。
// - conversations：采集插件读到的对话真实总轮数 [{ provider, conversation_id,
//   turn_count, synced_at }]（任务 74 起提供，可能为空数组）。
// - context_truncated：上下文被 5000 条上限截断时为 true（张数可能少算）。
//
// 硬要求：统计绝不能出错——宁可不显示，也不显示一个可能错的数字；任何情况下
// 都不按时间间隔猜轮次。所以 A 级（ChatGPT 真实轮次）条件全部满足才显示轮次，
// 否则一律降为 C 级（只显示张数）或无对话（保持任务 73 的单行做法）。采集时
// 记下的 message_id 来源不统一，不参与任何计数或判定（B 级已取消）。
//
// 返回：
// - mode: "turns"（A 级）| "assets"（C 级）| "plain"（无对话）。
// - turns: A 级对话总轮数，其余 null。
// - images: 已收录张数；context_truncated 时为 null（C 级连张数也不显示）。
// - rows: turns/assets 模式的行 [{ event, outputAsset, isCurrent, turnIndex }]，
//   event 是该行展示素材的代表性记录（created_at 最早，平局取 id 小）；
//   plain 模式恒为空数组——73 的取行逻辑（inspector-markup 的
//   generationContextRows）原样保留，由调用方回退，两处不重复实现。

const CHATGPT_PROVIDER = "chatgpt";
const RECORD_SEPARATOR = "\u0000";

export function computeConversationRounds(history, currentAssetId) {
  const events = historyEvents(history);
  const assetById = new Map((Array.isArray(history?.output_assets) ? history.output_assets : [])
    .filter((asset) => asset && String(asset.id || "").trim())
    .map((asset) => [String(asset.id), asset]));
  const selectedId = String(currentAssetId || "");

  // 1. 确定对话：当前素材的记录里取 provider + conversation_id；分属不止一个
  //    对话、不是 chatgpt、或没有对话号 → 无对话。当前素材没有记录 → 无对话。
  const currentRecords = events.filter((event) => String(event.output_asset_id || "") === selectedId);
  if (!currentRecords.length) return plainRound();
  const conversationKeys = new Set(currentRecords.map((event) => conversationKeyOf(event)));
  if (conversationKeys.size !== 1) return plainRound();
  const [provider, conversationId] = [...conversationKeys][0].split(RECORD_SEPARATOR);
  if (provider !== CHATGPT_PROVIDER || !conversationId) return plainRound();

  // 2. 对话内的素材：同对话的 chatgpt 记录按 output_asset_id 归组；不在回收站
  //    的才计入（当前素材即使在回收站也计入）；找不到 output_assets 的记录不算。
  const recordsByAsset = new Map();
  for (const event of events) {
    if (conversationKeyOf(event) !== `${CHATGPT_PROVIDER}${RECORD_SEPARATOR}${conversationId}`) continue;
    const assetId = String(event.output_asset_id || "");
    const asset = assetById.get(assetId);
    if (!asset) continue;
    if (assetId !== selectedId && String(asset.deleted_at || "") !== "") continue;
    const list = recordsByAsset.get(assetId);
    if (list) list.push(event);
    else recordsByAsset.set(assetId, [event]);
  }
  // 当前素材自己的产物条目缺失时无从归属行，按无对话处理（不猜）。
  if (!recordsByAsset.has(selectedId)) return plainRound();

  // 3. 每个素材聚合：非空 turn_index 必须全部相同（不同 → 整个对话「不一致」）；
  //    turn_synced_at 收集自带 turn_index 的记录，用于 A 级「同一次快照」校验。
  const groups = [...recordsByAsset.entries()].map(([assetId, records]) => {
    const ordered = records.slice().sort(compareByTimeOf);
    const turnIndexes = new Set();
    const turnSyncedAts = new Set();
    for (const record of ordered) {
      const turnIndex = normalizeTurnIndex(record.turn_index);
      if (turnIndex === null) continue;
      turnIndexes.add(turnIndex);
      turnSyncedAts.add(String(record.turn_synced_at || ""));
    }
    return {
      assetId,
      representative: ordered[0],
      turnIndex: turnIndexes.size === 1 ? [...turnIndexes][0] : turnIndexes.size > 1 ? Number.NaN : null,
      turnSyncedAts: [...turnSyncedAts],
    };
  }).sort((left, right) => compareByTimeOf(left.representative, right.representative) || left.assetId.localeCompare(right.assetId));
  const inconsistent = groups.some((group) => Number.isNaN(group.turnIndex));
  const images = groups.length;
  const currentGroup = groups.find((group) => group.assetId === selectedId);

  // 4. A 级：conversations 里有这个对话（turn_count + synced_at 齐全）、没有
  //    「不一致」、没截断，且每个计入素材都有 turn_index、≤ turn_count、
  //    turn_synced_at 与对话 synced_at 相同（同一次快照）。任一不满足 → C 级。
  const conversation = (Array.isArray(history?.conversations) ? history.conversations : [])
    .find((entry) => conversationKeyOf(entry) === `${CHATGPT_PROVIDER}${RECORD_SEPARATOR}${conversationId}`);
  const turnCount = normalizeTurnCount(conversation?.turn_count);
  const syncedAt = String(conversation?.synced_at || "");
  const levelA = turnCount !== null && syncedAt !== "" && !inconsistent && history?.context_truncated !== true
    && groups.every((group) => Number.isInteger(group.turnIndex)
      && group.turnIndex <= turnCount
      && group.turnSyncedAts.length === 1
      && group.turnSyncedAts[0] === syncedAt);
  if (levelA) {
    const membersByTurn = new Map();
    for (const group of groups) {
      const list = membersByTurn.get(group.turnIndex);
      if (list) list.push(group);
      else membersByTurn.set(group.turnIndex, [group]);
    }
    const turnNumbers = [...membersByTurn.keys()].sort((left, right) => left - right);
    const rows = windowAround(turnNumbers, turnNumbers.indexOf(currentGroup.turnIndex))
      .map((turn) => {
        // 当前轮展示当前素材；其他轮展示该轮 created_at 最早的素材（groups 有序）。
        const shown = turn === currentGroup.turnIndex ? currentGroup : membersByTurn.get(turn)[0];
        return { event: shown.representative, outputAsset: assetById.get(shown.assetId) || null, isCurrent: turn === currentGroup.turnIndex, turnIndex: turn };
      });
    return { mode: "turns", turns: turnCount, images, rows };
  }

  // 5. C 级按素材取：当前素材 + created_at 前后各一个（groups 已按时间排好），
  //    贴边时向另一侧补足。context_truncated 时张数不显示（可能少算）。
  const rows = windowAround(groups, groups.indexOf(currentGroup))
    .map((group) => ({ event: group.representative, outputAsset: assetById.get(group.assetId) || null, isCurrent: group.assetId === selectedId, turnIndex: null }));
  return { mode: "assets", turns: null, images: history?.context_truncated === true ? null : images, rows };
}

// 无对话：行数据交给调用方按 73 的 generationContextRows 取，这里只标模式。
function plainRound() {
  return { mode: "plain", turns: null, images: null, rows: [] };
}

function historyEvents(history) {
  return [
    ...(Array.isArray(history?.events) ? history.events : []),
    ...(Array.isArray(history?.context_events) ? history.context_events : []),
  ].filter((event) => event && String(event.output_asset_id || "").trim());
}

function conversationKeyOf(entry) {
  return `${String(entry?.provider || "")}${RECORD_SEPARATOR}${String(entry?.conversation_id || "")}`;
}

// 缺失（null/undefined/空串）→ null；1 起的整数 → 数值；其余脏数据 → NaN
// （NaN 过不了 Number.isInteger，把对话按进 C 级，绝不显示可能错的轮次）。
function normalizeTurnIndex(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? number : Number.NaN;
}

function normalizeTurnCount(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? number : null;
}

function compareByTimeOf(left, right) {
  return String(left?.created_at || "").localeCompare(String(right?.created_at || ""))
    || String(left?.id || "").localeCompare(String(right?.id || ""));
}

// 中心 ±1、共 3 个；贴边向另一侧补足，不足 3 个就全出。与 73 的取行窗口同规则。
function windowAround(ordered, centerIndex) {
  const anchorStart = centerIndex >= 0 ? Math.max(0, centerIndex - 1) : Math.max(0, ordered.length - 3);
  const anchorEnd = Math.min(ordered.length, anchorStart + 3);
  const windowStart = Math.max(0, anchorEnd - 3);
  return ordered.slice(windowStart, anchorEnd);
}
