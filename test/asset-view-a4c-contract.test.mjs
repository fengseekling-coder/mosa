// GravityPort A4c（任务 90）大图查看页契约：布局按稿子改版（返回浮层头部 + 右上
// 删除/适合窗口/全屏 + 舞台两侧大箭头）、稿子里没有的旧控件从界面拿掉而 JS 引用
// 经空值守卫保留、删除→自动落点→撤销恢复、全屏进出（Esc 只退全屏）、toast 带
// 操作按钮且检视器打开时避让检视器宽度。静态守卫 + 纯函数行为测试——Node 标准库，
// 无网络访问，绝不以整文件 SHA 代替行为契约。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { assetViewLandingIndexAfterDeletion } from "../web/app/asset-view.mjs";

const root = resolve(import.meta.dirname, "..");
const readCss = () => readFile(resolve(root, "web/app/styles.css"), "utf8");
const readHtml = () => readFile(resolve(root, "web/app/index.html"), "utf8");
const readApp = () => readFile(resolve(root, "web/app/app.mjs"), "utf8");
const readAssetView = () => readFile(resolve(root, "web/app/asset-view.mjs"), "utf8");
const readToast = () => readFile(resolve(root, "web/app/toast-manager.mjs"), "utf8");
const readI18n = () => readFile(resolve(root, "web/app/i18n.mjs"), "utf8");

/** Extracts a `{...}` block starting at the marker, honouring nested braces. */
function blockAfter(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `marker not found: ${marker}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced block after marker: ${marker}`);
}

/** Extracts a source slice between two markers. */
function sliceBetween(source, openMarker, closeMarker) {
  const start = source.indexOf(openMarker);
  assert.notEqual(start, -1, `marker not found: ${openMarker}`);
  const end = source.indexOf(closeMarker, start);
  assert.notEqual(end, -1, `marker not found: ${closeMarker}`);
  return source.slice(start, end);
}

/** The body of a top-level function (declaration through the balanced closing brace). */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function not found: ${name}`);
  let parenDepth = 0;
  let cursor = source.indexOf("(", start);
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === "(") parenDepth += 1;
    if (source[cursor] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) { cursor += 1; break; }
    }
  }
  const open = source.indexOf("{", cursor);
  let braceDepth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") braceDepth += 1;
    if (source[i] === "}") {
      braceDepth -= 1;
      if (braceDepth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced function body: ${name}`);
}

const assetViewSlice = (html) => sliceBetween(html, '<section class="asset-view"', "</main>");

// ===== 1. 稿子里没有的界面元素从界面拿掉，代码保留 =====
test("1. removed legacy controls leave the markup while the JS guards stay", async () => {
  const [html, viewer] = await Promise.all([readHtml(), readAssetView()]);
  const slice = assetViewSlice(html);
  for (const id of ["assetViewPosition", "assetViewScope", "assetZoomOut", "assetZoomIn", "assetZoomValue", "assetViewNav", "assetViewControls"]) {
    assert.doesNotMatch(slice, new RegExp(`id="${id}"`), `#${id} is off the interface (task 90 removal list)`);
  }
  // 代码保留：位置/缩放状态函数仍在，元素缺省时经既有空值守卫跳过。
  assert.match(functionBody(viewer, "updateAssetViewNav"), /if \(els\.assetViewPosition\)/, "position output guard retained");
  assert.match(functionBody(viewer, "updateAssetViewControls"), /if \(els\.assetZoomValue\)/, "zoom value guard retained");
});

// ===== 2. 布局照稿子：浮层头部 + 右上动作组 + 舞台两侧箭头 =====
test("2. header is a pointer-transparent overlay and the stage fills the region", async () => {
  const css = await readCss();
  const header = blockAfter(css, ".asset-view-header {");
  assert.match(header, /position: absolute/, "header floats over the stage (mock: media centred on the full region height)");
  assert.match(header, /pointer-events: none/, "header empty areas never block stage wheel/pan");
  assert.match(header, /height: var\(--topbar-height\)/, "header keeps the topbar height token");
  assert.match(css, /\.asset-view-header > \* \{ pointer-events: auto; \}/, "header buttons stay interactive");
  const stage = blockAfter(css, ".asset-view-stage {");
  assert.match(stage, /flex: 1/, "stage fills the whole asset-view region");
});

test("3. viewer action buttons and stage arrows follow the mock geometry", async () => {
  const [html, css] = await Promise.all([readHtml(), readCss()]);
  const slice = assetViewSlice(html);
  // 右上三按钮：删除 / 适合窗口 / 全屏（适合窗口沿用 #assetZoomFit 的禁用语义）。
  assert.match(slice, /<button class="asset-view-action" id="assetViewDelete" type="button">/, "delete action button");
  assert.match(slice, /<button class="asset-view-action" id="assetZoomFit" type="button" disabled>/, "fit keeps the wired id and starts disabled");
  assert.match(slice, /<button class="asset-view-action" id="assetViewFullscreen" type="button">/, "fullscreen action button");
  const actions = blockAfter(css, ".asset-view-action {");
  assert.match(actions, /height: 24px/, "mock button height 24");
  assert.match(actions, /border-radius: var\(--radius-md\)/, "mock radius 8 via token");
  assert.match(blockAfter(css, ".asset-view-actions {"), /gap: var\(--sp-1\)/, "mock inter-button gap 4");
  // 左右箭头：沿用 prev/next id（绑定/焦点兜底/禁用语义全保留），44×44 命中区。
  assert.match(slice, /class="asset-view-arrow asset-view-arrow-prev" id="assetViewPrev" type="button"/, "prev arrow keeps its id");
  assert.match(slice, /class="asset-view-arrow asset-view-arrow-next" id="assetViewNext" type="button"/, "next arrow keeps its id");
  const arrow = blockAfter(css, ".asset-view-arrow {");
  assert.match(arrow, /position: absolute/, "arrows float over the stage");
  assert.match(arrow, /top: calc\(50% - 22px\)/, "arrows are vertically centred on the full region");
  assert.match(arrow, /width: 44px/, "44px hit target");
  assert.match(blockAfter(css, ".asset-view-arrow:disabled,"), /opacity: \.48/, "disabled state reuses the existing token");
});

// ===== 3. 删除 → 自动落点（纯函数行为 + app 侧流程契约） =====
test("4. landing index after deletion: next, then previous, then none", () => {
  const ids = ["a", "b", "c", "d"];
  const all = () => true;
  assert.equal(assetViewLandingIndexAfterDeletion(ids, 1, all), 2, "middle deletion lands on the next asset");
  assert.equal(assetViewLandingIndexAfterDeletion(ids, 3, all), 2, "last deletion lands on the previous asset");
  assert.equal(assetViewLandingIndexAfterDeletion(["only"], 0, all), -1, "deleting the only asset leaves the viewer");
  const withoutB = (id) => id !== "b";
  assert.equal(assetViewLandingIndexAfterDeletion(ids, 1, withoutB), 2, "invalid neighbours are skipped forward");
  assert.equal(assetViewLandingIndexAfterDeletion(ids, 3, withoutB), 2, "invalid neighbours are skipped backward");
  assert.equal(assetViewLandingIndexAfterDeletion(["x", "y", "z"], 1, () => false), -1, "no valid neighbour returns -1");
  assert.equal(assetViewLandingIndexAfterDeletion(ids, 9, all), -1, "out-of-range index is rejected");
});

test("5. viewer delete flow: confirm, trash, advance, undo toast, restore", async () => {
  const [app, viewer] = await Promise.all([readApp(), readAssetView()]);
  const del = functionBody(app, "deleteCurrentAssetFromViewer");
  assert.match(del, /state\.viewMode !== "asset"/, "the flow only runs in the dedicated viewer");
  assert.match(del, /confirmDetailNavigation\(\)/, "unsaved drafts guard runs first");
  assert.match(del, /requestConfirmation\(\{[\s\S]*?moveToTrashTitle[\s\S]*?tone: "danger"/, "the existing trash confirmation stays (task 90 keeps current confirm behaviour)");
  assert.match(del, /action: "trash"/, "delete means move-to-trash via the existing batch endpoint");
  assert.match(del, /assetViewer\.advanceAfterViewerDelete\(\)/, "auto-advance to the next asset after success");
  assert.match(del, /kind: "asset-deleted"/, "local reconcile removes the row");
  assert.match(del, /actionLabel: t\("undo"\)/, "the toast carries an undo action");
  assert.match(del, /t\("assetMovedToTrash"\)/, "the toast copy is the existing moved-to-trash message");
  assert.match(del, /restoreTrashedAssetFromViewer\(projectId, deletedId\)/, "undo rewires to the restore flow");
  const restore = functionBody(app, "restoreTrashedAssetFromViewer");
  assert.match(restore, /\/restore`, \{ method: "POST" \}/, "undo calls the existing restore endpoint");
  assert.match(restore, /kind: "asset-restored"/, "local reconcile re-adds the row");
  assert.match(restore, /assetViewer\.showAssetInView\(assetId\)/, "inside the viewer the restored asset is shown again");
  assert.match(restore, /openAssetView\(assetId\)/, "after a gallery fallback the restored asset reopens in the viewer");
  assert.match(functionBody(viewer, "advanceAfterViewerDelete"), /returnToLibrary\(\)/, "no neighbour left → back to the gallery");
  assert.match(functionBody(viewer, "showAssetInView"), /assetViewSequenceHasAsset\(id\)/, "undo jump validates against the live result set");
});

test("6. viewer delete/undo buttons are wired and the arrows keep the gesture guard", async () => {
  const app = await readApp();
  const bind = functionBody(app, "bindEvents");
  assert.match(bind, /els\.assetViewDelete\?\.addEventListener\("click"/, "delete button wired");
  assert.match(bind, /els\.assetViewFullscreen\?\.addEventListener\("click"/, "fullscreen button wired");
  assert.match(bind, /document\.addEventListener\("fullscreenchange", \(\) => assetViewer\.syncAssetViewFullscreenClass\(\)\)/, "fullscreen state syncs from the browser event");
  const viewer = await readAssetView();
  assert.match(functionBody(viewer, "handleAssetViewPointerDown"), /closest\("\.asset-view-controls, \.asset-view-arrow"\)/, "pointer gestures ignore the stage arrows");
});

// ===== 4. 全屏：只剩媒体，Esc 只退全屏 =====
test("7. fullscreen hides viewer chrome, falls back to CSS, Esc never closes the viewer", async () => {
  const [css, app] = await Promise.all([readCss(), readApp()]);
  assert.match(css, /\.asset-view\.is-fullscreen \{ background: #0b0b0d; \}/, "opaque black backdrop reuses the media-backdrop base value (body.mosa-v2 turns the token translucent for the preview scrim — fullscreen has nothing behind it)");
  assert.match(css, /\.asset-view\.is-fullscreen:not\(:fullscreen\) \{ position: fixed;/, "CSS fallback covers the window when the API is unavailable");
  assert.match(css, /\.asset-view\.is-fullscreen \.asset-view-header,\s*\.asset-view\.is-fullscreen \.asset-view-arrow \{ display: none; \}/, "all viewer chrome hides in fullscreen");
  const shortcuts = functionBody(app, "setupKeyboardShortcuts");
  const iFullscreen = shortcuts.indexOf("assetViewer.isAssetViewFullscreen()");
  const iViewExit = shortcuts.indexOf('if (state.viewMode === "asset" || state.detailOpen) { event.preventDefault(); void closeDetailSurface(); return; }');
  assert.ok(iFullscreen > -1, "fullscreen Escape branch exists");
  assert.ok(iFullscreen < iViewExit, "Esc in fullscreen exits fullscreen only — the viewer stays open");
  const viewer = await readAssetView();
  const toggle = functionBody(viewer, "toggleAssetViewFullscreen");
  assert.match(toggle, /requestFullscreen/, "Fullscreen API is the primary path (desktop preload has no window-fullscreen bridge; desktop/ untouched)");
  assert.match(toggle, /assetViewFullscreenFallback = true/, "no-gesture/unsupported environments degrade to the CSS state");
});

// ===== 5. toast：操作按钮 + 检视器避让（全局） =====
test("8. toast action button: text-only label, keyboard activation, duration override", async () => {
  const toast = await readToast();
  const present = functionBody(toast, "present");
  assert.match(present, /className = "toast-action"/, "the action renders as a button inside the toast");
  assert.match(present, /actionButton\.textContent = entry\.actionLabel/, "label is textContent only — no HTML pathway");
  assert.match(present, /const viaKeyboard = event\.detail === 0/, "keyboard activation is detected like the dismiss button");
  assert.match(present, /entry\.onAction\(\);/, "activation runs the injected callback");
  assert.match(present, /dismiss\(entry\.id, "action", viaKeyboard\)/, "activation dismisses the toast");
  const show = functionBody(toast, "show");
  assert.match(show, /Number\.isFinite\(options\.duration\) && options\.duration > 0 \? options\.duration : TOAST_DURATIONS\[normalizedType\]/, "duration override only via options");
  assert.match(show, /typeof options\.onAction === "function" \? options\.onAction : null/, "callback injection is type-guarded");
});

test("9. open inspector offsets the toast stack by inspector width + 20, globally", async () => {
  const css = await readCss();
  assert.match(css, /@media \(min-width: 701px\) \{\s*body\.detail-open \.toast-stack \{ right: calc\(var\(--inspector-width\) \+ 20px\); \}\s*\}/,
    "docked inspector pushes both toast lanes off the inspector; width comes from the token, not a literal");
});

// ===== 6. i18n：新键中英对称 =====
test("10. viewer copy is bilingual", async () => {
  const i18n = await readI18n();
  for (const [key, zh, en] of [
    ["assetViewBack", "返回", "Back"],
    ["assetViewActions", "大图操作", "Viewer actions"],
    ["fullscreen", "全屏", "Fullscreen"],
    ["undo", "撤销", "Undo"],
  ]) {
    assert.match(i18n, new RegExp(`${key}: "${zh}"`), `zh ${key}`);
    assert.match(i18n, new RegExp(`${key}: "${en}"`), `en ${key}`);
  }
});
