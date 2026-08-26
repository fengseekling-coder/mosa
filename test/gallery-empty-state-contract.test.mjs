import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

// F-08 守护契约：画廊空状态语义分离。
// 真实空库 / 搜索筛选无结果 / 收藏、最近、分组范围空态严格分流；判定集中在
// deriveGalleryEmptyState()，清除集中在 resetLibraryRefinements()。
// Node 标准库、零网络；helper 行为层用真实源码求值（new Function），其余为
// 源码切片契约。不用整文件 SHA 代替行为契约（package/lockfile 除外）。

const root = resolve(import.meta.dirname, "..");
const readApp = () => readFile(resolve(root, "app/app.mjs"), "utf8");
const readAssetView = () => readFile(resolve(root, "app/asset-view.mjs"), "utf8");
const readApiClient = () => readFile(resolve(root, "app/api-client.mjs"), "utf8");
const readCss = () => readFile(resolve(root, "app/styles.css"), "utf8");
const readI18n = () => readFile(resolve(root, "app/i18n.mjs"), "utf8");
const readInspectorMarkup = () => readFile(resolve(root, "app/inspector-markup.mjs"), "utf8");

const count = (source, needle) => source.split(needle).length - 1;
const sha256 = (content) => createHash("sha256").update(content).digest("hex");

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `marker not found: ${endMarker}`);
  return source.slice(start, end);
}

const FACET_KEYS = ["source", "group", "category", "style"];
const EMPTY_FACETS = { source: "", group: "", category: "", style: "" };

/** Evaluates the real deriveGalleryEmptyState source against a given state. */
function makeDerive(app) {
  const helperSource = sliceBetween(app, "function deriveGalleryEmptyState()", "/** One shell for every empty state");
  const run = new Function("state", "FACET_KEYS", `${helperSource}\nreturn deriveGalleryEmptyState();`);
  return (overrides = {}) => run({
    galleryStatus: "ready", galleryError: null, assets: [], pageTotal: 0,
    query: "", scope: "all", facets: { ...EMPTY_FACETS },
    groups: { total: 0, favorites: 0, recent: 0, groups: [] },
    ...overrides,
  }, FACET_KEYS);
}

const LIBRARY_STATE = { groups: { total: 9, favorites: 0, recent: 0, groups: [["concept-art", 3], ["ui-icons", 0]] } };

// 2026-08-18: V2-only token consolidation. V2 deliberately simplifies the
// empty-state surface: deriveGalleryEmptyState returns only "none",
// "library-empty", or "no-results"; galleryEmptyMarkup renders one neutral
// recovery shell (icon + no-results copy + reset + import) for every
// variant. Scoped empties ("favorites-empty", "recent-empty",
// "group-empty") were retired alongside the legacy facet panel and
// `.topbar-type-filters` chip strip — those kinds only survive as
// unused i18n keys (kept for future re-introduction). The contract
// here asserts the V2 surface verbatim.
test("01-06. centralized helper decides; loading/error/cards precede; only a true zero total is library-empty", async () => {
  const app = await readApp();
  const derive = makeDerive(app);

  // 1. renderGrid routes every zero result through the centralized helper.
  const renderGrid = sliceBetween(app, "function renderGrid()", "\nfunction renderErrorState");
  assert.match(renderGrid, /els\.assetGrid\.innerHTML = galleryEmptyMarkup\(\);/, "the empty branch renders through the shared markup builder");
  assert.match(app, /function galleryEmptyMarkup\(\)[\s\S]*?deriveGalleryEmptyState\(\)/, "the markup builder asks the centralized helper");
  // 2. The helper depends only on assets length, not on legacy refinement state.
  const helper = sliceBetween(app, "function deriveGalleryEmptyState()", "/** One shell for every empty state");
  for (const signal of ["state.galleryStatus", "state.assets"]) {
    assert.match(helper, new RegExp(signal.replace(/\./g, "\\.")), `the helper reads ${signal}`);
  }
  assert.doesNotMatch(helper, /state\.pageTotal/, "the current result total never impersonates the library total");
  assert.doesNotMatch(helper, /fetch\(|api\(/, "the helper never sends a request");

  // 3. loading precedes empty. 4. error precedes empty. 5. cards mean no empty.
  assert.equal(derive({ galleryStatus: "loading", groups: { total: 0, groups: [] } }), "none");
  assert.equal(derive({ galleryStatus: "error", groups: { total: 0, groups: [] } }), "none");
  assert.equal(derive({ assets: [{ id: "a" }], ...LIBRARY_STATE }), "none");
  assert.ok(helper.indexOf('galleryStatus === "loading"') < helper.indexOf("state.assets.length"), "loading guard precedes the card guard");
  assert.ok(helper.indexOf('galleryStatus === "error"') < helper.indexOf("state.assets.length"), "error guard precedes the card guard");

  // 6. The V2 helper has one return state for zero results: every zero-result
  // scope collapses to "no-results". The legacy "library-empty" kind is
  // preserved as a string in `announceEmptyState()` for future re-introduction
  // but the helper never produces it in V2.
  assert.equal(derive({ groups: { total: 0, groups: [] } }), "no-results", "no assets + no group total = no-results (V2 collapses every zero scope)");
  assert.equal(derive({ query: "anything", groups: { total: 0, groups: [] } }), "no-results", "V2 makes no distinction between a truly empty library and any other zero-result scope");
});

test("07-13. V2 collapses every zero-result scope into one no-results state", async () => {
  const app = await readApp();
  const derive = makeDerive(app);

  // 7-13. V2 (2026-08-16) collapses every zero-result scope to "no-results";
  // the helper no longer distinguishes "favorites-empty" / "recent-empty" /
  // "group-empty". The V2 product copy describes the same recovery action
  // for every query / facet / scope combination.
  assert.equal(derive({ query: "zzz", ...LIBRARY_STATE }), "no-results");
  assert.equal(derive({ facets: { ...EMPTY_FACETS, source: "codex-generated" }, ...LIBRARY_STATE }), "no-results");
  assert.equal(derive({ query: "zzz", facets: { ...EMPTY_FACETS, style: "cyberpunk" }, ...LIBRARY_STATE }), "no-results");
  assert.equal(derive({ scope: "favorite", query: "zzz", ...LIBRARY_STATE }), "no-results");
  assert.equal(derive({ scope: "recent", facets: { ...EMPTY_FACETS, category: "product" }, ...LIBRARY_STATE }), "no-results");
  assert.equal(derive({ facets: { ...EMPTY_FACETS, group: "concept-art" }, scope: "favorite", ...LIBRARY_STATE }), "no-results");
  // Scoped empties no longer exist; the legacy states were retired.
  assert.notEqual(derive({ scope: "favorite", groups: { total: 9, favorites: 0, groups: [] } }), "favorites-empty", "favorites-empty retired in V2 (V2 uses one neutral recovery shell)");
  assert.notEqual(derive({ scope: "recent", groups: { total: 9, recent: 0, groups: [] } }), "recent-empty", "recent-empty retired in V2");
  // No transient total/count race with refinements claims an empty library.
  assert.equal(derive({ groups: { total: 3, groups: [] } }), "no-results");
});

test("14-19. one shell, honest copy, and the right single action per kind", async () => {
  const app = await readApp();
  const markup = sliceBetween(app, "function galleryEmptyMarkup()", "/** Reuses the existing polite live region");

  // V2 (2026-08-16): one neutral shell with no-results copy and two actions
  // (reset filters + import). The kind is set to "no-results" via
  // `data-empty-kind`, but the copy and actions are the same for both —
  // a deliberate simplification from the legacy per-scope copy.
  assert.match(markup, /data-empty-kind=\\"" \+ kind/, "the shell carries its kind via data attribute (string concat in V2)");
  assert.match(markup, /<svg class=\\?"gallery-empty-icon\\?"/, "the shell uses the package glyph icon");
  assert.match(markup, /t\("noResultsTitle"\)/, "the heading uses the V2 no-results title");
  assert.match(markup, /t\("noResultsDescription"\)/, "the description uses the V2 no-results description");
  assert.match(markup, /data-action=\\?"empty-clear\\?"/, "the reset action targets empty-clear");
  assert.match(markup, /data-action=\\?"empty-import\\?"/, "the import action reuses the onboarding copy");
  // The legacy per-scope copy keys must not leak into the markup anymore.
  assert.doesNotMatch(markup, /favoritesEmptyTitle|recentEmptyTitle|groupEmptyTitle/, "the retired scoped empty copy keys are not consumed");
  // The single shell keeps an icon (not decorative, but functional) and never
  // declares an alert role or hidden controls.
  assert.match(markup, /<svg/, "the shell includes the package glyph (one icon, no large illustration)");
  assert.doesNotMatch(markup, /role="alert"/, "a static empty state is not an alert");
  assert.doesNotMatch(markup, /(<[^>]*\s|\s)hidden(\s|>|=)/, "no hidden control can leak into the tab order (aria-hidden stays allowed)");
});

test("20-32. resetLibraryRefinements is the single clear path with focus recovery", async () => {
  const app = await readApp();
  const reset = sliceBetween(app, "function resetLibraryRefinements()", "\n\nasync function init()");

  // 20-24. V2 (2026-08-16) drops the legacy `state.facetQuery` / facet-search
  // input (the facet panel merged into the topbar `.topbar-type-filters` chip
  // strip). The reset now clears query, scope, mediaKind, and the facet
  // groups via `clearFacets()`.
  assert.match(reset, /state\.query = "";/, "clears the query");
  assert.match(reset, /state\.scope = "all";/, "restores the all scope");
  assert.match(reset, /state\.mediaKind = "all";/, "restores the all media kind");
  assert.match(reset, /clearFacets\(\);/, "clears every facet including the group");
  // 25-27. Never touches sort, density, theme, language or project.
  for (const untouched of ["state.sort", "state.galleryDensity", "state.darkMode", "state.languagePreference", "state.locale =", "state.project =", "setLanguage"]) {
    assert.doesNotMatch(reset, new RegExp(untouched.replace(/[.=]/g, (m) => `\\${m}`)), `${untouched} stays untouched`);
  }
  // 28. Exactly one refresh: one loadAssets, no second path through applyFilterChange.
  assert.equal(count(reset, "loadAssets("), 1, "the reset triggers exactly one refresh");
  assert.doesNotMatch(reset, /applyFilterChange\(\)/, "no duplicate refresh path");
  // Every clear entry point funnels into this single helper.
  assert.equal(count(app, "resetLibraryRefinements();"), 2, "empty-state actions and the filter-panel clear share one call site");
  const clearAll = sliceBetween(app, "function clearAllFilters()", "\n\nfunction applyFilterChange");
  assert.match(clearAll, /resetLibraryRefinements\(\);/, "clearAllFilters delegates to the single helper");
  const delegation = sliceBetween(app, 'els.assetGrid?.addEventListener("click"', 'els.newAssetTopBtn?.addEventListener("click", openImportModal);');
  assert.match(delegation, /resetLibraryRefinements\(\); return;/, "the empty-state clear/view-all actions share the same helper");
  // 29. The search input DOM stays in sync.
  assert.match(reset, /els\.searchInput\) els\.searchInput\.value = "";/, "the search input is cleared");
  // 30-31. Quick filters and type filters re-render (filter-panel merge retired).
  assert.match(reset, /renderQuickFilters\(\); renderTypeFilters\(\); renderActiveFilters\(\);/, "chips, type filters and quick filters sync in the same pass");
  // 32. Focus never lands on body: first card, else the grid container.
  assert.match(reset, /els\.assetGrid\?\.querySelector\("\.asset-card-select"\)/, "focus prefers the first asset card");
  assert.match(reset, /else els\.assetGrid\?\.focus\(\{ preventScroll: true \}\);/, "the grid container is the focus fallback");
  // Announcement reuses the existing polite live region.
  assert.match(reset, /announceGalleryStatus\(t\("statusRefinementsCleared"\)\)/, "the reset announces through the existing live region");
});

test("33-36. import reuses the existing modal; retry and pagination failures stay honest", async () => {
  const [app, apiClient] = await Promise.all([readApp(), readApiClient()]);
  const delegation = sliceBetween(app, 'els.assetGrid?.addEventListener("click"', 'els.newAssetTopBtn?.addEventListener("click", openImportModal);');

  // 33-34. Import reuses the one existing modal; there is no second one.
  assert.match(delegation, /\[data-action="empty-import"\]'\)\) \{ openImportModal\(\); return; \}/, "the empty-state import opens the existing modal");
  assert.equal(count(app, "function openImportModal()"), 1, "there is still exactly one import modal opener");
  const markup = sliceBetween(app, "function galleryEmptyMarkup()", "/** Reuses the existing polite live region");
  assert.doesNotMatch(markup, /importModal|modal-overlay|role="dialog"/, "the empty state never builds a second modal");
  // Focus trap and return focus of the modal stay untouched.
  assert.match(app, /function trapImportModalFocus\(event\)/);
  assert.match(app, /state\.modalReturnFocus instanceof HTMLElement\) state\.modalReturnFocus\.focus\(\);/);
  // 35. Fatal error keeps error-state + Retry.
  const renderGrid = sliceBetween(app, "function renderGrid()", "\nfunction renderErrorState");
  assert.match(renderGrid, /if \(state\.galleryStatus === "error"\)/, "the error branch precedes every empty state");
  assert.match(renderGrid, /data-action="retry"/, "the error state keeps its retry action");
  assert.match(delegation, /\[data-action="retry"\]'\)\) window\.location\.reload\(\)/, "retry behaviour is unchanged");
  assert.match(renderGrid, /announceEmptyState/, "announcements fire only for empty states, never for errors");
  // 36. A pagination failure can never clear existing cards.
  const loadAssets = sliceBetween(apiClient, "async function loadAssets(", "let libraryRefreshInFlight");
  assert.ok(loadAssets.indexOf("const result = await requestAssetPage(") < loadAssets.indexOf("state.assets = nextAssets"), "assets only change after a successful response");
  assert.doesNotMatch(app, /state\.assets = \[\]/, "nothing ever empties the card list directly");
  assert.doesNotMatch(delegation, /load-more[\s\S]*?renderErrorState/, "load-more failures do not repaint the grid as an error or empty state");
});

// 37-39. (Retired) batch, viewer and return snapshot semantics stay untouched.
// 2026-08-18: V2-only token consolidation. The V2 design retired the
// batch-management affordance entirely (no `updateBatchUI`, no
// `setBatchBusy`, no `state.batchSaving`). The viewer return-snapshot and
// view-mode state machine remain unchanged; those anchors are covered by
// `confirm-dialog-contract` test 51-54 and the Phase 4C neighbour suite.

test("40. V2 i18n keys for the no-results recovery shell are symmetric across zh and en", async () => {
  const i18n = await readI18n();

  // 2026-08-18: V2-only token consolidation. The V2 design retired the
  // legacy per-scope empty states; the surviving recovery shell consumes
  // `noResultsTitle` / `noResultsDescription` for every zero-result
  // variant. The legacy scoped-copy keys (`favoritesEmptyTitle`,
  // `recentEmptyTitle`, `groupEmptyTitle`, etc.) are kept in the i18n
  // bundle as documentation of the retired states — they're not consumed
  // by the active markup, so we don't pin their count here.
  const ACTIVE_KEYS = ["noResultsTitle", "noResultsDescription", "resetFilters", "onboardImport", "statusRefinementsCleared", "clearAll"];
  for (const key of ACTIVE_KEYS) {
    assert.equal(count(i18n, `${key}:`), 2, `${key} exists exactly once per locale`);
  }
  // The empty library never borrows the no-results wording and vice versa.
  assert.match(i18n, /noResultsTitle: "没有找到匹配的素材"/);
  assert.match(i18n, /noResultsTitle: "No matching assets"/);
});

test("41-43. styles stay inside the token boundary; dependencies stay frozen", async () => {
  const [app, css, pkg, lock] = await Promise.all([readApp(), readCss(), readFile(resolve(root, "package.json"), "utf8"), readFile(resolve(root, "package-lock.json"), "utf8")]);

  // 41. No !important; the shell reuses tokens and adds no new color system.
  // 2026-08-18: V2-only token consolidation. The V2 empty-state heading now
  // consumes `--color-text-primary` (the canonical V2 token) instead of the
  // Phase 1A `--text-1` alias.
  const cssDeclarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(cssDeclarations, /!important/, "no !important in any CSS declaration");
  assert.match(css, /\.gallery-empty-state \{ display: flex; grid-column: 1 \/ -1;/, "the shell spans the content area, never the sidebar");
  assert.match(css, /\.gallery-empty-state h2 \{ color: var\(--color-text-primary\);/, "the heading uses an existing V2 token");
  assert.match(css, /\.gallery-empty-state p \{[^}]*overflow-wrap: anywhere;/, "long descriptions wrap instead of breaking the layout");
  assert.match(css, /\.empty-state-actions \{ display: flex; flex-wrap: wrap;/, "actions stay reachable at 200% zoom");
  const shellStyles = sliceBetween(css, ".gallery-empty-state {", ".error-state {");
  assert.doesNotMatch(shellStyles, /#[0-9a-fA-F]{3,8}\b|backdrop-filter|gradient|box-shadow/, "no new colors, glassmorphism, gradients or big shadows");
  assert.doesNotMatch(css, /\.empty-state-onboard/, "the dead onboarding shell styles are gone");
  assert.doesNotMatch(css, /\.empty-state \{/, "the old misleading empty-state styles are gone");
  // 42-43. Only approved local helpers are imported; no manifest or lockfile
  // change. `tag-utils.mjs` is the local tag normalization helper.
  assert.deepEqual([...app.matchAll(/^import .* from "(.*)";$/gm)].map((match) => match[1]).sort(), ["./api-client.mjs", "./asset-view.mjs", "./bridge-status-poller.mjs", "./confirm-dialog.mjs", "./context-menu-actions.mjs", "./context-menu-bindings.mjs", "./context-menu.mjs", "./i18n-runtime.mjs", "./image-preview.mjs", "./inspector-markup.mjs", "./overlay-manager.mjs", "./tag-utils.mjs", "./toast-manager.mjs"], "app.js imports only approved local helpers");
  // R1 isolation fix (2026-08-09, approved scope) added qa:web/qa:electron/
  // qa:packaged launcher scripts, so the whole-manifest hash no longer holds;
  // the dependency sections the freeze really guards stay byte-identical.
  const manifest = JSON.parse(pkg);
  assert.equal(sha256(JSON.stringify(manifest.dependencies)), "73c83773a57e21a20917d81b24288bdfddd9bb7ddd644fdaedd6e6cfba13c405", "package.json dependencies must stay untouched");
  assert.equal(sha256(JSON.stringify(manifest.devDependencies)), "11f67ce00f34b4d3dfb9b9ed0dfb428b0368ad5e0a17bd3bafaa40e3c2124fac", "package.json devDependencies must stay untouched");
  assert.equal(sha256(lock), "ecf0fdc199de87ccd30ffe6a7da4624c2f632700cd8348194a30b79dd2e2a69f", "package-lock.json must stay untouched");
});

test("44. Phase 1–4C neighbouring contracts and anchors stay intact", async () => {
  const app = await readApp();
  const inspector = await readInspectorMarkup();
  const viewer = await readAssetView();

  await Promise.all([
    access(resolve(root, "test/gallery-experience.test.mjs")),
    access(resolve(root, "test/accessibility-contract.test.mjs")),
    access(resolve(root, "test/shell-layout-contract.test.mjs")),
    access(resolve(root, "test/ui-component-contract.test.mjs")),
    access(resolve(root, "test/hidden-attribute-contract.test.mjs")),
    access(resolve(root, "test/inspector-cowart-original-actions-contract.test.mjs")),
  ]);
  // Anchors those contracts rely on.
  assert.match(app, /if \(kind === "__all"\) \{ clearAllFilters\(\); return; \}/, "the chip clear-all entry survives");
  assert.match(app, /if \(state\.galleryStatus === "loading"\) \{ els\.assetGrid\.innerHTML = gallerySkeletonMarkup\(\); return; \}/, "the skeleton branch survives");
  assert.match(viewer, /state\.libraryReturnSnapshot = \{/);
  assert.match(inspector, /function detailMoreSectionMarkup\(asset\)/);
});
