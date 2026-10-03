// 任务 50 契约：浅色全局辅助灰 --color-text-tertiary 加深到 WCAG AA（≥4.5:1）。
// 只读 web/app/styles.css：从浅色 token 块读出实际值，按 WCAG 相对亮度公式对
// 浅色主题里 tertiary 文字实际落到的每一种底色算对比度；并断言被替换的两个
// 旧灰值从声明体里消失（注释里的引用不算，先剥注释再扫声明体）。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const readWebCss = () => readFile(resolve(root, "web/app/styles.css"), "utf8");

// 找出声明体里用到某个色值的所有规则的选择器；写法同 web-r21-inspector-contrast.test.mjs。
function selectorsUsingColor(css, hex) {
  const selectors = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = pattern.exec(css))) {
    if (match[2].includes(hex)) selectors.push(match[1]);
  }
  return selectors;
}

// WCAG 2.x 相对亮度（sRGB 十六进制）。
function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)]
    .sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

test("light --color-text-tertiary reaches WCAG AA on every light background it sits on", async () => {
  const css = await readWebCss();
  const lightStart = css.indexOf(':root[data-theme="light"]');
  const lightEnd = css.indexOf("设计令牌：深色");
  const light = css.slice(lightStart, lightEnd);
  const token = /--color-text-tertiary:\s*(#[0-9a-f]{6});/.exec(light)?.[1];
  assert.ok(token, "light --color-text-tertiary token must exist");
  // 白（卡片/弹窗）、#fbfbfc（浅色侧栏）、#f6f6f7（画廊底/--app-bg）、
  // #f5f5f7（--app-input/--app-hover）、#efeff1（搜索框底/--app-search）。
  for (const background of ["#ffffff", "#fbfbfc", "#f6f6f7", "#f5f5f7", "#efeff1"]) {
    const ratio = contrastRatio(token, background);
    assert.ok(
      ratio >= 4.5,
      `light tertiary ${token} on ${background} is ${ratio.toFixed(2)}:1, below WCAG AA 4.5:1`,
    );
  }
});

test("the superseded light greys are gone from declaration bodies (comments excluded)", async () => {
  const css = await readWebCss();
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const hex of ["#85858b", "#8b8b91", "#919197", "#9a9aa0", "#8e8e94"]) {
    const selectors = selectorsUsingColor(withoutComments, hex);
    assert.equal(
      selectors.length, 0,
      `${hex} must be gone from declarations (任务 50 deepened light tertiary), used by: ${selectors.map((selector) => selector.trim().split("\n").at(-1)).join(" | ")}`,
    );
  }
});
