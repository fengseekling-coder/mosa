import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

// 检视器用户标签删除契约：用户标签 chip 内的 × 按钮（data-action="remove-tag"）直接
// 删除并整体 PATCH tags（与 openTagEditor submit 同一保存语义），来源标签纯展示无
// 删除入口；保存期间禁用按钮，成功后刷新标签区并把焦点交还给下一个标签。
// Node 标准库、零网络、源码切片断言；界面合一后只读 web/app 这一份。

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

const count = (source, needle) => source.split(needle).length - 1;

/** Slices a top-level function up to the next top-level function. */
function functionSlice(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function not found: ${name}`);
  const candidates = ["\nfunction ", "\nasync function "]
    .map((marker) => source.indexOf(marker, start + 1))
    .filter((index) => index !== -1);
  const next = candidates.length ? Math.min(...candidates) : -1;
  return source.slice(start, next === -1 ? source.length : next);
}

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `marker not found: ${endMarker}`);
  return source.slice(start, end);
}

test("markup. only user tags render; the source chip stays removed (A4a)", async () => {
  const inspector = await read("web/app/inspector-markup.mjs");
  const tagsSection = functionSlice(inspector, "detailTagsSectionMarkup");

  // GravityPort A4a：来源标签芯片从标签行拿掉（来源在头部「来源 · 日期」行显示），
  // 锁「不得回来」；用户标签 chip 行为不变。
  assert.doesNotMatch(tagsSection, /detail-source-tag|const sourceMarkup/, "the source chip must not come back to the tags row");

  assert.match(tagsSection, /<span class="detail-tag" data-tag-value="\$\{escapeHtml\(tag\)\}"><span class="detail-tag-label">\$\{escapeHtml\(tag\)\}<\/span><button class="detail-tag-remove" type="button" data-action="remove-tag" data-tag-value="\$\{escapeHtml\(tag\)\}" aria-label="\$\{escapeHtml\(t\("removeTag", \{ tag \}\)\)\}">×<\/button><\/span>/,
    "each user tag ends with a real <button> × carrying type, action, value, and i18n aria-label");
  assert.equal(count(tagsSection, 'type="button" data-action="remove-tag"'), 1, "exactly one remove-button template");
  // 显示上限不变：删掉一个后第 10 个自然补位；超过上限时由 +N 按钮收起（任务 35）。
  assert.match(tagsSection, /allTags\.slice\(0, DETAIL_TAGS_VISIBLE_LIMIT\)/, "the 9-tag display cap stays, spelled via the named limit constant");
  assert.match(inspector, /export const DETAIL_TAGS_VISIBLE_LIMIT = 9;/, "the display cap stays a single named constant");
});

test("markup. the +N toggle is a real button with aria-expanded and i18n names", async () => {
  const inspector = await read("web/app/inspector-markup.mjs");
  const tagsSection = functionSlice(inspector, "detailTagsSectionMarkup");

  assert.match(tagsSection, /<button class="detail-tags-toggle" type="button" data-action="toggle-tags" aria-expanded="\$\{expanded\}"/,
    "the +N control is a real <button> with type, action, and aria-expanded");
  assert.match(tagsSection, /aria-label="\$\{escapeHtml\(expanded \? t\("collapseTags"\) : t\("showMoreTags", \{ count: overflowCount \}\)\)\}"/,
    "the accessible name carries the hidden count when collapsed and the collapse copy when expanded");
  assert.match(tagsSection, /<span aria-hidden="true">\$\{expanded \? escapeHtml\(t\("collapseTagsShort"\)\) : `\+\$\{overflowCount\}`\}<\/span>/,
    "the visible +N / short label is presentational");
  assert.match(tagsSection, /const tags = expanded \? allTags : allTags\.slice\(0, DETAIL_TAGS_VISIBLE_LIMIT\);/,
    "collapsed mode renders only the visible slice — hidden tags never enter the DOM, so no display:none bookkeeping");
});

test("app. the +N toggle flips the session flag, re-renders the row, and keeps focus on the toggle", async () => {
  const app = await read("web/app/app.mjs");
  const toggle = functionSlice(app, "toggleDetailTagsExpanded");

  assert.match(toggle, /state\.detailTagsExpanded = !state\.detailTagsExpanded;/, "the session flag flips in place");
  assert.match(toggle, /refreshDetailTagsSection\(asset, renderId\);/, "the row re-renders through the same path as tag writes");
  assert.match(toggle, /querySelector\('\[data-action="toggle-tags"\]'\)\?\.focus\(\);/, "focus returns to the re-rendered toggle button");
});

test("app. adding past the cap auto-expands; the toggle is bound on full render and section refresh", async () => {
  const app = await read("web/app/app.mjs");
  const tagEditor = functionSlice(app, "openTagEditor");
  const bindDetailEvents = functionSlice(app, "bindDetailEvents");
  const refreshTags = functionSlice(app, "refreshDetailTagsSection");

  assert.match(tagEditor, /assetTags\(result\.asset\)\.length > DETAIL_TAGS_VISIBLE_LIMIT\) state\.detailTagsExpanded = true;/,
    "a collapsed row auto-expands when a new tag lands past the cap");
  assert.match(bindDetailEvents, /querySelector\('\[data-action="toggle-tags"\]'\)\?\.addEventListener\("click", \(\) => toggleDetailTagsExpanded\(asset, renderId\)\);/,
    "bindDetailEvents wires the initial toggle");
  assert.match(refreshTags, /querySelector\('\[data-action="toggle-tags"\]'\)\?\.addEventListener\("click", \(\) => toggleDetailTagsExpanded\(asset, renderId\)\);/,
    "refreshDetailTagsSection re-binds the re-rendered toggle");
});

test("app. removeDetailTag PATCHes assetTags minus the removed tag and updates state", async () => {
  const app = await read("web/app/app.mjs");
  const removeTag = functionSlice(app, "removeDetailTag");

  assert.match(removeTag, /latestAssetSnapshot\(asset\.project_id, asset\.id, asset\)/, "the base is the latest asset snapshot");
  assert.match(removeTag, /assetTags\(currentAsset\)\.filter\(\(tag\) => tag\.toLocaleLowerCase\(\) !== target\)/,
    "PATCH tags = assetTags minus the removed tag");
  assert.match(removeTag, /apiFetch\(`\/api\/assets\/\$\{encodeURIComponent\(asset\.project_id\)\}\/\$\{encodeURIComponent\(asset\.id\)\}`, \{ method: "PATCH", body: \{ tags \} \}\)/,
    "the whole list is PATCHed to the asset endpoint");
  assert.match(removeTag, /state\.detailAsset = result\.asset;/, "state.detailAsset follows the saved asset");
  assert.match(removeTag, /state\.assets\.findIndex\(\(item\) => item\.id === asset\.id\)/, "the gallery entry is updated too");
  assert.match(removeTag, /showToast\(t\("tagRemoved"\), "success"\);/, "success announces the new tagRemoved copy");
  assert.match(removeTag, /refreshDetailTagsSection\(result\.asset, renderId\);/, "the tags section re-renders after saving");
  assert.doesNotMatch(removeTag, /confirmDialog|confirm-dialog/, "no confirmation dialog before deleting");
  // 保存期间锁住整个标签区的增删控件：每次写入都是整表 PATCH，并发的第二次
  // 写入会以旧快照为基准把刚删掉的标签写回来。失败时控件恢复、标签保持原样。
  assert.match(removeTag, /querySelectorAll\('\[data-action="remove-tag"\], \[data-action="add-tag"\]'\)/,
    "all tag controls in the section are collected");
  assert.match(removeTag, /tagControls\.forEach\(\(control\) => \{ control\.disabled = true; \}\);/,
    "every tag control is disabled while saving");
  assert.match(removeTag, /\.finally\(\(\) => \{\s*\n\s*tagControls\.forEach\(\(control\) => \{ if \(control\.isConnected\) control\.disabled = false; \}\);/,
    "the still-mounted tag controls re-enable after a failure");
});

test("app. focus moves to the next tag's remove button, else the add-tag button", async () => {
  const app = await read("web/app/app.mjs");
  const removeTag = functionSlice(app, "removeDetailTag");

  assert.match(removeTag, /querySelectorAll\('\[data-action="remove-tag"\]'\)\]\.indexOf\(button\)/, "the removed slot is remembered");
  assert.match(removeTag, /querySelectorAll\('\[data-action="remove-tag"\]'\)\[removedIndex\]\s*\n\s*\|\| .*querySelector\('\[data-action="add-tag"\]'\)/,
    "focus prefers the next tag's button and falls back to the add-tag button");
});

test("app. remove buttons are bound on full render and re-bound on section refresh", async () => {
  const app = await read("web/app/app.mjs");
  const bindDetailEvents = functionSlice(app, "bindDetailEvents");
  const refreshTags = functionSlice(app, "refreshDetailTagsSection");

  assert.match(bindDetailEvents, /querySelectorAll\('\[data-action="remove-tag"\]'\)\.forEach\(\(button\) => \{\s*\n\s*button\.addEventListener\("click", \(\) => removeDetailTag\(panel, button, asset, renderId\)\);/,
    "bindDetailEvents wires the initial remove buttons");
  assert.match(refreshTags, /querySelectorAll\('\[data-action="remove-tag"\]'\)\.forEach\(\(button\) => \{\s*\n\s*button\.addEventListener\("click", \(\) => removeDetailTag\(els\.detailPanel, button, asset, renderId\)\);/,
    "refreshDetailTagsSection re-binds the re-rendered remove buttons");
});

test("i18n. removeTag and tagRemoved are symmetric across zh and en", async () => {
  const i18n = await read("web/app/i18n.mjs");

  for (const key of ["removeTag", "tagRemoved", "showMoreTags", "collapseTags", "collapseTagsShort"]) {
    assert.equal(count(i18n, `${key}:`), 2, `${key} exists exactly once per locale`);
  }
  assert.equal(count(i18n, 'removeTag: "删除标签「{tag}」"'), 1, "the zh aria-label names the tag");
  assert.equal(count(i18n, 'removeTag: "Remove tag \\"{tag}\\""'), 1, "the en aria-label names the tag");
  assert.equal(count(i18n, 'tagRemoved: "已删除标签"'), 1, "the zh success toast");
  assert.equal(count(i18n, 'tagRemoved: "Tag removed"'), 1, "the en success toast");
  // The accessible name starts with the visible "+N" / "收起" / "Less" text so
  // voice-control users can activate the toggle by what they see (WCAG 2.5.3).
  assert.equal(count(i18n, 'showMoreTags: "+{count}，显示其余 {count} 个标签"'), 1, "the zh collapsed label carries the visible +N and the hidden count");
  assert.equal(count(i18n, 'showMoreTags: "+{count}, show {count} more tags"'), 1, "the en collapsed label carries the visible +N and the hidden count");
  assert.equal(count(i18n, 'collapseTags: "收起标签"'), 1, "the zh expanded label contains the visible 收起");
  assert.equal(count(i18n, 'collapseTags: "Less, collapse tags"'), 1, "the en expanded label contains the visible Less");
  assert.equal(count(i18n, 'collapseTagsShort: "收起"'), 1, "the zh expanded visible label");
  assert.equal(count(i18n, 'collapseTagsShort: "Less"'), 1, "the en expanded visible label");
});

test("styles. the remove button hides by default, shows on hover/focus, and never uses display:none", async () => {
  const css = await read("web/app/styles.css");
  const removeRule = sliceBetween(css, ".detail-tag-remove {", "}\n");
  const revealRule = sliceBetween(css, ".detail-tag:hover .detail-tag-remove", "}\n");
  const touchBlock = sliceBetween(css, "@media (hover: none), (pointer: coarse) {", "}\n");

  assert.match(removeRule, /opacity: 0;/, "hidden by default via opacity");
  assert.doesNotMatch(removeRule, /display: none/, "display:none would drop the button from the tab order");
  assert.match(removeRule, /align-self: stretch;/, "the hit area fills the pill height without raising it");
  assert.match(revealRule, /opacity: 1;/, "hover or focus-within reveals the button");
  assert.match(revealRule, /\.detail-tag:focus-within \.detail-tag-remove/, "keyboard focus inside the tag reveals it");
  assert.match(touchBlock, /\.detail-tag-remove \{ width: 24px; opacity: 1;/, "touch devices always show a wider button");
});

