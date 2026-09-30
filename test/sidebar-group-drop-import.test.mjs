import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

// 侧边栏分组拖放导入契约：从 Finder/资源管理器把文件拖到侧边栏手动分组上，
// 松开即导入到该分组（stackId 显式为空，落到分组根层级）。读源码切片断言，
// 与其他 *-contract 测试同一风格；零网络、零运行时。

const root = resolve(import.meta.dirname, "..");
const readWebApp = () => readFile(resolve(root, "web/app/app.mjs"), "utf8");
const readDesktopApp = () => readFile(resolve(root, "desktop/app/app.mjs"), "utf8");
const readWebActions = () => readFile(resolve(root, "web/app/context-menu-actions.mjs"), "utf8");
const readWebI18n = () => readFile(resolve(root, "web/app/i18n.mjs"), "utf8");
const readWebCss = () => readFile(resolve(root, "web/app/styles.css"), "utf8");

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `marker not found: ${endMarker}`);
  return source.slice(start, end);
}

function setupSidebarSlice(app) {
  return sliceBetween(app, "function setupSidebarGroupDropImport()", "// ===== Global drag/drop guard");
}

test("01 sidebar drop targets are exactly the manual group items (data-filter=group)", async () => {
  for (const app of [await readWebApp(), await readDesktopApp()]) {
    const setup = setupSidebarSlice(app);
    // 放置目标：只有 #sidebarManualGroupList 委托根内命中的手动分组项。
    assert.match(setup, /els\.sidebarManualGroupList/, "the listeners delegate from the manual group list");
    assert.match(setup, /closest\('\.nav-group-item\[data-filter="group"\]'\)/,
      "only manual group items resolve as drop targets");
    // 智能分组（data-filter="source"）与"新建分组"编辑框（data-sidebar-group-input）
    // 不出现在目标匹配里。
    assert.doesNotMatch(setup, /data-filter="source"/);
    assert.doesNotMatch(setup, /data-sidebar-group-input/);
    // 挂载点只有手动分组列表。
    assert.match(app, /sidebarManualGroupList: document\.querySelector\("#sidebarManualGroupList"\)/);
  }
});

test("02 only external file drags qualify (dataTransfer.types contains Files)", async () => {
  for (const app of [await readWebApp(), await readDesktopApp()]) {
    const setup = setupSidebarSlice(app);
    assert.match(setup, /event\.dataTransfer\?\.types/,
      "the guard reads the drag's dataTransfer types");
    assert.match(setup, /\.includes\("Files"\)/, "only drags carrying Files are handled");
    // 回收站范围在守卫内部短路，非文件拖拽同样不算放置目标。
    assert.match(setup, /if \(state\.scope === "trash"\) return null;/);
  }
});

test("03 drop enqueues into the target group with stackId pinned to the group root", async () => {
  for (const app of [await readWebApp(), await readDesktopApp()]) {
    const setup = setupSidebarSlice(app);
    const drop = sliceBetween(setup, 'list.addEventListener("drop", async (e) => {', "window.addEventListener(\"dragend\"");
    assert.match(drop, /collectDroppedFiles\(e\.dataTransfer/,
      "the drop reuses the shared file collector (unsupported formats still count)");
    assert.match(drop, /const group = String\(item\.dataset\.value \|\| ""\)\.trim\(\);/,
      "the group name comes from the dropped item's data-value");
    assert.match(drop, /batchImporter\.enqueue\(files, \{ metadata: \{ group \}, stackId: "", skipped: unsupported \}\)/,
      "enqueue pins stackId to \"\" so files land at the group root, never inside the active Stack");
  }
});

test("04 highlight reuses .group-drop-target with a flicker-safe leave guard", async () => {
  for (const app of [await readWebApp(), await readDesktopApp()]) {
    const setup = setupSidebarSlice(app);
    assert.match(setup, /classList\.add\("group-drop-target"\)/);
    assert.match(setup, /classList\.remove\("group-drop-target"\)/);
    // 子元素之间移动不闪烁：dragleave 只在落点离开高亮项时清除。
    assert.match(setup, /if \(highlighted && e\.relatedTarget instanceof Node && highlighted\.contains\(e\.relatedTarget\)\) return;/);
    // 进入新分组时向读屏播报目标分组名。
    assert.match(setup, /announceGalleryStatus\(t\("sidebarDropImportReady", \{ group: String\(item\.dataset\.value \|\| ""\)\.trim\(\) \}\), \{ persist: true \}\)/);
    assert.match(setup, /window\.addEventListener\("dragend"/, "cancelled drags clear the highlight");
    // 高亮类在样式表里已有定义，直接复用，不新增样式族。
    const css = await readWebCss();
    assert.match(css, /\.mosa-v2 \.nav-item\.group-drop-target \{ background: var\(--app-hover\); box-shadow: inset 0 0 0 1\.5px var\(--color-accent\); \}/);
  }
});

test("05 both UI trees carry byte-identical drop-import code", async () => {
  const [web, desktop] = await Promise.all([readWebApp(), readDesktopApp()]);
  assert.equal(web, desktop, "web/app/app.mjs and desktop/app/app.mjs must stay identical copies");
});

test("06 global drag guard whitelists only the manual group items and still blocks the rest of the sidebar", async () => {
  for (const app of [await readWebApp(), await readDesktopApp()]) {
    const guard = sliceBetween(app, "function setupGlobalDragGuard()", "// ===== Paste import =====");
    assert.match(guard, /if \(state\.scope !== "trash"\n\s*&& target\.closest\('#sidebarManualGroupList \.nav-group-item\[data-filter="group"\]'\)\) return true;/,
      "manual group items are allowed drop targets outside trash");
    // 其余侧边栏区域不放行：允许列表之外仍然 preventDefault + dropEffect none。
    assert.match(guard, /e\.preventDefault\(\);\n    if \(e\.dataTransfer\) e\.dataTransfer\.dropEffect = "none";/);
    assert.equal((guard.match(/if \(isAllowedDropTarget\(e\.target\)\) return;/g) || []).length, 2,
      "dragover and drop use the same active-target policy");
  }
});

test("07 the sidebar drop import is registered at startup and leaves the gallery overlay alone", async () => {
  for (const app of [await readWebApp(), await readDesktopApp()]) {
    const init = sliceBetween(app, "async function init()", "async function loadProductVersion()");
    assert.match(init, /setupDragDrop\(\);\n    setupSidebarGroupDropImport\(\);\n    setupGlobalDragGuard\(\);/,
      "the sidebar drop setup binds right after the gallery drop setup");
    // 拖到侧边栏分组时画廊浮层不受影响：侧边栏不在 .library 内，画廊
    // dragenter 不会触发；浮层逻辑本身保持原样。
    const dragDrop = sliceBetween(app, "function setupDragDrop()", "// ===== Sidebar group drop import =====");
    assert.match(dragDrop, /els\.dragOverlay\.hidden = false;/);
    assert.doesNotMatch(dragDrop, /sidebarManualGroupList/, "the gallery drop handler never touches the sidebar");
  }
});

test("08 trash scope blocks gallery drag import: no overlay, no copy effect, no import", async () => {
  for (const app of [await readWebApp(), await readDesktopApp()]) {
    const dragDrop = sliceBetween(app, "function setupDragDrop()", "// ===== Sidebar group drop import =====");
    // dragenter：回收站不显示浮层、不累计计数。
    const dragEnter = sliceBetween(dragDrop, 'library.addEventListener("dragenter"', 'library.addEventListener("dragover"');
    assert.match(dragEnter, /if \(state\.viewMode !== "library" \|\| state\.scope === "trash"\) return;/);
    // dragover：回收站显式 dropEffect = "none"。
    const dragOver = sliceBetween(dragDrop, 'library.addEventListener("dragover"', 'library.addEventListener("dragleave"');
    assert.match(dragOver, /if \(state\.scope === "trash"\) \{\s*if \(e\.dataTransfer\) e\.dataTransfer\.dropEffect = "none";\s*return;\s*\}/);
    // drop：回收站直接返回，不走导入（也不 preventDefault，交给全局守卫拦截跳转）。
    const drop = sliceBetween(dragDrop, 'library.addEventListener("drop", async (e) => {', "\n  });");
    assert.match(drop, /if \(state\.viewMode !== "library" \|\| state\.scope === "trash"\) return;/);
  }
});

test("09 trash scope blocks paste import on both the shared handler and the Electron path", async () => {
  for (const app of [await readWebApp(), await readDesktopApp()]) {
    const paste = sliceBetween(app, "function setupPasteImport()", "const favoriteRequests");
    assert.match(paste, /\/\/ 回收站是只读范围：不允许任何导入（含粘贴）。\n    if \(state\.scope === "trash"\) return;/,
      "Ctrl/Cmd+V returns early in trash before touching the clipboard");
    const nativePaste = sliceBetween(app, "async function pasteClipboardImage()", "function setLanguage");
    assert.match(nativePaste, /if \(state\.scope === "trash"\) return null;/,
      "the Electron context-menu paste refuses to import in trash");
  }
});

test("10 trash scope hides the clipboard paste context-menu item", async () => {
  const actions = await readWebActions();
  const emptyMenu = sliceBetween(actions, "function getEmptyGridMenu()", "label: t(\"refreshLibrary\")");
  assert.match(emptyMenu, /const pasteItem = state\.scope === "trash" \? \[\] : \[\{/,
    "the paste item is excluded from the empty-grid menu in the read-only trash scope");
  assert.match(emptyMenu, /\.\.\.pasteItem,/);
});

test("11 trash empty state never advertises the drag/paste import hint", async () => {
  for (const app of [await readWebApp(), await readDesktopApp()]) {
    const markup = sliceBetween(app, "function galleryEmptyMarkup()", "/** Reuses the existing polite live region");
    assert.match(markup, /const dropHint = state\.scope === "trash" \? "" : "<p>" \+ escapeHtml\(t\("emptyDropHint"\)\) \+ "<\/p>";/,
      "the drop hint is dropped in the read-only trash scope");
  }
});

test("12 the announcement copy is symmetric across locales", async () => {
  const i18n = await readWebI18n();
  assert.equal((i18n.match(/\bsidebarDropImportReady:/g) || []).length, 2,
    "sidebarDropImportReady exists exactly once per locale");
  assert.match(i18n, /sidebarDropImportReady: "松开即可导入到「\{group\}」"/);
  assert.match(i18n, /sidebarDropImportReady: "Release to import into \\"\{group\}\\""/);
});
