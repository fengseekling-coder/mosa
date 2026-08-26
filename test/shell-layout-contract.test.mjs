// Shell layout contract (Phase 2C): single-source panel tokens, three layout
// modes (wide / compact desktop / web fallback), shrink chain, overlay levels,
// batch-bar compensation and breakpoint governance. Static guards only —
// Node standard library, no network access. Locks concrete selectors, tokens
// and layout behaviour (never a whole-file CSS SHA).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const readCss = () => readFile(resolve(root, "app/styles.css"), "utf8");
const readHtml = () => readFile(resolve(root, "app/index.html"), "utf8");
const readApp = () => readFile(resolve(root, "app/app.mjs"), "utf8");
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

/** Extracts the sidebar/topbar slice of index.html by element boundaries. */
function htmlSlice(html, openMarker, closeMarker) {
  const start = html.indexOf(openMarker);
  assert.notEqual(start, -1, `marker not found: ${openMarker}`);
  const end = html.indexOf(closeMarker, start);
  assert.notEqual(end, -1, `marker not found: ${closeMarker}`);
  return html.slice(start, end);
}

// 1. Shell contains the Sidebar, Library and Detail primary regions.
// 2–6. Shell consumes the semantic panel tokens (no width literals in Shell rules).
// 7. The topbar height still comes from its token.
test("1-7. shell regions and panel token consumption", async () => {
  const [html, css] = await Promise.all([readHtml(), readCss()]);

  // 1. Three primary regions, in DOM order (detail last → rightmost column).
  assert.match(html, /<div class="shell" id="appShell">/);
  assert.match(html, /<aside class="sidebar"/);
  assert.match(html, /<main class="library">/);
  assert.match(html, /<aside class="detail" id="detailPanel"/);
  const order = [html.indexOf('class="sidebar"'), html.indexOf('class="library"'), html.indexOf('id="detailPanel"')];
  assert.ok(order[0] > -1 && order[0] < order[1] && order[1] < order[2], "DOM order must be sidebar → library → detail");

  // 2. Shell rules consume tokens.
  const shell = blockAfter(css, ".shell {");
  const shellOpen = blockAfter(css, ".shell.details-open {");
  assert.match(shell, /grid-template-columns: var\(--sidebar-width\) minmax\(0, 1fr\)/);
  assert.match(shellOpen, /grid-template-columns: var\(--sidebar-width\) minmax\(0, 1fr\) var\(--inspector-width\)/);

  // 3–6. Widths resolve from token definitions, and narrow/compact variants drive
  // the ≤1120px media query — never repeated literals in Shell rules.
  // 2026-08-18: V2-only token consolidation. V2 collapses the Phase 1A
  // 232px sidebar down to 220px (still on the 8pt grid). Narrow (208) and
  // compact (56) stay identical; the inspector widths are unchanged.
  assert.match(css, /--sidebar-width: 220px;/);
  assert.match(css, /--sidebar-width-narrow: 208px;/);
  assert.match(css, /--sidebar-width-compact: 56px;/);
  assert.match(css, /--inspector-width: 360px;/);
  assert.match(css, /--inspector-width-compact: 340px;/);
  const mq1120 = blockAfter(css, "@media (max-width: 1120px)");
  assert.match(mq1120, /\.shell \{ grid-template-columns: var\(--sidebar-width-narrow\) minmax\(0, 1fr\); \}/);
  assert.match(mq1120, /\.shell\.details-open \{ grid-template-columns: var\(--sidebar-width-compact\) minmax\(0, 1fr\) var\(--inspector-width-compact\); \}/);
  assert.doesNotMatch(shell + shellOpen + mq1120, /grid-template-columns:[^;]*\b(232|208|56|360|340)px\b/);

  // 7. Topbar height token. V2 (2026-08-07) moved the value from 52px to 56px
  // (8pt-grid fix); the token indirection is what this asserts.
  assert.match(blockAfter(css, ".topbar {"), /height: var\(--topbar-height\)/);
  assert.match(css, /--topbar-height: 56px;/);
});

// 8. Wide-screen detail sits on the right.
// 9. 960–1120 detail sits on the right, never below the gallery.
// 10. The details-open compact sidebar contract exists.
// 19. No 959px shell breakpoint (nor any other hairline breakpoint).
// 20. No rule sinks the detail below the gallery in the 900–1120 range.
// 21. The 1400/1120/900 breakpoints keep clear semantics.
test("8-10, 19-21. three layout modes and breakpoint governance", async () => {
  const css = await readCss();

  // 8. Wide mode: third column is the inspector token (right side).
  assert.match(blockAfter(css, ".shell.details-open {"), /minmax\(0, 1fr\) var\(--inspector-width\); \}$/);

  // 9. Compact desktop: detail stays the right-hand column of the same grid row.
  const mq1120 = blockAfter(css, "@media (max-width: 1120px)");
  assert.match(mq1120, /\.shell\.details-open \{ grid-template-columns: var\(--sidebar-width-compact\) minmax\(0, 1fr\) var\(--inspector-width-compact\); \}/);
  assert.doesNotMatch(mq1120, /grid-template-rows/);

  // 10. Compact sidebar (icon rail) contract under details-open, 701–1120px.
  const mqCompact = blockAfter(css, "@media (min-width: 701px) and (max-width: 1120px)");
  assert.match(mqCompact, /\.shell\.details-open \.nav-item-text/);

  // 19. No hairline breakpoints anywhere in the stylesheet.
  assert.doesNotMatch(css, /@media[^{]*\b(959|961|1119|1121)px\b/);

  // 20. The detail never drops to a second grid row (900–1120 included).
  assert.doesNotMatch(css, /\.shell\.details-open \{[^}]*grid-template-rows/);
  assert.doesNotMatch(css, /\.detail \{[^}]*grid-row/);

  // 21. Breakpoint semantics: 1400 → gallery columns, 1120 → shell compaction,
  // 900 → gallery columns + icon-only import under details-open.
  assert.match(css, /@media \(max-width: 1400px\) \{ \.grid \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \} \}/);
  assert.match(blockAfter(css, "@media (max-width: 1120px)"), /\.shell \{ grid-template-columns: var\(--sidebar-width-narrow\)/);
  assert.match(css, /@media \(max-width: 900px\) \{ \.grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \} \}/);
  const mq900 = blockAfter(css, "@media (max-width: 900px) {\n");
  assert.match(mq900, /\.shell\.details-open \.create-button span \{ display: none; \}/);
});

// 11. Library carries the min-width:0 shrink contract.
// 12. Topbar context/actions carry min-width shrink contracts.
// 13. The grid never depends on a fixed page width.
// 14. The page never masks horizontal overflow with body/html overflow-x:hidden.
test("11-14. shrink chain and honest overflow", async () => {
  const css = await readCss();

  assert.match(blockAfter(css, ".library {"), /min-width: 0/);
  assert.match(blockAfter(css, ".topbar-context {"), /min-width: 0/);
  assert.match(blockAfter(css, ".topbar-actions {"), /min-width: 0/);

  const grid = blockAfter(css, ".grid {");
  assert.match(grid, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(grid, /min-width: 0/);
  assert.doesNotMatch(grid, /\bwidth:\s*\d+px/);

  // The body lock (overflow:hidden, desktop shell contract) stays, but no rule
  // may hide *horizontal* overflow on the page root.
  assert.match(css, /\nbody \{ overflow: hidden;/);
  assert.doesNotMatch(css, /(?:^|\})\s*(?:html|html, body|body)\s*\{[^}]*overflow-x:\s*hidden/);
});

// 15. Filter panel uses the popover overlay level.
// 16. Compact search expansion uses the popover level.
// 17. Detail scrolls vertically on its own — Phase 4A moved the independent
//     y-scroller to .detail-inspector-scroll; the panel itself stays overflow:hidden.
// 18. Batch-bar compensation consumes tokens and leaves no residue when off.
test("15-18. overlay levels and batch-bar compensation", async () => {
  const css = await readCss();

  assert.match(css, /--z-popover: 30;/);
  assert.match(blockAfter(css, ".filter-panel {"), /z-index: var\(--z-popover\)/);
  // V2 FilterBar: the single search lives in the topbar; its focus state stays scoped.
  assert.match(css, /\.topbar-search:focus-within \{[^}]*border-color: var\(--color-border-subtle\)/);

  const detail = blockAfter(css, "\n.detail {");
  assert.match(detail, /overflow: hidden/);
  const inspectorScroll = blockAfter(css, ".detail-inspector-scroll {");
  assert.match(inspectorScroll, /overflow-x: hidden/);
  assert.match(inspectorScroll, /overflow-y: auto/);

  assert.match(css, /--statusbar-height: 48px;/);
  assert.match(blockAfter(css, ".grid.batch-active {"), /padding-bottom: calc\(var\(--statusbar-height\) \+ var\(--space-2\)\)/);
  assert.match(blockAfter(css, ".shell:has(.grid.batch-active) .detail {"), /padding-bottom: var\(--statusbar-height\)/);
  // Off-state keeps only the regular breathing room — no residual batch padding.
  assert.match(blockAfter(css, ".grid {"), /padding: var\(--space-2\) 20px var\(--space-3\)/);
  // 2026-08-18: V2-only token consolidation. The V2 design removed the
  // bottom statusbar / batch-bar chrome and the JS hook that toggled
  // `.batch-active` on the grid. The CSS compensation rule below stays
  // in place (token-driven, harmless when no element sets the class),
  // and the contract now documents that V2 choice rather than asserting
  // a JS hook that has been retired.
  assert.match(css, /\.grid\.batch-active \{ padding-bottom: calc\(var\(--statusbar-height\) \+ var\(--space-2\)\); \}/,
    "CSS compensation rule for the retired batch-bar stays in place");
});

// 22. The public CSS keeps the O2 compact-desktop decision executable after
// the internal implementation-decision note was removed from the repository.
test("22. O2 compact desktop behavior stays locked in public CSS", async () => {
  const css = await readCss();
  const mq1120 = blockAfter(css, "@media (max-width: 1120px)");
  const mqCompact = blockAfter(css, "@media (min-width: 701px) and (max-width: 1120px)");

  assert.match(mq1120, /\.shell\.details-open \{ grid-template-columns: var\(--sidebar-width-compact\) minmax\(0, 1fr\) var\(--inspector-width-compact\); \}/);
  assert.match(mqCompact, /\.shell\.details-open \.nav-item-text,[\s\S]*?clip: rect\(0,0,0,0\)/);
  assert.match(css, /@media \(max-width: 700px\) \{[\s\S]*?\.shell, \.shell\.details-open \{ display: flex; min-height: 100vh; flex-direction: column; \}/);
});

// 23. The search-location contract keeps holding (sidebar, not topbar).
// 24. The topbar three-group hierarchy keeps holding.
// 25. The card quick-action contract keeps holding.
test("23-25. adjacent Phase 2A/2B/1C contracts unaffected", async () => {
  const [html, css, app] = await Promise.all([readHtml(), readCss(), readApp()]);

  const sidebar = htmlSlice(html, '<aside class="sidebar"', '<main class="library">');
  const topbar = htmlSlice(html, '<header class="topbar">', "</header>");
  assert.ok(topbar.includes('id="searchInput"'), "the V2 search input lives in the topbar");
  assert.equal(sidebar.includes('id="searchInput"'), false, "no search input may remain in the sidebar");

  for (const group of ["topbar-utility-group", "topbar-work-group", "topbar-primary-group"]) {
    assert.match(html, new RegExp(`class="${group}"`));
  }

  assert.match(css, /\.card-action-btn/);
  assert.match(css, /\.card-favorite\.is-fav/);
  assert.match(app, /card-favorite/);
});

// 26. No !important anywhere in the stylesheet.
// 27. Every consumed token is defined (no undefined var references).
// 28. No new dependencies (package.json stays untouched).
test("26-28. hygiene: no !important, no undefined tokens, no new dependencies", async () => {
  const css = await readCss();
  // Declarations only — the word may still appear inside comments.
  assert.doesNotMatch(css, /:[^;{}]*!important/);

  const defined = new Set([...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]));
  // Fallback-less var() references must resolve to a defined token. References
  // with a fallback (var(--x, fallback)) are runtime anchor points injected by
  // app.js (overlay positioning) — verify the injection sites instead.
  const hardRefs = new Set([...css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1]));
  const missing = [...hardRefs].filter((name) => !defined.has(name));
  assert.deepEqual(missing, [], `undefined tokens referenced: ${missing.join(", ")}`);
  const anchorRefs = new Set([...css.matchAll(/var\(\s*(--[\w-]+)\s*,/g)].map((m) => m[1]));
  const app = await readApp();
  // R1 batch 3: the toast stack offset injection lives in app/toast-manager.mjs.
  const toast = await readFile(resolve(root, "app/toast-manager.mjs"), "utf8");
  for (const name of anchorRefs) {
    if (defined.has(name)) continue;
    assert.ok((app + toast).includes(`setProperty("${name}"`), `anchor ${name} needs a fallback and a JS injection site`);
  }

  const pkg = await readFile(resolve(root, "package.json"), "utf8");
  // R1 isolation fix (2026-08-09, approved scope) added qa:web/qa:electron/
  // qa:packaged launcher scripts, so the whole-manifest hash no longer holds;
  // the dependency sections the freeze really guards stay byte-identical.
  const manifest = JSON.parse(pkg);
  assert.equal(sha256(JSON.stringify(manifest.dependencies)), "73c83773a57e21a20917d81b24288bdfddd9bb7ddd644fdaedd6e6cfba13c405", "package.json dependencies must stay untouched");
  assert.equal(sha256(JSON.stringify(manifest.devDependencies)), "11f67ce00f34b4d3dfb9b9ed0dfb428b0368ad5e0a17bd3bafaa40e3c2124fac", "package.json devDependencies must stay untouched");
});
