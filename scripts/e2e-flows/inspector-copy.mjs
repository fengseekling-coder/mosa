// Inspector copy flow: the three clipboard copy buttons (prompt / instruction /
// source path), the gallery card quick-copy button, and the generation-history
// "open output asset" button — none of which inspector-editing covers (its
// header comment explicitly scopes clipboard actions out).
//
// 摸底清单（web/app/app.mjs + inspector-markup.mjs + i18n.mjs）：
// - writeClipboardText（app.mjs ~1512）：web 端走 navigator.clipboard.writeText；
//   API 缺失时抛 Error(t("copyFailed"))；writeText reject 时异常原样冒泡，
//   runAction 把 error.message 原文上 toast——所以「记录器 reject」路径的 toast
//   文案是注入的拒绝信息，copyFailed 文案只出现在「API 不存在」分支，两条都测。
// - copy-prompt（app.mjs ~5669）：复制 promptTexts[activePromptVariant]（生成
//   Prompt），成功 toast t("copySuccess")=「提示词已复制」；按钮只在有 prompt 时
//   渲染（无 prompt 无 requestPrompt 时整个按钮不渲染，inspector-markup ~258）。
// - copy-instruction（app.mjs ~5670）：复制 source.user_message || business_fields.
//   user_message（trim），成功 toast 同 copySuccess；按钮恒渲染，空时 disabled
//   （inspector-markup ~277）。
// - copy-source（app.mjs ~5632）：复制 sourceCopyValue(source)=source.path，
//   成功 toast t("originalPathCopied")=「原始路径已复制」；按钮只在有可复制值时
//   渲染，位于默认收起的 detail-source-disclosure 里。
// - .card-quick-copy（app.mjs ~1891）：复制该素材 prompt，成功 toast copySuccess；
//   事件里 stopPropagation，不选中卡片不开检视器。产品发现：V2 UI（body.mosa-v2，
//   index.html:13 硬编码，无 JS 切换）下 styles.css:1229 无条件
//   `.mosa-v2 .card-quick-copy { display: none; }`（PR #105 起），按钮从未显现，
//   Phase 1C 的 hover/focus-within 渐进披露契约（styles.css:1020-1026）对它失效。
//   测试钉住「按钮存在但不可见 + 点击契约」这一实际行为；若产品恢复按钮可见，
//   这里应改回真实的 hover/focus 披露路径并在回报里同步。
// - open-generation-output（app.mjs ~5227 → openGenerationOutputAsset ~5172）：
//   切换选中并打开目标素材；按钮在生成节点详情里（inspector-markup ~560），
//   产物即当前素材时 disabled 且文案 t("generationCurrentAsset")=「当前素材」，
//   否则 t("generationOpenAsset")=「打开素材」。素材生成历史 = 连通 lineage
//   分量（lib/generation-history.mjs buildAssetGenerationHistory），所以用
//   eA→A、eB→B 两个事件 + eB(child)←eA(parent) 关系把 eB 带进 A 的历史。
// - 无草稿时 openGenerationOutputAsset 不弹确认框（confirmDetailNavigation 只在
//   hasManualSaveDraft() 时拦）。
// - 剪贴板怎么测：隐藏窗口没有焦点，真实 writeText 大概率被拒；在页面脚本里把
//   navigator.clipboard.writeText 换成记录器（记入参、正常 resolve），断言边界
//   定在浏览器接口入参上，不绕开产品逻辑。
// - 文案断言依赖中文界面：e2e-web-driver.mjs ~67 每个窗口启动时都会把
//   localStorage["mosa.ui-language"] 钉成 zh 并 reload，全部窗口都以 zh 启动。

import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "inspector-copy";
export const description = "inspector copy-prompt/instruction/source via a clipboard recorder + failure toasts -> card quick-copy contract (V2 keeps the button display:none) -> open-generation-output switches assets + current-asset disabled branch";

// i18n.mjs zh 文案（代码实际调用的键写在各断言旁）。
const TOAST_COPY_SUCCESS = "提示词已复制"; // copySuccess（copy-prompt / copy-instruction / 卡片快捷复制共用）
const TOAST_PATH_COPIED = "原始路径已复制"; // originalPathCopied
const TOAST_COPY_FAILED = "复制失败，请重试"; // copyFailed
const LABEL_OPEN_ASSET = "打开素材"; // generationOpenAsset
const LABEL_CURRENT_ASSET = "当前素材"; // generationCurrentAsset

export async function run(ctx) {
  await ctx.prepare();
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const config = {
    themeA: `复制流程主图 ${stamp}`,
    themeB: `复制流程产物 ${stamp}`,
    promptA: `检视器复制流程的主图提示词 ${stamp}`,
    promptB: `复制流程产物的提示词 ${stamp}`,
    userMessage: `把主图背景换成黄昏的海滩，其他保持不变 ${stamp}`,
    provider: "e2e-copy-flow",
  };
  const seeded = await seed(ctx, config);

  const server = await ctx.startServer();
  try {
    // S1: the three inspector copy buttons on the rich asset + both failure paths.
    const inspector = await ctx.runInPage(server, inspectorCopySource(seeded));
    assertCondition(inspector.promptButton.present === true && inspector.promptButton.disabled === false,
      `copy-prompt button should render enabled for an asset with a prompt: ${JSON.stringify(inspector.promptButton)}`);
    assertCondition(inspector.writes.length === 3, `expected three clipboard writes, got ${JSON.stringify(inspector.writes)}`);
    assertCondition(inspector.writes[0] === seeded.expect.prompt,
      `copy-prompt wrote ${JSON.stringify(inspector.writes[0])}, expected the asset prompt ${JSON.stringify(seeded.expect.prompt)}`);
    assertCondition(inspector.writes[1] === seeded.expect.instruction,
      `copy-instruction wrote ${JSON.stringify(inspector.writes[1])}, expected the user instruction ${JSON.stringify(seeded.expect.instruction)}`);
    assertCondition(inspector.writes[2] === seeded.expect.sourcePath,
      `copy-source wrote ${JSON.stringify(inspector.writes[2])}, expected the original path ${JSON.stringify(seeded.expect.sourcePath)}`);
    assertCondition(inspector.promptToastSeen === true && inspector.pathToastSeen === true,
      `success toasts missing: ${JSON.stringify({ promptToastSeen: inspector.promptToastSeen, pathToastSeen: inspector.pathToastSeen })}`);
    // 失败路径 1：记录器 reject 一次 —— toast 文案是注入的拒绝信息原文
    // （runAction 把 error.message 原样上 toast），剪贴板不得新增成功写入。
    assertCondition(inspector.rejectPath.attemptsDelta === 1 && inspector.rejectPath.okLength === 3,
      `rejected write should reach the API once and record nothing: ${JSON.stringify(inspector.rejectPath)}`);
    assertCondition(inspector.rejectPath.errorTexts.includes(REJECTION_MESSAGE),
      `rejected write did not surface the rejection message on an error toast: ${JSON.stringify(inspector.rejectPath.errorTexts)}`);
    // 失败路径 2：剪贴板 API 整个不存在 —— 产品抛 copyFailed 文案的错误 toast。
    assertCondition(inspector.missingApiPath.attemptsDelta === 0 && inspector.missingApiPath.okLength === 3,
      `missing clipboard API must not reach the recorder: ${JSON.stringify(inspector.missingApiPath)}`);
    assertCondition(inspector.missingApiPath.errorTexts.includes(TOAST_COPY_FAILED),
      `missing clipboard API did not show the copyFailed toast: ${JSON.stringify(inspector.missingApiPath.errorTexts)}`);
    assertNoRendererErrors(inspector, "inspector copy buttons");

    // S2: empty asset — prompt/instruction copy entries are inert, source path
    // still copies.
    const empty = await ctx.runInPage(server, emptyAssetSource(seeded));
    assertCondition(empty.promptButton.present === false,
      "copy-prompt button must not render when the asset has no prompt and no request prompt");
    assertCondition(empty.instruction.present === true && empty.instruction.disabled === true,
      `copy-instruction button must render disabled for an asset without a user instruction: ${JSON.stringify(empty.instruction)}`);
    assertCondition(empty.afterDisabledClick.attempts === 0 && empty.afterDisabledClick.ok === 0 && empty.afterDisabledClick.toastCount === 0,
      `clicking the disabled instruction button must not write the clipboard or toast: ${JSON.stringify(empty.afterDisabledClick)}`);
    assertCondition(empty.sourceWrite === seeded.expect.emptySourcePath,
      `copy-source on the empty asset wrote ${JSON.stringify(empty.sourceWrite)}, expected its original path ${JSON.stringify(seeded.expect.emptySourcePath)}`);
    assertNoRendererErrors(empty, "empty asset copy buttons");

    // S3: card quick-copy — the V2 UI keeps the button display:none (product
    // finding, see the header comment), so pin that state and exercise the
    // click contract: copy the prompt without selecting the card or opening
    // the inspector.
    const quickCopy = await ctx.runInPage(server, quickCopySource(seeded));
    assertCondition(quickCopy.visibility.display === "none",
      `V2 hides .card-quick-copy entirely (styles.css:1229); observed ${JSON.stringify(quickCopy.visibility)} — if this fails because the button became visible, switch this flow to the real hover/focus reveal path`);
    assertCondition(quickCopy.write === seeded.expect.prompt,
      `quick-copy wrote ${JSON.stringify(quickCopy.write)}, expected the asset prompt ${JSON.stringify(seeded.expect.prompt)}`);
    assertCondition(quickCopy.toastSeen === true, "quick-copy did not show the copySuccess toast");
    assertCondition(quickCopy.before.selected === "" && quickCopy.before.open === false
      && quickCopy.after.selected === "" && quickCopy.after.open === false,
      `quick-copy must not select the card or open the inspector: before=${JSON.stringify(quickCopy.before)} after=${JSON.stringify(quickCopy.after)}`);
    assertNoRendererErrors(quickCopy, "card quick-copy");

    // S4: open-generation-output from A switches the inspector to B; the
    // current-asset event renders a disabled 当前素材 button on both assets.
    const navigation = await ctx.runInPage(server, openOutputSource(seeded));
    assertCondition(navigation.before.title === seeded.expect.titleA && navigation.before.selected === seeded.a,
      `inspector should start on A: ${JSON.stringify(navigation.before)}`);
    assertCondition(navigation.before.ownEventButton.disabled === true && navigation.before.ownEventButton.label === LABEL_CURRENT_ASSET,
      `A's own generation event must render the disabled current-asset button: ${JSON.stringify(navigation.before.ownEventButton)}`);
    assertCondition(navigation.before.outputButton.disabled === false && navigation.before.outputButton.label === LABEL_OPEN_ASSET
      && navigation.before.outputButton.target === seeded.b,
      `the output event must render an enabled open-asset button targeting B: ${JSON.stringify(navigation.before.outputButton)}`);
    assertCondition(navigation.after.selected === seeded.b && navigation.after.open === true
      && navigation.after.title === seeded.expect.titleB,
      `clicking open-generation-output must switch the inspector to B: ${JSON.stringify(navigation.after)}`);
    assertCondition(navigation.after.ownEventButton.disabled === true && navigation.after.ownEventButton.label === LABEL_CURRENT_ASSET,
      `B's own generation event must render the disabled current-asset button: ${JSON.stringify(navigation.after.ownEventButton)}`);
    assertCondition(navigation.after.parentButton.disabled === false && navigation.after.parentButton.label === LABEL_OPEN_ASSET,
      `B's view must offer an enabled open-asset button back to A: ${JSON.stringify(navigation.after.parentButton)}`);

    // API 复查：B 确实存在，且是接口记录里的那条产物素材。
    const bAfter = (await ctx.api(server.origin, "GET", `/api/assets/default/${encodeURIComponent(seeded.b)}`)).asset;
    assertCondition(bAfter?.id === seeded.b, `generation output asset B disappeared from the library: ${JSON.stringify(bAfter?.id)}`);
    assertCondition(bAfter.prompt === config.promptB, `asset B was mutated by the flow: ${JSON.stringify(bAfter?.prompt)}`);
  } finally {
    await server.stop();
  }
  return { a: seeded.a, b: seeded.b, c: seeded.c, events: { own: seeded.eventA, output: seeded.eventB } };
}

// ===== Node-side helpers =====

const REJECTION_MESSAGE = "The document is not focused."; // 记录器注入的拒绝信息（模拟 Chromium 焦点拒绝）

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function assertNoRendererErrors(result, phase) {
  assertCondition(JSON.stringify(result?.rendererErrors || []) === "[]", `${phase} rendered with errors: ${JSON.stringify(result?.rendererErrors)}`);
}

async function seed(ctx, config) {
  const server = await ctx.startServer();
  try {
    const api = (method, path, body) => ctx.api(server.origin, method, path, body);
    const base = Date.now();
    const iso = (msAgo) => new Date(base - msAgo).toISOString();
    const create = async (fileName, [r, g, b], extra = {}) => {
      const payload = await api("POST", "/api/assets/create", {
        projectId: "default", imagePath: await ctx.makePng(fileName, [r, g, b]), ...extra,
      });
      assertCondition(payload?.asset?.id, `asset seed returned no id for ${fileName}`);
      return payload.asset;
    };
    // A：有提示词、有用户指令（copy-instruction 读 source.user_message）、有原始
    // 路径（store 把 imagePath 记进 source.path）。
    const aAsset = await create("inspector-copy-a.png", [181, 68, 74], {
      prompt: config.promptA, theme: config.themeA, source: { user_message: config.userMessage },
    });
    // B：作为生成产物被 eB 事件指向。
    const bAsset = await create("inspector-copy-b.png", [74, 127, 181], { prompt: config.promptB, theme: config.themeB });
    // C：提示词与用户指令都为空（无 prompt、无 source）。
    const cAsset = await create("inspector-copy-c.png", [58, 138, 87]);

    const record = async (body) => {
      const result = await api("POST", "/api/generations", body);
      assertCondition(result?.event?.id, `generation seed returned no event for ${body.output_asset_id}`);
      return result.event.id;
    };
    const eventA = await record({
      output_asset_id: aAsset.id, provider: config.provider, model: "e2e-model",
      effective_prompt: config.promptA, created_at: iso(3000),
    });
    const eventB = await record({
      output_asset_id: bAsset.id, provider: config.provider, model: "e2e-model",
      effective_prompt: config.promptB, created_at: iso(2000),
    });
    // eB(child)←eA(parent)：把两个事件接进同一个 lineage 分量，A 的生成历史
    // 因此同时渲染 eA 和 eB（buildAssetGenerationHistory 取连通分量）。
    await api("POST", "/api/generation-relations", {
      project_id: "default", child_generation_id: eventB, parent_generation_id: eventA, relation_type: "edited_from",
    });

    const fresh = async (assetId) => (await api("GET", `/api/assets/default/${encodeURIComponent(assetId)}`)).asset;
    const aFull = await fresh(aAsset.id);
    const cFull = await fresh(cAsset.id);
    assertCondition(aFull.prompt === config.promptA && aFull.source?.user_message === config.userMessage && aFull.source?.path,
      `asset A is missing the seeded copy fields: ${JSON.stringify({ prompt: aFull.prompt, source: aFull.source })}`);
    assertCondition(cFull.prompt === "" && !cFull.source?.user_message,
      `asset C should hold an empty prompt and no user instruction: ${JSON.stringify({ prompt: cFull.prompt, source: cFull.source })}`);
    return {
      a: aAsset.id, b: bAsset.id, c: cAsset.id, eventA, eventB,
      expect: {
        prompt: aFull.prompt,
        instruction: config.userMessage, // copy-instruction 侧做 trim，种子无首尾空白
        sourcePath: aFull.source.path,
        emptySourcePath: cFull.source.path,
        titleA: config.themeA, // displayAssetTitle = theme || 文件名 || id
        titleB: config.themeB,
      },
    };
  } finally {
    await server.stop();
  }
}

// ===== In-page sources =====

const CLIP_HELPERS = String.raw`
  const panel = () => document.querySelector('#detailPanel');
  const detailOpen = () => panel()?.getAttribute('aria-hidden') === 'false';
  const selectedId = () => document.querySelector('.asset-card.selected')?.dataset.id || '';
  const detailImageSrc = () => panel()?.querySelector('img.detail-image')?.getAttribute('src') || '';
  const detailTitle = () => document.querySelector('#detailTitle')?.textContent || '';
  const successToasts = () => [...document.querySelectorAll('#toastContainer .toast.success .toast-message')].map((node) => node.textContent || '');
  const errorToasts = () => [...document.querySelectorAll('#toastErrorContainer .toast.error .toast-message')].map((node) => node.textContent || '');
  // 剪贴板记录器：替换 navigator.clipboard.writeText，记下程序交给剪贴板的
  // 文字并正常 resolve。隐藏窗口没有焦点，真实 writeText 大概率被拒；断言边界
  // 定在浏览器接口入参上，不算绕开产品逻辑。
  const clip = { ok: [], attempts: 0, rejectOnce: false };
  if (!navigator.clipboard) Object.defineProperty(navigator, 'clipboard', { value: {}, configurable: true });
  navigator.clipboard.writeText = (text) => {
    clip.attempts += 1;
    const value = String(text ?? '');
    if (clip.rejectOnce) {
      clip.rejectOnce = false;
      return Promise.reject(new DOMException('The document is not focused.', 'NotAllowedError'));
    }
    clip.ok.push(value);
    return Promise.resolve();
  };
  async function openDetailFor(assetId) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const trigger = document.querySelector(cardSelector(assetId) + ' .asset-card-select');
      if (trigger?.isConnected) {
        trigger.click();
        if (detailOpen() && selectedId() === assetId && panel()?.querySelector('[data-inspector-section="file"]')) return;
      }
      await sleep(100);
    }
    throw new Error('Timed out opening inspector for ' + assetId + ' diagnostic=' + JSON.stringify(pageDiagnostic()));
  }
  async function openSourceDisclosure() {
    const summary = panel()?.querySelector('[data-inspector-section="source"] details.detail-source-disclosure > summary');
    if (!summary) throw new Error('Missing source disclosure summary');
    summary.click();
    await waitFor(() => panel()?.querySelector('[data-inspector-section="source"] details.detail-source-disclosure')?.open === true,
      'source disclosure opens');
  }
`;

// S1：A 的三个复制按钮 + 两条失败路径。
function inspectorCopySource(seeded) {
  return `(async () => {
    const seeded = ${JSON.stringify(seeded)};
    ${PAGE_HELPERS}
    ${CLIP_HELPERS}
    await waitFor(() => gallerySettled() && rootCardIds().length === 3, 'three seeded cards');
    await openDetailFor(seeded.a);
    const promptButton = panel().querySelector('[data-action="copy-prompt"]');
    const promptButtonFacts = { present: Boolean(promptButton), disabled: promptButton ? promptButton.disabled : null };

    // 生成 Prompt 复制：成功 toast copySuccess（zh「提示词已复制」）。
    promptButton.click();
    await waitFor(() => successToasts().includes('${TOAST_COPY_SUCCESS}'), 'prompt copy success toast');
    const promptToastSeen = true;

    // 用户指令复制：同一成功文案（copySuccess），区分靠记录器第二条写入。
    panel().querySelector('[data-action="copy-instruction"]').click();
    await waitFor(() => clip.ok.length >= 2 && successToasts().includes('${TOAST_COPY_SUCCESS}'), 'instruction copy lands');
    const instructionToastSeen = true;

    // 原始路径复制：按钮藏在来源 disclosure 里，真实入口先展开再点。
    await openSourceDisclosure();
    panel().querySelector('[data-action="copy-source"]').click();
    await waitFor(() => clip.ok.length >= 3 && successToasts().includes('${TOAST_PATH_COPIED}'), 'source copy lands');
    const pathToastSeen = true;

    // 失败路径 1：记录器 reject 一次 —— writeClipboardText 的异常原样冒泡，
    // runAction 把 error.message 原文上错误 toast；剪贴板不得新增成功写入。
    const beforeReject = { attempts: clip.attempts, ok: clip.ok.length };
    clip.rejectOnce = true;
    promptButton.click();
    await waitFor(() => errorToasts().includes('${REJECTION_MESSAGE}'), 'rejected write surfaces the rejection message');
    const rejectPath = {
      attemptsDelta: clip.attempts - beforeReject.attempts,
      okLength: clip.ok.length,
      errorTexts: errorToasts(),
    };

    // 失败路径 2：剪贴板 API 不存在 —— 产品走 copyFailed 文案的错误 toast，
    // 且根本不会调到记录器。
    navigator.clipboard.writeText = undefined;
    const beforeMissing = { attempts: clip.attempts };
    promptButton.click();
    await waitFor(() => errorToasts().includes('${TOAST_COPY_FAILED}'), 'missing clipboard API surfaces copyFailed');
    const missingApiPath = {
      attemptsDelta: clip.attempts - beforeMissing.attempts,
      okLength: clip.ok.length,
      errorTexts: errorToasts(),
    };

    return {
      promptButton: promptButtonFacts,
      writes: clip.ok,
      promptToastSeen,
      instructionToastSeen,
      pathToastSeen,
      rejectPath,
      missingApiPath,
      rendererErrors: rendererErrors.slice(0, 3),
    };
  })()`;
}

// S2：空素材 C —— 无 prompt 无指令时各复制入口的实际行为。
function emptyAssetSource(seeded) {
  return `(async () => {
    const seeded = ${JSON.stringify(seeded)};
    ${PAGE_HELPERS}
    ${CLIP_HELPERS}
    await waitFor(() => gallerySettled() && rootCardIds().length === 3, 'three seeded cards');
    await openDetailFor(seeded.c);
    const promptButton = panel().querySelector('[data-action="copy-prompt"]');
    const promptButtonFacts = { present: Boolean(promptButton), disabled: promptButton ? promptButton.disabled : null };
    const instructionButton = panel().querySelector('[data-action="copy-instruction"]');
    const instructionFacts = { present: Boolean(instructionButton), disabled: instructionButton ? instructionButton.disabled : null };
    // disabled 按钮的 click() 会被浏览器吞掉：点它之后不得有任何写入或提示。
    const beforeDisabledClick = { attempts: clip.attempts, ok: clip.ok.length };
    if (instructionButton) instructionButton.click();
    await sleep(400);
    const afterDisabledClick = {
      attempts: clip.attempts - beforeDisabledClick.attempts,
      ok: clip.ok.length - beforeDisabledClick.ok,
      toastCount: successToasts().length + errorToasts().length,
    };
    // 空提示词/空指令素材的原始路径仍在（store 总是记 source.path），
    // copy-source 照常工作。
    await openSourceDisclosure();
    panel().querySelector('[data-action="copy-source"]').click();
    await waitFor(() => clip.ok.length >= 1 && successToasts().includes('${TOAST_PATH_COPIED}'), 'empty-asset source copy lands');
    const sourceWrite = clip.ok[0];
    return {
      promptButton: promptButtonFacts,
      instruction: instructionFacts,
      afterDisabledClick,
      sourceWrite,
      rendererErrors: rendererErrors.slice(0, 3),
    };
  })()`;
}

// S3：卡片快捷复制 —— V2 把按钮 display:none（产品发现），钉住可见性状态，
// 并验证点击契约：复制提示词、不选中卡片、不开检视器。
function quickCopySource(seeded) {
  return `(async () => {
    const seeded = ${JSON.stringify(seeded)};
    ${PAGE_HELPERS}
    ${CLIP_HELPERS}
    await waitFor(() => gallerySettled() && rootCardIds().length === 3, 'three seeded cards');
    // 每个窗口是同一 userData 的新会话，app 会从 sessionStorage 恢复上一次的
    // 检视器；先用真实关闭按钮归零基线，再断言点击不选中不开检视器。
    if (detailOpen()) {
      click('[data-action="close-detail"]');
      await waitFor(() => !detailOpen(), 'restored inspector closed');
    }
    const before = { selected: selectedId(), open: detailOpen() };
    const button = document.querySelector(cardSelector(seeded.a) + ' .card-quick-copy');
    if (!button) throw new Error('Missing .card-quick-copy on card ' + seeded.a + ' diagnostic=' + JSON.stringify(pageDiagnostic()));
    // 产品发现：body.mosa-v2（index.html:13 硬编码）+ styles.css:1229 无条件
    // 写死 .mosa-v2 .card-quick-copy 的 display:none，按钮从未显现，hover/
    // focus 披露路径不存在。这里把观察到的可见性原样带回，由 Node 端钉住。
    const style = getComputedStyle(button);
    const visibility = { display: style.display, opacity: style.opacity, pointerEvents: style.pointerEvents };
    button.click();
    await waitFor(() => clip.ok.length >= 1 && successToasts().includes('${TOAST_COPY_SUCCESS}'), 'quick-copy writes the prompt');
    const after = { selected: selectedId(), open: detailOpen() };
    return {
      before,
      visibility,
      after,
      write: clip.ok[0],
      toastSeen: successToasts().includes('${TOAST_COPY_SUCCESS}'),
      rendererErrors: rendererErrors.slice(0, 3),
    };
  })()`;
}

// S4：生成记录的「打开生成结果」——从 A 跳到 B，双向的当前素材禁用分支都覆盖。
function openOutputSource(seeded) {
  return `(async () => {
    const seeded = ${JSON.stringify(seeded)};
    ${PAGE_HELPERS}
    ${CLIP_HELPERS}
    const genRegion = () => panel()?.querySelector('[data-generation-history]');
    const genNode = (eventId) => genRegion()?.querySelector('.generation-lineage-node[data-generation-id="' + eventId + '"]');
    const openButton = (eventId) => genNode(eventId)?.querySelector('[data-action="open-generation-output"]');
    const buttonFacts = (eventId) => {
      const button = openButton(eventId);
      return { disabled: button ? button.disabled : null, label: button ? button.textContent.trim() : '', target: button?.dataset.outputAssetId || '' };
    };
    await waitFor(() => gallerySettled() && rootCardIds().length === 3, 'three seeded cards');
    await openDetailFor(seeded.a);
    await waitFor(() => genNode(seeded.eventA) && genNode(seeded.eventB)
      && !genRegion().querySelector('.generation-history-status'), 'A generation tree renders both events');
    const before = {
      title: detailTitle(),
      selected: selectedId(),
      ownEventButton: buttonFacts(seeded.eventA),
      outputButton: buttonFacts(seeded.eventB),
    };
    // 真实入口：展开 eB 节点再点「打开素材」。
    const summary = genNode(seeded.eventB)?.querySelector('summary');
    if (!summary) throw new Error('Missing generation node summary for ' + seeded.eventB);
    if (!genNode(seeded.eventB).open) summary.click();
    await waitFor(() => genNode(seeded.eventB)?.open === true, 'generation node expands');
    const targetButton = openButton(seeded.eventB);
    if (!targetButton || targetButton.disabled) throw new Error('open-generation-output button missing or disabled: ' + JSON.stringify(buttonFacts(seeded.eventB)));
    targetButton.click();
    await waitFor(() => detailOpen() && selectedId() === seeded.b && detailImageSrc().includes(seeded.b),
      'inspector switches to B via open-generation-output');
    await waitFor(() => genNode(seeded.eventB) && !genRegion().querySelector('.generation-history-status'),
      "B generation tree renders after the switch");
    const after = {
      title: detailTitle(),
      selected: selectedId(),
      open: detailOpen(),
      ownEventButton: buttonFacts(seeded.eventB),
      parentButton: buttonFacts(seeded.eventA),
    };
    return { before, after, rendererErrors: rendererErrors.slice(0, 3) };
  })()`;
}
