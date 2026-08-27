import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

async function readApp() {
  return readFile(resolve(root, "app/app.mjs"), "utf8");
}

function sliceBetween(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `expected source slice: ${start}`);
  return source.slice(from, to);
}

test("recipe save merges prompt tags with the latest asset tags, not the render-time closure", async () => {
  const app = await readApp();
  const persist = sliceBetween(
    app,
    "async function persistInspectorDraft(panel, asset, renderId)",
    "async function flushInspectorSave()",
  );

  assert.match(app, /function latestAssetSnapshot\(projectId, assetId, fallback = null\)/);
  assert.match(persist, /const currentAsset = latestAssetSnapshot\(originProjectId, originAssetId, asset\);/);
  assert.match(persist, /tags: uniqueTags\(\[\.\.\.assetTags\(currentAsset\), \.\.\.derivePromptTags\(recipeDraft\)\]\)/);
  assert.doesNotMatch(persist, /\.\.\.\(asset\.tags \|\| \[\]\)/);
});

test("tag editor participates in dirty-state protection until its save commits", async () => {
  const app = await readApp();
  const editorActive = sliceBetween(app, "function isDetailEditorActive()", "function latestAssetSnapshot");
  const tagEditor = sliceBetween(app, "function openTagEditor(panel, asset, renderId)", "function refreshDetailTagsSection");

  assert.match(editorActive, /\[data-tag-editor\]/);
  assert.match(tagEditor, /input\?\.addEventListener\("input", syncTagDraftState\)/);
  assert.match(tagEditor, /editor\.dataset\.detailDirty = "true"/);
  assert.match(tagEditor, /editor\.dataset\.detailDirtyScope = "tags"/);
  assert.match(tagEditor, /state\.detailDirty = panelHasDirtyDraft\(panel\)/);
  assert.match(tagEditor, /const currentAsset = latestAssetSnapshot\(asset\.project_id, asset\.id, asset\)/);
  assert.match(tagEditor, /clearDetailDirtyScope\(panel, "tags"\)/);
});

test("desktop image paste never hijacks editors or stacks over another modal surface", async () => {
  const app = await readApp();
  const paste = sliceBetween(app, 'document.addEventListener("paste", async (event) => {', "api.onMenuImport");

  assert.match(paste, /target\.closest\("input, textarea, select, \[contenteditable\]"\)/);
  assert.match(paste, /confirmDialogState\.pending/);
  assert.match(paste, /!els\.settingsMenu\?\.hidden/);
  assert.match(paste, /!els\.imagePreviewModal\?\.hidden/);
  assert.match(paste, /els\.importModal\?\.classList\.contains\("open"\)/);
  assert.match(paste, /els\.groupModal\?\.classList\.contains\("open"\)/);
  assert.match(paste, /els\.accountModal\?\.classList\.contains\("open"\)/);
  assert.match(paste, /if \(editableTarget \|\| blockingSurfaceOpen\) return;/);
  assert.match(paste, /showToast\(t\("clipboardAccessDenied"\), "error"\)/);
});

test("focused video keeps native keyboard controls while Escape keeps app-layer priority", async () => {
  const app = await readApp();
  const shortcuts = sliceBetween(app, "function setupKeyboardShortcuts()", "// ===== Image preview zoom/pan/pinch");
  const escapeIndex = shortcuts.indexOf('if (event.key === "Escape") {');
  const videoGuardIndex = shortcuts.indexOf('if (event.target.closest?.("video")) return;');

  assert.ok(escapeIndex >= 0 && videoGuardIndex > escapeIndex, "Escape is handled before native video shortcut guard");
  assert.match(shortcuts, /if \(event\.target\.closest\?\.\("video"\)\) return;/);
});

test("a consumed Escape cannot also close mobile navigation", async () => {
  const app = await readApp();
  const shortcuts = sliceBetween(app, "function setupKeyboardShortcuts()", "// ===== Image preview zoom/pan/pinch");
  const consumed = shortcuts.indexOf('if (event.key === "Escape" && event.defaultPrevented) return;');
  const mobile = shortcuts.indexOf('if (event.key === "Escape" && document.body.classList.contains("mobile-nav-open"))');

  assert.ok(consumed >= 0 && mobile > consumed, "defaultPrevented guard precedes the mobile Escape branch");
});

test("masonry image loads only repair their own card instead of remeasuring the whole grid", async () => {
  const app = await readApp();
  const masonry = sliceBetween(app, "let masonryResizeObserver = null;", "let infiniteScrollObserver = null;");

  assert.match(masonry, /layoutMasonry\(\[\.\.\.masonryPendingCards\]\)/, "pending decoded cards are measured as a bounded batch");
  assert.match(masonry, /const card = media\.closest\("\.asset-card"\);\s*if \(card\) scheduleMasonryLayout\(card\);/, "an image settle schedules only its containing card");
  assert.doesNotMatch(masonry, /addEventListener\("load",\s*schedule/, "media load must not schedule a full-grid layout");
  assert.match(masonry, /Math\.abs\(width - masonryObservedWidth\) < 0\.5/, "ResizeObserver ignores height-only churn from masonry itself");
});

test("gallery card actions use grid-level delegation instead of per-card closures", async () => {
  const app = await readApp();
  const bind = sliceBetween(app, "function bindEvents()", "function bindDesktopIntegration()");
  const render = sliceBetween(app, "function renderGrid()", "/** Routed through the state machine");

  assert.match(bind, /event\.target\.closest\("\.card-favorite"\)/);
  assert.match(bind, /event\.target\.closest\("\.card-quick-copy"\)/);
  assert.match(bind, /event\.target\.closest\("\.asset-card-select"\)/);
  assert.match(bind, /els\.assetGrid\?\.addEventListener\("dblclick"/);
  assert.doesNotMatch(render, /querySelectorAll\("\.asset-card-select"\)\.forEach/);
  assert.doesNotMatch(render, /querySelectorAll\("\.card-quick-copy"\)\.forEach/);
  assert.doesNotMatch(render, /querySelectorAll\("\.card-favorite"\)\.forEach/);
});

test("populated gallery renders reconcile cards by id instead of replacing the whole grid", async () => {
  const app = await readApp();
  const reconcile = sliceBetween(app, "function reconcileAssetCards(entries)", "// F-24：入场动画范围");
  const render = sliceBetween(app, "function renderGrid()", "/** Routed through the state machine");

  assert.match(reconcile, /new Map\(\[\.\.\.grid\.querySelectorAll\(":scope > \.asset-card"\)\]/);
  assert.match(reconcile, /card\.dataset\.renderKey !== entry\.renderKey/);
  assert.match(reconcile, /card\.replaceWith\(replacement\)/);
  assert.match(reconcile, /desiredCards\.forEach\(\(card\) => \{/);
  assert.match(render, /reconcileAssetCards\(cards\)/);
  assert.doesNotMatch(render, /els\.assetGrid\.innerHTML = `\$\{cards\}/);
});

test("background library polling yields while an infinite-scroll append is in flight", async () => {
  const app = await readApp();
  const init = sliceBetween(app, "async function init()", "function renderSettingsMenu()");

  assert.match(init, /libraryRefreshTimer = setInterval\(\(\) => \{/);
  assert.match(init, /if \(!isLoadingMore\) void refreshLibraryInBackground\(\);/);
  assert.doesNotMatch(init, /setInterval\(refreshLibraryInBackground,\s*2500\)/);
  assert.match(init, /LIBRARY_REFRESH_INTERVAL/);
});

test("background stats refresh skips the effectively static library-path request", async () => {
  const apiClient = await readFile(resolve(root, "app/api-client.mjs"), "utf8");
  const stats = sliceBetween(apiClient, "async function loadStats(options = {})", "let assetRequestSequence = 0;");

  assert.match(stats, /options\.background\s*\? Promise\.resolve\(null\)\s*:\s*apiFetch\(`\/api\/library-path/);
  assert.match(stats, /apiFetch\(`\/api\/groups\?project=/);
});
