import translations from "./i18n.mjs";
import { createBridgeStatusPoller } from "./bridge-status-poller.js";
const SORT_ORDERS = ["newest", "oldest", "name"];
const SOURCE_FACETS = { codex: "codex-generated", cowart: "cowart-generated", grok: "grok-generated" };
const SCOPES = ["all", "favorite", "recent"];
const FACET_KEYS = ["source", "group", "category", "style"];
const SIDEBAR_GROUP_LIMIT = 5;

function normalizeSort(value) {
  return SORT_ORDERS.includes(String(value || "")) ? String(value) : "newest";
}

const GALLERY_DENSITIES = ["image", "info"];
const CARD_TITLE_MAX = 52;
// Declared up here because `init()` runs at module scope and paints the skeleton
// before the first request; a `const` further down would still be in its
// temporal dead zone and abort start-up.
const SKELETON_TILE_COUNT = 12;
const STATUS_ANNOUNCEMENT_DURATION = 3000;
const LIVE_REGION_WRITE_DELAY = 32;
let statusAnnouncementTimer = null;
let statusTextWriteTimer = null;
let statusAnnouncementSequence = 0;
let statusAnnouncementActive = false;
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

function normalizeDensity(value) {
  return GALLERY_DENSITIES.includes(String(value || "")) ? String(value) : "image";
}

// ===== Phase 5A / F-14：共享锚定浮层 manager（Filter / Settings / Language 唯一基础设施）=====
// 三套锚定浮层共用同一个 vanilla helper：打开/关闭、锚点定位与 viewport 碰撞（翻转/钳制）、
// 唯一一套外部点击、Escape 分层（child 优先）、resize 重定位、return focus、aria-expanded 同步
// 与 hidden 状态。状态模型为 root/child 引用而非单一布尔：Filter 与 Settings 是互斥 root 浮层；
// Language 是 Settings 的 child——打开 Language 不关 Settings，Escape 先关 child。
// 无第三方定位库、不依赖 CSS Anchor Positioning、无轮询/watchdog；定位一律使用 CSS 像素。
const ANCHORED_OVERLAY_VIEWPORT_PADDING = 12; // 三浮层统一 viewport 安全距离
const ANCHORED_OVERLAY_TRIGGER_GAP = 8;       // 浮层与触发器的统一间距

function createAnchoredOverlayManager() {
  const overlays = new Map(); // id -> config（panel/trigger 惰性 getter，兼容 Settings DOM 重建）
  let rootId = null;
  let childId = null;

  const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
  const configOf = (id) => overlays.get(id) ?? null;
  const panelOf = (id) => configOf(id)?.getPanel?.() ?? null;
  const triggerOf = (id) => configOf(id)?.getTrigger?.() ?? null;
  const isOpen = (id) => { const panel = panelOf(id); return Boolean(panel && panel.isConnected && !panel.hidden); };
  const insideOverlay = (id, target) => {
    if (!(target instanceof Node)) return false;
    const panel = panelOf(id);
    const trigger = triggerOf(id);
    return Boolean((panel && panel.contains(target)) || (trigger && trigger.contains(target)));
  };

  function syncTriggerExpanded(id, expanded) {
    triggerOf(id)?.setAttribute("aria-expanded", String(expanded));
  }

  function focusTarget(id) {
    const target = configOf(id)?.focusOnOpen?.();
    if (target instanceof HTMLElement && target.isConnected) target.focus();
  }

  function restoreFocus(id) {
    const target = configOf(id)?.returnFocus?.();
    if (target instanceof HTMLElement && target.isConnected) target.focus();
  }

  // 统一定位公式：placement 决定初始方位，空间不足时水平翻转/垂直翻转，最终钳制在
  // viewportPadding 之内；hidden panel 不参与计算；resize 后经同一函数重定位。
  function position(id) {
    const config = configOf(id);
    const panel = panelOf(id);
    const trigger = triggerOf(id);
    if (!config || !panel || panel.hidden || !trigger) return;
    const anchor = trigger.getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = ANCHORED_OVERLAY_VIEWPORT_PADDING;
    const gap = ANCHORED_OVERLAY_TRIGGER_GAP;
    const clampLeft = (value) => clamp(value, pad, Math.max(pad, vw - width - pad));
    const clampTop = (value) => clamp(value, pad, Math.max(pad, vh - height - pad));
    let top;
    let left;
    if (config.placement === "bottom-end") {
      left = clampLeft(anchor.right - width);
      top = anchor.bottom + gap;
      if (top + height > vh - pad) top = clampTop(anchor.top - gap - height); // 下方不足：向上翻转/钳制
    } else if (config.placement === "right-start") {
      top = clampTop(anchor.top);
      left = anchor.right + gap;
      if (left + width > vw - pad) left = Math.max(pad, anchor.left - gap - width); // 右侧不足：向左翻转
    } else if (config.placement === "left-start") {
      top = clampTop(anchor.top);
      left = anchor.left - gap - width;
      if (left < pad) left = clampLeft(anchor.right + gap); // 左侧不足：向右翻转
    } else { // bottom-start（设置菜单：下方通常无空间，碰撞公式翻转为向上展开）
      left = clampLeft(anchor.left);
      top = anchor.bottom + gap;
      if (top + height > vh - pad) top = clampTop(anchor.top - gap - height);
    }
    top = clampTop(top);
    panel.style.top = `${Math.round(top)}px`;
    panel.style.left = `${Math.round(left)}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    if (config.maxHeight) panel.style.maxHeight = `${Math.round(Math.min(config.maxHeight, vh - top - pad))}px`;
  }

  function open(id) {
    const config = configOf(id);
    if (!config || isOpen(id)) return;
    const panel = panelOf(id);
    if (!panel) return;
    if (config.kind === "root") {
      if (childId) close(childId, "parent-closed");
      if (rootId && rootId !== id) close(rootId, "sibling-opened"); // root 浮层互斥
      rootId = id;
    } else {
      if (!rootId) return; // child 浮层不得脱离 root 存在
      if (childId && childId !== id) close(childId, "sibling-opened");
      childId = id;
    }
    panel.hidden = false;
    syncTriggerExpanded(id, true);
    position(id);
    focusTarget(id);
  }

  function close(id, reason = "escape") {
    const config = configOf(id);
    if (!config) return;
    if (config.kind === "root") {
      // Escape child-first：Language 打开时先关 Language，不穿透到 Settings/Viewer。
      if (childId && reason === "escape" && isOpen(childId)) { close(childId, "escape"); return; }
      if (childId) close(childId, "parent-closed"); // 关闭 root 必须同时清理 child
      if (rootId === id) rootId = null;
    } else if (childId === id) {
      childId = null;
    }
    const panel = panelOf(id);
    if (!panel) return;
    panel.hidden = true;
    syncTriggerExpanded(id, false);
    // outside-pointer 不抢焦点（让被点目标自然获得焦点）；selection 的焦点由业务路径接管。
    if (reason === "escape" || reason === "trigger-toggle") restoreFocus(id);
  }

  return {
    register(config) { overlays.set(config.id, config); },
    idForPanel(panel) { for (const [id, config] of overlays) if (config.getPanel?.() === panel) return id; return null; },
    isOpen,
    open,
    close,
    toggle(id) { if (isOpen(id)) close(id, "trigger-toggle"); else open(id); },
    position,
    repositionOpen() { if (rootId) position(rootId); if (childId) position(childId); },
    // 唯一一套外部点击路由：child 内无动作；root 内 child 外只关 child；之外先 child 后 root。
    handleOutsidePointer(target) {
      // 重建期间断开的旧节点不算外部点击：语言选择会触发 Settings DOM 重建，
      // 被点 locale 按钮随即脱离文档；真实的外部点击目标必然仍连接在文档中。
      if (!(target instanceof Node) || !target.isConnected) return;
      if (childId && insideOverlay(childId, target)) return;
      if (rootId && insideOverlay(rootId, target)) { if (childId) close(childId, "outside-pointer"); return; }
      if (childId) close(childId, "outside-pointer");
      if (rootId) close(rootId, "outside-pointer");
    },
    // 唯一一套 Escape 路由（由 setupKeyboardShortcuts 的优先级链调用）。
    handleEscape() {
      if (childId && isOpen(childId)) { close(childId, "escape"); return true; }
      if (rootId && isOpen(rootId)) { close(rootId, "escape"); return true; }
      return false;
    },
    containsTarget(target) {
      for (const id of [rootId, childId]) if (id && insideOverlay(id, target)) return true;
      return false;
    },
    // Settings DOM 重建（语言切换）后：引用经 getter 惰性刷新，只把状态对齐到新 DOM。
    refreshAfterRebuild() {
      if (childId && !isOpen(childId)) childId = null;
      if (rootId && !isOpen(rootId)) rootId = null;
    },
    openRootId: () => rootId,
    openChildId: () => childId,
  };
}

const anchoredOverlayManager = createAnchoredOverlayManager();

/**
 * Cards used to expose the whole prompt as their accessible name, which a screen
 * reader read out in full for every tile. The label is now a short title plus
 * source and date; the complete prompt stays in the detail panel.
 */
function cardShortTitle(asset = {}) {
  const raw = String(asset.theme || asset.asset || asset.id || "").replace(/\s+/g, " ").trim();
  if (raw.length <= CARD_TITLE_MAX) return raw;
  const clipped = raw.slice(0, CARD_TITLE_MAX);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > CARD_TITLE_MAX * 0.6 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

const SOURCE_LABEL_KEYS = {
  "codex-generated": "sourceCodex",
  "cowart-generated": "sourceCowart",
  "grok-generated": "sourceGrok",
  "web-chatgpt": "sourceWebChatgpt",
  "local-file": "sourceManual",
};

function assetSourceLabel(asset = {}) {
  const type = String(asset.source?.type || asset.sourceType || "");
  return SOURCE_LABEL_KEYS[type] ? t(SOURCE_LABEL_KEYS[type]) : (type || t("sourceUnknown"));
}

/**
 * Machine-generated facet values such as `black-white-minimal-concept` are hard
 * to scan in a long list. Only lowercase ASCII slugs are reworded; anything else
 * (hand-written collection names, CJK, mixed case) is shown exactly as stored,
 * and the stored value is always what gets sent back to the API.
 */
function humanizeFacetValue(value) {
  const raw = String(value ?? "");
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(raw)) return raw;
  return raw.split(/[-_]/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

const preference = safeStorageGet("mosa.ui-language") || "system";
const state = {
  project: "default", projects: [], cowartCanvases: [], assets: [], pageTotal: 0, nextCursor: null, loadedPageCount: 0, selectedId: null, detailAsset: null, versionHistory: null, recipeHistory: null, detailOpen: false, detailDirty: false, detailReturnFocus: null, imagePreviewId: null, previewReturnFocus: null, query: "",
  scope: "all", facets: { source: "", group: "", category: "", style: "" }, sort: normalizeSort(safeStorageGet("mosa.asset-sort")), facetQuery: "",
  groups: { total: 0, favorites: 0, recent: 0, codex: 0, cowart: 0, groups: [], categories: [], styles: [], styleTotal: 0 }, cowartInsertAvailable: false, cowartInsertTargetId: safeStorageGet("mosa.cowart-insert-target") || "mosa", cowartInsertFeedback: null,
  galleryStatus: "loading", galleryError: null, galleryDensity: normalizeDensity(safeStorageGet("mosa.gallery-density")),
  libraryPath: "", codexImagesDir: "", supportedMediaExtensions: [], importSaving: false, modalReturnFocus: null, languagePreference: preference, locale: resolveLocale(preference),
  batchMode: false, batchSaving: false, selectedIds: new Set(), dragCounter: 0,
  darkMode: safeStorageGet("mosa-dark-mode") === "true", diagnosticsExpanded: false,
  imageZoom: 1, imagePanX: 0, imagePanY: 0, imageDragging: false,
  // Phase 3A / D4：专用大图查看模式最小状态——viewMode 二值（library/asset）+ 进入时的
  // 画廊返回快照。不复刻搜索/筛选/排序状态、不深拷贝 state、无第二套 selectedAsset、无平行 Router。
  viewMode: "library", libraryReturnSnapshot: null,
};

const els = {
  searchInput: document.querySelector("#searchInput"), quickFilters: document.querySelector("#quickFilters"),
  filterToggle: document.querySelector("#filterToggle"), filterPanel: document.querySelector("#filterPanel"), filterDot: document.querySelector("#filterDot"), clearFiltersBtn: document.querySelector("#clearFiltersBtn"), sourceFilters: document.querySelector("#sourceFilters"), groupList: document.querySelector("#groupList"), categoryList: document.querySelector("#categoryList"), styleList: document.querySelector("#styleList"),
  activeFilters: document.querySelector("#activeFilters"), sortSelect: document.querySelector("#sortSelect"), facetSearchInput: document.querySelector("#facetSearchInput"), styleTruncated: document.querySelector("#styleTruncated"), themeToggle: document.querySelector("#themeToggle"),
  settingsToggle: document.querySelector("#settingsToggle"), settingsMenu: document.querySelector("#settingsMenu"), addGroupBtn: document.querySelector("#addGroupBtn"), sidebarGroupList: document.querySelector("#sidebarGroupList"), newAssetTopBtn: document.querySelector("#newAssetTopBtn"), importModal: document.querySelector("#importModal"), closeImportModal: document.querySelector("#closeImportModal"), cancelImportBtn: document.querySelector("#cancelImportBtn"), groupModal: document.querySelector("#groupModal"), closeGroupModal: document.querySelector("#closeGroupModal"), cancelGroupBtn: document.querySelector("#cancelGroupBtn"), saveGroupBtn: document.querySelector("#saveGroupBtn"), groupNameInput: document.querySelector("#groupNameInput"), imagePreviewModal: document.querySelector("#imagePreviewModal"), imagePreviewStage: document.querySelector("#imagePreviewStage"), imagePreviewImage: document.querySelector("#imagePreviewImage"), imagePreviewVideo: document.querySelector("#imagePreviewVideo"), imagePreviewTitle: document.querySelector("#imagePreviewTitle"), closeImagePreview: document.querySelector("#closeImagePreview"), imagePathInput: document.querySelector("#imagePathInput"), codexSourceHint: document.querySelector("#codexSourceHint"), importFormatList: document.querySelector("#importFormatList"), importPathExample: document.querySelector("#importPathExample"), imagePathError: document.querySelector("#imagePathError"), businessFieldsError: document.querySelector("#businessFieldsError"), importAdvanced: document.querySelector("#importAdvanced"), promptInput: document.querySelector("#promptInput"), skillInput: document.querySelector("#skillInput"), styleInput: document.querySelector("#styleInput"), ratioInput: document.querySelector("#ratioInput"), themeInput: document.querySelector("#themeInput"), groupInput: document.querySelector("#groupInput"), categoryInput: document.querySelector("#categoryInput"), businessInput: document.querySelector("#businessInput"), saveAssetBtn: document.querySelector("#saveAssetBtn"),
  viewTitle: document.querySelector("#viewTitle"), assetCount: document.querySelector("#assetCount"), statusText: document.querySelector("#statusText"), bridgeStatus: document.querySelector("#bridgeStatus"), bridgeStatusLabel: document.querySelector("#bridgeStatusLabel"), bridgeStatusMeta: document.querySelector("#bridgeStatusMeta"), appShell: document.querySelector("#appShell"), assetGrid: document.querySelector("#assetGrid"), detailPanel: document.querySelector("#detailPanel"), toastContainer: document.querySelector("#toastContainer"), toastErrorContainer: document.querySelector("#toastErrorContainer")
};

// ===== New element references =====
Object.assign(els, {
  dragOverlay: document.querySelector("#dragOverlay"),
  batchBar: document.querySelector("#batchBar"),
  batchSelectAll: document.querySelector("#batchSelectAll"),
  batchCount: document.querySelector("#batchCount"),
  batchFavorite: document.querySelector("#batchFavorite"),
  batchArchive: document.querySelector("#batchArchive"),
  batchCancel: document.querySelector("#batchCancel"),
  batchToggle: document.querySelector("#batchToggle"),
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
  // Filter Panel：root 浮层，非模态 dialog 语义；打开聚焦 facet 搜索（缺失时第一个筛选控件）。
  anchoredOverlayManager.register({
    id: "filter", kind: "root", placement: "bottom-end", maxHeight: 580,
    getPanel: () => els.filterPanel,
    getTrigger: () => els.filterToggle,
    focusOnOpen: () => els.facetSearchInput || els.filterPanel?.querySelector("button, input, select") || null,
    returnFocus: () => els.filterToggle,
  });
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

// ===== Batch Operations =====
function setBatchMode(active) {
  state.batchMode = Boolean(active);
  state.selectedIds.clear();
  if (els.assetGrid) els.assetGrid.classList.toggle("batch-active", state.batchMode);
  updateBatchUI();
  renderGrid();
}

function toggleBatchMode() {
  if (state.batchSaving) return;
  setBatchMode(!state.batchMode);
}

function toggleAssetSelection(id, event) {
  if (event) event.stopPropagation();
  if (!state.batchMode) return;
  if (state.selectedIds.has(id)) state.selectedIds.delete(id); else state.selectedIds.add(id);
  updateBatchUI(); updateSelectedCard();
}
function selectAllAssets() {
  if (state.selectedIds.size === state.assets.length) state.selectedIds.clear();
  else state.assets.forEach((a) => state.selectedIds.add(a.id));
  updateBatchUI(); updateSelectedCard();
}
function updateBatchUI() {
  const selectedCount = state.selectedIds.size;
  if (els.batchBar) els.batchBar.hidden = !state.batchMode;
  if (els.batchToggle) els.batchToggle.setAttribute("aria-pressed", String(state.batchMode));
  if (els.batchCount) els.batchCount.textContent = t("batchSelected", { count: selectedCount });
  if (els.batchSelectAll) {
    els.batchSelectAll.textContent = selectedCount === state.assets.length ? t("deselectAll") : t("selectAll");
    els.batchSelectAll.disabled = state.batchSaving || state.assets.length === 0;
  }
  for (const button of [els.batchFavorite, els.batchArchive, els.batchCancel]) {
    if (button) button.disabled = state.batchSaving || (button !== els.batchCancel && selectedCount === 0);
  }
}

function setBatchBusy(busy) {
  state.batchSaving = Boolean(busy);
  updateBatchUI();
}

async function runBatchOperation(action, successKey, ids = null) {
  // Phase 5B：ids 允许调用方传入确认打开前捕获的快照（批量归档）；缺省仍读当前
  // 选中集合（收藏等路径），行为不变。
  const assetIds = ids ? [...ids] : [...state.selectedIds];
  if (!assetIds.length || state.batchSaving) return;
  setBatchBusy(true);
  try {
    const result = await api("/api/assets/batch", {
      method: "POST",
      body: { action, projectId: state.project, assetIds },
    });
    if (!Array.isArray(result.results) || result.results.length !== assetIds.length) {
      throw new Error(t("batchOperationIncomplete"));
    }
    if (assetIds.includes(state.selectedId)) clearDetailSelection();
    state.selectedIds.clear();
    state.batchMode = false;
    if (els.assetGrid) els.assetGrid.classList.remove("batch-active");
    showToast(t(successKey, { count: result.results.length }), "success");
    await loadStats();
    await loadAssets();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setBatchBusy(false);
  }
}

async function batchFavorite() {
  await runBatchOperation("favorite", "batchFavoriteDone");
}

async function batchArchive() {
  const count = state.selectedIds.size;
  if (!count) return;
  // Phase 5B：确认打开时刻捕获选中 ID 快照——确认后只处理快照中的 ID，Modal 打开
  // 期间选中集合变化不会导致标题与实际操作数量错位；Cancel 后 selection 保持。
  const snapshotIds = [...state.selectedIds];
  const confirmed = await requestConfirmation({
    title: t("archiveManyTitle", { count }),
    description: t("archiveManyDescription", { count }),
    confirmLabel: t("archiveAction"),
    tone: "danger",
    contextKey: `${state.project}:batch-archive`,
  });
  if (!confirmed) return; // Cancel：不调用归档 API，不产生业务副作用
  await runBatchOperation("archive", "batchArchiveDone", snapshotIds);
}
async function toggleFavorite(id, event) {
  if (event) event.stopPropagation();
  try { await api(`/api/assets/${encodeURIComponent(state.project)}/${encodeURIComponent(id)}/favorite`, { method: "POST" }); showToast(t("favAdded"), "success"); await loadAssets(); } catch (error) { showToast(error.message, "error"); }
}

// ===== Keyboard Shortcuts =====
function setupKeyboardShortcuts() {
  document.addEventListener("keydown", (event) => {
    // Phase 5B：ConfirmDialog 打开时页面背景不接收任何键盘操作（Escape 由
    // trapConfirmDialogFocus 消费；不新增第二套全局 Escape 路由）。
    if (confirmDialogState.pending) return;
    if (event.target.matches("input, textarea, select")) {
      // Phase 5A：处于打开的锚定浮层内部（如筛选面板 facet 搜索）时，Escape 仍须能关闭
      // 宿主浮层；其余快捷键保持输入守卫，打字不触发全局快捷键。
      if (event.key !== "Escape" || !anchoredOverlayManager.containsTarget(event.target)) return;
    }
    if (event.key === "/" && state.viewMode === "library" && !els.importModal?.classList.contains("open") && !els.groupModal?.classList.contains("open")) { event.preventDefault(); els.searchInput?.focus(); return; }
    if (event.key === "Escape") {
      // Phase 3A 运行时修复：bindEvents 先行注册的 Modal 焦点陷阱已消费本次 Escape
      // （preventDefault）时，本链不得再继续向下穿透（否则会关 Modal 同时退出查看模式）。
      if (event.defaultPrevented) return;
      if (state.batchMode) { toggleBatchMode(); event.preventDefault(); return; }
      if (!els.imagePreviewModal?.hidden) { closeImagePreview(); event.preventDefault(); return; }
      if (els.importModal?.classList.contains("open")) { closeImportModal(); event.preventDefault(); return; }
      if (els.groupModal?.classList.contains("open")) { closeGroupModal(); event.preventDefault(); return; }
      // Phase 3A：Escape 先关最上层浮层（筛选面板/设置菜单），再退出查看模式——不得穿透。
      // Phase 5A：closePanel 统一路由到 anchoredOverlayManager（Settings 打开 Language 时 child 先关）。
      if (!els.filterPanel?.hidden) { closePanel(els.filterPanel, els.filterToggle); event.preventDefault(); return; }
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
      && els.filterPanel?.hidden
      && els.settingsMenu?.hidden
      && !event.target.closest?.("[contenteditable]")) {
      if (event.target.matches("input, textarea, select")) return; // 输入控件一律不触发 Viewer 快捷键
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
    if (event.key === "b" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); toggleBatchMode(); }
  });
}

// ===== Image Zoom & Pan =====
const IMAGE_PREVIEW_ZOOM_STEP = 0.25;
const IMAGE_PREVIEW_PAN_STEP = 48;
const IMAGE_PREVIEW_MIN_SCALE = 0.5;
const IMAGE_PREVIEW_MAX_SCALE = 5;
const IMAGE_PREVIEW_SCALE_EPSILON = 1e-6;
const IMAGE_PREVIEW_POINTER_EPSILON = 2;
const imagePreviewActivePointers = new Map();
let imagePreviewPanSession = null;
let imagePreviewPinchSession = null;
let imagePreviewSuppressStageClick = false;

function imagePreviewStageSize() {
  const stage = els.imagePreviewStage;
  if (!stage) return { width: 0, height: 0 };
  const styles = getComputedStyle(stage);
  return {
    width: Math.max(0, stage.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight)),
    height: Math.max(0, stage.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom)),
  };
}

function imagePreviewBaseSize() {
  const image = els.imagePreviewImage;
  if (!image) return { width: 0, height: 0 };
  return {
    width: image.offsetWidth || Number.parseFloat(image.style.width) || 0,
    height: image.offsetHeight || Number.parseFloat(image.style.height) || 0,
  };
}

function clampImagePreviewPan(offset, renderedSize, stageSize) {
  if (!(renderedSize > stageSize)) return 0;
  const limit = (renderedSize - stageSize) / 2;
  return Math.min(limit, Math.max(-limit, offset));
}

function clampImagePreviewOffsets(scale, offsetX, offsetY) {
  const base = imagePreviewBaseSize();
  const stage = imagePreviewStageSize();
  return {
    offsetX: clampImagePreviewPan(offsetX, base.width * scale, stage.width),
    offsetY: clampImagePreviewPan(offsetY, base.height * scale, stage.height),
  };
}

function imagePreviewCanTransform() {
  return Boolean(state.imagePreviewId && els.imagePreviewImage && !els.imagePreviewImage.hidden && imagePreviewBaseSize().width > 0);
}

function announceImagePreviewZoom() {
  announceGalleryStatus(t("zoomAnnouncement", { percent: Math.round(state.imageZoom * 100) }));
}

function resetImageZoom({ announce = false } = {}) {
  clearImagePreviewPointerSession();
  const changed = Math.abs(state.imageZoom - 1) > IMAGE_PREVIEW_SCALE_EPSILON || state.imagePanX !== 0 || state.imagePanY !== 0;
  state.imageZoom = 1;
  state.imagePanX = 0;
  state.imagePanY = 0;
  state.imageDragging = false;
  applyImageTransform();
  if (announce && changed) announceImagePreviewZoom();
  return changed;
}

function applyImageTransform() {
  const img = els.imagePreviewImage;
  if (!img) return;
  img.style.transform = `translate(${state.imagePanX}px, ${state.imagePanY}px) scale(${state.imageZoom})`;
  if (els.imagePreviewStage) {
    const base = imagePreviewBaseSize();
    const stage = imagePreviewStageSize();
    const pannable = state.imageZoom > 1 || base.width * state.imageZoom > stage.width || base.height * state.imageZoom > stage.height;
    els.imagePreviewStage.classList.toggle("zoomed", pannable);
    if (!pannable) els.imagePreviewStage.classList.remove("dragging");
  }
}

function zoomImage(delta, { announce = true } = {}) {
  if (!imagePreviewCanTransform()) return false;
  const nextScale = Math.max(IMAGE_PREVIEW_MIN_SCALE, Math.min(IMAGE_PREVIEW_MAX_SCALE, state.imageZoom + delta));
  if (Math.abs(nextScale - state.imageZoom) <= IMAGE_PREVIEW_SCALE_EPSILON) return false;
  state.imageZoom = nextScale;
  if (Math.abs(state.imageZoom - 1) <= IMAGE_PREVIEW_SCALE_EPSILON) {
    state.imageZoom = 1;
    state.imagePanX = 0;
    state.imagePanY = 0;
  } else {
    const offsets = clampImagePreviewOffsets(state.imageZoom, state.imagePanX, state.imagePanY);
    state.imagePanX = offsets.offsetX;
    state.imagePanY = offsets.offsetY;
  }
  applyImageTransform();
  if (announce) announceImagePreviewZoom();
  return true;
}

function panImagePreview(deltaX, deltaY, { announce = true } = {}) {
  if (!imagePreviewCanTransform() || state.imageZoom <= 1) return false;
  const offsets = clampImagePreviewOffsets(state.imageZoom, state.imagePanX + deltaX, state.imagePanY + deltaY);
  if (Math.abs(offsets.offsetX - state.imagePanX) <= IMAGE_PREVIEW_SCALE_EPSILON
    && Math.abs(offsets.offsetY - state.imagePanY) <= IMAGE_PREVIEW_SCALE_EPSILON) return false;
  state.imagePanX = offsets.offsetX;
  state.imagePanY = offsets.offsetY;
  applyImageTransform();
  if (announce) {
    const direction = Math.abs(deltaX) >= Math.abs(deltaY)
      ? (deltaX < 0 ? "imagePreviewPanLeft" : "imagePreviewPanRight")
      : (deltaY < 0 ? "imagePreviewPanUp" : "imagePreviewPanDown");
    announceGalleryStatus(t(direction));
  }
  return true;
}

function imagePreviewStagePointer(clientX, clientY) {
  const stage = els.imagePreviewStage;
  if (!stage) return { x: 0, y: 0 };
  const rect = stage.getBoundingClientRect();
  const styles = getComputedStyle(stage);
  const paddingLeft = parseFloat(styles.paddingLeft) || 0;
  const paddingTop = parseFloat(styles.paddingTop) || 0;
  const size = imagePreviewStageSize();
  return {
    x: clientX - rect.left - paddingLeft - size.width / 2,
    y: clientY - rect.top - paddingTop - size.height / 2,
  };
}

function imagePreviewPointerIsPannable() {
  if (!imagePreviewCanTransform()) return false;
  const base = imagePreviewBaseSize();
  const stage = imagePreviewStageSize();
  return base.width * state.imageZoom > stage.width + IMAGE_PREVIEW_SCALE_EPSILON
    || base.height * state.imageZoom > stage.height + IMAGE_PREVIEW_SCALE_EPSILON;
}

function zoomImageAtPoint(targetScale, pointerX, pointerY, currentScale, currentPanX, currentPanY) {
  const scale = currentScale > 0 ? currentScale : 1;
  const anchorX = (pointerX - currentPanX) / scale;
  const anchorY = (pointerY - currentPanY) / scale;
  return { offsetX: pointerX - anchorX * targetScale, offsetY: pointerY - anchorY * targetScale };
}

function imagePreviewPointerEntries(ids = null) {
  const entries = [...imagePreviewActivePointers.entries()];
  return ids ? entries.filter(([pointerId]) => ids.includes(pointerId)) : entries;
}

function imagePreviewTouchPointers() {
  return imagePreviewPointerEntries().filter(([, pointer]) => pointer.pointerType === "touch");
}

function imagePreviewPointerMidpoint(entries) {
  const first = imagePreviewStagePointer(entries[0][1].clientX, entries[0][1].clientY);
  const second = imagePreviewStagePointer(entries[1][1].clientX, entries[1][1].clientY);
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function imagePreviewPointerDistance(entries) {
  const first = entries[0][1];
  const second = entries[1][1];
  return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
}

function captureImagePreviewPointer(pointerId) {
  const stage = els.imagePreviewStage;
  if (!stage?.setPointerCapture) return false;
  try {
    stage.setPointerCapture(pointerId);
    return stage.hasPointerCapture?.(pointerId) ?? true;
  } catch {
    return false;
  }
}

function releaseImagePreviewPointer(pointerId) {
  const stage = els.imagePreviewStage;
  if (!stage?.releasePointerCapture) return;
  try {
    if (!stage.hasPointerCapture || stage.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId);
  } catch {
    // Pointer capture can already be gone after a native cancel.
  }
}

function startImagePreviewPan(pointer) {
  if (!imagePreviewPointerIsPannable()) return;
  imagePreviewPanSession = {
    pointerId: pointer.pointerId,
    startClientX: pointer.clientX,
    startClientY: pointer.clientY,
    startPanX: state.imagePanX,
    startPanY: state.imagePanY,
    moved: false,
  };
  state.imageDragging = true;
  els.imagePreviewStage?.classList.add("dragging");
}

function startImagePreviewPinch() {
  const entries = imagePreviewTouchPointers();
  if (entries.length < 2) return false;
  const distance = imagePreviewPointerDistance(entries);
  if (!(distance > IMAGE_PREVIEW_SCALE_EPSILON)) return false;
  imagePreviewPanSession = null;
  state.imageDragging = false;
  els.imagePreviewStage?.classList.remove("dragging");
  imagePreviewPinchSession = {
    pointerIds: entries.slice(0, 2).map(([pointerId]) => pointerId),
    startDistance: distance,
    startScale: state.imageZoom,
    startPanX: state.imagePanX,
    startPanY: state.imagePanY,
    startMidpoint: imagePreviewPointerMidpoint(entries),
    changed: false,
  };
  return true;
}

function updateImagePreviewPinch() {
  const session = imagePreviewPinchSession;
  if (!session) return false;
  const entries = imagePreviewPointerEntries(session.pointerIds);
  if (entries.length !== 2) return false;
  const distance = imagePreviewPointerDistance(entries);
  if (!(distance > IMAGE_PREVIEW_SCALE_EPSILON) || !(session.startDistance > IMAGE_PREVIEW_SCALE_EPSILON)) return false;
  const targetScale = Math.max(IMAGE_PREVIEW_MIN_SCALE, Math.min(IMAGE_PREVIEW_MAX_SCALE, session.startScale * (distance / session.startDistance)));
  const midpoint = imagePreviewPointerMidpoint(entries);
  const zoomed = zoomImageAtPoint(targetScale, session.startMidpoint.x, session.startMidpoint.y, session.startScale, session.startPanX, session.startPanY);
  const midpointDelta = { x: midpoint.x - session.startMidpoint.x, y: midpoint.y - session.startMidpoint.y };
  const offsets = clampImagePreviewOffsets(targetScale, zoomed.offsetX + midpointDelta.x, zoomed.offsetY + midpointDelta.y);
  const changed = Math.abs(targetScale - state.imageZoom) > IMAGE_PREVIEW_SCALE_EPSILON
    || Math.abs(offsets.offsetX - state.imagePanX) > IMAGE_PREVIEW_SCALE_EPSILON
    || Math.abs(offsets.offsetY - state.imagePanY) > IMAGE_PREVIEW_SCALE_EPSILON;
  state.imageZoom = targetScale;
  state.imagePanX = offsets.offsetX;
  state.imagePanY = offsets.offsetY;
  applyImageTransform();
  session.changed ||= changed;
  return changed;
}

function finishImagePreviewPinch({ announce = false } = {}) {
  const session = imagePreviewPinchSession;
  imagePreviewPinchSession = null;
  if (announce && session?.changed) announceImagePreviewZoom();
  return Boolean(session?.changed);
}

function clearImagePreviewPointerSession({ release = true } = {}) {
  if (release) for (const pointerId of imagePreviewActivePointers.keys()) releaseImagePreviewPointer(pointerId);
  imagePreviewActivePointers.clear();
  imagePreviewPanSession = null;
  imagePreviewPinchSession = null;
  state.imageDragging = false;
  els.imagePreviewStage?.classList.remove("dragging");
}

function handleImagePreviewPointerDown(event) {
  if (!state.imagePreviewId || !imagePreviewCanTransform()) return;
  if (event.pointerType === "mouse" && (!event.isPrimary || event.button !== 0)) return;
  if (event.target.closest?.("video")) return;
  if (imagePreviewActivePointers.has(event.pointerId)) return;
  const pointer = {
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    clientX: event.clientX,
    clientY: event.clientY,
  };
  imagePreviewActivePointers.set(event.pointerId, pointer);
  captureImagePreviewPointer(event.pointerId);
  if (imagePreviewTouchPointers().length >= 2) {
    startImagePreviewPinch();
    return;
  }
  if (event.pointerType === "mouse" || imagePreviewPointerIsPannable()) startImagePreviewPan(pointer);
}

function handleImagePreviewPointerMove(event) {
  const pointer = imagePreviewActivePointers.get(event.pointerId);
  if (!pointer) return;
  pointer.clientX = event.clientX;
  pointer.clientY = event.clientY;
  if (!imagePreviewPinchSession && imagePreviewTouchPointers().length >= 2) startImagePreviewPinch();
  if (imagePreviewPinchSession) {
    event.preventDefault();
    updateImagePreviewPinch();
    imagePreviewSuppressStageClick = true;
    return;
  }
  const session = imagePreviewPanSession;
  if (!session || session.pointerId !== event.pointerId) return;
  event.preventDefault();
  if (Math.hypot(event.clientX - session.startClientX, event.clientY - session.startClientY) > IMAGE_PREVIEW_POINTER_EPSILON) {
    session.moved = true;
    imagePreviewSuppressStageClick = true;
  }
  const offsets = clampImagePreviewOffsets(state.imageZoom, session.startPanX + event.clientX - session.startClientX, session.startPanY + event.clientY - session.startClientY);
  state.imagePanX = offsets.offsetX;
  state.imagePanY = offsets.offsetY;
  applyImageTransform();
}

function transitionImagePreviewPinchToPan() {
  const [entry] = imagePreviewTouchPointers();
  if (!entry) return;
  if (imagePreviewPointerIsPannable()) startImagePreviewPan(entry[1]);
}

function handleImagePreviewPointerEnd(event) {
  const pointer = imagePreviewActivePointers.get(event.pointerId);
  if (!pointer) return;
  pointer.clientX = event.clientX;
  pointer.clientY = event.clientY;
  releaseImagePreviewPointer(event.pointerId);
  if (event.type === "pointercancel") {
    clearImagePreviewPointerSession({ release: false });
    return;
  }
  const endingPinch = imagePreviewPinchSession?.pointerIds.includes(event.pointerId);
  imagePreviewActivePointers.delete(event.pointerId);
  if (endingPinch) {
    finishImagePreviewPinch({ announce: true });
    imagePreviewPanSession = null;
    state.imageDragging = false;
    transitionImagePreviewPinchToPan();
  } else if (imagePreviewPanSession?.pointerId === event.pointerId) {
    imagePreviewPanSession = null;
    state.imageDragging = false;
    els.imagePreviewStage?.classList.remove("dragging");
  }
  if (!imagePreviewActivePointers.size) clearImagePreviewPointerSession({ release: false });
}

function setupImageZoomPan() {
  const stage = els.imagePreviewStage; if (!stage) return;
  stage.addEventListener("wheel", (e) => { if (state.imagePreviewId) { e.preventDefault(); zoomImage(e.deltaY < 0 ? IMAGE_PREVIEW_ZOOM_STEP : -IMAGE_PREVIEW_ZOOM_STEP, { announce: false }); } }, { passive: false });
  stage.addEventListener("pointerdown", handleImagePreviewPointerDown);
  stage.addEventListener("pointermove", handleImagePreviewPointerMove);
  stage.addEventListener("pointerup", handleImagePreviewPointerEnd);
  stage.addEventListener("pointercancel", handleImagePreviewPointerEnd);
}

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
  const libraryTotal = Number(state.groups.total || 0);
  const hasQuery = state.query.trim() !== "";
  const hasFacet = FACET_KEYS.some((key) => state.facets[key]);
  const refined = hasQuery || hasFacet || state.scope !== "all";
  // A genuinely empty library wins over any refinement: importing is the only
  // useful action when there is nothing to search.
  if (!refined || libraryTotal === 0) {
    if (libraryTotal === 0) return "library-empty";
    // Total says assets exist, no refinement is active, yet the result is
    // empty — a transient stat/count race. Never claim the library is empty;
    // no-results is the conservative, recoverable message.
    return "no-results";
  }
  // Any query or non-group facet means “no matches”, also when stacked on a
  // scope or a group (a scoped empty state never hides an active search).
  if (hasQuery || state.facets.source || state.facets.category || state.facets.style) return "no-results";
  if (state.facets.group) {
    if (state.scope !== "all") return "no-results";
    const groupExists = state.groups.groups.some(([name]) => name === state.facets.group);
    return groupExists ? "group-empty" : "no-results";
  }
  if (state.scope === "favorite") return "favorites-empty";
  if (state.scope === "recent") return "recent-empty";
  return "no-results";
}

/** One shell for every empty state; the kind only changes copy and actions. */
function galleryEmptyMarkup() {
  const kind = deriveGalleryEmptyState();
  if (kind === "none") return "";
  let title = "";
  let description = "";
  let actions = "";
  if (kind === "library-empty") {
    // Reuses the approved onboarding copy — the guided empty state is no
    // longer dead code, and no duplicate synonym keys are introduced.
    title = t("onboardTitle");
    description = t("onboardHint");
    actions = `<button class="btn-primary" type="button" data-action="empty-import">${escapeHtml(t("onboardImport"))}</button>${state.libraryPath ? `<button class="btn-secondary" type="button" data-action="empty-open-library">${escapeHtml(t("openLibrary"))}</button>` : ""}`;
  } else if (kind === "no-results") {
    title = t("noResultsTitle");
    description = t("noResultsDescription");
    actions = `<button class="btn-secondary" type="button" data-action="empty-clear">${escapeHtml(t("clearAll"))}</button>`;
  } else if (kind === "favorites-empty") {
    title = t("favoritesEmptyTitle");
    description = t("favoritesEmptyDescription");
    actions = `<button class="btn-secondary" type="button" data-action="empty-view-all">${escapeHtml(t("viewAllAssets"))}</button>`;
  } else if (kind === "recent-empty") {
    title = t("recentEmptyTitle");
    // “Recent” is a real business window (assets created in the last 7 days),
    // not “recently viewed” — the copy only describes that true semantic.
    description = t("recentEmptyDescription");
    actions = `<button class="btn-secondary" type="button" data-action="empty-view-all">${escapeHtml(t("viewAllAssets"))}</button>`;
  } else if (kind === "group-empty") {
    const groupName = humanizeFacetValue(state.facets.group);
    title = t("groupEmptyTitle");
    description = t("groupEmptyDescription", { name: groupName });
    actions = `<button class="btn-secondary" type="button" data-action="empty-view-all">${escapeHtml(t("viewAllAssets"))}</button>`;
  }
  // The group name travels as an escaped dynamic parameter and stays fully
  // reachable via title, however long it is.
  const subjectTitle = kind === "group-empty" ? ` title="${escapeHtml(state.facets.group)}"` : "";
  return `<div class="gallery-empty-state" data-empty-kind="${kind}"><div class="empty-state-copy"><h2${subjectTitle}>${escapeHtml(title)}</h2><p${subjectTitle}>${escapeHtml(description)}</p></div>${actions ? `<div class="empty-state-actions">${actions}</div>` : ""}</div>`;
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
  state.facetQuery = "";
  if (els.facetSearchInput) els.facetSearchInput.value = "";
  state.scope = "all";
  clearFacets();
  // A reset restarts paging, and the viewer result-set semantics changed.
  state.nextCursor = null;
  if (state.viewMode === "asset") returnToLibrary();
  clearDetailSelection();
  renderQuickFilters(); renderFilterPanel(); renderActiveFilters();
  announceGalleryStatus(t("statusRefinementsCleared"));
  void loadAssets().then((applied) => {
    if (!applied) return;
    const firstCard = els.assetGrid?.querySelector(".asset-card-select");
    if (firstCard) firstCard.focus({ preventScroll: true });
    else els.assetGrid?.focus({ preventScroll: true });
  });
}

init();

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
    setInterval(refreshLibraryInBackground, 2500);
  } catch (error) {
    renderErrorState(error);
    setStatus(t("statusUnavailable"), "error");
  }
}

function resolveLocale(value) {
  if (value === "zh" || value === "en") return value;
  return /^zh/i.test(navigator.language || "") ? "zh" : "en";
}

function t(key, variables = {}) {
  const template = translations[state.locale]?.[key] ?? translations.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(variables[name] ?? ""));
}

function applyLanguage() {
  state.locale = resolveLocale(state.languagePreference);
  document.documentElement.lang = state.locale === "zh" ? "zh-CN" : "en";
  document.title = t("appTitle");
  document.querySelectorAll("[data-i18n]").forEach((node) => { node.textContent = t(node.dataset.i18n); });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => { node.placeholder = t(node.dataset.i18nPlaceholder); });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((node) => { node.setAttribute("aria-label", t(node.dataset.i18nAriaLabel)); });
  document.querySelectorAll("[data-i18n-title]").forEach((node) => { node.title = t(node.dataset.i18nTitle); });
  updateCodexHint();
  window.electronAPI?.setLocale?.(state.locale);
  renderSettingsMenu();
  if (els.sortSelect) els.sortSelect.value = state.sort;
  renderQuickFilters();
  renderFilterPanel();
  updateViewTitle();
  renderGrid();
  if (state.detailOpen) renderDetail();
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
  const projects = state.projects.length ? state.projects : [state.project];
  const choices = [
    ["system", `${t("systemLanguage")} · ${resolveLocale("system") === "zh" ? t("chinese") : t("english")}`],
    ["zh", t("chinese")], ["en", t("english")]
  ];
  const currentLanguage = choices.find(([value]) => value === state.languagePreference) || choices[0];
  const projectOptions = projects.map((project) => `<option value="${escapeHtml(project)}"${project === state.project ? " selected" : ""}>${escapeHtml(project)}</option>`).join("");
  // Phase 5A / F-12：Settings=role=menu（action row 为 menuitem）；原生 select 保持 combobox 语义、
  // segmented=role=radiogroup/radio（aria-checked + roving tabindex）；Language=menuitemradio + aria-checked。
  const appearanceSectionHtml = `<section class="settings-section"><p>${t("appearance")}</p><div class="segmented" role="radiogroup" aria-label="${escapeHtml(t("appearance"))}"><button class="segmented-btn${!state.darkMode ? " active" : ""}" type="button" role="radio" aria-checked="${!state.darkMode}" tabindex="${state.darkMode ? -1 : 0}" data-appearance-opt="light">${t("themeLight")}</button><button class="segmented-btn${state.darkMode ? " active" : ""}" type="button" role="radio" aria-checked="${state.darkMode}" tabindex="${state.darkMode ? 0 : -1}" data-appearance-opt="dark">${t("themeDark")}</button></div><div class="segmented" role="radiogroup" aria-label="${escapeHtml(t("galleryDensity"))}"><button class="segmented-btn${state.galleryDensity === "image" ? " active" : ""}" type="button" role="radio" aria-checked="${state.galleryDensity === "image"}" tabindex="${state.galleryDensity === "image" ? 0 : -1}" data-density-opt="image">${t("densityImageOnly")}</button><button class="segmented-btn${state.galleryDensity === "info" ? " active" : ""}" type="button" role="radio" aria-checked="${state.galleryDensity === "info"}" tabindex="${state.galleryDensity === "info" ? 0 : -1}" data-density-opt="info">${t("densityWithInfo")}</button></div></section>`;
  const diagnosticsSectionHtml = `<section class="settings-section"><button type="button" class="settings-diagnostics-toggle" role="menuitem" tabindex="-1" aria-expanded="${state.diagnosticsExpanded}" data-action="toggle-diagnostics">${state.diagnosticsExpanded ? t("hideDiagnostics") : t("showDiagnostics")}</button><div class="settings-diagnostics" id="diagnosticsPanel"${state.diagnosticsExpanded ? "" : " hidden"}><div id="diagnosticsContent">${state.diagnosticsExpanded ? `<p class="diag-loading">${t("diagLoading")}</p>` : ""}</div></div></section>`;
  els.settingsMenu.innerHTML = `<section class="settings-section"><p>${t("project")}</p><div class="settings-project-row"><select id="projectSelect" data-project-select aria-label="${escapeHtml(t("project"))}">${projectOptions}</select><button class="icon-button quiet" type="button" role="menuitem" tabindex="-1" data-open-library title="${escapeHtml(t("openLibrary"))}" aria-label="${escapeHtml(t("openLibrary"))}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg></button></div></section><section class="settings-section settings-language-section"><p>${t("language")}</p><button class="settings-submenu-trigger" type="button" role="menuitem" tabindex="-1" data-language-menu aria-haspopup="menu" aria-expanded="false" aria-controls="languageMenu"><span>${escapeHtml(currentLanguage[1])}</span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg></button><div class="language-menu anchored-overlay" id="languageMenu" role="menu" aria-label="${escapeHtml(t("language"))}" hidden>${choices.map(([value, label]) => `<button type="button" role="menuitemradio" aria-checked="${state.languagePreference === value}" tabindex="-1" data-locale="${value}">${escapeHtml(label)}<span aria-hidden="true">${state.languagePreference === value ? "✓" : ""}</span></button>`).join("")}</div></section>${appearanceSectionHtml}${diagnosticsSectionHtml}`;
  const radioGroups = [...els.settingsMenu.querySelectorAll('[role="radiogroup"]')];
  radioGroups.forEach((group, groupIndex) => {
    const groupId = `settingsRadioGroupLabel-${groupIndex}`;
    addVoiceOverLabel(group, groupId, group.getAttribute("aria-label"));
    [...group.querySelectorAll('[role="radio"]')].forEach((radio, radioIndex) => {
      addVoiceOverLabel(radio, `${groupId}-${radioIndex}`, radio.getAttribute("aria-label") || radio.textContent.trim());
    });
  });
  const openLibraryButton = els.settingsMenu.querySelector("[data-open-library]");
  addVoiceOverLabel(openLibraryButton, "settingsOpenLibraryLabel", openLibraryButton?.getAttribute("aria-label"));
  const languageTrigger = els.settingsMenu.querySelector("[data-language-menu]");
  addVoiceOverLabel(languageTrigger, "settingsLanguageTriggerLabel", languageTrigger?.textContent.trim());
  [...els.settingsMenu.querySelectorAll('[role="menuitemradio"]')].forEach((item, index) => {
    addVoiceOverLabel(item, `languageMenuItemLabel-${index}`, item.getAttribute("aria-label") || item.textContent.trim());
  });
  els.settingsMenu.querySelector(".settings-language-section")?.insertAdjacentHTML("beforebegin", renderCowartCanvasSettings());
  primeSettingsRoving();
  if (state.diagnosticsExpanded) fetchDiagnostics();
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
  if (!els.imagePreviewModal?.hidden || !els.filterPanel?.hidden || !els.settingsMenu?.hidden) return;
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

// ===== Phase 5C / F-16：双通道可排队 Toast Manager =====
// 单一 Manager 管理两条物理独立的反馈通道：polite（success/default，容器 role=status，
// aria-live=polite）与 assertive（error，每条 Toast 自身 role=alert）。每条 lane 同时最多
// 2 条，超出进入 FIFO 等待队列；计时只在真正可见后开始（success/default 2200ms，
// error 6000ms），排队不消耗时长。hover/focus 暂停可多原因叠加，全部解除后按剩余
// 时长恢复；error 可手动关闭（关闭按钮仅 error 有，键盘关闭有安全焦点策略）；进出
// 过渡为 class + transition 可中断，transitionend 后移除并有短 fallback 防僵尸节点。
// Toast 状态不进素材 state、不写 localStorage；消息一律 textContent，绝不接受任意 HTML。
const TOAST_DURATIONS = { success: 2200, default: 2200, error: 6000 };
const TOAST_VISIBLE_LIMIT = 2;
const TOAST_LEAVE_FALLBACK_MS = 400;
let toastSequence = 0;

function normalizeToastMessage(message) {
  if (typeof message === "string") return message;
  if (message == null) return "";
  if (typeof message.message === "string") return message.message;
  const text = String(message);
  return text === "[object Object]" ? "" : text;
}

function toastSvgIcon(className) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", className === "toast-icon"
    ? "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4.5V13m0 3.5v.01"
    : "m6 6 12 12M18 6 6 18");
  svg.appendChild(path);
  return svg;
}

function createToastManager() {
  const lanes = {
    polite: { containerKey: "toastContainer", visible: [], pending: [] },
    assertive: { containerKey: "toastErrorContainer", visible: [], pending: [] },
  };
  const entries = new Map(); // id -> 记录（稳定唯一 ID，每条独立生命周期）
  const laneOf = (type) => (type === "error" ? "assertive" : "polite");
  const containerOf = (laneName) => els[lanes[laneName].containerKey];

  function syncPoliteStackOffset() {
    // 两通道物理独立但共享右下角：错误栈占底，polite 栈浮在其上方；
    // 偏移由 Manager 实测 error 栈高度得出，避免两栈重叠。
    const assertive = els.toastErrorContainer;
    const polite = els.toastContainer;
    if (!assertive || !polite) return;
    const height = assertive.offsetHeight;
    polite.style.setProperty("--toast-error-stack-height", height > 0 ? `${height + 8}px` : "0px");
  }

  function pump(laneName) {
    const lane = lanes[laneName];
    while (lane.visible.length < TOAST_VISIBLE_LIMIT && lane.pending.length) {
      present(laneName, lane.pending.shift());
    }
    if (laneName === "assertive") syncPoliteStackOffset();
  }

  function present(laneName, entry) {
    const container = containerOf(laneName);
    if (!container) { entry.state = "removed"; entries.delete(entry.id); return; }
    entry.state = "visible";
    entry.shownAt = Date.now();
    entry.startedAt = entry.shownAt;
    entry.remaining = entry.duration;

    const element = document.createElement("div");
    element.className = `toast ${entry.type}`;
    element.dataset.toastId = entry.id;
    if (entry.type === "error") {
      element.setAttribute("role", "alert");
      element.appendChild(toastSvgIcon("toast-icon"));
    }
    const message = document.createElement("span");
    message.className = "toast-message";
    // Include polite text in the live-region insertion. VoiceOver can otherwise
    // miss a later text mutation when the toast is initially appended empty.
    message.textContent = entry.message;
    element.appendChild(message);
    if (entry.type === "error") {
      const dismissButton = document.createElement("button");
      dismissButton.type = "button";
      dismissButton.className = "toast-dismiss";
      dismissButton.dataset.i18nAriaLabel = "dismissNotification"; // Language 切换后经 applyI18n 更新
      dismissButton.setAttribute("aria-label", t("dismissNotification"));
      dismissButton.appendChild(toastSvgIcon("toast-dismiss-icon"));
      // event.detail === 0 即键盘激活（Enter/Space）；指针点击 detail > 0，不强制动焦点。
      dismissButton.addEventListener("click", (event) => dismiss(entry.id, "manual", event.detail === 0));
      element.appendChild(dismissButton);
    }
    entry.element = element;
    lanes[laneName].visible.push(entry);
    container.appendChild(element);
    void element.offsetHeight; // 强制回流，使进场 transition 可播放且可中断
    element.classList.add("is-visible");

    // 暂停/恢复：pointer 与 focus 两类原因可叠加，全部解除后才继续计时。
    element.addEventListener("pointerenter", () => pause(entry.id, "pointer"));
    element.addEventListener("pointerleave", () => resume(entry.id, "pointer"));
    element.addEventListener("focusin", () => pause(entry.id, "focus"));
    element.addEventListener("focusout", (event) => { if (!element.contains(event.relatedTarget)) resume(entry.id, "focus"); });

    entry.timer = setTimeout(() => beginLeave(entry.id, "timeout"), entry.remaining);
  }

  function pause(id, reason) {
    const entry = entries.get(id);
    if (!entry || entry.state !== "visible") return;
    const first = entry.pauseReasons.size === 0;
    entry.pauseReasons.add(reason);
    if (!first) return; // 已有暂停原因在途，只叠加不重复结算
    clearTimeout(entry.timer);
    entry.timer = null;
    entry.remaining = Math.max(0, entry.remaining - (Date.now() - entry.startedAt));
  }

  function resume(id, reason) {
    const entry = entries.get(id);
    if (!entry || entry.state !== "visible") return;
    entry.pauseReasons.delete(reason);
    if (entry.pauseReasons.size > 0 || entry.timer) return; // 仍有其他原因或已有 timer，绝不重复创建
    entry.startedAt = Date.now();
    if (entry.remaining <= 0) { beginLeave(entry.id, "timeout"); return; }
    entry.timer = setTimeout(() => beginLeave(entry.id, "timeout"), entry.remaining);
  }

  function beginLeave(id, reason) {
    const entry = entries.get(id);
    if (!entry || entry.state !== "visible") return; // 单条只移除一次：leaving/removed 不再进场
    entry.state = "leaving";
    entry.dismissedReason = reason;
    clearTimeout(entry.timer);
    entry.timer = null;
    const lane = lanes[entry.lane];
    lane.visible = lane.visible.filter((item) => item !== entry);
    const element = entry.element;
    if (element?.isConnected) {
      element.classList.remove("is-visible");
      element.classList.add("is-leaving");
      element.addEventListener("transitionend", (event) => { if (event.target === element) finalize(entry.id); }, { once: true });
    }
    entry.leaveTimer = setTimeout(() => finalize(entry.id), TOAST_LEAVE_FALLBACK_MS);
    pump(entry.lane); // 前一条离场即泵送最早等待项（新 Toast 不取消本条离场清理）
  }

  function finalize(id) {
    const entry = entries.get(id);
    if (!entry || entry.state === "removed") return;
    entry.state = "removed";
    clearTimeout(entry.leaveTimer);
    entry.leaveTimer = null;
    entry.element?.remove();
    entries.delete(id);
    if (entry.lane === "assertive") syncPoliteStackOffset();
  }

  function restoreAssertiveDismissFocus(closedEntry) {
    // 键盘关闭后的安全焦点：1）下一条 Error 的关闭按钮；2）创建时仍连接的 origin；
    // 3）当前视图安全可达元素。绝不落回 body，绝不恢复 hidden/disabled/断开节点。
    requestAnimationFrame(() => {
      const next = lanes.assertive.visible[0];
      const nextDismiss = next?.element?.querySelector(".toast-dismiss");
      if (nextDismiss?.isConnected) { nextDismiss.focus(); return; }
      if (isConfirmFocusTarget(closedEntry.originFocus)) { closedEntry.originFocus.focus(); return; }
      const fallback = state.viewMode === "asset" ? els.assetViewBack : els.searchInput;
      if (isConfirmFocusTarget(fallback)) fallback.focus();
    });
  }

  function show(rawMessage, type = "default") {
    const normalizedType = type === "success" || type === "error" ? type : "default";
    const lane = laneOf(normalizedType);
    const entry = {
      id: `toast-${++toastSequence}`,
      message: normalizeToastMessage(rawMessage),
      type: normalizedType,
      lane,
      duration: TOAST_DURATIONS[normalizedType],
      remaining: TOAST_DURATIONS[normalizedType],
      createdAt: Date.now(),
      shownAt: null,
      startedAt: null,
      timer: null,
      leaveTimer: null,
      state: "queued",
      originFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      pauseReasons: new Set(),
      element: null,
      dismissedReason: null,
    };
    entries.set(entry.id, entry);
    lanes[lane].pending.push(entry);
    pump(lane);
    return entry.id;
  }

  function dismiss(id, reason = "manual", viaKeyboard = false) {
    const entry = entries.get(id);
    if (!entry || entry.state !== "visible") return;
    const laneName = entry.lane;
    beginLeave(id, reason);
    if (viaKeyboard && laneName === "assertive") restoreAssertiveDismissFocus(entry);
  }

  function clearAll(reason = "clear") {
    for (const entry of [...entries.values()]) {
      clearTimeout(entry.timer);
      clearTimeout(entry.leaveTimer);
      entry.state = "removed";
      entry.dismissedReason = entry.dismissedReason || reason;
      entry.element?.remove();
    }
    entries.clear();
    for (const laneName of Object.keys(lanes)) { lanes[laneName].visible = []; lanes[laneName].pending = []; }
    syncPoliteStackOffset();
  }

  function laneSnapshot(laneName) {
    const lane = lanes[laneName];
    const pack = (entry, position) => ({ id: entry.id, type: entry.type, state: entry.state, duration: entry.duration, remaining: entry.remaining, createdAt: entry.createdAt, shownAt: entry.shownAt, queuePosition: position, pauseReasons: [...entry.pauseReasons], dismissedReason: entry.dismissedReason });
    return { visible: lane.visible.map((entry, index) => pack(entry, index)), pending: lane.pending.map((entry, index) => pack(entry, index)) };
  }

  return { show, dismiss, pause, resume, clearAll, snapshot: () => ({ polite: laneSnapshot("polite"), assertive: laneSnapshot("assertive") }) };
}

const toastManager = createToastManager();
function showToast(message, type = "default") { return toastManager.show(message, type); }
// 只读调试钩子：仅供契约/运行时验证取证（队列位置、remaining、暂停原因），
// 不向 UI 暴露、不参与任何业务决策。
window.__mosaToastDebug = () => toastManager.snapshot();

async function api(path, options = {}) {
  const response = await fetch(path, { method: options.method || "GET", headers: options.body ? { "content-type": "application/json" } : undefined, body: options.body ? JSON.stringify(options.body) : undefined });
  const raw = await response.text();
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch { if (!response.ok) throw new Error(response.statusText); }
  if (!response.ok) {
    // Carry the server's machine-readable code so callers can attribute a
    // failure to a specific form field instead of matching on prose.
    const error = new Error(payload.error || response.statusText);
    if (payload.code) error.code = payload.code;
    throw error;
  }
  return payload;
}

async function loadProjects() {
  const result = await api("/api/projects");
  state.projects = result.projects || [];
  renderSettingsMenu();
}

async function loadCowartCanvases() {
  const result = await api("/api/cowart-canvases");
  state.cowartCanvases = result.canvases || [];
  renderSettingsMenu();
  if (state.detailOpen) renderDetail();
}

let statsRequestSequence = 0;
async function loadStats(options = {}) {
  const requestId = ++statsRequestSequence;
  const project = state.project;
  const [library, result] = await Promise.all([
    api(`/api/library-path?project=${encodeURIComponent(project)}`).catch(() => null),
    api(`/api/groups?project=${encodeURIComponent(project)}`)
  ]);
  if (requestId !== statsRequestSequence || project !== state.project) return false;

  state.libraryPath = library?.path || "";
  state.codexImagesDir = library?.codexGeneratedImagesDir || "";
  state.supportedMediaExtensions = Array.isArray(library?.supportedMediaExtensions) ? library.supportedMediaExtensions : [];
  updateCodexHint();
  const nextGroups = { total: 0, favorites: 0, recent: 0, codex: 0, cowart: 0, grok: 0, groups: [], categories: [], styles: [], styleTotal: 0, ...(result.groups || {}) };
  const changed = JSON.stringify(nextGroups) !== JSON.stringify(state.groups);
  state.groups = nextGroups;
  if (!options.background || changed) {
    renderQuickFilters();
    renderFilterPanel();
  }
  return true;
}

let assetRequestSequence = 0;

// BUG-10（Batch 2A）：Gallery 与 Viewer 边界按需加载共用同一分页请求语义——参数构造
// 与请求发起都收敛到这两个 helper，避免两套查询规则漂移。Viewer 只允许在进入时捕获的
// 只读查询快照上取页，绝不读取运行中已变化的筛选状态；游标必须与发出时的排序同行。
function buildAssetPageParams(request, options = {}) {
  const params = new URLSearchParams({ project: request.project, q: request.query });
  params.set("limit", "100");
  // The sort is resolved by the store across the whole query, so the cursor must
  // travel with the same order it was issued under.
  params.set("sort", request.sort);
  if (options.cursor) params.set("cursor", options.cursor);
  if (request.scope === "favorite") params.set("favorite", "1");
  else if (request.scope === "recent") params.set("recent", "1");
  for (const key of FACET_KEYS) {
    if (request.facets[key]) params.set(key, request.facets[key]);
  }
  return params;
}

function requestAssetPage(request, options = {}) {
  return api(`/api/assets?${buildAssetPageParams(request, options)}`);
}

// Gallery busy is owned by the single results container. A completion may clear
// the attribute only when its request generation and request key are still current;
// a stale response can never make a newer search/filter request look idle.
function isCurrentAssetRequest(requestId, request) {
  if (requestId !== assetRequestSequence) return false;
  return assetRequestKey(request) === assetRequestKey(currentAssetRequest());
}

function setGalleryBusy(busy, requestId = null, request = null) {
  if (!els.assetGrid) return false;
  if (!busy && requestId !== null && !isCurrentAssetRequest(requestId, request)) return false;
  els.assetGrid.setAttribute("aria-busy", String(Boolean(busy)));
  return true;
}

async function loadAssets(options = {}) {
  const requestId = ++assetRequestSequence;
  const request = currentAssetRequest();
  setGalleryBusy(true, requestId, request);
  let result;
  try {
    result = await requestAssetPage(request, { cursor: options.append ? state.nextCursor : null });
  } catch (error) {
    if (!isCurrentAssetRequest(requestId, request)) return false;
    // Background refreshes must not replace a usable gallery with an error
    // screen, but their busy lifecycle still ends at the failed request.
    if (options.background && state.assets.length) {
      setGalleryBusy(false, requestId, request);
      return false;
    }
    renderErrorState(error, requestId, request);
    return false;
  }
  if (!isCurrentAssetRequest(requestId, request)) return false;

  const previousAssets = state.assets;
  const previousSelected = selectedAsset();
  const incomingAssets = result.assets || [];
  const nextAssets = options.append
    ? [...state.assets, ...incomingAssets.filter((asset) => !state.assets.some((current) => current.id === asset.id && current.project_id === asset.project_id))]
    : incomingAssets;
  const nextSelected = nextAssets.find((asset) => asset.id === state.selectedId)
    || (state.detailAsset?.id === state.selectedId && state.detailAsset.project_id === request.project ? state.detailAsset : null);
  const assetsChanged = assetListVersion(previousAssets) !== assetListVersion(nextAssets);
  const selectedChanged = assetVersion(previousSelected) !== assetVersion(nextSelected);
  state.assets = nextAssets;
  // The request answered, so an empty result is now genuinely an empty library.
  state.galleryStatus = "ready";
  state.galleryError = null;
  state.pageTotal = Number(result.page?.total || nextAssets.length);
  state.nextCursor = result.page?.nextCursor || null;
  state.loadedPageCount = options.append ? state.loadedPageCount + 1 : 1;
  if (state.detailAsset?.project_id !== request.project) state.detailAsset = null;
  if (state.detailAsset && state.assets.some((asset) => asset.id === state.detailAsset.id && asset.project_id === state.detailAsset.project_id)) state.detailAsset = null;
  if (state.selectedId && !state.assets.some((asset) => asset.id === state.selectedId)
    && !(state.detailAsset?.id === state.selectedId && state.detailAsset.project_id === request.project)) state.selectedId = null;
  if (!options.background || assetsChanged) {
    // F-24：入场动画只用于首次加载或追加页（新卡片），搜索/筛选/排序/后台刷新
    // 的普通重渲染不重复播放整页动画。
    renderGrid({ animate: options.append || previousAssets.length === 0, animateFrom: options.append ? previousAssets.length : 0 });
    updateViewTitle();
  }
  if (state.detailOpen && (!options.background || !state.selectedId || (selectedChanged && !isDetailEditorActive()))) renderDetail();
  // Phase 3C：后台刷新不重新排序 session 序列，但有效性可能变化——仅同步导航边界
  // 与位置（缺失 ID 在导航时跳过，总数基于当前有效 ID 重算）。
  if (state.viewMode === "asset") updateAssetViewNav();
  setGalleryBusy(false, requestId, request);
  return true;
}

let libraryRefreshInFlight = false;
async function refreshLibraryInBackground() {
  if (document.hidden || libraryRefreshInFlight) return;
  libraryRefreshInFlight = true;
  try {
    await Promise.all([
      loadStats({ background: true }),
      state.loadedPageCount > 1 ? Promise.resolve(true) : loadAssets({ background: true }),
    ]);
  } catch {
    // A transient refresh failure should not interrupt the active library view.
  } finally {
    libraryRefreshInFlight = false;
  }
}

function currentAssetRequest() {
  return { project: state.project, query: state.query, scope: state.scope, facets: { ...state.facets }, sort: state.sort };
}

function assetRequestKey(request) {
  return JSON.stringify([request.project, request.query, request.scope, ...FACET_KEYS.map((key) => request.facets[key] || ""), request.sort]);
}

function assetListVersion(assets) {
  return assets.map((asset) => `${asset.id}:${asset.updated_at || ""}:${asset.image_url || ""}`).join("|");
}

function assetVersion(asset) {
  return asset ? `${asset.id}:${asset.updated_at || ""}` : "";
}

function isDetailEditorActive() {
  const active = document.activeElement;
  return state.detailDirty || (active instanceof HTMLElement && Boolean(els.detailPanel?.contains(active) && active.closest("[data-edit], [data-version-change], [data-recipe-change]")));
}

const bridgeStatusPoller = createBridgeStatusPoller({
  fetchStatus: () => api("/api/bridges"),
  onSuccess: applyBridgeStatus,
  onError: applyBridgeStatusFailure,
});

// Stop polling when the page goes away and drop any response that lands afterwards.
window.addEventListener("pagehide", () => bridgeStatusPoller.stop());

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
  // A count of 0 while the first request is still open is the bug the audit saw
  // as "sidebar 405, workspace 0".
  els.assetCount.textContent = state.galleryStatus === "loading"
    ? t("galleryLoading")
    : (state.galleryStatus === "error" ? "" : t("assetsCount", { count: state.pageTotal || state.assets.length }));
  const facetCount = FACET_KEYS.filter((key) => state.facets[key]).length;
  if (els.filterDot) {
    els.filterDot.hidden = facetCount === 0;
    els.filterDot.textContent = facetCount ? String(facetCount) : "";
  }
  els.filterToggle?.setAttribute("aria-pressed", String(facetCount > 0));
  renderActiveFilters();
}

/** The chips are the only place the full active query is spelled out. */
function activeFilterChips() {
  const chips = [];
  if (state.query) chips.push({ kind: "query", label: t("chipSearch"), value: `“${state.query}”` });
  if (state.scope !== "all") chips.push({ kind: "scope", label: t("chipScope"), value: state.scope === "favorite" ? t("favorites") : t("recent") });
  const sourceLabels = Object.fromEntries(Object.entries(SOURCE_FACETS).map(([key, value]) => [value, t(`filter${key.charAt(0).toUpperCase()}${key.slice(1)}`)]));
  for (const key of FACET_KEYS) {
    const value = state.facets[key];
    if (!value) continue;
    const label = t(`chip${key.charAt(0).toUpperCase()}${key.slice(1)}`);
    chips.push({ kind: key, label, value: key === "source" ? (sourceLabels[value] || value) : humanizeFacetValue(value) });
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
  else if (FACET_KEYS.includes(kind)) state.facets[kind] = "";
  else return;
  applyFilterChange();
}

function bindEvents() {
  els.batchToggle?.addEventListener("click", toggleBatchMode);
  els.batchSelectAll?.addEventListener("click", selectAllAssets);
  els.batchFavorite?.addEventListener("click", () => { void batchFavorite(); });
  els.batchArchive?.addEventListener("click", () => { void batchArchive(); });
  els.batchCancel?.addEventListener("click", () => setBatchMode(false));
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
  els.facetSearchInput?.addEventListener("input", debounce(() => { state.facetQuery = els.facetSearchInput.value; renderFilterPanel(); }, 120));
  els.activeFilters?.addEventListener("click", (event) => { const chip = event.target.closest("[data-chip]"); if (chip) removeFilterChip(chip.dataset.chip); });
  els.assetGrid?.addEventListener("click", (event) => {
    if (event.target.closest('[data-action="retry"]')) window.location.reload();
    if (event.target.closest('[data-action="load-more"]')) void loadAssets({ append: true });
    // F-08 空态操作：导入复用现有 Modal（不建第二套）；清除与查看全部共用
    // 同一个 reset helper，只触发一次刷新；打开素材库复用既有 API。
    if (event.target.closest('[data-action="empty-import"]')) { openImportModal(); return; }
    if (event.target.closest('[data-action="empty-clear"]') || event.target.closest('[data-action="empty-view-all"]')) { resetLibraryRefinements(); return; }
    const openLibraryAction = event.target.closest('[data-action="empty-open-library"]');
    if (openLibraryAction) runAction(async () => { if (!state.libraryPath) return; await api("/api/open-folder", { method: "POST", body: { path: state.libraryPath } }); showToast(t("openInFinder"), "success"); });
  });
  els.addGroupBtn?.addEventListener("click", openGroupModal);
  els.newAssetTopBtn?.addEventListener("click", openImportModal);
  els.quickFilters?.addEventListener("click", (event) => { const button = event.target.closest("[data-filter]"); if (button) setFilter(button.dataset.filter); });
  els.sidebarGroupList?.addEventListener("click", (event) => {
    if (event.target.closest('[data-action="open-all-groups"]')) {
      // The sidebar only lists the busiest collections; the panel owns the full list.
      // The document-level outside-click handler would close the panel again as this
      // click keeps bubbling, so it must not reach it.
      event.stopPropagation();
      if (els.filterPanel?.hidden) togglePanel(els.filterPanel, els.filterToggle);
      // Focused synchronously: an animation frame never runs while the window is hidden.
      els.facetSearchInput?.focus();
      return;
    }
    const button = event.target.closest("[data-filter]"); if (button) setFilter(button.dataset.filter, button.dataset.value);
  });
  els.filterToggle?.addEventListener("click", () => togglePanel(els.filterPanel, els.filterToggle));
  els.clearFiltersBtn?.addEventListener("click", () => clearAllFilters());
  els.sourceFilters?.addEventListener("click", (event) => { const button = event.target.closest("[data-filter]"); if (button) setFilter(button.dataset.filter); });
  [els.groupList, els.categoryList, els.styleList].forEach((list) => list?.addEventListener("click", (event) => { const button = event.target.closest("[data-filter]"); if (button) setFilter(button.dataset.filter, button.dataset.value); }));
  els.settingsToggle?.addEventListener("click", () => togglePanel(els.settingsMenu, els.settingsToggle));
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
      anchoredOverlayManager.close("language", "selection"); // 关闭 child；保持 Settings，焦点由 setLanguage 重建后恢复
      return setLanguage(localeButton.dataset.locale);
    }
    const openLibraryButton = event.target.closest("[data-open-library]");
    if (openLibraryButton) runAction(async () => { if (!state.libraryPath) return; await api("/api/open-folder", { method: "POST", body: { path: state.libraryPath } }); showToast(t("openInFinder"), "success"); });
  });
  els.closeImportModal?.addEventListener("click", closeImportModal);
  els.cancelImportBtn?.addEventListener("click", closeImportModal);
  els.importModal?.addEventListener("click", (event) => { if (event.target === els.importModal) closeImportModal(); });
  els.closeGroupModal?.addEventListener("click", closeGroupModal);
  els.cancelGroupBtn?.addEventListener("click", closeGroupModal);
  els.groupModal?.addEventListener("click", (event) => { if (event.target === els.groupModal) closeGroupModal(); });
  // Phase 5B / F-15：ConfirmDialog——Cancel/Confirm 结算唯一 pending Promise；Backdrop 点击只能取消，绝不确认。
  els.confirmDialogCancel?.addEventListener("click", () => closeConfirmDialog(false));
  els.confirmDialogConfirm?.addEventListener("click", () => closeConfirmDialog(true));
  els.confirmDialog?.addEventListener("click", (event) => { if (event.target === els.confirmDialog) closeConfirmDialog(false); });
  els.saveGroupBtn?.addEventListener("click", saveGroup);
  els.closeImagePreview?.addEventListener("click", closeImagePreview);
  els.imagePreviewModal?.addEventListener("click", (event) => { if (event.target === els.imagePreviewModal) closeImagePreview(); });
  els.imagePreviewStage?.addEventListener("click", (event) => {
    if (imagePreviewSuppressStageClick) { imagePreviewSuppressStageClick = false; return; }
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
  window.addEventListener("resize", () => { anchoredOverlayManager.repositionOpen(); if (state.imagePreviewId) fitImagePreview(); });
  // Phase 5B：ConfirmDialog 陷阱先于其余陷阱注册——Escape 优先级链最前（preventDefault +
  // stopPropagation，不穿透 Viewer/既有 Modal）；ConfirmDialog 未打开时后续陷阱照常工作。
  document.addEventListener("keydown", trapConfirmDialogFocus);
  document.addEventListener("keydown", trapImportModalFocus);
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
    if (els.importModal?.classList.contains("open") || els.groupModal?.classList.contains("open") || !els.imagePreviewModal?.hidden) return;
    if (!els.filterPanel?.hidden || !els.settingsMenu?.hidden) return;
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
  // Phase 5A：applyLanguage 重建 Settings DOM（语言子菜单与入口按钮全部换新）——同步 manager
  // 状态后，用稳定重查询 + requestAnimationFrame 把焦点恢复到新的语言入口；Settings 保持打开，
  // 不保留断开的旧 DOM 引用。
  anchoredOverlayManager.refreshAfterRebuild();
  requestAnimationFrame(() => {
    if (els.settingsMenu && !els.settingsMenu.hidden) els.settingsMenu.querySelector("[data-language-menu]")?.focus();
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
  // F-08：清除一律收敛到单一 reset helper（query/输入框/facets/facetQuery/scope/分组，
  // 一次刷新）；sort、density、theme、language、project 不受影响。
  resetLibraryRefinements();
}

function applyFilterChange() {
  // A filter change restarts paging, so any cursor from the previous query is stale.
  state.nextCursor = null;
  // Phase 3A：结果集语义已变化，退出查看模式。
  if (state.viewMode === "asset") returnToLibrary();
  clearDetailSelection();
  renderQuickFilters(); renderFilterPanel(); renderActiveFilters(); loadAssets();
}

// Phase 5A / F-14：兼容 wrapper——既有调用点（Escape 优先级链、sidebar 打开全部分组）保留
// 原字面签名；开关/定位/aria-expanded/hidden/return focus 全部路由到共享 anchoredOverlayManager，
// 不再存在任何独立定位公式。
function togglePanel(panel, trigger) {
  if (!panel) return;
  const overlayId = anchoredOverlayManager.idForPanel(panel);
  if (!overlayId) return;
  anchoredOverlayManager.toggle(overlayId); // trigger-toggle：root 互斥由 manager 统一处理
}
function closePanel(panel, trigger, reason = "escape") {
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
  if (event.target.matches("select, input, textarea")) return; // 原生 select 保持原生键盘语义
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
    const result = await api("/api/assets/create", { method: "POST", body: { projectId: state.project, imagePath: els.imagePathInput.value, prompt: els.promptInput.value, skill: els.skillInput.value, style: els.styleInput.value, ratio: els.ratioInput.value, theme: els.themeInput.value, group: els.groupInput.value, category: els.categoryInput.value, business_fields: businessFields } });
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

/**
 * The sidebar keeps only the busiest collections; the complete list lives in the
 * filter panel so the two surfaces stop duplicating the same long list.
 */
function renderSidebarGroups() {
  if (!els.sidebarGroupList) return;
  const all = state.groups.groups;
  const shown = all.slice(0, SIDEBAR_GROUP_LIMIT);
  const items = shown.map(([name, count]) => {
    const active = state.facets.group === name;
    return `<li><button class="nav-item nav-group-item${active ? " active" : ""}" data-filter="group" data-value="${escapeHtml(name)}" type="button" aria-pressed="${active}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-10Z"/></svg><span class="nav-item-text" title="${escapeHtml(name)}">${escapeHtml(name)}</span><span class="nav-count">${count}</span></button></li>`;
  }).join("");
  const overflow = all.length > shown.length
    ? `<li><button class="nav-item nav-group-more" type="button" data-action="open-all-groups">${escapeHtml(t("allGroups", { count: all.length }))}</button></li>`
    : "";
  els.sidebarGroupList.innerHTML = `${items}${overflow}`;
}

function matchesFacetQuery(name) {
  const needle = state.facetQuery.trim().toLowerCase();
  if (!needle) return true;
  return String(name).toLowerCase().includes(needle) || humanizeFacetValue(name).toLowerCase().includes(needle);
}

function renderFilterPanel() {
  if (!els.sourceFilters) return;
  const activeSource = state.facets.source;
  const sources = [
    ["all", t("filterAll"), state.groups.total, ""],
    ["codex", t("filterCodex"), state.groups.codex, SOURCE_FACETS.codex],
    ["cowart", t("filterCowart"), state.groups.cowart, SOURCE_FACETS.cowart],
    ["grok", t("filterGrok"), state.groups.grok, SOURCE_FACETS.grok],
  ];
  els.sourceFilters.innerHTML = sources.map(([type, label, count, value]) => {
    const active = value ? activeSource === value : !activeSource;
    return `<button class="filter-pill${active ? " active" : ""}" data-filter="${type}" type="button" aria-pressed="${active}">${escapeHtml(label)} <span>${count}</span></button>`;
  }).join("");
  renderFilterList(els.groupList, state.groups.groups, "group", t("noGroups"));
  renderFilterList(els.categoryList, state.groups.categories, "category", t("noCategories"));
  renderFilterList(els.styleList, state.groups.styles, "style", t("noStyles"));
  renderFacetTruncationHint();
}

/** A capped facet list has to say so rather than looking complete. */
function renderFacetTruncationHint() {
  if (!els.styleTruncated) return;
  const total = Number(state.groups.styleTotal || 0);
  const shown = state.groups.styles.length;
  const truncated = total > shown;
  els.styleTruncated.hidden = !truncated;
  els.styleTruncated.textContent = truncated ? t("facetTruncated", { shown, total }) : "";
}

function renderFilterList(element, values, type, emptyText) {
  if (!element) return;
  if (!values.length) { element.innerHTML = `<li class="filter-empty">${escapeHtml(emptyText)}</li>`; return; }
  const visible = values.filter(([name]) => matchesFacetQuery(name));
  if (!visible.length) { element.innerHTML = `<li class="filter-empty">${escapeHtml(t("facetNoMatch"))}</li>`; return; }
  element.innerHTML = visible.map(([name, count]) => {
    const active = state.facets[type] === name;
    const label = humanizeFacetValue(name);
    // `title` keeps the stored value reachable when the display name differs.
    return `<li><button class="filter-list-item${active ? " active" : ""}" data-filter="${type}" data-value="${escapeHtml(name)}" type="button" aria-pressed="${active}" title="${escapeHtml(name)}"><span>${escapeHtml(label)}</span><span>${count}</span></button></li>`;
  }).join("");
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
    const date = formatDate(asset.created_at);
    const selected = asset.id === state.selectedId;
    const media = assetMediaPreviewMarkup(asset, "thumb");
    // Short, structured label instead of the full prompt.
    const label = t("cardAccessibleName", { title: title || asset.id, source: sourceLabel, date });
    const versionIndex = Number(asset.version_index) || 0;
    const badge = versionIndex > 1 ? t("versionLabelShort", { number: versionIndex }) : (asset.group || "");
    const info = `<div class="asset-card-info"><p class="asset-card-title" title="${escapeHtml(title)}">${escapeHtml(title)}</p><p class="asset-card-meta"><span>${escapeHtml(sourceLabel)}</span><span>${escapeHtml(date)}</span>${badge ? `<span class="asset-card-badge" title="${escapeHtml(badge)}">${escapeHtml(badge)}</span>` : ""}</p></div>`;
    const isFav = asset.favorite;
    const isChecked = state.batchMode && state.selectedIds.has(asset.id);
    const checkbox = state.batchMode ? `<input type="checkbox" class="card-checkbox" ${isChecked ? "checked" : ""} data-batch-id="${escapeHtml(asset.id)}" aria-label="${escapeHtml(t("selectAsset"))}" />` : "";
    const favoriteLabel = isFav ? t("removeFavorite") : t("addFavorite");
    // Phase 1C/1C.1 契约：.card-actions > button.card-action-btn.card-favorite / .card-quick-copy，
    // 业务 class 与 data 属性全部保留（现有事件绑定依赖）；aria-pressed 表达收藏态。
    // Phase 1C.1：批量模式原生 disabled——退出 Tab 顺序、不可执行、不派发点击；
    // 退出批量后 renderGrid 重渲染自动移除，单卡操作恢复可用。
    const batchDisabled = state.batchMode ? " disabled" : "";
    const favBtn = `<button class="card-action-btn card-favorite${isFav ? " is-fav" : ""}" type="button"${batchDisabled} data-fav-id="${escapeHtml(asset.id)}" aria-pressed="${Boolean(isFav)}" aria-label="${escapeHtml(favoriteLabel)}" title="${escapeHtml(favoriteLabel)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2.5l2.95 5.97 6.59.96-4.77 4.65 1.13 6.57L12 17.57l-5.9 3.08 1.13-6.57-4.77-4.65 6.59-.96L12 2.5z"/></svg></button>`;
    const copyBtn = `<button class="card-action-btn card-quick-copy" type="button"${batchDisabled} data-copy="${escapeHtml(asset.prompt || "")}" data-i18n-title="copyPrompt" title="${t("copyPrompt")}" aria-label="${t("copyPrompt")}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9"/></svg></button>`;
    const cardActions = `<div class="card-actions">${favBtn}${copyBtn}</div>`;
    return `<article class="asset-card${selected ? " selected" : ""}${isVideoAsset(asset) ? " is-video" : ""}${animateCard ? " card-enter" : ""}" data-id="${escapeHtml(asset.id)}" title="${escapeHtml(cardShortTitle(asset))}">${checkbox}<button class="asset-card-select" type="button" aria-pressed="${selected}" aria-label="${escapeHtml(label)}">${media}</button>${info}${cardActions}</article>`;
  }).join("");
  els.assetGrid.innerHTML = `${cards}${state.nextCursor ? `<div class="asset-load-more"><button type="button" data-action="load-more">${t("loadMore")}</button></div>` : ""}`;
  setupMasonryLayout();
  els.assetGrid.querySelectorAll(".asset-card-select").forEach((button) => {
    // Phase 3A / D4：单击卡片主体进入专用大图查看模式；批量模式下单击保持批量选择优先。
    button.addEventListener("click", () => {
      const id = button.closest(".asset-card")?.dataset.id;
      if (!id) return;
      if (state.batchMode) { toggleAssetSelection(id); return; }
      openAssetView(id, button);
    });
    // 双击统一进入同一查看模式，不再弹出旧 lightbox 竞争（旧 lightbox 业务代码保留不删）。
    button.addEventListener("dblclick", () => {
      const id = button.closest(".asset-card")?.dataset.id;
      if (id && !state.batchMode) openAssetView(id, button);
    });
  });
  els.assetGrid.querySelectorAll(".card-quick-copy").forEach((button) => button.addEventListener("click", async (event) => { event.stopPropagation(); await runAction(async () => { await navigator.clipboard.writeText(button.dataset.copy || ""); showToast(t("copySuccess"), "success"); }); }));
  els.assetGrid.querySelectorAll(".card-favorite").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); void toggleFavorite(button.dataset.favId, event); }));
  els.assetGrid.querySelectorAll(".card-checkbox").forEach((checkbox) => checkbox.addEventListener("change", (event) => { void toggleAssetSelection(checkbox.dataset.batchId, event); }));
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
  state.detailOpen = Boolean(open); els.appShell?.classList.toggle("details-open", state.detailOpen); els.detailPanel?.setAttribute("aria-hidden", String(!state.detailOpen));
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
  const title = asset.theme || asset.asset || asset.id;
  if (els.assetViewScope) els.assetViewScope.textContent = currentScopeTitle();
  if (els.assetViewTitle) els.assetViewTitle.textContent = t("viewingAsset", { title });
  if (els.assetViewError) els.assetViewError.hidden = true;
  // Phase 3B：切换素材即重置为 fit（不继承上一张的缩放位置）；同一素材的重渲染
  // （后台刷新/语言切换）保持当前 transform 不动。
  if (asset.id !== assetViewStageAssetId) {
    assetViewStageAssetId = asset.id;
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
  if (els.assetViewImage.dataset.assetId !== asset.id) {
    // Phase 3C 竞态防护：以素材 ID 为唯一会话键（同 URL 重复变体间导航也算切换）——
    // src 与 ID 守卫/结算标记同步切换，晚到的旧 load/error 事件据此被识别并丢弃。
    els.assetViewImage.dataset.assetId = asset.id;
    els.assetViewImage.dataset.loadSettled = "";
    if (els.assetViewImage.getAttribute("src") !== asset.image_url) els.assetViewImage.src = asset.image_url;
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
  if (!id || state.batchMode || state.viewMode === "asset") return;
  const originProjectId = state.project;
  const originAssetId = state.selectedId;
  if (!await confirmDetailNavigation(id)) return;
  // Phase 5B context guard：确认期间 Detail 选择已变化时安全取消，不进入查看模式。
  if (originAssetId !== null && !isCurrentDetailSelection(originProjectId, originAssetId)) return;
  // 画廊上下文快照：真实滚动容器的 scrollTop（经 getLibraryScrollContainer 解析）；
  // requestKey 标识结果集语义，查看期间搜索/筛选/排序/项目变化时恢复自动降级。
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
  state.selectedId = id; state.detailAsset = null; state.versionHistory = null; state.recipeHistory = null;
  setViewMode("asset");
  setupAssetViewInteraction();
  renderAssetView();
  updateAssetViewNav();
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
  assetViewStageAssetId = null;
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
  setViewMode("library");
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
      setupMasonryLayout();
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
let assetViewInteractionActive = false;
let assetViewStageObserver = null;
let assetViewPanSession = null;
const assetViewActivePointers = new Map();
let assetViewPinchSession = null;

// ----- 集中式纯几何 helper：事件处理器只组装输入，不复制公式 -----
// 舞台可用几何 = content box（clientWidth/Height 去掉 padding），与 contain 语义一致。
function assetViewStageSize() {
  const stage = els.assetViewStage;
  if (!stage) return { width: 0, height: 0 };
  const styles = getComputedStyle(stage);
  const width = stage.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
  const height = stage.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

function assetViewNaturalSize() {
  const image = els.assetViewImage;
  if (!image || !(image.naturalWidth > 0) || !(image.naturalHeight > 0)) return { width: 0, height: 0 };
  return { width: image.naturalWidth, height: image.naturalHeight };
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
  const stage = els.assetViewStage;
  if (!stage) return { x: 0, y: 0 };
  const rect = stage.getBoundingClientRect();
  const styles = getComputedStyle(stage);
  const paddingLeft = parseFloat(styles.paddingLeft);
  const paddingTop = parseFloat(styles.paddingTop);
  const size = assetViewStageSize();
  return {
    x: clientX - rect.left - paddingLeft - size.width / 2,
    y: clientY - rect.top - paddingTop - size.height / 2,
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

function setAssetViewScale(targetScale, pointerX = 0, pointerY = 0, { announce = false } = {}) {
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
  applyAssetViewTransform();
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
  announceGalleryStatus(t("zoomResetDone"));
  return true;
}

// 切换素材/错误兜底：回到 fit 语义并清理内联几何与瞬时 pointer 状态（不持久化缩放记忆）。
function resetAssetViewTransform() {
  cancelAssetViewPan();
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
  image.dataset.loadSettled = "load";
  // 元素几何=自然尺寸，transform scale 以此为唯一基准（rendered = natural × scale）。
  image.style.width = `${image.naturalWidth}px`;
  image.style.height = `${image.naturalHeight}px`;
  fitAssetView();
}

function handleAssetViewWheel(event) {
  // 仅 Asset mode 且图片就绪时接管；Library mode、Modal/Lightbox/面板打开时一律放行
  // （不 preventDefault），不拦截应用其他区域滚动。
  if (state.viewMode !== "asset" || !assetViewImageReady()) return;
  if (!els.imagePreviewModal?.hidden || els.importModal?.classList.contains("open") || els.groupModal?.classList.contains("open")) return;
  if (!els.filterPanel?.hidden || !els.settingsMenu?.hidden) return;
  event.preventDefault();
  // 乘法步进与按钮一致（每 100 deltaY 一个 ×1.2 档）；普通滚轮与浏览器映射的 pinch
  // wheel（小 delta 连续事件）共用同一指针中心公式，滚轮方向沿用旧 Lightbox（上滚放大）。
  const factor = Math.pow(ASSET_VIEW_ZOOM_STEP, -event.deltaY / 100);
  const pointer = assetViewStagePointer(event.clientX, event.clientY);
  zoomAssetViewBy(factor, pointer.x, pointer.y);
}

function handleAssetViewPointerDown(event) {
  if (state.viewMode !== "asset" || !assetViewImageReady()) return;
  if (event.pointerType === "mouse" && (!event.isPrimary || event.button !== 0)) return;
  if (event.target.closest(".asset-view-controls")) return;
  if (assetViewActivePointers.has(event.pointerId)) return;
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
  applyAssetViewTransform();
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
  applyAssetViewTransform();
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
  stage.removeEventListener("wheel", handleAssetViewWheel);
  stage.removeEventListener("pointerdown", handleAssetViewPointerDown);
  stage.removeEventListener("pointermove", handleAssetViewPointerMove);
  stage.removeEventListener("pointerup", handleAssetViewPointerEnd);
  stage.removeEventListener("pointercancel", handleAssetViewPointerEnd);
  assetViewStageObserver?.disconnect();
  assetViewStageObserver = null;
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

// 缺失或失效 ID（后台刷新后不再存在于当前结果集）在导航时跳过；绝不回退到全素材，
// 也不重新运行用户的搜索/筛选/排序条件。
function assetViewSequenceHasAsset(id) {
  return state.assets.some((asset) => asset.id === id);
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
    const previousLength = state.assets.length;
    const incoming = (result.assets || []).filter((asset) => !state.assets.some((current) => current.id === asset.id));
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
    renderGrid({ animate: true, animateFrom: previousLength });
    updateViewTitle();
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
  const currentId = ids[assetViewSequence.index];
  const validCount = ids.filter((id) => assetViewSequenceHasAsset(id)).length;
  const total = Math.max(assetViewSequence.total, validCount);
  const position = state.viewMode === "asset" && assetViewSequenceHasAsset(currentId)
    ? ids.slice(0, assetViewSequence.index + 1).filter((id) => assetViewSequenceHasAsset(id)).length
    : 0;
  if (els.assetViewPosition) els.assetViewPosition.textContent = position > 0 ? `${position} / ${total}` : "—";
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
  assetViewSequence.index = nextIndex;
  state.selectedId = id;
  state.detailAsset = null;
  state.versionHistory = null;
  state.recipeHistory = null;
  renderAssetView();
  renderDetail();
  updateSelectedCard();
  updateAssetViewNav();
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

function openImportModal() {
  state.modalReturnFocus = document.activeElement;
  clearImportErrors();
  setImportBusy(false);
  els.importModal?.classList.add("open");
  els.importModal?.setAttribute("aria-hidden", "false");
  // Focused synchronously: an animation frame never runs while the window is hidden.
  els.imagePathInput?.focus();
}
function closeImportModal() { announceGalleryStatus(""); els.importModal?.classList.remove("open"); els.importModal?.setAttribute("aria-hidden", "true"); if (state.modalReturnFocus instanceof HTMLElement) state.modalReturnFocus.focus(); state.modalReturnFocus = null; }
function openGroupModal() { state.modalReturnFocus = document.activeElement; els.groupModal?.classList.add("open"); els.groupModal?.setAttribute("aria-hidden", "false"); if (els.groupNameInput) els.groupNameInput.value = ""; requestAnimationFrame(() => els.groupNameInput?.focus()); }
function closeGroupModal() { els.groupModal?.classList.remove("open"); els.groupModal?.setAttribute("aria-hidden", "true"); if (state.modalReturnFocus instanceof HTMLElement) state.modalReturnFocus.focus(); state.modalReturnFocus = null; }

// ===== Confirm Dialog（Phase 5B / F-15） =====
// 全应用唯一 ConfirmDialog：批量归档/单素材归档/放弃未保存修改/受限参考图再生四条路径
// 均经 requestConfirmation；不持久化到 state/localStorage/素材数据，不建确认队列，
// 不建第二套 Modal Manager。
const confirmDialogState = { pending: false, resolve: null, returnFocus: null, triggerElement: null, contextKey: null };

// 单 pending 策略：已有确认显示时，新请求直接返回 false——不排队、第二个请求不覆盖
// 第一个 resolver，两个不同业务绝不共享同一确认结果（重复快速点击不叠加第二个 Modal）。
function requestConfirmation({ title = "", description = "", confirmLabel = "", cancelLabel = "", tone = "danger", returnFocus = null, contextKey = null } = {}) {
  if (confirmDialogState.pending || !els.confirmDialog) return Promise.resolve(false);
  // 打开前：1）保存当前焦点元素；2）经 Phase 5A manager 的公开关闭能力关闭 Filter/Settings/
  // Language（不直接修改 manager 私有 rootId/childId；reason 不触发浮层 return focus）。
  confirmDialogState.triggerElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  closePanel(els.filterPanel, els.filterToggle, "confirm-dialog");
  closePanel(els.settingsMenu, els.settingsToggle, "confirm-dialog");
  // 3）填充标题/说明/按钮文案与 tone；4）打开 overlay。
  if (els.confirmDialogTitle) els.confirmDialogTitle.textContent = title;
  if (els.confirmDialogDescription) els.confirmDialogDescription.textContent = description;
  if (els.confirmDialogConfirm) {
    els.confirmDialogConfirm.textContent = confirmLabel;
    // tone：danger → DestructiveButton 红色 outline；warning → primary 层级（品牌蓝），不误用归档红色语义。
    els.confirmDialogConfirm.classList.toggle("btn-danger", tone === "danger");
    els.confirmDialogConfirm.classList.toggle("btn-primary", tone !== "danger");
  }
  if (els.confirmDialogCancel) els.confirmDialogCancel.textContent = cancelLabel || t("cancel");
  if (els.confirmDialogCard) els.confirmDialogCard.dataset.tone = tone === "danger" ? "danger" : "warning";
  confirmDialogState.pending = true;
  confirmDialogState.returnFocus = returnFocus instanceof HTMLElement ? returnFocus : null;
  confirmDialogState.contextKey = contextKey;
  // The dialog sits outside #appShell; inert keeps the complete application
  // background out of assistive-technology and keyboard navigation while it is open.
  els.appShell?.setAttribute("inert", "");
  els.confirmDialog.classList.add("open");
  els.confirmDialog.setAttribute("aria-hidden", "false");
  return new Promise((resolve) => {
    confirmDialogState.resolve = resolve;
    // 默认焦点落 Cancel——破坏性操作不得默认聚焦确认按钮；焦点不落容器或 body。
    requestAnimationFrame(() => { if (confirmDialogState.pending) els.confirmDialogCancel?.focus(); });
  });
}

function closeConfirmDialog(result) {
  if (!confirmDialogState.pending) return;
  const { resolve } = confirmDialogState;
  confirmDialogState.pending = false;
  confirmDialogState.resolve = null;
  // 焦点恢复经 rAF 延后，先取走引用再清理状态。
  restoreConfirmDialogFocus(confirmDialogState.returnFocus, confirmDialogState.triggerElement, confirmDialogState.contextKey);
  confirmDialogState.returnFocus = null;
  confirmDialogState.triggerElement = null;
  confirmDialogState.contextKey = null;
  els.confirmDialog?.classList.remove("open");
  els.confirmDialog?.setAttribute("aria-hidden", "true");
  els.appShell?.removeAttribute("inert");
  // 清理临时文案与 tone，单一 Dialog 壳回到静态空壳。
  if (els.confirmDialogTitle) els.confirmDialogTitle.textContent = "";
  if (els.confirmDialogDescription) els.confirmDialogDescription.textContent = "";
  if (els.confirmDialogConfirm) {
    els.confirmDialogConfirm.textContent = "";
    els.confirmDialogConfirm.classList.remove("btn-danger");
    els.confirmDialogConfirm.classList.add("btn-primary");
  }
  delete els.confirmDialogCard?.dataset.tone;
  if (resolve) resolve(result); // Confirm=true；Cancel/Escape/Backdrop=false；resolver 只结算一次
}

// 焦点恢复目标必须仍连接、非 disabled、非 hidden 且可见；body 不在候选之列。
function isConfirmFocusTarget(element) {
  return element instanceof HTMLElement && element.isConnected && !element.disabled && !element.hidden && element.offsetParent !== null;
}

function restoreConfirmDialogFocus(returnFocus, triggerElement, contextKey) {
  requestAnimationFrame(() => {
    // 优先级 1）业务显式 returnFocus；2）打开前的 activeElement。
    for (const candidate of [returnFocus, triggerElement]) {
      if (isConfirmFocusTarget(candidate)) { candidate.focus(); return; }
    }
    // 3）对应业务入口的稳定重新查询（确认期间 Detail 可能重渲染，trigger 被新 DOM 替换）。
    const requery = contextKey?.endsWith(":archive-asset") ? els.detailPanel?.querySelector('[data-action="archive-asset"]')
      : contextKey?.endsWith(":restricted-regenerate") ? els.detailPanel?.querySelector('[data-action="regenerate"]')
      : contextKey?.endsWith(":discard-version") ? els.detailPanel?.querySelector("[data-version-select]")
      : contextKey?.endsWith(":batch-archive") ? els.batchArchive
      : null;
    if (isConfirmFocusTarget(requery)) { requery.focus(); return; }
    // 4）安全区：查看模式的返回按钮或侧栏搜索框，绝不落回 body。
    const fallback = state.viewMode === "asset" ? els.assetViewBack : els.searchInput;
    if (isConfirmFocusTarget(fallback)) fallback.focus();
  });
}

function trapConfirmDialogFocus(event) {
  if (!confirmDialogState.pending) return;
  if (event.key === "Escape") {
    // Escape 优先级链最前：消费后不穿透 Viewer/既有 Modal/锚定浮层（后续监听器
    // 经 defaultPrevented 检查，与既有 Modal 陷阱同先例）。
    event.preventDefault();
    event.stopPropagation();
    closeConfirmDialog(false);
    return;
  }
  if (event.key !== "Tab") return;
  // Tab 在 Cancel/Confirm 之间正/反向循环；Enter/Space 保持聚焦原生按钮的默认行为，
  // 无全局 Enter 自动确认。
  const focusable = [els.confirmDialogCancel, els.confirmDialogConfirm].filter((button) => button && !button.disabled);
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
    const result = await api("/api/groups", { method: "POST", body: { projectId: state.project, name } });
    closeGroupModal();
    await loadStats();
    showToast(`${t("groupCreated")}${result.group.name}`, "success");
    state.facets.group = result.group.name;
    state.nextCursor = null;
    clearDetailSelection();
    renderQuickFilters(); renderFilterPanel(); renderActiveFilters(); await loadAssets();
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
  const offsets = clampImagePreviewOffsets(state.imageZoom, state.imagePanX, state.imagePanY);
  state.imagePanX = offsets.offsetX;
  state.imagePanY = offsets.offsetY;
  applyImageTransform();
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

const COPY_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9"/></svg>`;

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
  // Phase 4A：批准的单栏信息架构——十个语义区块按固定顺序渲染（文件事实/收藏/Prompt/
  // 来源/版本/分组/标签/Cowart/新版本/更多），无 tab 角色、无隐藏面板、唯一纵向滚动容器。
  els.detailPanel.innerHTML = `<div class="detail-inspector"><div class="detail-inspector-header"><span>${t("assetInspector")}</span><button class="detail-close" type="button" data-action="close-detail" aria-label="${t("close")}">${t("close")}</button></div><div class="detail-inspector-scroll">${detailFileSectionMarkup(asset)}${detailFavoriteSectionMarkup(asset)}${detailPromptSectionMarkup(asset)}${detailSourceSectionMarkup(asset)}${detailVersionSectionMarkup(asset, cachedHistory, cachedRecipeHistory)}${detailGroupSectionMarkup(asset)}${detailTagsSectionMarkup()}${detailCowartSectionMarkup()}${detailNewVersionSectionMarkup()}${detailMoreSectionMarkup(asset)}</div></div>`;
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

// ===== Phase 4A：单栏检视器区块 markup helper =====
// 纯展示 helper：只生成 markup 或格式化显示值；不发 API 请求、不绑定事件、不引入新
// 状态层。事件继续集中在 bindDetailEvents 与既有小型绑定函数中处理。
//
// 文件事实推导规则（集中在此，任务书第六节）：
// - 尺寸 / 大小：服务端当前无持久化字段（width/height/size_bytes 均不下发），恒回退
//   「未记录」；不用 naturalWidth 伪装持久化事实、不发 HEAD 请求、不把 business_fields
//   自填 JSON 冒充文件事实、不显示 0 × 0 / NaN / undefined。
// - 格式：仅当扩展名明确时确定性推导（大写扩展名），否则回退「未记录」。
function fileDimensionsText(asset) {
  const width = Number(asset?.width);
  const height = Number(asset?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return `${Math.round(width)} × ${Math.round(height)}`;
}

function fileFormatText(asset) {
  const match = /\.([a-z0-9]+)(?:$|\?)/i.exec(String(asset?.image_path || asset?.asset || ""));
  return match ? match[1].toUpperCase() : null;
}

function fileSizeText(asset) {
  const bytes = Number(asset?.size_bytes);
  return Number.isFinite(bytes) && bytes > 0 ? formatFileSize(bytes) : null;
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function fileFactRowMarkup(key, value) {
  return `<div class="meta-row"><span class="meta-key">${t(key)}</span><span class="meta-val">${value === null ? `<span class="empty-copy">${t("notRecorded")}</span>` : escapeHtml(value)}</span></div>`;
}

function detailFileSectionMarkup(asset) {
  const title = asset.theme || asset.asset || asset.id;
  const facts = [["fileDimensions", fileDimensionsText(asset)], ["fileFormat", fileFormatText(asset)], ["fileSize", fileSizeText(asset)]].map(([key, value]) => fileFactRowMarkup(key, value)).join("");
  return `<section class="inspector-section" data-inspector-section="file"><div class="detail-image-wrap">${assetMediaPreviewMarkup(asset, "detail")}</div><div class="detail-head"><h3 id="detailTitle" tabindex="-1" title="${escapeHtml(title)}">${escapeHtml(title)}</h3><p>${escapeHtml(asset.id)} · ${formatDate(asset.created_at)}</p></div><div class="detail-facts" role="group" aria-label="${escapeHtml(t("fileFacts"))}"><div class="meta-table">${facts}</div></div></section>`;
}

function detailFavoriteSectionMarkup(asset) {
  const favorite = Boolean(asset.favorite);
  return `<section class="inspector-section inspector-section-compact" data-inspector-section="favorite"><button class="detail-fav-btn${favorite ? " is-fav" : ""}" type="button" data-action="toggle-favorite" aria-pressed="${favorite}"><span aria-hidden="true">${favorite ? "★" : "☆"}</span> ${t(favorite ? "removeFavorite" : "addFavorite")}</button></section>`;
}

function detailPromptSectionMarkup(asset) {
  const source = asset.source || {};
  const promptUnavailable = (source.type === "web-chatgpt" || asset.source_type === "web-chatgpt")
    && source.prompt_status === "not-available";
  const promptText = asset.prompt
    ? escapeHtml(asset.prompt)
    : `<span class="empty-copy">${t(promptUnavailable ? "chatgptPromptUnavailable" : "notRecorded")}</span>`;
  // Prompt 不存在时复制按钮不渲染（避免死按钮与空复制成功提示）；用户指令作为独立子段，
  // 不伪装成生成 Prompt；复制 Prompt 只复制生成 Prompt。
  const copyButton = asset.prompt
    ? `<button class="section-head-copy" type="button" data-action="copy-prompt" title="${t("copyPrompt")}" aria-label="${t("copyPrompt")}">${COPY_ICON_SVG}</button>`
    : "";
  const userInstruction = String(source.user_message || asset.business_fields?.user_message || "").trim();
  const userInstructionMarkup = userInstruction
    ? `<div class="user-instruction"><div class="section-head"><h4>${t("userInstruction")}</h4></div><div class="prompt-box">${escapeHtml(userInstruction)}</div></div>`
    : "";
  return `<section class="inspector-section" data-inspector-section="prompt"><div class="section-head"><h4>${t("prompt")}</h4>${copyButton}</div><div class="prompt-box">${promptText}</div>${userInstructionMarkup}<details class="detail-disclosure"><summary>${t("recipeAndEditing")}</summary><div class="disclosure-content detail-fields">${editRecipeFieldsMarkup(asset)}<label class="field recipe-change-field"><span>${t("recipeChangeSummary")}</span><textarea data-recipe-change rows="2" placeholder="${escapeHtml(t("recipeChangePlaceholder"))}"></textarea></label><div class="recipe-save-actions"><button class="recipe-save-btn secondary" type="button" data-action="save-recipe">${t("saveRecipe")}</button></div></div></details></section>`;
}

function editRecipeFieldsMarkup(asset) {
  const rating = Math.min(5, Math.max(0, Math.round(asset.rating || 0)));
  const groupOptions = state.groups.groups.map(([name]) => `<option value="${escapeHtml(name)}"></option>`).join("");
  return `<label class="field"><span>${t("prompt")}</span><textarea data-edit="prompt" rows="5">${escapeHtml(asset.prompt || "")}</textarea></label><div class="two"><label class="field"><span>${t("skill")}</span><input data-edit="skill" value="${escapeHtml(asset.skill || "")}" /></label><label class="field"><span>${t("style")}</span><input data-edit="style" value="${escapeHtml(asset.style || "")}" /></label></div><div class="two"><label class="field"><span>${t("ratio")}</span><input data-edit="ratio" value="${escapeHtml(asset.ratio || "")}" /></label><label class="field"><span>${t("theme")}</span><input data-edit="theme" value="${escapeHtml(asset.theme || "")}" /></label></div><div class="two"><label class="field"><span>${t("group")}</span><input data-edit="group" value="${escapeHtml(asset.group || "")}" list="groupSuggestionsEdit" /><datalist id="groupSuggestionsEdit">${groupOptions}</datalist></label><label class="field"><span>${t("category")}</span><select data-edit="category"><option value="">${t("none")}</option>${categoryOptions(asset.category)}</select></label></div><label class="field"><span>${t("rating")}</span><div class="rating-edit" data-edit="rating">${[1,2,3,4,5].map((number) => `<button type="button" data-val="${number}" class="${number <= rating ? "on" : ""}" aria-label="${number}/5">${number <= rating ? "★" : "☆"}</button>`).join("")}</div></label><label class="field"><span>${t("businessFields")}</span><textarea data-edit="business_fields" rows="3">${escapeHtml(JSON.stringify(asset.business_fields || {}, null, 2))}</textarea></label>`;
}

function detailSourceSectionMarkup(asset) {
  const source = asset.source || {};
  const sourceRows = buildSourceRows(source).filter(([, value]) => value !== undefined && value !== null && value !== "");
  const rowsMarkup = sourceRows.length
    ? `<div class="meta-table">${sourceRows.map(([key, value]) => `<div class="meta-row"><span class="meta-key">${t(key)}</span><span class="meta-val source-value">${escapeHtml(value)}</span></div>`).join("")}</div>`
    : `<p class="empty-copy">${t("notRecorded")}</p>`;
  // 复制来源入口仅在有明确可复制值（原始路径）时渲染；取值与点击复制共用 sourceCopyValue。
  const copyButton = sourceCopyValue(source)
    ? `<button class="section-head-copy" type="button" data-action="copy-source" title="${t("copyOriginalPath")}" aria-label="${t("copyOriginalPath")}">${COPY_ICON_SVG}</button>`
    : "";
  return `<section class="inspector-section" data-inspector-section="source"><div class="section-head"><h4>${t("sourceInfo")}</h4>${copyButton}</div>${rowsMarkup}<details class="detail-disclosure" data-reference-rights-section><summary>${t("referenceRights")}</summary><div class="disclosure-content" data-reference-rights>${referenceRightsMarkup(asset)}</div></details></section>`;
}

function detailVersionSectionMarkup(asset, cachedHistory, cachedRecipeHistory) {
  return `<section class="inspector-section" data-inspector-section="version"><div class="section-head"><h4>${t("tabVersions")}</h4></div><div class="version-picker" data-version-picker>${versionPickerMarkup(asset, cachedHistory)}</div><details class="detail-disclosure"><summary>${t("versionHistory")}</summary><div class="disclosure-content version-history-region" data-version-history aria-live="polite">${cachedHistory ? versionHistoryMarkup(cachedHistory, asset.id) : `<p class="version-history-status" role="status">${t("versionLoading")}</p>`}</div></details>${recipeHistoryDisclosureMarkup(cachedRecipeHistory)}</section>`;
}

// Phase 4B：版本选择器——原生 <select>（无自制 popover/listbox/菜单、无第三方 Select、
// 无新依赖）。option value 为素材 ID，显示文本用 versionLabelShort（Vn），归档版本追加
// archivedVersion 文字标记；完整变更说明在选择器下方（复用 detailVersionSummaryMarkup）。
// 五态模型：加载中 disabled + aria-busy 且显示当前 Vn；单版本 disabled；多版本 enabled
// 且 option 遵循 API 顺序；错误保留当前版本单选 disabled 且摘要/版本区不清空；缺
// version_index 回退当前版本/标题文案，不显示 VNaN/V0/undefined。
function versionPickerMarkup(asset, history, error = null) {
  const versions = error ? [] : (history?.versions || []);
  const options = versions.length ? versions : [asset];
  const multiple = versions.length > 1;
  const busy = !error && !history;
  const selectOptions = options.map((version) => `<option value="${escapeHtml(version.id)}"${version.id === asset.id ? " selected" : ""}>${escapeHtml(versionOptionLabel(version, version.id === asset.id))}</option>`).join("");
  return `<label class="visually-hidden" for="versionSelect">${t("versionPickerLabel")}</label><select id="versionSelect" data-version-select${multiple ? "" : " disabled"}${busy ? ' aria-busy="true"' : ""}>${selectOptions}</select>${detailVersionSummaryMarkup(asset)}`;
}

function versionOptionLabel(version, selected) {
  const index = Number(version?.version_index);
  const label = Number.isFinite(index) && index > 0
    ? t("versionLabelShort", { number: index })
    : (selected ? t("currentVersion") : String(version?.theme || version?.asset || version?.id || ""));
  return version?.archived ? `${label} · ${t("archivedVersion")}` : label;
}

function detailVersionSummaryMarkup(asset) {
  const index = Number(asset.version_index);
  const label = Number.isFinite(index) && index > 0 ? t("versionLabel", { number: index }) : "";
  const change = asset.version_change || (index === 1 ? t("initialVersion") : t("noVersionChange"));
  return `<div class="version-summary"><span class="version-summary-label">${label ? `<strong>${escapeHtml(label)}</strong>` : ""}<span class="version-current">${t("currentVersion")}</span></span><span class="version-change">${escapeHtml(change)}</span></div>`;
}

function detailGroupSectionMarkup(asset) {
  const group = String(asset.group || "").trim();
  return `<section class="inspector-section inspector-section-compact" data-inspector-section="group"><div class="section-head"><h4>${t("group")}</h4></div><p class="inspector-readout">${group ? escapeHtml(group) : `<span class="empty-copy">${t("notGrouped")}</span>`}</p></section>`;
}

// D2 冻结：标签保留右栏第 7 位，但当前没有标签数据模型——只显示书面占位说明，
// 不渲染假标签 / 随机 chip / disabled 输入框 / 添加按钮。
function detailTagsSectionMarkup() {
  return `<section class="inspector-section" data-inspector-section="tags"><div class="section-head"><h4>${t("tags")}</h4></div><p class="empty-copy">${t("tagsUnavailable")}</p></section>`;
}

function detailCowartSectionMarkup() {
  return `<section class="inspector-section" data-inspector-section="cowart"><div class="section-head"><h4>${t("insertCowart")}</h4></div><div class="cowart-insert-slot"></div></section>`;
}

function detailNewVersionSectionMarkup() {
  return `<section class="inspector-section" data-inspector-section="new-version"><div class="section-head"><h4>${t("createNewVersion")}</h4></div><label class="field version-change-field"><span>${t("versionChange")}</span><textarea data-version-change rows="2" placeholder="${escapeHtml(t("versionChangePlaceholder"))}"></textarea></label><div class="new-version-actions"><button class="recipe-save-btn secondary" type="button" data-action="save-version">${t("saveAsVersion")}</button></div></section>`;
}

// Phase 4C：App/Web 原图能力集中判定——desktop-finder（Electron 注入 showItemInFolder 且
// image_path 为有效非空路径）/ web-open（无桌面能力且 image_url 非空，真实 <a> 新标签页）/
// unavailable（不渲染死按钮）。同一素材绝不同时表达两套入口；Web 不伪装 Finder 能力。
function originalMediaCapability(asset) {
  const imagePath = String(asset?.image_path || "").trim();
  if (typeof window.electronAPI?.showItemInFolder === "function" && imagePath) return "desktop-finder";
  const imageUrl = String(asset?.image_url || "").trim();
  if (imageUrl) return "web-open";
  return "unavailable";
}

function originalMediaActionMarkup(asset) {
  const capability = originalMediaCapability(asset);
  if (capability === "desktop-finder") return `<button class="action-btn secondary" type="button" data-action="show-in-finder">${t("showInFinder")}</button>`;
  if (capability === "web-open") return `<a class="action-btn secondary original-media-link" href="${escapeHtml(asset.image_url)}" target="_blank" rel="noopener noreferrer">${t("openOriginal")}</a>`;
  return `<p class="empty-copy original-media-unavailable">${t("originalUnavailable")}</p>`;
}

// Phase 4C More 终态：显式原图入口默认可见（App「在 Finder 中显示」/ Web「打开原图」/
// 「原图不可用」，三选一）+ 原生 details「更多操作」（regenerate / copy-path / 图片位置）+
// 独立 danger 区（归档）。无省略号菜单、无 popover、无三点图标；copy-path 无路径不渲染。
function detailMoreSectionMarkup(asset) {
  const imagePath = String(asset.image_path || "").trim();
  const copyPathAction = imagePath
    ? `<button class="action-btn secondary" type="button" data-action="copy-path">${t("copyPath")}</button>`
    : "";
  const locationValue = imagePath
    ? escapeHtml(asset.image_path)
    : `<span class="empty-copy">${t("notRecorded")}</span>`;
  return `<section class="inspector-section" data-inspector-section="more"><div class="section-head"><h4>${t("originalAndMore")}</h4></div><div class="original-media-action">${originalMediaActionMarkup(asset)}</div><details class="detail-disclosure" data-more-actions><summary>${t("moreActions")}</summary><div class="disclosure-content"><div class="detail-utility-actions"><button class="action-btn secondary" type="button" data-action="regenerate">${t("regenerate")}</button>${copyPathAction}</div><div class="more-location"><span class="meta-key">${t("imageLocation")}</span><div class="path-box detail-path-box">${locationValue}</div></div></div></details><div class="detail-danger-actions"><button class="action-btn danger" type="button" data-action="archive-asset">${t("batchArchive")}</button></div></section>`;
}

let versionHistoryRequestSequence = 0;

// Phase 4C Busy 终态：插入按钮与目标 select 同时禁用、控件 aria-busy="true"、按钮文案
// 切到「正在插入」（insertingCowart）；恢复只在控件仍连接且仍属当前素材时由调用方触发
//（finally 守卫），可用性本身仍由 state.cowartInsertAvailable 决定。
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

// 内联反馈落回当前 Detail 的状态行：只对应当前 project + asset；无反馈时隐藏。
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
    const result = await api(`/api/assets/${encodeURIComponent(asset.project_id)}/${encodeURIComponent(asset.id)}/versions`);
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

// picker 与 history 两个区域同次响应各自局部重建：不重建整个 Detail、不丢滚动、不关
// 其他 disclosure；innerHTML 重建使旧事件随旧 DOM 销毁，重复异步响应不叠加事件。
// picker 重建前若焦点已在其中（版本切换后 rAF 聚焦的 select 会被同次响应的重建销毁），
// 重建后把焦点恢复到新 select——否则响应到达时焦点会被打回 body。
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

function versionHistoryMarkup(history, selectedId) {
  const versions = history?.versions || [];
  return `<ol class="version-timeline" aria-label="${escapeHtml(t("versionHistory"))}">${versions.map((version) => {
    const selected = version.id === selectedId;
    const depth = Math.min(Math.max(Number(version.version_depth) || 0, 0), 6);
    const change = version.version_change || (version.version_index === 1 ? t("initialVersion") : t("noVersionChange"));
    return `<li class="version-timeline-item version-depth-${depth}${selected ? " selected" : ""}"><button type="button" data-version-id="${escapeHtml(version.id)}"${selected ? ' aria-current="true"' : ""}><span class="version-marker" aria-hidden="true"></span><span class="version-content"><span class="version-title"><strong>${escapeHtml(t("versionLabel", { number: version.version_index }))}</strong>${selected ? `<span class="version-current">${t("currentVersion")}</span>` : ""}${version.archived ? `<span class="version-archived">${t("archivedVersion")}</span>` : ""}</span><span class="version-change">${escapeHtml(change)}</span><time datetime="${escapeHtml(version.created_at || "")}">${escapeHtml(formatDate(version.created_at))}</time></span></button></li>`;
  }).join("")}</ol>`;
}

function bindVersionHistoryEvents(history) {
  if (!history) return;
  els.detailPanel?.querySelectorAll("[data-version-id]").forEach((button) => button.addEventListener("click", () => {
    selectDetailVersion(button.dataset.versionId);
  }));
}

// Phase 4B：集中式版本切换——版本选择器 change 与版本时间线 click 的唯一入口，顺序锁定：
// 查找目标 → 同版本 no-op → confirmDetailNavigation dirty guard（Phase 5B 起异步 await，
// 取消/异常目标/上下文失效均恢复 select 显示值）→ 更新 selectedId/detailAsset（保留
// versionHistory、清空 recipeHistory）→ updateSelectedCard → 重建 Detail 面板 → 钳制恢复
// scrollTop → rAF 聚焦新版本选择器（preventScroll 避免焦点滚动覆盖已恢复的位置）。
// 不触碰 assetViewSequence/libraryReturnSnapshot/搜索筛选排序；dirty 复用
// confirmDetailNavigation，无第二套状态。
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

function recipeHistoryDisclosureMarkup(history) {
  const content = history
    ? recipeHistoryMarkup(history)
    : `<p class="recipe-history-status" role="status">${t("recipeSnapshotLoading")}</p>`;
  // Phase 4A：单栏中完整历史默认不强行展开，按需披露（与版本历史 disclosure 一致）。
  return `<details class="detail-disclosure"><summary>${t("recipeSnapshotHistory")}</summary><div class="disclosure-content recipe-history-region" data-recipe-history aria-live="polite">${content}</div></details>`;
}

async function loadRecipeHistory(asset) {
  const requestId = ++recipeHistoryRequestSequence;
  const selectedKey = `${asset.project_id}\u0000${asset.id}`;
  try {
    const result = await api(`/api/assets/${encodeURIComponent(asset.project_id)}/${encodeURIComponent(asset.id)}/recipes`);
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

/**
 * Summarise reference rights for the snapshot badge.
 *
 * `lib/reference-rights.mjs` is the authority for this vocabulary; the browser
 * bundle cannot import it, so this mirrors its precedence rules. An explicit
 * refusal outranks an unknown here for the same reason it does there, and
 * values are normalised the same way so a hand-edited or legacy row cannot read
 * as unresolved here while the library reads it as restricted.
 */
function referenceRightsSummary(references) {
  const list = Array.isArray(references) ? references : [];
  if (!list.length) return null;
  const state = (value) => (typeof value === "boolean" ? value : String(value ?? "").trim().toLowerCase());
  let restricted = 0;
  let unresolved = 0;
  for (const reference of list) {
    const rights = reference?.rights || reference || {};
    const consent = state(rights.portrait_consent ?? rights.consent);
    const redistribution = state(rights.redistribution ?? rights.redistribution_allowed);
    if (consent === "denied" || consent === false || redistribution === "forbidden" || redistribution === false) restricted += 1;
    else if ([state(rights.copyright), consent, redistribution].some((value) => !value || value === "unknown")) unresolved += 1;
  }
  if (restricted) return { tone: "restricted", label: t("referenceRightsRestricted", { count: restricted }) };
  if (unresolved) return { tone: "unresolved", label: t("referenceRightsUnresolved", { count: unresolved }) };
  return { tone: "cleared", label: t("referenceRightsCleared") };
}

function recipeHistoryMarkup(history) {
  const snapshots = history?.snapshots || [];
  if (!snapshots.length) return `<p class="recipe-history-status">${t("notRecorded")}</p>`;
  return `<ol class="recipe-snapshot-list" aria-label="${escapeHtml(t("recipeSnapshotHistory"))}">${snapshots.map((snapshot, index) => {
    const active = snapshot.snapshot_id === history.active_snapshot_id;
    const tool = [snapshot.model, snapshot.generation_tool, snapshot.provider].filter(Boolean).join(" · ") || t("notRecorded");
    const referenceText = snapshot.references?.length ? t("referenceCount", { count: snapshot.references.length }) : "";
    const rights = referenceRightsSummary(snapshot.references);
    const digest = String(snapshot.recipe_digest || "").slice(0, 12);
    return `<li class="recipe-snapshot-item${active ? " active" : ""}"><div class="recipe-snapshot-head"><span><strong>${escapeHtml(t("recipeSnapshotLabel", { number: index + 1 }))}</strong>${active ? `<span class="recipe-current">${t("currentRecipe")}</span>` : ""}</span><code title="${escapeHtml(snapshot.recipe_digest || "")}">${escapeHtml(digest)}</code></div><p class="recipe-snapshot-change">${escapeHtml(snapshot.change_summary || t("noRecipeChange"))}</p><p class="recipe-snapshot-prompt">${escapeHtml(snapshot.effective_prompt || t("notRecorded"))}</p><div class="recipe-snapshot-meta"><span>${escapeHtml(tool)}</span><span>${escapeHtml(t("promptStatus"))}: ${escapeHtml(snapshot.prompt_status || t("notRecorded"))}</span>${referenceText ? `<span>${escapeHtml(referenceText)}</span>` : ""}${rights ? `<button type="button" class="recipe-reference-rights ${rights.tone}" data-action="open-reference-rights" title="${escapeHtml(t("referenceRights"))}">${escapeHtml(rights.label)}</button>` : ""}</div><div class="recipe-snapshot-footer"><time datetime="${escapeHtml(snapshot.created_at || "")}">${escapeHtml(formatDateTime(snapshot.created_at))}</time><button type="button" data-recipe-snapshot-id="${escapeHtml(snapshot.snapshot_id)}">${t("useRecipe")}</button></div></li>`;
  }).join("")}</ol>`;
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

function categoryOptions(selected) { return ["product", "concept", "texture", "reference", "other"].map((value) => `<option value="${value}"${selected === value ? " selected" : ""}>${t(`category${value[0].toUpperCase()}${value.slice(1)}`)}</option>`).join(""); }
function buildSourceRows(source) {
  if (source.type === "codex-generated") return [["sourceLabel", sourceName(source)], ["taskId", source.codex_task_id], ["model", source.model], ["generationTool", source.generation_tool], ["originalPath", source.path]];
  if (source.type === "cowart-generated") return [["sourceLabel", sourceName(source)], ["canvasObject", source.cowart_shape_id], ["pageAsset", source.cowart_asset_id], ["canvasNote", source.cowart_annotation_source_shape_id ? t("canvasEdited") : t("canvasImage")], ["originalPath", source.path]];
  if (source.type === "grok-generated") {
    const mediaLabel = source.media_kind === "video" ? t("mediaKindVideo") : t("mediaKindImage");
    return [
      ["sourceLabel", sourceName(source)],
      ["mediaKind", mediaLabel],
      ["sessionId", source.grok_session_id],
      ["model", source.model],
      ["generationTool", source.generation_tool],
      ["originalPath", source.path || source.grok_media_path],
    ];
  }
  return [["sourceLabel", sourceName(source)], ["originalPath", source.path], ["taskId", source.codex_task_id], ["generationTool", source.generation_tool], ["model", source.model]];
}
// 来源名称统一走 SOURCE_LABEL_KEYS 单一映射（与 assetSourceLabel 同口径）：web-chatgpt
// 显示为 ChatGPT，不得落入手动导入；未知类型回退到原始类型串或“未知来源”。
function sourceName(source = {}) {
  const type = String(source.type || "");
  return SOURCE_LABEL_KEYS[type] ? t(SOURCE_LABEL_KEYS[type]) : (type || t("sourceUnknown"));
}

// 复制来源路径的统一取值：与 buildSourceRows 的 originalPath 行同一优先级（path →
// grok_media_path → 空串），保证“显示有路径即可复制”，渲染判断与点击取值不漂移。
function sourceCopyValue(source = {}) {
  return String(source.path || source.grok_media_path || "");
}

function isVideoAsset(asset = {}) {
  const kind = asset.source?.media_kind || asset.business_fields?.media_kind;
  if (kind === "video") return true;
  if (kind === "image") return false;
  const path = String(asset.image_path || asset.asset || asset.image_url || "");
  return /\.(mp4|webm|mov|m4v)(?:$|\?)/i.test(path);
}

function assetMediaPreviewMarkup(asset, mode = "thumb") {
  const title = asset.theme || asset.asset || asset.id;
  const url = mode === "detail" ? (asset.preview_url || asset.image_url) : (asset.thumbnail_url || asset.image_url);
  if (isVideoAsset(asset)) {
    if (mode === "detail") {
      return `<div class="detail-video-stack"><video class="detail-image detail-video" src="${escapeHtml(asset.image_url)}" controls playsinline preload="metadata" title="${escapeHtml(title)}">${escapeHtml(t("videoFallback"))}</video><p class="video-fallback-note">${escapeHtml(t("videoFallback"))} <a class="video-open-link" href="${escapeHtml(asset.image_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("openOriginalMedia"))}</a></p></div>`;
    }
    return `<span class="thumb video-thumb" aria-hidden="true"><video class="thumb-video" src="${escapeHtml(asset.image_url)}" muted playsinline preload="metadata"></video><span class="video-badge">▶</span></span>`;
  }
  if (mode === "detail") {
    return `<img class="detail-image" src="${escapeHtml(url)}" alt="${escapeHtml(title)}" title="${escapeHtml(t("viewFullImage"))}" />`;
  }
  return `<img class="thumb" src="${escapeHtml(url)}" alt="${escapeHtml(title)}" loading="lazy" />`;
}

function bindDetailEvents(asset, renderId) {
  const panel = els.detailPanel;
  panel.querySelectorAll("[data-edit], [data-version-change], [data-recipe-change]").forEach((field) => {
    field.addEventListener("input", () => { state.detailDirty = true; });
    field.addEventListener("change", () => { state.detailDirty = true; });
  });
  panel.querySelector('[data-action="close-detail"]')?.addEventListener("click", () => { if (state.viewMode === "asset") returnToLibrary(); else setDetailOpen(false); });
  // Phase 4A 区块 2：Detail 内收藏——复用既有 toggleFavorite（同一收藏 API），不切换
  // 素材、不返回 Library；loadAssets 后 renderDetail 重渲染按 asset.favorite 重绘本按钮。
  panel.querySelector('[data-action="toggle-favorite"]')?.addEventListener("click", (event) => toggleFavorite(asset.id, event));
  panel.querySelector('[data-action="copy-source"]')?.addEventListener("click", () => runAction(async () => { await navigator.clipboard.writeText(sourceCopyValue(asset.source)); showToast(t("originalPathCopied"), "success"); }));
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
      const result = await api(`/api/assets/${encodeURIComponent(originProjectId)}/${encodeURIComponent(originAssetId)}/insert-cowart`, { method: "POST", body: { placement: "right", targetId } });
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
      await api(`/api/assets/${encodeURIComponent(asset.project_id)}/${encodeURIComponent(asset.id)}/archive`, { method: "POST" });
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
      const result = await api(`/api/assets/${encodeURIComponent(originProjectId)}/${encodeURIComponent(originAssetId)}`, {
        method: "PATCH",
        body: { ...readRecipeDraft(panel), ...(changeSummary ? { recipe_change_summary: changeSummary } : {}) },
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
      const result = await api(`/api/assets/${encodeURIComponent(originProjectId)}/${encodeURIComponent(originAssetId)}/versions`, {
        method: "POST",
        body: { ...readRecipeDraft(panel), version_change: versionChange },
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
    const result = await api(`/api/assets/${encodeURIComponent(originProjectId)}/${encodeURIComponent(originAssetId)}`, {
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
    const thumbnail = linked?.thumbnail_url || linked?.image_url;
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

function formatDate(value) { if (!value) return ""; try { return new Intl.DateTimeFormat(state.locale === "zh" ? "zh-CN" : "en", { year: "numeric", month: "short", day: "numeric" }).format(new Date(value)); } catch { return String(value).slice(0, 10); } }
function formatDateTime(value) { if (!value) return ""; try { return new Intl.DateTimeFormat(state.locale === "zh" ? "zh-CN" : "en", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); } catch { return String(value); } }
function setStatus(value, stateName = "neutral") {
  persistentStatus = { value, stateName };
  if (!statusAnnouncementActive) writeStatusText(value);
  // The visible label collapses to its dot in a narrow workspace bar, so the text
  // is also carried as a tooltip. #statusText keeps announcing it either way.
  if (els.bridgeStatus) { els.bridgeStatus.dataset.state = stateName; els.bridgeStatus.title = value; }
  if (els.bridgeStatusLabel) els.bridgeStatusLabel.textContent = value;
}
async function runAction(action) { try { await action(); } catch (error) { showToast(error.message, "error"); } }
function debounce(fn, delay) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); }; }
function escapeHtml(value) { return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }
function safeStorageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function safeStorageSet(key, value) { try { localStorage.setItem(key, value); } catch {} }
