// 任务 111：右键即选中。右键一张不在当前多选里的普通素材 = 先左键选中它再弹
// 菜单——走 selectAsset 同一条路，检视器同时换成这张；已经在多选里的图右键仍
// 对整组操作、检视器不动；检视器有未保存修改（manual-save 草稿）时，右键换图
// 弹同一个「放弃未保存的修改？」确认，取消则不换选中、不弹菜单。
//
// 摸底清单（web/app/context-menu-bindings.mjs + app.mjs selectAsset）：
// - 右键不在多选里的素材：await selectAsset(id)（与左键同路：confirmDetailNavigation
//   → 换 state.selectedId → 开检视器），成功后 gallerySelection.replaceWith(id)
//   保持「右键对象进多选、菜单针对它」的既有口径。selectAsset 因用户取消而没换
//   选中时（state.selectedId !== id）直接 return，不弹菜单。
// - 堆叠节点（根视图带 stack.id 的封面）同一条规则：右键没选中的封面 = 先左键
//   选中它（selectGalleryNode → selectStackNode），检视器换成堆叠检视器
//   （#detailPanel [data-stack-inspector]），菜单是堆叠菜单。
// - 检视器标题：#detailTitle 的 textContent 是完整文件名（任务 110 注释明说 e2e 读它）。
// - 未保存修改用「标签编辑器」制造：点 +添加标签 → 输入即标
//   data-detail-dirty=true / scope=tags（manual-save 语义，confirmDetailNavigation 拦）。
// - 菜单关闭：菜单打开期间键盘归菜单（捕获阶段 stopPropagation），一次 Escape
//   只关菜单不动选区——比合成 document click 更不旁生枝节。
// - 文案断言依赖中文界面：e2e-web-driver 启动时把 mosa.ui-language 钉成 zh。

import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "context-menu-select";
export const description = "right-click selects: viewer follows a right-clicked card outside the multi-selection (same path as a left click, stack covers included), in-selection right-click keeps the group + viewer, dirty inspector asks 放弃未保存的修改 and cancel shows no menu";

export async function run(ctx) {
  await ctx.prepare();
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // 检视器标题是入库后的文件名（create 会加随机段），断言按名词干匹配。
  const config = {
    nameA: `rcm-a-${stamp}`,
    nameB: `rcm-b-${stamp}`,
    nameC: `rcm-c-${stamp}`,
  };
  const server = await ctx.startServer();
  let ids;
  try {
    const create = async (fileName, [r, g, b]) => {
      const payload = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default", imagePath: await ctx.makePng(`${fileName}.png`, [r, g, b]),
      });
      if (!payload?.asset?.id) throw new Error(`asset seed returned no id for ${fileName}`);
      return payload.asset.id;
    };
    // 倒序创建让 A 最旧、C 最新（画廊默认最新在前，顺序本身不作断言）。
    const idC = await create(config.nameC, [58, 138, 87]);
    const idB = await create(config.nameB, [181, 68, 74]);
    const idA = await create(config.nameA, [74, 127, 181]);
    // 堆叠封面 D（成员 D、E）：根视图里多一张带角标的卡片。
    const idE = await create(`rcm-e-${stamp}`, [120, 90, 160]);
    const idD = await create(`rcm-d-${stamp}`, [200, 160, 60]);
    const stack = await ctx.api(server.origin, "POST", "/api/asset-stacks", { projectId: "default", assetIds: [idD, idE], coverAssetId: idD });
    if (!stack?.stack?.id) throw new Error(`stack seed returned no id: ${JSON.stringify(stack)}`);
    ids = { idA, idB, idC, idD, idE };

    const result = await ctx.runInPage(server, source({ idA, idB, idC, idD, stackId: stack.stack.id, nameA: config.nameA, nameB: config.nameB, nameC: config.nameC }));
    assertCondition(result.ready === true, `gallery never showed the four cards: ${JSON.stringify(result)}`);

    // S1 选中 A → 右键 B：检视器换 B，只有 B 在选区里。
    assertCondition(result.s1?.menuItems > 0, `the right-click menu never opened for B: ${JSON.stringify(result.s1)}`);
    assertCondition(result.s1?.viewerIsB === true, `the inspector did not switch to B on right-click: ${JSON.stringify(result.s1)}`);
    assertCondition(result.s1?.bMulti === true && result.s1?.aSelected === false && result.s1?.aMulti === false,
      `right-click B left the wrong selection state: ${JSON.stringify(result.s1)}`);

    // S2 多选 A、B → 右键 A：整组保持选中，检视器不动。
    assertCondition(result.s2?.aMulti === true && result.s2?.bMulti === true,
      `the A+B selection broke after right-clicking A: ${JSON.stringify(result.s2)}`);
    assertCondition(result.s2?.viewerStillB === true, `the inspector moved off B when right-clicking a selected card: ${JSON.stringify(result.s2)}`);

    // S3 未保存修改：右键先弹「放弃未保存的修改？」；取消 → 不换选中、不弹菜单。
    assertCondition(result.s3?.discardTitle === "放弃未保存的修改？", `the dirty-inspector right-click asked ${JSON.stringify(result.s3?.discardTitle)}`);
    assertCondition(result.s3?.afterCancel?.menuNeverOpened === true, `a menu opened after cancelling the discard dialog: ${JSON.stringify(result.s3?.afterCancel)}`);
    assertCondition(result.s3?.afterCancel?.viewerStillC === true, `the inspector moved off C although the discard was cancelled: ${JSON.stringify(result.s3?.afterCancel)}`);
    assertCondition(result.s3?.afterCancel?.cSelected === true && result.s3?.afterCancel?.bNotSelected === true,
      `cancelling the discard changed the selection: ${JSON.stringify(result.s3?.afterCancel)}`);
    assertCondition(result.s3?.afterDiscard?.viewerIsB === true && result.s3?.afterDiscard?.bMulti === true,
      `discarding did not move selection + viewer to B: ${JSON.stringify(result.s3?.afterDiscard)}`);

    // S4 选中 A → 右键没选中的堆叠封面：检视器换成这个堆叠，只有封面在选区里，菜单是堆叠菜单。
    assertCondition(result.s4?.stackInspector === true, `the inspector did not switch to the stack on right-click: ${JSON.stringify(result.s4)}`);
    assertCondition(result.s4?.dMulti === true && result.s4?.aSelected === false && result.s4?.aMulti === false,
      `right-clicking the stack cover left the wrong selection state: ${JSON.stringify(result.s4)}`);
    assertCondition(result.s4?.menuHasOpenStack === true, `the stack cover did not get the stack menu: ${JSON.stringify(result.s4)}`);
  } finally {
    await server.stop();
  }
}

function source(seeded) {
  return `(async () => {
    const config = ${JSON.stringify(seeded)};
    ${PAGE_HELPERS}
    const cardOf = (id) => document.querySelector('.asset-card[data-id="' + CSS.escape(id) + '"]');
    const menuVisible = () => Boolean(document.querySelector('.context-menu'));
    const inspectorTitle = () => document.querySelector('#detailTitle')?.textContent || '';
    const rightClick = (id) => cardOf(id).querySelector('.asset-card-select')
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
    const closeMenu = async () => {
      await sleep(80);
      document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
      await waitFor(() => !menuVisible(), 'the context menu closes on Escape');
    };

    await waitFor(() => gallerySettled() && rootCardIds().length === 4, 'four root cards ready', 20000);

    // S1 选中 A → 右键 B。
    cardOf(config.idA).querySelector('.asset-card-select').click();
    await waitFor(() => inspectorTitle().includes(config.nameA), 'the inspector shows A after the left click');
    await waitFor(() => cardOf(config.idA)?.classList.contains('selected') === true, 'A is detail-selected');
    rightClick(config.idB);
    await waitFor(() => menuVisible() && document.querySelectorAll('.context-menu-item').length > 0, 'the menu opens for B');
    await waitFor(() => {
      const bMulti = cardOf(config.idB)?.classList.contains('multi-selected') === true;
      const aSelected = cardOf(config.idA)?.classList.contains('selected') === true;
      const aMulti = cardOf(config.idA)?.classList.contains('multi-selected') === true;
      return (bMulti && !aSelected && !aMulti && inspectorTitle().includes(config.nameB))
        ? { menuItems: document.querySelectorAll('.context-menu-item').length, bMulti, aSelected, aMulti, viewerIsB: true }
        : null;
    }, 'right-click B selects B and switches the inspector to B');
    const s1 = {
      menuItems: document.querySelectorAll('.context-menu-item').length,
      bMulti: cardOf(config.idB)?.classList.contains('multi-selected') === true,
      aSelected: cardOf(config.idA)?.classList.contains('selected') === true,
      aMulti: cardOf(config.idA)?.classList.contains('multi-selected') === true,
      viewerIsB: inspectorTitle().includes(config.nameB),
    };
    await closeMenu();

    // S2 多选 A、B → 右键 A。
    cardOf(config.idA).querySelector('.asset-card-select')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    await waitFor(() => cardOf(config.idA)?.classList.contains('multi-selected') === true
      && cardOf(config.idB)?.classList.contains('multi-selected') === true, 'A and B are both multi-selected');
    const titleBefore = inspectorTitle();
    rightClick(config.idA);
    await waitFor(() => menuVisible(), 'the menu opens for the A+B group');
    const s2 = {
      aMulti: cardOf(config.idA)?.classList.contains('multi-selected') === true,
      bMulti: cardOf(config.idB)?.classList.contains('multi-selected') === true,
      viewerStillB: inspectorTitle() === titleBefore && inspectorTitle().includes(config.nameB),
    };
    await closeMenu();

    // S3 未保存修改：左键 C → 标签草稿 → 右键 B 弹「放弃未保存的修改？」。
    cardOf(config.idC).querySelector('.asset-card-select').click();
    await waitFor(() => inspectorTitle().includes(config.nameC), 'the inspector shows C');
    document.querySelector('#detailPanel [data-inspector-section="tags"] [data-action="add-tag"]').click();
    await waitFor(() => Boolean(document.querySelector('#detailPanel [data-tag-editor] input')), 'the tag editor opens');
    setValue('#detailPanel [data-tag-editor] input', '右键草稿');
    await waitFor(() => Boolean(document.querySelector('#detailPanel [data-detail-dirty="true"]')), 'the tag draft marks the inspector dirty');

    rightClick(config.idB);
    await waitFor(() => document.querySelector('#confirmDialog')?.classList.contains('open') === true, 'the discard dialog opens on the dirty right-click');
    const discardTitle = document.querySelector('#confirmDialogTitle')?.textContent || '';
    document.querySelector('#confirmDialogCancel').click();
    await waitFor(() => document.querySelector('#confirmDialog')?.classList.contains('open') !== true, 'the discard dialog closes on cancel');
    await sleep(120);
    const afterCancel = {
      menuNeverOpened: !menuVisible(),
      viewerStillC: inspectorTitle().includes(config.nameC),
      bNotSelected: !cardOf(config.idB)?.classList.contains('multi-selected') && !cardOf(config.idB)?.classList.contains('selected'),
      cSelected: cardOf(config.idC)?.classList.contains('selected') === true,
    };

    rightClick(config.idB);
    await waitFor(() => document.querySelector('#confirmDialog')?.classList.contains('open') === true, 'the discard dialog opens again');
    document.querySelector('#confirmDialogConfirm').click();
    await waitFor(() => menuVisible() && document.querySelectorAll('.context-menu-item').length > 0, 'the menu opens after discarding the draft');
    const afterDiscard = {
      viewerIsB: inspectorTitle().includes(config.nameB) && !inspectorTitle().includes(config.nameC),
      bMulti: cardOf(config.idB)?.classList.contains('multi-selected') === true,
    };
    await closeMenu();

    // S4 选中 A → 右键没选中的堆叠封面 D。
    cardOf(config.idA).querySelector('.asset-card-select').click();
    await waitFor(() => inspectorTitle().includes(config.nameA) && cardOf(config.idA)?.classList.contains('selected') === true, 'the inspector is back on A before the stack right-click');
    const stackInspectorId = () => document.querySelector('#detailPanel [data-stack-inspector]')?.dataset.stackId || '';
    rightClick(config.idD);
    await waitFor(() => menuVisible() && document.querySelectorAll('.context-menu-item').length > 0, 'the menu opens for the stack cover');
    await waitFor(() => stackInspectorId() === config.stackId, 'the inspector switches to the right-clicked stack');
    const s4 = {
      stackInspector: stackInspectorId() === config.stackId,
      dMulti: cardOf(config.idD)?.classList.contains('multi-selected') === true,
      aSelected: cardOf(config.idA)?.classList.contains('selected') === true,
      aMulti: cardOf(config.idA)?.classList.contains('multi-selected') === true,
      menuHasOpenStack: [...document.querySelectorAll('.context-menu-item')].some((item) => item.textContent.includes('打开堆叠')),
    };
    await closeMenu();

    return { ready: true, s1, s2, s3: { discardTitle, afterCancel, afterDiscard }, s4 };
  })()`;
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}
