// R21（Web 端）画廊与卡片契约：只读 web/app/styles.css 与 web/app/app.mjs，
// 锁定本任务定下的 R21 值（设计稿 MOSA_UI_Integrated_R21_4px_Grid；瀑布流保留，
// 只调间距/圆角/选中态/卡片信息）。R21 新颜色只出现在浅色作用域。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const readWebCss = () => readFile(resolve(root, "web/app/styles.css"), "utf8");
const readWebApp = () => readFile(resolve(root, "web/app/app.mjs"), "utf8");

test("R21 gallery spacing: one shared 4px gap and the 0/20/32 padding (design restore)", async () => {
  const css = await readWebCss();
  // 横竖共用一个值：瀑布流估算（app.mjs）与框选命中（gallerySelectionRects）都只读它。
  // 任务 70 返工 1（设计稿还原）：16 → 4。
  assert.match(css, /--gallery-gap: 4px;/, "--gallery-gap must be the design-restored 4px");
  // 任务 70（GravityPort A3）：列数改由 --gallery-columns 驱动（app.mjs 按滑杆
  // 目标宽计算）；返工 1 对照稿子：顶部 0（第一行贴顶栏）、左右 20、底部 32 不变。
  assert.match(css, /\.mosa-v2 \.grid \{ grid-template-columns: repeat\(var\(--gallery-columns\), minmax\(0, 1fr\)\); column-gap: var\(--gallery-gap\); row-gap: 0; padding: 0 20px var\(--r21-s8\); background: transparent; \}/,
    "the V2 grid padding must be 0/20/32 (design restore)");
  // 阶梯值对齐：s5=20 / s6=24 / s8=32 / s4=16（token 本身不动，检视器等仍在用）。
  for (const [name, value] of [["--r21-s5", "20px"], ["--r21-s6", "24px"], ["--r21-s8", "32px"], ["--r21-s4", "16px"]]) {
    assert.match(css, new RegExp(`${name}: ${value};`), `${name} must stay ${value}`);
  }
});

test("R21 card radius: thumbs use --radius-card (8px) and the ring follows", async () => {
  const css = await readWebCss();
  assert.match(css, /--radius-card: 8px;/, "--radius-card must be 8px");
  assert.match(css, /\.mosa-v2 \.asset-card-select \{ border-radius: var\(--radius-card\); background: var\(--app-card\); box-shadow: none; \}/);
  assert.match(css, /\.mosa-v2 \.asset-card \.thumb, [^}]*\{ border-radius: var\(--radius-card\); \}/,
    "thumb/img/poster/placeholder must use the 8px radius token");
  // 选中框：1.5px、外扩 1px（inset -1px）、圆角跟随缩略图（8+1）。
  assert.match(css, /\.mosa-v2 \.asset-card\.selected::after, \.mosa-v2 \.asset-card\.multi-selected::after \{ content: ""; position: absolute; z-index: 4; inset: -1px; box-sizing: border-box; border: 1\.5px solid var\(--color-accent\); border-radius: calc\(var\(--radius-card\) \+ 1px\); pointer-events: none; \}/);
  // 选中框颜色：浅色 #4d4dff，深色保持 var(--color-accent)（上面那条）。
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.asset-card\.selected::after, :root\[data-theme="light"\] \.mosa-v2 \.asset-card\.multi-selected::after \{ border-color: #4d4dff; \}/);
  // 缩略图占位底色：浅色 #ececef，深色保持 var(--app-hover)（基规则不动）。
  assert.match(css, /\.thumb \{ display: block; width: 100%; height: auto; background: var\(--app-hover\); \}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.asset-card \.thumb \{ background: #ececef; \}/);
});

test("R21 card info: 12 distance, 12px/620 title, 10px non-mono meta, 12 bottom padding", async () => {
  const css = await readWebCss();
  // 信息区：上下内边距 12（顶=与缩略图的距离，底=计入卡片高度的留白），左右 2 沿用。
  assert.match(css, /\.asset-card-info \{ display: none; padding: var\(--r21-s3\) 2px; \}/);
  // 标题：12px / 620，单行省略（nowrap + ellipsis 保留）。
  assert.match(css, /\.asset-card-title \{ overflow: hidden; color: var\(--color-text-primary\); font-size: 12px; font-weight: 620; text-overflow: ellipsis; white-space: nowrap; \}/);
  // 元信息：10px、与标题间距 4、普通字体（mono 移除）、单行省略。
  const meta = /(\.asset-card-meta \{[^}]*\})/.exec(css)?.[1];
  assert.ok(meta, ".asset-card-meta rule must exist");
  assert.doesNotMatch(meta, /font-family/, "the meta row must not use the mono font anymore");
  assert.match(meta, /flex-wrap: nowrap;/, "the meta row must be single-line");
  assert.match(meta, /margin-top: var\(--r21-s1\);/, "the meta row must sit 4px below the title");
  assert.match(meta, /font-size: 10px;/);
  assert.match(meta, /overflow: hidden;/, "the meta row must clip to one line");
  // 元信息子项逐项省略。
  assert.match(css, /\.asset-card-meta > \* \{ flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; \}/);
  // 元信息颜色：浅色 #6e6e73（在 #f6f6f7 上 4.70:1，达 AA 4.5:1），深色保持 --color-text-secondary（基规则不动）。
  assert.match(css, /\.asset-card-meta \{ display: flex; flex-wrap: nowrap; gap: 2px 7px; margin-top: var\(--r21-s1\); overflow: hidden; color: var\(--color-text-secondary\); font-size: 10px; white-space: nowrap; \}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.asset-card-meta \{ color: #6e6e73; \}/);
});

test("web estimate uses the measured 61px info height; the span math is unchanged", async () => {
  const app = await readWebApp();
  const estimate = (/function estimatedGalleryCardSpan\(asset\) \{[\s\S]*?\n\}/).exec(app)?.[0];
  assert.ok(estimate, "estimatedGalleryCardSpan must exist");
  assert.match(estimate, /const infoHeight = state\.showCardInfo \? 61 : 0;/,
    "the web estimate must reserve the measured 61px info-row height");
  assert.match(estimate, /Math\.max\(48, Math\.ceil\(mediaHeight \+ infoHeight \+ gap\)\)/);
  // 间距单一来源：估算只读 --gallery-gap。
  assert.match(estimate, /getPropertyValue\("--gallery-gap"\)/);
});
