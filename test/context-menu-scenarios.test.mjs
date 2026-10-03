import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { createContextMenuActions } from "../web/app/context-menu-actions.mjs";

/**
 * 右键菜单统一契约（右键菜单统一方案第二/三/四节）：逐场景断言菜单项、顺序、
 * 分隔线位置、置灰与危险标记，外加多选收藏规则与"分组"命名统一。标签用参数化
 * t()（key + JSON 参数）断言，不复制 i18n 文案，文案改动只需同步 key。
 */

const root = resolve(import.meta.dirname, "..");
const T = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key);

function createHarness(t, {
  stateOverrides = {},
  hasSelectedStacks = false,
  batchBodies = [],
  stackCalls = [],
  stackBusy = false,
} = {}) {
  // 选区/堆叠动作会向 window 派发刷新事件；以最小 window 桩运行并在测试后还原。
  const originalWindow = globalThis.window;
  globalThis.window = { dispatchEvent() {} };
  t.after(() => { globalThis.window = originalWindow; });
  const state = {
    project: "p",
    scope: "all",
    assets: [],
    groups: { groups: [{ name: "G1" }, { name: "G2" }] },
    selectedId: null,
    activeStackId: "",
    storageKind: "sqlite",
    pageTotal: 6,
    ...stateOverrides,
  };
  const actions = createContextMenuActions({
    state,
    els: {},
    t: T,
    apiClient: {
      apiFetch: async (url, options = {}) => {
        if (url === "/api/assets/batch" && options.body?.action === "favorite") batchBodies.push(options.body);
        return { results: [] };
      },
    },
    showToast() {},
    runAction: async (action) => action(),
    requestConfirmation: async () => true,
    openStackRenameModal: () => {},
    copyOriginalImage: async () => {},
    isVideoAsset: (entry) => String(entry?.image_path || "").endsWith(".mp4"),
    assetStacks: {
      createStackFromSelection: async () => void stackCalls.push("createStackFromSelection"),
      removeSelectedFromStack: async () => void stackCalls.push("removeSelectedFromStack"),
      renameActiveStack: async () => {},
      dissolveActiveStack: async () => {},
      exitStack: async () => void stackCalls.push("exitStack"),
      syncChrome: () => {},
      isBusy: () => stackBusy,
    },
    emptyTrash: async () => void stackCalls.push("emptyTrash"),
    gallerySelection: {
      hasSelectedStacks: () => hasSelectedStacks,
      selectAll: async () => {},
      clear: () => {},
      selectedIds: () => new Set(),
    },
  });
  return { actions, state, batchBodies, stackCalls };
}

const asset = { id: "a1", project_id: "p", prompt: "p1", image_path: "/x.png", image_url: "/x.png", favorite: false };
const favorited = (overrides = {}) => ({ ...asset, favorite: true, ...overrides });

/**
 * 菜单 → 可读契约形状：分隔线为 "|"，表头为 { heading }，其余只保留契约字段。
 * 置灰只保留"真置灰"；快捷键归一化为 Esc / mod+A（平台后缀由既有断言单独锁）。
 */
function contractShape(menu) {
  return menu.map((item) => {
    if (item.separator) return "|";
    if (item.heading) return { heading: item.heading };
    return {
      label: item.label,
      ...(item.danger ? { danger: true } : {}),
      ...(item.disabled ? { disabled: true } : {}),
      ...(item.shortcut ? { shortcut: item.shortcut === "Esc" ? "Esc" : "mod+A" } : {}),
      ...(item.submenu ? { submenu: true } : {}),
    };
  });
}

function assertSeparatorHygiene(menu) {
  const shape = contractShape(menu);
  assert.notEqual(shape[0], "|", "菜单不能以分隔线开头");
  assert.notEqual(shape.at(-1), "|", "菜单不能以分隔线结尾");
  for (let index = 1; index < shape.length; index += 1) {
    assert.ok(!(shape[index] === "|" && shape[index - 1] === "|"), `不允许连续分隔线 @${index}: ${JSON.stringify(shape)}`);
  }
}

function assertDangerLastAndOnly(menu, dangerLabel) {
  const interactive = menu.filter((item) => !item.separator && !item.heading);
  const dangers = interactive.filter((item) => item.danger);
  assert.equal(dangers.length, 1, `exactly one danger item: ${JSON.stringify(contractShape(menu))}`);
  assert.equal(dangers[0].label, dangerLabel);
  assert.equal(interactive.at(-1).label, dangerLabel, "the danger action is always the last interactive item");
}

test("画廊 · 单张：打开｜复制（图/词/路径）｜收藏+分组｜历史+导出｜回收站", (t) => {
  const { actions } = createHarness(t);
  const menu = actions.getAssetMenu(asset, [asset], { selectionCount: 1 });
  assert.deepEqual(contractShape(menu), [
    { label: T("openInViewer") },
    { label: T("showInFinder") },
    "|",
    { label: T("copyImage") },
    { label: T("copyPrompt") },
    { label: T("copyPath") },
    "|",
    { label: T("addToFavorites") },
    { label: T("moveToGroup"), submenu: true },
    "|",
    { label: T("viewVersionHistory") },
    { label: T("exportAsset") },
    "|",
    { label: T("moveToTrash"), danger: true },
  ]);
  assertSeparatorHygiene(menu);
  assertDangerLastAndOnly(menu, T("moveToTrash"));
});

test("单张置灰只标“暂时做不了”：无提示词置灰复制提示词，视频置灰复制图片", (t) => {
  const { actions } = createHarness(t);
  const noPrompt = { ...asset, prompt: "" };
  const menu = actions.getAssetMenu(noPrompt, [noPrompt], { selectionCount: 1 });
  const byLabel = Object.fromEntries(menu.filter((item) => item.label).map((item) => [item.label, item]));
  assert.equal(byLabel[T("copyPrompt")].disabled, true);
  assert.equal(byLabel[T("copyPath")].disabled, undefined, "复制路径始终可用");
  const video = { ...asset, image_path: "/v.mp4" };
  const videoMenu = actions.getAssetMenu(video, [video], { selectionCount: 1 });
  assert.equal(videoMenu.find((item) => item.label === T("copyImage")).disabled, true);
});

test("画廊 · 多选：选区表头｜收藏/分组/堆叠所选｜导出｜全选+取消选择｜回收站；多选不出现打开/复制/版本历史", (t) => {
  const { actions } = createHarness(t);
  const selection = [asset, favorited({ id: "a2" })];
  const menu = actions.getAssetMenu(asset, selection, { selectionCount: 2 });
  assert.deepEqual(contractShape(menu), [
    { heading: T("batchSelected", { count: 2 }) },
    "|",
    { label: T("addToFavorites") },
    { label: T("moveToGroup"), submenu: true },
    { label: T("stackSelected") },
    "|",
    { label: T("exportAsset") },
    "|",
    { label: T("selectAll"), shortcut: "mod+A" },
    { label: T("deselectAll"), shortcut: "Esc" },
    "|",
    { label: T("moveToTrash"), danger: true },
  ]);
  assert.ok(!contractShape(menu).some((entry) => [
    T("openInViewer"), T("showInFinder"), T("copyImage"), T("copyPrompt"), T("copyPath"), T("viewVersionHistory"),
  ].includes(entry.label)), "多选整段隐藏打开/复制/版本历史");
  assertSeparatorHygiene(menu);
  assertDangerLastAndOnly(menu, T("moveToTrash"));
});

test("多选收藏看整个选区：混合→添加到收藏并发 favorite:true；全部已收藏→取消收藏并发 favorite:false", async (t) => {
  const harness = createHarness(t);
  const mixed = [asset, favorited({ id: "a2" })];
  const mixedMenu = harness.actions.getAssetMenu(asset, mixed, { selectionCount: 2 });
  const favoriteItem = mixedMenu.find((item) => item.label === T("addToFavorites"));
  assert.ok(favoriteItem, "混合选区显示“添加到收藏”，与右键命中的那张无关");
  await favoriteItem.action();
  assert.equal(harness.batchBodies.at(-1)?.favorite, true);

  const all = [favorited(), favorited({ id: "a2" })];
  const allMenu = harness.actions.getAssetMenu(asset, all, { selectionCount: 2 });
  const removeItem = allMenu.find((item) => item.label === T("removeFromFavorites"));
  assert.ok(removeItem, "全部已收藏显示“取消收藏”");
  await removeItem.action();
  assert.equal(harness.batchBodies.at(-1)?.favorite, false);
});

test("画廊 · 多选含堆叠：不显示堆叠所选与导出（不支持堆叠套堆叠/导出堆叠），不留连续分隔线", (t) => {
  const { actions } = createHarness(t, { hasSelectedStacks: true });
  const selection = [asset, { ...asset, id: "a2", stack: { id: "s9", count: 2 } }];
  const menu = actions.getAssetMenu(asset, selection, { selectionCount: 3 });
  assert.deepEqual(contractShape(menu), [
    { heading: T("batchSelected", { count: 3 }) },
    "|",
    { label: T("addToFavorites") },
    { label: T("moveToGroup"), submenu: true },
    "|",
    { label: T("selectAll"), shortcut: "mod+A" },
    { label: T("deselectAll"), shortcut: "Esc" },
    "|",
    { label: T("moveToTrash"), danger: true },
  ]);
  assertSeparatorHygiene(menu);
});

test("堆叠所选置灰：存储引擎不支持，或堆叠操作进行中（mutationInFlight）", (t) => {
  const json = createHarness(t, { stateOverrides: { storageKind: "json" } });
  const selection = [asset, { ...asset, id: "a2" }];
  assert.equal(json.actions.getAssetMenu(asset, selection, { selectionCount: 2 }).find((item) => item.label === T("stackSelected")).disabled, true);

  const busy = createHarness(t, { stackBusy: true });
  const busyMenu = busy.actions.getAssetMenu(asset, selection, { selectionCount: 2 });
  assert.equal(busyMenu.find((item) => item.label === T("stackSelected")).disabled, true, "堆叠 mutation 进行中置灰");
});

test("画廊 · 堆叠卡片：打开堆叠｜重命名/分组/解散｜回收站；不提供收藏与导出", (t) => {
  const { actions } = createHarness(t);
  const stackAsset = { ...asset, stack: { id: "s1", count: 3, name: "S" } };
  const menu = actions.getAssetMenu(stackAsset, [stackAsset], { stackNode: true, selectionCount: 1 });
  assert.deepEqual(contractShape(menu), [
    { label: T("openStack") },
    "|",
    { label: T("renameStack") },
    { label: T("moveToGroup"), submenu: true },
    { label: T("dissolveStack") },
    "|",
    { label: T("moveToTrash"), danger: true },
  ]);
  assert.ok(!menu.some((item) => item.label === T("addToFavorites") || item.label === T("exportAsset")));
  assertSeparatorHygiene(menu);
});

test("堆叠内部 · 单张成员：同画廊单张，整理分区多一项移出堆叠（路由到控制器）", async (t) => {
  const harness = createHarness(t, { stateOverrides: { activeStackId: "s1" } });
  const menu = harness.actions.getAssetMenu(asset, [asset], { selectionCount: 1 });
  assert.deepEqual(contractShape(menu), [
    { label: T("openInViewer") },
    { label: T("showInFinder") },
    "|",
    { label: T("copyImage") },
    { label: T("copyPrompt") },
    { label: T("copyPath") },
    "|",
    { label: T("addToFavorites") },
    { label: T("moveToGroup"), submenu: true },
    { label: T("removeFromStack") },
    "|",
    { label: T("viewVersionHistory") },
    { label: T("exportAsset") },
    "|",
    { label: T("moveToTrash"), danger: true },
  ]);
  assertSeparatorHygiene(menu);
  await menu.find((item) => item.label === T("removeFromStack")).action();
  assert.deepEqual(harness.stackCalls, ["removeSelectedFromStack"], "移出堆叠路由到堆叠控制器");
});

test("堆叠内部 · 多选成员：选区表头｜收藏/分组/移出堆叠｜导出｜全选+取消选择｜回收站", (t) => {
  const { actions } = createHarness(t, { stateOverrides: { activeStackId: "s1" } });
  const selection = [asset, { ...asset, id: "a2" }];
  const menu = actions.getAssetMenu(asset, selection, { selectionCount: 2 });
  assert.deepEqual(contractShape(menu), [
    { heading: T("batchSelected", { count: 2 }) },
    "|",
    { label: T("addToFavorites") },
    { label: T("moveToGroup"), submenu: true },
    { label: T("removeFromStack") },
    "|",
    { label: T("exportAsset") },
    "|",
    { label: T("selectAll"), shortcut: "mod+A" },
    { label: T("deselectAll"), shortcut: "Esc" },
    "|",
    { label: T("moveToTrash"), danger: true },
  ]);
  assert.ok(!menu.some((item) => item.label === T("stackSelected")),
    "堆叠内部不能再堆叠，堆叠所选不出现");
  assertSeparatorHygiene(menu);
});

test("移出堆叠在堆叠 mutation 进行中置灰", (t) => {
  const { actions } = createHarness(t, { stateOverrides: { activeStackId: "s1" }, stackBusy: true });
  const menu = actions.getAssetMenu(asset, [asset], { selectionCount: 1 });
  assert.equal(menu.find((item) => item.label === T("removeFromStack")).disabled, true);
});

test("堆叠所选路由到堆叠控制器", async (t) => {
  const harness = createHarness(t);
  const selection = [asset, { ...asset, id: "a2" }];
  const stackItem = harness.actions.getAssetMenu(asset, selection, { selectionCount: 2 })
    .find((item) => item.label === T("stackSelected"));
  await stackItem.action();
  assert.deepEqual(harness.stackCalls, ["createStackFromSelection"]);
});

test("画廊 · 空白处：粘贴、新建分组｜全选、刷新素材库", (t) => {
  const { actions } = createHarness(t);
  const menu = actions.getEmptyGridMenu();
  assert.deepEqual(contractShape(menu), [
    { label: T("pasteFromClipboard"), disabled: true },
    { label: T("createGroup") },
    "|",
    { label: T("selectAll"), shortcut: "mod+A" },
    { label: T("refreshLibrary") },
  ]);
  assertSeparatorHygiene(menu);
});

test("堆叠内部 · 空白处：返回素材库｜粘贴｜重命名+解散当前堆叠｜全选、刷新；没有新建分组", (t) => {
  const { actions, state } = createHarness(t, { stateOverrides: { activeStackId: "s1" } });
  state.activeStackSummary = { id: "s1", name: "S", count: 3 };
  const menu = actions.getEmptyGridMenu();
  assert.deepEqual(contractShape(menu), [
    { label: T("backToLibrary") },
    "|",
    { label: T("pasteFromClipboard"), disabled: true },
    "|",
    { label: T("renameStack") },
    { label: T("dissolveStack") },
    "|",
    { label: T("selectAll"), shortcut: "mod+A" },
    { label: T("refreshLibrary") },
  ]);
  assert.ok(!contractShape(menu).some((entry) => entry.label === T("createGroup")));
  assertSeparatorHygiene(menu);
});

test("回收站 · 空白处：全选、刷新｜清空回收站（危险）；没有新建分组与粘贴", (t) => {
  const { actions } = createHarness(t, { stateOverrides: { scope: "trash", groups: { groups: [], trash: 3 } } });
  const menu = actions.getEmptyGridMenu();
  assert.deepEqual(contractShape(menu), [
    { label: T("selectAll"), shortcut: "mod+A" },
    { label: T("refreshLibrary") },
    "|",
    { label: T("emptyTrash"), danger: true },
  ]);
  assertSeparatorHygiene(menu);
  assertDangerLastAndOnly(menu, T("emptyTrash"));
});

test("回收站为空时清空回收站置灰", (t) => {
  const { actions } = createHarness(t, { stateOverrides: { scope: "trash", groups: { groups: [], trash: 0 } } });
  assert.equal(actions.getEmptyGridMenu().find((item) => item.label === T("emptyTrash")).disabled, true);
});

test("回收站 · 单张：还原素材｜永久删除", (t) => {
  const { actions } = createHarness(t, { stateOverrides: { scope: "trash" } });
  const menu = actions.getAssetMenu(asset, [asset], { selectionCount: 1 });
  assert.deepEqual(contractShape(menu), [
    { label: T("restoreAsset") },
    "|",
    { label: T("permanentDelete"), danger: true },
  ]);
  assertSeparatorHygiene(menu);
  assertDangerLastAndOnly(menu, T("permanentDelete"));
});

test("回收站 · 多选：选区表头｜还原 N 项｜全选+取消选择｜永久删除（带数量标签保留）", (t) => {
  const { actions } = createHarness(t, { stateOverrides: { scope: "trash" } });
  const selection = [asset, { ...asset, id: "a2" }];
  const menu = actions.getAssetMenu(asset, selection, { selectionCount: 2 });
  assert.deepEqual(contractShape(menu), [
    { heading: T("batchSelected", { count: 2 }) },
    "|",
    { label: T("restoreAssets", { count: 2 }) },
    "|",
    { label: T("selectAll"), shortcut: "mod+A" },
    { label: T("deselectAll"), shortcut: "Esc" },
    "|",
    { label: T("permanentDelete"), danger: true },
  ]);
  assertSeparatorHygiene(menu);
});

test("回收站空白处全选与画廊空白处全选是同一个构造器（同名同快捷键）", (t) => {
  const gallery = createHarness(t);
  const trash = createHarness(t, { stateOverrides: { scope: "trash" } });
  const gallerySelectAll = gallery.actions.getEmptyGridMenu().find((item) => item.label === T("selectAll"));
  const trashSelectAll = trash.actions.getEmptyGridMenu().find((item) => item.label === T("selectAll"));
  assert.deepEqual(contractShape([gallerySelectAll]), contractShape([trashSelectAll]));
});

test("命名统一成“分组”：中文侧栏标题、英文手动分组文案不再出现 collection", async () => {
  const i18n = await readFile(resolve(root, "web/app/i18n.mjs"), "utf8");
  const html = await readFile(resolve(root, "web/app/index.html"), "utf8");
  assert.match(i18n, /assetCategories: "分组"/);
  assert.match(i18n, /assetCategories: "Groups"/);
  assert.doesNotMatch(i18n, /collection/i, "手动分组文案统一 group，i18n 里不再有 collection");
  assert.doesNotMatch(html, /素材分类/, "index.html 里写死的侧栏标题同步改为分组");
});
