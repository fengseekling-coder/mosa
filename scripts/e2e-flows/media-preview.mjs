// Pluggable e2e flow: 图片预览弹窗 + 视频播放。
// 图片预览（web/app/image-preview.mjs / app.mjs openImagePreview）：检视器里
// img.detail-image 外层的 button.detail-preview-entry（任务 36）是唯一 UI 入口——
// 鼠标双击打开（app.mjs 只在非视频素材上绑定）；键盘走入口的 keydown
// Enter/Space，或程序化 .click()（detail===0 分支）。API 预置两张 PNG（一张
// 400×300、一张 2400×1600 大图），经真实入口驱动弹窗：打开后显示正确素材
// （src 与 /api/assets 的 preview_url 逐字相等）、焦点落到关闭按钮；按钮关闭
// 与 Escape 关闭各一次，关闭后焦点回到键盘入口（button，任务 36 的焦点归还
// 契约；旧断言"回 body"记录的是入口不可聚焦时代的缺陷，已按新行为改掉）；
// 大图阶段断言"适应窗口"的 fit 尺寸与 scale(1)，再走缩放控件：滚轮放大 ×2、
// "+" 键、滚轮缩小、"0" 键复位。视频素材的检视器不得渲染预览入口（断言）。
// asset-viewer.mjs 已覆盖素材查看页（#assetView）的翻页/缩放，本流程不重复。
//
// 视频：webm 全链路被支持（前端 isSupportedImportFile、服务端 STAGING_EXTENSIONS /
// VIDEO_EXTENSIONS，media_kind 按扩展名判 video，派生图对视频跳过），所以不依赖
// ffmpeg：在页面里用 canvas.captureStream(0) + track.requestFrame() + MediaRecorder
// 录约 1.9 秒 webm（沙箱窗口 show:false 会节流 rAF，requestFrame 逐帧推流绕开它），
// 构造 File 后走真实拖入导入。断言画廊卡片 is-video 样式（video-badge + 占位海报
// video[data-gallery-video-src]）、检视器出现 <video class="detail-video" controls>
// 且 src 指向正确素材；播放用 <video controls> 的原生行为——原生控件的播放键在
// 封闭 shadow DOM 里无法合成点击，所以在页面里调用 play()——currentTime 前进，
// 暂停后不再前进。最后用接口复查：/api/assets?mediaKind=video 只含该素材、
// mediaKind=img 不含，image_path 以 .webm 结尾。
// 页面只回传观察到的事实，全部断言在 Node 端逐项检查。

import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "media-preview";
export const description = "inspector image preview modal via mouse dblclick + keyboard entry (Enter/Space, focus return): open/verify/close (button + Escape) -> wheel/keyboard zoom + fit; video: in-page MediaRecorder webm drop import -> video card styling -> detail <video> play/pause (no preview entry) -> mediaKind API recheck";

const SEED_TIMEOUT_MS = 30000;

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const images = await seedImages(ctx, server.origin);
    const image = assertImagePhase(await ctx.runInPage(server, imagePhaseSource(images)), images);
    const video = await videoPhase(ctx, server, images);
    return { image, video };
  } finally {
    await server.stop();
  }
}

// ===== 预置 =====

async function seedImages(ctx, origin) {
  const create = async (fileName, [r, g, b], width, height) => {
    const response = await ctx.api(origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: await ctx.makePng(fileName, [r, g, b], { width, height }),
      prompt: `media-preview ${fileName}`,
    });
    if (!response?.asset?.id) throw new Error(`media-preview seed failed for ${fileName}: ${JSON.stringify(response)}`);
    return response.asset.id;
  };
  const small = { id: await create("media-preview-small.png", [181, 68, 74], 400, 300) };
  const large = { id: await create("media-preview-large.png", [58, 138, 87], 2400, 1600) };
  for (const entry of [small, large]) {
    // openImagePreview 用 state.assets 里的 preview_url || image_url，先把派生图
    // 等 ready，页面快照与 Node 侧快照才不会在断言 src 时漂移。
    const deadline = Date.now() + SEED_TIMEOUT_MS;
    let asset = null;
    while (Date.now() < deadline) {
      asset = (await ctx.api(origin, "GET", `/api/assets/default/${encodeURIComponent(entry.id)}`))?.asset || null;
      if (asset?.preview_ready === true && asset?.preview_url) break;
      await sleep(150);
    }
    if (asset?.preview_ready !== true || !asset?.preview_url) {
      throw new Error(`media-preview seed: preview derivative not ready for ${entry.id}: ${JSON.stringify(asset && { preview_ready: asset.preview_ready, preview_url: asset.preview_url })}`);
    }
    entry.previewUrl = asset.preview_url;
    entry.imageUrl = asset.image_url;
  }
  return { small, large };
}

// ===== 图片预览弹窗 =====

function imagePhaseSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    const modal = () => document.querySelector('#imagePreviewModal');
    const modalOpen = () => Boolean(modal()) && !modal().hidden;
    const previewImg = () => document.querySelector('#imagePreviewImage');
    const stage = () => document.querySelector('#imagePreviewStage');
    const detailImg = () => document.querySelector('#detailPanel img.detail-image');
    const previewEntry = () => document.querySelector('#detailPanel .detail-preview-entry');
    const activeSig = () => {
      const el = document.activeElement;
      if (!el || el === document.body) return 'body';
      if (el.id) return '#' + el.id;
      return el.tagName.toLowerCase() + (el.classList.length ? '.' + el.classList[0] : '');
    };
    const transform = () => previewImg()?.style.transform || '';
    const parseTransform = (value) => {
      const match = /translate\\(([-\\d.]+)px, ([-\\d.]+)px\\) scale\\(([\\d.]+)\\)/.exec(value || '');
      return match ? { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) } : null;
    };
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
      await waitFor(() => document.querySelector('#detailPanel')?.getAttribute('aria-hidden') === 'false'
        && document.querySelector('.asset-card.selected')?.dataset.id === assetId, 'detail opens for ' + assetId);
      await waitFor(() => {
        const img = detailImg();
        return img && (img.getAttribute('src') || '').includes(assetId) && img.complete && img.naturalWidth > 0;
      }, 'detail image loaded for ' + assetId);
    }
    async function openPreview() {
      // 任务 36：入口是 button.detail-preview-entry，真实双击的 mousedown 会把
      // 焦点交给它；沙箱里只派发 dblclick（不合成 mousedown），焦点归还断言
      // 不依赖打开前的焦点位置——关闭后统一回入口。
      detailImg().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      await waitFor(modalOpen, 'image preview modal opens');
      await waitFor(() => !previewImg().hidden && previewImg().complete && previewImg().naturalWidth > 0, 'preview image loaded');
      // openImagePreview 经 requestAnimationFrame 把焦点交给关闭按钮，隐藏窗口
      // 下 rAF 可能迟到，放宽等待。
      await waitFor(() => document.activeElement === document.querySelector('#closeImagePreview'), 'focus on close button', 8000);
    }
    const closeAndWait = async () => {
      await waitFor(() => !modalOpen(), 'image preview modal closed');
      await sleep(120);
      return activeSig();
    };

    await waitFor(() => gallerySettled() && rootCardIds().length === 2, 'two seeded image cards');

    // 小图：打开 -> 观察内容与焦点 -> 按钮关闭。
    await openDetailFor(config.small.id);
    await openPreview();
    const openedSmall = {
      imgSrc: previewImg().getAttribute('src') || '',
      imgAlt: previewImg().getAttribute('alt') || '',
      titleText: document.querySelector('#imagePreviewTitle')?.textContent?.trim() || '',
      stageAria: stage()?.getAttribute('aria-label') || '',
      focusOnClose: document.activeElement === document.querySelector('#closeImagePreview'),
      transformBeforeZoom: transform(),
      stageZoomedClass: stage()?.classList.contains('zoomed') || false,
    };
    click('#closeImagePreview');
    const focusAfterButtonClose = await closeAndWait();

    // 重新打开 -> Escape 关闭（document 级 keydown 路由会消费它）。
    await openPreview();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const focusAfterEscape = await closeAndWait();

    // 大图：fit 尺寸 + 缩放控件各操作一次（滚轮入×2、'+'、滚轮出、'0' 复位）。
    await openDetailFor(config.large.id);
    await openPreview();
    await waitFor(() => (parseFloat(previewImg().style.width) || 0) > 0, 'fit applied to preview image', 8000);
    const openedLarge = {
      imgSrc: previewImg().getAttribute('src') || '',
      naturalWidth: previewImg().naturalWidth,
      naturalHeight: previewImg().naturalHeight,
      fitWidth: parseFloat(previewImg().style.width),
      fitHeight: parseFloat(previewImg().style.height),
      stageClientWidth: stage().clientWidth,
      stageClientHeight: stage().clientHeight,
      transform: transform(),
    };
    const zoomSteps = [];
    const recordStep = (via) => zoomSteps.push({ via, ...parseTransform(transform()), zoomed: stage()?.classList.contains('zoomed') || false });
    const wheelZoom = async (deltaY, label, expectScale) => {
      stage().dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
      await waitFor(() => parseTransform(transform())?.scale === expectScale, label, 8000);
      recordStep(label);
    };
    const keyZoom = async (key, label, expectScale) => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      await waitFor(() => parseTransform(transform())?.scale === expectScale, label, 8000);
      recordStep(label);
    };
    await wheelZoom(-120, 'wheel-in-1', 1.25);
    await wheelZoom(-120, 'wheel-in-2', 1.5);
    await keyZoom('+', 'key-plus', 1.75);
    await wheelZoom(120, 'wheel-out', 1.5);
    await keyZoom('0', 'key-zero-reset', 1);
    recordStep('final');
    click('#closeImagePreview');
    const focusAfterZoomClose = await closeAndWait();

    // ===== 任务 36：键盘路径 =====
    // 真实键盘走入口的 keydown 分支；沙箱里合成 KeyboardEvent 不会触发原生
    // 激活，但会经过同一段 keydown 处理（preventDefault + openImagePreview）。
    // 程序化 .click()（detail===0）是等价的另一条激活路径，一并断言。
    await openDetailFor(config.small.id);
    const entry = previewEntry();
    if (!entry) throw new Error('missing .detail-preview-entry in the inspector');
    const entryLabel = entry.getAttribute('aria-label') || '';
    entry.focus();
    const entryFocusable = document.activeElement === entry;
    entry.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await waitFor(modalOpen, 'preview opens via Enter');
    await waitFor(() => !previewImg().hidden && previewImg().complete && previewImg().naturalWidth > 0, 'preview image loaded (Enter)', 8000);
    // 关闭按钮的聚焦走 rAF，等它落位再断言（同 openPreview 的放宽等待）。
    await waitFor(() => document.activeElement === document.querySelector('#closeImagePreview'), 'focus on close button (Enter)', 8000);
    const keyboardEnter = {
      src: previewImg().getAttribute('src') || '',
      focusOnClose: document.activeElement === document.querySelector('#closeImagePreview'),
    };
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const focusAfterKeyboardEscape = await closeAndWait();
    entry.focus();
    entry.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    await waitFor(modalOpen, 'preview opens via Space');
    await waitFor(() => !previewImg().hidden && previewImg().complete && previewImg().naturalWidth > 0, 'preview image loaded (Space)', 8000);
    const keyboardSpace = { src: previewImg().getAttribute('src') || '' };
    click('#closeImagePreview');
    const focusAfterKeyboardButtonClose = await closeAndWait();
    // 鼠标单击不打开（保持任务 36 之前的现状）：detail>=1 的 click 不触发。
    entry.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    const singleClickOpens = modalOpen();

    return {
      openedSmall,
      focusAfterButtonClose,
      focusAfterEscape,
      openedLarge,
      zoomSteps,
      focusAfterZoomClose,
      keyboard: {
        entryLabel,
        entryFocusable,
        keyboardEnter,
        focusAfterKeyboardEscape,
        keyboardSpace,
        focusAfterKeyboardButtonClose,
        singleClickOpens,
      },
      rendererErrors,
    };
  })()`;
}

function assertImagePhase(result, config) {
  const problems = [];
  if (result?.rendererErrors?.length) problems.push(`renderer errors: ${JSON.stringify(result.rendererErrors)}`);

  const openedSmall = result?.openedSmall || {};
  if (openedSmall.imgSrc !== config.small.previewUrl) {
    problems.push(`small preview src ${openedSmall.imgSrc} != api preview ${config.small.previewUrl}`);
  }
  if (!openedSmall.titleText) problems.push("preview title empty");
  if (openedSmall.titleText !== openedSmall.imgAlt) {
    problems.push(`title ${JSON.stringify(openedSmall.titleText)} != img alt ${JSON.stringify(openedSmall.imgAlt)}`);
  }
  if (!openedSmall.stageAria.includes(openedSmall.titleText)) {
    problems.push(`stage aria-label ${JSON.stringify(openedSmall.stageAria)} misses title`);
  }
  if (openedSmall.focusOnClose !== true) problems.push(`focus after open: ${String(openedSmall.focusOnClose)}`);
  const initial = parseScale(openedSmall.transformBeforeZoom);
  if (initial?.scale !== 1 || initial?.x !== 0 || initial?.y !== 0) {
    problems.push(`initial transform ${JSON.stringify(openedSmall.transformBeforeZoom)}`);
  }
  if (openedSmall.stageZoomedClass !== false) problems.push("stage marked zoomed before any zoom");

  // 任务 36：关闭后焦点回到键盘入口（button.detail-preview-entry）。旧断言
  // "回 body" 记录的是入口（不可聚焦的 img）时代的缺陷，按新契约改写。
  const entrySig = "button.detail-preview-entry";
  if (result?.focusAfterButtonClose !== entrySig) problems.push(`focus after button close ${JSON.stringify(result?.focusAfterButtonClose)} != entry`);
  if (result?.focusAfterEscape !== entrySig) problems.push(`focus after Escape ${JSON.stringify(result?.focusAfterEscape)} != entry`);
  if (result?.focusAfterZoomClose !== entrySig) problems.push(`focus after zoom-phase close ${JSON.stringify(result?.focusAfterZoomClose)} != entry`);

  // 键盘路径：入口可聚焦、Enter/Space 打开正确的图、两条键盘关闭路径都回入口、
  // 鼠标单击不开（保持旧现状）。
  const kb = result?.keyboard || {};
  if (kb.entryLabel !== "查看大图") problems.push(`entry aria-label ${JSON.stringify(kb.entryLabel)}`);
  if (kb.entryFocusable !== true) problems.push("entry is not focusable via focus()");
  if (kb.keyboardEnter?.src !== config.small.previewUrl) {
    problems.push(`Enter-opened preview src ${JSON.stringify(kb.keyboardEnter?.src)} != api preview`);
  }
  if (kb.keyboardEnter?.focusOnClose !== true) problems.push(`focus after Enter-open: ${String(kb.keyboardEnter?.focusOnClose)}`);
  if (kb.focusAfterKeyboardEscape !== entrySig) problems.push(`focus after keyboard Escape close ${JSON.stringify(kb.focusAfterKeyboardEscape)} != entry`);
  if (kb.keyboardSpace?.src !== config.small.previewUrl) {
    problems.push(`Space-opened preview src ${JSON.stringify(kb.keyboardSpace?.src)} != api preview`);
  }
  if (kb.focusAfterKeyboardButtonClose !== entrySig) problems.push(`focus after keyboard button close ${JSON.stringify(kb.focusAfterKeyboardButtonClose)} != entry`);
  if (kb.singleClickOpens !== false) problems.push(`single click (detail=1) opened the preview: ${String(kb.singleClickOpens)} (must stay closed)`);

  const openedLarge = result?.openedLarge || {};
  if (openedLarge.imgSrc !== config.large.previewUrl) {
    problems.push(`large preview src ${openedLarge.imgSrc} != api preview ${config.large.previewUrl}`);
  }
  const fitWidth = openedLarge.fitWidth || 0;
  const fitHeight = openedLarge.fitHeight || 0;
  const stageWidth = openedLarge.stageClientWidth || 0;
  const stageHeight = openedLarge.stageClientHeight || 0;
  if (!(fitWidth > 0 && fitHeight > 0)) problems.push(`fit size ${fitWidth}x${fitHeight}`);
  else {
    if (fitWidth > stageWidth + 1 || fitHeight > stageHeight + 1) {
      problems.push(`fit ${fitWidth}x${fitHeight} exceeds stage ${stageWidth}x${stageHeight}`);
    }
    const naturalRatio = (openedLarge.naturalWidth || 0) / (openedLarge.naturalHeight || 1);
    const fitRatio = fitWidth / fitHeight;
    if (Math.abs(naturalRatio - fitRatio) > Math.max(0.02, naturalRatio * 0.01)) {
      problems.push(`fit aspect ${fitRatio.toFixed(3)} != natural ${naturalRatio.toFixed(3)}`);
    }
  }
  const fitTransform = parseScale(openedLarge.transform);
  if (fitTransform?.scale !== 1) problems.push(`transform at open ${JSON.stringify(openedLarge.transform)}`);

  // 缩放步长 0.25（image-preview.mjs IMAGE_PREVIEW_ZOOM_STEP）：
  // 滚轮入×2 -> 1.25 -> 1.5，'+' -> 1.75，滚轮出 -> 1.5，'0' 复位 -> 1。
  const expectedScales = { "wheel-in-1": 1.25, "wheel-in-2": 1.5, "key-plus": 1.75, "wheel-out": 1.5, "key-zero-reset": 1 };
  const steps = Array.isArray(result?.zoomSteps) ? result.zoomSteps : [];
  for (const [via, scale] of Object.entries(expectedScales)) {
    const step = steps.find((entry) => entry.via === via);
    if (!step) { problems.push(`zoom step ${via} missing`); continue; }
    if (step.scale !== scale) problems.push(`zoom ${via} scale ${step.scale} != ${scale}`);
    if (step.x !== 0 || step.y !== 0) problems.push(`zoom ${via} pan ${step.x},${step.y} (no pan input expected)`);
    if (step.zoomed !== (scale > 1)) problems.push(`zoom ${via} stage.zoomed=${String(step.zoomed)} at scale ${scale}`);
  }
  const final = steps.find((entry) => entry.via === "final");
  if (!final || final.scale !== 1 || final.x !== 0 || final.y !== 0) {
    problems.push(`final transform ${JSON.stringify(final || null)}`);
  }

  if (problems.length) throw new Error(`Media preview image phase mismatches: ${problems.join("; ")}`);
  return {
    smallSrc: openedSmall.imgSrc,
    titleText: openedSmall.titleText,
    focusAfterButtonClose: result.focusAfterButtonClose,
    focusAfterEscape: result.focusAfterEscape,
    focusAfterZoomClose: result.focusAfterZoomClose,
    fitSize: [openedLarge.fitWidth, openedLarge.fitHeight],
    zoomScales: steps.map((entry) => entry.scale),
  };
}

function parseScale(transformText) {
  const match = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/.exec(transformText || "");
  return match ? { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) } : null;
}

// ===== 视频：页面内录制 webm -> 拖入 -> 卡片/检视器/播放 =====

async function videoPhase(ctx, server, images) {
  const videoResult = await ctx.runInPage(server, videoPhaseSource());
  if (videoResult?.videoSupport?.ok === false) {
    // 录制能力缺失才跳过；当前 Electron 渲染端始终带 MediaRecorder + canvas，
    // CI 上不会走到这个分支。
    return { videoSkipped: true, reason: String(videoResult.videoSupport.reason || "video recording unsupported") };
  }
  return assertVideoPhase(ctx, server, videoResult, images);
}

function videoPhaseSource() {
  return `(async () => {
    ${PAGE_HELPERS}
    const libraryDropTarget = () => {
      const el = document.querySelector('.library');
      if (!el) throw new Error('Missing .library drop surface');
      return el;
    };
    async function clickCard(assetId) {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const button = document.querySelector(cardSelector(assetId) + ' .asset-card-select');
        if (button?.isConnected) { button.click(); return; }
        await sleep(100);
      }
      throw new Error('Timed out clicking card ' + assetId);
    }
    // 录一段约 1.9 秒的 webm：captureStream(0) 只在 requestFrame() 时出一帧，
    // 不依赖 rAF（沙箱窗口 show:false 会被节流）；帧时间戳来自真实时钟，播放
    // 时 currentTime 按墙钟前进。
    async function recordWebmVideo(fileName) {
      if (typeof MediaRecorder === 'undefined') return { ok: false, reason: 'MediaRecorder unavailable in renderer' };
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 120;
      const context = canvas.getContext('2d');
      if (!context || !canvas.captureStream) return { ok: false, reason: 'canvas.captureStream unavailable' };
      const stream = canvas.captureStream(0);
      const track = stream.getVideoTracks()[0];
      if (!track || typeof track.requestFrame !== 'function') return { ok: false, reason: 'CanvasCaptureMediaStreamTrack.requestFrame unavailable' };
      const mimeType = ['video/webm;codecs=vp8', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type)) || '';
      if (!mimeType) return { ok: false, reason: 'no supported webm mimeType for MediaRecorder' };
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks = [];
      recorder.ondataavailable = (event) => { if (event.data && event.data.size) chunks.push(event.data); };
      const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
      recorder.start(200);
      const colors = ['#1a7f5a', '#b3502a', '#3311aa', '#aa3311', '#1166aa', '#66aa11', '#aa6611', '#11aa66', '#5a4fcf', '#1868a8', '#7d3c98', '#d68910'];
      for (const color of colors) {
        context.fillStyle = color;
        context.fillRect(0, 0, canvas.width, canvas.height);
        track.requestFrame();
        await sleep(160);
      }
      recorder.stop();
      await stopped;
      const blob = new Blob(chunks, { type: 'video/webm' });
      if (!blob.size) return { ok: false, reason: 'MediaRecorder produced 0 bytes' };
      return { ok: true, bytes: blob.size, mimeType, file: new File([blob], fileName, { type: 'video/webm' }) };
    }

    await waitFor(() => gallerySettled() && rootCardIds().length === 2, 'two image cards before the video drop');
    const record = await recordWebmVideo('mosa-media-preview.webm');
    if (!record.ok) return { videoSupport: { ok: false, reason: record.reason } };
    const before = rootCardIds();
    beginFileDrag(libraryDropTarget(), [record.file])();
    await waitFor(() => gallerySettled() && rootCardIds().length === before.length + 1, 'video card appears after drop', 30000);
    const videoId = rootCardIds().find((id) => !before.includes(id)) || '';
    if (!videoId) throw new Error('No new card id after the video drop');
    const card = () => document.querySelector(cardSelector(videoId));
    const cardFacts = {
      isVideoClass: card().classList.contains('is-video'),
      hasVideoThumb: Boolean(card().querySelector('.video-thumb')),
      badgeText: card().querySelector('.video-badge')?.textContent || '',
      posterForm: card().querySelector('img.thumb-video-poster') ? 'img'
        : (card().querySelector('video.thumb-video-poster') ? 'video' : 'none'),
      posterVideoSrc: card().querySelector('video.thumb-video-poster')?.getAttribute('data-gallery-video-src') || '',
    };

    await clickCard(videoId);
    await waitFor(() => document.querySelector('#detailPanel')?.getAttribute('aria-hidden') === 'false'
      && document.querySelector('.asset-card.selected')?.dataset.id === videoId, 'detail opens for the video');
    const detailVideo = await waitFor(() => document.querySelector('#detailPanel video.detail-image'), 'detail <video> element');
    const detailFacts = {
      detailVideoClass: detailVideo.classList.contains('detail-video'),
      src: detailVideo.getAttribute('src') || '',
      hasControls: detailVideo.controls === true,
      // 任务 36：视频检视器不得渲染图片预览入口（入口只包 img 分支）。
      hasPreviewEntry: Boolean(document.querySelector('#detailPanel .detail-preview-entry')),
    };
    // 原生 controls 的播放键在封闭 shadow DOM 里，无法合成点击；Electron 默认
    // autoplay 策略允许无手势播放，所以在页面里直接调用 play()。
    const playOutcome = await detailVideo.play().then(() => 'playing', (error) => 'rejected:' + (error?.name || error));
    await waitFor(() => detailVideo.currentTime > 0.1 || detailVideo.ended, 'playback advances', 10000);
    const t1 = detailVideo.currentTime;
    const playingAtT1 = !detailVideo.paused;
    await sleep(250);
    const t2 = detailVideo.currentTime;
    detailVideo.pause();
    const pausedAt = detailVideo.currentTime;
    const pausedFlag = detailVideo.paused;
    await sleep(700);
    const tAfterPause = detailVideo.currentTime;
    const playback = {
      playOutcome,
      t1,
      t2,
      playingAtT1,
      advancedWhilePlaying: t2 > t1,
      endedDuringPlayback: detailVideo.ended,
      pausedFlag,
      pausedAt,
      tAfterPause,
      frozenAfterPause: Math.abs(tAfterPause - pausedAt) < 0.05,
    };
    await sleep(200);
    return {
      videoSupport: { ok: true, bytes: record.bytes, mimeType: record.mimeType },
      videoId,
      cardFacts,
      detailFacts,
      playback,
      rendererErrors,
    };
  })()`;
}

async function assertVideoPhase(ctx, server, result, images) {
  const problems = [];
  if (result?.rendererErrors?.length) problems.push(`renderer errors: ${JSON.stringify(result.rendererErrors)}`);

  const videoId = result?.videoId || "";
  if (!videoId) problems.push("no video asset id");

  const cardFacts = result?.cardFacts || {};
  if (cardFacts.isVideoClass !== true) problems.push("card lacks is-video class");
  if (cardFacts.hasVideoThumb !== true) problems.push("card lacks .video-thumb");
  if (!(cardFacts.badgeText || "").includes("▶")) problems.push(`video badge text ${JSON.stringify(cardFacts.badgeText)}`);
  // 视频导入跳过派生图（thumbnail_path 为空 -> thumbnail_url 与原图相同），
  // 海报必然是占位 video 形态，data-gallery-video-src 指向原图。
  if (cardFacts.posterForm !== "video") problems.push(`video poster form ${JSON.stringify(cardFacts.posterForm)}, expected placeholder video`);

  const detailFacts = result?.detailFacts || {};
  if (detailFacts.detailVideoClass !== true) problems.push("detail media lacks detail-video class");
  if (detailFacts.hasControls !== true) problems.push("detail video has no controls attribute");
  if (detailFacts.hasPreviewEntry !== false) problems.push("video detail must not render the image preview entry (task 36)");

  const playback = result?.playback || {};
  if (playback.playOutcome !== "playing") problems.push(`play() outcome ${JSON.stringify(playback.playOutcome)}`);
  if (playback.advancedWhilePlaying !== true) {
    problems.push(`currentTime did not advance while playing (t1=${playback.t1}, t2=${playback.t2})`);
  }
  if (playback.pausedFlag !== true) problems.push("video not paused after pause()");
  if (playback.frozenAfterPause !== true) {
    problems.push(`currentTime moved after pause (pausedAt=${playback.pausedAt}, after=${playback.tAfterPause})`);
  }

  // 接口复查：服务端按扩展名把 webm 归为 video；mediaKind 过滤是它的 HTTP 面。
  const videoListed = ((await ctx.api(server.origin, "GET", "/api/assets?project=default&mediaKind=video")).assets || []);
  if (videoListed.map((asset) => asset.id).join(",") !== videoId) {
    problems.push(`mediaKind=video listing ${JSON.stringify(videoListed.map((asset) => asset.id))} != [${videoId}]`);
  }
  const imageListed = ((await ctx.api(server.origin, "GET", "/api/assets?project=default&mediaKind=img")).assets || []);
  if (imageListed.some((asset) => asset.id === videoId)) problems.push("video asset leaked into mediaKind=img listing");
  const videoAsset = videoListed.find((asset) => asset.id === videoId) || null;
  if (!videoAsset) {
    problems.push("video asset missing from mediaKind=video listing");
  } else {
    if (!/\.webm$/i.test(String(videoAsset.image_path || ""))) {
      problems.push(`video asset image_path ${JSON.stringify(videoAsset.image_path)}`);
    }
    if (detailFacts.src && videoAsset.image_url && detailFacts.src !== videoAsset.image_url) {
      problems.push(`detail src ${detailFacts.src} != api image_url ${videoAsset.image_url}`);
    }
    if (cardFacts.posterVideoSrc && videoAsset.image_url && cardFacts.posterVideoSrc !== videoAsset.image_url) {
      problems.push(`poster video src ${cardFacts.posterVideoSrc} != api image_url ${videoAsset.image_url}`);
    }
  }
  // 图片不受影响：两张预置图仍归 image 列表。
  if (imageListed.length !== 2 || !imageListed.every((asset) => asset.id === images.small.id || asset.id === images.large.id)) {
    problems.push(`mediaKind=img listing ${JSON.stringify(imageListed.map((asset) => asset.id))}`);
  }

  if (problems.length) throw new Error(`Media preview video phase mismatches: ${problems.join("; ")}`);
  return {
    videoId,
    recordedBytes: result.videoSupport?.bytes || 0,
    cardFacts,
    playback,
    mediaKindListing: { video: [videoId], imageCount: imageListed.length },
  };
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
