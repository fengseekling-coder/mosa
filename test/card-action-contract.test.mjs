import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const readCss = () => readFile(resolve(root, "app/styles.css"), "utf8");
const readApp = () => readFile(resolve(root, "app/app.mjs"), "utf8");
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

/** The Phase 1C/1C.1 disclosure section between its marker and the responsive section. */
function disclosureSection(css) {
  const start = css.indexOf("/* ===== 卡片快捷操作披露契约（Phase 1C / Phase 1C.1 收口） =====");
  const end = css.indexOf("/* ===== 响应式 ===== */");
  assert.ok(start > -1 && end > start, "the Phase 1C disclosure section must precede the responsive section");
  return css.slice(start, end);
}

/** Collects every `selector { body }` rule whose selector mentions the card actions. */
function cardActionRules(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].includes(".card-actions") || match[1].includes(".card-action-btn")) {
      rules.push({ selector: match[1].trim(), body: match[2] });
    }
  }
  return rules;
}

// 1. renderGrid() renders the .card-actions container.
test("1. app.js renders the .card-actions container", async () => {
  const app = await readApp();
  assert.match(app, /const cardActions = `<div class="card-actions">\$\{favBtn\}\$\{copyBtn\}<\/div>`;/,
    "renderGrid must wrap both quick actions in a single .card-actions container");
  assert.match(app, /\$\{info\}\$\{cardActions\}<\/article>/,
    "the container must live inside the card article, after the info block");
});

// 2. Both quick actions sit inside that container (and only there).
test("2. favorite and copy buttons are both inside .card-actions", async () => {
  const app = await readApp();
  const container = /<div class="card-actions">([\s\S]*?)<\/div>/.exec(app);
  assert.ok(container, ".card-actions container must exist in the render template");
  assert.ok(container[1].includes("${favBtn}"), "favorite button must be inside .card-actions");
  assert.ok(container[1].includes("${copyBtn}"), "quick-copy button must be inside .card-actions");
  // The buttons must not also be emitted loose inside the article template.
  const article = /return `<article([\s\S]*?)<\/article>`;/.exec(app);
  assert.ok(article, "article template must exist");
  assert.equal(article[1].includes("${favBtn}"), false, "favorite button must not be emitted outside the container");
  assert.equal(article[1].includes("${copyBtn}"), false, "copy button must not be emitted outside the container");
});

// 3. Both buttons carry the shared .card-action-btn class plus their business class.
test("3. both buttons carry .card-action-btn and keep their business classes", async () => {
  const app = await readApp();
  assert.match(app, /class="card-action-btn card-favorite/, "favorite keeps .card-favorite beside .card-action-btn");
  assert.match(app, /class="card-action-btn card-quick-copy"/, "copy keeps .card-quick-copy beside .card-action-btn");
  // Legacy event bindings depend on the business classes and data attributes.
  assert.match(app, /data-fav-id="\$\{escapeHtml\(asset\.id\)\}"/, "favorite keeps data-fav-id");
  assert.match(app, /data-copy="\$\{escapeHtml\(asset\.prompt \|\| ""\)\}"/, "copy keeps data-copy");
});

// 4. Both quick actions are native buttons with type="button" (no div/span fakes).
test("4. both quick actions are native type=\"button\" buttons", async () => {
  const app = await readApp();
  const fav = /const favBtn = `<button([\s\S]*?)<\/button>`;/.exec(app);
  const copy = /const copyBtn = `<button([\s\S]*?)<\/button>`;/.exec(app);
  assert.ok(fav && copy, "both quick actions must be rendered as <button> elements");
  assert.match(fav[1], /type="button"/, "favorite button needs type=\"button\"");
  assert.match(copy[1], /type="button"/, "copy button needs type=\"button\"");
  assert.doesNotMatch(app, /<(div|span)[^>]*class="[^"]*card-action-btn/, "quick actions must not be faked with div/span");
});

// 5. The favorite button exposes aria-pressed and keeps it in sync at render time.
test("5. favorite button renders aria-pressed from the favorite state", async () => {
  const app = await readApp();
  assert.match(app, /aria-pressed="\$\{Boolean\(isFav\)\}"/,
    "favorite button must render aria-pressed=\"true|false\" from isFav");
  // The accessible name flips between add/remove so it describes the current action.
  assert.match(app, /const favoriteLabel = isFav \? t\("removeFavorite"\) : t\("addFavorite"\)/,
    "favorite accessible name must describe the currently executable action");
});

// 6. Both quick actions have accessible names independent of title.
test("6. both quick actions have aria-label accessible names", async () => {
  const app = await readApp();
  const fav = /const favBtn = `<button([\s\S]*?)<\/button>`;/.exec(app);
  const copy = /const copyBtn = `<button([\s\S]*?)<\/button>`;/.exec(app);
  assert.match(fav[1], /aria-label="\$\{escapeHtml\(favoriteLabel\)\}"/, "favorite needs an aria-label");
  assert.match(copy[1], /aria-label="\$\{t\("copyPrompt"\)\}"/, "copy needs an aria-label");
});

// 7. The CSS .card-actions/.card-action-btn selectors match the real DOM classes.
test("7. CSS selectors match the rendered DOM classes", async () => {
  const css = await readCss();
  const app = await readApp();
  assert.match(css, /\.card-actions \{/, "styles.css must style .card-actions");
  assert.match(css, /\.card-action-btn \{/, "styles.css must style .card-action-btn");
  assert.ok(app.includes('class="card-actions"') && app.includes('class="card-action-btn'),
    "app.js must render the same classes the CSS styles (no orphan selectors)");
});

// 8. Precise-pointer hover disclosure: hidden by default, revealed on hover.
//    Phase 1C.1: the disclosure granularity moved from the container to the child buttons.
test("8. precise-pointer hover disclosure exists", async () => {
  const css = await readCss();
  const section = disclosureSection(css);
  const { block } = extractBlock(section, "@media (hover: hover) and (pointer: fine) {");
  assert.match(block, /\.card-action-btn \{ opacity: 0; pointer-events: none; \}/,
    "precise pointers default to subdued, non-interactive quick actions (child-button granularity)");
  assert.match(block, /\.asset-card:hover \.card-action-btn[^{]*\{ opacity: 1; pointer-events: auto; \}/,
    "card hover reveals the quick actions");
});

// 9. :focus-within (and selected / favorited-star) reveal rules exist.
test("9. :focus-within, selected and favorited-star reveal rules exist", async () => {
  const css = await readCss();
  const section = disclosureSection(css);
  const { block } = extractBlock(section, "@media (hover: hover) and (pointer: fine) {");
  for (const selector of [".asset-card:focus-within .card-action-btn", ".asset-card.selected .card-action-btn", ".card-action-btn.card-favorite.is-fav"]) {
    assert.ok(block.includes(selector), `reveal rule missing: ${selector}`);
  }
});

// 10. Coarse-pointer / no-hover fallback keeps the actions visible and tappable.
test("10. coarse pointer / hover none fallback exists", async () => {
  const css = await readCss();
  const section = disclosureSection(css);
  const { block } = extractBlock(section, "@media (hover: none), (pointer: coarse) {");
  assert.match(block, /\.card-action-btn \{ opacity: 1; pointer-events: auto; \}/,
    "touch devices must always see the quick actions");
});

// 11/12. Focusable quick actions are never hidden with display:none or visibility:hidden.
test("11-12. quick actions never use display:none / visibility:hidden", async () => {
  const css = await readCss();
  const rules = cardActionRules(css);
  assert.ok(rules.length >= 4, "expected several .card-actions/.card-action-btn rules");
  for (const rule of rules) {
    assert.doesNotMatch(rule.body, /display:\s*none/, `display:none is forbidden for focusable actions: ${rule.selector}`);
    assert.doesNotMatch(rule.body, /visibility:\s*hidden/, `visibility:hidden is forbidden for focusable actions: ${rule.selector}`);
  }
  const app = await readApp();
  assert.doesNotMatch(app, /card-action-btn[^>]*tabindex="-1"/, "quick actions must stay in the tab order");
  assert.doesNotMatch(app, /card-action-btn[^>]*\shidden[\s>]/, "the hidden attribute is forbidden on quick actions");
});

// 13. The stylesheet stays free of !important.
test("13. no !important anywhere in the stylesheet", async () => {
  const css = await readCss();
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(withoutComments, /!important/, "stylesheet must stay free of !important");
});

// 14. The quick actions consume the shared IconButton/primitive state contract.
// 14. Quick actions consume the Phase 1B IconButton state contract.
// 2026-08-18: V2-only token consolidation. The shared hover/active rules
// for the surface IconButton group (where `.card-action-btn` now lives)
// consume V2 semantic tokens (`--color-text-primary`, `--color-border-default`,
// `--app-hover`) instead of the Phase 1A short names (`--text-1`,
// `--border-2`, `--surface-2`). The `.card-action-btn` still joins the
// shared `:where(...)` group; only the token names changed.
test("14. quick actions consume the Phase 1B IconButton state contract", async () => {
  const css = await readCss();
  const contractStart = css.indexOf("/* ===== 按钮原语契约（Phase 1B） =====");
  assert.ok(contractStart > -1, "the Phase 1B contract section must exist");
  const { block: hoverBlock } = extractBlock(css, "@media (hover: hover) and (pointer: fine) {", contractStart);
  assert.ok(hoverBlock.includes(".card-action-btn"), ".card-action-btn must join the shared hover group");
  assert.match(hoverBlock, /color: var\(--color-text-primary\); border-color: var\(--color-border-default\); background: var\(--app-hover\);/,
    "the shared IconButton hover declaration must cover .card-action-btn");
  const activeLine = css.split("\n").find((line) => line.includes(".card-action-btn") && line.includes(":active") && !line.includes(":hover"));
  assert.ok(activeLine, ".card-action-btn must join the shared active (pressed) group");
  assert.ok(activeLine.includes(":not(:disabled):not([aria-disabled=\"true\"])"),
    "the shared active rule must keep its disabled guard for .card-action-btn");
});

// 15. Reduced-motion contract: disclosure and state transitions are cancelled.
test("15. reduced-motion contract covers the quick actions", async () => {
  const css = await readCss();
  const { block } = extractBlock(css, "@media (prefers-reduced-motion: reduce) {");
  assert.match(block, /\.card-actions, \.card-action-btn \{ transition: none; \}/,
    "reduced-motion must cancel the disclosure/state transitions");
});

// 16. Event isolation: favorite/copy handlers keep stopPropagation.
test("16. favorite and copy listeners keep event isolation", async () => {
  const app = await readApp();
  const copyListener = /querySelectorAll\("\.card-quick-copy"\)[\s\S]*?addEventListener\("click", async \(event\) => \{ event\.stopPropagation\(\);/;
  const favListener = /querySelectorAll\("\.card-favorite"\)[\s\S]*?addEventListener\("click", \(event\) => \{ event\.stopPropagation\(\);/;
  assert.match(app, copyListener, "quick-copy click must keep stopPropagation (no detail opening)");
  assert.match(app, favListener, "favorite click must keep stopPropagation (no detail opening)");
});

// 17. No API, data-structure or persistence changes; out-of-scope files stay locked.
test("17. no API, data-structure or persistence changes", async () => {
  // app/index.html was intentionally migrated by Phase 2A (global search into the
  // sidebar, D3); its structure is guarded by test/search-location-contract.test.mjs.
  // R1 isolation fix (2026-08-09, approved scope) deliberately changed
  // server.mjs (ERR_ISOLATION_GUARD fail-closed handler) and package.json
  // (qa:web/qa:electron/qa:packaged launcher scripts), so those two files
  // leave the hash table; their security-relevant behaviour is asserted
  // structurally below. The lockfile stays hash-pinned.
  const expected = {
    "package-lock.json": "50a7d029b6aed62fd921ca013f00dba1b01d2ce96009792fb69c63207a04c8dd",
  };
  for (const [file, hash] of Object.entries(expected)) {
    const text = await readFile(resolve(root, file), "utf8");
    assert.equal(sha256(text), hash, `${file} must stay untouched in Phase 1C`);
  }
  // server.mjs must still fail closed when the isolation guard rejects a run.
  const server = await readFile(resolve(root, "server.mjs"), "utf8");
  assert.match(server, /ERR_ISOLATION_GUARD/, "server.mjs must fail closed on isolation guard rejection");
  assert.match(server, /process\.exit\(1\)/, "server.mjs must exit non-zero on isolation guard rejection");
  // package.json dependency sections stay frozen.
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  assert.equal(sha256(JSON.stringify(manifest.dependencies)), "73c83773a57e21a20917d81b24288bdfddd9bb7ddd644fdaedd6e6cfba13c405", "package.json dependencies must stay untouched in Phase 1C");
  assert.equal(sha256(JSON.stringify(manifest.devDependencies)), "24a0c3b9b5c327ef720981045751d87687b51bd41e0e104ed7e0d3127879387b", "package.json devDependencies must stay untouched in Phase 1C");
  const app = await readApp();
  // The favorite flow still posts to the same endpoint; renderGrid stays free of API calls.
  assert.match(app, /apiFetch\(`\/api\/assets\/\$\{encodeURIComponent\(state\.project\)\}\/\$\{encodeURIComponent\(id\)\}\/favorite`, \{ method: "POST" \}\)/,
    "toggleFavorite must keep its existing API endpoint and method");
  const grid = /function renderGrid\(\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(grid, "renderGrid must exist");
  assert.doesNotMatch(grid[0], /\bapi\(/, "renderGrid must not gain API calls");
});

// 18. i18n parity: zh/en key sets match and cover the card quick actions.
test("18. i18n zh/en key parity including quick-action strings", async () => {
  const messages = (await import(resolve(root, "app/i18n.mjs"))).default;
  const zhKeys = Object.keys(messages.zh).sort();
  const enKeys = Object.keys(messages.en).sort();
  assert.deepEqual(zhKeys, enKeys, "zh and en must expose the same key set");
  for (const key of ["addFavorite", "removeFavorite", "copyPrompt", "copySuccess"]) {
    assert.ok(messages.zh[key] && messages.en[key], `missing quick-action i18n key: ${key}`);
  }
});

// 19. Phase 1B contract markers survive (its dedicated suite covers the details).
test("19. Phase 1B contract section survives alongside the card contract", async () => {
  const css = await readCss();
  assert.ok(css.includes("/* ===== 按钮原语契约（Phase 1B） ====="), "Phase 1B contract section marker must survive");
  assert.match(css, /button:focus-visible[^{]*\{ outline: 2px solid var\(--color-focus-ring\); outline-offset: 2px; \}/,
    "the unified focus-visible contract must survive");
});

// 20. No undefined CSS tokens are consumed (fallback-free var() references).
test("20. no undefined CSS tokens are consumed", async () => {
  const css = await readCss();
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const defined = new Set([...withoutComments.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
  const missing = new Set();
  for (const match of withoutComments.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g)) {
    if (!defined.has(match[1])) missing.add(match[1]);
  }
  assert.deepEqual([...missing], [], `undefined tokens referenced: ${[...missing].join(", ")}`);
  // Every token the card contract consumes is explicitly defined.
  for (const token of ["--z-card-overlay", "--space-1", "--color-border-default", "--radius-control", "--color-text-primary", "--color-surface", "--shadow-card", "--duration-fast", "--duration-normal", "--ease-standard", "--color-favorite"]) {
    assert.ok(defined.has(token), `card contract token must be defined: ${token}`);
  }
});

// ===== Phase 1C.1 收口契约 =====

// 21. Favorited card: the copy button is NOT always visible — only the star marks the state.
test("21. favorited card: quick-copy stays progressively disclosed", async () => {
  const css = await readCss();
  const section = disclosureSection(css);
  const { block } = extractBlock(section, "@media (hover: hover) and (pointer: fine) {");
  assert.ok(!section.includes(":has(.is-fav)"),
    "the container-level favorite reveal (:has) must be removed so the whole area no longer stays up");
  assert.doesNotMatch(block, /card-quick-copy[^{]*\{[^}]*opacity: 1/,
    "quick-copy must never get a default-visible rule on precise pointers");
  assert.doesNotMatch(block, /\.card-actions[^{]*\{[^}]*opacity: 1/,
    "no container-level always-visible rule may remain in the precise-pointer block");
});

// 22. The favorited star itself stays visible and directly clickable (favorite state visibility).
test("22. favorited star stays visible by default", async () => {
  const css = await readCss();
  const section = disclosureSection(css);
  const { block } = extractBlock(section, "@media (hover: hover) and (pointer: fine) {");
  assert.match(block, /\.card-action-btn\.card-favorite\.is-fav \{ opacity: 1; pointer-events: auto; \}/,
    "the favorited star must stay visible and clickable on precise pointers");
  // 2026-08-18: V2-only token consolidation. The favorite highlight now
  // consumes `--color-favorite` (the canonical V2 token) instead of the
  // Phase 1A `--favorite` alias.
  assert.match(css, /\.card-action-btn\.card-favorite\.is-fav \{ color: var\(--color-favorite\); \}/,
    "the favorite colour marker must survive on every device (consumes V2 --color-favorite)");
});

// 23-25. hover / focus-within / selected each reveal BOTH quick actions (generic .card-action-btn).
test("23-25. hover, focus-within and selected each reveal both quick actions", async () => {
  const css = await readCss();
  const section = disclosureSection(css);
  const { block } = extractBlock(section, "@media (hover: hover) and (pointer: fine) {");
  // One shared rule targets the generic .card-action-btn, so favorite AND copy both appear.
  assert.ok(block.includes(".asset-card:hover .card-action-btn, .asset-card:focus-within .card-action-btn, .asset-card.selected .card-action-btn { opacity: 1; pointer-events: auto; }"),
    "hover / focus-within / selected must share one reveal rule covering the generic .card-action-btn (both buttons)");
});

// 26. (Retired) Batch mode renders both quick actions disabled.
// 2026-08-18: V2-only token consolidation. The V2 design retired the
// batch-management affordance: no #batchToggle button, no state.batchMode,
// no .batch-active grid class, no renderGrid `batchDisabled` derivation.
// The card quick-actions are now always interactive; multi-select moved to
// the V2 select surface (asset-card.select). This contract documents that
// the legacy batch-mode wiring is gone.

// 27. (Retired) Batch buttons leave the tab order natively.
// 2026-08-18: V2-only token consolidation. The V2 design retired the
// batch-management affordance; the disabled-attribute / tab-order concern
// this test used to guard was removed alongside the batch mode entry
// points. Card quick-actions now stay reactive at all times.

// 28. In batch mode :focus-within must NOT restore the single-card actions.
test("28. batch mode: focus-within does not restore quick actions", async () => {
  const css = await readCss();
  const section = disclosureSection(css);
  for (const variant of [".batch-active .asset-card .card-action-btn", ".batch-active .asset-card:hover .card-action-btn", ".batch-active .asset-card:focus-within .card-action-btn", ".batch-active .asset-card.selected .card-action-btn"]) {
    assert.match(section, new RegExp(variant.replace(/[.:]/g, "\\$&") + "[^{]*\\{ opacity: 0; pointer-events: none; \\}"),
      `batch suppression must cover ${variant} (hidden even on hover/focus-within/selected)`);
  }
  assert.ok(!section.includes(".batch-active .asset-card .card-actions {"), "the old container-level batch rule must be gone");
  assert.ok(!section.includes(".batch-active .asset-card:focus-within .card-actions {"), "the old batch focus-within restore must be gone");
  // The batch affordance itself stays visible and clear.
  assert.match(css, /\.batch-active \.asset-card \.card-checkbox \{ opacity: 1; \}/,
    "batch checkboxes must stay visible in batch mode");
});

// 29. (Retired) Leaving batch mode restores the quick actions.
// 2026-08-18: V2-only token consolidation. The V2 design retired the
// batch-management affordance; setBatchMode and renderGrid no longer
// hold the disabled-attribute derivation this test used to lock.

// 30/31. The click target is at least 28×28px (Phase 1B compatible IconButton floor; 26px forbidden).
test("30-31. quick-action click area is at least 28x28px", async () => {
  const css = await readCss();
  const { block } = extractBlock(css, ".card-action-btn {");
  const width = Number(/width:\s*(\d+)px/.exec(block)?.[1]);
  const height = Number(/height:\s*(\d+)px/.exec(block)?.[1]);
  assert.ok(width >= 28, `click width must be >= 28px (got ${width}px); the 26px target is forbidden`);
  assert.ok(height >= 28, `click height must be >= 28px (got ${height}px); the 26px target is forbidden`);
});

// 32. The icon's visual size stays decoupled from and smaller than the click area.
test("32. icon visual size is decoupled from and smaller than the click area", async () => {
  const css = await readCss();
  const { block: button } = extractBlock(css, ".card-action-btn {");
  const clickSize = Number(/width:\s*(\d+)px/.exec(button)?.[1]);
  const { block: icon } = extractBlock(css, ".card-action-btn svg {");
  const iconWidth = Number(/width:\s*(\d+)px/.exec(icon)?.[1]);
  const iconHeight = Number(/height:\s*(\d+)px/.exec(icon)?.[1]);
  assert.ok(iconWidth >= 14 && iconWidth <= 16, `icon visual size should stay around 14-16px (got ${iconWidth}px)`);
  assert.ok(iconWidth < clickSize && iconHeight < clickSize,
    `icon ${iconWidth}x${iconHeight} must be smaller than the ${clickSize}px click area`);
  const app = await readApp();
  const fav = /const favBtn = `<button([\s\S]*?)<\/button>`;/.exec(app);
  const copy = /const copyBtn = `<button([\s\S]*?)<\/button>`;/.exec(app);
  for (const [name, template] of [["favorite", fav[1]], ["copy", copy[1]]]) {
    const inline = Number(/<svg width="(\d+)"/.exec(template)?.[1]);
    assert.equal(inline, iconWidth, `${name} inline SVG size must mirror the CSS icon size`);
    assert.ok(inline < clickSize, `${name} icon must stay smaller than the click area`);
  }
});
