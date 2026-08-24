import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

// Phase 4C 守护契约：Cowart 全状态（不可用/单画布/多画布/Busy/Success/Error/目标持久化/
// 竞态 guard）、原图 App/Web 能力适配（desktop-finder / web-open / unavailable）、More 区
// 最终形态（原生 details/summary + 独立 danger 区）与 Phase 1–4B 边界冻结。
// Node 标准库、零网络、源码切片断言；不用整文件 SHA 代替行为契约（package/lockfile 除外）。

const root = resolve(import.meta.dirname, "..");
const readApp = () => readFile(resolve(root, "app/app.mjs"), "utf8");
const readAssetView = () => readFile(resolve(root, "app/asset-view.mjs"), "utf8");
const readInspectorMarkup = () => readFile(resolve(root, "app/inspector-markup.mjs"), "utf8");
const readCss = () => readFile(resolve(root, "app/styles.css"), "utf8");
const readI18n = () => readFile(resolve(root, "app/i18n.mjs"), "utf8");
const readPreload = () => readFile(resolve(root, "desktop/preload.cjs"), "utf8");
const readMain = () => readFile(resolve(root, "desktop/main.mjs"), "utf8");

const count = (source, needle) => source.split(needle).length - 1;
const sha256 = (content) => createHash("sha256").update(content).digest("hex");

/** Slices a function (top-level or 2-space-indented module helper) up to the next function. */
function functionSlice(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function not found: ${name}`);
  const candidates = ["\nfunction ", "\nasync function ", "\n  function ", "\n  async function "]
    .map((marker) => source.indexOf(marker, start + 1))
    .filter((index) => index !== -1);
  const next = candidates.length ? Math.min(...candidates) : -1;
  return source.slice(start, next === -1 ? source.length : next);
}

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `marker not found: ${endMarker}`);
  return source.slice(start, end);
}

// Library v2 keeps favorite in the Overview instead of a detached section.
const SECTION_ORDER = ["file", "tags", "prompt", "source", "version", "group", "cowart", "new-version", "more"];
const COMPOSITION = "${detailFileSectionMarkup(asset)}${detailTagsSectionMarkup(asset)}${detailPromptSectionMarkup(asset)}${detailSourceSectionMarkup(asset)}${detailVersionSectionMarkup(asset, cachedHistory, cachedRecipeHistory)}${detailGroupSectionMarkup(asset)}${detailCowartSectionMarkup()}${detailNewVersionSectionMarkup()}${detailMoreSectionMarkup(asset)}";

// The insert-cowart click handler slice (event binding up to the next binding).
function insertHandlerSlice(app) {
  return sliceBetween(app, 'panel.querySelector(\'[data-action="insert-cowart"]\')', 'panel.querySelector(\'[data-action="copy-prompt"]\')');
}

// 1. Cowart stays the 7th section. 2. Cowart stays the only primary. 53. V2 order.
test("01-02,53. cowart section position, single primary, approved V2 section order", async () => {
  const app = await readApp();
  const inspector = await readInspectorMarkup();

  assert.ok(app.includes(COMPOSITION), "renderDetail composition sequence unchanged");
  const positions = SECTION_ORDER.map((id) => inspector.indexOf(`data-inspector-section="${id}"`));
  assert.ok(positions.every((index) => index > -1), "all V2 section ids still render");
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "section order matches the approved sequence");
  assert.equal(SECTION_ORDER[6], "cowart", "cowart stays the 7th section");
  assert.equal(SECTION_ORDER[8], "more", "more stays the 9th section");

  assert.equal(count(app, "action-btn primary"), 1, "the Cowart insert button is the only solid primary");
  assert.doesNotMatch(app, /recipe-save-btn primary/);
});

// 3-5. Usable-canvas judgement is a single centralized helper that filters untrusted/disabled.
test("03-05. usable canvases come from one centralized helper with trust/enabled guards", async () => {
  const app = await readApp();

  const helper = functionSlice(app, "usableCowartCanvases");
  assert.match(helper, /state\.cowartCanvases\.filter/, "helper reads state.cowartCanvases");
  assert.match(helper, /canvas\.trusted !== false/, "untrusted canvases never become targets");
  assert.match(helper, /canvas\.enabled !== false/, "disabled canvases never become targets");

  const control = functionSlice(app, "createCowartInsertControl");
  const targetFor = functionSlice(app, "cowartInsertTargetIdFor");
  assert.match(control, /usableCowartCanvases\(\)/, "control uses the centralized helper");
  assert.match(targetFor, /usableCowartCanvases\(\)/, "target resolution uses the centralized helper");
  // Discovered-but-untrusted/disabled must not leak into options through any other path.
  assert.doesNotMatch(control, /state\.cowartCanvases\.map/, "options are never built from raw sources");
});

// 6-8. Unavailable state: native disabled, visible explanation, no empty select.
test("06-08. unavailable state disables the button, explains visibly, renders no empty select", async () => {
  const app = await readApp();
  const control = functionSlice(app, "createCowartInsertControl");

  assert.match(control, /\$\{available \? "" : " disabled"\} aria-disabled="\$\{!available\}"/, "disabled and aria-disabled stay in sync");
  assert.match(control, /data-cowart-connect-hint/, "unavailable shows a visible explanation");
  assert.match(control, /\$\{escapeHtml\(t\("cowartConnectHint"\)\)\}/, "the hint is the connect copy, not title-only");
  assert.match(control, /available && usable\.length > 1/, "a select renders only for multiple usable canvases");
  assert.match(control, /state\.cowartInsertAvailable && usable\.length > 0/, "unavailable means no usable canvas or insert unavailable");
});

// 9-10. Single canvas: read-only target readout instead of a pointless one-option select.
test("09-10. single canvas shows a read-only target name, not a one-option select", async () => {
  const app = await readApp();
  const control = functionSlice(app, "createCowartInsertControl");

  assert.match(control, /else if \(available\) \{\n\s+targetMarkup = `<p class="cowart-target-readout" data-cowart-target-readout>/, "single canvas renders a readout");
  assert.match(control, /cowartCanvasLabel\(usable\[0\]\)/, "the readout names the target canvas");
  assert.match(control, /cowartInsertTarget/, "the readout is labelled with the target semantics");
});

// 11-15. Multiple canvases: native select of exactly the usable canvases, current target
// selected, selection persisted, illegal targets fall back to a legal one.
test("11-15. multi-canvas select lists only usable canvases, selects, persists, falls back", async () => {
  const app = await readApp();
  const control = functionSlice(app, "createCowartInsertControl");
  const targetFor = functionSlice(app, "cowartInsertTargetIdFor");

  assert.match(control, /<select id="cowartInsertTarget" class="cowart-target-select" data-cowart-insert-target/, "multi-canvas renders a native select");
  assert.match(control, /usable\.map\(\(canvas\) => `<option value=/, "options come from the usable list only");
  assert.match(control, /canvas\.id === targetId \? " selected" : ""/, "the current target is selected");
  assert.match(app, /safeStorageSet\("mosa\.cowart-insert-target", state\.cowartInsertTargetId\)/, "selection is persisted");
  assert.match(targetFor, /usable\.some\(\(canvas\) => canvas\.id === requestedId\)/, "persisted/source target must still be usable");
  assert.match(targetFor, /usable\.find\(\(canvas\) => canvas\.id === "mosa"\)\?\.id \|\| usable\[0\]\?\.id \|\| ""/, "illegal targets fall back to the MOSA canvas or the first usable canvas");
  assert.match(control, /if \(targetId\) state\.cowartInsertTargetId = targetId;/, "fallback updates state so an illegal id is never sent");
});

// 16-18. Busy: aria-busy on the control, button + select locked, no duplicate POST.
test("16-18. busy locks the control with aria-busy and prevents duplicate POSTs", async () => {
  const app = await readApp();
  const busy = functionSlice(app, "setCowartInsertBusy");
  const handler = insertHandlerSlice(app);

  assert.match(busy, /control\.setAttribute\("aria-busy", "true"\)/, "busy sets aria-busy on the control");
  assert.match(busy, /button\.disabled = busy \|\| !state\.cowartInsertAvailable/, "busy disables the button");
  assert.match(busy, /target\.disabled = busy \|\| !state\.cowartInsertAvailable/, "busy disables the target select");
  assert.match(busy, /busy \? t\("insertingCowart"\) : t\("insertCowart"\)/, "busy swaps the button label");
  assert.match(handler, /setCowartInsertBusy\(control, true\)/, "the handler enters busy before the request");
  assert.match(handler, /const requestId = \+\+cowartInsertRequestSequence/, "request generation guard exists");
  assert.match(handler, /if \(!targetId \|\| !state\.cowartInsertAvailable\) return;/, "no request without a legal target");
  // While busy the button is natively disabled, so a second click cannot dispatch.
  const updater = functionSlice(app, "updateCowartInsertControls");
  assert.match(updater, /aria-busy"\) === "true"\) return;/, "bridge polling never re-enables a busy control");
});

// 19-23. Success/error inline feedback bound to the current asset key; stale responses
// from an older asset never pollute the new one; error stays retryable.
test("19-23. inline feedback is asset-scoped, race-guarded, and retryable", async () => {
  const app = await readApp();
  const handler = insertHandlerSlice(app);

  assert.match(handler, /state\.cowartInsertFeedback = \{ assetKey, type: "success", message \}/, "success stores inline feedback");
  assert.match(handler, /state\.cowartInsertFeedback = \{ assetKey, type: "error", message: error\.message \}/, "error stores inline feedback");
  assert.match(handler, /const assetKey = `\$\{originProjectId\}\\u0000\$\{originAssetId\}`/, "feedback is bound to the asset key");
  assert.match(handler, /requestId === cowartInsertRequestSequence && isCurrentDetailSelection\(originProjectId, originAssetId\)/, "late responses are dropped for other assets");
  assert.match(handler, /finally \{/, "busy always resolves");
  assert.match(handler, /setCowartInsertBusy\(control, false\)/, "controls recover after success or error");
  assert.match(handler, /if \(hadFocus\) button\?\.focus\(\{ preventScroll: true \}\)/, "focus returns to the same button without scrolling");
  assert.match(handler, /if \(!isCurrentResponse\(\)\) return;/, "stale success and stale error both bail out");

  const status = functionSlice(app, "renderCowartInsertStatus");
  assert.match(status, /state\.cowartInsertFeedback\.assetKey === `\$\{state\.project\}\\u0000\$\{state\.selectedId\}`/, "the status row only shows the current asset's feedback");
  assert.match(status, /status\.hidden = !feedback/, "no feedback means a hidden status row");

  const feedbackFor = functionSlice(app, "cowartInsertFeedbackFor");
  assert.match(feedbackFor, /feedback\.assetKey === `\$\{asset\.project_id\}\\u0000\$\{asset\.id\}`/, "redraws restore feedback only for the same asset");

  // Feedback lifecycle: cleared on a new insert, on asset switch, and on close.
  assert.match(handler, /state\.cowartInsertFeedback = null;\n\s+renderCowartInsertStatus\(\);/, "a new insert clears old feedback first");
  assert.match(app, /state\.cowartInsertFeedback\.assetKey !== `\$\{asset\.project_id\}\\u0000\$\{asset\.id\}`\)\) state\.cowartInsertFeedback = null;/, "switching assets clears feedback in renderDetail");
  assert.match(app, /返回 Library \/ 关闭检视器时清理 Cowart 内联反馈/, "closing the inspector clears feedback");
  assert.doesNotMatch(app, /safeStorageSet\([^)]*cowartInsertFeedback|localStorage\.setItem\([^)]*cowartInsertFeedback/, "feedback is never persisted to disk");
});

// 24-28. The insert flow keeps the existing API contract and never touches viewer state.
test("24-28. insert keeps the API contract and leaves viewer/library state untouched", async () => {
  const app = await readApp();
  const handler = insertHandlerSlice(app);

  assert.match(handler, /\/api\/assets\/\$\{encodeURIComponent\(originProjectId\)\}\/\$\{encodeURIComponent\(originAssetId\)\}\/insert-cowart/, "the existing insert-cowart API is used");
  assert.match(handler, /body: \{ placement: "right", targetId \}/, "the request body carries placement and targetId");
  assert.doesNotMatch(handler, /loadAssets\(/, "insert never reloads the asset list");
  assert.doesNotMatch(handler, /assetViewSequence\.|libraryReturnSnapshot =|state\.selectedId =/, "insert never touches the viewer sequence, return snapshot, or selection");
  assert.match(handler, /await refreshBridgeStatus\(\)/, "only the bridge status refreshes after success");
});

// 29-35. Desktop capability: preload exposes only showItemInFolder; main validates sender,
// absolute path, and existence, and uses shell.showItemInFolder — never openExternal.
test("29-35. show-item-in-folder IPC is minimal, validated, and shell-correct", async () => {
  const [preload, main] = await Promise.all([readPreload(), readMain()]);

  assert.match(preload, /showItemInFolder: \(path\) =>\s*\n?\s*ipcRenderer\.invoke\("show-item-in-folder", path\)/, "preload exposes showItemInFolder");
  assert.equal(count(preload, "ipcRenderer.invoke"), 5, "preload still exposes only the five invoke channels (batch 1.2 added stage-dropped-file)");
  assert.doesNotMatch(preload, /shell\s*[:.]/, "the renderer never receives a shell object");

  const handler = sliceBetween(main, 'ipcMain.handle("show-item-in-folder"', "\n}");
  assert.match(main, /import \{[^}]*\bshell\b[^}]*\} from "electron"/, "main imports shell");
  assert.match(handler, /event\.sender !== mainWindow\.webContents/, "the sender must be the current main window");
  assert.match(handler, /typeof path !== "string" \|\| !path\.trim\(\)/, "empty paths are rejected");
  assert.match(handler, /!isAbsolute\(target\)/, "relative paths are rejected");
  assert.match(handler, /\^\[a-z\]\[a-z0-9\+\.\-\]\*:\/i\.test\(target\)/, "URL-like input is rejected");
  assert.match(handler, /!existsSync\(target\)/, "missing files are rejected");
  assert.match(handler, /shell\.showItemInFolder\(target\)/, "the native API is shell.showItemInFolder");
  assert.doesNotMatch(handler, /openExternal/, "local paths never go through shell.openExternal");
  assert.match(handler, /return \{ ok: true \}/, "success returns a structured ok result");
  assert.match(handler, /reason: "missing"/, "missing files return a structured reason");
  assert.match(handler, /reason: "invalid"/, "invalid input returns a structured reason");
  assert.match(handler, /reason: "unavailable"/, "unavailable capability returns a structured reason");
  assert.doesNotMatch(handler, /writeFile|mkdir|rename|unlink|fetch\(/, "the handler never creates, modifies, moves, or downloads files");
});

// 36-43. Original-media capability: App shows Finder copy, Web shows a safe link, both
// image and video get an explicit entry, and unavailable never renders a dead control.
test("36-43. original media capability adapts between App and Web without dead controls", async () => {
  const app = await readApp();
  const inspector = await readInspectorMarkup();
  const capability = functionSlice(inspector, "originalMediaCapability");
  const markup = functionSlice(inspector, "originalMediaActionMarkup");
  const more = functionSlice(inspector, "detailMoreSectionMarkup");

  assert.match(capability, /typeof window\.electronAPI\?\.showItemInFolder === "function" && imagePath/, "desktop-finder requires the injected API and a real path");
  assert.match(capability, /if \(imageUrl\) return "web-open";/, "web-open requires a non-empty image_url");
  assert.match(capability, /return "unavailable";/, "both missing means unavailable");

  assert.match(markup, /data-action="show-in-finder">\$\{t\("showInFinder"\)\}/, "App uses the Finder copy");
  assert.match(markup, /<a class="action-btn secondary original-media-link" href="\$\{escapeHtml\(asset\.image_url\)\}" target="_blank" rel="noopener noreferrer">\$\{t\("openOriginal"\)\}/, "Web uses a safe new-tab link with the open-original copy");
  assert.match(markup, /<p class="empty-copy original-media-unavailable">\$\{t\("originalUnavailable"\)\}<\/p>/, "unavailable renders honest copy, not a dead button");
  assert.doesNotMatch(markup, /disabled/, "unavailable renders no disabled dead control");

  // The entry is unconditional for images and videos alike — no isVideoAsset gate.
  assert.match(more, /<div class="original-media-action">\$\{originalMediaActionMarkup\(asset\)\}<\/div>/, "the entry renders for every asset");
  assert.doesNotMatch(more, /isVideoAsset/, "the entry is no longer video-only");
  assert.doesNotMatch(inspector, /isVideoAsset\(asset\)\s*\?\s*[^\n]*open-original-media/, "the old video-only gate is gone");

  // One capability per asset — never both entries at once.
  assert.match(markup, /if \(capability === "desktop-finder"\) return/, "finder returns early");
  assert.match(markup, /if \(capability === "web-open"\) return/, "web returns early");

  // The Finder handler never leaks the absolute path into a toast.
  const finderHandler = sliceBetween(app, '[data-action="show-in-finder"]', "[data-cowart-insert-target]");
  assert.match(finderHandler, /window\.electronAPI\.showItemInFolder\(asset\.image_path\)/, "the handler invokes the IPC with the asset path");
  assert.match(finderHandler, /showToast\(t\("shownInFinder"\), "success"\)/, "the success toast is a fixed string");
  assert.doesNotMatch(finderHandler, /showToast\([^)]*image_path/, "no absolute path in any toast");
  assert.doesNotMatch(app, /file:\/\//, "no file:// URL is ever produced");
});

// 44-52. More section final form: visible original entry, native details disclosure for
// utility actions, separated danger archive, and no custom popover or ellipsis menu.
test("44-52. more section final form keeps the approved hierarchy", async () => {
  const inspector = await readInspectorMarkup();
  const more = functionSlice(inspector, "detailMoreSectionMarkup");

  assert.ok(COMPOSITION.endsWith("${detailMoreSectionMarkup(asset)}"), "more stays the last section");
  const originalIndex = more.indexOf('original-media-action');
  const detailsIndex = more.indexOf("data-more-actions");
  assert.ok(originalIndex > -1 && originalIndex < detailsIndex, "the original entry is visible by default, before the disclosure");
  assert.match(more, /<details class="detail-disclosure" data-more-actions><summary>\$\{t\("moreActions"\)\}<\/summary>/, "more actions use a native details/summary disclosure");
  assert.match(more, /<div class="detail-utility-actions"><button class="action-btn secondary" type="button" data-action="regenerate">/, "regenerate lives inside the disclosure");
  assert.match(more, /\? `<button class="action-btn secondary" type="button" data-action="copy-path">\$\{t\("copyPath"\)\}<\/button>`\n\s+: "";/, "copy-path renders only when a path exists");
  assert.match(more, /<div class="more-location"><span class="meta-key">\$\{t\("imageLocation"\)\}<\/span>/, "the image location row lives inside the disclosure");
  assert.match(more, /<div class="detail-danger-actions"><button class="action-btn danger" type="button" data-action="archive-asset">/, "archive stays a separated danger action");
  assert.doesNotMatch(more, /role="menu|popover|ellipsis|overflow-menu|⋯|…/, "no custom popover, menu role, or ellipsis trigger");

  // The disclosure is closed by default (no open attribute).
  assert.doesNotMatch(more, /<details class="detail-disclosure" data-more-actions open/, "the disclosure starts closed");
});

// 54-58. Neighbouring contracts keep passing and their app.js anchors are intact.
test("54-58. Phase 1-4B neighbouring contracts and anchors stay intact", async () => {
  const app = await readApp();
  const inspector = await readInspectorMarkup();
  const viewer = await readAssetView();

  // V2 migration: large-view-* tests were removed during V2 cleanup
  await Promise.all([
    access(resolve(root, "test/inspector-information-architecture-contract.test.mjs")),
    access(resolve(root, "test/inspector-version-workflow-contract.test.mjs")),
    access(resolve(root, "test/accessibility-contract.test.mjs")),
  ]);
  assert.match(viewer, /assetViewSequence\.ids = state\.assets\.map\(\(asset\) => asset\.id\);/, "viewer navigation anchor intact");
  assert.match(viewer, /function applyAssetViewTransform\(\)/, "viewer transform anchor intact");
  assert.match(viewer, /state\.libraryReturnSnapshot = \{/, "return snapshot anchor intact");
  assert.match(inspector, /function detailVersionSectionMarkup\(asset, cachedHistory, cachedRecipeHistory\)/, "Phase 4A IA anchors intact");
  assert.match(app, /function selectDetailVersion\(/, "Phase 4B version workflow anchor intact");
});

// 59-60. package.json and the lockfile stay frozen; app.js gains no new imports.
test("59-60. dependency freeze: manifest, lockfile, and app.js imports unchanged", async () => {
  const [app, pkg, lock] = await Promise.all([
    readApp(),
    readFile(resolve(root, "package.json"), "utf8"),
    readFile(resolve(root, "package-lock.json"), "utf8"),
  ]);

  // R1 isolation fix (2026-08-09, approved scope) added qa:web/qa:electron/
  // qa:packaged launcher scripts, so the whole-manifest hash no longer holds;
  // the dependency sections the freeze really guards stay byte-identical.
  const manifest = JSON.parse(pkg);
  assert.equal(sha256(JSON.stringify(manifest.dependencies)), "73c83773a57e21a20917d81b24288bdfddd9bb7ddd644fdaedd6e6cfba13c405", "package.json dependencies must stay untouched");
  assert.equal(sha256(JSON.stringify(manifest.devDependencies)), "11f67ce00f34b4d3dfb9b9ed0dfb428b0368ad5e0a17bd3bafaa40e3c2124fac", "package.json devDependencies must stay untouched");
  assert.equal(sha256(lock), "ecf0fdc199de87ccd30ffe6a7da4624c2f632700cd8348194a30b79dd2e2a69f", "package-lock.json must stay untouched");
  assert.deepEqual([...app.matchAll(/^import .* from "(.*)";$/gm)].map((match) => match[1]).sort(),
    ["./api-client.mjs", "./asset-view.mjs", "./bridge-status-poller.mjs", "./confirm-dialog.mjs", "./context-menu-actions.mjs", "./context-menu-bindings.mjs", "./context-menu.mjs", "./i18n-runtime.mjs", "./image-preview.mjs", "./inspector-markup.mjs", "./overlay-manager.mjs", "./tag-utils.mjs", "./toast-manager.mjs"], "app.js imports only the local tag utility");
});

// i18n: every new key exists in both locales, symmetric, and no duplicate synonyms.
test("i18n. new cowart/original-media keys are symmetric across zh and en", async () => {
  const i18n = await readI18n();

  const NEW_KEYS = ["cowartConnectHint", "showInFinder", "shownInFinder", "showInFinderFailed", "openOriginal", "originalUnavailable", "originalAndMore"];
  for (const key of NEW_KEYS) {
    assert.equal(count(i18n, `${key}:`), 2, `${key} exists exactly once per locale`);
  }
  // Reused keys stay single-sourced — no duplicate synonyms were introduced.
  for (const key of ["insertCowart", "insertingCowart", "insertedCowart", "cowartInsertUnavailable", "cowartInsertTarget", "moreActions", "imageLocation", "regenerate", "copyPath"]) {
    assert.equal(count(i18n, `${key}:`), 2, `${key} stays exactly one entry per locale`);
  }
  // The connect hint copy matches the approved wording.
  assert.match(i18n, /cowartConnectHint: "打开或连接 Cowart 画布后即可插入"/);
  assert.match(i18n, /cowartConnectHint: "Open or connect a Cowart canvas to insert"/);
});

// Styles: the new cowart/original-media styling stays inside the design-token boundary.
test("styles. Phase 4C additions reuse tokens and keep the primary button width stable", async () => {
  const css = await readCss();

  assert.match(css, /\.cowart-insert-control \.action-btn\.primary \{ min-width: (1[6-9]|[2-9]\d)\d+px; \}/, "the primary button min-width covers the longest busy label so idle and busy stay the same width");
  assert.match(css, /\.cowart-target-readout \{[^}]*min-height: 36px;/, "the single-canvas readout matches control height");
  assert.match(css, /\.cowart-insert-status \{[^}]*grid-column: 1 \/ -1;/, "the status row spans the control");
  assert.match(css, /\.cowart-insert-status\[data-type="success"\]::before \{ content: "✓ "; color: var\(--color-accent\); \}/, "success is not color-only");
  assert.match(css, /\.cowart-insert-status\[data-type="error"\] \{ color: var\(--color-danger\); \}/, "error uses the existing danger token");
  assert.match(css, /\.cowart-insert-status\[data-type="error"\]::before \{ content: "⚠ "; \}/, "error is not color-only");
  assert.match(css, /\.original-media-action \{ display: grid; margin-bottom: 10px; \}/, "the original entry keeps the 8px rhythm");
  assert.match(css, /\.more-location \{ display: grid; gap: 6px; margin-top: 8px; \}/, "the location row keeps the 8px rhythm");
  const cssDeclarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(cssDeclarations, /!important/, "no !important in any CSS declaration");
  const phase4cStyles = sliceBetween(css, "/* Phase 4C：Busy", ".action-btn {");
  assert.doesNotMatch(phase4cStyles, /#[0-9a-fA-F]{3,8}\b|backdrop-filter|gradient/, "Phase 4C styles introduce no new colors, glassmorphism, or gradients");
});
