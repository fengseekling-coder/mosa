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
  const cardShortTitle = new Function(`
    const LEADING_UI_GLYPH_TOKENS = new Set(["play_circle", "play_arrow", "more_vert"]);
    ${liftFunction(utils, "displayAssetTitle")}
    ${liftFunction(utils, "cardShortTitle")}
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
  assert.equal(cardShortTitle({ theme: "play_circle Bears riding surfboards" }), "Bears riding surfboards");
  assert.equal(cardShortTitle({ theme: "more_vert play_arrow Bears riding surfboards" }), "Bears riding surfboards");
  assert.equal(cardShortTitle({ theme: "  Spaced   out  " }), "Spaced out");
  assert.equal(cardShortTitle({ id: "only-id" }), "only-id");
  assert.equal(cardShortTitle({}), "");
});

test("labels cards with title, source and date rather than the prompt", async () => {
  const [app, inspector] = await Promise.all([readApp(), readInspectorMarkup()]);

  assert.match(app, /const label = t\("cardAccessibleName", \{ title: title \|\| asset\.id, source: sourceLabel, date \}\)/);
  assert.match(app, /aria-label="\$\{escapeHtml\(label\)\}"/);
  // The prompt is still copyable and still lives in the detail panel, but it is
  // not duplicated into every card's DOM as a data attribute.
  assert.doesNotMatch(app, /data-copy=/);
  assert.match(app, /const asset = state\.assets\.find\(\(item\) => item\.id === assetId\)/);
  assert.match(app, /writeClipboardText\(asset\?\.prompt \|\| ""\)/);
  assert.match(app, /aria-label="\$\{t\("copyPrompt"\)\}"/);
  assert.match(inspector, /<div class="prompt-box detail-prompt-box"[^>]*>\$\{promptText\}<\/div>/);
  // The old behaviour was to hand the raw theme/prompt straight to aria-label.
  assert.doesNotMatch(app, /aria-label="\$\{escapeHtml\(title\)\}">\$\{media\}/);
});

test("gallery never falls back to a full-resolution original while thumbnails are pending", async () => {
  const [inspector, store] = await Promise.all([
    readInspectorMarkup(),
    readFile(resolve(root, "lib/sqlite-asset-store.mjs"), "utf8"),
  ]);

  assert.match(store, /thumbnail_ready: Boolean\(asset\.thumbnail_path\)/);
  assert.match(inspector, /mode === "thumb" && asset\.thumbnail_ready === false/);
  assert.match(inspector, /image-thumb-pending/);
  assert.match(inspector, /thumbSrcset/);
  assert.match(inspector, /sizes="\(max-width: 720px\) calc\(50vw - 24px\), 240px"/);
});

test("video cards lazily reveal a first-frame poster and adopt the real media aspect ratio", async () => {
  const [app, inspector, css] = await Promise.all([readApp(), readInspectorMarkup(), readCss()]);

  assert.match(inspector, /function videoThumbAspectAttributes\(asset\)/);
  assert.match(inspector, /data-gallery-video-src="\$\{escapeHtml\(asset\.image_url\)\}" preload="none"/);
  assert.match(inspector, /data-video-width="\$\{dimensions\.width\}" data-video-height="\$\{dimensions\.height\}"/);
  assert.match(app, /function bindGalleryVideoFrame\(video\)/);
  assert.match(app, /const width = Number\(video\.videoWidth \|\| 0\)/);
  assert.match(app, /const height = Number\(video\.videoHeight \|\| 0\)/);
  assert.match(app, /const persistedWidth = Number\(frame\?\.dataset\.videoWidth \|\| video\.getAttribute\("width"\) \|\| 0\)/);
  assert.match(app, /frame\.style\.aspectRatio = `\$\{width\} \/ \$\{height\}`/);
  assert.match(app, /video\.currentTime = firstFrameTime/);
  assert.match(app, /video\.classList\.add\("is-frame-ready"\)/);
  assert.match(app, /media\.removeAttribute\("src"\)/, "offscreen video probes must release their source");
  assert.match(app, /video\.thumb-video-frame\[data-gallery-video-src\]/);
  assert.match(css, /\.asset-card\.is-video \.thumb\.video-thumb \{[^}]*aspect-ratio: 16 \/ 9;/);
  assert.match(css, /\.asset-card \.thumb-video-frame\.is-frame-ready \{ opacity: 1; \}/);
  assert.doesNotMatch(css, /\.asset-card\.is-video \.thumb\.video-thumb \{[^}]*aspect-ratio: 16 \/ 10;/);
});

test("separates loading, failed, empty and populated gallery states", async () => {
  const [app, css, apiClient] = await Promise.all([readApp(), readCss(), readApiClient()]);

  assert.match(app, /galleryStatus: "loading"/);
  assert.match(app, /if \(state\.galleryStatus === "loading"\) \{ els\.assetGrid\.innerHTML = gallerySkeletonMarkup\(\); restoreGridFallbackFocus\(\); return; \}/);
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
  // Loading remains announced by the skeleton even though the topbar no longer
  // renders a result/statistics counter.
  assert.match(app, /gallery-skeleton[\s\S]*?t\("galleryLoading"\)/);
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
  const [app, css, config] = await Promise.all([readApp(), readCss(), readFile(resolve(root, "app/config.mjs"), "utf8")]);

  // V2: Density is controlled via settings-menu segmented control
  assert.match(app, /data-density-opt/);
  assert.match(app, /"image".*data-density-opt|data-density-opt.*"image"/);
  assert.match(app, /data-appearance-opt/);
  assert.match(config, /export const GALLERY_DENSITIES = \["image", "info"\]/);
  assert.match(app, /safeStorageSet\("mosa\.gallery-density", state\.galleryDensity\)/);
  // Info mode adds short title, source, date and a group/version badge.
  assert.match(app, /class="asset-card-title"/);
  assert.match(app, /class="asset-card-meta"/);
  assert.match(app, /class="asset-card-badge"/);
  assert.match(app, /versionIndex > 1 \? t\("versionLabelShort", \{ number: versionIndex \}\) : \(asset\.group \|\| ""\)/);
  // The block is always rendered and only revealed, so toggling cannot reorder cards.
  assert.match(css, /\.asset-card-info \{ display: none;/);
  assert.match(css, /\.grid\[data-density="info"\] \.asset-card-info \{ display: block; \}/);
  assert.match(app, /els\.assetGrid\.dataset\.density = state\.galleryDensity/);
  // Masonry row spans must not depend solely on an animation frame: the first
  // full pass is synchronous, while later image decodes repair only their own
  // cards instead of triggering a whole-grid measurement storm.
  assert.match(app, /function setupMasonryLayout\(options = \{\}\) \{[\s\S]*?layoutMasonry\(layoutTargets\);/);
  assert.match(app, /if \(card\) scheduleMasonryLayout\(card\);/);
  assert.doesNotMatch(app, /addEventListener\("load",\s*schedule/);
  // Gallery spacing is one 4px-based token in both axes. The masonry grid keeps
  // row-gap at zero and reserves the same visual gap in each computed row span.
  assert.match(css, /--gallery-gap:\s*12px;/);
  assert.match(css, /\.grid \{[^}]*column-gap: var\(--gallery-gap\); row-gap: 0;/);
  assert.match(css, /\.mosa-v2 \.asset-card \{ margin-bottom: 0;/);
  assert.match(app, /getPropertyValue\("--gallery-gap"\)/);
  assert.match(app, /Math\.ceil\(height \+ galleryGap\)/);
  assert.doesNotMatch(css, /\.mosa-v2 \.grid[^}]*gap: 10px/);
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
  // V2 uses --color-text-primary/secondary/tertiary and --app-* surface tokens
  const appBg = readToken(css, "app-bg");
  const appSidebar = readToken(css, "app-sidebar");
  const appCard = readToken(css, "app-card");
  const textSecondary = readToken(css, "color-text-secondary");
  const textTertiary = readToken(css, "color-text-tertiary");

  // Check contrast ratios for meaningful text on different surfaces
  for (const [token, name] of [["app-bg", appBg], ["app-sidebar", appSidebar], ["app-card", appCard]]) {
    const ratio = contrastRatio(textSecondary, name);
    assert.ok(ratio >= 4.5, `--color-text-secondary is ${ratio.toFixed(2)}:1 on --${token}, needs >= 4.5`);
  }

  // The tertiary token is deliberately below the floor for decorative use
  assert.ok(contrastRatio(textTertiary, appBg) < 4.5, "--color-text-tertiary is expected to remain decorative");

  // Counts, dates and metadata keys use --color-text-secondary for content
  for (const rule of [
    /\.nav-count \{[^}]*color: var\(--color-text-secondary\)/,
    /\.title-row p \{[^}]*color: var\(--color-text-secondary\)/,
    /\.filter-list-item > span:last-child \{[^}]*color: var\(--color-text-secondary\)/,
    /\.filter-pill span \{[^}]*color: var\(--color-text-secondary\)/,
    /\.detail-head p \{[^}]*color: var\(--color-text-secondary\)/,
    /\.meta-key \{[^}]*color: var\(--color-text-secondary\)/,
    /\.asset-card-meta \{[^}]*color: var\(--color-text-secondary\)/,
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
