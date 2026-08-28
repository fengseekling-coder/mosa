// Large view mode contract (Phase 3A / D4 / F-01): dedicated asset-view shell —
// two mutually exclusive UI states in the main region, single-primary-action
// header, quiet contain stage, open/return state machine, gallery context
// snapshot/restore, Escape layering and i18n. Static guards only — Node
// standard library, no network access. Locks concrete DOM, selectors, state
// fields and function behaviour (never a whole-file SHA).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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

/** The asset-view section of index.html (opening tag through the end of </main>). */
const assetViewSlice = (html) => sliceBetween(html, '<section class="asset-view"', "</main>");
/** The Phase 3A section of styles.css (new section header through the detail-panel header). */
const assetViewCssSlice = (css) => sliceBetween(css, "/* ===== 专用大图查看模式", "/* ===== 详情面板 ===== */");
/** The body of a top-level app.js function (from the declaration to the balanced closing brace). */
function functionBody(source, name) {
  const body = blockAfter(source, `function ${name}(`);
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf(body, start) + body.length);
}

// 1. The main region exposes two explicit, mutually exclusive UI states:
//    .library-view (gallery) and .asset-view (dedicated large-image view).
test("1. two explicit UI states exist in the main region", async () => {
  const html = await readHtml();
  assert.match(html, /<section class="library-view" id="libraryView">/, "gallery state wrapper must exist");
  assert.match(html, /<section class="asset-view" id="assetView" aria-labelledby="assetViewTitle" hidden inert aria-hidden="true">/,
    "asset-view state must exist and start hidden + inert + aria-hidden");
  const main = sliceBetween(html, '<main class="library">', "</main>");
  assert.ok(main.indexOf('id="libraryView"') < main.indexOf('id="assetView"'), "library-view precedes asset-view in DOM order");
});

// 2. The view owns an independent stage region inside the asset-view state.
test("2. dedicated stage region exists", async () => {
  const [html, css] = await Promise.all([readHtml(), readCss()]);
  assert.match(assetViewSlice(html), /<div class="asset-view-stage" id="assetViewStage">/, "stage container must exist");
  const stage = blockAfter(css, ".asset-view-stage {");
  assert.match(stage, /flex: 1/, "stage consumes the remaining height");
  assert.match(stage, /overflow: hidden/, "stage must not produce scrollbars");
  assert.match(stage, /align-items: center/, "stage centres the media vertically");
  assert.match(stage, /justify-content: center/, "stage centres the media horizontally");
});

// 3. Exactly one primary image (plus one video equivalent for video assets) lives
//    in the stage — the page never shows two competing primary images.
test("3. single primary media in the stage", async () => {
  const html = await readHtml();
  const slice = assetViewSlice(html);
  assert.equal(slice.match(/<img\b/g).length, 1, "exactly one <img> in the asset view");
  assert.equal(slice.match(/<video\b/g).length, 1, "exactly one <video> (video-asset equivalent) in the asset view");
  assert.match(slice, /<img class="asset-view-image" id="assetViewImage" alt="" draggable="false" hidden \/>/, "primary image starts hidden with an alt hook and the native drag ghost disabled (Phase 3B)");
});

// 4. No thumbnail strip is shipped in the dedicated view.
test("4. no thumbnail strip in the asset view", async () => {
  const html = await readHtml();
  const slice = assetViewSlice(html);
  assert.doesNotMatch(slice, /thumb|filmstrip|strip|gallery-strip/i, "no thumbnail-strip markup in the asset view");
});

// 5. No related-assets rail is shipped in the dedicated view.
test("5. no related-assets rail in the asset view", async () => {
  const html = await readHtml();
  const slice = assetViewSlice(html);
  assert.doesNotMatch(slice, /related|recommend|similar/i, "no related-assets markup in the asset view");
  const viewer = await readAssetView();
  assert.doesNotMatch(functionBody(viewer, "renderAssetView"), /related|recommend|similar/i, "renderAssetView paints no related rail");
});

// 6. In asset mode the gallery grid is hidden (via the library-view wrapper).
test("6. gallery is hidden in asset mode", async () => {
  const viewer = await readAssetView();
  const body = functionBody(viewer, "setViewMode");
  assert.match(body, /els\.libraryView\.hidden = assetMode/, "library-view (grid wrapper) must be hidden in asset mode");
  assert.match(body, /els\.assetView\.hidden = !assetMode/, "asset-view must be visible in asset mode");
});

// 7. In asset mode the gallery grid is inert (removed from the tab order).
test("7. gallery is inert in asset mode", async () => {
  const viewer = await readAssetView();
  const body = functionBody(viewer, "setViewMode");
  assert.match(body, /els\.libraryView\.toggleAttribute\("inert", assetMode\)/, "library-view must be inert in asset mode");
  assert.match(body, /els\.assetView\.toggleAttribute\("inert", !assetMode\)/, "asset-view must leave inert in asset mode");
  assert.match(body, /els\.libraryView\.setAttribute\("aria-hidden", String\(assetMode\)\)/, "library-view must be aria-hidden in asset mode");
});

// 8. The detail panel stays the right-hand column of the shell in asset mode.
test("8. detail panel remains the right column", async () => {
  const [html, css] = await Promise.all([readHtml(), readCss()]);
  assert.ok(html.indexOf('class="library"') < html.indexOf('id="detailPanel"'), "detail stays after the main region in DOM order");
  const shellOpen = blockAfter(css, ".shell.details-open {");
  assert.match(shellOpen, /grid-template-columns: var\(--sidebar-width\) minmax\(0, 1fr\) var\(--inspector-width\)/,
    "wide details-open shell keeps the inspector as the third column");
});

// 9. Compact desktop (701–1120px) keeps the three-column shell — detail never
//    drops below the gallery, and no horizontal scrollbar is introduced.
test("9. compact 960–1120 keeps three columns (no detail drop)", async () => {
  const css = await readCss();
  const compact = blockAfter(css, "@media (max-width: 1120px) {");
  assert.match(compact, /\.shell\.details-open \{ grid-template-columns: var\(--sidebar-width-compact\) minmax\(0, 1fr\) var\(--inspector-width-compact\); \}/,
    "compact details-open keeps sidebar-rail + stage + inspector columns");
  assert.match(compact, /\.asset-view-header \{ gap: var\(--space-1\); padding: 0 var\(--space-1\); \}/,
    "asset-view header follows the same compact padding as the topbar");
  const rail = blockAfter(css, "@media (min-width: 701px) and (max-width: 1120px) {");
  assert.doesNotMatch(rail, /\.detail \{[^}]*position: static/, "detail must not re-enter the document flow in the rail band");
});

// 10. Library v2 uses the inspector drawer as the single card destination.
// The historical canvas viewer stays available for its own controls, but a card
// press must never switch the primary UI away from the V2 gallery context.
test("10. single click on a card opens the V2 detail inspector", async () => {
  const app = await readApp();
  const cards = sliceBetween(app, 'const selectButton = event.target.closest(".asset-card-select")', 'const loadMoreButton = event.target.closest');
  assert.match(cards, /const id = selectButton\.closest\("\.asset-card"\)\?\.dataset\.id;/,
    "card click resolves the asset id");
  assert.match(cards, /if \(id\) void selectAsset\(id\);/, "card click opens the V2 detail inspector");
  assert.doesNotMatch(cards, /openAssetView/, "card click does not enter the retired canvas viewer");
});

// 11. The card favourite quick action does not bubble.
test("11. favourite quick action does not bubble", async () => {
  const app = await readApp();
  const fav = sliceBetween(app, 'const favoriteButton = event.target.closest(".card-favorite")', 'const copyButton = event.target.closest(".card-quick-copy")');
  assert.match(fav, /event\.stopPropagation\(\)/, "favourite click must not bubble to the card");
  assert.match(fav, /void toggleFavorite\(favoriteButton\.dataset\.favId, event\)/, "favourite click keeps its action");
});

// 12. The card copy quick action does not bubble.
test("12. copy quick action does not bubble", async () => {
  const app = await readApp();
  const copy = sliceBetween(app, 'const copyButton = event.target.closest(".card-quick-copy")', 'const selectButton = event.target.closest(".asset-card-select")');
  assert.match(copy, /event\.stopPropagation\(\)/, "copy click must not bubble to the card");
  assert.match(copy, /const assetId = copyButton\.closest\("\.asset-card"\)\?\.dataset\.id;/, "copy resolves the owning asset without embedding its prompt in DOM");
  assert.match(copy, /navigator\.clipboard\.writeText\(asset\?\.prompt \|\| ""\)/, "copy click keeps its clipboard action");
});

// 13. The return control is a native button whose accessible name contains the
//     visible return semantics (label + scope), in both locales.
test("13. return button exposes a complete accessible name", async () => {
  const [html, i18n] = await Promise.all([readHtml(), readI18n()]);
  const slice = assetViewSlice(html);
  assert.match(slice, /<button class="toolbar-filter asset-view-back" id="assetViewBack" type="button">/,
    "return control is a native type=button consuming the ToolbarButton contract");
  assert.match(slice, /<span class="asset-view-back-label" data-i18n="backToLibrary">返回素材库<\/span>/,
    "visible return-semantics label is present and i18n-driven");
  assert.match(slice, /<span class="asset-view-back-scope" id="assetViewScope">全部素材<\/span>/,
    "visible scope name rides along in the accessible name");
  assert.match(i18n, /backToLibrary: "返回素材库"/, "zh backToLibrary copy");
  assert.match(i18n, /backToLibrary: "Back to library"/, "en backToLibrary copy");
});

// 14. Escape closes the topmost layer first: menus before the view exit,
//     and the view exit before the legacy detail fallback.
test("14. Escape layering: overlays first, view exit second", async () => {
  const app = await readApp();
  const shortcuts = functionBody(app, "setupKeyboardShortcuts");
  const iSettings = shortcuts.indexOf("if (!els.settingsMenu?.hidden)");
  const iViewDetail = shortcuts.indexOf('if (state.viewMode === "asset" || state.detailOpen) { event.preventDefault(); void closeDetailSurface(); return; }');
  for (const [name, pos] of [["settings", iSettings], ["view/detail", iViewDetail]]) {
    assert.ok(pos > -1, `${name} Escape branch must exist`);
  }
  assert.ok(iSettings < iViewDetail,
    "Escape priority must be settings menu → dirty-safe asset/detail exit");
  const delegated = sliceBetween(app, 'document.addEventListener("keydown", trapImagePreviewFocus);', "bindDesktopIntegration();");
  assert.match(delegated, /if \(state\.viewMode === "asset"\) return;/,
    "the earlier-registered detail Escape listener must not fire through the asset view");
});

// 15. The snapshot records scrollTop exclusively through the shared real-scroller
//     helper — never a direct assetGrid.scrollTop read, never window.scrollY.
test("15. snapshot captures scrollTop via the shared scroller helper", async () => {
  const viewer = await readAssetView();
  const body = functionBody(viewer, "openAssetView");
  assert.match(body, /scrollTop: getLibraryScrollContainer\(\)\.scrollTop/, "snapshot reads scrollTop through getLibraryScrollContainer()");
  assert.doesNotMatch(body, /els\.assetGrid\.scrollTop/, "snapshot must not read assetGrid.scrollTop directly");
  assert.doesNotMatch(body + functionBody(viewer, "returnToLibrary"), /window\.scrollY|window\.scrollTo/,
    "scroll state never comes from the window");
});

// 16. scrollTop is restored through the same helper after the gallery is visible
//     and laid out again (double rAF — display:none clamps scrollTop to 0, fixed
//     timeouts are banned), and focus is restored only after the scroll write.
test("16. scrollTop restored via helper after re-layout, focus after scroll", async () => {
  const viewer = await readAssetView();
  const body = functionBody(viewer, "returnToLibrary");
  const iRaf = body.indexOf("requestAnimationFrame(() => {");
  const iScroll = body.indexOf("getLibraryScrollContainer().scrollTop = snapshot.scrollTop;");
  const iFocus = body.indexOf("cardButton.focus({ preventScroll: true })");
  assert.ok(iRaf > -1 && iScroll > iRaf, "restore writes scrollTop via the helper inside the rAF callback");
  assert.ok(iFocus > iScroll, "focus restore runs after the scrollTop write in the same settled frame");
  assert.match(body, /requestAnimationFrame\(\(\) => \{\s+requestAnimationFrame\(\(\) => \{/, "restore runs inside a double requestAnimationFrame");
  assert.doesNotMatch(body, /setTimeout/, "no fixed-delay restore");
});

// 19. Focus returns to the originating card; if it is gone, focus lands on the
//     gallery container (main content), never on <body>.
test("19. focus restores to the originating card with a grid fallback", async () => {
  const viewer = await readAssetView();
  const body = functionBody(viewer, "returnToLibrary");
  assert.match(body, /els\.assetGrid\.querySelector\(`\.asset-card\[data-id="\$\{CSS\.escape\(snapshot\.focusedAssetId\)\}"\] \.asset-card-select`\)/,
    "the originating card button is looked up by the snapshot id");
  assert.match(body, /if \(cardButton\) cardButton\.focus\(\{ preventScroll: true \}\);\s+else els\.assetGrid\.focus\(\{ preventScroll: true \}\);/,
    "fallback focus lands on the gallery container, and neither focus call may move the restored scroll");
  const html = await readHtml();
  assert.match(html, /<section class="grid" id="assetGrid"[^>]*tabindex="-1"/, "grid container is programmatically focusable");
});

// 20. Opening and returning never reset the search query.
test("20. search query is never reset by the view cycle", async () => {
  const viewer = await readAssetView();
  const bodies = functionBody(viewer, "openAssetView") + functionBody(viewer, "returnToLibrary");
  assert.doesNotMatch(bodies, /state\.query\s*=/, "view cycle must not touch state.query");
  assert.doesNotMatch(bodies, /els\.searchInput\.value\s*=/, "view cycle must not touch the search input");
});

// 21. Opening and returning never reset the active facets.
test("21. facet filters are never reset by the view cycle", async () => {
  const viewer = await readAssetView();
  const bodies = functionBody(viewer, "openAssetView") + functionBody(viewer, "returnToLibrary");
  assert.doesNotMatch(bodies, /state\.facets|clearFacets|applyFilterChange/, "view cycle must not touch facet state");
});

// 22. Opening and returning never reset the sort order.
test("22. sort order is never reset by the view cycle", async () => {
  const viewer = await readAssetView();
  const bodies = functionBody(viewer, "openAssetView") + functionBody(viewer, "returnToLibrary");
  assert.doesNotMatch(bodies, /state\.sort\s*=|normalizeSort/, "view cycle must not touch sort state");
});

// 23. Opening and returning never reset the scope (all/favorites/recent) or groups.
test("23. scope and groups are never reset by the view cycle", async () => {
  const viewer = await readAssetView();
  const bodies = functionBody(viewer, "openAssetView") + functionBody(viewer, "returnToLibrary");
  assert.doesNotMatch(bodies, /state\.scope\s*=|state\.groups\s*=/, "view cycle must not touch scope or groups");
});

// 24. No parallel router is introduced for the view.
test("24. no new router for the view mode", async () => {
  const app = await readApp();
  assert.doesNotMatch(app, /pushState|replaceState|hashchange|popstate|onhashchange/,
    "view mode is state-driven, never URL-driven");
});

// 25. No second selected-asset state is introduced — the single selectedId is reused.
test("25. no duplicate selected-asset state", async () => {
  const app = await readApp();
  const viewer = await readAssetView();
  assert.doesNotMatch(app, /state\.(assetViewId|viewAssetId|viewerAssetId|largeViewId|viewSelectedId)/,
    "no parallel selected id may be introduced");
  assert.match(functionBody(viewer, "openAssetView"), /state\.selectedId = id;/,
    "the view reuses the single state.selectedId");
});

// 26. Stage media contract (Phase 3B rendering model): the image renders at its
//     natural size multiplied by the JS-driven transform scale; fit still means the
//     complete image, centred, never cropped, never stretched — the fitScale formula
//     itself is guarded by test/large-view-interaction-contract.test.mjs.
test("26. contain contract on the stage media", async () => {
  const css = await readCss();
  const image = blockAfter(css, ".asset-view-image {");
  assert.match(image, /transform-origin: center center/, "zoom/pan transforms anchor at the image centre");
  assert.match(image, /flex: 0 0 auto/, "image keeps its natural box inside the flex stage");
  assert.doesNotMatch(image, /object-fit: cover|max-width: 100%|max-height: 100%/,
    "no cropping and no CSS rescaling that would fight the JS transform model");
  assert.match(blockAfter(css, ".asset-view-stage {"), /overflow: hidden/,
    "stage clips the transformed media without producing scrollbars");
});

// 27. The two modes can never be in the tab order together (hidden + inert are
//     driven by the same boolean in one place).
test("27. the two modes are mutually exclusive in the tab order", async () => {
  const viewer = await readAssetView();
  const body = functionBody(viewer, "setViewMode");
  assert.match(body, /const assetMode = state\.viewMode === "asset";/, "a single boolean drives both regions");
  assert.ok(body.indexOf("els.libraryView.hidden = assetMode") < body.indexOf("els.assetView.hidden = !assetMode"),
    "library hides exactly when the asset view shows");
  assert.match(body, /els\.appShell\?\.classList\.toggle\("asset-view-open", assetMode\)/,
    "the shell mirrors the mode for styling hooks");
});

// 28. The global search lives in the topbar (V2 FilterBar location contract).
test("28. search lives in the topbar", async () => {
  const html = await readHtml();
  assert.equal(html.match(/id="searchInput"/g).length, 1, "exactly one #searchInput in the document");
  assert.ok(html.indexOf('<header class="topbar"') < html.indexOf('id="searchInput"'), "search lives inside the topbar");
  assert.ok(html.indexOf('id="searchInput"') < html.indexOf('class="topbar-primary-group"'), "search sits before the primary group");
});

// 29. The topbar hierarchy (context + three action groups, unique control
//     IDs) is intact — the view adds no second competing toolbar.
test("29. topbar hierarchy intact, single toolbar per mode", async () => {
  const html = await readHtml();
  assert.ok(html.indexOf("topbar-context") < html.indexOf("topbar-actions"), "context precedes actions");
  for (const group of ["topbar-utility-group", "topbar-work-group", "topbar-primary-group"]) {
    assert.equal(html.match(new RegExp(`class="${group}"`, "g")).length, 1, `${group} appears exactly once`);
  }
  // V2 removed batchToggle and filterToggle
  for (const id of ["bridgeStatus", "themeToggle", "sortSelect", "newAssetTopBtn"]) {
    assert.equal(html.match(new RegExp(`id="${id}"`, "g"))?.length || 0, 1, `#${id} must stay unique`);
  }
  const asset = assetViewSlice(html);
  assert.doesNotMatch(asset, /class="topbar/, "the asset view reuses no gallery topbar markup");
  assert.equal(asset.match(/<header\b/g).length, 1, "the asset view ships exactly one header");
});

// 30. The Phase 2C shell contract (three layout modes) is preserved.
test("30. shell three-mode contract preserved", async () => {
  const css = await readCss();
  assert.match(blockAfter(css, ".shell {"), /grid-template-columns: var\(--sidebar-width\) minmax\(0, 1fr\)/, "wide shell");
  assert.match(blockAfter(css, ".shell.details-open {"), /var\(--inspector-width\)/, "wide details-open shell");
  const compact = blockAfter(css, "@media (max-width: 1120px) {");
  assert.match(compact, /\.shell \{ grid-template-columns: var\(--sidebar-width-narrow\) minmax\(0, 1fr\); \}/, "compact shell");
  assert.match(compact, /var\(--inspector-width-compact\)/, "compact details-open shell");
  const fallback = blockAfter(css, "@media (max-width: 700px) {");
  assert.match(fallback, /\.shell, \.shell\.details-open \{ display: flex; min-height: 100vh; flex-direction: column; \}/, "web fallback");
  assert.match(fallback, /\.asset-view \{ min-height: 56vh; \}/, "asset view follows the fallback min-height");
});

// 31. The card quick-action contract (favourite + copy, stopPropagation) is intact.
test("31. card quick-action contract preserved", async () => {
  const app = await readApp();
  assert.match(app, /<div class="card-actions">\$\{favBtn\}\$\{copyBtn\}<\/div>/, "card actions keep both quick buttons");
  const fav = sliceBetween(app, 'const favoriteButton = event.target.closest(".card-favorite")', 'const copyButton = event.target.closest(".card-quick-copy")');
  const copy = sliceBetween(app, 'const copyButton = event.target.closest(".card-quick-copy")', 'const selectButton = event.target.closest(".asset-card-select")');
  assert.match(fav, /event\.stopPropagation\(\)/, "favourite keeps its bubbling guard");
  assert.match(fav, /void toggleFavorite\(favoriteButton\.dataset\.favId, event\)/, "favourite keeps its action");
  assert.match(copy, /event\.stopPropagation\(\)/, "copy keeps its bubbling guard");
  assert.match(copy, /void runAction\(async \(\) => \{/, "copy keeps its async action wrapper");
});

// 32. The new CSS introduces no !important.
test("32. no !important in the Phase 3A CSS", async () => {
  const css = await readCss();
  assert.doesNotMatch(assetViewCssSlice(css), /!important/, "new section must stay off !important");
});

// 33. Every design token consumed by the new CSS is defined (no orphan var()).
test("33. no undefined design tokens in the Phase 3A CSS", async () => {
  const css = await readCss();
  const consumed = new Set();
  for (const match of css.matchAll(/\.asset-view[^{]*\{[^}]*\}/g)) {
    for (const token of match[0].matchAll(/var\((--[a-z0-9-]+)\)/gi)) consumed.add(token[1]);
  }
  assert.ok(consumed.size > 0, "expected the new rules to consume design tokens");
  for (const token of consumed) {
    assert.ok(new RegExp(`${token}\\s*:`).test(css), `token ${token} must be defined`);
  }
});

// 34. package.json and package-lock.json stay untouched (SHA baselines shared
//     with the out-of-scope locks in the sibling contracts).
test("34. package files stay untouched", async () => {
  const pkg = await readFile(resolve(root, "package.json"), "utf8");
  // R1 isolation fix (2026-08-09, approved scope) added qa:web/qa:electron/
  // qa:packaged launcher scripts, so the whole-manifest hash no longer holds;
  // the dependency sections the freeze really guards stay byte-identical.
  const manifest = JSON.parse(pkg);
  assert.equal(sha256(JSON.stringify(manifest.dependencies)), "73c83773a57e21a20917d81b24288bdfddd9bb7ddd644fdaedd6e6cfba13c405", "package.json dependencies must stay untouched");
  assert.equal(sha256(JSON.stringify(manifest.devDependencies)), "11f67ce00f34b4d3dfb9b9ed0dfb428b0368ad5e0a17bd3bafaa40e3c2124fac", "package.json devDependencies must stay untouched");
  const lock = await readFile(resolve(root, "package-lock.json"), "utf8");
  assert.equal(sha256(lock), "ecf0fdc199de87ccd30ffe6a7da4624c2f632700cd8348194a30b79dd2e2a69f", "package-lock.json must stay untouched");
});

// 35. Runtime-verified fix: the shortcuts Escape chain must bail when an
//     earlier-registered modal focus trap already consumed the event
//     (defaultPrevented) — otherwise one Escape closes the modal AND exits the
//     asset view (penetration found in runtime flow 18).
test("35. Escape chain stops after a modal trap consumed the event", async () => {
  const app = await readApp();
  const shortcuts = functionBody(app, "setupKeyboardShortcuts");
  // V2 removed batch mode, find the Escape branch up to the next major conditional
  const escapeStart = shortcuts.indexOf('if (event.key === "Escape") {');
  const escapeEnd = shortcuts.indexOf('if (event.key === "ArrowLeft"', escapeStart);
  const escapeBranch = shortcuts.slice(escapeStart, escapeEnd);
  assert.match(escapeBranch, /if \(event\.defaultPrevented\) return;/,
    "Escape chain must bail on defaultPrevented before any overlay/view-exit branch");
});

// 36. Centralized real-scroller helper: the Grid qualifies only when it genuinely
//     scrolls (content overflows AND computed overflow-y allows it); otherwise the
//     document scroller is used, with documentElement as the sane fallback.
test("36. centralized getLibraryScrollContainer helper resolves the real scroller", async () => {
  const viewer = await readAssetView();
  const body = functionBody(viewer, "getLibraryScrollContainer");
  assert.match(body, /grid\.scrollHeight > grid\.clientHeight/, "grid must genuinely overflow to qualify");
  assert.match(body, /getComputedStyle\(grid\)\.overflowY/, "computed overflow-y is inspected");
  assert.match(body, /overflowY === "auto" \|\| overflowY === "scroll"/, "only a scrollable overflow-y qualifies");
  assert.match(body, /document\.scrollingElement \|\| document\.documentElement/, "document scroller with documentElement fallback");
});

// 37. The scroller judgement lives in exactly one place: the helper is the only
//     site that mentions scrollingElement, and open/return both consume it.
test("37. scroller resolution is centralized, not copied across functions", async () => {
  const viewer = await readAssetView();
  assert.equal(viewer.split("document.scrollingElement").length - 1, 1,
    "document.scrollingElement must appear exactly once (inside the helper)");
  assert.match(functionBody(viewer, "openAssetView"), /getLibraryScrollContainer\(\)/, "open captures through the helper");
  assert.match(functionBody(viewer, "returnToLibrary"), /getLibraryScrollContainer\(\)/, "return restores through the same helper");
});

// 38. No window-scroll assumptions and no harness-only hooks in the view cycle:
//     the product captures and restores scroll itself; tests only observe.
test("38. no window scroll APIs or harness-only hooks in the view cycle", async () => {
  const viewer = await readAssetView();
  const cycle = functionBody(viewer, "openAssetView") + functionBody(viewer, "returnToLibrary") + functionBody(viewer, "getLibraryScrollContainer");
  assert.doesNotMatch(cycle, /window\.scrollY|window\.scrollTo|scrollIntoView/, "no parallel window-scroll implementation");
  assert.doesNotMatch(cycle, /__p3a|watchdog|cdp/i, "product code must not contain test-harness hooks");
});

// 39. The return snapshot stays minimal — scroll position, originating card,
//     selection and the result-set key; never whole state or the asset array.
test("39. return snapshot stays minimal", async () => {
  const viewer = await readAssetView();
  const body = functionBody(viewer, "openAssetView");
  const snapshot = sliceBetween(body, "state.libraryReturnSnapshot = {", "};");
  const keys = [...snapshot.matchAll(/^ {4,6}(\w+):/gm)].map((match) => match[1]);
  assert.deepEqual(keys, ["scrollTop", "focusedAssetId", "selectedAssetId", "requestKey"],
    "snapshot stores only the minimal gallery context");
  assert.doesNotMatch(snapshot, /\.assets\b/, "snapshot must not copy the asset list");
});

// 40. Runtime-verified fix: when result-set semantics changed while viewing
//     (requestKey mismatch), focus must land on the gallery container
//     unconditionally. setDetailOpen(false) has just moved focus back to the
//     element that opened the view — usually the originating gallery card — and
//     that card dies with the upcoming re-render, dropping focus to <body>
//     (found in the runtime focus-fallback re-verification, flow 15).
test("40. degraded return always focuses the gallery container", async () => {
  const viewer = await readAssetView();
  const body = functionBody(viewer, "returnToLibrary");
  const degraded = sliceBetween(body, "if (snapshot.requestKey !== assetRequestKey(currentAssetRequest())) {", "      return;\n    }");
  assert.match(degraded, /els\.assetGrid\.focus\(\);/, "degraded branch focuses the grid container");
  assert.doesNotMatch(degraded, /libraryView\?\.contains|activeElement/,
    "no conditional guard that stale in-library focus can defeat");
});

// 41. Runtime-verified fix: the library detail-drawer's own Escape listener runs
//     BEFORE setupKeyboardShortcuts (both are document keydown listeners registered
//     in bindEvents order). A modal/lightbox trap has already consumed the same
//     Escape (preventDefault + closed the overlay) by the time this listener runs,
//     so its modal-open guards all pass — without a defaultPrevented bail it would
//     close the detail drawer as a second layer on the same keystroke (penetration
//     found in the Escape-priority matrix re-verification: add-group/import modal
//     + detail open → one Escape closed both).
test("41. detail-drawer Escape listener bails on defaultPrevented", async () => {
  const app = await readApp();
  const bind = functionBody(app, "bindEvents");
  const drawerEscape = sliceBetween(bind, 'document.addEventListener("keydown", (event) => {\n    if (event.key !== "Escape") return;', "void closeDetailSurface();");
  assert.match(drawerEscape, /if \(event\.defaultPrevented\) return;/,
    "detail-drawer Escape listener must bail before its overlay guards when a trap consumed the event");
});

// 42. Runtime-verified fix: entering via double-click means the first click opens
//     the view and synchronously focuses the back button, then the second
//     mousedown lands on the stage/main image now occupying those coordinates —
//     the browser default action moves focus to <body> and the open-focus is lost
//     (found in the double-click entry re-verification, flow 31/36). The stage
//     mousedown guard prevents the default focus theft on stage/image only;
//     the video element is excluded so native controls keep working.
test("42. asset-view stage mousedown guard prevents double-click focus theft", async () => {
  const app = await readApp();
  const bind = functionBody(app, "bindEvents");
  const guard = sliceBetween(bind, 'els.assetViewStage?.addEventListener("mousedown"', "});");
  assert.match(guard, /event\.target === els\.assetViewStage/, "guard covers the stage itself");
  assert.match(guard, /event\.target === els\.assetViewImage/, "guard covers the main image");
  assert.doesNotMatch(guard, /assetViewVideo/, "video element keeps native mousedown for controls");
  assert.match(guard, /event\.preventDefault\(\);/, "guard suppresses the default focus move");
});
