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
const readApp = () => readFile(resolve(root, "app/app.js"), "utf8");
const readCss = () => readFile(resolve(root, "app/styles.css"), "utf8");
const readI18n = () => readFile(resolve(root, "app/i18n.mjs"), "utf8");

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

test("01-06. centralized helper decides; loading/error/cards precede; only a true zero total is library-empty", async () => {
  const app = await readApp();
  const derive = makeDerive(app);

  // 1. renderGrid routes every zero result through the centralized helper.
  const renderGrid = sliceBetween(app, "function renderGrid()", "\nfunction renderErrorState");
  assert.match(renderGrid, /els\.assetGrid\.innerHTML = galleryEmptyMarkup\(\);/, "the empty branch renders through the shared markup builder");
  assert.match(app, /function galleryEmptyMarkup\(\)[\s\S]*?deriveGalleryEmptyState\(\)/, "the markup builder asks the centralized helper");
  // 2. The decision never depends on assets.length alone.
  const helper = sliceBetween(app, "function deriveGalleryEmptyState()", "/** One shell for every empty state");
  for (const signal of ["state.groups.total", "state.query", "state.facets", "state.scope"]) {
    assert.match(helper, new RegExp(signal.replace(/\./g, "\\.")), `the helper reads ${signal}`);
  }
  assert.doesNotMatch(helper, /state\.pageTotal/, "the current result total never impersonates the library total");
  assert.doesNotMatch(helper, /fetch\(|api\(/, "the helper never sends a request");
  // Old misleading one-size-fits-all copy is gone from the grid.
  assert.doesNotMatch(renderGrid, /t\("noAssets"\)/, "the grid no longer paints the generic empty-library copy");

  // 3. loading precedes empty. 4. error precedes empty. 5. cards mean no empty.
  assert.equal(derive({ galleryStatus: "loading", groups: { total: 0, groups: [] } }), "none");
  assert.equal(derive({ galleryStatus: "error", groups: { total: 0, groups: [] } }), "none");
  assert.equal(derive({ assets: [{ id: "a" }], ...LIBRARY_STATE }), "none");
  assert.ok(helper.indexOf('galleryStatus === "loading"') < helper.indexOf("state.assets.length"), "loading guard precedes the card guard");
  assert.ok(helper.indexOf('galleryStatus === "error"') < helper.indexOf("state.assets.length"), "error guard precedes the card guard");

  // 6. Only an authoritative whole-library total of 0 is library-empty.
  assert.equal(derive({ groups: { total: 0, groups: [] } }), "library-empty");
  assert.equal(derive({ query: "anything", groups: { total: 0, groups: [] } }), "library-empty", "a truly empty library wins over any refinement");
  assert.equal(derive({ groups: { total: 1, groups: [] } }), "no-results", "a nonzero total can never be reported as an empty library");
});

test("07-13. query, facet, combined, scope and group empties are distinct kinds", async () => {
  const app = await readApp();
  const derive = makeDerive(app);

  // 7. query miss. 8. facet miss. 9. query+facet miss.
  assert.equal(derive({ query: "zzz", ...LIBRARY_STATE }), "no-results");
  assert.equal(derive({ facets: { ...EMPTY_FACETS, source: "codex-generated" }, ...LIBRARY_STATE }), "no-results");
  assert.equal(derive({ query: "zzz", facets: { ...EMPTY_FACETS, style: "cyberpunk" }, ...LIBRARY_STATE }), "no-results");
  // 10. scope+query (and scope+facet, group+anything) prefer no-results.
  assert.equal(derive({ scope: "favorite", query: "zzz", ...LIBRARY_STATE }), "no-results");
  assert.equal(derive({ scope: "recent", facets: { ...EMPTY_FACETS, category: "product" }, ...LIBRARY_STATE }), "no-results");
  assert.equal(derive({ facets: { ...EMPTY_FACETS, group: "concept-art" }, scope: "favorite", ...LIBRARY_STATE }), "no-results");
  // 11. favorites empty. 12. recent empty.
  assert.equal(derive({ scope: "favorite", groups: { total: 9, favorites: 0, groups: [] } }), "favorites-empty");
  assert.equal(derive({ scope: "recent", groups: { total: 9, recent: 0, groups: [] } }), "recent-empty");
  // 13. group empty — only for an existing group with no other refinement.
  assert.equal(derive({ facets: { ...EMPTY_FACETS, group: "concept-art" }, ...LIBRARY_STATE }), "group-empty");
  assert.equal(derive({ facets: { ...EMPTY_FACETS, group: "deleted-group" }, ...LIBRARY_STATE }), "no-results", "a vanished group falls back to no-results");
  // Priority order inside the helper: refinements beat scoped empties.
  const helper = sliceBetween(app, "function deriveGalleryEmptyState()", "/** One shell for every empty state");
  assert.ok(helper.indexOf('return "no-results";') < helper.indexOf('"favorites-empty"'), "no-results is decided before any scoped empty");
  // A transient total/count race with zero refinements never claims an empty library.
  assert.equal(derive({ groups: { total: 3, groups: [] } }), "no-results");
});

test("14-19. one shell, honest copy, and the right single action per kind", async () => {
  const app = await readApp();
  const markup = sliceBetween(app, "function galleryEmptyMarkup()", "/** Reuses the existing polite live region");

  // Single shared shell, kind expressed through data-empty-kind only.
  assert.equal(count(markup, 'class="gallery-empty-state" data-empty-kind="${kind}"'), 1, "one shell serves every kind");
  assert.equal(count(markup, "<h2"), 1, "one heading per state, not five duplicated DOM trees");
  // 14. Long group names are escaped dynamic parameters and stay reachable.
  assert.match(markup, /t\("groupEmptyDescription", \{ name: groupName \}\)/, "the group name is a dynamic parameter");
  assert.match(markup, /escapeHtml\(title\)/, "titles are escaped");
  assert.match(markup, /escapeHtml\(description\)/, "descriptions are escaped");
  assert.match(markup, /title="\$\{escapeHtml\(state\.facets\.group\)\}"/, "the full raw group name stays accessible via title");
  // No decorative large illustration, no alert role, no hidden controls in the shell.
  assert.doesNotMatch(markup, /<svg/, "no decorative illustration in the empty state");
  assert.doesNotMatch(markup, /role="alert"/, "a static empty state is not an alert");
  assert.doesNotMatch(markup, /hidden/, "no hidden control can leak into the tab order");

  const libraryBranch = sliceBetween(markup, 'if (kind === "library-empty")', '} else if (kind === "no-results")');
  const resultsBranch = sliceBetween(markup, '} else if (kind === "no-results")', '} else if (kind === "favorites-empty")');
  // 15. A true empty library shows Import. 16. It never shows clear-refinements.
  assert.match(libraryBranch, /btn-primary" type="button" data-action="empty-import"/, "library-empty has the import primary action");
  assert.match(libraryBranch, /data-action="empty-open-library"/, "the existing open-library entry is offered as secondary");
  assert.doesNotMatch(libraryBranch, /empty-clear/, "library-empty never offers clear-refinements");
  // 17. no-results has no import primary. 18. It offers clear-refinements (secondary).
  assert.doesNotMatch(resultsBranch, /btn-primary|empty-import/, "no-results shows no import primary");
  assert.match(resultsBranch, /btn-secondary" type="button" data-action="empty-clear"/, "no-results offers clear-refinements");
  // 19. Scoped empties offer view-all; library-empty and no-results do not.
  for (const kind of ["favorites-empty", "recent-empty", "group-empty"]) {
    const branch = sliceBetween(markup, `} else if (kind === "${kind}")`, kind === "group-empty" ? "}\n  // The group name travels" : "} else if");
    assert.match(branch, /data-action="empty-view-all"/, `${kind} offers view-all`);
  }
  assert.doesNotMatch(libraryBranch, /empty-view-all/);
  assert.doesNotMatch(resultsBranch, /empty-view-all/);
  // recent copy describes the real 7-day creation window, not “recently viewed”.
  assert.match(markup, /t\("recentEmptyDescription"\)/);
});

test("20-32. resetLibraryRefinements is the single clear path with focus recovery", async () => {
  const app = await readApp();
  const reset = sliceBetween(app, "function resetLibraryRefinements()", "\n\ninit();");

  // 20-24. Clears query, facets, facetQuery, scope and the group facet.
  assert.match(reset, /state\.query = "";/, "clears the query");
  assert.match(reset, /state\.facetQuery = "";/, "clears the facet search");
  assert.match(reset, /state\.scope = "all";/, "restores the all scope");
  assert.match(reset, /clearFacets\(\);/, "clears every facet including the group");
  // 25-27. Never touches sort, density, theme, language or project.
  for (const untouched of ["state.sort", "state.galleryDensity", "state.darkMode", "state.languagePreference", "state.locale =", "state.project =", "setLanguage"]) {
    assert.doesNotMatch(reset, new RegExp(untouched.replace(/[.=]/g, (m) => `\\${m}`)), `${untouched} stays untouched`);
  }
  // 28. Exactly one refresh: one loadAssets, no second path through applyFilterChange.
  assert.equal(count(reset, "loadAssets("), 1, "the reset triggers exactly one refresh");
  assert.doesNotMatch(reset, /applyFilterChange\(\)/, "no duplicate refresh path");
  // Every clear entry point funnels into this single helper (the comment on
  // the section header and the definition itself are not call sites).
  assert.equal(count(app, "resetLibraryRefinements();"), 2, "empty-state actions and the filter-panel clear share one call site");
  const clearAll = sliceBetween(app, "function clearAllFilters()", "\n\nfunction applyFilterChange");
  assert.match(clearAll, /resetLibraryRefinements\(\);/, "clearAllFilters delegates to the single helper");
  const delegation = sliceBetween(app, 'els.assetGrid?.addEventListener("click"', 'els.newAssetTopBtn?.addEventListener("click", openImportModal);');
  assert.match(delegation, /resetLibraryRefinements\(\); return;/, "the empty-state clear/view-all actions share the same helper");
  // 29. The search input DOM stays in sync.
  assert.match(reset, /els\.searchInput\) els\.searchInput\.value = "";/, "the search input is cleared");
  assert.match(reset, /els\.facetSearchInput\) els\.facetSearchInput\.value = "";/, "the facet search input is cleared");
  // 30-31. Chips, quick filters and the filter panel re-render.
  assert.match(reset, /renderQuickFilters\(\); renderFilterPanel\(\); renderActiveFilters\(\);/, "chips and quick filters sync in the same pass");
  // 32. Focus never lands on body: first card, else the grid container.
  assert.match(reset, /els\.assetGrid\?\.querySelector\("\.asset-card-select"\)/, "focus prefers the first asset card");
  assert.match(reset, /else els\.assetGrid\?\.focus\(\{ preventScroll: true \}\);/, "the grid container is the focus fallback");
  // Announcement reuses the existing polite live region.
  assert.match(reset, /announceGalleryStatus\(t\("statusRefinementsCleared"\)\)/, "the reset announces through the existing live region");
});

test("33-36. import reuses the existing modal; retry and pagination failures stay honest", async () => {
  const app = await readApp();
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
  const loadAssets = sliceBetween(app, "async function loadAssets(", "let libraryRefreshInFlight");
  assert.ok(loadAssets.indexOf("const result = await requestAssetPage(") < loadAssets.indexOf("state.assets = nextAssets"), "assets only change after a successful response");
  assert.doesNotMatch(app, /state\.assets = \[\]/, "nothing ever empties the card list directly");
  assert.doesNotMatch(delegation, /load-more[\s\S]*?renderErrorState/, "load-more failures do not repaint the grid as an error or empty state");
});

test("37-39. batch, viewer and return snapshot semantics stay untouched", async () => {
  const app = await readApp();

  // 37. Zero results leave no operable dangerous batch action.
  const batchUi = sliceBetween(app, "function updateBatchUI()", "\nfunction setBatchBusy");
  assert.match(batchUi, /els\.batchSelectAll\.disabled = state\.batchSaving \|\| state\.assets\.length === 0;/, "select-all is disabled with zero results");
  assert.match(batchUi, /button\.disabled = state\.batchSaving \|\| \(button !== els\.batchCancel && selectedCount === 0\)/, "favorite/archive need a real selection; cancel stays the safe exit");
  // 38. Return snapshot structure is untouched.
  assert.match(app, /state\.libraryReturnSnapshot = \{\n\s+scrollTop: getLibraryScrollContainer\(\)\.scrollTop,/, "the return snapshot keeps its fields");
  assert.match(app, /requestKey: assetRequestKey\(currentAssetRequest\(\)\)/);
  // 39. The viewer state machine is untouched.
  assert.match(app, /viewMode: "library", libraryReturnSnapshot: null/, "viewMode stays binary");
  assert.match(app, /assetViewSequence\.ids = state\.assets\.map\(\(asset\) => asset\.id\);/);
  assert.match(app, /function setViewMode\(/);
});

test("40. i18n keys are symmetric across zh and en and free of duplicate synonyms", async () => {
  const i18n = await readI18n();

  const NEW_KEYS = ["noResultsTitle", "noResultsDescription", "favoritesEmptyTitle", "favoritesEmptyDescription", "recentEmptyTitle", "recentEmptyDescription", "groupEmptyTitle", "groupEmptyDescription", "viewAllAssets", "statusLibraryEmpty", "statusScopeEmpty", "statusRefinementsCleared"];
  for (const key of NEW_KEYS) {
    assert.equal(count(i18n, `${key}:`), 2, `${key} exists exactly once per locale`);
  }
  // The true empty library reuses the onboarding copy instead of adding synonyms.
  for (const key of ["onboardTitle", "onboardHint", "onboardImport", "clearAll"]) {
    assert.equal(count(i18n, `${key}:`), 2, `${key} stays single-sourced`);
  }
  // The empty library never borrows the no-results wording and vice versa.
  assert.match(i18n, /noResultsTitle: "没有匹配的素材"/);
  assert.match(i18n, /noResultsTitle: "No matching assets"/);
  assert.match(i18n, /recentEmptyDescription: "最近 7 天内创建的素材会显示在这里。"/, "recent copy matches the real 7-day business window");
  assert.match(i18n, /groupEmptyDescription: .*\{name\}/, "the group name is a dynamic parameter");
});

test("41-43. styles stay inside the token boundary; dependencies stay frozen", async () => {
  const [app, css, pkg, lock] = await Promise.all([readApp(), readCss(), readFile(resolve(root, "package.json"), "utf8"), readFile(resolve(root, "package-lock.json"), "utf8")]);

  // 41. No !important; the shell reuses tokens and adds no new color system.
  const cssDeclarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(cssDeclarations, /!important/, "no !important in any CSS declaration");
  assert.match(css, /\.gallery-empty-state \{ display: flex; grid-column: 1 \/ -1;/, "the shell spans the content area, never the sidebar");
  assert.match(css, /\.gallery-empty-state h2 \{ color: var\(--text-1\);/, "the heading uses an existing token");
  assert.match(css, /\.gallery-empty-state p \{[^}]*overflow-wrap: anywhere;/, "long group names wrap instead of breaking the layout");
  assert.match(css, /\.empty-state-actions \{ display: flex; flex-wrap: wrap;/, "actions stay reachable at 200% zoom");
  const shellStyles = sliceBetween(css, ".gallery-empty-state {", ".error-state {");
  assert.doesNotMatch(shellStyles, /#[0-9a-fA-F]{3,8}\b|backdrop-filter|gradient|box-shadow/, "no new colors, glassmorphism, gradients or big shadows");
  assert.doesNotMatch(css, /\.empty-state-onboard/, "the dead onboarding shell styles are gone");
  assert.doesNotMatch(css, /\.empty-state \{/, "the old misleading empty-state styles are gone");
  // 42-43. No new imports, no manifest or lockfile change.
  assert.deepEqual([...app.matchAll(/^import .* from "(.*)";$/gm)].map((match) => match[1]).sort(), ["./bridge-status-poller.js", "./i18n.mjs"], "app.js gains no new imports");
  assert.equal(sha256(pkg), "e161974a477853703cc88724de39805fe5c65e590bd331060a17be6d087a2f24", "package.json must stay untouched");
  assert.equal(sha256(lock), "50a7d029b6aed62fd921ca013f00dba1b01d2ce96009792fb69c63207a04c8dd", "package-lock.json must stay untouched");
});

test("44. Phase 1–4C neighbouring contracts and anchors stay intact", async () => {
  const app = await readApp();

  await Promise.all([
    access(resolve(root, "test/filter-experience.test.mjs")),
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
  assert.match(app, /action-btn primary/, "the inspector primary button survives");
  assert.match(app, /state\.libraryReturnSnapshot = \{/);
  assert.match(app, /function detailMoreSectionMarkup\(asset\)/);
});
