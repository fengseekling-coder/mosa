import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

async function readApp() {
  return readFile(resolve(root, "app/app.mjs"), "utf8");
}

async function readStyles() {
  return readFile(resolve(root, "app/styles.css"), "utf8");
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
  assert.doesNotMatch(app, /accountModal|openAccountModal|closeAccountModal/,
    "the retired standalone About dialog must not leave renderer blocking hooks behind");
  assert.match(paste, /if \(editableTarget \|\| blockingSurfaceOpen\) return;/);
  assert.match(paste, /await pasteClipboardImage\(\)/, "paste events use the shared native-image paste path");

  const sharedPaste = sliceBetween(app, "async function pasteClipboardImage()", "function setLanguage");
  assert.match(sharedPaste, /state\.stagingInProgress/, "rapid paste cannot create concurrent staging files");
  assert.match(sharedPaste, /state\.stagedPath = filePath;/, "Electron paste joins the same cancel-cleanup lifecycle as manual staging");
  assert.match(sharedPaste, /if \(!els\.importModal\?\.classList\.contains\("open"\)\)[\s\S]*?cleanupStagedFile\(filePath\)/,
    "a paste staged while another overlay opens is discarded instead of becoming hidden state");
  assert.match(sharedPaste, /showToast\(t\("pasteImageSaveFailed"\), "error"\)/, "staging failures are not misreported as clipboard permissions");
});

test("clipboard actions never use renderer clipboard reads in the production app", async () => {
  const [app, actions] = await Promise.all([
    readApp(),
    readFile(resolve(root, "app/context-menu-actions.mjs"), "utf8"),
  ]);
  assert.doesNotMatch(actions, /navigator\.clipboard\.read/);
  assert.match(actions, /pasteClipboardImage/);
  assert.match(app, /window\.electronAPI\?\.pasteImage \? pasteClipboardImage : null/);
});

test("context-menu image copy uses the stored original rather than a thumbnail", async () => {
  const [app, actions, preload, main] = await Promise.all([
    readApp(),
    readFile(resolve(root, "app/context-menu-actions.mjs"), "utf8"),
    readFile(resolve(root, "desktop/preload.cjs"), "utf8"),
    readFile(resolve(root, "desktop/main.mjs"), "utf8"),
  ]);
  assert.match(actions, /label: t\("copyImage"\)/);
  assert.match(actions, /copyOriginalImage\(asset\)/);
  assert.match(app, /const imagePath = String\(asset\.image_path \|\| ""\)\.trim\(\);/);
  assert.match(app, /const imageUrl = String\(asset\.image_url \|\| ""\)\.trim\(\);/);
  assert.doesNotMatch(app, /writeClipboardImage\([^)]*thumbnail_url/);
  assert.match(preload, /write-clipboard-image/);
  assert.match(main, /nativeImage\.createFromPath\(allowedTarget\)/);
});

test("context-menu favorite batch mutations preserve partial failures instead of claiming full success", async () => {
  const actions = await readFile(resolve(root, "app/context-menu-actions.mjs"), "utf8");
  assert.match(actions, /function reconcileBatchMutation\(assets = \[\], response = \{\}\)/);
  assert.match(actions, /if \(!response\?\.partial\) return \{ succeeded: assets, failed: \[\] \};/);
  assert.match(actions, /const outcome = reconcileBatchMutation\(assets, response\);/,
    "favorite reconciles partial batch results before reporting success");
  assert.match(actions, /if \(outcome\.failed\.length\)/,
    "favorite keeps partial failures visible instead of claiming full success");
  assert.match(actions, /batchPartialResult/,
    "partial favorite results surface an explicit partial-result message");
  assert.doesNotMatch(actions, /t\("archiveAsset"\)/,
    "archive is intentionally absent from the asset context menu");
});

test("manual sidebar groups create and rename inline without routing through the group modal", async () => {
  const [app, html, actions, bindings] = await Promise.all([
    readApp(),
    readFile(resolve(root, "app/index.html"), "utf8"),
    readFile(resolve(root, "app/context-menu-actions.mjs"), "utf8"),
    readFile(resolve(root, "app/context-menu-bindings.mjs"), "utf8"),
  ]);
  assert.match(html, /id="addGroupBtn"/);
  assert.match(html, /id="sidebarManualGroupList"/);
  assert.match(app, /function startSidebarGroupCreate\(\)/);
  assert.match(app, /function startSidebarGroupRename\(groupName\)/);
  assert.match(app, /async function commitSidebarGroupEdit\(\)/);
  assert.match(app, /addGroupBtn\?\.addEventListener\("click"[\s\S]*?startSidebarGroupCreate\(\)/);
  assert.match(app, /sidebarManualGroupList\?\.addEventListener\("focusout"[\s\S]*?commitSidebarGroupEdit\(\)/);
  assert.match(app, /event\.key === "Enter"[\s\S]*?commitSidebarGroupEdit\(\)/);
  assert.match(actions, /label: t\("renameGroup"\)/);
  assert.match(bindings, /mosa:begin-sidebar-group-rename/);
});

test("sidebar smart and manual groups collapse independently and keep compact navigation density", async () => {
  const [app, html, css] = await Promise.all([
    readApp(),
    readFile(resolve(root, "app/index.html"), "utf8"),
    readFile(resolve(root, "app/styles.css"), "utf8"),
  ]);
  assert.match(html, /id="smartGroupsToggle"[^>]*aria-expanded="true"[^>]*aria-controls="sidebarGroupList"/);
  assert.match(html, /id="assetCategoriesToggle"[^>]*aria-expanded="true"[^>]*aria-controls="sidebarManualGroupList"/);
  assert.match(app, /sidebarSmartCollapsed: safeStorageGet\("mosa\.sidebar-smart-collapsed"\) === "true"/);
  assert.match(app, /sidebarManualCollapsed: safeStorageGet\("mosa\.sidebar-manual-collapsed"\) === "true"/);
  assert.match(app, /function syncSidebarSectionVisibility\(\)/);
  assert.match(app, /function setSidebarSectionCollapsed\(section, collapsed\)/);
  assert.match(app, /function startSidebarGroupCreate\(\) \{[\s\S]*?setSidebarSectionCollapsed\("manual", false\)/);
  assert.match(css, /\.mosa-v2 \.nav-item, \.mosa-v2 \.add-group-button, \.mosa-v2 \.settings-trigger \{ min-height: 32px;/);
  assert.match(css, /\.mosa-v2 \.sidebar-group-list \{ gap: 0;/);
  assert.match(css, /\.mosa-v2 \.sidebar-section-toggle\[aria-expanded="false"\] \.sidebar-section-chevron \{ transform: rotate\(-90deg\); \}/);
});

test("sidebar primary, smart-source, and manual-group navigation stay mutually exclusive", async () => {
  const app = await readApp();
  const navigation = sliceBetween(app, "function isSidebarNavigationActive", "function toggleFacet");
  const rendering = sliceBetween(app, "function renderQuickFilters()", "function syncSidebarSectionVisibility()");

  assert.match(navigation, /function setSidebarNavigationState\(type, value = ""\)/);
  assert.match(navigation, /state\.facets\.source = "";\s*state\.facets\.group = "";/,
    "switching sidebar zones clears the other group/source selection");
  assert.match(navigation, /state\.scope = "all";\s*state\.facets\.source = "";\s*state\.facets\.group = "";\s*if \(!wasActive\) state\.facets\[navType\] = navValue;/,
    "smart/manual group navigation replaces the primary scope instead of intersecting it");
  assert.match(rendering, /isSidebarNavigationActive\(button\.dataset\.filter\)/,
    "primary navigation active styling uses the shared exclusive selection");
  assert.match(rendering, /isSidebarNavigationActive\("source", sourceType\)/,
    "smart groups use the same exclusive active-state rule");
  assert.match(rendering, /isSidebarNavigationActive\("group", groupName\)/,
    "manual groups use the same exclusive active-state rule");
});

test("group deletion uses a second confirmation to decide whether assets are kept", async () => {
  const [actions, dialog, html, translations] = await Promise.all([
    readFile(resolve(root, "app/context-menu-actions.mjs"), "utf8"),
    readFile(resolve(root, "app/confirm-dialog.mjs"), "utf8"),
    readFile(resolve(root, "app/index.html"), "utf8"),
    import(pathToFileURL(resolve(root, "app/i18n.mjs")).href).then((module) => module.default),
  ]);
  assert.match(actions, /const confirmed = await requestConfirmation\([\s\S]*?title: t\("deleteGroupTitle"\)[\s\S]*?if \(!confirmed\) return;/,
    "the original delete-group confirmation remains the first gate");
  assert.match(actions, /const deleteAssets = await requestFollowupConfirmation\([\s\S]*?title: t\("deleteGroupAssetsTitle"\)[\s\S]*?cancelLabel: t\("keepGroupAssetsAction"\)/,
    "after group deletion is confirmed, a second two-button prompt asks whether to delete the assets");
  assert.match(dialog, /async function requestFollowupConfirmation\(options = \{\}\)[\s\S]*?requestAnimationFrame\(\(\) => requestAnimationFrame\(resolve\)\)[\s\S]*?return requestConfirmation\(options\);/,
    "follow-up confirmation waits for the first dialog's closed state to paint before reusing the overlay");
  assert.match(actions, /params\.set\("deleteAssets", "true"\)/,
    "the move-to-Trash branch is explicit in the API request");
  assert.doesNotMatch(dialog, /alternateLabel|confirmDialogAlternate/,
    "the shared dialog has returned to the original two-button contract");
  assert.doesNotMatch(html, /confirmDialogAlternate|btn-danger-solid/,
    "there is no separate delete-group-and-assets button in the dialog shell");
  assert.equal(translations.zh.keepGroupAssetsAction, "保留素材");
  assert.equal(translations.zh.deleteGroupAssetsAction, "移到回收站");
});

test("Unorganized replaces Recent in primary navigation and Trash remains a first-class 90-day scope", async () => {
  const [config, html, app, client, routes, actions, translations] = await Promise.all([
    readFile(resolve(root, "app/config.mjs"), "utf8"),
    readFile(resolve(root, "app/index.html"), "utf8"),
    readFile(resolve(root, "app/app.mjs"), "utf8"),
    readFile(resolve(root, "app/api-client.mjs"), "utf8"),
    readFile(resolve(root, "lib/api/asset-routes.mjs"), "utf8"),
    readFile(resolve(root, "app/context-menu-actions.mjs"), "utf8"),
    import(pathToFileURL(resolve(root, "app/i18n.mjs")).href).then((module) => module.default),
  ]);
  assert.match(config, /SCOPES = \["all", "favorite", "unorganized", "trash"\]/);
  assert.match(html, /data-filter="unorganized"[\s\S]*?data-filter="trash"/, "Trash sits directly after Unorganized in the primary navigation");
  assert.doesNotMatch(html, /data-filter="recent"/, "Recent is no longer a primary navigation destination");
  assert.equal(translations.zh.unorganized, "未整理");
  assert.equal(translations.en.unorganized, "Unorganized");
  assert.match(client, /request\.scope === "unorganized"[\s\S]*?params\.set\("unorganized", "1"\)/);
  assert.match(routes, /unorganized: url\.searchParams\.get\("unorganized"\) === "1"/);
  assert.match(app, /unorganized: state\.groups\.unorganized/);
  assert.match(html, /id="emptyTrashBtn"/);
  assert.match(client, /request\.scope === "trash"[\s\S]*?params\.set\("trash", "1"\)/);
  assert.match(app, /TRASH_RETENTION_MS = 90 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(app, /trashRemainingDays\(asset\.deleted_at\)/);
  assert.match(actions, /\/restore`[\s\S]*?method: "POST"/);
  assert.match(actions, /\/permanent`[\s\S]*?method: "DELETE"/);
  assert.equal(translations.zh.trash, "回收站");
  assert.equal(translations.zh.trashDaysRemaining, "{count} 天后删除");
});

test("group export paginates until exhaustion without a silent asset cap", async () => {
  const actions = await readFile(resolve(root, "app/context-menu-actions.mjs"), "utf8");
  assert.doesNotMatch(actions, /collected\.length\s*<\s*5000/,
    "group export must not silently truncate libraries at 5000 assets");
  assert.match(actions, /const seenCursors = new Set\(\);/,
    "cursor-cycle detection bounds broken pagination without truncating valid exports");
  assert.match(actions, /if \(seenCursors\.has\(cursor\)\) throw new Error\("Group export pagination stalled\."\);/);
  assert.match(actions, /if \(!cursor\) break;/,
    "pagination terminates only when the server reports no next cursor");
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

test("V2 sidebar source selection does not create a redundant active-filter row", async () => {
  const css = await readStyles();

  assert.match(css, /\.mosa-v2 \.active-filters \{ display: none; \}/,
    "sidebar/source selection stays represented by the active navigation item only");
  assert.doesNotMatch(css, /\.mosa-v2 \.active-filters:not\(\[hidden\]\) \{ display: flex; \}/,
    "active source facets must not reopen the legacy chip/clear-all toolbar");
});

test("overlay motion is discrete-safe, token-driven, and disabled for reduced motion", async () => {
  const css = await readStyles();
  const reducedMotion = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));

  assert.match(css, /\.modal-overlay \{[^}]*display var\(--duration-normal\) allow-discrete/,
    "modal overlays keep their fade while display is removed discretely");
  assert.match(css, /@starting-style \{[\s\S]*?\.modal-overlay\.open \{ opacity: 0; \}/,
    "modal entrance has an explicit starting style instead of a hard cut");
  assert.doesNotMatch(css, /account-modal-card/,
    "the retired standalone About dialog must not leave a second modal surface behind");
  assert.match(css, /\.image-preview-modal\[hidden\][^}]*pointer-events: none/,
    "a visually exiting preview cannot intercept input after hidden is set");
  assert.match(css, /\.drag-overlay \{[^}]*var\(--duration-fast\)[^}]*allow-discrete/,
    "drag feedback stays on the fast motion token");
  assert.match(css, /\.mobile-nav-scrim \{[\s\S]*?transition: opacity var\(--duration-slow\)/,
    "the compact-navigation scrim fades on the same slow token as the drawer");
  for (const selector of [".modal-overlay", ".image-preview-modal", ".drag-overlay", ".mosa-v2 .sidebar", ".mobile-nav-scrim"]) {
    assert.ok(reducedMotion.includes(selector), `${selector} must opt out under reduced motion`);
  }
});

test("image preview keeps media alive through its exit transition and cancels stale cleanup on reopen", async () => {
  const app = await readApp();
  const lifecycle = sliceBetween(app, "let imagePreviewCleanupTimer", "function fitImagePreview()");
  const close = sliceBetween(app, "function closeImagePreview()", "function trapImagePreviewFocus");
  const finalizer = sliceBetween(app, "function finalizeImagePreviewClose()", "function scheduleImagePreviewCleanup()");

  assert.match(lifecycle, /function cancelPendingImagePreviewCleanup\(\)/);
  assert.match(lifecycle, /function openImagePreview[\s\S]*?cancelPendingImagePreviewCleanup\(\);[\s\S]*?state\.imagePreviewId = asset\.id/,
    "reopening invalidates the previous close cleanup before a new preview is installed");
  assert.match(close, /els\.imagePreviewModal\.hidden = true;/);
  assert.match(close, /scheduleImagePreviewCleanup\(\);/);
  assert.doesNotMatch(close, /removeAttribute\("src"\)/,
    "close must not tear media down before the visual exit completes");
  assert.match(finalizer, /imagePreviewImage\?\.removeAttribute\("src"\)/);
  assert.match(finalizer, /imagePreviewVideo\?\.removeAttribute\("src"\)/);
  assert.match(lifecycle, /prefers-reduced-motion: reduce/,
    "reduced-motion users skip the deferred visual cleanup path");
  assert.match(lifecycle, /transitionend/);
  assert.match(lifecycle, /setTimeout\(\(\) => finish\(\), 260\)/,
    "hidden or throttled windows still have a bounded cleanup fallback");
});

test("masonry image loads only repair their own card instead of remeasuring the whole grid", async () => {
  const app = await readApp();
  const css = await readStyles();
  const masonry = sliceBetween(app, "let masonryResizeObserver = null;", "let infiniteScrollObserver = null;");

  assert.match(masonry, /layoutMasonry\(\[\.\.\.masonryPendingCards\]\)/, "pending decoded cards are measured as a bounded batch");
  assert.match(masonry, /const card = media\.closest\("\.asset-card"\);\s*if \(card\) scheduleMasonryLayout\(card\);/, "an image settle schedules only its containing card");
  assert.doesNotMatch(masonry, /addEventListener\("load",\s*schedule/, "media load must not schedule a full-grid layout");
  assert.match(masonry, /Math\.abs\(width - masonryObservedWidth\) < 0\.5/, "ResizeObserver ignores height-only churn from masonry itself");
  assert.match(masonry, /card\.classList\.remove\("masonry-content-virtualized"\);[\s\S]*?getBoundingClientRect\(\)[\s\S]*?card\.classList\.add\("masonry-content-virtualized"\)/,
    "offscreen content virtualization is enabled only after the real masonry height is measured");
  assert.match(css, /\.asset-card\.masonry-content-virtualized\s*\{[^}]*content-visibility:\s*auto;/,
    "laid-out cards use browser-native offscreen rendering virtualization");
});

test("gallery card creation parses each changed batch once instead of one template per card", async () => {
  const app = await readApp();
  const creation = sliceBetween(app, "function initializeAssetCardElement", "function reconcileAssetCards(entries)");
  const reconcile = sliceBetween(app, "function reconcileAssetCards(entries)", "// F-24：入场动画范围");

  assert.match(creation, /function createAssetCardElements\(entries\)/);
  assert.match(creation, /template\.innerHTML = entries\.map\(\(entry\) => entry\.markup\.trim\(\)\)\.join\(""\)/,
    "one template parse materializes the whole changed batch");
  assert.match(reconcile, /const createdCards = createAssetCardElements\(entriesNeedingCards\)/);
  assert.doesNotMatch(reconcile, /document\.createElement\("template"\)/,
    "reconciliation does not parse markup inside the per-card loop");
});

test("loaded-page refresh fetches off-DOM and commits the gallery once", async () => {
  const apiClient = await readFile(resolve(root, "app/api-client.mjs"), "utf8");
  const reload = sliceBetween(apiClient, "async function reloadLoadedAssetPages(options = {})", "async function refreshLoadedAssetsInBackground()");
  const refresh = sliceBetween(apiClient, "async function refreshLoadedAssetsInBackground()", "async function refreshLibraryInBackground()");

  assert.doesNotMatch(reload, /loadAssets\(/, "loaded pages are not committed one at a time");
  assert.match(reload, /const pages = \[\];[\s\S]*?for \(let page = 0; page < pageCount; page \+= 1\)/,
    "all currently loaded pages are assembled in a private snapshot first");
  assert.equal((reload.match(/renderGrid\(/g) || []).length, 1, "the refreshed snapshot has one gallery commit point");
  assert.match(refresh, /return reloadLoadedAssetPages\(\{ background: true \}\)/,
    "a revision change reloads the complete loaded window so changes beyond page one cannot be hidden");
});

test("bridge status exposes active reconciliation instead of reporting ready", async () => {
  const app = await readApp();
  const applyStatus = sliceBetween(app, "function applyBridgeStatus", "function applyBridgeStatusFailure");
  assert.match(applyStatus, /codex\?\.busy \|\| grok\?\.busy \|\| cowart\?\.busy/,
    "renderer must consume the bridge busy signal");
  assert.match(applyStatus, /bridgeBusy\) setStatus\(t\("statusBridgeBusy"\), "warn"\)/,
    "active reconciliation must be visible before the ready state");
});

test("keyed gallery refresh lets native scroll anchoring preserve the viewed card", async () => {
  const app = await readApp();
  const render = sliceBetween(app, "function renderGrid()", "/** Routed through the state machine");
  assert.match(render, /changedCards\.length >= state\.assets\.length/,
    "numeric scroll restoration is reserved for a full populated replacement");
  assert.doesNotMatch(render, /if \(savedScrollTop !== null\) \{\s*requestAnimationFrame/,
    "incremental keyed refreshes must not always overwrite Chromium scroll anchoring");
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

  assert.match(reconcile, /const existingCardList = \[\.\.\.grid\.querySelectorAll\(":scope > \.asset-card"\)\]/);
  assert.match(reconcile, /new Map\(existingCardList\.map\(\(card\) => \[card\.dataset\.id, card\]\)\)/);
  assert.match(reconcile, /card\.dataset\.renderKey !== entry\.renderKey/);
  assert.match(reconcile, /card\.replaceWith\(replacement\)/);
  assert.match(reconcile, /desiredCards\.forEach\(\(card\) => \{/);
  assert.match(render, /reconcileAssetCards\(cards\)/);
  assert.doesNotMatch(render, /els\.assetGrid\.innerHTML = `\$\{cards\}/);
});

test("infinite-scroll append uses a tail-only render path and virtualizes decoded thumbnails", async () => {
  const app = await readApp();
  const apiClient = await readFile(resolve(root, "app/api-client.mjs"), "utf8");
  const render = sliceBetween(app, "function renderGrid()", "/** Routed through the state machine");
  const virtualization = sliceBetween(app, "function setupGalleryMediaVirtualization", "function layoutMasonry");
  const infiniteScroll = sliceBetween(app, "function setupInfiniteScroll()", "/**\n * Placeholders sized like real cards");

  assert.match(render, /state\.assets\.slice\(animateFrom\)/, "append maps only the incoming tail");
  assert.match(render, /appendAssetCards\(cards\)/, "append avoids a full card reconciliation");
  assert.match(app, /class=\"asset-load-more\" hidden/, "normal infinite scrolling keeps the pagination boundary invisible");
  assert.match(render, /syncRenderedSelection\(\{[\s\S]*?prune: false,[\s\S]*?changedIds:/,
    "append selection sync touches only the newly mounted tail");
  assert.match(virtualization, /rootMargin: "1200px 0px"/, "nearby thumbnails stay warm around the viewport");
  assert.match(virtualization, /media\.removeAttribute\("src"\)/, "decoded offscreen thumbnails are released");
  assert.match(virtualization, /media\.src = source/, "virtualized thumbnails restore when they approach the viewport");
  assert.match(infiniteScroll, /root: grid/, "the infinite-scroll observer is rooted in the actual scrolling gallery");
  assert.match(infiniteScroll, /grid\.clientHeight \* 0\.85/, "cached pages mount before the user reaches the boundary without auto-appending at launch");
  assert.match(infiniteScroll, /fallbackButton\.hidden = false/, "manual pagination appears only as a real fallback after observer/load failure");
  assert.match(apiClient, /prefetchAssetPageChain\(request, cursor, 2, assetPrefetchGeneration\)/,
    "the data pipeline keeps two cursor pages ahead of the viewport");
  assert.match(apiClient, /includeTotal: false/, "prefetch pages skip redundant exact-count work");
});

test("large galleries use explicit masonry placement and bounded card hydration", async () => {
  const app = await readApp();
  const css = await readFile(resolve(root, "app/styles.css"), "utf8");
  const virtualization = sliceBetween(app, "function galleryVirtualSpanKey", "function bindGalleryVideoFrame");
  const masonry = sliceBetween(app, "function layoutMasonry", "function scheduleMasonryLayout");

  assert.match(app, /const GALLERY_CARD_VIRTUAL_THRESHOLD = 40;/,
    "virtualization starts exactly at the first gallery page so later appends never cross a full-DOM cliff");
  assert.match(virtualization, /data-virtual-span="\$\{span\}"/,
    "virtual placeholders preserve an explicit masonry span before hydration");
  assert.match(virtualization, /galleryCardVirtualVisiblePendingChanges/,
    "visible hydration has a priority queue independent from background preloading");
  assert.match(virtualization, /new IntersectionObserver\([\s\S]*?rootMargin: "1200px 0px"/,
    "native intersection observation drives card hydration in supported browsers");
  assert.match(virtualization, /galleryCardVirtualLowerBound/,
    "the non-IntersectionObserver fallback binary-searches per-column masonry geometry instead of scanning every card");
  assert.match(virtualization, /takeChanges\(galleryCardVirtualVisiblePendingChanges, 6\)/,
    "fast-scroll visible hydration is bounded per frame instead of blocking the compositor");
  assert.doesNotMatch(virtualization, /flushVisibleGalleryCardVirtualChanges/,
    "the scroll path never synchronously hydrates the whole visible virtual set");
  assert.match(virtualization, /if \(hydratedCards\.length\) setupGalleryMediaVirtualization\(hydratedCards\);/,
    "hydration preserves placeholder geometry and avoids immediate masonry measurement");
  assert.doesNotMatch(virtualization, /layoutMasonry\(hydratedCards\)/,
    "virtual-card hydration does not force a synchronous masonry read/write cycle");
  assert.match(virtualization, /galleryCardVirtualScrollGrid\.addEventListener\("scroll", handleGalleryCardVirtualScroll/,
    "indexed scroll synchronization guards large compositor jumps without an O(N) card scan");
  assert.match(masonry, /const columnEnds = Array\(columnCount\)\.fill\(1\)/,
    "masonry placement tracks column heights in a linear pass");
  assert.match(masonry, /const canAppendIncrementally =[\s\S]*?galleryCardVirtualGeometryColumns\[columnIndex\]\.push\(geometry\)[\s\S]*?return;/,
    "infinite-scroll append extends existing masonry columns instead of re-placing the full gallery");
  assert.match(masonry, /const previousSpan[\s\S]*?removeProperty\("grid-row-end"\)[\s\S]*?measureTargets\.forEach[\s\S]*?getBoundingClientRect\(\)/,
    "masonry preserves the previous span and batches layout writes before geometry reads");
  assert.match(masonry, /card\.style\.gridColumnStart = String\(columnStart\)/);
  assert.match(masonry, /card\.style\.gridRowStart = String\(rowStart\)/);
  assert.doesNotMatch(css, /grid-auto-flow:\s*dense/,
    "the browser must not run dense backtracking across thousands of masonry items");
});

test("background library polling yields while an infinite-scroll append is in flight", async () => {
  const app = await readApp();
  const init = sliceBetween(app, "async function init()", "async function loadProductVersion()");
  const pageshow = sliceBetween(app, 'window.addEventListener("pageshow",', "function refreshBridgeStatus()");
  const apiClient = await readFile(resolve(root, "app/api-client.mjs"), "utf8");

  assert.match(init, /libraryRefreshTimer = setInterval\(\(\) => \{/);
  assert.match(init, /if \(!isLoadingMore\) void refreshLibraryIfChanged\(\);/);
  assert.match(pageshow, /if \(!isLoadingMore\) void refreshLibraryIfChanged\(\);/, "bfcache recovery keeps the lightweight revision guard");
  assert.doesNotMatch(pageshow, /refreshLibraryInBackground\(\)/, "bfcache recovery must not restore the heavy polling path");
  assert.doesNotMatch(init, /setInterval\(refreshLibraryInBackground,\s*2500\)/);
  assert.match(init, /LIBRARY_REFRESH_INTERVAL/);
  assert.match(apiClient, /\/api\/library-revision\?project=/, "timer polls only a lightweight revision token");
  assert.match(apiClient, /if \(nextRevision === lastLibraryRevision\) return false;/, "unchanged libraries do not reload groups or assets");
});

test("library updates use a realtime event stream with revision polling as fallback", async () => {
  const app = await readApp();
  const apiClient = await readFile(resolve(root, "app/api-client.mjs"), "utf8");

  assert.match(app, /new EventSource\(`\/api\/library-events\?project=\$\{encodeURIComponent\(project\)\}`\)/);
  assert.match(app, /source\.addEventListener\("library-changed"/);
  assert.match(app, /void reconcileLibraryRevision\(payload\.revision\)/, "SSE ready reconciles the revision instead of blindly advancing the displayed baseline");
  assert.match(app, /void reconcileLibraryRevision\(revision\)/, "library-changed reconciles only after the visible library catches up");
  assert.match(app, /if \(!isLoadingMore\) void refreshLibraryIfChanged\(\);/, "visibility recovery keeps a direct lightweight fallback check");
  assert.match(app, /stopLibraryEventStream\(\);/, "hidden or torn-down pages release their SSE connection");
  assert.match(apiClient, /function noteLibraryRevision\(revision\)/);
  assert.match(apiClient, /async function reconcileLibraryRevision\(revision\)/);
  assert.match(apiClient, /return reloadLoadedAssetPages\(\{ background: true \}\)/, "revision-triggered refreshes reconcile the complete loaded window");
  assert.match(apiClient, /return statsRefreshed !== false && assetsRefreshed !== false;/,
    "a failed or stale background loader must not consume the advertised library revision");
  assert.match(apiClient, /\/api\/library-revision\?project=/, "periodic revision polling remains as a reconnect/failure fallback");
});

test("background stats refresh skips the effectively static library-path request", async () => {
  const apiClient = await readFile(resolve(root, "app/api-client.mjs"), "utf8");
  const stats = sliceBetween(apiClient, "async function loadStats(options = {})", "let assetRequestSequence = 0;");

  assert.match(stats, /options\.background\s*\? Promise\.resolve\(null\)\s*:\s*apiFetch\(`\/api\/library-path/);
  assert.match(stats, /apiFetch\(`\/api\/groups\?project=/);
});
