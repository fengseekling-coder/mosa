export const MARQUEE_DRAG_THRESHOLD_PX = 3;
export const MARQUEE_CARD_DRAG_THRESHOLD_PX = 6;
const AUTO_SCROLL_EDGE_PX = 36;
const AUTO_SCROLL_MAX_PX = 18;

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

function sameIds(a, b) {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function createGallerySelection({ els, state, t, announceGalleryStatus }) {
  let pointer = null;
  let selectionBox = null;
  let suppressNextGridClick = false;
  let autoScrollFrame = 0;
  let selectionUpdateFrame = 0;
  let pendingSelectionPoint = null;
  let stackedAssetSetSource = null;
  let stackedAssetIds = new Set();

  function ensureSelectionSet() {
    if (!(state.selectedIds instanceof Set)) state.selectedIds = new Set(state.selectedIds || []);
    if (state.selectionProject !== state.project) {
      state.selectedIds.clear();
      state.selectionProject = state.project;
    }
    return state.selectedIds;
  }

  function loadedIds() {
    return new Set((state.assets || []).map((asset) => asset.id));
  }

  function currentStackedAssetIds() {
    if (stackedAssetSetSource !== state.assets) {
      stackedAssetSetSource = state.assets;
      stackedAssetIds = new Set((state.assets || []).filter((asset) => asset.stack?.id).map((asset) => asset.id));
    }
    return stackedAssetIds;
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
    if (prune) {
      const validIds = loadedIds();
      for (const id of selectedIds) if (!validIds.has(id)) selectedIds.delete(id);
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
    if (els.selectionSelectAll) els.selectionSelectAll.disabled = !state.assets.length || count >= state.assets.length;
    if (els.selectionClear) els.selectionClear.disabled = count === 0;
    if (els.selectionStack) {
      const stackedIds = currentStackedAssetIds();
      const includesExistingStack = [...selectedIds].some((id) => stackedIds.has(id));
      els.selectionStack.disabled = state.scope === "trash" || state.storageKind !== "sqlite" || count < 2 || includesExistingStack;
    }
    if (els.selectionRemoveFromStack) els.selectionRemoveFromStack.disabled = count === 0;
    return count;
  }

  function announceSelection() {
    const count = ensureSelectionSet().size;
    announceGalleryStatus?.(count ? t("batchSelected", { count }) : t("batchCancel"));
  }

  function commitSelection(nextSelection, { announce = false } = {}) {
    const current = ensureSelectionSet();
    const changedIds = new Set();
    for (const id of current) if (!nextSelection.has(id)) changedIds.add(id);
    for (const id of nextSelection) if (!current.has(id)) changedIds.add(id);
    if (!sameIds(current, nextSelection)) state.selectedIds = new Set(nextSelection);
    syncRenderedSelection({ prune: false, changedIds });
    if (announce) announceSelection();
  }

  function clear({ announce = false } = {}) {
    if (!ensureSelectionSet().size) return false;
    state.selectedIds = new Set();
    syncRenderedSelection({ prune: false });
    if (announce) announceSelection();
    return true;
  }

  function toggle(id, { announce = true } = {}) {
    if (!id) return false;
    const next = new Set(ensureSelectionSet());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    commitSelection(next, { announce });
    return true;
  }

  function selectAll({ announce = true } = {}) {
    const next = new Set((state.assets || []).map((asset) => asset.id));
    if (!next.size) return false;
    commitSelection(next, { announce });
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
    for (const entry of pointer.cardRects || []) if (rectsIntersect(rect, entry.rect)) next.add(entry.id);
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
    if (completedDrag && !canceled && pendingSelectionPoint) {
      updateDragSelection(pendingSelectionPoint.x, pendingSelectionPoint.y);
    }
    pointer = null;
    stopAutoScroll();
    removeSelectionBox();
    try { els.assetGrid?.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    if (canceled && completedDrag) commitSelection(baseSelection);
    else if (completedDrag) {
      announceSelection();
      window.setTimeout(() => { suppressNextGridClick = false; }, 0);
    }
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
    if (!(event.metaKey || event.ctrlKey)) return false;
    event.preventDefault();
    toggle(id, { announce: true });
    return true;
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
    // Browser-native image dragging competes with marquee pointer events when
    // the gesture begins directly on a thumbnail. MOSA has no internal card
    // drag operation, so suppress only drags originating from an asset card.
    els.assetGrid.addEventListener("dragstart", (event) => {
      if (event.target.closest?.(".asset-card")) event.preventDefault();
    });
    els.selectionSelectAll?.addEventListener("click", () => selectAll({ announce: true }));
    els.selectionClear?.addEventListener("click", () => clear({ announce: true }));
  }

  return {
    bind,
    clear,
    toggle,
    selectAll,
    syncRenderedSelection,
    handleGridClick,
    handleCardClick,
    selectedIds: () => new Set(ensureSelectionSet()),
  };
}
