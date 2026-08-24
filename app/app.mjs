import { createLanguageApplier, createT, resolveLocale } from "./i18n-runtime.mjs";
import { createBridgeStatusPoller } from "./bridge-status-poller.mjs";
import {
  FACET_KEYS, LIVE_REGION_WRITE_DELAY, SCOPES, SKELETON_TILE_COUNT, SOURCE_FACETS, SOURCE_LABEL_KEYS, STATUS_ANNOUNCEMENT_DURATION,
} from "./config.mjs";
import {
  cardShortTitle, debounce, escapeHtml, formatDate, humanizeFacetValue, normalizeDensity, normalizeSort, safeStorageGet, safeStorageSet,
} from "./utils.mjs";
import { createAnchoredOverlayManager } from "./overlay-manager.mjs";
import { createToastManager } from "./toast-manager.mjs";
import { createApiClient } from "./api-client.mjs";
import { createConfirmDialog } from "./confirm-dialog.mjs";
import { createImagePreviewViewer } from "./image-preview.mjs";
import { createAssetViewer } from "./asset-view.mjs";
import { createInspectorMarkup } from "./inspector-markup.mjs";
import { assetTags, derivePromptTags, uniqueTags } from "./tag-utils.mjs";
import { createContextMenu } from "./context-menu.mjs";
import { createContextMenuActions } from "./context-menu-actions.mjs";
import { bindContextMenuEvents } from "./context-menu-bindings.mjs";
let statusAnnouncementTimer = null;
let statusTextWriteTimer = null;
let statusAnnouncementSequence = 0;
let statusAnnouncementActive = false;
let libraryRefreshTimer = null;
let persistentStatus = { value: "", stateName: "neutral" };

// Clear and repopulate the shared status node in separate DOM mutations. This
// gives VoiceOver a reliable text mutation to announce when the same status is
// emitted twice in a row.
function writeStatusText(value) {
  if (!els.statusText) return;
  window.clearTimeout(statusTextWriteTimer);
  statusTextWriteTimer = null;
  els.statusText.textContent = "";
  value = String(value ?? "");
  if (!value) return;
  statusTextWriteTimer = window.setTimeout(() => {
    statusTextWriteTimer = null;
    if (els.statusText) els.statusText.textContent = value;
  }, LIVE_REGION_WRITE_DELAY);
}

const anchoredOverlayManager = createAnchoredOverlayManager();

function assetSourceLabel(asset = {}) {
  const type = String(asset.source?.type || asset.sourceType || "");
  return SOURCE_LABEL_KEYS[type] ? t(SOURCE_LABEL_KEYS[type]) : (type || t("sourceUnknown"));
}

const preference = safeStorageGet("mosa.ui-language") || "system";
const state = {
  project: "default", projects: [], cowartCanvases: [], assets: [], pageTotal: 0, nextCursor: null, loadedPageCount: 0, selectedId: null, detailAsset: null, versionHistory: null, recipeHistory: null, detailOpen: false, detailDirty: false, detailReturnFocus: null, imagePreviewId: null, previewReturnFocus: null, query: "",
  scope: "all", facets: { source: "", group: "", category: "", style: "", conversation: "", generationBatch: "" }, sort: normalizeSort(safeStorageGet("mosa.asset-sort")),
  mediaKind: "all",
  groups: { total: 0, favorites: 0, recent: 0, codex: 0, cowart: 0, groups: [], categories: [], styles: [], styleTotal: 0 }, cowartInsertAvailable: false, cowartInsertTargetId: safeStorageGet("mosa.cowart-insert-target") || "mosa", cowartInsertFeedback: null,
  galleryStatus: "loading", galleryError: null, galleryDensity: normalizeDensity(safeStorageGet("mosa.gallery-density")),
  libraryPath: "", codexImagesDir: "", supportedMediaExtensions: [], importSaving: false, modalReturnFocus: null, languagePreference: preference, locale: resolveLocale(preference),
  dragCounter: 0,
  darkMode: safeStorageGet("mosa-dark-mode") === "true", diagnosticsExpanded: false, settingsReturnFocus: null, accountReturnFocus: null,
  imageZoom: 1, imagePanX: 0, imagePanY: 0, imageDragging: false,
  // Bulk-selection gate. The viewer short-circuits while batch mode is active so
  // selected cards never auto-open the asset view mid-selection; this defaults to
  // false because batch UI isn't yet wired up (see Bug D in the audit report).
  batchMode: false,
  // Phase 3A / D4：专用大图查看模式最小状态——viewMode 二值（library/asset）+ 进入时的
  // 画廊返回快照。不复刻搜索/筛选/排序状态、不深拷贝 state、无第二套 selectedAsset、无平行 Router。
  viewMode: "library", libraryReturnSnapshot: null,
};

// ===== i18n 运行时（resolveLocale/t/applyLanguage 已提取至 i18n-runtime.mjs）=====
const t = createT({ getLocale: () => state.locale });
const applyLanguage = createLanguageApplier({
  state,
  t,
  refreshUI: () => {
    updateCodexHint();
    window.electronAPI?.setLocale?.(state.locale);
    renderSettingsMenu();
    if (els.sortSelect) els.sortSelect.value = state.sort;
    renderQuickFilters();
    updateViewTitle();
    renderGrid();
    if (state.detailOpen) renderDetail();
  },
});

const els = {
  searchInput: document.querySelector("#searchInput"), quickFilters: document.querySelector("#quickFilters"),
  typeFilters: document.querySelector(".topbar-type-filters"),
  sidebar: document.querySelector("#appSidebar"), mobileNavToggle: document.querySelector("#mobileNavToggle"), mobileNavClose: document.querySelector("#mobileNavClose"), mobileNavScrim: document.querySelector("#mobileNavScrim"),
  activeFilters: document.querySelector("#activeFilters"), filterPanel: document.querySelector("#filterPanel"), filterToggle: document.querySelector("#filterToggle"), sortSelect: document.querySelector("#sortSelect"), themeToggle: document.querySelector("#themeToggle"),
  accountToggle: document.querySelector("#accountToggle"), accountModal: document.querySelector("#accountModal"), closeAccountModal: document.querySelector("#closeAccountModal"), accountAssetCount: document.querySelector("#accountAssetCount"), accountCollectionCount: document.querySelector("#accountCollectionCount"), settingsToggle: document.querySelector("#settingsToggle"), settingsMenu: document.querySelector("#settingsMenu"), addGroupBtn: document.querySelector("#addGroupBtn"), sidebarGroupList: document.querySelector("#sidebarGroupList"), newAssetTopBtn: document.querySelector("#newAssetTopBtn"), importModal: document.querySelector("#importModal"), closeImportModal: document.querySelector("#closeImportModal"), cancelImportBtn: document.querySelector("#cancelImportBtn"), groupModal: document.querySelector("#groupModal"), closeGroupModal: document.querySelector("#closeGroupModal"), cancelGroupBtn: document.querySelector("#cancelGroupBtn"), saveGroupBtn: document.querySelector("#saveGroupBtn"), groupNameInput: document.querySelector("#groupNameInput"), imagePreviewModal: document.querySelector("#imagePreviewModal"), imagePreviewStage: document.querySelector("#imagePreviewStage"), imagePreviewImage: document.querySelector("#imagePreviewImage"), imagePreviewVideo: document.querySelector("#imagePreviewVideo"), imagePreviewTitle: document.querySelector("#imagePreviewTitle"), closeImagePreview: document.querySelector("#closeImagePreview"), imagePathInput: document.querySelector("#imagePathInput"), codexSourceHint: document.querySelector("#codexSourceHint"), importFormatList: document.querySelector("#importFormatList"), importPathExample: document.querySelector("#importPathExample"), imagePathError: document.querySelector("#imagePathError"), businessFieldsError: document.querySelector("#businessFieldsError"), importAdvanced: document.querySelector("#importAdvanced"), promptInput: document.querySelector("#promptInput"), skillInput: document.querySelector("#skillInput"), styleInput: document.querySelector("#styleInput"), ratioInput: document.querySelector("#ratioInput"), themeInput: document.querySelector("#themeInput"), groupInput: document.querySelector("#groupInput"), categoryInput: document.querySelector("#categoryInput"), businessInput: document.querySelector("#businessInput"), saveAssetBtn: document.querySelector("#saveAssetBtn"),
  viewTitle: document.querySelector("#viewTitle"), assetCount: document.querySelector("#assetCount"), statusText: document.querySelector("#statusText"), bridgeStatus: document.querySelector("#bridgeStatus"), bridgeStatusLabel: document.querySelector("#bridgeStatusLabel"), bridgeStatusMeta: document.querySelector("#bridgeStatusMeta"), appShell: document.querySelector("#appShell"), assetGrid: document.querySelector("#assetGrid"), detailPanel: document.querySelector("#detailPanel"), toastContainer: document.querySelector("#toastContainer"), toastErrorContainer: document.querySelector("#toastErrorContainer")
};

// asset-view 的导航状态更新由 asset-view.mjs 工厂闭包持有。保持顶层函数声明
// （提升使其在下方 createApiClient 参数求值时可引用），运行时再委托给已初始化的 viewer。
function updateAssetViewNav() {
  assetViewer.updateAssetViewNav();
}

// ===== API client + data loading（apiFetch 与数据加载已提取至 api-client.mjs，R1 批次 3）=====
const apiClient = createApiClient({
  state,
  els,
  renderSettingsMenu,
  renderDetail,
  updateCodexHint,
  renderQuickFilters,
  renderGrid,
  updateViewTitle,
  renderErrorState,
  updateAssetViewNav,
  selectedAsset,
  isDetailEditorActive,
});
const { apiFetch, loadProjects, loadCowartCanvases, loadStats, loadAssets, refreshLibraryInBackground, buildAssetPageParams, requestAssetPage, currentAssetRequest, assetRequestKey, assetListVersion, assetVersion } = apiClient;

// ===== New element references =====
Object.assign(els, {
  dragOverlay: document.querySelector("#dragOverlay"),
  libraryView: document.querySelector("#libraryView"),
  assetView: document.querySelector("#assetView"),
  assetViewBack: document.querySelector("#assetViewBack"),
  assetViewScope: document.querySelector("#assetViewScope"),
  assetViewTitle: document.querySelector("#assetViewTitle"),
  assetViewStage: document.querySelector("#assetViewStage"),
  assetViewImage: document.querySelector("#assetViewImage"),
  assetViewVideo: document.querySelector("#assetViewVideo"),
  assetViewError: document.querySelector("#assetViewError"),
  assetViewControls: document.querySelector("#assetViewControls"),
  assetZoomOut: document.querySelector("#assetZoomOut"),
  assetZoomIn: document.querySelector("#assetZoomIn"),
  assetZoomFit: document.querySelector("#assetZoomFit"),
  assetZoomValue: document.querySelector("#assetZoomValue"),
  assetViewNav: document.querySelector("#assetViewNav"),
  assetViewPrev: document.querySelector("#assetViewPrev"),
  assetViewNext: document.querySelector("#assetViewNext"),
  assetViewPosition: document.querySelector("#assetViewPosition"),
  // Phase 5B / F-15：全应用唯一 ConfirmDialog（替换 window.confirm 的四条确认路径）。
  confirmDialog: document.querySelector("#confirmDialog"),
  confirmDialogCard: document.querySelector("#confirmDialogCard"),
  confirmDialogTitle: document.querySelector("#confirmDialogTitle"),
  confirmDialogDescription: document.querySelector("#confirmDialogDescription"),
  confirmDialogCancel: document.querySelector("#confirmDialogCancel"),
  confirmDialogConfirm: document.querySelector("#confirmDialogConfirm"),
});

// ===== Dark mode =====
function applyDarkMode() {
  const appearance = state.darkMode ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", appearance);
  els.themeToggle?.setAttribute("aria-pressed", String(state.darkMode));
  els.settingsMenu?.querySelectorAll("[data-appearance-opt]").forEach((button) => {
    button.classList.toggle("active", button.dataset.appearanceOpt === appearance);
  });
  // Phase 5A / F-12：aria-checked 与 roving tabindex 必须跟随 .active 视觉态同步。
  syncSegmentedRadios(els.settingsMenu);
}

// Phase 5A / F-12：segmented radiogroup 状态同步——aria-checked/tabindex 跟随 .active class，
// 颜色不是唯一选中表达；组内永远保留恰好一个 Tab 停靠点。
function syncSegmentedRadios(container) {
  container?.querySelectorAll(".segmented").forEach((group) => {
    const buttons = [...group.querySelectorAll(".segmented-btn")];
    let anyChecked = false;
    for (const button of buttons) {
      const checked = button.classList.contains("active");
      if (checked) anyChecked = true;
      button.setAttribute("aria-checked", String(checked));
      button.tabIndex = checked ? 0 : -1;
    }
    if (!anyChecked && buttons[0]) buttons[0].tabIndex = 0;
  });
}

// ===== Phase 5A：三套浮层注册（root 互斥 + parent/child 层级）=====
function registerAnchoredOverlays() {
  // Settings Menu：与 Filter 互斥的 root 浮层；bottom-start 定位由碰撞公式翻转为向上展开。
  anchoredOverlayManager.register({
    id: "settings", kind: "root", placement: "bottom-start",
    getPanel: () => els.settingsMenu,
    getTrigger: () => els.settingsToggle,
    // 混合控件策略：首个可操作元素是原生项目 select 时聚焦该 select（保留原生键盘语义），
    // 否则进入 menu roving 第一项。
    focusOnOpen: () => {
      const first = els.settingsMenu?.querySelector("[data-project-select]");
      if (first) return first;
      const item = settingsMenuItems()[0];
      if (item) focusSettingsMenuItem(item);
      return null;
    },
    returnFocus: () => els.settingsToggle,
  });
  // Language Menu：Settings 的 child 浮层；向右优先、空间不足向左翻转；打开时当前选中项优先获焦。
  anchoredOverlayManager.register({
    id: "language", kind: "child", parentId: "settings", placement: "right-start",
    getPanel: () => els.settingsMenu?.querySelector("#languageMenu") || null,
    getTrigger: () => els.settingsMenu?.querySelector("[data-language-menu]") || null,
    focusOnOpen: () => {
      const menu = els.settingsMenu?.querySelector("#languageMenu");
      const item = menu?.querySelector('[role="menuitemradio"][aria-checked="true"]') || menu?.querySelector('[role="menuitemradio"]');
      if (item) focusLanguageMenuItem(item);
      return null;
    },
    returnFocus: () => els.settingsMenu?.querySelector("[data-language-menu]") || null,
  });
}
registerAnchoredOverlays();

// ===== Phase 5A / F-12：菜单 roving tabindex（仅作用于本层合法 menu items）=====
function settingsMenuItems() {
  if (!els.settingsMenu) return [];
  return [...els.settingsMenu.querySelectorAll('[role="menuitem"]')].filter((item) => !item.disabled && !item.closest("[hidden]"));
}

function focusSettingsMenuItem(item) {
  for (const candidate of settingsMenuItems()) candidate.tabIndex = -1;
  if (!item) return;
  item.tabIndex = 0;
  item.focus();
}

// 静态 markup 一律 tabindex=-1（hidden 浮层不进 Tab 顺序）；重建后动态把首个
// menuitem 设为 roving 锚点，保证键盘用户从项目下拉框 Tab 一次即可进入菜单层。
// 重建多发生在面板隐藏时，故这里不走可见性过滤的 settingsMenuItems()。
function primeSettingsRoving() {
  if (!els.settingsMenu) return;
  const items = [...els.settingsMenu.querySelectorAll('[role="menuitem"]')].filter((item) => !item.disabled);
  items.forEach((item, index) => { item.tabIndex = index === 0 ? 0 : -1; });
}

function languageMenuItems(menu) {
  const scope = menu || els.settingsMenu?.querySelector("#languageMenu");
  if (!scope) return [];
  return [...scope.querySelectorAll('[role="menuitemradio"]')].filter((item) => !item.disabled);
}

function focusLanguageMenuItem(item) {
  for (const candidate of languageMenuItems(item?.closest(".language-menu"))) candidate.tabIndex = -1;
  if (!item) return;
  item.tabIndex = 0;
  item.focus();
}
function toggleDarkMode() { state.darkMode = !state.darkMode; safeStorageSet("mosa-dark-mode", String(state.darkMode)); applyDarkMode(); showToast(t("darkModeChanged"), "success"); }

async function droppedFilePath(file) {
  // Electron：preload 把拖放文件在主进程 staging 后返回受信任的 staging 路径，
  // 用户外部原始路径永不进入本 renderer；staging 失败在此 reject（不回退到
  // File.path——Electron 下那正是我们要消除的原始路径）。
  if (window.electronAPI?.getPathForFile) {
    return (await window.electronAPI.getPathForFile(file)) || "";
  }
  // 纯浏览器回退：标准 File 对象没有本地路径，这里恒为 ""。
  return typeof file.path === "string" ? file.path : "";
}

// ===== Drag & Drop =====
function setupDragDrop() {
  const library = els.assetGrid?.closest(".library");
  if (!library) return;
  const clearDragAnnouncement = () => announceGalleryStatus(t("dropImportCanceled"));
  const hideDragOverlay = ({ announce = true } = {}) => {
    state.dragCounter = 0;
    if (els.dragOverlay) els.dragOverlay.hidden = true;
    if (announce) clearDragAnnouncement();
  };
  library.addEventListener("dragenter", (e) => {
    if (state.viewMode !== "library") return;
    e.preventDefault();
    if (state.dragCounter === 0) {
      state.dragCounter = 1;
      if (els.dragOverlay) els.dragOverlay.hidden = false;
      announceGalleryStatus(t("dropImportReady"), { persist: true });
      return;
    }
    state.dragCounter++;
  });
  library.addEventListener("dragover", (e) => {
    if (state.viewMode !== "library") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  library.addEventListener("dragleave", (e) => {
    if (state.viewMode !== "library") return;
    e.preventDefault();
    state.dragCounter = Math.max(0, state.dragCounter - 1);
    if (state.dragCounter === 0) hideDragOverlay();
  });
  library.addEventListener("drop", async (e) => {
    if (state.viewMode !== "library") return;
    e.preventDefault();
    hideDragOverlay({ announce: false });
    announceGalleryStatus(t("dropImportReceived"), { persist: true });
    const files = e.dataTransfer?.files;
    if (!files || !files.length) {
      // 无文件：不进入导入流程，清空持久 live region（audit fix batch 1.3）。
      announceGalleryStatus("");
      return;
    }
    const file = files[0];
    if (!/\.(apng|avif|gif|jpe?g|png|svg|webp|m4v|mov|mp4|webm)$/i.test(file.name)) {
      announceGalleryStatus("");
      showToast(t("errorPathUnsupported"), "error");
      return;
    }
    let filePath = "";
    try {
      filePath = await droppedFilePath(file);
    } catch {
      // staging 失败：清空 live region 并显示可见 toast（与 Browse 一致），
      // 绝不回退到用户原始路径（audit fix batch 1.3）。
      announceGalleryStatus("");
      showToast(t("fileSelectionFailed"), "error");
      return;
    }
    if (!filePath) {
      // 无可用路径：不开空 Import Modal，清空持久状态并提示。
      announceGalleryStatus("");
      showToast(t("dropPathUnavailable"), "error");
      return;
    }
    if (els.imagePathInput) els.imagePathInput.value = filePath;
    openImportModal();
  });
}

async function toggleFavorite(id, event) {
  if (event) event.stopPropagation();
  try { await apiFetch(`/api/assets/${encodeURIComponent(state.project)}/${encodeURIComponent(id)}/favorite`, { method: "POST" }); showToast(t("favAdded"), "success"); await loadAssets(); } catch (error) { showToast(error.message, "error"); }
}

// The design reference intentionally switches navigation at 768px.  Desktop
// keeps the persistent rail; compact web views get a focusable drawer, scrim
// and Escape exit rather than a squeezed desktop sidebar.
const MOBILE_NAVIGATION_QUERY = "(max-width: 767px)";
let mobileNavReturnFocus = null;
function isMobileNavigationViewport() { return window.matchMedia(MOBILE_NAVIGATION_QUERY).matches; }
function setMobileNavOpen(open, { restoreFocus = false } = {}) {
  const mobile = isMobileNavigationViewport();
  const next = mobile && Boolean(open);
  document.body.classList.toggle("mobile-nav-open", next);
  els.mobileNavToggle?.setAttribute("aria-expanded", String(next));
  if (els.mobileNavScrim) els.mobileNavScrim.hidden = !next;
  if (els.sidebar) {
    els.sidebar.toggleAttribute("inert", mobile && !next);
    els.sidebar.setAttribute("aria-hidden", String(mobile && !next));
  }
  if (next) {
    mobileNavReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : els.mobileNavToggle;
    requestAnimationFrame(() => els.mobileNavClose?.focus());
  } else if (restoreFocus && mobileNavReturnFocus instanceof HTMLElement) {
    mobileNavReturnFocus.focus();
    mobileNavReturnFocus = null;
  }
}
function syncMobileNavigation() { setMobileNavOpen(false); }

// ===== Keyboard Shortcuts =====
function setupKeyboardShortcuts() {
  document.addEventListener("keydown", (event) => {
    // Phase 5B：ConfirmDialog 打开时页面背景不接收任何键盘操作（Escape 由
    // trapConfirmDialogFocus 消费；不新增第二套全局 Escape 路由）。
    if (confirmDialogState.pending) return;
    // Disabled context-menu shortcuts (pasteFromClipboard / selectAll) advertise
    // ⌘V / ⌘A but never implement them. Block the browser defaults so users
    // don't accidentally select all DOM text or trip paste-handlers that the
    // app does not own.
    if ((event.metaKey || event.ctrlKey) && (event.key === "a" || event.key === "A" || event.key === "v" || event.key === "V")) {
      if (event.target.matches?.("input, textarea, select, [contenteditable]")) return;
      // In Electron, the paste event handler in bindDesktopIntegration imports
      // a pasted image from the clipboard. Calling preventDefault() here would
      // suppress that paste event entirely, so let it through on the desktop.
      if (event.key === "v" || event.key === "V") {
        if (window.electronAPI) return;
      }
      event.preventDefault();
      return;
    }
    if (event.key === "Escape" && document.body.classList.contains("mobile-nav-open")) {
      event.preventDefault();
      setMobileNavOpen(false, { restoreFocus: true });
      return;
    }
    if (event.target.matches?.("input, textarea, select")) {
      // Phase 5A：处于打开的锚定浮层内部（如筛选面板 facet 搜索）时，Escape 仍须能关闭
      // 宿主浮层；其余快捷键保持输入守卫，打字不触发全局快捷键。
      if (event.key !== "Escape" || !anchoredOverlayManager.containsTarget(event.target)) return;
    }
    if (event.key === "/" && state.viewMode === "library" && !els.importModal?.classList.contains("open") && !els.groupModal?.classList.contains("open") && !els.accountModal?.classList.contains("open")) { event.preventDefault(); els.searchInput?.focus(); return; }
    if (event.key === "Escape") {
      // Phase 3A 运行时修复：bindEvents 先行注册的 Modal 焦点陷阱已消费本次 Escape
      // （preventDefault）时，本链不得再继续向下穿透（否则会关 Modal 同时退出查看模式）。
      if (event.defaultPrevented) return;
      if (!els.imagePreviewModal?.hidden) { closeImagePreview(); event.preventDefault(); return; }
      if (els.importModal?.classList.contains("open")) { closeImportModal(); event.preventDefault(); return; }
      if (els.groupModal?.classList.contains("open")) { closeGroupModal(); event.preventDefault(); return; }
      if (els.accountModal?.classList.contains("open")) { closeAccountModal(); event.preventDefault(); return; }
      // Phase 3A：Escape 先关最上层浮层（筛选面板/设置菜单），再退出查看模式——不得穿透。
      // Phase 5A：closePanel 统一路由到 anchoredOverlayManager（Settings 打开 Language 时 child 先关）。
      if (!els.settingsMenu?.hidden) { closePanel(els.settingsMenu, els.settingsToggle); event.preventDefault(); return; }
      if (state.viewMode === "asset") { returnToLibrary(); event.preventDefault(); return; }
      if (state.detailOpen) { setDetailOpen(false); event.preventDefault(); return; }
    }
    // Image Preview uses this same application-level keyboard router. Keeping
    // the handler here preserves the existing Escape priority and avoids a
    // second global shortcut manager. Form fields/contenteditable remain native.
    if (!els.imagePreviewModal?.hidden) {
      if (event.ctrlKey || event.metaKey || event.altKey || event.target.closest?.("[contenteditable]")) return;
      if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomImage(IMAGE_PREVIEW_ZOOM_STEP); return; }
      if (event.key === "-" || event.key === "_") { event.preventDefault(); zoomImage(-IMAGE_PREVIEW_ZOOM_STEP); return; }
      if (event.key === "0") { event.preventDefault(); resetImageZoom({ announce: true }); return; }
      if (event.key === "ArrowLeft") { event.preventDefault(); panImagePreview(-IMAGE_PREVIEW_PAN_STEP, 0); return; }
      if (event.key === "ArrowRight") { event.preventDefault(); panImagePreview(IMAGE_PREVIEW_PAN_STEP, 0); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); panImagePreview(0, -IMAGE_PREVIEW_PAN_STEP); return; }
      if (event.key === "ArrowDown") { event.preventDefault(); panImagePreview(0, IMAGE_PREVIEW_PAN_STEP); return; }
      return;
    }
    // Phase 3B / 规格 §8：专用大图舞台缩放快捷键——仅 Asset mode 生效；Modal、
    // Lightbox、筛选面板或设置菜单打开时不触发；带 Ctrl/Meta/Alt 时放行（浏览器缩放
    // 等系统快捷键保持原生，不覆盖）；输入控件由链首守卫拦截，此处再排除
    // contenteditable。方向键保留给 Phase 3C，本阶段不占用。
    if (state.viewMode === "asset"
      && !event.ctrlKey && !event.metaKey && !event.altKey
      && els.imagePreviewModal?.hidden
      && !els.importModal?.classList.contains("open")
      && !els.groupModal?.classList.contains("open")
      && els.settingsMenu?.hidden
      && !event.target.closest?.("[contenteditable]")) {
      if (event.target.matches?.("input, textarea, select")) return; // 输入控件一律不触发 Viewer 快捷键
      // Phase 3C：ArrowLeft/ArrowRight = 上一张/下一张。只在对应方向存在有效素材时
      // preventDefault（边界态放行浏览器原生行为）；不占用 ArrowUp/ArrowDown；导航
      // 经集中式 navigateAssetView（同步、幂等，键盘长按重复触发同路径安全）。
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        if (canNavigateAssetView(direction)) { event.preventDefault(); navigateAssetView(direction); }
        return;
      }
      if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomAssetViewBy(ASSET_VIEW_ZOOM_STEP, 0, 0, { announce: true }); return; }
      if (event.key === "-" || event.key === "_") { event.preventDefault(); zoomAssetViewBy(1 / ASSET_VIEW_ZOOM_STEP, 0, 0, { announce: true }); return; }
      if (event.key === "0") { event.preventDefault(); resetAssetViewToHundred(); return; }
      if (event.key === "f" || event.key === "F") { event.preventDefault(); fitAssetView(true); return; }
    }
    if (state.viewMode === "library") handleLibraryKeyboardNavigation(event);
  });
}

// ===== Image preview zoom/pan/pinch（已提取至 image-preview.mjs，R1 批次 4）=====
const imagePreview = createImagePreviewViewer({ els, state, t, announceGalleryStatus });
const { resetImageZoom, zoomImage, panImagePreview, announceImagePreviewZoom, setupImageZoomPan,
  reconcileImagePreviewTransform, consumeImagePreviewSuppressedClick,
  IMAGE_PREVIEW_ZOOM_STEP, IMAGE_PREVIEW_PAN_STEP } = imagePreview;
// ===== Inspector markup（检视器区块 markup helper，已提取至 inspector-markup.mjs，R1 批次 4）=====
const inspectorMarkup = createInspectorMarkup({ state, t, referenceRightsMarkup });
const { detailFileSectionMarkup, detailPromptSectionMarkup, detailSourceSectionMarkup,
  detailVersionSectionMarkup, detailGroupSectionMarkup, detailTagsSectionMarkup, detailCowartSectionMarkup,
  detailNewVersionSectionMarkup, detailMoreSectionMarkup, versionPickerMarkup, versionHistoryMarkup,
  recipeHistoryMarkup, recipeHistoryDisclosureMarkup, categoryOptions, buildSourceRows, sourceName,
  sourceCopyValue, isVideoAsset, assetMediaPreviewMarkup, formatFileSize, fileDimensionsText, fileFormatText,
  fileSizeText, fileFactRowMarkup, editRecipeFieldsMarkup, versionOptionLabel, detailVersionSummaryMarkup,
  originalMediaCapability, originalMediaActionMarkup, referenceRightsSummary } = inspectorMarkup;

// ===== Asset view（大图查看器，已提取至 asset-view.mjs，R1 批次 4）=====
const assetViewer = createAssetViewer({ els, state, t, announceGalleryStatus, selectedAsset, isVideoAsset,
  confirmDetailNavigation, isCurrentDetailSelection, assetRequestKey, currentAssetRequest, requestAssetPage,
  renderGrid, updateViewTitle, showToast, renderDetail, updateSelectedCard, setDetailOpen, setupMasonryLayout });
const { setViewMode, renderAssetView, openAssetView, returnToLibrary, resetAssetViewTransform,
  handleAssetViewImageLoad, handleAssetViewImageError, canNavigateAssetView, navigateAssetView,
  zoomAssetViewBy, fitAssetView, resetAssetViewToHundred, ASSET_VIEW_ZOOM_STEP } = assetViewer;


// ===== Gallery empty states (F-08) =====
// 五种空态语义严格分离：真实空库 / 搜索筛选无结果 / 收藏、最近、分组范围空态。
// 判定集中在 deriveGalleryEmptyState()，清除集中在 resetLibraryRefinements()；
// 不发送任何请求、不复制搜索/筛选算法、不维护第二套 gallery 状态。

/**
 * Centralized empty-state decision. Pure: reads existing state only, never
 * fetches. Fixed priority: loading → fatal error → cards → true empty library
 * → no results → scoped empties. `state.groups.total` is the authoritative
 * whole-library total (the same /api/groups count the sidebar shows); it is
 * loaded before assets on init, on project switch, and refreshed in the
 * background — `state.pageTotal` is only the current result total and must
 * never impersonate the library total.
 */
function deriveGalleryEmptyState() {
  if (state.galleryStatus === "loading") return "none";
  if (state.galleryStatus === "error") return "none";
  if (state.assets.length > 0) return "none";
  // The V2 Gallery deliberately uses one neutral recovery state for every
  // zero-result scope.  Separate favorites/recent/group states are legacy UI.
  return "no-results";
}

/** One shell for every empty state; the kind only changes copy and actions. */
function galleryEmptyMarkup() {
  const kind = deriveGalleryEmptyState();
  if (kind === "none") return "";
  // Faithful V2 recovery shell: package glyph, neutral copy, reset and import.
  const packageOpenIcon = "<svg class=\"gallery-empty-icon\" width=\"48\" height=\"48\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M12 22v-9\"/><path d=\"M15.17 2.21a1.67 1.67 0 0 1 1.63 0L21 4.57a1.93 1.93 0 0 1 0 3.36L8.82 14.79a1.66 1.66 0 0 1-1.64 0L3 12.43a1.93 1.93 0 0 1 0-3.36z\"/><path d=\"M20 13v3.87a2.06 2.06 0 0 1-1.11 1.83l-6 3.08a1.93 1.93 0 0 1-1.78 0l-6-3.08A2.06 2.06 0 0 1 4 16.87V13\"/><path d=\"M21 12.43a1.93 1.93 0 0 0 0-3.36L8.83 2.21a1.64 1.64 0 0 0-1.63 0L3 4.57a1.93 1.93 0 0 0 0 3.36l12.18 6.86a1.64 1.64 0 0 0 1.63 0z\"/></svg>";
  return "<div class=\"gallery-empty-state\" data-empty-kind=\"" + kind + "\">" + packageOpenIcon + "<div class=\"empty-state-copy\"><h2>" + escapeHtml(t("noResultsTitle")) + "</h2><p>" + escapeHtml(t("noResultsDescription")) + "</p></div><div class=\"empty-state-actions\"><button class=\"btn-secondary\" type=\"button\" data-action=\"empty-clear\">" + escapeHtml(t("resetFilters")) + "</button><button class=\"btn-primary\" type=\"button\" data-action=\"empty-import\">" + escapeHtml(t("onboardImport")) + "</button></div></div>";
}

/** Reuses the existing polite live region; never a second announcement system. */
function announceGalleryStatus(message, { persist = false } = {}) {
  if (!els.statusText) return;
  window.clearTimeout(statusAnnouncementTimer);
  statusAnnouncementTimer = null;
  const sequence = ++statusAnnouncementSequence;
  const announcement = String(message ?? "");
  if (!announcement) {
    statusAnnouncementActive = false;
    writeStatusText(persistentStatus.value);
    return;
  }
  statusAnnouncementActive = true;
  writeStatusText(announcement);
  if (persist) return;
  statusAnnouncementTimer = window.setTimeout(() => {
    if (sequence !== statusAnnouncementSequence) return;
    statusAnnouncementTimer = null;
    statusAnnouncementActive = false;
    writeStatusText(persistentStatus.value);
  }, STATUS_ANNOUNCEMENT_DURATION);
}

function announceEmptyState(kind) {
  if (!kind) return;
  announceGalleryStatus(kind === "library-empty" ? t("statusLibraryEmpty") : kind === "no-results" ? t("noResultsTitle") : t("statusScopeEmpty"));
}

/**
 * The single refinement reset. Clears query, search input, facets (including
 * the group facet), facet search and scope, then refreshes exactly once.
 * Sort, density, theme, language, project and every asset/favorite stay
 * untouched. Focus never lands on body: the first card wins, the grid
 * container is the fallback.
 */
function resetLibraryRefinements() {
  state.query = "";
  if (els.searchInput) els.searchInput.value = "";
  state.scope = "all";
  state.mediaKind = "all";
  clearFacets();
  // A reset restarts paging, and the viewer result-set semantics changed.
  state.nextCursor = null;
  if (state.viewMode === "asset") returnToLibrary();
  clearDetailSelection();
  renderQuickFilters(); renderTypeFilters(); renderActiveFilters();
  announceGalleryStatus(t("statusRefinementsCleared"));
  void loadAssets().then((applied) => {
    if (!applied) return;
    const firstCard = els.assetGrid?.querySelector(".asset-card-select");
    if (firstCard) firstCard.focus({ preventScroll: true });
    else els.assetGrid?.focus({ preventScroll: true });
  });
}

async function init() {
    applyLanguage();
    applyDarkMode();
    bindEvents();
    setupDragDrop();
    setupKeyboardShortcuts();
    setupImageZoomPan();
    renderGrid();
    try {
      await Promise.all([loadProjects(), loadCowartCanvases()]);
      await loadStats();
      await loadAssets();
      setDetailOpen(false);
      await refreshBridgeStatus();
      bridgeStatusPoller.start();
      // Single interval: dedupe on hot-reload / repeated init() and stop on unload.
      if (libraryRefreshTimer) clearInterval(libraryRefreshTimer);
      libraryRefreshTimer = setInterval(refreshLibraryInBackground, 2500);
    } catch (error) {
      renderErrorState(error);
      setStatus(t("statusUnavailable"), "error");
    }
  }

function addVoiceOverLabel(element, id, text) {
  if (!element || !text) return;
  const label = document.createElement("span");
  label.className = "visually-hidden";
  label.id = id;
  label.textContent = text;
  element.setAttribute("aria-labelledby", id);
  element.prepend(label);
}

function renderSettingsMenu() {
  if (!els.settingsMenu) return;
  const settingIcon = (path) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="${path}"/></svg>`;
  const radio = (selected, attribute, value, label) => `<button class="segmented-btn${selected ? " active" : ""}" type="button" role="radio" aria-checked="${selected}" tabindex="${selected ? 0 : -1}" ${attribute}="${value}">${label}</button>`;
  const row = (icon, title, subtitle, control = "") => `<section class="settings-modal-row"><div class="settings-row-icon" aria-hidden="true">${icon}</div><div class="settings-row-copy"><h3>${title}</h3><p>${subtitle}</p></div>${control ? `<div class="settings-row-control">${control}</div>` : ""}</section>`;
  const visualLocale = state.locale === "en" ? "en" : "zh";
  const path = escapeHtml(state.libraryPath || state.codexImagesDir || "—");
  const closeIcon = settingIcon("m6 6 12 12M18 6 6 18");
  const rows = [
    row(settingIcon("M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4M15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0"), t("themeMode"), state.darkMode ? t("themeDarkHint") : t("themeLightHint"), `<div class="segmented" role="radiogroup" aria-label="${escapeHtml(t("themeMode"))}">${radio(!state.darkMode, "data-appearance-opt", "light", t("themeLight"))}${radio(state.darkMode, "data-appearance-opt", "dark", t("themeDark"))}</div>`),
    row(settingIcon("M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"), t("cardDensity"), state.galleryDensity === "image" ? t("densityImage") : t("densityInfo"), `<div class="segmented" role="radiogroup" aria-label="${escapeHtml(t("cardDensity"))}">${radio(state.galleryDensity === "image", "data-density-opt", "image", t("densityImageControl"))}${radio(state.galleryDensity === "info", "data-density-opt", "info", t("densityInfoControl"))}</div>`),
    row(settingIcon("M4 12h16M12 4a12 12 0 0 1 0 16M12 4a12 12 0 0 0 0 16M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0"), t("interfaceLanguage"), visualLocale === "en" ? t("english") : t("chinese"), `<div class="segmented" role="radiogroup" aria-label="${escapeHtml(t("interfaceLanguage"))}">${radio(visualLocale === "zh", "data-locale", "zh", "中文")}${radio(visualLocale === "en", "data-locale", "en", "EN")}</div>`),
    row(settingIcon("M3 7.5A2.5 2.5 0 0 1 5.5 5h4l1.7 2h7.3A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5v-10Z"), t("libraryPath"), `<span class="settings-path">${path}</span>`, `<button class="settings-text-action" type="button" data-open-library>${t("change")}</button>`),
    row(settingIcon("M5.5 5.5C5.5 4.1 8.4 3 12 3s6.5 1.1 6.5 2.5S15.6 8 12 8 5.5 6.9 5.5 5.5ZM5.5 5.5v6C5.5 12.9 8.4 14 12 14s6.5-1.1 6.5-2.5v-6M5.5 11.5v6C5.5 18.9 8.4 20 12 20s6.5-1.1 6.5-2.5v-6"), t("storageEngine"), t("storageEngineValue")),
    row(settingIcon("M12 10v5M12 7.5v.1M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0"), t("version"), t("versionValue"))
  ].join("");
  els.settingsMenu.innerHTML = `<div class="settings-modal-card" role="dialog" aria-modal="true" aria-labelledby="settingsModalTitle" aria-describedby="settingsModalDescription" tabindex="-1"><header class="settings-modal-header"><div><h2 id="settingsModalTitle">${t("preferences")}</h2><p id="settingsModalDescription">${t("preferencesSubtitle")}</p></div><button class="settings-modal-close" type="button" data-settings-close aria-label="${escapeHtml(t("closeSettings"))}">${closeIcon}</button></header><div class="settings-modal-body">${rows}</div></div>`;
  syncSegmentedRadios(els.settingsMenu);
}

async function fetchDiagnostics() {
  const panel = document.querySelector("#diagnosticsPanel");
  const content = document.querySelector("#diagnosticsContent");
  if (!panel || !content) return;
  try {
    const response = await fetch("/api/health");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const fingerprint = data.uiFingerprint === "unknown" ? data.uiFingerprint : `${String(data.uiFingerprint).slice(0, 12)}...`;
    content.innerHTML = `<dl><dt>${t("diagVersion")}</dt><dd>${escapeHtml(data.productVersion)}</dd><dt>${t("diagGitSha")}</dt><dd>${escapeHtml(data.gitSha)}</dd><dt>${t("diagUiFingerprint")}</dt><dd>${escapeHtml(fingerprint)}</dd><dt>${t("diagLibraryDir")}</dt><dd>${escapeHtml(data.libraryDir)}</dd><dt>${t("diagStorage")}</dt><dd>${escapeHtml(data.storage)}</dd></dl>`;
  } catch {
    content.innerHTML = `<p class="diag-error">${t("diagError")}</p>`;
  } finally {
    anchoredOverlayManager.repositionOpen();
  }
}

function renderCowartCanvasSettings() {
  const entries = state.cowartCanvases.map((canvas) => {
    const label = cowartCanvasLabel(canvas);
    const status = canvas.lastError ? "error" : canvas.enabled ? "ok" : "off";
    return `<div class="settings-cowart-entry" title="${escapeHtml(canvas.canvasDir || canvas.projectDir || "")}"><span class="settings-cowart-status" data-state="${status}" aria-hidden="true"></span><span class="settings-cowart-name">${escapeHtml(label)}</span></div>`;
  }).join("");
  return `<section class="settings-section settings-cowart-section"><p>${t("cowartCanvases")}</p><div class="settings-cowart-list">${entries}</div></section>`;
}

function cowartCanvasLabel(canvas = {}) {
  if (canvas.managed) return t("mosaCanvas");
  const path = String(canvas.projectDir || "").replace(/\/+$/, "");
  const name = path.split("/").pop() || path || t("cowartCanvases");
  return t("projectCanvas", { name });
}

// Phase 4C：集中式可用画布判定——trusted === false 或 enabled === false 的画布永远不会
// 成为可选/可执行目标；仅「被发现」不等于「可插入」。只读取 state.cowartCanvases，不修改
// 原始数据、不复制后端安全规则（后端 resolveCowartInsertCanvas 仍独立拒绝 untrusted 目标）。
function usableCowartCanvases() {
  return state.cowartCanvases.filter((canvas) => canvas && canvas.trusted !== false && canvas.enabled !== false);
}

// 目标优先级：当前素材 source.cowart_source_id → 已持久化用户选择 → MOSA 专用画布 →
// 第一项可用画布。原目标不再可用时回退到下一合法目标——非法 ID 绝不发送到 insert API。
function cowartInsertTargetIdFor(asset) {
  const usable = usableCowartCanvases();
  const sourceId = typeof asset?.source?.cowart_source_id === "string" ? asset.source.cowart_source_id : "";
  const requestedId = sourceId || state.cowartInsertTargetId;
  if (usable.some((canvas) => canvas.id === requestedId)) return requestedId;
  return usable.find((canvas) => canvas.id === "mosa")?.id || usable[0]?.id || "";
}

// 内联反馈仅对应当前 project + asset；Bridge 轮询重绘同素材时从 state 恢复，不产生残留。
function cowartInsertFeedbackFor(asset) {
  const feedback = state.cowartInsertFeedback;
  if (!feedback || !asset) return null;
  return feedback.assetKey === `${asset.project_id}\u0000${asset.id}` ? feedback : null;
}

// Phase 4C 控件终态：可选目标区（多画布原生 select / 单画布只读目标 / 不可用可见说明）
// + 插入按钮 + 内联状态行。不可用时不渲染空 select；单画布不渲染无意义的单项 select。
// request generation 与 setCowartInsertBusy/renderCowartInsertStatus 协同保证一次点击
// 只发一次 POST、Busy 期间不可重复触发、晚到的旧响应不污染新素材。
let cowartInsertRequestSequence = 0;

function createCowartInsertControl(asset) {
  const usable = usableCowartCanvases();
  const targetId = cowartInsertTargetIdFor(asset);
  if (targetId) state.cowartInsertTargetId = targetId;
  const available = state.cowartInsertAvailable && usable.length > 0;

  let targetMarkup = "";
  if (available && usable.length > 1) {
    targetMarkup = `<label class="visually-hidden" for="cowartInsertTarget">${escapeHtml(t("cowartInsertTarget"))}</label><select id="cowartInsertTarget" class="cowart-target-select" data-cowart-insert-target aria-label="${escapeHtml(t("cowartInsertTarget"))}">${usable.map((canvas) => `<option value="${escapeHtml(canvas.id)}"${canvas.id === targetId ? " selected" : ""}>${escapeHtml(cowartCanvasLabel(canvas))}</option>`).join("")}</select>`;
  } else if (available) {
    targetMarkup = `<p class="cowart-target-readout" data-cowart-target-readout><span class="cowart-target-label">${escapeHtml(t("cowartInsertTarget"))}</span><span class="cowart-target-name">${escapeHtml(cowartCanvasLabel(usable[0]))}</span></p>`;
  } else {
    targetMarkup = `<p class="cowart-insert-hint" data-cowart-connect-hint>${escapeHtml(t("cowartConnectHint"))}</p>`;
  }
  const feedback = cowartInsertFeedbackFor(asset);
  const control = document.createElement("div");
  control.className = "cowart-insert-control";
  control.innerHTML = `${targetMarkup}<button class="action-btn primary" type="button" data-action="insert-cowart"${available ? "" : " disabled"} aria-disabled="${!available}" title="${escapeHtml(available ? t("insertCowart") : t("cowartInsertUnavailable"))}">${escapeHtml(t("insertCowart"))}</button><p class="cowart-insert-status" data-cowart-insert-status data-type="${feedback?.type || ""}" role="status"${feedback ? "" : " hidden"}>${escapeHtml(feedback?.message || "")}</p>`;
  return control;
}

const ARROW_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
// Cards in the same masonry column share a left edge to within a rounding error.
const COLUMN_TOLERANCE_PX = 4;

/** Rendered card geometry, so navigation follows what the reader can see. */
function cardGeometry() {
  const cards = [...(els.assetGrid?.querySelectorAll(".asset-card") || [])];
  return cards.map((card) => {
    const box = card.getBoundingClientRect();
    return { id: card.dataset.id, left: box.left, top: box.top, bottom: box.bottom, centerX: box.left + box.width / 2, centerY: box.top + box.height / 2 };
  }).filter((entry) => entry.id);
}

/**
 * A masonry grid places cards in columns of unequal height, so index arithmetic
 * does not describe what is next to what. Left/right move within the visual row
 * and up/down within the visual column, both measured from the rendered boxes.
 */
function neighbourAssetId(key) {
  const cards = cardGeometry();
  const current = cards.find((entry) => entry.id === state.selectedId);
  if (!current) return null;
  if (key === "ArrowLeft" || key === "ArrowRight") {
    const wanted = key === "ArrowRight" ? 1 : -1;
    const inDirection = cards.filter((entry) => entry.id !== current.id
      && Math.sign(entry.centerX - current.centerX) === wanted);
    // "Beside" in a staggered layout means the boxes overlap vertically. When
    // nothing overlaps, fall back to the nearest card in that direction.
    const overlapping = inDirection.filter((entry) => entry.top < current.bottom && entry.bottom > current.top);
    const pool = overlapping.length ? overlapping : inDirection;
    if (!pool.length) return null;
    return pool.reduce((best, entry) => {
      const score = Math.abs(entry.centerX - current.centerX) + Math.abs(entry.centerY - current.centerY) * 2;
      return score < best.score ? { id: entry.id, score } : best;
    }, { id: null, score: Infinity }).id;
  }
  const wanted = key === "ArrowDown" ? 1 : -1;
  const sameColumn = cards.filter((entry) => entry.id !== current.id
    && Math.abs(entry.left - current.left) <= COLUMN_TOLERANCE_PX
    && Math.sign(entry.centerY - current.centerY) === wanted);
  if (!sameColumn.length) return null;
  return sameColumn.reduce((best, entry) => {
    const distance = Math.abs(entry.centerY - current.centerY);
    return distance < best.distance ? { id: entry.id, distance } : best;
  }, { id: null, distance: Infinity }).id;
}

function handleLibraryKeyboardNavigation(event) {
  bindKeyboardNav(event);
}

// Gallery arrow navigation is a pure branch of the single application keydown
// router. The name is retained for the Phase 3 contract seam; it does not add a
// second document listener or a second shortcut manager.
function bindKeyboardNav(event) {
  if (confirmDialogState.pending || els.importModal?.classList.contains("open") || els.groupModal?.classList.contains("open")) return;
  if (!els.imagePreviewModal?.hidden || !els.settingsMenu?.hidden) return;
  if (event.target.closest?.("[contenteditable]")) return;
  if (event.target.closest?.("[role='tab']")) return;
  // Phase 3A：箭头键画廊导航仅属库内模式；查看模式下不切换选中资产（上一张/下一张属 Phase 3C）。
  if (state.viewMode !== "library") return;
  if (!ARROW_KEYS.has(event.key) || !state.assets.length) return;
  if (!state.assets.some((asset) => asset.id === state.selectedId)) return;
  const nextId = neighbourAssetId(event.key);
  if (!nextId) return;
  event.preventDefault();
  selectAsset(nextId, true);
}

// ===== ConfirmDialog（已提取至 confirm-dialog.mjs，R1 批次 3）=====
const confirmDialog = createConfirmDialog({ els, state, t, closePanel });
const { requestConfirmation, closeConfirmDialog, trapConfirmDialogFocus, isConfirmFocusTarget, confirmDialogState } = confirmDialog;

const toastManager = createToastManager({ els, state, t, isConfirmFocusTarget });
function showToast(message, type = "default") { return toastManager.show(message, type); }
// 只读调试钩子：仅供契约/运行时验证取证（队列位置、remaining、暂停原因），
// 不向 UI 暴露、不参与任何业务决策。
window.__mosaToastDebug = () => toastManager.snapshot();

// ===== Context Menu =====
const contextMenu = createContextMenu();
const contextMenuActions = createContextMenuActions({
  state,
  els,
  t,
  apiClient,
  showToast,
  runAction,
  requestConfirmation,
  getGroupColor: colorForGroup,
  saveGroupColor,
});

function isDetailEditorActive() {
  const active = document.activeElement;
  return state.detailDirty || (active instanceof HTMLElement && Boolean(els.detailPanel?.contains(active) && active.closest("[data-edit], [data-version-change], [data-recipe-change]")));
}

const bridgeStatusPoller = createBridgeStatusPoller({
  fetchStatus: () => apiFetch("/api/bridges"),
  onSuccess: applyBridgeStatus,
  onError: applyBridgeStatusFailure,
});

// Stop polling when the page goes away and drop any response that lands afterwards.
window.addEventListener("pagehide", () => {
  bridgeStatusPoller.stop();
  if (libraryRefreshTimer) {
    clearInterval(libraryRefreshTimer);
    libraryRefreshTimer = null;
  }
});

function refreshBridgeStatus() {
  return bridgeStatusPoller.refresh();
}

function applyBridgeStatus({ codex, grok, cowart, cowartInsert } = {}) {
    const nextCanvases = Array.isArray(cowart?.sources) ? cowart.sources : [];
    const canvasesChanged = cowartCanvasListSignature(nextCanvases) !== cowartCanvasListSignature(state.cowartCanvases);
    const availabilityChanged = state.cowartInsertAvailable !== Boolean(cowartInsert?.available);
    if (canvasesChanged) {
      state.cowartCanvases = nextCanvases;
      renderSettingsMenu();
      if (state.detailOpen && !isDetailEditorActive()) renderDetail();
    }
    state.cowartInsertAvailable = Boolean(cowartInsert?.available);
    // Required bridges only: a Grok-only failure must not force global error status.
    const hasError = codex?.lastError || cowart?.lastError;
    const codexOn = Boolean(codex?.enabled);
    const cowartOn = Boolean(cowart?.enabled);
    const grokOn = Boolean(grok?.enabled);
    const importedCount = Number(cowart?.totalImported || 0) + Number(codex?.totalImported || 0) + Number(grok?.totalImported || 0);
    const monitoredCount = Number(cowart?.monitoredCount || 0);
    // Grok is optional: global readiness only requires Codex + Cowart (+ insert when available).
    if (hasError) setStatus(t("statusBridgeError"), "error");
    else if (codexOn && cowartOn && state.cowartInsertAvailable) setStatus(t("statusReady"), "ok");
    else if (codexOn || cowartOn || grokOn) setStatus(state.cowartInsertAvailable ? t("statusBridgePartial") : t("statusCowartInsertUnavailable"), "warn");
    else setStatus(t("statusBridgeOff"), "warn");
    if (els.bridgeStatusMeta) {
      const meta = [];
      if (monitoredCount > 0) {
        meta.push(monitoredCount === 1
          ? t("statusWatchingOneCanvas")
          : t("statusWatchingCanvasCount", { count: monitoredCount }));
      }
      if (importedCount > 0) meta.push(t("statusImportedCount", { count: importedCount }));
      if (grok?.lastWarning) meta.push(String(grok.lastWarning));
      if (grok?.lastError) meta.push(String(grok.lastError));
      els.bridgeStatusMeta.textContent = meta.join(" · ");
    }
    updateCowartInsertControls();
    // Phase 4C：可用性翻转（MCP 连接/断开）改变控件结构（说明 ↔ 目标区），需要重建
    // Detail；签名未变的常规轮询只经 updateCowartInsertControls 同步 disabled 状态。
    if (!canvasesChanged && availabilityChanged && state.detailOpen && !isDetailEditorActive()) renderDetail();
}

function applyBridgeStatusFailure() {
    const availabilityChanged = state.cowartInsertAvailable;
    state.cowartInsertAvailable = false;
    if (els.bridgeStatusMeta) els.bridgeStatusMeta.textContent = "";
    setStatus(t("statusUnavailable"), "error");
    updateCowartInsertControls();
    if (availabilityChanged && state.detailOpen && !isDetailEditorActive()) renderDetail();
}

function cowartCanvasListSignature(canvases) {
  return (canvases || []).map((canvas) => `${canvas.id}:${canvas.canvasDir}:${canvas.enabled}:${canvas.lastError || ""}`).join("|");
}

/**
 * The supported-format list comes from the server rather than a copy in the
 * client, so the hint cannot claim a format the store would reject.
 */
function updateCodexHint() {
  if (els.importFormatList) els.importFormatList.textContent = state.supportedMediaExtensions.join(" ");
  const exampleDir = state.codexImagesDir || "/Users/you/Pictures";
  if (els.importPathExample) els.importPathExample.textContent = `${exampleDir}/example.png`;
  if (els.imagePathInput) els.imagePathInput.placeholder = `${exampleDir}/example.png`;
  if (els.codexSourceHint) els.codexSourceHint.textContent = state.codexImagesDir || t("importPathCodexDirUnknown");
}

function updateViewTitle() {
  const titles = { all: t("allAssets"), favorite: t("favorites"), recent: t("recent") };
  els.viewTitle.textContent = titles[state.scope] || t("allAssets");
  // Match V2 SearchBar's scope-aware hint without changing the shared search
  // control or any query semantics.
  if (els.searchInput) {
    const activeGroup = String(state.facets.group || "").trim();
    els.searchInput.placeholder = activeGroup
      ? t("searchGroup", { group: activeGroup })
      : state.scope === "favorite"
        ? t("searchFavorite")
        : state.scope === "recent"
          ? t("searchRecent")
          : t("searchAll");
  }
  // A count of 0 while the first request is still open is the bug the audit saw
  // as "sidebar 405, workspace 0".
  els.assetCount.textContent = state.galleryStatus === "loading"
    ? t("galleryLoading")
    : (state.galleryStatus === "error" ? "" : t("resultCount", { count: state.pageTotal || state.assets.length }));
  renderActiveFilters();
}

/** The chips are the only place the full active query is spelled out. */
function compactGenerationIdentifier(value) {
  const identifier = String(value || "");
  return identifier.length > 26 ? `${identifier.slice(0, 12)}…${identifier.slice(-8)}` : identifier;
}

function activeFilterChips() {
  const chips = [];
  if (state.query) chips.push({ kind: "query", label: t("chipSearch"), value: `“${state.query}”` });
  if (state.scope !== "all") chips.push({ kind: "scope", label: t("chipScope"), value: state.scope === "favorite" ? t("favorites") : t("recent") });
  if (state.mediaKind && state.mediaKind !== "all") chips.push({ kind: "type", label: t("typeFilter"), value: state.mediaKind === "img" ? t("typeImages") : t("typeVideos") });
  const sourceLabels = Object.fromEntries(Object.entries(SOURCE_FACETS).map(([key, value]) => [value, t(`filter${key.charAt(0).toUpperCase()}${key.slice(1)}`)]));
  for (const key of FACET_KEYS) {
    const value = state.facets[key];
    if (!value) continue;
    const label = t(`chip${key.charAt(0).toUpperCase()}${key.slice(1)}`);
    const readableValue = key === "source"
      ? (sourceLabels[value] || value)
      : (["conversation", "generationBatch"].includes(key) ? compactGenerationIdentifier(value) : humanizeFacetValue(value));
    chips.push({ kind: key, label, value: readableValue });
  }
  return chips;
}

function renderActiveFilters() {
  if (!els.activeFilters) return;
  const chips = activeFilterChips();
  els.activeFilters.hidden = chips.length === 0;
  if (!chips.length) { els.activeFilters.innerHTML = ""; return; }
  const chipMarkup = chips.map((chip) => {
    const readable = `${chip.label}${t("chipSeparator")}${chip.value}`;
    return `<button class="filter-chip" type="button" data-chip="${escapeHtml(chip.kind)}" aria-label="${escapeHtml(t("removeFilter", { label: readable }))}"><span class="filter-chip-key">${escapeHtml(chip.label)}</span><span class="filter-chip-value">${escapeHtml(chip.value)}</span><span class="filter-chip-x" aria-hidden="true">×</span></button>`;
  }).join("");
  // The chips scroll on one line rather than wrapping: at the 960px minimum window
  // a wrapped row grew the workspace bar to a quarter of the viewport. Clear-all
  // sits outside the scroller so it stays reachable however many chips there are.
  els.activeFilters.innerHTML = `<span class="visually-hidden">${escapeHtml(t("activeFilters"))}</span><div class="filter-chip-strip">${chipMarkup}</div><button class="filter-chip-clear" type="button" data-chip="__all">${escapeHtml(t("clearAll"))}</button>`;
}

function removeFilterChip(kind) {
  if (kind === "__all") { clearAllFilters(); return; }
  if (kind === "query") { state.query = ""; if (els.searchInput) els.searchInput.value = ""; }
  else if (kind === "scope") state.scope = "all";
  else if (kind === "type") { state.mediaKind = "all"; renderTypeFilters(); }
  else if (FACET_KEYS.includes(kind)) state.facets[kind] = "";
  else return;
  applyFilterChange();
}

function bindEvents() {
  syncMobileNavigation();
  els.mobileNavToggle?.addEventListener("click", () => setMobileNavOpen(true));
  els.mobileNavClose?.addEventListener("click", () => setMobileNavOpen(false, { restoreFocus: true }));
  els.mobileNavScrim?.addEventListener("click", () => setMobileNavOpen(false, { restoreFocus: true }));
  els.sidebar?.addEventListener("click", (event) => {
    if (!isMobileNavigationViewport()) return;
    if (event.target.closest(".nav-item, .add-group-button, .settings-trigger")) setMobileNavOpen(false);
  });
  els.searchInput?.addEventListener("input", debounce(async () => { state.query = els.searchInput.value; state.nextCursor = null;
    // Phase 3A：结果集语义已变化，退出查看模式（快照 requestKey 随之失效，恢复自动降级）。
    if (state.viewMode === "asset") returnToLibrary();
    renderActiveFilters(); await loadAssets(); }, 180));
  els.sortSelect?.addEventListener("change", () => {
    state.sort = normalizeSort(els.sortSelect.value);
    safeStorageSet("mosa.asset-sort", state.sort);
    // Cursors are order-specific, so a sort change always restarts from page one.
    state.nextCursor = null;
    // Phase 3A：结果集语义已变化，退出查看模式。
    if (state.viewMode === "asset") returnToLibrary();
    void loadAssets();
  });
  els.themeToggle?.addEventListener("click", toggleDarkMode);
  els.activeFilters?.addEventListener("click", (event) => { const chip = event.target.closest("[data-chip]"); if (chip) removeFilterChip(chip.dataset.chip); });
  els.assetGrid?.addEventListener("click", (event) => {
    const loadMoreButton = event.target.closest('[data-action="load-more"]');
    if (loadMoreButton && state.nextCursor && !isLoadingMore) {
      isLoadingMore = true;
      loadMoreButton.disabled = true;
      void loadAssets({ append: true }).finally(() => { isLoadingMore = false; });
      return;
    }
    if (event.target.closest('[data-action="retry"]')) window.location.reload();
    // F-08 空态操作：导入复用现有 Modal（不建第二套）；清除与查看全部共用
    // 同一个 reset helper，只触发一次刷新；打开素材库复用既有 API。
    if (event.target.closest('[data-action="empty-import"]')) { openImportModal(); return; }
    if (event.target.closest('[data-action="empty-clear"]') || event.target.closest('[data-action="empty-view-all"]')) { resetLibraryRefinements(); return; }
    const openLibraryAction = event.target.closest('[data-action="empty-open-library"]');
    if (openLibraryAction) runAction(async () => { if (!state.libraryPath) return; await apiFetch("/api/open-folder", { method: "POST", body: { path: state.libraryPath } }); showToast(t("openInFinder"), "success"); });
  });
  els.addGroupBtn?.addEventListener("click", openGroupModal);
  els.newAssetTopBtn?.addEventListener("click", openImportModal);
  els.quickFilters?.addEventListener("click", (event) => { const button = event.target.closest("[data-filter]"); if (button) setFilter(button.dataset.filter); });
  els.sidebarGroupList?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]"); if (button) setFilter(button.dataset.filter, button.dataset.value);
  });
  els.typeFilters?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-type]");
    if (!button || button.dataset.type === state.mediaKind) return;
    state.mediaKind = button.dataset.type;
    renderTypeFilters();
    applyFilterChange();
  });
  els.settingsToggle?.addEventListener("click", toggleSettingsModal);
  els.accountToggle?.addEventListener("click", openAccountModal);
  els.closeAccountModal?.addEventListener("click", closeAccountModal);
  els.accountModal?.addEventListener("click", (event) => {
    if (event.target === els.accountModal) { closeAccountModal(); return; }
    if (event.target.closest("[data-account-action]")) showToast(t("accountUnavailable"));
  });
  els.settingsMenu?.addEventListener("change", async (event) => {
    const select = event.target.closest("[data-project-select]");
    if (!select) return;
    state.project = select.value; clearDetailSelection(); state.scope = "all"; clearFacets(); state.query = ""; els.searchInput.value = ""; state.nextCursor = null;
    // Phase 3A：项目切换改变结果集语义，退出查看模式（设置菜单在侧栏，查看模式下仍可达）。
    if (state.viewMode === "asset") returnToLibrary();
    renderActiveFilters();
    await loadStats(); await loadAssets();
  });
  els.settingsMenu?.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (event.target === els.settingsMenu || button?.dataset.settingsClose !== undefined) { closeSettingsModal(); return; }
    // Theme/Density segmented buttons
    if (button?.dataset.appearanceOpt) {
      const newTheme = button.dataset.appearanceOpt;
      state.darkMode = newTheme === "dark";
      safeStorageSet("mosa-dark-mode", String(state.darkMode));
      applyDarkMode(); // 同步 .active 视觉态与 aria-checked/roving tabindex（Phase 5A / F-12）
      showToast(t("darkModeChanged"), "success");
      return;
    }

    // Gallery density segmented buttons
    if (button?.dataset.densityOpt) {
      const newDensity = button.dataset.densityOpt;
      state.galleryDensity = normalizeDensity(newDensity);
      safeStorageSet("mosa.gallery-density", state.galleryDensity);
      renderGrid();
      if (state.detailOpen) renderDetail();
      button.parentElement.querySelectorAll(".segmented-btn").forEach((b) => b.classList.remove("active"));
      button.classList.add("active");
      syncSegmentedRadios(els.settingsMenu); // aria-checked 与 .active 同步（Phase 5A / F-12）
      return;
    }

    // Toggle diagnostics section
    const diagnosticsToggle = event.target.closest("[data-action='toggle-diagnostics']");
    if (diagnosticsToggle) {
      state.diagnosticsExpanded = !state.diagnosticsExpanded;
      const panel = document.querySelector("#diagnosticsPanel");
      const content = document.querySelector("#diagnosticsContent");
      if (panel) panel.hidden = !state.diagnosticsExpanded;
      diagnosticsToggle.setAttribute("aria-expanded", String(state.diagnosticsExpanded));
      diagnosticsToggle.textContent = state.diagnosticsExpanded ? t("hideDiagnostics") : t("showDiagnostics");
      if (state.diagnosticsExpanded && content) {
        content.innerHTML = `<p class="diag-loading">${t("diagLoading")}</p>`;
        fetchDiagnostics();
      }
      return;
    }

    const languageMenuTrigger = event.target.closest("[data-language-menu]");
    if (languageMenuTrigger) {
      // Phase 5A：child 浮层的开关、定位、aria-expanded 全部经共享 manager（打开不关 Settings）。
      anchoredOverlayManager.toggle("language");
      return;
    }
    const localeButton = event.target.closest("[data-locale]");
    if (localeButton) {
      return setLanguage(localeButton.dataset.locale);
    }
    const openLibraryButton = event.target.closest("[data-open-library]");
    if (openLibraryButton) runAction(async () => { if (!state.libraryPath) return; await apiFetch("/api/open-folder", { method: "POST", body: { path: state.libraryPath } }); showToast(t("openInFinder"), "success"); });
  });
  els.closeImportModal?.addEventListener("click", closeImportModal);
  els.cancelImportBtn?.addEventListener("click", closeImportModal);
  els.importModal?.addEventListener("click", (event) => { if (event.target === els.importModal) closeImportModal(); });
  els.closeGroupModal?.addEventListener("click", closeGroupModal);
  els.cancelGroupBtn?.addEventListener("click", closeGroupModal);
  els.groupModal?.addEventListener("click", (event) => { if (event.target === els.groupModal) closeGroupModal(); });
  els.groupModal?.addEventListener("click", (event) => {
    const swatch = event.target.closest("[data-group-color]");
    if (swatch) selectGroupColor(swatch.dataset.groupColor);
  });
  els.groupNameInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); void saveGroup(); }
  });
  // Phase 5B / F-15：ConfirmDialog——Cancel/Confirm 结算唯一 pending Promise；Backdrop 点击只能取消，绝不确认。
  els.confirmDialogCancel?.addEventListener("click", () => closeConfirmDialog(false));
  els.confirmDialogConfirm?.addEventListener("click", () => closeConfirmDialog(true));
  els.confirmDialog?.addEventListener("click", (event) => { if (event.target === els.confirmDialog) closeConfirmDialog(false); });
  els.saveGroupBtn?.addEventListener("click", saveGroup);
  els.closeImagePreview?.addEventListener("click", closeImagePreview);
  els.imagePreviewModal?.addEventListener("click", (event) => { if (event.target === els.imagePreviewModal) closeImagePreview(); });
  els.imagePreviewStage?.addEventListener("click", (event) => {
    if (consumeImagePreviewSuppressedClick()) return;
    if (event.target === els.imagePreviewStage) closeImagePreview();
  });
  els.imagePreviewImage?.addEventListener("load", fitImagePreview);
  els.assetViewBack?.addEventListener("click", returnToLibrary);
  // Phase 3A 运行时修复（双击进入路径）：第一次 click 已打开查看模式并同步聚焦返回按钮，
  // 紧随的第二次 mousedown 落在同坐标的舞台/主图上——浏览器默认动作会把焦点清到 BODY，
  // 使打开焦点丢失。阻止舞台与主图 mousedown 的默认焦点转移（不改布局/不新增状态）；
  // 视频元素排除在外，保留原生 controls 交互；缩放/平移接入（Phase 3B）时在同一监听器扩展。
  els.assetViewStage?.addEventListener("mousedown", (event) => {
    if (event.target === els.assetViewStage || event.target === els.assetViewImage) event.preventDefault();
  });
  // Phase 3C：主图 error 走带竞态守卫的命名处理器（旧 error 不得污染新素材错误态）。
  els.assetViewImage?.addEventListener("error", handleAssetViewImageError);
  // Phase 3B：缩放控制条与主图 load 接线（全应用唯一一套缩放控制）。
  els.assetZoomOut?.addEventListener("click", () => zoomAssetViewBy(1 / ASSET_VIEW_ZOOM_STEP, 0, 0, { announce: true }));
  els.assetZoomIn?.addEventListener("click", () => zoomAssetViewBy(ASSET_VIEW_ZOOM_STEP, 0, 0, { announce: true }));
  els.assetZoomFit?.addEventListener("click", () => fitAssetView(true));
  els.assetViewImage?.addEventListener("load", handleAssetViewImageLoad);
  // Phase 3C：唯一一套上一张/下一张（全应用无第二套导航控件）。
  els.assetViewPrev?.addEventListener("click", () => navigateAssetView(-1));
  els.assetViewNext?.addEventListener("click", () => navigateAssetView(1));
  els.saveAssetBtn?.addEventListener("click", saveAsset);
  // Phase 5A / F-12：Settings 菜单统一键盘模型（menu roving + Language 子菜单 + segmented radiogroup）。
  // 绑定在持久的 #settingsMenu 元素上：innerHTML 重建不会叠加监听器（全应用唯一一套）。
  els.settingsMenu?.addEventListener("keydown", handleSettingsMenuKeydown);
  // Phase 5A / F-14：全局外部点击只保留一套（manager 统一路由 root/child 关闭策略）。
  document.addEventListener("click", (event) => anchoredOverlayManager.handleOutsidePointer(event.target));
  // Phase 5A / F-14：全局 resize 重定位只保留一套（viewport-change 只重定位，不自动关闭）。
  window.addEventListener("resize", () => { anchoredOverlayManager.repositionOpen(); syncMobileNavigation(); if (state.imagePreviewId) fitImagePreview(); });

  bindContextMenuEvents({
    state,
    els,
    contextMenu,
    contextMenuActions,
    loadAssets,
    loadStats,
    selectAsset,
    openAssetView,
    showToast,
    t,
  });
  // Phase 5B：ConfirmDialog 陷阱先于其余陷阱注册——Escape 优先级链最前（preventDefault +
  // stopPropagation，不穿透 Viewer/既有 Modal）；ConfirmDialog 未打开时后续陷阱照常工作。
  document.addEventListener("keydown", trapConfirmDialogFocus);
  document.addEventListener("keydown", trapAccountModalFocus);
  document.addEventListener("keydown", trapImportModalFocus);
  document.addEventListener("keydown", trapSettingsModalFocus);
  document.addEventListener("keydown", trapGroupModalFocus);
  document.addEventListener("keydown", trapImagePreviewFocus);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    // Phase 3A 运行时修复：Modal/Lightbox 焦点陷阱已在先注册的监听器中消费本次 Escape
    // （preventDefault + 关浮层）——本监听器不得再把 detail 抽屉连带关闭（一次 Escape 只退一层）。
    if (event.defaultPrevented) return;
    if (!state.detailOpen) return;
    // Phase 3A：查看模式的 Escape 由 setupKeyboardShortcuts 的优先级链统一处理（先浮层后退出）。
    if (state.viewMode === "asset") return;
    if (els.importModal?.classList.contains("open") || els.groupModal?.classList.contains("open") || els.accountModal?.classList.contains("open") || !els.imagePreviewModal?.hidden) return;
    if (!els.settingsMenu?.hidden) return;
    event.preventDefault();
    setDetailOpen(false);
  });
  bindDesktopIntegration();
}

function bindDesktopIntegration() {
  const api = window.electronAPI;
  if (!api) return;
  document.querySelector("#browseFileBtn")?.addEventListener("click", async () => {
    try {
      const filePaths = await api.openFileDialog();
      if (filePaths?.length && els.imagePathInput) {
        els.imagePathInput.value = filePaths[0];
      }
    } catch {
      // Staging failures propagate via IPC rejection; the user gets visible
      // feedback instead of a silent skip (audit fix batch 1.1).
      showToast(t("fileSelectionFailed"), "error");
    }
  });
  document.addEventListener("paste", async (event) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        event.preventDefault();
        const filePath = await api.pasteImage();
        if (filePath && els.imagePathInput) {
          els.imagePathInput.value = filePath;
          openImportModal();
        }
        return;
      }
    }
  });
  api.onMenuImport?.(() => openImportModal());
  api.onMenuSearch?.(() => { els.searchInput?.focus(); });
}

function setLanguage(value) {
  state.languagePreference = value;
  safeStorageSet("mosa.ui-language", value);
  applyLanguage();
  requestAnimationFrame(() => {
    if (els.settingsMenu && !els.settingsMenu.hidden) els.settingsMenu.querySelector(`[data-locale="${value === "en" ? "en" : "zh"}"]`)?.focus();
  });
  refreshBridgeStatus();
  showToast(t("languageChanged"), "success");
}

/**
 * One entry point for every filter control. Scopes replace each other; facets
 * toggle, so picking a style no longer silently discards an active source.
 */
function setFilter(type, value = "") {
  if (type === "all") { state.scope = "all"; clearFacets(); }
  else if (SCOPES.includes(type)) state.scope = type;
  else if (type in SOURCE_FACETS) toggleFacet("source", SOURCE_FACETS[type]);
  else if (FACET_KEYS.includes(type)) toggleFacet(type, value);
  else return;
  applyFilterChange();
}

function toggleFacet(key, value) {
  state.facets[key] = state.facets[key] === value ? "" : value;
}

function clearFacets() {
  for (const key of FACET_KEYS) state.facets[key] = "";
}

function clearAllFilters() {
  // F-08：清除一律收敛到单一 reset helper（query/输入框/facets/scope/分组，
  // 一次刷新）；sort、density、theme、language、project 不受影响。
  resetLibraryRefinements();
}

function applyFilterChange() {
  // A filter change restarts paging, so any cursor from the previous query is stale.
  state.nextCursor = null;
  // Phase 3A：结果集语义已变化，退出查看模式。
  if (state.viewMode === "asset") returnToLibrary();
  clearDetailSelection();
  renderQuickFilters(); renderTypeFilters(); renderActiveFilters(); loadAssets();
}

function showRelatedGenerations(asset, mode) {
  const conversationId = String(asset?.source?.conversation_id || "").trim();
  const messageId = String(asset?.source?.message_id || "").trim();
  if (!conversationId || (mode === "batch" && !messageId)) return;
  state.scope = "all";
  state.mediaKind = "all";
  clearFacets();
  state.facets.conversation = conversationId;
  if (mode === "batch") state.facets.generationBatch = messageId;
  applyFilterChange();
}

// Phase 5A / F-14：兼容 wrapper——既有调用点（Escape 优先级链、sidebar 打开全部分组）保留
// 原字面签名；开关/定位/aria-expanded/hidden/return focus 全部路由到共享 anchoredOverlayManager，
// 不再存在任何独立定位公式。
function togglePanel(panel, trigger) {
  if (panel === els.settingsMenu) { toggleSettingsModal(); return; }
  if (!panel) return;
  const overlayId = anchoredOverlayManager.idForPanel(panel);
  if (!overlayId) return;
  anchoredOverlayManager.toggle(overlayId); // trigger-toggle：root 互斥由 manager 统一处理
}
function closePanel(panel, trigger, reason = "escape") {
  if (panel === els.settingsMenu) { closeSettingsModal({ restoreFocus: reason !== "outside-pointer" }); return; }
  if (!panel) return;
  const overlayId = anchoredOverlayManager.idForPanel(panel);
  if (!overlayId) return;
  anchoredOverlayManager.close(overlayId, reason); // reason=escape 时 child 先关（child-first）
}

// Phase 5A / F-12：Settings 菜单统一键盘处理器（委托在持久的 #settingsMenu 元素）。
// 分层：语言子菜单打开时优先处理 child；radiogroup 自持方向键（不冒泡到 menu roving）；
// 原生 select/input 不被方向键劫持；menu roving 仅作用于本层合法 menuitem，循环导航。
function handleSettingsMenuKeydown(event) {
  const languageMenu = els.settingsMenu?.querySelector("#languageMenu");
  if (languageMenu && !languageMenu.hidden && languageMenu.contains(event.target)) {
    handleLanguageMenuKeydown(event, languageMenu);
    return;
  }
  const radio = event.target.closest?.('[role="radio"]');
  if (radio) {
    const group = radio.closest('[role="radiogroup"]');
    const buttons = group ? [...group.querySelectorAll('[role="radio"]')] : [];
    const index = buttons.indexOf(radio);
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % buttons.length;
    else if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === "ArrowUp") next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    if (next === -1 || !buttons[next]) return;
    event.preventDefault();
    event.stopPropagation(); // 分段控件内方向键不得触发 Settings menu 的 roving handler
    buttons[next].click(); // 复用既有主题/密度 click 业务路径，逻辑零分叉
    buttons[next].focus();
    return;
  }
  if (event.target.closest?.("[data-language-menu]") && event.key === "ArrowRight") {
    // ArrowRight 打开子菜单；Enter/Space 走原生 button click 委托，不重复实现。
    if (els.settingsMenu?.querySelector("#languageMenu")?.hidden) {
      event.preventDefault();
      anchoredOverlayManager.open("language");
    }
    return;
  }
  if (event.target.matches?.("select, input, textarea")) return; // 原生 select 保持原生键盘语义
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
  const items = settingsMenuItems();
  if (!items.length) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement);
  let next;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  else next = current === -1 ? 0 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  focusSettingsMenuItem(items[next]);
}

// Language child overlay 键盘模型：ArrowDown/Up 循环、Home/End、Escape/ArrowLeft 关闭 child
// 并把焦点送回语言入口（不穿透到 Settings 与 Viewer）；Enter/Space 选择走原生 click 委托。
function handleLanguageMenuKeydown(event, menu) {
  if (event.key === "Escape" || event.key === "ArrowLeft") {
    event.preventDefault();
    event.stopPropagation();
    anchoredOverlayManager.close("language", "escape");
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
    const items = languageMenuItems(menu);
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement);
    let next;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else next = current === -1 ? 0 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    focusLanguageMenuItem(items[next]);
  }
}

/** Maps a store error code to the field that caused it and a readable reason. */
const IMPORT_ERROR_FIELDS = {
  IMAGE_PATH_REQUIRED: { field: "imagePath", message: "errorPathRequired" },
  IMAGE_PATH_NOT_FOUND: { field: "imagePath", message: "errorPathNotFound" },
  IMAGE_PATH_UNSUPPORTED_TYPE: { field: "imagePath", message: "errorPathUnsupported" },
  IMAGE_PATH_NOT_READABLE: { field: "imagePath", message: "errorPathNotReadable" },
};

function importErrorTargets() {
  return {
    imagePath: { input: els.imagePathInput, output: els.imagePathError, disclosure: null },
    businessFields: { input: els.businessInput, output: els.businessFieldsError, disclosure: els.importAdvanced },
  };
}

function clearImportErrors() {
  for (const { input, output } of Object.values(importErrorTargets())) {
    input?.removeAttribute("aria-invalid");
    if (output) { output.hidden = true; output.textContent = ""; }
  }
}

/**
 * Errors are shown next to the field that caused them, announced through the
 * field's aria-describedby, and marked with aria-invalid — the icon and text
 * carry the meaning, so colour is never the only signal.
 */
function showImportError(field, message) {
  clearImportErrors();
  const target = importErrorTargets()[field];
  if (!target) { showToast(message, "error"); return; }
  if (target.output) { target.output.textContent = message; target.output.hidden = false; }
  target.input?.setAttribute("aria-invalid", "true");
  // A collapsed advanced section would otherwise hide the field the error names.
  if (target.disclosure) target.disclosure.open = true;
  target.input?.focus();
}

function setImportBusy(busy) {
  state.importSaving = busy;
  if (!els.saveAssetBtn) return;
  els.saveAssetBtn.disabled = busy;
  els.saveAssetBtn.setAttribute("aria-busy", String(busy));
  els.saveAssetBtn.textContent = busy ? t("savingAsset") : t("saveAsset");
}

async function saveAsset() {
  // A second click while the first request is in flight would import twice.
  if (state.importSaving) return;
  clearImportErrors();
  if (!els.imagePathInput.value.trim()) { showImportError("imagePath", t("errorPathRequired")); return; }
  let businessFields = {};
  if (els.businessInput.value.trim()) {
    try { businessFields = JSON.parse(els.businessInput.value); }
    catch { showImportError("businessFields", t("errorInvalidJson")); return; }
  }
  setImportBusy(true);
  try {
    const result = await apiFetch("/api/assets/create", { method: "POST", body: { projectId: state.project, imagePath: els.imagePathInput.value, prompt: els.promptInput.value, skill: els.skillInput.value, style: els.styleInput.value, ratio: els.ratioInput.value, theme: els.themeInput.value, group: els.groupInput.value, category: els.categoryInput.value, tags: uniqueTags([...(derivePromptTags({ prompt: els.promptInput.value, skill: els.skillInput.value, style: els.styleInput.value, theme: els.themeInput.value, category: els.categoryInput.value }))]), business_fields: businessFields } });
    state.selectedId = result.asset.id;
    clearImportForm(); closeImportModal(); showToast(`${t("savedAsset")} · ${result.asset.id}`, "success");
    await loadStats(); await loadAssets();
  } catch (error) {
    const mapped = IMPORT_ERROR_FIELDS[error?.code];
    if (mapped) showImportError(mapped.field, t(mapped.message));
    else showToast(error.message, "error");
  } finally {
    setImportBusy(false);
  }
}

function clearImportForm() {
  [els.imagePathInput, els.promptInput, els.skillInput, els.styleInput, els.ratioInput, els.themeInput, els.groupInput, els.businessInput].forEach((input) => { input.value = ""; });
  els.categoryInput.value = "";
  clearImportErrors();
  if (els.importAdvanced) els.importAdvanced.open = false;
}

function renderQuickFilters() {
  if (!els.quickFilters) return;
  const counts = { all: state.groups.total, favorite: state.groups.favorites, recent: state.groups.recent };
  els.quickFilters.querySelectorAll("[data-filter]").forEach((button) => { const active = button.dataset.filter === state.scope; button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active)); button.querySelector(".nav-count").textContent = counts[button.dataset.filter] ?? "—"; });
  renderSidebarGroups();
}

/** V2 FilterBar type filter: sync the 全部/图片/视频 pressed state. */
function renderTypeFilters() {
  els.typeFilters?.querySelectorAll("[data-type]").forEach((button) => {
    const active = button.dataset.type === state.mediaKind;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

/**
 * The sidebar keeps only the busiest collections; the complete list lives in the
 * filter panel so the two surfaces stop duplicating the same long list.
 */
function renderSidebarGroups() {
  if (!els.sidebarGroupList) return;
  const all = state.groups.groups;
  const shown = all;
  const items = shown.map(([name, count]) => {
    const active = state.facets.group === name;
    const color = colorForGroup(name);
    return `<li><button class="nav-item nav-group-item${active ? " active" : ""}" data-filter="group" data-value="${escapeHtml(name)}" type="button" aria-pressed="${active}"><span class="nav-group-dot" data-group-color="${escapeHtml(color)}" aria-hidden="true"></span><span class="nav-item-text" title="${escapeHtml(name)}">${escapeHtml(name)}</span><span class="nav-count">${count}</span></button></li>`;
  }).join("");
  els.sidebarGroupList.innerHTML = items;
}

let masonryResizeObserver = null;
function layoutMasonry() { els.assetGrid?.querySelectorAll(".asset-card").forEach((card) => { const height = card.getBoundingClientRect().height || 0; if (height) card.style.gridRowEnd = `span ${Math.ceil(height + 8)}`; }); }
function setupMasonryLayout() {
  const grid = els.assetGrid; if (!grid) return;
  // Lay out once synchronously and again on the next frame. Animation frames are
  // suspended while the window is hidden or throttled, and a masonry grid whose
  // row spans never get measured collapses its cards to a few pixels.
  const schedule = () => { layoutMasonry(); requestAnimationFrame(layoutMasonry); };
  grid.querySelectorAll(".thumb").forEach((media) => {
    media.addEventListener("load", schedule, { once: true });
    media.addEventListener("loadeddata", schedule, { once: true });
  });
  schedule();
  masonryResizeObserver?.disconnect();
  if ("ResizeObserver" in window) { masonryResizeObserver = new ResizeObserver(schedule); masonryResizeObserver.observe(grid); }
  setupInfiniteScroll();
}

let infiniteScrollObserver = null;
let isLoadingMore = false;
function setupInfiniteScroll() {
  infiniteScrollObserver?.disconnect();
  const sentinel = els.assetGrid?.querySelector('[data-sentinel="true"]');
  if (!sentinel || !state.nextCursor) return;
  infiniteScrollObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting && state.nextCursor && !isLoadingMore) {
        isLoadingMore = true;
        loadAssets({ append: true }).finally(() => { isLoadingMore = false; });
      }
    });
  }, { rootMargin: "400px" });
  infiniteScrollObserver.observe(sentinel);
}

/**
 * Placeholders sized like real cards, so the first paint is not a fake empty
 * library. Heights come from nth-child rules rather than inline styles.
 */
function gallerySkeletonMarkup() {
  const tiles = Array.from({ length: SKELETON_TILE_COUNT }, () => `<div class="asset-skeleton" aria-hidden="true"></div>`).join("");
  return `<div class="gallery-skeleton" role="status" aria-live="polite"><span class="visually-hidden">${escapeHtml(t("galleryLoading"))}</span>${tiles}</div>`;
}

// F-24：入场动画范围经 arguments 传入（loadAssets 在首次加载/追加页时设置），
// 普通重渲染（搜索/筛选/排序/后台刷新）不带参数则不播放；签名保持无参以兼容
// 既有契约测试对 renderGrid 签名的正则锁定。
function renderGrid() {
  const { animate = false, animateFrom = 0 } = arguments[0] || {};
  if (!els.assetGrid) return;
  els.assetGrid.dataset.density = state.galleryDensity;
  // Loading, failed, empty and populated are four distinct renders; the empty
  // state is only reachable once a request has actually answered with nothing.
  if (state.galleryStatus === "loading") { els.assetGrid.innerHTML = gallerySkeletonMarkup(); return; }
  if (state.galleryStatus === "error") {
    const message = state.galleryError?.message || "";
    els.assetGrid.innerHTML = `<div class="error-state"><p>${escapeHtml(t("loadFailed"))}</p><span>${escapeHtml(message)}</span><button type="button" data-action="retry">${escapeHtml(t("retry"))}</button></div>`;
    return;
  }
  if (!state.assets.length) {
    // F-08：零结果不再一律谎称「素材库为空」——判定由集中式 helper 按
    // 全库总数、query、facets、scope、分组分流，五类空态共用一个壳。
    els.assetGrid.innerHTML = galleryEmptyMarkup();
    announceEmptyState(els.assetGrid.querySelector(".gallery-empty-state")?.dataset.emptyKind);
    return;
  }
  // F-24：闭包序号判断入场动画范围（保持 map 回调签名与既有契约一致）。
  let cardOrdinal = 0;
  const cards = state.assets.map((asset) => {
    const animateCard = animate && cardOrdinal >= animateFrom;
    cardOrdinal += 1;
    const title = cardShortTitle(asset);
    const sourceLabel = assetSourceLabel(asset);
    const date = formatDate(asset.created_at, state.locale);
    const selected = asset.id === state.selectedId;
    const media = assetMediaPreviewMarkup(asset, "thumb");
    // Short, structured label instead of the full prompt.
    const label = t("cardAccessibleName", { title: title || asset.id, source: sourceLabel, date });
    const versionIndex = Number(asset.version_index) || 0;
    const badge = versionIndex > 1 ? t("versionLabelShort", { number: versionIndex }) : (asset.group || "");
    const info = `<div class="asset-card-info"><p class="asset-card-title" title="${escapeHtml(title)}">${escapeHtml(title)}</p><p class="asset-card-meta"><span>${escapeHtml(sourceLabel)}</span><span>${escapeHtml(date)}</span>${badge ? `<span class="asset-card-badge" title="${escapeHtml(badge)}">${escapeHtml(badge)}</span>` : ""}</p></div>`;
    const isFav = asset.favorite;
    const favoriteLabel = isFav ? t("removeFavorite") : t("addFavorite");
    // Phase 1C/1C.1 契约：.card-actions > button.card-action-btn.card-favorite / .card-quick-copy，
    // 业务 class 与 data 属性全部保留（现有事件绑定依赖）；aria-pressed 表达收藏态。
    const favBtn = `<button class="card-action-btn card-favorite${isFav ? " is-fav" : ""}" type="button" data-fav-id="${escapeHtml(asset.id)}" aria-pressed="${Boolean(isFav)}" aria-label="${escapeHtml(favoriteLabel)}" title="${escapeHtml(favoriteLabel)}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2.5l2.95 5.97 6.59.96-4.77 4.65 1.13 6.57L12 17.57l-5.9 3.08 1.13-6.57-4.77-4.65 6.59-.96L12 2.5z"/></svg></button>`;
    const copyBtn = `<button class="card-action-btn card-quick-copy" type="button" data-copy="${escapeHtml(asset.prompt || "")}" data-i18n-title="copyPrompt" title="${t("copyPrompt")}" aria-label="${t("copyPrompt")}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9"/></svg></button>`;
    const cardActions = `<div class="card-actions">${favBtn}${copyBtn}</div>`;
    return `<article class="asset-card${selected ? " selected" : ""}${isVideoAsset(asset) ? " is-video" : ""}${animateCard ? " card-enter" : ""}" data-id="${escapeHtml(asset.id)}" title="${escapeHtml(cardShortTitle(asset))}"><button class="asset-card-select" type="button" aria-pressed="${selected}" aria-label="${escapeHtml(label)}">${media}<span class="card-scrim" aria-hidden="true"></span><span class="card-check" aria-hidden="true"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.5 5 5 10-11"/></svg></span></button>${info}${cardActions}</article>`;
  }).join("");
  // 追加页会重建整个网格；必须保存实际的滚动容器，而不是不可滚动的
  // .library-view 父元素，否则浏览器在清空子节点时会把 grid 的位置钳回顶部。
  const isAppendMode = animate && animateFrom > 0;
  const scrollContainer = els.assetGrid;
  const savedScrollTop = isAppendMode ? scrollContainer.scrollTop : null;

  els.assetGrid.innerHTML = `${cards}${state.nextCursor ? `<div class="asset-load-more"><button type="button" data-action="load-more">${escapeHtml(t("loadMore"))}</button></div><div class="infinite-scroll-sentinel" data-sentinel="true"></div>` : ""}`;

  setupMasonryLayout();
  // setupMasonryLayout() queues its final row-span measurement for the next
  // frame. Restore after that pass, once the replacement cards have restored
  // enough scroll height for the prior position to be valid again.
  if (savedScrollTop !== null) {
    requestAnimationFrame(() => {
      const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
      scrollContainer.scrollTop = Math.min(savedScrollTop, maxScrollTop);
    });
  }
  els.assetGrid.querySelectorAll(".asset-card-select").forEach((button) => {
    // A normal card press opens the current asset in the V2 detail surface.
    button.addEventListener("click", () => {
      const id = button.closest(".asset-card")?.dataset.id;
      if (!id) return;
      void selectAsset(id);
    });
    // 双击打开图片预览
    button.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      const id = button.closest(".asset-card")?.dataset.id;
      if (!id) return;
      openImagePreview(id, button);
    });
  });
  els.assetGrid.querySelectorAll(".card-quick-copy").forEach((button) => button.addEventListener("click", async (event) => { event.stopPropagation(); await runAction(async () => { await navigator.clipboard.writeText(button.dataset.copy || ""); showToast(t("copySuccess"), "success"); }); }));
  els.assetGrid.querySelectorAll(".card-favorite").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); void toggleFavorite(button.dataset.favId, event); }));
}

/** Routed through the state machine so a later re-render cannot resurrect the skeleton. */
function renderErrorState(error, requestId = null, request = null) {
  state.galleryStatus = "error";
  state.galleryError = error instanceof Error ? error : new Error(String(error || ""));
  renderGrid();
  updateViewTitle();
  setGalleryBusy(false, requestId, request);
}

async function selectAsset(id, shouldScroll = false) {
  if (!id) return;
  const originProjectId = state.project;
  const originAssetId = state.selectedId;
  if (!await confirmDetailNavigation(id)) return;
  // Phase 5B context guard：确认期间 Detail 选择已变化时安全取消，旧确认结果不操作新素材。
  if (originAssetId !== null && !isCurrentDetailSelection(originProjectId, originAssetId)) return;
  state.selectedId = id; state.detailAsset = null; state.versionHistory = null; state.recipeHistory = null; setDetailOpen(true); updateSelectedCard();
  if (shouldScroll) els.assetGrid.querySelector(`.asset-card[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function clearDetailSelection() {
  state.selectedId = null;
  state.detailAsset = null;
  state.versionHistory = null;
  state.recipeHistory = null;
}

async function confirmDetailNavigation(nextAssetId) {
  // Phase 5B：异步 Promise 语义——未 dirty 或目标即当前选中时直接放行，不打开 Dialog；
  // dirty 且目标不同时经全应用唯一 ConfirmDialog 确认（无第二套 discard 确认副本）。
  if (!state.detailDirty || nextAssetId === state.selectedId) return true;
  return requestConfirmation({
    title: t("discardChangesTitle"),
    description: t("discardChangesDescription"),
    confirmLabel: t("discardChangesAction"),
    tone: "danger",
    contextKey: `${state.project}:${state.selectedId}:discard-version`,
  });
}

function selectedAsset() {
  return state.assets.find((asset) => asset.id === state.selectedId)
    || (state.detailAsset?.id === state.selectedId ? state.detailAsset : null)
    || state.versionHistory?.versions?.find((asset) => asset.id === state.selectedId)
    || null;
}

function updateSelectedCard() { els.assetGrid?.querySelectorAll(".asset-card").forEach((card) => { const selected = card.dataset.id === state.selectedId; card.classList.toggle("selected", selected); card.querySelector(".asset-card-select")?.setAttribute("aria-pressed", String(selected)); }); }
function setDetailOpen(open) {
  const wasOpen = state.detailOpen;
  state.detailOpen = Boolean(open); els.appShell?.classList.toggle("details-open", state.detailOpen); document.body.classList.toggle("detail-open", state.detailOpen); els.detailPanel?.setAttribute("aria-hidden", String(!state.detailOpen));
  if (state.detailOpen) setMobileNavOpen(false);
  if (state.detailOpen) {
    if (!wasOpen) {
      const activeEl = document.activeElement;
      state.detailReturnFocus = (activeEl instanceof HTMLElement && activeEl.isConnected) ? activeEl : null;
    }
    renderDetail();
    // Focus moves only on the closed -> open transition: arrow-key gallery
    // navigation keeps calling setDetailOpen(true) while the drawer is already
    // open, and yanking focus into the drawer each time would break it.
    // Focus synchronously rather than in requestAnimationFrame, which never
    // runs while the window is hidden or frame-throttled.
    if (!wasOpen) els.detailPanel?.querySelector("#detailTitle")?.focus();
  } else {
    state.detailDirty = false;
    // Phase 4C：返回 Library / 关闭检视器时清理 Cowart 内联反馈（不持久化到磁盘）。
    state.cowartInsertFeedback = null;
    const returnEl = state.detailReturnFocus;
    state.detailReturnFocus = null;
    if (returnEl instanceof HTMLElement && returnEl.isConnected) returnEl.focus();
  }
}

// ===== Asset view（大图查看器，已提取至 asset-view.mjs，R1 批次 4）=====

function openImportModal() {
  state.modalReturnFocus = document.activeElement;
  clearImportErrors();
  setImportBusy(false);
  els.importModal?.classList.add("open");
  els.importModal?.setAttribute("aria-hidden", "false");
  // Focused synchronously: an animation frame never runs while the window is hidden.
  els.closeImportModal?.focus();
}
function closeImportModal() { announceGalleryStatus(""); els.importModal?.classList.remove("open"); els.importModal?.setAttribute("aria-hidden", "true"); if (state.modalReturnFocus instanceof HTMLElement) state.modalReturnFocus.focus(); state.modalReturnFocus = null; }
function openSettingsModal() {
  if (!els.settingsMenu || !els.settingsMenu.hidden) return;
  state.settingsReturnFocus = document.activeElement;
  els.settingsMenu.hidden = false;
  els.settingsToggle?.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => els.settingsMenu?.querySelector("[data-settings-close]")?.focus());
}
function closeSettingsModal({ restoreFocus = true } = {}) {
  if (!els.settingsMenu || els.settingsMenu.hidden) return;
  els.settingsMenu.hidden = true;
  els.settingsToggle?.setAttribute("aria-expanded", "false");
  if (restoreFocus && state.settingsReturnFocus instanceof HTMLElement && state.settingsReturnFocus.isConnected) state.settingsReturnFocus.focus();
  state.settingsReturnFocus = null;
}
function toggleSettingsModal() { if (els.settingsMenu?.hidden) openSettingsModal(); else closeSettingsModal(); }

const GROUP_COLORS = ["#6366f1", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#ec4899"];

function groupColorStorageKey() { return `mosa.group-colors.${state.project}`; }
function groupColorMap() {
  try {
    const parsed = JSON.parse(safeStorageGet(groupColorStorageKey()) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
function deterministicGroupColor(name) {
  let hash = 0;
  for (const character of String(name || "")) hash = ((hash << 5) - hash + character.codePointAt(0)) | 0;
  return GROUP_COLORS[Math.abs(hash) % GROUP_COLORS.length];
}
function colorForGroup(name) {
  const stored = groupColorMap()[name];
  return GROUP_COLORS.includes(stored) ? stored : deterministicGroupColor(name);
}
function saveGroupColor(name, color) {
  const colors = groupColorMap();
  colors[name] = GROUP_COLORS.includes(color) ? color : deterministicGroupColor(name);
  safeStorageSet(groupColorStorageKey(), JSON.stringify(colors));
}
function selectGroupColor(color) {
  if (!GROUP_COLORS.includes(color)) return;
  els.groupModal?.querySelectorAll("[data-group-color]").forEach((button) => {
    const selected = button.dataset.groupColor === color;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}
function selectedGroupColor() {
  return els.groupModal?.querySelector("[data-group-color][aria-pressed='true']")?.dataset.groupColor || GROUP_COLORS[0];
}
function refreshAccountSummary() {
  if (els.accountAssetCount) els.accountAssetCount.textContent = String(state.groups.total || state.assets.length || 0);
  if (els.accountCollectionCount) els.accountCollectionCount.textContent = String(state.groups.groups.length || 0);
}
function openAccountModal() {
  if (!els.accountModal || els.accountModal.classList.contains("open")) return;
  state.accountReturnFocus = document.activeElement;
  refreshAccountSummary();
  els.accountModal.classList.add("open");
  els.accountModal.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => els.closeAccountModal?.focus());
}
function closeAccountModal() {
  if (!els.accountModal?.classList.contains("open")) return;
  els.accountModal.classList.remove("open");
  els.accountModal.setAttribute("aria-hidden", "true");
  if (state.accountReturnFocus instanceof HTMLElement && state.accountReturnFocus.isConnected) state.accountReturnFocus.focus();
  state.accountReturnFocus = null;
}
function openGroupModal() {
  state.modalReturnFocus = document.activeElement;
  els.groupModal?.classList.add("open");
  els.groupModal?.setAttribute("aria-hidden", "false");
  if (els.groupNameInput) els.groupNameInput.value = "";
  selectGroupColor(GROUP_COLORS[0]);
  requestAnimationFrame(() => els.groupNameInput?.focus());
}
function closeGroupModal() { els.groupModal?.classList.remove("open"); els.groupModal?.setAttribute("aria-hidden", "true"); if (state.modalReturnFocus instanceof HTMLElement) state.modalReturnFocus.focus(); state.modalReturnFocus = null; }

function trapAccountModalFocus(event) {
  if (!els.accountModal?.classList.contains("open")) return;
  if (event.key === "Escape") { event.preventDefault(); closeAccountModal(); return; }
  if (event.key !== "Tab") return;
  const focusable = [...els.accountModal.querySelectorAll("button:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter((element) => !element.hasAttribute("hidden"));
  if (!focusable.length) return;
  const current = focusable.indexOf(document.activeElement);
  const next = event.shiftKey ? (current <= 0 ? focusable.length - 1 : current - 1) : (current === focusable.length - 1 ? 0 : current + 1);
  event.preventDefault();
  focusable[next].focus();
}

function trapImportModalFocus(event) {
  if (!els.importModal?.classList.contains("open")) return;
  if (event.key === "Escape") { event.preventDefault(); closeImportModal(); return; }
  if (event.key !== "Tab") return;
  const focusable = [...els.importModal.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter((element) => !element.hasAttribute("hidden"));
  if (!focusable.length) return; const current = focusable.indexOf(document.activeElement); const next = event.shiftKey ? (current <= 0 ? focusable.length - 1 : current - 1) : (current === focusable.length - 1 ? 0 : current + 1); event.preventDefault(); focusable[next].focus();
}

function trapSettingsModalFocus(event) {
  if (els.settingsMenu?.hidden) return;
  if (event.key === "Escape") { event.preventDefault(); closeSettingsModal(); return; }
  if (event.key !== "Tab") return;
  const focusable = [...els.settingsMenu.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter((element) => !element.hasAttribute("hidden"));
  if (!focusable.length) return;
  const current = focusable.indexOf(document.activeElement);
  const next = event.shiftKey ? (current <= 0 ? focusable.length - 1 : current - 1) : (current === focusable.length - 1 ? 0 : current + 1);
  event.preventDefault();
  focusable[next].focus();
}

function trapGroupModalFocus(event) {
  if (!els.groupModal?.classList.contains("open")) return;
  if (event.key === "Escape") { event.preventDefault(); closeGroupModal(); return; }
  if (event.key !== "Tab") return;
  const focusable = [...els.groupModal.querySelectorAll("button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter((element) => !element.hasAttribute("hidden"));
  if (!focusable.length) return; const current = focusable.indexOf(document.activeElement); const next = event.shiftKey ? (current <= 0 ? focusable.length - 1 : current - 1) : (current === focusable.length - 1 ? 0 : current + 1); event.preventDefault(); focusable[next].focus();
}

async function saveGroup() {
  await runAction(async () => {
    const name = els.groupNameInput?.value.trim() || "";
    if (!name) throw new Error(t("groupNameRequired"));
    const result = await apiFetch("/api/groups", { method: "POST", body: { projectId: state.project, name } });
    saveGroupColor(result.group.name, selectedGroupColor());
    closeGroupModal();
    await loadStats();
    showToast(`${t("groupCreated")}${result.group.name}`, "success");
    state.facets.group = result.group.name;
    state.nextCursor = null;
    clearDetailSelection();
    renderQuickFilters(); renderActiveFilters(); await loadAssets();
  });
}

function openImagePreview(id, trigger) {
  const asset = state.assets.find((item) => item.id === id)
    || state.versionHistory?.versions?.find((item) => item.id === id)
    || (state.detailAsset?.id === id ? state.detailAsset : null);
  if (!asset || !els.imagePreviewModal || !els.imagePreviewImage || !els.imagePreviewVideo || !els.imagePreviewTitle) return;
  state.imagePreviewId = asset.id;
  resetImageZoom();
  state.previewReturnFocus = trigger instanceof HTMLElement ? trigger : document.activeElement;
  els.imagePreviewTitle.textContent = asset.theme || asset.asset || asset.id;
  els.imagePreviewStage?.setAttribute("aria-label", `${t("imagePreviewStage")}: ${els.imagePreviewTitle.textContent}`);
  if (isVideoAsset(asset)) {
    els.imagePreviewImage.hidden = true;
    els.imagePreviewImage.removeAttribute("src");
    els.imagePreviewVideo.hidden = false;
    els.imagePreviewVideo.src = asset.image_url;
    els.imagePreviewModal.hidden = false;
    requestAnimationFrame(() => els.closeImagePreview?.focus());
    return;
  }
  els.imagePreviewVideo.pause();
  els.imagePreviewVideo.removeAttribute("src");
  els.imagePreviewVideo.hidden = true;
  els.imagePreviewImage.hidden = false;
  els.imagePreviewImage.style.removeProperty("width");
  els.imagePreviewImage.style.removeProperty("height");
  els.imagePreviewImage.src = asset.image_url;
  els.imagePreviewImage.alt = asset.theme || asset.asset || asset.id;
  els.imagePreviewModal.hidden = false;
  requestAnimationFrame(fitImagePreview);
  requestAnimationFrame(() => els.closeImagePreview?.focus());
}

function fitImagePreview() {
  const image = els.imagePreviewImage;
  const stage = els.imagePreviewStage;
  if (!state.imagePreviewId || !image?.naturalWidth || !image.naturalHeight || !stage) return;
  const styles = getComputedStyle(stage);
  const availableWidth = stage.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
  const availableHeight = stage.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom);
  const scale = Math.min(availableWidth / image.naturalWidth, availableHeight / image.naturalHeight);
  image.style.width = `${Math.floor(image.naturalWidth * scale)}px`;
  image.style.height = `${Math.floor(image.naturalHeight * scale)}px`;
  reconcileImagePreviewTransform();
}

function closeImagePreview() {
  if (!els.imagePreviewModal?.hidden) els.imagePreviewModal.hidden = true;
  els.imagePreviewImage?.removeAttribute("src");
  els.imagePreviewImage.hidden = false;
  els.imagePreviewVideo?.pause();
  els.imagePreviewVideo?.removeAttribute("src");
  els.imagePreviewVideo.hidden = true;
  state.imagePreviewId = null;
  resetImageZoom();
  els.imagePreviewImage?.style.removeProperty("width");
  els.imagePreviewImage?.style.removeProperty("height");
  els.imagePreviewStage?.classList.remove("zoomed", "dragging");
  els.imagePreviewStage?.setAttribute("aria-label", t("imagePreviewStage"));
  if (state.previewReturnFocus instanceof HTMLElement) state.previewReturnFocus.focus();
  state.previewReturnFocus = null;
}

function trapImagePreviewFocus(event) {
  if (els.imagePreviewModal?.hidden) return;
  if (event.key === "Escape") { event.preventDefault(); closeImagePreview(); return; }
  if (event.key !== "Tab") return;
  const focusable = [...els.imagePreviewModal.querySelectorAll("button:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter((element) => !element.hasAttribute("hidden"));
  if (!focusable.length) return;
  const current = focusable.indexOf(document.activeElement);
  const next = event.shiftKey ? (current <= 0 ? focusable.length - 1 : current - 1) : (current === focusable.length - 1 ? 0 : current + 1);
  event.preventDefault(); focusable[next].focus();
}

let detailRenderSequence = 0;
// Phase 4A：单栏检视器滚动策略——同素材重渲染（语言切换/后台刷新/收藏）保留滚动
// 位置；切换到另一素材（Viewer Previous/Next、画廊选择）随 innerHTML 重建自然回顶；
// Phase 4B 起版本切换由 selectDetailVersion 在重建后显式钳制恢复滚动位置。焦点原本
// 在面板内时焦点恢复优先（浏览器会把聚焦的 #detailTitle 滚入视野）。
let detailRenderedAssetId = null;

function renderDetail() {
  if (!els.detailPanel) return;
  const renderId = ++detailRenderSequence;
  const asset = selectedAsset();
  // Phase 4C：Cowart 内联反馈仅属当前 project + asset——切换素材/无选中时清理，
  // 同素材重绘（Bridge 轮询/收藏/语言切换）保留。
  if (state.cowartInsertFeedback && (!asset || state.cowartInsertFeedback.assetKey !== `${asset.project_id}\u0000${asset.id}`)) state.cowartInsertFeedback = null;
  // Re-rendering replaces the whole panel, so a focus that lived inside it
  // would fall back to <body>. Arrow-key gallery browsing re-renders on every
  // step; keep the keyboard anchored on the detail title instead.
  const hadPanelFocus = document.activeElement instanceof HTMLElement && els.detailPanel.contains(document.activeElement);
  const keepScrollTop = !hadPanelFocus && asset && detailRenderedAssetId === asset.id
    ? els.detailPanel.querySelector(".detail-inspector-scroll")?.scrollTop ?? null
    : null;
  state.detailDirty = false;
  if (!asset) { detailRenderedAssetId = null; els.detailPanel.innerHTML = `<div class="detail-empty"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg><p>${t(state.assets.length ? "noSelection" : "noAssets")}</p><span>${t(state.assets.length ? "noSelectionHint" : "noAssetsHint")}</span></div>`; return; }
  const cachedHistory = versionHistoryForAsset(asset);
  const cachedRecipeHistory = recipeHistoryForAsset(asset) || recipeHistoryFromAsset(asset);
  // Library v2 首屏把基础信息与收藏合为一个 Overview，避免旧版把收藏拆成独立区块。
  // 后续九个语义区块保持单列、无 tab、唯一纵向滚动容器。
  els.detailPanel.innerHTML = `<div class="detail-inspector"><div class="detail-inspector-header"><span>${t("assetInspector")}</span><button class="detail-close" type="button" data-action="close-detail" aria-label="${t("close")}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div><div class="detail-inspector-scroll">${detailFileSectionMarkup(asset)}${detailTagsSectionMarkup(asset)}${detailPromptSectionMarkup(asset)}${detailSourceSectionMarkup(asset)}${detailVersionSectionMarkup(asset, cachedHistory, cachedRecipeHistory)}${detailGroupSectionMarkup(asset)}${detailCowartSectionMarkup()}${detailNewVersionSectionMarkup()}${detailMoreSectionMarkup(asset)}</div></div>`;
  const scroller = els.detailPanel.querySelector(".detail-inspector-scroll");
  if (scroller && keepScrollTop !== null) scroller.scrollTop = keepScrollTop;
  scroller?.querySelector(".cowart-insert-slot")?.append(createCowartInsertControl(asset));
  updateCowartInsertControls();
  bindDetailEvents(asset, renderId);
  bindVersionPickerEvents();
  bindVersionHistoryEvents(cachedHistory);
  bindRecipeHistoryEvents(cachedRecipeHistory, asset);
  detailRenderedAssetId = asset.id;
  if (hadPanelFocus) els.detailPanel.querySelector("#detailTitle")?.focus();
  // Phase 3A：详情内容变化（版本切换/后台刷新/语言切换）时同步查看模式舞台主图。
  if (state.viewMode === "asset") renderAssetView();
  void loadVersionHistory(asset);
  void loadRecipeHistory(asset);
}

let versionHistoryRequestSequence = 0;
function setCowartInsertBusy(control, busy) {
  if (!control) return;
  const button = control.querySelector('[data-action="insert-cowart"]');
  const target = control.querySelector("[data-cowart-insert-target]");
  if (busy) control.setAttribute("aria-busy", "true");
  else control.removeAttribute("aria-busy");
  if (button) {
    button.disabled = busy || !state.cowartInsertAvailable;
    button.setAttribute("aria-disabled", String(button.disabled));
    button.textContent = busy ? t("insertingCowart") : t("insertCowart");
  }
  if (target) target.disabled = busy || !state.cowartInsertAvailable;
}
function renderCowartInsertStatus() {
  const status = els.detailPanel?.querySelector("[data-cowart-insert-status]");
  if (!status) return;
  const feedback = state.cowartInsertFeedback
    && state.cowartInsertFeedback.assetKey === `${state.project}\u0000${state.selectedId}`
    ? state.cowartInsertFeedback
    : null;
  status.dataset.type = feedback?.type || "";
  status.textContent = feedback?.message || "";
  status.hidden = !feedback;
}
function versionHistoryForAsset(asset) {
  const history = state.versionHistory;
  if (!history || history.project_id !== asset.project_id) return null;
  return history.versions?.some((version) => version.id === asset.id) ? history : null;
}
async function loadVersionHistory(asset) {
  const requestId = ++versionHistoryRequestSequence;
  const selectedKey = `${asset.project_id}\u0000${asset.id}`;
  try {
    const result = await apiFetch(`/api/assets/${encodeURIComponent(asset.project_id)}/${encodeURIComponent(asset.id)}/versions`);
    if (requestId !== versionHistoryRequestSequence || `${state.project}\u0000${state.selectedId}` !== selectedKey) return;
    state.versionHistory = result.history;
    renderVersionPickerRegion(result.history, asset.id);
    renderVersionHistoryRegion(result.history, asset.id);
  } catch (error) {
    if (requestId !== versionHistoryRequestSequence || `${state.project}\u0000${state.selectedId}` !== selectedKey) return;
    renderVersionPickerRegion(null, asset.id, error);
    renderVersionHistoryRegion(null, asset.id, error);
  }
}
function renderVersionPickerRegion(history, selectedId, error = null) {
  const region = els.detailPanel?.querySelector("[data-version-picker]");
  if (!region || state.selectedId !== selectedId) return;
  const asset = state.detailAsset?.id === selectedId
    ? state.detailAsset
    : history?.versions?.find((version) => version.id === selectedId) || null;
  if (!asset) return;
  const hadFocus = region.contains(document.activeElement);
  region.innerHTML = versionPickerMarkup(asset, history, error);
  bindVersionPickerEvents();
  if (hadFocus) region.querySelector("[data-version-select]")?.focus({ preventScroll: true });
}
function bindVersionPickerEvents() {
  const select = els.detailPanel?.querySelector("[data-version-select]");
  if (!select) return;
  select.addEventListener("change", () => selectDetailVersion(select.value));
}
function renderVersionHistoryRegion(history, selectedId, error = null) {
  const region = els.detailPanel?.querySelector("[data-version-history]");
  if (!region || state.selectedId !== selectedId) return;
  region.innerHTML = error
    ? `<p class="version-history-status error" role="status">${escapeHtml(t("versionLoadFailed"))}: ${escapeHtml(error.message)}</p>`
    : versionHistoryMarkup(history, selectedId);
  bindVersionHistoryEvents(history);
}
function bindVersionHistoryEvents(history) {
  if (!history) return;
  els.detailPanel?.querySelectorAll("[data-version-id]").forEach((button) => button.addEventListener("click", () => {
    selectDetailVersion(button.dataset.versionId);
  }));
}
async function selectDetailVersion(versionId, options = {}) {
  const focusSelect = options.focusSelect !== false;
  const target = state.versionHistory?.versions?.find((version) => version.id === versionId) || null;
  if (!target) { restoreVersionPickerValue(); return false; }
  if (target.id === state.selectedId) { restoreVersionPickerValue(); return true; }
  const originProjectId = state.project;
  const originAssetId = state.selectedId;
  if (!await confirmDetailNavigation(target.id)) { restoreVersionPickerValue(); return false; }
  // Phase 5B context guard：确认期间 Detail 选择已变化时恢复 select 显示值，不操作新素材。
  if (!isCurrentDetailSelection(originProjectId, originAssetId)) { restoreVersionPickerValue(); return false; }
  const previousScrollTop = els.detailPanel?.querySelector(".detail-inspector-scroll")?.scrollTop ?? null;
  state.selectedId = target.id;
  state.detailAsset = target;
  state.recipeHistory = null;
  updateSelectedCard();
  renderDetail();
  const scroller = els.detailPanel?.querySelector(".detail-inspector-scroll");
  if (scroller && previousScrollTop !== null) {
    scroller.scrollTop = Math.min(previousScrollTop, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
  }
  if (focusSelect) requestAnimationFrame(() => els.detailPanel?.querySelector("[data-version-select]")?.focus({ preventScroll: true }));
  return true;
}
function restoreVersionPickerValue() {
  const select = els.detailPanel?.querySelector("[data-version-select]");
  if (select && state.selectedId) select.value = state.selectedId;
}
let recipeHistoryRequestSequence = 0;
function recipeHistoryForAsset(asset) {
  const history = state.recipeHistory;
  return history?.project_id === asset.project_id && history?.asset_id === asset.id ? history : null;
}
function recipeHistoryFromAsset(asset) {
  if (!Array.isArray(asset.recipe_snapshots) || !asset.recipe_snapshots.length) return null;
  return {
    project_id: asset.project_id,
    asset_id: asset.id,
    active_snapshot_id: asset.active_recipe_snapshot_id || asset.recipe_snapshots.at(-1)?.snapshot_id,
    snapshots: asset.recipe_snapshots,
  };
}
async function loadRecipeHistory(asset) {
  const requestId = ++recipeHistoryRequestSequence;
  const selectedKey = `${asset.project_id}\u0000${asset.id}`;
  try {
    const result = await apiFetch(`/api/assets/${encodeURIComponent(asset.project_id)}/${encodeURIComponent(asset.id)}/recipes`);
    if (requestId !== recipeHistoryRequestSequence || `${state.project}\u0000${state.selectedId}` !== selectedKey) return;
    state.recipeHistory = result.history;
    renderRecipeHistoryRegion(result.history, asset);
  } catch (error) {
    if (requestId !== recipeHistoryRequestSequence || `${state.project}\u0000${state.selectedId}` !== selectedKey) return;
    renderRecipeHistoryRegion(null, asset, error);
  }
}
function renderRecipeHistoryRegion(history, asset, error = null) {
  const region = els.detailPanel?.querySelector("[data-recipe-history]");
  if (!region || !isCurrentDetailSelection(asset.project_id, asset.id)) return;
  region.innerHTML = error
    ? `<p class="recipe-history-status error" role="status">${escapeHtml(t("recipeSnapshotLoadFailed"))}: ${escapeHtml(error.message)}</p>`
    : recipeHistoryMarkup(history);
  bindRecipeHistoryEvents(history, asset);
  // The rights editor reads the active snapshot's references, and the panel is
  // built before this history arrives. Gallery rows deliberately omit recipe
  // relations, so without redrawing here the editor stays empty on first open
  // even when the asset has references.
  renderReferenceRightsRegion(asset);
}
function renderReferenceRightsRegion(asset) {
  const region = els.detailPanel?.querySelector("[data-reference-rights]");
  if (!region || !isCurrentDetailSelection(asset.project_id, asset.id)) return;
  const section = region.closest("[data-reference-rights-section]");
  const wasOpen = section?.open;
  region.innerHTML = referenceRightsMarkup(asset);
  if (section && wasOpen) section.open = true;
  bindReferenceRightsEvents(els.detailPanel, asset, detailRenderSequence);
}
function bindRecipeHistoryEvents(history, asset) {
  if (!history) return;
  els.detailPanel?.querySelectorAll("[data-recipe-snapshot-id]").forEach((button) => button.addEventListener("click", () => runAction(async () => {
    const snapshot = history.snapshots.find((item) => item.snapshot_id === button.dataset.recipeSnapshotId);
    if (!snapshot) return;
    await navigator.clipboard.writeText(regenerationInstruction(asset, snapshot));
    showToast(t("instructionCopied"), "success");
  })));
}


function bindDetailEvents(asset, renderId) {
  const panel = els.detailPanel;
  panel.querySelectorAll("[data-edit], [data-version-change], [data-recipe-change]").forEach((field) => {
    field.addEventListener("input", () => { state.detailDirty = true; });
    field.addEventListener("change", () => { state.detailDirty = true; });
  });
  panel.querySelectorAll("[data-composer-select]").forEach((select) => {
    select.addEventListener("change", () => { state.detailDirty = true; });
  });
  panel.querySelectorAll("[data-resolution]").forEach((button) => button.addEventListener("click", () => {
    panel.querySelectorAll("[data-resolution]").forEach((option) => {
      const selected = option === button;
      option.setAttribute("aria-pressed", String(selected));
    });
    state.detailDirty = true;
  }));
  panel.querySelector('[data-action="close-detail"]')?.addEventListener("click", () => { if (state.viewMode === "asset") returnToLibrary(); else setDetailOpen(false); });
  // Phase 4A 区块 2：Detail 内收藏——复用既有 toggleFavorite（同一收藏 API），不切换
  // 素材、不返回 Library；loadAssets 后 renderDetail 重渲染按 asset.favorite 重绘本按钮。
  panel.querySelector('[data-action="toggle-favorite"]')?.addEventListener("click", (event) => toggleFavorite(asset.id, event));
  panel.querySelector('[data-action="add-tag"]')?.addEventListener("click", () => openTagEditor(panel, asset, renderId));
  panel.querySelector('[data-action="copy-source"]')?.addEventListener("click", () => runAction(async () => { await navigator.clipboard.writeText(sourceCopyValue(asset.source)); showToast(t("originalPathCopied"), "success"); }));
  panel.querySelector('[data-action="view-generation-session"]')?.addEventListener("click", () => showRelatedGenerations(asset, "session"));
  panel.querySelector('[data-action="view-generation-batch"]')?.addEventListener("click", () => showRelatedGenerations(asset, "batch"));
  if (!isVideoAsset(asset)) {
    panel.querySelector(".detail-image")?.addEventListener("dblclick", (event) => openImagePreview(asset.id, event.currentTarget));
  }
  // Phase 4C：App 能力——「在 Finder 中显示」走 preload 注入的最小 IPC；成功提示不含
  // 本地绝对路径；失败为结构化错误提示。不重绘 Detail、不改变滚动与焦点。
  panel.querySelector('[data-action="show-in-finder"]')?.addEventListener("click", () => runAction(async () => {
    const result = await window.electronAPI.showItemInFolder(asset.image_path);
    if (result?.ok) { showToast(t("shownInFinder"), "success"); return; }
    throw new Error(t("showInFinderFailed"));
  }));
  panel.querySelector("[data-cowart-insert-target]")?.addEventListener("change", (event) => {
    state.cowartInsertTargetId = event.target.value;
    safeStorageSet("mosa.cowart-insert-target", state.cowartInsertTargetId);
  });
  panel.querySelector('[data-action="insert-cowart"]')?.addEventListener("click", () => runAction(async () => {
    const originProjectId = asset.project_id;
    const originAssetId = asset.id;
    const assetKey = `${originProjectId}\u0000${originAssetId}`;
    // Phase 4C：targetId 只取集中式 helper 的合法目标——没有合法目标绝不发请求；
    // 一次点击一次 POST（Busy 期间按钮 disabled + request generation 双保险）。
    const targetId = cowartInsertTargetIdFor(asset);
    if (!targetId || !state.cowartInsertAvailable) return;
    const requestId = ++cowartInsertRequestSequence;
    const control = panel.querySelector(".cowart-insert-control");
    const button = panel.querySelector('[data-action="insert-cowart"]');
    const hadFocus = document.activeElement === button;
    state.cowartInsertFeedback = null;
    renderCowartInsertStatus();
    setCowartInsertBusy(control, true);
    showToast(t("insertingCowart"));
    // 请求竞态 guard：request generation + 当前 Detail project/id 双校验，晚到的旧素材
    // 响应（成功或失败）不得污染新素材的反馈。
    const isCurrentResponse = () => requestId === cowartInsertRequestSequence && isCurrentDetailSelection(originProjectId, originAssetId);
    const isConnectedControl = () => isCurrentResponse() && Boolean(control?.isConnected);
    try {
      const result = await apiFetch(`/api/assets/${encodeURIComponent(originProjectId)}/${encodeURIComponent(originAssetId)}/insert-cowart`, { method: "POST", body: { placement: "right", targetId } });
      if (!isCurrentResponse()) return;
      const canvas = result.canvas || {};
      const message = t("insertedCowart", { page: canvas.pageId || "Cowart", x: Math.round(canvas.bounds?.x || 0), y: Math.round(canvas.bounds?.y || 0) });
      state.cowartInsertFeedback = { assetKey, type: "success", message };
      showToast(message, "success");
      // 不调用 loadAssets、不改变 Viewer Sequence / Return Snapshot / selectedAsset；
      // 只刷新桥接状态。签名未变时 Detail 不重建，反馈经 renderCowartInsertStatus 落回。
      await refreshBridgeStatus();
      if (isCurrentResponse()) renderCowartInsertStatus();
    } catch (error) {
      if (!isCurrentResponse()) return;
      state.cowartInsertFeedback = { assetKey, type: "error", message: error.message };
      renderCowartInsertStatus();
      throw error;
    } finally {
      // 只恢复仍连接且仍属当前素材的控件；Busy 期间 disabled 使焦点掉到 body 时，
      // 完成后把焦点恢复到同一个插入按钮（preventScroll 不打乱 Inspector scrollTop）。
      if (isConnectedControl()) {
        setCowartInsertBusy(control, false);
        if (hadFocus) button?.focus({ preventScroll: true });
      }
    }
  }));
  panel.querySelector('[data-action="copy-prompt"]')?.addEventListener("click", () => runAction(async () => { await navigator.clipboard.writeText(asset.prompt || ""); showToast(t("copySuccess"), "success"); }));
  panel.querySelector('[data-action="copy-instruction"]')?.addEventListener("click", () => runAction(async () => { const instruction = String(asset.source?.user_message || asset.business_fields?.user_message || "").trim(); await navigator.clipboard.writeText(instruction); showToast(t("copySuccess"), "success"); }));
  panel.querySelector('[data-action="copy-path"]')?.addEventListener("click", () => runAction(async () => { await navigator.clipboard.writeText(asset.image_path); showToast(t("pathCopied"), "success"); }));
  panel.querySelector('[data-action="regenerate"]')?.addEventListener("click", (event) => {
    const trigger = event.currentTarget;
    runAction(async () => {
      const snapshot = activeRecipeSnapshot(asset);
      const blocked = (snapshot?.references || []).filter((reference) => referenceRightsTone(reference) === "restricted");
      if (blocked.length) {
        // Phase 5B：blocked>0 才打开确认（warning tone，不用红色）；blocked=0 直接执行既有复制。
        const confirmed = await requestConfirmation({
          title: t("restrictedRegenerateTitle"),
          description: t("restrictedRegenerateDescription", { count: blocked.length }),
          confirmLabel: t("restrictedRegenerateAction"),
          tone: "warning",
          returnFocus: trigger,
          contextKey: `${asset.project_id}:${asset.id}:restricted-regenerate`,
        });
        // Cancel：不写剪贴板；context guard：旧确认结果不操作新素材。
        if (!confirmed || !isCurrentDetailSelection(asset.project_id, asset.id)) return;
      }
      await navigator.clipboard.writeText(regenerationInstruction(asset, snapshot));
      showToast(t("instructionCopied"), "success");
    });
  });
  panel.querySelector('[data-action="archive-asset"]')?.addEventListener("click", (event) => {
    const trigger = event.currentTarget;
    runAction(async () => {
      // Phase 5B：单素材归档确认（danger tone）——确认阶段不关闭 Detail、不清 selectedId。
      const confirmed = await requestConfirmation({
        title: t("archiveOneTitle"),
        description: t("archiveOneDescription"),
        confirmLabel: t("archiveAction"),
        tone: "danger",
        returnFocus: trigger,
        contextKey: `${asset.project_id}:${asset.id}:archive-asset`,
      });
      if (!confirmed) return; // Cancel：保持当前素材、Viewer、位置和 Inspector
      // Context guard：确认后重新检查操作入口对应素材仍是当前 Detail 选择。
      if (!isCurrentDetailSelection(asset.project_id, asset.id)) return;
      await apiFetch(`/api/assets/${encodeURIComponent(asset.project_id)}/${encodeURIComponent(asset.id)}/archive`, { method: "POST" });
      showToast(t("archived"), "success");
      setDetailOpen(false);
      state.selectedId = null;
      await loadStats();
      await loadAssets();
    });
  });
  panel.querySelectorAll('[data-edit="rating"] button').forEach((button) => button.addEventListener("click", () => { state.detailDirty = true; const value = Number(button.dataset.val); panel.querySelectorAll('[data-edit="rating"] button').forEach((star) => { const on = Number(star.dataset.val) <= value; star.classList.toggle("on", on); star.textContent = on ? "★" : "☆"; }); }));
  panel.querySelector('[data-action="save-recipe"]')?.addEventListener("click", () => runAction(async () => {
    const originProjectId = asset.project_id;
    const originAssetId = asset.id;
    setInspectorSaveActionsBusy(panel, true, "save-recipe");
    try {
      // 配方保存只读 [data-recipe-change]；说明为空时省略 recipe_change_summary 字段
      //（服务端缺省 "Recipe updated"），不硬编码英文、不创建新版本。
      const changeSummary = panel.querySelector("[data-recipe-change]")?.value.trim() || "";
      const result = await apiFetch(`/api/assets/${encodeURIComponent(originProjectId)}/${encodeURIComponent(originAssetId)}`, {
        method: "PATCH",
        body: { ...readRecipeDraft(panel), tags: uniqueTags([...(asset.tags || []), ...derivePromptTags(readRecipeDraft(panel))]), ...(changeSummary ? { recipe_change_summary: changeSummary } : {}) },
      });
      showToast(t("recipeSaved"), "success");
      if (!isCurrentDetailAction(renderId, originProjectId, originAssetId)) return;
      state.selectedId = result.asset.id;
      state.detailAsset = result.asset;
      state.versionHistory = null;
      state.recipeHistory = null;
      state.detailDirty = false;
      await loadStats();
      if (!isCurrentDetailSelection(result.asset.project_id, result.asset.id)) return;
      await loadAssets();
      if (isCurrentDetailSelection(result.asset.project_id, result.asset.id)) requestAnimationFrame(() => els.detailPanel?.querySelector("#detailTitle")?.focus());
    } finally {
      if (renderId === detailRenderSequence) setInspectorSaveActionsBusy(panel, false, "save-recipe");
    }
  }));
  panel.querySelector('[data-action="save-version"]')?.addEventListener("click", () => runAction(async () => {
    const versionChange = panel.querySelector("[data-version-change]")?.value.trim() || "";
    if (!versionChange) throw new Error(t("versionChangeRequired"));
    const originProjectId = asset.project_id;
    const originAssetId = asset.id;
    setInspectorSaveActionsBusy(panel, true, "save-version");
    try {
      const result = await apiFetch(`/api/assets/${encodeURIComponent(originProjectId)}/${encodeURIComponent(originAssetId)}/versions`, {
        method: "POST",
        body: {
          ...readRecipeDraft(panel),
          model: panel.querySelector('[data-composer-select="model"]')?.value || "auto",
          ratio: panel.querySelector('[data-composer-select="ratio"]')?.value || "4:3",
          resolution: panel.querySelector('[data-resolution][aria-pressed="true"]')?.dataset.resolution || "1K",
          version_change: versionChange,
        },
      });
      showToast(t("versionSaved"), "success");
      if (!isCurrentDetailAction(renderId, originProjectId, originAssetId)) return;
      state.selectedId = result.asset.id;
      state.detailAsset = result.asset;
      state.versionHistory = null;
      state.recipeHistory = null;
      state.detailDirty = false;
      await loadStats();
      if (!isCurrentDetailSelection(result.asset.project_id, result.asset.id)) return;
      await loadAssets();
      if (isCurrentDetailSelection(result.asset.project_id, result.asset.id)) requestAnimationFrame(() => els.detailPanel?.querySelector("#detailTitle")?.focus());
    } finally {
      if (renderId === detailRenderSequence) setInspectorSaveActionsBusy(panel, false, "save-version");
    }
  }));

  bindReferenceRightsEvents(panel, asset, renderId);
}

const USE_PERMISSION_CYCLE = { undeclared: "allowed", allowed: "forbidden", forbidden: "undeclared" };

function bindReferenceRightsEvents(panel, asset, renderId) {
  const section = panel.querySelector("[data-reference-rights-section]");
  if (!section) return;

  // The badge is the only place the problem is visible, so it has to be the way
  // into fixing it rather than a notice with no action attached.
  panel.addEventListener("click", (event) => {
    if (!event.target.closest('[data-action="open-reference-rights"]')) return;
    // Phase 4A：单栏布局无 tab 可切——目标 disclosure 已在来源区内，直接展开。
    section.open = true;
    section.scrollIntoView({ block: "nearest" });
    section.querySelector("select")?.focus();
  });

  // A reference can point at an asset that was since deleted. Without this the
  // thumbnail 404s and leaves an empty box; the strict CSP rules out an inline
  // onerror attribute, so the fallback is bound here.
  section.querySelectorAll(".reference-thumb img").forEach((image) => image.addEventListener("error", () => {
    const initials = escapeHtml(String(image.dataset.referenceLabel || "?").slice(0, 2).toUpperCase());
    image.replaceWith(Object.assign(document.createElement("span"), { className: "reference-thumb-empty", ariaHidden: "true", textContent: initials }));
  }));

  section.querySelectorAll("[data-reference-use]").forEach((chip) => chip.addEventListener("click", () => {
    const current = ["allowed", "forbidden", "undeclared"].find((value) => chip.classList.contains(value)) || "undeclared";
    const next = USE_PERMISSION_CYCLE[current];
    chip.classList.remove(current);
    chip.classList.add(next);
    chip.lastElementChild?.remove();
    if (next !== "undeclared") chip.insertAdjacentHTML("beforeend", `<span aria-hidden="true">${next === "allowed" ? "✓" : "✕"}</span>`);
    chip.setAttribute("aria-label", `${t(`use_${chip.dataset.referenceUse}`)} — ${t(`permission_${next}`)}`);
    state.detailDirty = true;
  }));

  section.querySelectorAll("[data-reference-field]").forEach((field) => field.addEventListener("input", () => {
    state.detailDirty = true;
    refreshReferenceRowState(section, field.dataset.referenceIndex);
  }));

  section.querySelector('[data-action="save-reference-rights"]')?.addEventListener("click", () => runAction(async () => {
    const originProjectId = asset.project_id;
    const originAssetId = asset.id;
    const result = await apiFetch(`/api/assets/${encodeURIComponent(originProjectId)}/${encodeURIComponent(originAssetId)}`, {
      method: "PATCH",
      body: { references: readReferenceRightsDraft(section, asset) },
    });
    showToast(t("rightsSaved"), "success");
    if (!isCurrentDetailAction(renderId, originProjectId, originAssetId)) return;
    state.detailAsset = result.asset;
    state.recipeHistory = null;
    state.detailDirty = false;
    await loadAssets();
  }));
}

/** Keep one row's status chip in step with its own selects while editing. */
function refreshReferenceRowState(section, index) {
  const badge = section.querySelector(`[data-reference-state="${index}"]`);
  if (!badge) return;
  const rights = {};
  section.querySelectorAll(`[data-reference-index="${index}"][data-reference-field]`).forEach((field) => {
    rights[field.dataset.referenceField] = field.value;
  });
  const tone = referenceRightsTone({ rights });
  badge.className = `recipe-reference-rights ${tone}`;
  badge.textContent = t(`rightsState_${tone}`);
}

/**
 * Rebuild the reference list from the editor.
 *
 * `asset_id`, `sha256`, `role`, `scope`, and `applied` are copied from the
 * snapshot untouched: they are the digest material, so altering one here would
 * turn a rights annotation into a different recipe.
 */
function readReferenceRightsDraft(section, asset) {
  const references = activeRecipeSnapshot(asset)?.references || [];
  return references.map((reference, index) => {
    const rights = { ...reference.rights };
    section.querySelectorAll(`[data-reference-index="${index}"][data-reference-field]`).forEach((field) => {
      rights[field.dataset.referenceField] = field.value;
    });
    const allowed = [];
    const forbidden = [];
    section.querySelectorAll(`[data-reference-index="${index}"][data-reference-use]`).forEach((chip) => {
      if (chip.classList.contains("allowed")) allowed.push(chip.dataset.referenceUse);
      else if (chip.classList.contains("forbidden")) forbidden.push(chip.dataset.referenceUse);
    });
    return {
      asset_id: reference.asset_id,
      sha256: reference.sha256,
      role: reference.role,
      scope: reference.scope,
      applied: reference.applied,
      allowed_uses: allowed,
      forbidden_uses: forbidden,
      rights,
    };
  });
}

const REFERENCE_USES = ["identity", "subject", "world", "space", "composition", "lighting", "wardrobe", "color", "style", "prop"];
const RIGHTS_FIELDS = [
  ["copyright", ["unknown", "owned", "licensed", "third-party"]],
  ["portrait_consent", ["unknown", "granted", "not-required", "denied"]],
  ["redistribution", ["unknown", "allowed", "forbidden"]],
];

/**
 * Build the reference rights editor from the active snapshot.
 *
 * Snapshot references are the normalised copy, so they always carry the rights
 * fields; `asset.references` is whatever the caller last wrote. Editing here
 * writes the whole list back, which is digest-inert and therefore refreshes the
 * existing snapshot instead of creating a version.
 */
function referenceRightsMarkup(asset) {
  const references = activeRecipeSnapshot(asset)?.references || [];
  if (!references.length) return `<p class="empty-copy">${t("noReferences")}</p>`;
  const rows = references.map((reference, index) => {
    const linked = state.assets.find((item) => item.id === reference.asset_id);
    const thumbnail = reference.attachment_url || linked?.thumbnail_url || linked?.image_url;
    const label = reference.asset_id || `${t("referenceHash")} ${String(reference.sha256 || "").slice(0, 8)}`;
    const media = thumbnail
      ? `<img src="${escapeHtml(thumbnail)}" alt="" loading="lazy" data-reference-label="${escapeHtml(label)}" />`
      : `<span class="reference-thumb-empty" aria-hidden="true">${escapeHtml(String(label).slice(0, 2).toUpperCase())}</span>`;
    const selects = RIGHTS_FIELDS.map(([field, values]) => `<label class="field"><span>${t(`rights_${field}`)}</span><select data-reference-index="${index}" data-reference-field="${field}">${values.map((value) => `<option value="${value}"${(reference.rights?.[field] || "unknown") === value ? " selected" : ""}>${t(`rightsValue_${value}`)}</option>`).join("")}</select></label>`).join("");
    const chips = REFERENCE_USES.map((use) => {
      const permission = reference.forbidden_uses?.includes(use) ? "forbidden" : reference.allowed_uses?.includes(use) ? "allowed" : "undeclared";
      const mark = permission === "allowed" ? "✓" : permission === "forbidden" ? "✕" : "";
      return `<button type="button" class="use-chip ${permission}" data-reference-index="${index}" data-reference-use="${use}" aria-label="${escapeHtml(`${t(`use_${use}`)} — ${t(`permission_${permission}`)}`)}">${escapeHtml(t(`use_${use}`))}${mark ? `<span aria-hidden="true">${mark}</span>` : ""}</button>`;
    }).join("");
    return `<li class="reference-row" data-reference-row="${index}"><div class="reference-head"><span class="reference-thumb">${media}</span><span class="reference-name"><strong>${escapeHtml(label)}</strong>${reference.role ? `<em>${escapeHtml(reference.role)}</em>` : ""}</span><span class="recipe-reference-rights ${referenceRightsTone(reference)}" data-reference-state="${index}">${escapeHtml(t(`rightsState_${referenceRightsTone(reference)}`))}</span></div><div class="reference-fields">${selects}<label class="field"><span>${t("rights_attribution")}</span><input data-reference-index="${index}" data-reference-field="attribution" value="${escapeHtml(reference.rights?.attribution || "")}" placeholder="${escapeHtml(t("attributionPlaceholder"))}" /></label></div><p class="reference-uses-hint">${t("useChipHint")}</p><div class="use-chips">${chips}</div></li>`;
  }).join("");
  // Phase 4A：Cowart 是检视器唯一实心主操作——深层次级 disclosure 内的保存一律次级。
  return `<ol class="reference-list">${rows}</ol><div class="recipe-save-actions"><button class="recipe-save-btn secondary" type="button" data-action="save-reference-rights">${t("saveRights")}</button></div>`;
}

/** Single reference status, mirroring lib/reference-rights.mjs precedence. */
function referenceRightsTone(reference) {
  const rights = reference?.rights || {};
  if (rights.portrait_consent === "denied" || rights.redistribution === "forbidden") return "restricted";
  if ([rights.copyright, rights.portrait_consent, rights.redistribution].some((value) => !value || value === "unknown")) return "unresolved";
  return "cleared";
}

function activeRecipeSnapshot(asset) {
  const history = recipeHistoryForAsset(asset) || recipeHistoryFromAsset(asset);
  return history?.snapshots?.find((snapshot) => snapshot.snapshot_id === history.active_snapshot_id)
    || history?.snapshots?.at(-1)
    || null;
}

function regenerationInstruction(asset, snapshot) {
  const recipe = snapshot || {
    effective_prompt: asset.prompt,
    user_prompt: asset.user_prompt || asset.source?.user_prompt || asset.business_fields?.user_prompt,
    negative_prompt: asset.negative_prompt || asset.business_fields?.negative_prompt,
    prompt_status: asset.source?.prompt_status || asset.business_fields?.prompt_status,
    generation_tool: asset.source?.generation_tool || asset.business_fields?.generation_tool,
    model: asset.source?.model || asset.business_fields?.model,
    provider: asset.source?.provider || asset.business_fields?.provider,
    skill: asset.skill,
    style: asset.style,
    ratio: asset.ratio,
    theme: asset.theme,
    references: asset.references || asset.business_fields?.references || [],
    provenance: {},
  };
  const provenance = recipe.provenance || {};
  const source = Object.fromEntries(Object.entries({
    generation_tool: recipe.generation_tool,
    model: recipe.model,
    provider: recipe.provider,
    task_id: provenance.task_id,
    session_id: provenance.session_id,
    generation_call_id: provenance.generation_call_id,
    source_recipe_snapshot_id: recipe.snapshot_id,
  }).filter(([, value]) => value));
  return [
    t("generatedInstruction"),
    recipe.snapshot_id ? `source recipe snapshot: ${recipe.snapshot_id}` : "",
    "",
    "tool: asset_version_create",
    `projectId: ${JSON.stringify(asset.project_id)}`,
    `assetId: ${JSON.stringify(asset.id)}`,
    "imagePath: <path returned by image generation>",
    "version_change: <describe the generated result>",
    `prompt: ${JSON.stringify(recipe.effective_prompt || "")}`,
    `user_prompt: ${JSON.stringify(recipe.user_prompt || "")}`,
    `negative_prompt: ${JSON.stringify(recipe.negative_prompt || "")}`,
    `references: ${JSON.stringify(recipe.references || [])}`,
    `skill: ${JSON.stringify(recipe.skill || "")}`,
    `style: ${JSON.stringify(recipe.style || "")}`,
    `ratio: ${JSON.stringify(recipe.ratio || "")}`,
    `theme: ${JSON.stringify(recipe.theme || "")}`,
    `group: ${JSON.stringify(asset.group || "")}`,
    `category: ${JSON.stringify(asset.category || "")}`,
    `business_fields: ${JSON.stringify(asset.business_fields || {})}`,
    `source: ${JSON.stringify(source)}`,
  ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join("\n");
}

function openTagEditor(panel, asset, renderId) {
  const section = panel.querySelector('[data-inspector-section="tags"]');
  const list = section?.querySelector("[data-tags-list]");
  const addButton = section?.querySelector('[data-action="add-tag"]');
  if (!section || !list || !addButton || section.querySelector("[data-tag-editor]")) return;
  const editor = document.createElement("form");
  editor.className = "detail-tag-editor";
  editor.dataset.tagEditor = "true";
  editor.innerHTML = `<input type="text" maxlength="32" placeholder="${escapeHtml(t("tagInputPlaceholder"))}" aria-label="${escapeHtml(t("tagInputLabel"))}" /><button class="action-btn secondary" type="submit">${escapeHtml(t("saveTag"))}</button>`;
  addButton.replaceWith(editor);
  const input = editor.querySelector("input");
  input?.focus();
  editor.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = input?.value.trim() || "";
    if (!value) { input?.focus(); return; }
    runAction(async () => {
      const tags = uniqueTags([...assetTags(asset), value]);
      const result = await apiFetch(`/api/assets/${encodeURIComponent(asset.project_id)}/${encodeURIComponent(asset.id)}`, { method: "PATCH", body: { tags } });
      if (!isCurrentDetailAction(renderId, asset.project_id, asset.id)) return;
      state.detailAsset = result.asset;
      const index = state.assets.findIndex((item) => item.id === asset.id);
      if (index >= 0) state.assets[index] = result.asset;
      showToast(t("tagSaved"), "success");
      renderDetail();
    });
  });
}

function readRecipeDraft(panel) {
  const businessText = panel.querySelector('[data-edit="business_fields"]').value;
  let businessFields = {};
  try {
    businessFields = businessText.trim() ? JSON.parse(businessText) : {};
  } catch {
    throw new Error(t("invalidJson"));
  }
  return {
    prompt: panel.querySelector('[data-edit="prompt"]').value,
    skill: panel.querySelector('[data-edit="skill"]').value,
    style: panel.querySelector('[data-edit="style"]').value,
    ratio: panel.querySelector('[data-edit="ratio"]').value,
    theme: panel.querySelector('[data-edit="theme"]').value,
    group: panel.querySelector('[data-edit="group"]').value,
    category: panel.querySelector('[data-edit="category"]').value,
    rating: panel.querySelectorAll('[data-edit="rating"] button.on').length,
    business_fields: businessFields,
  };
}

function setInspectorSaveActionsBusy(panel, busy, activeAction) {
  panel.querySelectorAll(".recipe-save-btn").forEach((button) => { button.disabled = busy; });
  panel.querySelectorAll('input[data-edit], textarea[data-edit], select[data-edit], [data-version-change], [data-recipe-change], [data-edit="rating"] button').forEach((field) => { field.disabled = busy; });
  const activeButton = panel.querySelector(`[data-action="${activeAction}"]`);
  if (!activeButton?.isConnected) return;
  activeButton.textContent = busy
    ? t(activeAction === "save-version" ? "savingVersion" : "saving")
    : t(activeAction === "save-version" ? "saveAsVersion" : "saveRecipe");
}

function isCurrentDetailAction(renderId, projectId, assetId) {
  return renderId === detailRenderSequence && isCurrentDetailSelection(projectId, assetId);
}

function isCurrentDetailSelection(projectId, assetId) {
  return state.project === projectId && state.selectedId === assetId;
}

function updateCowartInsertControls() {
  const button = els.detailPanel?.querySelector('[data-action="insert-cowart"]');
  const target = els.detailPanel?.querySelector("[data-cowart-insert-target]");
  if (!button) return;
  // Busy 期间 disabled/文案由 setCowartInsertBusy 独占管理——Bridge 轮询触发的可用性
  // 同步不得提前重新启用插入中的控件。
  if (button.closest(".cowart-insert-control")?.getAttribute("aria-busy") === "true") return;
  button.disabled = !state.cowartInsertAvailable;
  button.setAttribute("aria-disabled", String(button.disabled));
  button.title = state.cowartInsertAvailable ? t("insertCowart") : t("cowartInsertUnavailable");
  if (target) target.disabled = !state.cowartInsertAvailable;
}

function setStatus(value, stateName = "neutral") {
  persistentStatus = { value, stateName };
  if (!statusAnnouncementActive) writeStatusText(value);
  // The visible label collapses to its dot in a narrow workspace bar, so the text
  // is also carried as a tooltip. #statusText keeps announcing it either way.
  if (els.bridgeStatus) { els.bridgeStatus.dataset.state = stateName; els.bridgeStatus.title = value; }
  if (els.bridgeStatusLabel) els.bridgeStatusLabel.textContent = value;
}
async function runAction(action) { try { await action(); } catch (error) { showToast(error.message, "error"); } }

// bootstrap：所有顶层工厂（confirmDialog/toastManager/bridgeStatusPoller 等）初始化
// 完成后才启动，避免同步 init 期间引用尚未求值的 const（TDZ）。
init();
