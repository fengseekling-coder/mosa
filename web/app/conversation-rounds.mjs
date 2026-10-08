// ===== 任务 75 + 返工 1：检视器「版本树与上下文」的轮次计算（纯函数，可直接单测） =====
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
// 都不按时间间隔猜轮次。返工 1（10-07）起改为逐张判定：真实对话里只有当前分支
// 上的少数素材带轮次（其余是被重新生成、改提问换掉的旧版本，本来就没有「第几
// 轮」），所以不再要求整框都有轮次，而是每一行单独校验、合格才显示——一行不
// 合格只废一行。采集时记下的 message_id 来源不统一，不参与任何计数或判定。
//
// 返回：
// - mode: "context"（有对话，行内逐张带轮次或不带）| "plain"（无对话）。
// - turns: 对话快照有效且未截断时的总轮数，其余 null。
// - images: 已收录张数；context_truncated 时为 null（连张数也不显示）。
// - rows: context 模式的行 [{ event, outputAsset, isCurrent, turnIndex }]，按
//   素材时间取当前素材和前后各一张（贴边补足），turnIndex 为 null 表示该行不
//   显示轮次；plain 模式恒为空数组——73 的取行逻辑（inspector-markup 的
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

  // 3. 每个素材聚合：非空 turn_index 收进集合（多个不同值 → NaN，判这一行
  //    不一致）；turn_synced_at 收集自带 turn_index 的记录，用于「同一次快照」
  //    校验。逐行判定在下面第 5 步，这里不整框定级。
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
  const currentGroup = groups.find((group) => group.assetId === selectedId);

  // 4. 对话快照：conversations 里的 turn_count / synced_at 是逐行判定的基准；
  //    context_truncated 时张数可能少算，轮次和数字一律不显示（75 原规则）。
  const conversation = (Array.isArray(history?.conversations) ? history.conversations : [])
    .find((entry) => conversationKeyOf(entry) === `${CHATGPT_PROVIDER}${RECORD_SEPARATOR}${conversationId}`);
  const turnCount = normalizeTurnCount(conversation?.turn_count);
  const syncedAt = String(conversation?.synced_at || "");
  const truncated = history?.context_truncated === true;

  // 5. 取行一律按素材时间：当前素材 + created_at 前后各一个，贴边向另一侧补足
  //    （与 73 的取行窗口同规则）；每一行单独判定轮次（返工 1）。
  const rows = windowAround(groups, groups.indexOf(currentGroup)).map((group) => ({
    event: group.representative,
    outputAsset: assetById.get(group.assetId) || null,
    isCurrent: group.assetId === selectedId,
    turnIndex: truncated ? null : rowTurnIndex(group, turnCount, syncedAt),
  }));
  return {
    mode: "context",
    turns: !truncated && turnCount !== null && syncedAt !== "" ? turnCount : null,
    images: truncated ? null : groups.length,
    rows,
  };
}

// 逐行判定（返工 1）：对话快照有效（turn_count / synced_at 齐全），且这张素材
// 「非空 turn_index 唯一、不超过 turn_count、带轮次记录的 turn_synced_at 全部等
// 于对话 synced_at（同一次快照）」才返回轮次；任一条件不满足这一行就不显示轮次，
// 不影响其他行。
function rowTurnIndex(group, turnCount, syncedAt) {
  if (turnCount === null || syncedAt === "") return null;
  if (!Number.isInteger(group.turnIndex) || group.turnIndex > turnCount) return null;
  return group.turnSyncedAts.length === 1 && group.turnSyncedAts[0] === syncedAt ? group.turnIndex : null;
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
// （NaN 过不了 Number.isInteger，让这一行不显示轮次，绝不显示可能错的数字）。
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
