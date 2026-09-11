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
    apiFetch,
    loadStats,
    librarySync,
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
    const groupEntry = (Array.isArray(state.groups.groups) ? state.groups.groups : [])
      .find((entry) => entry.name === groupName);
    if (!groupEntry) return;

    const group = {
      id: groupName,
      name: groupName,
      count: groupEntry.count,
      color: groupItem.querySelector("[data-group-color]")?.dataset.groupColor || groupEntry.color || "#6366f1"
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

  window.addEventListener("mosa:refresh-assets", (event) => {
    const detail = event.detail || {};
    // 增量同步：事件携带受影响实体时只 reconcile 这些实体（O(affected)），
    // 普通库变更永远不再触发已加载窗口的全量重拉。
    const changes = [];
    for (const id of detail.removedAssetIds || []) {
      changes.push({ kind: "asset-deleted", entityType: "asset", entityId: String(id) });
    }
    for (const id of detail.restoredAssetIds || []) {
      changes.push({ kind: "asset-restored", entityType: "asset", entityId: String(id) });
    }
    for (const id of detail.permanentlyDeletedAssetIds || []) {
      changes.push({ kind: "asset-permanently-deleted", entityType: "asset", entityId: String(id) });
    }
    for (const id of detail.updatedAssetIds || []) {
      changes.push({ kind: "asset-updated", entityType: "asset", entityId: String(id), flags: detail.groupChanged ? ["group"] : [] });
    }
    if (detail.stackDissolved?.id) {
      changes.push({ kind: "stack-dissolved", entityType: "stack", entityId: String(detail.stackDissolved.id) });
    }
    const statsRefresh = loadStats({ background: true }).catch((error) => console.warn("Context-menu refresh failed:", error));
    if (changes.length && typeof librarySync?.applyLocalChanges === "function") {
      void librarySync.applyLocalChanges(changes).catch((error) => console.warn("Incremental refresh failed:", error));
      void statsRefresh;
      return;
    }
    // 未指明受影响实体（如手动“刷新库”）：走权威 revision 对账，由 delta
    // 决定增量应用或 fallback。
    void (async () => {
      const result = await apiFetch(`/api/library-revision?project=${encodeURIComponent(state.project)}`).catch(() => null);
      if (result?.revision != null && typeof librarySync?.reconcileToRevision === "function") {
        await librarySync.reconcileToRevision(result.revision);
      }
    })().catch((error) => console.warn("Context-menu refresh failed:", error));
    void statsRefresh;
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
