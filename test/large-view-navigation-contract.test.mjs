// Large view navigation contract (Phase 3C / F-04): single prev/next navigation set
// bound to the session-stable ID sequence captured from the exact ordered result set
// renderGrid consumes, boundary disabled states, position output, centralised
// navigateAssetView helper, transform reset on switch, async load/error race guards,
// Arrow-key policy, accessibility and i18n symmetry. Static guards only — Node
// standard library, no network access. Locks concrete DOM, selectors and function
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
const readApiClient = () => readFile(resolve(root, "app/api-client.mjs"), "utf8");
const readI18n = () => readFile(resolve(root, "app/i18n.mjs"), "utf8");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Extracts a source slice between two markers. */
function sliceBetween(source, openMarker, closeMarker) {
  const start = source.indexOf(openMarker);
  assert.notEqual(start, -1, `marker not found: ${openMarker}`);
  const end = source.indexOf(closeMarker, start);
  assert.notEqual(end, -1, `marker not found: ${closeMarker}`);
  return source.slice(start, end);
}

/**
 * The body of a top-level app.js function (declaration through the balanced
 * brace). The parameter list is skipped first — default values may themselves
 * contain braces (e.g. `loadAssets(options = {})`), so the first `{` after the
 * name is not necessarily the function body.
 */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `marker not found: function ${name}(`);
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

/** Strips HTML comments so documentation notes never trip negative assertions. */
const stripHtmlComments = (source) => source.replace(/<!--[\s\S]*?-->/g, "");

/**
 * Strips JS line/block comments while skipping string and template literals, so
 * documented intent never trips negative assertions.
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
/** The viewer keyboard block (Phase 3B zoom map + Phase 3C arrows) inside setupKeyboardShortcuts. */
const viewerKeySlice = (app) => sliceBetween(app, "Phase 3B / 规格 §8：专用大图舞台缩放快捷键", 'if (event.key === "b" && (event.metaKey || event.ctrlKey))');
/** The Phase 3C navigation CSS slice (nav group + buttons) up to the stage rule. */
const navCssSlice = (css) => sliceBetween(css, ".asset-view-nav { display: flex", ".asset-view-stage { position: relative;");

const PHASE3C_I18N_KEYS = ["assetNavControls", "assetNavPrev", "assetNavNext", "assetPosition"];

// 1. Exactly one Previous button exists.
test("1. single previous button", async () => {
  const html = await readHtml();
  assert.equal(html.match(/id="assetViewPrev"/g)?.length, 1, "exactly one #assetViewPrev");
});

// 2. Exactly one Next button exists.
test("2. single next button", async () => {
  const html = await readHtml();
  assert.equal(html.match(/id="assetViewNext"/g)?.length, 1, "exactly one #assetViewNext");
});

// 3. Exactly one position output exists.
test("3. single position output", async () => {
  const html = await readHtml();
  assert.equal(html.match(/id="assetViewPosition"/g)?.length, 1, "exactly one #assetViewPosition");
  assert.match(html, /<output class="asset-view-position" id="assetViewPosition"/, "position uses <output> semantics");
});

// 4. No second navigation set anywhere in the document.
test("4. no duplicate navigation set", async () => {
  const html = stripHtmlComments(await readHtml());
  assert.equal(html.match(/asset-view-nav-btn/g)?.length, 2, "exactly two nav buttons total");
  assert.equal(html.match(/id="assetViewNav"/g)?.length, 1, "exactly one nav group");
  assert.doesNotMatch(html, /prev-asset|next-asset|asset-prev|asset-next|gallery-prev|gallery-next/i, "no parallel prev/next controls");
});

// 5. No thumbnail strip in the asset view.
test("5. no thumbnail strip", async () => {
  const html = stripHtmlComments(assetViewSlice(await readHtml()));
  assert.doesNotMatch(html, /thumb|filmstrip|strip/i, "no thumbnail-strip markup in the asset view");
});

// 6. No related-assets or bottom asset list region in the asset view.
test("6. no related assets region", async () => {
  const html = stripHtmlComments(assetViewSlice(await readHtml()));
  assert.doesNotMatch(html, /related|recommend|carousel|slide|similar|asset-list/i, "no related-assets/carousel markup in the asset view");
});

// 7. The session sequence stores IDs only.
test("7. sequence stores ids only", async () => {
  const app = await readAssetView();
  const open = functionBody(app, "openAssetView");
  assert.match(open, /assetViewSequence\.ids = state\.assets\.map\(\(asset\) => asset\.id\);/, "capture keeps only asset ids");
  const declaration = sliceBetween(app, "const assetViewSequence = {", "};");
  assert.match(declaration, /ids: \[\], index: -1, requestKey: ""/, "sequence is ids + index + requestKey only");
});

// 8. The sequence never copies asset objects, arrays or deep-clones state.
test("8. sequence copies no asset objects", async () => {
  const app = await readAssetView();
  const slice = sliceBetween(app, "const assetViewSequence = {", "function assetViewSequenceHasAsset(");
  const code = stripJsComments(slice);
  assert.doesNotMatch(code, /structuredClone|JSON\.parse\(JSON\.stringify|\.slice\(\)|\[\.\.\.state\.assets\]/, "no array/object copying into the sequence");
  assert.doesNotMatch(code, /assetViewSequence\.assets|assetViewSequence\.items|assetViewSequence\.results/, "sequence has no asset-array side channel");
});

// 9. The sequence source is the exact final ordered array renderGrid consumes.
test("9. sequence source matches renderGrid result", async () => {
  const app = await readApp();
  const viewer = await readAssetView();
  assert.match(functionBody(app, "renderGrid"), /state\.assets\.map\(\(asset\) =>/, "renderGrid renders state.assets in order");
  assert.match(functionBody(viewer, "openAssetView"), /assetViewSequence\.ids = state\.assets\.map\(\(asset\) => asset\.id\);/, "sequence captures the same state.assets order");
});

// 10. The captured order carries the active search semantics.
// BUG-10（Batch 2A）：请求构造收敛到 buildAssetPageParams，loadAssets 与 Viewer 边界
// 加载共用同一分页语义；断言跟随共享 helper，不再锚定 loadAssets 内部局部变量。
test("10. search order captured", async () => {
  const apiClient = await readApiClient();
  assert.match(functionBody(apiClient, "buildAssetPageParams"), /project: request\.project, q: request\.query/, "request carries the search query");
  assert.match(functionBody(apiClient, "loadAssets"), /requestAssetPage\(request/, "loadAssets delegates to the shared page request");
  assert.match(functionBody(apiClient, "loadAssets"), /state\.assets = nextAssets;/, "state.assets holds the searched order");
});

// 11. The captured order carries the active facet filters.
test("11. filter order captured", async () => {
  const apiClient = await readApiClient();
  assert.match(functionBody(apiClient, "currentAssetRequest"), /facets: \{ \.\.\.state\.facets \}/, "request carries facets");
  assert.match(functionBody(apiClient, "buildAssetPageParams"), /for \(const key of FACET_KEYS\)/, "facets are sent to the store");
});

// 12. The captured order carries the active sort.
test("12. sort order captured", async () => {
  const apiClient = await readApiClient();
  assert.match(functionBody(apiClient, "currentAssetRequest"), /sort: state\.sort/, "request carries the sort");
  assert.match(functionBody(apiClient, "buildAssetPageParams"), /params\.set\("sort", request\.sort\)/, "sort is resolved by the store");
});

// 13. The captured order carries scope (all/favorites/recent) and group facets.
test("13. scope/group order captured", async () => {
  const apiClient = await readApiClient();
  const params = functionBody(apiClient, "buildAssetPageParams");
  assert.match(params, /request\.scope === "favorite"\) params\.set\("favorite", "1"/, "favorites scope sent");
  assert.match(params, /request\.scope === "recent"\) params\.set\("recent", "1"/, "recent scope sent");
  assert.match(params, /if \(request\.facets\[key\]\) params\.set\(key, request\.facets\[key\]\)/, "group/category/style facets sent");
});

// 14. Navigation never bypasses the session sequence with a fresh full-library fetch.
test("14. no full-library bypass", async () => {
  const app = await readAssetView();
  const navigate = stripJsComments(functionBody(app, "navigateAssetView"));
  assert.doesNotMatch(navigate, /api\(|fetch\(|loadAssets|state\.assets =/, "navigation never refetches or reorders the library");
  assert.match(navigate, /assetViewSequence\.ids\[nextIndex\]/, "navigation reads the session sequence");
});

// 15. No wrap-around at either end.
test("15. no wrap-around", async () => {
  const app = await readAssetView();
  const scan = stripJsComments(functionBody(app, "nextValidAssetViewIndex"));
  assert.match(scan, /i >= 0 && i < ids\.length/, "scan stays inside the sequence bounds");
  assert.doesNotMatch(scan, /%/, "no modulo wrap-around");
  assert.match(scan, /return -1;/, "exhausted direction reports -1");
});

// 16. First item disables Previous.
test("16. first item previous disabled", async () => {
  const app = await readAssetView();
  assert.match(functionBody(app, "updateAssetViewNav"), /setAssetViewControlDisabled\(els\.assetViewPrev, !canNavigateAssetView\(-1\)\)/, "previous mirrors canNavigate(-1)");
  const scan = stripJsComments(functionBody(app, "nextValidAssetViewIndex"));
  assert.match(scan, /for \(let i = fromIndex \+ direction;/, "from index 0 the -1 scan starts out of bounds and yields -1");
});

// 17. Last item disables Next.
test("17. last item next disabled", async () => {
  const app = await readAssetView();
  assert.match(functionBody(app, "updateAssetViewNav"), /setAssetViewControlDisabled\(els\.assetViewNext, !canNavigateAssetView\(1\)\)/, "next mirrors canNavigate(+1)");
  assert.match(functionBody(app, "canNavigateAssetView"), /nextValidAssetViewIndex\(assetViewSequence\.index, direction\) !== -1/, "enabled only when a valid item exists in that direction");
});

// 18. A single-item sequence disables both ends.
test("18. single item disables both ends", async () => {
  const app = await readAssetView();
  const scan = stripJsComments(functionBody(app, "nextValidAssetViewIndex"));
  assert.match(scan, /i >= 0 && i < ids\.length/, "a one-item sequence bounds out both directions");
  assert.match(functionBody(app, "canNavigateAssetView"), /assetViewSequence\.index >= 0/, "no navigation without a session index");
});

// 19. The position output updates on open and on every navigation; the total is the
// stable Viewer session total (BUG-10), not the count of currently loaded ids.
test("19. position updates", async () => {
  const app = await readAssetView();
  const nav = functionBody(app, "updateAssetViewNav");
  assert.match(nav, /els\.assetViewPosition\.textContent = position > 0 \? `\$\{position\} \/ \$\{total\}` : "—"/, "position renders current / session total");
  assert.match(nav, /Math\.max\(assetViewSequence\.total, validCount\)/, "total comes from the stable session total");
  assert.match(functionBody(app, "openAssetView"), /updateAssetViewNav\(\)/, "open initialises position and boundaries");
  assert.match(functionBody(app, "navigateAssetView"), /updateAssetViewNav\(\)/, "navigation refreshes position and boundaries");
});

// 20. A centralised navigate helper exists and is the only entry.
test("20. centralised navigate helper", async () => {
  const viewer = await readAssetView();
  const app = await readApp();
  assert.match(viewer, /function navigateAssetView\(direction\) \{/, "navigateAssetView exists");
  assert.match(app, /els\.assetViewPrev\?\.addEventListener\("click", \(\) => navigateAssetView\(-1\)\)/, "previous button routes through the helper");
  assert.match(app, /els\.assetViewNext\?\.addEventListener\("click", \(\) => navigateAssetView\(1\)\)/, "next button routes through the helper");
});

// 21. The helper accepts only -1/+1.
test("21. direction restricted to -1/+1", async () => {
  const app = await readAssetView();
  assert.match(functionBody(app, "navigateAssetView"), /if \(direction !== -1 && direction !== 1\) return;/, "other directions are rejected");
});

// 22. Navigation updates the single selectedAsset source.
test("22. navigation updates selectedAsset", async () => {
  const app = await readAssetView();
  const navigate = stripJsComments(functionBody(app, "navigateAssetView"));
  assert.match(navigate, /state\.selectedId = id;/, "selectedId moves with navigation");
  assert.match(navigate, /assetViewSequence\.index = nextIndex;/, "sequence index moves with navigation");
});

// 23. Navigation re-renders the detail panel.
test("23. navigation updates detail", async () => {
  const app = await readAssetView();
  const navigate = stripJsComments(functionBody(app, "navigateAssetView"));
  assert.match(navigate, /renderDetail\(\)/, "detail re-renders for the new asset");
  assert.match(navigate, /state\.detailAsset = null;/, "stale detail asset is cleared");
});

// 24. Navigation resets the transform to fit (via the renderAssetView switch path).
test("24. navigation resets transform to fit", async () => {
  const app = await readAssetView();
  assert.match(functionBody(app, "navigateAssetView"), /renderAssetView\(\)/, "navigation re-renders the stage");
  assert.match(functionBody(app, "renderAssetView"), /if \(asset\.id !== assetViewStageAssetId\) \{[\s\S]*?resetAssetViewTransform\(\)/, "asset switch resets the transform");
  assert.match(functionBody(app, "resetAssetViewTransform"), /assetViewTransform\.mode = "fit";/, "reset restores fit");
});

// 25. Navigation zeroes the pan offsets.
test("25. navigation clears offsets", async () => {
  const app = await readAssetView();
  const reset = functionBody(app, "resetAssetViewTransform");
  assert.match(reset, /assetViewTransform\.offsetX = 0;/, "offsetX cleared");
  assert.match(reset, /assetViewTransform\.offsetY = 0;/, "offsetY cleared");
});

// 26. Navigation cleans up any in-flight pointer/pan session.
test("26. navigation clears pointer state", async () => {
  const app = await readAssetView();
  const navigate = stripJsComments(functionBody(app, "navigateAssetView"));
  assert.match(navigate, /cancelAssetViewPan\(\)/, "pan session cancelled before switching");
  const cancel = functionBody(app, "cancelAssetViewPan");
  assert.match(cancel, /assetViewPanSession = null;/, "pan session dropped");
  assert.match(cancel, /assetViewTransform\.isPanning = false;/, "isPanning cleared");
});

// 27. Navigation never touches the Library Return Snapshot.
test("27. navigation keeps return snapshot untouched", async () => {
  const viewer = await readAssetView();
  assert.doesNotMatch(stripJsComments(functionBody(viewer, "navigateAssetView")), /libraryReturnSnapshot/, "navigate helper does not reference the snapshot");
  assert.doesNotMatch(stripJsComments(functionBody(viewer, "updateAssetViewNav")), /libraryReturnSnapshot/, "boundary updates do not reference the snapshot");
});

// 28. Returning still restores the original scrollTop.
test("28. return restores scrollTop", async () => {
  const viewer = await readAssetView();
  const body = functionBody(viewer, "returnToLibrary");
  assert.match(body, /getLibraryScrollContainer\(\)\.scrollTop = snapshot\.scrollTop/, "scroll restoration kept");
  assert.match(body, /assetViewSequence\.ids = \[\];/, "sequence cleared on session end");
});

// 29. Returning still restores the originating card focus.
test("29. return restores card focus", async () => {
  const viewer = await readAssetView();
  assert.match(functionBody(viewer, "returnToLibrary"), /cardButton\.focus\(\{ preventScroll: true \}\)/, "originating card focus kept");
});

// 30. ArrowLeft navigates to the previous asset.
test("30. ArrowLeft navigates previous", async () => {
  const app = await readApp();
  const slice = stripJsComments(viewerKeySlice(app));
  assert.match(slice, /event\.key === "ArrowLeft" \|\| event\.key === "ArrowRight"/, "ArrowLeft claimed in the viewer block");
  assert.match(slice, /event\.key === "ArrowLeft" \? -1 : 1/, "ArrowLeft maps to -1");
});

// 31. ArrowRight navigates to the next asset.
test("31. ArrowRight navigates next", async () => {
  const app = await readApp();
  const slice = stripJsComments(viewerKeySlice(app));
  assert.match(slice, /event\.key === "ArrowLeft" \? -1 : 1/, "ArrowRight maps to +1");
  assert.match(slice, /navigateAssetView\(direction\)/, "arrows route through the helper");
});

// 32. Library mode never intercepts the viewer arrows.
test("32. library mode does not intercept arrows", async () => {
  const app = await readApp();
  const slice = stripJsComments(viewerKeySlice(app));
  assert.match(slice, /if \(state\.viewMode === "asset"/, "viewer arrows live inside the asset-mode guard");
  assert.match(functionBody(app, "bindKeyboardNav"), /if \(state\.viewMode !== "library"\) return;/, "gallery arrow nav stays library-only");
});

// 33. Text inputs are never intercepted.
test("33. inputs not intercepted", async () => {
  const app = await readApp();
  const chain = functionBody(app, "setupKeyboardShortcuts");
  assert.ok(chain.indexOf('event.target.matches?.("input, textarea, select")') < chain.indexOf("ArrowLeft"), "input guard runs before the arrow branch");
  assert.match(stripJsComments(viewerKeySlice(app)), /!event\.target\.closest\?\.\("\[contenteditable\]"\)/, "contenteditable excluded");
});

// 34. Ctrl/Meta/Alt combinations are never intercepted.
test("34. modifiers not intercepted", async () => {
  const app = await readApp();
  assert.match(stripJsComments(viewerKeySlice(app)), /!event\.ctrlKey && !event\.metaKey && !event\.altKey/, "modified arrows bail before navigation");
});

// 35. Modal/Popover/Menu/Lightbox overlays suppress arrow navigation.
test("35. overlays suppress arrows", async () => {
  const app = await readApp();
  const slice = stripJsComments(viewerKeySlice(app));
  assert.match(slice, /els\.imagePreviewModal\?\.hidden/, "lightbox open suppresses arrows");
  assert.match(slice, /!els\.importModal\?\.classList\.contains\("open"\)/, "import modal suppresses arrows");
  assert.match(slice, /!els\.groupModal\?\.classList\.contains\("open"\)/, "group modal suppresses arrows");
  assert.match(slice, /els\.filterPanel\?\.hidden/, "filter panel suppresses arrows");
  assert.match(slice, /els\.settingsMenu\?\.hidden/, "settings menu suppresses arrows");
});

// 36. The Phase 3B zoom shortcuts still exist alongside the arrows.
test("36. phase 3B shortcuts intact", async () => {
  const app = await readApp();
  const slice = stripJsComments(viewerKeySlice(app));
  assert.match(slice, /event\.key === "\+" \|\| event\.key === "="/, "+ and = still zoom in");
  assert.match(slice, /event\.key === "-" \|\| event\.key === "_"/, "- and _ still zoom out");
  assert.match(slice, /event\.key === "0"\) \{ event\.preventDefault\(\); resetAssetViewToHundred\(\);/, "0 still restores 100%");
  assert.match(slice, /event\.key === "f" \|\| event\.key === "F"/, "F/f still fits");
});

// 37. Async race guards exist on the main image pipeline.
test("37. async race guards exist", async () => {
  const viewer = await readAssetView();
  const render = functionBody(viewer, "renderAssetView");
  assert.match(render, /els\.assetViewImage\.dataset\.assetId = asset\.id;/, "render stamps the asset id guard");
  assert.match(render, /els\.assetViewImage\.dataset\.loadSettled = "";/, "render resets the settled marker");
  assert.match(functionBody(viewer, "handleAssetViewImageLoad"), /image\.dataset\.assetId !== state\.selectedId/, "load guard keyed to the current asset");
  assert.match(functionBody(viewer, "handleAssetViewImageError"), /image\.dataset\.assetId !== state\.selectedId/, "error guard keyed to the current asset");
});

// 38. A late load of a superseded image cannot overwrite the current asset.
test("38. stale load cannot overwrite", async () => {
  const viewer = await readAssetView();
  const load = stripJsComments(functionBody(viewer, "handleAssetViewImageLoad"));
  assert.ok(load.indexOf("image.dataset.assetId !== state.selectedId") < load.indexOf("image.style.width"), "id guard runs before writing natural sizes");
  assert.match(load, /image\.dataset\.loadSettled === "error"\) return;/, "load after a settled error is dropped");
});

// 39. A late error of a superseded image cannot mark the current asset as failed.
test("39. stale error cannot overwrite", async () => {
  const viewer = await readAssetView();
  const error = stripJsComments(functionBody(viewer, "handleAssetViewImageError"));
  assert.match(error, /image\.dataset\.assetId !== state\.selectedId\) return;/, "id guard drops stale errors");
  assert.match(error, /!image\.getAttribute\("src"\)\) return;/, "errors without a live request are dropped");
  assert.match(error, /image\.dataset\.loadSettled === "load"\) return;/, "error after a settled load is dropped");
  assert.match(error, /!image\.complete\) return;/, "in-flight current request means the event is stale");
});

// 40. Rapid repeated navigation converges on the last asset: in-sequence steps stay
// synchronous; the only asynchronous branch is the boundary page load (BUG-10).
test("40. rapid navigation converges", async () => {
  const viewer = await readAssetView();
  const navigate = stripJsComments(functionBody(viewer, "navigateAssetView"));
  assert.doesNotMatch(navigate, /setTimeout|requestAnimationFrame|queueMicrotask/, "navigation never defers to timers");
  assert.match(navigate, /direction === 1 && assetViewCanLoadNext\(\)\) \{[\s\S]*?await loadNextAssetViewPage\(\);/, "async page load only at the loaded-sequence end");
  for (const call of ["renderAssetView()", "renderDetail()", "updateAssetViewNav()", "updateSelectedCard()"]) {
    assert.match(navigate, new RegExp(call.replace(/[()]/g, (c) => `\\${c}`)), `${call} runs in the same synchronous step`);
  }
});

// 41. Navigation stays available while the image is in an error state.
test("41. navigation available on image error", async () => {
  const viewer = await readAssetView();
  const navigate = stripJsComments(functionBody(viewer, "navigateAssetView"));
  assert.doesNotMatch(navigate, /assetViewImageReady|assetViewError|loadSettled/, "navigation never gated on image readiness or error state");
  assert.doesNotMatch(stripJsComments(functionBody(viewer, "updateAssetViewNav")), /assetViewImageReady|assetViewError/, "boundaries never gated on image state");
});

// 42. The position output has an accessible name and polite live updates.
test("42. position output accessible name", async () => {
  const html = await readHtml();
  assert.match(html, /<output class="asset-view-position" id="assetViewPosition" data-i18n-aria-label="assetPosition" aria-label="素材位置" aria-live="polite">/, "output has a translated accessible name and polite live region");
  assert.doesNotMatch(html, /assetViewPosition[^>]*aria-live="assertive"/, "never assertive");
});

// 43. The navigation group has an accessible name.
test("43. navigation group accessible name", async () => {
  const html = await readHtml();
  assert.match(html, /<div class="asset-view-nav" id="assetViewNav" role="group" data-i18n-aria-label="assetNavControls" aria-label="素材导航">/, "group role and translated name");
  assert.match(html, /id="assetViewPrev" type="button" data-i18n-aria-label="assetNavPrev" aria-label="上一张素材"/, "previous has a complete translated name");
  assert.match(html, /id="assetViewNext" type="button" data-i18n-aria-label="assetNavNext" aria-label="下一张素材"/, "next has a complete translated name");
});

// 44. New i18n keys exist in both zh and en.
test("44. i18n key symmetry", async () => {
  const i18n = await readI18n();
  const zh = sliceBetween(i18n, "zh: {", "en: {");
  const en = i18n.slice(i18n.indexOf("en: {"));
  for (const key of PHASE3C_I18N_KEYS) {
    assert.match(zh, new RegExp(`${key}: "`), `zh missing ${key}`);
    assert.match(en, new RegExp(`${key}: "`), `en missing ${key}`);
  }
});

// 45. Previous/Next use native disabled (initial state and updates).
test("45. native disabled used", async () => {
  const html = await readHtml();
  assert.match(html, /id="assetViewPrev" type="button"[^>]*disabled>/, "previous starts natively disabled");
  assert.match(html, /id="assetViewNext" type="button"[^>]*disabled>/, "next starts natively disabled");
  const viewer = await readAssetView();
  assert.match(functionBody(viewer, "setAssetViewControlDisabled"), /button\.disabled = disabled;/, "updates write the native disabled property");
});

// 46. aria-disabled stays in sync with native disabled.
test("46. aria-disabled in sync", async () => {
  const viewer = await readAssetView();
  const helper = functionBody(viewer, "setAssetViewControlDisabled");
  assert.match(helper, /button\.setAttribute\("aria-disabled", String\(disabled\)\);/, "aria-disabled mirrors native disabled");
  assert.match(functionBody(viewer, "updateAssetViewNav"), /setAssetViewControlDisabled\(els\.assetViewPrev/, "previous synced through the shared helper");
  assert.match(functionBody(viewer, "updateAssetViewNav"), /setAssetViewControlDisabled\(els\.assetViewNext/, "next synced through the shared helper");
});

// 47. Detail stays on the right at 960–1120.
test("47. detail stays right at 960-1120", async () => {
  const css = await readCss();
  const compact = sliceBetween(css, "@media (max-width: 1120px)", "@media (min-width: 701px) and (max-width: 1120px)");
  assert.match(compact, /\.shell\.details-open \{ grid-template-columns: var\(--sidebar-width-compact\) minmax\(0, 1fr\) var\(--inspector-width-compact\); \}/, "three-column shell keeps the detail column on the right");
  const html = await readHtml();
  assert.ok(html.indexOf('<aside class="detail" id="detailPanel"') > html.indexOf("<main"), "detail aside remains after main in the grid order");
});

// 48. The Phase 3A return-snapshot contract stays intact.
test("48. phase 3A return snapshot intact", async () => {
  const viewer = await readAssetView();
  const body = functionBody(viewer, "openAssetView");
  assert.match(body, /scrollTop: getLibraryScrollContainer\(\)\.scrollTop/, "scrollTop snapshot kept");
  assert.match(body, /focusedAssetId:/, "focusedAssetId kept");
  assert.match(body, /selectedAssetId:/, "selectedAssetId kept");
  assert.match(body, /requestKey: assetRequestKey\(currentAssetRequest\(\)\)/, "requestKey kept");
  assert.doesNotMatch(body, /assets:/, "snapshot still avoids copying the assets array");
});

// 49. The Phase 3B interaction contract helpers stay intact.
test("49. phase 3B helpers intact", async () => {
  const viewer = await readAssetView();
  assert.match(viewer, /function computeAssetFitScale\(stageWidth, stageHeight, naturalWidth, naturalHeight\)/, "fitScale helper kept");
  assert.match(viewer, /function zoomAssetViewAtPoint\(/, "pointer-centred zoom helper kept");
  assert.match(viewer, /function clampAssetViewOffsets\(/, "clamp helper kept");
  await access(resolve(root, "test", "large-view-interaction-contract.test.mjs"));
});

// 50. Phase 1/2/3A/3B contract suites remain in place and runnable.
test("50. phase contract files present", async () => {
  for (const file of [
    "large-view-mode-contract.test.mjs",
    "large-view-interaction-contract.test.mjs",
    "shell-layout-contract.test.mjs",
    "topbar-hierarchy-contract.test.mjs",
    "accessibility-contract.test.mjs",
    "ui-component-contract.test.mjs",
    "card-action-contract.test.mjs",
  ]) {
    await access(resolve(root, "test", file));
  }
});

// 51. The navigation CSS uses no !important.
test("51. no !important in navigation css", async () => {
  const css = await readCss();
  assert.doesNotMatch(navCssSlice(css), /!important/, "navigation styles must not use !important");
});

// 52. Every design token referenced by the navigation CSS is defined.
test("52. no undefined tokens", async () => {
  const css = await readCss();
  const refs = new Set([...navCssSlice(css).matchAll(/var\((--[a-z0-9-]+)\)/gi)].map((match) => match[1]));
  assert.ok(refs.size > 0, "navigation css should consume tokens");
  for (const token of refs) {
    assert.match(css, new RegExp(`${token}:`), `token ${token} is referenced but never defined`);
  }
});

// 53. package.json and the lockfile are untouched by Phase 3C.
test("53. package manifest and lockfile unchanged", async () => {
  const pkg = await readFile(resolve(root, "package.json"), "utf8");
  const lock = await readFile(resolve(root, "package-lock.json"), "utf8");
  // R1 isolation fix (2026-08-09, approved scope) added qa:web/qa:electron/
  // qa:packaged launcher scripts, so the whole-manifest hash no longer holds;
  // the dependency sections the freeze really guards stay byte-identical.
  const manifest = JSON.parse(pkg);
  assert.equal(sha256(JSON.stringify(manifest.dependencies)), "73c83773a57e21a20917d81b24288bdfddd9bb7ddd644fdaedd6e6cfba13c405", "package.json dependencies must not change in Phase 3C");
  assert.equal(sha256(JSON.stringify(manifest.devDependencies)), "24a0c3b9b5c327ef720981045751d87687b51bd41e0e104ed7e0d3127879387b", "package.json devDependencies must not change in Phase 3C");
  assert.equal(sha256(lock), "50a7d029b6aed62fd921ca013f00dba1b01d2ce96009792fb69c63207a04c8dd", "package-lock.json must not change in Phase 3C");
});

// 54. No new dependencies (app.js import set unchanged).
test("54. no new dependencies", async () => {
  const app = await readApp();
  assert.deepEqual([...app.matchAll(/^import .* from "(.*)";$/gm)].map((match) => match[1]).sort(),
    ["./api-client.mjs", "./asset-view.mjs", "./bridge-status-poller.mjs", "./confirm-dialog.mjs", "./i18n-runtime.mjs", "./image-preview.mjs", "./inspector-markup.mjs", "./overlay-manager.mjs", "./toast-manager.mjs"], "app.js gains no new imports");
});
