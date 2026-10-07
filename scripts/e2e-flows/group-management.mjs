// Pluggable e2e flow: full manual-group lifecycle driven through the real UI
// entry points (blank-gallery context menu, asset "添加分组" submenu, sidebar
// group context menus, inline rename editor, confirm dialogs). Seed via API,
// assert on returned page facts in Node, audit through the API, then restart
// the server on the same library to prove persistence.

import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "group-management";
export const description =
  "groups: create/move/selection-create/remove/rename/reorder/stats/merge/delete-keep/delete-trash -> API audit -> restart persistence";

// Menu labels verified against web/app/i18n.mjs (zh is the default locale):
// createGroup=添加分组(画廊空白处), addToGroup=添加分组(素材菜单,任务 91 改文案), createGroupWithSelection=新建分组并移入,
// removeFromGroup=移除分组(任务 91 提为顶层项), renameGroup=重命名分组, moveGroupUp=上移,
// groupStats=分组统计, mergeGroupInto=合并到…, deleteGroup=删除分组.
const MENU = {
  createGroup: "添加分组",
  addToGroup: "添加分组",
  createGroupWithSelection: "新建分组并移入",
  removeFromGroup: "移除分组",
  renameGroup: "重命名分组",
  moveGroupUp: "上移",
  groupStats: "分组统计",
  mergeGroupInto: "合并到…",
  deleteGroup: "删除分组",
};

// In-page helpers specific to this flow, interpolated after PAGE_HELPERS.
const GROUP_HELPERS = String.raw`
  const groupNavSelector = (groupName) => '#sidebarManualGroupList .nav-item[data-filter="group"][data-value="' + CSS.escape(groupName) + '"]';
  const sidebarGroupNames = () => [...document.querySelectorAll('#sidebarManualGroupList .nav-item[data-filter="group"]')].map((button) => button.dataset.value);
  const groupNavCount = (groupName) => Number(document.querySelector(groupNavSelector(groupName) + ' .nav-count')?.textContent?.trim() || '-1');
  const sortedIds = () => [...rootCardIds()].sort();
  // Gallery multi-selection marks cards with .multi-selected (the detail
  // selection uses .selected); see cardSelectionFlags in gallery-selection.mjs.
  const selectedCardIds = () => [...document.querySelectorAll('.asset-card.multi-selected')].map((card) => card.dataset.id).sort();
  async function waitForSidebarGroups(names, label) {
    const want = JSON.stringify(names);
    return waitFor(() => JSON.stringify(sidebarGroupNames()) === want, label || ('sidebar groups == ' + names.join(',')));
  }
  // Sidebar nav buttons navigate immediately for programmatic clicks (detail 0).
  async function openGroupView(groupName, expectedIds) {
    click(groupNavSelector(groupName));
    const want = JSON.stringify([...expectedIds].sort());
    await waitFor(() => gallerySettled() && JSON.stringify(sortedIds()) === want, 'group view ' + groupName);
    return rootCardIds();
  }
  async function openScopeView(filter, expectedIds) {
    click('#quickFilters .nav-item[data-filter="' + filter + '"]');
    const want = expectedIds ? JSON.stringify([...expectedIds].sort()) : null;
    await waitFor(() => gallerySettled() && (!want || JSON.stringify(sortedIds()) === want), 'scope view ' + filter);
    return rootCardIds();
  }
  // Ctrl/Cmd+click toggles a card into the gallery multi-selection.
  function ctrlClickCard(assetId) {
    const target = document.querySelector(cardSelector(assetId) + ' .asset-card-select');
    if (!target) throw new Error('Missing card select for ' + assetId);
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true, metaKey: true }));
  }
  // Walks an open context menu down the labels array (parent items hover-open their
  // submenu, the last label is clicked). Exact .context-menu-label matching so
  // group names like G-Alpha never hit G-Alpha2.
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
    // openContextMenu returns the first root item matching labels[0]; hovering
    // each intermediate item opens its submenu, and the last label is clicked.
    let item = await openContextMenu(triggerSelector, labels[0]);
    for (let index = 1; index < labels.length; index += 1) {
      item.dispatchEvent(new MouseEvent('mouseenter'));
      item = await findMenuItem(labels[index], labels[index - 1]);
    }
    item.click();
  }
  async function createGroupViaModal(groupName) {
    await waitFor(() => document.querySelector('#groupModal')?.classList.contains('open'), 'group modal opens');
    setValue('#groupNameInput', groupName);
    click('#saveGroupBtn');
    await waitFor(() => !document.querySelector('#groupModal')?.classList.contains('open'), 'group modal closes');
  }
  // Delete-group is a two-step confirmation: delete, then keep assets (Cancel)
  // or move them to Trash (Confirm). Descriptions prove which dialog answered.
  async function deleteGroupViaMenu(groupName, deleteAssets) {
    await rightClickChoose(groupNavSelector(groupName), [MENU.deleteGroup]);
    const first = await answerConfirmDialog({ confirm: true });
    if (!first.includes('分组将被删除')) throw new Error('Unexpected delete confirm dialog: ' + first);
    const followup = await answerConfirmDialog({ confirm: deleteAssets });
    if (!followup.includes('未分组')) throw new Error('Unexpected delete-assets dialog: ' + followup);
  }
`;

function source(config, body) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    const MENU = ${JSON.stringify(MENU)};
    ${PAGE_HELPERS}
    ${GROUP_HELPERS}
    ${body}
  })()`;
}

function expect(condition, message) {
  if (!condition) throw new Error(`group-management: ${message}`);
}

const sameMembers = (actual, expected) => JSON.stringify([...(actual || [])].sort()) === JSON.stringify([...expected].sort());

export async function run(ctx) {
  await ctx.prepare();
  let ids;
  const first = await ctx.startServer();
  try {
    // ===== Seed via API: P1-P4 ungrouped, groups G-Alpha/G-Beta, P4 in G-Beta =====
    const seedAsset = async (fileName, [r, g, b], prompt) => {
      const imagePath = await ctx.makePng(fileName, [r, g, b]);
      const response = await ctx.api(first.origin, "POST", "/api/assets/create", { projectId: "default", imagePath, prompt });
      return response.asset.id;
    };
    const p1 = await seedAsset("group-p1.png", [220, 68, 74], "group flow P1");
    const p2 = await seedAsset("group-p2.png", [74, 181, 92], "group flow P2");
    const p3 = await seedAsset("group-p3.png", [240, 180, 40], "group flow P3");
    const p4 = await seedAsset("group-p4.png", [108, 92, 231], "group flow P4");
    await ctx.api(first.origin, "POST", "/api/groups", { projectId: "default", name: "G-Alpha" });
    await ctx.api(first.origin, "POST", "/api/groups", { projectId: "default", name: "G-Beta" });
    await ctx.api(first.origin, "POST", "/api/assets/batch", { projectId: "default", action: "group", assetIds: [p4], group: "G-Beta" });
    ids = { p1, p2, p3, p4 };

    // ===== S1: create G-New from the blank gallery menu; move P1 -> G-Alpha =====
    const s1 = await ctx.runInPage(first, source(ids, `
      await waitFor(() => gallerySettled() && rootCardIds().length === 4, 'four seeded cards');
      await waitForSidebarGroups(['G-Alpha', 'G-Beta'], 'seeded sidebar groups');
      document.querySelector('#assetGrid').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
      (await findMenuItem(MENU.createGroup, null)).click();
      await createGroupViaModal('G-New');
      await waitForSidebarGroups(['G-Alpha', 'G-Beta', 'G-New'], 'G-New appears in sidebar');
      await rightClickChoose(cardSelector(config.p1), [MENU.addToGroup, 'G-Alpha']);
      await waitFor(() => groupNavCount('G-Alpha') === 1, 'G-Alpha count becomes 1');
      const gAlphaIds = await openGroupView('G-Alpha', [config.p1]);
      return { sidebar: sidebarGroupNames(), gAlphaIds, gAlphaCount: groupNavCount('G-Alpha') };
    `));
    expect(sameMembers(s1.sidebar, ["G-Alpha", "G-Beta", "G-New"]), `S1 sidebar after create: ${JSON.stringify(s1.sidebar)}`);
    expect(sameMembers(s1.gAlphaIds, [p1]), `S1 G-Alpha members: ${JSON.stringify(s1.gAlphaIds)}`);
    expect(s1.gAlphaCount === 1, `S1 G-Alpha count: ${s1.gAlphaCount}`);

    // ===== S2: G-Sel from selected P2+P3; remove P3 from it =====
    const s2 = await ctx.runInPage(first, source(ids, `
      await waitFor(() => gallerySettled() && rootCardIds().length === 4, 'all view with four cards');
      ctrlClickCard(config.p2);
      await waitFor(() => selectedCardIds().length === 1, 'P2 selected');
      ctrlClickCard(config.p3);
      await waitFor(() => JSON.stringify(selectedCardIds()) === JSON.stringify([config.p2, config.p3].sort()), 'P2+P3 selected');
      await rightClickChoose(cardSelector(config.p3), [MENU.addToGroup, MENU.createGroupWithSelection]);
      await createGroupViaModal('G-Sel');
      await waitFor(() => groupNavCount('G-Sel') === 2, 'G-Sel count becomes 2');
      const gSelIds = await openGroupView('G-Sel', [config.p2, config.p3]);
      await rightClickChoose(cardSelector(config.p3), [MENU.addToGroup, MENU.removeFromGroup]);
      await waitFor(() => groupNavCount('G-Sel') === 1, 'G-Sel count back to 1');
      const gSelAfterRemove = await openGroupView('G-Sel', [config.p2]);
      const unorganizedIds = await openScopeView('unorganized', [config.p3]);
      return { gSelIds, gSelAfterRemove, unorganizedIds };
    `));
    expect(sameMembers(s2.gSelIds, [p2, p3]), `S2 G-Sel members after create: ${JSON.stringify(s2.gSelIds)}`);
    expect(sameMembers(s2.gSelAfterRemove, [p2]), `S2 G-Sel members after remove: ${JSON.stringify(s2.gSelAfterRemove)}`);
    expect(sameMembers(s2.unorganizedIds, [p3]), `S2 unorganized view: ${JSON.stringify(s2.unorganizedIds)}`);

    // ===== S3: rename G-Alpha -> G-Alpha2 (inline editor); move G-New up; stats =====
    const s3 = await ctx.runInPage(first, source(ids, `
      await waitForSidebarGroups(['G-Alpha', 'G-Beta', 'G-New', 'G-Sel'], 'sidebar before rename');
      await rightClickChoose(groupNavSelector('G-Alpha'), [MENU.renameGroup]);
      await waitFor(() => document.querySelector('[data-sidebar-group-editor][data-original-name="G-Alpha"]'), 'inline rename editor for G-Alpha');
      setValue('#sidebarManualGroupList [data-sidebar-group-input]', 'G-Alpha2');
      document.querySelector('#sidebarManualGroupList [data-sidebar-group-input]')
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await waitForSidebarGroups(['G-Alpha2', 'G-Beta', 'G-New', 'G-Sel'], 'sidebar after rename');
      const renamedIds = await openGroupView('G-Alpha2', [config.p1]);
      const activeText = document.querySelector('#sidebarManualGroupList .nav-item.active .nav-item-text')?.textContent || '';
      await rightClickChoose(groupNavSelector('G-New'), [MENU.moveGroupUp]);
      await waitForSidebarGroups(['G-Alpha2', 'G-New', 'G-Beta', 'G-Sel'], 'sidebar after moving G-New up');
      const orderAfterMove = sidebarGroupNames();
      await rightClickChoose(groupNavSelector('G-Alpha2'), [MENU.groupStats]);
      await waitFor(() => document.querySelector('#groupStatsModal')?.classList.contains('open'), 'group stats modal opens');
      const totalCell = await waitFor(() => {
        const entries = [...document.querySelectorAll('#groupStatsBody .group-stats-cell')]
          .map((cell) => ({ label: cell.querySelector('span')?.textContent || '', value: cell.querySelector('strong')?.textContent || '' }));
        return entries.find((entry) => entry.label === '素材总数') || null;
      }, 'group stats rows rendered');
      click('#groupStatsCloseBtn');
      await waitFor(() => !document.querySelector('#groupStatsModal')?.classList.contains('open'), 'group stats modal closes');
      return { renamedIds, activeText, orderAfterMove, statsTotal: Number(totalCell.value) };
    `));
    expect(sameMembers(s3.renamedIds, [p1]), `S3 G-Alpha2 members after rename: ${JSON.stringify(s3.renamedIds)}`);
    expect(s3.activeText === "G-Alpha2", `S3 active sidebar label: ${s3.activeText}`);
    const expectedOrder = ["G-Alpha2", "G-New", "G-Beta", "G-Sel"];
    expect(JSON.stringify(s3.orderAfterMove) === JSON.stringify(expectedOrder), `S3 order after move up: ${JSON.stringify(s3.orderAfterMove)}`);
    // Only one group survives to the restart, so prove the manual order is
    // persisted here, where it still has four groups to compare.
    const orderedGroups = await ctx.api(first.origin, "GET", "/api/groups?project=default");
    const persistedOrder = (orderedGroups?.groups?.groups || []).map((group) => group.name);
    expect(JSON.stringify(persistedOrder) === JSON.stringify(expectedOrder), `S3 persisted group order: ${JSON.stringify(persistedOrder)}`);
    expect(s3.statsTotal === 1, `S3 G-Alpha2 stats total: ${s3.statsTotal}`);

    // ===== S4: merge G-Beta into G-Alpha2; delete G-Sel keeping assets =====
    const s4 = await ctx.runInPage(first, source(ids, `
      await waitForSidebarGroups(['G-Alpha2', 'G-New', 'G-Beta', 'G-Sel'], 'sidebar before merge');
      await rightClickChoose(groupNavSelector('G-Beta'), [MENU.mergeGroupInto, 'G-Alpha2']);
      const mergeDescription = await answerConfirmDialog({ confirm: true });
      await waitForSidebarGroups(['G-Alpha2', 'G-New', 'G-Sel'], 'sidebar after merge');
      await waitFor(() => groupNavCount('G-Alpha2') === 2, 'G-Alpha2 count becomes 2');
      const mergedIds = await openGroupView('G-Alpha2', [config.p1, config.p4]);
      await deleteGroupViaMenu('G-Sel', false);
      await waitForSidebarGroups(['G-Alpha2', 'G-New'], 'sidebar after deleting G-Sel');
      const allIds = await openScopeView('all', [config.p1, config.p2, config.p3, config.p4]);
      const unorganizedIds = await openScopeView('unorganized', [config.p2, config.p3]);
      return { mergeDescription, mergedIds, allIds, unorganizedIds };
    `));
    expect(s4.mergeDescription.includes("G-Beta") && s4.mergeDescription.includes("G-Alpha2"), `S4 merge dialog text: ${s4.mergeDescription}`);
    expect(sameMembers(s4.mergedIds, [p1, p4]), `S4 G-Alpha2 members after merge: ${JSON.stringify(s4.mergedIds)}`);
    expect(sameMembers(s4.allIds, [p1, p2, p3, p4]), `S4 all view after delete-keep: ${JSON.stringify(s4.allIds)}`);
    expect(sameMembers(s4.unorganizedIds, [p2, p3]), `S4 unorganized view after delete-keep: ${JSON.stringify(s4.unorganizedIds)}`);

    // ===== Seed P5 into G-New via API, then delete G-New moving assets to Trash =====
    const p5 = (await ctx.api(first.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("group-p5.png", [40, 140, 200]), prompt: "group flow P5",
    })).asset.id;
    ids.p5 = p5;
    await ctx.api(first.origin, "POST", "/api/assets/batch", { projectId: "default", action: "group", assetIds: [p5], group: "G-New" });

    const s5 = await ctx.runInPage(first, source({ ...ids, p5 }, `
      await waitForSidebarGroups(['G-Alpha2', 'G-New'], 'sidebar before deleting G-New');
      await waitFor(() => groupNavCount('G-New') === 1, 'G-New count is 1 before delete');
      await deleteGroupViaMenu('G-New', true);
      await waitForSidebarGroups(['G-Alpha2'], 'sidebar after deleting G-New');
      const trashIds = await openScopeView('trash', [config.p5]);
      return { trashIds };
    `));
    expect(sameMembers(s5.trashIds, [p5]), `S5 trash view: ${JSON.stringify(s5.trashIds)}`);

    // ===== API audit of the final state =====
    const groups = await ctx.api(first.origin, "GET", "/api/groups?project=default");
    const groupList = groups?.groups?.groups || [];
    expect(JSON.stringify(groupList.map((group) => group.name)) === JSON.stringify(["G-Alpha2"]), `audit groups: ${JSON.stringify(groupList)}`);
    expect(groupList[0]?.count === 2, `audit G-Alpha2 count: ${groupList[0]?.count}`);
    const alphaMembers = await ctx.api(first.origin, "GET", `/api/assets?project=default&group=${encodeURIComponent("G-Alpha2")}`);
    expect(sameMembers((alphaMembers?.assets || []).map((asset) => asset.id), [p1, p4]), `audit G-Alpha2 members: ${JSON.stringify(alphaMembers?.assets?.map((asset) => asset.id))}`);
    const trashAssets = await ctx.api(first.origin, "GET", "/api/assets?project=default&trash=1");
    expect(sameMembers((trashAssets?.assets || []).map((asset) => asset.id), [p5]), `audit trash: ${JSON.stringify(trashAssets?.assets?.map((asset) => asset.id))}`);
    const unorganized = await ctx.api(first.origin, "GET", "/api/assets?project=default&unorganized=1");
    expect(sameMembers((unorganized?.assets || []).map((asset) => asset.id), [p2, p3]), `audit unorganized: ${JSON.stringify(unorganized?.assets?.map((asset) => asset.id))}`);
  } finally {
    await first.stop();
  }

  // ===== Restart on the same library: names, manual order and members persist =====
  const second = await ctx.startServer();
  try {
    const restart = await ctx.runInPage(second, source(ids, `
      await waitFor(() => gallerySettled() && rootCardIds().length === 4, 'gallery restored after restart');
      await waitForSidebarGroups(['G-Alpha2'], 'sidebar groups after restart');
      const members = await openGroupView('G-Alpha2', [config.p1, config.p4]);
      return { sidebar: sidebarGroupNames(), members, gAlphaCount: groupNavCount('G-Alpha2') };
    `));
    expect(sameMembers(restart.sidebar, ["G-Alpha2"]), `restart sidebar: ${JSON.stringify(restart.sidebar)}`);
    expect(sameMembers(restart.members, [ids.p1, ids.p4]), `restart G-Alpha2 members: ${JSON.stringify(restart.members)}`);
    expect(restart.gAlphaCount === 2, `restart G-Alpha2 count: ${restart.gAlphaCount}`);
    return { groups: ["G-Alpha2"], members: [ids.p1, ids.p4], trash: [ids.p5 || ""], restarted: true };
  } finally {
    await second.stop();
  }
}
