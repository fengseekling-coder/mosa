// Inspector information-architecture contract (Phase 4A): the approved
// single-column detail panel — V2's seven semantic sections in the approved order,
// no tab roles, honest file-fact fallbacks ("未记录" instead of fabricated
// dimensions/size), the retired Save Version composer absent, and every async
// race guard preserved. Static guards
// only — Node standard library, no network access. Locks concrete DOM, order,
// state and helpers (never a whole-file SHA of app.js / styles.css).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { createInspectorMarkup } from "../web/app/inspector-markup.mjs";
import { assertPackageLockMatchesManifest } from "./package-lock-contract.mjs";

const root = resolve(import.meta.dirname, "..");
const readApp = () => readFile(resolve(root, "web/app/app.mjs"), "utf8");
const readCss = () => readFile(resolve(root, "web/app/styles.css"), "utf8");
const readI18n = () => readFile(resolve(root, "web/app/i18n.mjs"), "utf8");
const readInspectorMarkup = () => readFile(resolve(root, "web/app/inspector-markup.mjs"), "utf8");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const count = (source, needle) => source.split(needle).length - 1;

/** Extracts a `{...}` block starting at the marker, honouring nested braces. */
function blockAfter(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `marker not found: ${marker}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced block after marker: ${marker}`);
}

/** Slices source between two markers (start inclusive, end exclusive). */
function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `marker not found: ${endMarker}`);
  return source.slice(start, end);
}

/** Slices a function (top-level or 2-space-indented module helper) up to the next function. */
function functionSlice(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function not found: ${name}`);
  const candidates = ["\nfunction ", "\nasync function ", "\n  function ", "\n  async function "]
    .map((marker) => source.indexOf(marker, start + 1))
    .filter((index) => index !== -1);
  const next = candidates.length ? Math.min(...candidates) : -1;
  return source.slice(start, next === -1 ? source.length : next);
}

// Library v2 keeps favorite inside its Overview. GravityPort A4a 重排后的滚动列
// 六个语义区块：头部 / 标签 / 色板 / 提示词 / 参考图 / 版本树与上下文；
// 第七个 data-inspector-section（"version-overlay"）是版本树浮层的内容壳。
const SECTION_ORDER = ["file", "tags", "palette", "prompt", "reference", "version"];
// Exact helper-call sequence inside the renderDetail single-column composition.
const COMPOSITION = "${detailFileSectionMarkup(asset)}${detailTagsSectionMarkup(asset)}${detailPaletteSectionMarkup(asset)}${detailPromptSectionMarkup(asset)}${detailReferenceSectionMarkup(asset)}${detailVersionContextSectionMarkup(asset, cachedGenerationHistory)}";

// 1. Detail uses a single vertical information column.
// 2. No detail tablist. 3. No detail tab. 4. No detail tabpanel.
// 5. Nine semantic sections exist. 6. Their order matches the V2 spec.
test("1-6. single-column architecture, tab roles removed, V2 sections in approved order", async () => {
  const [app, inspector, css] = await Promise.all([readApp(), readInspectorMarkup(), readCss()]);

  // 1. Single column: one inspector shell with one header, one scroll container,
  // the fixed asset-path capsule and the persistent overlay container.
  const renderDetail = functionSlice(app, "renderDetail");
  const shell = functionSlice(app, "ensureDetailInspectorShell");
  assert.ok(shell.includes('<div class="detail-inspector"><div class="detail-inspector-header">'), "persistent inspector shell has fixed header");
  assert.ok(shell.includes('<div class="detail-inspector-scroll"></div>'), "persistent shell owns the single scroll container");
  assert.ok(shell.includes('<div class="detail-pathbar" data-detail-pathbar hidden></div>'), "asset-path capsule is a persistent shell slot outside the scroll column");
  assert.ok(shell.includes('<div class="gp-inspector-overlay" data-gp-overlay'), "reference/version overlay container lives in the persistent shell");
  assert.ok(renderDetail.includes('${detailFileSectionMarkup(asset)}${detailTagsSectionMarkup(asset)}${detailPaletteSectionMarkup(asset)}${detailPromptSectionMarkup(asset)}'), "file facts, tags, palette and prompt stay adjacent without an extra overview wrapper");
  assert.equal(count(shell, 'class="detail-inspector-scroll"'), 1, "the shell creates exactly one scroll container");
  assert.doesNotMatch(renderDetail, /els\.detailPanel\.innerHTML\s*=/, "asset switches must not rebuild the entire inspector shell");
  assert.match(renderDetail, /renderDetailInspectorContent\(t\("assetInspector"\)/, "asset content renders into the persistent shell");
  const scroller = blockAfter(css, ".detail-inspector-scroll {");
  assert.match(scroller, /overflow-y: auto/);
  assert.match(scroller, /overflow-x: hidden/);
  assert.match(scroller, /min-height: 0/);
  assert.match(blockAfter(css, ".detail-inspector {"), /flex-direction: column/);
  // The panel itself never scrolls — the scroll container is the only y-scroller.
  const detail = blockAfter(css, "\n.detail {");
  assert.match(detail, /overflow: hidden/);
  assert.doesNotMatch(detail, /overflow-y:\s*(auto|scroll)/);

  // 2–4. No tab roles remain in the detail panel (rendered markup is
  // double-quoted; the single-quoted [role='tab'] keyboard guard is a generic
  // arrow-key escape hatch, not a rendered tab).
  const detailSource = renderDetail + inspector;
  assert.doesNotMatch(detailSource, /role="tablist"/);
  assert.doesNotMatch(detailSource, /role="tab"/);
  assert.doesNotMatch(detailSource, /role="tabpanel"/);
  assert.doesNotMatch(detailSource, /detailTabOverview|detailTabRecipe|detailTabVersions/);
  assert.doesNotMatch(detailSource, /detailPanelOverview|detailPanelRecipe|detailPanelVersions/);
  assert.doesNotMatch(detailSource, /class="detail-tab/);
  assert.doesNotMatch(css, /\.detail-tab/);

  // 5. Section markers: the six scroll-column blocks plus the version-overlay
  // content shell are live; the three retired sections (source / group / more)
  // survive only inside their retained helper bodies.
  assert.equal(count(inspector, 'data-inspector-section="'), 10, "6 column + 1 overlay + 3 retained-in-helper markers");
  for (const id of SECTION_ORDER) {
    assert.ok(inspector.includes(`data-inspector-section="${id}"`), `missing section ${id}`);
  }
  assert.ok(inspector.includes('data-inspector-section="version-overlay"'), "version tree overlay keeps its own section marker");
  for (const id of ["source", "group", "more"]) {
    assert.equal(count(inspector, `data-inspector-section="${id}"`), 1, `retained ${id} helper keeps exactly one marker`);
  }

  // 6. The renderDetail composition concatenates the V2 helpers in the
  // approved order — this string is the single source of the section order.
  assert.ok(app.includes(COMPOSITION), "renderDetail must compose the V2 sections in the approved order");
  // （旧 --inspector-unit=4px 已并入规范表 v1 的 --sp-*，任务 107）解析 :root 实际值，
  // 守卫语义保留：检视器空间标尺的 4px 基准单位仍然存在。
  assert.equal([...css.matchAll(/--sp-1\s*:\s*(\d+)px\s*;/g)][0]?.[1], "4", "--sp-1 (merged --inspector-unit) must stay 4px");
  assert.doesNotMatch(app, /detail-overview-card/, "the inspector must not add an extra outer card wrapper around overview content");
  assert.match(css, /\.mosa-v2 \.detail-inspector-scroll > \.inspector-section \{[\s\S]*?flex: 0 0 auto;/, "semantic sections must not shrink out of the flex scroll column");
  // R21（web-r21-inspector-head）把滚动列的底部留白定在滚动列 padding 的
  // 末档（--r21-s7=28px，任务 107 并入 --sp-* 时按两档中间取小档归 24=--sp-6），
  // 由该契约锁定；这里继续锁区块之间不留缝（gap: 0）。
  assert.match(css, /\.mosa-v2 \.detail-inspector-scroll \{[^}]*gap: 0;/);
  assert.match(css, /\.mosa-v2 \.detail \.detail-prompt-section \{[\s\S]*?border-top: 1px solid var\(--inspector-divider\);[\s\S]*?border-radius: 0;[\s\S]*?background: transparent;/);
  assert.doesNotMatch(blockAfter(css, ".mosa-v2 .detail-inspector {"), /animation:/, "persistent shell itself never replays the materialize animation");
  assert.match(css, /\.mosa-v2 \.detail\.detail-entering \.detail-inspector \{[\s\S]*?animation: inspector-materialize/, "materialize animation is limited to a closed-to-open transition");
  assert.match(functionSlice(app, "setDetailOpen"), /classList\.toggle\("detail-entering", state\.detailOpen && !wasOpen\)/, "selection changes while open cannot retrigger the inspector entrance");
});

// 7. File-facts section exists. 8. Missing facts fall back to notRecorded.
// 9. No fabricated 0×0 dimensions. 10. No fabricated file size.
test("7-10. file facts are honest — notRecorded fallbacks, no fabrication", async () => {
  // R21 检视器头部：web 头部重排为两栏键值；旧 detail-facts 结构与宽图几何
  // 已随桌面端一起退役，由 web-r21-inspector-head 的「detailFileSectionMarkup
  // keeps every e2e-critical anchor…」与「R21 head layout」两条契约锁定。
  const [app, inspector, i18n] = await Promise.all([readApp(), readInspectorMarkup(), readI18n()]);

  // 7. Section with an asset-metadata group and the V2 fact-tag values.
  const fileSection = functionSlice(inspector, "detailFileSectionMarkup");
  assert.ok(fileSection.includes('data-inspector-section="file"'));
  assert.ok(fileSection.includes('["fileDimensions", fileDimensionsText(asset)]'));
  assert.ok(fileSection.includes('["fileFormat", fileFormatText(asset)]'));
  assert.ok(fileSection.includes('["fileSize", fileSizeText(asset)]'));

  // 8. Every null fact renders the shared notRecorded copy (never a blank cell).
  assert.match(inspector, /value === null \? `<span class="empty-copy">\$\{t\("notRecorded"\)\}<\/span>`/);
  assert.match(i18n, /notRecorded: "未记录"/);
  assert.match(i18n, /notRecorded: "Not recorded"/);

  // 9. Dimensions require two finite, positive numbers — 0×0 can never render.
  assert.match(inspector, /if \(!Number\.isFinite\(width\) \|\| !Number\.isFinite\(height\) \|\| width <= 0 \|\| height <= 0\) return null;/);
  // No rendered literal may fake a zero dimension (checked on comment-stripped helpers).
  const strippedHelpers = sliceBetween(inspector, "  function fileDimensionsText(", "  function assetMediaPreviewMarkup").replace(/\/\/.*/g, "");
  assert.doesNotMatch(strippedHelpers, /0 × 0/);
  assert.doesNotMatch(strippedHelpers, /0×0/);
  assert.doesNotMatch(inspector, /naturalWidth \? |\|\| image\.naturalWidth/, "no naturalWidth masquerading as a persisted fact");

  // 10. File size requires a positive byte count; non-positive yields "" (→ null upstream).
  assert.match(inspector, /Number\.isFinite\(bytes\) && bytes > 0 \? formatFileSize\(bytes\) : null/);
  assert.match(inspector, /if \(!Number\.isFinite\(bytes\) \|\| bytes <= 0\) return "";/);

  // Web Capture persists verified file facts in business_fields. The inspector
  // must surface them instead of treating the asset as unknown.
  const helpers = createInspectorMarkup({ state: { groups: { groups: [] } }, t: (key) => key, referenceRightsMarkup: () => "" });
  const capturedAsset = { business_fields: { width: 768, height: 1376, file_bytes: 597543 } };
  assert.equal(helpers.fileDimensionsText(capturedAsset), "768 × 1376");
  assert.equal(helpers.fileAspectRatioText(capturedAsset), "9:16");
  assert.equal(helpers.fileAspectRatioText({ business_fields: { width: 1487, height: 1058 } }), "7:5");
  assert.equal(helpers.fileAspectRatioText({ business_fields: { width: 1020, height: 2080 } }), "51:104", "do not force a common ratio when the export is not close enough");
  assert.equal(helpers.fileSizeText(capturedAsset), "584 KB");
  assert.equal(helpers.fileDimensionsText({ business_fields: { width: 0, height: 1376 } }), null);

  // Preview geometry: R21 把头部预览改为 132×132 方图（asset-mini，object-fit:
  // cover），旧的宽图 aspect-ratio 属性与 detail-image-wrap 结构在 web 端已删除，
  // 由 web-r21-inspector-head 的「R21 head layout」契约锁定。
});

// 11. Favorite button belongs to the Overview. 12. It uses aria-pressed.
// 13. It reuses toggleFavorite.
test("11-13. V2 Overview favorite control uses aria-pressed and toggleFavorite", async () => {
  const app = await readApp();
  const inspector = await readInspectorMarkup();
  // R21：web 头部重排后收藏按钮仍在头部（asset-name-row 内，按钮只显图标），
  // 由 web-r21-inspector-head 的 e2e 锚点契约与「the last-declared header rules」
  // 契约（.mosa-v2 .asset-name-row .detail-fav-btn）锁定。

  const favoriteButton = functionSlice(inspector, "detailFavoriteButtonMarkup");
  assert.ok(functionSlice(inspector, "detailFileSectionMarkup").includes("${detailFavoriteButtonMarkup(asset)}"), "web head still renders the favorite control");
  assert.ok(favoriteButton.includes('data-action="toggle-favorite"'), "favorite button present");
  assert.ok(favoriteButton.includes('aria-pressed="${favorite}"'), "pressed state is exposed");
  assert.ok(favoriteButton.includes('t(favorite ? "removeFavorite" : "addFavorite")'));

  const bindDetailEvents = functionSlice(app, "bindDetailEvents");
  assert.match(bindDetailEvents, /toggleFavorite\(asset\.id, event\)/, "reuses the existing toggleFavorite path");
});

// 14. Prompt section exists. 15. Prompt copy entry exists.
// 16. ChatGPT-unavailable state kept. 17. User instruction stays separate.
test("14-17. prompt section states, copy entry and user-instruction separation", async () => {
  const [app, inspector, i18n] = await Promise.all([readApp(), readInspectorMarkup(), readI18n()]);

  const promptSection = functionSlice(inspector, "detailPromptSectionMarkup");
  assert.ok(promptSection.includes('data-inspector-section="prompt"'));

  // 15. Copy renders only when a prompt exists (no dead button, no empty copy).
  assert.match(promptSection, /const copyButton = asset\.prompt\n\s+\? `<button class="section-head-copy" type="button" data-action="copy-prompt"/);
  assert.match(promptSection, /data-action="copy-prompt" title="\$\{t\("copyPrompt"\)\}" aria-label="\$\{t\("copyPrompt"\)\}"/);

  // 16. The ChatGPT prompt-unavailable state stays distinct from "not recorded".
  assert.match(promptSection, /source\.prompt_status === "not-available"/);
  assert.match(promptSection, /t\(promptUnavailable \? "webPromptUnavailable" : "notRecorded"\)/);
  assert.match(i18n, /webPromptUnavailable: "网页来源未暴露原始生图提示词"/);
  assert.match(i18n, /webPromptUnavailable: "The web source did not expose the original image-generation prompt"/);

  // 17. V2 always reserves the user-instruction pair after the prompt box.
  // Missing upstream data must use the explicit V2 fallback rather than moving
  // recipe controls into the fixed-height primary composition.
  assert.match(promptSection, /const instructionText = userInstruction/);
  assert.match(promptSection, /t\("userInstructionUnavailable"\)/);
  assert.match(promptSection, /const instructionMarkup = `<div class="detail-prompt-subhead">/);
  assert.match(promptSection, /<div class="detail-prompt-subhead"><h4>\$\{t\("userInstruction"\)\}<\/h4>/);
  assert.match(promptSection, /detail-instruction-box/);
  assert.match(promptSection, /\$\{promptText\}<\/div>\$\{promptProvenance\}\$\{instructionMarkup\}/);
  assert.match(i18n, /userInstruction: "用户指令"/);
  assert.match(i18n, /userInstruction: "User instruction"/);
  assert.match(i18n, /userInstructionUnavailable: "未提供用户指令"/);
  assert.match(i18n, /userInstructionUnavailable: "No user instruction provided"/);

  // GravityPort A4a：两段提示词时渲染「提示词1 / 提示词2」页签（i18n 键独立于
  // prompt/prompt2），单段时只显示标题「提示词」。
  assert.match(promptSection, /data-prompt-variant="1">\$\{t\("promptTab1"\)\}<\/button><button class="detail-prompt-toggle" type="button" aria-pressed="false" data-prompt-variant="2">\$\{t\("promptTab2"\)\}/);
  assert.match(promptSection, /: `<h3>\$\{t\("prompt"\)\}<\/h3>`/);
  assert.match(i18n, /promptTab1: "提示词1"/);
  assert.match(i18n, /promptTab1: "Prompt 1"/);
  assert.match(i18n, /promptTab2: "提示词2"/);
  assert.match(i18n, /promptTab2: "Prompt 2"/);

  // The reference block (its own A4a section now) shows real generation
  // references instead of the old hard-coded "unused" claim. Web assets
  // distinguish loading, empty, and populated reference states while recipe
  // history loads asynchronously.
  assert.doesNotMatch(promptSection, /\$\{promptReferencesMarkup|<div data-prompt-references>/, "references left the prompt section in A4a");
  const referenceSection = functionSlice(inspector, "detailReferenceSectionMarkup");
  assert.match(referenceSection, /data-inspector-section="reference"/);
  assert.match(referenceSection, /data-prompt-references/);
  assert.match(inspector, /function promptReferencesMarkup\(asset\)/);
  assert.match(inspector, /linked\?\.thumbnail_url \|\| reference\.attachment_url \|\| linked\?\.image_url/);
  assert.match(inspector, /data-reference-thumb-img/);
  assert.match(inspector, /data-reference-thumb-fallback/);
  assert.match(inspector, /t\("referenceLoading"\)/);
  assert.match(inspector, /t\("referenceNone"\)/);
  assert.doesNotMatch(promptSection, /t\("referenceUnused"\)/);
  assert.match(app, /function renderPromptReferencesRegion\(asset, error = null\)/);
  assert.match(app, /renderPromptReferencesRegion\(asset, error\)/);
  assert.match(app, /t\("referenceLoadFailed"\)/);
  assert.match(app, /function bindReferenceThumbnailFallbacks\(root\)/);
  assert.match(app, /classList\.add\("is-load-error"\)/);
  assert.match(i18n, /referenceLoadFailed: "读取失败"/);
  assert.match(i18n, /referenceLoadFailed: "Failed to load"/);
});

// GravityPort A4a：来源信息区块从界面拿掉（用户 10-06 拍板，不挪到别处）。
// 「查看同批次」「查看同对话」按钮与 copy-source 入口随区块一并消失；
// showRelatedGenerations / buildSourceRows / sourceCopyValue 保留实现。
test("18-20. source section stays removed from the inspector (A4a)", async () => {
  const app = await readApp();
  const inspector = await readInspectorMarkup();

  // 18. The helper body is retained but never composed into the column and
  // never rendered by the overlay bodies either.
  const sourceSection = functionSlice(inspector, "detailSourceSectionMarkup");
  assert.ok(sourceSection.includes('data-inspector-section="source"'), "retained helper keeps its marker");
  assert.ok(!app.includes("${detailSourceSectionMarkup(asset)}"), "source section must not come back to renderDetail");
  const renderDetailOverlays = functionSlice(app, "renderDetailOverlays");
  assert.ok(!renderDetailOverlays.includes("detailSourceSectionMarkup"), "source section must not come back inside the overlays");
  // 19. The copy-source / session / batch inspector entries are gone.
  const bindDetailEvents = functionSlice(app, "bindDetailEvents");
  assert.doesNotMatch(bindDetailEvents, /data-action="copy-source"/, "copy-source entry must not come back");
  assert.doesNotMatch(bindDetailEvents, /data-action="view-generation-session"/, "session entry must not come back");
  assert.doesNotMatch(bindDetailEvents, /data-action="view-generation-batch"/, "batch entry must not come back");
  // 20. buildSourceRows / sourceCopyValue survive as retained implementations
  // (their only consumer, detailSourceSectionMarkup, stays in the file).
  assert.match(inspector, /function buildSourceRows\(source\)/);
  assert.match(inspector, /function sourceCopyValue\(source = \{\}\)/);
});

test("source navigation helpers stay retained but expose no inspector entries", async () => {
  const [app, inspector, i18n] = await Promise.all([readApp(), readInspectorMarkup(), readI18n()]);
  // GravityPort A4a：导航功能代码保留（右键菜单/其他入口仍可能用），但检视器里
  // 没有它们的按钮——锁「不得回来」。
  const navigation = functionSlice(app, "showRelatedGenerations");
  const bindings = functionSlice(app, "bindDetailEvents");
  assert.match(navigation, /if \(!conversationId \|\| \(mode === "batch" && !messageId\)\) return;/, "retained navigation helper keeps its guards");
  assert.doesNotMatch(bindings, /showRelatedGenerations/);
  assert.doesNotMatch(functionSlice(inspector, "detailFileSectionMarkup"), /view-generation-session/, "the head open-conversation button must not come back");
  for (const key of ["generationNavigation", "viewGenerationBatch", "viewGenerationSession"]) {
    assert.equal(count(i18n, `${key}:`), 2, `${key} must exist in both locales`);
  }
});

// 21. Version context box follows the reference section in the column.
// 22. AI generation lineage is visible in the version tree overlay, open by
//     default; local version history stays behind a closed disclosure.
// 23. Recipe snapshot history UI is removed (A4a) while its data still loads.
test("21-23. version context position, overlay lineage, recipe history data", async () => {
  const app = await readApp();
  const inspector = await readInspectorMarkup();
  const css = await readCss();

  // 21. The version context section sits after reference in the A4a column;
  // the full version workflow renders inside the overlay body.
  const versionIndex = COMPOSITION.indexOf("detailVersionContextSectionMarkup");
  assert.ok(versionIndex > COMPOSITION.indexOf("detailReferenceSectionMarkup"), "version tree & context follows the reference section");
  assert.match(app, /versionBody\.innerHTML = detailVersionSectionMarkup\(asset, cachedHistory, null, cachedGenerationHistory\);/, "the version overlay body composes the version workflow helpers");

  // 22. AI generation lineage is visible in V2 and open by default; local
  // version history remains behind a closed disclosure.
  const versionSection = functionSlice(inspector, "detailVersionSectionMarkup");
  assert.match(versionSection, /<details class="detail-disclosure generation-history-disclosure" open><summary>\$\{t\("generationHistory"\)\}<\/summary>/);
  assert.match(versionSection, /data-generation-history aria-live="polite"/);
  assert.match(inspector, /function generationHistoryMarkup\(history, selectedAssetId\)/);
  assert.match(inspector, /function generationCandidateParentsMarkup\(event, history, eventById\)/);
  assert.match(inspector, /data-action="confirm-generation-relation-candidate"/);
  assert.match(inspector, /data-action="dismiss-generation-relation-candidate"/);
  assert.match(app, /\/api\/generation-relation-candidates/);
  assert.match(versionSection, /<details class="detail-disclosure"><summary>\$\{t\("versionHistory"\)\}<\/summary>/);
  assert.match(versionSection, /data-version-history aria-live="polite"/);
  assert.doesNotMatch(css, /\.mosa-v2 \.detail \.detail-version-section[\s\S]{0,180}\{[^}]*display:\s*none;/, "V2 must not hide the version/generation context surface");
  // The current-version summary stays visible outside the disclosure.
  assert.match(inspector, /function detailVersionSummaryMarkup\(asset\)/);

  // 23. A4a：配方快照历史 disclosure 从界面拿掉（helper 保留实现），配方历史数据
  // 仍照常拉取（参考图权利编辑器依赖它），历史到位后仍刷新参考图区块。
  const recipeDisclosure = functionSlice(inspector, "recipeHistoryDisclosureMarkup");
  assert.match(recipeDisclosure, /<details class="detail-disclosure"><summary>\$\{t\("recipeHistoryLabel"\)\}<\/summary>/, "retained helper keeps its markup");
  assert.ok(!app.includes("${recipeHistoryDisclosureMarkup(cachedRecipeHistory)}"), "recipe history disclosure must not come back to the version section");
  assert.match(functionSlice(app, "renderDetail"), /void loadRecipeHistory\(asset\);/);
  assert.match(functionSlice(app, "renderRecipeHistoryRegion"), /renderReferenceRightsRegion\(asset\);/, "recipe history arrival still refreshes the reference rights editor");
});

// 24. A4a：单独的分组区块拿掉，分组并入头部键值（无分组显示「未分组」）。
test("24. group section stays removed; the head facts carry the group row", async () => {
  const app = await readApp();
  const inspector = await readInspectorMarkup();

  const groupSection = functionSlice(inspector, "detailGroupSectionMarkup");
  assert.ok(groupSection.includes('data-inspector-section="group"'), "retained helper keeps its marker");
  assert.ok(!app.includes("${detailGroupSectionMarkup(asset)}"), "group section must not come back to renderDetail");
  const fileSection = functionSlice(inspector, "detailFileSectionMarkup");
  assert.match(fileSection, /\["group", String\(asset\.group \|\| ""\)\.trim\(\) \|\| t\("notGrouped"\)\]/, "head facts keep the group row with the notGrouped fallback");
});

// 25. Tags section follows file (before palette/prompt). 26. User tags render
//     without a source chip (A4a). 27. The add action is persistent. 28. The section remains bounded.
test("25-28. tags section renders user chips and add action (D3)", async () => {
  const [app, inspector, i18n] = await Promise.all([readApp(), readInspectorMarkup(), readI18n()]);

  // 25. Tags sits after file (overview) and before palette/prompt so it lands
  // directly under the basic information block.
  const tagsIndex = COMPOSITION.indexOf("detailTagsSectionMarkup");
  assert.ok(tagsIndex > COMPOSITION.indexOf("detailFileSectionMarkup"));
  assert.ok(tagsIndex < COMPOSITION.indexOf("detailPromptSectionMarkup"));

  const tagsSection = functionSlice(inspector, "detailTagsSectionMarkup");
  assert.ok(tagsSection.includes('data-inspector-section="tags"'));
  // 26–28. A4a：来源标签芯片拿掉（来源在头部「来源 · 日期」显示），用户标签直接
  // 渲染，添加动作常在，行高有界。
  assert.match(tagsSection, /assetTags\(asset\)/);
  assert.doesNotMatch(tagsSection, /detail-source-tag|sourceMarkup/, "the source chip must not come back to the tags row");
  assert.match(tagsSection, /\$\{tagMarkup\}\$\{tagsToggleMarkup\}/, "user tags render directly, followed by the overflow toggle");
  assert.match(tagsSection, /class="detail-tag"/);
  assert.match(tagsSection, /data-action="add-tag"/);
  assert.match(tagsSection, /t\("addTag"\)/);
  assert.doesNotMatch(tagsSection, /asset-curation|curationMarkup|toggle-curated|copy-context-package|export-context-package/,
    "curation and context-package controls stay out of the asset inspector");
  const css = await readCss();
  assert.match(css, /\.mosa-v2 \.detail \.detail-tags-row \{ gap: var\(--sp-1\); max-height: none; \}/);
  assert.doesNotMatch(css, /asset-curation|context-package-actions/,
    "retired curation/context-package layout styles stay removed");
  assert.match(i18n, /addTag: "添加标签"/);
});

// 32-33. The retired save-as-version composer stays absent from the inspector.
test("32-33. save-as-version section stays removed", async () => {
  const [app, inspector, css] = await Promise.all([readApp(), readInspectorMarkup(), readCss()]);
  assert.doesNotMatch(app + inspector, /detailNewVersionSectionMarkup|data-inspector-section="new-version"|data-action="save-version"/);
  assert.doesNotMatch(inspector, /data-version-change|detail-regenerate-composer|detail-save-version/);
  assert.doesNotMatch(css, /detail-regenerate-section|detail-regenerate-composer|detail-save-version/);
});

// 34-35. A4a：图片位置区块拿掉（由底部固定「素材路径」胶囊取代），helper 保留实现。
test("34-35. more section stays removed; the pathbar owns the location", async () => {
  const app = await readApp();
  const inspector = await readInspectorMarkup();

  assert.ok(!app.includes("${detailMoreSectionMarkup(asset)}"), "more section must not come back to renderDetail");
  const moreSection = functionSlice(inspector, "detailMoreSectionMarkup");
  assert.ok(moreSection.includes('data-inspector-section="more"'), "retained helper keeps its marker");
  // 2026-09-04: the original-media entry and its capability helper retired.
  assert.doesNotMatch(moreSection, /originalMediaActionMarkup/);
  assert.doesNotMatch(inspector, /function originalMediaCapability\(/);
  assert.match(moreSection, /<div class="more-location"><span class="meta-key">\$\{t\("imageLocation"\)\}<\/span>/, "retained helper keeps the location row");
  // A4a：底部固定行渲染素材路径，「打开」复用 /api/open-folder。
  const renderDetailPathbar = functionSlice(app, "renderDetailPathbar");
  assert.match(renderDetailPathbar, /data-action="open-asset-location"/);
  assert.match(renderDetailPathbar, /t\("assetPathLabel"\)/);
  assert.match(renderDetailPathbar, /imagePath \? "" : " disabled"/, "open is disabled without a path");
  const reveal = functionSlice(app, "revealAssetAtPath");
  assert.match(reveal, /apiFetch\("\/api\/open-folder"/);
  assert.match(reveal, /body: \{ path, reveal: true \}/, "reveal reuses the context-menu action endpoint");
  assert.match(reveal, /t\("showInFinderPathNotAllowed"\)/);
  assert.match(reveal, /t\("shownInFinder"\)/);
});

// 36-37. A4a：配方编辑界面整个拿掉（helper 保留）；参考图权利编辑器搬进参考图浮层。
test("36-37. recipe editing stays removed; reference rights render inside the overlay", async () => {
  const app = await readApp();
  const inspector = await readInspectorMarkup();

  // 36. The retained edit form keeps its fields but never composes into the
  // prompt section.
  const promptSection = functionSlice(inspector, "detailPromptSectionMarkup");
  assert.ok(!promptSection.includes("recipeAndEditing"), "recipe editing disclosure must not come back to the prompt section");
  assert.doesNotMatch(promptSection, /data-action="save-recipe"/);
  const editFields = functionSlice(inspector, "editRecipeFieldsMarkup");
  assert.match(editFields, /data-edit="prompt"/, "retained helper keeps its fields");
  assert.match(editFields, /data-edit="business_fields"/, "retained helper keeps its fields");

  // 37. Reference rights render inside the reference overlay body with the
  // same region markers the async renderers and dirty-draft guards rely on.
  const renderDetailOverlays = functionSlice(app, "renderDetailOverlays");
  assert.match(renderDetailOverlays, /data-reference-rights-section/);
  assert.match(renderDetailOverlays, /<div data-reference-rights>\$\{referenceRightsMarkup\(asset\)\}<\/div>/);
  assert.match(app, /function bindReferenceRightsEvents\(panel\)/);
  assert.match(app, /<button class="recipe-save-btn secondary" type="button" data-action="save-reference-rights">/);
});

// 38. state.detailTab no longer controls single-column visibility.
// 39. bindDetailTabEvents is never called. 40. No hidden tabpanel in the tree.
test("38-40. tab state is decoupled from rendering", async () => {
  const [app, inspector, css] = await Promise.all([readApp(), readInspectorMarkup(), readCss()]);

  // 38. renderDetail never reads the deprecated compatibility field.
  assert.doesNotMatch(functionSlice(app, "renderDetail"), /detailTab/, "renderDetail must not consult state.detailTab");

  // 39. Neither tab function exists or is called anywhere.
  assert.doesNotMatch(app + inspector, /bindDetailTabEvents\(\)/);
  assert.doesNotMatch(app + inspector, /function bindDetailTabEvents/);
  assert.doesNotMatch(app + inspector, /switchDetailTab\(/);
  assert.doesNotMatch(app + inspector, /function switchDetailTab/);

  // 40. No tabpanel markup or hidden-panel styling can enter the a11y tree.
  const detailSource = functionSlice(app, "renderDetail") + inspector;
  assert.doesNotMatch(detailSource, /role="tabpanel"/);
  assert.doesNotMatch(detailSource, /aria-labelledby="detailTab/);
  assert.doesNotMatch(css, /\.detail-tab-panel/);
});

// 41. detailRenderSequence guard kept. 42. Version request guard kept.
// 43. Recipe request guard kept.
test("41-43. async race guards preserved", async () => {
  const app = await readApp();

  assert.match(app, /let detailRenderSequence = 0;/);
  assert.match(app, /const renderId = \+\+detailRenderSequence;/);
  assert.match(app, /bindDetailEvents\(asset, renderId\);/);
  assert.match(app, /function isCurrentDetailAction\(renderId, projectId, assetId\)/);
  assert.match(app, /return renderId === detailRenderSequence && isCurrentDetailSelection\(projectId, assetId\);/);

  assert.match(app, /let versionHistoryRequestSequence = 0;/);
  assert.match(app, /const requestId = \+\+versionHistoryRequestSequence;/);
  assert.match(app, /if \(requestId !== versionHistoryRequestSequence/);

  assert.match(app, /let recipeHistoryRequestSequence = 0;/);
  assert.match(app, /const requestId = \+\+recipeHistoryRequestSequence;/);
  assert.match(app, /if \(requestId !== recipeHistoryRequestSequence/);

  assert.match(app, /let generationHistoryRequestSequence = 0;/);
  assert.match(app, /const requestId = \+\+generationHistoryRequestSequence;/);
  assert.match(app, /if \(requestId !== generationHistoryRequestSequence/);
});

// 44. Viewer Navigation contract. 45. Viewer Transform contract.
// 46. Return Snapshot contract. 47. Phase 1/2 contracts. All keep running.
// V2 migration: large-view-* tests were removed during V2 cleanup.
test("44-47. adjacent viewer and phase 1/2 contract files stay in the suite", async () => {
  for (const file of [
    // V2: large-view tests removed, Phase 1/2 contracts remain
    // 47. Phase 1/2 contracts.
    "ui-component-contract.test.mjs",
    "shell-layout-contract.test.mjs",
    "topbar-hierarchy-contract.test.mjs",
    "card-action-contract.test.mjs",
    "accessibility-contract.test.mjs",
  ]) {
    await access(resolve(root, "test", file));
  }
});

// 48. No !important. 49. No undefined tokens.
// 50. package.json and lockfile untouched. 51. No new dependencies.
test("48-51. hygiene: no !important, no undefined tokens, manifest and dependencies untouched", async () => {
  const [app, css] = await Promise.all([readApp(), readCss()]);

  // 48. Declarations only — the word may still appear inside comments.
  assert.doesNotMatch(css, /:[^;{}]*!important/);

  // 49. Fallback-less var() references must resolve to a defined token.
  const defined = new Set([...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((match) => match[1]));
  const hardRefs = new Set([...css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((match) => match[1]));
  const missing = [...hardRefs].filter((name) => !defined.has(name));
  assert.deepEqual(missing, [], `undefined tokens referenced: ${missing.join(", ")}`);

  // 50. Manifest and lockfile SHAs stay at their pre-Phase-4A values.
  const pkg = await readFile(resolve(root, "package.json"), "utf8");
  const lock = await readFile(resolve(root, "package-lock.json"), "utf8");
  // R1 isolation fix (2026-08-09, approved scope) added qa:web/qa:electron/
  // qa:packaged launcher scripts, so the whole-manifest hash no longer holds;
  // the dependency sections the freeze really guards stay byte-identical.
  const manifest = JSON.parse(pkg);
  assert.equal(sha256(JSON.stringify(manifest.dependencies)), "709481475dca249e75c25f9e0b5e93a685b92cfada8e7e7ab0db8a33653c1843", "package.json dependencies must stay untouched");
  assert.equal(sha256(JSON.stringify(manifest.devDependencies)), "11f67ce00f34b4d3dfb9b9ed0dfb428b0368ad5e0a17bd3bafaa40e3c2124fac", "package.json devDependencies must stay untouched");
  assertPackageLockMatchesManifest(lock, manifest, "package-lock.json must preserve dependency identity");

  // 51. app.js imports only approved first-party helpers (no new runtime dependencies).
  assert.deepEqual([...app.matchAll(/^import .* from "(.*)";$/gm)].map((match) => match[1]).sort(),
    ["./api-client.mjs", "./asset-stacks.mjs", "./asset-view.mjs", "./batch-import.mjs", "./bridge-status-poller.mjs", "./confirm-dialog.mjs", "./context-menu-actions.mjs", "./context-menu-bindings.mjs", "./context-menu.mjs", "./cut-paste.mjs", "./gallery-selection.mjs", "./i18n-runtime.mjs", "./image-preview.mjs", "./inspector-markup.mjs", "./inspector-overlay.mjs", "./library-reconciliation.mjs", "./middle-ellipsis.mjs", "./native-asset-drag.mjs", "./navigation-history.mjs", "./status-live-region.mjs", "./tag-utils.mjs", "./toast-manager.mjs"], "app.js imports only approved local helpers");
});

// i18n symmetry: every new Phase 4A key ships in both languages, and no
// hardcoded single-language string leaks into the section helpers.
test("i18n. new Phase 4A keys are symmetric across zh and en", async () => {
  const [app, inspector, i18n] = await Promise.all([readApp(), readInspectorMarkup(), readI18n()]);

  const pairs = [
    [/fileFacts: "基础信息"/, /fileFacts: "Overview"/],
    [/favorited: "已收藏"/, /favorited: "Saved"/],
    [/fileDimensions: "尺寸"/, /fileDimensions: "Dimensions"/],
    [/fileFormat: "格式"/, /fileFormat: "Format"/],
    [/fileSize: "大小"/, /fileSize: "Size"/],
    [/aspectRatio: "比例"/, /aspectRatio: "Ratio"/],
    [/assetMetadata: "素材标签"/, /assetMetadata: "Asset metadata"/],
    [/tags: "标签"/, /tags: "Tags"/],
    [/recipeAndEditing: "配方与编辑"/, /recipeAndEditing: "Recipe and editing"/],
    [/notGrouped: "未分组"/, /notGrouped: "Ungrouped"/],
    // GravityPort A4a 新增键。
    [/promptTab1: "提示词1"/, /promptTab1: "Prompt 1"/],
    [/promptTab2: "提示词2"/, /promptTab2: "Prompt 2"/],
    [/copyColorAria: "复制颜色 \{color\}"/, /copyColorAria: "Copy color \{color\}"/],
    [/colorPalette: "色板"/, /colorPalette: "Color palette"/],
    [/viewAction: "查看"/, /viewAction: "View"/],
    [/versionTreeTitle: "版本树与上下文"/, /versionTreeTitle: "Version tree & context"/],
    [/assetPathLabel: "素材路径"/, /assetPathLabel: "Asset path"/],
    [/openPathAction: "打开"/, /openPathAction: "Open"/],
    [/generationModelLine: "模型：\{value\}"/, /generationModelLine: "Model: \{value\}"/],
  ];
  for (const [zh, en] of pairs) {
    assert.match(i18n, zh);
    assert.match(i18n, en);
  }

  // Section helpers copy goes through t() — no CJK literals in app.js markup
  // helpers (comments are stripped first; only rendered strings are checked).
  const helperRegion = sliceBetween(inspector, "  function fileDimensionsText(", "  function assetMediaPreviewMarkup").replace(/\/\/.*/g, "");
  assert.doesNotMatch(helperRegion, /[一-鿿]/, "section helpers must not hardcode Chinese copy");
});

// Scroll/focus policy: same-asset re-renders keep the scroll position, asset
// switches reset naturally, and panel-held focus lands back on #detailTitle.
test("scroll. single-column scroll and focus restoration policy", async () => {
  const app = await readApp();

  const renderDetail = functionSlice(app, "renderDetail");
  assert.match(renderDetail, /const keepScrollTop = !hadPanelFocus && asset && detailRenderedAssetId === asset\.id/);
  assert.match(renderDetail, /els\.detailPanel\.querySelector\("\.detail-inspector-scroll"\)\?\.scrollTop \?\? null/);
  assert.match(renderDetail, /if \(scroller && keepScrollTop !== null\) scroller\.scrollTop = keepScrollTop;/);
  assert.match(renderDetail, /bindDetailHeaderContext\(asset\);/);
  assert.match(renderDetail, /if \(hadPanelFocus\) els\.detailPanel\.querySelector\("#detailTitle"\)\?\.focus\(\);/);
  assert.match(app, /let detailRenderedAssetId = null;/);
  const headerContext = functionSlice(app, "bindDetailHeaderContext");
  assert.match(headerContext, /scroller\.scrollTop >= overview\.offsetTop \+ overview\.offsetHeight - 8/);
  assert.match(headerContext, /headerLabel\.textContent = overviewPassed \? assetTitle : t\("assetInspector"\)/);
  assert.match(headerContext, /classList\.toggle\("is-contextual", overviewPassed\)/);
  assert.match(headerContext, /scroller\.onscroll = syncHeader;/, "persistent scroller replaces, rather than accumulates, header scroll handlers");
  assert.match(functionSlice(app, "renderDetailInspectorContent"), /scroller\.onscroll = null;/, "non-asset content clears the previous asset scroll handler");
});

test("generation lineage nodes expose evidence and relation management without generation actions", async () => {
  const [app, inspector, i18n, css] = await Promise.all([readApp(), readInspectorMarkup(), readI18n(), readCss()]);

  const lineage = functionSlice(inspector, "generationHistoryMarkup");
  assert.match(lineage, /<details class="generation-lineage-node" data-generation-id=/);
  assert.match(lineage, /generationEventDetailMarkup\(event, \{ history, eventById, assetById, incoming, selectedAssetId \}\)/);
  assert.match(lineage, /generationContextCandidatesMarkup\(history, contextEvents, eventById, assetById\)/);
  assert.match(inspector, /<details class="generation-context-candidates"><summary class="generation-context-candidates-head">/, "context candidates default to a collapsed disclosure");
  assert.match(inspector, /<details class="generation-management-disclosure"><summary>\$\{escapeHtml\(t\("generationRelations"\)\)\}<\/summary>/, "relation management defaults to a nested disclosure");
  assert.match(inspector, /data-action="confirm-generation-relation-candidate"/);

  const detail = functionSlice(inspector, "generationEventDetailMarkup");
  assert.match(detail, /generationEffectivePrompt/);
  assert.match(detail, /generationReferences/);
  assert.match(detail, /generationEvidence/);
  assert.match(detail, /generationIdentifiers/);
  assert.match(detail, /generationRelationsMarkup\(event, incoming, eventById\)/);
  assert.match(detail, /generationLinkComposerMarkup\(event, context\.history, eventById\)/);
  assert.doesNotMatch(detail, /generationContinueComposerMarkup|continue-generation-in-mosa|continue-generation/);
  assert.doesNotMatch(inspector, /function generationContinueComposerMarkup/);
  assert.match(app, /function bindGenerationHistoryEvents\(history, selectedAssetId\)/);
  assert.match(app, /action === "confirm-generation-relation-candidate"/);
  assert.match(app, /activeHistory\.relation_candidates/);
  assert.match(app, /apiFetch\("\/api\/generation-relations"/);
  assert.doesNotMatch(app, /api\/generations\/continue|generationContinuationInstruction|refreshOpenAiGenerationStatus/);
  assert.doesNotMatch(i18n, /generationContinueInMosa|openAiGenerationSettings/);
  assert.match(css, /\.generation-lineage-detail/);
  assert.match(css, /\.generation-evidence-json/);
  assert.match(css, /\.generation-management/);
  assert.match(css, /\.generation-context-candidates/);
  assert.doesNotMatch(css, /\.generation-continue-composer|\.settings-api-key-control/);
});
