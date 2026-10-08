// GravityPort A2 侧栏契约：品牌行（GravityPort 靠右）、固定入口顺序、
// 导航项 36/8/4 排版与 20px 左右内边距、中文字距只在 zh 生效、分组色点 12px、
// 底部用户中心按钮（保留 settingsToggle 语义）与新 i18n 键、头像字母规则。
// 只读 web/app/ 源码；字母规则通过源码切片 + new Function 直接求值。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const readIndexHtml = () => readFile(resolve(root, "web/app/index.html"), "utf8");
const readCss = () => readFile(resolve(root, "web/app/styles.css"), "utf8");
const readApp = () => readFile(resolve(root, "web/app/app.mjs"), "utf8");

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

test("brand row: GravityPort in h1, sidebar aria-label and <title>; subtitle kept but hidden", async () => {
  const [html, css] = await Promise.all([readIndexHtml(), readCss()]);
  assert.match(html, /<h1>GravityPort<\/h1>/, "the brand h1 must read GravityPort");
  assert.match(html, /<aside class="sidebar" id="appSidebar" aria-label="GravityPort">/, "the sidebar aria-label must read GravityPort");
  assert.match(html, /<title>GravityPort<\/title>/, "the page title must read GravityPort");
  // 副标题元素与 i18n 键保留，但界面上不再展示。
  assert.match(html, /class="sidebar-library-title"/, "the subtitle element stays in the DOM");
  assert.match(css, /\.mosa-v2 \.brand \.sidebar-library-title \{ display: none; \}/, "the subtitle must be hidden in the brand row");
  // 品牌行与顶栏同高、靠右、右内边距 20px；文字 18px / 500 / 字距 0。
  const brand = blockAfter(css, ".mosa-v2 .brand {");
  assert.match(brand, /justify-content: flex-end;/, "brand content must right-align");
  assert.match(brand, /padding: 0 20px;/, "brand right padding must be 20px");
  assert.match(brand, /height: var\(--topbar-height\);/, "brand row height must stay the topbar token");
  assert.match(css, /\.mosa-v2 \.brand-info h1 \{ color: var\(--color-text-primary\); font-size: 18px; font-weight: 500; line-height: 20px; letter-spacing: 0; \}/);
  // 靠右之后不再需要为三色按钮让位：margin-left 补偿规则必须删干净。
  assert.doesNotMatch(css, /electron-shell[^{]*brand-info h1[^{]*\{[^}]*margin-left/, "the traffic-light offset rule must be gone");
});

test("primary navigation order: all → unorganized → favorite → trash", async () => {
  const html = await readIndexHtml();
  const nav = html.slice(html.indexOf('id="quickFilters"'), html.indexOf("</ul>", html.indexOf('id="quickFilters"')));
  const order = [...nav.matchAll(/data-filter="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(order, ["all", "unorganized", "favorite", "trash"], "quick filters must follow the GravityPort A2 order");
});

test("nav items: 36px height, 8px radius, 4px gap, 20px nav side padding, 12px item padding", async () => {
  const css = await readCss();
  assert.match(css, /\.mosa-v2 \.nav-item, \.mosa-v2 \.add-group-button, \.mosa-v2 \.settings-trigger \{ min-height: 36px; border-radius: 8px;/);
  assert.match(css, /\.mosa-v2 \.primary-nav \{ padding: 16px 20px 10px; \}/, "nav side padding must be 20px (item width 280 − 40 = 240)");
  assert.match(css, /\.mosa-v2 \.nav-list \{ gap: var\(--r21-s1\); \}/, "fixed-entry gap must stay the 4px step");
  assert.match(css, /\.mosa-v2 \.sidebar-group-list \{ gap: var\(--r21-s1\);/, "group item gap must be the 4px step too");
  assert.match(css, /\.mosa-v2 \.nav-item \{ padding: 0 12px; font-size: 13px; \}/, "nav items keep 12px inner padding; group items read 13px");
  assert.match(css, /\.mosa-v2 \.nav-list \.nav-item \{ font-size: 14px; \}/, "fixed entries read 14px");
  assert.match(css, /\.mosa-v2 \.nav-count \{ color: var\(--color-text-tertiary\); font-size: 12px; font-weight: 300;/, "counts read 12px / weight 300");
  // 选中态底色与左侧 2px 指示条规则保留（v2 中维持现状隐藏）。
  assert.match(css, /\.nav-item\.active::before \{ content: ""; position: absolute; top: 6px; left: 0; width: 2px;/, "the 2px active indicator rule must survive");
  // 底部不再有分隔线。
  assert.doesNotMatch(css, /^\.sidebar-footer \{[^}]*border-top/m, "the base sidebar footer must not draw a top border");
  assert.match(css, /\.mosa-v2 \.sidebar-footer \{ padding: 12px 20px; border-top: 0; \}/, "the footer must keep the 20px side padding and no border");
});

test("group headings: 12px/600 labels and 24px space above heading rows", async () => {
  const css = await readCss();
  assert.match(css, /\.mosa-v2 \.nav-label \{ margin: 18px 0 6px; padding: 0 12px; color: var\(--color-text-tertiary\); font-size: 12px; font-weight: 600;/);
  assert.match(css, /\.mosa-v2 \.sidebar-group-heading \{ display: flex; align-items: center; justify-content: space-between; min-height: 28px; margin: var\(--r21-s6\) 10px 2px; \}/, "heading rows sit 24px (--r21-s6) below the previous block");
  assert.match(css, /\.mosa-v2 \.sidebar-manual-group-heading \{ margin-top: var\(--r21-s6\); \}/);
});

test("Chinese letter-spacing applies only under html[lang^=zh]; English stays 0", async () => {
  const css = await readCss();
  // 基础字距一律 0（英文界面不加字距）。
  assert.match(css, /\.mosa-v2 \.nav-item, \.mosa-v2 \.add-group-button, \.mosa-v2 \.settings-trigger \{[^}]*letter-spacing: 0;/);
  // 中文 0.2em 必须挂在 lang 选择器上，且只作用于固定入口/用户中心的文字。
  assert.match(css, /html\[lang\^="zh"\] \.mosa-v2 \.nav-list \.nav-item \.nav-item-text \{ letter-spacing: \.2em; \}/);
  assert.match(css, /html\[lang\^="zh"\] \.mosa-v2 \.settings-trigger \.settings-trigger-label \{ letter-spacing: \.2em; \}/);
  // 不允许无 lang 限定的 0.2em 字距规则漏进英文界面。
  assert.doesNotMatch(css, /(?:^|\n)\.mosa-v2 \.[^{]*letter-spacing: \.2em/);
});

test("group color dot is a 12px circle", async () => {
  const css = await readCss();
  assert.match(css, /\.mosa-v2 \.nav-group-dot \{ width: 12px; height: 12px; flex: 0 0 12px; border-radius: 50%; background: var\(--group-color\); \}/);
});

test("user center button keeps #settingsToggle semantics and adds the avatar", async () => {
  const html = await readIndexHtml();
  const app = await readApp();
  const button = html.slice(html.indexOf('<button class="settings-trigger"'), html.indexOf("</button>", html.indexOf('<button class="settings-trigger"')));
  assert.match(button, /id="settingsToggle"/, "the bottom button must keep #settingsToggle");
  assert.match(button, /aria-haspopup="dialog"/);
  assert.match(button, /aria-controls="settingsMenu"/, "the bottom button must keep aria-controls");
  assert.match(button, /data-i18n-aria-label="userCenterOpenSettings"/, "the accessible name must say it opens settings");
  assert.match(button, /class="user-center-avatar" id="userCenterAvatar" aria-hidden="true">G</, "the avatar starts as G");
  assert.match(button, /class="settings-trigger-label" data-i18n="userCenter"/, "the visible label uses the userCenter key");
  // 打开设置弹窗的行为不变（settingsToggle 仍绑定 toggleSettingsModal）。
  assert.match(app, /els\.settingsToggle\?\.addEventListener\("click", toggleSettingsModal\)/);
});

test("userCenter / userCenterOpenSettings / userId / userIdCopied exist in both locales", async () => {
  const { default: translations } = await import(pathToFileURL(resolve(root, "web/app/i18n.mjs")).href);
  assert.equal(translations.zh.userCenter, "用户中心");
  assert.equal(translations.en.userCenter, "Account");
  assert.equal(translations.zh.userCenterOpenSettings, "用户中心，打开设置");
  assert.equal(translations.en.userCenterOpenSettings, "Account, open settings");
  assert.equal(translations.zh.userId, "用户 ID");
  assert.equal(translations.en.userId, "User ID");
  assert.equal(translations.zh.userIdCopied, "用户 ID 已复制");
  assert.equal(translations.en.userIdCopied, "User ID copied");
  // 页面 <title> 由 appTitle 驱动，两个语言都是 GravityPort。
  assert.equal(translations.zh.appTitle, "GravityPort");
  assert.equal(translations.en.appTitle, "GravityPort");
});

test("userCenterInitial: first letter upper-cased, G fallback without a usable ID", async () => {
  const app = await readApp();
  const marker = "export function userCenterInitial(userId)";
  const start = app.indexOf(marker);
  assert.ok(start > -1, "userCenterInitial must be exported for this contract");
  const open = app.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < app.length; i += 1) {
    if (app[i] === "{") depth += 1;
    if (app[i] === "}") {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  // 与 theme-init 同款手法：切片 + new Function 在无 DOM 的 Node 里求值。
  const fn = new Function(`${marker.replace("export ", "")} ${app.slice(open, end)}; return userCenterInitial;`)();
  assert.equal(typeof fn, "function");
  assert.equal(fn("fb12a174-1d05-4c92-9f3e-6a2f0b7c1234"), "F");
  assert.equal(fn("0123-4567"), "G", "a digit-only id falls back to G");
  assert.equal(fn(""), "G");
  assert.equal(fn(undefined), "G");
  assert.equal(fn("7ac2-…"), "A");
});

test("settings About page renders the user ID row with a copy action only when an id exists", async () => {
  const app = await readApp();
  const slice = app.slice(app.indexOf("const userIdRow"), app.indexOf("const settingsPages"));
  assert.match(slice, /state\.userProfileId\s*\n\s*\? row\(/, "the row is conditional on the profile id");
  assert.match(slice, /class="settings-path" data-settings-user-id title="/, "the value reuses the mono/ellipsis path style with a hover title");
  assert.match(slice, /data-copy-user-id>\$\{escapeHtml\(t\("copyAction"\)\)\}/, "the copy button reuses copyAction and the settings text action style");
  const wiring = app.slice(app.indexOf('const copyUserIdButton = event.target.closest("[data-copy-user-id]")'), app.indexOf("const visualToggleButton = event.target.closest"));
  assert.match(wiring, /writeClipboardText\(state\.userProfileId\)/, "copy goes through the shared clipboard helper");
  assert.match(wiring, /showToast\(t\("userIdCopied"\), "success"\)/, "success uses the existing toast path");
  // 头像字母异步水合：不阻塞启动，拿到后写头像与 state。
  const hydrate = app.slice(app.indexOf("async function hydrateUserCenter()"), app.indexOf("async function hydrateUserCenter()") + 900);
  assert.match(hydrate, /window\.electronAPI\?\.getUserProfile/);
  assert.match(app, /void hydrateUserCenter\(\);/, "hydration must be fired without blocking init");
});
