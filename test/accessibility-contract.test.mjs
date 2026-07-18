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
  assert.match(html, /data-i18n-aria-label="closeImport"/);
  assert.match(html, /<button class="nav-item active"/);
  assert.match(app, /class="asset-card-select" type="button"/);
  assert.match(html, /id="assetCount" role="status" aria-live="polite"/);
  assert.match(app, /function trapImportModalFocus\(event\)/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(css, /button:focus-visible/);
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
  assert.match(app, /document\.documentElement\.lang/);
});
