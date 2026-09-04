// ConfirmDialog contract (Phase 5B / F-15): the single app-wide confirmation
// dialog that replaced every window.confirm, its single-pending Promise API,
// focus/Escape lifecycle, the four migrated business paths, the async
// confirmDetailNavigation guard, and the zero-change perimeters. Node standard
// library only, no network access, and never a whole-file SHA of app.js /
// index.html as a substitute for behaviour contracts (package manifest pins
// excepted).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const readApp = () => readFile(resolve(root, "app/app.mjs"), "utf8");
const readAssetView = () => readFile(resolve(root, "app/asset-view.mjs"), "utf8");
const readConfirmDialog = () => readFile(resolve(root, "app/confirm-dialog.mjs"), "utf8");
const readHtml = () => readFile(resolve(root, "app/index.html"), "utf8");
const readCss = () => readFile(resolve(root, "app/styles.css"), "utf8");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const count = (source, needle) => source.split(needle).length - 1;

/** Slices a top-level app.js function (async or sync) up to the next top-level function. */
function functionSlice(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function not found: ${name}`);
  const candidates = ["\nfunction ", "\nasync function "]
    .map((marker) => source.indexOf(marker, start + 1))
    .filter((index) => index !== -1);
  const next = candidates.length ? Math.min(...candidates) : -1;
  return source.slice(start, next === -1 ? source.length : next);
}

// 1-7. One static ConfirmDialog with the full dialog ARIA contract and native buttons.
test("1-7. a single app-wide ConfirmDialog with dialog semantics", async () => {
  const html = await readHtml();
  assert.equal(count(html, 'id="confirmDialog"'), 1, "exactly one ConfirmDialog overlay");
  assert.equal(count(html, "confirm-dialog-card"), 1, "exactly one confirm dialog card");
  assert.equal(count(html, 'id="confirmDialogTitle"'), 1, "exactly one dialog title");
  assert.equal(count(html, 'id="confirmDialogDescription"'), 1, "exactly one dialog description");
  const overlay = html.slice(html.indexOf('id="confirmDialog"'), html.indexOf('id="imagePreviewModal"'));
  assert.match(overlay, /role="dialog"/, "role=dialog");
  assert.match(overlay, /aria-modal="true"/, "aria-modal=true");
  assert.match(overlay, /aria-labelledby="confirmDialogTitle"/, "aria-labelledby points at the title");
  assert.match(overlay, /aria-describedby="confirmDialogDescription"/, "aria-describedby points at the description");
  assert.match(overlay, /<h3 id="confirmDialogTitle">/, "title is real text content");
  assert.match(overlay, /<p id="confirmDialogDescription">/, "description is real text content");
  assert.match(overlay, /<button class="btn-secondary" id="confirmDialogCancel" type="button"/, "Cancel is a native button");
  assert.match(overlay, /<button class="btn-danger" id="confirmDialogConfirm" type="button"/, "Confirm is a native button");
  assert.doesNotMatch(overlay, /confirmDialogAlternate/, "ConfirmDialog stays a two-button surface");
  assert.match(overlay, /data-i18n="cancel"/, "Cancel reuses the shared cancel copy");
  assert.match(html, /class="modal-overlay confirm-dialog-overlay" id="confirmDialog"/, "reuses the modal-overlay shell");
});

// 8-11. One Promise API, boolean result, resolver settles once, one pending at a time.
test("8-11. single Promise API with a single pending confirmation", async () => {
  const app = await readApp();
  const confirmDialog = await readConfirmDialog();
  const request = functionSlice(confirmDialog, "requestConfirmation");
  const close = functionSlice(confirmDialog, "closeConfirmDialog");
  assert.match(confirmDialog, /function requestConfirmation\(\{/, "the single confirmation API exists");
  assert.match(request, /return new Promise\(\(resolve\) =>/, "returns a Promise");
  assert.equal(count(request, "confirmDialogState.resolve = resolve"), 1, "resolver assigned exactly once per open");
  assert.match(close, /resolve\(result\)/, "resolves with the boolean result");
  assert.match(app, /closeConfirmDialog\(true\)/, "Confirm settles true");
  assert.match(app, /closeConfirmDialog\(false\)/, "Cancel settles false");
  assert.match(close, /if \(!confirmDialogState\.pending\) return;/, "resolver settles only once");
  assert.match(close, /confirmDialogState\.resolve = null;/, "resolver cleared on close");
  assert.match(request, /if \(confirmDialogState\.pending \|\| !els\.confirmDialog\) return Promise\.resolve\(false\);/,
    "a second request while pending resolves false immediately — no queue, no resolver override");
  assert.doesNotMatch(request, /(rootId|childId)\s*=/, "never assigns the anchored-overlay manager private state");
});

// 12-15. Confirm=true, Cancel/Escape/Backdrop=false; the backdrop can never confirm.
test("12-15. result semantics — backdrop can only cancel", async () => {
  const app = await readApp();
  const confirmDialog = await readConfirmDialog();
  assert.match(app, /els\.confirmDialogConfirm\?\.addEventListener\("click", \(\) => closeConfirmDialog\(true\)\);/, "Confirm button settles true");
  assert.match(app, /els\.confirmDialogCancel\?\.addEventListener\("click", \(\) => closeConfirmDialog\(false\)\);/, "Cancel button settles false");
  const trap = functionSlice(confirmDialog, "trapConfirmDialogFocus");
  assert.match(trap, /closeConfirmDialog\(false\)/, "Escape settles false");
  const backdrop = app.match(/els\.confirmDialog\?\.addEventListener\("click",[^\n]*/)?.[0] || "";
  assert.match(backdrop, /event\.target === els\.confirmDialog\) closeConfirmDialog\(false\)/, "backdrop click only cancels");
  assert.doesNotMatch(backdrop, /closeConfirmDialog\(true\)/, "backdrop can never confirm");
});

// 16-18. Default focus lands on Cancel; Tab/Shift+Tab cycle between the two buttons.
test("16-18. default focus on Cancel with a two-stop Tab cycle", async () => {
  const app = await readApp();
  const confirmDialog = await readConfirmDialog();
  const request = functionSlice(confirmDialog, "requestConfirmation");
  const trap = functionSlice(confirmDialog, "trapConfirmDialogFocus");
  assert.match(request, /requestAnimationFrame\(\(\) => \{ if \(confirmDialogState\.pending\) els\.confirmDialogCancel\?\.focus\(\); \}\);/,
    "opening focuses Cancel — destructive actions never default-focus the confirm button");
  assert.match(trap, /const focusable = \[els\.confirmDialogCancel, els\.confirmDialogConfirm\]/, "the trap cycles exactly the two dialog buttons");
  assert.match(trap, /event\.shiftKey \? \(current <= 0 \? focusable\.length - 1 : current - 1\) : \(current === focusable\.length - 1 \? 0 : current \+ 1\)/,
    "Tab wraps forward and Shift+Tab wraps backward");
  assert.match(trap, /event\.preventDefault\(\);\s*\n\s*focusable\[next\]\.focus\(\);/, "focus never escapes to the page background");
});

// 19-21. Escape is consumed at the head of the priority chain and never leaks.
test("19-21. Escape consumed first, never leaks into the viewer", async () => {
  const app = await readApp();
  const confirmDialog = await readConfirmDialog();
  const trap = functionSlice(confirmDialog, "trapConfirmDialogFocus");
  assert.match(trap, /event\.preventDefault\(\);\s*\n\s*event\.stopPropagation\(\);\s*\n\s*closeConfirmDialog\(false\);/,
    "Escape is preventDefault + stopPropagation, then cancels");
  assert.ok(app.indexOf('document.addEventListener("keydown", trapConfirmDialogFocus);')
    < app.indexOf('document.addEventListener("keydown", trapImportModalFocus);'),
  "the confirm trap registers before the legacy modal traps — Escape priority head");
  const shortcuts = functionSlice(app, "setupKeyboardShortcuts");
  assert.match(shortcuts, /if \(confirmDialogState\.pending\) return;/, "background shortcuts stay silent while the dialog is open");
  const keyboardNav = functionSlice(app, "bindKeyboardNav");
  assert.match(keyboardNav, /confirmDialogState\.pending/, "arrow-key gallery navigation stays silent while the dialog is open");
});

// 22-23. Focus returns to a connected trigger; a disconnected trigger falls back safely.
test("22-23. focus restoration with safe fallbacks", async () => {
  const app = await readApp();
  const confirmDialog = await readConfirmDialog();
  const restore = functionSlice(confirmDialog, "restoreConfirmDialogFocus");
  const target = functionSlice(confirmDialog, "isConfirmFocusTarget");
  assert.match(restore, /requestAnimationFrame\(/, "restoration is deferred through rAF");
  assert.match(restore, /for \(const candidate of \[returnFocus, triggerElement\]\)/, "priority 1 returnFocus, priority 2 pre-open activeElement");
  assert.match(restore, /data-action="archive-asset"/, "priority 3 stable requery for the archive entry");
  assert.match(restore, /data-action="regenerate"/, "priority 3 stable requery for the regenerate entry");
  assert.match(restore, /\[data-version-select\]/, "priority 3 stable requery for the version picker");
  assert.match(restore, /els\.batchArchive/, "priority 3 stable requery for the batch entry");
  assert.match(restore, /state\.viewMode === "asset" \? els\.assetViewBack : els\.searchInput/, "priority 4 safe zone, never body");
  assert.match(target, /element\.isConnected && !element\.disabled && !element\.hidden && element\.offsetParent !== null/,
    "never restores into disconnected, disabled, hidden, or invisible nodes");
  assert.doesNotMatch(restore, /document\.body\.focus/, "focus never lands on body");
});

// 24-25. Existing surfaces close through the shared wrapper before the dialog opens.
test("24-25. filter/settings surfaces close before opening", async () => {
  const app = await readApp();
  const confirmDialog = await readConfirmDialog();
  const request = functionSlice(confirmDialog, "requestConfirmation");
  const closeFilter = request.indexOf('closePanel(els.filterPanel, els.filterToggle, "confirm-dialog")');
  const closeSettings = request.indexOf('closePanel(els.settingsMenu, els.settingsToggle, "confirm-dialog")');
  const open = request.indexOf('els.confirmDialog.classList.add("open")');
  assert.ok(closeFilter > -1 && closeSettings > -1, "Filter and Settings close via the shared closePanel wrapper");
  assert.ok(closeFilter < open && closeSettings < open, "surfaces close before the dialog opens");
  assert.match(app, /function closePanel\(panel, trigger, reason = "escape"\)[\s\S]*?panel\.hidden = true;[\s\S]*?trigger\?\.setAttribute\("aria-expanded", "false"\)/,
    "closePanel no longer depends on the retired anchored-overlay manager");
});

// 26-29. window.confirm is gone; batch archive confirms on a selection snapshot.
// 2026-08-18: V2-only token consolidation. The V2 design retired the
// batch-management affordance entirely; `batchArchive()` was removed from
// `app.mjs` along with `state.selectedIds`. Single-asset archive still
// goes through the dialog and is asserted in test 30-31 below.

// 30-31. Single-asset archive confirms before the API and keeps everything on Cancel.
test("30-31. single archive confirms before touching the API", async () => {
  const app = await readApp();
  const start = app.indexOf('panel.querySelector(\'[data-action="archive-asset"]\')?.addEventListener');
  assert.notEqual(start, -1, "archive-asset listener exists");
  const section = app.slice(start, start + 2500);
  assert.match(section, /title: t\("archiveOneTitle"\)/, "uses the single-archive copy");
  assert.match(section, /tone: "danger"/, "single archive keeps danger tone");
  assert.match(section, /returnFocus: trigger/, "Cancel returns focus to the archive button");
  const confirm = section.indexOf("await requestConfirmation");
  const cancel = section.indexOf("if (!confirmed) return;");
  const apiCall = section.indexOf("/archive");
  assert.ok(confirm < cancel && cancel < apiCall, "Cancel keeps the viewer, position, and inspector — no API call");
  assert.match(section, /isCurrentDetailSelection\(asset\.project_id, asset\.id\)/, "context recheck after confirm");
});

// 32-35. Restricted regenerate only confirms when blocked > 0, in warning tone.
test("32-35. restricted regenerate keeps warning semantics", async () => {
  const app = await readApp();
  const start = app.indexOf('panel.querySelector(\'[data-action="regenerate"]\')?.addEventListener');
  assert.notEqual(start, -1, "regenerate listener exists");
  const next = app.indexOf('panel.querySelector(\'[data-action="archive-asset"]\')?.addEventListener', start + 1);
  assert.notEqual(next, -1, "archive-asset listener follows the regenerate listener");
  const section = app.slice(start, next);
  assert.match(section, /if \(blocked\.length\) \{/, "blocked=0 never opens the dialog");
  assert.match(section, /title: t\("restrictedRegenerateTitle"\)/, "uses the restricted-regenerate copy");
  assert.match(section, /t\("restrictedRegenerateDescription", \{ count: blocked\.length \}\)/, "count interpolates");
  assert.match(section, /tone: "warning"/, "warning tone, never the destructive red");
  assert.doesNotMatch(section, /tone: "danger"/, "restricted regenerate never uses danger");
  const confirm = section.indexOf("await requestConfirmation");
  const cancel = section.indexOf("if (!confirmed || !isCurrentDetailSelection(asset.project_id, asset.id)) return;");
  const clipboard = section.indexOf("writeClipboardText(regenerationInstruction(asset, snapshot))");
  assert.ok(confirm < cancel && cancel < clipboard, "Cancel never writes the clipboard; Confirm reuses regenerationInstruction");
});

// 36-42. confirmDetailNavigation is async, awaited everywhere, and flushes the pending auto-save before navigation.
test("36-42. async dirty-navigation guard awaited at every call site", async () => {
  const app = await readApp();
  const viewer = await readAssetView();
  assert.match(app, /async function confirmDetailNavigation\(\)/, "the guard is async");
  const guard = functionSlice(app, "confirmDetailNavigation");
  assert.match(guard, /return flushInspectorSave\(\);/,
    "navigation flushes the pending auto-save; a failed flush returns false and blocks navigation instead of prompting to discard");
  assert.match(app, /async function persistInspectorDraft\(panel, asset, renderId\)/, "the debounced auto-save path exists");
  assert.ok(count(app, "await confirmDetailNavigation(") >= 2, "all app-side destructive navigation paths await the shared guard");
  assert.equal(count(viewer, "await confirmDetailNavigation("), 2, "openAssetView and previous/next navigation await in asset-view.mjs");
  assert.doesNotMatch(app, /if \(!confirmDetailNavigation\(/, "no synchronous call site survives");
  assert.match(app, /async function selectAsset\(id, shouldScroll = false\)/, "selectAsset migrated to async");
  assert.match(viewer, /async function openAssetView\(id, trigger\)/, "openAssetView migrated to async");
  const helper = functionSlice(app, "selectDetailVersion");
  assert.match(helper, /if \(!await confirmDetailNavigation\(target\.id\)\) \{ restoreVersionPickerValue\(\); return false; \}/,
    "a failed flush restores the select value and keeps the current version");
  assert.match(helper, /state\.selectedId = target\.id;/, "a successful flush completes the version switch");
});

// 43-44. Context keys and stale-result guards on every async path.
test("43-44. contextKey guards keep stale results from acting", async () => {
  const app = await readApp();
  const viewer = await readAssetView();
  // 2026-08-26: auto-save retired the discard-confirmation prompt, so the
  // `:discard-version` contextKey retired with it (navigation now flushes the
  // pending draft instead of asking permission to discard). The single-asset
  // archive and restricted-regenerate context keys still guard their paths.
  assert.match(app, /contextKey: `\$\{asset\.project_id\}:\$\{asset\.id\}:archive-asset`/, "single archive contextKey");
  assert.match(app, /contextKey: `\$\{asset\.project_id\}:\$\{asset\.id\}:restricted-regenerate`/, "restricted regenerate contextKey");
  const selectAsset = functionSlice(app, "selectAsset");
  const openView = functionSlice(viewer, "openAssetView");
  const helper = functionSlice(app, "selectDetailVersion");
  for (const [name, body] of [["selectAsset", selectAsset], ["openAssetView", openView], ["selectDetailVersion", helper]]) {
    assert.ok(body.indexOf("await confirmDetailNavigation") < body.indexOf("isCurrentDetailSelection"),
      `${name} rechecks the context after the flush resolves`);
  }
});

// 45-50. Four distinct copy sets, symmetric i18n, correct tone assignment.
test("45-50. distinct copy per path with symmetric i18n", async () => {
  const { default: translations } = await import(pathToFileURL(resolve(root, "app/i18n.mjs")).href);
  const keys = ["archiveManyTitle", "archiveManyDescription", "archiveOneTitle", "archiveOneDescription", "archiveAction",
    "discardChangesTitle", "discardChangesDescription", "discardChangesAction",
    "restrictedRegenerateTitle", "restrictedRegenerateDescription", "restrictedRegenerateAction"];
  for (const locale of ["zh", "en"]) {
    for (const key of keys) {
      assert.ok(typeof translations[locale][key] === "string" && translations[locale][key].length, `${locale}.${key} exists`);
    }
  }
  const zhTitles = [translations.zh.archiveManyTitle, translations.zh.archiveOneTitle, translations.zh.discardChangesTitle, translations.zh.restrictedRegenerateTitle];
  assert.equal(new Set(zhTitles).size, 4, "four distinct zh titles");
  const zhDescriptions = [translations.zh.archiveManyDescription, translations.zh.archiveOneDescription, translations.zh.discardChangesDescription, translations.zh.restrictedRegenerateDescription];
  assert.equal(new Set(zhDescriptions).size, 4, "four distinct zh descriptions");
  const enTitles = [translations.en.archiveManyTitle, translations.en.archiveOneTitle, translations.en.discardChangesTitle, translations.en.restrictedRegenerateTitle];
  assert.equal(new Set(enTitles).size, 4, "four distinct en titles");
  const actions = [translations.zh.archiveAction, translations.zh.discardChangesAction, translations.zh.restrictedRegenerateAction];
  assert.equal(new Set(actions).size, 3, "confirm buttons never rely on the title alone");
  for (const key of ["archiveManyTitle", "archiveManyDescription", "restrictedRegenerateDescription"]) {
    assert.match(translations.zh[key], /\{count\}/, `zh.${key} interpolates count`);
    assert.match(translations.en[key], /\{count\}/, `en.${key} interpolates count`);
  }
  for (const removed of ["confirmBatchArchive", "discardVersionChanges", "regenerateRestrictedConfirm"]) {
    assert.equal(translations.zh[removed], undefined, `legacy key ${removed} removed (zh)`);
    assert.equal(translations.en[removed], undefined, `legacy key ${removed} removed (en)`);
  }
});

// 51-54. Neighbouring contracts keep their anchors.
test("51-54. anchored overlay, viewer escape, version workflow, and return snapshot anchors intact", async () => {
  const app = await readApp();
  const viewer = await readAssetView();
  const shortcuts = functionSlice(app, "setupKeyboardShortcuts");
  // 2026-08-18: V2-only token consolidation. The V2 design retired the
  // standalone #filterPanel element (its affordance merged into the
  // `.topbar-type-filters` strip in `.topbar-context`). The Escape chain
  // now starts from the image-preview modal and walks through import /
  // group / settings overlays before view-mode / detail-open
  // fall-through. The contract pins the surviving branches.
  const branches = [
    ["!els.imagePreviewModal?.hidden", "imagePreview"],
    ["els.importModal?.classList.contains(\"open\")", "importModal"],
    ["els.groupModal?.classList.contains(\"open\")", "groupModal"],
    ["!els.settingsMenu?.hidden", "settingsMenu"],
  ];
  // Only inspect positions that fall inside the Escape branch (after the
  // first `if (event.key === "Escape")` marker) so we don't compare
  // image-preview positions in the *second* Escape handler (the image
  // zoom branch) against the modal branch above it.
  const escapeBranchStart = shortcuts.indexOf("if (event.key === \"Escape\")");
  assert.ok(escapeBranchStart > -1, "the Escape branch must exist");
  const escapeBranch = shortcuts.slice(escapeBranchStart);
  const positions = branches.map(([needle]) => escapeBranch.indexOf(needle));
  for (let i = 0; i < branches.length; i += 1) {
    assert.ok(positions[i] > -1, `Escape chain branch survives: ${branches[i][1]}`);
  }
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i] > positions[i - 1], `Escape priority order: ${branches[i][1]} after ${branches[i - 1][1]}`);
  }
  const iDetailExit = shortcuts.indexOf('if (state.viewMode === "asset" || state.detailOpen) { event.preventDefault(); void closeDetailSurface(); return; }');
  assert.ok(iDetailExit > -1, "view/detail Escape fallthrough is centralized through the dirty-safe close helper");
  assert.ok(positions[positions.length - 1] < iDetailExit, "modal fallthroughs precede view/detail exit");
  assert.match(shortcuts, /if \(event\.defaultPrevented\) return;/, "modal trap consumption still respected");
  assert.match(app, /select\.addEventListener\("change", \(\) => selectDetailVersion\(select\.value\)\);/, "version picker delegation intact");
  assert.match(app, /selectDetailVersion\(button\.dataset\.versionId\);/, "timeline delegation intact");
  const openView = functionSlice(viewer, "openAssetView");
  assert.match(openView, /state\.libraryReturnSnapshot = \{/, "return snapshot still built on open");
  assert.match(viewer, /function returnToLibrary\(/, "return path intact");
});

// 55. Toast compatibility entry kept — Phase 5C moved the behaviour to the
// dual-lane Toast Manager, so the contract here is delegation, not the old
// single-slot internals (which are now guarded by toast-manager-contract).
test("55. showToast keeps its signature and only delegates to the Toast Manager", async () => {
  const app = await readApp();
  const toast = functionSlice(app, "showToast");
  assert.match(toast, /function showToast\(message, type = "default"\)/, "existing call sites keep the (message, type) signature");
  assert.match(toast, /return toastManager\.show\(message, type\);/, "showToast only delegates to the manager — no duplicated queue logic");
  assert.doesNotMatch(app, /\btoastTimer\b/, "the legacy global single timer is gone");
});

// 56-57. Package manifest and lockfile frozen; no new dependencies.
test("56-57. package manifest and lockfile unchanged", async () => {
  const pkg = await readFile(resolve(root, "package.json"), "utf8");
  const lock = await readFile(resolve(root, "package-lock.json"), "utf8");
  // R1 isolation fix (2026-08-09, approved scope) added qa:web/qa:electron/
  // qa:packaged launcher scripts, so the whole-manifest hash no longer holds;
  // the dependency sections the freeze really guards stay byte-identical.
  const manifest = JSON.parse(pkg);
  assert.equal(sha256(JSON.stringify(manifest.dependencies)), "73c83773a57e21a20917d81b24288bdfddd9bb7ddd644fdaedd6e6cfba13c405", "package.json dependencies frozen");
  assert.equal(sha256(JSON.stringify(manifest.devDependencies)), "11f67ce00f34b4d3dfb9b9ed0dfb428b0368ad5e0a17bd3bafaa40e3c2124fac", "package.json devDependencies frozen");
  assert.equal(sha256(lock), "5f63f56e0757215ab2e5f2773de24afe1e7fa9a5bddc41adde805856f0fe09ec", "package-lock.json frozen");
});

// 58. The stylesheet stays free of !important while hosting the dialog styles.
// 2026-08-18: V2-only token consolidation. The DestructiveButton recipe
// now consumes V2 semantic tokens (`--color-danger`, `--app-card`) instead
// of the Phase 1A short names (`--error`, `--surface-1`).
test("58. dialog styles without !important", async () => {
  const css = await readCss();
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(withoutComments, /!important/, "stylesheet must stay free of !important");
  assert.match(css, /\.confirm-dialog-card \{ width: 400px; \}/, "dialog width suits 960×640");
  assert.match(css, /\.confirm-dialog-copy \{ padding: 20px 20px 16px; overflow-wrap: break-word; \}/, "copy wraps instead of overflowing");
  assert.match(css, /\.btn-danger \{ border: 1px solid var\(--color-danger\); color: var\(--color-danger\); background: var\(--app-card\); \}/,
    "the danger confirm button consumes the approved DestructiveButton recipe");
  assert.doesNotMatch(css, /\.btn-danger-solid\b/, "ConfirmDialog does not carry a third destructive-button recipe");
  assert.match(css, /:where\(\.action-btn\.danger, \.batch-bar-btn\.danger, \.btn-danger\):not\(:disabled\):not\(\[aria-disabled="true"\]\):hover/,
    "danger hover stays inside the precise-pointer media guard");
});

test("context-menu bulk Trash action passes the selected count into its title", async () => {
  const source = await readFile(resolve(root, "app/context-menu-actions.mjs"), "utf8");
  const { default: translations } = await import(pathToFileURL(resolve(root, "app/i18n.mjs")).href);

  assert.match(translations.zh.moveAssetsToTrashTitle, /\{count\}/);
  assert.match(translations.en.moveAssetsToTrashTitle, /\{count\}/);
  assert.match(source, /t\("moveAssetsToTrashTitle", \{ count: ids\.length \}\)/,
    "Trash confirmation reports the real expanded mutation count, including Stack members and unloaded selections");
  assert.doesNotMatch(source, /t\("moveAssetsToTrashTitle"\)/);
  assert.doesNotMatch(source, /t\("archiveAsset"\)/, "archive is no longer exposed from the asset context menu");
});
