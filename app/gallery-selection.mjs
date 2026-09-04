export const MARQUEE_DRAG_THRESHOLD_PX = 3;
export const MARQUEE_CARD_DRAG_THRESHOLD_PX = 6;
const AUTO_SCROLL_EDGE_PX = 36;
const AUTO_SCROLL_MAX_PX = 18;
const MARQUEE_GEOMETRY_BAND_PX = 512;

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

  function reconcileStackSelection(nextSelection, explicitStackNodes = null) {
    const nextStacks = explicitStackNodes instanceof Map
      ? new Map([...explicitStackNodes].filter(([id]) => nextSelection.has(id)))
      : new Map([...ensureStackSelectionMap()].filter(([id]) => nextSelection.has(id)));
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
    const multiSelected = selectedIds.has(id);
    const detailSelected = id === state.selectedId;
    card.classList.toggle("multi-selected", multiSelected);
    card.querySelector(".asset-card-select")?.setAttribute("aria-pressed", String(detailSelected || multiSelected));
  }

  function syncCardSelectionState(id, selectedIds) {
    if (!id || !els.assetGrid) return;
    const card = els.assetGrid.querySelector(`:scope > .asset-card[data-id="${CSS.escape(id)}"]`);
    applyCardSelectionState(card, selectedIds);
  }

  function syncRenderedSelection({ prune = true, changedIds = null } = {}) {
    const selectedIds = ensureSelectionSet();
    // Selection may span unloaded cursor pages. Query/project changes clear it
    // via ensureSelectionSet(), so never prune valid off-DOM IDs merely because
    // the gallery currently renders only a window of the result set.
    void prune;
    const stackNodes = ensureStackSelectionMap();
    for (const asset of state.assets || []) {
      if (!selectedIds.has(asset.id)) continue;
      if (isStackNode(asset)) stackNodes.set(asset.id, asset.stack.id);
      else stackNodes.delete(asset.id);
    }

    if (changedIds instanceof Set) {
      for (const id of changedIds) syncCardSelectionState(id, selectedIds);
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
    const changedIds = new Set();
    for (const id of current) if (!nextSelection.has(id)) changedIds.add(id);
    for (const id of nextSelection) if (!current.has(id)) changedIds.add(id);
    if (!sameIds(current, nextSelection)) state.selectedIds = new Set(nextSelection);
    state.selectedStackNodes = reconcileStackSelection(nextSelection, stackNodes);
    if (anchorId !== null) selectionAnchorId = anchorId;
    selectionRevision += 1;
    syncRenderedSelection({ prune: false, changedIds });
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
    const next = new Set(ensureSelectionSet());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    commitSelection(next, { announce, anchorId: id });
    return true;
  }

  function selectRange(id, { additive = false, announce = true } = {}) {
    if (!id) return false;
    const range = selectionRangeIds(state.assets, selectionAnchorId || state.selectedId || id, id);
    const next = additive ? new Set(ensureSelectionSet()) : new Set();
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

  async function resolveSelectedAssetIds() {
    const selected = new Set(ensureSelectionSet());
    const stackNodes = new Map(ensureStackSelectionMap());
    if (!stackNodes.size) return [...selected];
    if (typeof apiFetch !== "function") return [...selected].filter((id) => !stackNodes.has(id));
    for (const [coverId, stackId] of stackNodes) {
      selected.delete(coverId);
      const seenCursors = new Set();
      let cursor = "";
      while (true) {
        if (cursor) {
          if (seenCursors.has(cursor)) throw new Error("Stack selection pagination stalled.");
          seenCursors.add(cursor);
        }
        const params = new URLSearchParams({ project: state.project, limit: "250", includeTotal: "0" });
        if (cursor) params.set("cursor", cursor);
        const page = await apiFetch(`/api/asset-stacks/${encodeURIComponent(stackId)}/assets?${params}`);
        for (const asset of page.assets || []) if (asset?.id) selected.add(asset.id);
        cursor = page.page?.nextCursor || "";
        if (!cursor) break;
      }
    }
    return [...selected];
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

  function captureDragGeometry() {
    if (!pointer || !els.assetGrid) return;
    const bounds = els.assetGrid.getBoundingClientRect();
    const scrollLeft = els.assetGrid.scrollLeft;
    const scrollTop = els.assetGrid.scrollTop;
    const startX = clamp(pointer.startX, bounds.left, bounds.right);
    const startY = clamp(pointer.startY, bounds.top, bounds.bottom);
    pointer.startContentX = startX - bounds.left + scrollLeft;
    pointer.startContentY = startY - bounds.top + scrollTop;
    // Cache card geometry once per gesture in scroll-content coordinates.
    // Pointermove can fire far above the display refresh rate; avoiding an
    // all-card getBoundingClientRect() loop per event removes the largest
    // source of marquee jank in large Stacks.
    pointer.cardRects = [...els.assetGrid.querySelectorAll(":scope > .asset-card")].map((card) => {
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
  }

  function updateDragSelection(clientX, clientY) {
    if (!pointer?.dragging || !els.assetGrid) return;
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

    const next = pointer.additive ? new Set(pointer.baseSelection) : new Set();
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
    if (!els.assetGrid || state.viewMode !== "library" || !state.assets?.length) return;
    if (event.button !== 0 || event.isPrimary === false || event.pointerType === "touch") return;
    if (state.assetStackDragCandidate) return;
    // Card surfaces are valid marquee origins. Only controls whose primary job
    // is an immediate action stay out of the gesture so favorite/copy/load-more
    // clicks remain crisp. A plain card click is still untouched because we do
    // not capture or prevent anything until the pointer moves past the threshold.
    if (event.target.closest?.(".card-action-btn, .asset-load-more button, input, textarea, select, [contenteditable], a[href]")) return;
    const bounds = els.assetGrid.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
    const startCard = event.target.closest?.(".asset-card");
    pointer = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      additive: event.shiftKey,
      baseSelection: new Set(ensureSelectionSet()),
      baseStackNodes: new Map(ensureStackSelectionMap()),
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
      // Blank-area marquee stays very responsive. A card-origin gesture gets a
      // little more hysteresis so normal click jitter still resolves to the
      // card's single-select action instead of accidentally entering batch mode.
      const threshold = pointer.startCardId ? MARQUEE_CARD_DRAG_THRESHOLD_PX : MARQUEE_DRAG_THRESHOLD_PX;
      if (distance < threshold) return;
      pointer.dragging = true;
      captureDragGeometry();
      try { els.assetGrid?.setPointerCapture(event.pointerId); } catch { /* global listeners still keep the gesture alive */ }
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
      window.setTimeout(() => { suppressNextGridClick = false; }, 0);
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
    // Browser-native image dragging competes with marquee pointer events when
    // the gesture begins directly on a thumbnail. MOSA has no internal card
    // drag operation, so suppress only drags originating from an asset card.
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
    replaceWith,
    selectAll,
    selectRange,
    resolveSelectedAssetIds,
    hasSelectedStacks: () => ensureStackSelectionMap().size > 0,
    syncRenderedSelection,
    handleGridClick,
    handleCardClick,
    selectedIds: () => new Set(ensureSelectionSet()),
  };
}
