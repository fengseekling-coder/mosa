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
    selectAsset,
    openAssetView,
    showToast,
    t,
  } = options;

  els.sidebarGroupList?.addEventListener("contextmenu", (event) => {
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
    contextMenu.show({
      items: contextMenuActions.getAssetMenu(asset),
      x: event.clientX,
      y: event.clientY,
      target: card,
    });
  });

  window.addEventListener("mosa:refresh-assets", () => {
    // Same-result refreshes preserve gallery scroll centrally in loadAssets /
    // renderGrid. Mutations can also change sidebar counts (favorites, group
    // membership, archive/delete), so refresh stats in the same transaction.
    void Promise.allSettled([loadStats(), loadAssets()]).then((results) => {
      const failure = results.find((result) => result.status === "rejected");
      if (failure) console.warn("Context-menu refresh failed:", failure.reason);
    });
  });
  window.addEventListener("mosa:refresh-groups", () => {
    void loadStats().catch((error) => console.warn("Group refresh failed:", error));
  });
  window.addEventListener("mosa:select-asset", (event) => {
    const { assetId } = event.detail;
    if (assetId) void selectAsset(assetId);
  });
  window.addEventListener("mosa:open-asset-view", (event) => {
    const { assetId } = event.detail;
    if (assetId) openAssetView(assetId);
  });
  window.addEventListener("mosa:edit-group", () => {
    showToast(t("editGroupUnavailable"), "default");
  });
}
