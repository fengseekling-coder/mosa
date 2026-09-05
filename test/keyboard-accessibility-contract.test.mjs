import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

// Phase 6B contract matrix. This file intentionally uses only Node's standard
// library and source slices. Runtime focus traces are recorded separately by the
// GUI run; these checks protect the small, approved implementation surface.
const root = resolve(import.meta.dirname, "..");
const read = async (name) => readFile(resolve(root, name), "utf8");
const count = (source, needle) => source.split(needle).length - 1;
const sliceBetween = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
};
const functionSlice = (source, marker, endMarker) => sliceBetween(source, marker, endMarker);

const checks = [
  ["01 no positive literal tabindex", async () => {
    const [html, app] = await Promise.all([read("app/index.html"), read("app/app.mjs")]);
    assert.doesNotMatch(`${html}\n${app}`, /\btabindex\s*=\s*["'][1-9]\d*["']/i);
  }],
  ["02 library and viewer hidden boundaries", async () => {
    const html = await read("app/index.html");
    assert.match(html, /id="libraryView"/);
    assert.match(html, /id="assetView"[^>]*hidden inert aria-hidden="true"/);
  }],
  ["03 one application shortcut router", async () => {
    const app = await read("app/app.mjs");
    assert.match(app, /function setupKeyboardShortcuts\(\)/);
    assert.match(app, /handleLibraryKeyboardNavigation\(event\)/);
    // R1 batch 3: the toast banner moved out of app.js; the slice now ends at
    // the toast manager instance that replaced it.
    const galleryRouter = sliceBetween(app, "function bindKeyboardNav(", "const toastManager = createToastManager");
    assert.doesNotMatch(galleryRouter, /document\.addEventListener\("keydown"/);
  }],
  ["04 confirm blocks background shortcuts", async () => assert.match(await read("app/app.mjs"), /if \(confirmDialogState\.pending\) return;/)],
  ["05 modal Escape trap remains", async () => {
    const app = await read("app/app.mjs");
    assert.match(app, /function trapImportModalFocus\(event\)/);
    assert.match(app, /function trapGroupModalFocus\(event\)/);
    assert.match(app, /if \(event\.key === "Escape"\) \{ event\.preventDefault\(\); closeImportModal\(\); return; \}/);
  }],
  ["06 retired language child overlay stays removed", async () => {
    const app = await read("app/app.mjs");
    assert.doesNotMatch(app, /id: "language", kind: "child", parentId: "settings"/);
    assert.doesNotMatch(app, /#languageMenu|data-language-menu|focusLanguageMenuItem|handleLanguageMenuKeydown/);
  }],
  ["08 viewer Escape returns to library", async () => assert.match(await read("app/app.mjs"), /if \(state\.viewMode === "asset" \|\| state\.detailOpen\) \{ event\.preventDefault\(\); void closeDetailSurface\(\); return; \}/)],
  ["09 form controls guard global shortcuts without assuming an Element target", async () => {
    const app = await read("app/app.mjs");
    assert.match(app, /if \(event\.target\.matches\?\.\("input, textarea, select"\)\)/);
    assert.equal(count(app, "event.target.matches?.("), 3);
    assert.doesNotMatch(app, /event\.target\.matches\(/);
  }],
  ["10 contenteditable guard exists", async () => {
    const app = await read("app/app.mjs");
    assert.match(app, /!event\.target\.closest\?\.\("\[contenteditable\]"\)/);
    assert.match(app, /event\.target\.closest\?\.\("\[role='tab'\]"\)/);
  }],
  ["12 library search is a native focus target", async () => assert.match(await read("app/index.html"), /<input id="searchInput" type="search"/)],
  ["14 settings radiogroups keep one Tab stop", async () => {
    const app = await read("app/app.mjs");
    assert.match(app, /tabindex=\"\$\{selected \? 0 : -1\}\"/);
    assert.match(app, /button:not\(\[disabled\]\):not\(\[tabindex='-1'\]\)/);
  }],
  ["15 language uses the settings radiogroup", async () => {
    const app = await read("app/app.mjs");
    assert.match(app, /data-locale=|"data-locale"/);
    assert.match(app, /t\("interfaceLanguage"\)[\s\S]*?role=\"radiogroup\"/);
  }],
  ["16 radiogroup keeps directional keys", async () => {
    const app = await read("app/app.mjs");
    assert.match(app, /role=\"radio\"/);
    assert.match(app, /event\.key === "ArrowRight"/);
    assert.match(app, /event\.stopPropagation\(\);.*buttons\[next\]\.click\(\)/s);
  }],
  ["17 gallery card has native button entry", async () => assert.match(await read("app/app.mjs"), /<button class="asset-card-select" type="button"/)],
  ["18 Enter on a gallery asset opens the dedicated Viewer", async () => {
    const app = await read("app/app.mjs");
    assert.match(app, /if \(event\.key === "Enter"[\s\S]*?else void openAssetView\(asset\.id, els\.assetGrid\?\.querySelector/);
  }],
  ["19 viewer entry focuses Return", async () => assert.match(await read("app/asset-view.mjs"), /els\.assetViewBack\?\.focus\(\);/)],
  ["20 hidden library is inert in viewer", async () => assert.match(await read("app/asset-view.mjs"), /els\.libraryView\.toggleAttribute\("inert", assetMode\)/)],
  ["21 viewer navigation buttons stay native", async () => {
    const html = await read("app/index.html");
    assert.match(html, /id="assetViewPrev" type="button"/);
    assert.match(html, /id="assetViewNext" type="button"/);
  }],
  ["22 viewer zoom controls are reachable", async () => {
    const html = await read("app/index.html");
    for (const id of ["assetZoomOut", "assetZoomIn", "assetZoomFit"]) assert.match(html, new RegExp(`id="${id}" type="button"`));
  }],
  ["23 inspector V2 section order is fixed", async () => {
    const app = await read("app/app.mjs");
    const markup = app.match(/\$\{detailFileSectionMarkup\(asset\)\}[\s\S]*?\$\{detailMoreSectionMarkup\(asset\)\}/)?.[0] || "";
    assert.deepEqual([...markup.matchAll(/detail(\w+)SectionMarkup/g)].map((match) => match[1]), ["File", "Tags", "Prompt", "Source", "Version", "Group", "More"]);
  }],
  ["24 copy prompt action is native", async () => assert.match(await read("app/app.mjs"), /data-action="copy-prompt"/)],
  ["25 copy source action is native", async () => assert.match(await read("app/app.mjs"), /data-action="copy-source"/)],
  // 2026-09-04: the inspector copy-path button retired (context menu keeps its own entry).
  ["26 inspector copy-path button stays retired", async () => assert.doesNotMatch(await read("app/app.mjs"), /data-action="copy-path"/)],
  // 2026-09-04: the More disclosure retired; the image path renders directly.
  ["29 More disclosure stays retired", async () => assert.doesNotMatch(await read("app/inspector-markup.mjs"), /data-more-actions/)],
  // 2026-09-04: the App/Web original-media split retired from the inspector
  // (context menu keeps Finder and copy-path entries).
  ["30 App/Web original media split stays retired", async () => {
    const app = await read("app/app.mjs");
    const inspector = await read("app/inspector-markup.mjs");
    assert.doesNotMatch(app, /data-action="show-in-finder"/);
    assert.doesNotMatch(inspector, /original-media-link/);
  }],
  ["31 return snapshot shape remains", async () => {
    const app = await read("app/asset-view.mjs");
    assert.match(app, /state\.libraryReturnSnapshot = \{\s+scrollTop:/);
    assert.match(app, /focusedAssetId:/);
    assert.match(app, /requestKey: assetRequestKey\(currentAssetRequest\(\)\)/);
  }],
  ["33 discrete viewer zoom announces percent", async () => assert.match(await read("app/asset-view.mjs"), /function announceAssetViewZoom\(\)[\s\S]*?zoomAnnouncement/s)],
  ["34 unchanged viewer zoom does not announce", async () => assert.match(await read("app/asset-view.mjs"), /Math\.abs\(scale - assetViewTransform\.scale\) <= ASSET_VIEW_SCALE_EPSILON[\s\S]*?return false;/s)],
  ["35 preview stage is a focusable region", async () => {
    const html = await read("app/index.html");
    assert.match(html, /id="imagePreviewStage" role="region"/);
    assert.match(html, /id="imagePreviewStage"[^>]*tabindex="0"/);
  }],
  ["36 preview stage has an accessible name", async () => assert.match(await read("app/index.html"), /id="imagePreviewStage"[^>]*data-i18n-aria-label="imagePreviewStage"[^>]*aria-label=/)],
  ["37 preview plus and minus keys are mapped", async () => {
    const app = await read("app/app.mjs");
    assert.match(app, /if \(event\.key === "\+" \|\| event\.key === "="\) \{ event\.preventDefault\(\); zoomImage/);
    assert.match(app, /if \(event\.key === "-" \|\| event\.key === "_"\) \{ event\.preventDefault\(\); zoomImage/);
  }],
  ["38 preview reset key is mapped", async () => assert.match(await read("app/app.mjs"), /resetImageZoom\(\{ announce: true \}\)/)],
  ["39 preview has four pan directions", async () => {
    const app = await read("app/app.mjs");
    const preview = await read("app/image-preview.mjs");
    for (const direction of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) assert.match(app, new RegExp(`event\\.key === "${direction}"`));
    assert.match(preview, /function panImagePreview\(/);
  }],
  ["40 preview pan clamps per axis", async () => {
    const preview = await read("app/image-preview.mjs");
    assert.match(preview, /function clampImagePreviewPan\(/);
    assert.match(preview, /const limit = \(renderedSize - stageSize\) \/ 2/);
    assert.match(preview, /offsetX: clampImagePreviewPan/);
    assert.match(preview, /offsetY: clampImagePreviewPan/);
  }],
  ["41 preview reset clears pan", async () => assert.match(await read("app/image-preview.mjs"), /state\.imagePanX = 0;\s+state\.imagePanY = 0;/)],
  ["42 preview uses existing status region", async () => {
    const preview = await read("app/image-preview.mjs");
    assert.match(preview, /function announceImagePreviewZoom\(\)[\s\S]*?announceGalleryStatus/s);
    assert.match(preview, /panImagePreview[\s\S]*?announceGalleryStatus/s);
  }],
  ["43 gallery busy has one helper", async () => assert.match(await read("app/api-client.mjs"), /function setGalleryBusy\(busy, requestId = null, request = null\)/)],
  ["44 request start sets busy true", async () => assert.match(await read("app/api-client.mjs"), /const requestId = \+\+assetRequestSequence;[\s\S]*?setGalleryBusy\(true, requestId, request\)/s)],
  ["45 success clears busy after render", async () => {
    const apiClient = await read("app/api-client.mjs");
    const load = sliceBetween(apiClient, "async function loadAssets(", "let libraryRefreshInFlight");
    const success = load.slice(load.indexOf('state.galleryStatus = "ready"'));
    assert.ok(success.indexOf("renderGrid();") < success.indexOf("setGalleryBusy(false, requestId, request)"));
  }],
  ["46 error render clears busy", async () => {
    const app = await read("app/app.mjs");
    const apiClient = await read("app/api-client.mjs");
    assert.match(apiClient, /renderErrorState\(error, requestId, request\)/);
    assert.match(app, /function renderErrorState\(error, requestId = null, request = null\)[\s\S]*?setGalleryBusy\(false, requestId, request\)/s);
  }],
  ["47 stale request cannot clear busy", async () => assert.match(await read("app/api-client.mjs"), /if \(!busy && requestId !== null && !isCurrentAssetRequest\(requestId, request\)\) return false;/)],
  ["48 pagination uses same loader", async () => assert.match(await read("app/app.mjs"), /data-action="load-more".*?loadAssets\(\{ append: true \}\)/s)],
  ["49 empty render remains in gallery lifecycle", async () => {
    const app = await read("app/app.mjs");
    assert.match(app, /if \(!state\.assets\.length\) \{[\s\S]*?galleryEmptyMarkup\(\)/);
    assert.match(app, /setGalleryBusy\(false, requestId, request\)/);
  }],
  ["50 busy is not on body or viewer", async () => {
    const html = await read("app/index.html");
    assert.equal(count(html, "aria-busy"), 1);
    assert.doesNotMatch(html, /<body[^>]*aria-busy/);
    assert.doesNotMatch(html, /id="assetView"[^>]*aria-busy/);
  }],
  ["51 drag overlay has one instance", async () => assert.equal(count(await read("app/index.html"), "id=\"dragOverlay\""), 1)],
  ["52 drag overlay is hidden initially", async () => assert.match(await read("app/index.html"), /id="dragOverlay"[^>]* hidden>/)],
  ["53 drag overlay has an accessible name", async () => assert.match(await read("app/index.html"), /id="dragOverlay" role="region"[^>]*aria-label=/)],
  ["54 first dragenter announces once", async () => {
    const app = await read("app/app.mjs");
    const drag = functionSlice(app, "function setupDragDrop()", "async function toggleFavorite");
    assert.match(drag, /if \(state\.dragCounter === 0\)[\s\S]*?announceGalleryStatus\(t\("dropImportReady"\), \{ persist: true \}\)/s);
  }],
  ["55 nested dragenter only increments counter", async () => {
    const drag = functionSlice(await read("app/app.mjs"), "function setupDragDrop()", "async function toggleFavorite");
    const first = drag.indexOf('announceGalleryStatus(t("dropImportReady"), { persist: true })');
    assert.equal(count(drag.slice(first + 1), 'announceGalleryStatus(t("dropImportReady"), { persist: true })'), 0);
    assert.match(drag, /state\.dragCounter\+\+;/);
  }],
  ["56 dragleave hides at zero and clears status", async () => {
    const drag = functionSlice(await read("app/app.mjs"), "function setupDragDrop()", "async function toggleFavorite");
    assert.match(drag, /state\.dragCounter = Math\.max\(0, state\.dragCounter - 1\)/);
    assert.match(drag, /if \(state\.dragCounter === 0\) hideDragOverlay\(\)/);
    assert.match(drag, /announceGalleryStatus\(t\("dropImportCanceled"\)\)/);
  }],
  ["57 drop hides and announces received", async () => {
    const drag = functionSlice(await read("app/app.mjs"), "function setupDragDrop()", "async function toggleFavorite");
    assert.match(drag, /hideDragOverlay\(\{ announce: false \}\);\s+announceGalleryStatus\(t\("dropImportReceived"\), \{ persist: true \}\)/);
  }],
  ["58 invalid drop keeps error Toast", async () => assert.match(await read("app/app.mjs"), /showToast\(t\("errorPathUnsupported"\), "error"\)/)],
  ["59 unavailable path keeps error Toast", async () => assert.match(await read("app/app.mjs"), /if \(!filePath\) \{[\s\S]*?showToast\(t\("dropPathUnavailable"\), "error"\)/)],
  ["60 dragenter is not an alert", async () => {
    const [html, app] = await Promise.all([read("app/index.html"), read("app/app.mjs")]);
    assert.doesNotMatch(html, /id="dragOverlay"[^>]*role="alert"/);
    assert.doesNotMatch(app, /dragenter[\s\S]*?role="alert"/);
  }],
  ["61 no new live region on preview or overlay", async () => {
    const html = await read("app/index.html");
    assert.doesNotMatch(html, /id="imagePreviewStage"[^>]*aria-live/);
    assert.doesNotMatch(html, /id="dragOverlay"[^>]*aria-live/);
  }],
  ["62 F-08 empty state helper remains", async () => assert.match(await read("app/app.mjs"), /function deriveGalleryEmptyState\(\)/)],
  ["63 retired anchored overlay runtime stays removed", async () => {
    const app = await read("app/app.mjs");
    assert.doesNotMatch(app, /createAnchoredOverlayManager|anchoredOverlayManager/);
  }],
  ["64 confirm dialog remains centralized", async () => assert.match(await read("app/confirm-dialog.mjs"), /function requestConfirmation\(/)],
  ["65 toast manager remains centralized", async () => assert.match(await read("app/toast-manager.mjs"), /function createToastManager\(/)],
  ["66 viewer sequence remains centralized", async () => assert.match(await read("app/asset-view.mjs"), /assetViewSequence\.ids = state\.assets\.map/)],
  ["67 viewer transform state remains single", async () => {
    const app = await read("app/asset-view.mjs");
    assert.match(app, /const assetViewTransform = \{ mode: "fit", scale: 1/);
    assert.match(app, /function applyAssetViewTransform\(\)/);
  }],
  ["69 native minimum window contract remains external", async () => assert.match(await read("test/minimum-window-responsive-contract.test.mjs"), /minWidth|960/)],
  ["70 added i18n keys are symmetric", async () => {
    const i18n = await read("app/i18n.mjs");
    for (const key of ["zoomAnnouncement", "imagePreviewStage", "imagePreviewPanLeft", "imagePreviewPanRight", "imagePreviewPanUp", "imagePreviewPanDown", "dropImportReady", "dropImportReceived", "dropImportCanceled"]) assert.equal(count(i18n, `${key}:`), 2, `${key} should exist once per locale`);
  }],
  ["71 no new dependency is introduced", async () => {
    const [pkg, lock] = await Promise.all([read("package.json"), read("package-lock.json")]);
    assert.doesNotMatch(pkg, /playwright|puppeteer|axe-core/);
    assert.doesNotMatch(lock, /playwright|puppeteer|axe-core/);
  }],
  ["72 implementation has no important override", async () => assert.doesNotMatch(await read("app/app.mjs"), /!important/)],
  ["73 preview zoom step is fixed", async () => assert.match(await read("app/image-preview.mjs"), /const IMAGE_PREVIEW_ZOOM_STEP = 0\.25;/)],
  ["74 preview pan step is fixed", async () => assert.match(await read("app/image-preview.mjs"), /const IMAGE_PREVIEW_PAN_STEP = 48;/)],
  ["75 preview transform preserves mouse input through Pointer Events", async () => {
    const app = await read("app/app.mjs");
    const preview = await read("app/image-preview.mjs");
    assert.match(preview, /stage\.addEventListener\("pointerdown", handleImagePreviewPointerDown\)/);
    assert.match(preview, /stage\.addEventListener\("pointermove", handleImagePreviewPointerMove\)/);
    assert.match(preview, /stage\.addEventListener\("pointerup", handleImagePreviewPointerEnd\)/);
    assert.doesNotMatch(app, /document\.addEventListener\("mousemove"/);
    assert.doesNotMatch(app, /document\.addEventListener\("mouseup"/);
  }],
  ["76 wheel zoom suppresses announcement storm", async () => assert.match(await read("app/image-preview.mjs"), /zoomImage\([^;]*\{ announce: false \}\)/)],
  ["77 viewer visual zoom and announcement share scale", async () => {
    const app = await read("app/asset-view.mjs");
    assert.match(app, /assetZoomValue\) els\.assetZoomValue\.textContent = ready \? `\$\{Math\.round\(assetViewTransform\.scale \* 100\)\}%`/);
    assert.match(app, /Math\.round\(assetViewTransform\.scale \* 100\)/);
  }],
  ["78 asset switch resets transform without old announcement", async () => {
    const app = await read("app/asset-view.mjs");
    const render = functionSlice(app, "function renderAssetView()", "// Library 真实滚动容器");
    assert.match(render, /resetAssetViewTransform\(\)/);
    assert.doesNotMatch(render, /zoomAnnouncement|zoomFitDone|zoomResetDone/);
  }],
  ["79 viewer return has no delayed zoom timer", async () => {
    const app = await read("app/asset-view.mjs");
    const returned = functionSlice(app, "function returnToLibrary()", "// ===== 专用大图舞台交互");
    assert.doesNotMatch(returned, /setTimeout|setInterval/);
  }],
  ["80 drag overlay is viewer guarded", async () => assert.match(await read("app/app.mjs"), /if \(state\.viewMode !== "library"\) return;/)],
  ["81 drag overlay does not intercept pointer", async () => assert.match(await read("app/styles.css"), /\.drag-overlay \{[^}]*pointer-events: none;/)],
  ["82 preview stage uses the existing focus ring", async () => assert.match(await read("app/styles.css"), /\[tabindex\]:focus-visible/)],
  ["83 960x640 viewport remains declared", async () => assert.match(await read("app/index.html"), /name="viewport" content="width=device-width, initial-scale=1\.0"/)],
  ["84 status text remains the single app announcement lane", async () => assert.equal(count(await read("app/index.html"), "id=\"statusText\""), 1)],
  ["85 contract itself uses no network", async () => {
    const source = await read("test/keyboard-accessibility-contract.test.mjs");
    assert.doesNotMatch(source, /fetch\(|https?:\/\//);
    assert.match(source, /from "node:test"/);
  }],
];

for (const [label, check] of checks) test(label, check);

test("Phase 6B contract matrix contains at least 67 checks", () => {
  assert.ok(checks.length >= 67, `expected at least 67 checks, got ${checks.length}`);
});
