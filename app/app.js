const translations = {
  zh: {
    appTitle: "MOSA — 创作资产库", brandSubtitle: "创作资产库", library: "素材库", allAssets: "全部素材", favorites: "收藏", recent: "最近", refine: "筛选", findAssets: "查找素材", clearFilters: "清除筛选", source: "来源", groups: "分组", addGroup: "添加分组", createGroup: "添加分组", groupName: "分组名称", groupNamePlaceholder: "例如：灵感参考", closeGroup: "关闭添加分组窗口", groupCreated: "分组已创建：", groupNameRequired: "请输入分组名称", groupExists: "分组已存在：", categories: "分类", styles: "风格", settings: "设置", language: "语言", systemLanguage: "跟随系统", chinese: "中文", english: "英文", project: "项目", openLibrary: "打开素材库", importAsset: "导入素材", importEyebrow: "素材库", importTitle: "导入素材", closeImport: "关闭导入窗口", closePreview: "关闭大图预览", viewFullImage: "查看大图", imagePath: "图片路径", imagePathPlaceholder: "图片的本地绝对路径", prompt: "提示词", promptPlaceholder: "完整提示词", skill: "技能", style: "风格", ratio: "比例", theme: "主题", group: "分组", category: "分类", businessFields: "业务字段 JSON", none: "—", categoryProduct: "产品", categoryConcept: "概念", categoryTexture: "纹理", categoryReference: "参考", categoryOther: "其他", cancel: "取消", saveAsset: "保存素材", assetList: "素材列表", assetInspector: "素材检视器", noAssets: "还没有素材", noAssetsHint: "导入第一张图片，开始建立可复用的创作资产库。", noSelection: "选择一张素材", noSelectionHint: "在画廊中选择图片即可查看提示词与配方。", close: "关闭", copyPrompt: "复制提示词", copyPath: "复制路径", regenerate: "同配方再生成", insertCowart: "插入 Cowart", insertingCowart: "正在插入 Cowart…", insertedCowart: "已插入 Cowart：{page}（{x}, {y}）", cowartInsertUnavailable: "Cowart 插件不可用", recipe: "配方", sourceInfo: "来源信息", editMetadata: "编辑元数据", saveRecipe: "保存配方", imageLocation: "图片路径", notRecorded: "未记录", noDetails: "暂无附加信息", sourceCodex: "Codex", sourceCowart: "Cowart", sourceManual: "手动导入", sourceLabel: "来源", taskId: "任务 ID", model: "模型", generationTool: "生成工具", originalPath: "原始路径", canvasObject: "画布对象", pageAsset: "页面素材", canvasNote: "画布说明", canvasEdited: "批注编辑结果", canvasImage: "画布图片", rating: "评分", copyOriginalPath: "复制原始路径", saved: "已保存", saving: "正在保存…", copySuccess: "提示词已复制", pathCopied: "图片路径已复制", originalPathCopied: "原始路径已复制", instructionCopied: "再生成指令已复制", openInFinder: "已在 Finder 中打开", failedToOpen: "无法打开：", imagePathRequired: "请填写图片路径", invalidJson: "业务字段 JSON 格式错误", savedAsset: "素材已保存", recipeSaved: "配方已保存", groupSaved: "已移至分组：", groupFailed: "设置分组失败：", statusChecking: "检查桥接状态…", statusReady: "桥接已就绪", statusBridgeOff: "桥接未启用", statusBridgeError: "桥接出现错误", statusBridgePartial: "部分桥接已启用", statusCowartInsertUnavailable: "插入 Cowart 不可用", statusImportedCount: "已归档 {count} 项", statusUnavailable: "MOSA 服务不可用", retry: "重试", assetsCount: "{count} 项", filterAll: "全部", filterCodex: "Codex", filterCowart: "Cowart", noGroups: "暂无分组", noCategories: "暂无分类", noStyles: "暂无风格", languageChanged: "语言已更新", searchPlaceholder: "搜索素材、提示词或风格", generatedInstruction: "请用相同配方再生成一张图片，并保存到 MOSA："
  },
  en: {
    appTitle: "MOSA — Creative Asset Library", brandSubtitle: "Creative asset library", library: "Library", allAssets: "All assets", favorites: "Favorites", recent: "Recent", refine: "Filter", findAssets: "Find assets", clearFilters: "Clear filters", source: "Source", groups: "Collections", addGroup: "Add collection", createGroup: "Add collection", groupName: "Collection name", groupNamePlaceholder: "e.g. Inspiration", closeGroup: "Close add collection dialog", groupCreated: "Collection created: ", groupNameRequired: "Enter a collection name", groupExists: "Collection already exists: ", categories: "Categories", styles: "Styles", settings: "Settings", language: "Language", systemLanguage: "Use system language", chinese: "Chinese", english: "English", project: "Project", openLibrary: "Open library folder", importAsset: "Import asset", importEyebrow: "LIBRARY", importTitle: "Import asset", closeImport: "Close import", closePreview: "Close full-image preview", viewFullImage: "View full image", imagePath: "Absolute path to the local image", prompt: "Prompt", promptPlaceholder: "Full prompt", skill: "Skill", style: "Style", ratio: "Ratio", theme: "Theme", group: "Collection", category: "Category", businessFields: "Business fields JSON", none: "—", categoryProduct: "Product", categoryConcept: "Concept", categoryTexture: "Texture", categoryReference: "Reference", categoryOther: "Other", cancel: "Cancel", saveAsset: "Save asset", assetList: "Asset list", assetInspector: "Asset inspector", noAssets: "No assets yet", noAssetsHint: "Import your first image to start a reusable creative library.", noSelection: "Select an asset", noSelectionHint: "Choose an image in the gallery to view its prompt and recipe.", close: "Close", copyPrompt: "Copy prompt", copyPath: "Copy path", regenerate: "Regenerate", insertCowart: "Insert into Cowart", insertingCowart: "Inserting into Cowart…", insertedCowart: "Inserted into Cowart: {page} ({x}, {y})", cowartInsertUnavailable: "Cowart plugin unavailable", recipe: "Recipe", sourceInfo: "Source", editMetadata: "Edit metadata", saveRecipe: "Save recipe", imageLocation: "Image path", notRecorded: "Not recorded", noDetails: "No additional details", sourceCodex: "Codex", sourceCowart: "Cowart", sourceManual: "Manual import", sourceLabel: "Source", taskId: "Task ID", model: "Model", generationTool: "Generation tool", originalPath: "Original path", canvasObject: "Canvas object", pageAsset: "Page asset", canvasNote: "Canvas note", canvasEdited: "Annotated edit", canvasImage: "Canvas image", rating: "Rating", copyOriginalPath: "Copy original path", saved: "Saved", saving: "Saving…", copySuccess: "Prompt copied", pathCopied: "Image path copied", originalPathCopied: "Original path copied", instructionCopied: "Regeneration instruction copied", openInFinder: "Opened in Finder", failedToOpen: "Unable to open: ", imagePathRequired: "Enter an image path", invalidJson: "Business fields JSON is invalid", savedAsset: "Asset saved", recipeSaved: "Recipe saved", groupSaved: "Moved to collection: ", groupFailed: "Unable to update collection: ", statusChecking: "Checking bridges…", statusReady: "Bridges ready", statusBridgeOff: "Bridges off", statusBridgeError: "Bridge error", statusBridgePartial: "Some bridges enabled", statusCowartInsertUnavailable: "Cowart insert unavailable", statusImportedCount: "Archived {count} items", statusUnavailable: "MOSA service unavailable", retry: "Retry", assetsCount: "{count} assets", filterAll: "All", filterCodex: "Codex", filterCowart: "Cowart", noGroups: "No collections", noCategories: "No categories", noStyles: "No styles", languageChanged: "Language updated", searchPlaceholder: "Search assets, prompts, or styles", generatedInstruction: "Regenerate this image with the same recipe and save it to MOSA:"
  }
};

Object.assign(translations.zh, {
  cowartCanvases: "自动发现的 Cowart 画布",
  cowartInsertTarget: "回插画布",
  mosaCanvas: "MOSA 专用画布",
  projectCanvas: "项目画布 · {name}",
  statusWatchingOneCanvas: "监控 1 个画布",
  statusWatchingCanvasCount: "监控 {count} 个画布",
  loadMore: "加载更多",
});

Object.assign(translations.en, {
  cowartCanvases: "Detected Cowart canvases",
  cowartInsertTarget: "Insert canvas",
  mosaCanvas: "MOSA dedicated canvas",
  projectCanvas: "Project canvas · {name}",
  statusWatchingOneCanvas: "1 canvas",
  statusWatchingCanvasCount: "{count} canvases",
  loadMore: "Load more",
});

Object.assign(translations.zh, {
  versionHistory: "版本历史",
  versionLoading: "正在加载版本…",
  versionLoadFailed: "无法加载版本历史",
  versionLabel: "版本 {number}",
  currentVersion: "当前版本",
  initialVersion: "初始版本",
  versionChange: "变更说明",
  versionChangePlaceholder: "说明这个版本相对当前版本有哪些变化",
  noVersionChange: "未记录变更说明",
  saveAsVersion: "另存为新版本",
  savingVersion: "正在保存版本…",
  versionSaved: "新版本已保存",
  versionChangeRequired: "请填写变更说明",
  discardVersionChanges: "有尚未保存的修改，仍要切换版本吗？",
  archivedVersion: "已归档",
  generatedInstruction: "请用相同配方再生成一张图片，并通过 MOSA 的 asset_version_create 保存为当前素材的新版本：",
});

Object.assign(translations.en, {
  versionHistory: "Version history",
  versionLoading: "Loading versions…",
  versionLoadFailed: "Unable to load version history",
  versionLabel: "Version {number}",
  currentVersion: "Current version",
  initialVersion: "Initial version",
  versionChange: "Change summary",
  versionChangePlaceholder: "Describe what changed from the current version",
  noVersionChange: "No change summary",
  saveAsVersion: "Save as new version",
  savingVersion: "Saving version…",
  versionSaved: "New version saved",
  versionChangeRequired: "Enter a change summary",
  discardVersionChanges: "You have unsaved changes. Switch versions anyway?",
  archivedVersion: "Archived",
  generatedInstruction: "Regenerate this image with the same recipe, then use MOSA's asset_version_create tool to save it as a new version of the current asset:",
});

const preference = safeStorageGet("mosa.ui-language") || "system";
const state = {
  project: "default", projects: [], cowartCanvases: [], assets: [], pageTotal: 0, nextCursor: null, loadedPageCount: 0, selectedId: null, detailAsset: null, versionHistory: null, detailOpen: false, detailDirty: false, imagePreviewId: null, previewReturnFocus: null, query: "",
  filter: { type: "all", value: "" }, groups: { total: 0, favorites: 0, recent: 0, codex: 0, cowart: 0, groups: [], categories: [], styles: [] }, cowartInsertAvailable: false, cowartInsertTargetId: safeStorageGet("mosa.cowart-insert-target") || "mosa",
  libraryPath: "", codexImagesDir: "", modalReturnFocus: null, languagePreference: preference, locale: resolveLocale(preference)
};

const els = {
  searchInput: document.querySelector("#searchInput"), quickFilters: document.querySelector("#quickFilters"),
  filterToggle: document.querySelector("#filterToggle"), filterPanel: document.querySelector("#filterPanel"), filterDot: document.querySelector("#filterDot"), clearFiltersBtn: document.querySelector("#clearFiltersBtn"), sourceFilters: document.querySelector("#sourceFilters"), groupList: document.querySelector("#groupList"), categoryList: document.querySelector("#categoryList"), styleList: document.querySelector("#styleList"),
  settingsToggle: document.querySelector("#settingsToggle"), settingsMenu: document.querySelector("#settingsMenu"), addGroupBtn: document.querySelector("#addGroupBtn"), sidebarGroupList: document.querySelector("#sidebarGroupList"), newAssetTopBtn: document.querySelector("#newAssetTopBtn"), importModal: document.querySelector("#importModal"), closeImportModal: document.querySelector("#closeImportModal"), cancelImportBtn: document.querySelector("#cancelImportBtn"), groupModal: document.querySelector("#groupModal"), closeGroupModal: document.querySelector("#closeGroupModal"), cancelGroupBtn: document.querySelector("#cancelGroupBtn"), saveGroupBtn: document.querySelector("#saveGroupBtn"), groupNameInput: document.querySelector("#groupNameInput"), imagePreviewModal: document.querySelector("#imagePreviewModal"), imagePreviewStage: document.querySelector("#imagePreviewStage"), imagePreviewImage: document.querySelector("#imagePreviewImage"), imagePreviewTitle: document.querySelector("#imagePreviewTitle"), closeImagePreview: document.querySelector("#closeImagePreview"), imagePathInput: document.querySelector("#imagePathInput"), codexSourceHint: document.querySelector("#codexSourceHint"), promptInput: document.querySelector("#promptInput"), skillInput: document.querySelector("#skillInput"), styleInput: document.querySelector("#styleInput"), ratioInput: document.querySelector("#ratioInput"), themeInput: document.querySelector("#themeInput"), groupInput: document.querySelector("#groupInput"), categoryInput: document.querySelector("#categoryInput"), businessInput: document.querySelector("#businessInput"), saveAssetBtn: document.querySelector("#saveAssetBtn"),
  viewTitle: document.querySelector("#viewTitle"), assetCount: document.querySelector("#assetCount"), statusText: document.querySelector("#statusText"), bridgeStatus: document.querySelector("#bridgeStatus"), bridgeStatusLabel: document.querySelector("#bridgeStatusLabel"), bridgeStatusMeta: document.querySelector("#bridgeStatusMeta"), appShell: document.querySelector("#appShell"), assetGrid: document.querySelector("#assetGrid"), detailPanel: document.querySelector("#detailPanel"), toastContainer: document.querySelector("#toastContainer")
};

init();

async function init() {
  applyLanguage();
  bindEvents();
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

function bindKeyboardNav() {
  document.addEventListener("keydown", (event) => {
    if (els.importModal?.classList.contains("open") || event.target.matches("input, textarea, select")) return;
    if (!state.assets.length) return;
    const index = state.assets.findIndex((asset) => asset.id === state.selectedId);
    if (index < 0) return;
    if (event.key === "ArrowUp" && index > 0) selectAsset(state.assets[index - 1].id, true);
    if (event.key === "ArrowDown" && index < state.assets.length - 1) selectAsset(state.assets[index + 1].id, true);
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
  if (!response.ok) throw new Error(payload.error || response.statusText);
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
  updateCodexHint();
  const nextGroups = { total: 0, favorites: 0, recent: 0, codex: 0, cowart: 0, groups: [], categories: [], styles: [], ...(result.groups || {}) };
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
  if (options.append && state.nextCursor) params.set("cursor", state.nextCursor);
  if (request.filterType === "favorite") params.set("favorite", "1");
  else if (request.filterType === "recent") params.set("recent", "1");
  else if (request.filterType === "codex") params.set("source", "codex-generated");
  else if (request.filterType === "cowart") params.set("source", "cowart-generated");
  else if (["group", "category", "style"].includes(request.filterType)) params.set(request.filterType, request.filterValue);
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
  return { project: state.project, query: state.query, filterType: state.filter.type, filterValue: state.filter.value };
}

function assetRequestKey(request) {
  return JSON.stringify([request.project, request.query, request.filterType, request.filterValue]);
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
    const { codex, cowart, cowartInsert } = await api("/api/bridges");
    const nextCanvases = Array.isArray(cowart?.sources) ? cowart.sources : [];
    if (cowartCanvasListSignature(nextCanvases) !== cowartCanvasListSignature(state.cowartCanvases)) {
      state.cowartCanvases = nextCanvases;
      renderSettingsMenu();
      if (state.detailOpen && !isDetailEditorActive()) renderDetail();
    }
    state.cowartInsertAvailable = Boolean(cowartInsert?.available);
    const hasError = codex?.lastError || cowart?.lastError;
    const codexOn = Boolean(codex?.enabled);
    const cowartOn = Boolean(cowart?.enabled);
    const importedCount = Number(cowart?.totalImported || 0) + Number(codex?.totalImported || 0);
    const monitoredCount = Number(cowart?.monitoredCount || 0);
    if (hasError) setStatus(t("statusBridgeError"), "error");
    else if (codexOn && cowartOn && state.cowartInsertAvailable) setStatus(t("statusReady"), "ok");
    else if (codexOn || cowartOn) setStatus(state.cowartInsertAvailable ? t("statusBridgePartial") : t("statusCowartInsertUnavailable"), "warn");
    else setStatus(t("statusBridgeOff"), "warn");
    if (els.bridgeStatusMeta) {
      const meta = [];
      if (monitoredCount > 0) {
        meta.push(monitoredCount === 1
          ? t("statusWatchingOneCanvas")
          : t("statusWatchingCanvasCount", { count: monitoredCount }));
      }
      if (importedCount > 0) meta.push(t("statusImportedCount", { count: importedCount }));
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

function updateCodexHint() {
  if (!els.codexSourceHint) return;
  if (state.codexImagesDir) {
    els.imagePathInput.placeholder = `${state.codexImagesDir}/<task-id>/<image>.png`;
    els.codexSourceHint.textContent = `${t("sourceCodex")} · ${state.codexImagesDir}`;
  } else els.codexSourceHint.textContent = "";
}

function updateViewTitle() {
  const titles = { all: t("allAssets"), favorite: t("favorites"), recent: t("recent"), codex: t("filterCodex"), cowart: t("filterCowart") };
  els.viewTitle.textContent = titles[state.filter.type] || state.filter.value || t("allAssets");
  els.assetCount.textContent = t("assetsCount", { count: state.pageTotal || state.assets.length });
  const filtered = state.filter.type !== "all" || Boolean(state.query);
  els.filterDot.hidden = !filtered;
}

function bindEvents() {
  els.searchInput?.addEventListener("input", debounce(async () => { state.query = els.searchInput.value; await loadAssets(); }, 180));
  els.assetGrid?.addEventListener("click", (event) => {
    if (event.target.closest('[data-action="retry"]')) window.location.reload();
    if (event.target.closest('[data-action="load-more"]')) void loadAssets({ append: true });
  });
  els.addGroupBtn?.addEventListener("click", openGroupModal);
  els.newAssetTopBtn?.addEventListener("click", openImportModal);
  els.quickFilters?.addEventListener("click", (event) => { const button = event.target.closest("[data-filter]"); if (button) setFilter(button.dataset.filter); });
  els.sidebarGroupList?.addEventListener("click", (event) => { const button = event.target.closest("[data-filter]"); if (button) setFilter(button.dataset.filter, button.dataset.value); });
  els.filterToggle?.addEventListener("click", () => togglePanel(els.filterPanel, els.filterToggle));
  els.clearFiltersBtn?.addEventListener("click", () => { state.query = ""; els.searchInput.value = ""; setFilter("all"); });
  els.sourceFilters?.addEventListener("click", (event) => { const button = event.target.closest("[data-filter]"); if (button) setFilter(button.dataset.filter); });
  [els.groupList, els.categoryList, els.styleList].forEach((list) => list?.addEventListener("click", (event) => { const button = event.target.closest("[data-filter]"); if (button) setFilter(button.dataset.filter, button.dataset.value); }));
  els.settingsToggle?.addEventListener("click", () => togglePanel(els.settingsMenu, els.settingsToggle));
  els.settingsMenu?.addEventListener("change", async (event) => {
    const select = event.target.closest("[data-project-select]");
    if (!select) return;
    state.project = select.value; clearDetailSelection(); state.filter = { type: "all", value: "" }; state.query = ""; els.searchInput.value = "";
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
}

function setLanguage(value) {
  state.languagePreference = value;
  safeStorageSet("mosa.ui-language", value);
  applyLanguage();
  refreshBridgeStatus();
  showToast(t("languageChanged"), "success");
}

function setFilter(type, value = "") {
  state.filter = { type, value };
  clearDetailSelection();
  renderQuickFilters(); renderFilterPanel(); loadAssets();
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

async function saveAsset() {
  await runAction(async () => {
    if (!els.imagePathInput.value.trim()) throw new Error(t("imagePathRequired"));
    let businessFields = {};
    if (els.businessInput.value.trim()) { try { businessFields = JSON.parse(els.businessInput.value); } catch { throw new Error(t("invalidJson")); } }
    showToast(t("saving"));
    const result = await api("/api/assets/create", { method: "POST", body: { projectId: state.project, imagePath: els.imagePathInput.value, prompt: els.promptInput.value, skill: els.skillInput.value, style: els.styleInput.value, ratio: els.ratioInput.value, theme: els.themeInput.value, group: els.groupInput.value, category: els.categoryInput.value, business_fields: businessFields } });
    state.selectedId = result.asset.id;
    clearImportForm(); closeImportModal(); showToast(`${t("savedAsset")} · ${result.asset.id}`, "success");
    await loadStats(); await loadAssets();
  });
}

function clearImportForm() { [els.imagePathInput, els.promptInput, els.skillInput, els.styleInput, els.ratioInput, els.themeInput, els.groupInput, els.businessInput].forEach((input) => { input.value = ""; }); els.categoryInput.value = ""; }

function renderQuickFilters() {
  if (!els.quickFilters) return;
  const counts = { all: state.groups.total, favorite: state.groups.favorites, recent: state.groups.recent };
  els.quickFilters.querySelectorAll("[data-filter]").forEach((button) => { const active = button.dataset.filter === state.filter.type; button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active)); button.querySelector(".nav-count").textContent = counts[button.dataset.filter] ?? "—"; });
  renderSidebarGroups();
}

function renderSidebarGroups() {
  if (!els.sidebarGroupList) return;
  els.sidebarGroupList.innerHTML = state.groups.groups.map(([name, count]) => `<li><button class="nav-item nav-group-item${state.filter.type === "group" && state.filter.value === name ? " active" : ""}" data-filter="group" data-value="${escapeHtml(name)}" type="button" aria-pressed="${state.filter.type === "group" && state.filter.value === name}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-10Z"/></svg><span class="nav-item-text" title="${escapeHtml(name)}">${escapeHtml(name)}</span><span class="nav-count">${count}</span></button></li>`).join("");
}

function renderFilterPanel() {
  if (!els.sourceFilters) return;
  const sources = [["all", t("filterAll"), state.groups.total], ["codex", t("filterCodex"), state.groups.codex], ["cowart", t("filterCowart"), state.groups.cowart]];
  els.sourceFilters.innerHTML = sources.map(([type, label, count]) => `<button class="filter-pill${state.filter.type === type ? " active" : ""}" data-filter="${type}" type="button" aria-pressed="${state.filter.type === type}">${escapeHtml(label)} <span>${count}</span></button>`).join("");
  renderFilterList(els.groupList, state.groups.groups, "group", t("noGroups"));
  renderFilterList(els.categoryList, state.groups.categories, "category", t("noCategories"));
  renderFilterList(els.styleList, state.groups.styles, "style", t("noStyles"));
}

function renderFilterList(element, values, type, emptyText) {
  if (!element) return;
  if (!values.length) { element.innerHTML = `<li class="filter-empty">${escapeHtml(emptyText)}</li>`; return; }
  element.innerHTML = values.map(([name, count]) => `<li><button class="filter-list-item${state.filter.type === type && state.filter.value === name ? " active" : ""}" data-filter="${type}" data-value="${escapeHtml(name)}" type="button" aria-pressed="${state.filter.type === type && state.filter.value === name}"><span>${escapeHtml(name)}</span><span>${count}</span></button></li>`).join("");
}

let masonryResizeObserver = null;
function layoutMasonry() { els.assetGrid?.querySelectorAll(".asset-card").forEach((card) => { const height = card.getBoundingClientRect().height || 0; if (height) card.style.gridRowEnd = `span ${Math.ceil(height + 8)}`; }); }
function setupMasonryLayout() {
  const grid = els.assetGrid; if (!grid) return;
  const schedule = () => requestAnimationFrame(layoutMasonry);
  grid.querySelectorAll(".thumb").forEach((image) => image.addEventListener("load", schedule, { once: true })); schedule();
  masonryResizeObserver?.disconnect();
  if ("ResizeObserver" in window) { masonryResizeObserver = new ResizeObserver(schedule); masonryResizeObserver.observe(grid); }
}

function renderGrid() {
  if (!els.assetGrid) return;
  if (!state.assets.length) {
    els.assetGrid.innerHTML = `<div class="empty-state"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg><p>${t("noAssets")}</p><span>${t("noAssetsHint")}</span></div>`;
    return;
  }
  const cards = state.assets.map((asset) => {
    const title = asset.theme || asset.asset || asset.id; const selected = asset.id === state.selectedId;
    return `<article class="asset-card${selected ? " selected" : ""}" data-id="${escapeHtml(asset.id)}"><button class="asset-card-select" type="button" aria-pressed="${selected}" aria-label="${escapeHtml(title)}"><img class="thumb" src="${asset.thumbnail_url || asset.image_url}" alt="${escapeHtml(title)}" loading="lazy" /></button><button class="card-quick-copy" type="button" data-copy="${escapeHtml(asset.prompt || "")}" data-i18n-title="copyPrompt" title="${t("copyPrompt")}" aria-label="${t("copyPrompt")}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9"/></svg></button></article>`;
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
}

function renderErrorState(error) {
  if (!els.assetGrid) return;
  const message = error instanceof Error ? error.message : String(error || "");
  els.assetGrid.innerHTML = `<div class="error-state"><p>${t("statusUnavailable")}</p><span>${escapeHtml(message)}</span><button type="button" data-action="retry">${t("retry")}</button></div>`;
}

function selectAsset(id, shouldScroll = false) {
  if (!id || !confirmDetailNavigation(id)) return;
  state.selectedId = id; state.detailAsset = null; state.versionHistory = null; setDetailOpen(true); updateSelectedCard();
  if (shouldScroll) els.assetGrid.querySelector(`.asset-card[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function clearDetailSelection() {
  state.selectedId = null;
  state.detailAsset = null;
  state.versionHistory = null;
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
  state.detailOpen = Boolean(open); els.appShell?.classList.toggle("details-open", state.detailOpen); els.detailPanel?.setAttribute("aria-hidden", String(!state.detailOpen));
  if (state.detailOpen) renderDetail();
  else state.detailDirty = false;
}

function openImportModal() { state.modalReturnFocus = document.activeElement; els.importModal?.classList.add("open"); els.importModal?.setAttribute("aria-hidden", "false"); requestAnimationFrame(() => els.imagePathInput?.focus()); }
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
    state.filter = { type: "group", value: result.group.name };
    clearDetailSelection();
    renderQuickFilters(); renderFilterPanel(); await loadAssets();
  });
}

function openImagePreview(id, trigger) {
  const asset = state.assets.find((item) => item.id === id)
    || state.versionHistory?.versions?.find((item) => item.id === id)
    || (state.detailAsset?.id === id ? state.detailAsset : null);
  if (!asset || !els.imagePreviewModal || !els.imagePreviewImage || !els.imagePreviewTitle) return;
  state.imagePreviewId = asset.id;
  state.previewReturnFocus = trigger instanceof HTMLElement ? trigger : document.activeElement;
  els.imagePreviewImage.style.removeProperty("width");
  els.imagePreviewImage.style.removeProperty("height");
  els.imagePreviewImage.src = asset.image_url;
  els.imagePreviewImage.alt = asset.theme || asset.asset || asset.id;
  els.imagePreviewTitle.textContent = asset.theme || asset.asset || asset.id;
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
  state.detailDirty = false;
  if (!asset) { els.detailPanel.innerHTML = `<div class="detail-empty"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg><p>${t(state.assets.length ? "noSelection" : "noAssets")}</p><span>${t(state.assets.length ? "noSelectionHint" : "noAssetsHint")}</span></div>`; return; }
  const source = asset.source || {}; const rating = Math.min(5, Math.max(0, Math.round(asset.rating || 0))); const groupOptions = state.groups.groups.map(([name]) => `<option value="${escapeHtml(name)}"></option>`).join("");
  const metadata = [["skill", asset.skill], ["style", asset.style], ["ratio", asset.ratio], ["theme", asset.theme], ["group", asset.group], ["category", asset.category], ["rating", asset.rating ? `${asset.rating}/5` : ""]].filter(([, value]) => value !== undefined && value !== null && value !== "");
  const sourceRows = buildSourceRows(source).filter(([, value]) => value !== undefined && value !== null && value !== "");
  const cachedHistory = versionHistoryForAsset(asset);
  els.detailPanel.innerHTML = `<div class="detail-studio-bar"><span>${t("assetInspector")}</span><button class="detail-close" type="button" data-action="close-detail">${t("close")}</button></div><div class="detail-image-wrap"><img class="detail-image" src="${asset.preview_url || asset.image_url}" alt="${escapeHtml(asset.theme || asset.id)}" title="${t("viewFullImage")}" /></div><div class="detail-head"><h3 id="detailTitle" tabindex="-1">${escapeHtml(asset.theme || asset.asset || asset.id)}</h3><p>${escapeHtml(asset.id)} · ${formatDate(asset.created_at)}</p></div><div class="detail-actions"><button class="action-btn primary" type="button" data-action="copy-prompt">${t("copyPrompt")}</button><button class="action-btn secondary" type="button" data-action="regenerate">${t("regenerate")}</button><button class="action-btn secondary" type="button" data-action="copy-path">${t("copyPath")}</button></div><section class="section"><div class="section-head"><h4>${t("prompt")}</h4></div><div class="prompt-box">${asset.prompt ? escapeHtml(asset.prompt) : `<span class="empty-copy">${t("notRecorded")}</span>`}</div></section><section class="section"><div class="section-head"><h4>${t("recipe")}</h4></div>${metadata.length ? `<div class="meta-table">${metadata.map(([key, value]) => `<div class="meta-row"><span class="meta-key">${t(key)}</span><span class="meta-val">${key === "rating" ? `<span class="rating-stars">${"★".repeat(rating)}${"☆".repeat(5 - rating)}</span>` : escapeHtml(value)}</span></div>`).join("")}</div>` : `<p class="empty-copy">${t("noDetails")}</p>`}</section><details class="detail-disclosure" open><summary>${t("versionHistory")}</summary><div class="disclosure-content version-history-region" data-version-history aria-live="polite">${cachedHistory ? versionHistoryMarkup(cachedHistory, asset.id) : `<p class="version-history-status" role="status">${t("versionLoading")}</p>`}</div></details><details class="detail-disclosure"><summary>${t("sourceInfo")}</summary><div class="disclosure-content">${sourceRows.length ? `<div class="meta-table">${sourceRows.map(([key, value]) => `<div class="meta-row"><span class="meta-key">${t(key)}</span><span class="meta-val source-value">${escapeHtml(value)}</span></div>`).join("")}</div>` : `<p class="empty-copy">${t("noDetails")}</p>`}</div></details><details class="detail-disclosure"><summary>${t("editMetadata")}</summary><div class="disclosure-content detail-fields"><label class="field"><span>${t("prompt")}</span><textarea data-edit="prompt" rows="5">${escapeHtml(asset.prompt || "")}</textarea></label><div class="two"><label class="field"><span>${t("skill")}</span><input data-edit="skill" value="${escapeHtml(asset.skill || "")}" /></label><label class="field"><span>${t("style")}</span><input data-edit="style" value="${escapeHtml(asset.style || "")}" /></label></div><div class="two"><label class="field"><span>${t("ratio")}</span><input data-edit="ratio" value="${escapeHtml(asset.ratio || "")}" /></label><label class="field"><span>${t("theme")}</span><input data-edit="theme" value="${escapeHtml(asset.theme || "")}" /></label></div><div class="two"><label class="field"><span>${t("group")}</span><input data-edit="group" value="${escapeHtml(asset.group || "")}" list="groupSuggestionsEdit" /><datalist id="groupSuggestionsEdit">${groupOptions}</datalist></label><label class="field"><span>${t("category")}</span><select data-edit="category"><option value="">${t("none")}</option>${categoryOptions(asset.category)}</select></label></div><label class="field"><span>${t("rating")}</span><div class="rating-edit" data-edit="rating">${[1,2,3,4,5].map((number) => `<button type="button" data-val="${number}" class="${number <= rating ? "on" : ""}" aria-label="${number}/5">${number <= rating ? "★" : "☆"}</button>`).join("")}</div></label><label class="field"><span>${t("businessFields")}</span><textarea data-edit="business_fields" rows="3">${escapeHtml(JSON.stringify(asset.business_fields || {}, null, 2))}</textarea></label><label class="field version-change-field"><span>${t("versionChange")}</span><textarea data-version-change rows="2" placeholder="${escapeHtml(t("versionChangePlaceholder"))}"></textarea></label><div class="recipe-save-actions"><button class="recipe-save-btn secondary" type="button" data-action="save-recipe">${t("saveRecipe")}</button><button class="recipe-save-btn primary" type="button" data-action="save-version">${t("saveAsVersion")}</button></div></div></details><details class="detail-disclosure"><summary>${t("imageLocation")}</summary><div class="disclosure-content"><div class="path-box">${escapeHtml(asset.image_path)}</div></div></details>`;
  els.detailPanel.querySelector(".detail-actions")?.prepend(createCowartInsertControl(asset));
  updateCowartInsertControls();
  bindDetailEvents(asset, renderId);
  bindVersionHistoryEvents(cachedHistory);
  void loadVersionHistory(asset);
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
    return `<li class="version-timeline-item${selected ? " selected" : ""}" style="--version-depth:${depth}"><button type="button" data-version-id="${escapeHtml(version.id)}"${selected ? ' aria-current="true"' : ""}><span class="version-marker" aria-hidden="true"></span><span class="version-content"><span class="version-title"><strong>${escapeHtml(t("versionLabel", { number: version.version_index }))}</strong>${selected ? `<span class="version-current">${t("currentVersion")}</span>` : ""}${version.archived ? `<span class="version-archived">${t("archivedVersion")}</span>` : ""}</span><span class="version-change">${escapeHtml(change)}</span><time datetime="${escapeHtml(version.created_at || "")}">${escapeHtml(formatDate(version.created_at))}</time></span></button></li>`;
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
    updateSelectedCard();
    renderDetail();
    requestAnimationFrame(() => els.detailPanel?.querySelector("#detailTitle")?.focus());
  }));
}

function categoryOptions(selected) { return ["product", "concept", "texture", "reference", "other"].map((value) => `<option value="${value}"${selected === value ? " selected" : ""}>${t(`category${value[0].toUpperCase()}${value.slice(1)}`)}</option>`).join(""); }
function buildSourceRows(source) {
  if (source.type === "codex-generated") return [["sourceLabel", sourceName(source)], ["taskId", source.codex_task_id], ["model", source.model], ["generationTool", source.generation_tool], ["originalPath", source.path]];
  if (source.type === "cowart-generated") return [["sourceLabel", sourceName(source)], ["canvasObject", source.cowart_shape_id], ["pageAsset", source.cowart_asset_id], ["canvasNote", source.cowart_annotation_source_shape_id ? t("canvasEdited") : t("canvasImage")], ["originalPath", source.path]];
  return [["sourceLabel", sourceName(source)], ["originalPath", source.path], ["taskId", source.codex_task_id], ["generationTool", source.generation_tool], ["model", source.model]];
}
function sourceName(source = {}) { return source.type === "codex-generated" ? t("sourceCodex") : source.type === "cowart-generated" ? t("sourceCowart") : t("sourceManual"); }

function bindDetailEvents(asset, renderId) {
  const panel = els.detailPanel;
  panel.querySelectorAll("[data-edit], [data-version-change]").forEach((field) => {
    field.addEventListener("input", () => { state.detailDirty = true; });
    field.addEventListener("change", () => { state.detailDirty = true; });
  });
  panel.querySelector('[data-action="close-detail"]')?.addEventListener("click", () => setDetailOpen(false));
  panel.querySelector(".detail-image")?.addEventListener("dblclick", (event) => openImagePreview(asset.id, event.currentTarget));
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
    const instruction = [t("generatedInstruction"), "", "tool: asset_version_create", `projectId: ${asset.project_id}`, `assetId: ${asset.id}`, "imagePath: <path returned by image generation>", "version_change:", `skill: ${asset.skill || ""}`, `style: ${asset.style || ""}`, `ratio: ${asset.ratio || ""}`, `theme: ${asset.theme || ""}`, `group: ${asset.group || ""}`, `category: ${asset.category || ""}`, `business_fields: ${JSON.stringify(asset.business_fields || {})}`, "", asset.prompt || ""].join("\n");
    await navigator.clipboard.writeText(instruction); showToast(t("instructionCopied"), "success");
  }));
  panel.querySelectorAll('[data-edit="rating"] button').forEach((button) => button.addEventListener("click", () => { state.detailDirty = true; const value = Number(button.dataset.val); panel.querySelectorAll('[data-edit="rating"] button').forEach((star) => { const on = Number(star.dataset.val) <= value; star.classList.toggle("on", on); star.textContent = on ? "★" : "☆"; }); }));
  panel.querySelector('[data-action="save-recipe"]')?.addEventListener("click", () => runAction(async () => {
    const originProjectId = asset.project_id;
    const originAssetId = asset.id;
    setRecipeActionsBusy(panel, true, "save-recipe");
    try {
      const result = await api(`/api/assets/${encodeURIComponent(originProjectId)}/${encodeURIComponent(originAssetId)}`, { method: "PATCH", body: readRecipeDraft(panel) });
      showToast(t("recipeSaved"), "success");
      if (!isCurrentDetailAction(renderId, originProjectId, originAssetId)) return;
      state.selectedId = result.asset.id;
      state.detailAsset = result.asset;
      state.versionHistory = null;
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
      state.detailDirty = false;
      await loadStats();
      if (!isCurrentDetailSelection(result.asset.project_id, result.asset.id)) return;
      await loadAssets();
      if (isCurrentDetailSelection(result.asset.project_id, result.asset.id)) requestAnimationFrame(() => els.detailPanel?.querySelector("#detailTitle")?.focus());
    } finally {
      if (renderId === detailRenderSequence) setRecipeActionsBusy(panel, false, "save-version");
    }
  }));
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
function setStatus(value, stateName = "neutral") {
  if (els.statusText) els.statusText.textContent = value;
  if (els.bridgeStatus) els.bridgeStatus.dataset.state = stateName;
  if (els.bridgeStatusLabel) els.bridgeStatusLabel.textContent = value;
}
async function runAction(action) { try { await action(); } catch (error) { showToast(error.message, "error"); } }
function debounce(fn, delay) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); }; }
function escapeHtml(value) { return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }
function safeStorageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function safeStorageSet(key, value) { try { localStorage.setItem(key, value); } catch {} }
