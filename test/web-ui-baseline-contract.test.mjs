// Web UI baseline contract。web/app 是唯一一份界面样式（桌面端复用这份）：
// 锁定具体设计数值的契约在 web-r21-* 各文件与样式快照里，本文件只守
// web/app/styles.css 与具体数值无关的基线规则——改版可以换颜色、换尺寸、
// 换选择器，但不许丢掉这些底层能力。任何具体数值（按钮最小尺寸、顶栏高度、
// 断点等）都不属于这里。
// [hidden] 配对契约见 test/hidden-attribute-contract.test.mjs。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const readWebCss = () => readFile(resolve(root, "web/app/styles.css"), "utf8");

/** Extracts a `{...}` block starting at the marker, honouring nested braces. */
function blockAfter(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start > -1, `marker not found: ${marker}`);
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

test("web styles stay free of !important", async () => {
  const css = await readWebCss();
  // 去掉 CSS 注释后再判：注释中的说明性文字（如“不使用 !important”）不算违规。
  const declarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(declarations, /!important/, "web styles.css must stay free of !important");
});

test("web styles keep a prefers-reduced-motion block", async () => {
  const css = await readWebCss();
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/,
    "web styles.css must keep a prefers-reduced-motion media query");
});

test("web styles keep :focus-visible rules", async () => {
  const css = await readWebCss();
  assert.match(css, /:focus-visible/, "keyboard focus must stay visible in web styles.css");
});

test("web styles define dark-theme color tokens", async () => {
  const css = await readWebCss();
  const dark = blockAfter(css, ':root[data-theme="dark"]');
  assert.match(dark, /--color-accent\s*:/, 'the [data-theme="dark"] block must define --color-accent');
});
