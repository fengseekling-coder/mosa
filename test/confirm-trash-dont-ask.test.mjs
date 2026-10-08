// 任务 94（GravityPort A4f）：「移至回收站」确认框的「不再提醒」——
// 勾选框只在传入 dontAskAgainKey 时出现且每次打开未勾选、只有点「是」且勾选才写
// 存储（否/Esc/遮罩不写）、存储读写失败按「要提醒」处理、右键多选撤销只恢复本次
// 成功移走的那几张。纯 Node + 最小 DOM 桩，无网络访问。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { createConfirmDialog } from "../web/app/confirm-dialog.mjs";
import { createContextMenuActions } from "../web/app/context-menu-actions.mjs";
import { CONFIRM_MOVE_TO_TRASH_KEY, moveToTrashConfirmSuppressed } from "../web/app/utils.mjs";

const root = resolve(import.meta.dirname, "..");

/** localStorage 桩：可注入读取/写入失败；记录写入调用。 */
function fakeStorage({ failGet = false, failSet = false, initial = {} } = {}) {
  const map = new Map(Object.entries(initial));
  const writes = [];
  return {
    writes,
    storage: {
      getItem: (key) => {
        if (failGet) throw new Error("storage read failed");
        return map.has(key) ? map.get(key) : null;
      },
      setItem: (key, value) => {
        if (failSet) throw new Error("storage write failed");
        map.set(key, String(value));
        writes.push([key, String(value)]);
      },
      removeItem: (key) => map.delete(key),
    },
  };
}

/** 最小 DOM 桩：足够 createConfirmDialog 的打开/关闭路径跑通。 */
function fakeEls() {
  const track = (extra = {}) => ({ classList: { add() {}, remove() {}, toggle() {} }, ...extra });
  const checkbox = { checked: false };
  const dontAsk = { hidden: true };
  return {
    checkbox,
    dontAsk,
    els: {
      confirmDialog: track({ setAttribute() {}, removeAttribute() {} }),
      confirmDialogCard: track({ dataset: {} }),
      confirmDialogTitle: { textContent: "" },
      confirmDialogDescription: { textContent: "" },
      confirmDialogCancel: track({ textContent: "", focus() {} }),
      confirmDialogConfirm: track({ textContent: "" }),
      appShell: { setAttribute() {}, removeAttribute() {} },
      confirmDialogDontAsk: dontAsk,
      confirmDialogDontAskCheckbox: checkbox,
    },
  };
}

function stubGlobals(t, storage, { refreshDetails = null } = {}) {
  const original = {
    window: globalThis.window,
    document: globalThis.document,
    raf: globalThis.requestAnimationFrame,
    localStorage: globalThis.localStorage,
    HTMLElement: globalThis.HTMLElement,
  };
  globalThis.window = {
    dispatchEvent: (event) => {
      if (event.type === "mosa:refresh-assets" && refreshDetails) refreshDetails.push(event.detail);
    },
  };
  globalThis.document = { activeElement: null };
  globalThis.requestAnimationFrame = (callback) => callback();
  globalThis.localStorage = storage;
  globalThis.HTMLElement = class HTMLElement {};
  t.after(() => {
    globalThis.window = original.window;
    globalThis.document = original.document;
    globalThis.requestAnimationFrame = original.raf;
    globalThis.localStorage = original.localStorage;
    globalThis.HTMLElement = original.HTMLElement;
  });
}

// 撤销回调经 `void restoreTrashedSelection(...)` 后台执行（与大图页撤销同一形态）；
// 测试里让路事件循环，等逐张 restore 跑完再断言。
async function drainBackgroundRestores() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

test("勾选框只在传入 dontAskAgainKey 时出现，且每次打开都是未勾选", (t) => {
  const storage = fakeStorage();
  stubGlobals(t, storage.storage);
  const { els, checkbox, dontAsk } = fakeEls();
  const dialog = createConfirmDialog({ els, state: { viewMode: "library" }, t: (key) => key, closePanel: () => {} });

  dialog.requestConfirmation({ title: "T", dontAskAgainKey: CONFIRM_MOVE_TO_TRASH_KEY });
  assert.equal(dontAsk.hidden, false, "passing a key reveals the dont-ask row");
  assert.equal(checkbox.checked, false, "every open starts unchecked");
  dialog.closeConfirmDialog(false);
  assert.equal(dontAsk.hidden, true, "close hides the row again");
  assert.equal(checkbox.checked, false, "close unchecks the box");

  dialog.requestConfirmation({ title: "T" });
  assert.equal(dontAsk.hidden, true, "no key → no checkbox row");
});

test("只有点「是」且勾选时才写存储；否/Esc/遮罩（result=false）一律不写", async (t) => {
  const storage = fakeStorage();
  stubGlobals(t, storage.storage);
  const { els, checkbox } = fakeEls();
  const dialog = createConfirmDialog({ els, state: { viewMode: "library" }, t: (key) => key, closePanel: () => {} });
  const key = CONFIRM_MOVE_TO_TRASH_KEY;

  let pending = dialog.requestConfirmation({ dontAskAgainKey: key });
  checkbox.checked = true;
  dialog.closeConfirmDialog(false);
  assert.equal(await pending, false, "Esc/cancel/backdrop settles false");
  assert.equal(storage.writes.length, 0, "cancel/escape/backdrop never persist");

  pending = dialog.requestConfirmation({ dontAskAgainKey: key });
  dialog.closeConfirmDialog(true);
  assert.equal(await pending, true, "confirm settles true");
  assert.equal(storage.writes.length, 0, "confirm without the check does not persist");

  pending = dialog.requestConfirmation({ dontAskAgainKey: key });
  checkbox.checked = true;
  dialog.closeConfirmDialog(true);
  assert.equal(await pending, true);
  assert.deepEqual(storage.writes, [[key, "off"]], "confirm with the check persists the key as off");
});

test("存储读取失败按「要提醒」处理；写失败不影响确认结算", (t) => {
  const brokenRead = fakeStorage({ failGet: true });
  stubGlobals(t, brokenRead.storage);
  assert.equal(moveToTrashConfirmSuppressed(), false, "unreadable storage → keep asking");

  const failingSet = fakeStorage({ failSet: true });
  globalThis.localStorage = failingSet.storage;
  const { els, checkbox } = fakeEls();
  const dialog = createConfirmDialog({ els, state: { viewMode: "library" }, t: (key) => key, closePanel: () => {} });
  const pending = dialog.requestConfirmation({ dontAskAgainKey: CONFIRM_MOVE_TO_TRASH_KEY });
  checkbox.checked = true;
  assert.doesNotThrow(() => dialog.closeConfirmDialog(true), "a failed write must not break the dialog");
  return pending.then((value) => assert.equal(value, true));
});

/** 右键菜单动作 harness：batch 返回可注入，restore 调用与 toast/事件全部记录。 */
function trashHarness(t, { batchResponse, suppressed = false }) {
  const calls = { restoreCalls: [], refreshDetails: [], toastCalls: [], confirmationCalls: [] };
  const storage = fakeStorage({ initial: suppressed ? { [CONFIRM_MOVE_TO_TRASH_KEY]: "off" } : {} });
  stubGlobals(t, storage.storage, { refreshDetails: calls.refreshDetails });
  const state = {
    project: "p", scope: "all", assets: [], groups: { groups: [] }, selectedId: null,
    activeStackId: "", storageKind: "sqlite", pageTotal: 3,
  };
  const actions = createContextMenuActions({
    state,
    els: {},
    t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
    apiClient: {
      apiFetch: async (url, options = {}) => {
        if (url === "/api/assets/batch") return batchResponse;
        if (String(url).endsWith("/restore")) calls.restoreCalls.push(url);
        return {};
      },
    },
    showToast: (message, type, options) => calls.toastCalls.push({ message, type, options }),
    runAction: async (action) => action(),
    requestConfirmation: async (options) => {
      calls.confirmationCalls.push(options);
      return true;
    },
    gallerySelection: {
      hasSelectedStacks: () => false,
      captureActionContext: () => ({ projectId: "p" }),
      resolveSelectedAssetIds: async () => ({ projectId: "p", ids: ["a1", "a2", "a3"] }),
      isActionContextCurrent: () => true,
      selectAll: async () => {},
      clear: () => {},
      selectedIds: () => new Set(),
    },
  });
  return { actions, state, ...calls };
}

const batchAsset = (id) => ({ id, project_id: "p" });

test("右键多选：撤销只恢复成功的那几张；部分失败走既有错误提示，成功的那几张也能撤销", async (t) => {
  // 3 张里成功 2 张（partial 207 语义，第 2 张失败）。
  const { actions, toastCalls, confirmationCalls } = trashHarness(t, {
    batchResponse: {
      partial: true,
      results: [{ id: "a1", ok: true }, { id: "a2", ok: false }, { id: "a3", ok: true }],
    },
  });
  const menu = actions.getAssetMenu(batchAsset("a1"), [batchAsset("a1")], { selectionCount: 3 });
  const trashItem = menu.find((item) => item.label === "moveToTrash");
  assert.ok(trashItem, "the trash menu item exists");
  await trashItem.action();

  assert.equal(confirmationCalls.length, 1, "suppression off → the confirm still shows");
  assert.equal(confirmationCalls[0].dontAskAgainKey, CONFIRM_MOVE_TO_TRASH_KEY, "the trash confirm carries the dont-ask key");
  assert.ok(toastCalls.some((entry) => entry.message.startsWith("batchPartialResult")), "partial failure keeps the existing error toast");
  const partialToast = toastCalls.find((entry) => entry.message.startsWith("batchPartialResult"));
  assert.equal(typeof partialToast.options?.onAction, "function", "partial failure still offers undo for the moved ones");
});

test("右键多选全成功：撤销 toast 6 秒，回调经 restore 端点逐张恢复全部", async (t) => {
  const { actions, toastCalls, restoreCalls, refreshDetails } = trashHarness(t, {
    batchResponse: { results: [] }, // 无 partial → 全部成功
  });
  const menu = actions.getAssetMenu(batchAsset("a1"), [batchAsset("a1")], { selectionCount: 3 });
  await menu.find((item) => item.label === "moveToTrash").action();

  const undoToast = toastCalls.find((entry) => entry.options?.onAction);
  assert.ok(undoToast, "full success shows the undo toast");
  assert.equal(undoToast.options.actionLabel, "undo");
  assert.equal(undoToast.options.duration, 6000);
  await undoToast.options.onAction();
  await drainBackgroundRestores();
  assert.equal(restoreCalls.length, 3, "undo restores every moved id via the restore endpoint");
  assert.ok(restoreCalls.every((url) => url.includes("/api/assets/p/")), "the restore endpoint path carries the project");
  const restored = refreshDetails.find((detail) => Array.isArray(detail.restoredAssetIds));
  assert.equal(restored.restoredAssetIds.length, 3, "the refresh event carries the restored ids");
});

test("设为不再提醒后：右键多选不再弹确认框，直接移入回收站且仍弹撤销 toast", async (t) => {
  const { actions, toastCalls, confirmationCalls } = trashHarness(t, {
    batchResponse: { results: [] },
    suppressed: true,
  });
  const menu = actions.getAssetMenu(batchAsset("a1"), [batchAsset("a1")], { selectionCount: 3 });
  await menu.find((item) => item.label === "moveToTrash").action();
  assert.equal(confirmationCalls.length, 0, "suppressed → no confirmation at all");
  assert.ok(toastCalls.some((entry) => entry.options?.onAction), "the undo toast still appears");
});

test("三处调用都传 dontAskAgainKey；整组堆叠移至回收站不传（永远确认）", async () => {
  const [app, contextActions] = await Promise.all([
    readFile(resolve(root, "web/app/app.mjs"), "utf8"),
    readFile(resolve(root, "web/app/context-menu-actions.mjs"), "utf8"),
  ]);
  const viewer = app.slice(app.indexOf("async function deleteCurrentAssetFromViewer"), app.indexOf("async function restoreTrashedAssetFromViewer"));
  assert.match(viewer, /dontAskAgainKey: CONFIRM_MOVE_TO_TRASH_KEY/, "viewer delete passes the key");
  assert.match(viewer, /if \(!moveToTrashConfirmSuppressed\(\)\) \{/, "viewer delete honours the suppression");
  const trash = contextActions.slice(contextActions.indexOf("const moveToTrashItem ="), contextActions.indexOf("// 统一分区（任务 91 稿子顺序）"));
  assert.match(trash, /dontAskAgainKey: CONFIRM_MOVE_TO_TRASH_KEY/, "context-menu single/multi trash passes the key");
  assert.match(trash, /if \(!moveToTrashConfirmSuppressed\(\)\) \{/, "context-menu trash honours the suppression");
  const stackStart = contextActions.indexOf('title: t("stackTrashTitle")');
  assert.notEqual(stackStart, -1, "the stack trash confirmation exists");
  const stackTrash = contextActions.slice(Math.max(0, stackStart - 500), stackStart + 300);
  assert.doesNotMatch(stackTrash, /dontAskAgainKey/, "the whole-stack trash keeps confirming every time");
});
