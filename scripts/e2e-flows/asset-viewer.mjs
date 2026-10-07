// Pluggable e2e flow: 专用大图查看器（asset view，GravityPort A4c 任务 90 改版后）。
// API 预置 V1..V5（V3 为 2400×1600，大于沙箱舞台）与 V-Group 分组两张，然后经真实
// 入口驱动查看器：卡片右键菜单"在查看器中打开"、舞台两侧箭头与 ArrowLeft/ArrowRight
// 翻页（边界禁用按钮、不循环）、键盘 +/− 与「适合窗口」按钮（位置计数与缩放控制条
// 已按稿子移除，缩放断言改走主图渲染几何）、右上「删除」→ 自动落下一张 → toast
// 「撤销」→ 恢复并回到这张图、返回按钮与 Escape 退出、分组范围隔离、托管原图缺失
// 时的错误态。页面只回传观察到的事实，全部断言在 Node 端逐项检查。

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "asset-viewer";
export const description = "context-menu open -> arrow/key prev-next boundaries -> keyboard zoom + fit button -> delete auto-advance + undo restore -> back + Escape -> group scope isolation -> missing managed original shows error state";

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
    const selectedCardId = () => document.querySelector('.asset-card.selected')?.dataset.id || '';
    // Right-click puts the card into the multi-selection to target the menu;
    // "Open in viewer" must drop it again (like double-click), so after either
    // exit path the last viewed card is the plain .selected card and nothing is
    // left multi-selected.
    const selectionMarkedCardId = () => document.querySelector('.asset-card.selected, .asset-card.multi-selected')?.dataset.id || '';
    const pressKey = (key) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    const openViewer = async (assetId) => {
      const item = await openContextMenu(cardSelector(assetId), '在查看器中打开');
      item.click();
      await waitFor(() => !view().hidden, 'asset view opens');
      await waitFor(() => !image().hidden && image().complete && image().naturalWidth > 0, 'viewer image loaded');
    };
    // 画廊卡片顺序即翻页序列（A4c 保留的核心不变量）：viewer 序列取自打开时的
    // 画廊结果集；位置计数已按稿子移除，落点用当前媒体 id 对照卡片顺序断言。
    const posOf = (id) => rootIds.indexOf(id) + 1;
    const navStep = async (direction, via) => {
      const before = posOf(currentId());
      if (via === 'key') pressKey(direction === 1 ? 'ArrowRight' : 'ArrowLeft');
      else click(direction === 1 ? '#assetViewNext' : '#assetViewPrev');
      await waitFor(() => posOf(currentId()) === before + direction, (via === 'key' ? 'keyboard ' : 'button ') + (direction === 1 ? 'next' : 'prev'));
      return { fromPos: before, toPos: posOf(currentId()), toId: currentId() };
    };
    const recenterToV3 = async () => {
      let guard = 0;
      while (currentId() !== config.v3 && guard++ < rootIds.length + 1) {
        await navStep(posOf(currentId()) < posOf(config.v3) ? 1 : -1, 'button');
      }
    };

    await waitFor(() => gallerySettled() && rootCardIds().length === config.expectedRootCount, 'seven seeded root cards');
    const rootIds = rootCardIds();
    const v3Position = posOf(config.v3);
    if (v3Position < 1) throw new Error('V3 missing from root gallery: ' + JSON.stringify(rootIds));

    await openViewer(config.v3);
    const opened = {
      currentId: currentId(),
      focusOnBack: document.activeElement === document.querySelector('#assetViewBack'),
    };
    // 稿子里移除的旧控件不再渲染。
    const removedControls = {
      positionGone: !document.querySelector('#assetViewPosition'),
      zoomBarGone: !document.querySelector('#assetViewControls') && !document.querySelector('#assetZoomOut') && !document.querySelector('#assetZoomIn'),
      scopeGone: !document.querySelector('#assetViewScope'),
      arrowsPresent: Boolean(document.querySelector('#assetViewPrev') && document.querySelector('#assetViewNext')),
    };

    const steps = {};
    if (!document.querySelector('#assetViewNext').disabled) steps.buttonNext = await navStep(1, 'button');
    if (!document.querySelector('#assetViewPrev').disabled) steps.buttonPrev = await navStep(-1, 'button');
    if (!document.querySelector('#assetViewNext').disabled) steps.keyNext = await navStep(1, 'key');
    if (!document.querySelector('#assetViewPrev').disabled) steps.keyPrev = await navStep(-1, 'key');

    await recenterToV3();
    // 走到末端：Next disabled；末端按键不循环（代码实现为 canNavigate false 的 no-op）。
    let walkGuard = 0;
    while (!document.querySelector('#assetViewNext').disabled && walkGuard++ < rootIds.length) await navStep(1, 'button');
    const endState = {
      currentId: currentId(),
      nextDisabled: document.querySelector('#assetViewNext').disabled,
      prevDisabled: document.querySelector('#assetViewPrev').disabled,
    };
    pressKey('ArrowRight');
    await sleep(400);
    const endKeyNoop = { currentId: currentId() };

    // 走回首张：Prev disabled；首张按键不循环。
    walkGuard = 0;
    while (!document.querySelector('#assetViewPrev').disabled && walkGuard++ < rootIds.length) await navStep(-1, 'button');
    const firstState = {
      currentId: currentId(),
      nextDisabled: document.querySelector('#assetViewNext').disabled,
      prevDisabled: document.querySelector('#assetViewPrev').disabled,
    };
    pressKey('ArrowLeft');
    await sleep(400);
    const firstKeyNoop = { currentId: currentId() };

    await recenterToV3();
    // 缩放：主图渲染几何（rect 含 transform scale）。V3 2400×1600 在沙箱舞台 fit < 100%。
    const renderedWidth = () => image().getBoundingClientRect().width;
    await waitFor(() => renderedWidth() > 0 && renderedWidth() < 2400, 'fit applied to the oversized asset');
    const fitWidth = renderedWidth();
    pressKey('+');
    await waitFor(() => renderedWidth() > fitWidth + 1, 'keyboard zoom-in enlarges the render');
    const zoomInWidth = renderedWidth();
    pressKey('-');
    await waitFor(() => renderedWidth() < zoomInWidth - 1, 'keyboard zoom-out shrinks the render');
    await waitFor(() => Math.abs(renderedWidth() - fitWidth) <= 1, 'zoom-out returns toward fit');
    click('#assetZoomFit');
    await waitFor(() => Math.abs(renderedWidth() - fitWidth) <= 0.5, 'fit button restores the fit width');
    const zoom = { fitWidth, zoomInWidth, afterFitWidth: renderedWidth() };

    // 干净路径的返回 + 焦点恢复断言（必须在删除段之前：删除/恢复的后台对账会
    // 与焦点恢复竞态，见下方删除段注释）。
    click('#assetViewBack');
    await waitFor(() => view().hidden === true, 'asset view hidden after back');
    // Focus returns two animation frames after the view hides (scroll is
    // restored first), so wait for it instead of sampling immediately; slower
    // runners (Windows CI) miss that window. A timeout falls through to the
    // assertion below, which reports the real state.
    try {
      await waitFor(() => document.querySelector(cardSelector(selectionMarkedCardId()))?.contains(document.activeElement),
        'focus restored to the last viewed card', 5000);
    } catch {}
    const afterBack = {
      viewHidden: view().hidden,
      selectedCardId: selectedCardId(),
      markedCardId: selectionMarkedCardId(),
      multiSelectedCount: document.querySelectorAll('.asset-card.multi-selected').length,
      focusInMarkedCard: Boolean(document.querySelector(cardSelector(selectionMarkedCardId()))?.contains(document.activeElement)),
    };

    await openViewer(config.v3);

    // 任务 90：右上「删除」→ 确认框 → 自动落下一张 → toast 带撤销 → 撤销后回到这张图。
    // 删除/恢复会让后台对账与 SSE 事件在返回画廊后仍在途（卡片节点会被增量提交
    // 替换），所以本段自己的断言只看查看器内的落点；焦点恢复断言走上面那条干净路径。
    const deletedId = config.v3;
    const nextId = rootIds[v3Position]; // v3 的下一张（0-based 下一项）
    click('#assetViewDelete');
    const confirmDescription = await answerConfirmDialog({ confirm: true });
    await waitFor(() => currentId() === nextId, 'delete auto-advances to the next asset');
    await waitFor(() => Boolean(document.querySelector('#toastContainer .toast.is-visible .toast-action')), 'undo toast with an action button appears');
    const deletedToast = {
      message: (document.querySelector('#toastContainer .toast.is-visible .toast-message')?.textContent || '').trim(),
      actionLabel: (document.querySelector('#toastContainer .toast.is-visible .toast-action')?.textContent || '').trim(),
    };
    document.querySelector('#toastContainer .toast.is-visible .toast-action').click();
    await waitFor(() => currentId() === deletedId, 'undo shows the restored asset again');
    const deleted = { confirmDescription, nextId, deletedToast, afterUndoId: currentId() };

    pressKey('Escape');
    await waitFor(() => view().hidden === true, 'asset view hidden after Escape');
    await waitFor(() => rootCardIds().includes(deletedId), 'restored asset card is back in the gallery');
    const afterEscape = {
      viewHidden: view().hidden,
      selectedCardId: selectedCardId(),
      markedCardId: selectionMarkedCardId(),
      multiSelectedCount: document.querySelectorAll('.asset-card.multi-selected').length,
    };
    await sleep(300);
    return { rootIds, v3Position, opened, removedControls, steps, endState, endKeyNoop, firstState, firstKeyNoop, zoom, deleted, afterBack, afterEscape, rendererErrors };
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

  const v3Position = v3Index + 1;
  const at = (oneBased) => ids[oneBased - 1];
  const opened = result.opened || {};
  if (opened.currentId !== seed.v3) problems.push(`opened shows ${opened.currentId}`);
  if (opened.focusOnBack !== true) problems.push(`focus after open: ${String(opened.focusOnBack)}`);

  const removed = result.removedControls || {};
  for (const [key, expected] of [["positionGone", true], ["zoomBarGone", true], ["scopeGone", true], ["arrowsPresent", true]]) {
    if (removed[key] !== expected) problems.push(`removed-controls ${key}: ${String(removed[key])}`);
  }

  // V3 在序列中点附近，四个翻页步都应发生；键盘步在任何位置都可用（见源码注释）。
  for (const [key, direction] of [["buttonNext", 1], ["buttonPrev", -1], ["keyNext", 1], ["keyPrev", -1]]) {
    const step = result.steps?.[key];
    const expected = key === "buttonNext" ? v3Position < ids.length : key === "buttonPrev" ? v3Position > 1 : true;
    if (!expected) continue;
    if (!step) { problems.push(`${key} did not run`); continue; }
    if (step.toPos !== step.fromPos + direction) problems.push(`${key} moved ${step.fromPos} -> ${step.toPos}`);
    if (step.toId !== at(step.toPos)) problems.push(`${key} shows ${step.toId} at position ${step.toPos}`);
  }

  const endState = result.endState || {};
  if (endState.currentId !== at(ids.length)) problems.push(`end asset ${endState.currentId}`);
  if (endState.nextDisabled !== true) problems.push(`Next enabled at end (disabled=${String(endState.nextDisabled)})`);
  if (endState.prevDisabled !== false) problems.push(`Prev disabled before end (disabled=${String(endState.prevDisabled)})`);
  const endNoop = result.endKeyNoop || {};
  if (endNoop.currentId !== endState.currentId) {
    problems.push(`ArrowRight at end wrapped: ${JSON.stringify(endNoop)}`);
  }

  const firstState = result.firstState || {};
  if (firstState.currentId !== at(1)) problems.push(`first asset ${firstState.currentId}`);
  if (firstState.prevDisabled !== true) problems.push(`Prev enabled at first (disabled=${String(firstState.prevDisabled)})`);
  if (firstState.nextDisabled !== false) problems.push(`Next disabled at first (disabled=${String(firstState.nextDisabled)})`);
  const firstNoop = result.firstKeyNoop || {};
  if (firstNoop.currentId !== firstState.currentId) {
    problems.push(`ArrowLeft at first wrapped: ${JSON.stringify(firstNoop)}`);
  }

  const zoom = result.zoom || {};
  if (!(zoom.fitWidth > 0 && zoom.fitWidth < 2400)) problems.push(`fit width ${zoom.fitWidth} (2400×1600 must fit below natural size)`);
  if (!(zoom.zoomInWidth > zoom.fitWidth)) problems.push(`zoom-in width ${zoom.zoomInWidth} <= fit ${zoom.fitWidth}`);
  if (!(zoom.afterFitWidth <= zoom.fitWidth + 0.5)) problems.push(`after fit width ${zoom.afterFitWidth} != fit ${zoom.fitWidth}`);

  // 任务 90：删除落点 + 撤销回图。
  const deleted = result.deleted || {};
  if (!deleted.confirmDescription) problems.push("delete confirm dialog did not surface a description");
  if (deleted.nextId !== at(v3Position + 1)) problems.push(`delete auto-advance target ${deleted.nextId}, expected ${at(v3Position + 1)}`);
  if (!deleted.deletedToast?.message) problems.push("delete toast message empty");
  if (deleted.deletedToast?.actionLabel !== "撤销") problems.push(`delete toast action label ${JSON.stringify(deleted.deletedToast?.actionLabel)}`);
  if (deleted.afterUndoId !== seed.v3) problems.push(`undo landed on ${deleted.afterUndoId}`);

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
  return { v3Position, zoom };
}

function groupScopeSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    const view = () => document.querySelector('#assetView');
    const image = () => document.querySelector('#assetViewImage');
    const currentId = () => image().dataset.assetId || '';

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
    const opened = { currentId: currentId() };
    click('#assetViewNext');
    await waitFor(() => currentId() === groupIds[1], 'Next reaches the second group asset');
    const second = { currentId: currentId(), nextDisabled: document.querySelector('#assetViewNext').disabled };
    click('#assetViewPrev');
    await waitFor(() => currentId() === groupIds[0], 'Prev returns to the first group asset');
    const backToFirst = { currentId: currentId(), prevDisabled: document.querySelector('#assetViewPrev').disabled };
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
  const second = result?.second || {};
  if (second.currentId !== groupIds?.[1]) problems.push(`Next left group scope: ${second.currentId}`);
  if (second.nextDisabled !== true) problems.push(`Next enabled at group end (disabled=${String(second.nextDisabled)})`);
  const backToFirst = result?.backToFirst || {};
  if (backToFirst.currentId !== groupIds?.[0]) problems.push(`back position ${backToFirst.currentId}`);
  if (backToFirst.prevDisabled !== true) problems.push(`Prev enabled at group start (disabled=${String(backToFirst.prevDisabled)})`);
  if (problems.length) {
    throw new Error(`Asset viewer group scope mismatches (viewTitle=${JSON.stringify(result?.viewTitleText)}): ${problems.join("; ")}`);
  }
  return { openedId: opened.currentId, viewTitleText: result.viewTitleText };
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
  if (problems.length) throw new Error(`Asset viewer load-error phase mismatches: ${problems.join("; ")}`);
  return { errorText: result.errorText };
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
