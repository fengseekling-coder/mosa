// Library Change 增量 reconciliation 数据层的执行型测试。
// createLibraryReconciler 是无 DOM 的依赖注入工厂，这里用受控 stub 驱动完整
// 管线（classify → fetch → reconcile → advance），并锁定本轮最关键的负向契约：
// 普通 Library Change 绝不触发全量已加载窗口重拉。
import assert from "node:assert/strict";
import test from "node:test";
import { createLibraryReconciler, reconcileAssetListView } from "../app/library-reconciliation.mjs";

function row(id, createdAt, extra = {}) {
  return { id, project_id: "default", node_sort: { createdAt, sortName: `${id}-name`, searchScore: null }, updated_at: createdAt, ...extra };
}

function assetVersion(asset) {
  return asset ? `${asset.id}:${asset.updated_at || ""}` : "";
}

/**
 * Reconciler harness：记录每一次 gallery-rows / delta 请求与全量恢复调用，
 * state 驱动完整数据流。`fullReloads` 计数是本轮最关键的负向断言探针。
 */
function createHarness({
  initialAssets = [],
  galleryRows = () => ({ rows: [], rowByAssetId: {} }),
  deltaResponse = null,
  failDeltaFetch = false,
  nextCursor = null,
} = {}) {
  const state = {
    project: "default",
    assets: initialAssets,
    pageTotal: initialAssets.length,
    nextCursor,
    loadedPageCount: Math.max(1, Math.ceil(initialAssets.length / 40)),
    loadedAssetCount: initialAssets.length,
    selectedId: null,
    selectedIds: new Set(),
    selectedStackNodes: new Map(),
    detailAsset: null,
    detailOpen: false,
    detailDirty: false,
    galleryStatus: "ready",
    viewMode: "library",
    activeStackId: "",
    stackReturnSnapshot: null,
    scope: "all",
    query: "",
    sort: "newest",
    mediaKind: "all",
    facets: {},
  };
  const calls = {
    galleryRows: [],
    fullReloads: 0,
    statsRefreshes: 0,
    commits: [],
    prunedSelectionIds: [],
    totalRefreshes: 0,
    prefetchResets: 0,
  };
  let baseline = "1";
  const reconciler = createLibraryReconciler({
    state,
    apiFetch: async (path, options = {}) => {
      if (path === "/api/gallery-rows") {
        calls.galleryRows.push(options.body);
        return galleryRows(options.body);
      }
      throw new Error(`Unexpected apiFetch: ${path}`);
    },
    currentAssetRequest: () => ({
      project: state.project,
      query: state.query,
      scope: state.scope,
      mediaKind: state.mediaKind,
      facets: { ...state.facets },
      sort: state.activeStackId ? "manual" : state.sort,
      stackId: state.activeStackId || "",
    }),
    assetRequestKey: (request) => JSON.stringify([request.project, request.stackId || "", request.query, request.scope, request.mediaKind || "all", request.sort]),
    assetListVersion: (assets) => assets.map((asset) => `${asset.id}:${asset.updated_at || ""}`).join("|"),
    getBaselineRevision: () => baseline,
    setBaselineRevision: (revision) => { baseline = String(revision); },
    fetchLibraryChanges: async () => {
      if (failDeltaFetch) throw new Error("delta unavailable");
      return deltaResponse;
    },
    loadStats: async () => { calls.statsRefreshes += 1; return true; },
    assetVersion,
    performFullReconciliation: async () => { calls.fullReloads += 1; return true; },
    commitGalleryChanges: (outcome) => { calls.commits.push(outcome); },
    gallerySelection: {
      toggle: (id) => {
        state.selectedIds.delete(id);
        calls.prunedSelectionIds.push(id);
      },
    },
    renderDetail: () => {},
    isDetailEditorActive: () => false,
    refreshSelectedStackInspector: () => {},
    syncViewerAfterGalleryChanges: () => {},
    refreshPageTotal: async () => { calls.totalRefreshes += 1; return true; },
    resetAssetPrefetch: () => { calls.prefetchResets += 1; },
  });
  return { state, reconciler, calls, getBaseline: () => baseline, setBaseline: (value) => { baseline = String(value); } };
}

test("reconciliation recomputes against a pagination append that commits while affected rows are in flight", async () => {
  let releaseFirstFetch;
  let fetchCount = 0;
  const firstFetchBlocked = new Promise((resolve) => { releaseFirstFetch = resolve; });
  const harness = createHarness({
    initialAssets: [row("a", "2026-01-01")],
    galleryRows: async () => {
      fetchCount += 1;
      if (fetchCount === 1) await firstFetchBlocked;
      return { rows: [row("a", "2026-02-01")], rowByAssetId: { a: "a" } };
    },
  });
  harness.setBaseline("10");
  const applying = harness.reconciler.applyChangeDelta({
    changes: [{ revision: 11, kind: "asset-updated", entityType: "asset", entityId: "a" }],
    revision: "11",
    complete: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.state.assets = [...harness.state.assets, row("b", "2025-12-01")];
  releaseFirstFetch();
  assert.equal(await applying, true);
  assert.equal(fetchCount, 2, "a stale reconciliation snapshot must be recomputed once the append commits");
  assert.deepEqual(harness.state.assets.map((asset) => asset.id), ["a", "b"]);
  assert.equal(harness.state.assets[0].updated_at, "2026-02-01");
  assert.equal(harness.getBaseline(), "11");
});

test("asset-added inserts only the new row and never reloads the loaded window", async () => {
  const harness = createHarness({
    initialAssets: [row("b", "2026-01-01"), row("c", "2025-01-01")],
    galleryRows: () => ({ rows: [row("a", "2026-06-01")], rowByAssetId: { a: "a" } }),
  });
  harness.setBaseline("4");
  const applied = await harness.reconciler.applyChangeDelta({
    changes: [{ revision: 5, kind: "asset-added", entityType: "asset", entityId: "a" }],
    revision: "5",
    complete: true,
  });
  assert.equal(applied, true);
  assert.equal(harness.calls.fullReloads, 0, "a single asset addition must not trigger a full loaded-window reload");
  assert.equal(harness.calls.galleryRows.length, 1);
  assert.deepEqual(harness.calls.galleryRows[0].assetIds, ["a"]);
  assert.deepEqual(harness.state.assets.map((asset) => asset.id), ["a", "b", "c"], "newest sort inserts at the top");
  assert.deepEqual(harness.calls.commits.at(-1).insertedIds, ["a"]);
  assert.equal(harness.getBaseline(), "5", "revision advances only after a successful apply");
  assert.equal(harness.calls.statsRefreshes, 1);
});

test("asset-updated patches the target card in place without any reload", async () => {
  const harness = createHarness({
    initialAssets: [row("a", "2026-01-01"), row("b", "2025-01-01")],
    galleryRows: () => ({ rows: [{ ...row("b", "2025-01-01", { updated_at: "2025-01-02" }), prompt: "changed" }], rowByAssetId: { b: "b" } }),
  });
  await harness.reconciler.applyChangeDelta({
    changes: [{ revision: 2, kind: "asset-updated", entityType: "asset", entityId: "b" }],
    revision: "2",
    complete: true,
  });
  assert.equal(harness.calls.fullReloads, 0);
  assert.deepEqual(harness.state.assets.map((asset) => asset.id), ["a", "b"], "order unchanged");
  assert.equal(harness.state.assets[1].prompt, "changed");
  assert.deepEqual(harness.calls.commits.at(-1).updatedIds, ["b"]);
});

test("batched assets-updated reconciles every derivative id through one affected-row fetch", async () => {
  const harness = createHarness({
    initialAssets: [row("a", "2026-02-01"), row("b", "2026-01-01")],
    galleryRows: (body) => ({
      rows: body.assetIds.map((id) => ({ ...row(id, id === "a" ? "2026-02-01" : "2026-01-01"), thumbnail_url: `/thumb/${id}.webp`, thumbnail_ready: true })),
      rowByAssetId: Object.fromEntries(body.assetIds.map((id) => [id, id])),
    }),
  });
  await harness.reconciler.applyChangeDelta({
    changes: [{ revision: 2, kind: "assets-updated", entityType: "asset-batch", entityId: "derivatives", assetIds: ["a", "b"], flags: ["derivatives"] }],
    revision: "2",
    complete: true,
  });
  assert.equal(harness.calls.fullReloads, 0);
  assert.equal(harness.calls.galleryRows.length, 1, "one batched journal row stays one affected-row request");
  assert.deepEqual(harness.calls.galleryRows[0].assetIds.sort(), ["a", "b"]);
  assert.equal(harness.state.assets.every((asset) => asset.thumbnail_ready), true);
});

test("asset-deleted removes the row, prunes only the deleted selection, and keeps the rest", async () => {
  const harness = createHarness({
    initialAssets: [row("a", "2026-01-01"), row("b", "2025-01-01"), row("c", "2024-01-01")],
    galleryRows: () => ({ rows: [], rowByAssetId: { b: "b" } }),
  });
  harness.state.selectedIds = new Set(["b", "c"]);
  await harness.reconciler.applyChangeDelta({
    changes: [{ revision: 2, kind: "asset-deleted", entityType: "asset", entityId: "b" }],
    revision: "2",
    complete: true,
  });
  assert.equal(harness.calls.fullReloads, 0);
  assert.deepEqual(harness.state.assets.map((asset) => asset.id), ["a", "c"]);
  assert.deepEqual(harness.calls.prunedSelectionIds, ["b"], "multi-selection keeps non-deleted ids");
  assert.equal(harness.state.pageTotal, 2);
});

test("unfavorite inside the favorites scope removes the card from the view", async () => {
  const harness = createHarness({
    initialAssets: [row("a", "2026-01-01", { favorite: true })],
    galleryRows: () => ({ rows: [], rowByAssetId: { a: "a" } }),
  });
  harness.state.scope = "favorite";
  await harness.reconciler.applyChangeDelta({
    changes: [{ revision: 2, kind: "asset-updated", entityType: "asset", entityId: "a", flags: ["favorite"] }],
    revision: "2",
    complete: true,
  });
  assert.equal(harness.calls.fullReloads, 0);
  assert.deepEqual(harness.state.assets.map((asset) => asset.id), [], "card leaves the favorites view");
});

test("restore re-enters the current view at the sorted position", async () => {
  const harness = createHarness({
    initialAssets: [row("b", "2026-01-01")],
    galleryRows: () => ({ rows: [row("a", "2026-06-01")], rowByAssetId: { a: "a" } }),
  });
  await harness.reconciler.applyChangeDelta({
    changes: [{ revision: 2, kind: "asset-restored", entityType: "asset", entityId: "a" }],
    revision: "2",
    complete: true,
  });
  assert.equal(harness.calls.fullReloads, 0);
  assert.deepEqual(harness.state.assets.map((asset) => asset.id), ["a", "b"]);
});

test("stack creation collapses N asset cards into one stack node", async () => {
  const members = ["m1", "m2", "m3"].map((id, index) => row(id, `2026-0${index + 1}-01`));
  const harness = createHarness({
    initialAssets: members,
    galleryRows: () => ({
      rows: [row("m1", "2026-01-01", { stack: { id: "s1", count: 3 } })],
      rowByAssetId: { m1: "m1", m2: "m1", m3: "m1" },
    }),
  });
  await harness.reconciler.applyChangeDelta({
    changes: [{ revision: 2, kind: "stack-created", entityType: "stack", entityId: "s1", assetIds: ["m1", "m2", "m3"] }],
    revision: "2",
    complete: true,
  });
  assert.equal(harness.calls.fullReloads, 0);
  assert.deepEqual(harness.state.assets.map((asset) => asset.id), ["m1"], "one logical stack node replaces the members");
  assert.equal(harness.state.assets[0].stack.count, 3);
  assert.equal(harness.state.pageTotal, 1);
});

test("stack dissolution expands the node back into member rows", async () => {
  const harness = createHarness({
    initialAssets: [row("m1", "2026-01-01", { stack: { id: "s1", count: 2 } })],
    galleryRows: () => ({
      rows: [row("m2", "2026-02-01"), row("m1", "2026-01-01")],
      rowByAssetId: { m1: "m1", m2: "m2" },
    }),
  });
  await harness.reconciler.applyChangeDelta({
    changes: [{ revision: 2, kind: "stack-dissolved", entityType: "stack", entityId: "s1", assetIds: ["m1", "m2"] }],
    revision: "2",
    complete: true,
  });
  assert.equal(harness.calls.fullReloads, 0);
  assert.deepEqual(harness.state.assets.map((asset) => asset.id), ["m2", "m1"]);
  assert.equal(harness.state.assets[0].stack, undefined);
});

test("stack cover change refreshes only the stack card", async () => {
  const harness = createHarness({
    initialAssets: [
      row("old-cover", "2026-01-01", { stack: { id: "s1", count: 2 } }),
      row("other", "2025-01-01"),
    ],
    galleryRows: () => ({
      rows: [row("new-cover", "2026-03-01", { stack: { id: "s1", count: 2 } })],
      rowByAssetId: { "new-cover": "new-cover", "old-cover": "new-cover" },
    }),
  });
  await harness.reconciler.applyChangeDelta({
    changes: [{ revision: 2, kind: "stack-cover-changed", entityType: "stack", entityId: "s1", assetIds: ["new-cover", "old-cover"] }],
    revision: "2",
    complete: true,
  });
  assert.equal(harness.calls.fullReloads, 0);
  assert.deepEqual(harness.state.assets.map((asset) => asset.id), ["new-cover", "other"], "old cover card replaced by the new stack node");
});

test("delta application is idempotent when the same batch is replayed", async () => {
  const harness = createHarness({
    initialAssets: [row("b", "2026-01-01")],
    galleryRows: () => ({ rows: [row("a", "2026-06-01")], rowByAssetId: { a: "a" } }),
  });
  const payload = {
    changes: [{ revision: 2, kind: "asset-added", entityType: "asset", entityId: "a" }],
    revision: "2",
    complete: true,
  };
  await harness.reconciler.applyChangeDelta({ ...payload });
  await harness.reconciler.applyChangeDelta({ ...payload, revision: null });
  assert.deepEqual(harness.state.assets.map((asset) => asset.id), ["a", "b"], "no duplicate cards");
  assert.equal(harness.state.pageTotal, 2, "no double total accounting");
});

test("hidden or reconnect gaps recover through the delta API and advance the baseline", async () => {
  const harness = createHarness({
    initialAssets: [row("b", "2026-01-01")],
    deltaResponse: {
      revisionToken: "9:1",
      currentRevision: 9,
      complete: true,
      changes: [{ revision: 5, kind: "asset-added", entityType: "asset", entityId: "a" }],
    },
    galleryRows: () => ({ rows: [row("a", "2026-06-01")], rowByAssetId: { a: "a" } }),
  });
  harness.setBaseline("4:0");
  const applied = await harness.reconciler.reconcileToRevision("9:1");
  assert.equal(applied, true);
  assert.equal(harness.calls.fullReloads, 0, "a recoverable delta gap never degrades into a full reload");
  assert.deepEqual(harness.state.assets.map((asset) => asset.id), ["a", "b"]);
  assert.equal(harness.getBaseline(), "9:1");
});

test("a non-contiguous SSE payload falls back to the authoritative delta fetch", async () => {
  const harness = createHarness({
    initialAssets: [row("b", "2026-01-01")],
    deltaResponse: {
      revisionToken: "12",
      currentRevision: 12,
      complete: true,
      changes: [{ revision: 11, kind: "asset-deleted", entityType: "asset", entityId: "b" }],
    },
    galleryRows: () => ({ rows: [], rowByAssetId: { b: "b" } }),
  });
  harness.setBaseline("8");
  const applied = await harness.reconciler.handleLibraryEventPayload({
    revision: "12",
    fromRevision: "11",
    complete: true,
    changes: [{ revision: 12, kind: "asset-updated", entityType: "asset", entityId: "zz" }],
  });
  assert.equal(applied, true);
  assert.deepEqual(harness.state.assets.map((asset) => asset.id), [], "the gap (9-11) was recovered from the journal, not the event");
  assert.equal(harness.getBaseline(), "12");
});

test("a pruned journal (complete: false) is the only path that falls back to a full reload", async () => {
  const harness = createHarness({
    initialAssets: [row("b", "2026-01-01")],
    galleryRows: () => ({ rows: [], rowByAssetId: {} }),
  });
  const applied = await harness.reconciler.applyChangeDelta({
    changes: [],
    revision: "40",
    complete: false,
  });
  assert.equal(applied, true);
  assert.equal(harness.calls.fullReloads, 1, "delta gap falls back to full reconciliation exactly once");
  assert.equal(harness.getBaseline(), "40", "fallback advances the baseline after success");
});

test("unclassified changes fall back to a bounded recovery instead of being dropped", async () => {
  const harness = createHarness({ initialAssets: [row("b", "2026-01-01")] });
  await harness.reconciler.applyChangeDelta({
    changes: [{ revision: 2, kind: "library-changed", entityType: "library", entityId: "" }],
    revision: "2",
    complete: true,
  });
  assert.equal(harness.calls.fullReloads, 1);
  assert.equal(harness.getBaseline(), "2");
});

test("a failed delta fetch keeps the gallery and the baseline for a later retry", async () => {
  const harness = createHarness({
    initialAssets: [row("b", "2026-01-01")],
    failDeltaFetch: true,
  });
  const applied = await harness.reconciler.reconcileToRevision("9");
  assert.equal(applied, false, "failure must not pretend the delta was applied");
  assert.equal(harness.getBaseline(), "1", "baseline stays so the next event/poll retries");
  assert.deepEqual(harness.state.assets.map((asset) => asset.id), ["b"], "existing gallery is untouched");
  assert.equal(harness.calls.fullReloads, 0);
});

test("data_version-only revision changes fail closed to full recovery instead of advancing an empty delta", async () => {
  const harness = createHarness({
    initialAssets: [row("a", "2026-01-01")],
    deltaResponse: {
      revisionToken: "7:2",
      currentRevision: 7,
      complete: true,
      changes: [],
    },
  });
  harness.setBaseline("7:1");
  const applied = await harness.reconciler.reconcileToRevision("7:2");
  assert.equal(applied, true);
  assert.equal(harness.calls.fullReloads, 1, "an out-of-band SQLite write has no typed delta and must recover explicitly");
  assert.equal(harness.getBaseline(), "7:2");
});

test("changes are ignored when the request semantics changed mid-flight but the baseline still advances", async () => {
  let fetchCount = 0;
  const harness = createHarness({
    initialAssets: [row("b", "2026-01-01")],
    galleryRows: () => {
      fetchCount += 1;
      // 模拟 fetch 期间用户切换了查询语义。
      harness.state.query = "switched";
      return { rows: [row("a", "2026-06-01")], rowByAssetId: { a: "a" } };
    },
  });
  const applied = await harness.reconciler.applyChangeDelta({
    changes: [{ revision: 2, kind: "asset-added", entityType: "asset", entityId: "a" }],
    revision: "2",
    complete: true,
  });
  assert.equal(applied, true);
  assert.equal(fetchCount, 1);
  assert.equal(harness.calls.fullReloads, 0);
  assert.deepEqual(harness.state.assets.map((asset) => asset.id), ["b"], "stale delta does not commit into the switched view");
  assert.equal(harness.getBaseline(), "2", "the freshly-loading view already supersedes the delta");
});

test("changes landing inside a stack update the stack view and queue the root snapshot replay", async () => {
  const stackMemberRows = [row("m1", "2026-01-01", { stack_position: 0 }), row("m2", "2026-02-01", { stack_position: 1 })];
  const harness = createHarness({
    initialAssets: [row("root1", "2026-05-01")],
    galleryRows: (body) => {
      if (body.request.stackId === "s1") {
        return { rows: [stackMemberRows[0]], rowByAssetId: { m1: "m1", m2: "m1" } };
      }
      return { rows: [row("root1", "2026-05-01", { stack: { id: "s1", count: 2 } })], rowByAssetId: { m1: "root1", m2: "root1" } };
    },
  });
  // 进入 Stack：root 数据窗口保存于快照，state.assets 切换为成员列表。
  harness.state.activeStackId = "s1";
  harness.state.stackReturnSnapshot = {
    rootView: {
      request: { project: "default", query: "", scope: "all", mediaKind: "all", facets: {}, sort: "newest", stackId: "" },
      assets: [row("root1", "2026-05-01")],
      pageTotal: 1,
      nextCursor: null,
      loadedPageCount: 1,
      loadedAssetCount: 1,
      pending: [],
      degraded: false,
    },
  };
  harness.state.assets = stackMemberRows.map((asset) => ({ ...asset }));
  harness.state.pageTotal = 2;
  await harness.reconciler.applyChangeDelta({
    changes: [{ revision: 7, kind: "stack-members-changed", entityType: "stack", entityId: "s1", assetIds: ["m2"] }],
    revision: "7",
    complete: true,
  });
  assert.equal(harness.calls.fullReloads, 0);
  assert.deepEqual(harness.state.assets.map((asset) => asset.id), ["m1"], "removed member disappears from the stack view");
  assert.deepEqual(harness.state.stackReturnSnapshot.rootView.assets.map((asset) => asset.id), ["root1"],
    "root snapshot reflects the stack node");
  assert.equal(harness.state.stackReturnSnapshot.rootView.pending.length, 1, "pending queued for exit replay");

  // 退出 Stack：宿主恢复 root 视图并回放 pending（幂等）。
  harness.state.activeStackId = "";
  harness.state.assets = harness.state.stackReturnSnapshot.rootView.assets;
  harness.state.stackReturnSnapshot = { rootView: harness.state.stackReturnSnapshot.rootView };
  const replayed = await harness.reconciler.applyRootSnapshotPendingChanges(harness.state.stackReturnSnapshot.rootView);
  assert.equal(replayed, true);
  assert.equal(harness.calls.fullReloads, 0, "stack exit replays the journal delta instead of re-downloading the root window");
});

test("reconcileAssetListView keeps ranked-search views stable and accounts skipped inserts", () => {
  const list = [row("b", "2026-01-01")];
  const outcome = reconcileAssetListView({
    list,
    request: { sort: "newest", query: "prompt cat" },
    rows: [
      { ...row("n", "2026-06-01"), node_sort: { createdAt: "2026-06-01", sortName: "n", searchScore: 12 } },
      row("b", "2026-01-01"),
    ],
    rowByAssetId: { n: "n", b: "b" },
    assetVersion,
  });
  assert.deepEqual(outcome.list.map((asset) => asset.id), ["b"], "ranked position unknown: no mid-list insert");
  assert.equal(outcome.skippedInsertCount, 1, "skipped inserts still count toward the total");
  assert.equal(outcome.totalDelta, 1);
});

test("pagination boundary stays stable when an already-loaded row moves after nextCursor", async () => {
  const cursor = "stable-boundary";
  const harness = createHarness({
    nextCursor: cursor,
    initialAssets: [row("a", "2026-03-01"), row("b", "2026-02-01"), row("c", "2026-01-01")],
    galleryRows: (body) => {
      assert.equal(body.request.boundaryCursor, cursor, "affected-row fetch carries the current immutable page boundary");
      return {
        rows: [row("b", "2025-01-01", { updated_at: "2026-04-01" })],
        rowByAssetId: { b: "b" },
        afterCursorRowIds: ["b"],
      };
    },
  });
  await harness.reconciler.applyChangeDelta({
    changes: [{ revision: 2, kind: "asset-updated", entityType: "asset", entityId: "b", flags: ["metadata"] }],
    revision: "2",
    complete: true,
  });
  assert.deepEqual(harness.state.assets.map((asset) => asset.id), ["a", "c"],
    "a row that crossed after the keyset boundary leaves the loaded prefix");
  assert.equal(harness.state.nextCursor, cursor, "the server-minted keyset boundary is not guessed or rewritten client-side");
  assert.equal(harness.calls.prefetchResets, 1, "pages prefetched under the old row positions are discarded");
  assert.equal(harness.calls.totalRefreshes, 1, "structural changes reconcile the exact result total with one lightweight query");
  assert.equal(harness.calls.fullReloads, 0);
});

test("a changed row already after nextCursor is not pulled into the loaded prefix", async () => {
  const harness = createHarness({
    nextCursor: "stable-boundary",
    initialAssets: [row("a", "2026-03-01"), row("b", "2026-02-01")],
    galleryRows: () => ({
      rows: [row("z", "2020-01-01", { updated_at: "2026-04-01" })],
      rowByAssetId: { z: "z" },
      afterCursorRowIds: ["z"],
    }),
  });
  await harness.reconciler.applyChangeDelta({
    changes: [{ revision: 2, kind: "asset-updated", entityType: "asset", entityId: "z", flags: ["metadata"] }],
    revision: "2",
    complete: true,
  });
  assert.deepEqual(harness.state.assets.map((asset) => asset.id), ["a", "b"],
    "an unloaded row that remains beyond the boundary stays for a later append");
  assert.equal(harness.calls.fullReloads, 0);
});
