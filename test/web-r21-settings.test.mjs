// R21（Web 端）设置弹窗两栏契约（任务 25）：只读 web/app/app.mjs、
// web/app/styles.css、web/app/i18n.mjs 与 desktop/app/app.mjs。
// 锁定：两栏框架（168px 左栏 + 1fr 内容）、tablist/tab/tabpanel 语义、
// 四个 data-settings-page 及每页应含的控件、#settingsModalTitle 与
// data-settings-close 仍在、↑↓ Home End 键盘处理、state.settingsPage 默认
// general、R21 主要尺寸（792×592、左栏 168、导航 32 高、行最小 56 高、
// 分段控件 32 高）、本任务新增字号下限 10px；桌面端仍是单栏。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const readWebApp = () => readFile(resolve(root, "web/app/app.mjs"), "utf8");
const readWebCss = () => readFile(resolve(root, "web/app/styles.css"), "utf8");
const readWebI18n = () => readFile(resolve(root, "web/app/i18n.mjs"), "utf8");
const readDesktopApp = () => readFile(resolve(root, "desktop/app/app.mjs"), "utf8");

// 同一选择器可能出现多次，浏览器用最后一组；任务 25 的规则全部追加在文件末尾，
// 这里按「最后一次出现」取块（写法同 web-r21-inspector-body，允许逗号分组）。
function lastBlock(css, selector) {
  const pattern = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: \\{|,\\n)[^}]*\\}`, "g");
  const blocks = css.match(pattern) || [];
  assert.ok(blocks.length, `${selector} must exist`);
  return blocks.at(-1);
}

/** Extracts one renderSettingsMenu template panel section by its page id. */
function panelSlice(markup, pageId) {
  const start = markup.indexOf(`data-settings-panel="${pageId}"`);
  assert.notEqual(start, -1, `panel ${pageId} must exist`);
  const end = markup.indexOf("</section>", start);
  assert.notEqual(end, -1, `panel ${pageId} must be closed`);
  return markup.slice(start, end);
}

/** Slices the R21 settings renderer region (renderSettingsMenu … activateSettingsPage). */
async function settingsRenderBody() {
  const app = await readWebApp();
  const body = /function renderSettingsMenu\(\{ force = false \} = \{\}\) \{([\s\S]*?)\n\}\n\n\/\/ 设置弹窗内焦点/.exec(app)?.[1];
  assert.ok(body, "expected the R21 settings renderer body");
  return body;
}

test("R21 settings modal renders the two-pane frame with tablist semantics", async () => {
  const body = await settingsRenderBody();
  // 对话框语义保持：role/aria-modal/labelledby/tabindex 与关闭按钮原样保留。
  assert.match(body, /class="settings-modal-card" role="dialog" aria-modal="true" aria-labelledby="settingsModalTitle" tabindex="-1"/);
  assert.match(body, /<h2 id="settingsModalTitle">\$\{t\("settings"\)\}<\/h2>/);
  assert.match(body, /class="settings-modal-close" type="button" data-settings-close/);
  // 两栏：左栏 aside（品牌 + tablist + 本地优先），右栏 main（标题栏 + 滚动内容）。
  assert.match(body, /<aside class="settings-modal-sidebar">/);
  assert.match(body, /<div class="settings-modal-brand">/);
  assert.match(body, /<nav class="settings-modal-nav" role="tablist" aria-orientation="vertical"/);
  assert.match(body, /<div class="settings-modal-main">/);
  // 四个分类按钮与四个面板一一对应：tab 构建行与 panel 构建行都带完整语义。
  assert.match(body, /class="settings-nav-tab\$\{active \? " active" : ""\}" type="button" role="tab" id="settings-tab-\$\{page\.id\}" aria-selected="\$\{active\}" aria-controls="settings-page-\$\{page\.id\}" data-settings-page="\$\{page\.id\}" tabindex="\$\{active \? 0 : -1\}"/);
  assert.match(body, /class="settings-page" role="tabpanel" id="settings-page-\$\{page\.id\}" aria-labelledby="settings-tab-\$\{page\.id\}" data-settings-panel="\$\{page\.id\}"\$\{page\.id === activePage \? "" : " hidden"\}/);
  // 非当前页用 hidden 属性隐藏；右栏标题栏显示当前分类名。
  assert.match(body, /data-settings-active-title/);
});

test("each category page holds exactly its own rows and controls", async () => {
  const body = await settingsRenderBody();
  // 四页顺序固定，行内容复用既有 row() 变量。
  assert.match(body, /\{ id: "general", label: t\("settingsPageGeneral"\), description: t\("settingsPageGeneralDesc"\), rows: appearanceRows,/);
  assert.match(body, /\{ id: "library", label: t\("settingsPageLibrary"\), description: t\("settingsPageLibraryDesc"\), rows: storageRows,/);
  assert.match(body, /\{ id: "visual", label: t\("settingsPageVisual"\), description: t\("settingsPageVisualDesc"\), rows: visualRows,/);
  assert.match(body, /\{ id: "about", label: t\("settingsPageAbout"\), description: t\("settingsPageAboutDesc"\), rows: aboutRow,/);
  // 常规与外观：主题、素材卡片信息、界面语言。
  const appearanceRows = /const appearanceRows = \[([\s\S]*?)\]\.join\(""\);/.exec(body)?.[1] || "";
  assert.match(appearanceRows, /data-appearance-opt/);
  assert.match(appearanceRows, /data-card-info-opt/);
  assert.match(appearanceRows, /data-locale/);
  // 素材库与存储：素材库位置（含打开/更换，按钮在 changeLibraryControl 里）+ 存储引擎。
  const changeLibraryControl = /const changeLibraryControl = window\.electronAPI\?\.changeLibraryLocation\s*\n\s*\? `([\s\S]*?)`\n\s*: `([\s\S]*?)`;/.exec(body);
  assert.ok(changeLibraryControl, "expected the changeLibraryControl template");
  const libraryControlMarkup = `${changeLibraryControl[1]}${changeLibraryControl[2]}`;
  assert.match(libraryControlMarkup, /data-open-library/);
  assert.match(libraryControlMarkup, /data-change-library/);
  const storageRows = /const storageRows = \[([\s\S]*?)\]\.join\(""\);/.exec(body)?.[1] || "";
  assert.match(storageRows, /data-settings-library-path/);
  assert.match(storageRows, /, changeLibraryControl, "settings-library-row"/);
  assert.match(storageRows, /data-settings-storage-engine/);
  // 本地视觉能力：视觉模型状态行；关于 MOSA：版本 / 更新行。
  const visualRows = /const visualRows = row\(([\s\S]*?)\);\n  const aboutRow/.exec(body)?.[1] || "";
  assert.match(visualRows, /data-settings-visual-model/);
  const aboutRow = /const aboutRow = row\(([\s\S]*?)\);\n\n  \/\/ R21 两栏设置/.exec(body)?.[1] || "";
  assert.match(aboutRow, /data-settings-version/);
  assert.match(aboutRow, /data-settings-update-action/);
  // 控件不串页。
  assert.doesNotMatch(storageRows, /data-appearance-opt|data-locale/);
  assert.doesNotMatch(appearanceRows, /data-settings-library-path|data-settings-version/);
  // 每页有页标题、说明与 R21 卡片容器。
  assert.match(body, /class="settings-page-head"><h3 class="settings-page-title">\$\{page\.label\}<\/h3><p class="settings-page-desc">\$\{page\.description\}<\/p><\/div><div class="settings-group">\$\{page\.rows\}<\/div>/);
  // 左栏底部本地优先说明。
  assert.match(body, /class="settings-local-first"/);
  assert.match(body, /\$\{t\("settingsLocalFirst"\)\}/);
  assert.match(body, /\$\{t\("settingsLocalFirstDesc"\)\}/);
});

test("category switching keeps the roving-tabindex keyboard contract", async () => {
  const app = await readWebApp();
  // ↑/↓ 移动并自动激活，Home/End 到首/末；激活复用 click 业务路径。
  assert.match(app, /function handleSettingsMenuKeydown\(event\)[\s\S]*?const tab = event\.target\.closest\?\.\('\[role="tab"\]'\)[\s\S]*?ArrowDown" \|\| event\.key === "ArrowRight"[\s\S]*?ArrowUp" \|\| event\.key === "ArrowLeft"[\s\S]*?Home[\s\S]*?End[\s\S]*?tabs\[next\]\.click\(\);[\s\S]*?tabs\[next\]\.focus\(\);/);
  // 点击分支与唯一激活入口：同步 aria-selected、tabindex、面板 hidden。
  assert.match(app, /const settingsPageTab = event\.target\.closest\("\[data-settings-page\]"\);\n    if \(settingsPageTab\) \{ activateSettingsPage\(settingsPageTab\.dataset\.settingsPage\); return; \}/);
  assert.match(app, /function activateSettingsPage\(pageId\)[\s\S]*?aria-selected[\s\S]*?tabIndex = active \? 0 : -1[\s\S]*?panel\.hidden = panel\.dataset\.settingsPanel !== pageId/);
  // state.settingsPage：会话内记忆，默认 general，非法值回退 general。
  assert.match(app, /settingsPage: "general",/);
  assert.match(app, /if \(!settingsPages\.some\(\(page\) => page\.id === state\.settingsPage\)\) state\.settingsPage = "general";/);
  // 可见重建（语言切换）后焦点恢复：先记录身份，再优先回原控件、其次回当前分类标签。
  assert.match(app, /function describeSettingsFocus\(element\)/);
  assert.match(app, /function restoreSettingsFocus\(previousFocus\)/);
  assert.match(app, /const previousFocus = refreshingVisibleDialog \? describeSettingsFocus\(document\.activeElement\) : null;/);
  assert.match(app, /restoreSettingsFocus\(previousFocus\);/);
});

test("R21 settings geometry: 792x592 card, 168px sidebar, 32px tabs and rows at 56px", async () => {
  const css = await readWebCss();
  const card = lastBlock(css, ".mosa-v2 .settings-modal-card");
  assert.match(card, /display: grid;/);
  assert.match(card, /grid-template-columns: 168px minmax\(0, 1fr\);/);
  assert.match(card, /width: 792px;/);
  assert.match(card, /height: 592px;/);
  assert.match(card, /border-radius: 16px;/);
  const brand = lastBlock(css, ".mosa-v2 .settings-modal-brand");
  assert.match(brand, /height: 56px;/);
  const header = lastBlock(css, ".mosa-v2 .settings-modal-header");
  assert.match(header, /height: 56px;/);
  assert.match(header, /padding: 0 20px;/);
  const close = lastBlock(css, ".mosa-v2 .settings-modal-close");
  assert.match(close, /width: 28px;/);
  assert.match(close, /height: 28px;/);
  const tab = lastBlock(css, ".mosa-v2 .settings-nav-tab");
  assert.match(tab, /height: 32px;/);
  assert.match(tab, /padding: 0 12px;/);
  assert.match(tab, /border-radius: var\(--inspector-radius-sm\);/);
  assert.match(tab, /font-size: 12px;/);
  const row = lastBlock(css, ".mosa-v2 .settings-group .settings-modal-row");
  assert.match(row, /min-height: 56px;/);
  assert.match(row, /padding: 12px 16px;/);
  const segmented = lastBlock(css, ".mosa-v2 .settings-menu .segmented");
  assert.match(segmented, /width: 156px;/);
  assert.match(segmented, /height: 32px;/);
  assert.match(segmented, /padding: 4px;/);
  const body = lastBlock(css, ".mosa-v2 .settings-modal-body");
  assert.match(body, /padding: 20px 24px 28px;/);
  const title = lastBlock(css, ".mosa-v2 .settings-page-title");
  assert.match(title, /font-size: 17px;/);
  assert.match(title, /font-weight: 660;/);
  const textAction = lastBlock(css, ".mosa-v2 .settings-text-action");
  assert.match(textAction, /min-height: 32px;/);
  assert.match(textAction, /padding: 0 12px;/);
  const path = lastBlock(css, ".mosa-v2 .settings-path");
  assert.match(path, /font-size: 10px;/);
  assert.match(path, /max-width: 352px;/);
  assert.match(path, /text-overflow: ellipsis;/);
});

test("new light-only colours scope the sidebar, dividers, tabs and segmented track", async () => {
  const css = await readWebCss();
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.settings-modal-sidebar \{\n  border-right-color: #e7e7ea;\n  background: #fbfbfc;\n\}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.settings-nav-tab \{\n  color: #5f5f65;\n\}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.settings-nav-tab\.active \{\n  color: #202024;\n  background: #ececef;\n\}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.settings-menu \.segmented \{\n  background: #f1f1f3;\n\}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.settings-menu \.segmented-btn\.active \{[^}]*color: #303035;[^}]*background: #fff;[^}]*font-weight: 590;[^}]*box-shadow: 0 0 0 1px #e2e2e5 inset;/);
  // 深色不得出现这些浅色值。
  assert.doesNotMatch(css, /\[data-theme="dark"\][^\n]*#f1f1f3/);
});

test("narrow viewports below 840px collapse the sidebar into one scrollable row", async () => {
  const css = await readWebCss();
  const narrow = /@media \(max-width: 839px\) \{[\s\S]*?\.mosa-v2 \.settings-modal-card \{[^}]*\}/.exec(css)?.[0];
  assert.ok(narrow, "the narrow-window media block must exist");
  assert.match(narrow, /width: 100%;/);
  assert.match(narrow, /max-height: calc\(100dvh - 32px\);/);
  assert.match(narrow, /flex-direction: column;/);
  const sidebar = /@media \(max-width: 839px\) \{[\s\S]*?\.mosa-v2 \.settings-modal-sidebar \{[^}]*\}/.exec(css)?.[0];
  assert.match(sidebar, /flex-direction: row;/);
  assert.match(css, /@media \(max-width: 839px\) \{[\s\S]*?\.mosa-v2 \.settings-modal-nav \{[^}]*flex-direction: row;[^}]*overflow-x: auto;/);
  assert.match(css, /@media \(max-width: 839px\) \{[\s\S]*?\.mosa-v2 \.settings-modal-foot \{\n    display: none;\n  \}/);
});

test("every font size added by this task stays at or above the 10px floor", async () => {
  const css = await readWebCss();
  const marker = css.indexOf("R21 设置弹窗");
  assert.notEqual(marker, -1, "the task 25 block must exist");
  const added = css.slice(marker);
  const sizes = [...added.matchAll(/font-size: (\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
  assert.ok(sizes.length >= 10, `expected the task's font sizes to be pinned (got ${sizes.length})`);
  for (const size of sizes) {
    assert.ok(size >= 10, `every added font-size must stay >= 10px (got ${size}px)`);
  }
});

test("web i18n carries the four category names, page descriptions and local-first copy", async () => {
  const i18n = await readWebI18n();
  for (const [key, zh, en] of [
    ["settingsPageGeneral", "常规与外观", "General & appearance"],
    ["settingsPageLibrary", "素材库与存储", "Library & storage"],
    ["settingsPageVisual", "本地视觉能力", "Local visual search"],
    ["settingsPageAbout", "关于 MOSA", "About MOSA"],
    ["settingsLocalFirst", "本地优先", "Local first"],
  ]) {
    assert.match(i18n, new RegExp(`${key}: "${zh}"`), `zh copy for ${key}`);
    assert.match(i18n, new RegExp(`${key}: "${en.replaceAll("&", "&")}"`), `en copy for ${key}`);
  }
  for (const key of ["settingsPageGeneralDesc", "settingsPageLibraryDesc", "settingsPageVisualDesc", "settingsPageAboutDesc", "settingsLocalFirstDesc"]) {
    const matches = i18n.match(new RegExp(`${key}: "`, "g")) || [];
    assert.equal(matches.length, 2, `${key} must exist in both locales`);
  }
});

test("the frozen desktop settings stays a single-pane dialog without tab semantics", async () => {
  const desktop = await readDesktopApp();
  const markup = /els\.settingsMenu\.innerHTML = `([\s\S]*?)`;/.exec(desktop)?.[1] || "";
  assert.ok(markup.includes("settings-modal-card"), "desktop settings template must exist");
  assert.doesNotMatch(markup, /role="tablist"|role="tab"|role="tabpanel"|data-settings-page|data-settings-panel/,
    "desktop renderSettingsMenu must stay single-pane");
  // 桌面端仍是 settings-block 堆叠分段的单栏渲染器。
  assert.match(desktop, /class="settings-block\$\{extraClass/, "desktop settings keeps its stacked sections");
});
