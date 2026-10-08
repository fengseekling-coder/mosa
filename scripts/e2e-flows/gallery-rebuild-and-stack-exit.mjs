// 任务 61：画廊重建不泄漏观察节点 + 退出堆叠后筛选控件/检视器行为正确的运行时验证。
// 54-3 退出堆叠后类型按钮/分类下拉要恢复快照态且可继续切换；54-5 进出堆叠是
// 导航，不算「用户手动关闭检视器」，之后单击卡片仍自动打开检视器；55-1 反复
// 重建（搜索命中/不命中交替）后画廊仍正常。观察器泄漏量不在页面断言（审查
// 脚本 t-leak.mjs 在页面加载前注入计数），这里锁界面事实 + 接口复查。

import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "gallery-rebuild-and-stack-exit";
export const description = "stack exit restores type/category controls and keeps inspector auto-open on card click; alternating hit/miss searches rebuild the gallery cleanly";

const HIT_TERM = "rebuildprobe";
const MISS_TERM = "zznomatchzz";
const ROOT_CATEGORY = "product";
const STACK_CATEGORY = "concept";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const create = async (fileName, [r, g, b], prompt) => ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: await ctx.makePng(fileName, [r, g, b]),
      prompt,
      category: ROOT_CATEGORY,
    });
    const cover = await create("gr-cover.png", [181, 68, 74], `${HIT_TERM} stack cover`);
    const member = await create("gr-member.png", [74, 127, 181], `${HIT_TERM} stack member`);
    const plainA = await create("gr-plain-a.png", [58, 138, 87], `${HIT_TERM} plain one`);
    const plainB = await create("gr-plain-b.png", [140, 98, 181], `${HIT_TERM} plain two`);
    const stack = await ctx.api(server.origin, "POST", "/api/asset-stacks", {
      projectId: "default",
      assetIds: [cover.asset.id, member.asset.id],
      coverAssetId: cover.asset.id,
    });

    const config = {
      hitTerm: HIT_TERM,
      missTerm: MISS_TERM,
      stackId: stack.stack.id,
      coverId: cover.asset.id,
      memberId: member.asset.id,
      plainId: plainA.asset.id,
      rootCategory: ROOT_CATEGORY,
      stackCategory: STACK_CATEGORY,
    };

    const facts = await ctx.runInPage(server, pageSource(config));
    assertFacts(facts);

    // ===== 接口复查 =====
    // 1) 根视图筛选（图片 + product）下的素材数；root 把非封面成员折叠进堆叠
    //    节点卡，所以页面卡片数 = 命中素材数 - 折叠成员数。
    const filtered = await ctx.api(server.origin, "GET", `/api/assets?project=default&mediaKind=img&category=${ROOT_CATEGORY}&limit=250`);
    if ((filtered.assets || []).length - 1 !== facts.filteredCardCount) {
      throw new Error(`filtered asset count mismatch: api=${(filtered.assets || []).length} (folded=1) page=${facts.filteredCardCount}`);
    }
    // 2) 堆叠成员确实还是 2 个（预置未被界面操作破坏）。
    const stackDetail = await ctx.api(server.origin, "GET", `/api/asset-stacks/${encodeURIComponent(config.stackId)}?project=default`);
    if (Number(stackDetail?.stack?.count) !== 2) {
      throw new Error(`stack member count changed: ${JSON.stringify(stackDetail?.stack)}`);
    }
    // 3) 清空搜索后：卡片 id 集合 == 接口素材 id 集合去掉被折叠的非封面成员。
    const all = await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=250");
    const stackAssets = await ctx.api(server.origin, "GET", `/api/asset-stacks/${encodeURIComponent(config.stackId)}/assets?project=default&limit=250`);
    const coverId = stackDetail?.stack?.cover_asset_id || config.coverId;
    const foldedIds = (stackAssets.assets || []).map((asset) => asset.id).filter((id) => id !== coverId);
    const apiIds = (all.assets || []).map((asset) => asset.id).filter((id) => !foldedIds.includes(id)).sort();
    const pageIds = [...facts.finalCardIds].sort();
    if (JSON.stringify(pageIds) !== JSON.stringify(apiIds)) {
      throw new Error(`card id set mismatch: page=${JSON.stringify(pageIds)} api=${JSON.stringify(apiIds)} folded=${JSON.stringify(foldedIds)}`);
    }
    return {
      cards: pageIds.length,
      hitRounds: facts.hitRounds,
      missRounds: facts.missRounds,
      stackMembers: Number(stackDetail?.stack?.count),
    };
  } finally {
    await server.stop();
  }
}

function assertFacts(facts) {
  const expectations = {
    rootCardsBeforeFilters: 3,
    typeImgPressedAtRoot: true,
    filteredCardCount: 3,
    enteredStack: true,
    typeAllPressedInsideStack: true,
    stackCardsAfterAllFilter: 2,
    typeImgPressedAfterExit: true,
    typeAllNotPressedAfterExit: true,
    categoryAfterExit: ROOT_CATEGORY,
    typeAllSwitchesAfterExit: true,
    cardCountAfterTypeAllSwitch: 3,
    rootInspectorAutoOpened: true,
    enteredStackWithInspectorOpen: true,
    stackMemberInspectorAutoOpened: true,
    backAtRootAfterFinalExit: true,
    delayedFrameSearchSurvives: true,
    hitRounds: 10,
    missRounds: 10,
    missShowsEmptyState: true,
    missShowsNoCards: true,
    finalErrorState: false,
    finalCardCount: 3,
    rendererErrors: 0,
  };
  const problems = Object.entries(expectations)
    .filter(([key, expected]) => facts?.[key] !== expected)
    .map(([key, expected]) => `${key}=${JSON.stringify(facts?.[key])} (expected ${JSON.stringify(expected)})`);
  if (problems.length) throw new Error(`Unexpected page facts: ${problems.join("; ")} — ${JSON.stringify(facts)}`);
}

function pageSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    const facts = { hitRounds: 0, missRounds: 0 };
    const assert = (ok, label) => { if (!ok) throw new Error('gallery-rebuild-and-stack-exit: ' + label + ' diagnostic=' + JSON.stringify(pageDiagnostic())); };
    const typeState = (value) => {
      const button = document.querySelector('.topbar-type-filters [data-type="' + value + '"]');
      return { pressed: button?.getAttribute('aria-pressed') === 'true', active: button?.classList.contains('active') || false };
    };
    const categoryValue = () => document.querySelector('#categorySelect')?.value ?? '';
    const stackNode = () => document.querySelector('#assetGrid > .asset-card.is-stack[data-stack-id="' + CSS.escape(config.stackId) + '"]');

    await waitFor(() => gallerySettled() && rootCardIds().length === 3, 'three root cards (stack node + two plain)');
    facts.rootCardsBeforeFilters = rootCardIds().length;

    // ===== 根视图：图片类型 + product 分类 =====
    click('.topbar-type-filters [data-type="img"]');
    await waitFor(() => typeState('img').pressed && typeState('img').active && gallerySettled(), 'img type pressed at root');
    facts.typeImgPressedAtRoot = typeState('img').pressed;
    setValue('#categorySelect', config.rootCategory);
    await waitFor(() => gallerySettled() && rootCardIds().length === 3 && categoryValue() === config.rootCategory, 'category filter keeps every card');
    facts.filteredCardCount = rootCardIds().length;

    // ===== 双击进入堆叠 =====
    await waitFor(() => Boolean(stackNode()), 'stack node visible');
    stackNode().querySelector('.asset-card-select')
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    await waitFor(() => !document.querySelector('#stackBack')?.hidden && gallerySettled(), 'entered stack view');
    facts.enteredStack = true;

    // ===== 堆叠内：切「全部」、换分类 =====
    click('.topbar-type-filters [data-type="all"]');
    await waitFor(() => typeState('all').pressed && typeState('all').active && gallerySettled(), 'all type pressed inside stack');
    facts.typeAllPressedInsideStack = typeState('all').pressed;
    facts.stackCardsAfterAllFilter = rootCardIds().length;
    // 这里等堆叠内请求落定再返回，让 54-3 的断言只看快照恢复；请求还在飞行中
    // 就返回的情形由下面的「快速返回」一步单独覆盖。
    setValue('#categorySelect', config.stackCategory);
    await waitFor(() => gallerySettled() && categoryValue() === config.stackCategory && rootCardIds().length === 0, 'stack category filters the members out');

    // ===== 返回退出堆叠：控件恢复快照态（54-3） =====
    click('#stackBack');
    await waitFor(() => document.querySelector('#stackBack')?.hidden === true && gallerySettled(), 'exited stack view');
    facts.typeImgPressedAfterExit = typeState('img').pressed;
    facts.typeAllNotPressedAfterExit = !typeState('all').pressed;
    facts.categoryAfterExit = categoryValue();
    assert(facts.typeImgPressedAfterExit, 'img button must be pressed again after stack exit');
    assert(facts.categoryAfterExit === config.rootCategory, 'category select must show the pre-enter value');
    // 按钮没有失步：高亮「图片」时点「全部」要能切过去（handler 早退即卡死）。
    click('.topbar-type-filters [data-type="all"]');
    await waitFor(() => typeState('all').pressed && gallerySettled() && rootCardIds().length === 3, 'type all switches after exit');
    facts.typeAllSwitchesAfterExit = typeState('all').pressed;
    facts.cardCountAfterTypeAllSwitch = rootCardIds().length;

    // ===== 退出堆叠后单击卡片自动打开检视器（54-5） =====
    const plainCard = document.querySelector(cardSelector(config.plainId) + ' .asset-card-select');
    assert(Boolean(plainCard), 'plain card present after exit');
    plainCard.click();
    await waitFor(() => document.body.classList.contains('detail-open'), 'inspector auto-opens on plain card click');
    facts.rootInspectorAutoOpened = true;

    // ===== 检视器开着时双击进堆叠（导航关闭），单击成员卡自动打开 =====
    await waitFor(() => Boolean(stackNode()), 'stack node visible again');
    stackNode().querySelector('.asset-card-select')
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    await waitFor(() => !document.querySelector('#stackBack')?.hidden && gallerySettled(), 'entered stack with inspector open');
    facts.enteredStackWithInspectorOpen = true;
    const memberCard = document.querySelector(cardSelector(config.memberId) + ' .asset-card-select');
    assert(Boolean(memberCard), 'stack member card visible inside stack');
    memberCard.click();
    await waitFor(() => document.body.classList.contains('detail-open'), 'inspector auto-opens on member card click');
    facts.stackMemberInspectorAutoOpened = true;

    // ===== 再退出，回到根视图做重建循环 =====
    click('#stackBack');
    await waitFor(() => document.querySelector('#stackBack')?.hidden === true && gallerySettled() && rootCardIds().length === 3, 'back at root for rebuild loop');
    facts.backAtRootAfterFinalExit = true;

    // ===== 快速返回：堆叠内改筛选的请求还没返回就退出，画廊不能卡在加载中 =====
    await waitFor(() => Boolean(stackNode()), 'stack node visible for quick exit');
    stackNode().querySelector('.asset-card-select')
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    await waitFor(() => !document.querySelector('#stackBack')?.hidden && gallerySettled(), 'entered stack for quick exit');
    setValue('#categorySelect', config.stackCategory);
    click('#stackBack');
    await waitFor(() => document.querySelector('#stackBack')?.hidden === true && gallerySettled() && rootCardIds().length === 3, 'quick exit with an in-flight stack request settles');
    facts.quickExitSettled = true;

    // ===== 任务 95：退出堆叠的选中恢复不得放进延迟帧改写 selectedId =====
    // Windows 隐藏窗口把 rAF 攒到任意后续帧批量执行。若 exitStack 把
    // state.selectedId 的恢复留在 rAF 里，它会落在搜索 intent 的创建（input
    // 事件）与校验（防抖回调）之间：isNavigationIntentCurrent 的 selectedId
    // 比对失配，刚输入的搜索被静默丢弃，画廊停在旧结果且不忙。这里冻结
    // rAF，再进出堆叠一次制造退出尾巴，并把积压帧精准注入到不命中搜索的
    // 防抖窗口中点——空态必须照常渲染。
    const stackedRafs = [];
    const realRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => { stackedRafs.push(callback); return stackedRafs.length; };
    const flushStackedRafs = () => { for (const callback of stackedRafs.splice(0)) callback(Date.now()); };
    stackNode().querySelector('.asset-card-select')
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    await waitFor(() => !document.querySelector('#stackBack')?.hidden && gallerySettled(), 'entered stack for delayed-frame probe');
    click('#stackBack');
    await waitFor(() => document.querySelector('#stackBack')?.hidden === true && gallerySettled() && rootCardIds().length === 3, 'exited stack for delayed-frame probe');
    setValue('#searchInput', config.missTerm);
    await sleep(90);
    flushStackedRafs();
    await waitFor(() => gallerySettled() && rootCardIds().length === 0
      && Boolean(document.querySelector('#assetGrid .gallery-empty-state')), 'miss search survives a delayed stack-exit frame');
    facts.delayedFrameSearchSurvives = true;
    window.requestAnimationFrame = realRequestAnimationFrame;
    flushStackedRafs();
    setValue('#searchInput', config.hitTerm);
    await waitFor(() => gallerySettled() && rootCardIds().length === 4, 'hit search works after delayed-frame probe');

    // ===== 反复重建：命中/不命中交替各 10 次（55-1） =====
    for (let round = 0; round < 10; round += 1) {
      setValue('#searchInput', config.hitTerm);
      // 任务 83：搜索平铺——命中词让堆叠两成员（含封面）各自成卡，4 张全部
      // 出现，且任何一行都不渲染成堆叠节点或带角标。
      await waitFor(() => gallerySettled() && rootCardIds().length === 4
        && !document.querySelector('#assetGrid > .asset-card.is-stack')
        && !document.querySelector('#assetGrid .asset-stack-count'),
      'hit search shows all cards flat without stack chrome (round ' + round + ')');
      facts.hitRounds += 1;
      setValue('#searchInput', config.missTerm);
      await waitFor(() => gallerySettled() && rootCardIds().length === 0
        && Boolean(document.querySelector('#assetGrid .gallery-empty-state')), 'miss search shows empty state (round ' + round + ')');
      facts.missRounds += 1;
    }
    facts.missShowsEmptyState = facts.missRounds === 10;
    facts.missShowsNoCards = true;
    setValue('#searchInput', '');
    await waitFor(() => gallerySettled() && rootCardIds().length === 3, 'cleared search restores the full gallery');
    facts.finalCardIds = rootCardIds();
    facts.finalCardCount = facts.finalCardIds.length;
    facts.finalErrorState = Boolean(document.querySelector('#assetGrid .error-state'));
    facts.rendererErrors = rendererErrors.length;
    assert(facts.rendererErrors === 0, 'no renderer errors during rebuild loop');
    return facts;
  })()`;
}
