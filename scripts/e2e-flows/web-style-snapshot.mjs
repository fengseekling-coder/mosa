// R21（Web 端）样式快照：用固定数据打开 Web UI，从 getComputedStyle /
// getBoundingClientRect 量出关键元素【实际生效】的尺寸、间距、字号、颜色，
// 与 test/fixtures/web-style-snapshot.json 基准逐项比对，一次列出全部差异。
//
// 为什么：读样式表源码的契约测试（test/web-r21-*.test.mjs）查不到浏览器里真正
// 生效的值——R21 期间同一个选择器在 styles.css 里出现多次，只有最后一组生效，
// 源码测试却只查了第一组。这里量的是级联后的最终值，兜住这类回归。
//
// 什么时候更新基准：只有当你【有意】改了 Web 样式、且新值就是要发布的设计决定
// 时。怎么更新：
//   npm run build
//   MOSA_STYLE_SNAPSHOT_UPDATE=1 MOSA_E2E_ONLY=web-style-snapshot node scripts/e2e-critical-flows.mjs
// 更新后必须在 PR 说明里列出所有变化的键（看基准文件的 git diff 即可），并给出
// 改动理由；没改样式基准却变了，一律按回归排查，不许更新基准了事。
//
// 稳定性：渲染窗口 1280×800（scripts/e2e-web-driver.mjs 固定），浅色主题、默认
// 设置、中文界面。只量与滚动位置、动画中间态、当前时间无关的值；量之前等
// document.fonts.ready、图片解码完、目标几何连续两次采样一致。像素值四舍五入
// 到 0.5px 存基准；颜色归一成 hex；字号不加舍入、要求完全相等。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "web-style-snapshot";
export const description = "R21 样式快照：量实际生效样式并与 test/fixtures/web-style-snapshot.json 比对（MOSA_STYLE_SNAPSHOT_UPDATE=1 重录基准）";

const BASELINE_PATH = join("test", "fixtures", "web-style-snapshot.json");
const UPDATE_ENV = "MOSA_STYLE_SNAPSHOT_UPDATE";
const PX_TOLERANCE = 0.5;

// 每个键的比对方式：px（几何值，容差 0.5px）/ font（字号、字重，完全相等）/
// color（颜色，完全相等，归一成 hex）。键名即页面源码里写入 R 的键名。
const KEY_KINDS = {
  // 外壳
  "shell.topbarHeight": "px",
  "shell.sidebarWidth": "px",
  "shell.baseFontSize": "font",
  "shell.bodyColor": "color",
  "shell.bodyBackground": "color",
  "shell.navItemColor": "color",
  "shell.navItemHeight": "px",
  "shell.navItemRadius": "px",
  "shell.navItemActiveColor": "color",
  "shell.navItemActiveBackground": "color",
  // 顶栏控件
  "topbar.typeFilterHeight": "px",
  "topbar.typeFilterRadius": "px",
  "topbar.typeFilterBackground": "color",
  "topbar.typeFilterFontSize": "font",
  "topbar.typeFilterActiveBackground": "color",
  "topbar.typeFilterActiveColor": "color",
  "topbar.sortSelectHeight": "px",
  "topbar.sortSelectRadius": "px",
  "topbar.sortSelectBackground": "color",
  "topbar.categorySelectHeight": "px",
  "topbar.categorySelectRadius": "px",
  "topbar.categorySelectBackground": "color",
  "topbar.searchHeight": "px",
  "topbar.searchRadius": "px",
  "topbar.searchBackground": "color",
  // 画廊与卡片
  "gallery.gridPaddingTop": "px",
  "gallery.gridPaddingLeft": "px",
  "gallery.gridPaddingRight": "px",
  "gallery.gridPaddingBottom": "px",
  "gallery.gridColumnGap": "px",
  "gallery.cardGapX": "px",
  "gallery.thumbRadius": "px",
  "gallery.thumbBackground": "color",
  "gallery.selectionRingWidth": "px",
  "gallery.selectionRingColor": "color",
  "gallery.selectionRingRadius": "px",
  "gallery.cardInfoTitleFontSize": "font",
  "gallery.cardInfoTitleColor": "color",
  "gallery.cardInfoMetaFontSize": "font",
  "gallery.cardInfoMetaColor": "color",
  "gallery.cardInfoPaddingTop": "px",
  "gallery.cardInfoPaddingBottom": "px",
  "gallery.cardInfoPaddingLeft": "px",
  "gallery.cardInfoPaddingRight": "px",
  // 检视器
  "inspector.width": "px",
  "inspector.headerHeight": "px",
  "inspector.titleFontSize": "font",
  "inspector.titleFontWeight": "font",
  "inspector.titleColor": "color",
  "inspector.miniWidth": "px",
  "inspector.miniAspectRatio": "str",
  "inspector.miniRadius": "px",
  "inspector.factKeyFontSize": "font",
  "inspector.factKeyColor": "color",
  "inspector.factValFontSize": "font",
  "inspector.factValColor": "color",
  // 设置弹窗
  "settings.cardWidth": "px",
  "settings.cardHeight": "px",
  "settings.cardRadius": "px",
  "settings.sidebarWidth": "px",
  "settings.navTabHeight": "px",
  "settings.navTabColor": "color",
  "settings.navTabActiveBackground": "color",
  "settings.navTabActiveColor": "color",
  // 深色主题（R21 没有深色规格：只守关键颜色没被浅色规则串进去）
  "dark.bodyBackground": "color",
  "dark.bodyColor": "color",
  "dark.navItemActiveBackground": "color",
  "dark.typeFilterActiveBackground": "color",
  "dark.thumbBackground": "color",
  "dark.selectionRingColor": "color",
};

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  let readings;
  try {
    readings = await ctx.runInPage(server, measurementSource({ plainAssetId: (await seedAssets(ctx, server.origin)).ids[0] }));
  } finally {
    await server.stop();
  }

  const missingReadings = Object.keys(KEY_KINDS).filter((key) => readings?.[key] === undefined);
  if (missingReadings.length) {
    throw new Error(`页面没有量到 ${missingReadings.length} 个键（选择器断了或步骤没走完）：${missingReadings.join(", ")}`);
  }
  const measured = normalize(readings);
  const baselinePath = join(ctx.rootDir, BASELINE_PATH);

  if (process.env[UPDATE_ENV] === "1") {
    await mkdir(dirname(baselinePath), { recursive: true });
    const payload = `${JSON.stringify(measured, null, 2)}\n`;
    await writeFile(baselinePath, payload, "utf8");
    const reread = await readFile(baselinePath, "utf8");
    if (reread !== payload) throw new Error("基准写回后读不一致，请检查文件系统。");
    return { updated: true, keys: Object.keys(measured).length, path: BASELINE_PATH };
  }

  let baseline;
  try {
    baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  } catch {
    throw new Error(`样式基准不存在或不可解析：${BASELINE_PATH}\n首次生成：${UPDATE_ENV}=1 MOSA_E2E_ONLY=${name} node scripts/e2e-critical-flows.mjs`);
  }
  const problems = compareWithBaseline(measured, baseline);
  if (problems.length) {
    throw new Error(`样式快照与基准不一致，共 ${problems.length} 处：\n${problems.join("\n")}\n（若是你有意改的样式：${UPDATE_ENV}=1 MOSA_E2E_ONLY=${name} node scripts/e2e-critical-flows.mjs 重录基准，并在 PR 里列出变化的键）`);
  }
  return { compared: Object.keys(measured).length, path: BASELINE_PATH };
}

// ===== 预置数据：5 张不同尺寸的图（第 3 张进分组、后两张堆叠成 1 张卡）=====
async function seedAssets(ctx, origin) {
  const seeds = [
    ["snap-a.png", [96, 64], [74, 127, 181], "snapshot alpha"],
    ["snap-b.png", [64, 96], [181, 68, 74], "snapshot bravo"],
    ["snap-c.png", [80, 80], [58, 138, 87], "snapshot charlie"],
    ["snap-d.png", [120, 60], [138, 90, 47], "snapshot delta"],
    ["snap-e.png", [72, 72], [96, 74, 155], "snapshot echo"],
  ];
  const ids = [];
  for (const [index, [file, [width, height], color, prompt]] of seeds.entries()) {
    const imagePath = await ctx.makePng(file, color, { width, height });
    const body = await ctx.api(origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath,
      prompt,
      ...(index === 2 ? { group: "样式快照分组" } : {}),
    });
    if (!body?.asset?.id) throw new Error(`样式快照预置图失败：${file}`);
    ids.push(body.asset.id);
  }
  const stack = await ctx.api(origin, "POST", "/api/asset-stacks", {
    projectId: "default",
    assetIds: [ids[3], ids[4]],
    coverAssetId: ids[3],
  });
  if (!stack?.stack?.id) throw new Error("样式快照预置堆叠失败。");
  return { ids };
}

// ===== 比对 =====
function compareWithBaseline(measured, baseline) {
  if (typeof baseline !== "object" || baseline === null || Array.isArray(baseline)) {
    return [`基准文件格式不对：${BASELINE_PATH} 必须是扁平的 { 键: 值 } JSON。`];
  }
  const problems = [];
  for (const [key, actual] of Object.entries(measured)) {
    if (!(key in baseline)) {
      problems.push(`  ${key}: 基准里没有这个键（新增的测量项，需要重录基准）`);
      continue;
    }
    const expected = baseline[key];
    const equal = KEY_KINDS[key] === "px"
      ? Math.abs(actual - expected) <= PX_TOLERANCE + 1e-9
      : actual === expected;
    if (!equal) problems.push(`  ${key}: 基准 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`);
  }
  for (const key of Object.keys(baseline)) {
    if (!(key in measured)) problems.push(`  ${key}: 基准里有但这次没量到（测量项被删了？重录基准）`);
  }
  return problems;
}

function normalize(readings) {
  const roundHalf = (value) => Math.round(value * 2) / 2;
  const normalized = {};
  for (const [key, kind] of Object.entries(KEY_KINDS)) {
    const raw = String(readings[key]);
    if (kind === "color") {
      normalized[key] = normalizeColor(raw);
      continue;
    }
    if (kind === "str") {
      normalized[key] = raw.trim();
      continue;
    }
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value)) throw new Error(`键 ${key} 量到非数值：${raw}`);
    normalized[key] = kind === "px" ? roundHalf(value) : value;
  }
  return Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b)));
}

function normalizeColor(value) {
  const match = /^rgba?\((\d+(?:\.\d+)?), (\d+(?:\.\d+)?), (\d+(?:\.\d+)?)(?:, (\d+(?:\.\d+)?))?\)$/.exec(value.trim());
  if (!match) return value.trim();
  const [r, g, b] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  if (alpha !== 1) return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  const hex = (n) => n.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// ===== 页面内测量源码 =====
function measurementSource({ plainAssetId }) {
  return `(async () => {
    const seed = { plainAssetId: ${JSON.stringify(plainAssetId)} };
    ${PAGE_HELPERS}
    const R = {};
    const pick = (selector) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error('missing element ' + selector + ' diagnostic=' + JSON.stringify(pageDiagnostic()));
      return el;
    };
    const rectOf = (el) => el.getBoundingClientRect();
    const styleOf = (el, pseudo) => getComputedStyle(el, pseudo || null);

    // 两次采样一致才算稳：吃掉瀑布流重排、主题过渡。
    async function waitStable(sample, label, attempts = 40) {
      let prev = JSON.stringify(sample());
      for (let i = 0; i < attempts; i += 1) {
        await sleep(150);
        const next = JSON.stringify(sample());
        if (next === prev) return;
        prev = next;
      }
      throw new Error('never settled: ' + label + ' last=' + prev.slice(0, 200));
    }

    // 等入场动画真正结束（transform 回到恒等、子树没有在跑的动画）。
    // 只靠「两次采样相同」会被繁忙渲染器骗过：动画启动被推迟时，两个采样
    // 都落在起始值上，量到的就是 scale(.985) 这样的中间态。设置弹窗实测
    // 出现过一次，所以几何测量前必须先过这里。
    async function waitForMotionSettled(el, label) {
      await waitFor(() => {
        const transform = getComputedStyle(el).transform;
        return transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)';
      }, 'transform settles (' + label + ')');
      if (typeof el.getAnimations === 'function') {
        await Promise.race([
          Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))),
          sleep(3000),
        ]);
      }
    }

    async function waitGallerySettled(minCards) {
      await waitFor(() => gallerySettled() && rootCardIds().length >= minCards, minCards + ' seeded cards settled');
      await document.fonts.ready;
      await Promise.all([...document.images].map((img) => img.decode().catch(() => {})));
      await waitFor(
        () => [...document.querySelectorAll('#assetGrid .thumb img')].every((img) => img.complete && img.naturalWidth > 0),
        'thumbnails decoded',
      );
      await waitStable(() => [...document.querySelectorAll('#assetGrid > .asset-card')].map((card) => {
        const r = rectOf(card);
        return [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 2));
      }), 'card layout');
      await waitForMotionSettled(pick('#assetGrid'), 'gallery');
    }

    // 第一行相邻卡片左边缘差 = 实际生效的列间距（行内所有间隙必须一致）。
    function firstRowGapX() {
      const cards = [...document.querySelectorAll('#assetGrid > .asset-card')]
        .filter((card) => card.querySelector('.asset-card-select'));
      const rects = cards.map((card) => rectOf(card)).sort((a, b) => a.top - b.top || a.left - b.left);
      const topRow = rects.filter((r) => r.top < rects[0].bottom - 1).sort((a, b) => a.left - b.left);
      const gaps = [];
      for (let i = 1; i < topRow.length; i += 1) gaps.push(topRow[i].left - topRow[i - 1].right);
      if (!gaps.length) throw new Error('no same-row card pair to measure the column gap');
      for (const other of gaps) {
        if (Math.abs(other - gaps[0]) > 0.5) throw new Error('uneven column gaps: ' + JSON.stringify(gaps));
      }
      return gaps[0];
    }

    const settingsMenu = () => pick('#settingsMenu');
    const openSettings = async (label) => {
      click('#settingsToggle');
      await waitFor(() => !settingsMenu().hidden, 'settings opens (' + label + ')');
    };
    const closeSettings = async (label) => {
      click('#settingsMenu [data-settings-close]');
      await waitFor(() => settingsMenu().hidden, 'settings closes (' + label + ')');
    };

    // ---- 1) 浅色基础：外壳 / 顶栏 / 画廊（卡片信息默认关）----
    await waitGallerySettled(4);
    R['shell.topbarHeight'] = rectOf(pick('.mosa-v2 .topbar')).height;
    R['shell.sidebarWidth'] = rectOf(pick('#appSidebar')).width;
    const bodyStyle = styleOf(document.body);
    R['shell.baseFontSize'] = bodyStyle.fontSize;
    R['shell.bodyColor'] = bodyStyle.color;
    R['shell.bodyBackground'] = bodyStyle.backgroundColor;
    const navNormal = styleOf(pick('#quickFilters .nav-item[data-filter="favorite"]'));
    R['shell.navItemColor'] = navNormal.color;
    R['shell.navItemHeight'] = rectOf(pick('#quickFilters .nav-item[data-filter="favorite"]')).height;
    R['shell.navItemRadius'] = navNormal.borderTopLeftRadius;
    const navActive = styleOf(pick('#quickFilters .nav-item[data-filter="all"]'));
    R['shell.navItemActiveColor'] = navActive.color;
    R['shell.navItemActiveBackground'] = navActive.backgroundColor;

    const typeNormal = pick('.type-filter[data-type="img"]');
    const typeNormalStyle = styleOf(typeNormal);
    R['topbar.typeFilterHeight'] = rectOf(typeNormal).height;
    R['topbar.typeFilterRadius'] = typeNormalStyle.borderTopLeftRadius;
    R['topbar.typeFilterBackground'] = typeNormalStyle.backgroundColor;
    R['topbar.typeFilterFontSize'] = typeNormalStyle.fontSize;
    const typeActive = styleOf(pick('.type-filter[data-type="all"]'));
    R['topbar.typeFilterActiveBackground'] = typeActive.backgroundColor;
    R['topbar.typeFilterActiveColor'] = typeActive.color;

    const sortSelect = pick('#sortSelect');
    const sortStyle = styleOf(sortSelect);
    R['topbar.sortSelectHeight'] = rectOf(sortSelect).height;
    R['topbar.sortSelectRadius'] = sortStyle.borderTopLeftRadius;
    R['topbar.sortSelectBackground'] = sortStyle.backgroundColor;

    const searchBox = pick('.topbar-search');
    const searchStyle = styleOf(searchBox);
    R['topbar.searchHeight'] = rectOf(searchBox).height;
    R['topbar.searchRadius'] = searchStyle.borderTopLeftRadius;
    R['topbar.searchBackground'] = searchStyle.backgroundColor;

    // 任务 34：分类下拉框（复用 .sort-control 链，锁定与排序框同款外观）。
    const categorySelect = pick('#categorySelect');
    const categoryStyle = styleOf(categorySelect);
    R['topbar.categorySelectHeight'] = rectOf(categorySelect).height;
    R['topbar.categorySelectRadius'] = categoryStyle.borderTopLeftRadius;
    R['topbar.categorySelectBackground'] = categoryStyle.backgroundColor;

    const gridStyle = styleOf(pick('#assetGrid'));
    R['gallery.gridPaddingTop'] = gridStyle.paddingTop;
    R['gallery.gridPaddingLeft'] = gridStyle.paddingLeft;
    R['gallery.gridPaddingRight'] = gridStyle.paddingRight;
    R['gallery.gridPaddingBottom'] = gridStyle.paddingBottom;
    R['gallery.gridColumnGap'] = gridStyle.columnGap;
    R['gallery.cardGapX'] = firstRowGapX();
    const thumb = pick('#assetGrid .thumb');
    const thumbStyle = styleOf(thumb);
    R['gallery.thumbRadius'] = thumbStyle.borderTopLeftRadius;
    R['gallery.thumbBackground'] = thumbStyle.backgroundColor;

    // ---- 2) 设置弹窗（两栏框架），顺手用真实入口打开卡片信息 ----
    await openSettings('first');
    await waitForMotionSettled(pick('.mosa-v2 .settings-modal-card'), 'settings modal');
    await waitStable(() => {
      const r = rectOf(pick('.mosa-v2 .settings-modal-card'));
      return [r.width, r.height].map((v) => Math.round(v * 2));
    }, 'settings modal');
    const settingsCard = pick('.mosa-v2 .settings-modal-card');
    R['settings.cardWidth'] = rectOf(settingsCard).width;
    R['settings.cardHeight'] = rectOf(settingsCard).height;
    R['settings.cardRadius'] = styleOf(settingsCard).borderTopLeftRadius;
    R['settings.sidebarWidth'] = rectOf(pick('.mosa-v2 .settings-modal-sidebar')).width;
    const settingsTabNormal = pick('#settingsMenu [data-settings-page="library"]');
    R['settings.navTabHeight'] = rectOf(settingsTabNormal).height;
    R['settings.navTabColor'] = styleOf(settingsTabNormal).color;
    const settingsTabActive = styleOf(pick('#settingsMenu [data-settings-page="general"]'));
    R['settings.navTabActiveBackground'] = settingsTabActive.backgroundColor;
    R['settings.navTabActiveColor'] = settingsTabActive.color;
    click('#settingsMenu [data-card-info-opt="show"]');
    await waitFor(() => pick('#assetGrid').dataset.cardInfo === 'show', 'card info turns on');
    await closeSettings('after card info');

    // ---- 3) 卡片信息区字号 / 颜色 ----
    await waitGallerySettled(4);
    const cardInfo = pick('#assetGrid .asset-card-info');
    if (styleOf(cardInfo).display === 'none') throw new Error('card info is still display:none after enabling it');
    const infoStyle = styleOf(cardInfo);
    R['gallery.cardInfoPaddingTop'] = infoStyle.paddingTop;
    R['gallery.cardInfoPaddingBottom'] = infoStyle.paddingBottom;
    R['gallery.cardInfoPaddingLeft'] = infoStyle.paddingLeft;
    R['gallery.cardInfoPaddingRight'] = infoStyle.paddingRight;
    const infoTitle = styleOf(pick('#assetGrid .asset-card-title'));
    R['gallery.cardInfoTitleFontSize'] = infoTitle.fontSize;
    R['gallery.cardInfoTitleColor'] = infoTitle.color;
    const infoMeta = styleOf(pick('#assetGrid .asset-card-meta'));
    R['gallery.cardInfoMetaFontSize'] = infoMeta.fontSize;
    R['gallery.cardInfoMetaColor'] = infoMeta.color;

    // ---- 4) 检视器与选中框：点普通素材卡打开素材详情（堆叠卡开的是堆叠检视器，没有头部小图）----
    const detailCardButton = () => document.querySelector('.asset-card[data-id="' + CSS.escape(seed.plainAssetId) + '"] .asset-card-select');
    await waitFor(() => detailCardButton()?.isConnected, 'plain asset card button');
    detailCardButton().click();
    await waitFor(() => pick('#detailPanel').getAttribute('aria-hidden') === 'false' && document.querySelector('.asset-card.selected'), 'detail opens with the selected card');
    // 检视器内容是异步渲染的：等头部小图和事实行真的出现再量。
    await waitFor(() => pick('#detailPanel').querySelector('.asset-mini') && pick('#detailPanel').querySelector('.head-facts .meta-key'), 'inspector head renders');
    await waitForMotionSettled(pick('.detail-inspector'), 'inspector');
    await waitStable(() => [Math.round(rectOf(pick('#detailPanel')).width * 2)], 'inspector width');
    R['inspector.width'] = rectOf(pick('#detailPanel')).width;
    R['inspector.headerHeight'] = rectOf(pick('.detail-inspector-header')).height;
    const inspectorTitle = styleOf(pick('.detail-inspector-header > span'));
    R['inspector.titleFontSize'] = inspectorTitle.fontSize;
    R['inspector.titleFontWeight'] = inspectorTitle.fontWeight;
    R['inspector.titleColor'] = inspectorTitle.color;
    const mini = pick('#detailPanel .asset-mini');
    const miniStyle = styleOf(mini);
    // 宽度用计算值：132 是内容盒设计值（1px 边框不占其中，矩形外沿 134），
    // 记计算值才和 R21 的「132 小图」对得上；比例锁 1:1。
    R['inspector.miniWidth'] = miniStyle.width;
    R['inspector.miniAspectRatio'] = miniStyle.aspectRatio;
    R['inspector.miniRadius'] = miniStyle.borderTopLeftRadius;
    const factKey = styleOf(pick('#detailPanel .head-facts .meta-key'));
    R['inspector.factKeyFontSize'] = factKey.fontSize;
    R['inspector.factKeyColor'] = factKey.color;
    const factVal = styleOf(pick('#detailPanel .head-facts .meta-val'));
    R['inspector.factValFontSize'] = factVal.fontSize;
    R['inspector.factValColor'] = factVal.color;
    const selectedCard = pick('.asset-card.selected');
    const ring = styleOf(selectedCard, '::after');
    R['gallery.selectionRingWidth'] = ring.borderWidth;
    R['gallery.selectionRingColor'] = ring.borderColor;
    R['gallery.selectionRingRadius'] = ring.borderTopLeftRadius;

    // ---- 5) 深色主题关键颜色（设置里的真实入口切换）----
    await openSettings('dark');
    click('#settingsMenu [data-appearance-opt="dark"]');
    await waitFor(() => document.documentElement.dataset.theme === 'dark', 'dark theme applied');
    await closeSettings('after dark');
    await waitStable(() => [
      styleOf(document.body).backgroundColor,
      styleOf(document.body).color,
      styleOf(pick('#quickFilters .nav-item[data-filter="all"]')).backgroundColor,
      styleOf(pick('.type-filter[data-type="all"]')).backgroundColor,
      styleOf(pick('#assetGrid .thumb')).backgroundColor,
      styleOf(pick('.asset-card.selected'), '::after').borderColor,
    ], 'dark colours');
    const bodyDark = styleOf(document.body);
    R['dark.bodyBackground'] = bodyDark.backgroundColor;
    R['dark.bodyColor'] = bodyDark.color;
    R['dark.navItemActiveBackground'] = styleOf(pick('#quickFilters .nav-item[data-filter="all"]')).backgroundColor;
    R['dark.typeFilterActiveBackground'] = styleOf(pick('.type-filter[data-type="all"]')).backgroundColor;
    R['dark.thumbBackground'] = styleOf(pick('#assetGrid .thumb')).backgroundColor;
    R['dark.selectionRingColor'] = styleOf(pick('.asset-card.selected'), '::after').borderColor;

    return R;
  })()`;
}
