// 任务 60：键盘与浮层守卫的运行时验证。
// 54-1 三个「文本输入框 Enter 提交」处，组字（IME composition）Enter 不提交、
// 普通 Enter 照常提交；54-2 分组统计弹窗打开时 /、方向键、⌘A 都被统一浮层判定
// 拦下，关弹窗后恢复；55-2 右键菜单打开的同一任务里按 Escape 立即关菜单。
// 组字 Enter 的"不提交"用弹窗/编辑器仍然打开这个界面事实判定（提交会立刻关
// 闭它们），最终数据状态在 Node 端用接口复查。

import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "keyboard-modal-guards";
export const description = "IME composing Enter does not submit group/stack-rename/sidebar editors; group-stats modal blocks /, arrows and Cmd+A; context menu closes on an immediate Escape";

const GROUP_CREATE_NAME = "键盘守卫组";
const GROUP_RENAME_FROM = "预置分组";
const GROUP_RENAME_TO = "预置分组甲";
const STACK_RENAME_TO = "堆叠新名";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const create = async (fileName, [r, g, b], prompt) => ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: await ctx.makePng(fileName, [r, g, b]),
      prompt,
    });
    const cover = await create("kg-cover.png", [181, 68, 74], "keyboard guards stack cover");
    const member = await create("kg-member.png", [74, 127, 181], "keyboard guards stack member");
    const plain = await create("kg-plain.png", [58, 138, 87], "keyboard guards plain asset");
    const stack = await ctx.api(server.origin, "POST", "/api/asset-stacks", {
      projectId: "default",
      assetIds: [cover.asset.id, member.asset.id],
      coverAssetId: cover.asset.id,
    });
    await ctx.api(server.origin, "POST", "/api/groups", { projectId: "default", name: GROUP_RENAME_FROM });

    const config = {
      plainId: plain.asset.id,
      groupCreateName: GROUP_CREATE_NAME,
      groupRenameFrom: GROUP_RENAME_FROM,
      groupRenameTo: GROUP_RENAME_TO,
      stackRenameTo: STACK_RENAME_TO,
    };
    const facts = await ctx.runInPage(server, pageSource(config));
    assertFacts(facts);

    // 接口复查：分组列表恰好是「新建组 + 改名后的组」，且堆叠真被重命名。
    const payload = await ctx.api(server.origin, "GET", "/api/groups?project=default");
    const groupList = Array.isArray(payload?.groups) ? payload.groups : payload?.groups?.groups;
    const names = (Array.isArray(groupList) ? groupList : [])
      .map((group) => (Array.isArray(group) ? group[0] : group?.name)).sort();
    const expectedNames = [GROUP_CREATE_NAME, GROUP_RENAME_TO].sort();
    if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
      throw new Error(`Group list mismatch: ${JSON.stringify(names)} !== ${JSON.stringify(expectedNames)}`);
    }
    const renamedStack = await ctx.api(server.origin, "GET", `/api/asset-stacks/${encodeURIComponent(stack.stack.id)}?project=default`);
    if (renamedStack?.stack?.name !== STACK_RENAME_TO) {
      throw new Error(`Stack rename did not persist: ${JSON.stringify(renamedStack?.stack?.name)}`);
    }
    return { groups: names, stackName: renamedStack.stack.name };
  } finally {
    await server.stop();
  }
}

function assertFacts(facts) {
  const expectations = {
    composingKeyCodeDelivered: true,
    groupModalStillOpenAfterComposingEnter: true,
    sidebarEditorStillOpenAfterComposingEnter: true,
    stackRenameModalStillOpenAfterComposingEnter: true,
    searchFocusedWhileStatsOpen: false,
    selectionUnchangedWhileStatsOpen: true,
    selectedCountWhileStatsOpen: 1,
    searchFocusRestored: true,
    selectionMovesAfterClose: true,
    menuOpenImmediately: true,
    menuClosedAfterImmediateEscape: true,
    inspectorStillOpenAfterMenuEscape: true,
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
    const facts = {};
    const groupButtonSelector = (name) => '#sidebarManualGroupList [data-filter="group"][data-value="' + name + '"]';
    const modalOpen = (id) => document.querySelector(id)?.classList.contains('open') === true;
    const selectedId = () => document.querySelector('.asset-card.selected')?.dataset.id || '';
    const selectedCount = () => document.querySelectorAll('.asset-card.selected').length;
    const assert = (ok, label) => { if (!ok) throw new Error('keyboard-modal-guards: ' + label + ' diagnostic=' + JSON.stringify(pageDiagnostic())); };
    const keyOn = (target, init) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    // 组字 Enter：isComposing 是主信号，keyCode 229 兜底（构造器不收时再补）。
    const composingEnterOn = (target) => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true, keyCode: 229 });
      if (event.keyCode !== 229) {
        try { Object.defineProperty(event, 'keyCode', { get: () => 229 }); } catch (error) { /* isComposing 已覆盖主判定 */ }
      }
      facts.composingKeyCodeDelivered = event.keyCode === 229;
      target.dispatchEvent(event);
    };

    await waitFor(() => gallerySettled() && rootCardIds().length === 2, 'two root cards (stack node + plain asset)');
    await waitFor(() => Boolean(document.querySelector(groupButtonSelector(config.groupRenameFrom))), 'seeded group visible in sidebar');

    // ===== 新建分组弹窗：组字 Enter 不提交，普通 Enter 提交 =====
    const addGroupItem = await openContextMenu('#assetGrid', '添加分组');
    addGroupItem.click();
    await waitFor(() => modalOpen('#groupModal'), 'group modal opens');
    setValue('#groupNameInput', config.groupCreateName);
    composingEnterOn(document.querySelector('#groupNameInput'));
    await sleep(700);
    facts.groupModalStillOpenAfterComposingEnter = modalOpen('#groupModal');
    assert(facts.groupModalStillOpenAfterComposingEnter, 'composing Enter must not submit the group modal');
    keyOn(document.querySelector('#groupNameInput'), { key: 'Enter' });
    await waitFor(() => !modalOpen('#groupModal'), 'group modal closes on plain Enter');
    await waitFor(() => Boolean(document.querySelector(groupButtonSelector(config.groupCreateName))), 'created group reaches the sidebar');

    // ===== 侧栏分组内联改名：组字 Enter 不提交，普通 Enter 提交 =====
    document.querySelector(groupButtonSelector(config.groupRenameFrom))
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    const editorInput = await waitFor(
      () => document.querySelector('#sidebarManualGroupList [data-sidebar-group-input]'),
      'sidebar group editor opens',
    );
    editorInput.focus();
    editorInput.value = config.groupRenameTo;
    editorInput.dispatchEvent(new Event('input', { bubbles: true }));
    composingEnterOn(editorInput);
    await sleep(700);
    facts.sidebarEditorStillOpenAfterComposingEnter = Boolean(document.querySelector('#sidebarManualGroupList [data-sidebar-group-input]'));
    assert(facts.sidebarEditorStillOpenAfterComposingEnter, 'composing Enter must not commit the sidebar group rename');
    keyOn(editorInput, { key: 'Enter' });
    await waitFor(() => !document.querySelector('#sidebarManualGroupList [data-sidebar-group-input]'), 'sidebar editor closes on plain Enter');
    await waitFor(() => Boolean(document.querySelector(groupButtonSelector(config.groupRenameTo))), 'renamed group shows in sidebar');

    // ===== 堆叠重命名弹窗：组字 Enter 不提交，普通 Enter 提交 =====
    // 新建堆叠的 name 为空串（服务端默认，卡片显示封面标题），弹窗不预填，
    // 先 setValue 再派发组字 Enter——若守卫缺失会带着新名立即提交关窗。
    // 注意输入框 DOM id 是 #stackRenameInput（els 键名是 stackRenameModalInput）。
    const renameStackItem = await openContextMenu('.asset-card.is-stack', '重命名堆叠');
    renameStackItem.click();
    await waitFor(() => modalOpen('#stackRenameModal'), 'stack rename modal opens');
    setValue('#stackRenameInput', config.stackRenameTo);
    const stackInput = document.querySelector('#stackRenameInput');
    composingEnterOn(stackInput);
    await sleep(700);
    facts.stackRenameModalStillOpenAfterComposingEnter = modalOpen('#stackRenameModal');
    assert(facts.stackRenameModalStillOpenAfterComposingEnter, 'composing Enter must not submit the stack rename modal');
    keyOn(stackInput, { key: 'Enter' });
    await waitFor(() => !modalOpen('#stackRenameModal'), 'stack rename modal closes on plain Enter');

    // ===== 分组统计弹窗：/、方向键、⌘A 都不穿透，关弹窗后恢复 =====
    const cards = [...document.querySelectorAll('#assetGrid > .asset-card')]
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    cards[0].querySelector('.asset-card-select').click();
    await waitFor(() => Boolean(selectedId()), 'leftmost card selected');
    const statsItem = await openContextMenu(groupButtonSelector(config.groupRenameTo), '分组统计');
    statsItem.click();
    await waitFor(() => modalOpen('#groupStatsModal'), 'group stats modal opens');
    const selectedBefore = selectedId();
    keyOn(document.body, { key: '/' });
    await sleep(150);
    facts.searchFocusedWhileStatsOpen = document.activeElement?.id === 'searchInput';
    assert(!facts.searchFocusedWhileStatsOpen, '/ must not focus search while the stats modal is open');
    keyOn(document.body, { key: 'ArrowRight' });
    await sleep(150);
    facts.selectionUnchangedWhileStatsOpen = selectedId() === selectedBefore;
    assert(facts.selectionUnchangedWhileStatsOpen, 'ArrowRight must not move the gallery selection while the stats modal is open');
    keyOn(document.body, { key: 'a', metaKey: true, ctrlKey: true });
    await sleep(150);
    facts.selectedCountWhileStatsOpen = selectedCount();
    assert(facts.selectedCountWhileStatsOpen === 1, 'Cmd/Ctrl+A must not select all while the stats modal is open');
    keyOn(document.body, { key: 'Escape' });
    await waitFor(() => !modalOpen('#groupStatsModal'), 'stats modal closes on Escape');
    keyOn(document.body, { key: '/' });
    await waitFor(() => document.activeElement?.id === 'searchInput', '/ focuses search again after the modal closes');
    facts.searchFocusRestored = true;
    keyOn(document.body, { key: 'ArrowRight' });
    await waitFor(() => Boolean(selectedId()) && selectedId() !== selectedBefore, 'ArrowRight moves the selection after the modal closes');
    facts.selectionMovesAfterClose = true;

    // ===== 右键菜单：打开的同一任务里 Escape 立即关菜单 =====
    const plainCard = document.querySelector(cardSelector(config.plainId));
    assert(Boolean(plainCard), 'plain card exists for the context-menu Escape check');
    plainCard.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 320, clientY: 320 }));
    facts.menuOpenImmediately = Boolean(document.querySelector('.context-menu'));
    assert(facts.menuOpenImmediately, 'context menu opens synchronously on contextmenu');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    facts.menuClosedAfterImmediateEscape = !document.querySelector('.context-menu');
    assert(facts.menuClosedAfterImmediateEscape, 'Escape in the same task must close the freshly opened context menu');
    facts.inspectorStillOpenAfterMenuEscape = document.querySelector('#detailPanel')?.getAttribute('aria-hidden') === 'false';

    return facts;
  })()`;
}
