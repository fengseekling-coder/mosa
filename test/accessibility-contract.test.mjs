import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("keeps the import flow keyboard-accessible", async () => {
  const [html, app, css, preview] = await Promise.all([
    readFile(resolve(root, "app/index.html"), "utf8"),
    readFile(resolve(root, "app/app.mjs"), "utf8"),
    readFile(resolve(root, "app/styles.css"), "utf8"),
    readFile(resolve(root, "app/image-preview.mjs"), "utf8"),
  ]);

  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="importModalTitle"/);
  assert.match(html, /id="imagePreviewModal" role="dialog" aria-modal="true" aria-labelledby="imagePreviewTitle"/);
  assert.match(html, /id="imagePreviewStage"/);
  assert.match(html, /data-i18n-aria-label="closeImport"/);
  assert.match(html, /data-i18n-aria-label="closePreview"/);
  assert.match(html, /<button class="nav-item active"/);
  assert.match(html, /data-i18n="smartGroups"/);
  assert.match(html, /data-i18n="assetCategories"/);
  assert.match(html, /id="addGroupBtn"[^>]*data-i18n-aria-label="addGroup"/);
  assert.match(html, /id="sidebarManualGroupList"[^>]*data-i18n-aria-label="assetCategories"/);
  assert.match(html, /id="groupModal"/);
  assert.match(html, /aria-labelledby="groupModalTitle" tabindex="-1"/);
  assert.match(app, /class="asset-card-select" type="button"/);
  assert.doesNotMatch(app, /card-overlay|asset-source-badge/);
  assert.doesNotMatch(html, /id="assetCount"/);
  assert.match(html, /id="bridgeStatus" data-state="checking" role="status" aria-live="polite"/);
  assert.match(app, /function trapImportModalFocus\(event\)/);
  assert.match(app, /function trapGroupModalFocus\(event\)/);
  assert.match(app, /async function saveGroup\(\)/);
  assert.match(app, /function openImagePreview\(id, trigger\)/);
  assert.match(app, /function fitImagePreview\(\)/);
  assert.match(app, /Math\.min\(availableWidth \/ image\.naturalWidth, availableHeight \/ image\.naturalHeight\)/);
  assert.match(app, /imagePreviewStage\?\.addEventListener\("click", \(event\) => \{/);
  assert.match(app, /if \(consumeImagePreviewSuppressedClick\(\)\) return;/);
  assert.doesNotMatch(app, /imagePreviewSuppressStageClick|clampImagePreviewOffsets|applyImageTransform/);
  assert.match(preview, /function consumeImagePreviewSuppressedClick\(\)/);
  assert.match(preview, /function reconcileImagePreviewTransform\(\)/);
  assert.match(app, /if \(event\.target === els\.imagePreviewStage\) closeImagePreview\(\);/);
  assert.match(app, /function trapImagePreviewFocus\(event\)/);
  assert.match(app, /dblclick/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(css, /button:focus-visible/);
  assert.match(css, /\.image-preview-stage img \{[^}]*max-width: none;[^}]*max-height: none;/);
  assert.match(css, /\.image-preview-stage > \[hidden\] \{ display: none; \}/, "inactive preview media must not create a second grid item");
  assert.match(css, /\.image-preview-stage \{[^}]*padding: clamp\(24px, 5vw, 88px\);/);
  assert.match(css, /@media \(max-width: 700px\)/);
});

test("keeps the gallery source-aware and the inspector optional", async () => {
  const [app, config, inspector] = await Promise.all([
    readFile(resolve(root, "app/app.mjs"), "utf8"),
    readFile(resolve(root, "app/config.mjs"), "utf8"),
    readFile(resolve(root, "app/inspector-markup.mjs"), "utf8"),
  ]);

  // Sidebar source filtering uses the actual source values directly; the
  // legacy codex/cowart/grok alias map must not return.
  assert.doesNotMatch(config, /SOURCE_FACETS/);
  assert.match(config, /export const SIDEBAR_SOURCE_TYPES = \[/);
  // V2: SOURCE_LABEL_KEYS maps source types to i18n keys
  assert.match(config, /export const SOURCE_LABEL_KEYS = \{/);
  assert.match(config, /"cowart-generated": "sourceCowart"/);
  assert.match(config, /"grok-generated": "sourceGrok"/);
  assert.match(app, /function setDetailOpen\(open\)/);
  assert.match(app, /state\.detailOpen = Boolean\(open\)/);
  assert.match(app, /if \(!state\.detailOpen && isInspectorDocked\(\)\) state\.detailOpen = true;/,
    "desktop inspector remains docked even when legacy close paths request false");
  assert.match(app, /function updateSelectedCard\(\)/);
  assert.match(app, /updateSelectedCard\(\);/);
  assert.match(inspector, /function isVideoAsset\(/);
  assert.match(inspector, /function assetMediaPreviewMarkup\(/);
  const i18n = await readFile(resolve(root, "app/i18n.mjs"), "utf8");
  assert.match(i18n, /userInstruction: "用户指令"/);
  assert.match(i18n, /webPromptUnavailable: "网页来源未暴露原始生图提示词"/);
  assert.match(inspector, /const userInstructionMarkup = `<div class="detail-prompt-subhead">/);
  // Global bridge health ignores Grok-only failures while still exposing Grok metadata.
  assert.match(app, /const hasError = codex\?\.lastError \|\| cowart\?\.lastError;/);
  assert.doesNotMatch(app, /const hasError = codex\?\.lastError \|\| grok\?\.lastError \|\| cowart\?\.lastError;/);
  assert.match(app, /if \(grok\?\.lastWarning\) meta\.push\(String\(grok\.lastWarning\)\);/);
  assert.match(app, /if \(grok\?\.lastError\) meta\.push\(String\(grok\.lastError\)\);/);
  assert.match(app, /else if \(codexOn && cowartOn\) setStatus\(t\("statusReady"\), "ok"\);/);
});

test("keeps background library refreshes from replacing active edits", async () => {
  const [app, apiClient] = await Promise.all([
    readFile(resolve(root, "app/app.mjs"), "utf8"),
    readFile(resolve(root, "app/api-client.mjs"), "utf8"),
  ]);

  assert.match(app, /detailDirty: false/);
  assert.match(apiClient, /requestId !== assetRequestSequence/);
  assert.match(apiClient, /!options\.background \|\| assetsChanged/);
  assert.match(apiClient, /state\.detailOpen && !isDetailEditorActive\(\)/,
    "no asset refresh may replace an active Inspector draft");
  assert.match(apiClient, /!options\.background \|\| !state\.selectedId \|\| selectedChanged/);
  assert.match(apiClient, /function refreshAssetPageTotalInBackground\(\)/);
  assert.match(apiClient, /function refreshLoadedAssetsInBackground\(\)/);
  assert.match(apiClient, /function requestAssetTotal\(request\)[\s\S]*?params\.set\("limit", "1"\)/);
  assert.match(apiClient, /state\.pageTotal = total;[\s\S]*?updateViewTitle\(\)/);
  assert.match(apiClient, /state\.loadedPageCount > 1 \? refreshLoadedAssetsInBackground\(\) : loadAssets\(\{ background: true \}\)/);
  assert.match(app, /field\.dataset\.detailDirty = "true";[\s\S]*?field\.dataset\.detailDirtyScope = scope;[\s\S]*?state\.detailDirty = true;/,
    "Inspector edits carry an owned dirty scope instead of one undifferentiated flag");
});

test("uses a single language chosen from system, Chinese, or English", async () => {
  const [app, i18n, i18nRuntime, apiClient] = await Promise.all([
    readFile(resolve(root, "app/app.mjs"), "utf8"),
    readFile(resolve(root, "app/i18n.mjs"), "utf8"),
    readFile(resolve(root, "app/i18n-runtime.mjs"), "utf8"),
    readFile(resolve(root, "app/api-client.mjs"), "utf8"),
  ]);

  // V2 uses segmented control in settings for language selection (zh/en only)
  assert.match(app, /data-locale/);
  assert.match(app, /safeStorageGet\("mosa\.ui-language"\)/);
  assert.match(i18nRuntime, /export function resolveLocale\(value\)/);
  assert.match(i18nRuntime, /return function applyLanguage\(\)/);
  assert.match(app, /const applyLanguage = createLanguageApplier\(/);
  assert.match(app, /data-project-select/);
  assert.match(app, /data-open-library/);
  assert.match(i18nRuntime, /document\.documentElement\.lang/);
  assert.doesNotMatch(i18n, /自动发现的 Cowart 画布|Detected Cowart canvases/, "retired canvas-list copy does not stay in the language bundle");
  assert.doesNotMatch(app, /cowartCanvasListSignature|cowartCanvases|cowartCanvasLabel/);
  assert.doesNotMatch(app, /data-cowart-canvas-form/);
  assert.doesNotMatch(app, /data-remove-cowart-canvas/);
  assert.doesNotMatch(apiClient, /\/api\/cowart-canvases/, "startup must not duplicate the bridge status sources request");
  assert.match(app, /fetchStatus: \(\) => apiFetch\("\/api\/bridges"\)/);
});

test("keeps recipe version history navigable without replacing active edits", async () => {
  const [app, css, i18n, inspector] = await Promise.all([
    readFile(resolve(root, "app/app.mjs"), "utf8"),
    readFile(resolve(root, "app/styles.css"), "utf8"),
    readFile(resolve(root, "app/i18n.mjs"), "utf8"),
    readFile(resolve(root, "app/inspector-markup.mjs"), "utf8"),
  ]);

  assert.match(i18n, /versionHistory: "版本历史"/);
  assert.match(i18n, /versionHistory: "Version history"/);
  assert.match(inspector, /data-version-history aria-live="polite"/);
  assert.match(inspector, /<ol class="version-timeline" aria-label=/);
  assert.match(inspector, /version-depth-\$\{depth\}/);
  assert.doesNotMatch(app + inspector, /style="/);
  assert.match(inspector, /<time datetime=/);
  assert.match(inspector, /aria-current="true"/);
  assert.doesNotMatch(inspector, /data-version-change|data-inspector-section="new-version"/);
  assert.doesNotMatch(app, /data-action="save-version"/);
  assert.match(app, /function readRecipeDraft\(panel\)/);
  assert.doesNotMatch(inspector, /Imagen 4|Flux|data-composer-select|data-resolution/);
  assert.doesNotMatch(inspector, /createRecipeVersionDescription|saveAsVersion|detail-regenerate-composer/);
  assert.match(app, /function activeRecipeSnapshot\(asset\)/);
  assert.match(app, /function regenerationInstruction\(asset, snapshot\)/);
  assert.match(app, /`assetId: \$\{JSON\.stringify\(asset\.id\)\}`/);
  assert.match(app, /imagePath: <path returned by image generation>/);
  assert.match(inspector, /data-recipe-history aria-live="polite"/);
  assert.match(inspector, /data-recipe-snapshot-id=/);
  assert.match(app, /requestId !== recipeHistoryRequestSequence/);
  assert.match(app, /recipe_change_summary: changeSummary/);
  assert.match(app, /requestId !== versionHistoryRequestSequence/);
  assert.match(app, /function renderVersionHistoryRegion\(history, selectedId, error = null\)/);
  const regionRenderer = /function renderVersionHistoryRegion[\s\S]*?\n}\n\nfunction bindVersionHistoryEvents/.exec(app)?.[0] || "";
  assert.doesNotMatch(regionRenderer, /renderDetail\(/);
  // Phase 4B：版本切换集中到 selectDetailVersion（picker change 与 timeline click 唯一入口），
  // detailAsset 赋值随之内移；renderVersionHistoryRegion 依然不得整页重渲染。
  assert.match(app, /state\.detailAsset = target/);
  assert.match(app, /function selectDetailVersion\(versionId, options = \{\}\)/);
  // Gallery navigation no longer keys off the selected index — it resolves the
  // neighbour from rendered geometry — but it still requires a live selection.
  assert.match(app, /if \(!state\.assets\.some\(\(asset\) => asset\.id === state\.selectedId\)\) return;/);
  // 自动保存：dirty guard 不再弹丢弃确认，而是导航前冲刷挂起的防抖草稿；失败返回
  // false 阻断导航（不静默丢数据）。window.confirm 早已清零。
  assert.match(app, /async function confirmDetailNavigation\(\)/);
  assert.match(app, /return flushInspectorSave\(\);/);
  assert.match(app, /async function persistInspectorDraft\(panel, asset, renderId\)/);
  assert.doesNotMatch(app, /window\.confirm\(/);
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
  assert.match(inspector, /<button type="button" class="recipe-reference-rights \$\{rights\.tone\}" data-action="open-reference-rights"/);
  assert.match(app, /function readReferenceRightsDraft\(section, asset\)/);
  // Gallery rows omit recipe relations, so the editor is built before the
  // history it reads has arrived. It must redraw when the history lands or it
  // stays empty on first open for every asset that actually has references.
  assert.match(app, /function renderReferenceRightsRegion\(asset\)/);
  assert.match(inspector, /data-reference-rights>/);
  const historyRenderer = /function renderRecipeHistoryRegion[\s\S]*?\n}\n/.exec(app)?.[0] || "";
  assert.match(historyRenderer, /renderReferenceRightsRegion\(asset\)/);
  // Digest material must be copied from the snapshot, never re-read from the
  // editor, or a rights annotation would become a different recipe.
  assert.match(app, /asset_id: reference\.asset_id,\s+sha256: reference\.sha256,\s+role: reference\.role,\s+scope: reference\.scope,\s+applied: reference\.applied,/);
  assert.match(app, /const USE_PERMISSION_CYCLE = \{ undeclared: "allowed", allowed: "forbidden", forbidden: "undeclared" \}/);
  // 2026-09-04: the restricted-regenerate flow retired with the inspector button.
  assert.doesNotMatch(app, /restrictedRegenerateTitle/);
  assert.doesNotMatch(app, /referenceRightsTone\(reference\) === "restricted"/, "no gated regenerate path survives; restricted rights still render through the rights section");
  // The strict CSP forbids an inline onerror attribute.
  assert.doesNotMatch(app, /onerror=/);
  assert.match(css, /\.use-chip\.forbidden \{/);
  assert.match(css, /\.reference-thumb-empty \{/);
  assert.match(inspector, /function referenceRightsSummary\(references\)/);
  assert.match(inspector, /class="recipe-reference-rights \$\{rights\.tone\}"/);
  assert.match(i18n, /referenceRightsRestricted: "\{count\} 项参考受限"/);
  assert.match(i18n, /referenceRightsUnresolved: "\{count\} with unconfirmed rights"/);
  assert.match(css, /\.recipe-reference-rights\.restricted \{/);
  assert.match(css, /\.recipe-reference-rights\.unresolved \{/);
  assert.match(css, /\.recipe-save-actions \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.recipe-save-btn \{[^}]*white-space: normal;/);
});

test("provides an accessible single-column detail panel", async () => {
  const [app, css, i18n, inspector] = await Promise.all([
    readFile(resolve(root, "app/app.mjs"), "utf8"),
    readFile(resolve(root, "app/styles.css"), "utf8"),
    readFile(resolve(root, "app/i18n.mjs"), "utf8"),
    readFile(resolve(root, "app/inspector-markup.mjs"), "utf8"),
  ]);

  // Phase 4A：三 Tab 合并为批准的单栏信息架构——无 tab 角色；#detailTitle 仍是焦点
  // 落点，分段用原生 disclosure（键盘可达），按压态用 aria-pressed 暴露。
  assert.match(i18n, /assetInspector: "资产检视器"/);
  assert.match(i18n, /assetInspector: "Asset inspector"/);
  assert.match(app, /<div class="detail-inspector"><div class="detail-inspector-header">/);
  assert.match(app, /<div class="detail-inspector-scroll">/);
  assert.match(css, /@media \(min-width: 701px\) \{[\s\S]*?\.mosa-v2 \.detail-close \{ display: none; \}/,
    "desktop docked inspector must not expose a non-functional close control");
  assert.match(inspector, /<h3 id="detailTitle" tabindex="-1"/);
  assert.match(app, /data-action="close-detail" aria-label="\$\{t\("close"\)\}"/);
  assert.match(inspector, /data-action="toggle-favorite" aria-pressed="\$\{favorite\}"/);
  assert.match(inspector, /class="detail-facts" role="group" aria-label=/);
  assert.match(inspector, /<details class="detail-disclosure"><summary>\$\{t\("versionHistory"\)\}<\/summary>/);
  const renderDetailStart = app.indexOf("function renderDetail(");
  const renderDetailEnd = app.indexOf("\nfunction ", renderDetailStart + 1);
  const detailSource = app.slice(renderDetailStart, renderDetailEnd) + inspector;
  assert.doesNotMatch(detailSource, /role="tablist"/);
  assert.doesNotMatch(detailSource, /role="tab"/);
  assert.doesNotMatch(detailSource, /role="tabpanel"/);
  // Phase 4B 校正闸门：deprecated 的 state.detailTab 字段、初始值与重置语句全部移除，
  // 全 app 代码零残留（此前 Phase 4A 仅移除 Tab DOM 与路由）。
  assert.doesNotMatch(detailSource, /detailTab/);
  assert.match(css, /\.detail-inspector-scroll \{[^}]*overflow-y: auto/);
});

test("supports Escape to close detail panel and focus return", async () => {
  const app = await readFile(resolve(root, "app/app.mjs"), "utf8");

  assert.match(app, /detailReturnFocus: null/);
  assert.match(app, /state\.detailReturnFocus = \(activeEl instanceof HTMLElement/);
  assert.match(app, /const returnEl = state\.detailReturnFocus/);
  assert.match(app, /if \(returnEl instanceof HTMLElement && returnEl\.isConnected\) returnEl\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /detailReturnFocusAssetId[\s\S]*?\.asset-card\[data-id=/,
    "a replaced gallery card is re-queried by asset id before falling back to the grid");
  assert.match(app, /function setDetailOpen\(open\)/);
  // 关闭路径不再重置 detailTab（Phase 4B 已将该死状态整体移除）。
  assert.doesNotMatch(app, /state\.detailTab/);
  // Focus must move on the closed -> open transition only, and must not be
  // deferred to an animation frame (those are suspended while the window is
  // hidden or throttled, which silently drops the focus move).
  assert.match(app, /if \(!wasOpen\) els\.detailPanel\?\.querySelector\("#detailTitle"\)\?\.focus\(\)/);
  assert.doesNotMatch(app, /requestAnimationFrame\(\(\) => \{\s*const firstTab/);
});

test("keeps the 960px+ side drawer layout without bottom split", async () => {
  const css = await readFile(resolve(root, "app/styles.css"), "utf8");

  assert.match(css, /\.shell\.details-open \{ grid-template-columns: var\(--sidebar-width\) minmax\(0, 1fr\) var\(--inspector-width\); \}/);
  assert.match(css, /@media \(max-width: 1120px\)[\s\S]*?\.shell\.details-open \{ grid-template-columns: var\(--sidebar-width-compact\) minmax\(0, 1fr\) var\(--inspector-width-compact\); \}/);
  assert.match(css, /@media \(min-width: 701px\) and \(max-width: 1120px\)/);
  assert.doesNotMatch(css, /@media \(max-width: 959px\)/);
  assert.doesNotMatch(css, /\.shell\.details-open \{[^}]*grid-template-rows/);
  assert.doesNotMatch(css, /\.detail \{[^}]*grid-row:\s*2/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.shell, \.shell\.details-open \{ display: flex; min-height: 100vh; flex-direction: column; \}/);
  assert.match(css, /\.detail-inspector-scroll \{/);
  assert.match(css, /\.section-head-copy/);
});

test("ensures minimum touch target sizes for accessibility", async () => {
  const css = await readFile(resolve(root, "app/styles.css"), "utf8");

  // MOSA interaction-size contract: these controls must be at least 36px tall.
  // Using min-height (not fixed height) so content can expand naturally.
  assert.match(css, /\.action-btn \{[^}]*min-height:\s*36px/);
  assert.match(css, /\.detail-close \{[^}]*min-height:\s*36px/);
  assert.match(css, /\.section-head-copy \{[^}]*min-height:\s*36px/);
});

test("commits Inspector discards transactionally and keeps result-set mutations coherent", async () => {
  const [app, apiClient, contextBindings] = await Promise.all([
    readFile(resolve(root, "app/app.mjs"), "utf8"),
    readFile(resolve(root, "app/api-client.mjs"), "utf8"),
    readFile(resolve(root, "app/context-menu-bindings.mjs"), "utf8"),
  ]);

  const guardStart = app.indexOf("async function confirmDetailNavigation(nextAssetId)");
  const guardEnd = app.indexOf("\nfunction discardDetailDraft()", guardStart);
  const guard = app.slice(guardStart, guardEnd);
  assert.doesNotMatch(guard, /state\.detailDirty\s*=\s*false/,
    "confirmation alone must never mark a draft clean before the caller succeeds");
  assert.match(apiClient, /const preserveDirtySelection = Boolean\([\s\S]*?state\.detailOpen && state\.detailDirty[\s\S]*?state\.detailAsset = previousSelected;/,
    "a dirty selected asset removed from the current result set remains the Inspector source of truth");
  assert.match(app, /async function saveAsset\(\)[\s\S]*?await apiFetch\("\/api\/assets\/create"[\s\S]*?discardDetailDraft\(\);[\s\S]*?state\.selectedId = result\.asset\.id;/,
    "import discards the old Inspector draft only after asset creation succeeds");
  assert.match(app, /async function saveGroup\(\)[\s\S]*?await apiFetch\("\/api\/groups"[\s\S]*?discardDetailDraft\(\);[\s\S]*?clearDetailSelection\(\);/,
    "group creation keeps the old draft dirty until the group mutation succeeds");
  assert.match(contextBindings, /const assetRefresh =[\s\S]*?Promise\.allSettled\(\[loadStats\(\{ background: true \}\), assetRefresh\]\)/,
    "context-menu refresh failures are observed instead of becoming unhandled rejections");
  assert.match(app, /event\.key === "\/"[\s\S]*?els\.imagePreviewModal\?\.hidden[\s\S]*?els\.settingsMenu\?\.hidden/,
    "the global search shortcut cannot pierce the image preview or Settings modal");
});
