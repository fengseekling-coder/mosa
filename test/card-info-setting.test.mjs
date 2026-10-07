// 任务 20 契约：设置里的「素材卡片信息」开关（界面合一后只读 web/app 这一份）。
// 密度设置已在 9c7457e 删除且不得回归（名字与 density 无关）；新的开关：
// state.showCardInfo 只在本地存储 mosa.card-info === "show" 时为真（默认隐藏），
// 设置行用现有 segmented 控件（data-card-info-opt），renderGrid 把开关状态写到
// #assetGrid[data-card-info] 并按 renderedCardInfo 触发整体重排，虚拟列表高度
// 估算与缓存键都带上开关状态。零网络、源码切片断言。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");
const TREES = ["web/app"];

/** Slices a top-level module function up to the next top-level function. */
function functionSlice(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function not found: ${name}`);
  const candidates = ["\nfunction ", "\nasync function ", "\n  function ", "\n  async function "]
    .map((marker) => source.indexOf(marker, start + 1))
    .filter((index) => index !== -1);
  const next = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, next === -1 ? source.length : next);
}

test("state reads mosa.card-info and defaults to hidden (only \"show\" is true)", async () => {
  for (const tree of TREES) {
    const app = await read(`${tree}/app.mjs`);
    // 布尔状态：只有 "show" 才为真，没存过/存了其他值都是隐藏。
    assert.match(app, /showCardInfo: safeStorageGet\("mosa\.card-info"\) === "show"/,
      `${tree}: showCardInfo must default to hidden and only honor "show"`);
    // 旧的密度键保持忽略：不读 mosa.gallery-density，也不引入 density 命名。
    assert.doesNotMatch(app, /mosa\.gallery-density|galleryDensity|normalizeDensity|data-density-opt|densityOpt/,
      `${tree}: the retired density naming must stay gone`);
  }
});

test("settings menu renders the card-info segmented control between theme and language", async () => {
  for (const tree of TREES) {
    const app = await read(`${tree}/app.mjs`);
    // 外观段：主题行（任务 81 起整行预览卡，单独的 themeRow 常量）下面、语言行上面。
    const themeStart = app.indexOf("const themeRow = `");
    assert.notEqual(themeStart, -1, `${tree}: themeRow must exist`);
    const themeRow = app.slice(themeStart, app.indexOf("`;", themeStart));
    const appearanceStart = app.indexOf("const appearanceRows = [");
    assert.notEqual(appearanceStart, -1, `${tree}: appearanceRows must exist`);
    const appearanceEnd = app.indexOf('].join("")', appearanceStart);
    const appearanceRows = app.slice(appearanceStart, appearanceEnd);
    const themeAt = themeRow.indexOf('"data-appearance-opt"');
    const cardInfoAt = appearanceRows.indexOf('"data-card-info-opt"');
    const localeAt = appearanceRows.indexOf('"data-locale"');
    assert.ok(themeAt > -1 && cardInfoAt > -1 && localeAt > cardInfoAt,
      `${tree}: the card-info row must sit between the theme and language rows`);
    // 任务 81：选项顺序照稿子（隐藏｜显示）。
    assert.match(appearanceRows, /segmented\(t\("cardInfo"\), "data-card-info-opt", state\.showCardInfo \? "show" : "hide", \[\{ value: "hide", label: t\("cardInfoHide"\) \}, \{ value: "show", label: t\("cardInfoShow"\) \}\]\)/,
      `${tree}: the card-info row must use the shared segmented control with hide/show options`);
    // 高亮同步：syncSettingsMenuView 覆盖 data-card-info-opt。
    assert.match(app, /setRadioState\("\[data-card-info-opt\]", state\.showCardInfo \? "show" : "hide"\)/,
      `${tree}: syncSettingsMenuView must sync the card-info highlight`);
    assert.match(app, /button\.dataset\.cardInfoOpt === selectedValue/,
      `${tree}: setRadioState must match data-card-info-opt values`);
  }
});

test("the settings click handler updates state, persists the choice, and re-renders the gallery", async () => {
  for (const tree of TREES) {
    const app = await read(`${tree}/app.mjs`);
    const branchStart = app.indexOf("if (button?.dataset.cardInfoOpt) {");
    assert.notEqual(branchStart, -1, `${tree}: the settings click handler must own a data-card-info-opt branch`);
    const branch = app.slice(branchStart, app.indexOf("return;", branchStart));
    assert.match(branch, /state\.showCardInfo = newCardInfo === "show";/, `${tree}: the click must update showCardInfo`);
    assert.match(branch, /safeStorageSet\("mosa\.card-info", state\.showCardInfo \? "show" : "hide"\);/,
      `${tree}: the click must persist "show"/"hide" to mosa.card-info`);
    assert.match(branch, /renderGrid\(\);/, `${tree}: the click must re-render the gallery`);
  }
});

test("renderGrid exposes the switch on #assetGrid and full-relayouts when it changes", async () => {
  for (const tree of TREES) {
    const app = await read(`${tree}/app.mjs`);
    // dataset.cardInfo 写在渲染早期，加载/错误/空状态分支也能看到。
    assert.match(app, /const cardInfo = state\.showCardInfo \? "show" : "hide";\s*\n\s*els\.assetGrid\.dataset\.cardInfo = cardInfo;/,
      `${tree}: #assetGrid must carry dataset.cardInfo`);
    // 切换后不允许走快速追加路径：renderedCardInfo 必须参与 canAppendFast。
    const renderGrid = functionSlice(app, "renderGrid");
    assert.match(renderGrid, /&& els\.assetGrid\.dataset\.renderedCardInfo === cardInfo/,
      `${tree}: canAppendFast must require the rendered card-info state to match`);
    assert.match(renderGrid, /const previousCardInfo = els\.assetGrid\.dataset\.renderedCardInfo \|\| "";/,
      `${tree}: renderGrid must read the previously rendered card-info state`);
    assert.match(renderGrid, /els\.assetGrid\.dataset\.renderedCardInfo = cardInfo;/,
      `${tree}: renderGrid must record the rendered card-info state`);
    // 开关变化触发整体重排（9c7457e 删掉的 renderedDensity 判断，改名恢复）。
    assert.match(renderGrid, /const requiresFullMasonry = !canAppendFast && \(previousCardInfo !== cardInfo \|\| changedCards\.length >= state\.assets\.length\);/,
      `${tree}: a card-info switch must force the full masonry relayout`);
  }
});

test("the virtual span cache key and its prune prefix carry the switch state", async () => {
  for (const tree of TREES) {
    const app = await read(`${tree}/app.mjs`);
    const spanKey = functionSlice(app, "galleryVirtualSpanKey");
    assert.match(spanKey, /`\$\{state\.showCardInfo \? "show" : "hide"\}\\u001f\$\{Math\.round\(columnWidth\)\}\\u001f\$\{assetId\}`/,
      `${tree}: galleryVirtualSpanKey must prefix the switch state`);
    const prune = functionSlice(app, "pruneGalleryVirtualSpanCache");
    assert.match(prune, /`\$\{state\.showCardInfo \? "show" : "hide"\}\\u001f\$\{Math\.round\(galleryCardVirtualColumnWidth\)\}\\u001f`/,
      `${tree}: pruneGalleryVirtualSpanCache must rebuild the prefix from the switch state`);
  }
});

test("styles.css keeps the default-hide rule and adds the show override", async () => {
  for (const tree of TREES) {
    const css = await read(`${tree}/styles.css`);
    assert.match(css, /\.mosa-v2 \.asset-card-info \{ display: none; \}/,
      `${tree}: the default-hide rule must stay`);
    assert.match(css, /\.mosa-v2 \.grid\[data-card-info="show"\] \.asset-card-info \{ display: block; \}/,
      `${tree}: the show override must exist`);
  }
});

test("i18n carries the three card-info keys in zh and en", async () => {
  for (const tree of TREES) {
    const i18n = await read(`${tree}/i18n.mjs`);
    for (const [key, zh, en] of [
      ["cardInfo", "素材卡片信息", "Card info"],
      ["cardInfoShow", "显示", "Show"],
      ["cardInfoHide", "隐藏", "Hide"],
    ]) {
      assert.match(i18n, new RegExp(`\\b${key}: "${zh}"`), `${tree}: zh must define ${key}`);
      assert.match(i18n, new RegExp(`\\b${key}: "${en}"`), `${tree}: en must define ${key}`);
    }
  }
});
