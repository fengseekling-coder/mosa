// 任务 41 契约：检视器版本历史竖线时间轴 + 带文字的复制按钮 + 文件信息键名 AA 对比度。
// markup 断言只读 web/app/inspector-markup.mjs 与 web/app/i18n.mjs，样式断言只读
// web/app/styles.css；本任务新增的 R21 颜色必须只出现在浅色作用域（深色沿用既有
// token，见各断言），新增字号不得低于 10px。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const readWebCss = () => readFile(resolve(root, "web/app/styles.css"), "utf8");
const readInspectorMarkup = () => readFile(resolve(root, "web/app/inspector-markup.mjs"), "utf8");
const readI18n = () => readFile(resolve(root, "web/app/i18n.mjs"), "utf8");

function functionSlice(source, name) {
  let start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function not found: ${name}`);
  const candidates = [source.indexOf("\nfunction ", start + 1), source.indexOf("\nasync function ", start + 1), source.indexOf("\n  function ", start + 1), source.indexOf("\n  async function ", start + 1)]
    .filter((index) => index !== -1);
  const next = candidates.length ? Math.min(...candidates) : -1;
  return source.slice(start, next === -1 ? source.length : next);
}

// 同一选择器在样式表里出现多次时浏览器用最后一组；这里一律取「最后一次出现」
// 的规则块（写法同 web-r21-inspector-body 的 lastBlock，行首锚定）。
function lastBlock(css, selector) {
  const pattern = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: \\{|,\\n)[^}]*\\}`, "g");
  const blocks = css.match(pattern) || [];
  assert.ok(blocks.length, `${selector} must exist`);
  return blocks.at(-1);
}

// 找出声明体里用到某个色值的所有规则的选择器；用于锁「新颜色只在浅色作用域」。
function selectorsUsingColor(css, hex) {
  const selectors = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = pattern.exec(css))) {
    if (match[2].includes(hex)) selectors.push(match[1]);
  }
  return selectors;
}

test("version history rows render the three-column timeline structure", async () => {
  const inspector = await readInspectorMarkup();
  const history = functionSlice(inspector, "versionHistoryMarkup");

  // 行的可交互契约不变：button[data-version-id] + aria-current + time[datetime] + 深度类。
  assert.match(history, /<li class="version-timeline-item version-depth-\$\{depth\}/);
  assert.match(history, /<button type="button" data-version-id="\$\{escapeHtml\(version\.id\)\}"/);
  assert.match(history, /\$\{selected \? ' aria-current="true"' : ""\}/);
  assert.match(history, /<span class="version-marker" aria-hidden="true"><\/span>/);
  assert.match(history, /<time datetime="\$\{escapeHtml\(version\.created_at \|\| ""\)\}">/);

  // 三栏：版本号格只放 strong（徽标移走，保证各行列位对齐）；说明格承载
  // 「当前版本 / 已归档」标记；时间格收尾。
  assert.match(history, /<span class="version-title"><strong>\$\{escapeHtml\(t\("versionLabel", \{ number: version\.version_index \}\)\)\}<\/strong><\/span>/);
  assert.match(history, /<span class="version-change">\$\{escapeHtml\(change\)\}\$\{selected \? `<span class="version-current">/);
  assert.match(history, /\$\{version\.archived \? `<span class="version-archived">\$\{t\("archivedVersion"\)\}<\/span>` : ""\}<\/span><time datetime=/);
});

test("timeline draws the per-row 1px rail that stops at the end dots", async () => {
  const css = await readWebCss();
  const line = lastBlock(css, ".mosa-v2 .detail .version-timeline-item::before");
  assert.match(line, /position: absolute;/);
  assert.match(line, /top: calc\(-1 \* var\(--r21-s3\)\);/, "the rail must cross the 12px row gap");
  assert.match(line, /bottom: 0;/);
  assert.match(line, /left: 12px;/, "the rail sits on the marker's x centre (8px padding + 4px half dot)");
  assert.match(line, /width: 1px;/);
  assert.match(line, /background: var\(--color-border-subtle\);/, "dark keeps the existing border token");
  assert.match(lastBlock(css, ".mosa-v2 .detail .version-timeline-item:first-child::before"), /top: 16px;/);
  assert.match(lastBlock(css, ".mosa-v2 .detail .version-timeline-item:last-child::before"), /bottom: calc\(100% - 16px\);/);
  assert.match(lastBlock(css, ".mosa-v2 .detail .version-timeline-item:only-child::before"), /content: none;/, "a single row draws no rail");
  // 浅色竖线用 R21 的 #dcdce1；深色走 token（上方断言）。
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail \.version-timeline-item::before \{\n  background: #dcdce1;\n\}/);
});

test("timeline dots, three-column grid and per-column type are locked", async () => {
  const css = await readWebCss();
  const marker = lastBlock(css, ".mosa-v2 .detail .version-marker");
  assert.match(marker, /position: relative;/, "the dot must paint above the rail");
  assert.match(marker, /box-sizing: border-box;/, "the 8px dot is the outer size");
  assert.match(marker, /border-width: 1px;/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail \.version-marker \{\n  border-color: #a8a8ae;\n  background: #ffffff;\n\}/);
  // 选中圆点：accent 实心 + 2px 浅 accent 光圈；深色光圈用 token 调出。
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail \.version-timeline-item\.selected \.version-marker \{\n  border-color: var\(--color-accent\);\n  background: var\(--color-accent\);\n  box-shadow: 0 0 0 2px #e8e8ff;\n\}/);
  assert.match(css, /:root\[data-theme="dark"\] \.mosa-v2 \.detail \.version-timeline-item\.selected \.version-marker \{\n  box-shadow: 0 0 0 2px color-mix\(in srgb, var\(--color-accent\) 35%, transparent\);\n\}/);

  const content = lastBlock(css, ".mosa-v2 .detail .version-content");
  assert.match(content, /grid-template-columns: auto minmax\(0, 1fr\) auto;/);
  assert.match(content, /column-gap: var\(--r21-s2\);/, "8px between the three columns");
  assert.match(content, /align-items: baseline;/);

  const strong = lastBlock(css, ".mosa-v2 .detail .version-title strong");
  assert.match(strong, /font-family: var\(--font-family-mono\);/);
  assert.match(strong, /font-weight: var\(--weight-semibold\);/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail \.version-title strong \{\n  color: #58585e;\n\}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail \.version-timeline-item\.selected \.version-title strong \{\n  color: var\(--color-accent\);\n\}/);

  const change = lastBlock(css, ".mosa-v2 .detail .version-change");
  assert.match(change, /display: flex;/);
  assert.match(change, /flex-wrap: wrap;/, "the description must wrap, badges riding along");
  assert.match(change, /line-height: var\(--text-xs-lh\);/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail \.version-change \{\n  color: #64646a;\n\}/);

  const time = lastBlock(css, ".mosa-v2 .detail .version-content time");
  assert.match(time, /font-size: var\(--text-xs\);/);
  assert.match(time, /white-space: nowrap;/);
  assert.match(time, /text-align: right;/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail \.version-content time \{\n  color: #67676d;\n\}/);
});

test("copy buttons carry a text label while keeping the full accessible name", async () => {
  const [inspector, i18n] = await Promise.all([readInspectorMarkup(), readI18n()]);

  assert.match(inspector, /const COPY_ACTION_LABEL = `<span aria-hidden="true">\$\{t\("copyAction"\)\}<\/span>`;/);
  assert.match(inspector, /const COPY_ICON_SVG = `<svg width="12" height="12"/, "the icon renders at 12×12");
  assert.match(inspector, /data-action="copy-prompt" title="\$\{t\("copyPrompt"\)\}" aria-label="\$\{t\("copyPrompt"\)\}">\$\{COPY_ICON_SVG\}\$\{COPY_ACTION_LABEL\}<\/button>/);
  assert.match(inspector, /data-action="copy-prompt" title="\$\{t\("copyPrompt"\)\}" aria-label="\$\{t\("copyPrompt"\)\}" disabled>\$\{COPY_ICON_SVG\}\$\{COPY_ACTION_LABEL\}<\/button>/);
  assert.match(inspector, /data-action="copy-source" title="\$\{t\("copyOriginalPath"\)\}" aria-label="\$\{t\("copyOriginalPath"\)\}">\$\{COPY_ICON_SVG\}\$\{COPY_ACTION_LABEL\}<\/button>/);
  // 用户指令按钮的可访问名称要点明「复制」，不再只读「用户指令」。
  assert.match(inspector, /data-action="copy-instruction" aria-label="\$\{escapeHtml\(t\("copyUserInstruction"\)\)\}"/);
  const promptSection = functionSlice(inspector, "detailPromptSectionMarkup");
  assert.doesNotMatch(promptSection, /copy-instruction" aria-label="\$\{escapeHtml\(t\("userInstruction"\)\)\}"/);

  // 新 i18n 键双语齐全；不复用含义为「副本」的 copy 键。
  assert.match(i18n, /copyAction: "复制"/);
  assert.match(i18n, /copyAction: "Copy"/);
  assert.match(i18n, /copyUserInstruction: "复制用户指令"/);
  assert.match(i18n, /copyUserInstruction: "Copy user instruction"/);
  assert.doesNotMatch(functionSlice(inspector, "createInspectorMarkup"), /t\("copy"\)/);
});

test("textful copy buttons adopt the R21 .copy metrics", async () => {
  const css = await readWebCss();
  assert.match(css, /\.mosa-v2 \.detail \.detail-prompt-head \.section-head-copy,\n\.mosa-v2 \.detail \.detail-copy-sub,\n\.mosa-v2 \.detail \.detail-source-copy \.section-head-copy \{\n  display: inline-flex;\n  width: auto;\n  min-width: 0;\n  flex: 0 0 auto;\n  gap: var\(--r21-s1\);\n  align-items: center;\n  padding: 0 var\(--inspector-space-2\);\n  font-size: var\(--text-xs\);\n  font-weight: var\(--weight-regular\);\n\}/);
  const svg = lastBlock(css, ".mosa-v2 .detail .detail-prompt-head .section-head-copy svg");
  assert.match(svg, /flex: 0 0 auto;/);
  // 浅色文字 AA（#6e6e73，4.90:1 于 #fbfbfc）——由 web-r21-inspector-body 锁同一规则块。
});

test("head facts key colour reaches AA while the value keeps a lighter key tier", async () => {
  const css = await readWebCss();
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail \.head-facts \.meta-key \{ color: #707076; \}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail \.head-facts \.meta-val \{ color: #636369; \}/);
});

test("task-41 colours stay in the light scope and new font sizes stay at or above 10px", async () => {
  const css = await readWebCss();
  for (const hex of ["#dcdce1", "#a8a8ae", "#e8e8ff", "#58585e", "#64646a", "#67676d", "#707076"]) {
    const selectors = selectorsUsingColor(css, hex);
    assert.ok(selectors.length, `${hex} must be used`);
    for (const selector of selectors) {
      assert.match(selector, /data-theme="light"/, `${hex} must stay inside :root[data-theme="light"] (selector: ${selector.trim().split("\n").at(-1)})`);
    }
  }
  // 从复制按钮规格块（第一处带此标题的规则块）扫到设置弹窗块为止——这段范围
  // 是任务 41 新增/相邻的 R21 规则；更早的检视器规则不属于本任务，不纳入。
  const start = css.indexOf("任务 41：带文字的复制按钮");
  const end = css.indexOf("R21 设置弹窗");
  assert.notEqual(start, -1, "the task 41 blocks must exist");
  assert.ok(start < end, "the task 41 blocks must precede the settings block");
  const added = css.slice(start, end);
  // 规范表 v1（任务 104）后字号走 :root 变量，这里解析 token 实际值再做下限校验。
  const tokens = new Map([...css.matchAll(/(--text-(?:xs|sm|md|lg|xl)):\s*(\d+(?:\.\d+)?)px/g)].map((m) => [m[1], Number(m[2])]));
  const sizes = [
    ...[...added.matchAll(/font-size: (\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1])),
    ...[...added.matchAll(/font-size: var\((--text-(?:xs|sm|md|lg|xl))\)/g)].map((match) => tokens.get(match[1])),
  ];
  assert.ok(sizes.length >= 4, `expected the task's font sizes to be pinned (got ${sizes.length})`);
  for (const size of sizes) {
    assert.ok(size >= 10, `every font-size in the task 41 range must stay >= 10px (got ${size}px)`);
  }
});
