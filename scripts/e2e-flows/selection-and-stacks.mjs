// Pluggable e2e flow: gallery multi-selection (Ctrl/Cmd toggle, Shift range,
// pointer marquee, Cmd/Ctrl+A, selection bar), batch favorite / move-to-group
// through the multi-selection context menu, then the full Stack lifecycle
// (selection-bar stacking, rename modal with empty-name rejection, enter /
// remove member / return, restart persistence, dissolve with released-count
// toast). Seed via API, assert on returned page facts in Node, audit every
// mutation through the API, and restart the server on the same library before
// dissolving so the stack rename and membership are proven to persist.

import { existsSync } from "node:fs";
import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "selection-and-stacks";
export const description =
  "selection: ctrl-toggle/shift-range/marquee/select-all/clear -> batch favorite+move-to-group -> stack create/rename/empty-name/open/remove/return -> restart -> dissolve -> API audit";

// Menu labels verified against web/app/i18n.mjs (zh is the default locale):
// addToFavorites=添加到收藏, moveToGroup=移动到分组, openStack=打开堆叠,
// renameStack=重命名堆叠, dissolveStack=解散堆叠.
const MENU = {
  favorite: "添加到收藏",
  moveToGroup: "移动到分组",
  openStack: "打开堆叠",
  renameStack: "重命名堆叠",
  dissolveStack: "解散堆叠",
};

// In-page helpers specific to this flow, interpolated after PAGE_HELPERS.
const SELECTION_HELPERS = String.raw`
  // Gallery multi-selection marks cards with .multi-selected; .selected is
  // reserved for the single detail selection (cardSelectionFlags in
  // gallery-selection.mjs), so no card may carry .selected while a
  // multi-selection is active.
  const selectedCardIds = () => [...document.querySelectorAll('.asset-card.multi-selected')].map((card) => card.dataset.id).sort();
  const detailSelectedId = () => document.querySelector('.asset-card.selected')?.dataset.id || '';
  const selectionCountText = () => document.querySelector('#selectionCount')?.textContent || '';
  const selectionBarVisible = () => !document.querySelector('#selectionBar')?.hidden;
  const allToastTexts = () => [...document.querySelectorAll('.toast-message')].map((node) => node.textContent || '');
  const stackNodeSelector = (stackId) => '#assetGrid > .asset-card.is-stack[data-stack-id="' + CSS.escape(stackId) + '"]';
  const stackNodeTitle = (stackId) => document.querySelector(stackNodeSelector(stackId) + ' .asset-card-title')?.textContent || '';
  const stackNodeCount = (stackId) => document.querySelector(stackNodeSelector(stackId) + ' .asset-stack-count')?.textContent || '';
  // Ctrl/Cmd+click toggles a card into the multi-selection (handleCardClick in
  // gallery-selection.mjs tests metaKey || ctrlKey); both modifiers are set so
  // the gesture is platform-independent.
  function ctrlClickCard(assetId) {
    const target = document.querySelector(cardSelector(assetId) + ' .asset-card-select');
    if (!target) throw new Error('Missing card select for ' + assetId);
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true, metaKey: true }));
  }
  // Plain Shift+click replaces the current selection with the anchor->target
  // range (selectRange with additive=false; the anchor is the last toggled
  // card), so Ctrl S1 -> Ctrl S3 -> Shift S5 yields exactly {S3,S4,S5}.
  function shiftClickCard(assetId) {
    const target = document.querySelector(cardSelector(assetId) + ' .asset-card-select');
    if (!target) throw new Error('Missing card select for ' + assetId);
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
  }
  // Cmd/Ctrl+A is owned by the gallery keyboard router in app.mjs (document
  // keydown); the event target must not be a form field, so dispatch on
  // document itself.
  function selectAllKeyboard() {
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'a', metaKey: true, ctrlKey: true }));
  }
  // Pointer-event marquee (gallery-selection.mjs): pointerdown in the gallery,
  // one pointermove past the 3px drag threshold, then pointerup (endPointer
  // applies the final rectangle synchronously). shiftKey makes the gesture
  // additive so several marquees can accumulate a selection.
  async function marqueeSelect(fromX, fromY, toX, toY, { shiftKey = false } = {}) {
    const grid = document.querySelector('#assetGrid');
    if (!grid) throw new Error('Missing #assetGrid');
    const init = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: fromX, clientY: fromY, shiftKey };
    grid.dispatchEvent(new PointerEvent('pointerdown', init));
    window.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: toX, clientY: toY }));
    await sleep(90);
    window.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, clientX: toX, clientY: toY }));
    await sleep(40);
  }
  const cardRect = (assetId) => {
    const card = document.querySelector(cardSelector(assetId));
    if (!card) throw new Error('Missing card for ' + assetId);
    return card.getBoundingClientRect();
  };
  const rectsIntersect = (a, b) => a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
  // Frames the given cards with the shipped marquee: one rectangle when the
  // layout allows framing exactly the targets, otherwise a non-additive
  // marquee for the first target plus shift-additive marquees for the rest.
  // Either way the assertion is the resulting selection set.
  async function marqueeFrameExactly(targetIds) {
    const targets = targetIds.map((id) => ({ id, rect: cardRect(id) }));
    const allIds = rootCardIds();
    const inset = 3;
    const framedBy = (rect) => allIds.filter((id) => rectsIntersect(rect, cardRect(id)));
    const union = {
      left: Math.min(...targets.map((entry) => entry.rect.left)) + inset,
      right: Math.max(...targets.map((entry) => entry.rect.right)) - inset,
      top: Math.min(...targets.map((entry) => entry.rect.top)) + inset,
      bottom: Math.max(...targets.map((entry) => entry.rect.bottom)) - inset,
    };
    if (JSON.stringify(framedBy(union).sort()) === JSON.stringify([...targetIds].sort())) {
      await marqueeSelect(union.left, union.top, union.right, union.bottom);
      return 'single-rect';
    }
    for (const [index, entry] of targets.entries()) {
      await marqueeSelect(entry.rect.left + inset, entry.rect.top + inset, entry.rect.right - inset, entry.rect.bottom - inset, { shiftKey: index > 0 });
    }
    return 'additive-rects';
  }
  // Walks an open context menu down the labels array (parent items hover-open
  // their submenu, the last label is clicked). Exact .context-menu-label
  // matching so group/stack names never prefix-match each other.
  async function findMenuItem(label, parentLabel) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const items = [...document.querySelectorAll('.context-menu-item')];
      const match = items.find((entry) => !entry.disabled && entry.querySelector('.context-menu-label')?.textContent === label);
      if (match) return match;
      const parent = items.find((entry) => entry.querySelector('.context-menu-label')?.textContent === parentLabel);
      if (parent) parent.dispatchEvent(new MouseEvent('mouseenter'));
      await sleep(100);
    }
    throw new Error('Timed out waiting for menu item ' + label + ' diagnostic=' + JSON.stringify(pageDiagnostic()));
  }
  async function rightClickChoose(triggerSelector, labels) {
    let item = await openContextMenu(triggerSelector, labels[0]);
    for (let index = 1; index < labels.length; index += 1) {
      item.dispatchEvent(new MouseEvent('mouseenter'));
      item = await findMenuItem(labels[index], labels[index - 1]);
    }
    item.click();
  }
`;

function source(config, body) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    const MENU = ${JSON.stringify(MENU)};
    ${PAGE_HELPERS}
    ${SELECTION_HELPERS}
    ${body}
  })()`;
}

function expect(condition, message) {
  if (!condition) throw new Error(`selection-and-stacks: ${message}`);
}

const sameMembers = (actual, expected) => JSON.stringify([...(actual || [])].sort()) === JSON.stringify([...expected].sort());

export async function run(ctx) {
  await ctx.prepare();
  let ids;
  let imagePaths;
  const first = await ctx.startServer();
  try {
    // ===== Seed via API: S1-S6 ungrouped + group S-Target =====
    const seedAsset = async (fileName, [r, g, b], prompt) => {
      const imagePath = await ctx.makePng(fileName, [r, g, b]);
      const response = await ctx.api(first.origin, "POST", "/api/assets/create", { projectId: "default", imagePath, prompt });
      return { id: response.asset.id, imagePath: response.asset.image_path };
    };
    const s1 = await seedAsset("selection-s1.png", [220, 68, 74], "selection flow S1");
    const s2 = await seedAsset("selection-s2.png", [74, 181, 92], "selection flow S2");
    const s3 = await seedAsset("selection-s3.png", [240, 180, 40], "selection flow S3");
    const s4 = await seedAsset("selection-s4.png", [108, 92, 231], "selection flow S4");
    const s5 = await seedAsset("selection-s5.png", [58, 138, 87], "selection flow S5");
    const s6 = await seedAsset("selection-s6.png", [138, 90, 47], "selection flow S6");
    await ctx.api(first.origin, "POST", "/api/groups", { projectId: "default", name: "S-Target" });
    ids = { s1: s1.id, s2: s2.id, s3: s3.id, s4: s4.id, s5: s5.id, s6: s6.id, groupName: "S-Target", stackName: "S-Stack" };
    imagePaths = { s3: s3.imagePath, s4: s4.imagePath };

    // ===== Page 1: ctrl toggle + shift range + select-all + clear =====
    const p1 = await ctx.runInPage(first, source(ids, `
      await waitFor(() => gallerySettled() && rootCardIds().length === 6, 'six seeded cards');
      ctrlClickCard(config.s1);
      await waitFor(() => JSON.stringify(selectedCardIds()) === JSON.stringify([config.s1]), 'S1 selected');
      ctrlClickCard(config.s3);
      await waitFor(() => JSON.stringify(selectedCardIds()) === JSON.stringify([config.s1, config.s3].sort()), 'S1+S3 selected');
      shiftClickCard(config.s5);
      await waitFor(() => JSON.stringify(selectedCardIds()) === JSON.stringify([config.s3, config.s4, config.s5].sort()), 'range S3..S5 selected');
      const multiSelected = selectedCardIds();
      const barVisibleAfterMulti = selectionBarVisible();
      const countTextAfterMulti = selectionCountText();
      const detailSelectionDuringMulti = detailSelectedId();
      selectAllKeyboard();
      await waitFor(() => selectionBarVisible() && selectedCardIds().length === 6, 'Cmd/Ctrl+A selects all six');
      const countTextAfterSelectAll = selectionCountText();
      click('#selectionClear');
      await waitFor(() => !selectionBarVisible() && selectedCardIds().length === 0, 'selection bar clears');
      return { multiSelected, barVisibleAfterMulti, countTextAfterMulti, detailSelectionDuringMulti, countTextAfterSelectAll };
    `));
    expect(sameMembers(p1.multiSelected, [ids.s3, ids.s4, ids.s5]), `P1 shift-range selection: ${JSON.stringify(p1.multiSelected)}`);
    expect(p1.barVisibleAfterMulti === true, `P1 selection bar visible: ${p1.barVisibleAfterMulti}`);
    expect(p1.countTextAfterMulti === "已选 3 项", `P1 selection count text: ${p1.countTextAfterMulti}`);
    // 任务单写的是 .selected，但 shipped 代码里多选卡片带 .multi-selected，
    // .selected 只用于详情单选（gallery-selection.mjs cardSelectionFlags）。
    expect(p1.detailSelectionDuringMulti === "", `P1 no .selected card during multi-select: ${p1.detailSelectionDuringMulti}`);
    expect(p1.countTextAfterSelectAll === "已选 6 项", `P1 select-all count text: ${p1.countTextAfterSelectAll}`);

    // ===== Page 2: marquee frames exactly S2+S4 =====
    const p2 = await ctx.runInPage(first, source(ids, `
      await waitFor(() => gallerySettled() && rootCardIds().length === 6, 'gallery before marquee');
      await sleep(150);
      const marqueeStrategy = await marqueeFrameExactly([config.s2, config.s4]);
      await waitFor(() => gallerySettled() && JSON.stringify(selectedCardIds()) === JSON.stringify([config.s2, config.s4].sort()), 'marquee selects exactly S2+S4');
      return { marqueeStrategy, selected: selectedCardIds(), barVisible: selectionBarVisible(), countText: selectionCountText() };
    `));
    expect(sameMembers(p2.selected, [ids.s2, ids.s4]), `P2 marquee selection: ${JSON.stringify(p2.selected)}`);
    expect(p2.barVisible === true && p2.countText === "已选 2 项", `P2 marquee bar/count: ${p2.barVisible} ${p2.countText}`);

    // ===== Page 3: batch favorite + move to group via the multi-selection menu =====
    const p3 = await ctx.runInPage(first, source(ids, `
      await waitFor(() => gallerySettled() && rootCardIds().length === 6, 'gallery before batch actions');
      ctrlClickCard(config.s1);
      await waitFor(() => selectedCardIds().length === 1, 'S1 selected for batch');
      ctrlClickCard(config.s2);
      await waitFor(() => JSON.stringify(selectedCardIds()) === JSON.stringify([config.s1, config.s2].sort()), 'S1+S2 selected for batch');
      await rightClickChoose(cardSelector(config.s1), [MENU.favorite]);
      await waitFor(() => allToastTexts().some((text) => text.includes('收藏状态已更新')), 'batch favorite toast');
      await rightClickChoose(cardSelector(config.s1), [MENU.moveToGroup, config.groupName]);
      await waitFor(() => allToastTexts().some((text) => text.includes('已移动到分组')), 'batch move-to-group toast');
      return { selectionAfterBatch: selectedCardIds() };
    `));
    expect(sameMembers(p3.selectionAfterBatch, [ids.s1, ids.s2]), `P3 selection survives batch actions: ${JSON.stringify(p3.selectionAfterBatch)}`);
    const listed = (await ctx.api(first.origin, "GET", "/api/assets?project=default&limit=250")).assets || [];
    const byId = new Map(listed.map((asset) => [asset.id, asset]));
    expect(byId.get(ids.s1)?.favorite === true && byId.get(ids.s2)?.favorite === true, `audit favorite S1/S2: ${JSON.stringify([byId.get(ids.s1)?.favorite, byId.get(ids.s2)?.favorite])}`);
    expect(byId.get(ids.s1)?.group === "S-Target" && byId.get(ids.s2)?.group === "S-Target", `audit group S1/S2: ${JSON.stringify([byId.get(ids.s1)?.group, byId.get(ids.s2)?.group])}`);
    expect([ids.s3, ids.s4, ids.s5, ids.s6].every((id) => byId.get(id)?.favorite === false && byId.get(id)?.group === ""), "audit S3-S6 untouched by the batch");

    // ===== Page 4: stack S3+S4+S5 from the selection bar =====
    const p4 = await ctx.runInPage(first, source(ids, `
      await waitFor(() => gallerySettled() && rootCardIds().length === 6, 'root gallery before stacking');
      ctrlClickCard(config.s3);
      await waitFor(() => selectedCardIds().length === 1, 'S3 selected for stack');
      ctrlClickCard(config.s4);
      await waitFor(() => selectedCardIds().length === 2, 'S3+S4 selected for stack');
      ctrlClickCard(config.s5);
      await waitFor(() => JSON.stringify(selectedCardIds()) === JSON.stringify([config.s3, config.s4, config.s5].sort()), 'S3+S4+S5 selected for stack');
      const rootCountBeforeStack = rootCardIds().length;
      click('#selectionStack');
      const stackCard = await waitFor(() => document.querySelector('#assetGrid > .asset-card.is-stack'), 'Stack node appears');
      const stackId = stackCard.dataset.stackId;
      await waitFor(() => gallerySettled() && rootCardIds().length === 4, 'root loses two cards (3 members -> 1 node)');
      return {
        stackId,
        coverId: stackCard.dataset.id,
        stackCountShown: stackCard.querySelector('.asset-stack-count')?.textContent || '',
        rootCountBeforeStack,
        rootCountAfterStack: rootCardIds().length,
        barVisibleAfterStack: selectionBarVisible(),
      };
    `));
    expect(typeof p4.stackId === "string" && p4.stackId.startsWith("stack-"), `P4 stack id: ${p4.stackId}`);
    expect([ids.s3, ids.s4, ids.s5].includes(p4.coverId), `P4 stack cover is a member: ${p4.coverId}`);
    expect(p4.stackCountShown === "3", `P4 stack count badge: ${p4.stackCountShown}`);
    expect(p4.rootCountBeforeStack === 6 && p4.rootCountAfterStack === 4, `P4 root count 6 -> 4: ${p4.rootCountBeforeStack} -> ${p4.rootCountAfterStack}`);
    expect(p4.barVisibleAfterStack === false, `P4 selection bar hidden after stacking: ${p4.barVisibleAfterStack}`);
    ids.stackId = p4.stackId;

    // ===== Page 5: rename via the modal, then an empty name must be rejected =====
    const p5 = await ctx.runInPage(first, source(ids, `
      await waitFor(() => document.querySelector(stackNodeSelector(config.stackId)), 'Stack node before rename');
      await rightClickChoose(stackNodeSelector(config.stackId) + ' .asset-card-select', [MENU.renameStack]);
      await waitFor(() => document.querySelector('#stackRenameModal')?.classList.contains('open'), 'rename modal opens');
      setValue('#stackRenameInput', config.stackName);
      click('#saveStackRenameBtn');
      await waitFor(() => !document.querySelector('#stackRenameModal')?.classList.contains('open'), 'rename modal closes');
      await waitFor(() => stackNodeTitle(config.stackId) === config.stackName, 'node title shows S-Stack');
      await rightClickChoose(stackNodeSelector(config.stackId) + ' .asset-card-select', [MENU.renameStack]);
      await waitFor(() => document.querySelector('#stackRenameModal')?.classList.contains('open'), 'rename modal reopens');
      setValue('#stackRenameInput', '');
      click('#saveStackRenameBtn');
      await waitFor(() => allToastTexts().some((text) => text.includes('堆叠名称不能为空')), 'empty-name rejected toast');
      const modalStillOpenAfterEmpty = document.querySelector('#stackRenameModal')?.classList.contains('open') || false;
      const titleAfterEmptyAttempt = stackNodeTitle(config.stackId);
      click('#cancelStackRenameBtn');
      await waitFor(() => !document.querySelector('#stackRenameModal')?.classList.contains('open'), 'rename modal cancelled');
      return { titleAfterRename: stackNodeTitle(config.stackId), modalStillOpenAfterEmpty, titleAfterEmptyAttempt };
    `));
    expect(p5.titleAfterRename === "S-Stack", `P5 renamed node title: ${p5.titleAfterRename}`);
    expect(p5.modalStillOpenAfterEmpty === true, `P5 modal stays open on empty name: ${p5.modalStillOpenAfterEmpty}`);
    expect(p5.titleAfterEmptyAttempt === "S-Stack", `P5 empty name not saved: ${p5.titleAfterEmptyAttempt}`);

    // ===== Page 6: open the stack, remove S5 from inside, return =====
    const p6 = await ctx.runInPage(first, source(ids, `
      await waitFor(() => document.querySelector(stackNodeSelector(config.stackId)), 'Stack node before opening');
      await rightClickChoose(stackNodeSelector(config.stackId) + ' .asset-card-select', [MENU.openStack]);
      await waitFor(() => !document.querySelector('#stackBack')?.hidden
        && document.querySelector('#selectionStack')?.hidden
        && !document.querySelector('#selectionRemoveFromStack')?.hidden
        && gallerySettled(), 'entered stack view');
      const memberIdsInside = rootCardIds();
      const viewTitleInside = document.querySelector('#viewTitle')?.textContent || '';
      ctrlClickCard(config.s5);
      await waitFor(() => JSON.stringify(selectedCardIds()) === JSON.stringify([config.s5]), 'S5 selected inside stack');
      click('#selectionRemoveFromStack');
      await waitFor(() => gallerySettled() && JSON.stringify(rootCardIds().sort()) === JSON.stringify([config.s3, config.s4].sort()), 'S5 removed, 2 members left');
      // The member count in the header refreshes in the background after an
      // in-place removal; it must not keep the count captured on entry.
      const viewTitleAfterRemove = await waitFor(() => {
        const title = document.querySelector('#viewTitle')?.textContent || '';
        return title.includes('S-Stack') && title.includes('2') && !title.includes('3') ? title : '';
      }, 'stack title member count after removal');
      const removeToast = allToastTexts().find((text) => text.includes('已从堆叠移出')) || '';
      click('#stackBack');
      await waitFor(() => gallerySettled() && rootCardIds().length === 5
        && document.querySelector(cardSelector(config.s5))
        && stackNodeCount(config.stackId) === '2', 'back at root with S5 restored');
      const nodeCard = document.querySelector(stackNodeSelector(config.stackId));
      return { memberIdsInside, viewTitleInside, viewTitleAfterRemove, removeToast, rootIdsAfterBack: rootCardIds(), nodeIdAfterBack: nodeCard?.dataset.id || '' };
    `));
    expect(sameMembers(p6.memberIdsInside, [ids.s3, ids.s4, ids.s5]), `P6 stack interior: ${JSON.stringify(p6.memberIdsInside)}`);
    expect(p6.viewTitleInside.includes("S-Stack") && p6.viewTitleInside.includes("3"), `P6 view title inside stack: ${p6.viewTitleInside}`);
    expect(p6.viewTitleAfterRemove.includes("S-Stack") && p6.viewTitleAfterRemove.includes("2"), `P6 view title after removal: ${p6.viewTitleAfterRemove}`);
    expect(p6.removeToast.includes("已从堆叠移出"), `P6 remove toast: ${p6.removeToast}`);
    expect(sameMembers(p6.rootIdsAfterBack, [ids.s1, ids.s2, ids.s5, ids.s6, p6.nodeIdAfterBack]), `P6 root after return: ${JSON.stringify(p6.rootIdsAfterBack)}`);
    expect(p6.rootIdsAfterBack.includes(ids.s5), `P6 S5 back at root: ${JSON.stringify(p6.rootIdsAfterBack)}`);

    // ===== API audit of the stack before the restart =====
    const stackSummary = await ctx.api(first.origin, "GET", `/api/asset-stacks/${encodeURIComponent(ids.stackId)}?project=default`);
    expect(stackSummary?.stack?.name === "S-Stack" && stackSummary?.stack?.count === 2, `audit stack summary: ${JSON.stringify(stackSummary?.stack)}`);
    const stackMembers = await ctx.api(first.origin, "GET", `/api/asset-stacks/${encodeURIComponent(ids.stackId)}/assets?project=default&limit=250`);
    expect(sameMembers((stackMembers?.assets || []).map((asset) => asset.id), [ids.s3, ids.s4]), `audit stack members: ${JSON.stringify(stackMembers?.assets?.map((asset) => asset.id))}`);
  } finally {
    await first.stop();
  }

  // ===== Restart on the same library: name + membership persist, then dissolve =====
  const second = await ctx.startServer();
  try {
    const p7 = await ctx.runInPage(second, source(ids, `
      await waitFor(() => gallerySettled() && rootCardIds().length === 5
        && document.querySelector(stackNodeSelector(config.stackId)), 'root gallery restored after restart');
      const titleAfterRestart = stackNodeTitle(config.stackId);
      const countAfterRestart = stackNodeCount(config.stackId);
      await rightClickChoose(stackNodeSelector(config.stackId) + ' .asset-card-select', [MENU.openStack]);
      await waitFor(() => !document.querySelector('#stackBack')?.hidden && gallerySettled(), 'entered stack after restart');
      const memberIdsAfterRestart = rootCardIds();
      const viewTitleAfterRestart = document.querySelector('#viewTitle')?.textContent || '';
      click('#stackBack');
      await waitFor(() => gallerySettled() && rootCardIds().length === 5
        && document.querySelector(stackNodeSelector(config.stackId)), 'returned to root after restart');
      await rightClickChoose(stackNodeSelector(config.stackId) + ' .asset-card-select', [MENU.dissolveStack]);
      const dissolveConfirmText = await answerConfirmDialog({ confirm: true });
      await waitFor(() => allToastTexts().some((text) => text.includes('已解散堆叠')), 'dissolve toast');
      const dissolveToast = allToastTexts().find((text) => text.includes('已解散堆叠')) || '';
      // Let the shipped incremental reconciliation settle, then capture the
      // gallery state as the user sees it right after the dissolve.
      await waitFor(() => gallerySettled() && rootCardIds().length === 6, 'six root entries after dissolve');
      const captureCards = () => [...document.querySelectorAll('#assetGrid > .asset-card')].map((card) => ({
        id: card.dataset.id,
        isStack: card.classList.contains('is-stack'),
        badge: card.querySelector('.asset-stack-count')?.textContent || '',
        title: card.querySelector('.asset-card-title')?.textContent || '',
      }));
      const cardsAfterDissolve = captureCards();
      return {
        titleAfterRestart, countAfterRestart, memberIdsAfterRestart, viewTitleAfterRestart,
        dissolveConfirmText, dissolveToast, cardsAfterDissolve,
        rootIdsAfterDissolve: rootCardIds(),
      };
    `));
    // 任务单要求：重启后 Stack 仍叫 S-Stack，成员是 S3、S4。
    expect(p7.titleAfterRestart === "S-Stack", `restart node title: ${p7.titleAfterRestart}`);
    expect(p7.countAfterRestart === "2", `restart node count badge: ${p7.countAfterRestart}`);
    expect(sameMembers(p7.memberIdsAfterRestart, [ids.s3, ids.s4]), `restart stack members: ${JSON.stringify(p7.memberIdsAfterRestart)}`);
    expect(p7.viewTitleAfterRestart.includes("S-Stack") && p7.viewTitleAfterRestart.includes("2"), `restart view title: ${p7.viewTitleAfterRestart}`);
    expect(p7.dissolveConfirmText.includes("不会删除"), `dissolve confirm text: ${p7.dissolveConfirmText}`);
    expect(p7.dissolveToast.includes("2"), `dissolve toast contains "2": ${p7.dissolveToast}`);
    expect(sameMembers(p7.rootIdsAfterDissolve, [ids.s1, ids.s2, ids.s3, ids.s4, ids.s5, ids.s6]), `root after dissolve: ${JSON.stringify(p7.rootIdsAfterDissolve)}`);

    // ===== API audit: members released as standalone assets, nothing deleted or trashed =====
    const finalListed = (await ctx.api(second.origin, "GET", "/api/assets?project=default&limit=250")).assets || [];
    const finalById = new Map(finalListed.map((asset) => [asset.id, asset]));
    expect(finalListed.length === 6, `audit six assets after dissolve: ${finalListed.length}`);
    expect([ids.s3, ids.s4].every((id) => finalById.get(id) && !finalById.get(id).stack), "audit S3/S4 have no stack after dissolve");
    expect(finalById.get(ids.s1)?.favorite === true && finalById.get(ids.s1)?.group === "S-Target", "audit S1 favorite/group persist across restart");
    const trashListed = (await ctx.api(second.origin, "GET", "/api/assets?project=default&limit=250&trash=1")).assets || [];
    expect(trashListed.length === 0, `audit trash empty after dissolve: ${JSON.stringify(trashListed.map((asset) => asset.id))}`);
    let stackGone = false;
    try {
      await ctx.api(second.origin, "GET", `/api/asset-stacks/${encodeURIComponent(ids.stackId)}?project=default`);
    } catch {
      stackGone = true;
    }
    expect(stackGone === true, "audit stack record removed after dissolve");
    expect(existsSync(imagePaths.s3) && existsSync(imagePaths.s4), "audit S3/S4 managed files still on disk");

    // ===== 任务单第 8 步的界面断言：S3、S4 回到根层级成为"独立素材"。=====
    // Covers the incremental commit of a dissolved Stack whose cover was
    // removed earlier: the node row turns into a plain row with a different
    // sort key, which must be re-rendered, not just moved.
    expect(
      (p7.cardsAfterDissolve || []).some((card) => card.id === ids.s3 && !card.isStack)
        && (p7.cardsAfterDissolve || []).some((card) => card.id === ids.s4 && !card.isStack)
        && !(p7.cardsAfterDissolve || []).some((card) => card.isStack),
      `dissolve leaves a ghost stack node (cards=${JSON.stringify(p7.cardsAfterDissolve)})`,
    );

    return {
      assets: [ids.s1, ids.s2, ids.s3, ids.s4, ids.s5, ids.s6],
      group: ids.groupName,
      stackId: ids.stackId,
      renamedTo: ids.stackName,
      dissolveToast: p7.dissolveToast,
      restarted: true,
    };
  } finally {
    await second.stop();
  }
}
