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
    try { payload = raw ? JSON.parse(raw) : {}; }
    catch {
      // 200 + 非法 JSON（反代/网关错误页）不得伪装成空结果——否则画廊会渲染
      // “没有找到匹配的素材”空态而非错误态。HTTP/2 下 statusText 恒为空串，
      // 错误消息退回状态码文本。
      if (!response.ok) throw new Error(response.statusText || `HTTP ${response.status}`);
      throw new Error(`Invalid JSON response (HTTP ${response.status})`);
    }
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
    if (state.detailOpen && !isDetailEditorActive()) renderDetail();
  }

  let statsRequestSequence = 0;
  async function loadStats(options = {}) {
    const requestId = ++statsRequestSequence;
    const project = state.project;
    const [library, result] = await Promise.all([
      options.background
        ? Promise.resolve(null)
        : apiFetch(`/api/library-path?project=${encodeURIComponent(project)}`).catch(() => null),
      apiFetch(`/api/groups?project=${encodeURIComponent(project)}`)
    ]);
    if (requestId !== statsRequestSequence || project !== state.project) return false;

    if (library) {
      state.libraryPath = library.path || "";
      state.codexImagesDir = library.codexGeneratedImagesDir || "";
      state.supportedMediaExtensions = Array.isArray(library.supportedMediaExtensions) ? library.supportedMediaExtensions : [];
      updateCodexHint();
    }
    const nextGroups = { total: 0, favorites: 0, recent: 0, codex: 0, cowart: 0, grok: 0, sourceTypes: [], groups: [], categories: [], styles: [], styleTotal: 0, ...(result.groups || {}) };
    const changed = JSON.stringify(nextGroups) !== JSON.stringify(state.groups);
    state.groups = nextGroups;
    if (!options.background || changed) {
      renderQuickFilters();
    }
    return true;
  }

  let assetRequestSequence = 0;
  // Tracks the last result-set semantics that successfully committed to the
  // gallery. Refreshes of the same query/scope/sort must keep the user's
  // viewport; genuine result-set changes (search/filter/sort/project) start at
  // the top. This centralizes scroll policy instead of relying on individual
  // mutation handlers to remember to restore scroll after a full card rebuild.
  let lastCommittedAssetRequestKey = null;

  // BUG-10（Batch 2A）：Gallery 与 Viewer 边界按需加载共用同一分页请求语义——参数构造
  // 与请求发起都收敛到这两个 helper，避免两套查询规则漂移。Viewer 只允许在进入时捕获的
  // 只读查询快照上取页，绝不读取运行中已变化的筛选状态；游标必须与发出时的排序同行。
  function buildAssetPageParams(request, options = {}) {
    const params = new URLSearchParams({ project: request.project, q: request.query });
    if (!request.stackId) params.set("limit", "100");
    // The sort is resolved by the store across the whole query, so the cursor must
    // travel with the same order it was issued under.
    params.set("sort", request.sort);
    if (options.cursor) params.set("cursor", options.cursor);
    if (request.scope === "favorite") params.set("favorite", "1");
    else if (request.scope === "recent") params.set("recent", "1");
    if (request.mediaKind && request.mediaKind !== "all") params.set("mediaKind", request.mediaKind);
    for (const key of FACET_KEYS) {
      if (request.facets[key]) params.set(key, request.facets[key]);
    }
    return params;
  }

  function requestAssetPage(request, options = {}) {
    const params = buildAssetPageParams(request, options);
    if (request.stackId) return apiFetch(`/api/asset-stacks/${encodeURIComponent(request.stackId)}/assets?${params}`);
    // `/api/assets` remains the raw asset collection for exports and other
    // data-oriented callers. The gallery opts into Stack collapsing explicitly
    // so visual organisation never changes the meaning of the underlying API.
    params.set("view", "gallery");
    return apiFetch(`/api/assets?${params}`);
  }

  function requestAssetTotal(request) {
    const params = buildAssetPageParams(request);
    if (request.stackId) return apiFetch(`/api/asset-stacks/${encodeURIComponent(request.stackId)}/assets?${params}`);
    params.set("view", "gallery");
    params.set("limit", "1");
    return apiFetch(`/api/assets?${params}`);
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
    const requestKey = assetRequestKey(request);
    const preserveScroll = options.preserveScroll
      ?? (options.append || lastCommittedAssetRequestKey === requestKey);
    setGalleryBusy(true, requestId, request);
    let result;
    try {
      result = await requestAssetPage(request, { cursor: options.append ? state.nextCursor : null });
    } catch (error) {
      if (!isCurrentAssetRequest(requestId, request)) return false;
      if (request.stackId && error?.code === "STACK_NOT_FOUND") {
        setGalleryBusy(false, requestId, request);
        window.dispatchEvent(new CustomEvent("mosa:active-stack-missing", { detail: { stackId: request.stackId } }));
        return false;
      }
      // Loading the next page is additive. A transient failure must never
      // replace already-loaded cards or discard the user's browsing context.
      if (options.append && state.assets.length) {
        state.galleryError = error;
        setGalleryBusy(false, requestId, request);
        return false;
      }
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
    const existingAssetKeys = options.append
      ? new Set(state.assets.map((asset) => `${asset.project_id || request.project}\u001f${asset.id}`))
      : null;
    const uniqueIncomingAssets = options.append
      ? incomingAssets.filter((asset) => {
        const key = `${asset.project_id || request.project}\u001f${asset.id}`;
        if (existingAssetKeys.has(key)) return false;
        existingAssetKeys.add(key);
        return true;
      })
      : incomingAssets;
    const nextAssets = options.append ? [...state.assets, ...uniqueIncomingAssets] : incomingAssets;
    const nextSelected = nextAssets.find((asset) => asset.id === state.selectedId)
      || (state.detailAsset?.id === state.selectedId && state.detailAsset.project_id === request.project ? state.detailAsset : null);
    const assetsChanged = options.append
      ? uniqueIncomingAssets.length > 0
      : assetListVersion(previousAssets) !== assetListVersion(nextAssets);
    const selectedChanged = assetVersion(previousSelected) !== assetVersion(nextSelected);
    // A mutation can remove the edited asset from the current result set
    // without deleting the asset itself, e.g. un-favoriting while scoped to
    // Favorites. Keep a snapshot of that asset as the Inspector's source of
    // truth until the user saves or explicitly discards the draft. Otherwise
    // selectedId becomes null while the old editable DOM is still visible.
    const preserveDirtySelection = Boolean(state.detailOpen && state.detailDirty && previousSelected
      && previousSelected.project_id === request.project
      && !nextAssets.some((asset) => asset.id === previousSelected.id && asset.project_id === previousSelected.project_id));
    state.assets = nextAssets;
    if (request.stackId && result.stack) state.activeStackSummary = result.stack;
    // The request answered, so an empty result is now genuinely an empty library.
    state.galleryStatus = "ready";
    state.galleryError = null;
    state.pageTotal = Number(result.page?.total || nextAssets.length);
    state.nextCursor = result.page?.nextCursor || null;
    state.loadedPageCount = options.append ? state.loadedPageCount + 1 : 1;
    if (preserveDirtySelection) state.detailAsset = previousSelected;
    if (state.detailAsset?.project_id !== request.project) state.detailAsset = null;
    if (state.detailAsset && state.assets.some((asset) => asset.id === state.detailAsset.id && asset.project_id === state.detailAsset.project_id)) state.detailAsset = null;
    if (state.selectedId && !state.assets.some((asset) => asset.id === state.selectedId)
      && !(state.detailAsset?.id === state.selectedId && state.detailAsset.project_id === request.project)) state.selectedId = null;
    if (!options.background || assetsChanged) {
      // F-24：入场动画只用于首次加载或追加页（新卡片），搜索/筛选/排序/后台刷新
      // 的普通重渲染不重复播放整页动画。
      renderGrid({ animate: options.append || previousAssets.length === 0,
        animateFrom: options.append ? previousAssets.length : 0,
        preserveScroll,
      });
      updateViewTitle();
    }
    lastCommittedAssetRequestKey = requestKey;
    // A same-result mutation (favorite/tag/background refresh) may rebuild the
    // gallery, but it must never rebuild the Inspector while a local draft is
    // active. Doing so would replace the editable DOM and silently discard the
    // user's unsaved values.
    if (state.detailOpen && !isDetailEditorActive()
      && (!options.background || !state.selectedId || selectedChanged)) renderDetail();
    // Phase 3C：后台刷新不重新排序 session 序列，但有效性可能变化——仅同步导航边界
    // 与位置（缺失 ID 在导航时跳过，总数基于当前有效 ID 重算）。
    if (state.viewMode === "asset") updateAssetViewNav();
    setGalleryBusy(false, requestId, request);
    return true;
  }

  let libraryRefreshInFlight = false;
  let backgroundTotalRequestSequence = 0;

  /**
   * When the user has loaded more than one page, replacing the card list would
   * throw away those pages (and can move their scroll position). The gallery
   * still needs the exact current result total, though, so fetch one row using
   * the same query and update only its count. This leaves cards, cursors, and
   * loadedPageCount untouched.
   */
  async function refreshAssetPageTotalInBackground() {
    const requestId = ++backgroundTotalRequestSequence;
    const request = currentAssetRequest();
    let result;
    try {
      result = await requestAssetTotal(request);
    } catch {
      return false;
    }
    if (requestId !== backgroundTotalRequestSequence
      || assetRequestKey(request) !== assetRequestKey(currentAssetRequest())) return false;

    const total = Number(result.page?.total);
    if (!Number.isFinite(total)) return false;
    if (state.pageTotal !== total) {
      state.pageTotal = total;
      updateViewTitle();
    }
    return true;
  }

  async function reloadLoadedAssetPages(options = {}) {
    const pageCount = Math.max(1, Number(state.loadedPageCount) || 1);
    const firstApplied = await loadAssets({ background: options.background !== false, preserveScroll: true });
    if (!firstApplied) return false;
    for (let page = 1; page < pageCount && state.nextCursor; page += 1) {
      const appended = await loadAssets({ append: true, background: options.background !== false, preserveScroll: true });
      if (!appended) return false;
    }
    return true;
  }

  async function refreshLoadedAssetsInBackground() {
    const requestId = ++backgroundTotalRequestSequence;
    const request = currentAssetRequest();
    let result;
    try {
      result = await requestAssetPage(request);
    } catch {
      return false;
    }
    if (requestId !== backgroundTotalRequestSequence
      || assetRequestKey(request) !== assetRequestKey(currentAssetRequest())) return false;

    const incoming = result.assets || [];
    const visible = state.assets.slice(0, incoming.length);
    const incomingIds = incoming.map((asset) => `${asset.project_id || request.project}\u001f${asset.id}`).join("|");
    const visibleIds = visible.map((asset) => `${asset.project_id || request.project}\u001f${asset.id}`).join("|");
    if (incomingIds !== visibleIds) return reloadLoadedAssetPages({ background: true });

    const total = Number(result.page?.total);
    if (Number.isFinite(total) && state.pageTotal !== total) {
      state.pageTotal = total;
      updateViewTitle();
    }
    return true;
  }

  async function refreshLibraryInBackground() {
    if (document.hidden || libraryRefreshInFlight) return;
    libraryRefreshInFlight = true;
    try {
      await Promise.all([
        loadStats({ background: true }),
        state.loadedPageCount > 1 ? refreshLoadedAssetsInBackground() : loadAssets({ background: true }),
      ]);
    } catch {
      // A transient refresh failure should not interrupt the active library view.
    } finally {
      libraryRefreshInFlight = false;
    }
  }

  function currentAssetRequest() {
    return {
      project: state.project,
      query: state.query,
      scope: state.scope,
      mediaKind: state.mediaKind,
      facets: { ...state.facets },
      sort: state.activeStackId ? "manual" : state.sort,
      stackId: state.activeStackId || "",
    };
  }

  function assetRequestKey(request) {
    return JSON.stringify([request.project, request.stackId || "", request.query, request.scope, request.mediaKind || "all", ...FACET_KEYS.map((key) => request.facets[key] || ""), request.sort]);
  }

  function assetListVersion(assets) {
    return assets.map((asset) => `${asset.id}:${asset.updated_at || ""}:${asset.image_url || ""}`).join("|");
  }

  function assetVersion(asset) {
    return asset ? `${asset.id}:${asset.updated_at || ""}` : "";
  }

  return {
    apiFetch, loadProjects, loadCowartCanvases, loadStats, loadAssets, refreshLibraryInBackground,
    refreshAssetPageTotalInBackground, refreshLoadedAssetsInBackground, reloadLoadedAssetPages,
    buildAssetPageParams, requestAssetPage, requestAssetTotal, currentAssetRequest, assetRequestKey, assetListVersion, assetVersion,
  };
}
