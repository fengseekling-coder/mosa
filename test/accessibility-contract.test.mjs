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
  assert.match(html, /aria-label="关闭导入素材窗口"/);
  assert.match(html, /<button class="nav-item active"/);
  assert.match(app, /class="asset-card-select" type="button"/);
  assert.match(html, /id="assetCount" role="status" aria-live="polite"/);
  assert.match(app, /function trapImportModalFocus\(event\)/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(css, /button:focus-visible/);
  assert.match(css, /@media \(max-width: 640px\)/);
});
