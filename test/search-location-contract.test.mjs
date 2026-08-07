import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

// Phase 2A (D3 / F-05): the single global search input moves from the topbar back
// to the top of the left sidebar navigation. This suite locks the search location
// contract for both the wide sidebar and the compact rail (701–1120px, details open),
// and proves the search business semantics (events, state, algorithm, i18n) did not change.
// Node standard library only; no network access.

const root = resolve(import.meta.dirname, "..");
const readHtml = () => readFile(resolve(root, "app/index.html"), "utf8");
const readCss = () => readFile(resolve(root, "app/styles.css"), "utf8");
const readApp = () => readFile(resolve(root, "app/app.js"), "utf8");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Extracts a `{...}` block starting at the marker, honouring nested braces. */
function extractBlock(css, marker, fromIndex = 0) {
  const start = css.indexOf(marker, fromIndex);
  assert.ok(start > -1, `block not found: ${marker}`);
  let i = start + marker.length;
  let depth = 1;
  while (depth > 0 && i < css.length) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") depth -= 1;
    i += 1;
  }
  assert.equal(depth, 0, `unbalanced braces in block: ${marker}`);
  return { block: css.slice(start, i), start, end: i };
}

function sidebarBlock(html) {
  const start = html.indexOf('<aside class="sidebar"');
  const end = html.indexOf("</aside>", start);
  assert.ok(start > -1 && end > start, "sidebar aside must exist");
  return html.slice(start, end);
}

function topbarBlock(html) {
  const start = html.indexOf('<header class="topbar"');
  const end = html.indexOf("</header>", start);
  assert.ok(start > -1 && end > start, "topbar header must exist");
  return html.slice(start, end);
}

/** The compact-rail media block shared with the existing icon-rail rules. */
function compactRailMedia(css) {
  return extractBlock(css, "@media (min-width: 701px) and (max-width: 1120px) {").block;
}

// 1. Exactly one #searchInput exists in the page (no duplicate/synced inputs).
test("1. the page contains exactly one #searchInput", async () => {
  const html = await readHtml();
  assert.equal(html.split('id="searchInput"').length - 1, 1, "index.html must contain exactly one #searchInput");
  const app = await readApp();
  assert.equal(app.includes('id="searchInput"'), false, "app.js must not render a second search input");
});

// 2. The search input lives inside .sidebar.
test("2. #searchInput lives inside the .sidebar aside", async () => {
  const sidebar = sidebarBlock(await readHtml());
  assert.ok(sidebar.includes('id="searchInput"'), "#searchInput must be inside .sidebar");
});

// 3. Within the sidebar the search sits after the brand and before the primary nav.
test("3. search sits after .brand and before .primary-nav", async () => {
  const sidebar = sidebarBlock(await readHtml());
  const brand = sidebar.indexOf('class="brand"');
  const search = sidebar.indexOf('class="sidebar-search"');
  const nav = sidebar.indexOf('class="primary-nav"');
  assert.ok(brand > -1 && search > -1 && nav > -1, "brand, sidebar-search and primary-nav must all exist");
  assert.ok(brand < search && search < nav, "order must be brand → sidebar-search → primary-nav");
  const searchDiv = /<div class="sidebar-search">([\s\S]*?)<\/div>/.exec(sidebar);
  assert.ok(searchDiv, "sidebar-search container must exist");
  assert.ok(searchDiv[1].includes('id="searchInput"'), "the search input must be inside .sidebar-search");
});

// 4. The topbar no longer contains the search input.
test("4. the topbar no longer contains any search input", async () => {
  const topbar = topbarBlock(await readHtml());
  assert.equal(topbar.includes('id="searchInput"'), false, "#searchInput must not remain in the topbar");
  assert.equal(topbar.includes("sidebar-search"), false, "no search container may remain in the topbar");
});

// 5. .topbar-center leaves no empty shell behind (DOM and CSS both cleaned up).
test("5. .topbar-center leaves no empty shell", async () => {
  const html = await readHtml();
  assert.equal(html.includes("topbar-center"), false, "index.html must not keep .topbar-center");
  const css = await readCss();
  assert.equal(css.includes("topbar-center"), false, "styles.css must not keep .topbar-center rules");
  assert.equal(css.includes("topbar-search"), false, "styles.css must not keep .topbar-search rules");
  // The title area takes the freed space so the right-hand actions keep their row.
  // Phase 2B: .topbar-left was renamed to .topbar-context (semantic grouping, F-18).
  assert.match(css, /\.topbar-context \{[^}]*flex: 1 1 auto/, ".topbar-context must grow into the vacated space");
});

// 6. The input keeps type="search" (native clear button semantics).
test("6. #searchInput keeps type=\"search\"", async () => {
  const input = /<input id="searchInput"[^>]*>/.exec(await readHtml());
  assert.ok(input, "search input element must exist");
  assert.match(input[0], /type="search"/, "search input must keep type=\"search\"");
});

// 7. The input keeps an explicit accessible name (placeholder is not the only name).
test("7. #searchInput keeps an explicit accessible name", async () => {
  const input = /<input id="searchInput"[^>]*>/.exec(await readHtml());
  assert.match(input[0], /aria-label="搜索素材"/, "aria-label must be preserved");
  assert.match(input[0], /data-i18n-aria-label="searchPlaceholder"/, "i18n aria-label binding must be preserved");
  // The decorative magnifier is hidden from assistive technology.
  const searchDiv = /<div class="sidebar-search">([\s\S]*?)<\/div>/.exec(await readHtml());
  assert.match(searchDiv[1], /<svg class="sidebar-search-icon"[^>]*aria-hidden="true"/, "search icon must stay decorative (aria-hidden)");
});

// 8. The i18n placeholder binding and both locale strings survive.
test("8. i18n placeholder is preserved in both locales", async () => {
  const input = /<input id="searchInput"[^>]*>/.exec(await readHtml());
  assert.match(input[0], /data-i18n-placeholder="searchPlaceholder"/, "placeholder i18n binding must be preserved");
  assert.match(input[0], /placeholder="搜索素材、提示词或风格"/, "default zh placeholder must be preserved");
  const messages = (await import(resolve(root, "app/i18n.mjs"))).default;
  assert.equal(messages.zh.searchPlaceholder, "搜索素材、提示词或风格", "zh placeholder must stay unchanged");
  assert.equal(messages.en.searchPlaceholder, "Search assets, prompts, or styles", "en placeholder must stay unchanged");
});

// 9. The search event listener still binds to the same element ID.
test("9. the input event listener still binds #searchInput", async () => {
  const app = await readApp();
  assert.match(app, /searchInput: document\.querySelector\("#searchInput"\)/, "element lookup must keep the #searchInput ID");
  assert.match(app, /els\.searchInput\?\.addEventListener\("input", debounce\(async \(\) => \{ state\.query = els\.searchInput\.value;/,
    "the debounced input listener must stay bound to els.searchInput");
});

// 10. The search state field is unchanged (state.query, no new search state objects).
test("10. the search state field is unchanged", async () => {
  const app = await readApp();
  assert.match(app, /state\.query = els\.searchInput\.value/, "state.query remains the search state field");
  assert.doesNotMatch(app, /state\.search[A-Z]/, "no new search state fields may be introduced");
  assert.match(app, /if \(kind === "query"\) \{ state\.query = ""; if \(els\.searchInput\) els\.searchInput\.value = ""; \}/,
    "the query filter-chip clear path must stay intact");
});

// 11. The search algorithm is unchanged at the behaviour level. Phase 3A (D4 dedicated
//     asset view) added the view-mode exit hook inside the debounced handler and four new
//     i18n keys, so the byte-level hash lock is migrated to precise code-segment locks on
//     the unchanged pipeline (approved minimal migration; test file itself is not extended).
test("11. search algorithm, API and i18n behaviour stay locked", async () => {
  const app = await readApp();
  // Debounce and reload semantics stay wired the same way: same 180ms debounce, same
  // query → nextCursor reset → renderActiveFilters → loadAssets order (Phase 3A hook aside).
  assert.match(app, /debounce\(async \(\) => \{ state\.query = els\.searchInput\.value; state\.nextCursor = null;\s+\/\/ Phase 3A[^\n]*\n\s+if \(state\.viewMode === "asset"\) returnToLibrary\(\);\s+renderActiveFilters\(\); await loadAssets\(\); \}, 180\)/,
    "the 180ms debounced query → loadAssets pipeline must stay unchanged apart from the Phase 3A exit hook");
  // The request construction is untouched: same URL params, same paging contract.
  assert.match(app, /const params = new URLSearchParams\(\{ project: request\.project, q: request\.query \}\);/,
    "the /api/assets query construction must stay unchanged");
  assert.match(app, /params\.set\("limit", "100"\)/, "the page-size contract must stay unchanged");
  // The request identity helpers stay unchanged (the Phase 3A snapshot/restore logic keys off them).
  assert.match(app, /function currentAssetRequest\(\) \{\s+return \{ project: state\.project, query: state\.query, scope: state\.scope, facets: \{ \.\.\.state\.facets \}, sort: state\.sort \};/,
    "currentAssetRequest must stay unchanged");
  const i18n = await readFile(resolve(root, "app/i18n.mjs"), "utf8");
  // The search copy is unchanged in both locales (Phase 3A only appended new view-mode keys).
  assert.match(i18n, /searchPlaceholder: "搜索素材、提示词或风格"/, "zh search placeholder must stay unchanged");
  assert.match(i18n, /searchPlaceholder: "Search assets, prompts, or styles"/, "en search placeholder must stay unchanged");
});

// 12. Wide-sidebar search styles exist and consume control/surface/border tokens.
test("12. wide-sidebar search styles exist and consume design tokens", async () => {
  const css = await readCss();
  const { block } = extractBlock(css, ".sidebar-search {");
  assert.match(block, /height: var\(--control-sm\)/, "search container must consume the control-size token");
  assert.match(block, /background: var\(--color-surface\)/, "search container must consume the surface token");
  assert.match(block, /border: 1px solid var\(--color-border-subtle\)/, "search container must consume the border token");
  assert.match(block, /border-radius: var\(--radius-control\)/, "search container must consume the radius token");
  assert.match(css, /\.sidebar-search:focus-within \{[^}]*var\(--color-accent\)/, "focus must use the approved accent token");
  assert.match(css, /\.sidebar-search:focus-within \{[^}]*var\(--color-accent-ring\)/, "focus ring must use the accent-ring token");
});

// 13. Compact-rail search styles exist (icon entry in the 701–1120px details-open rail).
test("13. compact-rail search styles exist", async () => {
  const media = compactRailMedia(await readCss());
  assert.match(media, /\.shell\.details-open \.sidebar-search \{[^}]*width: 40px/, "compact entry must fit the 56px rail");
  assert.match(media, /\.shell\.details-open \.sidebar-search input \{[^}]*opacity: 0/, "collapsed input stays focusable as a transparent overlay");
});

// 14. The :focus-within expansion contract exists and overlays content via position:fixed.
test("14. the :focus-within expansion contract exists", async () => {
  const media = compactRailMedia(await readCss());
  const expanded = /\.shell\.details-open \.sidebar-search:focus-within \{([^}]*)\}/.exec(media);
  assert.ok(expanded, "the compact focus-within expansion rule must exist");
  assert.match(expanded[1], /position: fixed/, "the expanded panel must escape sidebar overflow clipping via position:fixed");
  assert.match(expanded[1], /width: 264px/, "the expanded panel must stay within the approved 240–280px width");
  const expandedInput = /\.shell\.details-open \.sidebar-search:focus-within input \{([^}]*)\}/.exec(media);
  assert.ok(expandedInput, "the expanded input rule must exist");
  assert.match(expandedInput[1], /opacity: 1/, "the same input must become visible while expanded");
});

// 15. The compact expansion consumes the popover z-index and shadow tokens.
test("15. compact expansion uses popover z-index and shadow tokens", async () => {
  const media = compactRailMedia(await readCss());
  const expanded = /\.shell\.details-open \.sidebar-search:focus-within \{([^}]*)\}/.exec(media);
  assert.match(expanded[1], /z-index: var\(--z-popover\)/, "expansion must consume --z-popover");
  assert.match(expanded[1], /box-shadow: var\(--shadow-popover\)/, "expansion must consume --shadow-popover");
});

// 16. No second synced/duplicate search control exists anywhere in the shell.
test("16. no duplicate or hidden synced search control exists", async () => {
  const html = await readHtml();
  assert.equal(html.split('class="sidebar-search"').length - 1, 1, "exactly one sidebar-search container");
  const searchDiv = /<div class="sidebar-search">([\s\S]*?)<\/div>/.exec(html);
  assert.equal(searchDiv[1].split("<input").length - 1, 1, "exactly one input inside the search container");
  assert.equal(html.includes("sidebar-search-compact"), false, "no compact-only duplicate control");
  // The compact behaviour is pure CSS on the same element: no JS class toggling for search.
  const app = await readApp();
  assert.doesNotMatch(app, /sidebar-search/, "app.js must not toggle search classes (pure-CSS compact contract)");
});

// 17. No new dependencies were introduced.
test("17. no new dependencies", async () => {
  const pkg = await readFile(resolve(root, "package.json"), "utf8");
  assert.equal(sha256(pkg), "e161974a477853703cc88724de39805fe5c65e590bd331060a17be6d087a2f24", "package.json must stay untouched");
  const lock = await readFile(resolve(root, "package-lock.json"), "utf8");
  assert.equal(sha256(lock), "50a7d029b6aed62fd921ca013f00dba1b01d2ce96009792fb69c63207a04c8dd", "package-lock.json must stay untouched");
});

// 18. No !important anywhere in the stylesheet (comments stripped).
test("18. no !important in styles.css", async () => {
  const css = (await readCss()).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(css.includes("!important"), false, "styles.css must not use !important");
});

// 19. No undefined tokens: every var() consumed by the search rules is defined.
test("19. search rules consume only defined tokens", async () => {
  const css = await readCss();
  const searchRules = [];
  for (const match of css.matchAll(/([^{}]*sidebar-search[^{}]*)\{([^{}]*)\}/g)) {
    searchRules.push(match[2]);
  }
  assert.ok(searchRules.length >= 5, "sidebar-search rules must exist (base, icon, input, placeholder/focus, compact)");
  const consumed = new Set();
  for (const body of searchRules) {
    for (const v of body.matchAll(/var\((--[a-z0-9-]+)/gi)) consumed.add(v[1]);
  }
  assert.ok(consumed.size > 0, "search rules must consume design tokens");
  for (const token of consumed) {
    assert.ok(css.includes(`${token}:`), `token consumed by search rules must be defined: ${token}`);
  }
});

// 20. The Phase 1A/1B/1C contract suites keep passing alongside this migration.
test("20. Phase 1 contract suites keep passing", () => {
  const result = spawnSync(process.execPath, [
    "--test", "test/ui-component-contract.test.mjs", "test/card-action-contract.test.mjs",
  ], { cwd: root, encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  const out = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, `Phase 1 contract suites must exit 0:\n${out}`);
});
