// ===== Asset view（大图查看器）——提取自 app.js，REFACTORING-PLAN R1 批次 4 =====
// els/state/t 及数据/渲染/导航依赖经 createAssetViewer 工厂注入；transform/序列/指针表等
// 模块级状态随闭包迁移；事件语义/钳制公式/手势状态机与原先完全一致。
import { displayAssetTitle } from "./utils.mjs";

export function createAssetViewer({
  els, state, t,
  announceGalleryStatus, selectedAsset, isVideoAsset, confirmDetailNavigation, discardDetailDraft,
  isCurrentDetailSelection, assetRequestKey, currentAssetRequest, requestAssetPage,
  renderGrid, updateViewTitle, showToast, renderDetail, updateSelectedCard,
  setDetailOpen, setupMasonryLayout,
}) {
  // ===== 专用大图查看模式（Phase 3A / D4 / F-01） =====
  // 终态结构：左侧 Sidebar + 中央专用大图工作区 + 右侧素材信息面板（既有详情面板复用，
  // .details-open 语义转为专用查看模式）；不显示画廊网格、无缩略图条、无相关素材。
  // 最小状态：state.viewMode（library/asset）+ state.libraryReturnSnapshot；无第二套
  // selectedAsset、无平行 Router、不深拷贝 state。缩放/平移/上一张下一张属 Phase 3B/3C。
  function currentScopeTitle() {
    return els.viewTitle?.textContent?.trim() || t("allAssets");
  }

  function setViewMode(mode) {
    state.viewMode = mode === "asset" ? "asset" : "library";
    const assetMode = state.viewMode === "asset";
    els.appShell?.classList.toggle("asset-view-open", assetMode);
    // hidden + inert + aria-hidden 组合：退出布局、Tab 顺序与辅助技术树。
    if (els.libraryView) {
      els.libraryView.hidden = assetMode;
      els.libraryView.toggleAttribute("inert", assetMode);
      els.libraryView.setAttribute("aria-hidden", String(assetMode));
    }
    if (els.assetView) {
      els.assetView.hidden = !assetMode;
      els.assetView.toggleAttribute("inert", !assetMode);
      els.assetView.setAttribute("aria-hidden", String(!assetMode));
    }
  }

  function renderAssetView() {
    const asset = selectedAsset();
    if (!asset || !els.assetViewImage || !els.assetViewVideo) return;
    const title = displayAssetTitle(asset);
    const displayImageUrl = asset.preview_url || asset.image_url;
    if (els.assetViewScope) els.assetViewScope.textContent = currentScopeTitle();
    if (els.assetViewTitle) els.assetViewTitle.textContent = t("viewingAsset", { title });
    if (els.assetViewError) els.assetViewError.hidden = true;
    // Phase 3B：切换素材即重置为 fit（不继承上一张的缩放位置）；同一素材仅元数据
    // 重渲染（收藏/语言切换）保持 transform。若同一 ID 的底层文件被替换、image_url
    // 发生变化，则它已是新的媒体几何，必须重新加载并 fit，不能继续显示旧 src。
    if (asset.id !== assetViewStageAssetId) {
      assetViewStageAssetId = asset.id;
      assetViewStageAssetUrl = displayImageUrl;
      resetAssetViewTransform();
    } else if (displayImageUrl !== assetViewStageAssetUrl) {
      assetViewStageAssetUrl = displayImageUrl;
      resetAssetViewTransform();
    }
    if (isVideoAsset(asset)) {
      els.assetViewImage.hidden = true;
      els.assetViewImage.removeAttribute("src");
      els.assetViewVideo.hidden = false;
      if (els.assetViewVideo.getAttribute("src") !== asset.image_url) els.assetViewVideo.src = asset.image_url;
      return;
    }
    els.assetViewVideo.pause();
    els.assetViewVideo.removeAttribute("src");
    els.assetViewVideo.hidden = true;
    els.assetViewImage.hidden = false;
    els.assetViewImage.alt = title;
    els.assetViewImage.dataset.originalUrl = asset.image_url || "";
    const currentImageUrl = els.assetViewImage.dataset.assetUrl || "";
    const currentImageIsUsable = currentImageUrl === displayImageUrl || currentImageUrl === asset.image_url;
    if (els.assetViewImage.dataset.assetId !== asset.id || !currentImageIsUsable) {
      // Phase 3C 竞态防护：以素材 ID 为唯一会话键（同 URL 重复变体间导航也算切换）——
      // src、ID 与 URL 守卫/结算标记同步切换，晚到的旧 load/error 事件据此被识别并丢弃。
      cancelAssetViewOriginalPreload();
      els.assetViewImage.dataset.assetId = asset.id;
      els.assetViewImage.dataset.assetUrl = displayImageUrl;
      els.assetViewImage.dataset.upgradingOriginal = "";
      els.assetViewImage.dataset.loadSettled = "";
      if (els.assetViewImage.getAttribute("src") !== displayImageUrl) els.assetViewImage.src = displayImageUrl;
      // 缓存命中时 load 事件可能不再派发，同步完成初始 fit（handleAssetViewImageLoad 幂等）；
      // 同 URL 破图（重复变体）不再派发 error，同步恢复错误态（handleAssetViewImageError 幂等）。
      if (els.assetViewImage.complete && els.assetViewImage.naturalWidth > 0) handleAssetViewImageLoad();
      else if (els.assetViewImage.complete && els.assetViewImage.getAttribute("src")) handleAssetViewImageError();
    }
  }

  // Library 真实滚动容器：桌面档 Grid 内部滚动（overflow-y 允许且内容溢出）；
  // Web 回退档（≤959px，body 放开滚动）真实滚动发生在文档级滚动元素。
  // 快照捕获与恢复都经此唯一入口——绝不假设 window.scrollY，也不永久假设 assetGrid。
  function getLibraryScrollContainer() {
    const grid = els.assetGrid;
    if (grid && grid.scrollHeight > grid.clientHeight) {
      const overflowY = getComputedStyle(grid).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") return grid;
    }
    return document.scrollingElement || document.documentElement;
  }

  async function openAssetView(id, trigger) {
    if (!id || state.viewMode === "asset") return;
    const originProjectId = state.project;
    const originAssetId = state.selectedId;
    if (!await confirmDetailNavigation(id)) return;
    // Phase 5B context guard：确认期间 Detail 选择已变化时安全取消，不进入查看模式。
    if (originAssetId !== null && !isCurrentDetailSelection(originProjectId, originAssetId)) return;
    discardDetailDraft();
    // 画廊上下文快照：真实滚动容器的 scrollTop（经 getLibraryScrollContainer 解析）；
    // requestKey 标识结果集语义，查看期间搜索/筛选/排序/项目变化时恢复自动降级。
    assetViewReturnGridWidth = els.assetGrid?.clientWidth || 0;
    state.libraryReturnSnapshot = {
      scrollTop: getLibraryScrollContainer().scrollTop,
      focusedAssetId: trigger?.closest?.(".asset-card")?.dataset.id || id,
      selectedAssetId: state.selectedId,
      requestKey: assetRequestKey(currentAssetRequest()),
    };
    // Phase 3C：从 renderGrid 使用的最终有序结果捕获本次 Viewer session 的稳定 ID 序列
    // （含当前搜索/筛选/排序/分组/范围语义）；与快照同一 requestKey，返回 Library 时清空。
    // BUG-10（Batch 2A）：session 额外持有查询集总数、游标与只读查询快照——边界按需加载
    // 沿用捕获时的分页语义，不读取运行中已变化的筛选状态；generation 标识本次会话代际。
    assetViewSequence.ids = state.assets.map((asset) => asset.id);
    assetViewSequence.index = assetViewSequence.ids.indexOf(id);
    assetViewSequence.requestKey = state.libraryReturnSnapshot.requestKey;
    assetViewSequence.total = state.pageTotal;
    assetViewSequence.nextCursor = state.nextCursor;
    assetViewSequence.snapshot = currentAssetRequest();
    assetViewSequence.loading = false;
    assetViewSequence.generation += 1;
    assetViewGalleryDirty = false;
    state.selectedId = id; state.detailAsset = null; state.versionHistory = null; state.recipeHistory = null; state.generationHistory = null;
    setViewMode("asset");
    setupAssetViewInteraction();
    renderAssetView();
    updateAssetViewNav();
    preloadAssetViewNeighbors();
    setDetailOpen(true);
    updateSelectedCard();
    // 返回是查看模式的主操作：进入后焦点落在返回按钮（同步聚焦——rAF 在隐藏窗口不执行）。
    els.assetViewBack?.focus();
    const viewed = selectedAsset();
    announceGalleryStatus(t("viewingAsset", { title: viewed?.theme || viewed?.asset || id }));
  }

  function returnToLibrary() {
    if (state.viewMode !== "asset") return;
    // Phase 3B：先清理舞台交互（wheel/pointer 监听、拖拽会话、ResizeObserver），再切回 Library。
    teardownAssetViewInteraction();
    cancelAssetViewDetailRender();
    cancelAssetViewNeighborPreloads();
    cancelAssetViewOriginalPreload();
    assetViewStageAssetId = null;
    assetViewStageAssetUrl = null;
    // Phase 3C：Viewer session 结束，清理导航序列（不落盘、不带回 Library）。
    // BUG-10：连同总数/游标/查询快照一并清空并推进 generation，晚到的分页响应据此丢弃。
    assetViewSequence.ids = [];
    assetViewSequence.index = -1;
    assetViewSequence.requestKey = "";
    assetViewSequence.total = 0;
    assetViewSequence.nextCursor = null;
    assetViewSequence.snapshot = null;
    assetViewSequence.loading = false;
    assetViewSequence.generation += 1;
    const snapshot = state.libraryReturnSnapshot;
    state.libraryReturnSnapshot = null;
    const returnGridWidth = assetViewReturnGridWidth;
    assetViewReturnGridWidth = 0;
    setViewMode("library");
    const galleryWasDirty = assetViewGalleryDirty;
    if (assetViewGalleryDirty) {
      renderGrid({ preserveScroll: true });
      updateViewTitle();
      assetViewGalleryDirty = false;
    }
    setDetailOpen(false);
    announceGalleryStatus(t("returnedToLibrary"));
    if (!snapshot || !els.assetGrid) return;
    if (snapshot.requestKey !== assetRequestKey(currentAssetRequest())) {
      // 结果集语义已变化：滚动/原卡片焦点快照失效。且 setDetailOpen(false) 刚把焦点送回
      // 打开前的元素——若那是画廊卡片，它会随结果重渲染从 DOM 移除，焦点掉到 <body>。
      // 降级路径一律把焦点落到画廊容器（主内容），绝不留在随重渲染死亡的元素上。
      els.assetGrid.focus();
      return;
    }
    // display:none 期间滚动容器 scrollTop 被钳为 0；重新可见并布局完成后恢复（双 rAF，非固定延时）。
    // 同一稳定帧内先写 scrollTop、再恢复焦点——焦点恢复必须发生在滚动恢复之后。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // BUG-10（Batch 2A）：Viewer 内追加页的 Gallery 渲染发生在 hidden 容器中，
        // 图片 load 时的 masonry 测量全为 0（卡片塌陷为几像素）。返回后重新调度布局
        // ——重新绑定 load 监听并同步 + rAF 各布局一次，保证滚动恢复前容器高度真实。
        const gridWidthChanged = Math.abs((els.assetGrid?.clientWidth || 0) - returnGridWidth) >= 0.5;
        if (galleryWasDirty || gridWidthChanged) setupMasonryLayout();
        // 恢复时重新解析当前真实容器（查看期间视口/布局可能已变化）。
        getLibraryScrollContainer().scrollTop = snapshot.scrollTop;
        const activeEl = document.activeElement;
        if (activeEl instanceof HTMLElement && els.assetGrid.contains(activeEl)) return;
        const cardButton = snapshot.focusedAssetId
          ? els.assetGrid.querySelector(`.asset-card[data-id="${CSS.escape(snapshot.focusedAssetId)}"] .asset-card-select`)
          : null;
        // preventScroll：焦点本身不得反向改动刚恢复的滚动位置。
        if (cardButton) cardButton.focus({ preventScroll: true });
        else els.assetGrid.focus({ preventScroll: true });
      });
    });
  }

  // ===== 专用大图舞台交互（Phase 3B / F-03 / F-09） =====
  // assetViewTransform 是专用大图舞台唯一的可变 transform state——与旧 Lightbox 的
  // state.imageZoom/imagePanX/imagePanY 完全隔离（两模式不共享可变状态、不同时监听 wheel）。
  // 约定：scale=1 表示图片自然尺寸的 100%；offsetX/offsetY 为舞台 CSS 像素，以舞台
  // content box 中心为原点。fitScale 是派生值，每次经 computeAssetFitScale 由舞台 content
  // box 与图片自然尺寸现算，不作为互相冲突的第二状态来源长期保存。不按素材持久化缩放
  // 位置：切换素材重置为 fit；返回 Library 清理全部瞬时状态。
  const ASSET_VIEW_ZOOM_STEP = 1.2;
  const ASSET_VIEW_MAX_SCALE = 8;
  const ASSET_VIEW_MIN_SCALE_FLOOR = 0.1;
  const ASSET_VIEW_SCALE_EPSILON = 1e-6;
  const assetViewTransform = { mode: "fit", scale: 1, offsetX: 0, offsetY: 0, isPanning: false };
  let assetViewStageAssetId = null;
  let assetViewStageAssetUrl = null;
  let assetViewOriginalPreload = null;
  let assetViewInteractionActive = false;
  let assetViewStageObserver = null;
  let assetViewStageGeometry = null;
  let assetViewPanSession = null;
  const assetViewActivePointers = new Map();
  let assetViewPinchSession = null;
  let assetViewTransformFrame = null;
  let assetViewDetailFrame = null;
  let assetViewDetailSecondFrame = null;
  const assetViewNeighborPreloads = new Map();

  function cancelAssetViewDetailRender() {
    if (assetViewDetailFrame !== null) cancelAnimationFrame(assetViewDetailFrame);
    if (assetViewDetailSecondFrame !== null) cancelAnimationFrame(assetViewDetailSecondFrame);
    assetViewDetailFrame = null;
    assetViewDetailSecondFrame = null;
  }

  // Keep the media swap on the current frame. The Inspector rebuild starts
  // after one paint, so rapid Previous/Next navigation cannot make both large
  // DOM updates compete for the same frame budget.
  function scheduleAssetViewDetailRender(assetId) {
    cancelAssetViewDetailRender();
    assetViewDetailFrame = requestAnimationFrame(() => {
      assetViewDetailFrame = null;
      assetViewDetailSecondFrame = requestAnimationFrame(() => {
        assetViewDetailSecondFrame = null;
        if (state.viewMode !== "asset" || state.selectedId !== assetId) return;
        renderDetail({ syncAssetView: false });
      });
    });
  }

  function cancelAssetViewNeighborPreloads() {
    for (const loader of assetViewNeighborPreloads.values()) loader.src = "";
    assetViewNeighborPreloads.clear();
  }

  function preloadAssetViewNeighbors() {
    if (state.viewMode !== "asset" || assetViewSequence.index < 0) return;
    const wanted = new Set();
    for (const offset of [-1, 1, 2]) {
      const id = assetViewSequence.ids[assetViewSequence.index + offset];
      if (!id) continue;
      const asset = state.assets.find((candidate) => candidate.id === id);
      if (!asset || isVideoAsset(asset)) continue;
      const url = asset.preview_url || asset.medium_url || asset.image_url || "";
      if (!url) continue;
      wanted.add(url);
      if (assetViewNeighborPreloads.has(url)) continue;
      const loader = new Image();
      loader.decoding = "async";
      loader.src = url;
      assetViewNeighborPreloads.set(url, loader);
    }
    for (const [url, loader] of assetViewNeighborPreloads) {
      if (wanted.has(url)) continue;
      loader.src = "";
      assetViewNeighborPreloads.delete(url);
    }
  }

  // ----- 集中式纯几何 helper：事件处理器只组装输入，不复制公式 -----
  // 舞台可用几何 = content box（clientWidth/Height 去掉 padding），与 contain 语义一致。
  function refreshAssetViewStageGeometry() {
    const stage = els.assetViewStage;
    if (!stage) {
      assetViewStageGeometry = { left: 0, top: 0, width: 0, height: 0 };
      return assetViewStageGeometry;
    }
    const rect = stage.getBoundingClientRect();
    const styles = getComputedStyle(stage);
    const paddingLeft = parseFloat(styles.paddingLeft) || 0;
    const paddingRight = parseFloat(styles.paddingRight) || 0;
    const paddingTop = parseFloat(styles.paddingTop) || 0;
    const paddingBottom = parseFloat(styles.paddingBottom) || 0;
    assetViewStageGeometry = {
      left: rect.left + paddingLeft,
      top: rect.top + paddingTop,
      width: Math.max(0, stage.clientWidth - paddingLeft - paddingRight),
      height: Math.max(0, stage.clientHeight - paddingTop - paddingBottom),
    };
    return assetViewStageGeometry;
  }

  function currentAssetViewStageGeometry() {
    return assetViewStageGeometry || refreshAssetViewStageGeometry();
  }

  function assetViewStageSize() {
    const geometry = currentAssetViewStageGeometry();
    return { width: geometry.width, height: geometry.height };
  }

  function assetViewNaturalSize() {
    const image = els.assetViewImage;
    if (!image || !(image.naturalWidth > 0) || !(image.naturalHeight > 0)) return { width: 0, height: 0 };
    const asset = selectedAsset();
    const width = Number(asset?.business_fields?.width);
    const height = Number(asset?.business_fields?.height);
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) return { width, height };
    return { width: image.naturalWidth, height: image.naturalHeight };
  }

  function cancelAssetViewOriginalPreload() {
    if (!assetViewOriginalPreload) return;
    assetViewOriginalPreload.src = "";
    assetViewOriginalPreload = null;
  }

  function scheduleAssetViewTransformApply() {
    if (assetViewTransformFrame !== null) return;
    assetViewTransformFrame = requestAnimationFrame(() => {
      assetViewTransformFrame = null;
      applyAssetViewTransform();
    });
  }

  function cancelAssetViewTransformApply() {
    if (assetViewTransformFrame !== null) cancelAnimationFrame(assetViewTransformFrame);
    assetViewTransformFrame = null;
  }

  async function maybeUpgradeAssetViewOriginal() {
    const image = els.assetViewImage;
    const asset = selectedAsset();
    if (!image || !asset || state.viewMode !== "asset" || !assetViewImageReady()) return false;
    const originalUrl = asset.image_url || "";
    if (!originalUrl || originalUrl === image.dataset.assetUrl || assetViewTransform.scale < 0.75) return false;
    if (assetViewOriginalPreload?.dataset.assetId === asset.id) return false;
    cancelAssetViewOriginalPreload();
    const loader = new Image();
    loader.decoding = "async";
    loader.dataset.assetId = asset.id;
    assetViewOriginalPreload = loader;
    loader.src = originalUrl;
    try {
      await loader.decode();
    } catch {
      if (!loader.complete || loader.naturalWidth <= 0) return false;
    }
    if (assetViewOriginalPreload !== loader) return false;
    assetViewOriginalPreload = null;
    if (state.viewMode !== "asset" || state.selectedId !== asset.id || image.dataset.assetId !== asset.id) return false;
    image.dataset.upgradingOriginal = "true";
    image.dataset.assetUrl = originalUrl;
    image.dataset.loadSettled = "";
    image.src = originalUrl;
    if (image.complete && image.naturalWidth > 0) handleAssetViewImageLoad();
    return true;
  }

  // Fit 几何：默认不将小图放大超过 100%；横/竖/方图完整显示、不裁切、不拉伸、图片居中。
  function computeAssetFitScale(stageWidth, stageHeight, naturalWidth, naturalHeight) {
    if (!(stageWidth > 0) || !(stageHeight > 0) || !(naturalWidth > 0) || !(naturalHeight > 0)) return 1;
    return Math.min(stageWidth / naturalWidth, stageHeight / naturalHeight, 1);
  }

  function currentAssetFitScale() {
    const stage = assetViewStageSize();
    const natural = assetViewNaturalSize();
    return computeAssetFitScale(stage.width, stage.height, natural.width, natural.height);
  }

  // 缩放范围 [min(fitScale, 0.1), 8]——超大图 fitScale 小于 10% 时仍可以 fitScale 完整显示。
  function assetViewMinScale() {
    return Math.min(currentAssetFitScale(), ASSET_VIEW_MIN_SCALE_FLOOR);
  }

  function clampAssetViewScale(value) {
    if (!Number.isFinite(value) || value <= 0) return assetViewMinScale();
    return Math.min(ASSET_VIEW_MAX_SCALE, Math.max(assetViewMinScale(), value));
  }

  // 平移边界（单轴）：渲染尺寸不超出舞台时该轴归零；超出时限制在 ±(rendered-stage)/2，
  // 图片不能被完全拖出舞台、不出现永久黑洞区域。
  function clampAssetViewAxisOffset(offset, renderedSize, stageSize) {
    if (!(renderedSize > stageSize)) return 0;
    const limit = (renderedSize - stageSize) / 2;
    return Math.min(limit, Math.max(-limit, offset));
  }

  function clampAssetViewOffsets(scale, offsetX, offsetY) {
    const stage = assetViewStageSize();
    const natural = assetViewNaturalSize();
    return {
      offsetX: clampAssetViewAxisOffset(offsetX, natural.width * scale, stage.width),
      offsetY: clampAssetViewAxisOffset(offsetY, natural.height * scale, stage.height),
    };
  }

  // 指针中心缩放：锚定指针下方的图片内容点，缩放前后保持其舞台坐标一致。
  // pointerX/pointerY 相对舞台 content box 中心；无指针坐标时传 (0,0)，即以舞台中心为锚点。
  function zoomAssetViewAtPoint(targetScale, pointerX, pointerY, currentScale, currentOffsetX, currentOffsetY) {
    const scale = currentScale > 0 ? currentScale : 1;
    const anchorX = (pointerX - currentOffsetX) / scale;
    const anchorY = (pointerY - currentOffsetY) / scale;
    return { offsetX: pointerX - anchorX * targetScale, offsetY: pointerY - anchorY * targetScale };
  }

  // 事件坐标 → 舞台 content box 中心坐标系（transform 锚点坐标系）。
  function assetViewStagePointer(clientX, clientY) {
    const geometry = currentAssetViewStageGeometry();
    return {
      x: clientX - geometry.left - geometry.width / 2,
      y: clientY - geometry.top - geometry.height / 2,
    };
  }

  // 图片就绪 = Asset mode + 主图可见 + 自然尺寸已知；视频与错误态自然排除。
  function assetViewImageReady() {
    const image = els.assetViewImage;
    return Boolean(state.viewMode === "asset" && image && !image.hidden && image.naturalWidth > 0 && image.naturalHeight > 0);
  }

  // translate 先于 scale：offset 以舞台 CSS 像素计，不被 scale 二次放大。
  function applyAssetViewTransform() {
    const image = els.assetViewImage;
    if (!image) return;
    image.style.transform = `translate(${assetViewTransform.offsetX}px, ${assetViewTransform.offsetY}px) scale(${assetViewTransform.scale})`;
    const stage = assetViewStageSize();
    const natural = assetViewNaturalSize();
    const pannable = natural.width * assetViewTransform.scale > stage.width
      || natural.height * assetViewTransform.scale > stage.height;
    image.classList.toggle("is-pannable", pannable);
    updateAssetViewControls();
  }

  function setAssetViewControlDisabled(button, disabled) {
    if (!button) return;
    button.disabled = disabled;
    button.setAttribute("aria-disabled", String(disabled));
  }

  // 控制条状态：百分比依据自然尺寸（scale=1 → 100%）；边界按钮原生 disabled 与
  // aria-disabled 保持一致；未就绪（加载中/错误/视频）时全部禁用且不显示 NaN。
  function updateAssetViewControls() {
    const ready = assetViewImageReady();
    if (els.assetZoomValue) els.assetZoomValue.textContent = ready ? `${Math.round(assetViewTransform.scale * 100)}%` : "—";
    const minScale = assetViewMinScale();
    setAssetViewControlDisabled(els.assetZoomOut, !ready || assetViewTransform.scale <= minScale + ASSET_VIEW_SCALE_EPSILON);
    setAssetViewControlDisabled(els.assetZoomIn, !ready || assetViewTransform.scale >= ASSET_VIEW_MAX_SCALE - ASSET_VIEW_SCALE_EPSILON);
    setAssetViewControlDisabled(els.assetZoomFit, !ready || assetViewTransform.mode === "fit");
  }

  function announceAssetViewZoom() {
    announceGalleryStatus(t("zoomAnnouncement", { percent: Math.round(assetViewTransform.scale * 100) }));
  }

  function setAssetViewScale(targetScale, pointerX = 0, pointerY = 0, { announce = false, defer = false } = {}) {
    if (!assetViewImageReady()) return false;
    const scale = clampAssetViewScale(targetScale);
    if (Math.abs(scale - assetViewTransform.scale) <= ASSET_VIEW_SCALE_EPSILON) {
      updateAssetViewControls();
      return false;
    }
    const zoomed = zoomAssetViewAtPoint(scale, pointerX, pointerY, assetViewTransform.scale, assetViewTransform.offsetX, assetViewTransform.offsetY);
    const offsets = clampAssetViewOffsets(scale, zoomed.offsetX, zoomed.offsetY);
    assetViewTransform.mode = "custom";
    assetViewTransform.scale = scale;
    assetViewTransform.offsetX = offsets.offsetX;
    assetViewTransform.offsetY = offsets.offsetY;
    if (defer) scheduleAssetViewTransformApply();
    else applyAssetViewTransform();
    void maybeUpgradeAssetViewOriginal();
    if (announce) announceAssetViewZoom();
    return true;
  }

  // 按钮/键盘/wheel 共用同一乘法步进（×1.2 / ÷1.2）；无指针坐标时锚点为舞台中心。
  function zoomAssetViewBy(factor, pointerX = 0, pointerY = 0, options = {}) {
    return setAssetViewScale(assetViewTransform.scale * factor, pointerX, pointerY, options);
  }

  function fitAssetView(announce = false) {
    if (!assetViewImageReady()) return false;
    const scale = currentAssetFitScale();
    const unchanged = assetViewTransform.mode === "fit"
      && Math.abs(assetViewTransform.scale - scale) <= ASSET_VIEW_SCALE_EPSILON
      && assetViewTransform.offsetX === 0 && assetViewTransform.offsetY === 0;
    if (unchanged) {
      updateAssetViewControls();
      return false;
    }
    assetViewTransform.mode = "fit";
    assetViewTransform.scale = scale;
    assetViewTransform.offsetX = 0;
    assetViewTransform.offsetY = 0;
    applyAssetViewTransform();
    if (announce) announceGalleryStatus(t("zoomFitDone"));
    return true;
  }

  // 100%：scale=1、mode=custom、以舞台中心为锚点、offsets clamp——图片小于舞台时
  // clamp 归零自然居中，大于舞台时允许平移。
  function resetAssetViewToHundred() {
    if (!assetViewImageReady()) return false;
    const zoomed = zoomAssetViewAtPoint(1, 0, 0, assetViewTransform.scale, assetViewTransform.offsetX, assetViewTransform.offsetY);
    const offsets = clampAssetViewOffsets(1, zoomed.offsetX, zoomed.offsetY);
    const unchanged = assetViewTransform.mode === "custom"
      && Math.abs(assetViewTransform.scale - 1) <= ASSET_VIEW_SCALE_EPSILON
      && Math.abs(offsets.offsetX) <= ASSET_VIEW_SCALE_EPSILON
      && Math.abs(offsets.offsetY) <= ASSET_VIEW_SCALE_EPSILON;
    if (unchanged) {
      updateAssetViewControls();
      return false;
    }
    assetViewTransform.mode = "custom";
    assetViewTransform.scale = 1;
    assetViewTransform.offsetX = offsets.offsetX;
    assetViewTransform.offsetY = offsets.offsetY;
    applyAssetViewTransform();
    void maybeUpgradeAssetViewOriginal();
    announceGalleryStatus(t("zoomResetDone"));
    return true;
  }

  // 切换素材/错误兜底：回到 fit 语义并清理内联几何与瞬时 pointer 状态（不持久化缩放记忆）。
  function resetAssetViewTransform() {
    cancelAssetViewPan();
    cancelAssetViewTransformApply();
    cancelAssetViewOriginalPreload();
    assetViewTransform.mode = "fit";
    assetViewTransform.scale = 1;
    assetViewTransform.offsetX = 0;
    assetViewTransform.offsetY = 0;
    const image = els.assetViewImage;
    if (image) {
      image.style.removeProperty("transform");
      image.style.removeProperty("width");
      image.style.removeProperty("height");
      image.classList.remove("is-pannable");
    }
    updateAssetViewControls();
  }

  function handleAssetViewImageLoad() {
    const image = els.assetViewImage;
    if (!image || !(image.naturalWidth > 0) || !(image.naturalHeight > 0)) return;
    // Phase 3C 竞态守卫：晚到的旧 load 不得覆盖新素材的 naturalWidth/naturalHeight 与 scale。
    if (image.dataset.assetId !== state.selectedId) return;
    if (image.dataset.loadSettled === "error") return;
    const upgradingOriginal = image.dataset.upgradingOriginal === "true";
    image.dataset.upgradingOriginal = "";
    image.dataset.loadSettled = "load";
    refreshAssetViewStageGeometry();
    // 元素几何=自然尺寸，transform scale 以此为唯一基准（rendered = natural × scale）。
    const natural = assetViewNaturalSize();
    image.style.width = `${natural.width}px`;
    image.style.height = `${natural.height}px`;
    if (upgradingOriginal) {
      applyAssetViewTransform();
      return;
    }
    fitAssetView();
  }

  function handleAssetViewWheel(event) {
    // 仅 Asset mode 且图片就绪时接管；Library mode、Modal/Lightbox/面板打开时一律放行
    // （不 preventDefault），不拦截应用其他区域滚动。
    if (state.viewMode !== "asset" || !assetViewImageReady()) return;
    if (!els.imagePreviewModal?.hidden || els.importModal?.classList.contains("open") || els.groupModal?.classList.contains("open")) return;
    if (!els.settingsMenu?.hidden) return;
    event.preventDefault();
    // 乘法步进与按钮一致（每 100 deltaY 一个 ×1.2 档）；普通滚轮与浏览器映射的 pinch
    // wheel（小 delta 连续事件）共用同一指针中心公式，滚轮方向沿用旧 Lightbox（上滚放大）。
    const factor = Math.pow(ASSET_VIEW_ZOOM_STEP, -event.deltaY / 100);
    const pointer = assetViewStagePointer(event.clientX, event.clientY);
    zoomAssetViewBy(factor, pointer.x, pointer.y, { defer: true });
  }

  function handleAssetViewPointerDown(event) {
    if (state.viewMode !== "asset" || !assetViewImageReady()) return;
    if (event.pointerType === "mouse" && (!event.isPrimary || event.button !== 0)) return;
    if (event.target.closest(".asset-view-controls")) return;
    if (assetViewActivePointers.has(event.pointerId)) return;
    // Cache the content-box geometry once per gesture. Pointer moves then stay
    // on the pure-math path instead of repeatedly forcing style/layout reads.
    refreshAssetViewStageGeometry();
    if (!assetViewActivePointers.size) cancelAssetViewPan();
    const pointer = { pointerId: event.pointerId, pointerType: event.pointerType, clientX: event.clientX, clientY: event.clientY };
    assetViewActivePointers.set(event.pointerId, pointer);
    try {
      els.assetViewStage.setPointerCapture(event.pointerId);
    } catch {
      // Native cancellation can race pointerdown during teardown.
    }
    if ([...assetViewActivePointers.values()].filter(({ pointerType }) => pointerType === "touch").length >= 2) {
      startAssetViewPinch();
      return;
    }
    startAssetViewPan(pointer);
  }

  function handleAssetViewPointerMove(event) {
    const pointer = assetViewActivePointers.get(event.pointerId);
    if (!pointer) return;
    pointer.clientX = event.clientX;
    pointer.clientY = event.clientY;
    if (!assetViewPinchSession && assetViewTouchPointers().length >= 2) startAssetViewPinch();
    if (assetViewPinchSession) {
      event.preventDefault();
      updateAssetViewPinch();
      return;
    }
    const session = assetViewPanSession;
    if (!session || event.pointerId !== session.pointerId) return;
    event.preventDefault();
    // 只有图片在某轴大于舞台时该轴才允许平移（clamp 内逐轴归零）。
    const offsets = clampAssetViewOffsets(
      assetViewTransform.scale,
      session.startOffsetX + (event.clientX - session.startClientX),
      session.startOffsetY + (event.clientY - session.startClientY),
    );
    assetViewTransform.offsetX = offsets.offsetX;
    assetViewTransform.offsetY = offsets.offsetY;
    scheduleAssetViewTransformApply();
  }

  function handleAssetViewPointerEnd(event) {
    const pointer = assetViewActivePointers.get(event.pointerId);
    if (!pointer) return;
    pointer.clientX = event.clientX;
    pointer.clientY = event.clientY;
    if (els.assetViewStage?.hasPointerCapture?.(event.pointerId)) els.assetViewStage.releasePointerCapture(event.pointerId);
    if (event.type === "pointercancel") {
      cancelAssetViewPan();
      return;
    }
    const endingPinch = assetViewPinchSession?.pointerIds.includes(event.pointerId);
    assetViewActivePointers.delete(event.pointerId);
    if (endingPinch) {
      finishAssetViewPinch({ announce: true });
      assetViewPanSession = null;
      assetViewTransform.isPanning = false;
      els.assetViewStage?.classList.remove("is-panning");
      startAssetViewPanFromRemainingPointer();
    } else if (assetViewPanSession?.pointerId === event.pointerId) {
      assetViewPanSession = null;
      assetViewTransform.isPanning = false;
      els.assetViewStage?.classList.remove("is-panning");
    }
    if (!assetViewActivePointers.size) cancelAssetViewPan();
  }

  function cancelAssetViewPan() {
    for (const pointerId of assetViewActivePointers.keys()) {
      if (els.assetViewStage?.hasPointerCapture?.(pointerId)) els.assetViewStage.releasePointerCapture(pointerId);
    }
    assetViewActivePointers.clear();
    assetViewPinchSession = null;
    assetViewPanSession = null;
    assetViewTransform.isPanning = false;
    els.assetViewStage?.classList.remove("is-panning");
  }

  function assetViewTouchPointers() {
    return [...assetViewActivePointers.entries()].filter(([, pointer]) => pointer.pointerType === "touch");
  }

  function assetViewPointerEntries(ids = null) {
    const entries = [...assetViewActivePointers.entries()];
    return ids ? entries.filter(([pointerId]) => ids.includes(pointerId)) : entries;
  }

  function assetViewPointerDistance(entries) {
    const first = entries[0][1];
    const second = entries[1][1];
    return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
  }

  function assetViewPointerMidpoint(entries) {
    const first = assetViewStagePointer(entries[0][1].clientX, entries[0][1].clientY);
    const second = assetViewStagePointer(entries[1][1].clientX, entries[1][1].clientY);
    return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  }

  function assetViewCanPan() {
    const stage = assetViewStageSize();
    const natural = assetViewNaturalSize();
    return natural.width * assetViewTransform.scale > stage.width + ASSET_VIEW_SCALE_EPSILON
      || natural.height * assetViewTransform.scale > stage.height + ASSET_VIEW_SCALE_EPSILON;
  }

  function startAssetViewPan(pointer) {
    if (!assetViewCanPan()) return;
    assetViewPanSession = {
      pointerId: pointer.pointerId,
      startClientX: pointer.clientX,
      startClientY: pointer.clientY,
      startOffsetX: assetViewTransform.offsetX,
      startOffsetY: assetViewTransform.offsetY,
    };
    assetViewTransform.isPanning = true;
    els.assetViewStage?.classList.add("is-panning");
  }

  function startAssetViewPanFromRemainingPointer() {
    const [entry] = assetViewPointerEntries();
    if (entry) startAssetViewPan(entry[1]);
  }

  function startAssetViewPinch() {
    const entries = assetViewTouchPointers();
    if (entries.length < 2) return false;
    const startDistance = assetViewPointerDistance(entries);
    if (!(startDistance > ASSET_VIEW_SCALE_EPSILON)) return false;
    assetViewPanSession = null;
    assetViewTransform.isPanning = false;
    els.assetViewStage?.classList.remove("is-panning");
    assetViewPinchSession = {
      pointerIds: entries.slice(0, 2).map(([pointerId]) => pointerId),
      startDistance,
      startScale: assetViewTransform.scale,
      startOffsetX: assetViewTransform.offsetX,
      startOffsetY: assetViewTransform.offsetY,
      startMidpoint: assetViewPointerMidpoint(entries),
      changed: false,
    };
    return true;
  }

  function updateAssetViewPinch() {
    const session = assetViewPinchSession;
    if (!session) return false;
    const entries = assetViewPointerEntries(session.pointerIds);
    if (entries.length !== 2) return false;
    const currentDistance = assetViewPointerDistance(entries);
    if (!(currentDistance > ASSET_VIEW_SCALE_EPSILON) || !(session.startDistance > ASSET_VIEW_SCALE_EPSILON)) return false;
    const targetScale = clampAssetViewScale(session.startScale * (currentDistance / session.startDistance));
    const midpoint = assetViewPointerMidpoint(entries);
    const zoomed = zoomAssetViewAtPoint(targetScale, session.startMidpoint.x, session.startMidpoint.y, session.startScale, session.startOffsetX, session.startOffsetY);
    const midpointDelta = { x: midpoint.x - session.startMidpoint.x, y: midpoint.y - session.startMidpoint.y };
    const offsets = clampAssetViewOffsets(targetScale, zoomed.offsetX + midpointDelta.x, zoomed.offsetY + midpointDelta.y);
    const changed = Math.abs(targetScale - assetViewTransform.scale) > ASSET_VIEW_SCALE_EPSILON
      || Math.abs(offsets.offsetX - assetViewTransform.offsetX) > ASSET_VIEW_SCALE_EPSILON
      || Math.abs(offsets.offsetY - assetViewTransform.offsetY) > ASSET_VIEW_SCALE_EPSILON;
    assetViewTransform.mode = "custom";
    assetViewTransform.scale = targetScale;
    assetViewTransform.offsetX = offsets.offsetX;
    assetViewTransform.offsetY = offsets.offsetY;
    scheduleAssetViewTransformApply();
    session.changed ||= changed;
    return changed;
  }

  function finishAssetViewPinch({ announce = false } = {}) {
    const session = assetViewPinchSession;
    assetViewPinchSession = null;
    if (announce && session?.changed) announceAssetViewZoom();
    return Boolean(session?.changed);
  }

  // 舞台尺寸变化：fit 模式重算 fitScale 并保持 offsets=0；custom 模式保持 scale、
  // 仅重新 clamp，不自动跳回 fit。回调只写 transform，不改变舞台尺寸，不自触发循环。
  function handleAssetViewStageResize() {
    if (state.viewMode !== "asset" || !assetViewImageReady()) return;
    refreshAssetViewStageGeometry();
    if (assetViewTransform.mode === "fit") {
      assetViewTransform.scale = currentAssetFitScale();
      assetViewTransform.offsetX = 0;
      assetViewTransform.offsetY = 0;
    } else {
      const offsets = clampAssetViewOffsets(assetViewTransform.scale, assetViewTransform.offsetX, assetViewTransform.offsetY);
      assetViewTransform.offsetX = offsets.offsetX;
      assetViewTransform.offsetY = offsets.offsetY;
    }
    applyAssetViewTransform();
  }

  // 监听器生命周期 = Asset mode：打开时绑定一次（幂等），返回 Library 时全部移除——
  // 不重复注册、不产生泄漏；ResizeObserver 仅观察 asset-view-stage，不观察 document。
  function setupAssetViewInteraction() {
    const stage = els.assetViewStage;
    if (assetViewInteractionActive || !stage) return;
    assetViewInteractionActive = true;
    refreshAssetViewStageGeometry();
    stage.addEventListener("wheel", handleAssetViewWheel, { passive: false });
    stage.addEventListener("pointerdown", handleAssetViewPointerDown);
    stage.addEventListener("pointermove", handleAssetViewPointerMove);
    stage.addEventListener("pointerup", handleAssetViewPointerEnd);
    stage.addEventListener("pointercancel", handleAssetViewPointerEnd);
    assetViewStageObserver = new ResizeObserver(handleAssetViewStageResize);
    assetViewStageObserver.observe(stage);
  }

  function teardownAssetViewInteraction() {
    const stage = els.assetViewStage;
    if (!assetViewInteractionActive || !stage) return;
    assetViewInteractionActive = false;
    cancelAssetViewPan();
    cancelAssetViewTransformApply();
    stage.removeEventListener("wheel", handleAssetViewWheel);
    stage.removeEventListener("pointerdown", handleAssetViewPointerDown);
    stage.removeEventListener("pointermove", handleAssetViewPointerMove);
    stage.removeEventListener("pointerup", handleAssetViewPointerEnd);
    stage.removeEventListener("pointercancel", handleAssetViewPointerEnd);
    assetViewStageObserver?.disconnect();
    assetViewStageObserver = null;
    assetViewStageGeometry = null;
  }

  // ===== 专用大图素材导航（Phase 3C / F-04） =====
  // assetViewSequence 是本次 Viewer session 的稳定导航序列：只保存素材 ID（不复制素材
  // 对象/数组、不深拷贝 state、无第二套 selectedAsset、无 Router、无状态库、不落盘）。
  // 打开 Asset mode 时从 renderGrid 使用的最终有序结果 state.assets 捕获 ID 顺序——
  // 搜索/筛选/排序/分组/收藏/最近范围的全部组合都由服务端排序后收敛到这一个数组，因此
  // 序列天然与画廊卡片顺序一致；requestKey 记录捕获时的结果集语义（仅作会话标识）。
  // session 期间不随后台刷新重排序、不插入新导入素材；返回 Library 时清空。
  // BUG-10（Batch 2A）：total/nextCursor 是进入时捕获的查询集总数与游标（按需加载后
  // 同步更新），snapshot 是只读查询快照（project/query/scope/facets/sort，不复制素材），
  // loading 防同一游标重复请求，generation 使返回/新会话后的晚到响应失效。
  const assetViewSequence = {
    ids: [], index: -1, requestKey: "",
    total: 0, nextCursor: null, loading: false, generation: 0,
    snapshot: null,
  };
  let assetViewGalleryDirty = false;
  let assetViewReturnGridWidth = 0;

  let assetViewAssetSetSource = null;
  let assetViewAssetIds = new Set();

  function currentAssetViewAssetIds() {
    if (assetViewAssetSetSource !== state.assets) {
      assetViewAssetSetSource = state.assets;
      assetViewAssetIds = new Set(state.assets.map((asset) => asset.id));
    }
    return assetViewAssetIds;
  }

  // 缺失或失效 ID（后台刷新后不再存在于当前结果集）在导航时跳过；绝不回退到全素材，
  // 也不重新运行用户的搜索/筛选/排序条件。
  function assetViewSequenceHasAsset(id) {
    return currentAssetViewAssetIds().has(id);
  }

  // 从 fromIndex 沿 direction（仅 -1/+1）寻找下一个仍有效的序号；找不到返回 -1（不循环首尾）。
  function nextValidAssetViewIndex(fromIndex, direction) {
    const ids = assetViewSequence.ids;
    for (let i = fromIndex + direction; i >= 0 && i < ids.length; i += direction) {
      if (assetViewSequenceHasAsset(ids[i])) return i;
    }
    return -1;
  }

  function canNavigateAssetView(direction) {
    return state.viewMode === "asset" && assetViewSequence.index >= 0
      && (nextValidAssetViewIndex(assetViewSequence.index, direction) !== -1
        // BUG-10：已加载序列末端 + 下游还有分页可取 → Next 可用（点击触发按需加载）。
        || (direction === 1 && assetViewCanLoadNext()));
  }

  // 边界按需加载可用性：Viewer 内、处于已加载序列末端、有游标、未到查询集总数、
  // 且没有在途分页请求（loading guard 保证同一游标最多发一次请求）。
  function assetViewCanLoadNext() {
    return state.viewMode === "asset"
      && assetViewSequence.requestKey !== ""
      && Boolean(assetViewSequence.snapshot)
      && Boolean(assetViewSequence.nextCursor)
      && assetViewSequence.ids.length < assetViewSequence.total
      && !assetViewSequence.loading;
  }

  // BUG-10：Viewer 边界按需加载下一页——与 Gallery 共用 buildAssetPageParams/requestAssetPage
  // 分页语义，但参数来自进入 Viewer 时捕获的只读查询快照（不读取已变化的筛选状态）。
  // 成功：按服务端顺序去重追加到 state.assets、仅把新增 ID 追加进 session、同步 Gallery
  // 总数/游标/已加载页数并增量渲染（新卡片入场动画，旧卡片不重播）。
  // 失败：当前素材/Inspector/Return Snapshot 不变，仅释放 loading 并显示现有 Error Toast，
  // 不进入 Gallery error screen、不清空已加载素材；游标未推进时可重试。
  async function loadNextAssetViewPage() {
    const session = assetViewSequence;
    if (!assetViewCanLoadNext()) return false;
    const generation = session.generation;
    const requestKey = session.requestKey;
    const cursor = session.nextCursor;
    session.loading = true;
    try {
      const result = await requestAssetPage(session.snapshot, { cursor });
      // 晚到响应丢弃：用户已 Return、新 Viewer session 已开始或 requestKey 已变化。
      if (state.viewMode !== "asset" || session.generation !== generation || session.requestKey !== requestKey) return false;
      const knownAssetIds = currentAssetViewAssetIds();
      const incoming = (result.assets || []).filter((asset) => {
        if (knownAssetIds.has(asset.id)) return false;
        knownAssetIds.add(asset.id);
        return true;
      });
      const nextCursor = result.page?.nextCursor || null;
      const total = Number(result.page?.total || session.total);
      // 服务端没有新数据且游标未推进：终止游标，避免同一 cursor 反复请求。
      if (incoming.length === 0) {
        session.nextCursor = nextCursor === cursor ? null : nextCursor;
        session.total = total;
        state.nextCursor = session.nextCursor;
        state.pageTotal = total;
        return false;
      }
      state.assets = state.assets.concat(incoming);
      session.ids = session.ids.concat(incoming.map((asset) => asset.id));
      session.nextCursor = nextCursor;
      session.total = total;
      // Gallery 状态与 Viewer cursor 同步；追加页计入已加载页数，防止后台刷新把新页
      // 打回首屏（loadedPageCount > 1 时刷新路径跳过 loadAssets）。
      state.nextCursor = nextCursor;
      state.pageTotal = total;
      state.loadedPageCount += 1;
      assetViewGalleryDirty = true;
      return true;
    } catch (error) {
      showToast(error.message, "error");
      return false;
    } finally {
      if (session.generation === generation) session.loading = false;
    }
  }

  // 导航边界与位置输出：第一项 Previous disabled、最后一项 Next disabled、单项两端 disabled；
  // 位置基于当前有效 ID 重新计算（缺失 ID 不计入位置）。BUG-10：总数来自稳定 Viewer session
  // total（打开时捕获、按需加载后更新），不再使用当前已加载 ID 数——第 100 项显示 100 / 106。
  function updateAssetViewNav() {
    const ids = assetViewSequence.ids;
    const availableIds = currentAssetViewAssetIds();
    const currentId = ids[assetViewSequence.index];
    let validCount = 0;
    let position = 0;
    for (let index = 0; index < ids.length; index += 1) {
      if (!availableIds.has(ids[index])) continue;
      validCount += 1;
      if (index <= assetViewSequence.index) position += 1;
    }
    const total = Math.max(assetViewSequence.total, validCount);
    const visiblePosition = state.viewMode === "asset" && availableIds.has(currentId) ? position : 0;
    if (els.assetViewPosition) els.assetViewPosition.textContent = visiblePosition > 0 ? `${visiblePosition} / ${total}` : "—";
    setAssetViewControlDisabled(els.assetViewPrev, !canNavigateAssetView(-1));
    setAssetViewControlDisabled(els.assetViewNext, !canNavigateAssetView(1));
  }

  // 集中式导航入口：direction 只接受 -1/+1。不返回 Library 再打开、不重建/覆盖
  // libraryReturnSnapshot、不修改搜索/筛选/排序/分组、不重新请求素材库、不打开旧
  // Lightbox；切换素材经 renderAssetView 重置 transform 为 fit（assetViewStageAssetId 跟踪）。
  // BUG-10（Batch 2A）：已加载序列内的导航保持完全同步；仅在 direction=1 且已加载序列到达
  // 末端时按需取下一页，取到后前进到原边界后的第一项，取不到保持原样可重试。
  async function navigateAssetView(direction) {
    if (direction !== -1 && direction !== 1) return;
    if (state.viewMode !== "asset") return;
    let nextIndex = nextValidAssetViewIndex(assetViewSequence.index, direction);
    if (nextIndex === -1 && direction === 1 && assetViewCanLoadNext()) {
      await loadNextAssetViewPage();
      nextIndex = nextValidAssetViewIndex(assetViewSequence.index, 1);
      if (nextIndex === -1) { updateAssetViewNav(); return; }
    }
    if (nextIndex === -1) return;
    cancelAssetViewPan();
    const id = assetViewSequence.ids[nextIndex];
    const originProjectId = state.project;
    const originAssetId = state.selectedId;
    if (!await confirmDetailNavigation(id)) return;
    if (originAssetId !== null && !isCurrentDetailSelection(originProjectId, originAssetId)) return;
    discardDetailDraft();
    assetViewSequence.index = nextIndex;
    state.selectedId = id;
    state.detailAsset = null;
    state.versionHistory = null;
    state.recipeHistory = null;
    state.generationHistory = null;
    renderAssetView();
    updateSelectedCard();
    updateAssetViewNav();
    preloadAssetViewNeighbors();
    scheduleAssetViewDetailRender(id);
    // 焦点策略：若本次导航使持焦按钮自身到达边界变为 disabled，焦点不得掉到 <body>——
    // 移到另一侧仍可用的导航按钮；两侧皆不可用（单项序列）时回到 Viewer Header 的返回按钮。
    const active = document.activeElement;
    if ((active === els.assetViewPrev || active === els.assetViewNext) && active.disabled) {
      const fallback = active === els.assetViewPrev ? els.assetViewNext : els.assetViewPrev;
      (fallback && !fallback.disabled ? fallback : els.assetViewBack)?.focus();
    }
  }

  // 主图异步竞态防护（Phase 3C）：快速连续导航时旧图片 load/error 可能晚到。dataset.assetId
  // 与 dataset.loadSettled 在 renderAssetView 设置 src 时同步更新——load/error 处理器先核对
  // 事件仍属当前素材：旧 load 不得覆盖新素材尺寸/scale，旧 error 不得把新素材标为错误。
  function handleAssetViewImageError() {
    const image = els.assetViewImage;
    if (!image || !els.assetViewError) return;
    if (image.dataset.assetId !== state.selectedId) return;
    if (!image.getAttribute("src")) return;
    if (image.dataset.loadSettled === "load") return;
    if (!image.complete) return;
    image.dataset.loadSettled = "error";
    image.hidden = true;
    els.assetViewError.textContent = t("imageLoadFailed");
    els.assetViewError.hidden = false;
    // Phase 3B：错误态缩放控制全部禁用、比例不显示 NaN、瞬时拖拽清理，不允许平移。
    cancelAssetViewPan();
    updateAssetViewControls();
  }

  return {
    setViewMode, renderAssetView, openAssetView, returnToLibrary, resetAssetViewTransform,
    handleAssetViewImageLoad, handleAssetViewImageError, canNavigateAssetView, navigateAssetView,
    zoomAssetViewBy, fitAssetView, resetAssetViewToHundred, updateAssetViewNav, ASSET_VIEW_ZOOM_STEP,
  };
}
