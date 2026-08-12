import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

// Phase 2B (F-18 / O4-A): topbar action-hierarchy contract. The workspace bar is
// split into .topbar-context (title + count) and .topbar-actions with three action
// groups (utility / work / primary); Import stays the single primary action; the
// bridge status is de-noised (dot + capped short label, meta visually-hidden) while
// role=status / aria-live / title / #statusText keep full state semantics; compact
// breakpoints hide visible labels via the clip pattern (never display:none on state
// semantics, never aria-hidden on whole buttons). No functional behaviour changes:
// this suite locks DOM, selectors and behaviours — not whole-file SHAs.
// Node standard library only; no network access.

const root = resolve(import.meta.dirname, "..");
const readHtml = () => readFile(resolve(root, "app/index.html"), "utf8");
const readCss = () => readFile(resolve(root, "app/styles.css"), "utf8");
const readApp = () => readFile(resolve(root, "app/app.mjs"), "utf8");

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

function topbarBlock(html) {
  const start = html.indexOf('<header class="topbar"');
  const end = html.indexOf("</header>", start);
  assert.ok(start > -1 && end > start, "topbar header must exist");
  return html.slice(start, end);
}

const CONTROL_IDS = ["bridgeStatus", "themeToggle", "batchToggle", "sortSelect", "filterToggle", "newAssetTopBtn"];

// 1. The topbar exposes exactly two regions: context and actions.
test("1. topbar has context and actions regions", async () => {
  const topbar = topbarBlock(await readHtml());
  assert.equal(topbar.split('class="topbar-context"').length - 1, 1, "exactly one .topbar-context");
  assert.equal(topbar.split('class="topbar-actions"').length - 1, 1, "exactly one .topbar-actions");
  assert.ok(topbar.indexOf('class="topbar-context"') < topbar.indexOf('class="topbar-actions"'), "context precedes actions");
  const context = /<div class="topbar-context">([\s\S]*?)<\/div>\s*<div class="topbar-actions"/.exec(topbar);
  assert.ok(context, "context block must exist before actions");
  assert.ok(context[1].includes('id="viewTitle"') && context[1].includes('id="assetCount"'), "context holds title + count");
});

// 2. The actions region holds exactly the three approved groups.
test("2. actions region holds utility / work / primary groups", async () => {
  const topbar = topbarBlock(await readHtml());
  for (const group of ["topbar-utility-group", "topbar-work-group", "topbar-primary-group"]) {
    assert.equal(topbar.split(`class="${group}"`).length - 1, 1, `exactly one .${group}`);
  }
  const order = ["topbar-utility-group", "topbar-work-group", "topbar-primary-group"].map((g) => topbar.indexOf(`class="${g}"`));
  assert.ok(order[0] < order[1] && order[1] < order[2], "group order must be utility → work → primary");
});

// 3. Bridge status and theme toggle live in the utility group.
test("3. bridge status and theme toggle live in the utility group", async () => {
  const topbar = topbarBlock(await readHtml());
  const utilityStart = topbar.indexOf('class="topbar-utility-group"');
  const workStart = topbar.indexOf('class="topbar-work-group"');
  for (const id of ["bridgeStatus", "themeToggle"]) {
    const at = topbar.indexOf(`id="${id}"`);
    assert.ok(at > utilityStart && at < workStart, `#${id} must sit inside the utility group`);
  }
});

// 4. Batch / sort / filter live in the work group.
test("4. batch, sort and filter live in the work group", async () => {
  const topbar = topbarBlock(await readHtml());
  const workStart = topbar.indexOf('class="topbar-work-group"');
  const primaryStart = topbar.indexOf('class="topbar-primary-group"');
  for (const marker of ['id="batchToggle"', 'class="sort-control"', 'id="sortSelect"', 'id="filterToggle"']) {
    const at = topbar.indexOf(marker);
    assert.ok(at > workStart && at < primaryStart, `${marker} must sit inside the work group`);
  }
});

// 5. Import lives in the primary group.
test("5. import lives in the primary group", async () => {
  const topbar = topbarBlock(await readHtml());
  const primaryStart = topbar.indexOf('class="topbar-primary-group"');
  const at = topbar.indexOf('id="newAssetTopBtn"');
  assert.ok(at > primaryStart, "#newAssetTopBtn must sit inside the primary group");
});

// 6. All six control IDs stay unique in the page.
test("6. the six control IDs stay unique", async () => {
  const html = await readHtml();
  for (const id of CONTROL_IDS) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, `#${id} must appear exactly once`);
  }
  const app = await readApp();
  for (const id of CONTROL_IDS) {
    assert.equal(app.split(`querySelector("#${id}")`).length - 1, 1, `app.js must keep a single #${id} lookup and render no duplicate`);
  }
});

// 7. The DOM order of the six controls is unchanged.
test("7. control DOM order is unchanged", async () => {
  const topbar = topbarBlock(await readHtml());
  const positions = CONTROL_IDS.map((id) => topbar.indexOf(`id="${id}"`));
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i] > positions[i - 1], `order violated: ${CONTROL_IDS[i - 1]} must precede ${CONTROL_IDS[i]}`);
  }
  // The hidden live region still precedes the visible bridge status.
  assert.ok(topbar.indexOf('id="statusText"') < topbar.indexOf('id="bridgeStatus"'), "#statusText stays before #bridgeStatus");
});

// 8. The topbar keeps exactly one primary action (Import).
test("8. the topbar keeps exactly one primary action", async () => {
  const topbar = topbarBlock(await readHtml());
  assert.equal(topbar.split('class="create-button"').length - 1, 1, "exactly one .create-button in the topbar");
  assert.equal(topbar.includes("btn-primary"), false, "no second solid-accent button class in the topbar");
  // The primary button is styled by the accent token, the work/utility controls are not.
  const css = await readCss();
  const { block } = extractBlock(css, ".create-button {");
  assert.match(block, /background: var\(--accent\)/, "the single primary action keeps the solid accent background");
});

// 9. Bridge meta no longer occupies visible topbar layout (visually-hidden, not display:none).
test("9. bridge meta is visually hidden without display:none", async () => {
  const html = await readHtml();
  assert.match(html, /class="bridge-status-meta visually-hidden" id="bridgeStatusMeta"/, "#bridgeStatusMeta must carry .visually-hidden");
  const css = await readCss();
  const { block } = extractBlock(css, ".visually-hidden {");
  assert.match(block, /position: absolute/, "visually-hidden must detach from layout");
  assert.match(block, /clip: rect\(0,0,0,0\)/, "visually-hidden must clip, not display:none");
  assert.doesNotMatch(css, /\.bridge-status-meta[^{]*\{[^}]*display:\s*none/, "meta must never be display:none (state semantics preserved)");
  assert.doesNotMatch(css, /#bridgeStatusLabel[^{]*\{[^}]*display:\s*none/, "label must never be display:none (state semantics preserved)");
});

// 10. Bridge role=status / aria-live / state pipeline stays intact.
test("10. bridge status live semantics stay intact", async () => {
  const html = await readHtml();
  assert.match(html, /id="bridgeStatus" data-state="checking" role="status" aria-live="polite"/, "bridge status keeps role=status + aria-live");
  assert.match(html, /id="statusText" role="status" aria-live="polite"/, "#statusText live region stays");
  const app = await readApp();
  assert.match(app, /els\.bridgeStatus\.dataset\.state = stateName; els\.bridgeStatus\.title = value;/, "setStatus still publishes data-state + tooltip");
  assert.match(app, /els\.bridgeStatusLabel\) els\.bridgeStatusLabel\.textContent = value;/, "setStatus still publishes the label text");
  assert.match(app, /els\.statusText\) els\.statusText\.textContent = value;/, "setStatus still publishes the hidden live text");
});

// 11. Theme toggle keeps its accessible name (icon-only).
test("11. theme toggle keeps its accessible name", async () => {
  const button = /<button class="toolbar-icon" id="themeToggle"[^>]*>/.exec(await readHtml());
  assert.ok(button, "theme toggle must exist");
  assert.match(button[0], /aria-label="切换暗色模式"/, "aria-label must be preserved");
  assert.match(button[0], /aria-pressed="false"/, "aria-pressed must be preserved");
  assert.match(button[0], /data-i18n-aria-label="darkModeToggle"/, "i18n aria-label binding must be preserved");
});

// 12. Batch toggle keeps aria-pressed.
test("12. batch toggle keeps aria-pressed", async () => {
  const button = /<button class="toolbar-filter batch-toggle" id="batchToggle"[^>]*>/.exec(await readHtml());
  assert.ok(button, "batch toggle must exist");
  assert.match(button[0], /aria-pressed="false"/, "aria-pressed must be preserved");
  assert.match(button[0], /aria-label="批量管理"/, "accessible name must be preserved");
  const app = await readApp();
  assert.match(app, /els\.batchToggle\) els\.batchToggle\.setAttribute\("aria-pressed", String\(state\.batchMode\)\);/, "batch aria-pressed sync logic unchanged");
});

// 13. Filter toggle keeps aria-expanded + aria-controls.
test("13. filter toggle keeps aria-expanded", async () => {
  const button = /<button class="toolbar-filter" id="filterToggle"[^>]*>/.exec(await readHtml());
  assert.ok(button, "filter toggle must exist");
  assert.match(button[0], /aria-expanded="false"/, "aria-expanded must be preserved");
  assert.match(button[0], /aria-controls="filterPanel"/, "aria-controls must be preserved");
  assert.match(button[0], /aria-label="筛选"/, "accessible name must be preserved");
});

// 14. Sort select keeps its accessible name and native options.
test("14. sort select keeps its accessible name", async () => {
  const select = /<select id="sortSelect"[^>]*>/.exec(await readHtml());
  assert.ok(select, "sort select must exist");
  assert.match(select[0], /aria-label="排序"/, "aria-label must be preserved");
  const topbar = topbarBlock(await readHtml());
  for (const value of ["newest", "oldest", "name"]) {
    assert.ok(topbar.includes(`<option value="${value}"`), `native option ${value} must be preserved`);
  }
});

// 15. Import keeps its accessible name and visible label text.
test("15. import keeps accessible name and visible text", async () => {
  const button = /<button class="create-button" id="newAssetTopBtn"[^>]*>([\s\S]*?)<\/button>/.exec(await readHtml());
  assert.ok(button, "import button must exist");
  assert.match(button[0], /aria-label="导入素材"/, "aria-label must be preserved");
  assert.match(button[1], /<span data-i18n="importAsset">导入素材<\/span>/, "visible label text must be preserved (not icon-only)");
  const app = await readApp();
  assert.match(app, /els\.newAssetTopBtn\?\.addEventListener\("click", openImportModal\);/, "import still opens the existing modal");
});

// 16. The 1179px compact tier exists (≤1399px label-clip rules; 1179 falls inside).
test("16. the 1179px compact tier exists", async () => {
  const { block } = extractBlock(await readCss(), "@media (max-width: 1399px) {");
  assert.match(block, /\.topbar-work-group \.toolbar-filter > span:not\(\.filter-dot\) \{[^}]*clip: rect\(0,0,0,0\)/, "batch/filter labels clip-hidden at ≤1399px");
  assert.match(block, /\.topbar-work-group \.toolbar-filter \{[^}]*padding: 0 8px/, "icon-only padding at ≤1399px");
  assert.doesNotMatch(block, /display:\s*none/, "the 1179 tier must not use display:none for control labels");
});

// 17. The 960px compact tier exists (≤1120px bridge-label clip rule; 960 falls inside).
test("17. the 960px compact tier exists", async () => {
  const css = await readCss();
  const { block, end } = extractBlock(css, "@media (max-width: 1120px) {");
  assert.match(block, /#bridgeStatusLabel \{[^}]*clip: rect\(0,0,0,0\)/, "bridge label clip-hidden at ≤1120px (dot-only)");
  // The 960×640 acceptance line keeps the import label; icon fallback only below 901px with details open.
  const media900 = extractBlock(css, "@media (max-width: 900px) {", end).block;
  assert.match(media900, /\.shell\.details-open \.create-button span \{[^}]*display:\s*none/, "import icon fallback is scoped to ≤900px details-open");
});

// 18. The topbar single-row contract exists (nowrap; ≤700px document-flow tier excepted).
test("18. the topbar nowrap contract exists", async () => {
  const { block } = extractBlock(await readCss(), ".topbar {");
  assert.match(block, /flex-wrap: nowrap/, "base .topbar must declare flex-wrap: nowrap");
  assert.match(block, /align-items: center/, "base .topbar must keep vertical centering");
});

// 19. The title area keeps min-width:0 + ellipsis contracts.
test("19. title min-width and ellipsis contracts exist", async () => {
  const css = await readCss();
  const { block: context } = extractBlock(css, ".topbar-context {");
  assert.match(context, /min-width: 0/, ".topbar-context must allow shrink");
  // The full flex shrink chain must be declared: a flex item's default min-width:auto
  // (= min-content) blocks ellipsis on nowrap text (caught by Phase 2B runtime).
  const { block: row } = extractBlock(css, ".title-row {");
  assert.match(row, /min-width: 0/, ".title-row must allow shrink");
  const { block: title } = extractBlock(css, ".title-row h2 {");
  assert.match(title, /min-width: 0/, "title h2 must allow shrink (flex-item min-width:auto blocks ellipsis)");
  assert.match(title, /overflow: hidden/, "title must clip overflow");
  assert.match(title, /text-overflow: ellipsis/, "title must ellipsize");
  assert.match(title, /white-space: nowrap/, "title must stay on one line");
  const { block: count } = extractBlock(css, ".title-row p {");
  assert.match(count, /flex: 0 0 auto/, "count must never cover the title");
});

// 20. The topbar height still references the token. V2 (2026-08-07) deliberately
// changed the token's value from 52px to 56px to fix an 8pt-grid violation the
// original design audit flagged; the token indirection itself is what this locks.
test("20. topbar height still references the token", async () => {
  const css = await readCss();
  const { block } = extractBlock(css, ".topbar {");
  assert.match(block, /height: var\(--topbar-height\)/, ".topbar must consume --topbar-height");
  assert.match(css, /--topbar-height: 56px;/, "the V2 56px token value must be in place");
});

// 21. No overflow / ellipsis menu was introduced.
test("21. no overflow menu was introduced", async () => {
  const topbar = topbarBlock(await readHtml());
  for (const marker of ["overflow-menu", "ellipsis-menu", "more-menu", "kebab", "topbar-menu", "dropdown-menu"]) {
    assert.equal(topbar.includes(marker), false, `topbar must not introduce a ${marker}`);
  }
  const app = await readApp();
  assert.doesNotMatch(app, /overflow-menu|kebab|topbar-menu/, "app.js must not wire an overflow menu");
});

// 22. The search location contract is untouched (sidebar, not topbar).
test("22. the search location contract is untouched", async () => {
  const html = await readHtml();
  const topbar = topbarBlock(html);
  assert.equal(topbar.includes('id="searchInput"'), false, "no search input may return to the topbar");
  const sidebarStart = html.indexOf('<aside class="sidebar"');
  const sidebarEnd = html.indexOf("</aside>", sidebarStart);
  assert.ok(html.slice(sidebarStart, sidebarEnd).includes('id="searchInput"'), "the search input must stay in the sidebar");
  const app = await readApp();
  assert.match(app, /els\.searchInput\?\.addEventListener\("input", debounce/, "search event wiring unchanged");
});

// 23. No !important anywhere in the stylesheet (comments stripped).
test("23. no !important in styles.css", async () => {
  const css = (await readCss()).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(css.includes("!important"), false, "styles.css must not use !important");
});

// 24. Topbar rules consume only defined tokens (no new hex/rgba/shadow/radius systems).
test("24. topbar rules consume only defined tokens", async () => {
  const css = await readCss();
  const ruleBodies = [];
  for (const marker of [".topbar {", ".topbar-context {", ".topbar-actions {", ".topbar-utility-group, .topbar-work-group {", ".topbar-primary-group {", "#bridgeStatusLabel {"]) {
    ruleBodies.push(extractBlock(css, marker).block);
  }
  ruleBodies.push(extractBlock(css, "@media (max-width: 1399px) {").block);
  const consumed = new Set();
  for (const body of ruleBodies) {
    for (const v of body.matchAll(/var\((--[a-z0-9-]+)/gi)) consumed.add(v[1]);
  }
  assert.ok(consumed.size > 0, "topbar rules must consume design tokens");
  for (const token of consumed) {
    assert.ok(css.includes(`${token}:`), `token consumed by topbar rules must be defined: ${token}`);
  }
  // No new raw colour literals inside the new group/label rules.
  for (const body of ruleBodies) {
    assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|rgba?\(/i, "topbar hierarchy rules must not introduce raw colour literals");
  }
});

// 25. Phase 1 and Phase 2A contract suites keep passing.
test("25. Phase 1 and Phase 2A contract suites keep passing", () => {
  const result = spawnSync(process.execPath, [
    "--test",
    "test/ui-component-contract.test.mjs",
    "test/card-action-contract.test.mjs",
    "test/search-location-contract.test.mjs",
  ], { cwd: root, encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  const out = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, `Phase 1/2A contract suites must exit 0:\n${out}`);
});
