// Phase 6A / F-10 / F-20（960×640 部分）：桌面最小窗口与 960×640 响应式守护契约。
// 任务书 42 项契约点映射见 docs/ui-audit/33-phase-6a-minimum-window-results.md §25。
// 原则：Node 标准库、无网络、行为契约优先；不以整文件 SHA 代替产品行为契约
// （SHA 仅用于锁定 package.json / package-lock.json 不新增依赖这一卫生项）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const read = (relativePath) => readFile(resolve(root, relativePath), "utf8");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const sources = {};
async function source(relativePath) {
  if (!sources[relativePath]) sources[relativePath] = await read(relativePath);
  return sources[relativePath];
}

test("1-2. BrowserWindow minWidth=960 且 minHeight=640（F-10 单次授权范围）", async () => {
  const main = await source("desktop/main.mjs");
  assert.match(main, /minWidth: 960,/);
  assert.match(main, /minHeight: 640,/);
  // 旧批准值以下的最小尺寸不得残留。
  assert.doesNotMatch(main, /minWidth: 900,/);
  assert.doesNotMatch(main, /minHeight: 600,/);
});

test("3. 不在 renderer 中模拟窗口最小值", async () => {
  const appJs = await source("app/app.mjs");
  const index = await source("app/index.html");
  const styles = await source("app/styles.css");
  // renderer 不得用 resizeTo/resizeBy 或任何内视口钳制模拟桌面窗口最小尺寸。
  assert.doesNotMatch(appJs, /window\.resizeTo\(|window\.resizeBy\(/);
  assert.doesNotMatch(appJs, /Math\.max\(\s*960/);
  assert.doesNotMatch(appJs, /simulateMinWindow|min-window-sim/);
  // 不用 CSS min-width 代替桌面窗口约束（html/body 不设 960px 最小宽度）。
  assert.doesNotMatch(styles, /(html|body)[^{]*\{[^}]*min-width:\s*9[0-9][0-9]px/s);
  assert.doesNotMatch(index, /min-width:\s*960/);
});

test("4. 不增加 resize watchdog / setBounds 强制", async () => {
  const main = await source("desktop/main.mjs");
  assert.doesNotMatch(main, /on\("resize"/);
  assert.doesNotMatch(main, /setBounds\(/);
  assert.doesNotMatch(main, /watchdog/i);
});

test("5-6. 初始窗口尺寸不低于批准的最小值", async () => {
  const main = await source("desktop/main.mjs");
  const match = main.match(/DEFAULT_BOUNDS = \{ width: (\d+), height: (\d+) \}/);
  assert.ok(match, "DEFAULT_BOUNDS literal must remain declarative");
  assert.ok(Number(match[1]) >= 960, `initial width ${match[1]} >= minWidth 960`);
  assert.ok(Number(match[2]) >= 640, `initial height ${match[2]} >= minHeight 640`);
});

test("7-9. preload 路径与安全 WebPreferences 不变", async () => {
  const main = await source("desktop/main.mjs");
  assert.match(main, /const preloadPath = fileURLToPath\(new URL\("\.\/preload\.cjs", import\.meta\.url\)\);/);
  assert.match(main, /preload: preloadPath/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
});

test("10-11. Finder IPC 收紧边界且其余 Desktop IPC 不变", async () => {
  const main = await source("desktop/main.mjs");
  const preload = await source("desktop/preload.cjs");
  // Finder 能力契约（与 desktop-packaging 契约一致，不放宽）。
  assert.match(main, /ipcMain\.handle\("show-item-in-folder",/);
  const handlerStart = main.indexOf('ipcMain.handle("show-item-in-folder"');
  const handler = main.slice(handlerStart, main.indexOf("\n}", handlerStart));
  assert.match(handler, /event\.sender !== mainWindow\.webContents/);
  assert.match(handler, /!isAbsolute\(target\)/);
  assert.match(handler, /!existsSync\(target\)/);
  assert.match(handler, /resolveAllowedFolderPath\(target, \[libraryDir\]\)/);
  assert.match(handler, /shell\.showItemInFolder\(allowedTarget\)/);
  assert.doesNotMatch(handler, /openExternal/);
  // 其余既有 IPC 通道与 preload 暴露面不变。
  for (const channel of ["open-file-dialog", "paste-image", "set-locale"]) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\("${channel}"`));
  }
  // P3-1 移除死通道 stage-dropped-file 后,preload 仅保留四个受控 invoke 通道。
  assert.equal(preload.split("ipcRenderer.invoke").length - 1, 4, "no invoke channel beyond the four currently approved narrow requests");
});

test("12-14. 960 下 Sidebar 批准收敛规则与搜索可达", async () => {
  const styles = await source("app/styles.css");
  const index = await source("app/index.html");
  // 701–1120 图标栏收敛（960×640 落在该区间）仍是批准的唯一紧凑档。
  assert.match(styles, /@media \(min-width: 701px\) and \(max-width: 1120px\)/);
  assert.match(styles, /\.shell\.details-open \.nav-item-text,/);
  // V2 FilterBar：唯一搜索框位于顶栏右侧，仍是同一个 #searchInput。
  assert.match(index, /<div class="topbar-search">/);
  assert.match(index, /id="searchInput"/);
  // 顶栏搜索的焦点态规则保留。
  assert.match(styles, /\.topbar-search:focus-within \{/);
});

test("15-16. 960 下 Viewer shell 与舞台契约", async () => {
  const styles = await source("app/styles.css");
  // .asset-view 保持 flex 互斥布局（hidden 才退出），不在紧凑档新增隐藏规则。
  assert.match(styles, /\.asset-view\[hidden\] \{ display: none; \}/);
  assert.match(styles, /\.asset-view \{ display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column; overflow: hidden;/);
  // 舞台收缩链：min-width:0 + overflow:hidden，不被 Inspector 挤死也不外溢。
  assert.match(styles, /\.asset-view-stage \{ position: relative; display: flex; min-width: 0; min-height: 0; flex: 1;/);
});

test("17-18. Inspector 独立滚动且宽度不超批准范围", async () => {
  const styles = await source("app/styles.css");
  assert.match(styles, /\.detail-inspector-scroll \{ position: relative; flex: 1 1 auto; min-height: 0; overflow-x: hidden; overflow-y: auto; \}/);
  // 批准宽度：宽屏 360px / 紧凑 340px，均来自 Token 且未出现更大值。
  assert.match(styles, /--inspector-width: 360px;/);
  assert.match(styles, /--inspector-width-compact: 340px;/);
  assert.match(styles, /\.shell\.details-open \{[^}]*var\(--inspector-width\)/s);
  assert.doesNotMatch(styles, /--inspector-width[^:]*:\s*3[7-9]\dpx|--inspector-width[^:]*:\s*[4-9]\d\dpx/);
});

test("19-21. Return / Prev / Next / Zoom 控件可见契约", async () => {
  const index = await source("app/index.html");
  const styles = await source("app/styles.css");
  assert.match(index, /id="assetViewBack"/);
  assert.match(index, /id="assetViewPrev"/);
  assert.match(index, /id="assetViewNext"/);
  assert.match(index, /id="assetZoomOut"/);
  assert.match(index, /id="assetZoomIn"/);
  assert.match(index, /id="assetZoomFit"/);
  assert.match(styles, /\.asset-view-back \{ min-width: 0;/);
  assert.match(styles, /\.asset-view-nav-btn \{ display: inline-flex; width: 40px; height: 40px;/);
  assert.match(styles, /\.asset-view-controls \{ position: absolute;/);
});

test("22-24. Inspector V2 八项顺序：File/Tags 直接进入滚动列，More 收尾", async () => {
  const appJs = await source("app/app.mjs");
  const inspector = await source("app/inspector-markup.mjs");
  const scrollStart = appJs.indexOf('detail-inspector-scroll">');
  const template = appJs.slice(
    scrollStart,
    appJs.indexOf("</div></div>`", scrollStart),
  );
  assert.notEqual(scrollStart, -1, "inspector scroll template exists");
  assert.match(template, /\$\{detailFileSectionMarkup\(asset\)\}\$\{detailTagsSectionMarkup\(asset\)\}/, "File and Tags enter the scroll column directly");
  const order = [
    "detailFileSectionMarkup",
    "detailTagsSectionMarkup",
    "detailPromptSectionMarkup",
    "detailSourceSectionMarkup",
    "detailVersionSectionMarkup",
    "detailGroupSectionMarkup",
    "detailNewVersionSectionMarkup",
    "detailMoreSectionMarkup",
  ];
  let cursor = 0;
  for (const markup of order) {
    const position = template.indexOf(markup, cursor);
    assert.notEqual(position, -1, `${markup} present in inspector template`);
    cursor = position;
  }
  assert.equal(order.indexOf("detailMoreSectionMarkup"), 7, "More stays the 8th section");
  // data-inspector-section 标记与顺序一致。
  assert.match(inspector, /data-inspector-section="more"/);
});

test("25. body/document 不设置造成水平滚动的固定宽度", async () => {
  const styles = await source("app/styles.css");
  assert.doesNotMatch(styles, /body\s*\{[^}]*width:\s*\d+px/s);
  assert.doesNotMatch(styles, /html\s*\{[^}]*width:\s*\d+px/s);
  // 不以 body overflow-x:hidden 掩盖横向溢出（Phase 2C 守护 #14 延续）。
  assert.doesNotMatch(styles, /body\s*\{[^}]*overflow-x:\s*hidden/s);
});

test("26. 断点必须属于已登记的桌面或 V2 响应式设计区间", async () => {
  const styles = await source("app/styles.css");
  // 只审计 @media 媒体查询中的宽度边界，不扫组件级 width/max-width 声明。
  const mediaQueries = [...styles.matchAll(/@media[^{]+\{/g)].map((match) => match[0]);
  const boundaryValues = [];
  for (const query of mediaQueries) {
    boundaryValues.push(...[...query.matchAll(/(?:min|max)-width:\s*(\d+)px/g)].map((match) => Number(match[1])));
  }
  // 1279/767 come from the supplied Library v2 reference: five columns at
  // 1280+, three columns at 768–1279, and a two-column drawer layout below.
  const allowed = new Set([1400, 1399, 1280, 1279, 1120, 900, 767, 701, 700, 480]);
  for (const width of boundaryValues) {
    assert.ok(allowed.has(width), `media query boundary ${width}px must belong to the registered breakpoint set`);
  }
  for (const magic of [959, 961, 1119, 1121]) {
    assert.equal(boundaryValues.includes(magic), false, `no magic ${magic}px breakpoint`);
  }
});

test("27. 959 Web fallback 保持（Electron 钳制 960 之外 Web 仍回退）", async () => {
  const styles = await source("app/styles.css");
  const assetView = await source("app/asset-view.mjs");
  // 959 落在 701–1120 图标栏区间：收敛规则在 959 继续生效，无独立 959 断点。
  assert.match(styles, /@media \(min-width: 701px\) and \(max-width: 1120px\)/);
  assert.match(styles, /@media \(max-width: 700px\) \{[\s\S]*body \{ overflow: auto; \}/);
  // 滚动容器 helper 继续处理 ≤959 文档级滚动回退（Return Snapshot 正确性的前提）。
  assert.match(assetView, /getLibraryScrollContainer/);
  assert.match(assetView, /≤959px/);
});

test("28-30. Surface max-height / ConfirmDialog viewport-safe / Toast fixed 栈保持", async () => {
  const styles = await source("app/styles.css");
  // Legacy filter/settings fallback geometry remains viewport-safe even though
  // the old anchored-overlay runtime has been retired from V2.
  assert.match(styles, /\.filter-panel \{[^}]*max-height: min\(580px, calc\(100vh - 76px\)\)/);
  assert.match(styles, /\.settings-menu \{[^}]*max-height: calc\(100vh - 56px\)/);
  assert.doesNotMatch(styles, /\.anchored-overlay/);
  // ConfirmDialog：modal-overlay padding 20px + modal-card max-width/max-height 保证视口安全。
  assert.match(styles, /\.modal-overlay \{ position: fixed;[^}]*padding: 20px;/);
  assert.match(styles, /\.modal-card \{[^}]*max-width: 100%; max-height: min\(760px, 88vh\)/);
  assert.match(styles, /\.confirm-dialog-card \{ width: 400px; \}/);
  // Toast：fixed 栈不扩展文档布局。
  assert.match(styles, /\.toast-stack \{ position: fixed; z-index: var\(--z-toast\);/);
  assert.match(styles, /\.toast-stack-polite \{ bottom: calc\(20px \+ var\(--toast-error-stack-height, 0px\)\); \}/);
});

test("31. F-08 空状态不退化", async () => {
  const appJs = await source("app/app.mjs");
  assert.match(appJs, /gallery-empty-state/);
  assert.match(appJs, /data-empty-kind=/);
  assert.match(appJs, /empty-state-actions/);
});

test("32-34. Phase 5 Confirm / Toast 契约测试文件不退化", async () => {
  const confirm = await source("test/confirm-dialog-contract.test.mjs");
  const toast = await source("test/toast-manager-contract.test.mjs");
  assert.match(confirm, /confirmDialog/);
  assert.match(toast, /createToastManager/);
  // Phase 5C 校正登记：18 个 test block 覆盖 60/60 契约点，不是 18 项契约。
  const toastBlocks = toast.split(/test\(/).length - 1;
  assert.equal(toastBlocks, 18, "toast contract keeps its 18 test blocks (covering 60 contract points)");
});

test("35-37. Viewer Navigation / Transform / Return Snapshot 不退化", async () => {
  const appJs = await source("app/app.mjs");
  const assetView = await source("app/asset-view.mjs");
  // 35 Navigation：稳定序列 + 边界禁用（BUG-10 扩展 session 持有总数/游标/快照）。
  assert.match(assetView, /const assetViewSequence = \{\n\s+ids: \[\], index: -1, requestKey: "",\n\s+total: 0, nextCursor: null, loading: false, generation: 0,\n\s+snapshot: null,\n\s*\};/);
  assert.match(assetView, /setAssetViewControlDisabled\(els\.assetViewPrev, !canNavigateAssetView\(-1\)\)/);
  assert.match(appJs, /els\.assetViewPrev\?\.addEventListener\("click", \(\) => navigateAssetView\(-1\)\)/);
  // 36 Transform：统一 transform 应用点与拖拽禁用契约保持。
  assert.match(assetView, /function applyAssetViewTransform\(\)/);
  const index = await source("app/index.html");
  assert.match(index, /id="assetViewImage"[^>]*draggable="false"/);
  // 37 Return Snapshot：四字段最小集合保持。
  assert.match(assetView, /state\.libraryReturnSnapshot = \{\n\s+scrollTop: getLibraryScrollContainer\(\)\.scrollTop,\n\s+focusedAssetId:/);
  assert.match(assetView, /selectedAssetId: state\.selectedId,\n\s+requestKey: assetRequestKey\(currentAssetRequest\(\)\)/);
});

test("38. Inspector IA V2 八项 section 标记全在且唯一", async () => {
  const inspector = await source("app/inspector-markup.mjs");
  const sections = ["file", "prompt", "source", "version", "group", "tags", "new-version", "more"];
  for (const section of sections) {
    assert.equal(
      inspector.split(`data-inspector-section="${section}"`).length - 1,
      1,
      `inspector section "${section}" rendered exactly once`,
    );
  }
});

test("39. App/Web 原图能力差异保持（Finder vs 打开原图）", async () => {
  const inspector = await source("app/inspector-markup.mjs");
  assert.match(inspector, /typeof window\.electronAPI\?\.showItemInFolder === "function" && imagePath\) return "desktop-finder"/);
  assert.match(inspector, /return "web-open"|capability === "web-open"/);
  assert.match(inspector, /original-media-link/);
  assert.match(inspector, /rel="noopener noreferrer"/);
});

test("40-41. package 与 lockfile 不变、无新依赖", async () => {
  const pkg = await source("package.json");
  const lock = await source("package-lock.json");
  // R1 isolation fix (2026-08-09, approved scope) added qa:web/qa:electron/
  // qa:packaged launcher scripts, so the whole-manifest hash no longer holds;
  // the dependency sections the freeze really guards stay byte-identical.
  const manifest = JSON.parse(pkg);
  assert.equal(sha256(JSON.stringify(manifest.dependencies)), "73c83773a57e21a20917d81b24288bdfddd9bb7ddd644fdaedd6e6cfba13c405");
  assert.equal(sha256(JSON.stringify(manifest.devDependencies)), "11f67ce00f34b4d3dfb9b9ed0dfb428b0368ad5e0a17bd3bafaa40e3c2124fac");
  assert.equal(sha256(lock), "ecf0fdc199de87ccd30ffe6a7da4624c2f632700cd8348194a30b79dd2e2a69f");
});

test("42. styles.css 不使用 !important", async () => {
  const styles = await source("app/styles.css");
  // 去掉 CSS 注释后再判：注释中的说明性文字（如“不使用 !important”）不算违规。
  const declarations = styles.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(declarations, /!important/);
});
