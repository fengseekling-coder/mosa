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
  assert.match(paste, /if \(state\.stagingInProgress\) return;/, "rapid paste cannot create concurrent staging files");
  assert.match(paste, /state\.stagedPath = filePath;/, "Electron paste joins the same cancel-cleanup lifecycle as manual staging");
  assert.match(paste, /if \(!els\.importModal\?\.classList\.contains\("open"\)\)[\s\S]*?cleanupStagedFile\(filePath\)/,
    "a paste staged while another overlay opens is discarded instead of becoming hidden state");
  assert.match(paste, /showToast\(t\("pasteImageSaveFailed"\), "error"\)/, "staging failures are not misreported as clipboard permissions");
});

test("global drag guard blocks default file navigation outside an active library drop target", async () => {
  const app = await readApp();
  const guard = sliceBetween(app, "function setupGlobalDragGuard()", "const favoriteRequests");

  assert.match(guard, /if \(target\.closest\("\.import-v2-path-card"\)\) return true;/);
  assert.match(guard, /return state\.viewMode === "library" && Boolean\(target\.closest\("\.library"\)\);/,
    "the shared .library container must not whitelist the large asset view");
  assert.equal((guard.match(/if \(isAllowedDropTarget\(e\.target\)\) return;/g) || []).length, 2,
    "dragover and drop use the same active-target policy");
  assert.match(guard, /if \(e\.dataTransfer\) e\.dataTransfer\.dropEffect = "none";/);
});

test("closing import during staging invalidates and removes the late staged file", async () => {
  const app = await readApp();
  const prepare = sliceBetween(app, "async function prepareImportFile", "// ===== Drag & Drop =====");
  const close = sliceBetween(app, "function closeImportModal", "function openSettingsModal");

  assert.match(app, /stagingCanceled: false/);
  assert.match(close, /if \(state\.stagingInProgress\) state\.stagingCanceled = true;/);
  assert.match(prepare, /filePath = await stageBrowserFile\(file\);\s*if \(state\.stagingCanceled\) \{\s*await cleanupStagedFile\(filePath\);\s*return false;/,
    "a stage finishing after cancel is deleted before it can become form state");
  assert.match(prepare, /if \(state\.stagingCanceled\) return false;[\s\S]*?filePath = await stageBrowserFile/,
    "cancel during old-file cleanup stops before a new upload starts");
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

test("infinite-scroll append uses a tail-only render path and virtualizes decoded thumbnails", async () => {
  const app = await readApp();
  const render = sliceBetween(app, "function renderGrid()", "/** Routed through the state machine");
  const virtualization = sliceBetween(app, "function setupGalleryMediaVirtualization", "function layoutMasonry");

  assert.match(render, /state\.assets\.slice\(animateFrom\)/, "append maps only the incoming tail");
  assert.match(render, /appendAssetCards\(cards\)/, "append avoids a full card reconciliation");
  assert.match(virtualization, /rootMargin: "1200px 0px"/, "nearby thumbnails stay warm around the viewport");
  assert.match(virtualization, /media\.removeAttribute\("src"\)/, "decoded offscreen thumbnails are released");
  assert.match(virtualization, /media\.src = source/, "virtualized thumbnails restore when they approach the viewport");
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
