// GravityPort A4a（任务 73）检视器浮层与色块流程：
// - 色块行：真实 PNG 派生出 palette 后渲染色块（≤8），aria-label 带色值，
//   点击把 hex 写进剪贴板（记录器）并弹「提示词已复制」toast。
// - 参考图「查看」浮层：打开（role=dialog + 焦点进入）、Esc 关闭且焦点回到
//   「查看」、点浮层外关闭。
// - 版本树「查看」浮层：打开后能在浮层里切版本（检视器跟随切换）；
//   浮层打开时全局快捷键（/）不响应。
// 文案断言依赖中文界面（e2e-web-driver 每窗口钉 zh）。

import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "inspector-overlay";
export const description = "A4a: swatch copy + reference/version overlay open, Esc/outside close, focus return, in-overlay version switch";

const TOAST_COPY_SUCCESS = "提示词已复制"; // copySuccess

export async function run(ctx) {
  await ctx.prepare();
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const config = {
    themeA: `浮层流程主图 ${stamp}`,
    themeB: `浮层流程产物 ${stamp}`,
    promptA: `浮层流程的主图提示词 ${stamp}`,
    requestPromptA: `发给图像工具的提示词 ${stamp}`,
    userMessageA: `把主图背景换成清晨的雾林 ${stamp}`,
    themeChild: `浮层流程版本二 ${stamp}`,
  };

  // 种子：一张高饱和纯色 PNG（派生 worker 从缩略图提取 palette）+ 两个提示词段
  // + 一个子版本 + 生成事件；palette 在 seed 服务器存活期间轮询到位。
  const seeded = await seed(ctx, config);

  const server = await ctx.startServer();
  try {
    const observed = await ctx.runInPage(server, overlayFlowSource({ ...config, ...seeded }));
    assertCondition(observed.swatch.count >= 1 && observed.swatch.count <= 8,
      `palette swatches should render between 1 and 8, got ${observed.swatch.count}`);
    assertCondition(observed.swatch.ariaLabels.every((label) => label.startsWith("复制颜色 #")),
      `swatch aria-labels must name the color: ${JSON.stringify(observed.swatch.ariaLabels)}`);
    assertCondition(observed.swatch.copiedHex === observed.swatch.firstHex,
      `clicking a swatch must copy its hex: copied ${JSON.stringify(observed.swatch.copiedHex)}, expected ${JSON.stringify(observed.swatch.firstHex)}`);
    assertCondition(observed.swatch.toastSeen === true, "the swatch copy must toast copySuccess");

    assertCondition(observed.tabs.both === true && observed.tabs.first === "提示词1" && observed.tabs.second === "提示词2",
      `two prompt segments must render both tabs: ${JSON.stringify(observed.tabs)}`);

    assertCondition(observed.reference.open.visible === true && observed.reference.open.modal === true,
      `the reference overlay must open as a modal dialog: ${JSON.stringify(observed.reference.open)}`);
    assertCondition(observed.reference.open.focusInside === true, "focus must move into the reference overlay");
    assertCondition(observed.reference.escClosed === true && observed.reference.escFocusBack === true,
      `Esc must close the reference overlay and return focus to 查看: ${JSON.stringify(observed.reference)}`);
    assertCondition(observed.reference.outsideClosed === true, "clicking outside must close the overlay");
    assertCondition(observed.reference.rightsRows === true, "the reference overlay renders the rights editor");
    assertCondition(observed.reference.boxThumbs === true, "the reference box shows 56px thumbnails");

    assertCondition(observed.version.open.visible === true && observed.version.open.focusInside === true,
      `the version overlay must open with focus inside: ${JSON.stringify(observed.version.open)}`);
    assertCondition(observed.version.shortcutBlocked === true, "global shortcuts must be blocked while the overlay is open");
    assertCondition(observed.version.rows.count === 1 && observed.version.rows.current === true,
      `the context box should show the single generation row as current: ${JSON.stringify(observed.version.rows)}`);
    assertCondition(observed.version.switched.selectedId === seeded.child && observed.version.switched.overlayClosed === true,
      `switching versions inside the overlay must follow the asset and close the overlay: ${JSON.stringify(observed.version.switched)}`);
    assertCondition(observed.version.reopenPickerValue === seeded.child,
      `reopening the overlay shows the switched version: ${JSON.stringify(observed.version)}`);
    assertNoRendererErrors(observed);
  } finally {
    await server.stop();
  }
  return seeded;
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}
function assertNoRendererErrors(result) {
  assertCondition(JSON.stringify(result?.rendererErrors || []) === "[]", `rendered with errors: ${JSON.stringify(result?.rendererErrors)}`);
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
    // 高饱和红：median cut 能提出确定的色板。b 先建，作为 a 的参考图挂进快照。
    const b = await create("inspector-overlay-b.png", [40, 90, 170], { prompt: "参考图流程的底图", theme: config.themeB });
    const a = await create("inspector-overlay-a.png", [196, 40, 30], {
      prompt: config.promptA,
      theme: config.themeA,
      source: { user_message: config.userMessageA, generation_request_prompt: config.requestPromptA },
      references: [{ asset_id: b.id, role: "subject", scope: ["style"] }],
    });
    const child = (await api("POST", `/api/assets/default/${encodeURIComponent(a.id)}/versions`, {
      version_change: "浮层流程版本二",
      prompt: "浮层流程版本二的提示词",
      theme: config.themeChild,
    })).asset.id;
    assertCondition(child && child !== a.id, "version seed returned no child id");
    // 给 A 一条生成事件（版本树上下文盒的行数据）。
    const recorded = await api("POST", "/api/generations", {
      output_asset_id: a.id, provider: "e2e-overlay", model: "e2e-model",
      conversation_id: "conv-e2e-overlay", message_id: "msg-e2e-overlay",
      effective_prompt: config.promptA, created_at: iso(2000),
    });
    assertCondition(recorded?.event?.id, "generation seed returned no event");
    // 等 palette 被派生 worker 提取出来（API 轮询，趁 seed 服务器存活）。
    const palette = await waitForPalette(ctx, server, a.id);
    return { a: a.id, b: b.id, child, eventA: recorded.event.id, palette };
  } finally {
    await server.stop();
  }
}

async function waitForPalette(ctx, server, assetId) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const payload = await ctx.api(server.origin, "GET", `/api/assets/default/${encodeURIComponent(assetId)}`);
    if (Array.isArray(payload?.asset?.palette) && payload.asset.palette.length) return payload.asset.palette;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`palette was never extracted for ${assetId}`);
}

const OVERLAY_HELPERS = String.raw`
  const panel = () => document.querySelector('#detailPanel');
  const detailOpen = () => panel()?.getAttribute('aria-hidden') === 'false';
  const selectedId = () => document.querySelector('.asset-card.selected')?.dataset.id || '';
  const overlay = () => panel()?.querySelector('[data-gp-overlay]');
  const overlayVisible = () => Boolean(overlay()) && !overlay().hidden;
  const swatches = () => [...(panel()?.querySelectorAll('[data-action="copy-swatch"]') || [])];
  const sectionView = (section) => panel()?.querySelector('[data-inspector-section="' + section + '"] [data-action$="-overlay"]');
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
    throw new Error('Timed out opening inspector for ' + assetId);
  }
  async function openOverlay(section) {
    // 「查看」随区块内容就绪（参考图要等 /recipes 异步加载）——轮询等它出现。
    let trigger = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      trigger = sectionView(section);
      if (trigger?.isConnected) break;
      await sleep(100);
    }
    if (!trigger) {
      throw new Error('Timed out waiting for the 查看 trigger of ' + section);
    }
    trigger.click();
    await waitFor(() => overlayVisible(), 'overlay opens for ' + section);
    return trigger;
  }
  const clip = { ok: [], attempts: 0 };
  if (!navigator.clipboard) Object.defineProperty(navigator, 'clipboard', { value: {}, configurable: true });
  navigator.clipboard.writeText = (text) => {
    clip.attempts += 1;
    clip.ok.push(String(text ?? ''));
    return Promise.resolve();
  };
`;

function overlayFlowSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    ${OVERLAY_HELPERS}
    await waitFor(() => gallerySettled() && rootCardIds().length >= 2, 'seeded cards');
    await openDetailFor(config.a);

    // S1 色块：数量 ≤8、aria-label、点击复制 hex + toast。
    await waitFor(() => swatches().length >= 1, 'palette swatches render');
    const nodes = swatches();
    const ariaLabels = nodes.map((node) => node.getAttribute('aria-label') || '');
    const firstHex = nodes[0].dataset.swatchColor;
    nodes[0].click();
    await waitFor(() => clip.ok.length >= 1, 'swatch copy lands');
    await waitFor(() => [...document.querySelectorAll('#toastContainer .toast.success .toast-message')].some((node) => node.textContent === '${TOAST_COPY_SUCCESS}'), 'copy toast');
    const swatch = { count: nodes.length, ariaLabels, firstHex, copiedHex: clip.ok[0], toastSeen: true };

    // S1b 提示词页签（两段 → 两个页签）。
    const tabs = [...(panel()?.querySelectorAll('[data-prompt-variant]') || [])].map((node) => node.textContent.trim());
    const tabInfo = { both: tabs.length === 2, first: tabs[0] || '', second: tabs[1] || '' };

    // S2 参考图浮层：打开 → 对话框语义 + 焦点进入 → Esc 关闭焦点回「查看」→
    // 重开 → 点外面关闭。
    const referenceTrigger = await openOverlay('reference');
    const open = { visible: overlayVisible(), modal: overlay().getAttribute('aria-modal') === 'true' && overlay().getAttribute('role') === 'dialog', focusInside: overlay().contains(document.activeElement) };
    document.querySelector('#detailPanel [data-gp-overlay]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await waitFor(() => !overlayVisible(), 'reference overlay closed by Escape');
    const escClosed = true;
    const escFocusBack = document.activeElement === referenceTrigger;
    const rightsRows = Boolean(panel()?.querySelector('[data-reference-rights] .reference-row'));
    const boxThumbs = Boolean(panel()?.querySelector('[data-inspector-section="reference"] .detail-reference-thumb img'));
    await openOverlay('reference');
    // 控制器在 document 捕获段监听 pointerdown（真实指针按下的语义）——
    // 程序化 .click() 不派发 pointerdown,这里直接派发 PointerEvent。
    panel()?.querySelector('[data-inspector-section="file"] h3#detailTitle')
      ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    await waitFor(() => !overlayVisible(), 'reference overlay closed by outside click');
    const outsideClosed = true;
    const reference = { open, escClosed, escFocusBack, outsideClosed, rightsRows, boxThumbs };

    // S3 版本树浮层：打开 + 焦点进入 + 全局快捷键被拦 + 上下文盒 + 浮层内切版本。
    await openOverlay('version');
    const versionOpen = { visible: overlayVisible(), focusInside: overlay().contains(document.activeElement) };
    // 浮层打开时「/」不得聚焦搜索框（hasBlockingOverlay 统一判定）。
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
    await sleep(150);
    const shortcutBlocked = document.activeElement !== document.querySelector('#searchInput');
    const rowNodes = [...(panel()?.querySelectorAll('[data-inspector-section="version"] .detail-version-context-row') || [])];
    const contextRows = { count: rowNodes.length, current: rowNodes.some((row) => row.classList.contains('is-current')) };
    // 浮层内切版本：选择器切到子版本 → 检视器跟随、浮层自动关闭。
    const select = panel()?.querySelector('[data-version-select]');
    if (!select) throw new Error('Missing version select inside the overlay');
    select.focus();
    select.value = config.child;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => selectedId() === config.child && detailOpen(), 'inspector follows the in-overlay version switch');
    await waitFor(() => !overlayVisible(), 'overlay auto-closes on the asset switch');
    const switched = { selectedId: selectedId(), overlayClosed: true };
    // 重开浮层：选择器显示新版本。
    await openOverlay('version');
    const reopenPickerValue = panel()?.querySelector('[data-version-select]')?.value || '';

    return { swatch, tabs: tabInfo, reference, version: { open: versionOpen, shortcutBlocked, rows: contextRows, switched, reopenPickerValue }, rendererErrors: rendererErrors.slice(0, 3) };
  })()`;
}
