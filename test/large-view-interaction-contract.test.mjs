// Large view interaction contract (Phase 3B / F-03 / F-09): dedicated stage zoom
// model (fit / 100% / pointer-centred zoom / drag panning), single zoom control
// bar, keyboard map, wheel policy, ResizeObserver lifecycle, load/error handling,
// accessibility and i18n symmetry. Static guards only — Node standard library,
// no network access. Locks concrete DOM, selectors, helper formulas and listener
// wiring via text slices (never a whole-file SHA of app/styles/html).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const readCss = () => readFile(resolve(root, "app/styles.css"), "utf8");
const readHtml = () => readFile(resolve(root, "app/index.html"), "utf8");
const readApp = () => readFile(resolve(root, "app/app.mjs"), "utf8");
const readAssetView = () => readFile(resolve(root, "app/asset-view.mjs"), "utf8");
const readI18n = () => readFile(resolve(root, "app/i18n.mjs"), "utf8");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

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

/** The body of a top-level app.js function (declaration through the balanced brace). */
function functionBody(source, name) {
  const body = blockAfter(source, `function ${name}(`);
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf(body, start) + body.length);
}

/** Strips HTML comments so documentation notes never trip negative assertions. */
const stripHtmlComments = (source) => source.replace(/<!--[\s\S]*?-->/g, "");

/**
 * Strips JS line/block comments while skipping string and template literals, so
 * documented intent (e.g. "do not preventDefault here") never trips ordering checks.
 */
function stripJsComments(source) {
  let output = "";
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const char = source[i];
    const pair = source.slice(i, i + 2);
    if (quote) {
      output += char;
      if (char === "\\") {
        output += source[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (char === quote) quote = null;
      i += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      output += char;
      i += 1;
      continue;
    }
    if (pair === "//") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (pair === "/*") {
      const close = source.indexOf("*/", i + 2);
      i = close === -1 ? source.length : close + 2;
      continue;
    }
    output += char;
    i += 1;
  }
  return output;
}

/** The asset-view section of index.html. */
const assetViewSlice = (html) => sliceBetween(html, '<section class="asset-view"', "</main>");
/** The Phase 3B viewer keyboard block inside setupKeyboardShortcuts. */
const viewerKeySlice = (app) => sliceBetween(app, "Phase 3B / 规格 §8：专用大图舞台缩放快捷键", 'if (event.key === "b" && (event.metaKey || event.ctrlKey))');
/** The Phase 3B CSS slice (stage interaction + control bar) up to the detail panel. */
const phase3bCssSlice = (css) => sliceBetween(css, ".asset-view-stage { position: relative;", "/* ===== 详情面板 ===== */");

const PHASE3B_I18N_KEYS = ["zoomControls", "zoomIn", "zoomOut", "zoomFit", "zoomLevel", "zoomFitDone", "zoomResetDone"];

// 1. Exactly one zoom control bar lives in the asset view.
test("1. single zoom control bar in the asset view", async () => {
  const html = await readHtml();
  const slice = assetViewSlice(html);
  assert.equal(slice.match(/class="asset-view-controls"/g).length, 1, "exactly one .asset-view-controls bar");
  assert.equal(html.match(/id="assetViewControls"/g).length, 1, "exactly one #assetViewControls in the document");
  assert.equal(html.match(/id="assetZoomIn"/g).length, 1, "no duplicate zoom-in control");
  assert.equal(html.match(/id="assetZoomOut"/g).length, 1, "no duplicate zoom-out control");
  assert.equal(html.match(/id="assetZoomFit"/g).length, 1, "no duplicate fit control");
});

// 2. Zoom-out exists as a native labelled button.
test("2. zoom-out button exists", async () => {
  const html = await readHtml();
  assert.match(assetViewSlice(html), /<button class="asset-view-control" id="assetZoomOut" type="button" data-i18n-aria-label="zoomOut" aria-label="[^"]+"/,
    "zoom-out must be a native type=button with an i18n-driven accessible name");
});

// 3. Zoom-in exists as a native labelled button.
test("3. zoom-in button exists", async () => {
  const html = await readHtml();
  assert.match(assetViewSlice(html), /<button class="asset-view-control" id="assetZoomIn" type="button" data-i18n-aria-label="zoomIn" aria-label="[^"]+"/,
    "zoom-in must be a native type=button with an i18n-driven accessible name");
});

// 4. Fit exists as a button with visible text (not an icon-only mystery button).
test("4. fit button exists with visible text", async () => {
  const html = await readHtml();
  const slice = assetViewSlice(html);
  assert.match(slice, /<button class="asset-view-fit" id="assetZoomFit" type="button"/, "fit must be a native type=button");
  assert.match(slice, /<span data-i18n="zoomFit">适合窗口<\/span>/, "fit button carries visible text");
});

// 5. The percentage readout is an <output> element (not a disguised button).
test("5. percentage output exists", async () => {
  const html = await readHtml();
  assert.match(assetViewSlice(html), /<output class="asset-view-zoom-value" id="assetZoomValue"/, "percentage readout must use <output>");
  assert.doesNotMatch(assetViewSlice(html), /<button[^>]*asset-view-zoom-value/, "percentage must not be a button");
});

// 6. The zoom control bar holds no previous/next asset controls. Phase 3C delivers
//    prev/next in the header navigation group (locked by the navigation contract);
//    this assertion migrates minimally to keep guarding the control bar itself.
test("6. no previous/next controls in the zoom control bar", async () => {
  const html = await readHtml();
  const controls = stripHtmlComments(sliceBetween(assetViewSlice(html), 'class="asset-view-controls"', "</div>"));
  assert.doesNotMatch(controls, /上一张|下一张|prev-asset|next-asset|asset-prev|asset-next|assetViewPrev|assetViewNext/i, "no prev/next markup inside the zoom control bar");
  const viewer = await readAssetView();
  assert.doesNotMatch(stripJsComments(functionBody(viewer, "renderAssetView")), /navigateAssetView|prevAsset|nextAsset|previousAsset/i, "renderAssetView implements no prev/next navigation itself");
});

// 7. No thumbnail strip in the asset view or its control bar.
test("7. no thumbnail strip", async () => {
  const html = await readHtml();
  assert.doesNotMatch(assetViewSlice(html), /thumb|filmstrip|strip/i, "no thumbnail-strip markup in the asset view");
});

// 8. No related-assets region in the dedicated view.
test("8. no related-assets region", async () => {
  const html = await readHtml();
  assert.doesNotMatch(assetViewSlice(html), /related|recommend|similar/i, "no related-assets markup in the asset view");
});

// 9. scale = 1 means exactly 100% of the natural size.
test("9. scale 1 renders as 100 percent", async () => {
  const viewer = await readAssetView();
  assert.match(functionBody(viewer, "updateAssetViewControls"), /Math\.round\(assetViewTransform\.scale \* 100\)/,
    "percentage derives from scale against the natural size");
  assert.match(functionBody(viewer, "resetAssetViewToHundred"), /assetViewTransform\.scale = 1/, "100% view sets scale = 1");
});

// 10. A centralised fit-scale helper exists.
test("10. centralised fitScale helper", async () => {
  const viewer = await readAssetView();
  assert.match(functionBody(viewer, "computeAssetFitScale"), /Math\.min\(stageWidth \/ naturalWidth, stageHeight \/ naturalHeight, 1\)/,
    "fitScale = min(stageW/naturalW, stageH/naturalH, 1)");
});

// 11. Fit never upscales small images beyond 100% by default.
test("11. fit does not upscale small images", async () => {
  const viewer = await readAssetView();
  const body = functionBody(viewer, "computeAssetFitScale");
  assert.match(body, /, 1\)/, "fitScale is capped at 1 (no upscaling of small images)");
  assert.match(body, /if \(!\(stageWidth > 0\)/, "degenerate inputs fall back safely");
});

// 12. A centralised pointer-centred zoom helper exists.
test("12. centralised zoomAtPoint helper", async () => {
  const viewer = await readAssetView();
  const body = functionBody(viewer, "zoomAssetViewAtPoint");
  assert.match(body, /anchorX = \(pointerX - currentOffsetX\) \/ scale/, "image-space anchor derives from pointer and current offset");
  assert.match(body, /offsetX: pointerX - anchorX \* targetScale/, "offset keeps the anchored image point under the pointer");
});

// 13. The pointer-centred formula is not scattered across handlers.
test("13. pointer-centred formula not duplicated", async () => {
  const viewer = await readAssetView();
  assert.equal(viewer.match(/pointerX - currentOffsetX/g).length, 1, "anchor formula appears exactly once");
  const wheel = functionBody(viewer, "handleAssetViewWheel");
  assert.doesNotMatch(wheel, /anchorX|currentOffsetX/, "wheel handler reuses the helper instead of copying the formula");
  assert.match(wheel, /zoomAssetViewBy\(factor, pointer\.x, pointer\.y\)/, "wheel zoom routes through the shared zoom path");
});

// 14. A centralised clampOffsets helper exists.
test("14. centralised clampOffsets helper", async () => {
  const viewer = await readAssetView();
  assert.match(functionBody(viewer, "clampAssetViewAxisOffset"), /\(renderedSize - stageSize\) \/ 2/, "pan limit = (rendered - stage) / 2");
  assert.match(functionBody(viewer, "clampAssetViewOffsets"), /clampAssetViewAxisOffset\(/, "clampOffsets composes the axis helper");
});

// 15. X and Y axes clamp independently.
test("15. per-axis clamping", async () => {
  const viewer = await readAssetView();
  const body = functionBody(viewer, "clampAssetViewOffsets");
  assert.match(body, /offsetX: clampAssetViewAxisOffset\(offsetX, natural\.width \* scale, stage\.width\)/, "X clamps against rendered width");
  assert.match(body, /offsetY: clampAssetViewAxisOffset\(offsetY, natural\.height \* scale, stage\.height\)/, "Y clamps against rendered height");
  assert.match(functionBody(viewer, "clampAssetViewAxisOffset"), /if \(!\(renderedSize > stageSize\)\) return 0;/, "axis collapses to 0 when the image fits");
});

// 16. Maximum zoom is 800%.
test("16. max zoom is 800 percent", async () => {
  const viewer = await readAssetView();
  assert.match(viewer, /const ASSET_VIEW_MAX_SCALE = 8;/, "max scale constant = 8 (800%)");
  assert.match(functionBody(viewer, "clampAssetViewScale"), /Math\.min\(ASSET_VIEW_MAX_SCALE, /, "scale clamped to the max");
});

// 17. Minimum zoom still fits images whose fitScale is below 10%.
test("17. min zoom honours tiny fitScale", async () => {
  const viewer = await readAssetView();
  assert.match(viewer, /const ASSET_VIEW_MIN_SCALE_FLOOR = 0\.1;/, "min-scale floor = 10%");
  assert.match(functionBody(viewer, "assetViewMinScale"), /Math\.min\(currentAssetFitScale\(\), ASSET_VIEW_MIN_SCALE_FLOOR\)/,
    "min scale = min(fitScale, 0.1) so huge images can always fit");
});

// 18. Button/keyboard zoom uses a stable multiplicative step.
test("18. stable multiplicative step", async () => {
  const app = await readApp();
  const viewer = await readAssetView();
  assert.match(viewer, /const ASSET_VIEW_ZOOM_STEP = 1\.2;/, "zoom step = 1.2");
  assert.match(app, /els\.assetZoomIn\?\.addEventListener\("click", \(\) => zoomAssetViewBy\(ASSET_VIEW_ZOOM_STEP, 0, 0, \{ announce: true \}\)\)/, "zoom-in multiplies by the step and announces");
  assert.match(app, /els\.assetZoomOut\?\.addEventListener\("click", \(\) => zoomAssetViewBy\(1 \/ ASSET_VIEW_ZOOM_STEP, 0, 0, \{ announce: true \}\)\)/, "zoom-out divides by the step and announces");
});

// 19. Wheel is bound to the asset stage only (not document/window).
test("19. wheel bound to asset stage only", async () => {
  const viewer = await readAssetView();
  assert.equal(viewer.match(/addEventListener\("wheel", handleAssetViewWheel/g).length, 1, "single asset-view wheel binding");
  const setup = functionBody(viewer, "setupAssetViewInteraction");
  assert.match(setup, /stage\.addEventListener\("wheel", handleAssetViewWheel/, "wheel binds to the stage element");
  assert.doesNotMatch(setup, /document\.addEventListener\("wheel"|window\.addEventListener\("wheel"/, "no global wheel interception");
});

// 20. The wheel listener is registered with passive:false so it can preventDefault.
test("20. wheel uses passive false", async () => {
  const viewer = await readAssetView();
  assert.match(functionBody(viewer, "setupAssetViewInteraction"), /stage\.addEventListener\("wheel", handleAssetViewWheel, \{ passive: false \}\)/,
    "wheel listener must be non-passive");
});

// 21. Library mode never intercepts wheel events.
test("21. library mode does not intercept wheel", async () => {
  const viewer = await readAssetView();
  const wheel = stripJsComments(functionBody(viewer, "handleAssetViewWheel"));
  assert.ok(wheel.indexOf('state.viewMode !== "asset"') > -1, "library mode bails out");
  assert.ok(wheel.indexOf('state.viewMode !== "asset"') < wheel.indexOf("preventDefault"), "bail happens before preventDefault");
  assert.match(functionBody(viewer, "teardownAssetViewInteraction"), /stage\.removeEventListener\("wheel", handleAssetViewWheel\)/,
    "returning to the library removes the wheel listener");
});

// 22. Pointer capture drives the drag session.
test("22. pointer capture exists", async () => {
  const viewer = await readAssetView();
  assert.match(functionBody(viewer, "handleAssetViewPointerDown"), /els\.assetViewStage\.setPointerCapture\(event\.pointerId\)/, "drag captures the pointer");
});

// 23. pointercancel is handled and releases capture.
test("23. pointercancel handled", async () => {
  const viewer = await readAssetView();
  assert.match(functionBody(viewer, "setupAssetViewInteraction"), /stage\.addEventListener\("pointercancel", handleAssetViewPointerEnd\)/, "pointercancel is wired");
  assert.match(functionBody(viewer, "handleAssetViewPointerEnd"), /releasePointerCapture\(event\.pointerId\)/, "capture is released on end/cancel");
  assert.match(functionBody(viewer, "handleAssetViewPointerEnd"), /cancelAssetViewPan\(\)/, "pan session is cleaned up");
});

// 24. Fit clears both offsets and returns to fit mode.
test("24. fit clears offsets", async () => {
  const viewer = await readAssetView();
  const body = functionBody(viewer, "fitAssetView");
  assert.match(body, /assetViewTransform\.mode = "fit";/, "fit restores fit mode");
  assert.match(body, /const scale = currentAssetFitScale\(\);/, "fit recomputes fitScale");
  assert.match(body, /assetViewTransform\.offsetX = 0;/, "fit clears offsetX");
  assert.match(body, /assetViewTransform\.offsetY = 0;/, "fit clears offsetY");
});

// 25. The 100% view pins scale to exactly 1 (custom mode, centre-anchored).
test("25. hundred-percent view uses scale 1", async () => {
  const viewer = await readAssetView();
  const body = functionBody(viewer, "resetAssetViewToHundred");
  assert.match(body, /zoomAssetViewAtPoint\(1, 0, 0, /, "100% anchors at the stage centre");
  assert.match(body, /assetViewTransform\.mode = "custom";/, "100% is a custom mode");
  assert.match(body, /assetViewTransform\.scale = 1;/, "100% sets scale = 1");
  assert.match(body, /clampAssetViewOffsets\(1, /, "100% re-clamps offsets");
});

// 26. The + / = shortcut zooms in.
test("26. plus/equals shortcut", async () => {
  const app = await readApp();
  assert.match(viewerKeySlice(app), /event\.key === "\+" \|\| event\.key === "="/, "+ and = both zoom in");
});

// 27. The - / _ shortcut zooms out.
test("27. minus/underscore shortcut", async () => {
  const app = await readApp();
  assert.match(viewerKeySlice(app), /event\.key === "-" \|\| event\.key === "_"/, "- and _ both zoom out");
});

// 28. The 0 shortcut restores 100%.
test("28. zero shortcut restores 100 percent", async () => {
  const app = await readApp();
  assert.match(viewerKeySlice(app), /event\.key === "0"\) \{ event\.preventDefault\(\); resetAssetViewToHundred\(\);/, "0 restores 100%");
});

// 29. The F shortcut fits to the window.
test("29. F shortcut fits to window", async () => {
  const app = await readApp();
  assert.match(viewerKeySlice(app), /event\.key === "f" \|\| event\.key === "F"/, "F/f fits to the window");
});

// 30. Shortcuts never fire while typing in inputs or editable content.
test("30. inputs are not intercepted", async () => {
  const app = await readApp();
  const chain = functionBody(app, "setupKeyboardShortcuts");
  assert.match(chain, /if \(event\.target\.matches\?\.\("input, textarea, select"\)\)/, "native inputs bail at the chain head without assuming an Element target");
  assert.doesNotMatch(chain, /event\.target\.matches\(/, "Document and other non-Element event targets stay safe");
  assert.match(viewerKeySlice(app), /!event\.target\.closest\?\.\("\[contenteditable\]"\)/, "contenteditable is excluded too");
});

// 31. Browser zoom (Ctrl/Meta +/-) is never overridden.
test("31. ctrl/meta browser zoom preserved", async () => {
  const app = await readApp();
  assert.match(viewerKeySlice(app), /!event\.ctrlKey && !event\.metaKey && !event\.altKey/, "modified keys bail before any viewer shortcut");
});

// 32. Arrow keys are claimed exclusively by Phase 3C navigation: the viewer shortcut
//     block routes ArrowLeft/ArrowRight only through the centralised navigateAssetView
//     helper and never touches ArrowUp/ArrowDown.
test("32. arrow keys route only through navigateAssetView", async () => {
  const app = await readApp();
  const slice = stripJsComments(viewerKeySlice(app));
  assert.match(slice, /event\.key === "ArrowLeft" \|\| event\.key === "ArrowRight"/, "viewer shortcuts claim ArrowLeft/ArrowRight for navigation");
  assert.match(slice, /navigateAssetView\(direction\)/, "arrow navigation goes through the centralised helper");
  assert.doesNotMatch(slice, /ArrowUp|ArrowDown/, "viewer shortcuts never touch ArrowUp/ArrowDown");
});

// 33. ResizeObserver watches the stage only.
test("33. ResizeObserver observes stage only", async () => {
  const viewer = await readAssetView();
  const setup = functionBody(viewer, "setupAssetViewInteraction");
  assert.match(setup, /assetViewStageObserver = new ResizeObserver\(handleAssetViewStageResize\)/, "observer drives the stage resize handler");
  assert.match(setup, /assetViewStageObserver\.observe\(stage\)/, "only the stage is observed");
  assert.doesNotMatch(setup, /observe\(document/, "the document is never observed");
});

// 34. The observer is disconnected on teardown (no leaks, no duplicates).
test("34. observer cleaned up", async () => {
  const viewer = await readAssetView();
  const teardown = functionBody(viewer, "teardownAssetViewInteraction");
  assert.match(teardown, /assetViewStageObserver\?\.disconnect\(\)/, "observer disconnects");
  assert.match(teardown, /assetViewStageObserver = null;/, "observer reference is dropped");
  assert.match(functionBody(viewer, "setupAssetViewInteraction"), /if \(assetViewInteractionActive \|\| !stage\) return;/, "setup is idempotent");
});

// 35. Switching assets resets to fit; re-rendering the same asset keeps the transform.
test("35. asset switch resets to fit", async () => {
  const viewer = await readAssetView();
  const body = functionBody(viewer, "renderAssetView");
  assert.match(body, /if \(asset\.id !== assetViewStageAssetId\) \{/, "reset only happens on a real asset switch");
  assert.match(body, /resetAssetViewTransform\(\)/, "switch resets the transform");
  assert.match(functionBody(viewer, "resetAssetViewTransform"), /assetViewTransform\.mode = "fit";/, "reset restores fit semantics");
});

// 36. Image errors disable the controls without NaN or console noise. Phase 3C moved
//     the handler to the race-guarded named handleAssetViewImageError; assertions follow.
test("36. image error disables controls", async () => {
  const app = await readApp();
  const viewer = await readAssetView();
  assert.match(app, /els\.assetViewImage\?\.addEventListener\("error", handleAssetViewImageError\)/, "error listener routes to the guarded named handler");
  const errorBody = functionBody(viewer, "handleAssetViewImageError");
  assert.match(errorBody, /cancelAssetViewPan\(\)/, "error aborts any pan session");
  assert.match(errorBody, /updateAssetViewControls\(\)/, "error refreshes the controls");
  const controls = functionBody(viewer, "updateAssetViewControls");
  assert.match(controls, /ready \? `\$\{Math\.round\(assetViewTransform\.scale \* 100\)\}%` : "—"/, "not-ready state never shows NaN");
  assert.match(controls, /setAssetViewControlDisabled\(els\.assetZoomIn, !ready/, "controls disable when not ready");
});

// 37. prefers-reduced-motion coverage exists for the new controls.
test("37. reduced-motion contract", async () => {
  const css = await readCss();
  const block = sliceBetween(css, "@media (prefers-reduced-motion: reduce)", "\n}");
  assert.match(block, /\.asset-view-control, \.asset-view-fit, \.asset-view-nav-btn \{ transition: none; \}/, "control and navigation-button transitions removed under reduced motion");
});

// 38. The control bar has a group accessible name.
test("38. control bar accessible name", async () => {
  const html = await readHtml();
  assert.match(assetViewSlice(html), /<div class="asset-view-controls" id="assetViewControls" role="group" data-i18n-aria-label="zoomControls" aria-label="[^"]+"/,
    "control bar is a labelled group");
});

// 39. The percentage output has an accessible label and muted live region.
test("39. output accessible name", async () => {
  const html = await readHtml();
  assert.match(assetViewSlice(html), /<output class="asset-view-zoom-value" id="assetZoomValue" data-i18n-aria-label="zoomLevel" aria-label="[^"]+"/,
    "output has a translatable accessible name");
  assert.match(assetViewSlice(html), /<output[^>]*aria-live="off"/, "wheel storms must not spam the live region");
});

// 40. New i18n keys exist in both zh and en.
test("40. i18n key symmetry", async () => {
  const i18n = await readI18n();
  const zh = sliceBetween(i18n, "zh: {", "en: {");
  const en = i18n.slice(i18n.indexOf("en: {"));
  for (const key of PHASE3B_I18N_KEYS) {
    assert.match(zh, new RegExp(`${key}: "`), `zh missing ${key}`);
    assert.match(en, new RegExp(`${key}: "`), `en missing ${key}`);
  }
});

// 41. The Phase 3A return-snapshot contract keeps its exact four fields.
test("41. phase 3A return snapshot intact", async () => {
  const viewer = await readAssetView();
  const body = functionBody(viewer, "openAssetView");
  assert.match(body, /scrollTop: getLibraryScrollContainer\(\)\.scrollTop/, "scrollTop snapshot kept");
  assert.match(body, /focusedAssetId:/, "focusedAssetId kept");
  assert.match(body, /selectedAssetId:/, "selectedAssetId kept");
  assert.match(body, /requestKey: assetRequestKey\(currentAssetRequest\(\)\)/, "requestKey kept");
  assert.doesNotMatch(body, /assets:/, "snapshot still avoids copying the assets array");
});

// 42. The Phase 3A Escape priority chain is unchanged.
test("42. phase 3A escape priority intact", async () => {
  const app = await readApp();
  const viewer = await readAssetView();
  const chain = functionBody(app, "setupKeyboardShortcuts");
  assert.match(chain, /if \(event\.defaultPrevented\) return;/, "defaultPrevented guard kept");
  const filterIdx = chain.indexOf("closePanel(els.filterPanel, els.filterToggle)");
  const assetIdx = chain.indexOf('if (state.viewMode === "asset") { returnToLibrary();');
  const detailIdx = chain.indexOf('if (state.detailOpen) { setDetailOpen(false);');
  assert.ok(filterIdx > -1 && assetIdx > filterIdx && detailIdx > assetIdx, "overlay -> asset view -> detail ordering preserved");
  assert.match(functionBody(viewer, "returnToLibrary"), /getLibraryScrollContainer\(\)\.scrollTop = snapshot\.scrollTop/, "scroll restoration still uses the shared helper");
});

// 43. Phase 1/2 and Phase 3A contract suites remain in place and runnable.
test("43. phase 1/2/3A contract files present", async () => {
  for (const file of [
    "large-view-mode-contract.test.mjs",
    "shell-layout-contract.test.mjs",
    "topbar-hierarchy-contract.test.mjs",
    "accessibility-contract.test.mjs",
    "ui-component-contract.test.mjs",
    "card-action-contract.test.mjs",
  ]) {
    await access(resolve(root, "test", file));
  }
});

// 44. The new viewer CSS uses no !important.
test("44. no !important in viewer css", async () => {
  const css = await readCss();
  assert.doesNotMatch(phase3bCssSlice(css), /!important/, "Phase 3B styles must not use !important");
});

// 45. Every design token referenced by the viewer CSS is defined.
test("45. no undefined tokens", async () => {
  const css = await readCss();
  const refs = new Set([...phase3bCssSlice(css).matchAll(/var\((--[a-z0-9-]+)\)/gi)].map((match) => match[1]));
  assert.ok(refs.size > 0, "viewer css should consume tokens");
  for (const token of refs) {
    assert.match(css, new RegExp(`${token}:`), `token ${token} is referenced but never defined`);
  }
});

// 46. package.json and the lockfile are untouched by Phase 3B (no new dependencies).
test("46. package manifest and lockfile unchanged", async () => {
  const pkg = await readFile(resolve(root, "package.json"), "utf8");
  const lock = await readFile(resolve(root, "package-lock.json"), "utf8");
  // R1 isolation fix (2026-08-09, approved scope) added qa:web/qa:electron/
  // qa:packaged launcher scripts, so the whole-manifest hash no longer holds;
  // the dependency sections the freeze really guards stay byte-identical.
  const manifest = JSON.parse(pkg);
  assert.equal(sha256(JSON.stringify(manifest.dependencies)), "73c83773a57e21a20917d81b24288bdfddd9bb7ddd644fdaedd6e6cfba13c405", "package.json dependencies must not change in Phase 3B");
  assert.equal(sha256(JSON.stringify(manifest.devDependencies)), "24a0c3b9b5c327ef720981045751d87687b51bd41e0e104ed7e0d3127879387b", "package.json devDependencies must not change in Phase 3B");
  assert.equal(sha256(lock), "50a7d029b6aed62fd921ca013f00dba1b01d2ce96009792fb69c63207a04c8dd", "package-lock.json must not change in Phase 3B");
  const app = await readApp();
  assert.deepEqual([...app.matchAll(/^import .* from "(.*)";$/gm)].map((match) => match[1]).sort(),
    ["./api-client.mjs", "./asset-view.mjs", "./bridge-status-poller.mjs", "./confirm-dialog.mjs", "./i18n-runtime.mjs", "./image-preview.mjs", "./inspector-markup.mjs", "./overlay-manager.mjs", "./toast-manager.mjs"], "app.js gains no new imports");
});
