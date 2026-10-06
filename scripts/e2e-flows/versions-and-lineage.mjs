// E2E flow: asset version history (tree / switch / compare), manual generation
// relations created and removed from the inspector, rule-derived relation
// candidates confirmed and dismissed, the context navigation entry, then a
// restart to prove versions and deletions persist.
// GravityPort A4a（任务 73）：版本工作流（选择器/版本历史/对比/生成树）搬进版本树
// 浮层——所有树/关系操作前先点版本区块的「查看」；来源区块（含「查看整个会话」
// 「查看同一批次」按钮）已从检视器拿掉，session/batch 导航锁「不再渲染」，
// 「查看上下文」经浮层照常验。

import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "versions-and-lineage";
export const description = "version tree/switch/compare -> generation relation create/save/delete -> candidate confirm/dismiss -> session/batch/context navigation -> restart persistence";

const CONVERSATION = "conv-e2e-lineage";
const CANDIDATE_CONVERSATION = "conv-e2e-candidates";
const RELATION_PROVIDER = "e2e-flow";
const MSG_L1 = "msg-e2e-l1";
const MSG_L2 = "msg-e2e-l2";
const THEMES = {
  r0: "版本链基线",
  r1: "版本链第一版",
  r2: "版本链第二版",
  l1: "生成父图L1",
  l2: "生成子图L2",
  ga: "候选祖图GA",
  gb: "候选子图GB",
  gc: "候选孙图GC",
};

// In-page helpers beyond _page-helpers.mjs: inspector navigation scoped to the
// detail panel's version and generation-history regions.
const INSPECTOR_HELPERS = String.raw`
  const detailPanel = () => document.querySelector('#detailPanel');
  const genRegion = () => detailPanel()?.querySelector('[data-generation-history]');
  const genNode = (eventId) => genRegion()?.querySelector('.generation-lineage-node[data-generation-id="' + eventId + '"]');
  const management = (eventId) => genNode(eventId)?.querySelector('.generation-management-disclosure');
  const setSelect = (select, value) => {
    if (!select) throw new Error('Missing select control for value ' + value);
    select.focus();
    select.value = value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select;
  };
  const openInspectorDisclosure = (selector) => {
    const disclosure = [...(detailPanel()?.querySelectorAll('details') || [])].find((entry) => entry.querySelector(selector));
    if (!disclosure) throw new Error('Missing inspector disclosure containing ' + selector);
    if (!disclosure.open) disclosure.querySelector('summary').click();
    return disclosure;
  };
  // GravityPort A4a：版本树浮层——版本选择器 / 版本历史 / 对比 / 生成树都在里面。
  const versionOverlayVisible = () => {
    const overlay = detailPanel()?.querySelector('[data-gp-overlay]');
    return Boolean(overlay) && !overlay.hidden && Boolean(overlay.querySelector('[data-gp-overlay-body="version"]:not([hidden])'));
  };
  async function openVersionOverlay() {
    const trigger = detailPanel()?.querySelector('[data-inspector-section="version"] [data-action="open-version-overlay"]');
    if (!trigger) throw new Error('Missing version overlay trigger');
    trigger.click();
    await waitFor(() => versionOverlayVisible(), 'version overlay opens');
  }
  async function openInspector(assetId) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const trigger = document.querySelector(cardSelector(assetId) + ' .asset-card-select');
      if (trigger?.isConnected) {
        trigger.click();
        const localDeadline = Date.now() + 1200;
        while (Date.now() < localDeadline) {
          const selected = document.querySelector('.asset-card.selected');
          const title = detailPanel()?.querySelector('#detailTitle');
          if (selected?.dataset.id === assetId && title?.isConnected && detailPanel()?.querySelector('[data-inspector-section="file"]')) return;
          await sleep(50);
        }
      }
      await sleep(100);
    }
    throw new Error('Timed out opening inspector for ' + assetId + ' diagnostic=' + JSON.stringify(pageDiagnostic()));
  }
  async function openGenerationNode(eventId) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const target = genNode(eventId);
      if (target?.isConnected) {
        if (!target.open) target.querySelector('summary').click();
        if (target.open) return;
      }
      await sleep(100);
    }
    throw new Error('Timed out opening generation node ' + eventId + ' diagnostic=' + JSON.stringify(pageDiagnostic()));
  }
  async function openManagement(eventId) {
    await openGenerationNode(eventId);
    const disclosure = management(eventId);
    if (!disclosure) throw new Error('Generation node ' + eventId + ' has no management disclosure');
    if (!disclosure.open) disclosure.querySelector('summary').click();
    return disclosure;
  }
  async function waitForGenerationTree(eventId) {
    await waitFor(() => genNode(eventId) && !genRegion().querySelector('.generation-history-status'), 'generation tree renders for ' + eventId);
  }
  async function waitRootIds(expectedIds, label) {
    const expected = expectedIds.slice().sort();
    await waitFor(() => gallerySettled()
      && JSON.stringify(rootCardIds().slice().sort()) === JSON.stringify(expected), label);
    return rootCardIds().slice().sort();
  }
`;

export async function run(ctx) {
  await ctx.prepare();
  let seeded;
  const first = await ctx.startServer();
  const api = (method, path, body) => ctx.api(first.origin, method, path, body);
  try {
    seeded = await seed(ctx, api);
    assertVersionTree(await ctx.runInPage(first, versionTreeSource(seeded)), seeded);
    await assertVersionsViaApi(api, seeded);

    assertRelationCreated(await ctx.runInPage(first, createRelationSource(seeded)), seeded);
    await assertRelationViaApi(api, seeded, "variant_of");

    assertRelationDeleted(await ctx.runInPage(first, deleteRelationSource(seeded)), seeded);
    await assertRelationGoneViaApi(api, seeded);

    await assertCandidatesSeeded(api, seeded);
    assertCandidateDismissed(await ctx.runInPage(first, dismissCandidateSource(seeded)), seeded);
    await assertCandidateNotSuggestedViaApi(api, seeded, "after dismissing");
    assertCandidatesResolved(await ctx.runInPage(first, resolveCandidatesSource(seeded)), seeded);
    await assertGcLineageViaApi(api, seeded);

    assertHistoryNavigation(await ctx.runInPage(first, historyNavigationSource(seeded)), seeded);
    await assertConversationFiltersViaApi(api, seeded);
  } finally {
    await first.stop();
  }

  const second = await ctx.startServer();
  const apiAfterRestart = (method, path, body) => ctx.api(second.origin, method, path, body);
  try {
    await assertVersionsViaApi(apiAfterRestart, seeded);
    await assertRelationGoneViaApi(apiAfterRestart, seeded);
    await assertGcLineageViaApi(apiAfterRestart, seeded);
    await assertCandidateNotSuggestedViaApi(apiAfterRestart, seeded, "after restart");
    assertAfterRestart(await ctx.runInPage(second, restartSource(seeded)), seeded);
    // Compare after a version switch: the inspector re-renders from the cached
    // history, and the compare selects must still respond.
    assertCompareAfterSwitch(await ctx.runInPage(second, compareAfterSwitchSource(seeded)), seeded);
  } finally {
    await second.stop();
  }
  return seeded;
}

async function seed(ctx, api) {
  const createAsset = async (key, [r, g, b], extra = {}) => {
    const body = await api("POST", "/api/assets/create", {
      projectId: "default",
      imagePath: await ctx.makePng(`versions-lineage-${key}.png`, [r, g, b]),
      prompt: `${key} 的提示词`,
      theme: THEMES[key],
      ...extra,
    });
    if (!body?.asset?.id) throw new Error(`Asset seed returned no id for ${key}`);
    return body.asset.id;
  };
  const r0 = await createAsset("r0", [74, 127, 181]);
  const r1 = (await api("POST", `/api/assets/default/${encodeURIComponent(r0)}/versions`, {
    version_change: "e2e 第一版调整",
    prompt: "R1 调整后的提示词",
    theme: THEMES.r1,
  })).asset.id;
  const r2 = (await api("POST", `/api/assets/default/${encodeURIComponent(r1)}/versions`, {
    version_change: "e2e 第二版调整",
    prompt: "R2 再调整的提示词",
    theme: THEMES.r2,
  })).asset.id;
  const l1 = await createAsset("l1", [58, 138, 87], { source: { conversation_id: CONVERSATION, message_id: MSG_L1 } });
  const l2 = await createAsset("l2", [138, 90, 47], { source: { conversation_id: CONVERSATION, message_id: MSG_L2 } });
  const ga = await createAsset("ga", [96, 74, 155]);
  const gb = await createAsset("gb", [181, 68, 74]);
  const gc = await createAsset("gc", [33, 77, 121]);

  // Explicit timestamps keep parent/child ordering and the "recent
  // predecessor" candidate signal deterministic.
  const base = Date.now();
  const iso = (msAgo) => new Date(base - msAgo).toISOString();
  const record = async (body) => {
    const result = await api("POST", "/api/generations", body);
    if (!result?.event?.id) throw new Error(`Generation seed returned no event for asset ${body.output_asset_id}`);
    return result.event.id;
  };
  const eL1 = await record({
    output_asset_id: l1, provider: RELATION_PROVIDER, conversation_id: CONVERSATION, message_id: MSG_L1,
    batch_id: "batch-l1", model: "e2e-model", effective_prompt: "生成一张底图", created_at: iso(5000),
  });
  const eL2 = await record({
    output_asset_id: l2, provider: RELATION_PROVIDER, conversation_id: CONVERSATION, message_id: MSG_L2,
    batch_id: "batch-l2", model: "e2e-model", effective_prompt: "在上一张的基础上修改背景", created_at: iso(4000),
  });
  // A non-chatgpt provider keeps the L pair free of auto candidates so the
  // manual composer flow starts clean; the candidate pair below uses chatgpt
  // because the rule-based resolver (chatgpt-lineage-v1) only scores those.
  const eGa = await record({
    output_asset_id: ga, provider: "chatgpt", conversation_id: CANDIDATE_CONVERSATION, message_id: "msg-e2e-ga",
    capture_context_id: "ctx-e2e-ga", model: "gpt-e2e", effective_prompt: "画一只橙色的猫", created_at: iso(3000),
  });
  const eGb = await record({
    output_asset_id: gb, provider: "chatgpt", conversation_id: CANDIDATE_CONVERSATION, message_id: "msg-e2e-gb",
    capture_context_id: "ctx-e2e-gb", model: "gpt-e2e", effective_prompt: "把背景改成深蓝色，其他保持不变", created_at: iso(2000),
  });
  const eGc = await record({
    output_asset_id: gc, provider: "chatgpt", conversation_id: CANDIDATE_CONVERSATION, message_id: "msg-e2e-gc",
    capture_context_id: "ctx-e2e-gc", model: "gpt-e2e", effective_prompt: "在此基础上把猫放大一点", created_at: iso(1000),
  });
  return {
    r0, r1, r2, l1, l2, ga, gb, gc,
    eL1, eL2, eGa, eGb, eGc,
    conversation: CONVERSATION,
    messages: { l1: MSG_L1, l2: MSG_L2 },
  };
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function expectDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertNoRendererErrors(result, phase) {
  expectDeepEqual(result?.rendererErrors || [], [], `${phase} rendered with errors`);
}

// ===== Phase 1: version history tree, switch, compare =====

function assertVersionTree(result, seeded) {
  const { r0, r1, r2 } = seeded;
  expect(result?.tree, `Version tree page returned nothing: ${JSON.stringify(result)}`);
  assertNoRendererErrors(result, "version tree");
  expect(result.treeBefore.title === THEMES.r2, `Inspector should open on R2's theme: ${JSON.stringify(result.treeBefore)}`);
  expectDeepEqual(result.tree.ids, [r0, r1, r2], "Version tree nodes/order");
  expect(result.tree.currentId === r2, `Version tree current marker should be R2: ${JSON.stringify(result.tree)}`);
  expect(result.tree.pickerValue === r2, `Version picker should show R2: ${JSON.stringify(result.tree)}`);
  expect(result.switched?.pickerValue === r0 && result.switched.currentId === r0
    && result.switched.selectedCardId === r0, `Clicking R0 in the tree should switch the inspector to R0: ${JSON.stringify(result.switched)}`);
  expect(result.switched.title === THEMES.r0, `Inspector title should switch to the R0 theme: ${JSON.stringify(result.switched)}`);
}

async function assertVersionsViaApi(api, { r0, r1, r2 }) {
  const payload = await api("GET", `/api/assets/default/${encodeURIComponent(r2)}/versions`);
  const history = payload?.history;
  expect(history?.root_asset_id === r0, `Version history root should be R0: ${JSON.stringify(history)}`);
  expectDeepEqual((history.versions || []).map((version) => version.id), [r0, r1, r2], "Version history order via API");
}

// Regression check: renderDetail rebuilds the compare selects from the cached
// history on a version switch (and on any other re-render), so they must be
// re-bound there, not only when /versions first loads.
function assertCompareAfterSwitch(result, seeded) {
  const { r1, r2 } = seeded;
  expect(result?.observed, `Version compare page returned nothing: ${JSON.stringify(result)}`);
  assertNoRendererErrors(result, "version compare");
  expect(result.observedPairApplied === true,
    `Version compare should rerender with the chosen pair after a version switch: ${JSON.stringify(result.observed)}`);
  expect(result.observed.baseValue === r1 && result.observed.targetValue === r2,
    `Version compare selects should hold the chosen pair: ${JSON.stringify(result.observed)}`);
  expectDeepEqual(result.observed.headLabels, ["V2", "V3"], "Version compare head labels");
  expect(result.observed.changedFields.includes("Prompt") && result.observed.changedFields.includes("变更说明"),
    `Version compare should flag the prompt and change-summary rows as changed: ${JSON.stringify(result.observed.changedFields)}`);
  expect(result.compareClosed === true, "Version compare disclosure should close again");
}

// ===== Phase 2: create + save a generation relation on L2 =====

function assertRelationCreated(result, { eL1, eL2 }) {
  expect(result?.created, `Relation create page returned nothing: ${JSON.stringify(result)}`);
  assertNoRendererErrors(result, "relation create");
  expectDeepEqual(result.contextIds, [eL1], "L2 context candidates should list the L1 generation");
  expect(result.before.relationRowCount === 0 && result.before.emptyText === "尚未建立版本关系",
    `Before creating, L2 should have no relations: ${JSON.stringify(result.before)}`);
  expect(result.created.child === eL2 && result.created.parent === eL1,
    `Created relation should be L2(child) <- L1(parent): ${JSON.stringify(result.created)}`);
  expect(result.created.previousType === "edited_from", `Created relation type should be edited_from: ${JSON.stringify(result.created)}`);
  expect(result.created.verification === "用户确认", `Created relation should be user confirmed: ${JSON.stringify(result.created)}`);
  expect(result.created.lineageItemCount === 2 && result.created.currentOutputEventId === eL2,
    `L2 tree should show the two connected generations: ${JSON.stringify(result.created)}`);
  expect(result.saved?.previousType === "variant_of", `Saving the row should retype the relation: ${JSON.stringify(result.saved)}`);
}

async function assertRelationViaApi(api, { eL1, eL2 }, relationType) {
  const payload = await api("GET", `/api/generations/${encodeURIComponent(eL2)}/lineage?project=default`);
  const lineage = payload?.lineage;
  expect(lineage, `Lineage for the L2 event missing: ${JSON.stringify(payload)}`);
  const eventIds = (lineage.events || []).map((event) => event.id).sort();
  expectDeepEqual(eventIds, [eL1, eL2].sort(), "Lineage events via API");
  const relations = lineage.relations || [];
  expect(relations.length === 1, `Lineage should hold exactly one relation: ${JSON.stringify(relations)}`);
  expect(relations[0].child_generation_id === eL2 && relations[0].parent_generation_id === eL1
    && relations[0].relation_type === relationType && relations[0].verification_level === "user_confirmed",
    `Lineage relation mismatch: ${JSON.stringify(relations[0])}`);
  const childEvent = (lineage.events || []).find((event) => event.id === eL2);
  expect((childEvent?.parent_generation_ids || []).includes(eL1), "Child event should list the L1 generation as parent");
}

// ===== Phase 3: delete the relation from the inspector =====

function assertRelationDeleted(result) {
  expect(result?.round1, `Relation delete page returned nothing: ${JSON.stringify(result)}`);
  assertNoRendererErrors(result, "relation delete");
  // Round 1 (Esc): the confirm dialog closes, the overlay stays open, focus is
  // back on the same delete button — the overlay never steals the keystroke.
  expect(result.round1.focusBackOnButton === true,
    `After Esc the focus must return to the delete button inside the overlay: ${JSON.stringify(result.round1)}`);
  // Round 2 (cancel): the relation survives, the overlay stays open.
  expect(result.round2.focusStillInOverlay === true,
    `After cancel the overlay must stay open with the focus inside: ${JSON.stringify(result.round2)}`);
  // Round 3 (confirm): the relation is gone; focus must stay inside the overlay
  // (the original button was rebuilt, so the overlay container takes it).
  expect(String(result.round3.dialogDescription || "").includes("版本关系"),
    `Delete confirm dialog should describe the relation removal: ${JSON.stringify(result.round3.dialogDescription)}`);
  expect(result.round3.focusInsideOverlay === true,
    `After confirm the focus must land inside the overlay: ${JSON.stringify(result.round3)}`);
  expect(result.after.relationRowCount === 0 && result.after.emptyText === "尚未建立版本关系" && result.after.lineageItemCount === 1,
    `L2 tree should be back to a single unrelated generation: ${JSON.stringify(result.after)}`);
}

async function assertRelationGoneViaApi(api, { l2, eL2 }) {
  const payload = await api("GET", `/api/generations/${encodeURIComponent(eL2)}/lineage?project=default`);
  expect((payload?.lineage?.relations || []).length === 0, `Deleted relation still in lineage: ${JSON.stringify(payload?.lineage?.relations)}`);
  const history = await api("GET", `/api/assets/default/${encodeURIComponent(l2)}/generation-history`);
  expect((history?.history?.relations || []).length === 0, `Deleted relation still in generation history: ${JSON.stringify(history?.history?.relations)}`);
}

// ===== Phase 4: relation candidates (confirm + dismiss) =====

async function assertCandidatesSeeded(api, { eGa, eGb, eGc, gb, gc }) {
  const historyGb = await api("GET", `/api/assets/default/${encodeURIComponent(gb)}/generation-history`);
  // The history lists every candidate touching the asset's lineage component,
  // including ones where the asset's event is the PARENT — filter to the ones
  // that propose a parent for this asset's own generation.
  const gbCandidates = (historyGb?.history?.relation_candidates || []).filter((candidate) => candidate.child_generation_id === eGb);
  expect(gbCandidates.length === 1, `GB should seed exactly one candidate: ${JSON.stringify(historyGb?.history?.relation_candidates)}`);
  expect(gbCandidates[0].parent_generation_id === eGa
    && gbCandidates[0].status === "suggested" && gbCandidates[0].suggested_relation_type === "edited_from"
    && Number(gbCandidates[0].confidence) >= 0.45,
    `GB candidate mismatch: ${JSON.stringify(gbCandidates[0])}`);
  const historyGc = await api("GET", `/api/assets/default/${encodeURIComponent(gc)}/generation-history`);
  const gcCandidates = (historyGc?.history?.relation_candidates || []).filter((candidate) => candidate.child_generation_id === eGc);
  expectDeepEqual(gcCandidates.map((candidate) => candidate.parent_generation_id).sort(), [eGa, eGb].sort(), "GC should seed two candidates");
}

function assertCandidateDismissed(result) {
  expect(result?.after, `Candidate dismiss page returned nothing: ${JSON.stringify(result)}`);
  assertNoRendererErrors(result, "candidate dismiss");
  expect(result.candidateRowText.includes("置信度"), `Candidate row should show a confidence: ${JSON.stringify(result.candidateRowText)}`);
  expect(result.after.candidateRowCount === 0 && result.after.relationRowCount === 0 && result.after.lineageItemCount === 1,
    `Dismissing should leave GB unrelated with no candidate rows: ${JSON.stringify(result.after)}`);
}

function assertCandidatesResolved(result, { eGa, eGb, eGc }) {
  expect(result?.confirmed, `Candidate confirm page returned nothing: ${JSON.stringify(result)}`);
  assertNoRendererErrors(result, "candidate confirm");
  expect(result.confirmed.relationRowPresent === true, "Confirmed candidate should become a relation row");
  expect(result.confirmed.child === eGc && result.confirmed.parent === eGb,
    `Confirmed relation should be GC(child) <- GB(parent): ${JSON.stringify(result.confirmed)}`);
  expect(result.confirmed.verification === "用户确认", `Confirmed relation should be user confirmed: ${JSON.stringify(result.confirmed)}`);
  expect(result.confirmed.lineageItemCount === 2 && result.confirmed.currentOutputEventId === eGc,
    `GC tree should show the connected pair after confirm: ${JSON.stringify(result.confirmed)}`);
  expect(result.after.candidateRowCount === 0 && result.after.relationRowCount === 1 && result.after.gaRelationAbsent === true,
    `Second candidate should be dismissed without creating a relation: ${JSON.stringify(result.after)}`);
}

// The generation-history endpoint only surfaces candidates whose status is
// still "suggested", so a dismissed (or confirmed) pair disappears from the
// listing — absence is the API-observable signal that the candidate is no
// longer pending.
async function assertCandidateNotSuggestedViaApi(api, seeded, phase) {
  const history = await api("GET", `/api/assets/default/${encodeURIComponent(seeded.gb)}/generation-history`);
  const pending = (history?.history?.relation_candidates || []).filter((candidate) => candidate.child_generation_id === seeded.eGb);
  expect(pending.length === 0, `GB candidate should no longer be suggested ${phase}: ${JSON.stringify(pending)}`);
}

async function assertGcLineageViaApi(api, { eGb, eGc }) {
  const payload = await api("GET", `/api/generations/${encodeURIComponent(eGc)}/lineage?project=default`);
  const relations = payload?.lineage?.relations || [];
  expect(relations.length === 1 && relations[0].child_generation_id === eGc
    && relations[0].parent_generation_id === eGb && relations[0].verification_level === "user_confirmed",
    `GC lineage should keep only the confirmed GB relation: ${JSON.stringify(relations)}`);
}

// ===== Phase 5: session / batch / context navigation =====

function assertHistoryNavigation(result, { l1 }) {
  expect(result?.removedEntries, `History navigation page returned nothing: ${JSON.stringify(result)}`);
  assertNoRendererErrors(result, "history navigation");
  expect(result.removedEntries === true, "A4a: session/batch entries must stay removed from the inspector");
  expectDeepEqual(result.contextIds, [l1], "查看上下文 should filter to the context owner only");
}

async function assertConversationFiltersViaApi(api, { l1, l2, conversation, messages }) {
  const listIds = async (query) => (await api("GET", `/api/assets?project=default&limit=250${query}`)).assets.map((asset) => asset.id).sort();
  expectDeepEqual(await listIds(`&conversation=${encodeURIComponent(conversation)}`), [l1, l2].sort(), "Conversation filter via API");
  expectDeepEqual(await listIds(`&conversation=${encodeURIComponent(conversation)}&generationBatch=${encodeURIComponent(messages.l2)}`), [l2], "Batch filter via API");
  expectDeepEqual(await listIds(`&conversation=${encodeURIComponent(conversation)}&generationBatch=${encodeURIComponent(messages.l1)}`), [l1], "Context filter via API");
}

// ===== Phase 6: restart =====

function assertAfterRestart(result, seeded) {
  const { r0, r1, r2 } = seeded;
  expect(result?.tree, `Restart page returned nothing: ${JSON.stringify(result)}`);
  assertNoRendererErrors(result, "after restart");
  expectDeepEqual(result.tree.ids, [r0, r1, r2], "Version tree after restart");
  expect(result.tree.currentId === r2 && result.tree.pickerValue === r2, `Version tree current marker after restart: ${JSON.stringify(result.tree)}`);
  expect(result.relationAfterRestart.relationRowCount === 0 && result.relationAfterRestart.emptyText === "尚未建立版本关系"
    && result.relationAfterRestart.lineageItemCount === 1,
    `Deleted relation must not come back after restart: ${JSON.stringify(result.relationAfterRestart)}`);
}

// ===== Page sources =====

function versionTreeSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    ${INSPECTOR_HELPERS}
    const historyRegion = () => detailPanel()?.querySelector('[data-version-history]');
    const treeNodeIds = () => [...(historyRegion()?.querySelectorAll('[data-version-id]') || [])].map((button) => button.dataset.versionId);
    const treeCurrentId = () => historyRegion()?.querySelector('[data-version-id][aria-current="true"]')?.dataset.versionId || '';
    await waitFor(() => gallerySettled() && document.querySelector(cardSelector(config.r2)), 'R2 card rendered');
    const menuItem = await openContextMenu(cardSelector(config.r2) + ' .asset-card-select', '查看版本历史');
    menuItem.click();
    await waitFor(() => document.querySelector('.asset-card.selected')?.dataset.id === config.r2, 'inspector selects R2');
    await openVersionOverlay();
    await waitFor(() => treeNodeIds().length === 3 && historyRegion() && !historyRegion().querySelector('.version-history-status'), 'version tree renders 3 nodes');
    const treeBefore = { title: document.querySelector('#detailTitle')?.textContent || '' };
    openInspectorDisclosure('[data-version-history]');
    const tree = {
      ids: treeNodeIds(),
      currentId: treeCurrentId(),
      pickerValue: document.querySelector('[data-version-select]')?.value || '',
    };
    const r0Button = historyRegion().querySelector('[data-version-id="' + config.r0 + '"]');
    if (!r0Button) throw new Error('Version tree is missing the R0 node');
    r0Button.click();
    await waitFor(() => document.querySelector('[data-version-select]')?.value === config.r0
      && treeCurrentId() === config.r0
      && document.querySelector('.asset-card.selected')?.dataset.id === config.r0, 'inspector switches to R0');
    const switched = {
      pickerValue: document.querySelector('[data-version-select]')?.value || '',
      currentId: treeCurrentId(),
      selectedCardId: document.querySelector('.asset-card.selected')?.dataset.id || '',
      title: document.querySelector('#detailTitle')?.textContent || '',
    };
    return { treeBefore, tree, switched, rendererErrors: rendererErrors.slice(0, 3) };
  })()`;
}

function compareAfterSwitchSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    ${INSPECTOR_HELPERS}
    const historyRegion = () => detailPanel()?.querySelector('[data-version-history]');
    const treeCurrentId = () => historyRegion()?.querySelector('[data-version-id][aria-current="true"]')?.dataset.versionId || '';
    await waitFor(() => gallerySettled() && document.querySelector(cardSelector(config.r2)), 'R2 card rendered');
    const menuItem = await openContextMenu(cardSelector(config.r2) + ' .asset-card-select', '查看版本历史');
    menuItem.click();
    await waitFor(() => document.querySelector('.asset-card.selected')?.dataset.id === config.r2, 'inspector selects R2');
    await openVersionOverlay();
    await waitFor(() => historyRegion()?.querySelectorAll('[data-version-id]').length === 3
      && historyRegion() && !historyRegion().querySelector('.version-history-status'), 'version tree renders 3 nodes');
    historyRegion().querySelector('[data-version-id="' + config.r0 + '"]').click();
    await waitFor(() => document.querySelector('[data-version-select]')?.value === config.r0
      && treeCurrentId() === config.r0, 'inspector switches to R0');
    const compareDisclosure = openInspectorDisclosure('[data-version-compare]');
    setSelect(compareDisclosure.querySelector('[data-version-compare-base]'), config.r1);
    setSelect(compareDisclosure.querySelector('[data-version-compare-target]'), config.r2);
    // The compare region rerenders synchronously in response to change events
    // when its listeners are alive; poll briefly instead of the full waitFor so
    // a dead region fails fast with its observed state instead of timing out.
    const deadline = Date.now() + 1500;
    let observedPairApplied = false;
    while (Date.now() < deadline) {
      const base = compareDisclosure.querySelector('[data-version-compare-base]');
      const target = compareDisclosure.querySelector('[data-version-compare-target]');
      if (base?.value === config.r1 && target?.value === config.r2
        && JSON.stringify([...compareDisclosure.querySelectorAll('.version-compare-head strong')].map((node) => node.textContent)) === JSON.stringify(['V2', 'V3'])) {
        observedPairApplied = true;
        break;
      }
      await sleep(50);
    }
    const observed = {
      baseValue: compareDisclosure.querySelector('[data-version-compare-base]')?.value || '',
      targetValue: compareDisclosure.querySelector('[data-version-compare-target]')?.value || '',
      headLabels: [...compareDisclosure.querySelectorAll('.version-compare-head strong')].map((node) => node.textContent),
      changedFields: [...compareDisclosure.querySelectorAll('.version-compare-row.changed strong')].map((node) => node.textContent),
    };
    compareDisclosure.querySelector('summary').click();
    return { observed, observedPairApplied, compareClosed: !compareDisclosure.open, rendererErrors: rendererErrors.slice(0, 3) };
  })()`;
}

function createRelationSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    ${INSPECTOR_HELPERS}
    await waitFor(() => gallerySettled() && document.querySelector(cardSelector(config.l2)), 'L2 card rendered');
    await openInspector(config.l2);
    await openVersionOverlay();
    await waitForGenerationTree(config.eL2);
    const contextIds = [...(genRegion()?.querySelectorAll('[data-context-generation-id]') || [])].map((li) => li.dataset.contextGenerationId);
    await openManagement(config.eL2);
    await waitFor(() => management(config.eL2)?.querySelector('[data-generation-link-form]'), 'link composer renders');
    const before = {
      relationRowCount: management(config.eL2).querySelectorAll('[data-generation-relation-row]').length,
      emptyText: management(config.eL2).querySelector('.generation-management-empty')?.textContent || '',
    };
    const linkDisclosure = management(config.eL2).querySelector('.generation-link-disclosure');
    if (!linkDisclosure.open) linkDisclosure.querySelector('summary').click();
    const form = () => management(config.eL2)?.querySelector('[data-generation-link-form]');
    await waitFor(() => form()?.dataset.anchorGenerationId === config.eL2, 'composer anchored at the L2 generation');
    setSelect(form().querySelector('[data-generation-link-candidate]'), config.eL1);
    setSelect(form().querySelector('[data-generation-link-direction]'), 'candidate-parent');
    const createButton = form().querySelector('[data-action="create-generation-relation"]');
    if (!createButton) throw new Error('Missing create-generation-relation button');
    createButton.click();
    const relationRowSelector = '[data-generation-relation-row][data-child-generation-id="' + config.eL2 + '"][data-parent-generation-id="' + config.eL1 + '"]';
    await waitFor(() => genRegion()?.querySelector(relationRowSelector), 'relation row appears');
    const createdRow = genRegion().querySelector(relationRowSelector);
    const created = {
      child: createdRow.dataset.childGenerationId,
      parent: createdRow.dataset.parentGenerationId,
      previousType: createdRow.dataset.previousRelationType,
      verification: createdRow.querySelector('.generation-verification')?.textContent || '',
      lineageItemCount: genRegion().querySelectorAll('.generation-lineage-item').length,
      currentOutputEventId: genRegion().querySelector('.generation-lineage-item.current-output .generation-lineage-node')?.dataset.generationId || '',
    };
    setSelect(createdRow.querySelector('[data-generation-relation-type]'), 'variant_of');
    const saveButton = createdRow.querySelector('[data-action="save-generation-relation"]');
    if (!saveButton) throw new Error('Missing save-generation-relation button');
    saveButton.click();
    await waitFor(() => genRegion()?.querySelector(relationRowSelector)?.dataset.previousRelationType === 'variant_of', 'relation type saved');
    const saved = { previousType: genRegion().querySelector(relationRowSelector)?.dataset.previousRelationType || '' };
    return { contextIds, before, created, saved, rendererErrors: rendererErrors.slice(0, 3) };
  })()`;
}

// 任务 73 返工 1：版本树浮层里的「删除关系」会弹出确认框（叠在浮层上）——浮层
// 必须让位。三段式：Esc 关确认框浮层保持且焦点回删除按钮；取消后浮层保持；
// 确认后关系删除、浮层保持、焦点回到浮层内（原按钮已被重建替换）。
// 真实指针序列：pointerdown（浮层在 document 捕获段监听）+ click。
const DELETE_FLOW_HELPERS = String.raw`
  const overlayOpen = () => {
    const overlay = detailPanel()?.querySelector('[data-gp-overlay]');
    return Boolean(overlay) && !overlay.hidden;
  };
  const confirmDialogOpen = () => document.querySelector('#confirmDialog')?.classList.contains('open') || false;
  const realPress = (el) => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    el.click();
  };
  async function deleteRelationRound(config, action) {
    await openManagement(config.eL2);
    const relationRowSelector = '[data-generation-relation-row][data-child-generation-id="' + config.eL2 + '"][data-parent-generation-id="' + config.eL1 + '"]';
    await waitFor(() => genRegion()?.querySelector(relationRowSelector), 'relation row renders for round ' + action);
    const deleteButton = genRegion().querySelector(relationRowSelector + ' [data-action="delete-generation-relation"]');
    if (!deleteButton) throw new Error('Missing delete-generation-relation button');
    realPress(deleteButton);
    await waitFor(() => confirmDialogOpen(), 'confirm dialog opens (round ' + action + ')');
    const focusedBefore = document.activeElement;
    if (action === 'escape') {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await waitFor(() => !confirmDialogOpen(), 'confirm dialog closed by Escape');
      await waitFor(() => overlayOpen(), 'overlay stays open after Escape');
      await new Promise((r) => setTimeout(r, 120));
      const deleteButtonAfter = genRegion()?.querySelector(relationRowSelector + ' [data-action="delete-generation-relation"]');
      const focusBackOnButton = document.activeElement === deleteButtonAfter;
      return { dialogDescription: '', focusBackOnButton };
    }
    const dialogDescription = document.querySelector('#confirmDialogDescription')?.textContent || '';
    const confirmButton = document.querySelector('#confirmDialogConfirm');
    const cancelButton = document.querySelector('#confirmDialogCancel');
    const buttonToPress = action === 'confirm' ? confirmButton : cancelButton;
    if (!buttonToPress) throw new Error('Missing ' + action + ' button in the confirm dialog');
    realPress(buttonToPress);
    await waitFor(() => !confirmDialogOpen(), 'confirm dialog closed by ' + action);
    await waitFor(() => overlayOpen(), 'overlay stays open after ' + action);
    if (action === 'confirm') {
      await waitFor(() => !genRegion()?.querySelector(relationRowSelector)
        && management(config.eL2)?.querySelector('.generation-management-empty'), 'relation row disappears after confirm');
      const overlayNode = detailPanel()?.querySelector('[data-gp-overlay]');
      const focusInsideOverlay = overlayNode?.contains(document.activeElement) && document.activeElement !== document.body;
      return { dialogDescription, focusInsideOverlay };
    }
    return { dialogDescription, focusStillInOverlay: overlayNode_containsFocus() };
  }
  function overlayNode_containsFocus() {
    const overlayNode = detailPanel()?.querySelector('[data-gp-overlay]');
    return Boolean(overlayNode?.contains(document.activeElement));
  }
`;

function deleteRelationSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    ${INSPECTOR_HELPERS}
    ${DELETE_FLOW_HELPERS}
    await waitFor(() => gallerySettled() && document.querySelector(cardSelector(config.l2)), 'L2 card rendered');
    await openInspector(config.l2);
    await openVersionOverlay();
    await waitForGenerationTree(config.eL2);

    // Round 1: Esc closes the confirm dialog on top; the overlay stays and the
    // focus returns to the same delete button.
    const round1 = await deleteRelationRound(config, 'escape');
    // Round 2: cancel keeps the relation and the overlay.
    const round2 = await deleteRelationRound(config, 'cancel');
    // Round 3: confirm really deletes; focus lands inside the overlay.
    const round3 = await deleteRelationRound(config, 'confirm');
    const after = {
      relationRowCount: genRegion().querySelectorAll('[data-generation-relation-row]').length,
      emptyText: management(config.eL2)?.querySelector('.generation-management-empty')?.textContent || '',
      lineageItemCount: genRegion().querySelectorAll('.generation-lineage-item').length,
    };
    return { round1, round2, round3, after, rendererErrors: rendererErrors.slice(0, 3) };
  })()`;
}

function dismissCandidateSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    ${INSPECTOR_HELPERS}
    await waitFor(() => gallerySettled() && document.querySelector(cardSelector(config.gb)), 'GB card rendered');
    await openInspector(config.gb);
    await openVersionOverlay();
    await waitForGenerationTree(config.eGb);
    await openManagement(config.eGb);
    await waitFor(() => management(config.eGb)?.querySelector('[data-generation-candidate-row]'), 'GB candidate row renders');
    const candidateRowText = management(config.eGb).querySelector('[data-generation-candidate-row]').textContent || '';
    const dismissButton = management(config.eGb).querySelector('[data-action="dismiss-generation-relation-candidate"][data-child-generation-id="' + config.eGb + '"][data-parent-generation-id="' + config.eGa + '"]');
    if (!dismissButton) throw new Error('Missing dismiss button on the GB candidate');
    dismissButton.click();
    await waitFor(() => !genRegion()?.querySelector('[data-generation-candidate-row]'), 'dismissed candidate row disappears');
    const after = {
      candidateRowCount: genRegion().querySelectorAll('[data-generation-candidate-row]').length,
      relationRowCount: genRegion().querySelectorAll('[data-generation-relation-row]').length,
      lineageItemCount: genRegion().querySelectorAll('.generation-lineage-item').length,
    };
    return { candidateRowText, after, rendererErrors: rendererErrors.slice(0, 3) };
  })()`;
}

function resolveCandidatesSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    ${INSPECTOR_HELPERS}
    await waitFor(() => gallerySettled() && document.querySelector(cardSelector(config.gc)), 'GC card rendered');
    await openInspector(config.gc);
    await openVersionOverlay();
    await waitForGenerationTree(config.eGc);
    await openManagement(config.eGc);
    await waitFor(() => management(config.eGc)?.querySelectorAll('[data-generation-candidate-row]').length === 2, 'two candidate rows render');
    const confirmButton = management(config.eGc).querySelector('[data-action="confirm-generation-relation-candidate"][data-child-generation-id="' + config.eGc + '"][data-parent-generation-id="' + config.eGb + '"]');
    if (!confirmButton) throw new Error('Missing confirm button for the GB candidate');
    confirmButton.click();
    const relationRowSelector = '[data-generation-relation-row][data-child-generation-id="' + config.eGc + '"][data-parent-generation-id="' + config.eGb + '"]';
    await waitFor(() => genRegion()?.querySelector(relationRowSelector), 'confirmed relation row appears');
    await waitFor(() => genRegion().querySelectorAll('[data-generation-candidate-row]').length === 1, 'only the GA candidate remains');
    const confirmedRow = genRegion().querySelector(relationRowSelector);
    const confirmed = {
      relationRowPresent: Boolean(confirmedRow),
      child: confirmedRow?.dataset.childGenerationId || '',
      parent: confirmedRow?.dataset.parentGenerationId || '',
      verification: confirmedRow?.querySelector('.generation-verification')?.textContent || '',
      lineageItemCount: genRegion().querySelectorAll('.generation-lineage-item').length,
      currentOutputEventId: genRegion().querySelector('.generation-lineage-item.current-output .generation-lineage-node')?.dataset.generationId || '',
    };
    const dismissButton = genRegion().querySelector('[data-action="dismiss-generation-relation-candidate"][data-child-generation-id="' + config.eGc + '"][data-parent-generation-id="' + config.eGa + '"]');
    if (!dismissButton) throw new Error('Missing dismiss button for the GA candidate');
    dismissButton.click();
    await waitFor(() => !genRegion()?.querySelector('[data-generation-candidate-row]'), 'second candidate dismissed');
    const after = {
      candidateRowCount: genRegion().querySelectorAll('[data-generation-candidate-row]').length,
      relationRowCount: genRegion().querySelectorAll('[data-generation-relation-row]').length,
      gaRelationAbsent: !genRegion().querySelector('[data-generation-relation-row][data-parent-generation-id="' + config.eGa + '"]'),
    };
    return { confirmed, after, rendererErrors: rendererErrors.slice(0, 3) };
  })()`;
}

function historyNavigationSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    ${INSPECTOR_HELPERS}
    await waitFor(() => gallerySettled() && document.querySelector(cardSelector(config.l2)), 'L2 card rendered');
    await openInspector(config.l2);
    // GravityPort A4a：来源区块（「查看整个会话」「查看同一批次」按钮）不再渲染——
    // 锁「不得回来」。
    const sessionEntry = detailPanel()?.querySelector('[data-action="view-generation-session"]');
    const batchEntry = detailPanel()?.querySelector('[data-action="view-generation-batch"]');
    const removedEntries = !sessionEntry && !batchEntry;
    if (!removedEntries) throw new Error('source-section navigation entries must stay removed, found ' + JSON.stringify({ sessionEntry: Boolean(sessionEntry), batchEntry: Boolean(batchEntry) }));
    // 「查看上下文」在生成节点详情里，经版本树浮层照常可达。
    await openInspector(config.l1);
    await openVersionOverlay();
    await waitForGenerationTree(config.eL1);
    await openGenerationNode(config.eL1);
    const contextButton = genNode(config.eL1)?.querySelector('[data-action="view-generation-context"]');
    if (!contextButton) throw new Error('Missing view-generation-context button on the L1 generation');
    contextButton.click();
    const contextIds = await waitRootIds([config.l1], 'context filter shows only L1');
    return { removedEntries, contextIds, rendererErrors: rendererErrors.slice(0, 3) };
  })()`;
}

function restartSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    ${INSPECTOR_HELPERS}
    await waitFor(() => gallerySettled() && document.querySelector(cardSelector(config.r2)), 'R2 card rendered');
    const menuItem = await openContextMenu(cardSelector(config.r2) + ' .asset-card-select', '查看版本历史');
    menuItem.click();
    await waitFor(() => document.querySelector('.asset-card.selected')?.dataset.id === config.r2, 'inspector selects R2 after restart');
    const historyRegion = () => detailPanel()?.querySelector('[data-version-history]');
    const treeNodeIds = () => [...(historyRegion()?.querySelectorAll('[data-version-id]') || [])].map((button) => button.dataset.versionId);
    await openVersionOverlay();
    await waitFor(() => treeNodeIds().length === 3 && historyRegion() && !historyRegion().querySelector('.version-history-status'), 'version tree renders 3 nodes after restart');
    const tree = {
      ids: treeNodeIds(),
      currentId: historyRegion()?.querySelector('[data-version-id][aria-current="true"]')?.dataset.versionId || '',
      pickerValue: document.querySelector('[data-version-select]')?.value || '',
    };
    await openInspector(config.l2);
    await openVersionOverlay();
    await waitForGenerationTree(config.eL2);
    await openManagement(config.eL2);
    const relationAfterRestart = {
      relationRowCount: genRegion().querySelectorAll('[data-generation-relation-row]').length,
      emptyText: management(config.eL2)?.querySelector('.generation-management-empty')?.textContent || '',
      lineageItemCount: genRegion().querySelectorAll('.generation-lineage-item').length,
    };
    return { tree, relationAfterRestart, rendererErrors: rendererErrors.slice(0, 3) };
  })()`;
}
