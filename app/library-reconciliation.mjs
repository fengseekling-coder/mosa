// Library Change 增量 reconciliation 数据层。
//
// 架构目标：Library 变化（SSE / 轮询 / 自发起 mutation）不再触发
// “revision changed → 重拉整个已加载画廊窗口”，而是
//
//   change batch → classify（按实体合并）
//   → fetch affected entities（POST /api/gallery-rows，O(affected)）
//   → reconcile state（有序列表增量插入/更新/移除 + pageTotal 记账）
//   → commit keyed DOM changes（由宿主注入的 commitGalleryChanges 完成）
//   → 成功后 advance revision baseline
//
// 本模块不触碰 document：所有渲染副作用经依赖注入（commitGalleryChanges /
// renderDetail / gallerySelection 等），因此可以在 Node 中直接执行单元测试。
// 全量恢复（journal gap / 未分类变更 / 不可恢复状态）是唯一 fallback 路径，
// 由宿主注入的 performFullReconciliation 承担。

const ROOT_SNAPSHOT_PENDING_LIMIT = 5000;
const GALLERY_ROWS_CHUNK_SIZE = 500;

// Revision token 形如 "<journal counter>"（JSON store）或 "<counter>:<data_version>"
//（SQLite store）。整数前缀是 delta API 的 since 游标。
export function parseRevisionNumber(token) {
  const value = Number.parseInt(String(token ?? ""), 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * 将一批 change records 合并成按实体键控的分类结果。
 * 未知 kind 一律视为 unclassified（触发有界 partial refresh），保证前向安全：
 * 旧前端遇到新后端事件时退化为旧行为，而不是静默丢变化。
 */
export function classifyLibraryChanges(changes) {
  const assetEvents = new Map();
  const stackEvents = new Map();
  const groupEvents = [];
  const generationAssetIds = new Set();
  const deletedAssetIds = new Set();
  let unclassified = false;
  let statsDirty = false;

  const assetEvent = (id) => {
    let event = assetEvents.get(id);
    if (!event) {
      event = { id, kinds: new Set(), flags: new Set() };
      assetEvents.set(id, event);
    }
    return event;
  };
  const stackEvent = (id) => {
    let event = stackEvents.get(id);
    if (!event) {
      event = { id, kinds: new Set(), assetIds: new Set(), dissolved: false };
      stackEvents.set(id, event);
    }
    return event;
  };
  const idsOf = (change) => (Array.isArray(change?.assetIds) ? change.assetIds : []);

  for (const change of Array.isArray(changes) ? changes : []) {
    const kind = String(change?.kind || "");
    switch (kind) {
      case "asset-added":
        assetEvent(String(change.entityId || "")).kinds.add("added");
        statsDirty = true;
        break;
      case "asset-updated": {
        const event = assetEvent(String(change.entityId || ""));
        event.kinds.add("updated");
        for (const flag of Array.isArray(change.flags) ? change.flags : []) event.flags.add(String(flag));
        if (event.flags.has("favorite") || event.flags.has("group")) statsDirty = true;
        break;
      }
      case "assets-updated": {
        const flags = Array.isArray(change.flags) ? change.flags.map(String) : [];
        for (const assetId of idsOf(change)) {
          const event = assetEvent(String(assetId));
          event.kinds.add("updated");
          for (const flag of flags) event.flags.add(flag);
        }
        if (flags.includes("favorite") || flags.includes("group")) statsDirty = true;
        break;
      }
      case "asset-deleted":
        assetEvent(String(change.entityId || "")).kinds.add("deleted");
        deletedAssetIds.add(String(change.entityId || ""));
        statsDirty = true;
        break;
      case "asset-restored":
        assetEvent(String(change.entityId || "")).kinds.add("restored");
        statsDirty = true;
        break;
      case "asset-permanently-deleted":
        assetEvent(String(change.entityId || "")).kinds.add("permanent");
        deletedAssetIds.add(String(change.entityId || ""));
        statsDirty = true;
        break;
      case "asset-archived":
        assetEvent(String(change.entityId || "")).kinds.add("archived");
        statsDirty = true;
        break;
      case "stack-created": {
        const event = stackEvent(String(change.entityId || ""));
        event.kinds.add("created");
        idsOf(change).forEach((id) => event.assetIds.add(String(id)));
        statsDirty = true;
        break;
      }
      case "stack-updated": {
        const event = stackEvent(String(change.entityId || ""));
        event.kinds.add("updated");
        idsOf(change).forEach((id) => event.assetIds.add(String(id)));
        break;
      }
      case "stack-members-changed": {
        const event = stackEvent(String(change.entityId || ""));
        event.kinds.add("members");
        idsOf(change).forEach((id) => event.assetIds.add(String(id)));
        statsDirty = true;
        break;
      }
      case "stack-cover-changed": {
        const event = stackEvent(String(change.entityId || ""));
        event.kinds.add("cover");
        idsOf(change).forEach((id) => event.assetIds.add(String(id)));
        break;
      }
      case "stack-order-changed": {
        const event = stackEvent(String(change.entityId || ""));
        event.kinds.add("order");
        idsOf(change).forEach((id) => event.assetIds.add(String(id)));
        break;
      }
      case "stack-dissolved": {
        const event = stackEvent(String(change.entityId || ""));
        event.kinds.add("dissolved");
        event.dissolved = true;
        idsOf(change).forEach((id) => event.assetIds.add(String(id)));
        statsDirty = true;
        break;
      }
      case "group-created":
      case "group-renamed":
      case "group-deleted":
      case "group-updated":
      case "groups-reordered":
        groupEvents.push(change);
        statsDirty = true;
        break;
      case "generation-updated":
      case "generation-relation-updated":
      case "generation-relation-candidate-updated":
      case "generation-relation-deleted":
        idsOf(change).forEach((id) => generationAssetIds.add(String(id)));
        break;
      case "":
        break;
      default:
        unclassified = true;
        break;
    }
  }
  return { assetEvents, stackEvents, groupEvents, generationAssetIds, deletedAssetIds, unclassified, statsDirty };
}

function compareIds(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 服务端排序语义的客户端复刻（与 sqlite listAssetPage/listCollapsedAssetPage 的
 * ORDER BY 一致）：newest = (createdAt DESC, id DESC)；oldest/name 为升序；
 * Stack 内 manual = (stack_position ASC, id ASC)。createdAt 为 ISO 字符串，
 * 字典序即时间序，与 SQLite TEXT 比较一致。
 */
export function compareGalleryNodeOrder(left, right, sort) {
  if (sort === "manual") {
    const leftPosition = Number(left?.stack_position ?? Number.POSITIVE_INFINITY);
    const rightPosition = Number(right?.stack_position ?? Number.POSITIVE_INFINITY);
    if (leftPosition !== rightPosition) return leftPosition < rightPosition ? -1 : 1;
    return compareIds(left?.id, right?.id);
  }
  const leftKeys = left?.node_sort || {};
  const rightKeys = right?.node_sort || {};
  if (sort === "name") {
    const leftName = String(leftKeys.sortName ?? "");
    const rightName = String(rightKeys.sortName ?? "");
    if (leftName !== rightName) return leftName < rightName ? -1 : 1;
    return compareIds(left?.id, right?.id);
  }
  const leftCreated = String(leftKeys.createdAt ?? "");
  const rightCreated = String(rightKeys.createdAt ?? "");
  if (sort === "oldest") {
    if (leftCreated !== rightCreated) return leftCreated < rightCreated ? -1 : 1;
    return compareIds(left?.id, right?.id);
  }
  // newest（默认）
  if (leftCreated !== rightCreated) return leftCreated < rightCreated ? 1 : -1;
  return -compareIds(left?.id, right?.id);
}

function insertSorted(list, row, sort) {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (compareGalleryNodeOrder(list[mid], row, sort) <= 0) low = mid + 1;
    else high = mid;
  }
  list.splice(low, 0, row);
}

/**
 * 卡片渲染相关字段的签名（与 renderKey 的输入对齐：updated_at 之外的
 * favorite/group/stack 注解/衍生图 URL 等都会改变卡片内容，但其中多个字段
 * 在服务端变更时并不会 bump updated_at，因此不能用 id:updated_at 判重）。
 */
function galleryRowSignature(asset, project = "default") {
  return [
    asset?.project_id || project,
    asset?.id || "",
    asset?.updated_at || "",
    asset?.image_url || "",
    asset?.thumbnail_url || "",
    asset?.preview_url || "",
    asset?.favorite ? "1" : "0",
    asset?.group || "",
    String(asset?.version_index ?? ""),
    asset?.deleted_at || "",
    asset?.stack?.id || "",
    String(asset?.stack?.count ?? ""),
    String(asset?.stack?.match_count ?? ""),
  ].join("\u001f");
}

/**
 * 对一份有序资产列表应用一批 gallery rows 的增量结果（纯函数，不触碰 DOM）。
 * - affected rows 中未返回的 → 移除
 * - 已存在的 → 原地更新；排序键变化且可复现排序时 → 重定位
 * - 新出现的 → 二分插入正确排序位置（搜索相关性排序等不可复现时跳过插入，
 *   只做 total 记账，卡片将在下一次视图刷新时出现）
 *
 * 幂等：重复应用同一批 rows 只会原地更新，不会产生重复卡片。
 */
export function reconcileAssetListView({ list, request, rows, rowByAssetId, afterCursorRowIds = [], project = "default" }) {
  const sort = request?.stackId ? "manual" : String(request?.sort || "newest");
  // searchKind（类型意图搜索）按相关性排序，位置无法在客户端复现；
  // 普通 FTS/LIKE 搜索只过滤不重排（服务端 _search_score 恒为 1），可正常插入。
  const rankedSearch = (Array.isArray(rows) ? rows : []).some((row) => (
    row?.node_sort?.searchScore != null && Number(row.node_sort.searchScore) !== 1
  ));
  const canPlace = !rankedSearch;

  const deferredIds = new Set(Array.isArray(afterCursorRowIds) ? afterCursorRowIds.map(String) : []);
  const normalizedRows = (Array.isArray(rows) ? rows : []).filter((row) => !deferredIds.has(String(row?.id || "")));
  const indexById = new Map(list.map((asset, index) => [asset.id, index]));
  const freshById = new Map(normalizedRows.map((row) => [row.id, row]));
  // 受影响集合 = 映射的键（受影响资产 id）∪ 值（它们映射到的节点行 id）。
  // 折叠视图里多个成员映射到同一个节点行：不在 fresh rows 里的已加载 id
  // （被折叠掉的成员、消失的节点）都要移除。
  const affectedIds = new Set();
  for (const [assetId, rowId] of Object.entries(rowByAssetId || {})) {
    affectedIds.add(String(assetId));
    affectedIds.add(String(rowId));
  }

  const removedIds = [];
  for (const rowId of affectedIds) {
    if (indexById.has(rowId) && !freshById.has(rowId)) removedIds.push(rowId);
  }
  // A row that moved beyond the immutable pagination boundary must leave the
  // loaded prefix now. The existing nextCursor remains valid because it
  // represents the boundary tuple, not the continued existence of its row;
  // the moved item will naturally reappear on a later append after that cursor.
  for (const rowId of deferredIds) {
    if (indexById.has(rowId) && !removedIds.includes(rowId)) removedIds.push(rowId);
  }

  const updatedIds = [];
  const insertedRows = [];
  const repositionIds = [];
  let nextList = list.slice();
  for (const row of normalizedRows) {
    const index = indexById.get(row.id);
    if (index === undefined) {
      insertedRows.push(row);
      continue;
    }
    const previous = nextList[index];
    const contentChanged = galleryRowSignature(previous, project) !== galleryRowSignature(row, project);
    const orderChanged = compareGalleryNodeOrder(previous, row, sort) !== 0;
    nextList[index] = row;
    if (orderChanged && canPlace) repositionIds.push(row.id);
    else if (contentChanged) updatedIds.push(row.id);
  }

  if (removedIds.length) {
    const removedSet = new Set(removedIds);
    nextList = nextList.filter((asset) => !removedSet.has(asset.id));
  }
  if (repositionIds.length) {
    const movingIds = new Set(repositionIds);
    const movingRows = new Map(normalizedRows.filter((row) => movingIds.has(row.id)).map((row) => [row.id, row]));
    nextList = nextList.filter((asset) => !movingIds.has(asset.id));
    // 按服务端返回顺序重插，保证多重定位时相对顺序与服务器一致。
    for (const row of normalizedRows) {
      if (movingRows.has(row.id)) insertSorted(nextList, row, sort);
    }
  }

  const insertedIds = [];
  let skippedInsertCount = 0;
  const presentIds = new Set(nextList.map((asset) => asset.id));
  for (const row of insertedRows) {
    if (!canPlace) {
      skippedInsertCount += 1;
      continue;
    }
    if (presentIds.has(row.id)) continue;
    insertSorted(nextList, row, sort);
    presentIds.add(row.id);
    insertedIds.push(row.id);
  }

  return {
    list: nextList,
    updatedIds,
    removedIds,
    insertedIds,
    repositionIds,
    boundaryDeferredIds: [...deferredIds],
    skippedInsertCount,
    // Moving an already-loaded row across the pagination boundary changes the
    // loaded prefix, not the result-set total. Neutralize that local removal;
    // an authoritative lightweight total refresh follows structural changes.
    totalDelta: insertedIds.length + skippedInsertCount - removedIds.length
      + removedIds.filter((id) => deferredIds.has(id)).length,
  };
}

export function createLibraryReconciler({
  state,
  apiFetch,
  currentAssetRequest,
  assetRequestKey,
  assetListVersion,
  getBaselineRevision,
  setBaselineRevision,
  fetchLibraryChanges,
  loadStats,
  performFullReconciliation,
  commitGalleryChanges,
  gallerySelection,
  renderDetail,
  isDetailEditorActive,
  refreshSelectedStackInspector,
  refreshSelectedGenerationHistory,
  syncViewerAfterGalleryChanges,
  refreshPageTotal,
  resetAssetPrefetch,
} = {}) {
  // 所有 delta 应用串行化：SSE 事件、轮询恢复、自发起 mutation 的本地 reconcile
  // 共用一条 promise 链，避免 append/切换视图与 reconcile 交错写 state。
  let applyChain = Promise.resolve();
  const enqueue = (task) => {
    const run = applyChain.then(task, task);
    applyChain = run.then(() => {}, () => {});
    return run;
  };

  function rootView() {
    const root = state.stackReturnSnapshot?.rootView;
    return state.activeStackId && root && !root.degraded ? root : null;
  }

  function activeRequestUnchanged(requestAtStart) {
    return assetRequestKey(requestAtStart) === assetRequestKey(currentAssetRequest());
  }

  async function fetchGalleryRows(request, assetIds, boundaryCursor = null) {
    const rowsById = new Map();
    const rowByAssetId = {};
    const afterCursorRowIds = new Set();
    const body = {
      project: request.project,
      request: {
        query: request.query || "",
        scope: request.scope || "all",
        mediaKind: request.mediaKind || "all",
        facets: { ...(request.facets || {}) },
        sort: request.stackId ? "manual" : request.sort,
        stackId: request.stackId || "",
        view: request.stackId ? "" : "gallery",
        boundaryCursor: boundaryCursor || "",
      },
    };
    for (let offset = 0; offset < assetIds.length; offset += GALLERY_ROWS_CHUNK_SIZE) {
      const chunk = assetIds.slice(offset, offset + GALLERY_ROWS_CHUNK_SIZE);
      const result = await apiFetch("/api/gallery-rows", { method: "POST", body: { ...body, assetIds: chunk } });
      for (const row of result?.rows || []) {
        if (!rowsById.has(row.id)) rowsById.set(row.id, row);
      }
      Object.assign(rowByAssetId, result?.rowByAssetId || {});
      for (const rowId of result?.afterCursorRowIds || []) afterCursorRowIds.add(String(rowId));
    }
    return { rows: [...rowsById.values()], rowByAssetId, afterCursorRowIds: [...afterCursorRowIds] };
  }

  function collectAffectedAssetIds(classified) {
    const ids = new Set();
    for (const [assetId, event] of classified.assetEvents) {
      if (event.kinds.size) ids.add(assetId);
    }
    for (const event of classified.stackEvents.values()) {
      for (const assetId of event.assetIds) ids.add(assetId);
    }
    for (const change of classified.groupEvents) {
      for (const assetId of Array.isArray(change.assetIds) ? change.assetIds : []) ids.add(String(assetId));
    }
    return ids;
  }

  async function reconcileTarget(target, classified) {
    const list = target.kind === "root" ? target.root.assets : state.assets;
    const sourceVersion = typeof assetListVersion === "function" ? assetListVersion(list) : list;
    const affectedIds = collectAffectedAssetIds(classified);
    // Stack 事件的受影响行是其节点行（封面 id）；当前列表里已加载的该 Stack
    // 节点也要一并取回，才能更新 count/match_count/封面。
    for (const asset of list) {
      const stackId = asset?.stack?.id;
      if (stackId && classified.stackEvents.has(stackId)) affectedIds.add(asset.id);
    }
    if (!affectedIds.size) return { changed: false };
    const boundaryCursor = target.kind === "root" ? target.root.nextCursor : state.nextCursor;
    const fetched = await fetchGalleryRows(target.request, [...affectedIds], boundaryCursor);
    const outcome = reconcileAssetListView({
      list,
      request: target.request,
      rows: fetched.rows,
      rowByAssetId: fetched.rowByAssetId,
      afterCursorRowIds: fetched.afterCursorRowIds,
      project: target.request.project,
    });
    return { changed: true, outcome, sourceVersion };
  }

  function activeListUnchanged(sourceVersion) {
    return typeof assetListVersion === "function"
      ? assetListVersion(state.assets) === sourceVersion
      : state.assets === sourceVersion;
  }

  function postReconcileActive(outcome, classified) {
    // 选择剪枝：只移除真正被删除的 id，多选保留其余（四十五）。
    for (const assetId of classified.deletedAssetIds) {
      if (state.selectedIds instanceof Set && state.selectedIds.has(assetId)) {
        gallerySelection?.toggle?.(assetId, { announce: false });
      }
    }
    if (state.selectedId && classified.deletedAssetIds.has(state.selectedId)) {
      state.selectedId = null;
      if (state.detailOpen && !isDetailEditorActive?.()) renderDetail?.();
    } else if (state.selectedId && outcome?.updatedIds?.includes(state.selectedId)) {
      const fresh = state.assets.find((asset) => asset.id === state.selectedId);
      if (fresh && state.detailAsset?.id === fresh.id) {
        state.detailAsset = fresh;
        if (state.detailOpen && !isDetailEditorActive?.()) renderDetail?.();
      }
    }
    if (classified.stackEvents.size) void refreshSelectedStackInspector?.();
    syncViewerAfterGalleryChanges?.(outcome, classified);
  }

  /**
   * Another window may have renamed, merged, or deleted the group the active
   * view is filtered by. The journal detail says where the members went, so
   * the facet is redirected before the request snapshot is taken:
   * - rename: same members, same filter semantics → rewrite the facet (and the
   *   pending stack-return snapshot) and let the normal row reconcile run;
   * - merge: the result set widens to the surviving group's own members;
   * - delete: the result set collapses. Both of those change the whole view,
   *   not just the affected rows, so the caller recovers through the
   *   full-reload path with the corrected facet already in place.
   */
  function redirectActiveGroupFilter(classified) {
    if (!classified.groupEvents.length) return { reload: false };
    const activeGroup = String(state.facets?.group || "");
    if (!activeGroup) return { reload: false };
    const root = rootView();
    for (const change of classified.groupEvents) {
      if (String(change.entityId || "") !== activeGroup) continue;
      if (change.kind === "group-renamed" && change.detail?.to) {
        state.facets.group = String(change.detail.to);
        if (root?.request?.facets?.group === activeGroup) root.request.facets.group = String(change.detail.to);
        return { reload: false };
      }
      if (change.kind === "group-deleted") {
        state.facets.group = change.detail?.mergedInto ? String(change.detail.mergedInto) : "";
        return { reload: true };
      }
    }
    return { reload: false };
  }

  async function applyChangesInner({ changes, revision, complete, commit = true } = {}) {
    const baseline = getBaselineRevision();
    if (revision != null && String(revision) === String(baseline)) return true;
    if (complete === false) return performFullRecovery(revision);

    const classified = classifyLibraryChanges(changes);
    const hasEntities = classified.assetEvents.size || classified.stackEvents.size || classified.groupEvents.length;
    const generationDirty = classified.generationAssetIds.size > 0;
    if (!hasEntities && !generationDirty && !classified.unclassified) {
      if (revision != null) setBaselineRevision(revision);
      return true;
    }
    if (classified.unclassified) return performFullRecovery(revision);

    const redirect = redirectActiveGroupFilter(classified);
    if (redirect.reload) return performFullRecovery(revision);
    const requestAtStart = currentAssetRequest();
    const targets = [];
    // 初始加载未完成的视图由 loadAssets 的正常路径负责（会带上最新 revision）。
    if (state.galleryStatus === "ready") targets.push({ kind: "active", request: requestAtStart });
    const root = rootView();
    if (root) targets.push({ kind: "root", root, request: { ...root.request } });

    let activeOutcome = null;
    let statsDirty = classified.statsDirty;
    for (const target of targets) {
      let result = await reconcileTarget(target, classified);
      if (!result.changed) continue;
      if (target.kind === "active") {
        // 等待期间用户已切换查询语义：丢弃 DOM 提交（新视图数据已晚于这些变化），
        // 但 revision 仍推进，避免旧 delta 反复重放。
        if (!activeRequestUnchanged(requestAtStart)) continue;
        // Pagination append owns the same `state.assets` list but runs outside
        // this reconciliation queue. If it commits while gallery-row fetches
        // are in flight, recompute against the newer list instead of replacing
        // the append with a stale snapshot. A continuously moving target falls
        // back to the authoritative recovery path rather than advancing the
        // revision on an uncertain local state.
        let retries = 0;
        while (!activeListUnchanged(result.sourceVersion) && retries < 3) {
          if (!activeRequestUnchanged(requestAtStart)) break;
          result = await reconcileTarget(target, classified);
          retries += 1;
        }
        if (!activeRequestUnchanged(requestAtStart)) continue;
        if (!activeListUnchanged(result.sourceVersion)) return performFullRecovery(revision);
        state.assets = result.outcome.list;
        // loadedAssetCount 只描述 root 已加载窗口大小；Stack 视图内的
        // state.assets 是成员列表，不得覆盖它（Stack 退出依赖该值）。
        if (!state.activeStackId) state.loadedAssetCount = result.outcome.list.length;
        activeOutcome = result.outcome;
        if (Number.isFinite(state.pageTotal) && state.pageTotal > 0) {
          state.pageTotal = Math.max(0, state.pageTotal + result.outcome.totalDelta);
        }
      } else {
        target.root.assets = result.outcome.list;
        target.root.pageTotal = Math.max(0, Number(target.root.pageTotal || 0) + result.outcome.totalDelta);
      }
    }

    if (commit && activeOutcome) {
      const structuralChange = activeOutcome.insertedIds.length
        || activeOutcome.removedIds.length
        || activeOutcome.repositionIds.length
        || activeOutcome.skippedInsertCount
        || activeOutcome.boundaryDeferredIds?.length;
      if (structuralChange && state.nextCursor) resetAssetPrefetch?.();
      commitGalleryChanges?.(activeOutcome, classified);
      postReconcileActive(activeOutcome, classified);
      if (structuralChange) void refreshPageTotal?.();
    }
    if (statsDirty) void loadStats?.({ background: true });
    if (generationDirty && state.selectedId && classified.generationAssetIds.has(state.selectedId)) {
      void refreshSelectedGenerationHistory?.();
    }

    // Stack 内逗留期间，把原始变化排队到 root 快照，退出时统一回放（二十二）。
    const pendingRoot = state.activeStackId ? state.stackReturnSnapshot?.rootView : null;
    if (pendingRoot) {
      pendingRoot.pending = Array.isArray(pendingRoot.pending) ? pendingRoot.pending : [];
      pendingRoot.pending.push(...(Array.isArray(changes) ? changes : []));
      if (pendingRoot.pending.length > ROOT_SNAPSHOT_PENDING_LIMIT) pendingRoot.degraded = true;
    }

    if (revision != null) setBaselineRevision(revision);
    return true;
  }

  async function performFullRecovery(revision) {
    // journal gap / 未分类变更：全量恢复是最后手段。Stack 内逗留时 root 快照
    // 同步标记为 degraded，退出时走完整重载而不是回放不完整的 pending。
    const root = state.stackReturnSnapshot?.rootView;
    if (root && state.activeStackId) root.degraded = true;
    const recovered = await performFullReconciliation?.();
    if (recovered === false) return false;
    await loadStats?.({ background: true });
    if (revision != null) setBaselineRevision(revision);
    void refreshSelectedStackInspector?.();
    return true;
  }

  function applyChangeDelta(payload) {
    return enqueue(() => applyChangesInner(payload));
  }

  // SSE library-changed：优先直接应用事件携带的 delta；发现与本地 baseline 不
  // 连续（漏事件/重连/隐藏期）时改用权威 delta API 补齐。
  function handleLibraryEventPayload(payload) {
    const baseline = getBaselineRevision();
    if (payload?.revision == null || String(payload.revision) === String(baseline)) return Promise.resolve(true);
    const baselineNumber = parseRevisionNumber(baseline);
    const fromNumber = parseRevisionNumber(payload.fromRevision);
    const targetNumber = parseRevisionNumber(payload.revision);
    const contiguous = baselineNumber != null
      && fromNumber === baselineNumber
      && targetNumber != null
      && targetNumber > baselineNumber
      && Array.isArray(payload.changes)
      && payload.complete !== false;
    if (contiguous) return applyChangeDelta({ changes: payload.changes, revision: payload.revision, complete: true });
    return reconcileToRevision(payload.revision);
  }

  // 权威恢复路径：/api/library-changes?since=baseline。任何失败保留现有画廊、
  // 不推进 baseline，等待下一次 SSE / 轮询 / 可见性恢复重试（五十）。
  function reconcileToRevision(targetRevision) {
    return enqueue(async () => {
      const baseline = getBaselineRevision();
      if (targetRevision == null || String(targetRevision) === String(baseline)) return true;
      try {
        const delta = await fetchLibraryChanges(baseline);
        if (!delta || String(delta.revisionToken ?? "") === String(baseline)) return true;
        // SQLite's revision token also carries PRAGMA data_version. If that
        // suffix changed while the durable journal counter did not, a writer
        // bypassed the store/journal. We detected a real mutation but have no
        // typed delta for it, so fail closed to the explicit full-recovery path
        // instead of advancing the baseline with a stale gallery.
        const baselineNumber = parseRevisionNumber(baseline);
        const targetNumber = parseRevisionNumber(delta.revisionToken);
        if (baselineNumber != null && targetNumber === baselineNumber
          && String(delta.revisionToken) !== String(baseline)) {
          return await performFullRecovery(delta.revisionToken);
        }
        return await applyChangesInner({
          changes: delta.changes,
          revision: delta.revisionToken,
          complete: delta.complete,
        });
      } catch {
        return false;
      }
    });
  }

  // 自发起 mutation 的本地快捷路径：前端已知受影响实体时立即 reconcile，
  // 不等待 SSE。与随后到达的 SSE delta 天然幂等。
  function applyLocalChanges(changes, { commit = true } = {}) {
    return applyChangeDelta({ changes, revision: null, complete: true, commit });
  }

  // Stack 退出回放：宿主已把 root 快照换回 state（且 request 字段已恢复），
  // 把逗留期间积压的 pending changes 作为本地 delta 应用到当前视图。
  // 提交阶段由宿主自己 renderGrid 完成，这里只做数据 reconcile。
  // rootView 允许显式传入：exitStack 在回放前已清空 stackReturnSnapshot。
  async function applyRootSnapshotPendingChanges(rootViewOverride = null) {
    return enqueue(async () => {
      const root = rootViewOverride || state.stackReturnSnapshot?.rootView;
      if (!root) return true;
      const pending = Array.isArray(root.pending) ? root.pending : [];
      root.pending = [];
      if (!pending.length) return true;
      return applyChangesInner({ changes: pending, revision: null, complete: true, commit: false });
    });
  }

  return {
    applyChangeDelta,
    handleLibraryEventPayload,
    reconcileToRevision,
    applyLocalChanges,
    applyRootSnapshotPendingChanges,
  };
}
