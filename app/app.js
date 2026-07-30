import translations from "./i18n.mjs";
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

function normalizeDensity(value) {
  return GALLERY_DENSITIES.includes(String(value || "")) ? String(value) : "image";
}

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
  project: "default", projects: [], cowartCanvases: [], assets: [], pageTotal: 0, nextCursor: null, loadedPageCount: 0, selectedId: null, detailAsset: null, versionHistory: null, recipeHistory: null, detailOpen: false, detailDirty: false, detailTab: "overview", detailReturnFocus: null, imagePreviewId: null, previewReturnFocus: null, query: "",
  scope: "all", facets: { source: "", group: "", category: "", style: "" }, sort: normalizeSort(safeStorageGet("mosa.asset-sort")), facetQuery: "",
  groups: { total: 0, favorites: 0, recent: 0, codex: 0, cowart: 0, groups: [], categories: [], styles: [], styleTotal: 0 }, cowartInsertAvailable: false, cowartInsertTargetId: safeStorageGet("mosa.cowart-insert-target") || "mosa",
  galleryStatus: "loading", galleryError: null, galleryDensity: normalizeDensity(safeStorageGet("mosa.gallery-density")),
  libraryPath: "", codexImagesDir: "", supportedMediaExtensions: [], importSaving: false, modalReturnFocus: null, languagePreference: preference, locale: resolveLocale(preference),
  batchMode: false, batchSaving: false, selectedIds: new Set(), dragCounter: 0,
  darkMode: safeStorageGet("mosa-dark-mode") === "true",
  imageZoom: 1, imagePanX: 0, imagePanY: 0, imageDragging: false,
};

const els = {
  searchInput: document.querySelector("#searchInput"), quickFilters: document.querySelector("#quickFilters"),
  filterToggle: document.querySelector("#filterToggle"), filterPanel: document.querySelector("#filterPanel"), filterDot: document.querySelector("#filterDot"), clearFiltersBtn: document.querySelector("#clearFiltersBtn"), sourceFilters: document.querySelector("#sourceFilters"), groupList: document.querySelector("#groupList"), categoryList: document.querySelector("#categoryList"), styleList: document.querySelector("#styleList"),
  activeFilters: document.querySelector("#activeFilters"), sortSelect: document.querySelector("#sortSelect"), facetSearchInput: document.querySelector("#facetSearchInput"), styleTruncated: document.querySelector("#styleTruncated"), densityToggle: document.querySelector("#densityToggle"),
  settingsToggle: document.querySelector("#settingsToggle"), settingsMenu: document.querySelector("#settingsMenu"), addGroupBtn: document.querySelector("#addGroupBtn"), sidebarGroupList: document.querySelector("#sidebarGroupList"), newAssetTopBtn: document.querySelector("#newAssetTopBtn"), importModal: document.querySelector("#importModal"), closeImportModal: document.querySelector("#closeImportModal"), cancelImportBtn: document.querySelector("#cancelImportBtn"), groupModal: document.querySelector("#groupModal"), closeGroupModal: document.querySelector("#closeGroupModal"), cancelGroupBtn: document.querySelector("#cancelGroupBtn"), saveGroupBtn: document.querySelector("#saveGroupBtn"), groupNameInput: document.querySelector("#groupNameInput"), imagePreviewModal: document.querySelector("#imagePreviewModal"), imagePreviewStage: document.querySelector("#imagePreviewStage"), imagePreviewImage: document.querySelector("#imagePreviewImage"), imagePreviewVideo: document.querySelector("#imagePreviewVideo"), imagePreviewTitle: document.querySelector("#imagePreviewTitle"), closeImagePreview: document.querySelector("#closeImagePreview"), imagePathInput: document.querySelector("#imagePathInput"), codexSourceHint: document.querySelector("#codexSourceHint"), importFormatList: document.querySelector("#importFormatList"), importPathExample: document.querySelector("#importPathExample"), imagePathError: document.querySelector("#imagePathError"), businessFieldsError: document.querySelector("#businessFieldsError"), importAdvanced: document.querySelector("#importAdvanced"), promptInput: document.querySelector("#promptInput"), skillInput: document.querySelector("#skillInput"), styleInput: document.querySelector("#styleInput"), ratioInput: document.querySelector("#ratioInput"), themeInput: document.querySelector("#themeInput"), groupInput: document.querySelector("#groupInput"), categoryInput: document.querySelector("#categoryInput"), businessInput: document.querySelector("#businessInput"), saveAssetBtn: document.querySelector("#saveAssetBtn"),
  viewTitle: document.querySelector("#viewTitle"), assetCount: document.querySelector("#assetCount"), statusText: document.querySelector("#statusText"), bridgeStatus: document.querySelector("#bridgeStatus"), bridgeStatusLabel: document.querySelector("#bridgeStatusLabel"), bridgeStatusMeta: document.querySelector("#bridgeStatusMeta"), appShell: document.querySelector("#appShell"), assetGrid: document.querySelector("#assetGrid"), detailPanel: document.querySelector("#detailPanel"), toastContainer: document.querySelector("#toastContainer")
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
});

// ===== Dark mode =====
function applyDarkMode() { document.documentElement.setAttribute("data-theme", state.darkMode ? "dark" : "light"); }
function toggleDarkMode() { state.darkMode = !state.darkMode; safeStorageSet("mosa-dark-mode", String(state.darkMode)); applyDarkMode(); showToast(t("darkModeChanged"), "success"); }

function droppedFilePath(file) {
  try {
    const electronPath = window.electronAPI?.getPathForFile?.(file);
    if (electronPath) return electronPath;
  } catch {
    // A normal browser cannot reveal a dropped file's local path.
  }
  return typeof file.path === "string" ? file.path : "";
}

// ===== Drag & Drop =====
function setupDragDrop() {
  const library = els.assetGrid?.closest(".library");
  if (!library) return;
  library.addEventListener("dragenter", (e) => { e.preventDefault(); state.dragCounter++; if (els.dragOverlay) els.dragOverlay.hidden = false; });
  library.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  library.addEventListener("dragleave", (e) => { e.preventDefault(); state.dragCounter--; if (state.dragCounter <= 0) { state.dragCounter = 0; if (els.dragOverlay) els.dragOverlay.hidden = true; } });
  library.addEventListener("drop", (e) => {
    e.preventDefault(); state.dragCounter = 0; if (els.dragOverlay) els.dragOverlay.hidden = true;
    const files = e.dataTransfer?.files;
    if (!files || !files.length) return;
    const file = files[0];
    if (!/\.(png|jpe?g|webp|gif|bmp|tiff?|mp4|webm|mov|m4v|svg)$/i.test(file.name)) { showToast(t("errorPathUnsupported"), "error"); return; }
    const filePath = droppedFilePath(file);
    if (filePath && els.imagePathInput) els.imagePathInput.value = filePath;
    openImportModal();
    if (!filePath) showToast(t("dropPathUnavailable"), "error");
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

async function runBatchOperation(action, successKey) {
  const assetIds = [...state.selectedIds];
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
  if (!window.confirm(t("confirmBatchArchive", { count: state.selectedIds.size }))) return;
  await runBatchOperation("archive", "batchArchiveDone");
}
async function toggleFavorite(id, event) {
  if (event) event.stopPropagation();
  try { await api(`/api/assets/${encodeURIComponent(state.project)}/${encodeURIComponent(id)}/favorite`, { method: "POST" }); showToast(t("favAdded"), "success"); await loadAssets(); } catch (error) { showToast(error.message, "error"); }
}

// ===== Keyboard Shortcuts =====
function setupKeyboardShortcuts() {
  document.addEventListener("keydown", (event) => {
    if (event.target.matches("input, textarea, select")) return;
    if (event.key === "/" && !els.importModal?.classList.contains("open") && !els.groupModal?.classList.contains("open")) { event.preventDefault(); els.searchInput?.focus(); return; }
    if (event.key === "Escape") {
      if (state.batchMode) { toggleBatchMode(); event.preventDefault(); return; }
      if (!els.imagePreviewModal?.hidden) { closeImagePreview(); event.preventDefault(); return; }
      if (els.importModal?.classList.contains("open")) { closeImportModal(); event.preventDefault(); return; }
      if (els.groupModal?.classList.contains("open")) { closeGroupModal(); event.preventDefault(); return; }
      if (state.detailOpen) { setDetailOpen(false); event.preventDefault(); return; }
    }
    if (event.key === "b" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); toggleBatchMode(); }
  });
}

// ===== Image Zoom & Pan =====
function resetImageZoom() { state.imageZoom = 1; state.imagePanX = 0; state.imagePanY = 0; applyImageTransform(); }
function applyImageTransform() { const img = els.imagePreviewImage; if (!img) return; img.style.transform = `scale(${state.imageZoom}) translate(${state.imagePanX}px, ${state.imagePanY}px)`; if (els.imagePreviewStage) els.imagePreviewStage.classList.toggle("zoomed", state.imageZoom > 1); }
function zoomImage(delta) { state.imageZoom = Math.max(0.5, Math.min(5, state.imageZoom + delta)); if (state.imageZoom === 1) { state.imagePanX = 0; state.imagePanY = 0; } applyImageTransform(); }
function setupImageZoomPan() {
  const stage = els.imagePreviewStage; if (!stage) return;
  stage.addEventListener("wheel", (e) => { if (state.imagePreviewId) { e.preventDefault(); zoomImage(e.deltaY < 0 ? 0.25 : -0.25); } }, { passive: false });
  let startX, startY;
  stage.addEventListener("mousedown", (e) => { if (state.imageZoom <= 1) return; state.imageDragging = true; startX = e.clientX - state.imagePanX; startY = e.clientY - state.imagePanY; stage.classList.add("dragging"); });
  document.addEventListener("mousemove", (e) => { if (!state.imageDragging) return; state.imagePanX = e.clientX - startX; state.imagePanY = e.clientY - startY; applyImageTransform(); });
  document.addEventListener("mouseup", () => { state.imageDragging = false; els.imagePreviewStage?.classList.remove("dragging"); });
}

function renderEmptyState() {
  return `<div class="empty-state-onboard"><svg class="empty-icon" width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg><h3>${t("onboardTitle")}</h3><p>${t("onboardHint")}</p><div class="empty-state-actions"><button class="btn-primary" type="button" id="onboardImportBtn">${t("onboardImport")}</button></div></div>`;
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
    setInterval(refreshBridgeStatus, 5000);
    setInterval(refreshLibraryInBackground, 2500);
  } catch (error) {
    renderErrorState(error);
    setStatus(t("statusUnavailable"), "error");
  }
  bindKeyboardNav();
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
  renderSettingsMenu();
  if (els.sortSelect) els.sortSelect.value = state.sort;
  renderDensityToggle();
  renderQuickFilters();
  renderFilterPanel();
  updateViewTitle();
  renderGrid();
  if (state.detailOpen) renderDetail();
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
  els.settingsMenu.innerHTML = `<section class="settings-section"><p>${t("project")}</p><div class="settings-project-row"><select id="projectSelect" data-project-select aria-label="${escapeHtml(t("project"))}">${projectOptions}</select><button class="icon-button quiet" type="button" data-open-library title="${escapeHtml(t("openLibrary"))}" aria-label="${escapeHtml(t("openLibrary"))}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg></button></div></section><section class="settings-section settings-language-section"><p>${t("language")}</p><button class="settings-submenu-trigger" type="button" data-language-menu aria-expanded="false" aria-controls="languageMenu"><span>${escapeHtml(currentLanguage[1])}</span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg></button><div class="language-menu" id="languageMenu" aria-label="${escapeHtml(t("language"))}" hidden>${choices.map(([value, label]) => `<button type="button" data-locale="${value}" aria-pressed="${state.languagePreference === value}">${escapeHtml(label)}<span>${state.languagePreference === value ? "✓" : ""}</span></button>`).join("")}</div></section>`;
  els.settingsMenu.querySelector(".settings-language-section")?.insertAdjacentHTML("beforebegin", renderCowartCanvasSettings());
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

function cowartInsertTargetIdFor(asset) {
  const sourceId = typeof asset?.source?.cowart_source_id === "string" ? asset.source.cowart_source_id : "";
  const requestedId = sourceId || state.cowartInsertTargetId;
  if (state.cowartCanvases.some((canvas) => canvas.id === requestedId)) return requestedId;
  return state.cowartCanvases.find((canvas) => canvas.id === "mosa")?.id || state.cowartCanvases[0]?.id || "";
}

function createCowartInsertControl(asset) {
  const targetId = cowartInsertTargetIdFor(asset);
  state.cowartInsertTargetId = targetId || state.cowartInsertTargetId;

  const control = document.createElement("div");
  control.className = "cowart-insert-control";
  control.innerHTML = `<label class="visually-hidden" for="cowartInsertTarget">${escapeHtml(t("cowartInsertTarget"))}</label><select id="cowartInsertTarget" class="cowart-target-select" data-cowart-insert-target aria-label="${escapeHtml(t("cowartInsertTarget"))}">${state.cowartCanvases.map((canvas) => `<option value="${escapeHtml(canvas.id)}"${canvas.id === targetId ? " selected" : ""}>${escapeHtml(cowartCanvasLabel(canvas))}</option>`).join("")}</select>`;

  const insertButton = document.createElement("button");
  insertButton.className = "action-btn primary";
  insertButton.type = "button";
  insertButton.dataset.action = "insert-cowart";
  insertButton.textContent = t("insertCowart");
  control.append(insertButton);
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

function bindKeyboardNav() {
  document.addEventListener("keydown", (event) => {
    if (els.importModal?.classList.contains("open") || els.groupModal?.classList.contains("open")) return;
    if (event.target.matches("input, textarea, select")) return;
    if (!ARROW_KEYS.has(event.key) || !state.assets.length) return;
    // Arrow keys belong to the tablist while a detail tab has focus.
    if (event.target.closest?.("[role='tab']")) return;
    if (!state.assets.some((asset) => asset.id === state.selectedId)) return;
    const nextId = neighbourAssetId(event.key);
    if (!nextId) return;
    event.preventDefault();
    selectAsset(nextId, true);
  });
}

let toastTimer = null;
function showToast(message, type = "default") {
  if (!els.toastContainer) return;
  els.toastContainer.querySelector(".toast")?.remove();
  clearTimeout(toastTimer);
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  els.toastContainer.appendChild(toast);
  toastTimer = setTimeout(() => { toast.classList.add("fading"); setTimeout(() => toast.remove(), 180); }, 2200);
}

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
async function loadAssets(options = {}) {
  const requestId = ++assetRequestSequence;
  const request = currentAssetRequest();
  const params = new URLSearchParams({ project: request.project, q: request.query });
  params.set("limit", "100");
  // The sort is resolved by the store across the whole query, so the cursor must
  // travel with the same order it was issued under.
  params.set("sort", request.sort);
  if (options.append && state.nextCursor) params.set("cursor", state.nextCursor);
  if (request.scope === "favorite") params.set("favorite", "1");
  else if (request.scope === "recent") params.set("recent", "1");
  for (const key of FACET_KEYS) {
    if (request.facets[key]) params.set(key, request.facets[key]);
  }
  const result = await api(`/api/assets?${params}`);
  if (requestId !== assetRequestSequence || assetRequestKey(request) !== assetRequestKey(currentAssetRequest())) return false;

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
    renderGrid();
    updateViewTitle();
  }
  if (state.detailOpen && (!options.background || !state.selectedId || (selectedChanged && !isDetailEditorActive()))) renderDetail();
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
  return state.detailDirty || (active instanceof HTMLElement && Boolean(els.detailPanel?.contains(active) && active.closest("[data-edit], [data-version-change]")));
}

async function refreshBridgeStatus() {
  try {
    const { codex, grok, cowart, cowartInsert } = await api("/api/bridges");
    const nextCanvases = Array.isArray(cowart?.sources) ? cowart.sources : [];
    if (cowartCanvasListSignature(nextCanvases) !== cowartCanvasListSignature(state.cowartCanvases)) {
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
  } catch {
    state.cowartInsertAvailable = false;
    if (els.bridgeStatusMeta) els.bridgeStatusMeta.textContent = "";
    setStatus(t("statusUnavailable"), "error");
    updateCowartInsertControls();
  }
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
  els.searchInput?.addEventListener("input", debounce(async () => { state.query = els.searchInput.value; state.nextCursor = null; renderActiveFilters(); await loadAssets(); }, 180));
  els.sortSelect?.addEventListener("change", () => {
    state.sort = normalizeSort(els.sortSelect.value);
    safeStorageSet("mosa.asset-sort", state.sort);
    // Cursors are order-specific, so a sort change always restarts from page one.
    state.nextCursor = null;
    void loadAssets();
  });
  els.densityToggle?.addEventListener("click", () => {
    state.galleryDensity = state.galleryDensity === "info" ? "image" : "info";
    safeStorageSet("mosa.gallery-density", state.galleryDensity);
    renderDensityToggle();
    renderGrid();
  });
  els.facetSearchInput?.addEventListener("input", debounce(() => { state.facetQuery = els.facetSearchInput.value; renderFilterPanel(); }, 120));
  els.activeFilters?.addEventListener("click", (event) => { const chip = event.target.closest("[data-chip]"); if (chip) removeFilterChip(chip.dataset.chip); });
  els.assetGrid?.addEventListener("click", (event) => {
    if (event.target.closest('[data-action="retry"]')) window.location.reload();
    if (event.target.closest('[data-action="load-more"]')) void loadAssets({ append: true });
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
    renderActiveFilters();
    await loadStats(); await loadAssets();
  });
  els.settingsMenu?.addEventListener("click", (event) => {
    const languageMenuTrigger = event.target.closest("[data-language-menu]");
    if (languageMenuTrigger) {
      const languageMenu = els.settingsMenu.querySelector("#languageMenu");
      if (!languageMenu) return;
      const willOpen = languageMenu.hidden;
      languageMenu.hidden = !willOpen;
      languageMenuTrigger.setAttribute("aria-expanded", String(willOpen));
      if (willOpen) positionLanguageMenu();
      return;
    }
    const localeButton = event.target.closest("[data-locale]");
    if (localeButton) return setLanguage(localeButton.dataset.locale);
    const openLibraryButton = event.target.closest("[data-open-library]");
    if (openLibraryButton) runAction(async () => { if (!state.libraryPath) return; await api("/api/open-folder", { method: "POST", body: { path: state.libraryPath } }); showToast(t("openInFinder"), "success"); });
  });
  els.closeImportModal?.addEventListener("click", closeImportModal);
  els.cancelImportBtn?.addEventListener("click", closeImportModal);
  els.importModal?.addEventListener("click", (event) => { if (event.target === els.importModal) closeImportModal(); });
  els.closeGroupModal?.addEventListener("click", closeGroupModal);
  els.cancelGroupBtn?.addEventListener("click", closeGroupModal);
  els.groupModal?.addEventListener("click", (event) => { if (event.target === els.groupModal) closeGroupModal(); });
  els.saveGroupBtn?.addEventListener("click", saveGroup);
  els.closeImagePreview?.addEventListener("click", closeImagePreview);
  els.imagePreviewModal?.addEventListener("click", (event) => { if (event.target === els.imagePreviewModal) closeImagePreview(); });
  els.imagePreviewStage?.addEventListener("click", (event) => { if (event.target === els.imagePreviewStage) closeImagePreview(); });
  els.imagePreviewImage?.addEventListener("load", fitImagePreview);
  els.saveAssetBtn?.addEventListener("click", saveAsset);
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#filterToggle") && !event.target.closest("#filterPanel")) closePanel(els.filterPanel, els.filterToggle);
    if (!event.target.closest(".settings-wrap")) closePanel(els.settingsMenu, els.settingsToggle);
  });
  window.addEventListener("resize", () => { if (!els.filterPanel?.hidden) positionFilterPanel(); if (!els.settingsMenu?.querySelector("#languageMenu")?.hidden) positionLanguageMenu(); if (state.imagePreviewId) fitImagePreview(); });
  document.addEventListener("keydown", trapImportModalFocus);
  document.addEventListener("keydown", trapGroupModalFocus);
  document.addEventListener("keydown", trapImagePreviewFocus);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!state.detailOpen) return;
    if (els.importModal?.classList.contains("open") || els.groupModal?.classList.contains("open") || !els.imagePreviewModal?.hidden) return;
    event.preventDefault();
    setDetailOpen(false);
  });
  document.querySelector("#darkModeToggle")?.addEventListener("click", toggleDarkMode);
  bindDesktopIntegration();
}

function bindDesktopIntegration() {
  const api = window.electronAPI;
  if (!api) return;
  document.querySelector("#browseFileBtn")?.addEventListener("click", async () => {
    const filePaths = await api.openFileDialog();
    if (filePaths?.length && els.imagePathInput) {
      els.imagePathInput.value = filePaths[0];
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
  state.query = "";
  if (els.searchInput) els.searchInput.value = "";
  state.scope = "all";
  clearFacets();
  applyFilterChange();
}

function applyFilterChange() {
  // A filter change restarts paging, so any cursor from the previous query is stale.
  state.nextCursor = null;
  clearDetailSelection();
  renderQuickFilters(); renderFilterPanel(); renderActiveFilters(); loadAssets();
}

function togglePanel(panel, trigger) {
  if (!panel) return;
  const willOpen = panel.hidden;
  closePanel(els.filterPanel, els.filterToggle); closePanel(els.settingsMenu, els.settingsToggle);
  panel.hidden = !willOpen;
  if (willOpen && panel === els.filterPanel) positionFilterPanel();
  trigger?.setAttribute("aria-expanded", String(willOpen));
}
function closePanel(panel, trigger) { if (!panel) return; panel.hidden = true; trigger?.setAttribute("aria-expanded", "false"); if (panel === els.settingsMenu) { panel.querySelector("#languageMenu")?.setAttribute("hidden", ""); panel.querySelector("[data-language-menu]")?.setAttribute("aria-expanded", "false"); } }

function positionFilterPanel() {
  if (!els.filterPanel || !els.filterToggle) return;
  const trigger = els.filterToggle.getBoundingClientRect();
  const padding = 12;
  const panelWidth = Math.min(286, window.innerWidth - padding * 2);
  const top = Math.min(trigger.bottom + 8, Math.max(padding, window.innerHeight - 480));
  const left = Math.max(padding, Math.min(trigger.right - panelWidth, window.innerWidth - panelWidth - padding));
  els.filterPanel.style.setProperty("--filter-panel-top", `${top}px`);
  els.filterPanel.style.setProperty("--filter-panel-left", `${left}px`);
  els.filterPanel.style.setProperty("--filter-panel-right", "auto");
}

function positionLanguageMenu() {
  const trigger = els.settingsMenu?.querySelector("[data-language-menu]");
  const menu = els.settingsMenu?.querySelector("#languageMenu");
  if (!trigger || !menu) return;
  const triggerRect = trigger.getBoundingClientRect();
  const padding = 12;
  const width = Math.min(184, window.innerWidth - padding * 2);
  const desiredLeft = triggerRect.right + 8;
  const left = desiredLeft + width <= window.innerWidth - padding ? desiredLeft : Math.max(padding, triggerRect.left - width - 8);
  menu.style.setProperty("--language-menu-top", `${Math.max(padding, Math.min(triggerRect.top, window.innerHeight - 142 - padding))}px`);
  menu.style.setProperty("--language-menu-left", `${left}px`);
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

/** The toggle is a two-state switch, so its name says which mode it will apply. */
function renderDensityToggle() {
  if (!els.densityToggle) return;
  const showingInfo = state.galleryDensity === "info";
  els.densityToggle.setAttribute("aria-pressed", String(showingInfo));
  const label = `${t("galleryDensity")}: ${t(showingInfo ? "densityWithInfo" : "densityImageOnly")}`;
  els.densityToggle.setAttribute("aria-label", label);
  els.densityToggle.title = label;
}

/**
 * Placeholders sized like real cards, so the first paint is not a fake empty
 * library. Heights come from nth-child rules rather than inline styles.
 */
function gallerySkeletonMarkup() {
  const tiles = Array.from({ length: SKELETON_TILE_COUNT }, () => `<div class="asset-skeleton" aria-hidden="true"></div>`).join("");
  return `<div class="gallery-skeleton" role="status" aria-live="polite"><span class="visually-hidden">${escapeHtml(t("galleryLoading"))}</span>${tiles}</div>`;
}

function renderGrid() {
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
    els.assetGrid.innerHTML = `<div class="empty-state"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg><p>${t("noAssets")}</p><span>${t("noAssetsHint")}</span></div>`;
    return;
  }
  const cards = state.assets.map((asset) => {
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
    const favBtn = `<button class="card-favorite${isFav ? " is-fav" : ""}" type="button" data-fav-id="${escapeHtml(asset.id)}" aria-label="${escapeHtml(favoriteLabel)}" title="${escapeHtml(favoriteLabel)}">${isFav ? "★" : "☆"}</button>`;
    return `<article class="asset-card${selected ? " selected" : ""}${isVideoAsset(asset) ? " is-video" : ""}" data-id="${escapeHtml(asset.id)}" title="${escapeHtml(cardShortTitle(asset))}">${checkbox}${favBtn}<button class="asset-card-select" type="button" aria-pressed="${selected}" aria-label="${escapeHtml(label)}">${media}</button>${info}<button class="card-quick-copy" type="button" data-copy="${escapeHtml(asset.prompt || "")}" data-i18n-title="copyPrompt" title="${t("copyPrompt")}" aria-label="${t("copyPrompt")}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9"/></svg></button></article>`;
  }).join("");
  els.assetGrid.innerHTML = `${cards}${state.nextCursor ? `<div class="asset-load-more"><button type="button" data-action="load-more">${t("loadMore")}</button></div>` : ""}`;
  setupMasonryLayout();
  els.assetGrid.querySelectorAll(".asset-card-select").forEach((button) => {
    button.addEventListener("click", () => selectAsset(button.closest(".asset-card")?.dataset.id));
    button.addEventListener("dblclick", () => {
      const id = button.closest(".asset-card")?.dataset.id;
      if (id) openImagePreview(id, button);
    });
  });
  els.assetGrid.querySelectorAll(".card-quick-copy").forEach((button) => button.addEventListener("click", async (event) => { event.stopPropagation(); await runAction(async () => { await navigator.clipboard.writeText(button.dataset.copy || ""); showToast(t("copySuccess"), "success"); }); }));
  els.assetGrid.querySelectorAll(".card-favorite").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); void toggleFavorite(button.dataset.favId, event); }));
  els.assetGrid.querySelectorAll(".card-checkbox").forEach((checkbox) => checkbox.addEventListener("change", (event) => { void toggleAssetSelection(checkbox.dataset.batchId, event); }));
}

/** Routed through the state machine so a later re-render cannot resurrect the skeleton. */
function renderErrorState(error) {
  state.galleryStatus = "error";
  state.galleryError = error instanceof Error ? error : new Error(String(error || ""));
  renderGrid();
  updateViewTitle();
}

function selectAsset(id, shouldScroll = false) {
  if (!id || !confirmDetailNavigation(id)) return;
  state.selectedId = id; state.detailAsset = null; state.versionHistory = null; state.recipeHistory = null; setDetailOpen(true); updateSelectedCard();
  if (shouldScroll) els.assetGrid.querySelector(`.asset-card[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function clearDetailSelection() {
  state.selectedId = null;
  state.detailAsset = null;
  state.versionHistory = null;
  state.recipeHistory = null;
  state.detailTab = "overview";
}

function confirmDetailNavigation(nextAssetId) {
  return !state.detailDirty || nextAssetId === state.selectedId || window.confirm(t("discardVersionChanges"));
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
    state.detailTab = "overview";
    const returnEl = state.detailReturnFocus;
    state.detailReturnFocus = null;
    if (returnEl instanceof HTMLElement && returnEl.isConnected) returnEl.focus();
  }
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
function closeImportModal() { els.importModal?.classList.remove("open"); els.importModal?.setAttribute("aria-hidden", "true"); if (state.modalReturnFocus instanceof HTMLElement) state.modalReturnFocus.focus(); state.modalReturnFocus = null; }
function openGroupModal() { state.modalReturnFocus = document.activeElement; els.groupModal?.classList.add("open"); els.groupModal?.setAttribute("aria-hidden", "false"); if (els.groupNameInput) els.groupNameInput.value = ""; requestAnimationFrame(() => els.groupNameInput?.focus()); }
function closeGroupModal() { els.groupModal?.classList.remove("open"); els.groupModal?.setAttribute("aria-hidden", "true"); if (state.modalReturnFocus instanceof HTMLElement) state.modalReturnFocus.focus(); state.modalReturnFocus = null; }
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
  state.previewReturnFocus = trigger instanceof HTMLElement ? trigger : document.activeElement;
  els.imagePreviewTitle.textContent = asset.theme || asset.asset || asset.id;
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
}

function closeImagePreview() {
  if (!els.imagePreviewModal?.hidden) els.imagePreviewModal.hidden = true;
  els.imagePreviewImage?.removeAttribute("src");
  els.imagePreviewImage.hidden = false;
  els.imagePreviewVideo?.pause();
  els.imagePreviewVideo?.removeAttribute("src");
  els.imagePreviewVideo.hidden = true;
  state.imagePreviewId = null;
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

function renderDetail() {
  if (!els.detailPanel) return;
  const renderId = ++detailRenderSequence;
  const asset = selectedAsset();
  // Re-rendering replaces the whole panel, so a focus that lived inside it
  // would fall back to <body>. Arrow-key gallery browsing re-renders on every
  // step; keep the keyboard anchored on the detail title instead.
  const hadPanelFocus = document.activeElement instanceof HTMLElement && els.detailPanel.contains(document.activeElement);
  state.detailDirty = false;
  if (!asset) { els.detailPanel.innerHTML = `<div class="detail-empty"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg><p>${t(state.assets.length ? "noSelection" : "noAssets")}</p><span>${t(state.assets.length ? "noSelectionHint" : "noAssetsHint")}</span></div>`; return; }
  const source = asset.source || {}; const rating = Math.min(5, Math.max(0, Math.round(asset.rating || 0))); const groupOptions = state.groups.groups.map(([name]) => `<option value="${escapeHtml(name)}"></option>`).join("");
  const metadata = [["skill", asset.skill], ["style", asset.style], ["ratio", asset.ratio], ["theme", asset.theme], ["group", asset.group], ["category", asset.category], ["rating", asset.rating ? `${asset.rating}/5` : ""]].filter(([, value]) => value !== undefined && value !== null && value !== "");
  const sourceRows = buildSourceRows(source).filter(([, value]) => value !== undefined && value !== null && value !== "");
  const userInstruction = String(source.user_message || asset.business_fields?.user_message || "").trim();
  const promptUnavailable = (source.type === "web-chatgpt" || asset.source_type === "web-chatgpt")
    && source.prompt_status === "not-available";
  const promptText = asset.prompt
    ? escapeHtml(asset.prompt)
    : `<span class="empty-copy">${t(promptUnavailable ? "chatgptPromptUnavailable" : "notRecorded")}</span>`;
  const userInstructionSection = userInstruction
    ? `<section class="section"><div class="section-head"><h4>${t("userInstruction")}</h4></div><div class="prompt-box">${escapeHtml(userInstruction)}</div></section>`
    : "";
  const cachedHistory = versionHistoryForAsset(asset);
  const cachedRecipeHistory = recipeHistoryForAsset(asset) || recipeHistoryFromAsset(asset);
  const activeTab = state.detailTab || "overview";
  const copyIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9"/></svg>`;
  const metadataRows = metadata.map(([key, value]) => `<div class="meta-row"><span class="meta-key">${t(key)}</span><span class="meta-val">${key === "rating" ? `<span class="rating-stars">${"★".repeat(rating)}${"☆".repeat(5 - rating)}</span>` : escapeHtml(value)}</span></div>`).join("");
  const sourceRowsMarkup = sourceRows.map(([key, value]) => `<div class="meta-row"><span class="meta-key">${t(key)}</span><span class="meta-val source-value">${escapeHtml(value)}</span></div>`).join("");
  const editFieldsMarkup = `<label class="field"><span>${t("prompt")}</span><textarea data-edit="prompt" rows="5">${escapeHtml(asset.prompt || "")}</textarea></label><div class="two"><label class="field"><span>${t("skill")}</span><input data-edit="skill" value="${escapeHtml(asset.skill || "")}" /></label><label class="field"><span>${t("style")}</span><input data-edit="style" value="${escapeHtml(asset.style || "")}" /></label></div><div class="two"><label class="field"><span>${t("ratio")}</span><input data-edit="ratio" value="${escapeHtml(asset.ratio || "")}" /></label><label class="field"><span>${t("theme")}</span><input data-edit="theme" value="${escapeHtml(asset.theme || "")}" /></label></div><div class="two"><label class="field"><span>${t("group")}</span><input data-edit="group" value="${escapeHtml(asset.group || "")}" list="groupSuggestionsEdit" /><datalist id="groupSuggestionsEdit">${groupOptions}</datalist></label><label class="field"><span>${t("category")}</span><select data-edit="category"><option value="">${t("none")}</option>${categoryOptions(asset.category)}</select></label></div><label class="field"><span>${t("rating")}</span><div class="rating-edit" data-edit="rating">${[1,2,3,4,5].map((number) => `<button type="button" data-val="${number}" class="${number <= rating ? "on" : ""}" aria-label="${number}/5">${number <= rating ? "★" : "☆"}</button>`).join("")}</div></label><label class="field"><span>${t("businessFields")}</span><textarea data-edit="business_fields" rows="3">${escapeHtml(JSON.stringify(asset.business_fields || {}, null, 2))}</textarea></label>`;
  const versionChangeFieldMarkup = `<label class="field version-change-field"><span>${t("versionChange")}</span><textarea data-version-change rows="2" placeholder="${escapeHtml(t("versionChangePlaceholder"))}"></textarea></label>`;
  const openMediaAction = isVideoAsset(asset)
    ? `<button class="action-btn secondary" type="button" data-action="open-original-media">${t("openOriginalMedia")}</button>`
    : "";
  els.detailPanel.innerHTML = `<div class="detail-studio-bar"><span>${t("assetInspector")}</span><button class="detail-close" type="button" data-action="close-detail" aria-label="${t("close")}">${t("close")}</button></div><div class="detail-tabs" role="tablist" aria-label="${t("assetInspector")}"><button class="detail-tab" role="tab" id="detailTabOverview" aria-selected="${activeTab === "overview"}" aria-controls="detailPanelOverview" data-detail-tab="overview" tabindex="${activeTab === "overview" ? "0" : "-1"}">${t("tabOverview")}</button><button class="detail-tab" role="tab" id="detailTabRecipe" aria-selected="${activeTab === "recipe"}" aria-controls="detailPanelRecipe" data-detail-tab="recipe" tabindex="${activeTab === "recipe" ? "0" : "-1"}">${t("tabRecipe")}</button><button class="detail-tab" role="tab" id="detailTabVersions" aria-selected="${activeTab === "versions"}" aria-controls="detailPanelVersions" data-detail-tab="versions" tabindex="${activeTab === "versions" ? "0" : "-1"}">${t("tabVersions")}</button></div><div class="detail-tab-panel" role="tabpanel" id="detailPanelOverview" aria-labelledby="detailTabOverview"${activeTab !== "overview" ? " hidden" : ""}><div class="detail-image-wrap">${assetMediaPreviewMarkup(asset, "detail")}</div><div class="detail-head"><h3 id="detailTitle" tabindex="-1">${escapeHtml(asset.theme || asset.asset || asset.id)}</h3><p>${escapeHtml(asset.id)} · ${formatDate(asset.created_at)}</p></div><div class="detail-actions"><div class="cowart-insert-control"></div></div><section class="section"><div class="section-head"><h4>${t("prompt")}</h4><button class="section-head-copy" type="button" data-action="copy-prompt" title="${t("copyPrompt")}" aria-label="${t("copyPrompt")}">${copyIcon}</button></div><div class="prompt-box">${promptText}</div></section>${userInstructionSection}</div><div class="detail-tab-panel" role="tabpanel" id="detailPanelRecipe" aria-labelledby="detailTabRecipe"${activeTab !== "recipe" ? " hidden" : ""}><section class="section"><div class="section-head"><h4>${t("recipe")}</h4></div>${metadata.length ? `<div class="meta-table">${metadataRows}</div>` : `<p class="empty-copy">${t("noDetails")}</p>`}</section><details class="detail-disclosure"${activeTab === "recipe" ? " open" : ""}><summary>${t("editMetadata")}</summary><div class="disclosure-content detail-fields">${editFieldsMarkup}${versionChangeFieldMarkup}<div class="recipe-save-actions"><button class="recipe-save-btn secondary" type="button" data-action="save-recipe">${t("saveRecipe")}</button><button class="recipe-save-btn primary" type="button" data-action="save-version">${t("saveAsVersion")}</button></div></div></details><details class="detail-disclosure" data-reference-rights-section><summary>${t("referenceRights")}</summary><div class="disclosure-content" data-reference-rights>${referenceRightsMarkup(asset)}</div></details><details class="detail-disclosure"><summary>${t("sourceInfo")}</summary><div class="disclosure-content">${sourceRows.length ? `<div class="meta-table">${sourceRowsMarkup}</div>` : `<p class="empty-copy">${t("noDetails")}</p>`}</div></details><div class="detail-utility-actions"><button class="action-btn secondary" type="button" data-action="regenerate">${t("regenerate")}</button><button class="action-btn secondary" type="button" data-action="copy-path">${t("copyPath")}</button>${openMediaAction}<button class="action-btn danger" type="button" data-action="archive-asset">${t("batchArchive")}</button></div></div><div class="detail-tab-panel" role="tabpanel" id="detailPanelVersions" aria-labelledby="detailTabVersions"${activeTab !== "versions" ? " hidden" : ""}><details class="detail-disclosure" open><summary>${t("versionHistory")}</summary><div class="disclosure-content version-history-region" data-version-history aria-live="polite">${cachedHistory ? versionHistoryMarkup(cachedHistory, asset.id) : `<p class="version-history-status" role="status">${t("versionLoading")}</p>`}</div></details><details class="detail-disclosure"><summary>${t("imageLocation")}</summary><div class="disclosure-content"><div class="section-head detail-path-head"><h4>${t("imageLocation")}</h4><button class="section-head-copy" type="button" data-action="copy-path" title="${t("copyPath")}" aria-label="${t("copyPath")}">${copyIcon}</button></div><div class="path-box detail-path-box">${escapeHtml(asset.image_path)}</div></div></details></div>`;
  els.detailPanel.querySelector("[data-version-history]")?.closest(".detail-disclosure")?.insertAdjacentHTML(
    "afterend",
    recipeHistoryDisclosureMarkup(cachedRecipeHistory),
  );
  els.detailPanel.querySelector(".cowart-insert-control")?.prepend(createCowartInsertControl(asset));
  updateCowartInsertControls();
  bindDetailEvents(asset, renderId);
  bindDetailTabEvents();
  bindVersionHistoryEvents(cachedHistory);
  bindRecipeHistoryEvents(cachedRecipeHistory, asset);
  if (hadPanelFocus) els.detailPanel.querySelector("#detailTitle")?.focus();
  void loadVersionHistory(asset);
  void loadRecipeHistory(asset);
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
    const result = await api(`/api/assets/${encodeURIComponent(asset.project_id)}/${encodeURIComponent(asset.id)}/versions`);
    if (requestId !== versionHistoryRequestSequence || `${state.project}\u0000${state.selectedId}` !== selectedKey) return;
    state.versionHistory = result.history;
    renderVersionHistoryRegion(result.history, asset.id);
  } catch (error) {
    if (requestId !== versionHistoryRequestSequence || `${state.project}\u0000${state.selectedId}` !== selectedKey) return;
    renderVersionHistoryRegion(null, asset.id, error);
  }
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
    const asset = history.versions.find((version) => version.id === button.dataset.versionId);
    if (!asset || asset.id === state.selectedId || !confirmDetailNavigation(asset.id)) return;
    state.selectedId = asset.id;
    state.detailAsset = asset;
    state.versionHistory = history;
    state.recipeHistory = null;
    updateSelectedCard();
    renderDetail();
    requestAnimationFrame(() => els.detailPanel?.querySelector("#detailTitle")?.focus());
  }));
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
  return `<details class="detail-disclosure" open><summary>${t("recipeSnapshotHistory")}</summary><div class="disclosure-content recipe-history-region" data-recipe-history aria-live="polite">${content}</div></details>`;
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
function sourceName(source = {}) {
  if (source.type === "codex-generated") return t("sourceCodex");
  if (source.type === "cowart-generated") return t("sourceCowart");
  if (source.type === "grok-generated") return t("sourceGrok");
  return t("sourceManual");
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
  panel.querySelectorAll("[data-edit], [data-version-change]").forEach((field) => {
    field.addEventListener("input", () => { state.detailDirty = true; });
    field.addEventListener("change", () => { state.detailDirty = true; });
  });
  panel.querySelector('[data-action="close-detail"]')?.addEventListener("click", () => setDetailOpen(false));
  if (!isVideoAsset(asset)) {
    panel.querySelector(".detail-image")?.addEventListener("dblclick", (event) => openImagePreview(asset.id, event.currentTarget));
  }
  panel.querySelector('[data-action="open-original-media"]')?.addEventListener("click", (event) => {
    openImagePreview(asset.id, event.currentTarget);
  });
  panel.querySelector("[data-cowart-insert-target]")?.addEventListener("change", (event) => {
    state.cowartInsertTargetId = event.target.value;
    safeStorageSet("mosa.cowart-insert-target", state.cowartInsertTargetId);
  });
  panel.querySelector('[data-action="insert-cowart"]')?.addEventListener("click", () => runAction(async () => {
    const button = panel.querySelector('[data-action="insert-cowart"]');
    button.disabled = true;
    showToast(t("insertingCowart"));
    const targetId = panel.querySelector("[data-cowart-insert-target]")?.value || state.cowartInsertTargetId;
    const result = await api(`/api/assets/${encodeURIComponent(asset.project_id)}/${encodeURIComponent(asset.id)}/insert-cowart`, { method: "POST", body: { placement: "right", targetId } });
    const canvas = result.canvas || {};
    showToast(t("insertedCowart", { page: canvas.pageId || "Cowart", x: Math.round(canvas.bounds?.x || 0), y: Math.round(canvas.bounds?.y || 0) }), "success");
    await refreshBridgeStatus();
  }).finally(updateCowartInsertControls));
  panel.querySelector('[data-action="copy-prompt"]')?.addEventListener("click", () => runAction(async () => { await navigator.clipboard.writeText(asset.prompt || ""); showToast(t("copySuccess"), "success"); }));
  panel.querySelector('[data-action="copy-path"]')?.addEventListener("click", () => runAction(async () => { await navigator.clipboard.writeText(asset.image_path); showToast(t("pathCopied"), "success"); }));
  panel.querySelector('[data-action="regenerate"]')?.addEventListener("click", () => runAction(async () => {
    const snapshot = activeRecipeSnapshot(asset);
    const blocked = (snapshot?.references || []).filter((reference) => referenceRightsTone(reference) === "restricted");
    if (blocked.length && !window.confirm(t("regenerateRestrictedConfirm", { count: blocked.length }))) return;
    await navigator.clipboard.writeText(regenerationInstruction(asset, snapshot));
    showToast(t("instructionCopied"), "success");
  }));
  panel.querySelector('[data-action="archive-asset"]')?.addEventListener("click", () => runAction(async () => {
    if (!window.confirm(t("confirmBatchArchive", { count: 1 }))) return;
    await api(`/api/assets/${encodeURIComponent(asset.project_id)}/${encodeURIComponent(asset.id)}/archive`, { method: "POST" });
    showToast(t("archived"), "success");
    setDetailOpen(false);
    state.selectedId = null;
    await loadStats();
    await loadAssets();
  }));
  panel.querySelectorAll('[data-edit="rating"] button').forEach((button) => button.addEventListener("click", () => { state.detailDirty = true; const value = Number(button.dataset.val); panel.querySelectorAll('[data-edit="rating"] button').forEach((star) => { const on = Number(star.dataset.val) <= value; star.classList.toggle("on", on); star.textContent = on ? "★" : "☆"; }); }));
  panel.querySelector('[data-action="save-recipe"]')?.addEventListener("click", () => runAction(async () => {
    const originProjectId = asset.project_id;
    const originAssetId = asset.id;
    setRecipeActionsBusy(panel, true, "save-recipe");
    try {
      const changeSummary = panel.querySelector("[data-version-change]")?.value.trim() || "Recipe updated in MOSA";
      const result = await api(`/api/assets/${encodeURIComponent(originProjectId)}/${encodeURIComponent(originAssetId)}`, {
        method: "PATCH",
        body: { ...readRecipeDraft(panel), recipe_change_summary: changeSummary },
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
      if (renderId === detailRenderSequence) setRecipeActionsBusy(panel, false, "save-recipe");
    }
  }));
  panel.querySelector('[data-action="save-version"]')?.addEventListener("click", () => runAction(async () => {
    const versionChange = panel.querySelector("[data-version-change]")?.value.trim() || "";
    if (!versionChange) throw new Error(t("versionChangeRequired"));
    const originProjectId = asset.project_id;
    const originAssetId = asset.id;
    setRecipeActionsBusy(panel, true, "save-version");
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
      if (renderId === detailRenderSequence) setRecipeActionsBusy(panel, false, "save-version");
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
    switchDetailTab("recipe");
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
  return `<ol class="reference-list">${rows}</ol><div class="recipe-save-actions"><button class="recipe-save-btn primary" type="button" data-action="save-reference-rights">${t("saveRights")}</button></div>`;
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

function bindDetailTabEvents() {
  const panel = els.detailPanel;
  if (!panel) return;
  const tabBar = panel.querySelector("[role='tablist']");
  const tabs = [...(tabBar?.querySelectorAll("[role='tab']") || [])];
  if (!tabs.length) return;
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => switchDetailTab(tab.dataset.detailTab));
    tab.addEventListener("keydown", (event) => {
      const index = tabs.indexOf(tab);
      let targetIndex = -1;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); targetIndex = (index + 1) % tabs.length; }
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); targetIndex = (index - 1 + tabs.length) % tabs.length; }
      else if (event.key === "Home") { event.preventDefault(); targetIndex = 0; }
      else if (event.key === "End") { event.preventDefault(); targetIndex = tabs.length - 1; }
      if (targetIndex >= 0) { switchDetailTab(tabs[targetIndex].dataset.detailTab); tabs[targetIndex].focus(); }
    });
  });
}

function switchDetailTab(tabId) {
  if (!tabId || tabId === state.detailTab) return;
  state.detailTab = tabId;
  const panel = els.detailPanel;
  if (!panel) return;
  panel.querySelectorAll("[role='tab']").forEach((tab) => {
    const isActive = tab.dataset.detailTab === tabId;
    tab.setAttribute("aria-selected", String(isActive));
    tab.tabIndex = isActive ? 0 : -1;
  });
  panel.querySelectorAll("[role='tabpanel']").forEach((tabPanel) => {
    const match = tabPanel.id === `detailPanel${tabId.charAt(0).toUpperCase()}${tabId.slice(1)}`;
    tabPanel.hidden = !match;
  });
  const activePanel = panel.querySelector(`[role='tabpanel']:not([hidden])`);
  activePanel?.querySelector("h3, h4, button, [tabindex]")?.focus();
}

function setRecipeActionsBusy(panel, busy, activeAction) {
  panel.querySelectorAll(".recipe-save-btn").forEach((button) => { button.disabled = busy; });
  panel.querySelectorAll('input[data-edit], textarea[data-edit], select[data-edit], [data-version-change], [data-edit="rating"] button').forEach((field) => { field.disabled = busy; });
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
  button.disabled = !state.cowartInsertAvailable;
  button.title = state.cowartInsertAvailable ? t("insertCowart") : t("cowartInsertUnavailable");
  if (target) target.disabled = !state.cowartInsertAvailable;
}

function formatDate(value) { if (!value) return ""; try { return new Intl.DateTimeFormat(state.locale === "zh" ? "zh-CN" : "en", { year: "numeric", month: "short", day: "numeric" }).format(new Date(value)); } catch { return String(value).slice(0, 10); } }
function formatDateTime(value) { if (!value) return ""; try { return new Intl.DateTimeFormat(state.locale === "zh" ? "zh-CN" : "en", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); } catch { return String(value); } }
function setStatus(value, stateName = "neutral") {
  if (els.statusText) els.statusText.textContent = value;
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
