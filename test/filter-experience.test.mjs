import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

const readApp = () => readFile(resolve(root, "app/app.js"), "utf8");
const readHtml = () => readFile(resolve(root, "app/index.html"), "utf8");
const readCss = () => readFile(resolve(root, "app/styles.css"), "utf8");

/**
 * `humanizeFacetValue` is a pure rule that decides which stored names get
 * reworded, so it is worth exercising directly rather than pattern-matching its
 * source. The gallery module cannot be imported under Node (it touches
 * `document` at load), so the declaration is lifted out and evaluated alone.
 */
async function loadHumanizer() {
  const app = await readApp();
  const start = app.indexOf("function humanizeFacetValue");
  assert.ok(start > -1, "humanizeFacetValue is missing");
  const end = app.indexOf("\n}\n", start);
  assert.ok(end > -1, "humanizeFacetValue is not brace-terminated as expected");
  const source = app.slice(start, end + 2);
  return new Function(`${source}; return humanizeFacetValue;`)();
}

test("renders machine facet names readably without touching authored names", async () => {
  const humanize = await loadHumanizer();

  assert.equal(humanize("black-white-minimal-concept"), "Black White Minimal Concept");
  assert.equal(humanize("retro_diffuse_gradient"), "Retro Diffuse Gradient");
  assert.equal(humanize("contact-sheet"), "Contact Sheet");

  // Hand-written names must survive verbatim: rewording them would misrepresent
  // what is stored and break recognition of the user's own collections.
  assert.equal(humanize("灵感参考"), "灵感参考");
  assert.equal(humanize("KEEP IT WOO · 21 Styles V1"), "KEEP IT WOO · 21 Styles V1");
  assert.equal(humanize("concept"), "concept");
  assert.equal(humanize("Already Titled"), "Already Titled");
  assert.equal(humanize(""), "");
  assert.equal(humanize(undefined), "");
});

test("keeps facets combinable instead of replacing one another", async () => {
  const app = await readApp();

  assert.match(app, /const FACET_KEYS = \["source", "group", "category", "style"\]/);
  assert.match(app, /function toggleFacet\(key, value\) \{\s*state\.facets\[key\] = state\.facets\[key\] === value \? "" : value;/);
  // Every facet travels on the request, so choosing a style cannot drop a source.
  assert.match(app, /for \(const key of FACET_KEYS\) \{\s*if \(request\.facets\[key\]\) params\.set\(key, request\.facets\[key\]\);/);
  // The request key covers all dimensions, so a stale response cannot overwrite a newer one.
  assert.match(app, /JSON\.stringify\(\[request\.project, request\.query, request\.scope, \.\.\.FACET_KEYS\.map\(\(key\) => request\.facets\[key\] \|\| ""\), request\.sort\]\)/);
  assert.match(app, /scope: "all", facets: \{ source: "", group: "", category: "", style: "" \}/);
});

test("resolves sort server-side and restarts paging when it changes", async () => {
  const [app, html] = await Promise.all([readApp(), readHtml()]);

  assert.match(html, /<select id="sortSelect">/);
  for (const [value, key] of [["newest", "sortNewest"], ["oldest", "sortOldest"], ["name", "sortName"]]) {
    assert.match(html, new RegExp(`<option value="${value}" data-i18n="${key}"`));
  }
  assert.match(app, /params\.set\("sort", request\.sort\)/);
  // A cursor belongs to the order that issued it, so switching sort must drop it.
  assert.match(app, /state\.sort = normalizeSort\(els\.sortSelect\.value\);[\s\S]{0,320}state\.nextCursor = null;/);
  assert.match(app, /const SORT_ORDERS = \["newest", "oldest", "name"\]/);
  assert.match(app, /safeStorageSet\("mosa\.asset-sort", state\.sort\)/);
  // Any filter change also restarts paging rather than resuming a stale cursor.
  assert.match(app, /function applyFilterChange\(\) \{\s*\/\/[^\n]*\n\s*state\.nextCursor = null;/);
});

test("surfaces the active query as removable chips with a clear-all", async () => {
  const [app, html, css] = await Promise.all([readApp(), readHtml(), readCss()]);

  // The chips live under the workspace bar, not inside it: competing with the
  // filter/sort/import controls pushed them off-screen at the 960px minimum.
  assert.match(html, /class="active-filters" id="activeFilters"/);
  assert.doesNotMatch(html, /class="topbar-left">[\s\S]*?id="activeFilters"[\s\S]*?<\/div><div class="topbar-right"/);
  assert.match(app, /function activeFilterChips\(\)/);
  assert.match(app, /function removeFilterChip\(kind\)/);
  // Each chip clears exactly its own dimension.
  assert.match(app, /if \(kind === "query"\) \{ state\.query = ""/);
  assert.match(app, /else if \(kind === "scope"\) state\.scope = "all";/);
  assert.match(app, /else if \(FACET_KEYS\.includes\(kind\)\) state\.facets\[kind\] = "";/);
  assert.match(app, /if \(kind === "__all"\) \{ clearAllFilters\(\); return; \}/);
  assert.match(app, /class="filter-chip-clear"/);
  assert.match(app, /t\("removeFilter", \{ label: readable \}\)/);
  assert.match(css, /\.filter-chip \{/);
  assert.match(css, /\.filter-chip-clear \{/);
  // A wrapping chip row grew the 960px workspace bar to a quarter of the viewport,
  // so the chips scroll on one line while clear-all stays pinned.
  assert.match(app, /class="filter-chip-strip"/);
  assert.match(css, /\.filter-chip-strip \{[^}]*overflow-x: auto/);
  assert.match(css, /\.filter-chip-clear \{[^}]*flex: 0 0 auto/);
  assert.doesNotMatch(css, /\.active-filters \{[^}]*flex-wrap: wrap/);
});

test("makes long facet lists searchable and honest about truncation", async () => {
  const [app, html, css] = await Promise.all([readApp(), readHtml(), readCss()]);

  assert.match(html, /id="facetSearchInput"/);
  assert.match(html, /data-i18n-placeholder="facetSearch"/);
  assert.match(app, /function matchesFacetQuery\(name\)/);
  // Searching has to match both the stored slug and the name actually rendered.
  assert.match(app, /String\(name\)\.toLowerCase\(\)\.includes\(needle\) \|\| humanizeFacetValue\(name\)\.toLowerCase\(\)\.includes\(needle\)/);
  assert.match(app, /function renderFacetTruncationHint\(\)/);
  assert.match(app, /t\("facetTruncated", \{ shown, total \}\)/);
  // Head and search stay visible while only the facet lists scroll.
  assert.match(html, /class="filter-panel-body"/);
  assert.match(css, /\.filter-panel-body \{[^}]*overflow: auto/);
  assert.match(css, /\.filter-panel-search \{[^}]*flex: 0 0 auto/);
  assert.match(css, /\.filter-panel-search input \{[^}]*min-height: 36px/);
});

test("stops the sidebar and filter panel from duplicating the collection list", async () => {
  const app = await readApp();

  assert.match(app, /const SIDEBAR_GROUP_LIMIT = 5/);
  assert.match(app, /const shown = all\.slice\(0, SIDEBAR_GROUP_LIMIT\)/);
  assert.match(app, /data-action="open-all-groups"/);
  assert.match(app, /t\("allGroups", \{ count: all\.length \}\)/);
  // The overflow entry opens the panel that owns the full list and focuses its search.
  assert.match(app, /if \(els\.filterPanel\?\.hidden\) togglePanel\(els\.filterPanel, els\.filterToggle\)/);
  // Without this the document-level outside-click handler closes the panel again,
  // and an animation-frame focus never runs while the window is hidden.
  assert.match(app, /open-all-groups"\]'\)\) \{[\s\S]{0,400}event\.stopPropagation\(\);[\s\S]{0,400}els\.facetSearchInput\?\.focus\(\);/);
});

test("shows how many filters are active on the filter toggle", async () => {
  const [app, css] = await Promise.all([readApp(), readCss()]);

  assert.match(app, /const facetCount = FACET_KEYS\.filter\(\(key\) => state\.facets\[key\]\)\.length/);
  assert.match(app, /els\.filterDot\.textContent = facetCount \? String\(facetCount\) : ""/);
  assert.match(app, /els\.filterToggle\?\.setAttribute\("aria-pressed", String\(facetCount > 0\)\)/);
  assert.match(css, /\.filter-dot \{[^}]*font-variant-numeric: tabular-nums/);
});

test("translates every new filter and sort string in both locales", async () => {
  const app = await readApp();
  const keys = [
    "sortLabel", "sortNewest", "sortOldest", "sortName",
    "facetSearch", "facetNoMatch", "activeFilters", "clearAll", "removeFilter",
    "chipSearch", "chipSource", "chipGroup", "chipCategory", "chipStyle", "chipScope", "chipSeparator",
    "allGroups", "facetTruncated",
  ];
  const zhBlocks = [...app.matchAll(/Object\.assign\(translations\.zh, \{([\s\S]*?)\n\}\);/g)].map((match) => match[1]).join("\n");
  const enBlocks = [...app.matchAll(/Object\.assign\(translations\.en, \{([\s\S]*?)\n\}\);/g)].map((match) => match[1]).join("\n");
  for (const key of keys) {
    assert.match(zhBlocks, new RegExp(`\\b${key}:`), `zh translation missing for ${key}`);
    assert.match(enBlocks, new RegExp(`\\b${key}:`), `en translation missing for ${key}`);
  }
});
