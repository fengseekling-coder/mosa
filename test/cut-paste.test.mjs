import assert from "node:assert/strict";
import test from "node:test";

import { createCutPasteController } from "../web/app/cut-paste.mjs";

/**
 * 任务 93：剪切粘贴控制器的行为测试。菜单契约在 context-menu-scenarios，
 * app.mjs 的 ⌘X/⌘V/Esc 接线由前端回归切片测试钉住；这里覆盖控制器本身：
 * 剪切进入/覆盖/取消（Esc 复用 cancelCut、复制取消、失焦取消）、粘贴目标
 * 判定、移动请求形状、成功/失败/空操作的提示与本地增量。
 */

const T = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key);

function createHarness(t, {
  assets = [],
  moveResponse = null,
  moveError = null,
  clipboardFails = false,
} = {}) {
  const originalWindow = globalThis.window;
  const windowListeners = new Map();
  globalThis.window = {
    addEventListener: (type, handler) => {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(handler);
    },
    removeEventListener: (type, handler) => windowListeners.get(type)?.delete(handler),
  };
  t.after(() => { globalThis.window = originalWindow; });

  const state = {
    project: "p",
    scope: "all",
    assets: [...assets],
    activeStackId: "",
    activeStackSummary: null,
    cutAssetIds: new Set(),
    cutProjectId: "",
    locale: "zh",
  };
  const calls = { move: [], clipboard: [], changes: [] };
  const toasts = [];
  const announcements = [];
  const controller = createCutPasteController({
    state,
    els: {
      assetGrid: {
        querySelectorAll: (selector) => {
          assert.equal(selector, ":scope > .asset-card");
          return [];
        },
      },
    },
    t: T,
    apiFetch: async (url, options = {}) => {
      calls.move.push({ url, method: options.method, body: options.body });
      if (moveError) throw moveError;
      return moveResponse;
    },
    showToast: (message, tone = "default") => toasts.push({ message, tone }),
    announceGalleryStatus: (message) => announcements.push(message),
    librarySync: { applyLocalChanges: async (changes) => void calls.changes.push(changes) },
    loadStats: async () => {},
    copyOriginalImage: async (asset) => {
      calls.clipboard.push(asset.id);
      if (clipboardFails) throw new Error("clipboard denied");
    },
  });
  return { controller, state, calls, toasts, announcements, windowListeners, emitBlur: () => windowListeners.get("blur")?.forEach((handler) => handler()) };
}

const asset = (id, extra = {}) => ({ id, project_id: "p", image_path: `/x/${id}.png`, image_url: `/x/${id}.png`, ...extra });

test("剪切进入：集合入 state、播报、系统剪贴板尽力写第一张原图；写失败不影响剪切", async (t) => {
  const failing = createHarness(t, {
    assets: [asset("a"), asset("b")],
    clipboardFails: true,
  });
  assert.equal(await failing.controller.cutAssetIds(["a", "b"]), true);
  assert.deepEqual([...failing.state.cutAssetIds].sort(), ["a", "b"]);
  assert.equal(failing.state.cutProjectId, "p");
  assert.deepEqual(failing.announcements, [T("cutPending", { count: 2 })]);
  assert.deepEqual(failing.calls.clipboard, ["a"], "多张只写第一张");
  assert.ok(failing.controller.isCutActive(), "剪贴板写失败不影响剪切本身");

  const ok = createHarness(t, { assets: [asset("a")] });
  assert.equal(await ok.controller.cutAssetIds(["a"]), true);
  assert.deepEqual(ok.calls.clipboard, ["a"]);
  assert.ok(ok.controller.isCutActive());
});

test("再次剪切覆盖上一次；回收站范围与非本项目拒绝剪切", async (t) => {
  const harness = createHarness(t, { assets: [asset("a"), asset("b"), asset("c")] });
  await harness.controller.cutAssetIds(["a", "b"]);
  await harness.controller.cutAssetIds(["c"]);
  assert.deepEqual([...harness.state.cutAssetIds], ["c"], "再剪切覆盖上一次");

  harness.state.scope = "trash";
  assert.equal(await harness.controller.cutAssetIds(["a"]), false);
  assert.deepEqual([...harness.state.cutAssetIds], ["c"], "回收站里不能发起剪切");

  harness.state.scope = "all";
  assert.equal(await harness.controller.cutAssetIds(["a"], { projectId: "other" }), false);
});

test("取消：cancelCut 清集合并可播报；Esc 走同一路径；项目口径变化视为已取消", async (t) => {
  const harness = createHarness(t, { assets: [asset("a")] });
  await harness.controller.cutAssetIds(["a"]);
  assert.equal(harness.controller.cancelCut({ announce: true }), true);
  assert.equal(harness.state.cutAssetIds.size, 0);
  assert.deepEqual(harness.announcements.at(-1), T("cutCancelled"));
  assert.equal(harness.controller.isCutActive(), false);
  assert.equal(harness.controller.cancelCut(), false, "没有剪切时取消是空操作");

  const project = createHarness(t, { assets: [asset("a")] });
  await project.controller.cutAssetIds(["a"]);
  project.state.project = "elsewhere";
  assert.equal(project.controller.isCutActive(), false, "项目口径变化即视为取消");
});

test("复制取消：应用内写剪贴板（复制图片/提示词）取消剪切；剪切自己的写入除外", async (t) => {
  const harness = createHarness(t, { assets: [asset("a")] });
  await harness.controller.cutAssetIds(["a"]);
  harness.controller.noteClipboardWrite();
  assert.equal(harness.controller.isCutActive(), false, "「复制图片」取消剪切状态");

  const self = createHarness(t, { assets: [asset("a")] });
  await self.controller.cutAssetIds(["a"]);
  assert.ok(self.controller.isCutActive(), "剪切自身的原图写入不取消剪切");
});

test("失焦取消（任务单回退规则）：bind 后窗口 blur 事件取消剪切", async (t) => {
  const harness = createHarness(t, { assets: [asset("a")] });
  await harness.controller.cutAssetIds(["a"]);
  harness.controller.bind();
  harness.emitBlur();
  assert.equal(harness.controller.isCutActive(), false);
});

test("粘贴目标判定：堆叠卡片 → 那个堆叠；堆叠内部 → 当前堆叠；非堆叠视图 → null；回收站拒绝", async (t) => {
  const harness = createHarness(t);
  assert.deepEqual(harness.controller.resolvePasteTarget({ stackId: "s9", stackName: "B" }),
    { kind: "stack", targetStackId: "s9", targetName: "B" });
  harness.state.activeStackId = "s1";
  harness.state.activeStackSummary = { id: "s1", name: "A" };
  assert.deepEqual(harness.controller.resolvePasteTarget({}),
    { kind: "stack", targetStackId: "s1", targetName: "A" });
  harness.state.activeStackId = "";
  assert.deepEqual(harness.controller.resolvePasteTarget({}),
    { kind: "unstack", targetStackId: null, targetName: "" });
  harness.state.scope = "trash";
  assert.equal(harness.controller.resolvePasteTarget({}).kind, "trash", "回收站里不能粘贴");
});

test("粘贴成功（移进堆叠）：请求形状、成功提示带堆叠名、两侧本地增量、剪切取消", async (t) => {
  const harness = createHarness(t, {
    assets: [asset("a"), asset("b")],
    moveResponse: {
      target: { id: "s9", name: "B" },
      sources: [{ stackId: "s1", dissolved: false, remainingAssetId: "" }],
      movedAssetIds: ["a", "b"],
    },
  });
  await harness.controller.cutAssetIds(["a", "b"]);
  assert.equal(await harness.controller.pasteCut({ stackId: "s9", stackName: "B" }), true);
  assert.deepEqual(harness.calls.move, [{
    url: "/api/asset-stacks/move",
    method: "POST",
    body: { project: "p", assetIds: ["a", "b"], targetStackId: "s9" },
  }]);
  assert.deepEqual(harness.toasts, [{ message: T("cutMovedToStack", { count: 2, name: "B" }), tone: "success" }]);
  assert.deepEqual(harness.calls.changes, [[
    { kind: "stack-members-changed", entityType: "stack", entityId: "s1", assetIds: ["a", "b"] },
    { kind: "stack-members-changed", entityType: "stack", entityId: "s9", assetIds: ["a", "b"] },
  ]]);
  assert.equal(harness.controller.isCutActive(), false, "成功后取消剪切");
});

test("粘贴成功（移出成散图）：targetStackId null、提示「已移出堆叠」；解散的源堆叠追加一句并落 stack-dissolved", async (t) => {
  const harness = createHarness(t, {
    assets: [asset("a")],
    moveResponse: {
      target: null,
      sources: [{ stackId: "s1", dissolved: true, remainingAssetId: "z" }],
      movedAssetIds: ["a"],
    },
  });
  await harness.controller.cutAssetIds(["a"]);
  await harness.controller.pasteCut({});
  assert.deepEqual(harness.calls.move[0].body.targetStackId, null);
  assert.deepEqual(harness.toasts, [{
    message: `${T("cutMovedOut", { count: 1 })} ${T("cutSourceDissolved")}`,
    tone: "success",
  }]);
  assert.deepEqual(harness.calls.changes, [[
    { kind: "stack-dissolved", entityType: "stack", entityId: "s1", assetIds: ["a", "z"] },
  ]]);
});

test("堆叠内部粘贴：目标取当前堆叠（activeStackId/summary）", async (t) => {
  const harness = createHarness(t, {
    assets: [asset("a")],
    moveResponse: { target: { id: "s1", name: "A" }, sources: [], movedAssetIds: ["a"] },
  });
  harness.state.activeStackId = "s1";
  harness.state.activeStackSummary = { id: "s1", name: "A" };
  await harness.controller.cutAssetIds(["a"]);
  await harness.controller.pasteCut({});
  assert.deepEqual(harness.calls.move[0].body, { project: "p", assetIds: ["a"], targetStackId: "s1" });
  assert.deepEqual(harness.toasts, [{ message: T("cutMovedToStack", { count: 1, name: "A" }), tone: "success" }]);
});

test("粘贴失败：保留剪切状态，提示错误原因", async (t) => {
  const harness = createHarness(t, {
    assets: [asset("a")],
    moveError: new Error("STACK_NOT_FOUND"),
  });
  await harness.controller.cutAssetIds(["a"]);
  assert.equal(await harness.controller.pasteCut({ stackId: "s9" }), false);
  assert.deepEqual(harness.toasts, [{ message: "STACK_NOT_FOUND", tone: "error" }]);
  assert.ok(harness.controller.isCutActive(), "失败保留剪切状态方便重试");
});

test("空操作：散图移出堆叠提示「本来就不在堆叠里」并取消剪切；目标堆叠原位不动提示无需移动", async (t) => {
  const loose = createHarness(t, {
    assets: [asset("a")],
    moveResponse: { target: null, sources: [], movedAssetIds: [] },
  });
  await loose.controller.cutAssetIds(["a"]);
  await loose.controller.pasteCut({});
  assert.deepEqual(loose.toasts, [{ message: T("cutAlreadyLoose"), tone: "default" }]);
  assert.equal(loose.controller.isCutActive(), false);
  assert.deepEqual(loose.calls.changes, []);

  const already = createHarness(t, {
    assets: [asset("a")],
    moveResponse: { target: { id: "s9", name: "B" }, sources: [], movedAssetIds: [] },
  });
  await already.controller.cutAssetIds(["a"]);
  await already.controller.pasteCut({ stackId: "s9", stackName: "B" });
  assert.deepEqual(already.toasts, [{ message: T("cutNothingMoved"), tone: "default" }]);
  assert.equal(already.controller.isCutActive(), false);
});

test("回收站粘贴直接拒绝，不发请求", async (t) => {
  const harness = createHarness(t, { assets: [asset("a")], moveResponse: { target: null, sources: [], movedAssetIds: ["a"] } });
  await harness.controller.cutAssetIds(["a"]);
  harness.state.scope = "trash";
  assert.equal(await harness.controller.pasteCut({}), false);
  assert.deepEqual(harness.calls.move, []);
  assert.ok(harness.controller.isCutActive(), "拒绝不是取消");
});

test("syncRenderedCutState：把已挂载卡片的 is-cut 刷成与剪切集合一致", async (t) => {
  const originalWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  t.after(() => { globalThis.window = originalWindow; });
  const toggled = [];
  const card = (id) => ({
    dataset: { id },
    classList: {
      toggle(name, value) {
        if (name === "is-cut") toggled.push([id, value]);
      },
    },
  });
  const grid = {
    querySelectorAll: (selector) => {
      assert.equal(selector, ":scope > .asset-card");
      return [card("a"), card("b"), card("c")];
    },
  };
  const state = { project: "p", scope: "all", assets: [], activeStackId: "", activeStackSummary: null, cutAssetIds: new Set(["a"]), cutProjectId: "p" };
  const controller = createCutPasteController({
    state,
    els: { assetGrid: grid },
    t: T,
    apiFetch: async () => ({}),
    showToast() {},
    announceGalleryStatus() {},
    librarySync: null,
    loadStats: async () => {},
    copyOriginalImage: async () => {},
  });
  controller.syncRenderedCutState();
  assert.deepEqual(toggled, [["a", true], ["b", false], ["c", false]]);
  state.cutAssetIds = new Set();
  controller.syncRenderedCutState();
  assert.deepEqual(toggled.slice(3), [["a", false], ["b", false], ["c", false]], "取消后卡片恢复正常（不再变淡）");
});
