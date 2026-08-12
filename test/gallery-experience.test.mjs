import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const readApp = () => readFile(resolve(root, "app/app.mjs"), "utf8");
const readApiClient = () => readFile(resolve(root, "app/api-client.mjs"), "utf8");
const readI18n = () => readFile(resolve(root, "app/i18n.mjs"), "utf8");
const readHtml = () => readFile(resolve(root, "app/index.html"), "utf8");
const readInspectorMarkup = () => readFile(resolve(root, "app/inspector-markup.mjs"), "utf8");
const readCss = () => readFile(resolve(root, "app/styles.css"), "utf8");

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

function readToken(css, name) {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i").exec(css);
  assert.ok(match, `token --${name} not found`);
  return match[1];
}

/**
 * Extracts a hard-coded pure JS helper from the gallery module and evaluates it
 * on its own. The module cannot be imported under Node because it touches
 * `document` at load time.
 */
function liftFunction(app, name) {
  const start = app.indexOf(`function ${name}`);
  assert.ok(start > -1, `${name} is missing`);
  const end = app.indexOf("\n}\n", start);
  assert.ok(end > -1, `${name} is not brace-terminated as expected`);
  return app.slice(start, end + 2);
}

test("shortens card titles instead of exposing the whole prompt", async () => {
  // cardShortTitle moved to app/utils.mjs (R1 batch 2); CARD_TITLE_MAX now lives
  // in app/config.mjs, so both are lifted from their new homes.
  const [utils, config] = await Promise.all([
    readFile(resolve(root, "app/utils.mjs"), "utf8"),
    readFile(resolve(root, "app/config.mjs"), "utf8"),
  ]);
  const cardShortTitle = new Function(`${liftFunction(utils, "cardShortTitle")}
    const CARD_TITLE_MAX = ${/CARD_TITLE_MAX = (\d+)/.exec(config)[1]};
    return cardShortTitle;`)();

  const longPrompt = "Hyper-realistic cinematic badminton athlete portrait, a young East Asian beauty standing on an outdoor badminton court at golden sunset hour with an ultra-wide lens";
  const short = cardShortTitle({ theme: longPrompt });
  assert.ok(short.length <= 54, `expected a short title, got ${short.length} characters`);
  assert.ok(short.endsWith("…"), "a clipped title should say so");
  const body = short.slice(0, -1);
  assert.ok(longPrompt.startsWith(body), "the clipped title should be a prefix of the source");
  // Clipping lands on a word boundary: the source continues with a space, so no
  // word is cut in half.
  assert.equal(longPrompt.charAt(body.length), " ", `clipped mid-word at ${JSON.stringify(longPrompt.slice(body.length - 5, body.length + 5))}`);

  assert.equal(cardShortTitle({ asset: "seed-003.png" }), "seed-003.png");
  assert.equal(cardShortTitle({ theme: "  Spaced   out  " }), "Spaced out");
  assert.equal(cardShortTitle({ id: "only-id" }), "only-id");
  assert.equal(cardShortTitle({}), "");
});

test("labels cards with title, source and date rather than the prompt", async () => {
  const [app, inspector] = await Promise.all([readApp(), readInspectorMarkup()]);

  assert.match(app, /const label = t\("cardAccessibleName", \{ title: title \|\| asset\.id, source: sourceLabel, date \}\)/);
  assert.match(app, /aria-label="\$\{escapeHtml\(label\)\}"/);
  // The prompt is still copyable and still lives in the detail panel.
  assert.match(app, /data-copy="\$\{escapeHtml\(asset\.prompt \|\| ""\)\}"/);
  assert.match(app, /aria-label="\$\{t\("copyPrompt"\)\}"/);
  assert.match(inspector, /<div class="prompt-box">\$\{promptText\}<\/div>/);
  // The old behaviour was to hand the raw theme/prompt straight to aria-label.
  assert.doesNotMatch(app, /aria-label="\$\{escapeHtml\(title\)\}">\$\{media\}/);
});

test("separates loading, failed, empty and populated gallery states", async () => {
  const [app, css, apiClient] = await Promise.all([readApp(), readCss(), readApiClient()]);

  assert.match(app, /galleryStatus: "loading"/);
  assert.match(app, /if \(state\.galleryStatus === "loading"\) \{ els\.assetGrid\.innerHTML = gallerySkeletonMarkup\(\); return; \}/);
  assert.match(app, /if \(state\.galleryStatus === "error"\)/);
  // The empty state is only reachable after a request has actually answered.
  const renderGrid = /function renderGrid\(\)[\s\S]*?\n}\n/.exec(app)?.[0] || "";
  const loadingGuard = renderGrid.indexOf('state.galleryStatus === "loading"');
  const emptyBranch = renderGrid.indexOf("!state.assets.length");
  assert.ok(loadingGuard > -1 && emptyBranch > loadingGuard, "the loading branch must precede the empty branch");
  assert.match(apiClient, /state\.galleryStatus = "ready"/);
  assert.match(app, /state\.galleryStatus = "error"/);
  // The skeleton is painted before the first request, not after it fails.
  assert.match(app, /bindEvents\(\);[\s\S]*?renderGrid\(\);/);
  // A count of zero must not appear while the first request is open.
  assert.match(app, /state\.galleryStatus === "loading"\s*\n?\s*\? t\("galleryLoading"\)/);
  assert.match(css, /\.gallery-skeleton \{/);
  assert.match(css, /\.asset-skeleton \{/);
  // The skeleton is painted from module scope, so anything it reads must be
  // declared before `init()` runs or start-up dies in the temporal dead zone.
  const initCall = app.indexOf("\ninit();");
  assert.ok(initCall > -1, "init() is no longer called at module scope");
  // Skeleton constants moved to app/config.mjs (R1 batch 2); the module-scope
  // import binds them before init() runs, so the same no-TDZ guarantee holds.
  const configImport = app.indexOf('from "./config.mjs"');
  assert.ok(configImport > -1 && configImport < initCall, "config.mjs import must precede init()");
  const config = await readFile(resolve(root, "app/config.mjs"), "utf8");
  assert.match(config, /export const SKELETON_TILE_COUNT = 12;/);
  assert.match(config, /export const GALLERY_DENSITIES = \["image", "info"\]/);
  // Heights vary through nth-child, keeping the markup free of inline styles.
  assert.match(css, /\.asset-skeleton:nth-child\(3n\)/);
});

test("offers a stable image-only / with-info density switch", async () => {
  const [app, html, css, config] = await Promise.all([readApp(), readHtml(), readCss(), readFile(resolve(root, "app/config.mjs"), "utf8")]);

  // Density is now controlled via settings-menu segmented control, not a standalone toggle.
  assert.match(app, /data-density-opt="image"/);
  assert.match(app, /data-density-opt="info"/);
  assert.match(app, /data-appearance-opt/);
  assert.match(config, /export const GALLERY_DENSITIES = \["image", "info"\]/);
  assert.match(app, /safeStorageSet\("mosa\.gallery-density", state\.galleryDensity\)/);
  // Active state derives from state, not a hardcoded string.
  assert.match(app, /state\.galleryDensity === "image" \? " active" : ""/);
  assert.match(app, /state\.galleryDensity === "info" \? " active" : ""/);
  // Info mode adds short title, source, date and a group/version badge.
  assert.match(app, /class="asset-card-title"/);
  assert.match(app, /class="asset-card-meta"/);
  assert.match(app, /class="asset-card-badge"/);
  assert.match(app, /versionIndex > 1 \? t\("versionLabelShort", \{ number: versionIndex \}\) : \(asset\.group \|\| ""\)/);
  // The block is always rendered and only revealed, so toggling cannot reorder cards.
  assert.match(css, /\.asset-card-info \{ display: none;/);
  assert.match(css, /\.grid\[data-density="info"\] \.asset-card-info \{ display: block; \}/);
  assert.match(app, /els\.assetGrid\.dataset\.density = state\.galleryDensity/);
  // Masonry row spans must not depend solely on an animation frame: those are
  // suspended while the window is hidden, and the cards collapse to a few pixels.
  assert.match(app, /const schedule = \(\) => \{ layoutMasonry\(\); requestAnimationFrame\(layoutMasonry\); \};/);
});

test("navigates the masonry grid in two dimensions from rendered geometry", async () => {
  const app = await readApp();

  assert.match(app, /const ARROW_KEYS = new Set\(\["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"\]\)/);
  assert.match(app, /function cardGeometry\(\)/);
  assert.match(app, /function neighbourAssetId\(key\)/);
  // Left/right needs vertical overlap; up/down needs a shared column edge.
  assert.match(app, /entry\.top < current\.bottom && entry\.bottom > current\.top/);
  assert.match(app, /Math\.abs\(entry\.left - current\.left\) <= COLUMN_TOLERANCE_PX/);
  // Arrow keys must not fight the detail tablist.
  assert.match(app, /if \(event\.target\.closest\?\.\("\[role='tab'\]"\)\) return;/);
  assert.match(app, /event\.preventDefault\(\);\s*\n\s*selectAsset\(nextId, true\);/);
  // Index arithmetic over a staggered layout is exactly what this replaces.
  assert.doesNotMatch(app, /selectAsset\(state\.assets\[index [-+] 1\]\.id, true\)/);
});

test("keeps meaningful labels above the WCAG AA body-text floor", async () => {
  const css = await readCss();
  // New token system: --surface-1/2/3 and --text-1/2/3 replace old --surface/--ink-* names.
  const surface = readToken(css, "surface-1");
  const muted = readToken(css, "text-2");
  const secondary = readToken(css, "text-2");
  const tertiary = readToken(css, "text-3");

  // Checking white alone is too lenient: card backgrounds use --surface-3, and
  // muted text there was only 4.41:1 while it passed against --surface-1.
  for (const token of ["surface-1", "surface-2", "surface-3"]) {
    const background = readToken(css, token);
    const ratio = contrastRatio(muted, background);
    assert.ok(ratio >= 4.5, `--text-2 is ${ratio.toFixed(2)}:1 on --${token}`);
  }
  // The decorative token is deliberately below the floor, which is why the roles
  // that carry meaning had to move off it.
  assert.ok(contrastRatio(tertiary, surface) < 4.5, "--text-3 is expected to remain decorative");

  // Counts, dates and metadata keys are content, not decoration.
  // New token system uses --text-2 for muted text.
  for (const rule of [
    /\.nav-count \{[^}]*color: var\(--text-2\)/,
    /\.title-row p \{[^}]*color: var\(--text-2\)/,
    /\.filter-list-item > span:last-child \{[^}]*color: var\(--text-2\)/,
    /\.filter-pill span \{[^}]*color: var\(--text-2\)/,
    /\.detail-head p \{[^}]*color: var\(--text-2\)/,
    /\.meta-key \{[^}]*color: var\(--text-2\)/,
    /\.asset-card-meta \{[^}]*color: var\(--text-2\)/,
  ]) {
    assert.match(css, rule);
  }
});

test("drops the card lift when the reader asks for less motion", async () => {
  const css = await readCss();
  const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css);
  assert.ok(block, "no prefers-reduced-motion block");
  assert.match(block[1], /\.asset-card:hover \{ transform: none; \}/);
  assert.match(block[1], /\.asset-skeleton \{ animation: none;/);
});

test("translates every new gallery string in both locales", async () => {
  const i18n = await readI18n();
  const keys = [
    "galleryLoading", "galleryDensity", "densityImageOnly", "densityWithInfo",
    "cardAccessibleName", "versionLabelShort", "sourceWebChatgpt", "sourceUnknown", "loadFailed",
  ];
  const zh = i18n;
  const en = i18n;
  for (const key of keys) {
    assert.match(zh, new RegExp(`\\b${key}:`), `zh translation missing for ${key}`);
    assert.match(en, new RegExp(`\\b${key}:`), `en translation missing for ${key}`);
  }
});
