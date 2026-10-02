// R21（Web 端）检视器主体契约（任务 24，头部以下区块）：只读 web/app/styles.css。
// 锁定：区块左右内边距 24 与 1px 分隔线、小标题 10.5px/590、标签 4/8 内边距与
// 10px 字号、提示词框四项、参考图 3 列网格、来源卡边框/圆角/按钮行、表单控件
// 高 32/圆角 8、本任务新增字号下限 10px，以及浅色覆盖后 hover/active 语义补回。
// 任务 41：区块小标题复制按钮改带文字后按 AA 校色（#929297 → #6e6e73）。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const readWebCss = () => readFile(resolve(root, "web/app/styles.css"), "utf8");

// 同一选择器在样式表里出现多次时，浏览器用的是最后一组；任务 24 的规则全部
// 追加在文件末尾，这里一律按「最后一次出现」取块（写法同 web-r21-inspector-head）。
// 选择器可能写在逗号分组里（组的声明在最后一个成员之后），所以选择器后面
// 允许跟「 {」或「,\n」，再吞到本条规则的收尾大括号。
function lastBlock(css, selector) {
  const pattern = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: \\{|,\\n)[^}]*\\}`, "g");
  const blocks = css.match(pattern) || [];
  assert.ok(blocks.length, `${selector} must exist`);
  return blocks.at(-1);
}

test("R21 inspector body: sections share the head's 24px side padding with 1px separators", async () => {
  const css = await readWebCss();
  for (const section of [".detail-prompt-section", ".detail-source-section", ".detail-version-section", ".detail-group-section"]) {
    const block = lastBlock(css, `.mosa-v2 .detail ${section}`);
    assert.match(block, /padding: var\(--r21-s5\) var\(--r21-s6\);/, `${section} must use 20/24 padding`);
  }
  const more = lastBlock(css, '.mosa-v2 .detail .inspector-section[data-inspector-section="more"]');
  assert.match(more, /padding: var\(--r21-s5\) var\(--r21-s6\);/);
  assert.match(more, /border-top: 1px solid transparent;/, "the more section reserves a separator without colouring dark mode");
  // 标签区块：设计稿里它紧跟头部，第一条分隔线画在提示词区块上方。
  const tags = lastBlock(css, ".mosa-v2 .detail .detail-tags-section");
  assert.match(tags, /padding: var\(--r21-s4\) var\(--r21-s6\) var\(--r21-s5\);/);
  // 浅色分隔线统一 #e7e7ea；深色沿用既有 token（不得出现深色作用域的 #e7e7ea）。
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail :is\(\.detail-prompt-section, \.detail-source-section, \.detail-version-section, \.detail-group-section, \.inspector-section\[data-inspector-section="more"\]\) \{\n  border-top-color: #e7e7ea;\n\}/);
});

test("section titles read as R21 sec-head (10.5px/590) with copy buttons in .copy grey", async () => {
  const css = await readWebCss();
  const title = lastBlock(css, ".mosa-v2 .detail .detail-prompt-head h3");
  assert.match(title, /font-size: 10\.5px;/);
  assert.match(title, /font-weight: 590;/);
  const summary = lastBlock(css, ".mosa-v2 .detail .detail-source-summary > span");
  assert.match(summary, /font-size: 10\.5px;/);
  assert.match(summary, /font-weight: 590;/);
  const disclosure = lastBlock(css, ".mosa-v2 .detail .detail-disclosure > summary");
  assert.match(disclosure, /font-size: 10\.5px;/);
  assert.match(disclosure, /font-weight: 590;/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail :is\(\.detail-prompt-head h3, \.detail-prompt-subhead h4, \.detail-source-summary > span, \.detail-disclosure > summary, \.detail-fields \.field > span\) \{\n  color: #8d8d93;\n\}/);
  // 任务 41：复制按钮带文字后按 AA 校色——R21 稿 #929297 只有 2.99:1，加深为 #6e6e73
  // （面板 #fbfbfc 上 4.90:1）；同一 :is 块里的来源摘要 strong 一并达标。
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail :is\(\.detail-prompt-head \.section-head-copy, \.detail-copy-sub, \.detail-source-copy \.section-head-copy, \.detail-source-summary > strong\) \{\n  color: #6e6e73;\n\}/);
  const icon = lastBlock(css, ".mosa-v2 .detail .detail-prompt-head .section-head-copy svg");
  assert.match(icon, /width: 12px;/);
  assert.match(icon, /height: 12px;/);
});

test("tags use 4/8 padding, the 8px radius and the 10px floor with the light palette", async () => {
  const css = await readWebCss();
  const tag = lastBlock(css, ".mosa-v2 .detail .detail-tag");
  assert.match(css, /--inspector-radius-sm: 8px;/, "the tag radius token must stay 8px");
  assert.match(tag, /padding: var\(--r21-s1\) var\(--r21-s2\);/);
  assert.match(tag, /border-radius: var\(--inspector-radius-sm\);/);
  assert.match(tag, /font-size: 10px;/);
  const tagLight = /:root\[data-theme="light"\] \.mosa-v2 \.detail \.detail-tag \{[^}]*\}/.exec(css)?.[0];
  assert.match(tagLight, /border-color: transparent;/);
  assert.match(tagLight, /background: #f0f0f2;/);
  assert.match(tagLight, /color: #5b5b61;/);
  const row = lastBlock(css, ".mosa-v2 .detail .detail-tags-row");
  assert.match(row, /gap: var\(--r21-s2\);/, "tags must sit 8px apart");
});

test("prompt and instruction boxes carry the R21 prompt-box values", async () => {
  const css = await readWebCss();
  const box = lastBlock(css, ".mosa-v2 .detail .detail-prompt-box");
  assert.match(box, /padding: var\(--r21-s3\);/);
  assert.match(box, /border-radius: var\(--inspector-radius-sm\);/);
  assert.match(box, /font-size: 10\.5px;/);
  assert.match(box, /line-height: 1\.58;/);
  const light = /:root\[data-theme="light"\] \.mosa-v2 \.detail \.detail-prompt-box,\n:root\[data-theme="light"\] \.mosa-v2 \.detail \.detail-instruction-box \{[^}]*\}/.exec(css)?.[0];
  assert.match(light, /border-color: transparent;/);
  assert.match(light, /background: #f3f3f5;/);
  assert.match(light, /color: #4a4a50;/);
});

test("reference thumbnails form a 3-column 1.3:1 grid with light chrome and grey count", async () => {
  const css = await readWebCss();
  const grid = lastBlock(css, ".mosa-v2 .detail .detail-reference-thumbnails");
  assert.match(grid, /display: grid;/);
  assert.match(grid, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(grid, /gap: var\(--r21-s2\);/);
  const thumb = lastBlock(css, ".mosa-v2 .detail .detail-reference-thumb");
  assert.match(thumb, /aspect-ratio: 1\.3 \/ 1;/);
  assert.match(thumb, /border-radius: var\(--inspector-radius-sm\);/);
  const thumbLight = /:root\[data-theme="light"\] \.mosa-v2 \.detail \.detail-reference-thumb \{[^}]*\}/.exec(css)?.[0];
  assert.match(thumbLight, /border-color: #e4e4e7;/);
  assert.match(thumbLight, /background: #ededf0;/);
  const value = lastBlock(css, ".mosa-v2 .detail .detail-reference-summary .detail-reference-value");
  assert.match(value, /font-weight: 450;/);
  const row = lastBlock(css, ".mosa-v2 .detail .detail-reference-row");
  assert.match(row, /font-size: 10\.5px;/);
});

test("source facts render as an R21 context card with an equal-split action row", async () => {
  const css = await readWebCss();
  const table = lastBlock(css, ".mosa-v2 .detail .detail-source-content .meta-table");
  assert.match(table, /gap: var\(--r21-s1\);/);
  assert.match(table, /padding: var\(--r21-s3\);/);
  assert.match(table, /border: 1px solid transparent;/);
  assert.match(table, /border-radius: var\(--inspector-radius-sm\);/);
  const tableLight = /:root\[data-theme="light"\] \.mosa-v2 \.detail \.detail-source-content \.meta-table \{[^}]*\}/.exec(css)?.[0];
  assert.match(tableLight, /border-color: #e7e7ea;/);
  assert.match(tableLight, /background: #fafafa;/);
  const metaKey = lastBlock(css, ".mosa-v2 .detail .detail-source-content .meta-key");
  assert.match(metaKey, /font-size: 10px;/);
  const metaVal = lastBlock(css, ".mosa-v2 .detail .detail-source-content .meta-val");
  assert.match(metaVal, /text-align: right;/, "source values must right-align like R21 context-facts");
  assert.match(metaVal, /overflow-wrap: normal;/, "source values must stay single-line with ellipsis");
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail \.detail-source-content \.meta-key \{\n  color: #a0a0a6;\n\}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail \.detail-source-content \.meta-val \{\n  color: #66666c;\n\}/);
  const nav = lastBlock(css, ".mosa-v2 .detail .detail-source-content .generation-navigation");
  assert.match(nav, /display: grid;/);
  assert.match(nav, /grid-template-columns: repeat\(auto-fit, minmax\(0, 1fr\)\);/);
  assert.match(nav, /padding: var\(--r21-s2\);/);
  const navLight = /:root\[data-theme="light"\] \.mosa-v2 \.detail \.detail-source-content \.generation-navigation \{[^}]*\}/.exec(css)?.[0];
  assert.match(navLight, /border-top-color: #e7e7ea;/);
  assert.match(navLight, /background: #f7f7f8;/);
  const navBtn = lastBlock(css, ".mosa-v2 .detail .generation-navigation .action-btn");
  assert.match(navBtn, /min-height: 28px;/);
  assert.match(navBtn, /border-radius: var\(--inspector-radius-sm\);/);
  assert.match(navBtn, /font-size: 10px;/);
  const navBtnLight = /:root\[data-theme="light"\] \.mosa-v2 \.detail \.generation-navigation \.action-btn \{[^}]*\}/.exec(css)?.[0];
  assert.match(navBtnLight, /background: #ececef;/);
  assert.match(navBtnLight, /color: #606066;/);
});

test("version area unifies to the 10-10.5px scale with 12px row pitch and 8px radii", async () => {
  const css = await readWebCss();
  const timeline = lastBlock(css, ".mosa-v2 .detail .version-timeline");
  assert.match(timeline, /gap: var\(--r21-s3\);/, "version rows must sit 12px apart");
  const single = lastBlock(css, ".mosa-v2 .detail .version-single strong");
  assert.match(single, /font-size: 10\.5px;/);
  const picker = lastBlock(css, ".mosa-v2 .detail .version-picker select");
  assert.match(picker, /border-radius: var\(--inspector-radius-sm\);/);
  assert.match(picker, /font-size: 10\.5px;/);
  const compareSelect = lastBlock(css, ".mosa-v2 .detail .version-compare-controls select");
  assert.match(compareSelect, /height: 32px;/);
  assert.match(compareSelect, /border-radius: var\(--inspector-radius-sm\);/);
  const compareGrid = lastBlock(css, ".mosa-v2 .detail .version-compare-grid");
  assert.match(compareGrid, /border-radius: var\(--inspector-radius-sm\);/);
  const compareHead = lastBlock(css, ".mosa-v2 .detail .version-compare-head strong");
  assert.match(compareHead, /font-size: 10px;/);
  const compareRow = lastBlock(css, ".mosa-v2 .detail .version-compare-row > span");
  assert.match(compareRow, /font-size: 10px;/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail :is\(\.version-single strong, \.version-summary-label strong\) \{\n  color: var\(--color-accent\);\n\}/);
});

test("recipe form controls are 32px tall, 8px radii, borderless in light mode", async () => {
  const css = await readWebCss();
  const label = lastBlock(css, ".mosa-v2 .detail .detail-fields .field > span");
  assert.match(label, /font-size: 10\.5px;/);
  assert.match(label, /font-weight: 590;/);
  const input = lastBlock(css, ".mosa-v2 .detail .detail-fields input");
  assert.match(input, /height: 32px;/);
  assert.match(input, /padding: 0 var\(--r21-s3\);/);
  assert.match(input, /border-radius: var\(--inspector-radius-sm\);/);
  const textarea = lastBlock(css, ".mosa-v2 .detail .detail-fields textarea");
  assert.match(textarea, /padding: var\(--r21-s3\);/);
  const light = /:root\[data-theme="light"\] \.mosa-v2 \.detail \.detail-fields :is\(input, textarea, select\) \{[^}]*\}/.exec(css)?.[0];
  assert.match(light, /border-color: transparent;/);
  assert.match(light, /background: #f3f3f5;/);
  const two = lastBlock(css, ".mosa-v2 .detail .two");
  assert.match(two, /gap: var\(--r21-s2\);/);
});

test("light overrides re-declare the hover/active semantics they would otherwise bury", async () => {
  const css = await readWebCss();
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail \.detail-tags-add:hover \{[^}]*color: var\(--color-text-primary\);[^}]*\}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail :is\(\.detail-prompt-head \.section-head-copy, \.detail-copy-sub, \.detail-source-copy \.section-head-copy\):hover \{[^}]*color: var\(--color-text-primary\);[^}]*\}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail \.generation-navigation \.action-btn:not\(:disabled\):not\(\[aria-disabled="true"\]\):hover \{[^}]*background: #e6e6e9;[^}]*\}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail \.generation-navigation \.action-btn:not\(:disabled\):not\(\[aria-disabled="true"\]\):active \{[^}]*background: #e0e0e4;[^}]*\}/);
});

test("every font size added by this task stays at or above the 10px floor", async () => {
  const css = await readWebCss();
  const marker = css.indexOf("R21 检视器主体");
  assert.notEqual(marker, -1, "the task 24 block must exist");
  const added = css.slice(marker);
  const sizes = [...added.matchAll(/font-size: (\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
  assert.ok(sizes.length >= 20, `expected the task's font sizes to be pinned (got ${sizes.length})`);
  for (const size of sizes) {
    assert.ok(size >= 10, `every added font-size must stay >= 10px (got ${size}px)`);
  }
});
