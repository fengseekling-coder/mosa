const STACK_DRAG_THRESHOLD_PX = 8;

function emptyFacets() {
  return { source: "", group: "", category: "", style: "", conversation: "", generationBatch: "" };
}

function dragIdsForCard(state, assetId) {
  const selected = state.selectedIds instanceof Set ? state.selectedIds : new Set();
  if (selected.size > 1 && selected.has(assetId)) return [...selected];
  return [assetId];
}

function moveBlockBefore(items, movingIds, targetId) {
  return moveBlockRelative(items, movingIds, targetId, "before");
}

function moveBlockRelative(items, movingIds, targetId, placement = "before") {
  const moving = new Set(movingIds);
  const block = items.filter((id) => moving.has(id));
  const rest = items.filter((id) => !moving.has(id));
  let targetIndex = rest.indexOf(targetId);
  if (targetIndex < 0) targetIndex = rest.length;
  else if (placement === "after") targetIndex += 1;
  rest.splice(targetIndex, 0, ...block);
  return rest;
}

function stackViewIsUnfiltered(state) {
  if (!state.activeStackId) return false;
  if (state.query || state.scope !== "all" || (state.mediaKind && state.mediaKind !== "all")) return false;
  if (Object.values(state.facets || {}).some(Boolean)) return false;
  // Reorder sends the complete member order as one atomic replacement. With
  // paged Stacks, only allow the gesture after every member has been loaded so
  // a partial page can never overwrite or reject the unseen tail.
  return !state.nextCursor && state.assets.length >= Number(state.pageTotal || state.assets.length);
}

export function createAssetStackController({
  els,
  state,
  apiFetch,
  loadAssets,
  performFullGalleryReconciliation,
  librarySync,
  currentAssetRequest,
  renderGrid,
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
  let dropPlacement = "";
  let dropGroupTarget = null;
  let mutationInFlight = false;
  let suppressClickAfterDrag = false;
  let pointerMoveFrame = null;

  function clearDropTarget() {
    dropTarget?.classList.remove("stack-drop-target", "stack-reorder-target", "stack-reorder-before", "stack-reorder-after");
    dropTarget = null;
    dropPlacement = "";
    dropGroupTarget?.classList.remove("group-drop-target");
    dropGroupTarget = null;
  }

  function removeGhost() {
    ghost?.remove();
    ghost = null;
    document.body.classList.remove("asset-stack-dragging");
    clearDropTarget();
  }

  function releasePointerCapture(pointerId) {
    if (!els.assetGrid || pointerId == null) return;
    try {
      if (els.assetGrid.hasPointerCapture?.(pointerId)) els.assetGrid.releasePointerCapture(pointerId);
    } catch {
      // Pointer capture may already have been released by the browser/OS.
    }
  }

  function cancelPointerGesture({ releaseCapture = true } = {}) {
    const hadPointer = Boolean(pointer);
    const pointerId = pointer?.id;
    pointer = null;
    if (pointerMoveFrame !== null) cancelAnimationFrame(pointerMoveFrame);
    pointerMoveFrame = null;
    state.assetStackDragCandidate = false;
    state.assetStackDragging = false;
    if (releaseCapture && pointerId != null) releasePointerCapture(pointerId);
    removeGhost();
    return hadPointer;
  }

  function suppressSyntheticClick() {
    suppressClickAfterDrag = true;
    window.setTimeout(() => { suppressClickAfterDrag = false; }, 0);
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

  function setMutationBusy(busy) {
    mutationInFlight = Boolean(busy);
    if (els.stackBack) els.stackBack.disabled = mutationInFlight;
    if (mutationInFlight) {
      if (els.selectionStack) els.selectionStack.disabled = true;
      if (els.selectionRemoveFromStack) els.selectionRemoveFromStack.disabled = true;
    } else {
      gallerySelection.syncRenderedSelection({ prune: false });
    }
  }

  async function runStackMutation(task) {
    if (mutationInFlight) return false;
    setMutationBusy(true);
    try {
      return await task();
    } catch (error) {
      showToast?.(error?.message || String(error), "error");
      return false;
    } finally {
      setMutationBusy(false);
    }
  }

  async function enterStack(stackId, initialSummary = null) {
    if (!stackId || state.activeStackId) return false;
    if (typeof closeDetailSurface === "function" && !await closeDetailSurface()) return false;
    // Root gallery 快照：请求语义之外的整个已加载数据窗口（含数组引用、
    // 分页状态与 revision 时刻）原内存保留。逗留期间库同步把累计 delta 应用到
    // 快照（数据）并在退出时回放，root 窗口不再重新下载（二十二）。
    state.stackReturnSnapshot = {
      query: state.query,
      scope: state.scope,
      facets: { ...state.facets },
      sort: state.sort,
      mediaKind: state.mediaKind,
      scrollTop: els.assetGrid?.scrollTop || 0,
      selectedId: state.selectedId || "",
      selectedIds: [...(state.selectedIds instanceof Set ? state.selectedIds : new Set())],
      selectedStackNodes: [...(state.selectedStackNodes instanceof Map ? state.selectedStackNodes : new Map())],
      loadedPageCount: Math.max(1, Number(state.loadedPageCount) || 1),
      loadedAssetCount: Math.max(0, Number(state.loadedAssetCount) || 0),
      stackId,
      rootView: {
        request: currentAssetRequest
          ? { ...currentAssetRequest(), stackId: "" }
          : null,
        assets: state.assets,
        pageTotal: state.pageTotal,
        nextCursor: state.nextCursor,
        loadedPageCount: Math.max(1, Number(state.loadedPageCount) || 1),
        loadedAssetCount: Math.max(0, Number(state.loadedAssetCount) || 0),
        pending: [],
        degraded: false,
      },
    };
    state.activeStackId = stackId;
    state.activeStackSummary = initialSummary ? { ...initialSummary, id: stackId } : null;
    // Keep the root search/filter context when opening a Stack. Root gallery
    // search can match hidden members, so clearing refinements here made users
    // lose the exact member(s) that caused the Stack to appear. Any refinements
    // changed while inside are still discarded on exit in favor of this root
    // snapshot, preserving the previous navigation contract.
    state.selectedId = null;
    gallerySelection.clear();
    syncChrome();
    const loaded = await loadAssets({ preserveScroll: false });
    if (!loaded) return false;
    syncChrome();
    els.assetGrid?.focus({ preventScroll: true });
    return true;
  }

  async function restoreRootFromSnapshot(snapshot) {
    const root = snapshot.rootView;
    if (!root || root.degraded) return false;
    state.assets = root.assets;
    state.pageTotal = Number(root.pageTotal) || 0;
    state.nextCursor = root.nextCursor || null;
    state.loadedPageCount = Math.max(1, Number(root.loadedPageCount) || 1);
    state.loadedAssetCount = Math.max(0, Number(root.loadedAssetCount) || 0);
    state.galleryStatus = "ready";
    state.galleryError = null;
    // 回放逗留期间积压的 delta（幂等；此时 currentAssetRequest 已恢复为 root 请求）。
    // 提交由下方的整体 renderGrid 完成，这里只做数据 reconcile。
    if (typeof librarySync?.applyRootSnapshotPendingChanges === "function") {
      const applied = await librarySync.applyRootSnapshotPendingChanges(root);
      if (applied === false) return false;
    }
    // 与 loadAssets 相同的选中项/Inspector 快照清理语义。
    if (state.detailAsset && state.assets.some((asset) => asset.id === state.detailAsset.id && asset.project_id === state.detailAsset.project_id)) state.detailAsset = null;
    if (state.selectedId && !state.assets.some((asset) => asset.id === state.selectedId)
      && !(state.detailAsset?.id === state.selectedId)) state.selectedId = null;
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
    let loaded = await restoreRootFromSnapshot(snapshot);
    if (!loaded) {
      // 快照缺失或已 degraded（journal gap 等）：全量恢复是最后手段。
      loaded = typeof performFullGalleryReconciliation === "function"
        ? await performFullGalleryReconciliation({ background: false })
        : await loadAssets({ preserveScroll: false });
    }
    if (loaded) {
      renderGrid({ preserveScroll: true });
      updateViewTitle();
      requestAnimationFrame(() => {
        if (!els.assetGrid) return;
        const maxScrollTop = Math.max(0, els.assetGrid.scrollHeight - els.assetGrid.clientHeight);
        els.assetGrid.scrollTop = Math.min(Number(snapshot.scrollTop || 0), maxScrollTop);
        const stackCard = snapshot.stackId
          ? els.assetGrid.querySelector(`.asset-card[data-stack-id="${CSS.escape(snapshot.stackId)}"]`)
          : null;
        const fallbackCard = snapshot.selectedId
          ? els.assetGrid.querySelector(`.asset-card[data-id="${CSS.escape(snapshot.selectedId)}"]`)
          : null;
        const returnCard = stackCard || fallbackCard;
        if (returnCard?.dataset.id) state.selectedId = returnCard.dataset.id;
        const visibleIds = new Set((state.assets || []).map((asset) => asset.id));
        state.selectedIds = new Set((snapshot.selectedIds || []).filter((id) => visibleIds.has(id)));
        state.selectedStackNodes = new Map((snapshot.selectedStackNodes || []).filter(([id]) => visibleIds.has(id)));
        els.assetGrid.querySelectorAll(":scope > .asset-card").forEach((card) => {
          card.classList.toggle("selected", Boolean(state.selectedId && card.dataset.id === state.selectedId));
        });
        gallerySelection.syncRenderedSelection({ prune: false });
        returnCard?.querySelector(".asset-card-select")?.focus({ preventScroll: true });
        if (!returnCard) els.assetGrid.focus({ preventScroll: true });
      });
    }
    syncChrome();
    return loaded;
  }

  async function createStackFromSelection(coverAssetId = "") {
    if (state.activeStackId || state.scope === "trash" || state.storageKind !== "sqlite") return false;
    if (gallerySelection.hasSelectedStacks?.()) return false;
    const selectedIds = [...(state.selectedIds instanceof Set ? state.selectedIds : new Set())];
    if (selectedIds.length < 2) return false;
    const coverId = coverAssetId && selectedIds.includes(coverAssetId)
      ? coverAssetId
      : (state.assets.find((asset) => state.selectedIds.has(asset.id))?.id || selectedIds[0]);
    return runStackMutation(async () => {
      const result = await apiFetch("/api/asset-stacks", {
        method: "POST",
        body: { projectId: state.project, assetIds: selectedIds, coverAssetId: coverId },
      });
      gallerySelection.clear();
      // 本地增量：N 张成员卡 → 1 张 Stack 节点卡；随后到达的 SSE delta 幂等。
      await librarySync.applyLocalChanges([{
        kind: "stack-created",
        entityType: "stack",
        entityId: result?.stack?.id || "",
        assetIds: selectedIds,
        detail: { coverAssetId: coverId },
      }]);
      showToast?.(t("stackCreated", { count: selectedIds.length }), "success");
      return true;
    });
  }

  async function removeSelectedFromStack() {
    if (!state.activeStackId) return false;
    const ids = [...(state.selectedIds instanceof Set ? state.selectedIds : new Set())];
    if (!ids.length) return false;
    return runStackMutation(async () => {
      const result = await apiFetch(`/api/asset-stacks/${encodeURIComponent(state.activeStackId)}/assets`, {
        method: "DELETE",
        body: { projectId: state.project, assetIds: ids },
      });
      gallerySelection.clear();
      if (result.dissolved) {
        await librarySync.applyLocalChanges([{
          kind: "stack-dissolved",
          entityType: "stack",
          entityId: state.activeStackId,
          assetIds: [...(result.assetIds || ids)],
        }]);
        showToast?.(t("stackDissolved"), "success");
        await exitStack();
        return true;
      }
      // Stack 视图内：受影响成员行就地 reconcile（移除的成员从视图消失，
      // Stack 计数同步），root 快照由增量层并行更新。
      await librarySync.applyLocalChanges([{
        kind: "stack-members-changed",
        entityType: "stack",
        entityId: state.activeStackId,
        assetIds: ids,
      }]);
      showToast?.(t("stackAssetsRemoved", { count: ids.length }), "success");
      return true;
    });
  }

  function beginPointer(event) {
    if (mutationInFlight) return;
    if (state.scope === "trash") return;
    if (!state.activeStackId && state.storageKind !== "sqlite") return;
    if (event.button !== 0 || event.isPrimary === false || event.pointerType === "touch") return;
    // Shift-drag belongs to additive marquee selection even when the pointer
    // begins on an already batch-selected card.
    if (event.shiftKey) return;
    if (event.target.closest?.(".card-action-btn, input, textarea, select, [contenteditable], a[href]")) return;
    const card = event.target.closest?.(".asset-card");
    if (!card) return;
    const assetId = card.dataset.id;
    if (!assetId) return;
    // A card press owns the drag gesture immediately, even before that card has
    // been single-click selected. This removes the extra "click once, then
    // drag" step and, more importantly, prevents an unselected card drag from
    // falling through to gallery marquee selection. dragIdsForCard() still
    // preserves an existing multi-selection when the pressed card belongs to it.
    const candidateIds = dragIdsForCard(state, assetId);
    if (state.activeStackId) {
      if (!stackViewIsUnfiltered(state)) return;
    } else {
      // A collapsed Stack is a logical node, not a draggable member asset.
      // Let users drag ordinary assets *into* a Stack, but never drag a Stack
      // itself into another Stack or accidentally mutate only its cover.
      if (candidateIds.some((id) => state.assets.find((asset) => asset.id === id)?.stack?.id)) return;
    }
    pointer = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      assetId,
      assetIds: candidateIds,
      dragging: false,
    };
    state.assetStackDragCandidate = true;
  }

  function targetCardAt(clientX, clientY) {
    const element = document.elementFromPoint(clientX, clientY);
    return element?.closest?.(".asset-card") || null;
  }

  // 拖拽入组：侧边栏分组项（data-filter="group"）与“待整理”项都是合法投放目标。
  // 命中分组即高亮；松手后走批量归属接口。
  function targetGroupAt(clientX, clientY) {
    const element = document.elementFromPoint(clientX, clientY);
    const item = element?.closest?.('[data-filter="group"][data-value], [data-filter="unorganized"]');
    return item;
  }

  function flushPointerMove() {
    pointerMoveFrame = null;
    if (!pointer?.dragging) return;
    const clientX = pointer.lastX;
    const clientY = pointer.lastY;
    const marker = createGhost(pointer.assetIds.length);
    marker.style.transform = `translate3d(${clientX + 12}px, ${clientY + 12}px, 0)`;
    // 侧边栏目标优先于画廊卡片：指针进入侧边栏后分组目标接管高亮，
    // 同时清掉画廊卡片的高亮残留。
    const groupItem = state.activeStackId ? null : targetGroupAt(clientX, clientY);
    if (groupItem) {
      const next = groupItem.dataset.filter === "group" ? groupItem.dataset.value : "";
      const changed = dropGroupTarget !== groupItem || dropGroupTarget?.dataset.value !== next;
      if (changed) clearDropTarget();
      dropGroupTarget = groupItem;
      groupItem.classList.add("group-drop-target");
      return;
    }
    if (dropGroupTarget) clearDropTarget();
    const target = targetCardAt(clientX, clientY);
    if (target !== dropTarget) clearDropTarget();
    if (!target) return;
    const targetId = target.dataset.id;
    if (!targetId) return;
    if (state.activeStackId) {
      if (pointer.assetIds.includes(targetId)) return;
      dropTarget = target;
      target.classList.add("stack-reorder-target");
      const rect = target.getBoundingClientRect();
      dropPlacement = clientX < rect.left + rect.width / 2 ? "before" : "after";
      target.classList.add(dropPlacement === "after" ? "stack-reorder-after" : "stack-reorder-before");
      return;
    }
    const targetAsset = state.assets.find((asset) => asset.id === targetId);
    if (!targetAsset) return;
    dropTarget = target;
    target.classList.add("stack-drop-target");
  }

  function movePointer(event) {
    if (!pointer || pointer.id !== event.pointerId) return;
    pointer.lastX = event.clientX;
    pointer.lastY = event.clientY;
    if (!pointer.dragging) {
      if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) < STACK_DRAG_THRESHOLD_PX) return;
      pointer.dragging = true;
      state.assetStackDragging = true;
      try { els.assetGrid?.setPointerCapture(event.pointerId); } catch { /* global listeners keep the gesture alive */ }
      document.body.classList.add("asset-stack-dragging");
    }
    event.preventDefault();
    if (pointerMoveFrame === null) pointerMoveFrame = requestAnimationFrame(flushPointerMove);
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
      await librarySync.applyLocalChanges([{
        kind: "stack-members-changed",
        entityType: "stack",
        entityId: targetAsset.stack.id,
        assetIds: toAdd,
      }]);
      showToast?.(t("stackAssetsAdded", { count: toAdd.length }), "success");
      return true;
    }
    // Dropping a multi-selection back onto one of its own members is a common
    // tiny mouse-jitter path. Treat it as a no-op instead of unexpectedly
    // creating a new Stack from the selection.
    if (movingIds.includes(targetId)) return false;
    const ids = [...movingIds, targetId];
    if (ids.length < 2) return false;
    const result = await apiFetch("/api/asset-stacks", {
      method: "POST",
      body: { projectId: state.project, assetIds: ids, coverAssetId: targetId },
    });
    gallerySelection.clear();
    await librarySync.applyLocalChanges([{
      kind: "stack-created",
      entityType: "stack",
      entityId: result?.stack?.id || "",
      assetIds: ids,
      detail: { coverAssetId: targetId },
    }]);
    showToast?.(t("stackCreated", { count: ids.length }), "success");
    return true;
  }

  async function finishReorder(targetId, drag, placement) {
    if (!targetId || drag.assetIds.includes(targetId)) return false;
    const currentIds = state.assets.map((asset) => asset.id);
    const nextIds = moveBlockRelative(currentIds, drag.assetIds, targetId, placement);
    if (nextIds.join("\u001f") === currentIds.join("\u001f")) return false;
    try {
      await apiFetch(`/api/asset-stacks/${encodeURIComponent(state.activeStackId)}/order`, {
        method: "PATCH",
        body: { projectId: state.project, assetIds: nextIds },
      });
    } catch (error) {
      if (error?.code !== "STACK_ORDER_MISMATCH") throw error;
      // A concurrent membership change can legitimately make the drag snapshot
      // stale between pointerdown and PATCH. Refresh from the server and surface
      // a recovery message instead of leaking the store's validation prose.
      await loadAssets({ preserveScroll: true });
      const staleOrderError = new Error(t("stackOrderChanged"));
      staleOrderError.code = error.code;
      throw staleOrderError;
    }
    await librarySync.applyLocalChanges([{
      kind: "stack-order-changed",
      entityType: "stack",
      entityId: state.activeStackId,
      assetIds: nextIds,
    }]);
    return true;
  }

  function endPointer(event, { canceled = false } = {}) {
    if (!pointer || pointer.id !== event.pointerId) return;
    // A synthetic/test gesture (and a very fast real gesture) can deliver
    // pointerup before the coalesced animation frame runs. Resolve the latest
    // pointer position synchronously so the drop target is never lost.
    if (pointerMoveFrame !== null) {
      cancelAnimationFrame(pointerMoveFrame);
      pointerMoveFrame = null;
      flushPointerMove();
    }
    const drag = pointer;
    const completed = drag.dragging;
    const targetId = dropTarget?.dataset.id || "";
    const placement = dropPlacement;
    pointer = null;
    state.assetStackDragCandidate = false;
    state.assetStackDragging = false;
    releasePointerCapture(drag.id);
    removeGhost();
    if (!completed || canceled) {
      return;
    }
    suppressSyntheticClick();
    event.preventDefault();
    // 侧边栏投放优先：分组项 → 移入该组；“待整理”项 → 移出分组。
    if (dropGroupTarget) {
      const item = dropGroupTarget;
      const filter = item.dataset.filter;
      const value = filter === "group" ? item.dataset.value : "";
      void runStackMutation(() => finishGroupDrop(drag.assetIds, value));
      return;
    }
    if (!targetId) return;
    void runStackMutation(() => state.activeStackId
      ? finishReorder(targetId, drag, placement)
      : finishRootDrop(targetId, drag));
  }

  /** 批量改归属 + 本地增量（assets-updated 带 group 标志）。 */
  async function finishGroupDrop(assetIds, groupName) {
    if (!assetIds.length) return false;
    await apiFetch("/api/assets/batch", {
      method: "POST",
      body: { action: "group", projectId: state.project, assetIds: [...assetIds], group: groupName },
    });
    gallerySelection.clear();
    await librarySync.applyLocalChanges([{
      kind: "assets-updated",
      entityType: "asset-batch",
      entityId: "group-assignment",
      assetIds: [...assetIds],
      flags: ["group"],
    }]);
    showToast(groupName
      ? t("moveToGroupCount", { count: assetIds.length, group: groupName })
      : t("removeFromGroupCount", { count: assetIds.length }), "success");
    return true;
  }

  function abandonStackContext() {
    cancelPointerGesture();
    state.activeStackId = "";
    state.activeStackSummary = null;
    state.stackReturnSnapshot = null;
    gallerySelection.clear();
    syncChrome();
  }

  function isBusy() {
    return mutationInFlight;
  }

  function bind() {
    els.assetGrid?.addEventListener("pointerdown", beginPointer);
    els.assetGrid?.addEventListener("click", (event) => {
      if (!suppressClickAfterDrag) return;
      suppressClickAfterDrag = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true });
    els.assetGrid?.addEventListener("lostpointercapture", () => {
      if (pointer?.dragging) cancelPointerGesture({ releaseCapture: false });
    });
    window.addEventListener("pointermove", movePointer, { passive: false });
    window.addEventListener("pointerup", endPointer);
    window.addEventListener("pointercancel", (event) => endPointer(event, { canceled: true }));
    window.addEventListener("blur", () => { cancelPointerGesture(); });
    els.stackBack?.addEventListener("click", () => { void exitStack(); });
    els.selectionStack?.addEventListener("click", () => { void createStackFromSelection(); });
    els.selectionRemoveFromStack?.addEventListener("click", () => { void removeSelectedFromStack(); });
    window.addEventListener("mosa:active-stack-missing", (event) => {
      if (!state.activeStackId || event.detail?.stackId !== state.activeStackId) return;
      void exitStack();
    });
    window.addEventListener("mosa:open-stack", (event) => {
      if (state.activeStackId || !event.detail?.stackId) return;
      void enterStack(event.detail.stackId, event.detail.stack || null);
    });
    syncChrome();
  }

  return {
    bind,
    enterStack,
    exitStack,
    createStackFromSelection,
    removeSelectedFromStack,
    abandonStackContext,
    isBusy,
    syncChrome,
  };
}

export { moveBlockBefore, moveBlockRelative };
