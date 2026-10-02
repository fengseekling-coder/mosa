// 退出 Stack 与增量同步交错时，根视图不能丢变化（原任务 26）。
//
// CI 现场（PR #110，macOS）：S5 是 Stack 封面，在 Stack 内移出 S5 后点「返回」，
// 根视图只有 S6、S5、S2、S1——缺的是 Stack 节点（新封面 S3），不是 S5。
// 1. 本地变化只带被移出的 S5：root 快照里行 id 为 S5 的 Stack 节点被 S5 的
//    独立行替换，新封面 S3 没有被请求。
// 2. 服务端推送的同一变化带着 [S5, S3]，但这个任务在 Stack 内开始、在退出之后
//    才结束：active 提交被跳过、root 结果写进已换出的快照对象、pending 也因
//    activeStackId 已清空被跳过，baseline 却推进了——S3 再也没人补上。
import assert from "node:assert/strict";
import test from "node:test";
import { createLibraryReconciler } from "../web/app/library-reconciliation.mjs";
import { createAssetStackController } from "../web/app/asset-stacks.mjs";

const STACK = "stack-1";
const ROOT_REQUEST = { project: "default", query: "", scope: "all", mediaKind: "all", facets: {}, sort: "newest", stackId: "" };

function row(id, day, extra = {}) {
  const createdAt = `2026-01-0${day}`;
  return { id, project_id: "default", node_sort: { createdAt, sortName: `${id}-name`, searchScore: null }, updated_at: createdAt, ...extra };
}

// 服务端在移出提交之后的真实状态：S5 是独立行，Stack 节点由新封面 S3 代表。
const ROOT_ROWS = {
  s5: row("s5", 5),
  s3: row("s3", 3, { stack: { id: STACK, count: 2, name: "S-Stack" } }),
};
const STACK_ROWS = { s3: row("s3", 3, { stack_position: 0 }), s4: row("s4", 4, { stack_position: 1 }) };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createSyncHarness({ holdStackRows = null } = {}) {
  const state = {
    project: "default",
    assets: [],
    pageTotal: 0,
    nextCursor: null,
    loadedPageCount: 1,
    loadedAssetCount: 0,
    selectedId: null,
    selectedIds: new Set(),
    selectedStackNodes: new Map(),
    detailAsset: null,
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
  const calls = { galleryRows: [], fullReloads: 0 };
  let baseline = "13";
  const reconciler = createLibraryReconciler({
    state,
    apiFetch: async (path, options = {}) => {
      if (path !== "/api/gallery-rows") throw new Error(`Unexpected apiFetch: ${path}`);
      const body = options.body;
      calls.galleryRows.push(body);
      const ids = body.assetIds;
      if (body.request.stackId) {
        if (holdStackRows) await holdStackRows.promise;
        return { rows: ids.filter((id) => STACK_ROWS[id]).map((id) => STACK_ROWS[id]), rowByAssetId: Object.fromEntries(ids.map((id) => [id, id])) };
      }
      return { rows: ids.filter((id) => ROOT_ROWS[id]).map((id) => ROOT_ROWS[id]), rowByAssetId: Object.fromEntries(ids.map((id) => [id, id])) };
    },
    currentAssetRequest: () => ({ ...ROOT_REQUEST, sort: state.activeStackId ? "manual" : state.sort, stackId: state.activeStackId || "" }),
    assetRequestKey: (request) => JSON.stringify([request.project, request.stackId || "", request.query, request.scope, request.mediaKind || "all", request.sort]),
    assetListVersion: (assets) => assets.map((asset) => `${asset.id}:${asset.updated_at || ""}`).join("|"),
    getBaselineRevision: () => baseline,
    setBaselineRevision: (revision) => { baseline = String(revision); },
    fetchLibraryChanges: async () => null,
    loadStats: async () => true,
    assetVersion: (asset) => (asset ? `${asset.id}:${asset.updated_at || ""}` : ""),
    performFullReconciliation: async () => { calls.fullReloads += 1; return true; },
    commitGalleryChanges: () => {},
    gallerySelection: { removeIds: () => {} },
    renderDetail: () => {},
    isDetailEditorActive: () => false,
    refreshSelectedStackInspector: () => {},
    syncViewerAfterGalleryChanges: () => {},
    refreshPageTotal: async () => true,
    resetAssetPrefetch: () => {},
  });
  return { state, reconciler, calls, getBaseline: () => baseline };
}

// 已经在 Stack 内：root 快照保存了进入前的根窗口，Stack 节点行 id 是旧封面 S5。
function enterStack(state, rootAssets) {
  state.activeStackId = STACK;
  state.stackReturnSnapshot = {
    rootView: {
      request: { ...ROOT_REQUEST },
      assets: rootAssets,
      pageTotal: rootAssets.length,
      nextCursor: null,
      loadedPageCount: 1,
      loadedAssetCount: rootAssets.length,
      pending: [],
      degraded: false,
    },
  };
  state.assets = [STACK_ROWS.s3, STACK_ROWS.s4];
}

// 与 asset-stacks.mjs 的 exitStack + restoreRootFromSnapshot 同序：先在串行链外
// 同步换回 root 窗口，再把回放排到链尾。
function exitStack(state, reconciler) {
  const root = state.stackReturnSnapshot.rootView;
  state.activeStackId = "";
  state.stackReturnSnapshot = null;
  state.assets = root.assets;
  return reconciler.applyRootSnapshotPendingChanges(root);
}

test("a delta that starts inside a Stack and finishes after exit still reaches the root replay", async () => {
  const hold = deferred();
  const harness = createSyncHarness({ holdStackRows: hold });
  const { state, reconciler } = harness;
  // 根窗口已经是"本地变化只带 S5"之后的样子：Stack 节点被 S5 独立行替换。
  enterStack(state, [row("s6", 6), ROOT_ROWS.s5, row("s2", 2), row("s1", 1)]);
  state.stackReturnSnapshot.rootView.pending.push({ kind: "stack-members-changed", entityType: "stack", entityId: STACK, assetIds: ["s5"] });

  // 服务端推送的同一变化带新旧封面；它的 Stack 视图请求在途时用户点了返回。
  const delta = reconciler.applyChangeDelta({
    changes: [{ revision: 14, kind: "stack-cover-changed", entityType: "stack", entityId: STACK, assetIds: ["s5", "s3"] }],
    revision: "14",
    complete: true,
  });
  while (!harness.calls.galleryRows.length) await new Promise((done) => setImmediate(done));
  const replay = exitStack(state, reconciler);
  hold.resolve();
  assert.equal(await delta, true);
  assert.equal(await replay, true);

  const ids = state.assets.map((asset) => asset.id);
  assert.ok(ids.includes("s3"), `the Stack node (new cover S3) is back at root: ${JSON.stringify(ids)}`);
  assert.ok(ids.includes("s5"), `the removed member S5 is a root row: ${JSON.stringify(ids)}`);
  assert.equal(new Set(ids).size, ids.length, "no duplicate rows");
  assert.equal(state.assets.find((asset) => asset.id === "s3")?.stack?.count, 2, "the Stack node shows two members");
  assert.equal(harness.getBaseline(), "14");
  assert.equal(harness.calls.fullReloads, 0, "recovered through the replay, not a full reload");
});

test("removing the Stack cover asks for the previous and the new cover in the local change", async () => {
  const state = {
    project: "default",
    activeStackId: STACK,
    activeStackSummary: { id: STACK, cover_asset_id: "s5", count: 3 },
    selectedIds: new Set(["s5"]),
  };
  const localChanges = [];
  const controller = createAssetStackController({
    els: {},
    state,
    apiFetch: async () => ({ dissolved: false, remainingAssetId: null, stack: { id: STACK, cover_asset_id: "s3", count: 2 } }),
    librarySync: { applyLocalChanges: async (changes) => { localChanges.push(...changes); return true; } },
    gallerySelection: { clear: () => {}, syncRenderedSelection: () => {} },
    showToast: () => {},
    t: (key) => key,
  });
  assert.equal(await controller.removeSelectedFromStack(), true);
  assert.equal(localChanges.length, 1);
  assert.equal(localChanges[0].entityId, STACK);
  assert.deepEqual([...localChanges[0].assetIds].sort(), ["s3", "s5"],
    "the local change names the removed member, the old cover row and the new cover row");
});
