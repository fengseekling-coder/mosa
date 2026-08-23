import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

// V2 FilterBar (mosa-library-v2, 2026-08-16): the single global search input lives
// in the topbar work group as the right-most control of the bar
// (result count → batch → sort → filter → search). This suite locks the search
// location contract for that layout and proves the search business semantics
// (events, state, algorithm, i18n) did not change. Node standard library only.

const root = resolve(import.meta.dirname, "..");
const readHtml = () => readFile(resolve(root, "app/index.html"), "utf8");
const readCss = () => readFile(resolve(root, "app/styles.css"), "utf8");
const readApp = () => readFile(resolve(root, "app/app.mjs"), "utf8");
const readApiClient = () => readFile(resolve(root, "app/api-client.mjs"), "utf8");
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

// 1. Exactly one #searchInput exists in the page (no duplicate/synced inputs).
test("1. the page contains exactly one #searchInput", async () => {
  const html = await readHtml();
  assert.equal(html.split('id="searchInput"').length - 1, 1, "index.html must contain exactly one #searchInput");
  const app = await readApp();
  assert.equal(app.includes('id="searchInput"'), false, "app.js must not render a second search input");
});

// 2. The search input lives inside the topbar work group, after the filter toggle.
test("2. #searchInput lives in the topbar work group after the filter toggle", async () => {
  const topbar = topbarBlock(await readHtml());
  assert.ok(topbar.includes('id="searchInput"'), "#searchInput must be inside the topbar");
  const searchDiv = /<div class="topbar-search">([\s\S]*?)<\/div>/.exec(topbar);
  assert.ok(searchDiv, "topbar-search container must exist");
  assert.ok(searchDiv[1].includes('id="searchInput"'), "the search input must be inside .topbar-search");
  assert.ok(topbar.indexOf('id="filterToggle"') < topbar.indexOf('id="searchInput"'), "search sits after the filter toggle (V2 FilterBar order)");
});

// 3. The sidebar no longer contains any search control.
test("3. the sidebar no longer contains a search control", async () => {
  const sidebar = sidebarBlock(await readHtml());
  assert.equal(sidebar.includes('id="searchInput"'), false, "no search input may remain in the sidebar");
  assert.equal(sidebar.includes("sidebar-search"), false, "no legacy sidebar-search container may remain");
});

// 4. The input keeps type="search" (native clear button semantics).
test("4. #searchInput keeps type=\"search\"", async () => {
  const input = /<input id="searchInput"[^>]*>/.exec(await readHtml());
  assert.ok(input, "search input element must exist");
  assert.match(input[0], /type="search"/, "search input must keep type=\"search\"");
});

// 5. The input keeps an explicit accessible name and the decorative icon stays hidden.
test("5. #searchInput keeps an explicit accessible name", async () => {
  const input = /<input id="searchInput"[^>]*>/.exec(await readHtml());
  assert.match(input[0], /aria-label="搜索素材"/, "aria-label must be preserved");
  assert.match(input[0], /data-i18n-aria-label="searchPlaceholder"/, "i18n aria-label binding must be preserved");
  const searchDiv = /<div class="topbar-search">([\s\S]*?)<\/div>/.exec(await readHtml());
  assert.match(searchDiv[1], /<svg class="topbar-search-icon"[^>]*aria-hidden="true"/, "search icon must stay decorative (aria-hidden)");
});

// 6. The V2 placeholder copy is wired through i18n in both locales.
test("6. i18n placeholder uses the V2 copy in both locales", async () => {
  const input = /<input id="searchInput"[^>]*>/.exec(await readHtml());
  assert.match(input[0], /data-i18n-placeholder="searchPlaceholder"/, "placeholder i18n binding must be preserved");
  assert.match(input[0], /placeholder="搜索所有素材\.\.\."/, "default zh placeholder must match V2");
  const messages = (await import(resolve(root, "app/i18n.mjs"))).default;
  assert.equal(messages.zh.searchPlaceholder, "搜索所有素材...", "zh placeholder must match V2");
  assert.equal(messages.en.searchPlaceholder, "Search all assets...", "en placeholder must match V2");
});

// 7. The search event listener still binds to the same element ID.
test("7. the input event listener still binds #searchInput", async () => {
  const app = await readApp();
  assert.match(app, /searchInput: document\.querySelector\("#searchInput"\)/, "element lookup must keep the #searchInput ID");
  assert.match(app, /els\.searchInput\?\.addEventListener\("input", debounce\(async \(\) => \{ state\.query = els\.searchInput\.value;/,
    "the debounced input listener must stay bound to els.searchInput");
});

// 8. The search state field is unchanged (state.query, no new search state objects).
test("8. the search state field is unchanged", async () => {
  const app = await readApp();
  assert.match(app, /state\.query = els\.searchInput\.value/, "state.query remains the search state field");
  assert.doesNotMatch(app, /state\.search[A-Z]/, "no new search state fields may be introduced");
  assert.match(app, /if \(kind === "query"\) \{ state\.query = ""; if \(els\.searchInput\) els\.searchInput\.value = ""; \}/,
    "the query filter-chip clear path must stay intact");
});

// 9. The search algorithm, API and i18n behaviour stay locked.
test("9. search algorithm, API and i18n behaviour stay locked", async () => {
  const [app, apiClient] = await Promise.all([readApp(), readApiClient()]);
  assert.match(app, /debounce\(async \(\) => \{ state\.query = els\.searchInput\.value; state\.nextCursor = null;\s+\/\/ Phase 3A[^\n]*\n\s+if \(state\.viewMode === "asset"\) returnToLibrary\(\);\s+renderActiveFilters\(\); await loadAssets\(\); \}, 180\)/,
    "the 180ms debounced query → loadAssets pipeline must stay unchanged apart from the Phase 3A exit hook");
  assert.match(apiClient, /const params = new URLSearchParams\(\{ project: request\.project, q: request\.query \}\)/,
    "the /api/assets query construction must stay unchanged");
  assert.match(apiClient, /params\.set\("limit", "100"\)/, "the page-size contract must stay unchanged");
  const i18n = await readFile(resolve(root, "app/i18n.mjs"), "utf8");
  assert.match(i18n, /searchPlaceholder: "搜索所有素材\.\.\."/, "zh search placeholder must match V2");
  assert.match(i18n, /searchPlaceholder: "Search all assets\.\.\."/, "en search placeholder must match V2");
});

// 10. The topbar search styles exist and keep the V2 geometry.
test("10. topbar search styles keep the V2 geometry", async () => {
  const css = await readCss();
  const { block } = extractBlock(css, ".topbar-search {");
  assert.match(block, /width: 256px/, "search container must keep the V2 256px width");
  assert.match(block, /height: var\(--control-sm\)/, "search container must consume the control-size token");
  assert.match(block, /border-radius: 8px/, "search container must keep the V2 8px radius");
  assert.match(css, /\.topbar-search:focus-within \{[^}]*var\(--border-focus\)/, "focus must use the V2 border-focus token");
  assert.match(css, /\.topbar-search:focus-within \{[^}]*var\(--app-search-focus\)/, "focus must use the V2 search-focus surface");
});

// 11. No second synced/duplicate search control exists anywhere in the shell.
test("11. no duplicate or hidden synced search control exists", async () => {
  const html = await readHtml();
  assert.equal(html.split('class="topbar-search"').length - 1, 1, "exactly one topbar-search container");
  const searchDiv = /<div class="topbar-search">([\s\S]*?)<\/div>/.exec(html);
  assert.equal(searchDiv[1].split("<input").length - 1, 1, "exactly one input inside the search container");
  assert.equal(html.includes("sidebar-search"), false, "no legacy sidebar search control");
  // The search behaviour is pure CSS + the existing debounced listener: no JS class toggling.
  const app = await readApp();
  assert.doesNotMatch(app, /topbar-search/, "app.js must not toggle search classes");
});

// 12. No new dependencies were introduced.
test("12. no new dependencies", async () => {
  const pkg = await readFile(resolve(root, "package.json"), "utf8");
  const manifest = JSON.parse(pkg);
  assert.equal(sha256(JSON.stringify(manifest.dependencies)), "73c83773a57e21a20917d81b24288bdfddd9bb7ddd644fdaedd6e6cfba13c405", "package.json dependencies must stay untouched");
  assert.equal(sha256(JSON.stringify(manifest.devDependencies)), "11f67ce00f34b4d3dfb9b9ed0dfb428b0368ad5e0a17bd3bafaa40e3c2124fac", "package.json devDependencies must stay untouched");
  const lock = await readFile(resolve(root, "package-lock.json"), "utf8");
  assert.equal(sha256(lock), "ecf0fdc199de87ccd30ffe6a7da4624c2f632700cd8348194a30b79dd2e2a69f", "package-lock.json must stay untouched");
});

// 13. No !important anywhere in the stylesheet (comments stripped).
test("13. no !important in styles.css", async () => {
  const css = (await readCss()).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(css.includes("!important"), false, "styles.css must not use !important");
});

// 14. No undefined tokens: every var() consumed by the search rules is defined.
test("14. search rules consume only defined tokens", async () => {
  const css = await readCss();
  const searchRules = [];
  for (const match of css.matchAll(/([^{}]*topbar-search[^{}]*)\{([^{}]*)\}/g)) {
    searchRules.push(match[2]);
  }
  assert.ok(searchRules.length >= 3, "topbar-search rules must exist (base, input, focus)");
  const consumed = new Set();
  for (const body of searchRules) {
    for (const v of body.matchAll(/var\((--[a-z0-9-]+)/gi)) consumed.add(v[1]);
  }
  assert.ok(consumed.size > 0, "search rules must consume design tokens");
  for (const token of consumed) {
    assert.ok(css.includes(`${token}:`), `token consumed by search rules must be defined: ${token}`);
  }
});

// 15. The Phase 1A/1B/1C contract suites keep passing alongside this migration.
test("15. Phase 1 contract suites keep passing", () => {
  const result = spawnSync(process.execPath, [
    "--test", "test/ui-component-contract.test.mjs", "test/card-action-contract.test.mjs",
  ], { cwd: root, encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  const out = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, `Phase 1 contract suites must exit 0:\n${out}`);
});
