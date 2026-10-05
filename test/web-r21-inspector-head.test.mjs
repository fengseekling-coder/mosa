// R21（Web 端）检视器外框与头部契约：只读 web/app/styles.css、
// web/app/inspector-markup.mjs、web/app/i18n.mjs。锁定：320 宽度 token（GravityPort）、
// 头部 14px/640、两栏头部（132px 左栏预览）、e2e 必需元素仍在
// detailFileSectionMarkup 输出里、五个事实键名、「素材详情」文案、
// 新增字号下限 10px（R21 的 8.5～9.5px 一律抬到 10px）。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const readWebCss = () => readFile(resolve(root, "web/app/styles.css"), "utf8");
const readWebMarkup = () => readFile(resolve(root, "web/app/inspector-markup.mjs"), "utf8");
const readWebI18n = () => readFile(resolve(root, "web/app/i18n.mjs"), "utf8");

/** Slices a top-level module function up to the next top-level function. */
function functionSlice(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function not found: ${name}`);
  const candidates = ["\nfunction ", "\nasync function ", "\n  function ", "\n  async function "]
    .map((marker) => source.indexOf(marker, start + 1))
    .filter((index) => index !== -1);
  const next = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, next === -1 ? source.length : next);
}

test("R21 inspector frame: 320px width token, light panel colours, 28px scroll-end padding", async () => {
  const css = await readWebCss();
  assert.match(css, /--inspector-width: 320px;/, "--inspector-width must be the GravityPort 320px");
  // GravityPort A1 去掉检视器左边线：外框新颜色只覆盖浅色底色；深色继续走既有 token 规则。
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail \{ background: #fbfbfc; \}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail-inspector-header \{ border-bottom-color: #e7e7ea; \}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail-inspector-scroll \{ background: #fbfbfc; \}/);
  // 底部留白 28（滚动列的内边距，符合外框规格）。
  assert.match(css, /\.mosa-v2 \.detail-inspector-scroll \{[\s\S]*?padding: 0 0 var\(--r21-s7\);/);
});

test("R21 inspector header: 64px height, 14px/640 title, 28x28 round close button", async () => {
  const css = await readWebCss();
  const header = /\.mosa-v2 \.detail-inspector-header \{[^}]*\}/.exec(css)?.[0];
  assert.ok(header, "the V2 header rule must exist");
  assert.match(header, /min-height: var\(--topbar-height\);/, "the header must share the 64px topbar token");
  assert.match(header, /padding: 0 24px;/);
  assert.match(header, /font-size: 14px;/);
  assert.match(header, /font-weight: 640;/);
  const close = /\.mosa-v2 \.detail-inspector-header \.detail-close \{[^}]*\}/.exec(css)?.[0];
  assert.match(close, /width: 28px;/);
  assert.match(close, /height: 28px;/);
  assert.match(close, /border-radius: var\(--radius-card\);/, "the close button must use the 8px radius");
});

test("R21 head layout: 132px square preview left, meta column right", async () => {
  const css = await readWebCss();
  assert.match(css, /\.mosa-v2 \.detail \.detail-overview \{[^}]*padding: var\(--inspector-space-5\) 24px 0;/,
    "the file section must sit 20px below the header with 24px side padding");
  assert.match(css, /\.mosa-v2 \.detail \.asset-head \{ display: grid; grid-template-columns: 132px minmax\(0, 1fr\); gap: var\(--inspector-space-4\); align-items: start; \}/);
  assert.match(css, /\.mosa-v2 \.detail \.asset-mini \{ position: relative; width: 132px; aspect-ratio: 1 \/ 1;[^}]*border-radius: var\(--radius-card\);/);
  assert.match(css, /\.mosa-v2 \.detail \.asset-mini img\.detail-image,\n\.mosa-v2 \.detail \.asset-mini video\.detail-image \{ object-fit: cover; \}/);
  assert.match(css, /\.mosa-v2 \.detail \.asset-name-row h3 \{[^}]*font-size: 14px;[^}]*font-weight: 650;[^}]*-webkit-line-clamp: 2;/);
  assert.match(css, /\.mosa-v2 \.detail \.asset-name-row \.detail-overview-open \{ display: inline-grid; width: 28px; height: 28px;/);
});

test("detailFileSectionMarkup keeps every e2e-critical anchor and the five fact keys", async () => {
  const markup = await readWebMarkup();
  const section = functionSlice(markup, "detailFileSectionMarkup");
  // e2e 依赖：区块标识、焦点标题、预览图、收藏按钮、打开原始会话按钮。
  assert.match(section, /data-inspector-section="file"/);
  assert.match(section, /<h3 id="detailTitle" tabindex="-1"/);
  assert.match(section, /\$\{assetMediaPreviewMarkup\(asset, "detail"\)\}/);
  assert.match(section, /\$\{detailFavoriteButtonMarkup\(asset\)\}/);
  assert.match(section, /data-action="view-generation-session"/);
  // 隐藏的小标题（aria-labelledby 指向它），用现成的 visually-hidden 类。
  assert.match(section, /<h3 id="assetOverviewTitle" class="visually-hidden">/);
  // 五个事实键名与取值函数保持不变（标签改为键值行）。
  for (const key of ["fileFormat", "fileDimensions", "aspectRatio", "fileSize", "group"]) {
    assert.match(section, new RegExp(`\\["${key}", `), `fact key ${key} must stay`);
  }
  assert.match(section, /fileFactRowMarkup\(key, value\)/, "facts render as key-value rows");
  // 旧宽图几何属性不再输出。
  assert.doesNotMatch(section, /data-detail-preview-aspect|detail-image-wrap|detail-overview-heading|detail-overview-title-row|class="detail-facts"/);
});

test("web title copy is 素材详情 / Asset details", async () => {
  const i18n = await readWebI18n();
  assert.match(i18n, /assetInspector: "素材详情"/);
  assert.match(i18n, /assetInspector: "Asset details"/);
});

test("every font size added by this task stays at or above the 10px floor", async () => {
  const css = await readWebCss();
  const rules = {
    "header title": /\.mosa-v2 \.detail-inspector-header \{[^}]*font-size: (\d+(?:\.\d+)?)px;/,
    "head title": /\.mosa-v2 \.detail \.asset-name-row h3 \{[^}]*font-size: (\d+(?:\.\d+)?)px;/,
    "source line": /\.mosa-v2 \.detail \.asset-kind \{[^}]*font-size: (\d+(?:\.\d+)?)px;/,
    "fact key": /\.mosa-v2 \.detail \.head-facts \.meta-key \{[^}]*font-size: (\d+(?:\.\d+)?)px;/,
    "fact value": /\.mosa-v2 \.detail \.head-facts \.meta-val \{[^}]*font-size: (\d+(?:\.\d+)?)px;/,
  };
  for (const [label, pattern] of Object.entries(rules)) {
    const size = Number(pattern.exec(css)?.[1]);
    assert.ok(size >= 10, `${label} font-size must stay >= 10px (got ${size}px)`);
  }
});

// 同一选择器在样式表里出现多次时，浏览器用的是最后一组。头部标题、内边距、背景、
// 关闭按钮都在文件后部还有一组规则（约 1923 行起），这里锁的是最后生效的那组。
test("the last-declared header rules carry the R21 values (cascade order)", async () => {
  const css = await readFile(resolve(root, "web/app/styles.css"), "utf8");
  const lastBlock = (selector) => {
    const pattern = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{[^}]*\\}`, "g");
    const blocks = css.match(pattern) || [];
    assert.ok(blocks.length, `${selector} must exist`);
    return blocks.at(-1);
  };
  const header = lastBlock(".mosa-v2 .detail-inspector-header");
  assert.match(header, /padding: 0 var\(--r21-s6\);/);
  assert.match(header, /background: transparent;/);
  const title = lastBlock(".mosa-v2 .detail-inspector-header > span");
  assert.match(title, /font-size: 14px;/);
  assert.match(title, /font-weight: 640;/);
  const close = lastBlock(".mosa-v2 .detail-inspector-header .detail-close");
  assert.match(close, /width: 28px;/);
  assert.match(close, /height: 28px;/);
  // 标题行里的收藏按钮只显示图标（按钮自带 aria-label），把宽度让给两行标题。
  assert.match(css, /\.mosa-v2 \.asset-name-row \.detail-fav-btn \{ width: 28px;[^}]*\}/);
  assert.match(css, /\.mosa-v2 \.asset-name-row \.detail-fav-btn > span:not\(\[aria-hidden\]\) \{ display: none; \}/);
  // 头部区块是检视器的第一个区块，它与头部的距离照 R21 是 20（原来被 :first-child 规则压成 16）。
  assert.match(css, /\.mosa-v2 \.detail \.inspector-section:first-child \{ padding-top: var\(--r21-s5\); \}/);
});
