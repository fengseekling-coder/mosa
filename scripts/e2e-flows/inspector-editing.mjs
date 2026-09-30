// Inspector editing flow: seed three assets through the API, then exercise every
// editable control in the web inspector (aside from favorite + prompt/recipe-change
// summary, which the critical web flow already covers, and the clipboard copy
// actions, which are out of scope for this task).
//
// 摸底清单（web/app/inspector-markup.mjs + app.mjs）：
// - 配方/元数据字段（配方与编辑 disclosure，data-edit + save-recipe）：prompt（关键流程已测，跳过）、
//   skill、style、ratio、theme、group、category（select）、rating（星级按钮）、
//   business_fields（JSON textarea）→ 本流程全覆盖。
// - 标签：add-tag 打开内联编辑器，submit 即时 PATCH；用户标签 chip 内的 × 按钮
//   （data-action="remove-tag"，来源标签没有此按钮）直接删除并整体 PATCH tags，
//   不弹确认框 → 添加与删除本流程都覆盖。
// - 参考图权利：open-reference-rights 打开（或展开来源 disclosure），copyright /
//   portrait_consent / redistribution 下拉、attribution 输入、use-chip 循环点击，
//   save-reference-rights 或 1.2s 停顿自动保存 → 本流程覆盖。
// - 收藏与 prompt/data-recipe-change 编辑：关键流程已覆盖 → 跳过。
// - 复制提示词/来源/指令：动系统剪贴板 → 按任务书不测。
// - 未保存草稿语义：recipe/reference 脏草稿在导航/搜索前静默冲刷（自动保存），
//   不弹确认框；tags 编辑器与版本说明是手动保存作用域，导航前弹「放弃修改」确认框，
//   取消则留在原地 → 两个分支都测。
//
// - 标签回归：列表接口曾不带 tags，检视器在新会话里显示空标签行，加标签时
//   以空列表为合并基数，把已有标签整体清掉（数据丢失）。重启阶段的探针守住它。

import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "inspector-editing";
export const description = "Inspector open/close/switch, tags, metadata fields, reference rights, autosave + discard guards, restart persistence";

export async function run(ctx) {
  await ctx.prepare();
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const config = {
    styleValue: `insp-style-${stamp}`,
    skillValue: `insp-skill-${stamp}`,
    ratioValue: "3:2",
    themeValue: `insp-theme-${stamp}`,
    groupValue: `insp-group-${stamp}`,
    skill2Value: `insp-skill2-${stamp}`,
    skill3Value: `insp-skill3-${stamp}`,
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
    // S1: open/close/reopen, keyboard switch with an unsaved style edit.
    const openClose = await ctx.runInPage(first, openCloseSwitchSource({ ...config, i1: ids.i1, i2: ids.i2 }));
    assertCondition(openClose.initialIds.length === 3, `expected three seeded cards, got ${JSON.stringify(openClose.initialIds)}`);
    assertCondition(openClose.openedFacts.open === true && openClose.openedFacts.imageSrc.includes(ids.i1),
      `inspector did not open with I1: ${JSON.stringify(openClose.openedFacts)}`);
    assertCondition(openClose.closedFacts.open === false && openClose.closedFacts.openButtonVisible === true,
      `close-detail did not close the inspector / reveal the open button: ${JSON.stringify(openClose.closedFacts)}`);
    assertCondition(openClose.arrowTarget && openClose.arrowTarget !== ids.i1,
      `arrow-key navigation did not move the selection off I1: ${JSON.stringify(openClose)}`);
    assertCondition(openClose.dialogDuringSwitch === false, "a confirm dialog appeared for a recipe-scope draft; expected a silent autosave flush");
    assertCondition(openClose.i2Facts.selected === ids.i2 && openClose.i2Facts.imageOk === true,
      `inspector did not follow the switch to I2: ${JSON.stringify(openClose.i2Facts)}`);
    assertCondition(openClose.i2Facts.styleValue === "" && openClose.i2Facts.dirtyFields === 0,
      `I1's unsaved edit leaked into I2's panel: ${JSON.stringify(openClose.i2Facts)}`);
    // The silent flush before navigation must have persisted I1's style edit.
    const i1AfterFlush = await getAsset(ctx, first, ids.i1);
    assertCondition(i1AfterFlush.style === config.styleValue,
      `flush-on-switch did not save I1.style (expected ${config.styleValue}, got ${JSON.stringify(i1AfterFlush.style)})`);

    // S2: every non-prompt recipe/metadata field: edit -> save-recipe -> observed.
    const metadata = await ctx.runInPage(first, metadataFieldsSource({ ...config, i1: ids.i1 }));
    assertCondition(metadata.dirtyAfterSave === 0, `recipe draft still dirty after save: ${JSON.stringify(metadata)}`);
    const i1AfterMetadata = await getAsset(ctx, first, ids.i1);
    for (const [field, expected] of [
      ["skill", config.skillValue],
      ["style", config.styleValue],
      ["ratio", config.ratioValue],
      ["theme", config.themeValue],
      ["group", config.groupValue],
      ["category", "concept"],
      ["rating", 4],
    ]) {
      assertCondition(i1AfterMetadata[field] === expected,
        `I1.${field} not saved via inspector (expected ${JSON.stringify(expected)}, got ${JSON.stringify(i1AfterMetadata[field])})`);
    }
    assertCondition(i1AfterMetadata.business_fields?.shot === config.shotValue && i1AfterMetadata.business_fields?.campaign === "inspector editing",
      `I1.business_fields not saved via inspector: ${JSON.stringify(i1AfterMetadata.business_fields)}`);

    // S3: reference rights editor: selects + attribution + use chip -> save.
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

    // S5: unsaved recipe edit flushed when switching to I3, then the pure
    // debounce autosave on I3 without any navigation.
    const autosave = await ctx.runInPage(first, autosaveSource({ ...config, i2: ids.i2, i3: ids.i3 }));
    assertCondition(autosave.afterSwitch.selected === ids.i3 && autosave.afterSwitch.confirmOpen === false,
      `switching with an unsaved draft did not land on I3 / raised a dialog: ${JSON.stringify(autosave.afterSwitch)}`);
    assertCondition(autosave.afterSwitch.skillShown !== config.skill2Value,
      `I2's unsaved skill leaked into I3's panel: ${JSON.stringify(autosave.afterSwitch)}`);
    assertCondition(autosave.autosaved === true, `debounced autosave did not clear the dirty draft: ${JSON.stringify(autosave)}`);
    const i2AfterFlush = await getAsset(ctx, first, ids.i2);
    assertCondition(i2AfterFlush.skill === config.skill2Value,
      `switch-flush did not save I2.skill (got ${JSON.stringify(i2AfterFlush.skill)})`);
    const i3AfterAutosave = await getAsset(ctx, first, ids.i3);
    assertCondition(i3AfterAutosave.skill === config.skill3Value,
      `debounced autosave did not save I3.skill (got ${JSON.stringify(i3AfterAutosave.skill)})`);

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
    // Restart persistence, verified through the API first.
    const expectations = {
      i1: { style: config.styleValue, skill: config.skillValue, ratio: config.ratioValue, theme: config.themeValue, group: config.groupValue, category: "concept", rating: 4, tags: [config.tagA] },
      i2: { skill: config.skill2Value },
      i3: { skill: config.skill3Value, tags: [config.tagDraftX] },
    };
    for (const [key, expected] of Object.entries(expectations)) {
      const asset = await getAsset(ctx, second, ids[key]);
      for (const [field, value] of Object.entries(expected)) {
        assertCondition(JSON.stringify(asset[field]) === JSON.stringify(value),
          `after restart ${key}.${field} is ${JSON.stringify(asset[field])}, expected ${JSON.stringify(value)}`);
      }
    }
    assertCondition(await getAsset(ctx, second, ids.i1).then((asset) => asset.business_fields?.shot) === config.shotValue,
      "after restart I1.business_fields.shot is missing");
    const restartReference = activeReference(await getAsset(ctx, second, ids.i1));
    const restartRights = restartReference.rights || {};
    assertCondition(restartRights.copyright === "owned" && restartRights.portrait_consent === "granted"
      && restartRights.redistribution === "allowed" && restartRights.attribution === config.attributionValue
      && Array.isArray(restartReference.allowed_uses) && restartReference.allowed_uses.includes("identity"),
      `after restart reference rights are ${JSON.stringify(restartReference)}`);

    // Then verify the reopened inspector actually shows the persisted state.
    const ui = await ctx.runInPage(second, persistenceUiSource({ ...config, i1: ids.i1 }));
    assertCondition(ui.recipe.skill === config.skillValue && ui.recipe.style === config.styleValue
      && ui.recipe.ratio === config.ratioValue && ui.recipe.theme === config.themeValue,
      `after restart the inspector shows ${JSON.stringify(ui.recipe)}`);
    assertCondition(ui.recipe.group === config.groupValue && ui.recipe.category === "concept" && ui.recipe.ratingOn === 4,
      `after restart the inspector shows ${JSON.stringify(ui.recipe)}`);
    assertCondition(ui.recipe.businessFields?.shot === config.shotValue, `after restart business_fields editor shows ${JSON.stringify(ui.recipe.businessFields)}`);
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
      skill: "", style: "", ratio: "", theme: "",
      business_fields: { campaign: "inspector editing", width: 32, height: 24 },
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
  async function openRecipeDisclosure() {
    const summary = panel()?.querySelector('[data-inspector-section="prompt"] details.detail-disclosure > summary');
    if (!summary) throw new Error('Missing recipe disclosure summary');
    summary.click();
    await waitFor(() => panel()?.querySelector('[data-edit="skill"]'), 'recipe editor fields');
  }
  async function saveRecipeDraft() {
    click('[data-action="save-recipe"]');
    await waitFor(() => dirtyFieldCount() === 0, 'recipe draft saved');
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
  async function openRightsEditor() {
    const sourceSummary = panel()?.querySelector('[data-inspector-section="source"] details.detail-source-disclosure > summary');
    if (!sourceSummary) throw new Error('Missing source disclosure summary');
    sourceSummary.click();
    const rightsSummary = panel()?.querySelector('[data-reference-rights-section] > summary');
    if (!rightsSummary) throw new Error('Missing reference rights disclosure');
    rightsSummary.click();
    // The rights editor renders only after /recipes history arrives.
    await waitFor(() => panel()?.querySelector('[data-reference-rights] .reference-row'), 'reference rights rows');
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
    // Unsaved recipe-scope edit on I1, then leave via the arrow keys: the code
    // flushes the draft silently instead of raising the discard dialog.
    setValue('[data-edit="style"]', config.styleValue);
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
      styleValue: inputValue('[data-edit="style"]'),
      dirtyFields: dirtyFieldCount(),
      confirmOpen: confirmOpen(),
    };
    return { initialIds: rootCardIds(), openedFacts, closedFacts, arrowTarget, dialogDuringSwitch, i2Facts, rendererErrors: rendererErrors.slice(0, 3) };
  })()`;
}

function metadataFieldsSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    ${INSPECTOR_HELPERS}
    await waitCards(3);
    await openDetailFor(config.i1);
    await openRecipeDisclosure();
    const observed = { styleRoundTrip: inputValue('[data-edit="style"]') };
    const edit = (selector, value) => { setValue(selector, value); return inputValue(selector); };
    observed.skill = edit('[data-edit="skill"]', config.skillValue);
    observed.ratio = edit('[data-edit="ratio"]', config.ratioValue);
    observed.theme = edit('[data-edit="theme"]', config.themeValue);
    await saveRecipeDraft();
    observed.group = edit('[data-edit="group"]', config.groupValue);
    observed.category = setSelectValue('[data-edit="category"]', 'concept');
    panel().querySelector('[data-edit="rating"] button[data-val="4"]').click();
    observed.ratingOn = panel().querySelectorAll('[data-edit="rating"] button.on').length;
    observed.businessFieldsBefore = JSON.parse(panel().querySelector('[data-edit="business_fields"]').value || '{}');
    editBusinessFields((fields) => { fields.shot = config.shotValue; });
    await saveRecipeDraft();
    observed.dirtyAfterSave = dirtyFieldCount();
    return observed;
  })()`;
}

function referenceRightsSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    ${INSPECTOR_HELPERS}
    await waitCards(3);
    await openDetailFor(config.i1);
    await openRightsEditor();
    setSelectValue('[data-reference-index="0"][data-reference-field="copyright"]', 'owned');
    setSelectValue('[data-reference-index="0"][data-reference-field="portrait_consent"]', 'granted');
    setSelectValue('[data-reference-index="0"][data-reference-field="redistribution"]', 'allowed');
    setValue('[data-reference-index="0"][data-reference-field="attribution"]', config.attributionValue);
    panel().querySelector('[data-reference-index="0"][data-reference-use="identity"]').click();
    const chipClass = panel().querySelector('[data-reference-index="0"][data-reference-use="identity"]')?.className || '';
    click('[data-action="save-reference-rights"]');
    await waitFor(() => !panel().querySelector('[data-reference-rights-section][data-reference-dirty="true"]'), 'reference rights saved');
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

function autosaveSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    ${INSPECTOR_HELPERS}
    await waitCards(3);
    await openDetailFor(config.i2);
    setValue('[data-edit="skill"]', config.skill2Value);
    await clickCard(config.i3);
    await waitFor(() => detailOpen() && detailImageSrc().includes(config.i3) && selectedId() === config.i3, 'detail shows i3');
    const afterSwitch = {
      selected: selectedId(),
      confirmOpen: confirmOpen(),
      dirtyFields: dirtyFieldCount(),
      skillShown: inputValue('[data-edit="skill"]'),
    };
    // Pure debounce autosave: edit I3 and stay put; the dirty flag must clear
    // on its own once the 1.2s autosave PATCH lands.
    setValue('[data-edit="skill"]', config.skill3Value);
    let autosaved = true;
    try {
      await waitFor(() => dirtyFieldCount() === 0, 'i3 skill autosaved by debounce', 8000);
    } catch {
      autosaved = false;
    }
    const autosaveStatus = [...(panel()?.querySelectorAll('[data-autosave-status]') || [])].map((node) => node.textContent);
    return { afterSwitch, autosaved, autosaveStatus };
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
    await openRecipeDisclosure();
    const recipe = {
      skill: inputValue('[data-edit="skill"]'),
      style: inputValue('[data-edit="style"]'),
      ratio: inputValue('[data-edit="ratio"]'),
      theme: inputValue('[data-edit="theme"]'),
      group: inputValue('[data-edit="group"]'),
      category: panel().querySelector('[data-edit="category"]')?.value ?? null,
      ratingOn: panel().querySelectorAll('[data-edit="rating"] button.on').length,
      businessFields: JSON.parse(panel().querySelector('[data-edit="business_fields"]')?.value || '{}'),
    };
    await openRightsEditor();
    const rights = {
      copyright: inputValue('[data-reference-index="0"][data-reference-field="copyright"]'),
      portrait_consent: inputValue('[data-reference-index="0"][data-reference-field="portrait_consent"]'),
      redistribution: inputValue('[data-reference-index="0"][data-reference-field="redistribution"]'),
      attribution: inputValue('[data-reference-index="0"][data-reference-field="attribution"]'),
      identityChipAllowed: (panel().querySelector('[data-reference-index="0"][data-reference-use="identity"]')?.className || '').includes('allowed'),
    };
    return { recipe, rights, tagChips: tagChips() };
  })()`;
}
