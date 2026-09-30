// Pluggable e2e flow: 专用大图查看器（asset view）。
// API 预置 V1..V5（V3 为 2400×1600，大于 1280×800 沙箱窗口）与 V-Group 分组两张，
// 然后经真实入口驱动查看器：卡片右键菜单"在查看器中打开"、Prev/Next 按钮与
// ArrowLeft/ArrowRight 翻页（asset-view.mjs 绑定，边界禁用按钮、不循环）、缩放按钮、
// 返回按钮与 Escape 退出、分组范围隔离、托管原图缺失时的错误态。
// 页面只回传观察到的事实，全部断言在 Node 端逐项检查。

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "asset-viewer";
export const description = "context-menu open -> button/keyboard prev-next boundaries -> zoom in/out/fit -> back + Escape -> group scope isolation -> missing managed original shows error state";

const GROUP_NAME = "V-Group";
const EXPECTED_ROOT_COUNT = 7;

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const seed = await seedAssets(ctx, server.origin);
    const root = assertRootViewerPhase(await ctx.runInPage(server, rootViewerSource(seed)), seed);
    const group = assertGroupScopePhase(await ctx.runInPage(server, groupScopeSource(seed)), seed);
    const broken = await breakManagedOriginal(ctx, server.origin);
    const error = assertLoadErrorPhase(await ctx.runInPage(server, loadErrorSource({ ...seed, brokenId: broken.id })), seed, broken);
    return { root, group, error };
  } finally {
    await server.stop();
  }
}

async function seedAssets(ctx, origin) {
  const created = [];
  const create = async (fileName, [r, g, b], options = {}) => {
    const response = await ctx.api(origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: await ctx.makePng(fileName, [r, g, b], options.size ? { width: options.size[0], height: options.size[1] } : {}),
      prompt: `asset-viewer ${fileName}`,
      ...(options.group ? { group: options.group } : {}),
    });
    if (!response?.asset?.id || !response?.asset?.image_path) {
      throw new Error(`Asset viewer seed failed for ${fileName}: ${JSON.stringify(response)}`);
    }
    created.push(response.asset.id);
    return response.asset;
  };
  await create("viewer-v1.png", [181, 68, 74]);
  await create("viewer-v2.png", [74, 127, 181]);
  const v3 = await create("viewer-v3.png", [58, 138, 87], { size: [2400, 1600] });
  await create("viewer-v4.png", [138, 90, 47]);
  await create("viewer-v5.png", [96, 74, 155]);
  const groupA = await create("viewer-group-a.png", [66, 165, 245], { group: GROUP_NAME });
  const groupB = await create("viewer-group-b.png", [240, 98, 146], { group: GROUP_NAME });
  if (new Set(created).size !== EXPECTED_ROOT_COUNT) throw new Error("Asset viewer seed produced duplicate asset ids.");
  return { v3: v3.id, groupA: groupA.id, groupB: groupB.id, expectedRootCount: EXPECTED_ROOT_COUNT, groupName: GROUP_NAME };
}

function rootViewerSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    const view = () => document.querySelector('#assetView');
    const image = () => document.querySelector('#assetViewImage');
    const currentId = () => image().dataset.assetId || '';
    const positionText = () => document.querySelector('#assetViewPosition')?.textContent?.trim() || '';
    const zoomText = () => document.querySelector('#assetZoomValue')?.textContent?.trim() || '';
    const selectedCardId = () => document.querySelector('.asset-card.selected')?.dataset.id || '';
    // Right-click puts the card into the multi-selection to target the menu;
    // "Open in viewer" must drop it again (like double-click), so after either
    // exit path the last viewed card is the plain .selected card and nothing is
    // left multi-selected.
    const selectionMarkedCardId = () => document.querySelector('.asset-card.selected, .asset-card.multi-selected')?.dataset.id || '';
    const parsePos = (text) => {
      const parts = String(text).split(' / ');
      const pos = Number(parts[0]);
      const total = Number(parts[1]);
      if (parts.length !== 2 || !Number.isInteger(pos) || !Number.isInteger(total)) throw new Error('Unexpected position text: ' + text);
      return { pos, total };
    };
    const percentOf = (text) => {
      if (!String(text).endsWith('%')) throw new Error('Unexpected zoom value: ' + text);
      const value = Number(String(text).slice(0, -1));
      if (!Number.isInteger(value)) throw new Error('Unexpected zoom value: ' + text);
      return value;
    };
    const pressKey = (key) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    const openViewer = async (assetId) => {
      const item = await openContextMenu(cardSelector(assetId), '在查看器中打开');
      item.click();
      await waitFor(() => !view().hidden, 'asset view opens');
      await waitFor(() => !image().hidden && image().complete && image().naturalWidth > 0, 'viewer image loaded');
    };
    // 位置文字与画廊顺序一致是本流程的核心不变量：viewer 序列取自打开时的画廊结果集。
    const navStep = async (direction, via) => {
      const before = parsePos(positionText());
      if (via === 'key') pressKey(direction === 1 ? 'ArrowRight' : 'ArrowLeft');
      else click(direction === 1 ? '#assetViewNext' : '#assetViewPrev');
      await waitFor(() => {
        const after = parsePos(positionText());
        return after.pos === before.pos + direction && currentId() === rootIds[after.pos - 1];
      }, (via === 'key' ? 'keyboard ' : 'button ') + (direction === 1 ? 'next' : 'prev'));
      return { fromPos: before.pos, toPos: parsePos(positionText()).pos, toId: currentId(), positionText: positionText() };
    };
    const recenterToV3 = async () => {
      let guard = 0;
      while (parsePos(positionText()).pos !== v3Position && guard++ < total + 1) {
        const current = parsePos(positionText()).pos;
        await navStep(current < v3Position ? 1 : -1, 'button');
      }
    };

    await waitFor(() => gallerySettled() && rootCardIds().length === config.expectedRootCount, 'seven seeded root cards');
    const rootIds = rootCardIds();
    const v3Position = rootIds.indexOf(config.v3) + 1;
    if (v3Position < 1) throw new Error('V3 missing from root gallery: ' + JSON.stringify(rootIds));

    await openViewer(config.v3);
    const opened = {
      currentId: currentId(),
      positionText: positionText(),
      scopeText: document.querySelector('#assetViewScope')?.textContent?.trim() || '',
      focusOnBack: document.activeElement === document.querySelector('#assetViewBack'),
    };
    const total = parsePos(positionText()).total;

    const steps = {};
    if (!document.querySelector('#assetViewNext').disabled) steps.buttonNext = await navStep(1, 'button');
    if (!document.querySelector('#assetViewPrev').disabled) steps.buttonPrev = await navStep(-1, 'button');
    if (!document.querySelector('#assetViewNext').disabled) steps.keyNext = await navStep(1, 'key');
    if (!document.querySelector('#assetViewPrev').disabled) steps.keyPrev = await navStep(-1, 'key');

    await recenterToV3();
    // 走到末端：Next disabled；末端按键不循环（代码实现为 canNavigate false 的 no-op）。
    let walkGuard = 0;
    while (!document.querySelector('#assetViewNext').disabled && walkGuard++ < total) await navStep(1, 'button');
    const endState = {
      positionText: positionText(),
      currentId: currentId(),
      nextDisabled: document.querySelector('#assetViewNext').disabled,
      prevDisabled: document.querySelector('#assetViewPrev').disabled,
    };
    pressKey('ArrowRight');
    await sleep(400);
    const endKeyNoop = { currentId: currentId(), positionText: positionText() };

    // 走回首张：Prev disabled；首张按键不循环。
    walkGuard = 0;
    while (!document.querySelector('#assetViewPrev').disabled && walkGuard++ < total) await navStep(-1, 'button');
    const firstState = {
      positionText: positionText(),
      currentId: currentId(),
      nextDisabled: document.querySelector('#assetViewNext').disabled,
      prevDisabled: document.querySelector('#assetViewPrev').disabled,
    };
    pressKey('ArrowLeft');
    await sleep(400);
    const firstKeyNoop = { currentId: currentId(), positionText: positionText() };

    await recenterToV3();
    await waitFor(() => percentOf(zoomText()) > 0, 'zoom percent shown');
    const fitPercent = percentOf(zoomText());
    click('#assetZoomIn');
    await waitFor(() => percentOf(zoomText()) > fitPercent, 'first zoom-in raises percent');
    const zoomInOne = percentOf(zoomText());
    click('#assetZoomIn');
    await waitFor(() => percentOf(zoomText()) > zoomInOne, 'second zoom-in raises percent');
    const zoomInTwo = percentOf(zoomText());
    click('#assetZoomOut');
    await waitFor(() => percentOf(zoomText()) < zoomInTwo, 'zoom-out lowers percent');
    const zoomOutOne = percentOf(zoomText());
    click('#assetZoomFit');
    await waitFor(() => percentOf(zoomText()) === fitPercent, 'fit restores the fit percent');
    const zoom = { fitPercent, zoomInOne, zoomInTwo, zoomOutOne, afterFit: percentOf(zoomText()) };

    click('#assetViewBack');
    await waitFor(() => view().hidden === true, 'asset view hidden after back');
    const afterBack = {
      viewHidden: view().hidden,
      selectedCardId: selectedCardId(),
      markedCardId: selectionMarkedCardId(),
      multiSelectedCount: document.querySelectorAll('.asset-card.multi-selected').length,
      focusInMarkedCard: Boolean(document.querySelector(cardSelector(selectionMarkedCardId()))?.contains(document.activeElement)),
    };

    await openViewer(config.v3);
    pressKey('Escape');
    await waitFor(() => view().hidden === true, 'asset view hidden after Escape');
    const afterEscape = {
      viewHidden: view().hidden,
      selectedCardId: selectedCardId(),
      markedCardId: selectionMarkedCardId(),
      multiSelectedCount: document.querySelectorAll('.asset-card.multi-selected').length,
    };
    await sleep(300);
    return { rootIds, v3Position, opened, steps, endState, endKeyNoop, firstState, firstKeyNoop, zoom, afterBack, afterEscape, rendererErrors };
  })()`;
}

function assertRootViewerPhase(result, seed) {
  const problems = [];
  if (result?.rendererErrors?.length) problems.push(`renderer errors: ${JSON.stringify(result.rendererErrors)}`);
  const ids = result?.rootIds;
  if (!Array.isArray(ids) || ids.length !== EXPECTED_ROOT_COUNT) problems.push(`root gallery ids ${JSON.stringify(ids)}`);
  const v3Index = Array.isArray(ids) ? ids.indexOf(seed.v3) : -1;
  if (v3Index < 0) problems.push("V3 missing from root gallery ids");
  if (problems.length) throw new Error(`Asset viewer root phase unusable: ${problems.join("; ")}`);

  const total = ids.length;
  const v3Position = v3Index + 1;
  const at = (oneBased) => ids[oneBased - 1];
  const opened = result.opened || {};
  if (opened.currentId !== seed.v3) problems.push(`opened shows ${opened.currentId}`);
  if (opened.positionText !== `${v3Position} / ${total}`) {
    problems.push(`opened position ${opened.positionText}, expected ${v3Position} / ${total}`);
  }
  if (opened.scopeText !== "所有素材") problems.push(`opened scope text ${JSON.stringify(opened.scopeText)}`);
  if (opened.focusOnBack !== true) problems.push(`focus after open: ${String(opened.focusOnBack)}`);

  // V3 在序列中点附近，四个翻页步都应发生；键盘步在任何位置都可用（见源码注释）。
  const expectedSteps = {
    buttonNext: v3Position < total,
    buttonPrev: v3Position > 1,
    keyNext: true,
    keyPrev: true,
  };
  for (const [key, direction] of [["buttonNext", 1], ["buttonPrev", -1], ["keyNext", 1], ["keyPrev", -1]]) {
    const step = result.steps?.[key];
    if (!expectedSteps[key]) continue;
    if (!step) { problems.push(`${key} did not run`); continue; }
    if (step.toPos !== step.fromPos + direction) problems.push(`${key} moved ${step.fromPos} -> ${step.toPos}`);
    if (step.toId !== at(step.toPos)) problems.push(`${key} shows ${step.toId} at position ${step.toPos}`);
    if (step.positionText !== `${step.toPos} / ${total}`) problems.push(`${key} position text ${step.positionText}`);
  }

  const endState = result.endState || {};
  if (endState.positionText !== `${total} / ${total}`) problems.push(`end position ${endState.positionText}`);
  if (endState.currentId !== at(total)) problems.push(`end asset ${endState.currentId}`);
  if (endState.nextDisabled !== true) problems.push(`Next enabled at end (disabled=${String(endState.nextDisabled)})`);
  if (endState.prevDisabled !== false) problems.push(`Prev disabled before end (disabled=${String(endState.prevDisabled)})`);
  const endNoop = result.endKeyNoop || {};
  if (endNoop.currentId !== endState.currentId || endNoop.positionText !== endState.positionText) {
    problems.push(`ArrowRight at end wrapped: ${JSON.stringify(endNoop)}`);
  }

  const firstState = result.firstState || {};
  if (firstState.positionText !== `1 / ${total}`) problems.push(`first position ${firstState.positionText}`);
  if (firstState.currentId !== at(1)) problems.push(`first asset ${firstState.currentId}`);
  if (firstState.prevDisabled !== true) problems.push(`Prev enabled at first (disabled=${String(firstState.prevDisabled)})`);
  if (firstState.nextDisabled !== false) problems.push(`Next disabled at first (disabled=${String(firstState.nextDisabled)})`);
  const firstNoop = result.firstKeyNoop || {};
  if (firstNoop.currentId !== firstState.currentId || firstNoop.positionText !== firstState.positionText) {
    problems.push(`ArrowLeft at first wrapped: ${JSON.stringify(firstNoop)}`);
  }

  const zoom = result.zoom || {};
  if (!(zoom.fitPercent > 0 && zoom.fitPercent < 100)) problems.push(`fit percent ${zoom.fitPercent} (2400×1600 must fit below 100%)`);
  if (!(zoom.zoomInOne > zoom.fitPercent)) problems.push(`zoom-in one ${zoom.zoomInOne} <= fit ${zoom.fitPercent}`);
  if (!(zoom.zoomInTwo > zoom.zoomInOne)) problems.push(`zoom-in two ${zoom.zoomInTwo} <= ${zoom.zoomInOne}`);
  if (!(zoom.zoomOutOne < zoom.zoomInTwo)) problems.push(`zoom-out ${zoom.zoomOutOne} >= ${zoom.zoomInTwo}`);
  if (zoom.afterFit !== zoom.fitPercent) problems.push(`after fit ${zoom.afterFit} != fit ${zoom.fitPercent}`);

  // Both exit paths: the last viewed card is the single selection and the
  // right-click multi-selection has been cleared.
  const afterBack = result.afterBack || {};
  if (afterBack.viewHidden !== true) problems.push(`view still open after back (${String(afterBack.viewHidden)})`);
  if (afterBack.multiSelectedCount !== 0) problems.push(`multi-selection left after back (${afterBack.multiSelectedCount})`);
  if (afterBack.selectedCardId !== seed.v3) {
    problems.push(`selection after back: selected=${afterBack.selectedCardId} marked=${afterBack.markedCardId}`);
  }
  if (afterBack.focusInMarkedCard !== true) problems.push(`focus after back not on marked card (${String(afterBack.focusInMarkedCard)})`);
  const afterEscape = result.afterEscape || {};
  if (afterEscape.viewHidden !== true) problems.push(`view still open after Escape (${String(afterEscape.viewHidden)})`);
  if (afterEscape.multiSelectedCount !== 0) problems.push(`multi-selection left after Escape (${afterEscape.multiSelectedCount})`);
  if (afterEscape.selectedCardId !== seed.v3) {
    problems.push(`selection after Escape: selected=${afterEscape.selectedCardId} marked=${afterEscape.markedCardId}`);
  }

  if (problems.length) throw new Error(`Asset viewer root phase mismatches: ${problems.join("; ")}`);
  return { positionText: opened.positionText, scopeText: opened.scopeText, zoom };
}

function groupScopeSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    const view = () => document.querySelector('#assetView');
    const image = () => document.querySelector('#assetViewImage');
    const currentId = () => image().dataset.assetId || '';
    const positionText = () => document.querySelector('#assetViewPosition')?.textContent?.trim() || '';

    await waitFor(() => gallerySettled() && rootCardIds().length === config.expectedRootCount, 'root cards before opening group');
    const groupButton = document.querySelector('#sidebarManualGroupList .nav-group-item[data-filter="group"][data-value="' + CSS.escape(config.groupName) + '"]');
    if (!groupButton) throw new Error('Missing sidebar entry for group ' + config.groupName);
    groupButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    await waitFor(() => gallerySettled() && JSON.stringify(rootCardIds().slice().sort()) === JSON.stringify([config.groupA, config.groupB].slice().sort()), 'group view shows exactly the two seeded assets');
    const groupIds = rootCardIds();
    const viewTitleText = document.querySelector('#viewTitle')?.textContent?.trim() || '';

    const item = await openContextMenu(cardSelector(groupIds[0]), '在查看器中打开');
    item.click();
    await waitFor(() => !view().hidden && !image().hidden && image().complete && image().naturalWidth > 0, 'viewer opens on first group asset');
    const opened = {
      currentId: currentId(),
      positionText: positionText(),
      scopeText: document.querySelector('#assetViewScope')?.textContent?.trim() || '',
    };
    click('#assetViewNext');
    await waitFor(() => currentId() === groupIds[1] && positionText() === '2 / 2', 'Next reaches the second group asset');
    const second = { currentId: currentId(), positionText: positionText(), nextDisabled: document.querySelector('#assetViewNext').disabled };
    click('#assetViewPrev');
    await waitFor(() => currentId() === groupIds[0] && positionText() === '1 / 2', 'Prev returns to the first group asset');
    const backToFirst = { positionText: positionText(), prevDisabled: document.querySelector('#assetViewPrev').disabled };
    await sleep(300);
    return { groupIds, viewTitleText, opened, second, backToFirst, rendererErrors };
  })()`;
}

function assertGroupScopePhase(result, seed) {
  const problems = [];
  if (result?.rendererErrors?.length) problems.push(`renderer errors: ${JSON.stringify(result.rendererErrors)}`);
  const groupIds = result?.groupIds;
  const expectedPair = JSON.stringify([seed.groupA, seed.groupB].slice().sort());
  if (JSON.stringify(Array.isArray(groupIds) ? groupIds.slice().sort() : groupIds) !== expectedPair) {
    problems.push(`group view ids ${JSON.stringify(groupIds)}`);
  }
  const opened = result?.opened || {};
  if (opened.currentId !== groupIds?.[0]) problems.push(`viewer opened on ${opened.currentId}`);
  if (opened.positionText !== "1 / 2") problems.push(`group viewer position ${opened.positionText}`);
  // The viewer scope chip mirrors the gallery title, which names an open
  // manual group.
  if (opened.scopeText !== GROUP_NAME) problems.push(`viewer scope text ${JSON.stringify(opened.scopeText)}, expected group name ${JSON.stringify(GROUP_NAME)}`);
  const second = result?.second || {};
  if (second.currentId !== groupIds?.[1]) problems.push(`Next left group scope: ${second.currentId}`);
  if (second.positionText !== "2 / 2") problems.push(`second position ${second.positionText}`);
  if (second.nextDisabled !== true) problems.push(`Next enabled at group end (disabled=${String(second.nextDisabled)})`);
  const backToFirst = result?.backToFirst || {};
  if (backToFirst.positionText !== "1 / 2") problems.push(`back position ${backToFirst.positionText}`);
  if (backToFirst.prevDisabled !== true) problems.push(`Prev enabled at group start (disabled=${String(backToFirst.prevDisabled)})`);
  if (problems.length) {
    throw new Error(`Asset viewer group scope mismatches (viewTitle=${JSON.stringify(result?.viewTitleText)}): ${problems.join("; ")}`);
  }
  return { positionTexts: [opened.positionText, second.positionText, backToFirst.positionText], scopeText: opened.scopeText, viewTitleText: result.viewTitleText };
}

// 加载失败场景：删除素材库里的托管原图。为避免与异步派生图管线竞态（若原图先被删，
// 派生任务会失败、preview_path 保持 NULL，viewer 回退原图 URL —— 结果一致；若派生先完成，
// 则 viewer 显示 preview，必须连派生文件一起删掉 display URL 才会 404），先等派生完成
// 再删除原图与已存在的派生文件，使查看器加载必然失败。
async function breakManagedOriginal(ctx, origin) {
  const created = await ctx.api(origin, "POST", "/api/assets/create", {
    projectId: "default",
    imagePath: await ctx.makePng("viewer-broken.png", [120, 120, 120]),
    prompt: "asset-viewer broken original",
  });
  const asset = created?.asset;
  if (!asset?.id || !asset?.image_path) throw new Error(`Broken-asset seed returned no asset: ${JSON.stringify(created)}`);
  const deadline = Date.now() + 20000;
  let current = asset;
  while (Date.now() < deadline) {
    current = (await ctx.api(origin, "GET", `/api/assets/default/${encodeURIComponent(asset.id)}`))?.asset || current;
    if (current?.preview_path || current?.medium_path || current?.thumbnail_path) break;
    await sleep(150);
  }
  await rm(asset.image_path, { force: true });
  const projectDir = join(ctx.libraryDir, "default");
  for (const path of [current?.preview_path, current?.medium_path, current?.thumbnail_path,
    join(projectDir, "previews", `${asset.id}.webp`), join(projectDir, "mediums", `${asset.id}.webp`), join(projectDir, "thumbnails", `${asset.id}.webp`)]) {
    if (path) await rm(path, { force: true });
  }
  return { id: asset.id, imagePath: asset.image_path };
}

function loadErrorSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    const view = () => document.querySelector('#assetView');
    await waitFor(() => gallerySettled() && rootCardIds().includes(config.brokenId), 'broken asset card appears in gallery');
    const item = await openContextMenu(cardSelector(config.brokenId), '在查看器中打开');
    item.click();
    await waitFor(() => !view().hidden, 'viewer opens on the broken asset');
    await waitFor(() => !document.querySelector('#assetViewError').hidden && (document.querySelector('#assetViewError').textContent || '').trim().length > 0, 'viewer error state becomes visible');
    const errorState = {
      currentId: document.querySelector('#assetViewImage')?.dataset.assetId || '',
      errorText: (document.querySelector('#assetViewError').textContent || '').trim(),
      imageHidden: document.querySelector('#assetViewImage').hidden,
      zoomValue: document.querySelector('#assetZoomValue')?.textContent?.trim() || '',
    };
    await sleep(500);
    return { ...errorState, rendererErrors };
  })()`;
}

function assertLoadErrorPhase(result, seed, broken) {
  const problems = [];
  if (result?.rendererErrors?.length) problems.push(`renderer errors: ${JSON.stringify(result.rendererErrors)}`);
  if (result?.currentId !== broken.id) problems.push(`viewer shows ${result?.currentId}, expected ${broken.id}`);
  if (!result?.errorText) problems.push("error text empty");
  if (result?.imageHidden !== true) problems.push(`stage image visible in error state (${String(result?.imageHidden)})`);
  if (result?.zoomValue !== "—") problems.push(`zoom value in error state ${JSON.stringify(result?.zoomValue)}`);
  if (problems.length) throw new Error(`Asset viewer load-error phase mismatches: ${problems.join("; ")}`);
  return { errorText: result.errorText };
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
