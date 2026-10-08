// 任务 96（A6）：大图页「全屏」与窗口系统全屏双向同步。
// 行为面：assetViewFullscreenTransition 纯状态机（toggle 双向带窗口写入、窗口事件
// 一律不回写防互触成环、不在大图页时与查看器无关）；接线面：app.mjs 只在桌面
// electronAPI 存在时注入桥并订阅 window-full-screen-change；样式面：舞台左右各让
// 出 52px 箭头栏、全屏（箭头隐藏）收回。Node 标准库，无网络访问。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { assetViewFullscreenTransition } from "../web/app/asset-view.mjs";

const root = resolve(import.meta.dirname, "..");
const readApp = () => readFile(resolve(root, "web/app/app.mjs"), "utf8");
const readAssetView = () => readFile(resolve(root, "web/app/asset-view.mjs"), "utf8");
const readCss = () => readFile(resolve(root, "web/app/styles.css"), "utf8");

const viewer = (fullscreen) => ({ fullscreen, inAssetView: true });

test("toggle：大图页点「全屏」进入并写窗口系统全屏", () => {
  assert.deepEqual(assetViewFullscreenTransition(viewer(false), { type: "toggle" }), { fullscreen: true, notifyWindow: true });
});

test("toggle：Esc/按钮退出「只剩图片」时窗口一并退出系统全屏", () => {
  assert.deepEqual(assetViewFullscreenTransition(viewer(true), { type: "toggle" }), { fullscreen: false, notifyWindow: true });
});

test("window-change：自己动作的回声（进入后收到 enter）不回写", () => {
  assert.equal(assetViewFullscreenTransition(viewer(true), { type: "window-change", active: true }), null);
});

test("window-change：自己动作的回声（退出后收到 leave）不回写", () => {
  assert.equal(assetViewFullscreenTransition(viewer(false), { type: "window-change", active: false }), null);
});

test("window-change：外部退出（菜单/绿按钮/⌃⌘F/系统 Esc）查看器跟随但不回写窗口", () => {
  assert.deepEqual(assetViewFullscreenTransition(viewer(true), { type: "window-change", active: false }), { fullscreen: false, notifyWindow: false });
});

test("window-change：在大图页内经菜单进入窗口全屏，查看器跟随进入且不回写", () => {
  assert.deepEqual(assetViewFullscreenTransition(viewer(false), { type: "window-change", active: true }), { fullscreen: true, notifyWindow: false });
});

test("不在大图页时窗口全屏与查看器无关", () => {
  const state = { fullscreen: false, inAssetView: false };
  assert.equal(assetViewFullscreenTransition(state, { type: "window-change", active: true }), null);
  assert.equal(assetViewFullscreenTransition(state, { type: "toggle" }), null);
});

test("无法识别的事件返回 null", () => {
  assert.equal(assetViewFullscreenTransition(viewer(false), { type: "mystery" }), null);
  assert.equal(assetViewFullscreenTransition(viewer(false), null), null);
});

test("接线面：桥仅在桌面 electronAPI 存在时注入，窗口事件订阅到状态机入口", async () => {
  const app = await readApp();
  const assetView = await readAssetView();
  assert.match(app, /const desktopFullscreenBridge = typeof window\.electronAPI\?\.setWindowFullScreen === "function"\n  \? \{ setWindowFullScreen: \(flag\) => window\.electronAPI\.setWindowFullScreen\(flag === true\) \}\n  : null;/, "bridge is feature-detected from the preload API");
  assert.match(app, /desktopFullscreen: desktopFullscreenBridge/, "bridge is the only new dependency of the viewer factory");
  assert.match(app, /window\.electronAPI\?\.onWindowFullScreenChange\?\.\(\(active\) => assetViewer\.handleWindowFullScreenChange\(active\)\);/, "window full-screen broadcasts feed the viewer state machine");
  assert.match(assetView, /toggleAssetViewFullscreen\(\) \{[\s\S]*?typeof desktopFullscreen\?\.setWindowFullScreen === "function"[\s\S]*?applyAssetViewFullscreenState\(\{ fullscreen: true, notifyWindow: true \}\);/, "desktop toggle enters via the window bridge, not the element Fullscreen API");
  assert.match(assetView, /exitAssetViewFullscreen\(\) \{[\s\S]*?notifyAssetViewWindowFullScreen\(false\);/, "viewer exit also leaves window fullscreen on desktop");
});

test("样式面：舞台左右各让出 52px 箭头栏（44 按钮 + 8 距缘），全屏收回", async () => {
  const css = await readCss();
  assert.match(css, /\.asset-view-stage \{[^}]*padding: var\(--space-3\) 52px;/, "stage reserves one arrow column on each side");
  assert.match(css, /\.asset-view\.is-fullscreen \.asset-view-stage \{ background: transparent; padding: var\(--space-3\); \}/, "fullscreen hides the arrows and reclaims the reserved columns");
  assert.match(css, /\.asset-view-arrow-prev \{ left: 8px; \}/, "arrow inset stays 8px so the reserved column is 44+8");
});
