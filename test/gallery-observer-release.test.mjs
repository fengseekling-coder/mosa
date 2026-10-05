import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

// 任务 61 契约矩阵（55-1 / 54-3 / 54-5）。只读源码切片，不跑 DOM：锁住
// 「画廊整体重建前统一释放卡片观察器 + 媒体观察器」「退出堆叠重渲染类型/分类
// 控件」「进出堆叠关检视器带导航选项、不算用户手动关闭」这三个实现面。运行时
// 行为由 e2e 流程 gallery-rebuild-and-stack-exit 覆盖，观察器泄漏量由审查脚本
// t-leak.mjs 在页面加载前注入计数来测。
const root = resolve(import.meta.dirname, "..");
const app = await readFile(resolve(root, "web/app/app.mjs"), "utf8");
const assetStacks = await readFile(resolve(root, "web/app/asset-stacks.mjs"), "utf8");
const count = (source, needle) => source.split(needle).length - 1;
const sliceBetween = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
};
const assertReleaseBefore = (slice, discardNeedle, label) => {
  const release = slice.indexOf("releaseGalleryObservers(");
  assert.notEqual(release, -1, `${label} must call releaseGalleryObservers`);
  const discard = slice.indexOf(discardNeedle);
  assert.notEqual(discard, -1, `${label} must still discard via ${discardNeedle}`);
  assert.ok(release < discard, `${label}: releaseGalleryObservers must run before ${discardNeedle}`);
};

test("01 releaseGalleryObservers releases both the card observer and the media observer", () => {
  const helper = sliceBetween(app, "function releaseGalleryObservers(root) {", "function setupGalleryMediaVirtualization(roots = null) {");
  assert.match(helper, /galleryCardVirtualObserver\?\.unobserve\(card\)/);
  assert.match(helper, /releaseObservedGalleryMedia\(card\)/);
  assert.match(helper, /root\.matches\?\.\("\.asset-card"\)/, "a bare card argument is released too, not only its descendants");
});

test("02 renderGrid loading early-exit releases observers before overwriting the grid", () => {
  const branch = sliceBetween(
    app,
    'if (state.galleryStatus === "loading") releaseGalleryObservers(els.assetGrid);',
    'if (state.galleryStatus === "error") {',
  );
  assertReleaseBefore(branch, "els.assetGrid.innerHTML = gallerySkeletonMarkup()", "loading branch");
});

test("03 renderGrid loading branch keeps the contract-pinned one-liner intact", () => {
  // gallery-experience / gallery-empty-state-contract 用正则钉住这行字面量；
  // 释放调用只能以同条件前置行并排保留，不许改那两条测试。
  assert.match(
    app,
    /if \(state\.galleryStatus === "loading"\) \{ els\.assetGrid\.innerHTML = gallerySkeletonMarkup\(\); restoreGridFallbackFocus\(\); return; \}/,
  );
});

test("04 renderGrid error early-exit releases observers before overwriting the grid", () => {
  const branch = sliceBetween(app, 'if (state.galleryStatus === "error") {', "if (!state.assets.length) {");
  assertReleaseBefore(branch, 'els.assetGrid.innerHTML = `<div class="error-state">', "error branch");
});

test("05 renderGrid empty early-exit releases observers before overwriting the grid", () => {
  const branch = sliceBetween(app, "if (!state.assets.length) {", "const isAppendMode = animateFrom > 0;");
  assertReleaseBefore(branch, "els.assetGrid.innerHTML = galleryEmptyMarkup()", "empty branch");
});

test("06 reconcileAssetCards releases observers before every wholesale discard", () => {
  const reconcile = sliceBetween(app, "function reconcileAssetCards(entries) {", "function appendAssetCards(entries) {");
  assertReleaseBefore(reconcile, "grid.replaceChildren()", "non-gallery-children rebuild guard");
  assertReleaseBefore(reconcile, "card.replaceWith(replacement)", "renderKey-changed card replacement");
  // 淘汰卡片的 card.remove() 循环同样必须走统一释放。
  assert.match(reconcile, /releaseGalleryObservers\(card\);\s*\n\s*if \(card\.dataset\.id\) galleryCardVirtualNodes\.delete\(card\.dataset\.id\);\s*\n\s*card\.remove\(\);/);
});

test("07 wholesale-rebuild release sites are exactly 1 definition + 6 call sites", () => {
  // 出现新的整体重建点（innerHTML / replaceChildren / replaceWith / remove
  // 丢卡片）时必须同步接入 releaseGalleryObservers 并更新这里的计数。
  assert.equal(count(app, "releaseGalleryObservers("), 7);
});

test("08 exitStack re-renders the type buttons and the category select from the restored snapshot", () => {
  const exit = sliceBetween(assetStacks, "async function exitStack() {", "async function createStackFromSelection");
  const renderType = exit.indexOf("renderTypeFilters()");
  assert.notEqual(renderType, -1, "exitStack must re-render the type filter buttons");
  const renderCategory = exit.indexOf("renderCategoryFilter()");
  assert.notEqual(renderCategory, -1, "exitStack must re-render the category select");
  const mediaKindRestore = exit.indexOf("state.mediaKind = snapshot.mediaKind");
  assert.ok(mediaKindRestore !== -1 && mediaKindRestore < renderType, "filters re-render after the snapshot restore");
  assert.match(exit, /state\.facets = \{ \.\.\.emptyFacets\(\), \.\.\.\(snapshot\.facets \|\| \{\}\) \};/);
});

test("09 entering and exiting a stack closes the inspector with the navigation option", () => {
  const enter = sliceBetween(assetStacks, "async function enterStack(", "async function restoreRootFromSnapshot");
  assert.match(enter, /closeDetailSurface\(\{ navigation: true \}\)/);
  const exit = sliceBetween(assetStacks, "async function exitStack() {", "async function createStackFromSelection");
  assert.match(exit, /closeDetailSurface\(\{ navigation: true \}\)/);
});

test("10 closeDetailSurface only sets detailManuallyClosed outside navigation closes", () => {
  const close = sliceBetween(app, "async function closeDetailSurface({ navigation = false } = {}) {", "function openDetailSurfaceManually");
  assert.match(close, /if \(!navigation\) state\.detailManuallyClosed = true;/, "navigation closes must not mark the inspector manually closed");
  assert.equal(count(close, "state.detailManuallyClosed = true"), 1, "the manual-close flag is set from exactly one guarded place");
});

test("restoring the root snapshot after a stack exit ends the gallery busy state", async () => {
  const stacks = await readFile(new URL("../web/app/asset-stacks.mjs", import.meta.url), "utf8");
  const start = stacks.indexOf("async function restoreRootFromSnapshot");
  assert.notEqual(start, -1);
  const body = stacks.slice(start, stacks.indexOf("async function exitStack", start));
  assert.match(body, /state\.galleryStatus = "ready";[\s\S]*setGalleryBusy\(false\)/,
    "a stale in-stack request never clears aria-busy, so the snapshot restore must");
  const app = await readFile(new URL("../web/app/app.mjs", import.meta.url), "utf8");
  const factory = app.slice(app.indexOf("createAssetStackController({"), app.indexOf("});", app.indexOf("createAssetStackController({")));
  assert.match(factory, /\bsetGalleryBusy,/, "setGalleryBusy must be injected into the stack controller");
});

