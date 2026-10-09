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

test("R21 inspector frame: 280px width token, light panel colours, 28px scroll-end padding", async () => {
  const css = await readWebCss();
  assert.match(css, /--inspector-width: 280px;/, "--inspector-width must be the spec-table v1 280px (was GravityPort 320px)");
  // GravityPort A1 去掉检视器左边线：外框新颜色只覆盖浅色底色；深色继续走既有 token 规则。
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail \{ background: #fbfbfc; \}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail-inspector-header \{ border-bottom-color: #e7e7ea; \}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail-inspector-scroll \{ background: #fbfbfc; \}/);
  // 底部留白 28（滚动列的内边距，符合外框规格）。
  assert.match(css, /\.mosa-v2 \.detail-inspector-scroll \{[\s\S]*?padding: 0 0 var\(--sp-6\);/);
});

test("R21 inspector header: topbar token height, 15px title (A4a 返工 1 + 规范表 v1), 28x28 round close button", async () => {
  const css = await readWebCss();
  const header = /\.mosa-v2 \.detail-inspector-header \{[^}]*\}/.exec(css)?.[0];
  assert.ok(header, "the V2 header rule must exist");
  assert.match(header, /min-height: var\(--topbar-height\);/, "the header must share the topbar token (48px, 规范表 v1)");
  // 稿子标题 16px(V2 基础块仍写 14px,A4a 后置覆盖块抬到 16)；规范表 v1 归 lg(15px)。
  assert.match(css, /\.mosa-v2 \.detail \.detail-inspector-header > span \{ font-size: var\(--text-lg\); \}/);
  assert.match(header, /font-size: var\(--text-md\);/);
  assert.match(header, /font-weight: var\(--weight-semibold\);/);
  const close = /\.mosa-v2 \.detail-inspector-header \.detail-close \{[^}]*\}/.exec(css)?.[0];
  assert.match(close, /width: 28px;/);
  assert.match(close, /height: 28px;/);
  assert.match(close, /border-radius: var\(--radius-md\);/, "the close button must use the 8px radius");
});

test("A4a head layout: 130px square preview left, meta column right, icon-only star", async () => {
  const css = await readWebCss();
  // GravityPort A4a：缩略图 130×130 无圆角（量数）；左右内边距 20；名称 17px。
  const headerBlocks = css.match(/\.mosa-v2 \.detail-inspector-header \{[^}]*\}/g) || [];
  assert.ok(headerBlocks.at(-1).includes("padding: 0 var(--sp-5);"), "the last header rule carries the 20px A4a side padding");
  assert.match(css, /\.mosa-v2 \.detail \.detail-overview \{ padding: 0 var\(--sp-5\) var\(--sp-2\); \}/,
    "the file section hugs the header with the 20px side padding");
  assert.match(css, /\.mosa-v2 \.detail \.asset-head \{ grid-template-columns: 130px minmax\(0, 1fr\); \}/);
  const mini = /\.mosa-v2 \.detail \.asset-mini \{[^}]*\}/g;
  const miniBlocks = css.match(mini) || [];
  assert.ok(miniBlocks.at(-1).includes("width: 130px;"), "the preview tile is 130px wide");
  assert.ok(miniBlocks.at(-1).includes("border-radius: 0;"), "the design preview has no corner radius");
  assert.match(css, /\.mosa-v2 \.detail \.asset-mini img\.detail-image,\n\.mosa-v2 \.detail \.asset-mini video\.detail-image \{ object-fit: cover; \}/);
  // A4a：字号抬到 17px 在后置覆盖块里，650 字重与两行截断仍在基础块；规范表 v1 归 lg/semibold。
  assert.match(css, /\.mosa-v2 \.detail \.asset-name-row h3 \{[^}]*font-weight: var\(--weight-semibold\);[^}]*-webkit-line-clamp: 2;/);
  assert.match(css, /\.mosa-v2 \.detail \.asset-name-row h3 \{ font-size: var\(--text-lg\); line-height: var\(--text-lg-lh\); \}/);
  // A4a：头部「打开原始对话」按钮随来源信息区块一并拿掉。
  assert.doesNotMatch(css, /\.detail-overview-open/, "the head open-conversation button style must not come back");
});

test("detailFileSectionMarkup keeps every e2e-critical anchor and the five fact keys", async () => {
  const markup = await readWebMarkup();
  const section = functionSlice(markup, "detailFileSectionMarkup");
  // e2e 依赖：区块标识、焦点标题、预览图、收藏按钮。
  assert.match(section, /data-inspector-section="file"/);
  assert.match(section, /<h3 id="detailTitle" tabindex="-1"/);
  assert.match(section, /\$\{assetMediaPreviewMarkup\(asset, "detail"\)\}/);
  assert.match(section, /\$\{detailFavoriteButtonMarkup\(asset\)\}/);
  // GravityPort A4a：「打开原始对话」按钮不再输出（showRelatedGenerations 保留实现）。
  assert.doesNotMatch(section, /data-action="view-generation-session"|detail-overview-open/);
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
  // 规范表 v1（任务 104）后字号走 :root 变量，这里解析 token 实际值再做下限校验。
  const tokens = new Map([...css.matchAll(/(--text-(?:xs|sm|md|lg|xl)):\s*(\d+(?:\.\d+)?)px/g)].map((m) => [m[1], Number(m[2])]));
  assert.ok(tokens.size >= 5, `the spec-table font tokens must exist (got ${tokens.size})`);
  const pxOf = (raw) => (raw.startsWith("var(") ? tokens.get(raw.match(/--text-[\w-]+/)[0]) : Number(raw.replace("px", "")));
  const rules = [
    ["header title", /\.mosa-v2 \.detail-inspector-header \{[^}]*font-size: ((?:var\(--text-(?:xs|sm|md|lg|xl)\))|(?:\d+(?:\.\d+)?px));/],
    ["head title", /\.mosa-v2 \.detail \.asset-name-row h3 \{ font-size: ((?:var\(--text-(?:xs|sm|md|lg|xl)\))|(?:\d+(?:\.\d+)?px)); line-height: /],
    ["source line", /\.mosa-v2 \.detail \.asset-kind \{[^}]*font-size: ((?:var\(--text-(?:xs|sm|md|lg|xl)\))|(?:\d+(?:\.\d+)?px));/],
    ["fact key", /\.mosa-v2 \.detail \.head-facts \.meta-key \{[^}]*font-size: ((?:var\(--text-(?:xs|sm|md|lg|xl)\))|(?:\d+(?:\.\d+)?px));/],
    ["fact value", /\.mosa-v2 \.detail \.head-facts \.meta-val \{[^}]*font-size: ((?:var\(--text-(?:xs|sm|md|lg|xl)\))|(?:\d+(?:\.\d+)?px));/],
  ];
  for (const [label, pattern] of rules) {
    const raw = pattern.exec(css)?.[1];
    assert.ok(raw, `${label} rule must exist`);
    const px = pxOf(raw);
    assert.ok(px >= 10, `${label} font-size must stay >= 10px (got ${px}px)`);
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
  assert.match(header, /padding: 0 var\(--sp-5\);/, "the last header rule carries the A4a 20px side padding");
  assert.match(css, /\.mosa-v2 \.detail-inspector-header \{[^}]*background: transparent;/, "the V2 base keeps the transparent header background");
  const title = lastBlock(".mosa-v2 .detail-inspector-header > span");
  assert.match(title, /font-size: var\(--text-md\);/);
  assert.match(title, /font-weight: var\(--weight-semibold\);/);
  const close = lastBlock(".mosa-v2 .detail-inspector-header .detail-close");
  assert.match(close, /width: 28px;/);
  assert.match(close, /height: 28px;/);
  // 标题行里的收藏按钮只显示图标（按钮自带 aria-label），把宽度让给两行标题。
  // GravityPort A4a：按钮本身也改成纯图标（markup 不再输出文字 span），这条
  // CSS 兜底规则保留，防止未来文字 span 回归时破坏布局。
  assert.match(css, /\.mosa-v2 \.asset-name-row \.detail-fav-btn \{ width: 28px;[^}]*\}/);
  assert.match(css, /\.mosa-v2 \.asset-name-row \.detail-fav-btn > span:not\(\[aria-hidden\]\) \{ display: none; \}/);
  // A4a：头部区块紧贴 64px 头部（量数：缩略图 y=64），first-child 顶距归零。
  assert.match(css, /\.mosa-v2 \.detail \.inspector-section:first-child \{ padding-top: 0; \}/);
});
