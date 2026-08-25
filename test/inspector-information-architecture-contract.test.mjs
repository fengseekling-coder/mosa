// Inspector information-architecture contract (Phase 4A): the approved
// single-column detail panel — V2's eight semantic sections in the approved order,
// no tab roles, honest file-fact fallbacks ("未记录" instead of fabricated
// dimensions/size), Save Version demoted to secondary, and every async race
// guard preserved. Static guards
// only — Node standard library, no network access. Locks concrete DOM, order,
// state and helpers (never a whole-file SHA of app.js / styles.css).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { createInspectorMarkup } from "../app/inspector-markup.mjs";

const root = resolve(import.meta.dirname, "..");
const readApp = () => readFile(resolve(root, "app/app.mjs"), "utf8");
const readCss = () => readFile(resolve(root, "app/styles.css"), "utf8");
const readI18n = () => readFile(resolve(root, "app/i18n.mjs"), "utf8");
const readInspectorMarkup = () => readFile(resolve(root, "app/inspector-markup.mjs"), "utf8");
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

// Library v2 keeps favorite inside its Overview; the remaining semantic blocks
// are therefore an eight-section column.
const SECTION_ORDER = ["file", "tags", "prompt", "source", "version", "group", "new-version", "more"];
// Exact helper-call sequence inside the renderDetail single-column composition.
const COMPOSITION = "${detailFileSectionMarkup(asset)}${detailTagsSectionMarkup(asset)}${detailPromptSectionMarkup(asset)}${detailSourceSectionMarkup(asset)}${detailVersionSectionMarkup(asset, cachedHistory, cachedRecipeHistory)}${detailGroupSectionMarkup(asset)}${detailNewVersionSectionMarkup()}${detailMoreSectionMarkup(asset)}";

// 1. Detail uses a single vertical information column.
// 2. No detail tablist. 3. No detail tab. 4. No detail tabpanel.
// 5. Nine semantic sections exist. 6. Their order matches the V2 spec.
test("1-6. single-column architecture, tab roles removed, V2 sections in approved order", async () => {
  const [app, inspector, css] = await Promise.all([readApp(), readInspectorMarkup(), readCss()]);

  // 1. Single column: one inspector shell with one header and one scroll container.
  const renderDetail = functionSlice(app, "renderDetail");
  assert.ok(renderDetail.includes('<div class="detail-inspector"><div class="detail-inspector-header">'), "inspector shell with fixed header");
  assert.ok(renderDetail.includes('<div class="detail-inspector-scroll">'), "single scroll container in markup");
  assert.equal(count(app, 'class="detail-inspector-scroll"'), 1, "exactly one scroll container is rendered");
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
  assert.doesNotMatch(app + inspector, /role="tablist"/);
  assert.doesNotMatch(app + inspector, /role="tab"/);
  assert.doesNotMatch(app + inspector, /role="tabpanel"/);
  assert.doesNotMatch(app + inspector, /detailTabOverview|detailTabRecipe|detailTabVersions/);
  assert.doesNotMatch(app + inspector, /detailPanelOverview|detailPanelRecipe|detailPanelVersions/);
  assert.doesNotMatch(app + inspector, /class="detail-tab/);
  assert.doesNotMatch(css, /\.detail-tab/);

  // 5. Eight semantic sections, each emitted exactly once. Favorite belongs in
  // the V2 Overview instead of occupying a detached visual section.
  assert.equal(count(inspector, 'data-inspector-section="'), 8, "exactly eight V2 semantic sections");
  for (const id of SECTION_ORDER) {
    assert.ok(inspector.includes(`data-inspector-section="${id}"`), `missing section ${id}`);
  }

  // 6. The renderDetail composition concatenates the V2 helpers in the
  // approved order — this string is the single source of the section order.
  assert.ok(app.includes(COMPOSITION), "renderDetail must compose the V2 sections in the approved order");
});

// 7. File-facts section exists. 8. Missing facts fall back to notRecorded.
// 9. No fabricated 0×0 dimensions. 10. No fabricated file size.
test("7-10. file facts are honest — notRecorded fallbacks, no fabrication", async () => {
  const [app, inspector, i18n] = await Promise.all([readApp(), readInspectorMarkup(), readI18n()]);

  // 7. Section with an asset-metadata group and the V2 fact-tag values.
  const fileSection = functionSlice(inspector, "detailFileSectionMarkup");
  assert.ok(fileSection.includes('data-inspector-section="file"'));
  assert.match(fileSection, /class="detail-facts" role="group" aria-label="\$\{escapeHtml\(t\("assetMetadata"\)\)\}"/);
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
  assert.equal(helpers.fileAspectRatioText(capturedAsset), "24:43");
  assert.equal(helpers.fileSizeText(capturedAsset), "584 KB");
  assert.equal(helpers.fileDimensionsText({ business_fields: { width: 0, height: 1376 } }), null);
});

// 11. Favorite button belongs to the Overview. 12. It uses aria-pressed.
// 13. It reuses toggleFavorite.
test("11-13. V2 Overview favorite control uses aria-pressed and toggleFavorite", async () => {
  const app = await readApp();
  const inspector = await readInspectorMarkup();

  const overview = functionSlice(inspector, "detailFileSectionMarkup");
  const favoriteButton = functionSlice(inspector, "detailFavoriteButtonMarkup");
  assert.ok(overview.includes('class="detail-overview-title-row"'), "favorite shares the title row");
  assert.ok(overview.includes("${detailFavoriteButtonMarkup(asset)}"), "overview renders the favorite control");
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
  assert.match(promptSection, /const userInstructionMarkup = `<div class="detail-prompt-subhead">/);
  assert.match(promptSection, /<div class="detail-prompt-subhead"><h4>\$\{t\("userInstruction"\)\}<\/h4>/);
  assert.match(promptSection, /detail-instruction-box/);
  assert.match(promptSection, /\$\{promptText\}<\/div>\$\{promptProvenance\}\$\{userInstructionMarkup\}/);
  assert.match(i18n, /userInstruction: "用户指令"/);
  assert.match(i18n, /userInstruction: "User instruction"/);
  assert.match(i18n, /userInstructionUnavailable: "未提供用户指令"/);
  assert.match(i18n, /userInstructionUnavailable: "No user instruction provided"/);
});

// 18. Source section exists. 19. Source copy entry exists. 20. buildSourceRows kept.
test("18-20. source section keeps buildSourceRows and a conditional copy entry", async () => {
  const app = await readApp();
  const inspector = await readInspectorMarkup();

  const sourceSection = functionSlice(inspector, "detailSourceSectionMarkup");
  assert.ok(sourceSection.includes('data-inspector-section="source"'));
  assert.match(sourceSection, /buildSourceRows\(source\)/, "source rows still come from buildSourceRows");
  assert.match(sourceSection, /const copyButton = sourceCopyValue\(source\)\n\s+\? `<button class="section-head-copy" type="button" data-action="copy-source"/);
  assert.match(sourceSection, /data-action="copy-source" title="\$\{t\("copyOriginalPath"\)\}" aria-label="\$\{t\("copyOriginalPath"\)\}"/);
  // Empty source falls back to notRecorded instead of an empty table.
  assert.match(sourceSection, /<p class="empty-copy">\$\{t\("notRecorded"\)\}<\/p>/);
  const bindDetailEvents = functionSlice(app, "bindDetailEvents");
  assert.match(bindDetailEvents, /copy-source.*clipboard\.writeText\(sourceCopyValue\(asset\.source\)\)/s, "copy-source copies the original path");
});

test("source navigation exposes only reliable generation session and batch actions", async () => {
  const [app, inspector, i18n] = await Promise.all([readApp(), readInspectorMarkup(), readI18n()]);
  const sourceSection = functionSlice(inspector, "detailSourceSectionMarkup");
  const sourceRows = functionSlice(inspector, "buildSourceRows");
  const navigation = functionSlice(app, "showRelatedGenerations");
  const bindings = functionSlice(app, "bindDetailEvents");

  assert.match(sourceRows, /\["sessionId", source\.conversation_id\]/);
  assert.match(sourceRows, /\["generationBatch", source\.message_id\]/);
  assert.match(sourceSection, /const sessionActions = conversationId/);
  assert.match(sourceSection, /messageId \? `<button[^`]*data-action="view-generation-batch"/);
  assert.match(sourceSection, /data-action="view-generation-session"/);
  assert.match(navigation, /if \(!conversationId \|\| \(mode === "batch" && !messageId\)\) return;/);
  assert.match(navigation, /state\.scope = "all";\s*state\.mediaKind = "all";\s*clearFacets\(\);\s*state\.facets\.conversation = conversationId;/);
  assert.match(navigation, /if \(mode === "batch"\) state\.facets\.generationBatch = messageId;/);
  assert.match(bindings, /view-generation-session[^\n]*showRelatedGenerations\(asset, "session"\)/);
  assert.match(bindings, /view-generation-batch[^\n]*showRelatedGenerations\(asset, "batch"\)/);
  for (const key of ["generationNavigation", "viewGenerationBatch", "viewGenerationSession"]) {
    assert.equal(count(i18n, `${key}:`), 2, `${key} must exist in both locales`);
  }
});

// 21. Version section position. 22. Version history stays on-demand.
// 23. Recipe history stays reachable.
test("21-23. version section position and on-demand history disclosures", async () => {
  const app = await readApp();
  const inspector = await readInspectorMarkup();

  // 21. Version sits after source and before group in the V2 column.
  const versionIndex = COMPOSITION.indexOf("detailVersionSectionMarkup");
  assert.ok(versionIndex > COMPOSITION.indexOf("detailSourceSectionMarkup"));
  assert.ok(versionIndex < COMPOSITION.indexOf("detailGroupSectionMarkup"));

  // 22. Version history lives behind a disclosure that is closed by default.
  const versionSection = functionSlice(inspector, "detailVersionSectionMarkup");
  assert.match(versionSection, /<details class="detail-disclosure"><summary>\$\{t\("versionHistory"\)\}<\/summary>/);
  assert.doesNotMatch(versionSection, /<details class="detail-disclosure" open>/);
  assert.match(versionSection, /data-version-history aria-live="polite"/);
  // The current-version summary stays visible outside the disclosure.
  assert.match(inspector, /function detailVersionSummaryMarkup\(asset\)/);

  // 23. Recipe snapshot history stays reachable behind its own disclosure,
  // also closed by default, and still lazy-loaded after render.
  const recipeDisclosure = functionSlice(inspector, "recipeHistoryDisclosureMarkup");
  assert.match(recipeDisclosure, /<details class="detail-disclosure"><summary>\$\{t\("recipeSnapshotHistory"\)\}<\/summary>/);
  assert.doesNotMatch(recipeDisclosure, /<details class="detail-disclosure" open>/);
  assert.match(recipeDisclosure, /data-recipe-history aria-live="polite"/);
  assert.ok(functionSlice(app, "renderDetail").includes("void loadRecipeHistory(asset);"));
});

// 24. Group section is a read-only readout (no editing control).
test("24. group section is display-only", async () => {
  const inspector = await readInspectorMarkup();

  const groupSection = functionSlice(inspector, "detailGroupSectionMarkup");
  assert.ok(groupSection.includes('data-inspector-section="group"'));
  assert.match(groupSection, /<p class="inspector-readout">/);
  assert.doesNotMatch(groupSection, /<input|<select|<textarea|contenteditable|data-edit=/);
  assert.match(groupSection, /t\("notGrouped"\)/, "empty group falls back to the notGrouped copy");
});

// 25. Tags section is 7th. 26. Prompt-derived chips render. 27. The add action is persistent. 28. The section remains bounded.
test("25-28. tags section renders prompt-derived chips and add action (D3)", async () => {
  const [app, inspector, i18n] = await Promise.all([readApp(), readInspectorMarkup(), readI18n()]);

  // 25. Tags sits after file (overview) and before prompt so it lands directly
  // under the basic information block.
  const tagsIndex = COMPOSITION.indexOf("detailTagsSectionMarkup");
  assert.ok(tagsIndex > COMPOSITION.indexOf("detailFileSectionMarkup"));
  assert.ok(tagsIndex < COMPOSITION.indexOf("detailPromptSectionMarkup"));

  const tagsSection = functionSlice(inspector, "detailTagsSectionMarkup");
  assert.ok(tagsSection.includes('data-inspector-section="tags"'));
  // 26–28. Tags are derived from the asset prompt, the add action is always rendered,
  // and the visual row is bounded by the implementation stylesheet.
  assert.match(tagsSection, /assetTags\(asset\)/);
  assert.match(tagsSection, /class="detail-tag"/);
  assert.match(tagsSection, /data-action="add-tag"/);
  assert.match(tagsSection, /t\("addTag"\)/);
  const css = await readCss();
  assert.match(css, /\.detail-tags-row \{[^}]*max-height: 56px/);
  assert.match(i18n, /tagsAutoHint: "从提示词自动提取"/);
  assert.match(i18n, /addTag: "添加标签"/);
});

// 32. Save Version is 8th. 33. The action describes the version operation MOSA actually performs.
test("32-33. new-version section position and honest save action", async () => {
  const inspector = await readInspectorMarkup();

  // 32. New-version is the 8th section (after group, before more).
  const newVersionIndex = COMPOSITION.indexOf("detailNewVersionSectionMarkup");
  assert.ok(newVersionIndex > COMPOSITION.indexOf("detailGroupSectionMarkup"));
  assert.ok(newVersionIndex < COMPOSITION.indexOf("detailMoreSectionMarkup"));

  // 33. Version composer contains only the change note and explicit save action;
  // it must not imply that MOSA calls an image-generation model.
  const newVersionSection = functionSlice(inspector, "detailNewVersionSectionMarkup");
  assert.ok(newVersionSection.includes('data-inspector-section="new-version"'));
  assert.match(newVersionSection, /detail-regenerate-composer/);
  assert.match(newVersionSection, /<textarea data-version-change/);
  assert.match(newVersionSection, /data-action="save-version"/);
  assert.match(newVersionSection, /detail-save-version/);
  assert.match(newVersionSection, /createRecipeVersionDescription/);
  assert.doesNotMatch(newVersionSection, /Imagen 4|Flux|data-composer-select|data-resolution|detail-composer-send/);
});

// 34. More is 9th. 35. Archive stays a separated danger action.
test("34-35. more section last, archive kept as a separated danger action", async () => {
  const inspector = await readInspectorMarkup();

  // 34. More is the final section.
  assert.ok(COMPOSITION.indexOf("detailMoreSectionMarkup") > COMPOSITION.indexOf("detailNewVersionSectionMarkup"));
  assert.ok(COMPOSITION.endsWith("${detailMoreSectionMarkup(asset)}"));

  const moreSection = functionSlice(inspector, "detailMoreSectionMarkup");
  assert.ok(moreSection.includes('data-inspector-section="more"'));
  // Phase 4C: the original-media entry renders through the centralized capability
  // helper (desktop-finder / web-open / unavailable) instead of a fixed button.
  assert.match(moreSection, /\$\{originalMediaActionMarkup\(asset\)\}/);
  assert.match(inspector, /function originalMediaCapability\(asset\)/);
  // Utility actions migrated as secondary buttons inside the native disclosure.
  assert.match(moreSection, /<details class="detail-disclosure" data-more-actions>/);
  assert.match(moreSection, /<button class="action-btn secondary" type="button" data-action="regenerate">/);
  assert.match(moreSection, /<button class="action-btn secondary" type="button" data-action="copy-path">/);
  // 35. Archive stays danger, visually separated from the utility cluster.
  assert.match(moreSection, /<div class="detail-danger-actions"><button class="action-btn danger" type="button" data-action="archive-asset">/);
  // No ellipsis overflow menu is introduced.
  assert.doesNotMatch(moreSection, /ellipsis|overflow-menu|⋯|…/);
});

// 36. Editing ability stays inside a disclosure. 37. Reference rights preserved.
test("36-37. recipe editing and reference rights stay inside disclosures", async () => {
  const app = await readApp();
  const inspector = await readInspectorMarkup();

  // 36. The full recipe edit form lives behind the "recipe and editing"
  // disclosure inside the prompt section — closed by default.
  const promptSection = functionSlice(inspector, "detailPromptSectionMarkup");
  assert.match(promptSection, /<details class="detail-disclosure"><summary>\$\{t\("recipeAndEditing"\)\}<\/summary><div class="disclosure-content detail-fields">\$\{editRecipeFieldsMarkup\(asset\)\}/);
  assert.doesNotMatch(promptSection, /<details class="detail-disclosure" open>/);
  const editFields = functionSlice(inspector, "editRecipeFieldsMarkup");
  assert.match(editFields, /data-edit="prompt"/);
  assert.match(editFields, /data-edit="business_fields"/);
  assert.match(promptSection, /<button class="recipe-save-btn secondary" type="button" data-action="save-recipe">/);

  // 37. Reference rights stay reachable from the source section disclosure,
  // and the deep link no longer depends on switching tabs.
  const sourceSection = functionSlice(inspector, "detailSourceSectionMarkup");
  assert.match(sourceSection, /<details class="detail-disclosure" data-reference-rights-section><summary>\$\{t\("referenceRights"\)\}<\/summary><div class="disclosure-content" data-reference-rights>\$\{referenceRightsMarkup\(asset\)\}<\/div><\/details>/);
  assert.match(app, /function bindReferenceRightsEvents\(panel, asset, renderId\)/);
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
  assert.doesNotMatch(app + inspector, /role="tabpanel"/);
  assert.doesNotMatch(app + inspector, /aria-labelledby="detailTab/);
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
  assert.equal(sha256(JSON.stringify(manifest.dependencies)), "73c83773a57e21a20917d81b24288bdfddd9bb7ddd644fdaedd6e6cfba13c405", "package.json dependencies must stay untouched");
  assert.equal(sha256(JSON.stringify(manifest.devDependencies)), "11f67ce00f34b4d3dfb9b9ed0dfb428b0368ad5e0a17bd3bafaa40e3c2124fac", "package.json devDependencies must stay untouched");
  assert.equal(sha256(lock), "ecf0fdc199de87ccd30ffe6a7da4624c2f632700cd8348194a30b79dd2e2a69f", "package-lock.json must stay untouched");

  // 51. app.js gains no new imports (no new runtime dependencies).
  assert.deepEqual([...app.matchAll(/^import .* from "(.*)";$/gm)].map((match) => match[1]).sort(),
    ["./api-client.mjs", "./asset-view.mjs", "./bridge-status-poller.mjs", "./confirm-dialog.mjs", "./context-menu-actions.mjs", "./context-menu-bindings.mjs", "./context-menu.mjs", "./i18n-runtime.mjs", "./image-preview.mjs", "./inspector-markup.mjs", "./overlay-manager.mjs", "./tag-utils.mjs", "./toast-manager.mjs"], "app.js imports only the local tag utility");
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
    [/createNewVersion: "创建新版本"/, /createNewVersion: "Create new version"/],
    [/moreActions: "更多操作"/, /moreActions: "More actions"/],
    [/recipeAndEditing: "配方与编辑"/, /recipeAndEditing: "Recipe and editing"/],
    [/notGrouped: "未分组"/, /notGrouped: "Ungrouped"/],
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
  assert.match(renderDetail, /if \(hadPanelFocus\) els\.detailPanel\.querySelector\("#detailTitle"\)\?\.focus\(\);/);
  assert.match(app, /let detailRenderedAssetId = null;/);
});
