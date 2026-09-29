export const MARQUEE_DRAG_THRESHOLD_PX = 3;
const AUTO_SCROLL_EDGE_PX = 36;
const AUTO_SCROLL_MAX_PX = 18;
const MARQUEE_GEOMETRY_BAND_PX = 512;
const STACK_SELECTION_RESOLVE_CONCURRENCY = 4;

export function rectFromPoints(x1, y1, x2, y2) {
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const right = Math.max(x1, x2);
  const bottom = Math.max(y1, y2);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

export function rectsIntersect(a, b) {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

export function cardSelectionFlags(id, selectedIds = new Set(), detailSelectedId = "") {
  const explicitSelection = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
  const multiSelected = explicitSelection.has(id);
  return {
    multiSelected,
    detailSelected: !explicitSelection.size && id === detailSelectedId,
  };
}

export function selectionRangeIds(assets = [], anchorId = "", targetId = "") {
  const ids = (assets || []).map((asset) => String(asset?.id || "")).filter(Boolean);
  const targetIndex = ids.indexOf(String(targetId || ""));
  if (targetIndex < 0) return targetId ? [String(targetId)] : [];
  const anchorIndex = ids.indexOf(String(anchorId || ""));
  if (anchorIndex < 0) return [ids[targetIndex]];
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return ids.slice(start, end + 1);
}

function sameIds(a, b) {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function createGallerySelection({
  els,
  state,
  t,
  announceGalleryStatus,
  currentAssetRequest,
  requestAssetPage,
  apiFetch,
  showToast,
  getCardSelectionRects,
  getCardSelectionGeometryVersion,
  getSelectionAsset,
  getRenderedSelectionCard,
}) {
  let pointer = null;
  let selectionBox = null;
  let suppressNextGridClick = false;
  let autoScrollFrame = 0;
  let selectionUpdateFrame = 0;
  let pendingSelectionPoint = null;
  let selectionAnchorId = "";
  let selectAllInFlight = false;
  let selectionRevision = 0;

  function currentSelectionRequestKey() {
    if (typeof currentAssetRequest !== "function") return "";
    try {
      const request = currentAssetRequest();
      return JSON.stringify([
        request.project,
        request.stackId || "",
        request.query || "",
        request.scope || "all",
        request.mediaKind || "all",
        ...Object.keys(request.facets || {}).sort().map((key) => `${key}:${request.facets[key] || ""}`),
      ]);
    } catch {
      return "";
    }
  }

  function captureActionContext() {
    const selectedIds = new Set(ensureSelectionSet());
    return {
      projectId: state.project,
      requestKey: currentSelectionRequestKey(),
      revision: selectionRevision,
      selectedIds,
      stackNodes: new Map(ensureStackSelectionMap()),
    };
  }

  function isActionContextCurrent(context) {
    if (!context) return false;
    return context.projectId === state.project
      && context.requestKey === currentSelectionRequestKey()
      && context.revision === selectionRevision;
  }

  function ensureStackSelectionMap() {
    if (!(state.selectedStackNodes instanceof Map)) state.selectedStackNodes = new Map();
    return state.selectedStackNodes;
  }

  function resetSelectionState({ requestKey = currentSelectionRequestKey(), resetAnchor = true } = {}) {
    state.selectedIds = new Set();
    state.selectedStackNodes = new Map();
    state.selectionProject = state.project;
    state.selectionRequestKey = requestKey;
    if (resetAnchor) selectionAnchorId = "";
    selectionRevision += 1;
  }

  function ensureSelectionSet() {
    if (!(state.selectedIds instanceof Set)) state.selectedIds = new Set(state.selectedIds || []);
    ensureStackSelectionMap();
    const requestKey = currentSelectionRequestKey();
    if (state.selectionProject !== state.project
      || (state.selectionRequestKey && requestKey && state.selectionRequestKey !== requestKey)) {
      resetSelectionState({ requestKey });
    } else if (!state.selectionRequestKey && requestKey) state.selectionRequestKey = requestKey;
    return state.selectedIds;
  }

  function isStackNode(asset) {
    return !state.activeStackId && Boolean(asset?.stack?.id);
  }

  function selectionAssetById(id) {
    if (!id) return null;
    if (typeof getSelectionAsset === "function") return getSelectionAsset(id) || null;
    return (state.assets || []).find((asset) => asset?.id === id) || null;
  }

  function currentDetailSelectionId() {
    const id = String(state.selectedId || "");
    if (!id) return "";
    return (state.assets || []).some((asset) => asset?.id === id) ? id : "";
  }

  function additiveSelectionBase({ excludeDetailId = "" } = {}) {
    const next = new Set(ensureSelectionSet());
    const detailId = currentDetailSelectionId();
    if (!next.size && detailId && detailId !== excludeDetailId) next.add(detailId);
    return next;
  }

  function reconcileStackSelection(nextSelection, explicitStackNodes = null, changedIds = null) {
    const nextStacks = explicitStackNodes instanceof Map
      ? new Map([...explicitStackNodes].filter(([id]) => nextSelection.has(id)))
      : new Map([...ensureStackSelectionMap()].filter(([id]) => nextSelection.has(id)));
    if (explicitStackNodes instanceof Map) return nextStacks;
    if (changedIds instanceof Set) {
      for (const id of changedIds) {
        if (!nextSelection.has(id)) continue;
        const asset = selectionAssetById(id);
        if (!asset) continue;
        if (isStackNode(asset)) nextStacks.set(asset.id, asset.stack.id);
        else nextStacks.delete(asset.id);
      }
      return nextStacks;
    }
    for (const asset of state.assets || []) {
      if (!nextSelection.has(asset.id)) continue;
      if (isStackNode(asset)) nextStacks.set(asset.id, asset.stack.id);
      else nextStacks.delete(asset.id);
    }
    return nextStacks;
  }

  function applyCardSelectionState(card, selectedIds) {
    if (!(card instanceof HTMLElement)) return;
    const id = card.dataset.id;
    if (!id) return;
    const { multiSelected, detailSelected } = cardSelectionFlags(id, selectedIds, state.selectedId);
    card.classList.toggle("selected", detailSelected);
    card.classList.toggle("multi-selected", multiSelected);
    card.querySelector(".asset-card-select")?.setAttribute("aria-pressed", String(detailSelected || multiSelected));
  }

  function syncCardSelectionState(id, selectedIds) {
    if (!id || !els.assetGrid) return;
    const card = typeof getRenderedSelectionCard === "function"
      ? getRenderedSelectionCard(id)
      : els.assetGrid.querySelector(`:scope > .asset-card[data-id="${CSS.escape(id)}"]`);
    applyCardSelectionState(card, selectedIds);
  }

  function syncRenderedSelection({ prune = true, changedIds = null, stackNodes = null } = {}) {
    const selectedIds = ensureSelectionSet();
    // Selection may span unloaded cursor pages. Query/project changes clear it
    // via ensureSelectionSet(), so never prune valid off-DOM IDs merely because
    // the gallery currently renders only a window of the result set.
    void prune;
    state.selectedStackNodes = reconcileStackSelection(selectedIds, stackNodes, changedIds);

    if (changedIds instanceof Set) {
      // Large selection changes (notably Select All) can contain thousands of
      // off-DOM IDs while virtualization keeps only a few hundred cards
      // mounted. In that case, scan mounted cards once instead of running one
      // selector lookup per changed ID. Small deltas stay O(changedIds) and can
      // use the renderer's id -> node cache through getRenderedSelectionCard.
      const mountedUpperBound = Math.max(0, Number(els.assetGrid?.childElementCount) || 0);
      if (els.assetGrid && changedIds.size > mountedUpperBound) {
        els.assetGrid.querySelectorAll(":scope > .asset-card").forEach((card) => {
          if (changedIds.has(card.dataset.id || "")) applyCardSelectionState(card, selectedIds);
        });
      } else {
        for (const id of changedIds) syncCardSelectionState(id, selectedIds);
      }
    } else {
      els.assetGrid?.querySelectorAll(":scope > .asset-card").forEach((card) => {
        applyCardSelectionState(card, selectedIds);
      });
    }

    const count = selectedIds.size;
    if (els.selectionBar) els.selectionBar.hidden = count === 0;
    els.assetGrid?.classList.toggle("selection-active", count > 0);
    if (els.selectionCount) els.selectionCount.textContent = t("batchSelected", { count });
    if (els.selectionSelectAll) els.selectionSelectAll.disabled = selectAllInFlight || !state.pageTotal || count >= state.pageTotal;
    if (els.selectionClear) els.selectionClear.disabled = count === 0;
    if (els.selectionStack) {
      const includesExistingStack = ensureStackSelectionMap().size > 0;
      els.selectionStack.disabled = state.scope === "trash" || state.storageKind !== "sqlite" || count < 2 || includesExistingStack;
    }
    if (els.selectionRemoveFromStack) els.selectionRemoveFromStack.disabled = count === 0;
    return count;
  }

  function announceSelection() {
    const count = ensureSelectionSet().size;
    announceGalleryStatus?.(count ? t("batchSelected", { count }) : t("batchCancel"));
  }

  function commitSelection(nextSelection, { announce = false, stackNodes = null, anchorId = null } = {}) {
    const current = ensureSelectionSet();
    const batchModeChanged = Boolean(current.size) !== Boolean(nextSelection.size);
    const changedIds = new Set();
    for (const id of current) if (!nextSelection.has(id)) changedIds.add(id);
    for (const id of nextSelection) if (!current.has(id)) changedIds.add(id);
    if (batchModeChanged && state.selectedId) changedIds.add(state.selectedId);
    if (!sameIds(current, nextSelection)) state.selectedIds = new Set(nextSelection);
    if (anchorId !== null) selectionAnchorId = anchorId;
    selectionRevision += 1;
    syncRenderedSelection({ prune: false, changedIds, stackNodes });
    if (announce) announceSelection();
  }

  function clear({ announce = false } = {}) {
    if (!ensureSelectionSet().size) return false;
    resetSelectionState();
    syncRenderedSelection({ prune: false });
    if (announce) announceSelection();
    return true;
  }

  function toggle(id, { announce = true } = {}) {
    if (!id) return false;
    const next = additiveSelectionBase({ excludeDetailId: id });
    if (next.has(id)) next.delete(id);
    else next.add(id);
    commitSelection(next, { announce, anchorId: id });
    return true;
  }

  function removeIds(ids, { announce = false } = {}) {
    const current = ensureSelectionSet();
    const remove = ids instanceof Set ? ids : new Set(ids || []);
    if (!remove.size) return false;
    const next = new Set(current);
    let changed = false;
    for (const id of remove) {
      if (next.delete(id)) changed = true;
    }
    if (!changed) return false;
    commitSelection(next, {
      announce,
      anchorId: remove.has(selectionAnchorId) ? "" : null,
    });
    return true;
  }

  function snapshotSelection() {
    return {
      selectedIds: [...ensureSelectionSet()],
      stackNodes: [...ensureStackSelectionMap()],
      anchorId: selectionAnchorId,
    };
  }

  function restoreSelection(snapshot = {}, { allowedIds = null, announce = false } = {}) {
    const allow = allowedIds instanceof Set ? allowedIds : null;
    const selectedIds = new Set((snapshot.selectedIds || []).filter((id) => !allow || allow.has(id)));
    const stackNodes = new Map((snapshot.stackNodes || []).filter(([id]) => selectedIds.has(id)));
    commitSelection(selectedIds, {
      announce,
      stackNodes,
      anchorId: selectedIds.has(snapshot.anchorId) ? snapshot.anchorId : "",
    });
    // Snapshot stack metadata can age while the user is inside a Stack. A
    // one-time full reconciliation on restore corrects loaded nodes that were
    // dissolved/recovered meanwhile while preserving off-page snapshot nodes.
    syncRenderedSelection({ prune: false });
    return selectedIds.size;
  }

  function selectRange(id, { additive = false, announce = true } = {}) {
    if (!id) return false;
    const range = selectionRangeIds(state.assets, selectionAnchorId || state.selectedId || id, id);
    const next = additive ? additiveSelectionBase() : new Set();
    range.forEach((assetId) => next.add(assetId));
    commitSelection(next, { announce, anchorId: id });
    return true;
  }

  async function selectAll({ announce = true } = {}) {
    if (selectAllInFlight || typeof currentAssetRequest !== "function" || typeof requestAssetPage !== "function") return false;
    ensureSelectionSet();
    const request = currentAssetRequest();
    const requestKey = currentSelectionRequestKey();
    const startRevision = selectionRevision;
    const next = new Set();
    const stackNodes = new Map();
    const seenCursors = new Set();
    let cursor = "";
    selectAllInFlight = true;
    syncRenderedSelection({ prune: false });
    try {
      while (true) {
        if (cursor) {
          if (seenCursors.has(cursor)) throw new Error("Selection pagination stalled.");
          seenCursors.add(cursor);
        }
        const page = await requestAssetPage(request, { cursor, limit: 250, includeTotal: cursor ? false : true });
        for (const asset of page.assets || []) {
          if (!asset?.id) continue;
          next.add(asset.id);
          if (!request.stackId && asset.stack?.id) stackNodes.set(asset.id, asset.stack.id);
        }
        cursor = page.page?.nextCursor || "";
        if (!cursor) break;
      }
      if (selectionRevision !== startRevision || (requestKey && currentSelectionRequestKey() !== requestKey)) return false;
      if (!next.size) return false;
      state.selectionRequestKey = requestKey;
      commitSelection(next, { announce, stackNodes, anchorId: "" });
      return true;
    } catch (error) {
      showToast?.(error?.message || String(error), "error");
      return false;
    } finally {
      selectAllInFlight = false;
      syncRenderedSelection({ prune: false });
    }
  }

  async function resolveSelectedAssetIds(context = captureActionContext()) {
    if (!isActionContextCurrent(context)) return null;
    const selected = new Set(context.selectedIds);
    const stackNodes = new Map(context.stackNodes);
    if (!stackNodes.size) return { projectId: context.projectId, ids: [...selected] };
    if (typeof apiFetch !== "function") {
      return { projectId: context.projectId, ids: [...selected].filter((id) => !stackNodes.has(id)) };
    }
    const entries = [...stackNodes];
    let nextEntryIndex = 0;
    let stale = false;
    async function resolveNextStack() {
      while (nextEntryIndex < entries.length && !stale) {
        const entryIndex = nextEntryIndex;
        nextEntryIndex += 1;
        const [coverId, stackId] = entries[entryIndex];
        const memberIds = [];
        const seenCursors = new Set();
        let cursor = "";
        while (true) {
          if (cursor) {
            if (seenCursors.has(cursor)) throw new Error("Stack selection pagination stalled.");
            seenCursors.add(cursor);
          }
          const params = new URLSearchParams({ project: context.projectId, limit: "250", includeTotal: "0" });
          if (cursor) params.set("cursor", cursor);
          const page = await apiFetch(`/api/asset-stacks/${encodeURIComponent(stackId)}/assets?${params}`);
          if (!isActionContextCurrent(context)) {
            stale = true;
            return;
          }
          for (const asset of page.assets || []) if (asset?.id) memberIds.push(asset.id);
          cursor = page.page?.nextCursor || "";
          if (!cursor) break;
        }
        selected.delete(coverId);
        memberIds.forEach((id) => selected.add(id));
      }
    }
    await Promise.all(Array.from(
      { length: Math.min(STACK_SELECTION_RESOLVE_CONCURRENCY, entries.length) },
      () => resolveNextStack(),
    ));
    if (stale || !isActionContextCurrent(context)) return null;
    return { projectId: context.projectId, ids: [...selected] };
  }

  function replaceWith(id, { announce = false } = {}) {
    if (!id) return false;
    commitSelection(new Set([id]), { announce, anchorId: id });
    return true;
  }

  function createSelectionBox() {
    if (selectionBox?.isConnected) return selectionBox;
    selectionBox = document.createElement("div");
    selectionBox.className = "marquee-selection-box";
    selectionBox.setAttribute("aria-hidden", "true");
    document.body.append(selectionBox);
    return selectionBox;
  }

  function removeSelectionBox() {
    selectionBox?.remove();
    selectionBox = null;
    document.body.classList.remove("marquee-selecting");
  }

  function stopAutoScroll() {
    if (autoScrollFrame) cancelAnimationFrame(autoScrollFrame);
    autoScrollFrame = 0;
    if (selectionUpdateFrame) cancelAnimationFrame(selectionUpdateFrame);
    selectionUpdateFrame = 0;
    pendingSelectionPoint = null;
  }

  function scrollVelocity(clientY) {
    const bounds = els.assetGrid?.getBoundingClientRect();
    if (!bounds) return 0;
    if (clientY < bounds.top + AUTO_SCROLL_EDGE_PX) {
      const ratio = clamp((bounds.top + AUTO_SCROLL_EDGE_PX - clientY) / AUTO_SCROLL_EDGE_PX, 0, 1);
      return -Math.ceil(AUTO_SCROLL_MAX_PX * ratio);
    }
    if (clientY > bounds.bottom - AUTO_SCROLL_EDGE_PX) {
      const ratio = clamp((clientY - (bounds.bottom - AUTO_SCROLL_EDGE_PX)) / AUTO_SCROLL_EDGE_PX, 0, 1);
      return Math.ceil(AUTO_SCROLL_MAX_PX * ratio);
    }
    return 0;
  }

  function refreshDragGeometrySnapshot() {
    if (!pointer || !els.assetGrid) return;
    const bounds = els.assetGrid.getBoundingClientRect();
    const scrollLeft = els.assetGrid.scrollLeft;
    const scrollTop = els.assetGrid.scrollTop;
    // Cache card geometry once per gesture in scroll-content coordinates.
    // Large galleries prune offscreen card DOM while marquee auto-scroll is
    // active, so prefer the masonry geometry provider: it represents the whole
    // loaded result window regardless of which cards are mounted. Small views
    // keep the DOM measurement fallback. Pointermove then intersects a stable
    // snapshot instead of a virtualized DOM window that changes underneath it.
    const providedRects = typeof getCardSelectionRects === "function" ? getCardSelectionRects() : null;
    pointer.cardRects = Array.isArray(providedRects) && providedRects.length
      ? providedRects
      : [...els.assetGrid.querySelectorAll(":scope > .asset-card")].map((card) => {
        const rect = card.getBoundingClientRect();
        return {
          id: card.dataset.id || "",
          rect: {
            left: rect.left - bounds.left + scrollLeft,
            right: rect.right - bounds.left + scrollLeft,
            top: rect.top - bounds.top + scrollTop,
            bottom: rect.bottom - bounds.top + scrollTop,
          },
        };
      }).filter((entry) => entry.id);
    pointer.cardRectBands = new Map();
    for (const entry of pointer.cardRects) {
      const firstBand = Math.floor(entry.rect.top / MARQUEE_GEOMETRY_BAND_PX);
      const lastBand = Math.floor(entry.rect.bottom / MARQUEE_GEOMETRY_BAND_PX);
      for (let band = firstBand; band <= lastBand; band += 1) {
        if (!pointer.cardRectBands.has(band)) pointer.cardRectBands.set(band, []);
        pointer.cardRectBands.get(band).push(entry);
      }
    }
    pointer.geometryVersion = typeof getCardSelectionGeometryVersion === "function"
      ? getCardSelectionGeometryVersion()
      : null;
  }

  function captureDragGeometry() {
    if (!pointer || !els.assetGrid) return;
    const bounds = els.assetGrid.getBoundingClientRect();
    const scrollLeft = els.assetGrid.scrollLeft;
    const scrollTop = els.assetGrid.scrollTop;
    const startX = clamp(pointer.startX, bounds.left, bounds.right);
    const startY = clamp(pointer.startY, bounds.top, bounds.bottom);
    pointer.startContentX = startX - bounds.left + scrollLeft;
    pointer.startContentY = startY - bounds.top + scrollTop;
    refreshDragGeometrySnapshot();
  }

  function updateDragSelection(clientX, clientY) {
    if (!pointer?.dragging || !els.assetGrid) return;
    if (typeof getCardSelectionGeometryVersion === "function"
      && pointer.geometryVersion !== getCardSelectionGeometryVersion()) {
      // Infinite-scroll append and incremental masonry reflow can extend or
      // shift loaded geometry while the same marquee remains active. Preserve
      // the original content-space origin, but refresh the candidate snapshot.
      refreshDragGeometrySnapshot();
    }
    const bounds = els.assetGrid.getBoundingClientRect();
    const x = clamp(clientX, bounds.left, bounds.right);
    const y = clamp(clientY, bounds.top, bounds.bottom);
    const currentContentX = x - bounds.left + els.assetGrid.scrollLeft;
    const currentContentY = y - bounds.top + els.assetGrid.scrollTop;
    const rect = rectFromPoints(pointer.startContentX, pointer.startContentY, currentContentX, currentContentY);
    const box = createSelectionBox();
    const viewportLeft = bounds.left + rect.left - els.assetGrid.scrollLeft;
    const viewportRight = bounds.left + rect.right - els.assetGrid.scrollLeft;
    const viewportTop = bounds.top + rect.top - els.assetGrid.scrollTop;
    const viewportBottom = bounds.top + rect.bottom - els.assetGrid.scrollTop;
    const clippedLeft = clamp(viewportLeft, bounds.left, bounds.right);
    const clippedRight = clamp(viewportRight, bounds.left, bounds.right);
    const clippedTop = clamp(viewportTop, bounds.top, bounds.bottom);
    const clippedBottom = clamp(viewportBottom, bounds.top, bounds.bottom);
    box.style.left = `${clippedLeft}px`;
    box.style.top = `${clippedTop}px`;
    box.style.width = `${Math.max(0, clippedRight - clippedLeft)}px`;
    box.style.height = `${Math.max(0, clippedBottom - clippedTop)}px`;

    const next = pointer.additive ? new Set(pointer.additiveBaseSelection) : new Set();
    if (!pointer.additive && pointer.promoteDetailId) next.add(pointer.promoteDetailId);
    // When a marquee starts on top of a card, that origin card is part of the
    // user's intended sweep even for a right-to-left / bottom-to-top drag.
    // Keeping it explicitly also avoids a one-pixel boundary miss at the exact
    // pointer origin and keeps the first card selected during auto-scroll.
    if (pointer.startCardId) next.add(pointer.startCardId);
    const candidateById = new Map();
    const firstBand = Math.floor(rect.top / MARQUEE_GEOMETRY_BAND_PX);
    const lastBand = Math.floor(rect.bottom / MARQUEE_GEOMETRY_BAND_PX);
    for (let band = firstBand; band <= lastBand; band += 1) {
      for (const entry of pointer.cardRectBands?.get(band) || []) candidateById.set(entry.id, entry);
    }
    for (const entry of candidateById.values()) if (rectsIntersect(rect, entry.rect)) next.add(entry.id);
    commitSelection(next);
  }

  function scheduleDragSelectionUpdate(clientX, clientY) {
    pendingSelectionPoint = { x: clientX, y: clientY };
    if (selectionUpdateFrame) return;
    selectionUpdateFrame = requestAnimationFrame(() => {
      selectionUpdateFrame = 0;
      const point = pendingSelectionPoint;
      pendingSelectionPoint = null;
      if (point) updateDragSelection(point.x, point.y);
    });
  }

  function scheduleAutoScroll() {
    if (autoScrollFrame || !pointer?.dragging) return;
    const step = () => {
      autoScrollFrame = 0;
      if (!pointer?.dragging || !els.assetGrid) return;
      const velocity = scrollVelocity(pointer.lastY);
      if (!velocity) return;
      const before = els.assetGrid.scrollTop;
      els.assetGrid.scrollTop += velocity;
      if (els.assetGrid.scrollTop !== before) updateDragSelection(pointer.lastX, pointer.lastY);
      autoScrollFrame = requestAnimationFrame(step);
    };
    autoScrollFrame = requestAnimationFrame(step);
  }

  function beginPointer(event) {
    // A completed marquee normally consumes the synthetic click generated by
    // that same gesture. If no click was dispatched, the next pointerdown is a
    // new gesture boundary and must invalidate the stale suppression flag.
    suppressNextGridClick = false;
    if (!els.assetGrid || state.viewMode !== "library" || !state.assets?.length) return;
    if (event.button !== 0 || event.isPrimary === false || event.pointerType === "touch") return;
    if (state.assetStackDragCandidate) return;
    // Gesture ownership is intentionally desktop-like: a plain press on an
    // asset card belongs to asset dragging, while marquee selection begins in
    // gallery whitespace. Shift-drag is the explicit exception that allows a
    // marquee to originate on a card for additive/range selection workflows.
    if (event.target.closest?.(".card-action-btn, .asset-load-more button, input, textarea, select, [contenteditable], a[href]")) return;
    const bounds = els.assetGrid.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
    const startCard = event.target.closest?.(".asset-card");
    if (startCard && !event.shiftKey) return;
    const explicitSelection = ensureSelectionSet();
    const promoteDetailId = explicitSelection.size ? "" : currentDetailSelectionId();
    pointer = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      additive: event.shiftKey,
      baseSelection: new Set(explicitSelection),
      additiveBaseSelection: event.shiftKey ? additiveSelectionBase() : new Set(explicitSelection),
      baseStackNodes: new Map(ensureStackSelectionMap()),
      promoteDetailId,
      startCardId: startCard?.dataset.id || "",
      dragging: false,
    };
  }

  function movePointer(event) {
    if (!pointer || pointer.id !== event.pointerId) return;
    pointer.lastX = event.clientX;
    pointer.lastY = event.clientY;
    if (!pointer.dragging) {
      const distance = Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY);
      if (distance < MARQUEE_DRAG_THRESHOLD_PX) return;
      pointer.dragging = true;
      captureDragGeometry();
      try { els.assetGrid?.setPointerCapture(event.pointerId); } catch { /* Window-level listeners still keep the gesture alive. */ }
      document.body.classList.add("marquee-selecting");
      suppressNextGridClick = true;
    }
    event.preventDefault();
    scheduleDragSelectionUpdate(event.clientX, event.clientY);
    scheduleAutoScroll();
  }

  function endPointer(event, { canceled = false } = {}) {
    if (!pointer || pointer.id !== event.pointerId) return;
    const completedDrag = pointer.dragging;
    const baseSelection = pointer.baseSelection;
    const baseStackNodes = pointer.baseStackNodes;
    if (completedDrag && !canceled && pendingSelectionPoint) {
      updateDragSelection(pendingSelectionPoint.x, pendingSelectionPoint.y);
    }
    pointer = null;
    stopAutoScroll();
    removeSelectionBox();
    try { els.assetGrid?.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    if (canceled && completedDrag) {
      suppressNextGridClick = false;
      commitSelection(baseSelection, { stackNodes: baseStackNodes });
    }
    else if (completedDrag) {
      announceSelection();
    }
  }

  function cancelPointerGesture() {
    if (!pointer) return;
    endPointer({ pointerId: pointer.id }, { canceled: true });
  }

  function handleGridClick(event) {
    if (suppressNextGridClick) {
      suppressNextGridClick = false;
      event.preventDefault();
      return true;
    }
    if (event.target.closest?.(".asset-card, button, input, textarea, select, [contenteditable]")) return false;
    return clear({ announce: true });
  }

  function handleCardClick(event, id) {
    if (event.shiftKey) {
      event.preventDefault();
      return selectRange(id, { additive: Boolean(event.metaKey || event.ctrlKey), announce: true });
    }
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      return toggle(id, { announce: true });
    }
    return false;
  }

  function bind() {
    if (!els.assetGrid) return;
    els.assetGrid.addEventListener("pointerdown", beginPointer);
    // Track on window rather than only on the grid. This makes a fast diagonal
    // start at a card edge just as reliable as a slow drag in empty whitespace,
    // even before pointer capture has been activated.
    window.addEventListener("pointermove", movePointer, { capture: true });
    window.addEventListener("pointerup", (event) => endPointer(event), { capture: true });
    window.addEventListener("pointercancel", (event) => endPointer(event, { canceled: true }), { capture: true });
    els.assetGrid.addEventListener("lostpointercapture", () => {
      if (pointer?.dragging) cancelPointerGesture();
    });
    // Browser-native image dragging competes with MOSA's Pointer-based card
    // drag and marquee selection. Cards stay non-native inside the renderer;
    // the Stack controller promotes the held card drag to the desktop OS only
    // after the pointer actually leaves the MOSA window.
    els.assetGrid.addEventListener("dragstart", (event) => {
      if (event.target.closest?.(".asset-card")) event.preventDefault();
    });
    window.addEventListener("blur", cancelPointerGesture);
    els.selectionSelectAll?.addEventListener("click", () => { void selectAll({ announce: true }); });
    els.selectionClear?.addEventListener("click", () => clear({ announce: true }));
  }

  return {
    bind,
    clear,
    toggle,
    removeIds,
    replaceWith,
    selectAll,
    selectRange,
    captureActionContext,
    isActionContextCurrent,
    resolveSelectedAssetIds,
    snapshotSelection,
    restoreSelection,
    hasSelectedStacks: () => ensureStackSelectionMap().size > 0,
    syncRenderedSelection,
    handleGridClick,
    handleCardClick,
    selectedIds: () => new Set(ensureSelectionSet()),
  };
}
