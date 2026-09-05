import { createLanguageApplier, createT, resolveLocale } from "./i18n-runtime.mjs";
import { createBridgeStatusPoller } from "./bridge-status-poller.mjs";
import {
  FACET_KEYS, LIBRARY_REFRESH_INTERVAL, LIVE_REGION_WRITE_DELAY, SCOPES, SIDEBAR_SOURCE_TYPES, SKELETON_TILE_COUNT, SOURCE_LABEL_KEYS, STATUS_ANNOUNCEMENT_DURATION,
} from "./config.mjs";
import {
  cardShortTitle, debounce, displayAssetTitle, escapeHtml, formatDate, normalizeDensity, normalizeSort, safeStorageGet, safeStorageSet,
} from "./utils.mjs";
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
import { createGallerySelection } from "./gallery-selection.mjs";
import { createAssetStackController } from "./asset-stacks.mjs";
let statusAnnouncementTimer = null;
let statusTextWriteTimer = null;
let statusAnnouncementSequence = 0;
let statusAnnouncementActive = false;
let libraryRefreshTimer = null;
const TRASH_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

function trashRemainingDays(deletedAt) {
  const deletedAtMs = Date.parse(String(deletedAt || ""));
  if (!Number.isFinite(deletedAtMs)) return 0;
  return Math.max(0, Math.ceil((deletedAtMs + TRASH_RETENTION_MS - Date.now()) / (24 * 60 * 60 * 1000)));
}
let libraryEventSource = null;
let persistentStatus = { value: "", stateName: "neutral" };
let sidebarGroupEdit = null;
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

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

function assetSourceLabel(asset = {}) {
  const type = String(asset.source?.type || asset.sourceType || "");
  return sourceTypeLabel(type);
}

function sourceTypeLabel(type) {
  const cleanType = String(type || "");
  return SOURCE_LABEL_KEYS[cleanType] ? t(SOURCE_LABEL_KEYS[cleanType]) : (cleanType || t("sourceUnknown"));
}

const preference = safeStorageGet("mosa.ui-language") || "system";
const INSPECTOR_DOCKED_MEDIA = "(min-width: 701px)";

function isInspectorDocked() {
  return typeof window.matchMedia === "function" && window.matchMedia(INSPECTOR_DOCKED_MEDIA).matches;
}

const state = {
  project: "default", projects: [], assets: [], pageTotal: 0, nextCursor: null, loadedPageCount: 0, selectedId: null, selectedIds: new Set(), selectedStackNodes: new Map(), selectionProject: "default", selectionRequestKey: "", detailAsset: null, detailStack: null, versionHistory: null, recipeHistory: null, generationHistory: null, detailOpen: false, detailDirty: false, detailReturnFocus: null, imagePreviewId: null, previewReturnFocus: null, query: "",
  scope: "all", facets: { source: "", group: "", category: "", style: "", conversation: "", generationBatch: "" }, sort: normalizeSort(safeStorageGet("mosa.asset-sort")),
  mediaKind: "all",
  groups: { total: 0, favorites: 0, unorganized: 0, trash: 0, sourceTypes: [], groups: [] },
  galleryStatus: "loading", galleryError: null, galleryDensity: normalizeDensity(safeStorageGet("mosa.gallery-density")), storageKind: "unknown",
  libraryPath: "", libraryRoot: "", codexImagesDir: "", supportedMediaExtensions: [], importSaving: false, groupSaving: false, libraryMoveInProgress: false, modalReturnFocus: null, languagePreference: preference, locale: resolveLocale(preference),
  dragCounter: 0,
  stagedPath: "", // P1-2: Track current staged file for cleanup on cancel
  stagingInProgress: false, // P1-3: Prevent concurrent staging requests
  stagingCanceled: false, // A close during staging invalidates the late result and cleans it up
  productVersion: "",
  updateStatus: "idle",
  latestVersion: "",
  updatePublishedAt: "",
  updateNotes: null,
  darkMode: safeStorageGet("mosa-dark-mode") === "true", settingsReturnFocus: null,
  sidebarSmartCollapsed: safeStorageGet("mosa.sidebar-smart-collapsed") === "true",
  sidebarManualCollapsed: safeStorageGet("mosa.sidebar-manual-collapsed") === "true",
  detailReturnFocusAssetId: null, previewReturnFocusAssetId: null,
  imageZoom: 1, imagePanX: 0, imagePanY: 0, imageDragging: false,
  // Bulk-selection gate. The viewer short-circuits while batch mode is active so
  // Phase 3A / D4：专用大图查看模式最小状态——viewMode 二值（library/asset）+ 进入时的
  // 画廊返回快照。不复刻搜索/筛选/排序状态、不深拷贝 state、无第二套 selectedAsset、无平行 Router。
  viewMode: "library", libraryReturnSnapshot: null,
  activeStackId: "", activeStackSummary: null, stackReturnSnapshot: null,
  assetStackDragCandidate: false, assetStackDragging: false,
};

// ===== i18n 运行时（resolveLocale/t/applyLanguage 已提取至 i18n-runtime.mjs）=====
const t = createT({ getLocale: () => state.locale });
const applyLanguage = createLanguageApplier({
  state,
  t,
  refreshUI: () => {
    updateCodexHint();
    window.electronAPI?.setLocale?.(state.locale);
    // Locale changes are the only settings update that needs fresh copy.
    // Rebuild without replaying the dialog entrance animation.
    renderSettingsMenu({ force: true });
    if (els.sortSelect) els.sortSelect.value = state.sort;
    renderQuickFilters();
    updateViewTitle();
    renderGrid();
    // Language changes must not destroy an in-progress Inspector draft. The
    // gallery and chrome update immediately; the Inspector adopts the locale
    // on the next safe render after save/discard.
    if (state.detailOpen && !isDetailEditorActive()) renderDetail();
  },
});

const els = {
  searchInput: document.querySelector("#searchInput"), quickFilters: document.querySelector("#quickFilters"),
  typeFilters: document.querySelector(".topbar-type-filters"),
  sidebar: document.querySelector("#appSidebar"), mobileNavToggle: document.querySelector("#mobileNavToggle"), mobileNavClose: document.querySelector("#mobileNavClose"), mobileNavScrim: document.querySelector("#mobileNavScrim"),
  sortSelect: document.querySelector("#sortSelect"),
  settingsToggle: document.querySelector("#settingsToggle"), settingsMenu: document.querySelector("#settingsMenu"), sidebarGroupList: document.querySelector("#sidebarGroupList"), sidebarManualGroupList: document.querySelector("#sidebarManualGroupList"), smartGroupsToggle: document.querySelector("#smartGroupsToggle"), assetCategoriesToggle: document.querySelector("#assetCategoriesToggle"), addGroupBtn: document.querySelector("#addGroupBtn"), newAssetTopBtn: document.querySelector("#newAssetTopBtn"), importModal: document.querySelector("#importModal"), closeImportModal: document.querySelector("#closeImportModal"), cancelImportBtn: document.querySelector("#cancelImportBtn"), groupModal: document.querySelector("#groupModal"), closeGroupModal: document.querySelector("#closeGroupModal"), cancelGroupBtn: document.querySelector("#cancelGroupBtn"), saveGroupBtn: document.querySelector("#saveGroupBtn"), groupNameInput: document.querySelector("#groupNameInput"), imagePreviewModal: document.querySelector("#imagePreviewModal"), imagePreviewStage: document.querySelector("#imagePreviewStage"), imagePreviewImage: document.querySelector("#imagePreviewImage"), imagePreviewVideo: document.querySelector("#imagePreviewVideo"), imagePreviewTitle: document.querySelector("#imagePreviewTitle"), closeImagePreview: document.querySelector("#closeImagePreview"), imagePathInput: document.querySelector("#imagePathInput"), importFileInput: document.querySelector("#importFileInput"), browseFileBtn: document.querySelector("#browseFileBtn"), codexSourceHint: document.querySelector("#codexSourceHint"), importFormatList: document.querySelector("#importFormatList"), importPathExample: document.querySelector("#importPathExample"), imagePathError: document.querySelector("#imagePathError"), businessFieldsError: document.querySelector("#businessFieldsError"), importAdvanced: document.querySelector("#importAdvanced"), promptInput: document.querySelector("#promptInput"), skillInput: document.querySelector("#skillInput"), styleInput: document.querySelector("#styleInput"), ratioInput: document.querySelector("#ratioInput"), themeInput: document.querySelector("#themeInput"), groupInput: document.querySelector("#groupInput"), categoryInput: document.querySelector("#categoryInput"), businessInput: document.querySelector("#businessInput"), saveAssetBtn: document.querySelector("#saveAssetBtn"),
  viewTitle: document.querySelector("#viewTitle"), statusText: document.querySelector("#statusText"), bridgeStatus: document.querySelector("#bridgeStatus"), bridgeStatusLabel: document.querySelector("#bridgeStatusLabel"), bridgeStatusMeta: document.querySelector("#bridgeStatusMeta"), appShell: document.querySelector("#appShell"), assetGrid: document.querySelector("#assetGrid"), detailPanel: document.querySelector("#detailPanel"), toastContainer: document.querySelector("#toastContainer"), toastErrorContainer: document.querySelector("#toastErrorContainer")
};

// asset-view 的导航状态更新由 asset-view.mjs 工厂闭包持有。保持顶层函数声明
// （提升使其在下方 createApiClient 参数求值时可引用），运行时再委托给已初始化的 viewer。
function updateAssetViewNav() {
  assetViewer.updateAssetViewNav();
}

// Data prefetch happens before the next page enters the DOM. Warm only real
// derivatives, never originals, so predictive browsing cannot turn into a
// burst of full-resolution decodes. Keeping a small rolling set gives the next
// viewport immediate pixels while leaving the remaining page to normal lazy
// loading and card virtualization.
const galleryPrewarmImages = new Set();
function prewarmAssetMedia(assets = []) {
  const urls = [];
  for (const asset of assets) {
    if (urls.length >= 24) break;
    if (!asset?.thumbnail_ready || !asset.thumbnail_url || asset.thumbnail_url === asset.image_url) continue;
    urls.push(asset.thumbnail_url);
  }
  urls.forEach((url) => {
    const image = new Image();
    image.decoding = "async";
    image.fetchPriority = "low";
    const release = () => galleryPrewarmImages.delete(image);
    image.addEventListener("load", release, { once: true });
    image.addEventListener("error", release, { once: true });
    galleryPrewarmImages.add(image);
    image.src = url;
  });
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
  prewarmAssetMedia,
});
const { apiFetch, loadProjects, loadStats, loadAssets, refreshLibraryInBackground, refreshLibraryIfChanged, reconcileLibraryRevision, noteLibraryRevision, buildAssetPageParams, requestAssetPage, currentAssetRequest, assetRequestKey, assetListVersion, assetVersion } = apiClient;

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
  selectionBar: document.querySelector("#selectionBar"),
  selectionCount: document.querySelector("#selectionCount"),
  selectionSelectAll: document.querySelector("#selectionSelectAll"),
  selectionClear: document.querySelector("#selectionClear"),
  selectionStack: document.querySelector("#selectionStack"),
  selectionRemoveFromStack: document.querySelector("#selectionRemoveFromStack"),
  stackBack: document.querySelector("#stackBack"),
  emptyTrashBtn: document.querySelector("#emptyTrashBtn"),
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

const gallerySelection = createGallerySelection({
  els,
  state,
  t,
  announceGalleryStatus,
  currentAssetRequest,
  requestAssetPage,
  apiFetch,
  showToast,
});
const assetStacks = createAssetStackController({
  els,
  state,
  apiFetch,
  loadAssets,
  gallerySelection,
  renderQuickFilters,
  updateViewTitle,
  showToast,
  closeDetailSurface,
  t,
});

// ===== Dark mode =====
function applyDarkMode() {
  const appearance = state.darkMode ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", appearance);
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
    let activeIndex = -1;
    for (const button of buttons) {
      const checked = button.classList.contains("active");
      if (checked) {
        anyChecked = true;
        activeIndex = buttons.indexOf(button);
      }
      button.setAttribute("aria-checked", String(checked));
      button.tabIndex = checked ? 0 : -1;
    }
    if (!anyChecked && buttons[0]) {
      buttons[0].tabIndex = 0;
      activeIndex = 0;
    }
    group.dataset.activeIndex = String(Math.max(0, activeIndex));
  });
}

function isSupportedImportFile(file) {
  return Boolean(file?.name && /\.(apng|avif|gif|jpe?g|png|svg|webp|m4v|mov|mp4|webm)$/i.test(file.name));
}

async function stageBrowserFile(file) {
  if (!(file instanceof File)) throw new Error(t("fileSelectionFailed"));
  if (!isSupportedImportFile(file)) {
    const error = new Error(t("errorPathUnsupported"));
    error.code = "IMAGE_PATH_UNSUPPORTED_TYPE";
    throw error;
  }
  const response = await fetch("/api/import/stage", {
    method: "POST",
    headers: {
      "content-type": file.type || "application/octet-stream",
      "x-mosa-file-name": encodeURIComponent(file.name),
    },
    body: file,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.path) {
    const error = new Error(payload?.error || t("fileSelectionFailed"));
    error.code = payload?.code || "IMPORT_STAGE_FAILED";
    throw error;
  }
  return payload.path;
}

// P1-2: Cleanup orphaned staged file on import cancel
async function cleanupStagedFile(stagedPath) {
  if (!stagedPath || typeof stagedPath !== "string") return;
  try {
    await apiFetch("/api/import/stage", { method: "DELETE", body: { path: stagedPath } });
  } catch (error) {
    // Non-fatal: log but don't interrupt user flow
    console.warn(`[MOSA] staged file cleanup failed: ${error?.message || error}`);
  }
}

async function prepareImportFile(file, { openModal = true } = {}) {
  // P1-3: Prevent concurrent staging to avoid orphaned files and last-write-wins
  if (state.stagingInProgress) return false;
  state.stagingInProgress = true;
  state.stagingCanceled = false;
  clearImportErrors();
  let filePath = "";
  try {
    // P1-2: Clean up previous staged file before staging new one
    if (state.stagedPath) {
      await cleanupStagedFile(state.stagedPath);
      state.stagedPath = "";
    }
    if (state.stagingCanceled) return false;

    // One path for Web and Electron: stream the selected File to the local
    // MOSA runtime and let the server stage it below the library root. This
    // also works when Electron safely attaches to an already-running MOSA
    // runtime, where an Electron-userData staging path would not be trusted.
    filePath = await stageBrowserFile(file);
    if (state.stagingCanceled) {
      await cleanupStagedFile(filePath);
      return false;
    }
    state.stagedPath = filePath; // P1-2: Track for cleanup on cancel
  } catch (error) {
    if (state.stagingCanceled) return false;
    const mapped = IMPORT_ERROR_FIELDS[error?.code];
    if (mapped) showImportError(mapped.field, t(mapped.message));
    else showToast(error?.message || t("fileSelectionFailed"), "error");
    return false;
  } finally {
    state.stagingInProgress = false;
    state.stagingCanceled = false;
  }
  if (!filePath) {
    showToast(t("dropPathUnavailable"), "error");
    return false;
  }
  if (els.imagePathInput) els.imagePathInput.value = filePath;
  if (openModal) {
    openImportModal();
    if (!els.importModal?.classList.contains("open")) {
      state.stagedPath = "";
      if (els.imagePathInput?.value === filePath) els.imagePathInput.value = "";
      await cleanupStagedFile(filePath);
      return false;
    }
  }
  return true;
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
    // P2-1: Multi-file drop indication
    if (files.length > 1) {
      showToast(t("multipleFilesIgnored"), "info");
    }
    const file = files[0];
    if (!isSupportedImportFile(file)) {
      announceGalleryStatus("");
      showToast(t("errorPathUnsupported"), "error");
      return;
    }
    const prepared = await prepareImportFile(file);
    announceGalleryStatus("");
    if (!prepared) return;
  });
}

// ===== Global drag/drop guard (P1-1) =====
// Prevent default drag-and-drop navigation in browser mode. Without this,
// dropping a file on non-drop targets (topbar, sidebar, modal backdrop, asset view)
// would navigate the tab to the dropped file's local path, losing all unsaved
// state. Electron has will-navigate protection, but browser mode needs this guard.
function setupGlobalDragGuard() {
  const isAllowedDropTarget = (target) => {
    if (!(target instanceof Element)) return false;
    if (target.closest(".import-v2-path-card")) return true;
    // `.library` also contains the mutually-exclusive large asset view. Only
    // the library mode has a drop handler that calls preventDefault(), so the
    // asset view must stay behind this fallback navigation guard.
    return state.viewMode === "library" && Boolean(target.closest(".library"));
  };
  document.addEventListener("dragover", (e) => {
    // Don't interfere with existing drop targets. Let them call preventDefault
    // themselves as needed. This is a fallback guard only.
    if (e.defaultPrevented) return;
    if (isAllowedDropTarget(e.target)) return;
    // Otherwise prevent default to avoid navigation.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  });

  document.addEventListener("drop", (e) => {
    // Same policy as dragover: only allow drops on known targets.
    if (e.defaultPrevented) return;
    if (isAllowedDropTarget(e.target)) return;
    e.preventDefault();
  });

  // P2-3: Reset drag counter on drop end to prevent stuck overlay when
  // elements are destroyed mid-drag (grid re-render from background refresh).
  window.addEventListener("dragend", () => {
    if (state.dragCounter > 0) {
      state.dragCounter = 0;
      if (els.dragOverlay) els.dragOverlay.hidden = true;
      announceGalleryStatus("");
    }
  });

  // Also reset on window-level drop (dropped outside library while overlay was visible)
  window.addEventListener("drop", () => {
    if (state.dragCounter > 0) {
      state.dragCounter = 0;
      if (els.dragOverlay) els.dragOverlay.hidden = true;
      announceGalleryStatus("");
    }
  }, true); // Capture phase to reset before any other drop handlers
}

const favoriteRequests = new Set();
async function toggleFavorite(id, event) {
  if (event) event.stopPropagation();
  if (!id) return;
  const currentTarget = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  const targetButton = event?.target instanceof Element
    ? event.target.closest('.card-favorite, [data-action="toggle-favorite"]')
    : null;
  const trigger = currentTarget?.matches?.('.card-favorite, [data-action="toggle-favorite"]')
    ? currentTarget
    : (targetButton instanceof HTMLElement ? targetButton : null);
  const shouldRestoreFocus = trigger && document.activeElement === trigger;
  const triggerWasDetail = Boolean(trigger?.closest?.("#detailPanel"));
  const projectId = state.project;
  const requestKey = `${projectId}\u0000${id}`;
  if (favoriteRequests.has(requestKey)) return;
  favoriteRequests.add(requestKey);
  try {
    const result = await apiFetch(`/api/assets/${encodeURIComponent(projectId)}/${encodeURIComponent(id)}/favorite`, { method: "POST" });
    const updated = result.asset || null;
    if (updated && projectId === state.project) {
      const index = state.assets.findIndex((asset) => asset.id === id && asset.project_id === projectId);
      if (index >= 0) state.assets[index] = updated;
      if (state.detailAsset?.id === id && state.detailAsset.project_id === projectId) state.detailAsset = updated;
      // Favorite only bumps updated_at, not the created_at sort order, so the
      // background refresh below skips renderGrid/renderDetail when the result
      // set is unchanged. Patch every visible favorite button here so the star
      // reflects the server response instead of staying stale until a later
      // full render (search/filter/sort/project) rebuilds the grid.
      const favorite = Boolean(updated.favorite);
      const gridButton = els.assetGrid?.querySelector(`.card-favorite[data-fav-id="${CSS.escape(id)}"]`);
      // Only patch the Inspector button when it actually renders this asset;
      // otherwise a favorite toggle on one card would overwrite the star of a
      // different asset currently open in the detail panel.
      const detailShowsAsset = state.detailAsset?.id === id && state.detailAsset?.project_id === projectId;
      const detailButton = detailShowsAsset ? els.detailPanel?.querySelector('[data-action="toggle-favorite"]') : null;
      if (trigger instanceof HTMLElement && trigger.isConnected) applyFavoriteButtonState(trigger, favorite);
      if (gridButton instanceof HTMLElement && gridButton !== trigger) applyFavoriteButtonState(gridButton, favorite);
      if (detailButton instanceof HTMLElement && detailButton !== trigger) applyFavoriteButtonState(detailButton, favorite);
    }
    showToast(updated?.favorite ? t("addedToFavorites") : t("removedFromFavorites"), "success");
    const refreshes = await Promise.allSettled([loadStats(), apiClient.reloadLoadedAssetPages({ background: true })]);
    refreshes.forEach((refresh) => {
      if (refresh.status === "rejected") console.warn("Favorite refresh failed:", refresh.reason);
    });
    if (shouldRestoreFocus && projectId === state.project) {
      const replacement = triggerWasDetail
        ? els.detailPanel?.querySelector('[data-action="toggle-favorite"]')
        : els.assetGrid?.querySelector(`.card-favorite[data-fav-id="${CSS.escape(id)}"]`);
      if (replacement instanceof HTMLElement) replacement.focus({ preventScroll: true });
      else els.assetGrid?.focus({ preventScroll: true });
    }
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    favoriteRequests.delete(requestKey);
  }
}

function applyFavoriteButtonState(button, favorite) {
  button.classList.toggle("is-fav", favorite);
  button.setAttribute("aria-pressed", String(favorite));
  button.setAttribute("aria-label", t(favorite ? "removeFavorite" : "addFavorite"));
  // The grid card's star is an <svg> whose fill is driven by the .is-fav
  // class (styles.css `.card-favorite.is-fav svg { fill: currentColor }`),
  // so its children stay untouched. The detail button carries two spans
  // (icon glyph + visible label) that must be reconciled in place.
  if (button.classList.contains("card-favorite")) {
    button.setAttribute("title", t(favorite ? "removeFavorite" : "addFavorite"));
    return;
  }
  const icon = button.children[0];
  const label = button.children[1];
  if (icon) icon.textContent = favorite ? "★" : "☆";
  if (label) label.textContent = t(favorite ? "favorited" : "addFavorite");
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
    // M1 兜底：右键菜单打开期间键盘归菜单独占（菜单本身以捕获阶段消费并阻断
    // 冒泡）。一次 Escape 只关菜单，方向键只移动菜单焦点，不连带关 Inspector
    // 或切换画廊选中。
    if (contextMenu.isOpen()) return;
    // The gallery owns ⌘/Ctrl+A now that marquee selection is available. Paste
    // remains desktop-only; browser mode still blocks accidental DOM selection
    // and paste handlers that MOSA does not own.
    if ((event.metaKey || event.ctrlKey) && (event.key === "a" || event.key === "A" || event.key === "v" || event.key === "V")) {
      if (event.target.matches?.("input, textarea, select, [contenteditable]")) return;
      if (confirmDialogState.pending
        || els.importModal?.classList.contains("open")
        || els.groupModal?.classList.contains("open")
        || !els.imagePreviewModal?.hidden
        || !els.settingsMenu?.hidden) return;
      if ((event.key === "a" || event.key === "A") && state.viewMode === "library" && state.assets.length) {
        event.preventDefault();
        void gallerySelection.selectAll({ announce: true });
        return;
      }
      // In Electron, the paste event handler in bindDesktopIntegration imports
      // a pasted image from the clipboard. Calling preventDefault() here would
      // suppress that paste event entirely, so let it through on the desktop.
      if (event.key === "v" || event.key === "V") {
        if (window.electronAPI) return;
      }
      event.preventDefault();
      return;
    }
    // Modal traps are registered before this application shortcut router. If
    // the topmost layer already consumed Escape, never let the same keystroke
    // also close the mobile navigation underneath it.
    if (event.key === "Escape" && event.defaultPrevented) return;
    if (event.key === "Escape" && document.body.classList.contains("mobile-nav-open")) {
      event.preventDefault();
      setMobileNavOpen(false, { restoreFocus: true });
      return;
    }
    if (event.target.matches?.("input, textarea, select") && event.key !== "Escape") return;
    // Escape in the search box clears the active query (or returns focus to the
    // gallery when already empty) instead of falling through to close the
    // Inspector underneath — matching the search-field reflex, not the modal
    // dismiss reflex. Clearing still honors the dirty-draft guard.
    if (event.key === "Escape" && event.target === els.searchInput) {
      event.preventDefault();
      if (els.searchInput.value) void clearSearchQuery();
      else els.assetGrid?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "/" && state.viewMode === "library"
      && els.imagePreviewModal?.hidden
      && els.settingsMenu?.hidden
      && !els.importModal?.classList.contains("open")
      && !els.groupModal?.classList.contains("open")) { event.preventDefault(); els.searchInput?.focus(); return; }
    if (event.key === "Escape") {
      // Phase 3A 运行时修复：bindEvents 先行注册的 Modal 焦点陷阱已消费本次 Escape
      // （preventDefault）时，本链不得再继续向下穿透（否则会关 Modal 同时退出查看模式）。
      if (event.defaultPrevented) return;
      if (!els.imagePreviewModal?.hidden) { closeImagePreview(); event.preventDefault(); return; }
      if (els.importModal?.classList.contains("open")) { closeImportModal(); event.preventDefault(); return; }
      if (els.groupModal?.classList.contains("open")) { closeGroupModal(); event.preventDefault(); return; }
      // Escape 先关最上层 Modal，再退出查看模式，不得穿透。
      if (!els.settingsMenu?.hidden) { closePanel(els.settingsMenu, els.settingsToggle); event.preventDefault(); return; }
      if (state.viewMode === "library" && state.selectedIds?.size) {
        gallerySelection.clear({ announce: true });
        event.preventDefault();
        return;
      }
      if (state.viewMode === "library" && state.detailOpen && isInspectorDocked()) {
        if (state.activeStackId) { event.preventDefault(); void assetStacks.exitStack(); }
        return;
      }
      if (state.viewMode === "asset" || state.detailOpen) { event.preventDefault(); void closeDetailSurface(); return; }
      if (state.activeStackId) { event.preventDefault(); void assetStacks.exitStack(); return; }
    }
    // Native video controls own their keyboard semantics (notably ←/→ seek).
    // Escape was handled above, so all remaining keystrokes can safely stay
    // with the focused <video> instead of becoming MOSA pan/navigation input.
    if (event.target.closest?.("video")) return;
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
    const galleryEnterTarget = event.target === els.assetGrid || Boolean(event.target.closest?.(".asset-card-select"));
    const galleryEnterCardId = event.target.closest?.(".asset-card")?.dataset.id || "";
    const galleryEnterAssetId = galleryEnterCardId || state.selectedId || "";
    if (event.key === "Enter"
      && galleryEnterTarget
      && state.viewMode === "library"
      && galleryEnterAssetId
      && !state.selectedIds?.size
      && els.imagePreviewModal?.hidden
      && !hasBlockingOverlay()
      && els.settingsMenu?.hidden) {
      const asset = state.assets.find((item) => item.id === galleryEnterAssetId)
        || (galleryEnterAssetId === state.selectedId ? selectedAsset() : null);
      if (asset) {
        event.preventDefault();
        if (!state.activeStackId && asset.stack?.id) void assetStacks.enterStack(asset.stack.id, asset.stack);
        else void openAssetView(asset.id, els.assetGrid?.querySelector(`.asset-card[data-id="${CSS.escape(asset.id)}"] .asset-card-select`));
        return;
      }
    }
    if (state.viewMode === "library" && !state.selectedIds?.size) handleLibraryKeyboardNavigation(event);
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
  detailVersionSectionMarkup, detailGroupSectionMarkup, detailTagsSectionMarkup,
  detailMoreSectionMarkup, versionPickerMarkup, versionHistoryMarkup,
  generationHistoryMarkup, recipeHistoryMarkup, recipeHistoryDisclosureMarkup, categoryOptions, buildSourceRows, sourceName,
  sourceCopyValue, isVideoAsset, assetMediaPreviewMarkup, formatFileSize, fileDimensionsText, fileFormatText,
  fileSizeText, fileFactRowMarkup, editRecipeFieldsMarkup, versionOptionLabel, detailVersionSummaryMarkup, stackInspectorMarkup,
  referenceRightsSummary, promptReferencesMarkup } = inspectorMarkup;

// ===== Asset view（大图查看器，已提取至 asset-view.mjs，R1 批次 4）=====
const assetViewer = createAssetViewer({ els, state, t, announceGalleryStatus, selectedAsset, isVideoAsset,
  confirmDetailNavigation, discardDetailDraft, isCurrentDetailSelection, assetRequestKey, currentAssetRequest, requestAssetPage,
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
async function resetLibraryRefinements() {
  if (!await confirmDetailNavigation(null)) return false;
  discardDetailDraft();
  state.query = "";
  if (els.searchInput) els.searchInput.value = "";
  state.scope = "all";
  state.mediaKind = "all";
  clearFacets();
  // A reset restarts paging, and the viewer result-set semantics changed.
  state.nextCursor = null;
  if (state.viewMode === "asset") returnToLibrary();
  clearDetailSelection();
  renderQuickFilters(); renderTypeFilters();
  announceGalleryStatus(t("statusRefinementsCleared"));
  void loadAssets().then((applied) => {
    if (!applied) return;
    const firstCard = els.assetGrid?.querySelector(".asset-card-select");
    if (firstCard) firstCard.focus({ preventScroll: true });
    else els.assetGrid?.focus({ preventScroll: true });
  });
  return true;
}

async function init() {
    applyLanguage();
    applyDarkMode();
    assetStacks.bind();
    gallerySelection.bind();
    bindEvents();
    setupDragDrop();
    setupGlobalDragGuard();
    setupKeyboardShortcuts();
    setupImageZoomPan();
    renderGrid();
    // Desktop V2 keeps the Inspector as a permanent third column. Calling the
    // existing state transition before data loading also prevents a visible
    // two-column -> three-column jump during startup; mobile still resolves to
    // the closed state because isInspectorDocked() is false there.
    setDetailOpen(false);
    try {
      await Promise.all([loadProjects(), loadProductVersion()]);
      await Promise.all([loadStats(), loadAssets()]);
      void refreshBridgeStatus();
      bridgeStatusPoller.start();
      startLibraryEventStream();
      // Single interval: dedupe on hot-reload / repeated init() and stop on unload.
      if (libraryRefreshTimer) clearInterval(libraryRefreshTimer);
      // Pagination owns the current gallery request while an append is in flight.
      // Starting the background page-one refresh at the same time would advance
      // api-client's shared request generation and make the append response stale.
      libraryRefreshTimer = setInterval(() => {
        if (!isLoadingMore) void refreshLibraryIfChanged();
      }, LIBRARY_REFRESH_INTERVAL);
      if (shouldAutoCheckForUpdates()) void checkForUpdates({ notify: true, silent: true });
    } catch (error) {
      renderErrorState(error);
      setStatus(t("statusUnavailable"), "error");
    }
  }

async function loadProductVersion() {
  try {
    const data = await apiFetch("/api/health");
    state.productVersion = String(data?.productVersion || "").trim();
    state.storageKind = String(data?.storage || "unknown");
  } catch {
    state.productVersion = "";
    state.storageKind = "unknown";
  }
  gallerySelection.syncRenderedSelection({ prune: false });
  renderSettingsMenu();
}

function shouldAutoCheckForUpdates() {
  if (!window.electronAPI?.checkForUpdates) return false;
  const lastChecked = Number(safeStorageGet("mosa.update-last-checked") || 0);
  return !Number.isFinite(lastChecked) || lastChecked <= 0 || Date.now() - lastChecked >= UPDATE_CHECK_INTERVAL_MS;
}

function updateVersionSummary() {
  const current = state.productVersion ? `v${String(state.productVersion).replace(/^v/i, "")}` : t("versionUnknown");
  if (state.updateStatus === "available" && state.latestVersion) {
    const published = state.updatePublishedAt ? ` · ${t("updatePublished", { date: formatDate(state.updatePublishedAt, state.locale) })}` : "";
    return `${current} · ${t("updateAvailable", { version: state.latestVersion })}${published}`;
  }
  if (state.updateStatus === "current") return `${current} · ${t("upToDate")}`;
  if (state.updateStatus === "error") return `${current} · ${t("updateCheckFailed")}`;
  return current;
}

function updateVersionControlMarkup() {
  if (!window.electronAPI?.checkForUpdates) return "";
  if (state.updateStatus === "available") {
    return `<button class="settings-text-action" type="button" data-download-latest>${escapeHtml(t("downloadLatest"))}</button>`;
  }
  const label = state.updateStatus === "checking" ? t("checkingForUpdates") : t("checkForUpdates");
  return `<button class="settings-text-action" type="button" data-check-updates${state.updateStatus === "checking" ? " disabled" : ""}>${escapeHtml(label)}</button>`;
}

async function checkForUpdates({ notify = false, silent = false } = {}) {
  const api = window.electronAPI;
  if (!api?.checkForUpdates || state.updateStatus === "checking") return null;
  state.updateStatus = "checking";
  syncSettingsMenuView();
  try {
    const result = await api.checkForUpdates(notify === true);
    if (result?.status === "ok") safeStorageSet("mosa.update-last-checked", String(Date.now()));
    if (result?.currentVersion) state.productVersion = String(result.currentVersion).replace(/^v/i, "");
    if (result?.status === "ok") {
      state.latestVersion = String(result.latestVersion || "").replace(/^v/i, "");
      state.updatePublishedAt = String(result.publishedAt || "");
      state.updateNotes = result.notes && typeof result.notes === "object" ? result.notes : null;
      state.updateStatus = result.updateAvailable ? "available" : "current";
      if (!silent || (notify && result.updateAvailable)) {
        showToast(result.updateAvailable ? t("updateAvailableToast", { version: state.latestVersion }) : t("upToDate"), "success");
      }
    } else if (result?.status === "disabled") {
      state.updateStatus = "idle";
    } else {
      state.updateStatus = "error";
      if (!silent) showToast(t("updateCheckFailed"), "error");
    }
    return result;
  } catch {
    state.updateStatus = "error";
    if (!silent) showToast(t("updateCheckFailed"), "error");
    return null;
  } finally {
    syncSettingsMenuView();
  }
}

function syncSettingsMenuView() {
  const menu = els.settingsMenu;
  if (!menu?.querySelector(".settings-modal-card")) return;
  const setRadioState = (selector, selectedValue) => {
    menu.querySelectorAll(selector).forEach((button) => {
      button.classList.toggle("active", button.value === selectedValue || button.dataset.appearanceOpt === selectedValue || button.dataset.densityOpt === selectedValue || button.dataset.locale === selectedValue);
    });
  };
  setRadioState("[data-appearance-opt]", state.darkMode ? "dark" : "light");
  setRadioState("[data-density-opt]", state.galleryDensity);
  setRadioState("[data-locale]", state.locale === "en" ? "en" : "zh");

  const libraryPath = state.libraryRoot || state.libraryPath || state.codexImagesDir || "—";
  const pathNode = menu.querySelector("[data-settings-library-path]");
  if (pathNode) {
    pathNode.textContent = libraryPath;
    pathNode.title = libraryPath;
  }
  const storageNode = menu.querySelector("[data-settings-storage-engine]");
  if (storageNode) storageNode.textContent = state.storageKind === "sqlite" ? t("storageEngineValue") : (state.storageKind && state.storageKind !== "unknown" ? state.storageKind : "—");
  const versionNode = menu.querySelector("[data-settings-version]");
  if (versionNode) versionNode.textContent = updateVersionSummary();
  const updateAction = menu.querySelector("[data-settings-update-action]");
  if (updateAction) {
    const markup = updateVersionControlMarkup();
    if (updateAction.innerHTML !== markup) updateAction.innerHTML = markup;
  }
  const changeLibraryButton = menu.querySelector("[data-change-library]");
  if (changeLibraryButton) {
    changeLibraryButton.disabled = state.libraryMoveInProgress;
    changeLibraryButton.textContent = state.libraryMoveInProgress ? t("changingLocation") : t("changeLocation");
  }
  syncSegmentedRadios(menu);
}

function renderSettingsMenu({ force = false } = {}) {
  if (!els.settingsMenu) return;
  const existingDialog = els.settingsMenu.querySelector(".settings-modal-card");
  if (existingDialog && !force) {
    syncSettingsMenuView();
    return;
  }

  const refreshingVisibleDialog = Boolean(existingDialog && !els.settingsMenu.hidden);
  if (refreshingVisibleDialog) els.settingsMenu.setAttribute("data-refreshing", "true");

  const settingIcon = (path) => `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
  const radio = (selected, attribute, value, label) => `<button class="segmented-btn${selected ? " active" : ""}" type="button" role="radio" aria-checked="${selected}" tabindex="${selected ? 0 : -1}" ${attribute}="${value}">${label}</button>`;
  const segmented = (ariaLabel, attribute, selectedValue, options) => {
    const activeIndex = Math.max(0, options.findIndex((option) => option.value === selectedValue));
    const buttons = options.map((option) => radio(option.value === selectedValue, attribute, option.value, option.label)).join("");
    return `<div class="segmented" role="radiogroup" aria-label="${escapeHtml(ariaLabel)}" data-active-index="${activeIndex}"><span class="segmented-thumb" aria-hidden="true"></span>${buttons}</div>`;
  };
  const row = (icon, title, subtitle, control = "", extraClass = "") => `<div class="settings-modal-row${extraClass ? ` ${extraClass}` : ""}"><div class="settings-row-icon" aria-hidden="true">${icon}</div><div class="settings-row-copy"><h4>${title}</h4>${subtitle ? `<p>${subtitle}</p>` : ""}</div>${control ? `<div class="settings-row-control">${control}</div>` : ""}</div>`;
  const section = (title, rows, extraClass = "") => `<section class="settings-block${extraClass ? ` ${extraClass}` : ""}"><h3>${title}</h3>${rows}</section>`;
  const visualLocale = state.locale === "en" ? "en" : "zh";
  const path = escapeHtml(state.libraryRoot || state.libraryPath || state.codexImagesDir || "—");
  const closeIcon = settingIcon("m6 6 12 12M18 6 6 18");
  const storageLabel = state.storageKind === "sqlite" ? t("storageEngineValue") : (state.storageKind && state.storageKind !== "unknown" ? state.storageKind : "—");
  const changeLibraryControl = window.electronAPI?.changeLibraryLocation
    ? `<div class="settings-inline-actions"><button class="settings-text-action" type="button" data-open-library>${t("settingsOpenLibrary")}</button><button class="settings-text-action" type="button" data-change-library${state.libraryMoveInProgress ? " disabled" : ""}>${state.libraryMoveInProgress ? t("changingLocation") : t("change")}</button></div>`
    : `<button class="settings-text-action" type="button" data-open-library>${t("settingsOpenLibrary")}</button>`;
  const appearanceRows = [
    row(settingIcon("M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4M15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0"), t("themeMode"), "", segmented(t("themeMode"), "data-appearance-opt", state.darkMode ? "dark" : "light", [{ value: "light", label: t("themeLight") }, { value: "dark", label: t("themeDark") }])),
    row(settingIcon("M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"), t("cardDensity"), "", segmented(t("cardDensity"), "data-density-opt", state.galleryDensity, [{ value: "image", label: t("densityImageControl") }, { value: "info", label: t("densityInfoControl") }])),
    row(settingIcon("M4 12h16M12 4a12 12 0 0 1 0 16M12 4a12 12 0 0 0 0 16M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0"), t("interfaceLanguage"), "", segmented(t("interfaceLanguage"), "data-locale", visualLocale, [{ value: "zh", label: "中文" }, { value: "en", label: "EN" }]))
  ].join("");
  const storageRows = [
    row(settingIcon("M3 7.5A2.5 2.5 0 0 1 5.5 5h4l1.7 2h7.3A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5v-10Z"), t("libraryPath"), `<span class="settings-path" data-settings-library-path title="${path}">${path}</span>`, changeLibraryControl, "settings-library-row"),
    row(settingIcon("M5.5 5.5C5.5 4.1 8.4 3 12 3s6.5 1.1 6.5 2.5S15.6 8 12 8 5.5 6.9 5.5 5.5ZM5.5 5.5v6C5.5 12.9 8.4 14 12 14s6.5-1.1 6.5-2.5v-6M5.5 11.5v6C5.5 18.9 8.4 20 12 20s6.5-1.1 6.5-2.5v-6"), t("storageEngine"), "", `<span class="settings-static-value" data-settings-storage-engine>${escapeHtml(storageLabel)}</span>`),
  ].join("");
  const aboutRow = row(settingIcon("M12 10v5M12 7.5v.1M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0"), t("version"), `<span data-settings-version>${escapeHtml(updateVersionSummary())}</span>`, `<div data-settings-update-action>${updateVersionControlMarkup()}</div>`, "settings-about-row");

  els.settingsMenu.innerHTML = `<div class="settings-modal-card" role="dialog" aria-modal="true" aria-labelledby="settingsModalTitle" tabindex="-1"><header class="settings-modal-header"><h2 id="settingsModalTitle">${t("settings")}</h2><button class="settings-modal-close" type="button" data-settings-close aria-label="${escapeHtml(t("closeSettings"))}">${closeIcon}</button></header><div class="settings-modal-body">${section(t("appearance"), appearanceRows)}${section(t("storageDataSection"), storageRows)}${section(t("aboutSection"), aboutRow, "settings-about-block")}</div></div>`;
  syncSettingsMenuView();
  if (refreshingVisibleDialog) requestAnimationFrame(() => els.settingsMenu?.removeAttribute("data-refreshing"));
}

const ARROW_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
// Cards in the same masonry column share a left edge to within a rounding error.
const COLUMN_TOLERANCE_PX = 4;
let cachedCardGeometry = null;
let cachedCardGeometryGrid = null;

function invalidateCardGeometryCache() {
  cachedCardGeometry = null;
  cachedCardGeometryGrid = null;
}

/** Rendered card geometry, so navigation follows what the reader can see. */
function cardGeometry() {
  if (cachedCardGeometry && cachedCardGeometryGrid === els.assetGrid) return cachedCardGeometry;
  const cards = [...(els.assetGrid?.querySelectorAll(".asset-card") || [])];
  cachedCardGeometryGrid = els.assetGrid;
  cachedCardGeometry = cards.map((card) => {
    const box = card.getBoundingClientRect();
    return { id: card.dataset.id, left: box.left, top: box.top, bottom: box.bottom, centerX: box.left + box.width / 2, centerY: box.top + box.height / 2 };
  }).filter((entry) => entry.id);
  return cachedCardGeometry;
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
const { requestConfirmation, requestFollowupConfirmation, closeConfirmDialog, trapConfirmDialogFocus, isConfirmFocusTarget, confirmDialogState } = confirmDialog;

const toastManager = createToastManager({ els, state, t, isConfirmFocusTarget });
function showToast(message, type = "default") { return toastManager.show(message, type); }
async function writeClipboardText(value) {
  const text = String(value ?? "");
  if (window.electronAPI?.writeClipboardText) {
    const result = await window.electronAPI.writeClipboardText(text);
    if (result?.ok !== true) throw new Error(t("copyFailed"));
    return;
  }
  if (!navigator.clipboard?.writeText) throw new Error(t("copyFailed"));
  await navigator.clipboard.writeText(text);
}

async function clipboardPngBlob(blob) {
  if (blob.type === "image/png") return blob;
  if (typeof createImageBitmap !== "function") throw new Error(t("copyImageFailed"));
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(t("copyImageFailed"));
    context.drawImage(bitmap, 0, 0);
    return await new Promise((resolvePromise, reject) => {
      canvas.toBlob((pngBlob) => {
        if (pngBlob) resolvePromise(pngBlob);
        else reject(new Error(t("copyImageFailed")));
      }, "image/png");
    });
  } finally {
    bitmap.close?.();
  }
}

async function writeClipboardImage(asset = {}) {
  if (isVideoAsset(asset)) throw new Error(t("copyImageFailed"));
  const imagePath = String(asset.image_path || "").trim();
  if (window.electronAPI?.writeClipboardImage && imagePath) {
    const result = await window.electronAPI.writeClipboardImage(imagePath);
    if (result?.ok !== true) throw new Error(t("copyImageFailed"));
    return;
  }

  const imageUrl = String(asset.image_url || "").trim();
  if (!imageUrl || !navigator.clipboard?.write || typeof ClipboardItem !== "function") {
    throw new Error(t("copyImageFailed"));
  }
  const response = await fetch(imageUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(t("copyImageFailed"));
  const sourceBlob = await response.blob();
  if (!sourceBlob.type.startsWith("image/")) throw new Error(t("copyImageFailed"));
  // Browser clipboard implementations are most interoperable with PNG. This
  // conversion keeps the original image dimensions and pixels; importantly,
  // it starts from image_url (the stored original), never thumbnail_url.
  const clipboardBlob = await clipboardPngBlob(sourceBlob);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": clipboardBlob })]);
}
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
  requestFollowupConfirmation,
  confirmDetailNavigation,
  discardDetailDraft,
  releaseAssetMedia: releaseAssetMediaForDeletion,
  openGroupModal,
  getGroupColor: colorForGroup,
  saveGroupColor,
  writeClipboardText,
  copyOriginalImage: writeClipboardImage,
  isVideoAsset,
  pasteClipboardImage: window.electronAPI?.pasteImage ? pasteClipboardImage : null,
  gallerySelection,
});

async function releaseAssetMediaForDeletion(assets = []) {
  const ids = new Set(assets.map((asset) => asset?.id).filter(Boolean));
  if (!ids.size) return;
  if (state.imagePreviewId && ids.has(state.imagePreviewId)) {
    els.imagePreviewVideo?.pause?.();
    els.imagePreviewVideo?.removeAttribute("src");
    els.imagePreviewVideo?.load?.();
    els.imagePreviewImage?.removeAttribute("src");
  }
  if (state.selectedId && ids.has(state.selectedId)) {
    els.assetViewVideo?.pause?.();
    els.assetViewVideo?.removeAttribute("src");
    els.assetViewVideo?.load?.();
    els.detailPanel?.querySelectorAll("video").forEach((video) => {
      video.pause?.();
      video.removeAttribute("src");
      video.load?.();
    });
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
}

function isDetailEditorActive() {
  const active = document.activeElement;
  const generationDraft = [...(els.detailPanel?.querySelectorAll("[data-generation-composer]") || [])].some((composer) => {
    const prompt = composer.querySelector("[data-generation-continue-prompt]")?.value.trim();
    const references = composer.querySelector("[data-generation-reference-id]");
    return Boolean(prompt || references);
  });
  return state.detailDirty
    || generationDraft
    || (active instanceof HTMLElement && Boolean(els.detailPanel?.contains(active) && active.closest("[data-edit], [data-version-change], [data-recipe-change], [data-tag-editor], [data-generation-composer]")));
}

function latestAssetSnapshot(projectId, assetId, fallback = null) {
  if (state.detailAsset?.project_id === projectId && state.detailAsset?.id === assetId) return state.detailAsset;
  return state.assets.find((item) => item.project_id === projectId && item.id === assetId) || fallback;
}

function createBridgeStatusPolling() {
  return createBridgeStatusPoller({
    fetchStatus: () => apiFetch("/api/bridges"),
    onSuccess: applyBridgeStatus,
    onError: applyBridgeStatusFailure,
  });
}
let bridgeStatusPoller = createBridgeStatusPolling();

// Stop polling when the page goes away and drop any response that lands afterwards.
window.addEventListener("pagehide", () => {
  bridgeStatusPoller.stop();
  stopLibraryEventStream();
  if (libraryRefreshTimer) {
    clearInterval(libraryRefreshTimer);
    libraryRefreshTimer = null;
  }
});
// M6：隐藏标签页暂停轮询（与 refreshLibraryInBackground 的 document.hidden 守卫
// 对齐）；重新可见时恢复并立即刷新一次，指示灯不落后于真实桥接状态。
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    bridgeStatusPoller.pause();
    stopLibraryEventStream();
  }
  else {
    bridgeStatusPoller.resume();
    void refreshBridgeStatus();
    startLibraryEventStream();
    if (!isLoadingMore) void refreshLibraryIfChanged();
  }
});
// bfcache 恢复（浏览器“后退”）：pagehide 已终止旧轮询实例（stop 是不可逆的
// teardown 守卫），pageshow(persisted) 后页面重新可见，重建新实例继续轮询并
// 恢复库刷新间隔，桥接指示灯不再永久冻结在旧值。
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  bridgeStatusPoller = createBridgeStatusPolling();
  void bridgeStatusPoller.refresh();
  bridgeStatusPoller.start();
  startLibraryEventStream();
  if (!libraryRefreshTimer) {
    libraryRefreshTimer = setInterval(() => {
      if (!isLoadingMore) void refreshLibraryIfChanged();
    }, LIBRARY_REFRESH_INTERVAL);
  }
});

function refreshBridgeStatus() {
  return bridgeStatusPoller.refresh();
}

function stopLibraryEventStream() {
  libraryEventSource?.close?.();
  libraryEventSource = null;
}

function startLibraryEventStream() {
  if (document.hidden || typeof EventSource !== "function") return;
  const project = state.project;
  stopLibraryEventStream();
  const source = new EventSource(`/api/library-events?project=${encodeURIComponent(project)}`);
  libraryEventSource = source;
  source.addEventListener("ready", (event) => {
    if (source !== libraryEventSource || project !== state.project) return;
    try {
      const payload = JSON.parse(event.data || "{}");
      void reconcileLibraryRevision(payload.revision);
    } catch {
      // The periodic revision check remains the fallback.
    }
  });
  source.addEventListener("library-changed", (event) => {
    if (source !== libraryEventSource || project !== state.project || isLoadingMore) return;
    let revision = null;
    try {
      const payload = JSON.parse(event.data || "{}");
      revision = payload.revision;
    } catch {
      // Refresh still proceeds even if an optional event payload is malformed.
    }
    void reconcileLibraryRevision(revision);
  });
}

function applyBridgeStatus({ codex, grok, cowart } = {}) {
    // Required bridges only: a Grok-only failure must not force global error status.
    const hasError = codex?.lastError || cowart?.lastError;
    const codexOn = Boolean(codex?.enabled);
    const cowartOn = Boolean(cowart?.enabled);
    const grokOn = Boolean(grok?.enabled);
    const bridgeBusy = Boolean(codex?.busy || grok?.busy || cowart?.busy);
    const importedCount = Number(cowart?.totalImported || 0) + Number(codex?.totalImported || 0) + Number(grok?.totalImported || 0);
    const monitoredCount = Number(cowart?.monitoredCount || 0);
    // Grok is optional: global readiness only requires Codex + Cowart.
    if (hasError) setStatus(t("statusBridgeError"), "error");
    else if (bridgeBusy) setStatus(t("statusBridgeBusy"), "warn");
    else if (codexOn && cowartOn) setStatus(t("statusReady"), "ok");
    else if (codexOn || cowartOn || grokOn) setStatus(t("statusBridgePartial"), "warn");
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
}

function applyBridgeStatusFailure() {
    if (els.bridgeStatusMeta) els.bridgeStatusMeta.textContent = "";
    setStatus(t("statusUnavailable"), "error");
}

/**
 * The supported-format list comes from the server rather than a copy in the
 * client, so the hint cannot claim a format the store would reject.
 */
function updateCodexHint() {
  if (els.importFormatList) els.importFormatList.textContent = state.supportedMediaExtensions.join(" ");
  const exampleDir = state.codexImagesDir || "/Users/you/Pictures";
  const exampleBase = exampleDir.replace(/[\\/]+$/, "");
  const exampleSeparator = exampleBase.includes("\\") ? "\\" : "/";
  const examplePath = `${exampleBase}${exampleSeparator}example.png`;
  if (els.importPathExample) els.importPathExample.textContent = examplePath;
  if (els.imagePathInput) els.imagePathInput.placeholder = examplePath;
  if (els.codexSourceHint) els.codexSourceHint.textContent = state.codexImagesDir || t("importPathCodexDirUnknown");
}

function updateViewTitle() {
  const titles = { all: t("allAssets"), favorite: t("favorites"), unorganized: t("unorganized"), trash: t("trash") };
  const hasFacets = Object.values(state.facets || {}).some(Boolean);
  const hasRefinements = Boolean(state.query || state.scope !== "all" || hasFacets
    || (state.mediaKind && state.mediaKind !== "all"));
  els.viewTitle.textContent = state.activeStackId
    ? (hasRefinements
      ? t("stackMatchCount", {
        matched: state.pageTotal || state.assets.length,
        total: state.activeStackSummary?.count || state.pageTotal || state.assets.length,
      })
      : t("stackItemCount", { count: state.activeStackSummary?.count || state.pageTotal || state.assets.length }))
    : (titles[state.scope] || t("allAssets"));
  // Match V2 SearchBar's scope-aware hint without changing the shared search
  // control or any query semantics.
  if (els.searchInput) {
    const activeGroup = String(state.facets.group || "").trim();
    els.searchInput.placeholder = state.activeStackId
      ? t("searchStack")
      : activeGroup
      ? t("searchGroup", { group: activeGroup })
      : state.scope === "favorite"
        ? t("searchFavorite")
        : state.scope === "unorganized"
          ? t("searchUnorganized")
          : state.scope === "trash"
            ? t("searchTrash")
            : t("searchAll");
  }
  if (els.emptyTrashBtn) els.emptyTrashBtn.hidden = state.scope !== "trash" || Number(state.groups?.trash || 0) === 0;
  if (els.newAssetTopBtn) els.newAssetTopBtn.hidden = state.scope === "trash";
}

async function clearSearchQuery() {
  if (!state.query && !els.searchInput?.value) return false;
  if (!await confirmDetailNavigation(null)) return;
  discardDetailDraft();
  state.query = "";
  if (els.searchInput) els.searchInput.value = "";
  applyFilterChange();
  return true;
}

function bindEvents() {
  syncMobileNavigation();
  syncSidebarSectionVisibility();
  els.mobileNavToggle?.addEventListener("click", () => setMobileNavOpen(true));
  els.mobileNavClose?.addEventListener("click", () => setMobileNavOpen(false, { restoreFocus: true }));
  els.mobileNavScrim?.addEventListener("click", () => setMobileNavOpen(false, { restoreFocus: true }));
  els.sidebar?.addEventListener("click", (event) => {
    if (!isMobileNavigationViewport()) return;
    if (event.target.closest(".nav-item, .add-group-button, .settings-trigger")) setMobileNavOpen(false);
  });
  els.searchInput?.addEventListener("input", debounce(async () => {
    const nextQuery = els.searchInput.value;
    if (nextQuery === state.query) return;
    if (!await confirmDetailNavigation(null)) {
      els.searchInput.value = state.query;
      return;
    }
    discardDetailDraft();
    state.query = nextQuery;
    state.nextCursor = null;
    // Phase 3A：结果集语义已变化，退出查看模式（快照 requestKey 随之失效，恢复自动降级）。
    if (state.viewMode === "asset") returnToLibrary();
    clearDetailSelection();
    await loadAssets();
  }, 180));
  els.sortSelect?.addEventListener("change", async () => {
    const nextSort = normalizeSort(els.sortSelect.value);
    if (nextSort === state.sort) return;
    if (!await confirmDetailNavigation(null)) {
      els.sortSelect.value = state.sort;
      return;
    }
    discardDetailDraft();
    state.sort = nextSort;
    safeStorageSet("mosa.asset-sort", state.sort);
    // Cursors are order-specific, so a sort change always restarts from page one.
    state.nextCursor = null;
    // Phase 3A：结果集语义已变化，退出查看模式。
    if (state.viewMode === "asset") returnToLibrary();
    clearDetailSelection();
    void loadAssets();
  });
  els.detailPanel?.addEventListener("click", handleReferenceRightsOpen);
  els.assetGrid?.addEventListener("click", async (event) => {
    if (gallerySelection.handleGridClick(event)) return;
    const favoriteButton = event.target.closest(".card-favorite");
    if (favoriteButton) {
      event.stopPropagation();
      void toggleFavorite(favoriteButton.dataset.favId, event);
      return;
    }
    const copyButton = event.target.closest(".card-quick-copy");
    if (copyButton) {
      event.stopPropagation();
      void runAction(async () => {
        const assetId = copyButton.closest(".asset-card")?.dataset.id;
        const asset = state.assets.find((item) => item.id === assetId);
        await writeClipboardText(asset?.prompt || "");
        showToast(t("copySuccess"), "success");
      });
      return;
    }
    const selectButton = event.target.closest(".asset-card-select");
    if (selectButton) {
      // A browser emits the second click before dblclick. Let the dedicated
      // dblclick handler own that second activation so one double-click never
      // repeats Inspector selection work immediately before entering Viewer.
      if (event.detail > 1) return;
      const id = selectButton.closest(".asset-card")?.dataset.id;
      if (id && gallerySelection.handleCardClick(event, id)) return;
      if (id) {
        gallerySelection.clear();
        const asset = state.assets.find((item) => item.id === id);
        if (!state.activeStackId && asset?.stack?.id) {
          // A collapsed Stack is a logical gallery node. Single-click only
          // inspects the logical Stack; navigation is reserved for double-click
          // (or Enter), which prevents accidental entry while browsing.
          if (state.viewMode !== "library") return;
          void selectStackNode(asset);
          return;
        }
        void selectAsset(id);
      }
      return;
    }
    const loadMoreButton = event.target.closest('[data-action="load-more"]');
    if (loadMoreButton && state.nextCursor && !isLoadingMore) {
      isLoadingMore = true;
      loadMoreButton.disabled = true;
      void loadAssets({ append: true }).then((applied) => {
        if (!applied && loadMoreButton.isConnected) {
          loadMoreButton.disabled = false;
          showToast(state.galleryError?.message || t("loadFailed"), "error");
        }
      }).finally(() => { isLoadingMore = false; });
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
  els.assetGrid?.addEventListener("dblclick", (event) => {
    const selectButton = event.target.closest(".asset-card-select");
    if (!selectButton) return;
    event.stopPropagation();
    const card = selectButton.closest(".asset-card");
    const id = card?.dataset.id;
    if (!id) return;
    const asset = state.assets.find((item) => item.id === id);
    if (!state.activeStackId && (card?.dataset.stackId || asset?.stack?.id)) {
      if (asset?.stack?.id) void assetStacks.enterStack(asset.stack.id, asset.stack);
      return;
    }
    void openAssetView(id, selectButton);
  });
  els.emptyTrashBtn?.addEventListener("click", async () => {
    if (state.scope !== "trash" || !Number(state.groups?.trash || 0)) return;
    const confirmed = await requestConfirmation({
      title: t("emptyTrashTitle"),
      description: t("emptyTrashDescription"),
      confirmLabel: t("emptyTrash"),
      tone: "danger",
    });
    if (!confirmed) return;
    await runAction(async () => {
      await releaseAssetMediaForDeletion(state.assets);
      const result = await apiFetch("/api/trash", { method: "DELETE", body: { projectId: state.project } });
      if (result.partial) {
        showToast(t("trashPartialDelete", { count: result.failed?.length || 0 }), "error");
      } else {
        showToast(t("trashEmptied"), "success");
      }
      clearDetailSelection();
      gallerySelection.clear();
      await Promise.all([loadStats(), loadAssets()]);
    });
  });
  els.newAssetTopBtn?.addEventListener("click", openImportModal);
  els.browseFileBtn?.addEventListener("click", () => {
    if (state.importSaving) return;
    if (els.importFileInput) {
      els.importFileInput.value = "";
      els.importFileInput.click();
    }
  });
  els.importFileInput?.addEventListener("change", () => {
    const file = els.importFileInput.files?.[0];
    if (file) void prepareImportFile(file, { openModal: false });
  });
  const importDropZone = els.browseFileBtn?.closest(".import-v2-path-card");
  ["dragenter", "dragover"].forEach((eventName) => {
    importDropZone?.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      importDropZone.classList.add("drag-active");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    importDropZone?.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      // P3-3: Only remove drag-active if leaving the zone entirely (not entering a child)
      if (eventName === "dragleave") {
        const related = event.relatedTarget;
        if (related instanceof Node && importDropZone.contains(related)) return;
      }
      importDropZone.classList.remove("drag-active");
      if (eventName !== "drop") return;
      // P1-3: Prevent drop during import save to avoid phantom path race
      if (state.importSaving) return;
      const files = event.dataTransfer?.files;
      if (!files || !files.length) return;
      // P2-1: Multi-file drop indication
      if (files.length > 1) {
        showToast(t("multipleFilesIgnored"), "info");
      }
      const file = files[0];
      if (file) void prepareImportFile(file, { openModal: false });
    });
  });
  els.quickFilters?.addEventListener("click", (event) => { const button = event.target.closest("[data-filter]"); if (button) void setFilter(button.dataset.filter); });
  els.smartGroupsToggle?.addEventListener("click", () => setSidebarSectionCollapsed("smart", !state.sidebarSmartCollapsed));
  els.assetCategoriesToggle?.addEventListener("click", () => setSidebarSectionCollapsed("manual", !state.sidebarManualCollapsed));
  els.sidebarGroupList?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]"); if (button) void setFilter(button.dataset.filter, button.dataset.value);
  });
  els.addGroupBtn?.addEventListener("click", (event) => {
    event.preventDefault();
    startSidebarGroupCreate();
  });
  els.sidebarManualGroupList?.addEventListener("click", (event) => {
    if (event.target.closest("[data-sidebar-group-editor]")) return;
    const button = event.target.closest("[data-filter]");
    if (button) void setFilter(button.dataset.filter, button.dataset.value);
  });
  els.sidebarManualGroupList?.addEventListener("dblclick", (event) => {
    const button = event.target.closest('[data-filter="group"][data-value]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    startSidebarGroupRename(button.dataset.value);
  });
  els.sidebarManualGroupList?.addEventListener("input", (event) => {
    const input = event.target.closest("[data-sidebar-group-input]");
    if (input && sidebarGroupEdit) sidebarGroupEdit.value = input.value;
  });
  els.sidebarManualGroupList?.addEventListener("keydown", (event) => {
    if (!event.target.closest("[data-sidebar-group-input]")) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void commitSidebarGroupEdit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelSidebarGroupEdit();
    }
  });
  els.sidebarManualGroupList?.addEventListener("focusout", (event) => {
    if (!event.target.closest("[data-sidebar-group-input]")) return;
    queueMicrotask(() => {
      if (sidebarGroupEdit && !els.sidebarManualGroupList?.contains(document.activeElement)) void commitSidebarGroupEdit();
    });
  });
  window.addEventListener("mosa:begin-sidebar-group-rename", (event) => startSidebarGroupRename(event.detail?.groupName));
  els.typeFilters?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-type]");
    if (!button || button.dataset.type === state.mediaKind) return;
    if (!await confirmDetailNavigation(null)) return;
    discardDetailDraft();
    state.mediaKind = button.dataset.type;
    renderTypeFilters();
    applyFilterChange();
  });
  els.settingsToggle?.addEventListener("click", toggleSettingsModal);
  els.settingsMenu?.addEventListener("change", async (event) => {
    const select = event.target.closest("[data-project-select]");
    if (!select) return;
    const previousProject = state.project;
    if (select.value === previousProject) return;
    if (!await confirmDetailNavigation(null)) {
      select.value = previousProject;
      return;
    }
    if (assetStacks.isBusy()) {
      select.value = previousProject;
      showToast(t("operationInProgress"), "default");
      return;
    }
    discardDetailDraft();
    if (state.activeStackId) assetStacks.abandonStackContext();
    state.project = select.value; clearDetailSelection(); state.scope = "all"; clearFacets(); state.query = ""; els.searchInput.value = ""; state.nextCursor = null;
    // Phase 3A：项目切换改变结果集语义，退出查看模式（设置菜单在侧栏，查看模式下仍可达）。
    if (state.viewMode === "asset") returnToLibrary();
    await loadStats(); await loadAssets();
    startLibraryEventStream();
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
      if (state.detailOpen && !isDetailEditorActive()) renderDetail();
      button.parentElement.querySelectorAll(".segmented-btn").forEach((b) => b.classList.remove("active"));
      button.classList.add("active");
      syncSegmentedRadios(els.settingsMenu); // aria-checked 与 .active 同步（Phase 5A / F-12）
      return;
    }

    const localeButton = event.target.closest("[data-locale]");
    if (localeButton) {
      return setLanguage(localeButton.dataset.locale);
    }
    const openLibraryButton = event.target.closest("[data-open-library]");
    if (openLibraryButton) runAction(async () => {
      const path = state.libraryRoot || state.libraryPath;
      if (!path) return;
      await apiFetch("/api/open-folder", { method: "POST", body: { path } });
      showToast(t("openInFinder"), "success");
    });
    const changeLibraryButton = event.target.closest("[data-change-library]");
    if (changeLibraryButton && window.electronAPI?.changeLibraryLocation && !state.libraryMoveInProgress) {
      void (async () => {
        state.libraryMoveInProgress = true;
        syncSettingsMenuView();
        try {
          const result = await window.electronAPI.changeLibraryLocation();
          if (!result || result.reason === "cancelled") return;
          if (!result.ok) {
            const key = result.reason === "not-empty"
              ? "libraryLocationNeedsEmpty"
              : result.reason === "managed"
                ? "libraryLocationManaged"
                : result.reason === "attached"
                  ? "libraryLocationAttached"
                  : "libraryMoveFailed";
            showToast(t(key), "error");
          }
        } catch {
          showToast(t("libraryMoveFailed"), "error");
        } finally {
          state.libraryMoveInProgress = false;
          syncSettingsMenuView();
        }
      })();
      return;
    }
    const checkUpdatesButton = event.target.closest("[data-check-updates]");
    if (checkUpdatesButton) { void checkForUpdates(); return; }
    const downloadLatestButton = event.target.closest("[data-download-latest]");
    if (downloadLatestButton) {
      void window.electronAPI?.openDownloadPage?.().then((result) => {
        if (!result?.ok) showToast(t("updateCheckFailed"), "error");
      });
    }
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
  // L：灯箱此前完全没有加载失败处理——图片 404 时舞台空白且无任何提示。
  // src 被移除（关闭预览）触发的 error 不属于真失败，需排除。
  els.imagePreviewImage?.addEventListener("error", () => {
    if (!els.imagePreviewModal?.hidden && els.imagePreviewImage?.getAttribute("src")) showToast(t("imageLoadFailed"), "error");
  });
  els.assetViewBack?.addEventListener("click", () => { void closeDetailSurface(); });
  // Phase 3A：Viewer 打开后返回按钮拥有进入焦点。舞台/主图上的普通 mousedown
  // 不应把焦点无意义地清到 BODY；视频元素排除在外，保留原生 controls 交互。
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
  // Settings 的 segmented radiogroup 在持久根节点上统一处理方向键。
  // 绑定在持久的 #settingsMenu 元素上：innerHTML 重建不会叠加监听器（全应用唯一一套）。
  els.settingsMenu?.addEventListener("keydown", handleSettingsMenuKeydown);
  window.addEventListener("resize", () => { syncMobileNavigation(); if (state.imagePreviewId) fitImagePreview(); });

  bindContextMenuEvents({
    state,
    els,
    contextMenu,
    contextMenuActions,
    loadAssets,
    loadStats,
    reloadLoadedAssetPages: apiClient.reloadLoadedAssetPages,
    renderGrid,
    updateViewTitle,
    selectAsset,
    openAssetView,
    showToast,
    t,
    gallerySelection,
  });
  // Phase 5B：ConfirmDialog 陷阱先于其余陷阱注册——Escape 优先级链最前（preventDefault +
  // stopPropagation，不穿透 Viewer/既有 Modal）；ConfirmDialog 未打开时后续陷阱照常工作。
  document.addEventListener("keydown", trapConfirmDialogFocus);
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
    if (els.importModal?.classList.contains("open") || els.groupModal?.classList.contains("open") || !els.imagePreviewModal?.hidden) return;
    if (!els.settingsMenu?.hidden) return;
    if (isInspectorDocked()) return;
    event.preventDefault();
    void closeDetailSurface();
  });
  bindDesktopIntegration();
}

function bindDesktopIntegration() {
  const api = window.electronAPI;
  if (!api) return;
  document.addEventListener("paste", async (event) => {
    const target = event.target;
    const editableTarget = target instanceof Element && Boolean(target.closest("input, textarea, select, [contenteditable]"));
    const blockingSurfaceOpen = Boolean(
      confirmDialogState.pending
      || !els.settingsMenu?.hidden
      || !els.imagePreviewModal?.hidden
      || els.importModal?.classList.contains("open")
      || els.groupModal?.classList.contains("open")
    );
    // Never steal paste from a native editor, and never stack an Import modal
    // on top of another modal/lightbox. Image paste remains available from the
    // normal app canvas where it is an intentional import shortcut.
    if (editableTarget || blockingSurfaceOpen) return;
    const items = event.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        event.preventDefault();
        await pasteClipboardImage();
        return;
      }
    }
  });
  api.onMenuImport?.(() => openImportModal());
  api.onMenuSearch?.(() => { els.searchInput?.focus(); });
}

async function pasteClipboardImage() {
  const api = window.electronAPI;
  if (!api?.pasteImage || state.stagingInProgress) return false;
  state.stagingInProgress = true;
  state.stagingCanceled = false;
  try {
    const filePath = await api.pasteImage();
    if (!filePath) return false;
    if (state.stagingCanceled) {
      await cleanupStagedFile(filePath);
      return false;
    }
    if (state.stagedPath && state.stagedPath !== filePath) await cleanupStagedFile(state.stagedPath);
    if (state.stagingCanceled) {
      await cleanupStagedFile(filePath);
      return false;
    }
    state.stagedPath = filePath;
    if (!els.imagePathInput) {
      state.stagedPath = "";
      await cleanupStagedFile(filePath);
      return false;
    }
    els.imagePathInput.value = filePath;
    openImportModal();
    if (!els.importModal?.classList.contains("open")) {
      state.stagedPath = "";
      els.imagePathInput.value = "";
      await cleanupStagedFile(filePath);
      return false;
    }
    return true;
  } catch (error) {
    if (!state.stagingCanceled) showToast(t("pasteImageSaveFailed"), "error");
    return false;
  } finally {
    state.stagingInProgress = false;
    state.stagingCanceled = false;
  }
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

function isSidebarNavigationActive(type, value = "") {
  const hasSourceSelection = Boolean(state.facets.source);
  const hasGroupSelection = Boolean(state.facets.group);
  if (type === "source") {
    return state.scope === "all" && !hasGroupSelection && state.facets.source === value;
  }
  if (type === "group") {
    return state.scope === "all" && !hasSourceSelection && state.facets.group === value;
  }
  return SCOPES.includes(type) && !hasSourceSelection && !hasGroupSelection && state.scope === type;
}

/**
 * The sidebar is navigation, not a facet-builder. Its three visual zones
 * (primary scopes, smart source groups, manual groups) share one selection.
 * Other refinements such as media type/style may still refine that selection.
 */
function setSidebarNavigationState(type, value = "") {
  const navType = type;
  const navValue = value;

  if (navType === "all") {
    state.scope = "all";
    clearFacets();
    return true;
  }

  if (SCOPES.includes(navType)) {
    state.scope = navType;
    state.facets.source = "";
    state.facets.group = "";
    return true;
  }

  if (navType === "source" || navType === "group") {
    const wasActive = isSidebarNavigationActive(navType, navValue);
    state.scope = "all";
    state.facets.source = "";
    state.facets.group = "";
    if (!wasActive) state.facets[navType] = navValue;
    return true;
  }

  return false;
}

/** One entry point for the three sidebar navigation zones. */
async function setFilter(type, value = "") {
  const valid = type === "all" || SCOPES.includes(type) || type === "source" || type === "group";
  if (!valid) return;
  if (!await confirmDetailNavigation(null)) return;
  discardDetailDraft();
  if (!setSidebarNavigationState(type, value)) return;
  applyFilterChange();
}

function clearFacets() {
  for (const key of FACET_KEYS) state.facets[key] = "";
}

function applyFilterChange() {
  // A filter change restarts paging, so any cursor from the previous query is stale.
  state.nextCursor = null;
  // Phase 3A：结果集语义已变化，退出查看模式。
  if (state.viewMode === "asset") returnToLibrary();
  clearDetailSelection();
  renderQuickFilters(); renderTypeFilters(); loadAssets();
}

async function showRelatedGenerations(asset, mode) {
  const conversationId = String(asset?.source?.conversation_id || "").trim();
  const messageId = String(asset?.source?.message_id || "").trim();
  if (!conversationId || (mode === "batch" && !messageId)) return;
  if (!await confirmDetailNavigation(null)) return;
  discardDetailDraft();
  state.scope = "all";
  state.mediaKind = "all";
  clearFacets();
  state.facets.conversation = conversationId;
  if (mode === "batch") state.facets.generationBatch = messageId;
  applyFilterChange();
}

function closePanel(panel, trigger, reason = "escape") {
  if (panel === els.settingsMenu) { closeSettingsModal({ restoreFocus: reason !== "outside-pointer" }); return; }
  if (!panel) return;
  panel.hidden = true;
  trigger?.setAttribute("aria-expanded", "false");
}

// Settings keeps native button semantics; segmented radiogroups additionally
// support desktop arrow-key navigation without introducing a second UI state.
function handleSettingsMenuKeydown(event) {
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
    event.stopPropagation();
    buttons[next].click(); // 复用既有主题/密度 click 业务路径，逻辑零分叉
    buttons[next].focus();
    return;
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
  // 控件在保存期间是 disabled（focus 对其是 no-op）；rAF 晚于调用方的 finally，
  // 到那时按钮已恢复可用，焦点才能真正落到出错字段上。
  requestAnimationFrame(() => target.input?.focus());
}

function setImportBusy(busy) {
  state.importSaving = busy;
  els.importModal?.querySelectorAll("input, textarea, select, button").forEach((control) => { control.disabled = busy; });
  if (els.saveAssetBtn) {
    els.saveAssetBtn.setAttribute("aria-busy", String(busy));
    els.saveAssetBtn.textContent = busy ? t("savingAsset") : t("saveAsset");
  }
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
  const originProjectId = state.project;
  const originAssetId = state.selectedId;
  const hadDetailDraft = state.detailDirty;
  // 防重窗口必须先于 confirmDetailNavigation 的网络级冲刷打开（PATCH + 两次
  // 刷新，数百毫秒）--否则冲刷期间的双击会重复走到 POST /api/assets/create，
  // 同一文件被导入两份。
  setImportBusy(true);
  try {
    if (hadDetailDraft && !await confirmDetailNavigation(null)) return;
    const result = await apiFetch("/api/assets/create", { method: "POST", body: { projectId: originProjectId, imagePath: els.imagePathInput.value, prompt: els.promptInput.value, skill: els.skillInput.value, style: els.styleInput.value, ratio: els.ratioInput.value, theme: els.themeInput.value, group: els.groupInput.value, category: els.categoryInput.value, tags: uniqueTags([...(derivePromptTags({ prompt: els.promptInput.value, skill: els.skillInput.value, style: els.styleInput.value, theme: els.themeInput.value, category: els.categoryInput.value }))]), business_fields: businessFields } });
    if (hadDetailDraft && originProjectId === state.project && originAssetId === state.selectedId) discardDetailDraft();
    state.selectedId = result.asset.id;
    clearImportForm(); closeImportModal({ force: true }); showToast(`${t("savedAsset")} · ${result.asset.id}`, "success");
    // P3-2: Parallel loadStats and loadAssets for faster UI refresh
    await Promise.all([loadStats(), loadAssets()]);
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
  const counts = { all: state.groups.total, favorite: state.groups.favorites, unorganized: state.groups.unorganized, trash: state.groups.trash };
  els.quickFilters.querySelectorAll("[data-filter]").forEach((button) => { const active = isSidebarNavigationActive(button.dataset.filter); button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active)); button.querySelector(".nav-count").textContent = counts[button.dataset.filter] ?? "—"; });
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

/** The sidebar groups automatic assets by their actual capture / bridge source. */
function renderSidebarGroups() {
  if (!els.sidebarGroupList) return;
  const counts = new Map(Array.isArray(state.groups.sourceTypes) ? state.groups.sourceTypes : []);
  const shown = SIDEBAR_SOURCE_TYPES
    .map((sourceType) => [sourceType, Number(counts.get(sourceType) || 0)])
    .filter(([, count]) => count > 0);
  const items = shown.map(([sourceType, count]) => {
    const active = isSidebarNavigationActive("source", sourceType);
    const label = sourceTypeLabel(sourceType);
    const color = deterministicGroupColor(sourceType);
    return `<li><button class="nav-item nav-group-item${active ? " active" : ""}" data-filter="source" data-value="${escapeHtml(sourceType)}" type="button" aria-pressed="${active}"><span class="nav-group-dot" data-group-color="${escapeHtml(color)}" aria-hidden="true"></span><span class="nav-item-text" title="${escapeHtml(label)}">${escapeHtml(label)}</span><span class="nav-count">${count}</span></button></li>`;
  }).join("");
  els.sidebarGroupList.innerHTML = items;

  if (!els.sidebarManualGroupList) return;
  const manualItems = (Array.isArray(state.groups.groups) ? state.groups.groups : []).map(([groupName, count]) => {
    if (sidebarGroupEdit?.mode === "rename" && sidebarGroupEdit.originalName === groupName) {
      return sidebarGroupEditorMarkup(groupName, sidebarGroupEdit.value, colorForGroup(groupName));
    }
    const active = isSidebarNavigationActive("group", groupName);
    const color = colorForGroup(groupName);
    return `<li><button class="nav-item nav-group-item${active ? " active" : ""}" data-filter="group" data-value="${escapeHtml(groupName)}" type="button" aria-pressed="${active}"><span class="nav-group-dot" data-group-color="${escapeHtml(color)}" aria-hidden="true"></span><span class="nav-item-text" title="${escapeHtml(groupName)}">${escapeHtml(groupName)}</span><span class="nav-count">${Number(count || 0)}</span></button></li>`;
  }).join("");
  const createEditor = sidebarGroupEdit?.mode === "create"
    ? sidebarGroupEditorMarkup("", sidebarGroupEdit.value, sidebarGroupEdit.color)
    : "";
  els.sidebarManualGroupList.innerHTML = `${manualItems}${createEditor}`;
  syncSidebarSectionVisibility();
  if (sidebarGroupEdit) requestAnimationFrame(focusSidebarGroupEditor);
}

function syncSidebarSectionVisibility() {
  const sync = (toggle, list, collapsed) => {
    if (list) list.hidden = collapsed;
    if (toggle) toggle.setAttribute("aria-expanded", String(!collapsed));
  };
  sync(els.smartGroupsToggle, els.sidebarGroupList, state.sidebarSmartCollapsed);
  sync(els.assetCategoriesToggle, els.sidebarManualGroupList, state.sidebarManualCollapsed);
}

function setSidebarSectionCollapsed(section, collapsed) {
  if (section === "smart") {
    state.sidebarSmartCollapsed = Boolean(collapsed);
    safeStorageSet("mosa.sidebar-smart-collapsed", String(state.sidebarSmartCollapsed));
  } else if (section === "manual") {
    state.sidebarManualCollapsed = Boolean(collapsed);
    safeStorageSet("mosa.sidebar-manual-collapsed", String(state.sidebarManualCollapsed));
  } else {
    return;
  }
  syncSidebarSectionVisibility();
}

function sidebarGroupEditorMarkup(originalName, value = "", color = GROUP_COLORS[0]) {
  return `<li class="sidebar-group-editor" data-sidebar-group-editor data-original-name="${escapeHtml(originalName)}"><span class="sidebar-group-editor-dot" data-group-color="${escapeHtml(color)}" aria-hidden="true"></span><input class="sidebar-group-editor-input" data-sidebar-group-input type="text" maxlength="80" value="${escapeHtml(value)}" placeholder="${escapeHtml(t("inlineGroupPlaceholder"))}" aria-label="${escapeHtml(t(originalName ? "renameGroup" : "addGroup"))}" /></li>`;
}

function focusSidebarGroupEditor() {
  const input = els.sidebarManualGroupList?.querySelector("[data-sidebar-group-input]");
  if (!(input instanceof HTMLInputElement)) return;
  if (document.activeElement !== input) {
    input.focus();
    input.select();
  }
}

function startSidebarGroupCreate() {
  setSidebarSectionCollapsed("manual", false);
  if (sidebarGroupEdit) return focusSidebarGroupEditor();
  sidebarGroupEdit = { mode: "create", value: "", color: GROUP_COLORS[0], saving: false };
  renderSidebarGroups();
}

function startSidebarGroupRename(groupName) {
  const name = String(groupName || "").trim();
  if (!name) return;
  setSidebarSectionCollapsed("manual", false);
  sidebarGroupEdit = { mode: "rename", originalName: name, value: name, color: colorForGroup(name), saving: false };
  renderSidebarGroups();
}

function cancelSidebarGroupEdit() {
  if (!sidebarGroupEdit || sidebarGroupEdit.saving) return;
  sidebarGroupEdit = null;
  renderSidebarGroups();
}

async function commitSidebarGroupEdit() {
  const draft = sidebarGroupEdit;
  if (!draft || draft.saving) return;
  const input = els.sidebarManualGroupList?.querySelector("[data-sidebar-group-input]");
  const name = String(input?.value ?? draft.value ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
  if (!name) {
    cancelSidebarGroupEdit();
    return;
  }
  if (draft.mode === "rename" && name === draft.originalName) {
    cancelSidebarGroupEdit();
    return;
  }
  draft.value = name;
  draft.saving = true;
  if (input instanceof HTMLInputElement) input.disabled = true;
  try {
    if (draft.mode === "create") {
      const result = await apiFetch("/api/groups", { method: "POST", body: { projectId: state.project, name } });
      saveGroupColor(result.group.name, draft.color);
      showToast(`${t("groupCreated")}${result.group.name}`, "success");
    } else {
      const originalName = draft.originalName;
      const result = await apiFetch(`/api/groups/${encodeURIComponent(originalName)}`, {
        method: "PATCH",
        body: { projectId: state.project, name },
      });
      const colors = groupColorMap();
      const previousColor = colors[originalName] || draft.color;
      delete colors[originalName];
      colors[result.group.name] = GROUP_COLORS.includes(previousColor) ? previousColor : deterministicGroupColor(result.group.name);
      safeStorageSet(groupColorStorageKey(), JSON.stringify(colors));
      if (state.facets.group === originalName) state.facets.group = result.group.name;
      showToast(`${t("groupRenamed")}${result.group.name}`, "success");
    }
    sidebarGroupEdit = null;
    await loadStats();
    if (draft.mode === "rename" && state.facets.group) await loadAssets();
  } catch (error) {
    draft.saving = false;
    if (input instanceof HTMLInputElement) input.disabled = false;
    showToast(error?.message || t("groupNameRequired"), "error");
    focusSidebarGroupEditor();
  }
}

let masonryResizeObserver = null;
let masonryObservedGrid = null;
let masonryObservedWidth = 0;
let masonryLayoutFrame = null;
let masonryFullLayoutPending = false;
const masonryPendingCards = new Set();
let galleryMediaObserver = null;
let galleryMediaObservedGrid = null;
let galleryCardVirtualObserver = null;
let galleryCardVirtualObservedGrid = null;
let galleryCardVirtualScrollGrid = null;
let galleryCardVirtualLastScrollTop = Number.NEGATIVE_INFINITY;
const galleryCardVirtualVisiblePendingChanges = new Map();
const galleryCardVirtualBackgroundPendingChanges = new Map();
let galleryCardVirtualBatchFrame = null;
let galleryCardVirtualWindowFrame = null;
const galleryCardVirtualEntries = new Map();
const galleryCardVirtualNodes = new Map();
const galleryCardVirtualHydratedIds = new Set();
const galleryCardVirtualSpanCache = new Map();
let galleryCardVirtualColumnWidth = 180;
let galleryCardVirtualGeometryColumns = [];
const galleryCardVirtualGeometryById = new Map();
const GALLERY_CARD_VIRTUAL_THRESHOLD = 40;
const GALLERY_CARD_INITIAL_HYDRATE = 40;
const GALLERY_CARD_DOM_WINDOW_THRESHOLD = 240;
const GALLERY_CARD_DOM_PRELOAD = 1800;

function galleryVirtualSpanKey(assetId, columnWidth = galleryCardVirtualColumnWidth) {
  return `${state.galleryDensity}\u001f${Math.round(columnWidth)}\u001f${assetId}`;
}

function galleryCardColumnWidth(styles = null) {
  const grid = els.assetGrid;
  if (!grid) return 180;
  const tracks = (styles || getComputedStyle(grid)).gridTemplateColumns.split(/\s+/).map(Number.parseFloat).filter((value) => Number.isFinite(value) && value > 0);
  if (tracks.length) return tracks[0];
  return Math.max(120, grid.clientWidth / 5);
}

function galleryAssetAspect(asset = {}) {
  const width = Number(asset.width || asset.business_fields?.width);
  const height = Number(asset.height || asset.business_fields?.height);
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) return height / width;
  const match = /^\s*(\d+(?:\.\d+)?)\s*[:/x×]\s*(\d+(?:\.\d+)?)\s*$/iu.exec(String(asset.ratio || ""));
  if (match) {
    const ratioWidth = Number(match[1]);
    const ratioHeight = Number(match[2]);
    if (ratioWidth > 0 && ratioHeight > 0) return ratioHeight / ratioWidth;
  }
  return 1;
}

function estimatedGalleryCardSpan(asset) {
  const cached = galleryCardVirtualSpanCache.get(galleryVirtualSpanKey(asset.id));
  if (cached) return cached;
  // Placeholder geometry must follow the same intrinsic aspect ratio as the
  // real media element. Capping tall assets here makes the placeholder shorter
  // than the hydrated card, so the real card can overflow into the next
  // masonry slot. Estimates are allowed to be approximate, but never
  // deliberately shorter than the media ratio we already know.
  const mediaHeight = galleryCardColumnWidth() * Math.max(0.35, galleryAssetAspect(asset));
  const infoHeight = state.galleryDensity === "info" ? 44 : 0;
  const grid = els.assetGrid;
  const styles = grid ? getComputedStyle(grid) : null;
  const gap = styles ? (Number.parseFloat(styles.getPropertyValue("--gallery-gap")) || Number.parseFloat(styles.columnGap) || 0) : 0;
  return Math.max(48, Math.ceil(mediaHeight + infoHeight + gap));
}

function virtualGalleryCardEntry(entry) {
  const span = estimatedGalleryCardSpan(entry.asset);
  return {
    ...entry,
    renderKey: `${entry.renderKey}\u001fvirtual`,
    animateCard: false,
    markup: `<article class="asset-card asset-card-virtual-placeholder" data-id="${escapeHtml(entry.id)}" data-virtual-span="${span}" aria-hidden="true"><span class="asset-card-virtual-surface"></span></article>`,
  };
}

function shouldHydrateGalleryCard(entry, ordinal) {
  if (state.assets.length < GALLERY_CARD_VIRTUAL_THRESHOLD) return true;
  if (ordinal < GALLERY_CARD_INITIAL_HYDRATE) return true;
  if (entry.id === state.selectedId || galleryCardVirtualHydratedIds.has(entry.id)) return true;
  return false;
}

function replaceVirtualGalleryCards(observerEntries) {
  const grid = els.assetGrid;
  const bottomOffset = grid ? Math.max(0, grid.scrollHeight - grid.scrollTop - grid.clientHeight) : null;
  const preserveBottomOffset = bottomOffset !== null && bottomOffset <= 1200;
  const replacements = [];
  for (const item of observerEntries) {
    const card = item.target;
    if (!(card instanceof HTMLElement) || !card.isConnected) continue;
    const entry = galleryCardVirtualEntries.get(card.dataset.id || "");
    if (!entry) continue;
    const hydrate = item.isIntersecting;
    if (hydrate && !card.classList.contains("asset-card-virtual-placeholder")) continue;
    if (!hydrate && card.classList.contains("asset-card-virtual-placeholder")) continue;
    if (!hydrate && (card.contains(document.activeElement) || card.classList.contains("selected") || card.matches(".stack-drop-target, .stack-reorder-target"))) continue;

    if (!hydrate) {
      const span = Number.parseInt(String(card.style.gridRowEnd || "").replace(/\D+/g, ""), 10);
      if (Number.isFinite(span) && span > 0) galleryCardVirtualSpanCache.set(galleryVirtualSpanKey(entry.id), span);
    }
    replacements.push({ card, entry, hydrate });
  }
  if (!replacements.length) return;

  const replacementEntries = replacements.map(({ entry, hydrate }) => hydrate ? entry : virtualGalleryCardEntry(entry));
  const createdCards = createAssetCardElements(replacementEntries);
  const hydratedCards = [];
  const changedIds = new Set();
  let changed = false;

  replacements.forEach(({ card, entry, hydrate }) => {
    const replacement = createdCards.get(entry.id);
    if (!replacement) return;
    galleryCardVirtualObserver?.unobserve(card);
    if (card.style.gridColumnStart) replacement.style.gridColumnStart = card.style.gridColumnStart;
    if (card.style.gridRowStart) replacement.style.gridRowStart = card.style.gridRowStart;
    if (hydrate && card.style.gridRowEnd) replacement.style.gridRowEnd = card.style.gridRowEnd;
    if (hydrate) {
      galleryCardVirtualHydratedIds.add(entry.id);
      hydratedCards.push(replacement);
    } else {
      galleryCardVirtualHydratedIds.delete(entry.id);
      releaseObservedGalleryMedia(card);
    }
    card.replaceWith(replacement);
    galleryCardVirtualNodes.set(entry.id, replacement);
    galleryCardVirtualObserver?.observe(replacement);
    changedIds.add(entry.id);
    changed = true;
  });

  // Placeholder geometry is only a scroll-stability estimate. Once a real card
  // is mounted, validate that estimate on the next animation frame. The
  // masonry scheduler batches all hydrated cards and reflows placement only if
  // a measured span actually changed, so correctness no longer depends on
  // metadata being perfect without reintroducing synchronous scroll jank.
  if (hydratedCards.length) {
    setupGalleryMediaVirtualization(hydratedCards);
    hydratedCards.forEach((card) => scheduleMasonryLayout(card));
  }
  if (changed) {
    invalidateCardGeometryCache();
    gallerySelection.syncRenderedSelection({ prune: false, changedIds });
    if (preserveBottomOffset && grid) {
      const targetScrollTop = Math.max(0, grid.scrollHeight - grid.clientHeight - bottomOffset);
      if (Math.abs(grid.scrollTop - targetScrollTop) > 0.5) grid.scrollTop = targetScrollTop;
    }
  }
}

function flushGalleryCardVirtualPendingChanges() {
  galleryCardVirtualBatchFrame = null;
  const grid = els.assetGrid;
  if (!grid || (!galleryCardVirtualVisiblePendingChanges.size && !galleryCardVirtualBackgroundPendingChanges.size)) return;
  const batch = [];
  const takeChanges = (pending, limit) => {
    let taken = 0;
    for (const [id, change] of pending) {
      if (taken >= limit) break;
      pending.delete(id);
      if (!change.target?.isConnected) continue;
      batch.push(change);
      taken += 1;
    }
  };
  // Normal scrolling should hydrate from the 1200px warm zone before a card is
  // visible. If a fast fling outruns that runway, resolve a bounded visible
  // batch per frame rather than freezing the compositor to hydrate the whole
  // viewport synchronously.
  if (galleryCardVirtualVisiblePendingChanges.size) takeChanges(galleryCardVirtualVisiblePendingChanges, 6);
  // Eviction must make progress in the same frame as visible hydration. If
  // the background queue waited for the visible queue to empty, a fast scroll
  // would retain every card it ever visited and defeat DOM virtualization.
  takeChanges(galleryCardVirtualBackgroundPendingChanges, 6);
  if (batch.length) replaceVirtualGalleryCards(batch);
  if (galleryCardVirtualVisiblePendingChanges.size || galleryCardVirtualBackgroundPendingChanges.size) {
    galleryCardVirtualBatchFrame = requestAnimationFrame(flushGalleryCardVirtualPendingChanges);
  }
}

function scheduleGalleryCardVirtualPendingChanges() {
  if (galleryCardVirtualBatchFrame !== null || (!galleryCardVirtualVisiblePendingChanges.size && !galleryCardVirtualBackgroundPendingChanges.size)) return;
  galleryCardVirtualBatchFrame = requestAnimationFrame(flushGalleryCardVirtualPendingChanges);
}

function queueGalleryCardVirtualChange(change, visible = false) {
  const card = change?.target;
  const id = card?.dataset?.id || "";
  if (!id) return;
  if (visible) {
    galleryCardVirtualBackgroundPendingChanges.delete(id);
    galleryCardVirtualVisiblePendingChanges.set(id, change);
    return;
  }
  // IntersectionObserver notifications can be delivered after a synchronous
  // indexed scroll check. Never let an older warm-zone notification demote a
  // card that the current viewport has already promoted to visible priority.
  if (galleryCardVirtualVisiblePendingChanges.has(id)) return;
  galleryCardVirtualBackgroundPendingChanges.set(id, change);
}

function galleryCardVirtualLowerBound(column, minRow) {
  let low = 0;
  let high = column.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (column[middle].rowEnd < minRow) low = middle + 1;
    else high = middle;
  }
  return low;
}

function galleryCardVirtualNode(grid, id) {
  const cached = galleryCardVirtualNodes.get(id);
  if (cached?.isConnected && cached.parentElement === grid && cached.dataset.id === id) return cached;
  if (cached) galleryCardVirtualNodes.delete(id);
  const card = grid.querySelector(`:scope > .asset-card[data-id="${CSS.escape(id)}"]`);
  if (card) galleryCardVirtualNodes.set(id, card);
  return card;
}

function mountGalleryVirtualCard(grid, id, hydrate = false) {
  const entry = galleryCardVirtualEntries.get(id);
  const geometry = galleryCardVirtualGeometryById.get(id);
  if (!entry || !geometry) return null;
  const created = createAssetCardElements([hydrate ? entry : virtualGalleryCardEntry(entry)]).get(id) || null;
  if (!created) return null;
  created.style.gridColumnStart = String(geometry.columnIndex + 1);
  created.style.gridRowStart = String(geometry.rowStart);
  created.style.gridRowEnd = `span ${Math.max(1, geometry.rowEnd - geometry.rowStart)}`;
  const pagination = grid.querySelector(":scope > .asset-load-more, :scope > .infinite-scroll-sentinel, :scope > .gallery-virtual-extent");
  grid.insertBefore(created, pagination || null);
  galleryCardVirtualNodes.set(id, created);
  if (hydrate) {
    galleryCardVirtualHydratedIds.add(id);
    setupGalleryMediaVirtualization([created]);
    scheduleMasonryLayout(created);
  } else {
    galleryCardVirtualHydratedIds.delete(id);
  }
  galleryCardVirtualObserver?.observe(created);
  return created;
}

function galleryVirtualExtentRow() {
  let rowEnd = 1;
  for (const column of galleryCardVirtualGeometryColumns) {
    const last = column.at(-1);
    if (last?.rowEnd > rowEnd) rowEnd = last.rowEnd;
  }
  return rowEnd;
}

function syncGalleryVirtualExtent() {
  const grid = els.assetGrid;
  if (!grid) return;
  let extent = grid.querySelector(":scope > .gallery-virtual-extent");
  if (state.assets.length < GALLERY_CARD_DOM_WINDOW_THRESHOLD) {
    extent?.remove();
    return;
  }
  if (!extent) {
    extent = document.createElement("div");
    extent.className = "gallery-virtual-extent";
    extent.setAttribute("aria-hidden", "true");
    grid.append(extent);
  }
  const row = galleryVirtualExtentRow();
  extent.style.gridRowStart = String(row);
  extent.style.gridColumn = "1 / -1";
  grid.querySelectorAll(":scope > .asset-load-more, :scope > .infinite-scroll-sentinel").forEach((element) => {
    element.style.gridRowStart = String(row + 1);
    element.style.gridColumn = "1 / -1";
  });
}

function pruneGalleryCardDomWindow() {
  const grid = els.assetGrid;
  if (!grid || state.assets.length < GALLERY_CARD_DOM_WINDOW_THRESHOLD) {
    syncGalleryVirtualExtent();
    return;
  }
  const minRow = Math.max(0, grid.scrollTop - GALLERY_CARD_DOM_PRELOAD);
  const maxRow = grid.scrollTop + grid.clientHeight + GALLERY_CARD_DOM_PRELOAD;
  grid.querySelectorAll(":scope > .asset-card").forEach((card) => {
    const id = card.dataset.id || "";
    const geometry = galleryCardVirtualGeometryById.get(id);
    if (!geometry || (geometry.rowEnd >= minRow && geometry.rowStart <= maxRow)) return;
    if (id === state.selectedId || card.contains(document.activeElement) || card.matches(".selected, .stack-drop-target, .stack-reorder-target")) return;
    releaseObservedGalleryMedia(card);
    galleryCardVirtualObserver?.unobserve(card);
    galleryCardVirtualHydratedIds.delete(id);
    galleryCardVirtualNodes.delete(id);
    card.remove();
  });
  syncGalleryVirtualExtent();
}

function syncGalleryCardVirtualWindow() {
  const grid = els.assetGrid;
  if (!grid || state.assets.length < GALLERY_CARD_VIRTUAL_THRESHOLD) return;
  const preload = 1200;
  const minRow = Math.max(0, grid.scrollTop - preload);
  const maxRow = grid.scrollTop + grid.clientHeight + preload;
  const visibleMinRow = grid.scrollTop;
  const visibleMaxRow = grid.scrollTop + grid.clientHeight;
  const desiredVisible = new Map();
  const desiredBackground = new Map();
  // Masonry placement produces ordered, non-overlapping ranges per column.
  // Binary-search those ranges so scroll work is proportional to the viewport
  // instead of to every loaded asset in the library.
  for (const column of galleryCardVirtualGeometryColumns) {
    for (let index = galleryCardVirtualLowerBound(column, minRow); index < column.length; index += 1) {
      const geometry = column[index];
      if (geometry.rowStart > maxRow) break;
      const visible = geometry.rowEnd >= visibleMinRow && geometry.rowStart <= visibleMaxRow;
      const card = galleryCardVirtualNode(grid, geometry.id) || mountGalleryVirtualCard(grid, geometry.id, visible);
      if (visible && card && !card.classList.contains("asset-card-virtual-placeholder")) continue;
      if (!card?.classList.contains("asset-card-virtual-placeholder")) continue;
      const change = { target: card, isIntersecting: true };
      if (visible) desiredVisible.set(geometry.id, change);
      else desiredBackground.set(geometry.id, change);
    }
  }
  for (const id of galleryCardVirtualHydratedIds) {
    const geometry = galleryCardVirtualGeometryById.get(id);
    if (!geometry || (geometry.rowEnd >= minRow && geometry.rowStart <= maxRow)) continue;
    const card = galleryCardVirtualNode(grid, id);
    if (card && !card.classList.contains("asset-card-virtual-placeholder")) {
      desiredBackground.set(id, { target: card, isIntersecting: false });
    }
  }
  for (const id of galleryCardVirtualVisiblePendingChanges.keys()) {
    if (!desiredVisible.has(id)) galleryCardVirtualVisiblePendingChanges.delete(id);
  }
  for (const id of galleryCardVirtualBackgroundPendingChanges.keys()) {
    if (!desiredBackground.has(id)) galleryCardVirtualBackgroundPendingChanges.delete(id);
  }
  desiredVisible.forEach((change, id) => {
    galleryCardVirtualBackgroundPendingChanges.delete(id);
    galleryCardVirtualVisiblePendingChanges.set(id, change);
  });
  desiredBackground.forEach((change, id) => {
    if (!galleryCardVirtualVisiblePendingChanges.has(id)) galleryCardVirtualBackgroundPendingChanges.set(id, change);
  });
  // The scroll callback only updates intent. DOM replacement is frame-budgeted
  // by the scheduler below, keeping the scroll path read-mostly and compositor
  // friendly even during very large jumps.
  scheduleGalleryCardVirtualPendingChanges();
  pruneGalleryCardDomWindow();
}

function scheduleGalleryCardVirtualWindowSync() {
  if (galleryCardVirtualWindowFrame !== null) return;
  galleryCardVirtualWindowFrame = requestAnimationFrame(() => {
    galleryCardVirtualWindowFrame = null;
    syncGalleryCardVirtualWindow();
  });
}

function handleGalleryCardVirtualScroll() {
  const grid = els.assetGrid;
  if (!grid) return;
  if (Math.abs(grid.scrollTop - galleryCardVirtualLastScrollTop) < 64) return;
  galleryCardVirtualLastScrollTop = grid.scrollTop;
  // The indexed lookup is already viewport-bounded, so perform it in the
  // scroll callback instead of risking a stale rAF coalescing a large jump.
  // DOM replacement remains deferred and batched by the hydration scheduler.
  syncGalleryCardVirtualWindow();
}

function setupGalleryCardVirtualization(roots = null) {
  const grid = els.assetGrid;
  if (!grid || state.assets.length < GALLERY_CARD_VIRTUAL_THRESHOLD) {
    galleryCardVirtualObserver?.disconnect();
    galleryCardVirtualObservedGrid = null;
    if (galleryCardVirtualScrollGrid) galleryCardVirtualScrollGrid.removeEventListener("scroll", handleGalleryCardVirtualScroll);
    galleryCardVirtualScrollGrid = null;
    galleryCardVirtualLastScrollTop = Number.NEGATIVE_INFINITY;
    galleryCardVirtualVisiblePendingChanges.clear();
    galleryCardVirtualBackgroundPendingChanges.clear();
    if (galleryCardVirtualBatchFrame !== null) cancelAnimationFrame(galleryCardVirtualBatchFrame);
    galleryCardVirtualBatchFrame = null;
    if (galleryCardVirtualWindowFrame !== null) cancelAnimationFrame(galleryCardVirtualWindowFrame);
    galleryCardVirtualWindowFrame = null;
    galleryCardVirtualGeometryColumns = [];
    galleryCardVirtualGeometryById.clear();
    return;
  }
  if ("IntersectionObserver" in window) {
    if (galleryCardVirtualObservedGrid !== grid || !galleryCardVirtualObserver) {
      galleryCardVirtualObserver?.disconnect();
      galleryCardVirtualObservedGrid = grid;
      galleryCardVirtualObserver = new IntersectionObserver((entries) => {
        const bounds = grid.getBoundingClientRect();
        entries.forEach((entry) => {
          const card = entry.target;
          if (!(card instanceof HTMLElement) || !card.isConnected) return;
          const isPlaceholder = card.classList.contains("asset-card-virtual-placeholder");
          if (entry.isIntersecting && isPlaceholder) {
            const rect = entry.boundingClientRect;
            const visible = rect.bottom > bounds.top && rect.top < bounds.bottom;
            queueGalleryCardVirtualChange({ target: card, isIntersecting: true }, visible);
          } else if (!entry.isIntersecting && !isPlaceholder) {
            queueGalleryCardVirtualChange({ target: card, isIntersecting: false });
          }
        });
        scheduleGalleryCardVirtualPendingChanges();
      }, { root: grid, rootMargin: "1200px 0px" });
    }
    const observationRoots = Array.isArray(roots) && roots.length ? roots : [grid];
    observationRoots.forEach((root) => {
      if (!(root instanceof Element)) return;
      const cards = root.matches?.(".asset-card") ? [root] : [...root.querySelectorAll(":scope > .asset-card")];
      cards.forEach((card) => galleryCardVirtualObserver.observe(card));
    });
    // IntersectionObserver is the primary driver, while the indexed scroll
    // lookup is a deterministic correctness guard for large programmatic jumps
    // and compositor timing. It is viewport-bounded, so this does not restore
    // the old O(N) scroll scan.
    if (galleryCardVirtualScrollGrid !== grid) {
      galleryCardVirtualScrollGrid?.removeEventListener("scroll", handleGalleryCardVirtualScroll);
      galleryCardVirtualScrollGrid = grid;
      galleryCardVirtualLastScrollTop = Number.NEGATIVE_INFINITY;
      galleryCardVirtualScrollGrid.addEventListener("scroll", handleGalleryCardVirtualScroll, { passive: true });
    }
    return;
  }
  galleryCardVirtualObserver?.disconnect();
  galleryCardVirtualObserver = null;
  galleryCardVirtualObservedGrid = grid;
  if (galleryCardVirtualScrollGrid !== grid) {
    galleryCardVirtualScrollGrid?.removeEventListener("scroll", handleGalleryCardVirtualScroll);
    galleryCardVirtualScrollGrid = grid;
    galleryCardVirtualLastScrollTop = Number.NEGATIVE_INFINITY;
    galleryCardVirtualScrollGrid.addEventListener("scroll", handleGalleryCardVirtualScroll, { passive: true });
  }
  handleGalleryCardVirtualScroll();
}

function bindGalleryVideoFrame(video) {
  if (!(video instanceof HTMLVideoElement) || video.dataset.galleryVideoBound === "true") return;
  video.dataset.galleryVideoBound = "true";
  const frame = video.closest(".video-thumb");
  const persistedWidth = Number(frame?.dataset.videoWidth || video.getAttribute("width") || 0);
  const persistedHeight = Number(frame?.dataset.videoHeight || video.getAttribute("height") || 0);
  if (frame instanceof HTMLElement && persistedWidth > 0 && persistedHeight > 0) {
    frame.style.aspectRatio = `${persistedWidth} / ${persistedHeight}`;
  }
  const updateAspect = () => {
    const width = Number(video.videoWidth || 0);
    const height = Number(video.videoHeight || 0);
    if (width <= 0 || height <= 0) return;
    video.setAttribute("width", String(width));
    video.setAttribute("height", String(height));
    video.dataset.knownAspect = "true";
    if (frame instanceof HTMLElement) {
      frame.style.aspectRatio = `${width} / ${height}`;
      frame.dataset.knownAspect = "true";
    }
    const card = video.closest(".asset-card");
    if (card) scheduleMasonryLayout(card);
    // Asking for a frame just after t=0 makes Chromium decode an actual poster
    // while still keeping the element paused and metadata-oriented.
    if (!video.dataset.galleryFrameSeeked) {
      video.dataset.galleryFrameSeeked = "true";
      const duration = Number(video.duration);
      const firstFrameTime = Number.isFinite(duration) && duration > 0
        ? Math.min(0.05, Math.max(0.001, duration / 100))
        : 0.001;
      try { video.currentTime = firstFrameTime; } catch {}
    }
  };
  const revealFrame = () => video.classList.add("is-frame-ready");
  video.addEventListener("loadedmetadata", updateAspect);
  video.addEventListener("loadeddata", revealFrame);
  video.addEventListener("seeked", revealFrame);
  video.addEventListener("error", () => video.classList.remove("is-frame-ready"));
}

// IntersectionObserver keeps strong references to every observed target, so
// media elements inside cards that are replaced or removed must be released;
// otherwise each grid rebuild leaks the previous render's nodes.
function releaseObservedGalleryMedia(card) {
  if (!galleryMediaObserver) return;
  card.querySelectorAll("img, video").forEach((media) => galleryMediaObserver.unobserve(media));
}

function setupGalleryMediaVirtualization(roots = null) {
  const grid = els.assetGrid;
  if (!grid || !("IntersectionObserver" in window)) return;
  if (galleryMediaObservedGrid !== grid) {
    galleryMediaObserver?.disconnect();
    galleryMediaObservedGrid = grid;
    galleryMediaObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const media = entry.target;
        if (media instanceof HTMLVideoElement) {
          const source = media.dataset.galleryVideoSrc || "";
          if (!source) return;
          if (entry.isIntersecting) {
            if (!media.hasAttribute("src")) {
              media.dataset.galleryUnloaded = "false";
              media.dataset.galleryFrameSeeked = "";
              media.preload = "metadata";
              media.src = source;
              media.load();
            }
            return;
          }
          if (!media.hasAttribute("src")) return;
          media.dataset.galleryUnloaded = "true";
          media.pause();
          media.removeAttribute("src");
          media.load();
          media.classList.remove("is-frame-ready");
          return;
        }
        if (!(media instanceof HTMLImageElement) || media.dataset.knownAspect !== "true") return;
        const source = media.dataset.gallerySrc || "";
        if (entry.isIntersecting) {
          if (media.dataset.galleryUnloaded === "true" && source) {
            media.dataset.galleryUnloaded = "false";
            media.classList.remove("gallery-media-unloaded");
            if (media.dataset.gallerySrcset) media.setAttribute("srcset", media.dataset.gallerySrcset);
            if (media.dataset.gallerySizes) media.setAttribute("sizes", media.dataset.gallerySizes);
            media.src = source;
          }
          return;
        }
        if (!source || media.dataset.galleryUnloaded === "true" || !media.complete || media.naturalWidth <= 0) return;
        media.dataset.galleryUnloaded = "true";
        media.classList.add("gallery-media-unloaded");
        if (media.hasAttribute("srcset")) media.dataset.gallerySrcset = media.getAttribute("srcset") || "";
        if (media.hasAttribute("sizes")) media.dataset.gallerySizes = media.getAttribute("sizes") || "";
        media.removeAttribute("srcset");
        media.removeAttribute("sizes");
        media.removeAttribute("src");
      });
    }, { root: grid, rootMargin: "1200px 0px" });
  }
  const targetRoots = Array.isArray(roots) && roots.length ? roots : [grid];
  targetRoots.forEach((root) => {
    if (!(root instanceof Element)) return;
    const selector = "img.thumb[data-known-aspect='true'][data-gallery-src], video.thumb-video-frame[data-gallery-video-src]";
    const media = root.matches?.(selector)
      ? [root]
      : [...root.querySelectorAll(selector)];
    media.forEach((item) => {
      if (item instanceof HTMLVideoElement) bindGalleryVideoFrame(item);
      if (item.dataset.galleryObserved === "true") return;
      item.dataset.galleryObserved = "true";
      galleryMediaObserver.observe(item);
    });
  });
}

function layoutMasonry(cards = null) {
  const grid = els.assetGrid;
  if (!grid) return;
  const gridStyles = getComputedStyle(grid);
  const galleryGap = Number.parseFloat(gridStyles.getPropertyValue("--gallery-gap")) || Number.parseFloat(gridStyles.columnGap) || 0;
  const virtualColumnWidth = galleryCardColumnWidth(gridStyles);
  galleryCardVirtualColumnWidth = virtualColumnWidth;
  const targets = cards ? [...cards] : [...grid.querySelectorAll(".asset-card")];
  const measureTargets = [];
  const measurements = [];
  let needsPlacement = !cards;
  let allTargetsUnplaced = Boolean(cards?.length);
  targets.forEach((card) => {
    if (!(card instanceof HTMLElement) || !card.isConnected) return;
    const alreadyPlaced = Boolean(card.style.gridColumnStart && card.style.gridRowStart);
    if (!alreadyPlaced) needsPlacement = true;
    else allTargetsUnplaced = false;
    if (card.classList.contains("asset-card-virtual-placeholder")) return;
    // content-visibility is enabled only after the real masonry span has been
    // measured. Temporarily expose the card when a relayout is required so an
    // offscreen intrinsic placeholder can never feed a fake height back into
    // the masonry algorithm.
    const previousSpan = Number.parseInt(String(card.style.gridRowEnd || "").replace(/\D+/g, ""), 10);
    card.classList.remove("masonry-content-virtualized");
    card.style.removeProperty("grid-row-end");
    measureTargets.push([card, previousSpan]);
  });
  // All layout-affecting writes above are complete before the first geometry
  // read, so Chromium performs one layout flush instead of a write/read cycle
  // for every card.
  measureTargets.forEach(([card, previousSpan]) => {
    const height = card.getBoundingClientRect().height || 0;
    if (height) measurements.push([card, Math.ceil(height + galleryGap), previousSpan]);
  });
  measurements.forEach(([card, span, previousSpan]) => {
    if (!Number.isFinite(previousSpan) || previousSpan !== span) needsPlacement = true;
    card.style.gridRowEnd = `span ${span}`;
    if (card.dataset.id) galleryCardVirtualSpanCache.set(galleryVirtualSpanKey(card.dataset.id, virtualColumnWidth), span);
    card.classList.add("masonry-content-virtualized");
  });
  if (!needsPlacement) {
    invalidateCardGeometryCache();
    return;
  }
  const columnCount = Math.max(1, gridStyles.gridTemplateColumns.split(/\s+/).filter(Boolean).length);
  const canAppendIncrementally = allTargetsUnplaced
    && galleryCardVirtualGeometryColumns.length === columnCount
    && galleryCardVirtualGeometryById.size > 0
    && targets.every((card) => card instanceof HTMLElement && card.dataset.id && !galleryCardVirtualGeometryById.has(card.dataset.id));
  if (canAppendIncrementally) {
    const columnEnds = galleryCardVirtualGeometryColumns.map((column) => column.at(-1)?.rowEnd || 1);
    targets.forEach((card) => {
      if (!(card instanceof HTMLElement) || !card.isConnected) return;
      let span = Number.parseInt(String(card.style.gridRowEnd || "").replace(/\D+/g, ""), 10);
      if (!Number.isFinite(span) || span <= 0) {
        const entry = galleryCardVirtualEntries.get(card.dataset.id || "");
        if (!entry) return;
        span = estimatedGalleryCardSpan(entry.asset);
        card.style.gridRowEnd = `span ${span}`;
      }
      let columnIndex = 0;
      for (let index = 1; index < columnEnds.length; index += 1) {
        if (columnEnds[index] < columnEnds[columnIndex]) columnIndex = index;
      }
      const rowStart = columnEnds[columnIndex];
      const columnStart = columnIndex + 1;
      card.style.gridColumnStart = String(columnStart);
      card.style.gridRowStart = String(rowStart);
      const id = card.dataset.id;
      const geometry = { id, rowStart, rowEnd: rowStart + span, columnIndex };
      galleryCardVirtualGeometryColumns[columnIndex].push(geometry);
      galleryCardVirtualGeometryById.set(id, geometry);
      columnEnds[columnIndex] += span;
    });
    invalidateCardGeometryCache();
    syncGalleryVirtualExtent();
    if (state.assets.length >= GALLERY_CARD_VIRTUAL_THRESHOLD) {
      pruneGalleryCardDomWindow();
      scheduleGalleryCardVirtualWindowSync();
    }
    return;
  }
  placeMasonryCards(grid, gridStyles);
}

// Recompute only card placement, not card height. Structural mutations such as
// Trash/removal and sort changes keep the surviving cards' measured spans, so
// re-reading every card's DOM height would add layout work without adding any
// information. A linear placement pass closes holes immediately.
function placeMasonryCards(grid, gridStyles) {
  const columnCount = Math.max(1, gridStyles.gridTemplateColumns.split(/\s+/).filter(Boolean).length);
  const columnEnds = Array(columnCount).fill(1);
  const nextGeometryColumns = Array.from({ length: columnCount }, () => []);
  galleryCardVirtualGeometryById.clear();
  state.assets.forEach((asset) => {
    const id = asset.id;
    const entry = galleryCardVirtualEntries.get(id);
    if (!entry) return;
    const card = galleryCardVirtualNode(grid, id);
    let span = card
      ? Number.parseInt(String(card.style.gridRowEnd || "").replace(/\D+/g, ""), 10)
      : galleryCardVirtualSpanCache.get(galleryVirtualSpanKey(id));
    if (!Number.isFinite(span) || span <= 0) span = estimatedGalleryCardSpan(entry.asset);
    let columnIndex = 0;
    for (let index = 1; index < columnEnds.length; index += 1) {
      if (columnEnds[index] < columnEnds[columnIndex]) columnIndex = index;
    }
    const rowStart = columnEnds[columnIndex];
    const columnStart = columnIndex + 1;
    if (card) {
      if (card.style.gridColumnStart !== String(columnStart)) card.style.gridColumnStart = String(columnStart);
      if (card.style.gridRowStart !== String(rowStart)) card.style.gridRowStart = String(rowStart);
      card.style.gridRowEnd = `span ${span}`;
    }
    const geometry = { id, rowStart, rowEnd: rowStart + span, columnIndex };
    nextGeometryColumns[columnIndex].push(geometry);
    galleryCardVirtualGeometryById.set(id, geometry);
    columnEnds[columnIndex] += span;
  });
  galleryCardVirtualGeometryColumns = nextGeometryColumns;
  invalidateCardGeometryCache();
  syncGalleryVirtualExtent();
  if (state.assets.length >= GALLERY_CARD_VIRTUAL_THRESHOLD) {
    pruneGalleryCardDomWindow();
    scheduleGalleryCardVirtualWindowSync();
  }
}

function reflowMasonryPlacement() {
  const grid = els.assetGrid;
  if (!grid) return;
  placeMasonryCards(grid, getComputedStyle(grid));
}

function scheduleMasonryLayout(card = null) {
  if (card) masonryPendingCards.add(card);
  else masonryFullLayoutPending = true;
  if (masonryLayoutFrame !== null) return;
  masonryLayoutFrame = requestAnimationFrame(() => {
    masonryLayoutFrame = null;
    if (masonryFullLayoutPending) layoutMasonry();
    else if (masonryPendingCards.size) layoutMasonry([...masonryPendingCards]);
    masonryFullLayoutPending = false;
    masonryPendingCards.clear();
  });
}
function setupMasonryLayout(options = {}) {
  const grid = els.assetGrid; if (!grid) return;
  const requestedCards = Array.isArray(options.cards) ? options.cards.filter(Boolean) : null;
  const fullLayout = options.full !== false || !requestedCards;
  const layoutTargets = fullLayout ? null : requestedCards;
  // Known image dimensions reserve the correct media height before bytes load,
  // so one synchronous pass is enough for the first paint. Unknown legacy
  // images repair only their own card after decode instead of forcing an O(N)
  // scan for every image load (the former O(N²) long-gallery hot path).
  layoutMasonry(layoutTargets);
  const mediaRoots = layoutTargets || [grid];
  const pendingMedia = mediaRoots.flatMap((root) => {
    if (!(root instanceof Element)) return [];
    const own = root.matches?.("img.thumb:not([data-known-aspect='true'])") ? [root] : [];
    return [...own, ...root.querySelectorAll("img.thumb:not([data-known-aspect='true'])")];
  });
  pendingMedia.forEach((media) => {
    if (media.dataset.masonryBound === "true") return;
    media.dataset.masonryBound = "true";
    const settle = () => {
      if (media.naturalWidth > 0 && media.naturalHeight > 0) {
        media.setAttribute("width", String(media.naturalWidth));
        media.setAttribute("height", String(media.naturalHeight));
        media.dataset.knownAspect = "true";
        setupGalleryMediaVirtualization([media]);
      }
      const card = media.closest(".asset-card");
      if (card) scheduleMasonryLayout(card);
    };
    if (media.complete) settle();
    else {
      media.addEventListener("load", settle, { once: true });
      media.addEventListener("error", settle, { once: true });
    }
  });
  if ("ResizeObserver" in window && masonryObservedGrid !== grid) {
    masonryResizeObserver?.disconnect();
    masonryObservedGrid = grid;
    masonryObservedWidth = grid.clientWidth;
    masonryResizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width ?? grid.clientWidth;
      if (Math.abs(width - masonryObservedWidth) < 0.5) return;
      masonryObservedWidth = width;
      galleryCardVirtualSpanCache.clear();
      grid.querySelectorAll(":scope > .asset-card-virtual-placeholder").forEach((card) => {
        const entry = galleryCardVirtualEntries.get(card.dataset.id || "");
        if (!entry) return;
        const span = estimatedGalleryCardSpan(entry.asset);
        card.dataset.virtualSpan = String(span);
        card.style.gridRowEnd = `span ${span}`;
      });
      scheduleMasonryLayout();
    });
    masonryResizeObserver.observe(grid);
  }
  setupGalleryMediaVirtualization(layoutTargets || null);
  setupGalleryCardVirtualization(layoutTargets || null);
  setupInfiniteScroll();
}

let infiniteScrollObserver = null;
let isLoadingMore = false;
let infiniteScrollRearmFrame = null;

function sentinelInInfiniteScrollWarmZone(grid, sentinel, preloadDistance) {
  if (!(grid instanceof HTMLElement) || !(sentinel instanceof HTMLElement) || !sentinel.isConnected) return false;
  const gridBounds = grid.getBoundingClientRect();
  const sentinelBounds = sentinel.getBoundingClientRect();
  return sentinelBounds.bottom >= gridBounds.top - preloadDistance
    && sentinelBounds.top <= gridBounds.bottom + preloadDistance;
}

function requestInfiniteScrollAppend(requestKey, preloadDistance) {
  const grid = els.assetGrid;
  const sentinel = grid?.querySelector('[data-sentinel="true"]');
  if (!grid || !sentinel || !state.nextCursor || isLoadingMore
    || requestKey !== assetRequestKey(currentAssetRequest())) return;
  isLoadingMore = true;
  const fallbackButton = grid.querySelector('[data-action="load-more"]')?.closest(".asset-load-more");
  loadAssets({ append: true }).then((applied) => {
    if (!applied && fallbackButton?.isConnected) fallbackButton.hidden = false;
  }).finally(() => {
    isLoadingMore = false;
    if (requestKey !== assetRequestKey(currentAssetRequest()) || infiniteScrollRearmFrame !== null) return;
    infiniteScrollRearmFrame = requestAnimationFrame(() => {
      infiniteScrollRearmFrame = null;
      const nextGrid = els.assetGrid;
      const nextSentinel = nextGrid?.querySelector('[data-sentinel="true"]');
      if (nextGrid && nextSentinel && state.nextCursor
        && sentinelInInfiniteScrollWarmZone(nextGrid, nextSentinel, preloadDistance)) {
        requestInfiniteScrollAppend(requestKey, preloadDistance);
      }
    });
  });
}

function setupInfiniteScroll() {
  const requestKey = assetRequestKey(currentAssetRequest());
  infiniteScrollObserver?.disconnect();
  if (infiniteScrollRearmFrame !== null) cancelAnimationFrame(infiniteScrollRearmFrame);
  infiniteScrollRearmFrame = null;
  const grid = els.assetGrid;
  const sentinel = grid?.querySelector('[data-sentinel="true"]');
  if (!grid || !sentinel || !state.nextCursor) return;
  const fallbackButton = grid.querySelector('[data-action="load-more"]')?.closest(".asset-load-more");
  if (!("IntersectionObserver" in window)) {
    if (fallbackButton) fallbackButton.hidden = false;
    return;
  }
  // Data is already prefetched by api-client. The sentinel therefore controls
  // only when cached rows enter the DOM, not when I/O starts. Mount roughly one
  // viewport ahead: early enough to hide a 40-card placeholder commit, but late
  // enough that the first page never auto-appends during launch.
  const preloadDistance = Math.max(600, Math.ceil(grid.clientHeight * 0.85));
  infiniteScrollObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) requestInfiniteScrollAppend(requestKey, preloadDistance);
    });
  }, { root: grid, rootMargin: `${preloadDistance}px 0px` });
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

function assetCardRenderKey(asset, selected) {
  return [
    asset.project_id || state.project,
    asset.id,
    asset.updated_at || "",
    asset.image_url || "",
    asset.thumbnail_url || "",
    asset.preview_url || "",
    asset.favorite ? "1" : "0",
    selected ? "1" : "0",
    asset.group || "",
    asset.version_index || "",
    asset.deleted_at || "",
    state.scope === "trash" ? String(trashRemainingDays(asset.deleted_at)) : "",
    asset.stack?.id || "",
    asset.stack?.count || "",
    asset.stack?.match_count || "",
    state.locale,
  ].join("\u001f");
}

function initializeAssetCardElement(card, renderKey, animateCard) {
  if (!(card instanceof HTMLElement)) return null;
  if (card.classList.contains("asset-card-virtual-placeholder")) {
    const span = Number.parseInt(card.dataset.virtualSpan || "", 10);
    if (Number.isFinite(span) && span > 0) card.style.gridRowEnd = `span ${span}`;
  }
  if (card.classList.contains("is-stack")) {
    const actions = card.querySelector(".card-actions");
    actions?.setAttribute("inert", "");
    actions?.setAttribute("aria-hidden", "true");
  }
  card.dataset.renderKey = renderKey;
  if (animateCard) card.addEventListener("animationend", () => card.classList.remove("card-enter"), { once: true });
  return card;
}

function createAssetCardElements(entries) {
  if (!entries.length) return new Map();
  const template = document.createElement("template");
  template.innerHTML = entries.map((entry) => entry.markup.trim()).join("");
  const cards = [...template.content.children];
  const created = new Map();
  entries.forEach((entry, index) => {
    const card = initializeAssetCardElement(cards[index], entry.renderKey, entry.animateCard);
    if (card) created.set(entry.id, card);
  });
  return created;
}

function galleryPaginationMarkup() {
  if (!state.nextCursor) return "";
  return `<div class="asset-load-more" hidden><button type="button" data-action="load-more">${escapeHtml(t("loadMore"))}</button></div><div class="infinite-scroll-sentinel" data-sentinel="true"></div>`;
}

function reconcileAssetCards(entries) {
  const grid = els.assetGrid;
  if (!grid) return { changedCards: [], replacedFocusedCard: false, structureChanged: false };
  const galleryChild = (element) => element.classList.contains("asset-card")
    || element.classList.contains("asset-load-more")
    || element.classList.contains("infinite-scroll-sentinel")
    || element.classList.contains("gallery-virtual-extent");
  if ([...grid.children].some((element) => !galleryChild(element))) grid.replaceChildren();

  const existingCardList = [...grid.querySelectorAll(":scope > .asset-card")];
  const existingOrder = existingCardList.map((card) => card.dataset.id || "");
  const desiredOrder = entries.map((entry) => entry.id);
  const structureChanged = existingOrder.length !== desiredOrder.length
    || existingOrder.some((id, index) => id !== desiredOrder[index]);
  const existingCards = new Map(existingCardList.map((card) => [card.dataset.id, card]));
  const keptCards = new Set();
  const desiredCards = [];
  const changedCards = [];
  let replacedFocusedCard = false;
  const entriesNeedingCards = entries.filter((entry) => {
    const card = existingCards.get(entry.id);
    return !card || card.dataset.renderKey !== entry.renderKey;
  });
  const createdCards = createAssetCardElements(entriesNeedingCards);

  for (const entry of entries) {
    let card = existingCards.get(entry.id) || null;
    if (!card || card.dataset.renderKey !== entry.renderKey) {
      const replacement = createdCards.get(entry.id) || null;
      if (!replacement) continue;
      if (card) {
        if (card.contains(document.activeElement)) replacedFocusedCard = true;
        releaseObservedGalleryMedia(card);
        card.replaceWith(replacement);
      }
      card = replacement;
      galleryCardVirtualNodes.set(entry.id, card);
      changedCards.push(card);
    }
    if (card) galleryCardVirtualNodes.set(entry.id, card);
    keptCards.add(card);
    desiredCards.push(card);
  }

  existingCards.forEach((card) => {
    if (!keptCards.has(card)) {
      if (card.contains(document.activeElement)) replacedFocusedCard = true;
      releaseObservedGalleryMedia(card);
      if (card.dataset.id) galleryCardVirtualNodes.delete(card.dataset.id);
      card.remove();
    }
  });
  let cursor = grid.firstElementChild;
  desiredCards.forEach((card) => {
    if (card !== cursor) grid.insertBefore(card, cursor);
    cursor = card.nextElementSibling;
  });
  grid.querySelectorAll(":scope > .asset-load-more, :scope > .infinite-scroll-sentinel, :scope > .gallery-virtual-extent").forEach((element) => element.remove());
  if (state.nextCursor) grid.insertAdjacentHTML("beforeend", galleryPaginationMarkup());
  if (changedCards.length || existingCards.size !== desiredCards.length) invalidateCardGeometryCache();
  return { changedCards, replacedFocusedCard, structureChanged };
}

function appendAssetCards(entries) {
  const grid = els.assetGrid;
  if (!grid) return [];
  grid.querySelectorAll(":scope > .asset-load-more, :scope > .infinite-scroll-sentinel, :scope > .gallery-virtual-extent").forEach((element) => element.remove());
  const createdCards = createAssetCardElements(entries);
  const changedCards = entries.map((entry) => createdCards.get(entry.id)).filter(Boolean);
  if (changedCards.length) {
    grid.append(...changedCards);
    changedCards.forEach((card) => {
      if (card.dataset.id) galleryCardVirtualNodes.set(card.dataset.id, card);
    });
  }
  if (state.nextCursor) grid.insertAdjacentHTML("beforeend", galleryPaginationMarkup());
  if (changedCards.length) invalidateCardGeometryCache();
  return changedCards;
}

// F-24：入场动画范围经 arguments 传入（loadAssets 在首次加载/追加页时设置），
// 普通重渲染（搜索/筛选/排序/后台刷新）不带参数则不播放；签名保持无参以兼容
// 既有契约测试对 renderGrid 签名的正则锁定。
function renderGrid() {
  // Direct UI-only rerenders (language/density/state decoration) should keep
  // the current viewport by default. loadAssets explicitly disables this when
  // the result-set semantics changed (search/filter/sort/project).
  const { animate = false, animateFrom = 0, preserveScroll = true } = arguments[0] || {};
  if (!els.assetGrid) return;
  const focusedElement = document.activeElement instanceof HTMLElement && els.assetGrid.contains(document.activeElement)
    ? document.activeElement
    : null;
  const focusedCard = focusedElement?.closest?.(".asset-card");
  const focusedAssetId = focusedCard?.dataset.id || null;
  const focusedAction = focusedElement?.classList.contains("card-favorite")
    ? "favorite"
    : focusedElement?.classList.contains("card-quick-copy")
      ? "copy"
      : focusedElement?.classList.contains("asset-card-select")
        ? "select"
        : null;
  els.assetGrid.dataset.density = state.galleryDensity;
  els.assetGrid.dataset.loadedAssets = String(state.assets.length);
  els.assetGrid.dataset.query = state.query;
  const restoreGridFallbackFocus = () => {
    if (!focusedElement) return;
    requestAnimationFrame(() => els.assetGrid?.focus({ preventScroll: true }));
  };
  // Loading, failed, empty and populated are four distinct renders; the empty
  // state is only reachable once a request has actually answered with nothing.
  if (state.galleryStatus === "loading" || state.galleryStatus === "error" || !state.assets.length) galleryCardVirtualNodes.clear();
  if (state.galleryStatus === "loading") { els.assetGrid.innerHTML = gallerySkeletonMarkup(); restoreGridFallbackFocus(); return; }
  if (state.galleryStatus === "error") {
    const message = state.galleryError?.message || "";
    els.assetGrid.innerHTML = `<div class="error-state"><p>${escapeHtml(t("loadFailed"))}</p><span>${escapeHtml(message)}</span><button type="button" data-action="retry">${escapeHtml(t("retry"))}</button></div>`;
    gallerySelection.syncRenderedSelection();
    restoreGridFallbackFocus();
    return;
  }
  if (!state.assets.length) {
    // F-08：零结果不再一律谎称「素材库为空」——判定由集中式 helper 按
    // 全库总数、query、facets、scope、分组分流，五类空态共用一个壳。
    els.assetGrid.innerHTML = galleryEmptyMarkup();
    gallerySelection.syncRenderedSelection();
    announceEmptyState(els.assetGrid.querySelector(".gallery-empty-state")?.dataset.emptyKind);
    restoreGridFallbackFocus();
    return;
  }
  const isAppendMode = animateFrom > 0;
  const canAppendFast = isAppendMode
    && galleryCardVirtualEntries.size === animateFrom
    && els.assetGrid.dataset.renderedDensity === state.galleryDensity;
  const renderAssets = canAppendFast ? state.assets.slice(animateFrom) : state.assets;
  galleryCardVirtualColumnWidth = galleryCardColumnWidth();
  if (!canAppendFast) {
    galleryCardVirtualEntries.clear();
    const currentIds = new Set(state.assets.map((asset) => asset.id));
    for (const id of galleryCardVirtualHydratedIds) {
      if (!currentIds.has(id)) galleryCardVirtualHydratedIds.delete(id);
    }
  }
  // F-24：闭包序号判断入场动画范围（保持 map 回调签名与既有契约一致）。
  let cardOrdinal = canAppendFast ? animateFrom : 0;
  const cards = renderAssets.map((asset) => {
    const ordinal = cardOrdinal;
    const animateCard = animate && cardOrdinal >= animateFrom;
    cardOrdinal += 1;
    const title = cardShortTitle(asset);
    const sourceLabel = assetSourceLabel(asset);
    const date = formatDate(asset.created_at, state.locale);
    const selected = asset.id === state.selectedId;
    const isStack = Boolean(!state.activeStackId && asset.stack?.id && Number(asset.stack?.count) > 1);
    const media = assetMediaPreviewMarkup(asset, "thumb");
    // Short, structured label instead of the full prompt.
    const label = t("cardAccessibleName", { title: title || asset.id, source: sourceLabel, date });
    const stackMatchCount = Math.max(0, Number(asset.stack?.match_count || 0));
    const stackHasPartialMatch = isStack && stackMatchCount > 0 && stackMatchCount < Number(asset.stack.count);
    const stackDescription = isStack
      ? ` aria-description="${escapeHtml(stackHasPartialMatch
        ? t("stackMatchAccessibleName", { label, count: asset.stack.count, matched: stackMatchCount })
        : t("stackAccessibleName", { label, count: asset.stack.count }))}"`
      : "";
    const versionIndex = Number(asset.version_index) || 0;
    const badge = versionIndex > 1 ? t("versionLabelShort", { number: versionIndex }) : (asset.group || "");
    const info = `<div class="asset-card-info"><p class="asset-card-title" title="${escapeHtml(title)}">${escapeHtml(title)}</p><p class="asset-card-meta"><span>${escapeHtml(sourceLabel)}</span><span>${escapeHtml(date)}</span>${badge ? `<span class="asset-card-badge" title="${escapeHtml(badge)}">${escapeHtml(badge)}</span>` : ""}</p></div>`;
    const isFav = asset.favorite;
    const favoriteLabel = isFav ? t("removeFavorite") : t("addFavorite");
    // Phase 1C/1C.1 契约：.card-actions > button.card-action-btn.card-favorite / .card-quick-copy，
    // 业务 class 与 data 属性全部保留（现有事件绑定依赖）；aria-pressed 表达收藏态。
    const favBtn = `<button class="card-action-btn card-favorite${isFav ? " is-fav" : ""}" type="button" data-fav-id="${escapeHtml(asset.id)}" aria-pressed="${Boolean(isFav)}" aria-label="${escapeHtml(favoriteLabel)}" title="${escapeHtml(favoriteLabel)}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2.5l2.95 5.97 6.59.96-4.77 4.65 1.13 6.57L12 17.57l-5.9 3.08 1.13-6.57-4.77-4.65 6.59-.96L12 2.5z"/></svg></button>`;
    const copyBtn = `<button class="card-action-btn card-quick-copy" type="button" data-i18n-title="copyPrompt" title="${t("copyPrompt")}" aria-label="${t("copyPrompt")}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9"/></svg></button>`;
    // Trash cards expose restore/permanent-delete through the Trash actions,
    // so do not render favorite/copy controls there at all. Removing the
    // focusable controls from the markup is safer than hiding them with CSS.
    const cardActions = state.scope === "trash" ? "" : `<div class="card-actions">${favBtn}${copyBtn}</div>`;
    const stackBadge = isStack
      ? `<span class="asset-stack-count" aria-hidden="true">${stackHasPartialMatch ? `${stackMatchCount}/${Number(asset.stack.count)}` : Number(asset.stack.count)}</span>`
      : "";
    const trashBadge = state.scope === "trash" && asset.deleted_at
      ? `<span class="trash-countdown">${escapeHtml(t("trashDaysRemaining", { count: trashRemainingDays(asset.deleted_at) }))}</span>`
      : "";
    const entry = {
      id: asset.id,
      asset,
      renderKey: assetCardRenderKey(asset, selected),
      animateCard,
      markup: `<article class="asset-card${selected ? " selected" : ""}${isStack ? " is-stack" : ""}${state.scope === "trash" ? " is-trash" : ""}${isVideoAsset(asset) ? " is-video" : ""}${animateCard ? " card-enter" : ""}" data-id="${escapeHtml(asset.id)}"${isStack ? ` data-stack-id="${escapeHtml(asset.stack.id)}"` : ""} title="${escapeHtml(cardShortTitle(asset))}"><button class="asset-card-select" type="button" aria-pressed="${selected}" aria-label="${escapeHtml(label)}"${stackDescription}>${media}${stackBadge}${trashBadge}<span class="card-check" aria-hidden="true"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.5 5 5 10-11"/></svg></span></button>${info}${cardActions}</article>`,
    };
    galleryCardVirtualEntries.set(entry.id, entry);
    const hydrateCard = shouldHydrateGalleryCard(entry, ordinal);
    if (hydrateCard) galleryCardVirtualHydratedIds.add(entry.id);
    else galleryCardVirtualHydratedIds.delete(entry.id);
    return hydrateCard ? entry : virtualGalleryCardEntry(entry);
  });
  const domCards = canAppendFast || state.assets.length < GALLERY_CARD_DOM_WINDOW_THRESHOLD
    ? cards
    : cards.filter((entry, index) => {
      const ordinal = index;
      if (ordinal < GALLERY_CARD_INITIAL_HYDRATE || entry.id === state.selectedId) return true;
      const geometry = galleryCardVirtualGeometryById.get(entry.id);
      if (!geometry) return false;
      const minRow = Math.max(0, els.assetGrid.scrollTop - GALLERY_CARD_DOM_PRELOAD);
      const maxRow = els.assetGrid.scrollTop + els.assetGrid.clientHeight + GALLERY_CARD_DOM_PRELOAD;
      return geometry.rowEnd >= minRow && geometry.rowStart <= maxRow;
    });
  // Populated renders are reconciled by asset id. Unchanged cards keep their
  // decoded media and DOM nodes; only changed/new cards are recreated.
  const scrollContainer = els.assetGrid;
  const savedScrollTop = (isAppendMode || preserveScroll) ? scrollContainer.scrollTop : null;
  if (!preserveScroll && !isAppendMode) scrollContainer.scrollTop = 0;
  const previousDensity = els.assetGrid.dataset.renderedDensity || "";
  const appendChangedCards = canAppendFast ? appendAssetCards(domCards) : null;
  const reconciliation = canAppendFast
    ? { changedCards: appendChangedCards, replacedFocusedCard: false, structureChanged: false }
    : reconcileAssetCards(domCards);
  const { changedCards, replacedFocusedCard, structureChanged } = reconciliation;
  els.assetGrid.dataset.renderedDensity = state.galleryDensity;
  const requiresFullMasonry = !canAppendFast && (previousDensity !== state.galleryDensity || changedCards.length >= state.assets.length);
  setupMasonryLayout(requiresFullMasonry ? {} : { cards: changedCards, full: false });
  if (!requiresFullMasonry && structureChanged) reflowMasonryPlacement();
  // Keyed incremental reconciliation keeps unchanged card nodes mounted, so
  // Chromium's native scroll anchoring can preserve the actual viewed card
  // when new assets are inserted above it. Writing the old numeric scrollTop
  // after every background refresh would override that correction and create
  // the visible "gallery nudge". Only fall back to numeric restoration when
  // the render replaced the whole populated set and no stable DOM anchor is
  // left for the browser to use.
  const needsNumericScrollRestore = savedScrollTop !== null
    && !canAppendFast
    && changedCards.length >= state.assets.length;
  if (needsNumericScrollRestore) {
    requestAnimationFrame(() => {
      const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
      scrollContainer.scrollTop = Math.min(savedScrollTop, maxScrollTop);
    });
  }
  if (focusedAssetId && focusedAction && (replacedFocusedCard || !focusedElement?.isConnected)) {
    requestAnimationFrame(() => {
      const card = els.assetGrid?.querySelector(`.asset-card[data-id="${CSS.escape(focusedAssetId)}"]`);
      const replacement = focusedAction === "favorite"
        ? card?.querySelector(".card-favorite")
        : focusedAction === "copy"
          ? card?.querySelector(".card-quick-copy")
          : card?.querySelector(".asset-card-select");
      if (replacement instanceof HTMLElement) replacement.focus({ preventScroll: true });
      else els.assetGrid?.focus({ preventScroll: true });
    });
  }
  if (canAppendFast) {
    gallerySelection.syncRenderedSelection({
      prune: false,
      changedIds: new Set(changedCards.map((card) => card.dataset.id).filter(Boolean)),
    });
  } else {
    gallerySelection.syncRenderedSelection();
  }
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
  if (id === state.selectedId && state.detailOpen) {
    updateSelectedCard();
    if (shouldScroll) els.assetGrid.querySelector(`.asset-card[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const originProjectId = state.project;
  const originAssetId = state.selectedId;
  if (!await confirmDetailNavigation(id)) return;
  // Phase 5B context guard：确认期间 Detail 选择已变化时安全取消，旧确认结果不操作新素材。
  if (originAssetId !== null && !isCurrentDetailSelection(originProjectId, originAssetId)) return;
  discardDetailDraft();
  state.selectedId = id; state.detailAsset = null; state.detailStack = null; state.versionHistory = null; state.recipeHistory = null; state.generationHistory = null; setDetailOpen(true); updateSelectedCard();
  if (shouldScroll) els.assetGrid.querySelector(`.asset-card[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

let stackInspectorRequestSequence = 0;
async function selectStackNode(asset) {
  const stackId = String(asset?.stack?.id || "");
  const coverAssetId = String(asset?.id || "");
  if (!stackId || !coverAssetId || state.activeStackId) return false;
  const originProjectId = state.project;
  const originAssetId = state.selectedId;
  if (!await confirmDetailNavigation(coverAssetId)) return false;
  if (originAssetId !== null && !isCurrentDetailSelection(originProjectId, originAssetId)) return false;
  discardDetailDraft();
  const requestId = ++stackInspectorRequestSequence;
  state.selectedId = coverAssetId;
  state.detailAsset = null;
  state.detailStack = {
    id: stackId,
    coverAssetId,
    count: Math.max(0, Number(asset.stack?.count || 0)),
    members: [],
    loading: true,
    error: false,
  };
  state.versionHistory = null;
  state.recipeHistory = null;
  state.generationHistory = null;
  setDetailOpen(true);
  updateSelectedCard();
  renderDetail();
  try {
    const members = [];
    const seenCursors = new Set();
    let cursor = "";
    let total = state.detailStack.count;
    while (true) {
      if (cursor) {
        if (seenCursors.has(cursor)) throw new Error("Stack inspector pagination stalled.");
        seenCursors.add(cursor);
      }
      const params = new URLSearchParams({ project: state.project, limit: "250" });
      if (cursor) params.set("cursor", cursor);
      if (members.length) params.set("includeTotal", "0");
      const page = await apiFetch(`/api/asset-stacks/${encodeURIComponent(stackId)}/assets?${params}`);
      if (requestId !== stackInspectorRequestSequence || state.selectedId !== coverAssetId || state.detailStack?.id !== stackId) return false;
      members.push(...(page.assets || []));
      if (page.page?.total != null) total = Number(page.page.total) || total;
      cursor = page.page?.nextCursor || "";
      if (!cursor) break;
    }
    state.detailStack = { ...state.detailStack, count: total || members.length, members, loading: false, error: false };
    renderDetail();
    return true;
  } catch (error) {
    if (requestId !== stackInspectorRequestSequence || state.selectedId !== coverAssetId || state.detailStack?.id !== stackId) return false;
    state.detailStack = { ...state.detailStack, loading: false, error: true };
    renderDetail();
    return false;
  }
}

function clearDetailSelection() {
  stackInspectorRequestSequence += 1;
  state.selectedId = null;
  state.detailAsset = null;
  state.detailStack = null;
  state.versionHistory = null;
  state.recipeHistory = null;
  state.generationHistory = null;
}

// ===== Inspector auto-save =====
// 检视器配方/参考图权利字段编辑停顿后自动 PATCH，消除"未保存修改时导航弹丢弃确认"的
// 摩擦。标签内联编辑器仍是 submit 即时保存（不改）。
let inspectorSaveTimer = null;
let inspectorSavePromise = null;
let activeInspector = null;
const INSPECTOR_AUTOSAVE_DELAY = 1200;

function scheduleInspectorSave() {
  if (!activeInspector?.panel?.isConnected) return;
  clearTimeout(inspectorSaveTimer);
  inspectorSaveTimer = setTimeout(() => {
    inspectorSaveTimer = null;
    void persistInspectorDraft(activeInspector.panel, activeInspector.asset, activeInspector.renderId);
  }, INSPECTOR_AUTOSAVE_DELAY);
}

function cancelInspectorSave() {
  clearTimeout(inspectorSaveTimer);
  inspectorSaveTimer = null;
}

function setInspectorAutosaveStatus(panel, kind) {
  panel?.querySelectorAll("[data-autosave-status]").forEach((node) => {
    if (kind === "saving") node.textContent = t("saving");
    else if (kind === "saved") node.textContent = t("autoSaved");
    // L1：失败必须落在面板状态位上（不只靠一闪而过的 Toast），dirty 仍保留可重试。
    else if (kind === "error") node.textContent = t("autoSaveFailed");
    else node.textContent = "";
  });
}

// Persist any dirty recipe/reference draft in one PATCH. Returns false on
// failure (dirty kept so a later edit/flush retries); the caller (navigation
// guards) treats false as "do not proceed" rather than silently dropping edits.
async function persistInspectorDraft(panel, asset, renderId) {
  const originProjectId = asset.project_id;
  const originAssetId = asset.id;
  if (!isCurrentDetailAction(renderId, originProjectId, originAssetId)) return true;
  // An in-flight save owns the wire; reschedule and let it land first.
  if (inspectorSavePromise) { scheduleInspectorSave(); return true; }
  const recipeDirty = Boolean(panel.querySelector('[data-detail-dirty="true"][data-detail-dirty-scope="recipe"]'));
  const referenceDirty = Boolean(panel.querySelector('[data-reference-rights-section][data-reference-dirty="true"]'));
  if (!recipeDirty && !referenceDirty) { state.detailDirty = panelHasDirtyDraft(panel); return true; }
  setInspectorAutosaveStatus(panel, "saving");
  const run = (async () => {
    try {
      const currentAsset = latestAssetSnapshot(originProjectId, originAssetId, asset);
      const body = {};
      let sentRecipeSnapshot = null;
      let sentReferencesSnapshot = null;
      if (recipeDirty) {
        const recipeDraft = readRecipeDraft(panel);
        // 配方保存只读 [data-recipe-change]；说明为空时省略 recipe_change_summary
        //（服务端缺省 "Recipe updated"），不硬编码英文、不创建新版本。
        const changeSummary = panel.querySelector("[data-recipe-change]")?.value.trim() || "";
        Object.assign(body, recipeDraft, { tags: uniqueTags([...assetTags(currentAsset), ...derivePromptTags(recipeDraft)]) }, changeSummary ? { recipe_change_summary: changeSummary } : {});
        sentRecipeSnapshot = JSON.stringify([recipeDraft, changeSummary]);
      }
      if (referenceDirty) {
        const section = panel.querySelector("[data-reference-rights-section]");
        body.references = readReferenceRightsDraft(section, currentAsset);
        sentReferencesSnapshot = JSON.stringify(body.references);
      }
      const result = await apiFetch(`/api/assets/${encodeURIComponent(originProjectId)}/${encodeURIComponent(originAssetId)}`, { method: "PATCH", body });
      if (!isCurrentDetailAction(renderId, originProjectId, originAssetId)) return true;
      state.detailAsset = result.asset;
      const index = state.assets.findIndex((item) => item.id === originAssetId && item.project_id === originProjectId);
      if (index >= 0) state.assets[index] = result.asset;
      // PATCH 在途期间的新输入不在请求体里：只有当前草稿与发出时完全一致才清脏；
      // 有飞行期编辑则保留 dirty 标志并立即补存，否则导航冲刷会把可见编辑当
      // “无草稿”静默丢弃（面板显示已保存，服务器却缺最后几笔输入）。
      const flightEdits = draftChangedDuringFlight(panel, sentRecipeSnapshot, sentReferencesSnapshot);
      if (!flightEdits) {
        if (recipeDirty) clearDetailDirtyScope(panel, "recipe");
        if (referenceDirty) {
          const section = panel.querySelector("[data-reference-rights-section]");
          if (section) delete section.dataset.referenceDirty;
          state.detailDirty = panelHasDirtyDraft(panel);
        }
      }
      setInspectorAutosaveStatus(panel, "saved");
      if (flightEdits) scheduleInspectorSave();
      await loadStats();
      await apiClient.reloadLoadedAssetPages({ background: true });
      return true;
    } catch (error) {
      showToast(error.message, "error");
      // Keep the dirty flags so the next edit or flush retries instead of losing data.
      setInspectorAutosaveStatus(panel, "error");
      return false;
    }
  })();
  inspectorSavePromise = run;
  try { return await run; } finally { inspectorSavePromise = null; }
}

// Flush a pending debounced save before navigation/switching. Awaits any
// in-flight PATCH, then runs once more if edits arrived during it.
async function flushInspectorSave() {
  cancelInspectorSave();
  if (inspectorSavePromise) await inspectorSavePromise;
  const ctx = activeInspector;
  if (!ctx?.panel?.isConnected || !panelHasDirtyDraft(ctx.panel)) return true;
  return persistInspectorDraft(ctx.panel, ctx.asset, ctx.renderId);
}

async function confirmDetailNavigation() {
  // 自动保存：导航/切换前冲刷挂起的草稿；失败则返回 false 阻断导航（不静默丢数据）。
  // version/tags 作用域是手动保存语义（没有自动保存兜底）：存在未提交草稿时先显式
  // 确认丢弃，避免点开另一张卡片/关掉 Inspector 就无声清掉已写的变更说明或新标签。
  if (hasManualSaveDraft()) {
    const confirmed = await requestConfirmation({
      title: t("discardChangesTitle"),
      description: t("discardChangesDescription"),
      confirmLabel: t("discardChangesAction"),
      tone: "danger",
    });
    if (!confirmed) return false;
  }
  return flushInspectorSave();
}

// 手动保存作用域（version=另存为新版本的变更说明，tags=标签编辑器输入）的未提交
// 草稿。recipe/reference 由自动保存冲刷兜底，不在此弹确认。
function hasManualSaveDraft() {
  const panel = els.detailPanel;
  if (!panel?.isConnected || !state.detailOpen) return false;
  return Boolean(panel.querySelector('[data-detail-dirty="true"][data-detail-dirty-scope="version"], [data-detail-dirty="true"][data-detail-dirty-scope="tags"]'));
}

function discardDetailDraft() {
  cancelInspectorSave();
  state.detailDirty = false;
  els.detailPanel?.querySelectorAll('[data-detail-dirty="true"]').forEach((field) => {
    delete field.dataset.detailDirty;
    delete field.dataset.detailDirtyScope;
  });
  const rights = els.detailPanel?.querySelector('[data-reference-rights-section][data-reference-dirty="true"]');
  if (rights) delete rights.dataset.referenceDirty;
}

async function closeDetailSurface() {
  if (!await confirmDetailNavigation(null)) return false;
  discardDetailDraft();
  if (state.viewMode === "asset") returnToLibrary();
  else {
    setDetailOpen(false);
    if (state.selectedId && !state.assets.some((asset) => asset.id === state.selectedId && asset.project_id === state.project)) clearDetailSelection();
  }
  return true;
}

function selectedAsset() {
  return state.assets.find((asset) => asset.id === state.selectedId)
    || (state.detailAsset?.id === state.selectedId ? state.detailAsset : null)
    || state.versionHistory?.versions?.find((asset) => asset.id === state.selectedId)
    || null;
}

let lastSelectedCardId = null;
function updateSelectedCard() {
  if (!els.assetGrid) return;
  const ids = new Set([lastSelectedCardId, state.selectedId].filter(Boolean));
  for (const id of ids) {
    const card = els.assetGrid.querySelector(`:scope > .asset-card[data-id="${CSS.escape(id)}"]`);
    if (!card) continue;
    const selected = id === state.selectedId;
    const multiSelected = Boolean(state.selectedIds?.has(id));
    card.classList.toggle("selected", selected);
    card.querySelector(".asset-card-select")?.setAttribute("aria-pressed", String(selected || multiSelected));
  }
  lastSelectedCardId = state.selectedId || null;
}
function setDetailOpen(open) {
  const wasOpen = state.detailOpen;
  state.detailOpen = Boolean(open);
  if (!state.detailOpen && isInspectorDocked()) state.detailOpen = true;
  els.appShell?.classList.toggle("details-open", state.detailOpen); document.body.classList.toggle("detail-open", state.detailOpen); els.detailPanel?.setAttribute("aria-hidden", String(!state.detailOpen));
  if (state.detailOpen) setMobileNavOpen(false);
  if (state.detailOpen) {
    if (!wasOpen) {
      const activeEl = document.activeElement;
      state.detailReturnFocus = (activeEl instanceof HTMLElement && activeEl.isConnected) ? activeEl : null;
      state.detailReturnFocusAssetId = activeEl?.closest?.(".asset-card")?.dataset.id || state.selectedId || null;
    }
    const selected = selectedAsset();
    const sameRenderedAsset = Boolean(selected && detailRenderedAssetId === selected.id);
    if (!wasOpen || !sameRenderedAsset || !isDetailEditorActive()) renderDetail();
    // Focus moves only on the closed -> open transition: arrow-key gallery
    // navigation keeps calling setDetailOpen(true) while the drawer is already
    // open, and yanking focus into the drawer each time would break it.
    // Focus synchronously rather than in requestAnimationFrame, which never
    // runs while the window is hidden or frame-throttled.
    if (!wasOpen) els.detailPanel?.querySelector("#detailTitle")?.focus();
  } else {
    const returnEl = state.detailReturnFocus;
    const returnAssetId = state.detailReturnFocusAssetId;
    state.detailReturnFocus = null;
    state.detailReturnFocusAssetId = null;
    if (returnEl instanceof HTMLElement && returnEl.isConnected) returnEl.focus({ preventScroll: true });
    else {
      const replacement = returnAssetId
        ? els.assetGrid?.querySelector(`.asset-card[data-id="${CSS.escape(returnAssetId)}"] .asset-card-select`)
        : null;
      if (replacement instanceof HTMLElement) replacement.focus({ preventScroll: true });
      else els.assetGrid?.focus({ preventScroll: true });
    }
  }
}

// ===== Asset view（大图查看器，已提取至 asset-view.mjs，R1 批次 4）=====

function hasBlockingOverlay(except = "") {
  return [
    ["import", Boolean(els.importModal?.classList.contains("open"))],
    ["group", Boolean(els.groupModal?.classList.contains("open"))],
    ["settings", Boolean(els.settingsMenu && !els.settingsMenu.hidden)],
    ["preview", Boolean(els.imagePreviewModal && !els.imagePreviewModal.hidden)],
  ].some(([name, open]) => name !== except && open);
}

function openImportModal() {
  if (state.importSaving || hasBlockingOverlay("import")) return;
  state.modalReturnFocus = document.activeElement;
  clearImportErrors();
  els.importModal?.classList.add("open");
  els.importModal?.setAttribute("aria-hidden", "false");
  // Focused synchronously: an animation frame never runs while the window is hidden.
  els.closeImportModal?.focus();
}
function closeImportModal({ force = false } = {}) {
  if (state.importSaving && !force) return false;
  // Closing while a replacement file is still uploading invalidates that
  // request. prepareImportFile/paste cleanup the late staging path as soon as
  // it becomes available, so a cancel never leaves a hidden orphan behind.
  if (state.stagingInProgress) state.stagingCanceled = true;
  // P1-2: Clean up orphaned staged file on cancel (non-destructive)
  const stagedToClean = state.stagedPath;
  state.stagedPath = "";
  if (stagedToClean) {
    // Non-blocking cleanup
    void cleanupStagedFile(stagedToClean);
  }
  announceGalleryStatus("");
  els.importModal?.classList.remove("open");
  els.importModal?.setAttribute("aria-hidden", "true");
  if (state.modalReturnFocus instanceof HTMLElement) state.modalReturnFocus.focus();
  state.modalReturnFocus = null;
  return true;
}
function openSettingsModal() {
  if (!els.settingsMenu || !els.settingsMenu.hidden || hasBlockingOverlay("settings")) return;
  state.settingsReturnFocus = document.activeElement;
  // Settings is rendered on demand so library path/stat changes that landed
  // after startup are always reflected when the user opens this single panel.
  renderSettingsMenu();
  els.settingsMenu.hidden = false;
  els.settingsToggle?.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => els.settingsMenu?.querySelector(".settings-modal-card")?.focus());
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
function openGroupModal() {
  if (state.groupSaving || hasBlockingOverlay("group")) return;
  state.modalReturnFocus = document.activeElement;
  els.groupModal?.classList.add("open");
  els.groupModal?.setAttribute("aria-hidden", "false");
  if (els.groupNameInput) els.groupNameInput.value = "";
  selectGroupColor(GROUP_COLORS[0]);
  requestAnimationFrame(() => els.groupNameInput?.focus());
}
function setGroupBusy(busy) {
  state.groupSaving = busy;
  if (els.saveGroupBtn) { els.saveGroupBtn.disabled = busy; els.saveGroupBtn.setAttribute("aria-busy", String(busy)); }
  if (els.closeGroupModal) els.closeGroupModal.disabled = busy;
  if (els.cancelGroupBtn) els.cancelGroupBtn.disabled = busy;
  if (els.groupNameInput) els.groupNameInput.disabled = busy;
  els.groupModal?.querySelectorAll("[data-group-color]").forEach((button) => { button.disabled = busy; });
}
function closeGroupModal({ force = false } = {}) {
  if (state.groupSaving && !force) return false;
  els.groupModal?.classList.remove("open");
  els.groupModal?.setAttribute("aria-hidden", "true");
  if (state.modalReturnFocus instanceof HTMLElement) state.modalReturnFocus.focus();
  state.modalReturnFocus = null;
  return true;
}

function trapImportModalFocus(event) {
  if (event.defaultPrevented) return;
  if (!els.importModal?.classList.contains("open")) return;
  if (event.key === "Escape") { event.preventDefault(); closeImportModal(); return; }
  if (event.key !== "Tab") return;
  const focusable = [...els.importModal.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter((element) => !element.hasAttribute("hidden"));
  if (!focusable.length) return; const current = focusable.indexOf(document.activeElement); const next = event.shiftKey ? (current <= 0 ? focusable.length - 1 : current - 1) : (current === focusable.length - 1 ? 0 : current + 1); event.preventDefault(); focusable[next].focus();
}

function trapSettingsModalFocus(event) {
  if (event.defaultPrevented) return;
  if (els.settingsMenu?.hidden) return;
  if (event.key === "Escape") { event.preventDefault(); closeSettingsModal(); return; }
  if (event.key !== "Tab") return;
  const focusable = [...els.settingsMenu.querySelectorAll("button:not([disabled]):not([tabindex='-1']), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter((element) => !element.closest("[hidden]"));
  if (!focusable.length) return;
  const current = focusable.indexOf(document.activeElement);
  const next = event.shiftKey ? (current <= 0 ? focusable.length - 1 : current - 1) : (current === focusable.length - 1 ? 0 : current + 1);
  event.preventDefault();
  focusable[next].focus();
}

function trapGroupModalFocus(event) {
  if (event.defaultPrevented) return;
  if (!els.groupModal?.classList.contains("open")) return;
  if (event.key === "Escape") { event.preventDefault(); closeGroupModal(); return; }
  if (event.key !== "Tab") return;
  const focusable = [...els.groupModal.querySelectorAll("button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter((element) => !element.hasAttribute("hidden"));
  if (!focusable.length) return; const current = focusable.indexOf(document.activeElement); const next = event.shiftKey ? (current <= 0 ? focusable.length - 1 : current - 1) : (current === focusable.length - 1 ? 0 : current + 1); event.preventDefault(); focusable[next].focus();
}

async function saveGroup() {
  if (state.groupSaving) return;
  const name = els.groupNameInput?.value.trim() || "";
  if (!name) { showToast(t("groupNameRequired"), "error"); return; }
  const originProjectId = state.project;
  const originAssetId = state.selectedId;
  const hadDetailDraft = state.detailDirty;
  // 同 saveAsset：防重窗口先于草稿冲刷的网络往返打开，冲刷期间双击不重复建组。
  setGroupBusy(true);
  try {
    if (hadDetailDraft && !await confirmDetailNavigation(null)) return;
    await runAction(async () => {
      const result = await apiFetch("/api/groups", { method: "POST", body: { projectId: originProjectId, name } });
      if (hadDetailDraft && originProjectId === state.project && originAssetId === state.selectedId) discardDetailDraft();
      saveGroupColor(result.group.name, selectedGroupColor());
      closeGroupModal({ force: true });
      await loadStats();
      showToast(`${t("groupCreated")}${result.group.name}`, "success");
      // “来源”已是当前侧栏的唯一自动分组入口；创建自定义分组不应把用户瞬间
      // 导航到一个尚无素材的空分组。保留当前画廊上下文，新分组会立即出现在
      // 素材右键的“移动到分组”子菜单中。
      clearDetailSelection();
      renderQuickFilters();
    });
  } finally {
    setGroupBusy(false);
  }
}

let imagePreviewCleanupTimer = null;
let imagePreviewCleanupHandler = null;

function cancelPendingImagePreviewCleanup() {
  if (imagePreviewCleanupTimer !== null) {
    window.clearTimeout(imagePreviewCleanupTimer);
    imagePreviewCleanupTimer = null;
  }
  if (imagePreviewCleanupHandler && els.imagePreviewModal) {
    els.imagePreviewModal.removeEventListener("transitionend", imagePreviewCleanupHandler);
    imagePreviewCleanupHandler = null;
  }
}

function finalizeImagePreviewClose() {
  cancelPendingImagePreviewCleanup();
  if (!els.imagePreviewModal?.hidden) return;
  els.imagePreviewImage?.removeAttribute("src");
  els.imagePreviewImage.hidden = false;
  els.imagePreviewVideo?.removeAttribute("src");
  els.imagePreviewVideo.hidden = true;
  resetImageZoom();
  els.imagePreviewImage?.style.removeProperty("width");
  els.imagePreviewImage?.style.removeProperty("height");
  els.imagePreviewStage?.classList.remove("zoomed", "dragging");
  els.imagePreviewStage?.setAttribute("aria-label", t("imagePreviewStage"));
}

function scheduleImagePreviewCleanup() {
  cancelPendingImagePreviewCleanup();
  const modal = els.imagePreviewModal;
  if (!modal?.hidden) return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    finalizeImagePreviewClose();
    return;
  }
  const finish = (event) => {
    if (event && (event.target !== modal || event.propertyName !== "opacity")) return;
    finalizeImagePreviewClose();
  };
  imagePreviewCleanupHandler = finish;
  modal.addEventListener("transitionend", finish);
  // Transition events can be skipped when a window is hidden or throttled.
  // Keep cleanup bounded without making the visual path timer-driven.
  imagePreviewCleanupTimer = window.setTimeout(() => finish(), 260);
}

function openImagePreview(id, trigger) {
  if (hasBlockingOverlay("preview")) return;
  const asset = state.assets.find((item) => item.id === id)
    || state.versionHistory?.versions?.find((item) => item.id === id)
    || (state.detailAsset?.id === id ? state.detailAsset : null);
  if (!asset || !els.imagePreviewModal || !els.imagePreviewImage || !els.imagePreviewVideo || !els.imagePreviewTitle) return;
  cancelPendingImagePreviewCleanup();
  state.imagePreviewId = asset.id;
  resetImageZoom();
  state.previewReturnFocus = trigger instanceof HTMLElement ? trigger : document.activeElement;
  state.previewReturnFocusAssetId = trigger?.closest?.(".asset-card")?.dataset.id || asset.id;
  els.imagePreviewTitle.textContent = displayAssetTitle(asset);
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
  els.imagePreviewImage.src = asset.preview_url || asset.image_url;
  els.imagePreviewImage.alt = displayAssetTitle(asset);
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
  if (!els.imagePreviewModal || els.imagePreviewModal.hidden) return;
  els.imagePreviewModal.hidden = true;
  els.imagePreviewVideo?.pause();
  state.imagePreviewId = null;
  const returnEl = state.previewReturnFocus;
  const returnAssetId = state.previewReturnFocusAssetId;
  if (returnEl instanceof HTMLElement && returnEl.isConnected) returnEl.focus({ preventScroll: true });
  else if (state.viewMode === "asset" && els.assetViewBack instanceof HTMLElement) els.assetViewBack.focus({ preventScroll: true });
  else {
    const replacement = returnAssetId
      ? els.assetGrid?.querySelector(`.asset-card[data-id="${CSS.escape(returnAssetId)}"] .asset-card-select`)
      : null;
    if (replacement instanceof HTMLElement) replacement.focus({ preventScroll: true });
    else els.assetGrid?.focus({ preventScroll: true });
  }
  state.previewReturnFocus = null;
  state.previewReturnFocusAssetId = null;
  scheduleImagePreviewCleanup();
}

function trapImagePreviewFocus(event) {
  if (event.defaultPrevented) return;
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

function renderDetail({ syncAssetView = true } = {}) {
  if (!els.detailPanel) return;
  // Rebuilding destroys every input; cancel a pending debounced save so it
  // cannot fire against the fresh DOM. An in-flight PATCH is left to resolve
  // and bail via the stale renderId guard inside persistInspectorDraft.
  cancelInspectorSave();
  activeInspector = null;
  const renderId = ++detailRenderSequence;
  const stackDetail = state.detailStack?.coverAssetId === state.selectedId ? state.detailStack : null;
  const asset = selectedAsset();
  // Re-rendering replaces the whole panel, so a focus that lived inside it
  // would fall back to <body>. Arrow-key gallery browsing re-renders on every
  // step; keep the keyboard anchored on the detail title instead.
  const hadPanelFocus = document.activeElement instanceof HTMLElement && els.detailPanel.contains(document.activeElement);
  if (stackDetail) {
    detailRenderedAssetId = `stack:${stackDetail.id}`;
    els.detailPanel.innerHTML = `<div class="detail-inspector"><div class="detail-inspector-header"><span data-detail-header-label>${t("stackInspectorTitle")}</span><button class="detail-close" type="button" data-action="close-detail" aria-label="${t("close")}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div><div class="detail-inspector-scroll">${stackInspectorMarkup(stackDetail)}</div></div>`;
    bindStackInspectorMediaFallbacks(els.detailPanel);
    els.detailPanel.querySelector('[data-action="close-detail"]')?.addEventListener("click", () => { void closeDetailSurface(); });
    return;
  }
  const keepScrollTop = !hadPanelFocus && asset && detailRenderedAssetId === asset.id
    ? els.detailPanel.querySelector(".detail-inspector-scroll")?.scrollTop ?? null
    : null;
  if (!asset) { detailRenderedAssetId = null; els.detailPanel.innerHTML = `<div class="detail-inspector"><div class="detail-inspector-header"><span data-detail-header-label>${t("assetInspector")}</span><button class="detail-close" type="button" data-action="close-detail" aria-label="${t("close")}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div><div class="detail-inspector-scroll"><div class="detail-empty"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg><p>${t(state.assets.length ? "noSelection" : "noAssets")}</p><span>${t(state.assets.length ? "noSelectionHint" : "noAssetsHint")}</span></div></div></div>`; return; }
  const cachedHistory = versionHistoryForAsset(asset);
  const cachedRecipeHistory = recipeHistoryForAsset(asset) || recipeHistoryFromAsset(asset);
  const cachedGenerationHistory = generationHistoryForAsset(asset);
  // Library v2 保持单层详情容器：语义区块直接进入唯一滚动列，不再额外包卡片壳。
  els.detailPanel.innerHTML = `<div class="detail-inspector"><div class="detail-inspector-header"><span data-detail-header-label>${t("assetInspector")}</span><button class="detail-close" type="button" data-action="close-detail" aria-label="${t("close")}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div><div class="detail-inspector-scroll">${detailFileSectionMarkup(asset)}${detailTagsSectionMarkup(asset)}${detailPromptSectionMarkup(asset)}${detailSourceSectionMarkup(asset)}${detailVersionSectionMarkup(asset, cachedHistory, cachedRecipeHistory, cachedGenerationHistory)}${detailGroupSectionMarkup(asset)}${detailMoreSectionMarkup(asset)}</div></div>`;
  const previewAspect = els.detailPanel.querySelector("[data-detail-preview-aspect]");
  if (previewAspect?.dataset.detailPreviewAspect) {
    previewAspect.style.setProperty("--detail-preview-aspect", previewAspect.dataset.detailPreviewAspect);
  }
  if (previewAspect?.dataset.detailPreviewNaturalFallback === "true") {
    const image = previewAspect.querySelector("img.detail-image");
    const applyNaturalPreviewAspect = () => {
      if (!image?.naturalWidth || !image.naturalHeight || !previewAspect.isConnected) return;
      const aspect = image.naturalWidth / image.naturalHeight;
      previewAspect.style.setProperty("--detail-preview-aspect", aspect >= 9 / 16
        ? `${image.naturalWidth} / ${image.naturalHeight}`
        : "9 / 16");
    };
    image?.addEventListener("load", applyNaturalPreviewAspect, { once: true });
    if (image?.complete) applyNaturalPreviewAspect();
  }
  const scroller = els.detailPanel.querySelector(".detail-inspector-scroll");
  if (scroller && keepScrollTop !== null) scroller.scrollTop = keepScrollTop;
  bindDetailHeaderContext(asset);
  bindDetailEvents(asset, renderId);
  bindReferenceThumbnailFallbacks(els.detailPanel);
  bindVersionPickerEvents();
  bindVersionHistoryEvents(cachedHistory);
  bindGenerationHistoryEvents(cachedGenerationHistory, asset.id);
  bindRecipeHistoryEvents(cachedRecipeHistory, asset);
  detailRenderedAssetId = asset.id;
  if (hadPanelFocus) els.detailPanel.querySelector("#detailTitle")?.focus();
  // Phase 3A：详情内容变化（版本切换/后台刷新/语言切换）时同步查看模式舞台主图。
  if (syncAssetView && state.viewMode === "asset") renderAssetView();
  // P2：该素材的历史已有缓存（同素材重渲染：收藏切换/自动保存后的后台刷新/
  // 语言切换）时不重发两个历史请求；导航换素材时缓存已被清空，照常拉取。
  if (!cachedHistory) void loadVersionHistory(asset);
  if (!cachedRecipeHistory) void loadRecipeHistory(asset);
  if (!cachedGenerationHistory) void loadGenerationHistory(asset);
}

function bindDetailHeaderContext(asset) {
  const scroller = els.detailPanel?.querySelector(".detail-inspector-scroll");
  const overview = scroller?.querySelector('[data-inspector-section="file"]');
  const headerLabel = els.detailPanel?.querySelector("[data-detail-header-label]");
  if (!scroller || !overview || !headerLabel) return;
  const assetTitle = displayAssetTitle(asset);
  const syncHeader = () => {
    const overviewPassed = scroller.scrollTop >= overview.offsetTop + overview.offsetHeight - 8;
    headerLabel.textContent = overviewPassed ? assetTitle : t("assetInspector");
    headerLabel.title = overviewPassed ? assetTitle : "";
    headerLabel.classList.toggle("is-contextual", overviewPassed);
  };
  scroller.addEventListener("scroll", syncHeader, { passive: true });
  syncHeader();
}

let generationHistoryRequestSequence = 0;
function generationHistoryForAsset(asset) {
  const history = state.generationHistory;
  return history?.project_id === asset.project_id && history?.asset_id === asset.id ? history : null;
}
async function loadGenerationHistory(asset, options = {}) {
  const requestId = ++generationHistoryRequestSequence;
  const selectedKey = `${asset.project_id}\u0000${asset.id}`;
  try {
    const result = await apiFetch(`/api/assets/${encodeURIComponent(asset.project_id)}/${encodeURIComponent(asset.id)}/generation-history`);
    if (requestId !== generationHistoryRequestSequence || `${state.project}\u0000${state.selectedId}` !== selectedKey) return;
    state.generationHistory = result.history;
    renderGenerationHistoryRegion(result.history, asset.id, null, options);
  } catch (error) {
    if (requestId !== generationHistoryRequestSequence || `${state.project}\u0000${state.selectedId}` !== selectedKey) return;
    renderGenerationHistoryRegion(null, asset.id, error);
  }
}
function renderGenerationHistoryRegion(history, selectedId, error = null, options = {}) {
  const region = els.detailPanel?.querySelector("[data-generation-history]");
  if (!region || state.selectedId !== selectedId) return;
  region.innerHTML = error
    ? `<p class="generation-history-status error" role="status">${escapeHtml(t("generationHistoryLoadFailed"))}: ${escapeHtml(error.message)}</p>`
    : generationHistoryMarkup(history, selectedId);
  if (error) return;
  bindGenerationHistoryEvents(history, selectedId);
  for (const generationId of options.openGenerationIds || []) {
    const node = region.querySelector(`[data-generation-id="${CSS.escape(String(generationId))}"]`);
    if (node instanceof HTMLDetailsElement) node.open = true;
  }
}

function generationHistoryEvent(history, generationId) {
  return [...(history?.events || []), ...(history?.context_events || [])]
    .find((event) => event.id === generationId) || null;
}

function openGenerationNodeIds(region) {
  return [...(region?.querySelectorAll?.("[data-generation-id][open]") || [])]
    .map((node) => node.dataset.generationId)
    .filter(Boolean);
}

async function openGenerationOutputAsset(outputAssetId) {
  const cleanAssetId = String(outputAssetId || "").trim();
  if (!cleanAssetId || cleanAssetId === state.selectedId) return;
  const originProjectId = state.project;
  const originAssetId = state.selectedId;
  if (!await confirmDetailNavigation(cleanAssetId)) return;
  if (originAssetId !== null && !isCurrentDetailSelection(originProjectId, originAssetId)) return;

  let target = state.assets.find((asset) => asset.id === cleanAssetId && asset.project_id === originProjectId) || null;
  if (!target) {
    const result = await apiFetch(`/api/assets/${encodeURIComponent(originProjectId)}/${encodeURIComponent(cleanAssetId)}`);
    if (originAssetId !== null && !isCurrentDetailSelection(originProjectId, originAssetId)) return;
    target = result.asset || null;
  }
  if (!target) throw new Error(t("generationOpenAssetFailed"));

  discardDetailDraft();
  state.selectedId = cleanAssetId;
  state.detailAsset = state.assets.some((asset) => asset.id === cleanAssetId && asset.project_id === originProjectId) ? null : target;
  state.versionHistory = null;
  state.recipeHistory = null;
  state.generationHistory = null;
  setDetailOpen(true);
  updateSelectedCard();
}

async function showGenerationEventContext(history, generationId) {
  const generation = generationHistoryEvent(history, generationId);
  const conversationId = String(generation?.conversation_id || "").trim();
  if (!generation || !conversationId) return;
  const originProjectId = state.project;
  const originAssetId = state.selectedId;
  if (!await confirmDetailNavigation(null)) return;
  if (originAssetId !== null && !isCurrentDetailSelection(originProjectId, originAssetId)) return;
  discardDetailDraft();
  state.scope = "all";
  state.mediaKind = "all";
  clearFacets();
  state.facets.conversation = conversationId;
  if (generation.message_id) state.facets.generationBatch = generation.message_id;
  applyFilterChange();
}

function bindGenerationHistoryEvents(history, selectedAssetId) {
  const region = els.detailPanel?.querySelector("[data-generation-history]");
  if (!region || !history || state.selectedId !== selectedAssetId) return;
  if (region.dataset.generationEventsBound === "true") return;
  region.dataset.generationEventsBound = "true";
  region.addEventListener("click", (event) => {
    const activeHistory = state.generationHistory;
    const activeSelectedAssetId = state.selectedId;
    if (!activeHistory || !activeSelectedAssetId) return;
    const button = event.target.closest?.("button[data-action]");
    if (!button || !region.contains(button)) return;
    const action = button.dataset.action;
    if (action === "open-generation-output") {
      runAction(() => openGenerationOutputAsset(button.dataset.outputAssetId));
      return;
    }
    if (action === "view-generation-context") {
      runAction(() => showGenerationEventContext(activeHistory, button.dataset.generationId));
      return;
    }
    if (action === "confirm-generation-relation-candidate") {
      runAction(async () => {
        const childGenerationId = String(button.dataset.childGenerationId || "");
        const parentGenerationId = String(button.dataset.parentGenerationId || "");
        const relationType = String(button.dataset.relationType || "based_on");
        if (!childGenerationId || !parentGenerationId) return;
        const inferred = (activeHistory.relation_candidates || []).find((candidate) => (
          candidate.child_generation_id === childGenerationId
          && candidate.parent_generation_id === parentGenerationId
          && (candidate.suggested_relation_type || candidate.relation_type) === relationType
        ));
        button.disabled = true;
        try {
          await apiFetch("/api/generation-relations", {
            method: "POST",
            body: {
              projectId: state.project,
              childGenerationId,
              parentGenerationId,
              relationType,
              verificationLevel: "user_confirmed",
              evidence: {
                ...(inferred?.evidence || {}),
                source: "asset-inspector-reference-candidate",
                user_confirmed_relation: true,
              },
            },
          });
          showToast(t("generationRelationSaved"), "success");
          const current = selectedAsset();
          if (current?.id === activeSelectedAssetId) {
            await loadGenerationHistory(current, {
              openGenerationIds: [...new Set([
                ...openGenerationNodeIds(region),
                childGenerationId,
                parentGenerationId,
              ])],
            });
          }
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      });
      return;
    }
    if (action === "dismiss-generation-relation-candidate") {
      runAction(async () => {
        const childGenerationId = String(button.dataset.childGenerationId || "");
        const parentGenerationId = String(button.dataset.parentGenerationId || "");
        if (!childGenerationId || !parentGenerationId) return;
        button.disabled = true;
        try {
          await apiFetch("/api/generation-relation-candidates", {
            method: "PATCH",
            body: {
              projectId: state.project,
              childGenerationId,
              parentGenerationId,
              status: "dismissed",
            },
          });
          const current = selectedAsset();
          if (current?.id === activeSelectedAssetId) {
            await loadGenerationHistory(current, { openGenerationIds: openGenerationNodeIds(region) });
          }
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      });
      return;
    }
    if (action === "create-generation-relation") {
      const form = button.closest("[data-generation-link-form]");
      if (!form) return;
      runAction(async () => {
        const anchorGenerationId = String(form.dataset.anchorGenerationId || "");
        const candidateGenerationId = String(form.querySelector("[data-generation-link-candidate]")?.value || "");
        const direction = String(form.querySelector("[data-generation-link-direction]")?.value || "candidate-parent");
        const relationType = String(form.querySelector("[data-generation-link-type]")?.value || "edited_from");
        if (!anchorGenerationId || !candidateGenerationId) return;
        const childGenerationId = direction === "candidate-child" ? candidateGenerationId : anchorGenerationId;
        const parentGenerationId = direction === "candidate-child" ? anchorGenerationId : candidateGenerationId;
        button.disabled = true;
        try {
          await apiFetch("/api/generation-relations", {
            method: "POST",
            body: {
              projectId: state.project,
              childGenerationId,
              parentGenerationId,
              relationType,
              verificationLevel: "user_confirmed",
              evidence: { source: "asset-inspector", user_selected_relation: true },
            },
          });
          showToast(t("generationRelationSaved"), "success");
          const current = selectedAsset();
          if (current?.id === activeSelectedAssetId) {
            const openGenerationIds = [...new Set([...openGenerationNodeIds(region), anchorGenerationId, candidateGenerationId])];
            await loadGenerationHistory(current, { openGenerationIds });
          }
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      });
      return;
    }
    if (action === "save-generation-relation") {
      const row = button.closest("[data-generation-relation-row]");
      if (!row) return;
      runAction(async () => {
        const childGenerationId = String(row.dataset.childGenerationId || "");
        const parentGenerationId = String(row.dataset.parentGenerationId || "");
        const previousRelationType = String(row.dataset.previousRelationType || "");
        const relationType = String(row.querySelector("[data-generation-relation-type]")?.value || previousRelationType);
        const existing = (activeHistory.relations || []).find((relation) => relation.child_generation_id === childGenerationId
          && relation.parent_generation_id === parentGenerationId
          && relation.relation_type === previousRelationType);
        button.disabled = true;
        try {
          await apiFetch("/api/generation-relations", {
            method: "PATCH",
            body: {
              projectId: state.project,
              childGenerationId,
              parentGenerationId,
              previousRelationType,
              relationType,
              verificationLevel: "user_confirmed",
              evidence: { ...(existing?.evidence || {}), source: "asset-inspector", user_confirmed_relation: true },
            },
          });
          showToast(t("generationRelationSaved"), "success");
          const current = selectedAsset();
          if (current?.id === activeSelectedAssetId) await loadGenerationHistory(current, { openGenerationIds: openGenerationNodeIds(region) });
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      });
      return;
    }
    if (action === "delete-generation-relation") {
      const row = button.closest("[data-generation-relation-row]");
      if (!row) return;
      runAction(async () => {
        const originProjectId = state.project;
        const childGenerationId = String(row.dataset.childGenerationId || "");
        const parentGenerationId = String(row.dataset.parentGenerationId || "");
        const relationType = String(row.dataset.previousRelationType || "");
        const confirmed = await requestConfirmation({
          title: t("generationRelationDeleteTitle"),
          description: t("generationRelationDeleteDescription"),
          confirmLabel: t("generationRelationDeleteAction"),
          tone: "warning",
          returnFocus: button,
        });
        if (!confirmed || !isCurrentDetailSelection(originProjectId, activeSelectedAssetId)) return;
        button.disabled = true;
        try {
          await apiFetch("/api/generation-relations", {
            method: "DELETE",
            body: { projectId: originProjectId, childGenerationId, parentGenerationId, relationType },
          });
          showToast(t("generationRelationDeleted"), "success");
          const current = selectedAsset();
          if (current?.id === activeSelectedAssetId) await loadGenerationHistory(current, { openGenerationIds: openGenerationNodeIds(region) });
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      });
    }
  });
}

let versionHistoryRequestSequence = 0;
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
  discardDetailDraft();
  const previousScrollTop = els.detailPanel?.querySelector(".detail-inspector-scroll")?.scrollTop ?? null;
  state.selectedId = target.id;
  state.detailAsset = target;
  state.recipeHistory = null;
  state.generationHistory = null;
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
  renderPromptReferencesRegion(asset, error);
}
function renderPromptReferencesRegion(asset, error = null) {
  const region = els.detailPanel?.querySelector("[data-prompt-references]");
  if (!region || !isCurrentDetailSelection(asset.project_id, asset.id)) return;
  region.innerHTML = error
    ? `<div class="detail-reference-row detail-reference-error" role="status"><span class="detail-reference-label">${escapeHtml(t("referenceImage"))}</span><span class="detail-reference-value">${escapeHtml(t("referenceLoadFailed"))}</span></div>`
    : promptReferencesMarkup(asset);
  bindReferenceThumbnailFallbacks(region);
}
function bindReferenceThumbnailFallbacks(root) {
  root?.querySelectorAll?.("[data-reference-thumb-img]").forEach((image) => {
    if (image.dataset.referenceFallbackBound === "1") return;
    image.dataset.referenceFallbackBound = "1";
    image.addEventListener("error", () => {
      image.closest(".detail-reference-thumb")?.classList.add("is-load-error");
      const fallback = image.parentElement?.querySelector?.("[data-reference-thumb-fallback]");
      fallback?.setAttribute("aria-hidden", "false");
    }, { once: true });
  });
}
function bindStackInspectorMediaFallbacks(root) {
  root?.querySelectorAll?.("img[data-stack-fallback-src]").forEach((image) => {
    if (image.dataset.stackFallbackBound === "1") return;
    image.dataset.stackFallbackBound = "1";
    image.addEventListener("error", () => {
      const fallback = String(image.dataset.stackFallbackSrc || "").trim();
      if (!fallback || image.dataset.stackFallbackUsed === "1") return;
      image.dataset.stackFallbackUsed = "1";
      image.removeAttribute("srcset");
      image.src = fallback;
    });
  });
}
function renderReferenceRightsRegion(asset) {
  const region = els.detailPanel?.querySelector("[data-reference-rights]");
  if (!region || !isCurrentDetailSelection(asset.project_id, asset.id)) return;
  const section = region.closest("[data-reference-rights-section]");
  // Never let a late recipe-history response overwrite rights the user has
  // already started editing in this render.
  if (section?.dataset.referenceDirty === "true" || section?.getAttribute("aria-busy") === "true") return;
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
    await writeClipboardText(regenerationInstruction(asset, snapshot));
    showToast(t("instructionCopied"), "success");
  })));
}


function bindDetailEvents(asset, renderId) {
  const panel = els.detailPanel;
  activeInspector = { panel, asset, renderId };
  panel.querySelectorAll("[data-edit], [data-version-change], [data-recipe-change]").forEach((field) => {
    const scope = field.matches("[data-version-change]") ? "version" : "recipe";
    const markDirty = () => {
      field.dataset.detailDirty = "true";
      field.dataset.detailDirtyScope = scope;
      state.detailDirty = true;
      if (scope === "recipe") scheduleInspectorSave();
    };
    field.addEventListener("input", markDirty);
    field.addEventListener("change", markDirty);
  });
  panel.querySelector('[data-action="close-detail"]')?.addEventListener("click", () => { void closeDetailSurface(); });
  // Phase 4A 区块 2：Detail 内收藏——复用既有 toggleFavorite（同一收藏 API），不切换
  // 素材、不返回 Library；loadAssets 后 renderDetail 重渲染按 asset.favorite 重绘本按钮。
  panel.querySelector('[data-action="toggle-favorite"]')?.addEventListener("click", (event) => toggleFavorite(asset.id, event));
  panel.querySelector('[data-action="add-tag"]')?.addEventListener("click", () => openTagEditor(panel, asset, renderId));
  panel.querySelector('[data-action="copy-source"]')?.addEventListener("click", () => runAction(async () => { await writeClipboardText(sourceCopyValue(asset.source)); showToast(t("originalPathCopied"), "success"); }));
  panel.querySelector('[data-action="view-generation-session"]')?.addEventListener("click", () => { void showRelatedGenerations(asset, "session"); });
  panel.querySelector('[data-action="view-generation-batch"]')?.addEventListener("click", () => { void showRelatedGenerations(asset, "batch"); });
  if (!isVideoAsset(asset)) {
    panel.querySelector(".detail-image")?.addEventListener("dblclick", (event) => openImagePreview(asset.id, event.currentTarget));
  }
  panel.querySelector('[data-action="copy-prompt"]')?.addEventListener("click", () => runAction(async () => { await writeClipboardText(asset.prompt || ""); showToast(t("copySuccess"), "success"); }));
  panel.querySelector('[data-action="copy-instruction"]')?.addEventListener("click", () => runAction(async () => { const instruction = String(asset.source?.user_message || asset.business_fields?.user_message || "").trim(); await writeClipboardText(instruction); showToast(t("copySuccess"), "success"); }));
  panel.querySelectorAll('[data-edit="rating"] button').forEach((button) => button.addEventListener("click", () => {
    state.detailDirty = true;
    const rating = button.closest('[data-edit="rating"]');
    rating?.setAttribute("data-detail-dirty", "true");
    rating?.setAttribute("data-detail-dirty-scope", "recipe");
    const value = Number(button.dataset.val);
    panel.querySelectorAll('[data-edit="rating"] button').forEach((star) => { const number = Number(star.dataset.val); const on = number <= value; star.classList.toggle("on", on); star.setAttribute("aria-checked", String(number === value)); star.textContent = on ? "★" : "☆"; });
    scheduleInspectorSave();
  }));
  panel.querySelector('[data-action="save-recipe"]')?.addEventListener("click", () => runAction(() => flushInspectorSave()));

  bindReferenceRightsEvents(panel, asset, renderId);
}

const USE_PERMISSION_CYCLE = { undeclared: "allowed", allowed: "forbidden", forbidden: "undeclared" };

function handleReferenceRightsOpen(event) {
  if (!event.target.closest('[data-action="open-reference-rights"]')) return;
  const section = els.detailPanel?.querySelector("[data-reference-rights-section]");
  if (!section) return;
  section.open = true;
  section.scrollIntoView({ block: "nearest" });
  section.querySelector("select")?.focus({ preventScroll: true });
}

function bindReferenceRightsEvents(panel, asset, renderId) {
  const section = panel.querySelector("[data-reference-rights-section]");
  if (!section) return;

  // A reference can point at an asset that was since deleted. Without this the
  // thumbnail 404s and leaves an empty box; the strict CSP rules out an inline
  // onerror attribute, so the fallback is bound here.
  section.querySelectorAll(".reference-thumb img").forEach((image) => image.addEventListener("error", () => {
    // textContent 不做 HTML 解析，直接赋原始缩写；先 escapeHtml 会双重转义成 &amp; 之类。
    const initials = String(image.dataset.referenceLabel || "?").slice(0, 2).toUpperCase();
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
    section.dataset.referenceDirty = "true";
    state.detailDirty = true;
    scheduleInspectorSave();
  }));

  section.querySelectorAll("[data-reference-field]").forEach((field) => field.addEventListener("input", () => {
    section.dataset.referenceDirty = "true";
    state.detailDirty = true;
    refreshReferenceRowState(section, field.dataset.referenceIndex);
    scheduleInspectorSave();
  }));

  section.querySelector('[data-action="save-reference-rights"]')?.addEventListener("click", () => runAction(() => flushInspectorSave()));
}

function panelHasDirtyDraft(panel) {
  if (!panel) return false;
  return Boolean(panel.querySelector('[data-detail-dirty="true"], [data-reference-rights-section][data-reference-dirty="true"]'));
}

function clearDetailDirtyScope(panel, scope) {
  panel?.querySelectorAll(`[data-detail-dirty="true"][data-detail-dirty-scope="${scope}"]`).forEach((field) => {
    delete field.dataset.detailDirty;
    delete field.dataset.detailDirtyScope;
  });
  state.detailDirty = panelHasDirtyDraft(panel);
}

// C1：比较“发出时的请求体快照”与当前 DOM 草稿。不一致说明 PATCH 在途期间用户
// 又编辑了（这些值不在已发出的请求体里），成功返回后不得清脏。读取异常（如
// business_fields 的 JSON 正在写一半、面板已被重建）一律保守视为“已变化”，保数据。
function draftChangedDuringFlight(panel, sentRecipeSnapshot, sentReferencesSnapshot) {
  try {
    if (sentRecipeSnapshot !== null) {
      const changeSummary = panel.querySelector("[data-recipe-change]")?.value.trim() || "";
      if (JSON.stringify([readRecipeDraft(panel), changeSummary]) !== sentRecipeSnapshot) return true;
    }
    if (sentReferencesSnapshot !== null) {
      const section = panel.querySelector("[data-reference-rights-section]");
      if (!section) return false;
      if (JSON.stringify(readReferenceRightsDraft(section, state.detailAsset)) !== sentReferencesSnapshot) return true;
    }
  } catch {
    return true;
  }
  return false;
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
  return `<ol class="reference-list">${rows}</ol><div class="recipe-save-actions"><button class="recipe-save-btn secondary" type="button" data-action="save-reference-rights">${t("saveRights")}</button><span class="detail-autosave-status" data-autosave-status role="status" aria-live="polite"></span></div>`;
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
    capture_context_id: provenance.capture_context_id,
    provider_tool_call_id: provenance.provider_tool_call_id,
    provider_generation_call_id: provenance.provider_generation_call_id,
    provider_response_id: provenance.provider_response_id,
    provider_asset_id: provenance.provider_asset_id,
    verification_level: provenance.verification_level,
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
  const syncTagDraftState = () => {
    const dirty = Boolean(input?.value.trim());
    if (dirty) {
      editor.dataset.detailDirty = "true";
      editor.dataset.detailDirtyScope = "tags";
    } else {
      delete editor.dataset.detailDirty;
      delete editor.dataset.detailDirtyScope;
    }
    state.detailDirty = panelHasDirtyDraft(panel);
  };
  input?.addEventListener("input", syncTagDraftState);
  input?.focus();
  editor.addEventListener("submit", (event) => {
    event.preventDefault();
    if (editor.dataset.saving === "true") return;
    const value = input?.value.trim() || "";
    if (!value) { input?.focus(); return; }
    editor.dataset.saving = "true";
    editor.querySelectorAll("input, button").forEach((control) => { control.disabled = true; });
    runAction(async () => {
      const currentAsset = latestAssetSnapshot(asset.project_id, asset.id, asset);
      const tags = uniqueTags([...assetTags(currentAsset), value]);
      const result = await apiFetch(`/api/assets/${encodeURIComponent(asset.project_id)}/${encodeURIComponent(asset.id)}`, { method: "PATCH", body: { tags } });
      if (!isCurrentDetailAction(renderId, asset.project_id, asset.id)) return;
      state.detailAsset = result.asset;
      const index = state.assets.findIndex((item) => item.id === asset.id);
      if (index >= 0) state.assets[index] = result.asset;
      showToast(t("tagSaved"), "success");
      refreshDetailTagsSection(result.asset, renderId);
      clearDetailDirtyScope(panel, "tags");
    }).finally(() => {
      if (!editor.isConnected) return;
      delete editor.dataset.saving;
      editor.querySelectorAll("input, button").forEach((control) => { control.disabled = false; });
    });
  });
}

function refreshDetailTagsSection(asset, renderId) {
  const current = els.detailPanel?.querySelector('[data-inspector-section="tags"]');
  if (!current || !isCurrentDetailAction(renderId, asset.project_id, asset.id)) return;
  const holder = document.createElement("div");
  holder.innerHTML = detailTagsSectionMarkup(asset);
  const replacement = holder.firstElementChild;
  if (!replacement) return;
  current.replaceWith(replacement);
  replacement.querySelector('[data-action="add-tag"]')?.addEventListener("click", () => openTagEditor(els.detailPanel, asset, renderId));
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

function isCurrentDetailAction(renderId, projectId, assetId) {
  return renderId === detailRenderSequence && isCurrentDetailSelection(projectId, assetId);
}

function isCurrentDetailSelection(projectId, assetId) {
  return state.project === projectId && state.selectedId === assetId;
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
