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
  // Source filtering now runs through the shared facet map instead of a chain of
  // literal params.set calls, but the same three source values stay reachable.
  assert.match(app, /const SOURCE_FACETS = \{[^}]*cowart: "cowart-generated"/);
  assert.match(app, /const SOURCE_FACETS = \{[^}]*grok: "grok-generated"/);
  assert.match(app, /function setDetailOpen\(open\)/);
  assert.match(app, /state\.detailOpen = Boolean\(open\)/);
  assert.match(app, /function updateSelectedCard\(\)/);
  assert.match(app, /updateSelectedCard\(\);/);
  assert.match(app, /function renderFilterPanel\(\)/);
  assert.match(app, /function positionFilterPanel\(\)/);
  assert.match(app, /\["cowart", t\("filterCowart"\)/);
  assert.match(app, /\["grok", t\("filterGrok"\)/);
  assert.match(app, /function isVideoAsset\(/);
  assert.match(app, /function assetMediaPreviewMarkup\(/);
  const i18n = await readFile(resolve(root, "app/i18n.mjs"), "utf8");
  assert.match(i18n, /userInstruction: "用户指令"/);
  assert.match(i18n, /chatgptPromptUnavailable: "ChatGPT 未暴露原始生图提示词"/);
  assert.match(app, /const userInstructionSection = userInstruction/);
  // Global bridge health ignores Grok-only failures while still exposing Grok metadata.
  assert.match(app, /const hasError = codex\?\.lastError \|\| cowart\?\.lastError;/);
  assert.doesNotMatch(app, /const hasError = codex\?\.lastError \|\| grok\?\.lastError \|\| cowart\?\.lastError;/);
  assert.match(app, /if \(grok\?\.lastWarning\) meta\.push\(String\(grok\.lastWarning\)\);/);
  assert.match(app, /if \(grok\?\.lastError\) meta\.push\(String\(grok\.lastError\)\);/);
  assert.match(app, /else if \(codexOn && cowartOn && state\.cowartInsertAvailable\) setStatus\(t\("statusReady"\), "ok"\);/);
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

test("keeps the Cowart reuse path wired through the local runtime", async () => {
  const [app, runtime, assetRoutes] = await Promise.all([
    readFile(resolve(root, "app/app.js"), "utf8"),
    readFile(resolve(root, "lib/mosa-runtime.mjs"), "utf8"),
    readFile(resolve(root, "lib/api/asset-routes.mjs"), "utf8"),
  ]);

  assert.match(app, /dataset\.action = "insert-cowart"/);
  assert.match(app, /data-cowart-insert-target/);
  assert.match(app, /\/insert-cowart/);
  assert.match(runtime, /handleApiRequest/);
  assert.match(assetRoutes, /insert_cowart_image/);
  assert.match(assetRoutes, /mosaAssetId/);
  assert.match(assetRoutes, /Cowart insertion target is not registered/);
});

test("uses a single language chosen from system, Chinese, or English", async () => {
  const [html, app, i18n] = await Promise.all([
    readFile(resolve(root, "app/index.html"), "utf8"),
    readFile(resolve(root, "app/app.js"), "utf8"),
    readFile(resolve(root, "app/i18n.mjs"), "utf8"),
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
  assert.match(i18n, /自动发现的 Cowart 画布/);
  assert.match(app, /function cowartCanvasListSignature\(canvases\)/);
  assert.doesNotMatch(app, /data-cowart-canvas-form/);
  assert.doesNotMatch(app, /data-remove-cowart-canvas/);
  assert.match(app, /\/api\/cowart-canvases/);
});

test("keeps recipe version history navigable without replacing active edits", async () => {
  const [app, css, i18n] = await Promise.all([
    readFile(resolve(root, "app/app.js"), "utf8"),
    readFile(resolve(root, "app/styles.css"), "utf8"),
    readFile(resolve(root, "app/i18n.mjs"), "utf8"),
  ]);

  assert.match(i18n, /versionHistory: "版本历史"/);
  assert.match(i18n, /versionHistory: "Version history"/);
  assert.match(app, /data-version-history aria-live="polite"/);
  assert.match(app, /<ol class="version-timeline" aria-label=/);
  assert.match(app, /version-depth-\$\{depth\}/);
  assert.doesNotMatch(app, /style="/);
  assert.match(app, /<time datetime=/);
  assert.match(app, /aria-current="true"/);
  assert.match(app, /<label class="field version-change-field">/);
  assert.match(app, /data-action="save-version"/);
  assert.match(app, /function readRecipeDraft\(panel\)/);
  assert.match(app, /body: \{ \.\.\.readRecipeDraft\(panel\), version_change: versionChange \}/);
  assert.match(app, /function activeRecipeSnapshot\(asset\)/);
  assert.match(app, /function regenerationInstruction\(asset, snapshot\)/);
  assert.match(app, /`assetId: \$\{JSON\.stringify\(asset\.id\)\}`/);
  assert.match(app, /imagePath: <path returned by image generation>/);
  assert.match(app, /data-recipe-history aria-live="polite"/);
  assert.match(app, /data-recipe-snapshot-id=/);
  assert.match(app, /requestId !== recipeHistoryRequestSequence/);
  assert.match(app, /recipe_change_summary: changeSummary/);
  assert.match(app, /requestId !== versionHistoryRequestSequence/);
  assert.match(app, /function renderVersionHistoryRegion\(history, selectedId, error = null\)/);
  const regionRenderer = /function renderVersionHistoryRegion[\s\S]*?\n}\n\nfunction versionHistoryMarkup/.exec(app)?.[0] || "";
  assert.doesNotMatch(regionRenderer, /renderDetail\(/);
  assert.match(app, /state\.detailAsset = asset/);
  // Gallery navigation no longer keys off the selected index — it resolves the
  // neighbour from rendered geometry — but it still requires a live selection.
  assert.match(app, /if \(!state\.assets\.some\(\(asset\) => asset\.id === state\.selectedId\)\) return;/);
  assert.match(app, /function confirmDetailNavigation\(nextAssetId\)/);
  assert.match(app, /window\.confirm\(t\("discardVersionChanges"\)\)/);
  assert.match(app, /function isCurrentDetailAction\(renderId, projectId, assetId\)/);
  assert.match(app, /renderId === detailRenderSequence/);
  assert.match(app, /\[data-edit="rating"\] button/);
  assert.match(css, /\.version-timeline-item\.selected > button/);
  assert.match(css, /\.version-depth-6 \{ margin-left: 72px; \}/);
  assert.match(css, /\.recipe-snapshot-item \{/);
  // The reference-rights badge must stay a text label with its own class, not
  // colour alone, so the state survives without colour perception.
  // The rights editor is the only way an operator can record this data, and the
  // badge is the only place the gap is visible, so the badge must be the way in.
  assert.match(app, /function referenceRightsMarkup\(asset\)/);
  assert.match(app, /data-reference-rights-section/);
  assert.match(app, /data-action="open-reference-rights"/);
  assert.match(app, /<button type="button" class="recipe-reference-rights \$\{rights\.tone\}" data-action="open-reference-rights"/);
  assert.match(app, /function readReferenceRightsDraft\(section, asset\)/);
  // Gallery rows omit recipe relations, so the editor is built before the
  // history it reads has arrived. It must redraw when the history lands or it
  // stays empty on first open for every asset that actually has references.
  assert.match(app, /function renderReferenceRightsRegion\(asset\)/);
  assert.match(app, /data-reference-rights>/);
  const historyRenderer = /function renderRecipeHistoryRegion[\s\S]*?\n}\n/.exec(app)?.[0] || "";
  assert.match(historyRenderer, /renderReferenceRightsRegion\(asset\)/);
  // Digest material must be copied from the snapshot, never re-read from the
  // editor, or a rights annotation would become a different recipe.
  assert.match(app, /asset_id: reference\.asset_id,\s*\n\s*sha256: reference\.sha256,\s*\n\s*role: reference\.role,\s*\n\s*scope: reference\.scope,\s*\n\s*applied: reference\.applied,/);
  assert.match(app, /const USE_PERMISSION_CYCLE = \{ undeclared: "allowed", allowed: "forbidden", forbidden: "undeclared" \}/);
  assert.match(app, /regenerateRestrictedConfirm/);
  assert.match(app, /referenceRightsTone\(reference\) === "restricted"/);
  // The strict CSP forbids an inline onerror attribute.
  assert.doesNotMatch(app, /onerror=/);
  assert.match(css, /\.use-chip\.forbidden \{/);
  assert.match(css, /\.reference-thumb-empty \{/);
  assert.match(app, /function referenceRightsSummary\(references\)/);
  assert.match(app, /class="recipe-reference-rights \$\{rights\.tone\}"/);
  assert.match(i18n, /referenceRightsRestricted: "\{count\} 项参考受限"/);
  assert.match(i18n, /referenceRightsUnresolved: "\{count\} with unconfirmed rights"/);
  assert.match(css, /\.recipe-reference-rights\.restricted \{/);
  assert.match(css, /\.recipe-reference-rights\.unresolved \{/);
  assert.match(css, /\.recipe-save-actions \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.recipe-save-btn \{[^}]*white-space: normal;/);
});

test("provides an accessible tabbed detail panel with ARIA roles", async () => {
  const [app, css, i18n] = await Promise.all([
    readFile(resolve(root, "app/app.js"), "utf8"),
    readFile(resolve(root, "app/styles.css"), "utf8"),
    readFile(resolve(root, "app/i18n.mjs"), "utf8"),
  ]);

  assert.match(i18n, /tabOverview: "概览"/);
  assert.match(i18n, /tabOverview: "Overview"/);
  assert.match(i18n, /tabRecipe: "Recipe"/);
  assert.match(i18n, /tabVersions: "Versions"/);
  assert.match(app, /role="tablist"/);
  assert.match(app, /role="tab" id="detailTabOverview"/);
  assert.match(app, /role="tab" id="detailTabRecipe"/);
  assert.match(app, /role="tab" id="detailTabVersions"/);
  assert.match(app, /aria-controls="detailPanelOverview"/);
  assert.match(app, /aria-controls="detailPanelRecipe"/);
  assert.match(app, /aria-controls="detailPanelVersions"/);
  assert.match(app, /role="tabpanel" id="detailPanelOverview"/);
  assert.match(app, /role="tabpanel" id="detailPanelRecipe"/);
  assert.match(app, /role="tabpanel" id="detailPanelVersions"/);
  assert.match(app, /aria-labelledby="detailTabOverview"/);
  assert.match(app, /function switchDetailTab\(tabId\)/);
  assert.match(app, /function bindDetailTabEvents\(\)/);
  assert.match(app, /state\.detailTab = "overview"/);
  assert.match(css, /\.detail-tab-panel\[hidden\] \{ display: none; \}/);
  assert.match(css, /\.detail-tab\[aria-selected="true"\]/);
  assert.match(css, /\.detail-tabs/);
});

test("supports Escape to close detail panel and focus return", async () => {
  const app = await readFile(resolve(root, "app/app.js"), "utf8");

  assert.match(app, /detailReturnFocus: null/);
  assert.match(app, /state\.detailReturnFocus = \(activeEl instanceof HTMLElement/);
  assert.match(app, /const returnEl = state\.detailReturnFocus/);
  assert.match(app, /if \(returnEl instanceof HTMLElement && returnEl\.isConnected\) returnEl\.focus\(\)/);
  assert.match(app, /function setDetailOpen\(open\)/);
  assert.match(app, /state\.detailTab = "overview"/);
  // Focus must move on the closed -> open transition only, and must not be
  // deferred to an animation frame (those are suspended while the window is
  // hidden or throttled, which silently drops the focus move).
  assert.match(app, /if \(!wasOpen\) els\.detailPanel\?\.querySelector\("#detailTitle"\)\?\.focus\(\)/);
  assert.doesNotMatch(app, /requestAnimationFrame\(\(\) => \{\s*const firstTab/);
});

test("keeps the 960px+ side drawer layout without bottom split", async () => {
  const css = await readFile(resolve(root, "app/styles.css"), "utf8");

  assert.match(css, /\.shell\.details-open \{ grid-template-columns: 224px minmax\(0, 1fr\) clamp\(360px, 30vw, 480px\); \}/);
  assert.match(css, /@media \(max-width: 1120px\)/);
  assert.match(css, /@media \(max-width: 959px\)/);
  assert.doesNotMatch(css, /1120px.*grid-template-rows.*286px/s);
  assert.match(css, /\.detail-tab \{/);
  assert.match(css, /\.section-head-copy/);
});

test("ensures minimum touch target sizes for accessibility", async () => {
  const css = await readFile(resolve(root, "app/styles.css"), "utf8");

  assert.match(css, /\.action-btn \{[^}]*min-height: 36px/);
  assert.match(css, /\.detail-close \{[^}]*min-height: 36px/);
  assert.match(css, /\.cowart-target-select \{[^}]*min-height: 36px/);
  assert.match(css, /\.section-head-copy \{[^}]*min-height: 36px/);
});
