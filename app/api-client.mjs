// API client + data loading（提取自 app.js，REFACTORING-PLAN R1 批次 3，附录 A #14）：
// apiFetch 与全部数据加载函数移入本模块；state、els 与渲染回调经 createApiClient 工厂注入。
// 请求语义/游标/顺序守卫与原先完全一致；请求序号等模块级状态随闭包迁移。
import { FACET_KEYS } from "./config.mjs";

export function createApiClient(deps) {
  const {
    state,
    els,
    renderSettingsMenu,
    renderDetail,
    updateCodexHint,
    renderQuickFilters,
    renderFilterPanel,
    renderGrid,
    updateViewTitle,
    renderErrorState,
    updateAssetViewNav,
    selectedAsset,
    isDetailEditorActive,
  } = deps;

  async function apiFetch(path, options = {}) {
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
    const result = await apiFetch("/api/projects");
    state.projects = result.projects || [];
    renderSettingsMenu();
  }

  async function loadCowartCanvases() {
    const result = await apiFetch("/api/cowart-canvases");
    state.cowartCanvases = result.canvases || [];
    renderSettingsMenu();
    if (state.detailOpen) renderDetail();
  }

  let statsRequestSequence = 0;
  async function loadStats(options = {}) {
    const requestId = ++statsRequestSequence;
    const project = state.project;
    const [library, result] = await Promise.all([
      apiFetch(`/api/library-path?project=${encodeURIComponent(project)}`).catch(() => null),
      apiFetch(`/api/groups?project=${encodeURIComponent(project)}`)
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
    return apiFetch(`/api/assets?${buildAssetPageParams(request, options)}`);
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

  return {
    apiFetch, loadProjects, loadCowartCanvases, loadStats, loadAssets, refreshLibraryInBackground,
    buildAssetPageParams, requestAssetPage, currentAssetRequest, assetRequestKey, assetListVersion, assetVersion,
  };
}
