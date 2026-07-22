import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("keeps the import flow keyboard-accessible", async () => {
  const [html, app, css] = await Promise.all([
    readFile(resolve(root, "app/index.html"), "utf8"),
    readFile(resolve(root, "app/app.js"), "utf8"),
    readFile(resolve(root, "app/styles.css"), "utf8"),
  ]);

  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="importModalTitle"/);
  assert.match(html, /id="imagePreviewModal" role="dialog" aria-modal="true" aria-labelledby="imagePreviewTitle"/);
  assert.match(html, /id="imagePreviewStage"/);
  assert.match(html, /data-i18n-aria-label="closeImport"/);
  assert.match(html, /data-i18n-aria-label="closePreview"/);
  assert.match(html, /<button class="nav-item active"/);
  assert.match(html, /id="addGroupBtn"/);
  assert.match(html, /id="groupModal"/);
  assert.match(html, /aria-labelledby="groupModalTitle" tabindex="-1"/);
  assert.match(app, /class="asset-card-select" type="button"/);
  assert.doesNotMatch(app, /card-overlay|asset-source-badge/);
  assert.match(html, /id="assetCount" role="status" aria-live="polite"/);
  assert.match(html, /id="bridgeStatus" data-state="checking" role="status" aria-live="polite"/);
  assert.match(app, /function trapImportModalFocus\(event\)/);
  assert.match(app, /function trapGroupModalFocus\(event\)/);
  assert.match(app, /async function saveGroup\(\)/);
  assert.match(app, /function openImagePreview\(id, trigger\)/);
  assert.match(app, /function fitImagePreview\(\)/);
  assert.match(app, /Math\.min\(availableWidth \/ image\.naturalWidth, availableHeight \/ image\.naturalHeight\)/);
  assert.match(app, /imagePreviewStage\?\.addEventListener\("click", \(event\) => \{ if \(event\.target === els\.imagePreviewStage\) closeImagePreview\(\); \}\)/);
  assert.match(app, /function trapImagePreviewFocus\(event\)/);
  assert.match(app, /dblclick/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(css, /button:focus-visible/);
  assert.match(css, /\.image-preview-stage img \{[^}]*max-width: none;[^}]*max-height: none;/);
  assert.match(css, /\.image-preview-stage \{[^}]*padding: clamp\(24px, 5vw, 88px\);/);
  assert.match(css, /@media \(max-width: 700px\)/);
});

test("keeps the gallery source-aware and the inspector optional", async () => {
  const [html, app] = await Promise.all([
    readFile(resolve(root, "app/index.html"), "utf8"),
    readFile(resolve(root, "app/app.js"), "utf8"),
  ]);

  assert.match(html, /id="filterPanel"/);
  assert.match(html, /class="toolbar-filter" id="filterToggle"/);
  assert.match(app, /source", "cowart-generated"/);
  assert.match(app, /function setDetailOpen\(open\)/);
  assert.match(app, /state\.detailOpen = Boolean\(open\)/);
  assert.match(app, /function updateSelectedCard\(\)/);
  assert.match(app, /updateSelectedCard\(\);/);
  assert.match(app, /function renderFilterPanel\(\)/);
  assert.match(app, /function positionFilterPanel\(\)/);
  assert.match(app, /\["cowart", t\("filterCowart"\)/);
});

test("keeps background library refreshes from replacing active edits", async () => {
  const app = await readFile(resolve(root, "app/app.js"), "utf8");

  assert.match(app, /detailDirty: false/);
  assert.match(app, /requestId !== assetRequestSequence/);
  assert.match(app, /!options\.background \|\| assetsChanged/);
  assert.match(app, /selectedChanged && !isDetailEditorActive\(\)/);
  assert.match(app, /state\.loadedPageCount > 1 \? Promise\.resolve\(true\) : loadAssets\(\{ background: true \}\)/);
  assert.match(app, /field\.addEventListener\("input", \(\) => \{ state\.detailDirty = true; \}\)/);
});

test("keeps the Cowart reuse path wired through the local server", async () => {
  const [app, server] = await Promise.all([
    readFile(resolve(root, "app/app.js"), "utf8"),
    readFile(resolve(root, "server.mjs"), "utf8"),
  ]);

  assert.match(app, /dataset\.action = "insert-cowart"/);
  assert.match(app, /data-cowart-insert-target/);
  assert.match(app, /\/insert-cowart/);
  assert.match(server, /insert_cowart_image/);
  assert.match(server, /mosaAssetId/);
  assert.match(server, /Cowart insertion target is not registered/);
});

test("uses a single language chosen from system, Chinese, or English", async () => {
  const [html, app] = await Promise.all([
    readFile(resolve(root, "app/index.html"), "utf8"),
    readFile(resolve(root, "app/app.js"), "utf8"),
  ]);

  assert.match(html, /data-locale="system"/);
  assert.match(html, /data-locale="zh"/);
  assert.match(html, /data-locale="en"/);
  assert.match(app, /safeStorageGet\("mosa\.ui-language"\)/);
  assert.match(app, /function resolveLocale\(value\)/);
  assert.match(app, /function applyLanguage\(\)/);
  assert.match(app, /data-project-select/);
  assert.match(app, /data-open-library/);
  assert.match(app, /data-language-menu/);
  assert.match(app, /function positionLanguageMenu\(\)/);
  assert.match(app, /document\.documentElement\.lang/);
  assert.match(app, /data-cowart-canvas-form/);
  assert.match(app, /data-remove-cowart-canvas/);
  assert.match(app, /\/api\/cowart-canvases/);
});
