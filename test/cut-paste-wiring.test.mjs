import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

async function readApp() {
  return readFile(resolve(root, "web/app/app.mjs"), "utf8");
}

async function readStyles() {
  return readFile(resolve(root, "web/app/styles.css"), "utf8");
}

function sliceBetween(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `expected source slice: ${start}`);
  return source.slice(from, to);
}

test("⌘X 走剪切：与 ⌘A/⌘V 同一块路由，输入控件与浮层不拦截，动作进 cutFromKeyboard", async () => {
  const app = await readApp();
  const shortcut = sliceBetween(
    app,
    'if ((event.metaKey || event.ctrlKey) && (event.key === "a"',
    'if (event.key === "Escape" && event.defaultPrevented) return;',
  );
  assert.match(shortcut, /event\.key === "x" \|\| event\.key === "X"/);
  assert.match(shortcut, /if \(event\.target\.matches\?\.\("input, textarea, select, \[contenteditable\]"\)\) return;/,
    "输入框里的 ⌘X 不拦截");
  assert.match(shortcut, /if \(hasBlockingOverlay\(\)\) return;/);
  assert.match(shortcut, /void cutFromKeyboard\(\)/);
  const cutBody = sliceBetween(app, "function cutFromKeyboard()", "function setupKeyboardShortcuts()");
  assert.match(cutBody, /state\.scope === "trash"/, "回收站不能发起剪切");
  assert.match(cutBody, /asset\.stack\?\.id && ids\.includes\(asset\.id\)/, "折叠 Stack 节点不动作（与菜单置灰同口径）");
  assert.match(cutBody, /cutPaste\.cutAssetIds/);
});

test("⌘V 分流：剪切状态活着先执行移动并 preventDefault；否则照旧导入", async () => {
  const app = await readApp();
  const paste = sliceBetween(app, "function setupPasteImport()", "const favoriteRequests");
  assert.match(paste, /if \(cutPaste\.isCutActive\(\)\) \{\s*event\.preventDefault\(\);\s*void cutPaste\.pasteCut\(\{\}\);\s*return;\s*\}/,
    "剪切中的 ⌘V 是移动，不再导入");
  // 既有导入契约保持：编辑器不劫持、浮层让位、文件进批处理管道。
  assert.match(paste, /target\.closest\("input, textarea, select, \[contenteditable\]"\)/);
  assert.match(paste, /item\.type\.startsWith\("image\/"\)/);
  assert.match(paste, /batchImporter\.enqueue\(named, \{ metadata: currentDropImportMetadata\(\) \}\)/);
});

test("Esc 优先级：菜单 > 全屏 > 剪切 > 其他——剪切分支在清选区之前，全屏态让位", async () => {
  const app = await readApp();
  const escapeChain = sliceBetween(app, "if (event.key === \"Escape\") {", "if (state.viewMode === \"library\" && !state.selectedIds?.size) handleLibraryKeyboardNavigation");
  const cutCancel = escapeChain.indexOf("cutPaste.cancelCut({ announce: true })");
  const selectionClear = escapeChain.indexOf("gallerySelection.clear({ announce: true })");
  const fullscreen = escapeChain.indexOf("assetViewer.isAssetViewFullscreen()");
  const viewerClose = escapeChain.indexOf("closeDetailSurface()");
  assert.ok(cutCancel >= 0, "Esc 剪切取消分支存在");
  assert.ok(cutCancel < selectionClear, "剪切先于清选区");
  assert.ok(cutCancel < viewerClose, "剪切先于关大图页");
  assert.ok(fullscreen >= 0 && fullscreen < cutCancel, "全屏态先退全屏再取消剪切");
  assert.match(escapeChain, /cutPaste\.isCutActive\(\)\s*&&\s*!\(state\.viewMode === "asset"/, "全屏时不消费 Esc");
});

test("应用内写剪贴板取消剪切：writeClipboardText/writeClipboardImage 挂 noteClipboardWrite，剪切自身写入豁免", async () => {
  const app = await readApp();
  const writeImage = sliceBetween(app, "async function writeClipboardImage(", "window.__mosaToastDebug");
  assert.match(writeImage, /if \(options\.skipCutInvalidation !== true\) cutPaste\?\.noteClipboardWrite\?\.\(\)/);
  const writeText = sliceBetween(app, "async function writeClipboardText(", "async function clipboardPngBlob");
  assert.match(writeText, /cutPaste\?\.noteClipboardWrite\?\.\(\)/);
});

test("卡片变淡：markup 带 is-cut、renderKey 含剪切标记、样式只复用既有禁用透明度", async () => {
  const app = await readApp();
  assert.match(app, /\$\{isCut \? " is-cut" : ""\}/);
  assert.match(app, /state\.cutAssetIds instanceof Set && state\.cutAssetIds\.has\(asset\.id\) \? "1" : "0"/);
  const styles = await readStyles();
  assert.match(styles, /\.asset-card\.is-cut \{ opacity: \.48; \}/, "沿用既有禁用 token（opacity .48），不新增颜色值");
});

test("失焦取消在 init 绑定（cut-paste.mjs 的回退规则）", async () => {
  const app = await readApp();
  const init = sliceBetween(app, "async function init() {", "requestAnimationFrame");
  assert.match(init, /cutPaste\.bind\(\)/);
});
