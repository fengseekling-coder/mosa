// 任务 43 契约：检视器里其余低对比度文字在浅色作用域加深到 ≥4.5:1（WCAG AA）。
// 只读 web/app/styles.css。锁定：每一处的新颜色、新颜色只出现在浅色作用域、
// 全局 token --color-text-tertiary 的值（浅色在任务 50 加深为 AA #67676d，深色保持原值）。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const readWebCss = () => readFile(resolve(root, "web/app/styles.css"), "utf8");

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

test("task-43 recolours: every AA-darkened spot carries its new value in the light scope", async () => {
  const css = await readWebCss();
  // 面板（#fbfbfc）上的辅助文字统一 #707076（4.76:1）。
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail \.asset-kind \{ color: #707076; \}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail \.more-location \.meta-key \{\n  color: #707076;\n\}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail :is\(\.version-history-status, \.generation-history-status, \.recipe-history-status\) \{\n  color: #707076;\n\}/);
  // 文件信息与来源区的「未记录」都在面板上，同用 #707076。
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail :is\(\.head-facts, \.detail-source-content\) \.empty-copy \{\n  color: #707076;\n\}/);
  // #f3f3f5 面上的占位与参考图行文字统一 #6e6e73（4.58:1）；任务 110：提示词 /
  // 用户指令框的占位改回 token tertiary（随主题），参考图行文字保持 #6e6e73。
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail \.detail-prompt-box \.empty-copy,\n:root\[data-theme="light"\] \.mosa-v2 \.detail \.detail-instruction-box \.empty-copy \{\n  color: var\(--color-text-tertiary\);\n\}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail :is\(\.detail-reference-summary \.detail-reference-label, \.detail-reference-row \.detail-reference-label\) \{\n  color: #6e6e73;\n\}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail :is\(\.detail-reference-summary \.detail-reference-value, \.detail-reference-row \.detail-reference-value\) \{\n  color: #6e6e73;\n\}/);
});

test("the AA greys stay in the light scope and the tertiary token keeps its value", async () => {
  const css = await readWebCss();
  // #707076 全库只允许出现在浅色作用域。
  for (const selector of selectorsUsingColor(css, "#707076")) {
    assert.match(selector, /data-theme="light"/, `#707076 must stay inside :root[data-theme="light"] (selector: ${selector.trim().split("\n").at(-1)})`);
  }
  // #6e6e73 的本任务新增块已由上一条测试的锚定正则逐条要求 light 前缀；它另在
  // 主题无关的 V2 基础规则（.detail .meta-key/.meta-val 等，深色有覆盖）中合法存在，
  // 不做全局断言。旧色值不得再出现在任何声明体里（注释里的引用不算）。
  for (const hex of ["#8d8d93", "#929297"]) {
    assert.equal(selectorsUsingColor(css, hex).length, 0, `${hex} must be gone from declarations`);
  }
  // --color-text-tertiary：浅色在任务 50 加深到 AA #67676d，深色保持原值。
  assert.match(css, /--color-text-tertiary: #67676d;/, "light tertiary token is the AA #67676d");
  assert.match(css, /--color-text-tertiary: #a0a0a6;/, "dark tertiary token value unchanged");
});

test("the user-instruction placeholder matches the prompt placeholder in the dark theme", async () => {
  const css = await readWebCss();
  // 深色下用户指令框「未提供用户指令」曾漏到全局 tertiary（4.43:1）；任务 43 起与
  // 提示词框占位同走 secondary。任务 110 把浅色统一成 token tertiary，深色仍是 secondary
  // （框底色是面板色叠 6% 白，tertiary 在上面只有 4.43:1）。
  assert.match(css, /:root\[data-theme="dark"\] \.mosa-v2 \.detail \.detail-reference-value,\n:root\[data-theme="dark"\] \.mosa-v2 \.detail \.detail-prompt-box \.empty-copy,\n:root\[data-theme="dark"\] \.mosa-v2 \.detail \.detail-instruction-box \.empty-copy \{\n  color: var\(--color-text-secondary\);\n\}/);
  // 任务 110：主题无关组里两个占位同走 token tertiary（原 secondary 组拆出组尾）。
  assert.match(css, /\.mosa-v2 \.detail \.detail-prompt-box \.empty-copy,\n\.mosa-v2 \.detail \.detail-instruction-box \.empty-copy \{\n  color: var\(--color-text-tertiary\);\n\}/);
});
