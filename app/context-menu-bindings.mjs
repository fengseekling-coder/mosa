/**
 * Keeps the context-menu integration separate from the library's general
 * click, keyboard, and modal event wiring. The actions themselves remain in
 * context-menu-actions.mjs; this module only translates DOM events to those
 * actions and to existing application callbacks.
 */
export function bindContextMenuEvents(options = {}) {
  const {
    state,
    els,
    contextMenu,
    contextMenuActions,
    loadAssets,
    loadStats,
    reloadLoadedAssetPages,
    renderGrid,
    updateViewTitle,
    selectAsset,
    openAssetView,
    showToast,
    t,
    gallerySelection,
  } = options;

  const bindGroupContextMenu = (list) => list?.addEventListener("contextmenu", (event) => {
    const groupItem = event.target.closest("[data-filter][data-value]");
    if (!groupItem) return;
    event.preventDefault();

    const groupName = groupItem.dataset.value;
    const groupEntry = state.groups.groups.find((entry) => entry[0] === groupName);
    if (!groupEntry) return;

    // Convert array format [name, count] to object format for menu actions
    const group = {
      id: groupName,
      name: groupName,
      count: groupEntry[1],
      color: groupItem.querySelector("[data-group-color]")?.dataset.groupColor || "#6366f1"
    };

    contextMenu.show({
      items: contextMenuActions.getNavItemMenu(group, "group"),
      x: event.clientX,
      y: event.clientY,
      target: groupItem,
    });
  });
  bindGroupContextMenu(els.sidebarGroupList);
  bindGroupContextMenu(els.sidebarManualGroupList);

  els.assetGrid?.addEventListener("contextmenu", (event) => {
    const card = event.target.closest(".asset-card");
    event.preventDefault();

    if (!card) {
      contextMenu.show({
        items: contextMenuActions.getEmptyGridMenu(),
        x: event.clientX,
        y: event.clientY,
        target: els.assetGrid,
      });
      return;
    }

    const asset = state.assets.find((entry) => entry.id === card.dataset.id);
    if (!asset) return;
    let selectedIds = state.selectedIds instanceof Set ? state.selectedIds : new Set();
    if (!selectedIds.has(asset.id)) {
      gallerySelection?.replaceWith?.(asset.id);
      selectedIds = state.selectedIds instanceof Set ? state.selectedIds : new Set([asset.id]);
    }
    const selectedAssets = state.assets.filter((entry) => selectedIds.has(entry.id));
    contextMenu.show({
      items: contextMenuActions.getAssetMenu(asset, selectedAssets, {
        stackNode: !state.activeStackId && Boolean(asset.stack?.id),
        selectionCount: selectedIds.size,
      }),
      x: event.clientX,
      y: event.clientY,
      target: card,
    });
  });

  function applyImmediateAssetRemoval(assetIds = []) {
    const removedIds = new Set((assetIds || []).map((id) => String(id || "")).filter(Boolean));
    if (!removedIds.size) return 0;
    const beforeCount = state.assets.length;
    state.assets = state.assets.filter((asset) => !removedIds.has(String(asset?.id || "")));
    const removedVisibleCount = beforeCount - state.assets.length;
    if (!removedVisibleCount) return 0;
    if (state.selectedIds instanceof Set) {
      for (const id of removedIds) state.selectedIds.delete(id);
    }
    if (state.selectedStackNodes instanceof Map) {
      for (const id of removedIds) state.selectedStackNodes.delete(id);
    }
    if (Number.isFinite(Number(state.pageTotal))) {
      state.pageTotal = Math.max(state.assets.length, Number(state.pageTotal) - removedVisibleCount);
    }
    renderGrid?.({ preserveScroll: true });
    updateViewTitle?.();
    return removedVisibleCount;
  }

  window.addEventListener("mosa:refresh-assets", (event) => {
    applyImmediateAssetRemoval(event.detail?.removedAssetIds);
    // Same-result refreshes preserve gallery scroll centrally in loadAssets /
    // renderGrid. If the user already loaded multiple pages, refresh the same
    // loaded window instead of collapsing back to page one after a mutation.
    const assetRefresh = typeof reloadLoadedAssetPages === "function" && state.loadedPageCount > 1
      ? reloadLoadedAssetPages({ background: true })
      : loadAssets({ background: true });
    void Promise.allSettled([loadStats({ background: true }), assetRefresh]).then((results) => {
      const failure = results.find((result) => result.status === "rejected");
      if (failure) console.warn("Context-menu refresh failed:", failure.reason);
    });
  });
  window.addEventListener("mosa:refresh-groups", () => {
    void loadStats().catch((error) => console.warn("Group refresh failed:", error));
  });
  window.addEventListener("mosa:rename-group", (event) => {
    const groupName = String(event.detail?.groupName || "");
    if (groupName) window.dispatchEvent(new CustomEvent("mosa:begin-sidebar-group-rename", { detail: { groupName } }));
  });
  window.addEventListener("mosa:select-asset", (event) => {
    const { assetId } = event.detail;
    if (assetId) void selectAsset(assetId);
  });
  window.addEventListener("mosa:open-asset-view", (event) => {
    const { assetId } = event.detail;
    if (assetId) openAssetView(assetId);
  });
}
