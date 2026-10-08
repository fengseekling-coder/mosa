// Inspector editing flow: seed three assets through the API, then exercise every
// editable control in the web inspector (aside from favorite + prompt/recipe-change
// summary, which the critical web flow already covers, and the clipboard copy
// actions, which are out of scope for this task).
//
// GravityPort A4a（任务 73）后的覆盖面：
// - 配方与编辑 disclosure 已从检视器拿掉（editRecipeFieldsMarkup 保留实现）——
//   本流程不再编辑 skill/style/ratio/theme/group/category/rating/business_fields，
//   改为锁「配方编辑区不再渲染」；配方草稿的静默冲刷 / debounce 自动保存随入口
//   一起从 UI 不可达（少验，见任务单回报）。
// - 标签：add-tag 打开内联编辑器，submit 即时 PATCH；用户标签 chip 内的 × 按钮
//   （data-action="remove-tag"）直接删除并整体 PATCH tags，不弹确认框 → 照常覆盖。
// - 参考图权利：经参考图区块的「查看」浮层打开（open-reference-overlay），
//   copyright / portrait_consent / redistribution 下拉、attribution 输入、
//   use-chip 循环点击，save-reference-rights → 照常覆盖。
// - 未保存草稿语义：tags 编辑器是手动保存作用域，导航前弹「放弃修改」确认框，
//   取消则留在原地 → 照常测。
//
// - 标签回归：列表接口曾不带 tags，检视器在新会话里显示空标签行，加标签时
//   以空列表为合并基数，把已有标签整体清掉（数据丢失）。重启阶段的探针守住它。

import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "inspector-editing";
export const description = "Inspector open/close/switch, tags, metadata fields, reference rights, autosave + discard guards, restart persistence";

export async function run(ctx) {
  await ctx.prepare();
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // A4a：配方字段（style/skill/ratio/theme/group/category/rating/business_fields）
  // 不再有编辑入口，相应配置一并移除；attribution/tag 系列照旧。
  const config = {
    shotValue: `insp-shot-${stamp}`,
    attributionValue: `insp-attrib-${stamp}`,
    tagA: `insp-a-${stamp}`,
    tagB: `insp-b-${stamp}`,
    tagDraftX: `insp-dx-${stamp}`,
    tagDraftY: `insp-dy-${stamp}`,
    tagC: `insp-c-${stamp}`,
  };
  const ids = await seedAssets(ctx, config);

  const first = await ctx.startServer();
  try {
    // S1: open/close/reopen, keyboard switch (A4a：配方草稿不可编辑，静默冲刷分支随之少验).
    const openClose = await ctx.runInPage(first, openCloseSwitchSource({ ...config, i1: ids.i1, i2: ids.i2 }));
    assertCondition(openClose.initialIds.length === 3, `expected three seeded cards, got ${JSON.stringify(openClose.initialIds)}`);
    assertCondition(openClose.openedFacts.open === true && openClose.openedFacts.imageSrc.includes(ids.i1),
      `inspector did not open with I1: ${JSON.stringify(openClose.openedFacts)}`);
    assertCondition(openClose.closedFacts.open === false && openClose.closedFacts.openButtonVisible === true,
      `close-detail did not close the inspector / reveal the open button: ${JSON.stringify(openClose.closedFacts)}`);
    assertCondition(openClose.arrowTarget && openClose.arrowTarget !== ids.i1,
      `arrow-key navigation did not move the selection off I1: ${JSON.stringify(openClose)}`);
    assertCondition(openClose.dialogDuringSwitch === false, "a confirm dialog appeared for a plain asset switch");
    assertCondition(openClose.i2Facts.selected === ids.i2 && openClose.i2Facts.imageOk === true,
      `inspector did not follow the switch to I2: ${JSON.stringify(openClose.i2Facts)}`);
    assertCondition(openClose.i2Facts.editFieldCount === 0,
      `data-edit fields must stay removed (A4a): ${JSON.stringify(openClose.i2Facts)}`);

    // S2: A4a——配方编辑区不再渲染（锁「不得回来」）。
    const metadata = await ctx.runInPage(first, recipeEditorRemovedSource({ ...config, i1: ids.i1, i3: ids.i3 }));
    assertCondition(metadata.removedOnI1 === true && metadata.removedOnI3 === true,
      `recipe editor must stay removed on every asset: ${JSON.stringify(metadata)}`);

    // S3: reference rights editor inside the overlay: selects + attribution + use chip -> save.
    const rights = await ctx.runInPage(first, referenceRightsSource({ ...config, i1: ids.i1 }));
    assertCondition(rights.identityChipAllowed === true, `identity use chip did not cycle to allowed: ${JSON.stringify(rights)}`);
    assertCondition(rights.dirtyCleared === true, `reference rights still dirty after save: ${JSON.stringify(rights)}`);
    const i1AfterRights = await getAsset(ctx, first, ids.i1);
    const savedReference = activeReference(i1AfterRights);
    const savedRights = savedReference.rights || {};
    assertCondition(savedRights.copyright === "owned" && savedRights.portrait_consent === "granted" && savedRights.redistribution === "allowed",
      `reference rights not persisted: ${JSON.stringify(savedRights)}`);
    assertCondition(savedRights.attribution === config.attributionValue,
      `reference attribution not persisted: ${JSON.stringify(savedRights)}`);
    assertCondition(Array.isArray(savedReference.allowed_uses) && savedReference.allowed_uses.includes("identity"),
      `allowed_uses missing the identity chip: ${JSON.stringify(savedReference)}`);

    // S4: add two tags through the inline tag editor.
    const tags = await ctx.runInPage(first, addTagsSource({ ...config, i1: ids.i1 }));
    assertCondition(tags.chips.includes(config.tagA) && tags.chips.includes(config.tagB),
      `tag chips missing after add: ${JSON.stringify(tags.chips)}`);
    const i1AfterTags = await getAsset(ctx, first, ids.i1);
    assertCondition(JSON.stringify(i1AfterTags.tags) === JSON.stringify([config.tagA, config.tagB]),
      `I1.tags not saved via inspector (got ${JSON.stringify(i1AfterTags.tags)})`);

    // S5: A4a——配方自动保存随入口拿掉；这里只锁切换不弹确认框 + 编辑区不渲染。
    const autosave = await ctx.runInPage(first, autosaveSource({ ...config, i2: ids.i2, i3: ids.i3 }));
    assertCondition(autosave.afterSwitch.selected === ids.i3 && autosave.afterSwitch.confirmOpen === false,
      `a plain switch did not land on I3 / raised a dialog: ${JSON.stringify(autosave.afterSwitch)}`);
    assertCondition(autosave.editFieldCount === 0, `data-edit fields must stay removed (A4a): ${JSON.stringify(autosave)}`);

    // S6: tags-editor draft guard: cancel keeps the draft (then save it),
    // confirm ("放弃修改") discards it and navigates.
    const guards = await ctx.runInPage(first, tagDraftGuardSource({ ...config, i1: ids.i1, i3: ids.i3 }));
    assertCondition(guards.cancelDialogNonEmpty === true, `discard confirmation dialog had no copy: ${JSON.stringify(guards)}`);
    assertCondition(guards.afterCancel.stayedOnI3 === true && guards.afterCancel.editorKeptDraft === true,
      `cancelling the discard dialog did not keep the draft on I3: ${JSON.stringify(guards.afterCancel)}`);
    assertCondition(guards.draftXSaved === true, `submitting the kept draft did not add the tag: ${JSON.stringify(guards)}`);
    assertCondition(guards.discardNavigatedToI1 === true, `confirming the discard dialog did not navigate to I1: ${JSON.stringify(guards)}`);
    const i3AfterGuards = await getAsset(ctx, first, ids.i3);
    assertCondition(JSON.stringify(i3AfterGuards.tags) === JSON.stringify([config.tagDraftX]),
      `I3.tags after the guard branches (got ${JSON.stringify(i3AfterGuards.tags)})`);

    // S6b: delete tagB through its chip's × button (no confirm dialog), then
    // re-check the persisted tags through the API.
    const removal = await ctx.runInPage(first, removeTagSource({ ...config, i1: ids.i1 }));
    assertCondition(removal.chipsAfter.includes(config.tagA) && !removal.chipsAfter.includes(config.tagB),
      `removing tagB via the × button left chips ${JSON.stringify(removal.chipsAfter)}`);
    assertCondition(removal.confirmOpen === false, "removing a tag raised a confirm dialog; expected immediate removal");
    const i1AfterDelete = await getAsset(ctx, first, ids.i1);
    assertCondition(JSON.stringify(i1AfterDelete.tags) === JSON.stringify([config.tagA]),
      `UI tag deletion did not leave exactly tagA (got ${JSON.stringify(i1AfterDelete.tags)})`);

    // S6c: tag overflow (任务 35) — 12 user tags collapse to the first 9 with a
    // "+3" toggle; keyboard focus + Enter expands it, deleting from either half
    // keeps the row and the counter consistent, the row resets to collapsed for a
    // different asset, and an add landing past the cap auto-expands.
    const overflowTags = Array.from({ length: 12 }, (_, index) => `insp-ov-${index + 1}-${stamp}`);
    await ctx.api(first.origin, "PATCH", `/api/assets/default/${encodeURIComponent(ids.i1)}`, { tags: overflowTags });
    const i1OverflowTags = (await getAsset(ctx, first, ids.i1)).tags;
    assertCondition(i1OverflowTags.length === 12, `server did not keep 12 tags: ${JSON.stringify(i1OverflowTags)}`);
    const overflowConfig = {
      ...config, i1: ids.i1, i2: ids.i2, expectedAll: i1OverflowTags, extraTag: `insp-ov-x-${stamp}`,
    };
    const overflow = await ctx.runInPage(first, tagOverflowSource(overflowConfig));
    assertCondition(JSON.stringify(overflow.collapsed.chips) === JSON.stringify(i1OverflowTags.slice(0, 9)),
      `collapsed row must show the first 9 of 12: ${JSON.stringify(overflow.collapsed.chips)}`);
    assertCondition(overflow.collapsed.toggle?.expanded === "false" && overflow.collapsed.toggle.text === "+3",
      `collapsed overflow toggle is wrong: ${JSON.stringify(overflow.collapsed.toggle)}`);
    assertCondition(overflow.collapsed.toggle.label.includes("3"), `collapsed toggle aria-label must carry the hidden count: ${JSON.stringify(overflow.collapsed.toggle)}`);
    // The accessible name must contain the visible text, so voice control can
    // target the toggle by what is on screen (WCAG 2.5.3 label in name).
    for (const state of [overflow.collapsed.toggle, overflow.expanded.toggle]) {
      assertCondition(state?.label.toLowerCase().includes(String(state?.text || "").toLowerCase()),
        `toggle aria-label must contain its visible text: ${JSON.stringify(state)}`);
    }
    assertCondition(overflow.keyboardFocus === true, "the +N toggle is not keyboard-focusable");
    assertCondition(JSON.stringify(overflow.expanded.chips) === JSON.stringify(i1OverflowTags),
      `expanded row must show all 12 tags: ${JSON.stringify(overflow.expanded.chips)}`);
    assertCondition(overflow.expanded.toggle?.expanded === "true" && ["收起", "Less"].includes(overflow.expanded.toggle.text),
      `expanded toggle is wrong: ${JSON.stringify(overflow.expanded.toggle)}`);
    assertCondition(JSON.stringify(overflow.afterHiddenDelete.chips) === JSON.stringify(i1OverflowTags.filter((tag) => tag !== overflow.removedHidden)),
      `deleting an expanded-only tag left wrong chips: ${JSON.stringify(overflow.afterHiddenDelete.chips)}`);
    assertCondition(overflow.afterHiddenDelete.toggle.expanded === "true", "deleting a tag collapsed the row; expansion must survive tag writes");
    const elevenTags = i1OverflowTags.filter((tag) => tag !== overflow.removedHidden);
    assertCondition(JSON.stringify(overflow.collapsedAgain.chips) === JSON.stringify(elevenTags.slice(0, 9)),
      `re-collapsed row must show the first 9 of 11: ${JSON.stringify(overflow.collapsedAgain.chips)}`);
    assertCondition(overflow.collapsedAgain.toggle.text === "+2", `re-collapsed toggle must read +2: ${JSON.stringify(overflow.collapsedAgain.toggle)}`);
    const tenTags = elevenTags.filter((tag) => tag !== overflow.removedVisible);
    assertCondition(JSON.stringify(overflow.afterVisibleDelete.chips) === JSON.stringify(tenTags.slice(0, 9)),
      `deleting a visible tag must slide the next hidden tag in: ${JSON.stringify(overflow.afterVisibleDelete.chips)}`);
    assertCondition(overflow.afterVisibleDelete.toggle.text === "+1", `toggle must read +1 after the visible delete: ${JSON.stringify(overflow.afterVisibleDelete.toggle)}`);
    assertCondition(overflow.afterVisibleDelete.focusAction === "remove-tag" && overflow.afterVisibleDelete.focusChip === tenTags[8],
      `focus must land on the slid-in tag's remove button: ${JSON.stringify(overflow.afterVisibleDelete)}`);
    assertCondition(JSON.stringify(overflow.afterSwitchBack.chips) === JSON.stringify(tenTags.slice(0, 9)) && overflow.afterSwitchBack.toggle.expanded === "false",
      `returning to the asset must reset the row to collapsed: ${JSON.stringify(overflow.afterSwitchBack)}`);
    assertCondition(overflow.afterAdd.chips.length === 11 && overflow.afterAdd.toggle.expanded === "true",
      `adding past the cap must auto-expand the row: ${JSON.stringify(overflow.afterAdd)}`);
    // API 复查只能在整段源码跑完后取一次终态（中间态留在页面侧断言里）；
    // 服务端会重排标签顺序，这里按集合比较。
    const i1FinalTags = await getAsset(ctx, first, ids.i1);
    const expectedFinalTags = [...tenTags, overflowConfig.extraTag];
    assertCondition(JSON.stringify([...i1FinalTags.tags].sort()) === JSON.stringify(expectedFinalTags.slice().sort()),
      `the overflow branch did not persist the expected final tags: ${JSON.stringify(i1FinalTags.tags)}`);
    // Restore I1's tags so S7 and the restart phase keep their preconditions.
    await ctx.api(first.origin, "PATCH", `/api/assets/default/${encodeURIComponent(ids.i1)}`, { tags: [config.tagA] });
    assertCondition(JSON.stringify((await getAsset(ctx, first, ids.i1)).tags) === JSON.stringify([config.tagA]),
      "restoring I1.tags after the overflow branch failed");

    // S7: search by tag text through the topbar search box.
    const search = await ctx.runInPage(first, tagSearchSource({ ...config, i1: ids.i1 }));
    assertCondition(JSON.stringify(search.tagAResults) === JSON.stringify([ids.i1]),
      `searching for the kept tag did not return exactly I1: ${JSON.stringify(search.tagAResults)}`);
    assertCondition(search.tagBResults.length === 0,
      `searching for the deleted tag still returned ${JSON.stringify(search.tagBResults)}`);
    assertCondition(search.restoredIds.length === 3, `clearing the search did not restore three cards: ${JSON.stringify(search.restoredIds)}`);
  } finally {
    await first.stop();
  }

  const second = await ctx.startServer();
  try {
    // Restart persistence, verified through the API first. A4a：配方字段不再经
    // UI 编辑，重启期望只保留标签与参考图权利。
    const expectations = {
      i1: { tags: [config.tagA] },
      i3: { tags: [config.tagDraftX] },
    };
    for (const [key, expected] of Object.entries(expectations)) {
      const asset = await getAsset(ctx, second, ids[key]);
      for (const [field, value] of Object.entries(expected)) {
        assertCondition(JSON.stringify(asset[field]) === JSON.stringify(value),
          `after restart ${key}.${field} is ${JSON.stringify(asset[field])}, expected ${JSON.stringify(value)}`);
      }
    }
    const restartReference = activeReference(await getAsset(ctx, second, ids.i1));
    const restartRights = restartReference.rights || {};
    assertCondition(restartRights.copyright === "owned" && restartRights.portrait_consent === "granted"
      && restartRights.redistribution === "allowed" && restartRights.attribution === config.attributionValue
      && Array.isArray(restartReference.allowed_uses) && restartReference.allowed_uses.includes("identity"),
      `after restart reference rights are ${JSON.stringify(restartReference)}`);

    // Then verify the reopened inspector actually shows the persisted state.
    // A4a：配方编辑区锁「不再渲染」；权利编辑器经浮层验证。
    const ui = await ctx.runInPage(second, persistenceUiSource({ ...config, i1: ids.i1 }));
    assertCondition(ui.recipeEditorRemoved === true, "after restart the recipe editor must stay removed");
    assertCondition(ui.rights.copyright === "owned" && ui.rights.portrait_consent === "granted" && ui.rights.redistribution === "allowed"
      && ui.rights.attribution === config.attributionValue && ui.rights.identityChipAllowed === true,
      `after restart the rights editor shows ${JSON.stringify(ui.rights)}`);

    // Tag-loss regression: in a fresh session the tags row must show the stored
    // tags, and adding one through the editor must keep them (the list API
    // once returned tags: [], so the editor merged into an empty list).
    const probe = await ctx.runInPage(second, tagWipeProbeSource({ ...config, i1: ids.i1 }));
    const tagsAfterProbe = (await getAsset(ctx, second, ids.i1)).tags;

    assertCondition(JSON.stringify(ui.tagChips) === JSON.stringify([config.tagA]),
      `after restart the tags row shows ${JSON.stringify(ui.tagChips)}, stored ${JSON.stringify([config.tagA])}`);
    const expectedAfterAdd = [config.tagA, config.tagC].sort();
    assertCondition(JSON.stringify([...(tagsAfterProbe || [])].sort()) === JSON.stringify(expectedAfterAdd),
      `adding a tag in a fresh session must keep the stored tags: stored after add ${JSON.stringify(tagsAfterProbe)}, `
      + `expected ${JSON.stringify(expectedAfterAdd)} (chips on open ${JSON.stringify(probe.chipsOnOpen)})`);
  } finally {
    await second.stop();
  }
  return { i1: ids.i1, i2: ids.i2, i3: ids.i3, stamp };
}

// ===== Node-side helpers =====

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function getAsset(ctx, server, assetId) {
  const payload = await ctx.api(server.origin, "GET", `/api/assets/default/${encodeURIComponent(assetId)}`);
  return payload.asset;
}

// allowed_uses/forbidden_uses live at the reference top level (lib/recipe-snapshot.mjs
// normalizeReferences), not inside `rights`.
function activeReference(asset) {
  const snapshots = Array.isArray(asset?.recipe_snapshots) ? asset.recipe_snapshots : [];
  const active = snapshots.find((snapshot) => snapshot.snapshot_id === asset.active_recipe_snapshot_id) || snapshots.at(-1) || null;
  return Array.isArray(active?.references) ? active.references[0] || {} : {};
}

async function seedAssets(ctx, config) {
  const first = await ctx.startServer();
  try {
    // Creation order matters for the "newest first" default sort: I2 (oldest,
    // rightmost column) then I1 (middle, holds references + business fields)
    // then I3 (newest, leftmost).
    const i2 = await ctx.api(first.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("i2.png", [74, 127, 181]), prompt: `inspector editing subject ${config.shotValue}`,
    });
    const i1 = await ctx.api(first.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("i1.png", [181, 68, 74]), prompt: `inspector editing hero ${config.shotValue}`,
      references: [{ asset_id: i2.asset.id, role: "subject", scope: ["style"] }],
    });
    const i3 = await ctx.api(first.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("i3.png", [58, 138, 87]), prompt: `inspector editing spare ${config.shotValue}`,
    });
    assertCondition(i1.asset?.id && i2.asset?.id && i3.asset?.id, "asset seeding failed");
    return { i1: i1.asset.id, i2: i2.asset.id, i3: i3.asset.id };
  } finally {
    await first.stop();
  }
}

// ===== In-page sources =====
// Every source runs in a fresh sandboxed renderer window: it must wait for the
// gallery, select the asset it needs, and return observed facts only.

const INSPECTOR_HELPERS = String.raw`
  const panel = () => document.querySelector('#detailPanel');
  const detailOpen = () => panel()?.getAttribute('aria-hidden') === 'false';
  const selectedId = () => document.querySelector('.asset-card.selected')?.dataset.id || '';
  const detailImageSrc = () => panel()?.querySelector('img.detail-image')?.getAttribute('src') || '';
  const confirmOpen = () => document.querySelector('#confirmDialog')?.classList.contains('open') || false;
  const dirtyFieldCount = () => panel()?.querySelectorAll('[data-detail-dirty="true"]').length || 0;
  const tagChips = () => [...(panel()?.querySelectorAll('.detail-tag[data-tag-value]') || [])].map((node) => node.dataset.tagValue);
  const inputValue = (selector) => panel()?.querySelector(selector)?.value ?? null;
  async function waitCards(count) {
    await waitFor(() => gallerySettled() && rootCardIds().length === count, count + ' cards settled');
  }
  async function clickCard(assetId) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const button = document.querySelector(cardSelector(assetId) + ' .asset-card-select');
      if (button?.isConnected) { button.click(); return; }
      await sleep(100);
    }
    throw new Error('Timed out clicking card ' + assetId);
  }
  async function openDetailFor(assetId) {
    await clickCard(assetId);
    await waitFor(() => detailOpen() && selectedId() === assetId && detailImageSrc().includes(assetId), 'detail shows ' + assetId);
  }
  // GravityPort A4a：配方编辑 disclosure 已拿掉——锁「不再渲染」（不得回来）。
  async function assertRecipeEditorAbsent() {
    const editor = panel()?.querySelector('[data-edit="skill"], [data-action="save-recipe"], [data-recipe-change]');
    if (editor) throw new Error('Recipe editor must stay removed, found ' + (editor.outerHTML || '').slice(0, 120));
    if ((panel()?.querySelectorAll('[data-edit]') || []).length) throw new Error('data-edit fields must stay removed');
  }
  // A4a：参考图权利编辑器经「查看」浮层打开（不再是来源 disclosure 内嵌）。
  async function openRightsEditor() {
    const trigger = panel()?.querySelector('[data-inspector-section="reference"] [data-action="open-reference-overlay"]');
    if (!trigger) throw new Error('Missing reference overlay trigger');
    trigger.click();
    await waitFor(() => panel()?.querySelector('[data-gp-overlay]:not([hidden]) [data-reference-rights] .reference-row'), 'reference rights rows inside the overlay');
  }
  function setSelectValue(selector, value) {
    const element = panel()?.querySelector(selector);
    if (!element) throw new Error('Missing select ' + selector);
    element.focus();
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return element.value;
  }
  function editBusinessFields(mutate) {
    const field = panel()?.querySelector('[data-edit="business_fields"]');
    if (!field) throw new Error('Missing business_fields editor');
    const parsed = JSON.parse(field.value || '{}');
    mutate(parsed);
    field.focus();
    field.value = JSON.stringify(parsed, null, 2);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function addTagViaEditor(value) {
    click('[data-action="add-tag"]');
    await waitFor(() => panel()?.querySelector('[data-tag-editor] input'), 'tag editor input');
    setValue('[data-tag-editor] input', value);
    click('[data-tag-editor] button[type="submit"]');
    await waitFor(() => panel()?.querySelector('.detail-tag[data-tag-value="' + value + '"]'), 'tag chip ' + value);
    await waitFor(() => panel()?.querySelector('[data-action="add-tag"]'), 'tag add button restored');
  }
`;

function openCloseSwitchSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    ${INSPECTOR_HELPERS}
    await waitCards(3);
    await openDetailFor(config.i1);
    const openedFacts = { open: detailOpen(), imageSrc: detailImageSrc(), selected: selectedId() };
    click('[data-action="close-detail"]');
    await waitFor(() => !detailOpen(), 'detail closed via close-detail');
    const openButton = document.querySelector('#openInspectorBtn');
    const closedFacts = { open: detailOpen(), openButtonVisible: Boolean(openButton) && !openButton.hidden };
    click('#openInspectorBtn');
    await waitFor(() => detailOpen() && detailImageSrc().includes(config.i1), 'detail reopened with i1');
    // A4a：配方编辑区已拿掉——箭头键切走时不该有任何草稿语义（无确认框）。
    await assertRecipeEditorAbsent();
    const grid = document.querySelector('#assetGrid');
    let arrowTarget = '';
    for (const key of ['ArrowRight', 'ArrowLeft']) {
      grid.focus();
      grid.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      try {
        await waitFor(() => selectedId() && selectedId() !== config.i1 && detailImageSrc().includes(selectedId()), key + ' moved selection', 4000);
        arrowTarget = selectedId();
        break;
      } catch {}
    }
    if (!arrowTarget) throw new Error('Arrow-key navigation did not move the selection off ' + config.i1);
    const dialogDuringSwitch = confirmOpen();
    if (arrowTarget !== config.i2) await openDetailFor(config.i2);
    await waitFor(() => detailOpen() && detailImageSrc().includes(config.i2) && selectedId() === config.i2, 'detail shows i2');
    const i2Facts = {
      selected: selectedId(),
      imageOk: detailImageSrc().includes(config.i2),
      editFieldCount: (panel()?.querySelectorAll('[data-edit]') || []).length,
      confirmOpen: confirmOpen(),
    };
    return { initialIds: rootCardIds(), openedFacts, closedFacts, arrowTarget, dialogDuringSwitch, i2Facts, rendererErrors: rendererErrors.slice(0, 3) };
  })()`;
}

// A4a：配方编辑 disclosure 不再渲染——在两个素材上分别锁「不得回来」。
function recipeEditorRemovedSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    ${INSPECTOR_HELPERS}
    await waitCards(3);
    await openDetailFor(config.i1);
    await assertRecipeEditorAbsent();
    const removedOnI1 = true;
    await openDetailFor(config.i3);
    await assertRecipeEditorAbsent();
    const removedOnI3 = true;
    return { removedOnI1, removedOnI3 };
  })()`;
}

function referenceRightsSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    ${INSPECTOR_HELPERS}
    await waitCards(3);
    await openDetailFor(config.i1);
    // A4a：权利编辑器经「查看」浮层打开（INSPECTOR_HELPERS.openRightsEditor）。
    await openRightsEditor();
    setSelectValue('[data-reference-index="0"][data-reference-field="copyright"]', 'owned');
    setSelectValue('[data-reference-index="0"][data-reference-field="portrait_consent"]', 'granted');
    setSelectValue('[data-reference-index="0"][data-reference-field="redistribution"]', 'allowed');
    setValue('[data-reference-index="0"][data-reference-field="attribution"]', config.attributionValue);
    panel().querySelector('[data-reference-index="0"][data-reference-use="identity"]').click();
    const chipClass = panel().querySelector('[data-reference-index="0"][data-reference-use="identity"]')?.className || '';
    click('[data-action="save-reference-rights"]');
    await waitFor(() => !panel().querySelector('[data-reference-rights-section][data-reference-dirty="true"]'), 'reference rights saved (overlay stays open)');
    return {
      identityChipAllowed: chipClass.includes('allowed'),
      dirtyCleared: !panel().querySelector('[data-reference-rights-section][data-reference-dirty="true"]'),
      stateBadge: panel().querySelector('[data-reference-state="0"]')?.textContent || '',
      confirmOpen: confirmOpen(),
    };
  })()`;
}

function addTagsSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    ${INSPECTOR_HELPERS}
    await waitCards(3);
    await openDetailFor(config.i1);
    await addTagViaEditor(config.tagA);
    await addTagViaEditor(config.tagB);
    return { chips: tagChips(), confirmOpen: confirmOpen() };
  })()`;
}

// Delete one tag through its chip's × button. Guards: the control is a real
// <button> with an aria-label, and the source tag exposes no remove entry.
function removeTagSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    ${INSPECTOR_HELPERS}
    await waitCards(3);
    await openDetailFor(config.i1);
    const chipSelector = '.detail-tag[data-tag-value="' + config.tagB + '"]';
    const removeButton = panel()?.querySelector(chipSelector + ' [data-action="remove-tag"]');
    if (!removeButton) throw new Error('Missing remove button for ' + config.tagB);
    if (removeButton.tagName !== 'BUTTON' || removeButton.getAttribute('type') !== 'button') {
      throw new Error('Remove control is not a type=button <button>');
    }
    if (!(removeButton.getAttribute('aria-label') || '').trim()) throw new Error('Remove button has no aria-label');
    if (!removeButton.getAttribute('aria-label').includes(config.tagB)) {
      throw new Error('Remove button aria-label does not name the tag: ' + removeButton.getAttribute('aria-label'));
    }
    if (panel()?.querySelector('.detail-source-tag button, button.detail-source-tag')) {
      throw new Error('Source tag exposes a remove button');
    }
    removeButton.click();
    await waitFor(() => !panel()?.querySelector(chipSelector), 'tagB chip removed');
    await waitFor(() => panel()?.querySelector('[data-action="add-tag"]'), 'tags row re-rendered with the add button');
    const chipsAfter = tagChips();
    const focusAfter = document.activeElement?.dataset?.action || '';
    return { chipsAfter, focusAfter, confirmOpen: confirmOpen() };
  })()`;
}

// 12-tag overflow branch (任务 35): the 9-cap with a "+N" toggle, keyboard
// expand, deletes from both halves, per-asset reset, add-past-cap auto-expand.
// The sandboxed renderer cannot synthesize a trusted Enter keystroke (browsers
// only activate buttons from trusted events), so the keydown is dispatched to
// document the keyboard path and activation goes through the same click
// handler; focusability of the real button is asserted separately.
function tagOverflowSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    ${INSPECTOR_HELPERS}
    const toggle = () => panel()?.querySelector('[data-action="toggle-tags"]');
    const toggleInfo = () => {
      const node = toggle();
      return node ? {
        expanded: node.getAttribute('aria-expanded'),
        text: node.textContent.trim(),
        label: node.getAttribute('aria-label') || '',
      } : null;
    };
    const chipRemoveButton = (tagValue) => panel()?.querySelector('.detail-tag[data-tag-value="' + CSS.escape(tagValue) + '"] [data-action="remove-tag"]');
    const focusedChip = () => document.activeElement?.closest('.detail-tag')?.dataset.tagValue || '';
    await waitCards(3);
    await openDetailFor(config.i1);
    const collapsed = { chips: tagChips(), toggle: toggleInfo() };
    toggle().focus();
    const keyboardFocus = document.activeElement === toggle();
    toggle().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    toggle().click();
    await waitFor(() => toggleInfo()?.expanded === 'true', 'tags expanded via Enter');
    const expanded = { chips: tagChips(), toggle: toggleInfo() };
    // Expanded: delete a tag that was hidden while collapsed.
    const removedHidden = config.expectedAll[9];
    chipRemoveButton(removedHidden).click();
    await waitFor(() => !panel()?.querySelector('.detail-tag[data-tag-value="' + CSS.escape(removedHidden) + '"]'), 'hidden tag removed');
    const afterHiddenDelete = { chips: tagChips(), toggle: toggleInfo() };
    // Collapse, then delete a visible tag: the next hidden tag slides in.
    toggle().click();
    await waitFor(() => toggleInfo()?.expanded === 'false', 'tags collapsed again');
    const collapsedAgain = { chips: tagChips(), toggle: toggleInfo() };
    const removedVisible = config.expectedAll[8];
    chipRemoveButton(removedVisible).click();
    await waitFor(() => !panel()?.querySelector('.detail-tag[data-tag-value="' + CSS.escape(removedVisible) + '"]'), 'visible tag removed');
    const afterVisibleDelete = { chips: tagChips(), toggle: toggleInfo(), focusAction: document.activeElement?.dataset?.action || '', focusChip: focusedChip() };
    // Switch away and back: the row must come back collapsed.
    await clickCard(config.i2);
    await waitFor(() => detailOpen() && detailImageSrc().includes(config.i2), 'detail shows i2');
    await clickCard(config.i1);
    await waitFor(() => detailOpen() && detailImageSrc().includes(config.i1), 'detail shows i1 again');
    const afterSwitchBack = { chips: tagChips(), toggle: toggleInfo() };
    // Collapsed and adding past the cap: auto-expand so the new tag is visible.
    await addTagViaEditor(config.extraTag);
    const afterAdd = { chips: tagChips(), toggle: toggleInfo() };
    return { collapsed, keyboardFocus, expanded, removedHidden, removedVisible, afterHiddenDelete, collapsedAgain, afterVisibleDelete, afterSwitchBack, afterAdd };
  })()`;
}

function autosaveSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    ${INSPECTOR_HELPERS}
    await waitCards(3);
    await openDetailFor(config.i2);
    await assertRecipeEditorAbsent();
    await clickCard(config.i3);
    await waitFor(() => detailOpen() && detailImageSrc().includes(config.i3) && selectedId() === config.i3, 'detail shows i3');
    const afterSwitch = {
      selected: selectedId(),
      confirmOpen: confirmOpen(),
      dirtyFields: dirtyFieldCount(),
    };
    const editFieldCount = (panel()?.querySelectorAll('[data-edit]') || []).length;
    return { afterSwitch, editFieldCount };
  })()`;
}

function tagDraftGuardSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    ${INSPECTOR_HELPERS}
    await waitCards(3);
    await openDetailFor(config.i3);
    // Branch 1: cancel the discard dialog, keep editing, submit the draft.
    click('[data-action="add-tag"]');
    await waitFor(() => panel()?.querySelector('[data-tag-editor] input'), 'tag editor input');
    setValue('[data-tag-editor] input', config.tagDraftX);
    await clickCard(config.i1);
    const dialogCopy = await answerConfirmDialog({ confirm: false });
    const afterCancel = {
      stayedOnI3: detailOpen() && detailImageSrc().includes(config.i3) && selectedId() === config.i3,
      editorKeptDraft: inputValue('[data-tag-editor] input') === config.tagDraftX,
    };
    click('[data-tag-editor] button[type="submit"]');
    await waitFor(() => panel()?.querySelector('.detail-tag[data-tag-value="' + config.tagDraftX + '"]'), 'draft-x chip saved');
    // Sample now: branch 2 re-renders the panel for I1, which has its own tags.
    const draftXSaved = Boolean(panel().querySelector('.detail-tag[data-tag-value="' + config.tagDraftX + '"]'));
    // Branch 2: confirm the discard dialog; navigation proceeds, draft is lost.
    click('[data-action="add-tag"]');
    await waitFor(() => panel()?.querySelector('[data-tag-editor] input'), 'tag editor input again');
    setValue('[data-tag-editor] input', config.tagDraftY);
    await clickCard(config.i1);
    await answerConfirmDialog({ confirm: true });
    await waitFor(() => detailOpen() && detailImageSrc().includes(config.i1) && selectedId() === config.i1, 'detail shows i1 after discard');
    return {
      cancelDialogNonEmpty: Boolean(dialogCopy && dialogCopy.trim()),
      dialogCopy,
      afterCancel,
      draftXSaved,
      discardNavigatedToI1: true,
      rendererErrors: rendererErrors.slice(0, 3),
    };
  })()`;
}

function tagSearchSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    ${INSPECTOR_HELPERS}
    await waitCards(3);
    setValue('#searchInput', config.tagA);
    await waitFor(() => gallerySettled() && JSON.stringify(rootCardIds()) === JSON.stringify([config.i1]), 'tag search returns I1');
    const tagAResults = rootCardIds();
    setValue('#searchInput', '');
    await waitCards(3);
    setValue('#searchInput', config.tagB);
    await waitFor(() => gallerySettled() && rootCardIds().length === 0, 'deleted tag search is empty');
    const tagBResults = rootCardIds();
    setValue('#searchInput', '');
    await waitCards(3);
    return { tagAResults, tagBResults, restoredIds: rootCardIds() };
  })()`;
}

// Fresh-session tag probe: read the tags row as first opened,
// then add one tag through the editor and report what the editor merged into.
function tagWipeProbeSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    ${INSPECTOR_HELPERS}
    await waitCards(3);
    await openDetailFor(config.i1);
    const chipsOnOpen = tagChips();
    await addTagViaEditor(config.tagC);
    return { chipsOnOpen, chipsAfterAdd: tagChips() };
  })()`;
}

function persistenceUiSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    ${INSPECTOR_HELPERS}
    await waitCards(3);
    await openDetailFor(config.i1);
    await assertRecipeEditorAbsent();
    const recipeEditorRemoved = true;
    // A4a：权利编辑器经「查看」浮层打开，重启后持久化值照常显示。
    await openRightsEditor();
    const rights = {
      copyright: inputValue('[data-reference-index="0"][data-reference-field="copyright"]'),
      portrait_consent: inputValue('[data-reference-index="0"][data-reference-field="portrait_consent"]'),
      redistribution: inputValue('[data-reference-index="0"][data-reference-field="redistribution"]'),
      attribution: inputValue('[data-reference-index="0"][data-reference-field="attribution"]'),
      identityChipAllowed: (panel().querySelector('[data-reference-index="0"][data-reference-use="identity"]')?.className || '').includes('allowed'),
    };
    return { recipeEditorRemoved, rights, tagChips: tagChips() };
  })()`;
}
