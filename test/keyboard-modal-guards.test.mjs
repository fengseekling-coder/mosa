import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

// 任务 60 契约矩阵（54-1 / 54-2 / 55-2）。只读源码切片，不跑 DOM：锁住
// 「IME 组字 Enter 不提交」「浮层判定统一到 hasBlockingOverlay」「右键菜单
// 空窗期 Escape 关菜单（方案 a）」这三个实现面。运行时行为由 e2e 流程
// keyboard-modal-guards 覆盖。
const root = resolve(import.meta.dirname, "..");
const app = await readFile(resolve(root, "web/app/app.mjs"), "utf8");
const contextMenuSource = await readFile(resolve(root, "web/app/context-menu.mjs"), "utf8");
const count = (source, needle) => source.split(needle).length - 1;
const sliceBetween = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
};
const assertGuardedBefore = (slice, submitCall, label) => {
  const guard = slice.indexOf("isImeComposing(event)");
  assert.notEqual(guard, -1, `${label} must pass the IME composing guard`);
  assert.equal(slice.includes("return", guard), true, `${label} guard must bail out`);
  const submit = slice.indexOf(submitCall);
  assert.notEqual(submit, -1, `${label} must still submit on a plain Enter (${submitCall})`);
  assert.ok(guard < submit, `${label}: the IME guard must run before ${submitCall}`);
};

test("01 isImeComposing checks both composition signals and never consumes the key", () => {
  const helper = sliceBetween(app, "function isImeComposing(event) {", "// ===== Keyboard Shortcuts =====");
  assert.match(helper, /return event\.isComposing === true \|\| event\.keyCode === 229;/);
  assert.doesNotMatch(helper, /preventDefault/);
});

test("02 sidebar group inline Enter submit passes the IME guard first", () => {
  const handler = sliceBetween(
    app,
    'els.sidebarManualGroupList?.addEventListener("keydown"',
    'els.sidebarManualGroupList?.addEventListener("focusout"',
  );
  assertGuardedBefore(handler, "commitSidebarGroupEdit()", "sidebar group inline editor");
});

test("03 stack rename modal Enter submit passes the IME guard first", () => {
  const handler = sliceBetween(
    app,
    'els.stackRenameModalInput?.addEventListener("keydown"',
    'els.saveStackRenameBtn?.addEventListener',
  );
  assertGuardedBefore(handler, "saveStackRename()", "stack rename modal");
});

test("04 group modal Enter submit passes the IME guard first", () => {
  const handler = sliceBetween(
    app,
    'els.groupNameInput?.addEventListener("keydown"',
    "els.closeGroupStatsModal?.addEventListener",
  );
  assertGuardedBefore(handler, "saveGroup()", "group modal");
});

test("05 every known text-input Enter submit is guarded (1 helper + 3 call sites)", () => {
  // 三个提交点：侧栏分组内联编辑、堆叠重命名弹窗、新建分组弹窗。出现第四个
  // “文本输入框 Enter 提交”处理时必须同样过 isImeComposing，并同步更新这里。
  assert.equal(count(app, "isImeComposing(event)"), 4, "expected exactly 1 definition + 3 guarded submit points");
});

test("06 hasBlockingOverlay is the single overlay gate covering all six surfaces", () => {
  const overlay = sliceBetween(app, 'function hasBlockingOverlay(except = "") {', "function openSettingsModal()");
  assert.match(overlay, /confirmDialogState\.pending/);
  assert.match(overlay, /els\.groupModal\?\.classList\.contains\("open"\)/);
  assert.match(overlay, /els\.groupStatsModal\?\.classList\.contains\("open"\)/);
  assert.match(overlay, /els\.stackRenameModal\?\.classList\.contains\("open"\)/);
  assert.match(overlay, /els\.settingsMenu && !els\.settingsMenu\.hidden/);
  assert.match(overlay, /els\.imagePreviewModal && !els\.imagePreviewModal\.hidden/);
});

test("07 paste import routes through the unified overlay gate", () => {
  const paste = sliceBetween(app, "function setupPasteImport()", "const favoriteRequests");
  assert.match(paste, /hasBlockingOverlay\(\)/);
  // frontend-interaction-regressions「image paste never hijacks editors」把这四个
  // 字面量钉在粘贴守卫里；统一判定 hasBlockingOverlay 作为权威兜底并排保留。
  assert.match(paste, /confirmDialogState\.pending/);
  assert.match(paste, /!els\.settingsMenu\?\.hidden/);
  assert.match(paste, /!els\.imagePreviewModal\?\.hidden/);
  assert.match(paste, /els\.groupModal\?\.classList\.contains\("open"\)/);
});

test("08 select-all/paste shortcut defers to the unified overlay gate", () => {
  const shortcut = sliceBetween(
    app,
    'if ((event.metaKey || event.ctrlKey) && (event.key === "a"',
    'if (event.key === "Escape" && event.defaultPrevented) return;',
  );
  assert.match(shortcut, /if \(hasBlockingOverlay\(\)\) return;/);
  assert.doesNotMatch(shortcut, /groupModal|stackRenameModal|imagePreviewModal|settingsMenu/);
});

test("09 / focuses search only when no overlay is open", () => {
  assert.match(app, /event\.key === "\/" && state\.viewMode === "library" && !hasBlockingOverlay\(\)/);
});

test("10 Enter opens asset/stack only when no overlay is open", () => {
  const enter = sliceBetween(app, 'if (event.key === "Enter"', "const asset = state.assets.find");
  assert.match(enter, /!hasBlockingOverlay\(\)/);
  assert.doesNotMatch(enter, /settingsMenu|imagePreviewModal/);
});

test("11 gallery arrow navigation defers to the unified overlay gate", () => {
  const nav = sliceBetween(app, "function bindKeyboardNav(event) {", "// Phase 3A：箭头键画廊导航仅属库内模式");
  assert.match(nav, /confirmDialogState\.pending \|\| hasBlockingOverlay\(\)/);
  // confirm-dialog-contract「Escape consumed first」把 confirmDialogState.pending
  // 字面量钉在本函数里；其余浮层不得再出现手写清单。
  assert.doesNotMatch(nav, /els\.groupModal|els\.stackRenameModal|els\.imagePreviewModal|els\.settingsMenu/);
});

test("12 Escape closes a freshly opened context menu before its deferred listeners register", () => {
  // 方案 (a)：菜单 keydown 监听延迟注册的空窗里，Escape 在 isOpen() 早退之前
  // 被应用级路由消费（preventDefault + 关菜单 + 归还焦点），不再被吞。
  const escBranch = sliceBetween(
    app,
    "if (confirmDialogState.pending) return;\n    // M1 兜底",
    "if (contextMenu.isOpen()) return;",
  );
  assert.match(escBranch, /event\.key === "Escape" && contextMenu\.isOpen\(\)/);
  assert.match(escBranch, /event\.preventDefault\(\)/);
  assert.match(escBranch, /contextMenu\.hide\(\{ restoreFocus: true \}\)/);
  // 选 (a) 而非 (b)：context-menu.mjs 的延迟注册契约原样保留。
  assert.match(contextMenuSource, /const registerTimer = setTimeout\(\(\) => \{/);
  assert.match(contextMenuSource, /document\.addEventListener\("keydown", keyHandler, \{ capture: true \}\);\s+window\.addEventListener\("scroll"/);
});
