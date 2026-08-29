// Inspector version-workflow contract (Phase 4B): the native version picker
// (five-state model), the centralized selectDetailVersion switch helper, the
// split recipe-save vs save-as-version paths, and the five Phase 4A correction
// gates — all locked as static source contracts. Node standard library only,
// no network access, and never a whole-file SHA of app.js / styles.css as a
// substitute for behaviour contracts (package manifest pins excepted).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const readApp = () => readFile(resolve(root, "app/app.mjs"), "utf8");
const readAssetView = () => readFile(resolve(root, "app/asset-view.mjs"), "utf8");
const readInspectorMarkup = () => readFile(resolve(root, "app/inspector-markup.mjs"), "utf8");
const readCss = () => readFile(resolve(root, "app/styles.css"), "utf8");
const readI18n = () => readFile(resolve(root, "app/i18n.mjs"), "utf8");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const count = (source, needle) => source.split(needle).length - 1;

/** Slices a top-level app.js function (declaration up to the next top-level function). */
function functionSlice(source, name) {
  // 优先匹配 async 声明，避免命中注释中的同名文本；终止边界同时识别 async。
  let start = source.indexOf(`async function ${name}(`);
  if (start === -1) start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function not found: ${name}`);
  const candidates = [source.indexOf("\nfunction ", start + 1), source.indexOf("\nasync function ", start + 1), source.indexOf("\n  function ", start + 1), source.indexOf("\n  async function ", start + 1)]
    .filter((index) => index !== -1);
  const next = candidates.length ? Math.min(...candidates) : -1;
  return source.slice(start, next === -1 ? source.length : next);
}

/** Slices source between two markers (start inclusive, end exclusive). */
function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `marker not found: ${endMarker}`);
  return source.slice(start, end);
}

// Library v2 keeps favorite inside the file overview, leaving seven semantic sections.
const SECTION_ORDER = ["file", "tags", "prompt", "source", "version", "group", "more"];
// Exact helper-call sequence inside the renderDetail single-column composition.
const COMPOSITION = "${detailFileSectionMarkup(asset)}${detailTagsSectionMarkup(asset)}${detailPromptSectionMarkup(asset)}${detailSourceSectionMarkup(asset)}${detailVersionSectionMarkup(asset, cachedHistory, cachedRecipeHistory, cachedGenerationHistory)}${detailGroupSectionMarkup(asset)}${detailMoreSectionMarkup(asset)}";

// 1. Native select exists. 2-3. No hand-rolled listbox / version popover.
// 4. Picker lives inside the version section. 5. Current version is selected.
test("1-5. native version picker inside the version section", async () => {
  const app = await readApp();
  const inspector = await readInspectorMarkup();

  // 1. A single native <select data-version-select> renders the picker.
  const picker = functionSlice(inspector, "versionPickerMarkup");
  assert.match(picker, /<select id="versionSelect" data-version-select/, "native select carries data-version-select");
  assert.match(picker, /<label class="visually-hidden" for="versionSelect">/, "select has an accessible (visually-hidden) label");
  assert.match(picker, /<option value="\$\{escapeHtml\(version\.id\)\}"/, "option value is the asset id");

  // 2-3. No hand-rolled listbox/popover/menu anywhere; no third-party Select import.
  assert.doesNotMatch(app, /role="listbox"/, "no custom listbox");
  assert.doesNotMatch(app, /role="option"/, "no custom option roles");
  assert.doesNotMatch(picker, /popover|dropdown|listbox|role="menu"/i, "no custom version popover");

  // 4. The picker region sits inside the version inspector section, before the disclosures.
  const versionSection = functionSlice(inspector, "detailVersionSectionMarkup");
  assert.ok(versionSection.includes('data-inspector-section="version"'), "section id stays version");
  assert.ok(versionSection.includes('class="version-picker" data-version-picker'), "picker region rendered inside the version section");
  assert.ok(versionSection.indexOf("data-version-picker") < versionSection.indexOf("data-version-history"), "picker precedes the history disclosure");

  // 5. The option matching the current asset id is marked selected.
  assert.match(picker, /version\.id === asset\.id \? " selected" : ""/, "current version option is selected");
});

// 6. Loading: disabled + aria-busy + current Vn. 7. Single version: quiet summary.
// 8. Multiple versions: enabled, API order. 9. Archived versions carry a text
// marker. 10. Missing version_index never renders VNaN/V0/undefined.
test("6-10. picker five-state model", async () => {
  const inspector = await readInspectorMarkup();
  const picker = functionSlice(inspector, "versionPickerMarkup");
  const optionLabel = functionSlice(inspector, "versionOptionLabel");

  // 6. Loading (no history yet): falls back to the current asset as the single
  // option (its Vn label when version_index exists), disabled, aria-busy.
  assert.match(picker, /const options = versions\.length \? versions : \[asset\];/, "loading/error fall back to the current-asset option");
  assert.match(picker, /const busy = !error && !history;/, "busy only while loading");
  assert.match(picker, /\$\{busy \? ' aria-busy="true"' : ""\}/, "loading select exposes aria-busy");

  // 7. Once history resolves to exactly one version, avoid a disabled picker
  // plus duplicated summary; render a compact textual status instead.
  assert.match(picker, /versions\.length === 1/, "single-version history has a dedicated quiet state");
  assert.match(picker, /class="version-single" role="status"/, "single version renders a compact status row");

  // 8. Multiple versions remain a native enabled select; loading/error retain
  // the disabled current-asset fallback. API order is never re-sorted.
  assert.match(picker, /const multiple = versions\.length > 1;/, "enabled state derives from the version count");
  assert.match(picker, /\$\{multiple \? "" : " disabled"\}/, "loading/error fallback disabled, multiple enabled");
  assert.doesNotMatch(picker, /\.sort\(/, "option order follows the API response, never re-sorted");

  // 9. Archived versions append the localized archivedVersion text marker.
  assert.match(optionLabel, /version\?\.archived \? `\$\{label\} · \$\{t\("archivedVersion"\)\}` : label/, "archived marker is textual, not colour-only");

  // 10. version_index is validated before use; missing/invalid values fall back
  // to currentVersion (selected) or the asset title — never VNaN/V0/undefined.
  assert.match(optionLabel, /Number\.isFinite\(index\) && index > 0/, "version_index is validated before rendering");
  assert.match(optionLabel, /selected \? t\("currentVersion"\) : String\(version\?\.theme \|\| version\?\.asset \|\| version\?\.id \|\| ""\)/, "fallback label for missing version_index");
  assert.doesNotMatch(optionLabel + picker, /NaN/, "no NaN can leak into option labels");
});

// 11. Load errors keep the picker (disabled, current version). 12. One request
// per load. 13. Generation + selection guards stay. 14. Picker and history
// regions update in the same response.
test("11-14. async region updates stay guarded and paired", async () => {
  const app = await readApp();
  const loader = functionSlice(app, "loadVersionHistory");
  const pickerRegion = functionSlice(app, "renderVersionPickerRegion");

  // 11. The error path re-renders the picker with (null, id, error) — the picker
  // markup still renders the current-asset option disabled instead of clearing.
  assert.match(loader, /renderVersionPickerRegion\(null, asset\.id, error\);/, "picker is re-rendered (not removed) on error");
  assert.match(pickerRegion, /region\.innerHTML = versionPickerMarkup\(asset, history, error\);/, "picker always re-renders from markup");
  assert.doesNotMatch(pickerRegion, /innerHTML = ""|remove\(\)/, "picker region is never cleared or detached");

  // 12. Exactly one API request per loadVersionHistory call.
  assert.equal(count(loader, "await apiFetch("), 1, "loadVersionHistory issues a single request");

  // 13. Both stale-response guards remain on success and error paths.
  assert.equal(count(loader, "requestId !== versionHistoryRequestSequence"), 2, "request generation guard on both paths");
  assert.equal(count(loader, "`${state.project}\\u0000${state.selectedId}` !== selectedKey"), 2, "selection guard on both paths");

  // 14. Success and error responses update picker and history regions together.
  assert.match(loader, /renderVersionPickerRegion\(result\.history, asset\.id\);\s*\n\s*renderVersionHistoryRegion\(result\.history, asset\.id\);/, "picker and history update in the same success response");
  assert.match(loader, /renderVersionPickerRegion\(null, asset\.id, error\);\s*\n\s*renderVersionHistoryRegion\(null, asset\.id, error\);/, "picker and history update in the same error response");

  // Region re-renders stay local — they never rebuild the whole detail panel.
  assert.doesNotMatch(pickerRegion, /renderDetail\(/, "picker region update never rebuilds the detail panel");
  const historyRegion = functionSlice(app, "renderVersionHistoryRegion");
  assert.doesNotMatch(historyRegion, /renderDetail\(/, "history region update never rebuilds the detail panel");
});

// 15. select change routes through the centralized helper. 16. Timeline clicks
// route through the same helper. 17. Same-version selection is a no-op.
// 18. The dirty guard is reused. 19. Cancelling restores the select value.
test("15-19. one centralized version-switch helper with dirty guard", async () => {
  const app = await readApp();
  const pickerEvents = functionSlice(app, "bindVersionPickerEvents");
  const historyEvents = functionSlice(app, "bindVersionHistoryEvents");
  const helper = functionSlice(app, "selectDetailVersion");

  // 15-16. Both entry points delegate to selectDetailVersion; neither carries
  // its own switch logic any more.
  assert.match(pickerEvents, /select\.addEventListener\("change", \(\) => selectDetailVersion\(select\.value\)\);/, "select change routes to the helper");
  assert.match(historyEvents, /selectDetailVersion\(button\.dataset\.versionId\);/, "timeline click routes to the same helper");
  assert.doesNotMatch(historyEvents, /renderDetail\(|state\.selectedId =/, "timeline binding keeps no inline switch logic");
  assert.doesNotMatch(pickerEvents, /renderDetail\(|state\.selectedId =/, "picker binding keeps no inline switch logic");

  // 17. Selecting the already-current version is a no-op (select display value
  // restored, no navigation).
  assert.match(helper, /target\.id === state\.selectedId\) \{ restoreVersionPickerValue\(\); return true; \}/, "same-version selection is a no-op");

  // 18. The existing confirmDetailNavigation guard is reused — no second dirty
  // state, no new confirm copy. Auto-save: the guard flushes the pending debounced
  // draft before switching; a failed flush returns false and blocks the switch
  // (the draft stays dirty for a retry instead of being discarded).
  assert.match(helper, /if \(!await confirmDetailNavigation\(target\.id\)\) \{ restoreVersionPickerValue\(\); return false; \}/, "a failed flush blocks the switch");
  assert.doesNotMatch(helper, /detailDirty\s*=|window\.confirm\(/, "helper neither owns dirty state nor introduces a new confirm");
  assert.match(app, /async function confirmDetailNavigation\(\) \{[\s\S]*?return flushInspectorSave\(\);\s*\n\}/,
    "shared guard flushes the pending auto-save; it never discards or commits before the caller succeeds");
  assert.doesNotMatch(functionSlice(app, "confirmDetailNavigation"), /state\.detailDirty\s*=\s*false/,
    "a failed flush must leave the draft dirty for a retry");
  assert.match(helper, /isCurrentDetailSelection\(originProjectId, originAssetId\)[\s\S]*?discardDetailDraft\(\);[\s\S]*?state\.selectedId = target\.id;/,
    "version switching commits discard only after confirmation and stale-context validation");

  // 19. Cancel (or an unknown target) restores the select's displayed value.
  assert.match(helper, /if \(!target\) \{ restoreVersionPickerValue\(\); return false; \}/, "unknown target restores the select value");
  const restore = functionSlice(app, "restoreVersionPickerValue");
  assert.match(restore, /select\.value = state\.selectedId;/, "restore resets the select to the current version");
});

// 20-21. The switch never touches assetViewSequence / libraryReturnSnapshot.
// 22. Scroll position survives the switch (clamped). 23. Focus lands on the
// new select without scrolling.
test("20-23. switch preserves viewer state, scroll, and lands focus", async () => {
  const app = await readApp();
  const helper = functionSlice(app, "selectDetailVersion");

  // 20-21. Viewer navigation order and the library return snapshot are untouched.
  assert.doesNotMatch(helper, /assetViewSequence/, "version switch never touches assetViewSequence");
  assert.doesNotMatch(helper, /libraryReturnSnapshot/, "version switch never rebuilds the return snapshot");

  // The state update order is locked: selection/asset, history retention,
  // recipe-history reset, gallery highlight, re-render.
  assert.match(helper, /state\.selectedId = target\.id;\s*\n\s*state\.detailAsset = target;\s*\n\s*state\.recipeHistory = null;\s*\n\s*state\.generationHistory = null;\s*\n\s*updateSelectedCard\(\);\s*\n\s*renderDetail\(\);/, "state update sequence keeps versionHistory and clears asset-specific histories");
  assert.doesNotMatch(helper, /state\.versionHistory = null/, "version history survives the switch");

  // 22. The previous scrollTop is captured before renderDetail and restored
  // afterwards, clamped into the new content's scrollable range.
  assert.match(helper, /const previousScrollTop = els\.detailPanel\?\.querySelector\("\.detail-inspector-scroll"\)\?\.scrollTop \?\? null;/, "scrollTop captured before re-render");
  assert.match(helper, /scroller\.scrollTop = Math\.min\(previousScrollTop, Math\.max\(0, scroller\.scrollHeight - scroller\.clientHeight\)\);/, "scrollTop restored with clamping");

  // 23. Focus moves to the new select in the next frame with preventScroll so
  // the restored scroll position is not overridden.
  assert.match(helper, /requestAnimationFrame\(\(\) => els\.detailPanel\?\.querySelector\("\[data-version-select\]"\)\?\.focus\(\{ preventScroll: true \}\)\);/, "focus lands on the new select without scrolling");
  assert.match(helper, /const focusSelect = options\.focusSelect !== false;/, "focus move stays opt-out via options");

  // 23b. The async picker re-render can land AFTER the rAF focus (same response
  // cycle); it must preserve focus instead of dropping it back to body.
  const pickerRegion = functionSlice(app, "renderVersionPickerRegion");
  assert.match(pickerRegion, /const hadFocus = region\.contains\(document\.activeElement\);/, "picker re-render captures focus before rebuild");
  assert.match(pickerRegion, /if \(hadFocus\) region\.querySelector\("\[data-version-select\]"\)\?\.focus\(\{ preventScroll: true \}\);/, "picker re-render restores focus to the new select");
});

// 24. data-recipe-change lives inside the recipe disclosure. 25-30. The removed
// save-as-version composer stays absent from the inspector and its event path.
// Recipe auto-save remains the only inspector save flow.
test("24-30. recipe save remains and save-as-version UI stays removed", async () => {
  const [app, inspector, i18n] = await Promise.all([readApp(), readInspectorMarkup(), readI18n()]);
  const promptSection = functionSlice(inspector, "detailPromptSectionMarkup");

  // 24. The recipe-change textarea sits inside the recipe disclosure, between
  // the recipe fields and the save-recipe button.
  assert.ok(promptSection.indexOf('t("recipeAndEditing")') > -1, "recipe disclosure heading intact");
  assert.ok(promptSection.indexOf("data-recipe-change") > promptSection.indexOf("${editRecipeFieldsMarkup(asset)}"), "recipe-change follows the recipe fields");
  assert.ok(promptSection.indexOf("data-recipe-change") < promptSection.indexOf('data-action="save-recipe"'), "recipe-change precedes the save button");
  assert.match(promptSection, /<label class="field recipe-change-field"><span>\$\{t\("recipeChangeSummary"\)\}<\/span>/, "recipe-change field label");
  assert.match(promptSection, /<textarea data-recipe-change rows="2" placeholder="\$\{escapeHtml\(t\("recipeChangePlaceholder"\)\)\}"><\/textarea>/, "recipe-change textarea");

  // 25-27. The bottom save-as-version composer and its client event path stay
  // removed. Version history remains read-only in this inspector.
  assert.doesNotMatch(inspector, /data-inspector-section="new-version"/);
  assert.doesNotMatch(inspector, /data-version-change|detail-regenerate-composer|detail-save-version/);
  assert.doesNotMatch(app, /data-action="save-version"|savingVersion|version_change: versionChange/);

  // 28-30. Recipe auto-save remains isolated from the versions API. save-recipe
  // is a manual flush trigger; the actual PATCH lives in persistInspectorDraft.
  const persist = sliceBetween(app, "async function persistInspectorDraft(panel, asset, renderId)", "async function flushInspectorSave()");
  assert.doesNotMatch(persist, /data-version-change/, "recipe auto-save never reads data-version-change");
  assert.match(persist, /panel\.querySelector\("\[data-recipe-change\]"\)\?\.value\.trim\(\) \|\| ""/, "recipe auto-save reads its own summary field");
  assert.doesNotMatch(app, /Recipe updated in MOSA/, "no hardcoded English recipe summary");
  assert.match(persist, /changeSummary \? \{ recipe_change_summary: changeSummary \} : \{\}/, "empty summary omits recipe_change_summary (server default applies)");
  assert.doesNotMatch(persist, /\/versions/, "recipe auto-save never calls the versions API");
  assert.match(persist, /method: "PATCH"/, "recipe auto-save keeps the PATCH path");

  // Recipe-change labels remain localized in both locales.
  assert.match(i18n, /recipeChangeSummary: "配方变更说明"/);
  assert.match(i18n, /recipeChangeSummary: "Recipe change summary"/);
  assert.match(i18n, /recipeChangePlaceholder: "简要说明本次 Prompt、参数或元数据修改"/);
  assert.match(i18n, /recipeChangePlaceholder: "Briefly describe the prompt, parameter, or metadata changes"/);
  assert.match(i18n, /versionPickerLabel: "选择版本"/);
  assert.match(i18n, /versionPickerLabel: "Select version"/);
  assert.match(promptSection, /class="recipe-save-btn secondary" type="button" data-action="save-recipe"/, "save-recipe stays secondary");
  assert.equal(count(app, "recipe-save-btn primary") + count(inspector, "recipe-save-btn primary"), 0, "no primary recipe save button");
});

// 34. state.detailTab is gone entirely. 35. notGrouped is "Ungrouped" in
// English. 36. web-chatgpt resolves through the single source-label map.
// 37. Grok media paths are copyable. 38. No copy affordance for empty sources.
test("34-38. Phase 4A correction gates hold", async () => {
  const [app, inspector, i18n, config] = await Promise.all([readApp(), readInspectorMarkup(), readI18n(), readFile(resolve(root, "app/config.mjs"), "utf8")]);

  // 34. The dead detailTab state (field, initial value, resets, comments) is
  // fully removed from the application code.
  assert.doesNotMatch(app, /detailTab/, "state.detailTab leaves zero residue in app code");

  // 35. English empty-group copy is "Ungrouped"; Chinese stays 未分组.
  assert.match(i18n, /notGrouped: "Ungrouped"/);
  assert.match(i18n, /notGrouped: "未分组"/);
  assert.doesNotMatch(i18n, /notGrouped: "No collection"/);

  // 36. Source naming resolves through the single SOURCE_LABEL_KEYS map —
  // web-chatgpt is explicitly identified as the web source, never as a manual import.
  const sourceNameFn = functionSlice(inspector, "sourceName");
  assert.match(sourceNameFn, /SOURCE_LABEL_KEYS\[type\] \? t\(SOURCE_LABEL_KEYS\[type\]\) : \(type \|\| t\("sourceUnknown"\)\)/, "sourceName reuses the single label map");
  assert.doesNotMatch(sourceNameFn, /sourceManual/, "sourceName never falls back to manual import");
  // SOURCE_LABEL_KEYS moved to app/config.mjs (R1 batch 2).
  assert.match(config, /"web-chatgpt": "sourceWebChatgpt"/, "web-chatgpt mapped to its own label key");
  assert.equal(count(i18n, 'sourceWebChatgpt: "ChatGPT 网页版"'), 1, "Chinese names the ChatGPT web source explicitly");
  assert.equal(count(i18n, 'sourceWebChatgpt: "ChatGPT Web"'), 1, "English names the ChatGPT web source explicitly");

  // 37. Copying a source uses sourceCopyValue (path → grok_media_path → ""),
  // the same precedence as the displayed originalPath row.
  const copyValue = functionSlice(inspector, "sourceCopyValue");
  assert.match(copyValue, /return String\(source\.path \|\| source\.grok_media_path \|\| ""\);/, "copy value mirrors the originalPath precedence");
  assert.match(app, /copy-source.*clipboard\.writeText\(sourceCopyValue\(asset\.source\)\)/s, "copy click uses sourceCopyValue");

  // 38. The copy button renders only when a copyable value exists.
  const sourceSection = functionSlice(inspector, "detailSourceSectionMarkup");
  assert.match(sourceSection, /const copyButton = sourceCopyValue\(source\)\n\s+\? `<button class="section-head-copy" type="button" data-action="copy-source"/, "empty sources get no copy button");
});

// 39-42. The seven V2 inspector sections keep their approved order.
// 43-46. The neighbouring contract suites keep their anchors in app.js.
// 47. package.json and the lockfile are untouched. 48. No new dependency.
test("39-48. layout order, neighbouring contracts, and dependency freeze", async () => {
  const app = await readApp();
  const inspector = await readInspectorMarkup();
  const viewer = await readAssetView();

  // 39-42. The composition sequence and section ids stay in the approved
  // order; version sits after source, more still closes the column.
  assert.ok(app.includes(COMPOSITION), "renderDetail composition sequence unchanged");
  const positions = SECTION_ORDER.map((id) => inspector.indexOf(`data-inspector-section="${id}"`));
  assert.ok(positions.every((index) => index > -1), "all V2 section ids still render");
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "section order matches the approved sequence");
  assert.equal(SECTION_ORDER[4], "version", "version stays the 5th section");
  assert.equal(SECTION_ORDER[6], "more", "more stays the 7th section");

  // 43-46. V2 migration: large-view-* tests were removed during V2 cleanup.
  // App.js anchors for viewer and inspector remain intact.
  assert.match(viewer, /assetViewSequence\.ids = state\.assets\.map\(\(asset\) => asset\.id\);/, "43. viewer navigation anchor intact");
  assert.match(viewer, /function applyAssetViewTransform\(\)/, "44. viewer transform anchor intact");
  assert.match(viewer, /state\.libraryReturnSnapshot = \{/, "45. library return snapshot anchor intact");
  assert.match(inspector, /function detailVersionSectionMarkup\(asset, cachedHistory, cachedRecipeHistory, cachedGenerationHistory\)/, "46. version section accepts generation history alongside legacy histories");

  // 47. Manifest and lockfile SHAs stay at their frozen values.
  const pkg = await readFile(resolve(root, "package.json"), "utf8");
  const lock = await readFile(resolve(root, "package-lock.json"), "utf8");
  // R1 isolation fix (2026-08-09, approved scope) added qa:web/qa:electron/
  // qa:packaged launcher scripts, so the whole-manifest hash no longer holds;
  // the dependency sections the freeze really guards stay byte-identical.
  const manifest = JSON.parse(pkg);
  assert.equal(sha256(JSON.stringify(manifest.dependencies)), "73c83773a57e21a20917d81b24288bdfddd9bb7ddd644fdaedd6e6cfba13c405", "package.json dependencies must stay untouched");
  assert.equal(sha256(JSON.stringify(manifest.devDependencies)), "11f67ce00f34b4d3dfb9b9ed0dfb428b0368ad5e0a17bd3bafaa40e3c2124fac", "package.json devDependencies must stay untouched");
  assert.equal(sha256(lock), "ecf0fdc199de87ccd30ffe6a7da4624c2f632700cd8348194a30b79dd2e2a69f", "package-lock.json must stay untouched");

  // 48. app.js gains no new imports (no new runtime dependencies, no
  // third-party Select component).
  assert.deepEqual([...app.matchAll(/^import .* from "(.*)";$/gm)].map((match) => match[1]).sort(),
    ["./api-client.mjs", "./asset-view.mjs", "./bridge-status-poller.mjs", "./confirm-dialog.mjs", "./context-menu-actions.mjs", "./context-menu-bindings.mjs", "./context-menu.mjs", "./i18n-runtime.mjs", "./image-preview.mjs", "./inspector-markup.mjs", "./tag-utils.mjs", "./toast-manager.mjs"], "app.js imports only approved local helpers");
});

// Picker/recipe styles stay inside the approved boundary: native select reuses
// the global form base (no custom select layer), the version area drops 9px
// type, and the recipe-change field matches the version-change rhythm.
test("styles. picker and recipe-change styling stay within the Phase 4B boundary", async () => {
  const css = await readCss();

  assert.match(css, /\.version-picker \{ display: grid; gap: 8px; margin-bottom: 10px; \}/, "picker layout uses the 8px grid");
  assert.match(css, /\.recipe-change-field \{ margin-top: 8px; \}/, "recipe-change field matches version-change spacing");
  assert.match(css, /\.version-current, \.version-archived \{[^}]*font-size: 10px;/, "version badges no longer use 9px type");
  assert.match(css, /\.version-content time \{ color: var\(--color-text-tertiary\); font-size: 10px; \}/, "version timestamps no longer use 9px type");
  const versionArea = sliceBetween(css, "/* 版本历史 */", "/* 配方快照 */");
  assert.doesNotMatch(versionArea, /font-size: 9px/, "no 9px type remains in the version area");
  assert.doesNotMatch(css, /\.version-picker[^{]*\{[^}]*appearance: none/, "native select keeps the platform affordance");
  const cssDeclarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(cssDeclarations, /!important/, "no !important in any CSS declaration");
});
