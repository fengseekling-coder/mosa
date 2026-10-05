// R21（Web 端）shell 契约：全局 token、侧边栏、顶栏。只读 web/app/styles.css，
// 锁定本任务定下的 R21 值（设计稿 MOSA_UI_Integrated_R21_4px_Grid）。
// 深色规格未定：R21 的新颜色必须只出现在浅色作用域里，深色 token 保持现状。
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

test("R21 light-theme tokens and the shared shell sizes land in web styles", async () => {
  const css = await readWebCss();
  const lightStart = css.indexOf(':root[data-theme="light"]');
  const lightEnd = css.indexOf('设计令牌：深色');
  const light = css.slice(lightStart, lightEnd);
  assert.match(light, /--app-bg: #f6f6f7;/, "light --app-bg must be the R21 #f6f6f7");
  assert.match(light, /--color-text-primary: #1d1d1f;/, "light --color-text-primary must be the R21 #1d1d1f");
  assert.match(light, /--color-text-tertiary: #67676d;/, "light --color-text-tertiary must be the AA-darkened #67676d (任务 50)");
  // 深色没有 R21 规格：token 保持现状。
  const darkStart = css.indexOf(':root[data-theme="dark"]');
  const darkEnd = css.indexOf("共享 Token");
  const dark = css.slice(darkStart, darkEnd);
  assert.match(dark, /--app-bg: #1c1c1e;/, "dark --app-bg must stay untouched");
  assert.match(dark, /--color-text-primary: #f5f5f7;/, "dark --color-text-primary must stay untouched");
  // 共享 shell 尺寸 token。
  assert.match(css, /--topbar-height: 64px;/, "--topbar-height must be the R21 64px");
  assert.match(css, /--sidebar-width: 280px;/, "--sidebar-width must be the GravityPort 280px");
  // R21 4px 结构网格阶梯（--mosa-s* 改名 --r21-*）。
  for (const [name, value] of [
    ["--r21-s1", "4px"], ["--r21-s2", "8px"], ["--r21-s3", "12px"], ["--r21-s4", "16px"],
    ["--r21-s5", "20px"], ["--r21-s6", "24px"], ["--r21-s7", "28px"], ["--r21-s8", "32px"],
    ["--r21-s10", "40px"], ["--r21-s12", "48px"], ["--r21-s14", "56px"], ["--r21-s16", "64px"],
  ]) {
    assert.match(css, new RegExp(`${name.replace(/-/g, "\\-")}: ${value.replace(".", "\\.")};`), `${name} must be ${value}`);
  }
  // 基础字号 12px。
  assert.match(css, /body \{ overflow: hidden;[^}]*font: 12px\/1\.5 var\(--font-family-ui\)/, "body base font-size must be the R21 12px");
});

test("R21 sidebar: light background, brand, nav items and group headings", async () => {
  const css = await readWebCss();
  // GravityPort A1 去掉侧栏右边线：浅色只覆盖背景；深色继续走 .mosa-v2 .sidebar 里的 token。
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.sidebar \{ background: #fbfbfc; \}/);
  assert.match(css, /\.mosa-v2 \.sidebar \{[^}]*background: rgb\(from var\(--app-sidebar\)/, "the dark fallback must keep the token-driven background");
  // 品牌区：与顶栏同高（token=64）、GravityPort A2 起文字靠右（右内边距 20）、
  // 名称 18px / 字重 500。
  const brand = blockAfter(css, ".mosa-v2 .brand {");
  assert.match(brand, /height: var\(--topbar-height\);/);
  assert.match(brand, /justify-content: flex-end;/);
  assert.match(brand, /padding: 0 20px;/);
  assert.match(css, /\.mosa-v2 \.brand-info h1 \{ color: var\(--color-text-primary\); font-size: 18px; font-weight: 500;/);
  // 导航区：上下结构不变，左右 20（GravityPort A2，项宽 280−40=240），品牌区到第一项 16；导航项间距 4。
  assert.match(css, /\.mosa-v2 \.primary-nav \{ padding: 16px 20px 10px; \}/);
  assert.match(css, /\.mosa-v2 \.nav-list \{ gap: var\(--r21-s1\); \}/);
  // 导航项：高 36、圆角 8、内边距 0 12（设置按钮与加号按钮共用这条圆角）。
  assert.match(css, /\.mosa-v2 \.nav-item, \.mosa-v2 \.add-group-button, \.mosa-v2 \.settings-trigger \{ min-height: 36px; border-radius: 8px;/);
  assert.match(css, /\.mosa-v2 \.nav-item \{ padding: 0 12px; font-size: 13px; \}/);
  assert.match(css, /\.mosa-v2 \.settings-trigger \{ width: 100%; justify-content: flex-start; gap: 8px; padding: 0 12px; font-size: 14px; \}/);
  // 选中导航项：字重 570，浅色底 #ececef。
  assert.match(css, /\.mosa-v2 \.nav-item\.active \{ color: var\(--color-text-primary\); background: var\(--app-chip-active\); font-weight: 570; \}/);
  // 浅色的灰色字色规则特异性高于 .nav-item.active，选中项必须在同一特异性下把字色改回主文字色。
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.nav-item\.active \{ background: #ececef; color: var\(--color-text-primary\); \}/);
  // 分组标题：12px / 600（GravityPort A2）；浅色不再有写死字色（任务 50 删除），回落到基础规则的 tertiary token。
  assert.match(css, /\.mosa-v2 \.nav-label \{ margin: 18px 0 6px; padding: 0 12px; color: var\(--color-text-tertiary\); font-size: 12px; font-weight: 600;/);
  assert.doesNotMatch(css, /:root\[data-theme="light"\] \.mosa-v2 \.nav-label \{/);
  // 分组之间的间距 24（GravityPort A2）。
  assert.match(css, /\.mosa-v2 \.sidebar-group-heading \{ display: flex; align-items: center; justify-content: space-between; min-height: 28px; margin: var\(--r21-s6\) 10px 2px; \}/);
  assert.match(css, /\.mosa-v2 \.sidebar-manual-group-heading \{ margin-top: var\(--r21-s6\); \}/);
  // 导航项字色：浅色 #55555a。
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.nav-item, :root\[data-theme="light"\] \.mosa-v2 \.settings-trigger \{ color: #55555a; \}/);
});

test("R21 topbar: type filters, sort control and search box", async () => {
  const css = await readWebCss();
  // 顶栏高度走 token（64px 在 token 测试里已锁）。
  assert.match(css, /\.mosa-v2 \.topbar \{[^}]*height: var\(--topbar-height\);/);
  // 类型筛选：纯文字分段，高 28、10.5px、圆角 8、内边距 0 12；图标 CSS 隐藏。
  assert.match(css, /\.mosa-v2 \.type-filter \{ height: 28px; gap: 6px; padding: 0 12px; border-radius: 8px; font-size: 10\.5px; \}/);
  assert.match(css, /\.mosa-v2 \.type-filter svg \{ display: none; \}/);
  assert.match(css, /\.mosa-v2 \.type-filter\.active \{ background: var\(--app-chip-active\); font-weight: 580; \}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.type-filter\.active \{ background: #f0f0f2; color: #303034; \}/);
  // 排序框：约 96 宽、高 32（既有规则）、左内边距 12、浅色底 #f4f4f5。
  assert.match(css, /\.mosa-v2 \.sort-control select \{ min-width: 96px; padding: 0 26px 0 12px; \}/);
  assert.match(css, /\.mosa-v2 \.toolbar-filter, \.mosa-v2 \.toolbar-icon, \.mosa-v2 \.sort-control select \{ height: 32px;/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.sort-control select \{ background: #f4f4f5; \}/);
  // 搜索框：宽 152、高 32（--control-sm）、浅色底 #f4f4f5。
  assert.match(css, /\.mosa-v2 \.topbar-search \{ flex: 0 1 152px; width: 152px; \}/);
  assert.match(css, /\.topbar-search \{ display: flex; box-sizing: border-box; min-width: 0; flex: 0 1 256px; align-items: center; gap: 8px; width: 256px; height: var\(--control-sm\);/);
  assert.match(css, /--control-sm: 32px;/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.topbar-search \{ background: #f4f4f5; \}/);
});
