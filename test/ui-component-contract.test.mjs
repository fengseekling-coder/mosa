import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const readCss = () => readFile(resolve(root, "app/styles.css"), "utf8");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** WCAG relative luminance for an opaque sRGB hex colour. */
function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Emulates `color-mix(in srgb, hex P%, black)` channel-wise. */
function mixWithBlack(hex, percent) {
  const channels = [1, 3, 5].map((offset) => Math.round(Number.parseInt(hex.slice(offset, offset + 2), 16) * percent / 100));
  return `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Extracts a `{...}` block starting at the marker, honouring nested braces. */
function extractBlock(css, marker) {
  const start = css.indexOf(marker);
  assert.ok(start > -1, `block not found: ${marker}`);
  let i = start + marker.length;
  let depth = 1;
  while (depth > 0 && i < css.length) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") depth -= 1;
    i += 1;
  }
  assert.equal(depth, 0, `unbalanced braces in block: ${marker}`);
  return { block: css.slice(start, i), rest: css.slice(0, start) + css.slice(i) };
}

function readToken(css, name) {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i").exec(css);
  assert.ok(match, `token --${name} not found`);
  return match[1];
}

const CONTRACT_MARKER = "/* ===== 按钮原语契约（Phase 1B） =====";
const RESPONSIVE_MARKER = "/* ===== 响应式 ===== */";

function contractSection(css) {
  const start = css.indexOf(CONTRACT_MARKER);
  const end = css.indexOf(RESPONSIVE_MARKER);
  assert.ok(start > -1 && end > start, "the Phase 1B contract section must precede the responsive section");
  return css.slice(start, end);
}

// The thirteen legacy button families inventoried in Phase 1B.
const FAMILIES = [
  "icon-button", "toolbar-icon", "toolbar-filter", "create-button", "action-btn",
  "recipe-save-btn", "btn-primary", "btn-secondary", "batch-bar-btn", "mini-btn",
  "settings-trigger", "add-group-button", "browse-btn",
];

test("the six button primitives are declared in the contract section", async () => {
  const section = contractSection(await readCss());
  for (const primitive of ["Button", "IconButton", "ToolbarButton", "DestructiveButton", "MenuItem", "InlineAction"]) {
    assert.ok(section.includes(primitive), `primitive ${primitive} is missing from the contract mapping`);
  }
  // Representative selectors for each primitive consume the shared rules.
  for (const selector of [
    ".btn-primary, .create-button, .action-btn.primary", // Button primary
    ".btn-secondary, .detail-close", // Button secondary
    ".icon-button:not(.quiet)", // IconButton
    ".icon-button.quiet", // IconButton quiet
    ".toolbar-icon, .toolbar-filter", // ToolbarButton
    ".action-btn.danger, .batch-bar-btn.danger", // DestructiveButton
    ".nav-item:not(.active), .settings-trigger", // MenuItem
    ".filter-chip-clear", // InlineAction
  ]) {
    assert.ok(section.includes(selector), `contract selector missing: ${selector}`);
  }
});

test("every legacy button family is mapped into the contract", async () => {
  const section = contractSection(await readCss());
  for (const family of FAMILIES) {
    assert.ok(section.includes(`.${family}`), `legacy family .${family} is not mapped in the contract section`);
  }
  // Companion classes that share the families' contract.
  for (const companion of ["section-head-copy", "detail-close", "detail-fav-btn", "filter-chip-clear", "asset-load-more", "recipe-snapshot-footer", "error-state"]) {
    assert.ok(section.includes(companion), `companion class ${companion} is not covered`);
  }
});

test("no !important is used anywhere in the stylesheet", async () => {
  const css = await readCss();
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(withoutComments, /!important/, "stylesheet must stay free of !important");
});

test("focus-visible contract: unified ring token plus a visible on-media ring", async () => {
  const css = await readCss();
  assert.match(css, /button:focus-visible[^{]*\{ outline: 2px solid var\(--color-focus-ring\); outline-offset: 2px; \}/,
    "the global focus-visible rule must use --color-focus-ring at 2px with a 2px offset");
  // The on-media ring token is defined in both theme blocks.
  const { block: light } = extractBlock(css, ':root[data-theme="light"] {');
  const { block: dark } = extractBlock(css, ':root[data-theme="dark"] {');
  assert.match(light, /--color-focus-ring-on-media:\s*#ffffff/, "light theme must define the on-media ring");
  assert.match(dark, /--color-focus-ring-on-media:\s*#ffffff/, "dark theme must define the on-media ring");
  assert.match(css, /\.image-preview-modal button:focus-visible \{ outline-color: var\(--color-focus-ring-on-media\); \}/,
    "the media viewer must override the ring colour because the light-theme blue ring is only 2.60:1 on the black stage");
});

test("button family hover rules only exist inside the precise-pointer media query", async () => {
  const css = await readCss();
  const { block, rest } = extractBlock(css, "@media (hover: hover) and (pointer: fine) {");
  for (const family of FAMILIES.concat(["section-head-copy", "detail-close", "detail-fav-btn", "filter-chip-clear"])) {
    const hoverUse = new RegExp(`\\.${family}[^,{]*:hover`);
    assert.doesNotMatch(rest, hoverUse, `.${family}:hover must live inside @media (hover: hover) and (pointer: fine)`);
    assert.match(block, new RegExp(`\\.${family.replace("-", "\\-")}`), `.${family} must be covered by the wrapped hover rules`);
  }
  // Touch-device stickiness is avoided by gating every hover state on the media query.
  const inner = block.slice(block.indexOf("{") + 1);
  assert.doesNotMatch(inner, /@media/, "hover media block must not nest further media queries");
});

test("hover and active rules suppress disabled controls", async () => {
  const css = await readCss();
  const { block } = extractBlock(css, "@media (hover: hover) and (pointer: fine) {");
  for (const line of block.split("\n").filter((l) => l.includes(":hover"))) {
    assert.ok(line.includes(":not(:disabled):not([aria-disabled=\"true\"])"),
      `hover rule must guard disabled state: ${line.trim()}`);
  }
  const section = contractSection(css);
  const activeRules = section.split("\n").filter((l) => l.includes(":active") && !l.includes("--color-accent-active") && !l.includes("accent-active)"));
  assert.ok(activeRules.length >= 6, "expected explicit :active feedback rules for every primitive group");
  for (const line of activeRules) {
    assert.ok(line.includes(":not(:disabled):not([aria-disabled=\"true\"])"),
      `active rule must guard disabled state: ${line.trim()}`);
  }
});

test("disabled and aria-disabled share one contract", async () => {
  const section = contractSection(await readCss());
  assert.match(section, /\):disabled,\s*:where\([^)]*\)\[aria-disabled="true"\] \{\s*cursor: not-allowed;\s*opacity: \.48;\s*\}/,
    "native :disabled and [aria-disabled=\"true\"] must resolve to the same not-allowed + opacity contract");
  // Disabled is more than opacity alone.
  assert.match(section, /cursor: not-allowed/, "disabled controls must not keep a pointer cursor");
});

test("busy/loading contract is visual-only and keeps button width stable", async () => {
  const section = contractSection(await readCss());
  const busy = /:where\([^)]*\)\[aria-busy="true"\] \{\n([^}]*)\}/.exec(section);
  assert.ok(busy, "an [aria-busy=\"true\"] contract rule must exist");
  assert.match(busy[1], /cursor: wait/, "busy controls expose a wait cursor");
  assert.doesNotMatch(busy[1], /width|padding|border|margin|font/,
    "the busy state must not change geometry, so buttons keep their width while loading");
  // The busy cursor must win over the disabled not-allowed cursor for parity with
  // the legacy `.recipe-save-btn:disabled { cursor: wait; }` behaviour.
  assert.ok(section.indexOf('[aria-busy="true"] {') > section.indexOf("cursor: not-allowed"),
    "the busy rule must come after the disabled rule to keep the wait cursor during busy saves");
  // aria-busy already has a live consumer in the save flow.
  const app = await readFile(resolve(root, "app/app.js"), "utf8");
  assert.match(app, /aria-busy/, "app.js must keep driving aria-busy for the busy contract");
});

test("no undefined tokens are consumed", async () => {
  const css = await readCss();
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const defined = new Set([...withoutComments.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
  const missing = new Set();
  // Only fallback-free var() references must resolve.
  for (const match of withoutComments.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g)) {
    if (!defined.has(match[1])) missing.add(match[1]);
  }
  assert.deepEqual([...missing], [], `undefined tokens referenced: ${[...missing].join(", ")}`);
});

test("dark-theme accent button text meets WCAG AA 4.5:1", async () => {
  const css = await readCss();
  const { block: dark } = extractBlock(css, ':root[data-theme="dark"] {');
  const accent = readToken(dark, "color-accent");
  const hover = readToken(dark, "color-accent-hover");
  // V2 (2026-08-07): dark accent is now a light burnt-peach (#d68f60), so a white
  // foreground no longer clears AA — the token switched to a warm near-black
  // (#241108) instead. The ratio math below still enforces the real 4.5:1 floor.
  const contrastFg = readToken(dark, "color-accent-contrast");
  assert.equal(contrastFg, "#241108", "the V2 warm-dark foreground is kept");
  assert.ok(contrastRatio(contrastFg, accent) >= 4.5, `foreground on dark accent is ${contrastRatio(contrastFg, accent).toFixed(2)}:1`);
  assert.ok(contrastRatio(contrastFg, hover) >= 4.5, `foreground on dark accent-hover is ${contrastRatio(contrastFg, hover).toFixed(2)}:1`);
  // The pressed fill derived by color-mix must stay above the floor as well.
  const active = mixWithBlack(accent, 88);
  assert.ok(contrastRatio(contrastFg, active) >= 4.5, `foreground on dark primary-active ${active} is ${contrastRatio(contrastFg, active).toFixed(2)}:1`);
  // Destructive pressed fill keeps white text readable.
  const error = readToken(dark, "color-danger");
  const dangerActive = mixWithBlack(error, 55);
  assert.ok(contrastRatio("#ffffff", dangerActive) >= 4.5, `white on dark destructive-active ${dangerActive} is ${contrastRatio("#ffffff", dangerActive).toFixed(2)}:1`);
  // Destructive hover text on the subtle danger wash.
  const errorInk = readToken(dark, "error-ink");
  const errorSubtle = readToken(dark, "error-subtle");
  assert.ok(contrastRatio(errorInk, errorSubtle) >= 4.5, `dark error-ink on error-subtle is ${contrastRatio(errorInk, errorSubtle).toFixed(2)}:1`);
});

test("light-theme accent button text meets WCAG AA 4.5:1", async () => {
  const css = await readCss();
  const { block: light } = extractBlock(css, ':root[data-theme="light"] {');
  const accent = readToken(light, "color-accent");
  const hover = readToken(light, "color-accent-hover");
  assert.ok(contrastRatio("#ffffff", accent) >= 4.5, `white on light accent is ${contrastRatio("#ffffff", accent).toFixed(2)}:1`);
  assert.ok(contrastRatio("#ffffff", hover) >= 4.5, `white on light accent-hover is ${contrastRatio("#ffffff", hover).toFixed(2)}:1`);
  assert.ok(contrastRatio("#ffffff", mixWithBlack(accent, 88)) >= 4.5, "white on light primary-active must pass");
  const error = readToken(light, "color-danger");
  assert.ok(contrastRatio("#ffffff", mixWithBlack(error, 55)) >= 4.5, "white on light destructive-active must pass");
  const errorInk = readToken(light, "error-ink");
  const errorSubtle = readToken(light, "error-subtle");
  assert.ok(contrastRatio(errorInk, errorSubtle) >= 4.5, `light error-ink on error-subtle is ${contrastRatio(errorInk, errorSubtle).toFixed(2)}:1`);
});

test("non-text boundaries and focus indicators reach 3:1", async () => {
  const css = await readCss();
  const { block: light } = extractBlock(css, ':root[data-theme="light"] {');
  const { block: dark } = extractBlock(css, ':root[data-theme="dark"] {');
  // Control boundaries against the surrounding surfaces.
  const darkAccent = readToken(dark, "color-accent");
  for (const surface of ["color-canvas", "color-surface", "color-surface-subtle"]) {
    const ratio = contrastRatio(darkAccent, readToken(dark, surface));
    assert.ok(ratio >= 3, `dark accent boundary on ${surface} is ${ratio.toFixed(2)}:1`);
  }
  const lightAccent = readToken(light, "color-accent");
  for (const surface of ["color-canvas", "color-surface"]) {
    const ratio = contrastRatio(lightAccent, readToken(light, surface));
    assert.ok(ratio >= 3, `light accent boundary on ${surface} is ${ratio.toFixed(2)}:1`);
  }
  // Focus indicators against the colours they sit next to.
  assert.ok(contrastRatio(darkAccent, readToken(dark, "color-surface")) >= 3, "dark focus ring on surface");
  assert.ok(contrastRatio(lightAccent, readToken(light, "color-canvas")) >= 3, "light focus ring on canvas");
  // The on-media ring against the viewer's black stage.
  assert.ok(contrastRatio(readToken(dark, "color-focus-ring-on-media"), "#0b0b0d") >= 3, "white on-media ring on the black stage");
  // Destructive outline against the surfaces it sits on.
  const darkError = readToken(dark, "color-danger");
  assert.ok(contrastRatio(darkError, readToken(dark, "color-surface")) >= 3, "dark destructive border on surface");
  const lightError = readToken(light, "color-danger");
  assert.ok(contrastRatio(lightError, readToken(light, "color-surface")) >= 3, "light destructive border on surface");
});

test("out-of-scope files stay locked and the Phase 1C card contract is stable", async () => {
  // SHA-256 baselines for files no UI phase may touch. app/app.js is intentionally
  // rewritten by Phase 1C (card quick-action DOM contract) and is guarded by
  // test/card-action-contract.test.mjs instead of a hash lock. app/index.html is
  // intentionally migrated by Phase 2A (global search moves into the sidebar, D3)
  // and is guarded by test/search-location-contract.test.mjs instead of a hash lock.
  // app/i18n.mjs is intentionally extended by Phase 3A (four view-mode keys, zh+en):
  // parity is guarded by card-action-contract #18 and the new keys are locked by
  // test/large-view-mode-contract.test.mjs instead of a hash lock.
  const expected = {
    "server.mjs": "9fac240976af00ddc6979958aabb225d33f432db2cbca60c420a8b72453ba29b",
    "package.json": "e161974a477853703cc88724de39805fe5c65e590bd331060a17be6d087a2f24",
    "package-lock.json": "50a7d029b6aed62fd921ca013f00dba1b01d2ce96009792fb69c63207a04c8dd",
  };
  for (const [file, hash] of Object.entries(expected)) {
    const text = await readFile(resolve(root, file), "utf8");
    assert.equal(sha256(text), hash, `${file} must stay untouched`);
  }
  // The Phase 1C/1C.1 card quick-action contract rules are locked verbatim against drift.
  // Phase 1C.1 re-locks: child-button disclosure granularity, 28px click area (Phase 1B
  // compatible IconButton floor), and the batch-disabled suppression variants.
  // V2 (2026-08-07) deliberately restyled .card-actions/.card-action-btn (dark floating
  // chips replace the bordered surface buttons, 32px click area, 8px gap) — the two
  // strings below were updated to match; the disclosure-behaviour rules (favorite-visible,
  // batch-disabled suppression) were not touched and stay verbatim.
  const css = await readCss();
  for (const rule of [
    ".card-actions { position: absolute; z-index: var(--z-card-overlay); top: var(--space-1); right: var(--space-1); display: flex; gap: var(--space-1); pointer-events: none; }",
    ".card-action-btn { display: grid; width: 32px; height: 32px; padding: 0; place-items: center; border: 0; border-radius: var(--radius-card); color: var(--color-media-text); background: var(--chip-dark); cursor: pointer; transition: opacity var(--duration-normal) var(--ease-standard), background-color var(--duration-fast) var(--ease-standard); }",
    ".card-action-btn.card-favorite.is-fav { color: var(--favorite); }",
    ".batch-active .asset-card .card-action-btn, .batch-active .asset-card:hover .card-action-btn, .batch-active .asset-card:focus-within .card-action-btn, .batch-active .asset-card.selected .card-action-btn { opacity: 0; pointer-events: none; }",
  ]) {
    assert.ok(css.includes(rule), `card quick-action contract rule must stay verbatim: ${rule.slice(0, 48)}…`);
  }
});
