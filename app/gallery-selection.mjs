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

  function syncRenderedSelection({ prune = true } = {}) {
    const selectedIds = ensureSelectionSet();
    if (prune) {
      const validIds = loadedIds();
      for (const id of selectedIds) if (!validIds.has(id)) selectedIds.delete(id);
    }

    els.assetGrid?.querySelectorAll(":scope > .asset-card").forEach((card) => {
      const id = card.dataset.id;
      const multiSelected = selectedIds.has(id);
      const detailSelected = id === state.selectedId;
      card.classList.toggle("multi-selected", multiSelected);
      card.querySelector(".asset-card-select")?.setAttribute("aria-pressed", String(detailSelected || multiSelected));
    });

    const count = selectedIds.size;
    if (els.selectionBar) els.selectionBar.hidden = count === 0;
    els.assetGrid?.classList.toggle("selection-active", count > 0);
    if (els.selectionCount) els.selectionCount.textContent = t("batchSelected", { count });
    if (els.selectionSelectAll) els.selectionSelectAll.disabled = !state.assets.length || count >= state.assets.length;
    if (els.selectionClear) els.selectionClear.disabled = count === 0;
    if (els.selectionStack) {
      const includesExistingStack = (state.assets || []).some((asset) => selectedIds.has(asset.id) && asset.stack?.id);
      els.selectionStack.disabled = count < 2 || includesExistingStack;
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
    if (!sameIds(current, nextSelection)) state.selectedIds = new Set(nextSelection);
    syncRenderedSelection({ prune: false });
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

  function updateDragSelection(clientX, clientY) {
    if (!pointer?.dragging || !els.assetGrid) return;
    const bounds = els.assetGrid.getBoundingClientRect();
    const x = clamp(clientX, bounds.left, bounds.right);
    const y = clamp(clientY, bounds.top, bounds.bottom);
    pointer.lastX = x;
    pointer.lastY = y;
    const rect = rectFromPoints(pointer.startX, pointer.startY, x, y);
    const box = createSelectionBox();
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;

    const next = pointer.additive ? new Set(pointer.baseSelection) : new Set();
    // When a marquee starts on top of a card, that origin card is part of the
    // user's intended sweep even for a right-to-left / bottom-to-top drag.
    // Keeping it explicitly also avoids a one-pixel boundary miss at the exact
    // pointer origin and keeps the first card selected during auto-scroll.
    if (pointer.startCardId) next.add(pointer.startCardId);
    els.assetGrid.querySelectorAll(":scope > .asset-card").forEach((card) => {
      const id = card.dataset.id;
      if (id && rectsIntersect(rect, card.getBoundingClientRect())) next.add(id);
    });
    commitSelection(next);
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
      try { els.assetGrid?.setPointerCapture(event.pointerId); } catch { /* global listeners still keep the gesture alive */ }
      document.body.classList.add("marquee-selecting");
      suppressNextGridClick = true;
    }
    event.preventDefault();
    updateDragSelection(event.clientX, event.clientY);
    scheduleAutoScroll();
  }

  function endPointer(event, { canceled = false } = {}) {
    if (!pointer || pointer.id !== event.pointerId) return;
    const completedDrag = pointer.dragging;
    const baseSelection = pointer.baseSelection;
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
