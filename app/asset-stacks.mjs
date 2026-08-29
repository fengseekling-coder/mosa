const STACK_DRAG_THRESHOLD_PX = 4;

function emptyFacets() {
  return { source: "", group: "", category: "", style: "", conversation: "", generationBatch: "" };
}

function dragIdsForCard(state, assetId) {
  const selected = state.selectedIds instanceof Set ? state.selectedIds : new Set();
  if (selected.size > 1 && selected.has(assetId)) return [...selected];
  return [assetId];
}

function moveBlockBefore(items, movingIds, targetId) {
  const moving = new Set(movingIds);
  const block = items.filter((id) => moving.has(id));
  const rest = items.filter((id) => !moving.has(id));
  let targetIndex = rest.indexOf(targetId);
  if (targetIndex < 0) targetIndex = rest.length;
  rest.splice(targetIndex, 0, ...block);
  return rest;
}

function stackViewIsUnfiltered(state) {
  if (!state.activeStackId) return false;
  if (state.query || state.scope !== "all" || (state.mediaKind && state.mediaKind !== "all")) return false;
  return !Object.values(state.facets || {}).some(Boolean);
}

export function createAssetStackController({
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
}) {
  let pointer = null;
  let ghost = null;
  let dropTarget = null;

  function clearDropTarget() {
    dropTarget?.classList.remove("stack-drop-target", "stack-reorder-target");
    dropTarget = null;
  }

  function removeGhost() {
    ghost?.remove();
    ghost = null;
    document.body.classList.remove("asset-stack-dragging");
    clearDropTarget();
  }

  function createGhost(count) {
    if (ghost?.isConnected) return ghost;
    ghost = document.createElement("div");
    ghost.className = "asset-stack-drag-ghost";
    ghost.textContent = count > 1 ? String(count) : "";
    document.body.append(ghost);
    return ghost;
  }

  function syncChrome() {
    const inside = Boolean(state.activeStackId);
    if (els.stackBack) els.stackBack.hidden = !inside;
    if (els.sortSelect) els.sortSelect.closest(".sort-control")?.toggleAttribute("hidden", inside);
    if (els.selectionStack) els.selectionStack.hidden = inside;
    if (els.selectionRemoveFromStack) els.selectionRemoveFromStack.hidden = !inside;
    renderQuickFilters();
    updateViewTitle();
  }

  async function enterStack(stackId, initialSummary = null) {
    if (!stackId || state.activeStackId) return false;
    if (typeof closeDetailSurface === "function" && !await closeDetailSurface()) return false;
    state.stackReturnSnapshot = {
      query: state.query,
      scope: state.scope,
      facets: { ...state.facets },
      sort: state.sort,
      mediaKind: state.mediaKind,
      scrollTop: els.assetGrid?.scrollTop || 0,
    };
    state.activeStackId = stackId;
    state.activeStackSummary = initialSummary ? { ...initialSummary, id: stackId } : null;
    state.query = "";
    state.scope = "all";
    state.facets = emptyFacets();
    state.mediaKind = "all";
    state.selectedId = null;
    gallerySelection.clear();
    if (els.searchInput) els.searchInput.value = "";
    syncChrome();
    const loaded = await loadAssets({ preserveScroll: false });
    if (!loaded) return false;
    syncChrome();
    els.assetGrid?.focus({ preventScroll: true });
    return true;
  }

  async function exitStack() {
    if (!state.activeStackId) return false;
    if (typeof closeDetailSurface === "function" && !await closeDetailSurface()) return false;
    const snapshot = state.stackReturnSnapshot || {};
    state.activeStackId = "";
    state.activeStackSummary = null;
    state.stackReturnSnapshot = null;
    state.query = snapshot.query || "";
    state.scope = snapshot.scope || "all";
    state.facets = { ...emptyFacets(), ...(snapshot.facets || {}) };
    state.sort = snapshot.sort || state.sort;
    state.mediaKind = snapshot.mediaKind || "all";
    state.selectedId = null;
    gallerySelection.clear();
    if (els.searchInput) els.searchInput.value = state.query;
    if (els.sortSelect) els.sortSelect.value = state.sort;
    syncChrome();
    const loaded = await loadAssets({ preserveScroll: false });
    if (loaded) {
      requestAnimationFrame(() => {
        if (!els.assetGrid) return;
        const maxScrollTop = Math.max(0, els.assetGrid.scrollHeight - els.assetGrid.clientHeight);
        els.assetGrid.scrollTop = Math.min(Number(snapshot.scrollTop || 0), maxScrollTop);
      });
    }
    syncChrome();
    return loaded;
  }

  async function createStackFromSelection(coverAssetId = "") {
    if (state.activeStackId) return false;
    const selectedIds = [...(state.selectedIds instanceof Set ? state.selectedIds : new Set())];
    if (selectedIds.length < 2) return false;
    const coverId = coverAssetId && selectedIds.includes(coverAssetId)
      ? coverAssetId
      : (state.assets.find((asset) => state.selectedIds.has(asset.id))?.id || selectedIds[0]);
    await apiFetch("/api/asset-stacks", {
      method: "POST",
      body: { projectId: state.project, assetIds: selectedIds, coverAssetId: coverId },
    });
    gallerySelection.clear();
    await loadAssets({ preserveScroll: true });
    showToast?.(t("stackCreated", { count: selectedIds.length }), "success");
    return true;
  }

  async function removeSelectedFromStack() {
    if (!state.activeStackId) return false;
    const ids = [...(state.selectedIds instanceof Set ? state.selectedIds : new Set())];
    if (!ids.length) return false;
    const result = await apiFetch(`/api/asset-stacks/${encodeURIComponent(state.activeStackId)}/assets`, {
      method: "DELETE",
      body: { projectId: state.project, assetIds: ids },
    });
    gallerySelection.clear();
    if (result.dissolved) {
      showToast?.(t("stackDissolved"), "success");
      await exitStack();
      return true;
    }
    await loadAssets({ preserveScroll: true });
    showToast?.(t("stackAssetsRemoved", { count: ids.length }), "success");
    return true;
  }

  function beginPointer(event) {
    if (event.button !== 0 || event.isPrimary === false || event.pointerType === "touch") return;
    // Shift-drag belongs to additive marquee selection even when the pointer
    // begins on an already batch-selected card.
    if (event.shiftKey) return;
    if (event.target.closest?.(".card-action-btn, input, textarea, select, [contenteditable], a[href]")) return;
    const card = event.target.closest?.(".asset-card");
    if (!card) return;
    const assetId = card.dataset.id;
    if (!assetId) return;
    const selected = state.selectedIds instanceof Set ? state.selectedIds : new Set();
    // Desktop-style arbitration: once a card is already selected, the next
    // press-drag belongs to moving that asset (or the explicit batch selection),
    // not to starting a marquee over it. An unselected card still remains a
    // valid marquee origin, so selection can begin from anywhere in the grid.
    const isSelectedForDrag = selected.has(assetId) || state.selectedId === assetId;
    if (state.activeStackId) {
      if (!stackViewIsUnfiltered(state)) return;
      if (!isSelectedForDrag) return;
    } else if (!(selected.has(assetId) || state.selectedId === assetId)) return;
    pointer = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      assetId,
      assetIds: dragIdsForCard(state, assetId),
      dragging: false,
    };
    state.assetStackDragCandidate = true;
  }

  function targetCardAt(clientX, clientY) {
    const element = document.elementFromPoint(clientX, clientY);
    return element?.closest?.(".asset-card") || null;
  }

  function movePointer(event) {
    if (!pointer || pointer.id !== event.pointerId) return;
    pointer.lastX = event.clientX;
    pointer.lastY = event.clientY;
    if (!pointer.dragging) {
      if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) < STACK_DRAG_THRESHOLD_PX) return;
      pointer.dragging = true;
      state.assetStackDragging = true;
      document.body.classList.add("asset-stack-dragging");
    }
    event.preventDefault();
    const marker = createGhost(pointer.assetIds.length);
    marker.style.transform = `translate3d(${event.clientX + 12}px, ${event.clientY + 12}px, 0)`;
    const target = targetCardAt(event.clientX, event.clientY);
    if (target !== dropTarget) clearDropTarget();
    if (!target) return;
    const targetId = target.dataset.id;
    if (!targetId) return;
    if (state.activeStackId) {
      if (pointer.assetIds.includes(targetId) && pointer.assetIds.length === 1) return;
      dropTarget = target;
      target.classList.add("stack-reorder-target");
      return;
    }
    const targetAsset = state.assets.find((asset) => asset.id === targetId);
    if (!targetAsset) return;
    dropTarget = target;
    target.classList.add("stack-drop-target");
  }

  async function finishRootDrop(targetId, drag) {
    const targetAsset = state.assets.find((asset) => asset.id === targetId);
    if (!targetAsset) return false;
    const movingIds = [...drag.assetIds];
    if (targetAsset.stack?.id) {
      const toAdd = movingIds.filter((id) => id !== targetId);
      if (!toAdd.length) return false;
      await apiFetch(`/api/asset-stacks/${encodeURIComponent(targetAsset.stack.id)}/assets`, {
        method: "POST",
        body: { projectId: state.project, assetIds: toAdd },
      });
      gallerySelection.clear();
      await loadAssets({ preserveScroll: true });
      showToast?.(t("stackAssetsAdded", { count: toAdd.length }), "success");
      return true;
    }
    const ids = movingIds.includes(targetId) ? movingIds : [...movingIds, targetId];
    if (ids.length < 2) return false;
    await apiFetch("/api/asset-stacks", {
      method: "POST",
      body: { projectId: state.project, assetIds: ids, coverAssetId: targetId },
    });
    gallerySelection.clear();
    await loadAssets({ preserveScroll: true });
    showToast?.(t("stackCreated", { count: ids.length }), "success");
    return true;
  }

  async function finishReorder(targetId, drag) {
    const currentIds = state.assets.map((asset) => asset.id);
    const nextIds = moveBlockBefore(currentIds, drag.assetIds, targetId);
    if (nextIds.join("\u001f") === currentIds.join("\u001f")) return false;
    await apiFetch(`/api/asset-stacks/${encodeURIComponent(state.activeStackId)}/order`, {
      method: "PATCH",
      body: { projectId: state.project, assetIds: nextIds },
    });
    await loadAssets({ preserveScroll: true });
    return true;
  }

  function endPointer(event, { canceled = false } = {}) {
    if (!pointer || pointer.id !== event.pointerId) return;
    const drag = pointer;
    const completed = drag.dragging;
    const targetId = dropTarget?.dataset.id || "";
    pointer = null;
    state.assetStackDragCandidate = false;
    state.assetStackDragging = false;
    removeGhost();
    if (!completed || canceled) {
      return;
    }
    event.preventDefault();
    const task = state.activeStackId ? finishReorder(targetId, drag) : finishRootDrop(targetId, drag);
    Promise.resolve(task).catch((error) => showToast?.(error.message || String(error), "error"));
  }

  function bind() {
    els.assetGrid?.addEventListener("pointerdown", beginPointer);
    window.addEventListener("pointermove", movePointer, { passive: false });
    window.addEventListener("pointerup", endPointer);
    window.addEventListener("pointercancel", (event) => endPointer(event, { canceled: true }));
    els.stackBack?.addEventListener("click", () => { void exitStack(); });
    els.selectionStack?.addEventListener("click", () => { void createStackFromSelection(); });
    els.selectionRemoveFromStack?.addEventListener("click", () => { void removeSelectedFromStack(); });
    window.addEventListener("mosa:active-stack-missing", (event) => {
      if (!state.activeStackId || event.detail?.stackId !== state.activeStackId) return;
      void exitStack();
    });
    syncChrome();
  }

  return {
    bind,
    enterStack,
    exitStack,
    createStackFromSelection,
    removeSelectedFromStack,
    syncChrome,
  };
}

export { moveBlockBefore };
