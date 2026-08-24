/**
 * Context Menu Actions for MOSA
 * Defines all context menu items and their actions
 */

export function createContextMenuActions({ state, els, t, apiClient, showToast, runAction, requestConfirmation }) {
  const { apiFetch } = apiClient;

  /**
   * Get navigation item context menu
   */
  function getNavItemMenu(item, type) {
    const items = [];

    if (type === "group") {
      items.push(
        {
          label: t("editGroup"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20h4l10.5-10.5a2.12 2.12 0 0 0-3-3L5 17v3Z"/><path d="m13.5 6 3 3"/></svg>',
          action: async () => {
            // Open edit group modal
            window.dispatchEvent(new CustomEvent("mosa:edit-group", { detail: { groupId: item.id } }));
          },
        },
        {
          label: t("duplicateGroup"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
          action: async () => {
            await runAction(async () => {
              const result = await apiFetch("/api/groups", {
                method: "POST",
                body: {
                  name: `${item.name} ${t("copy")}`,
                  color: item.color,
                },
              });
              showToast(t("groupDuplicated"), "success");
              window.dispatchEvent(new CustomEvent("mosa:refresh-groups"));
            });
          },
        },
        {
          label: t("exportGroup"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5-5 5 5"/><path d="M12 5v12"/></svg>',
          action: async () => {
            await runAction(async () => {
              const result = await apiFetch(`/api/groups/${encodeURIComponent(item.id)}/export`, {
                method: "POST",
              });
              showToast(t("exportStarted"), "success");
            });
          },
        },
        { separator: true },
        {
          label: t("groupStats"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3v18h18"/><path d="m7 16 4-4 4 4 6-6"/></svg>',
          action: async () => {
            await runAction(async () => {
              const result = await apiFetch(`/api/groups/${encodeURIComponent(item.id)}/stats`);
              showToast(`${item.name}: ${result.count} ${t("assets")}, ${result.size}`, "default");
            });
          },
        },
        { separator: true },
        {
          label: t("deleteGroup"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14Z"/></svg>',
          danger: true,
          action: async () => {
            try {
              const confirmed = await requestConfirmation({
                title: t("deleteGroupTitle"),
                description: t("deleteGroupDescription"),
                confirmLabel: t("deleteGroup"),
                tone: "danger",
              });
              if (!confirmed) return;

              await apiFetch(`/api/groups/${encodeURIComponent(item.name)}?project=${encodeURIComponent(state.project)}`, {
                method: "DELETE",
              });
              showToast(t("groupDeleted"), "success");

              // Clear group filter if the deleted group was active
              if (state.facets.group === item.name) {
                state.facets.group = "";
                state.nextCursor = null;
              }

              window.dispatchEvent(new CustomEvent("mosa:refresh-groups"));
              window.dispatchEvent(new CustomEvent("mosa:refresh-assets"));
            } catch (error) {
              console.error("Delete group error:", error);
              showToast(error.message || t("deleteFailed"), "error");
            }
          },
        }
      );
    }

    return items;
  }

  /**
   * Get single asset context menu
   */
  function getAssetMenu(asset, selectedAssets = []) {
    const isMultiple = selectedAssets.length > 1;
    const items = [];

    if (!isMultiple) {
      // Single asset actions
      items.push(
        {
          label: t("openInViewer"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
          action: async () => {
            window.dispatchEvent(new CustomEvent("mosa:open-asset-view", { detail: { assetId: asset.id } }));
          },
        },
        {
          label: t("showInFinder"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.27 6.96 8.73 5.04 8.73-5.04M12 22.08V12"/></svg>',
          action: async () => {
            await runAction(async () => {
              try {
                await apiFetch("/api/open-folder", {
                  method: "POST",
                  body: {
                    path: asset.path,
                    reveal: true
                  },
                });
                showToast(t("shownInFinder"), "success");
              } catch (error) {
                if (error.message.includes("Path not allowed")) {
                  showToast(t("showInFinderPathNotAllowed"), "error");
                } else if (error.message.includes("does not exist")) {
                  showToast(t("showInFinderNotFound"), "error");
                } else {
                  showToast(t("showInFinderFailed"), "error");
                }
                throw error;
              }
            });
          },
        },
        {
          label: t("copyPath"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
          action: async () => {
            await navigator.clipboard.writeText(asset.path);
            showToast(t("pathCopied"), "success");
          },
        },
        { separator: true }
      );
    }

    // Favorite toggle
    items.push({
      label: asset.favorite ? t("removeFromFavorites") : t("addToFavorites"),
      icon: asset.favorite
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/></svg>'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/></svg>',
      action: async () => {
        const assets = isMultiple ? selectedAssets : [asset];
        await runAction(async () => {
          for (const a of assets) {
            await apiFetch(`/api/assets/${encodeURIComponent(a.project_id)}/${encodeURIComponent(a.id)}`, {
              method: "PATCH",
              body: { favorite: !a.favorite },
            });
          }
          showToast(
            isMultiple ? t("favoriteUpdatedMultiple") : (asset.favorite ? t("removedFromFavorites") : t("addedToFavorites")),
            "success"
          );
          window.dispatchEvent(new CustomEvent("mosa:refresh-assets"));
        });
      },
    });

    // Move to group submenu
    items.push({
      label: t("moveToGroup"),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>',
      submenu: [
        {
          label: t("noGroup"),
          action: async () => {
            const assets = isMultiple ? selectedAssets : [asset];
            await runAction(async () => {
              for (const a of assets) {
                await apiFetch(`/api/assets/${encodeURIComponent(a.project_id)}/${encodeURIComponent(a.id)}`, {
                  method: "PATCH",
                  body: { group: "" },
                });
              }
              showToast(t("movedToGroup"), "success");
              window.dispatchEvent(new CustomEvent("mosa:refresh-assets"));
            });
          },
        },
        { separator: true },
        ...state.groups.groups.map((group) => ({
          label: group.name,
          icon: `<svg width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="${group.color}"/></svg>`,
          action: async () => {
            const assets = isMultiple ? selectedAssets : [asset];
            await runAction(async () => {
              for (const a of assets) {
                await apiFetch(`/api/assets/${encodeURIComponent(a.project_id)}/${encodeURIComponent(a.id)}`, {
                  method: "PATCH",
                  body: { group: group.name },
                });
              }
              showToast(t("movedToGroup"), "success");
              window.dispatchEvent(new CustomEvent("mosa:refresh-assets"));
            });
          },
        })),
      ],
    });

    if (!isMultiple) {
      items.push({ separator: true });

      // Creation actions
      items.push(
        {
          label: t("viewVersionHistory"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
          action: async () => {
            window.dispatchEvent(new CustomEvent("mosa:select-asset", { detail: { assetId: asset.id } }));
          },
        },
        {
          label: t("copyPrompt"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
          disabled: !asset.prompt,
          action: async () => {
            await navigator.clipboard.writeText(asset.prompt || "");
            showToast(t("promptCopied"), "success");
          },
        },
        {
          label: t("insertToCowart"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14M5 12h14"/></svg>',
          disabled: !state.cowartInsertAvailable,
          action: async () => {
            await runAction(async () => {
              const result = await apiFetch("/api/cowart-insert", {
                method: "POST",
                body: {
                  assetId: asset.id,
                  targetId: state.cowartInsertTargetId,
                },
              });
              showToast(t("insertedToCowart"), "success");
            });
          },
        }
      );

      items.push({ separator: true });
    }

    // Export
    items.push({
      label: t("exportAsset"),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5-5 5 5"/><path d="M12 5v12"/></svg>',
      action: async () => {
        const assets = isMultiple ? selectedAssets : [asset];
        await runAction(async () => {
          for (const a of assets) {
            await apiFetch(`/api/assets/${encodeURIComponent(a.project_id)}/${encodeURIComponent(a.id)}/export`, {
              method: "POST",
            });
          }
          showToast(isMultiple ? t("exportStartedMultiple") : t("exportStarted"), "success");
        });
      },
    });

    items.push({ separator: true });

    // Danger zone
    items.push(
      {
        label: t("archiveAsset"),
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="5" rx="1"/><path d="M3 8v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8M10 12h4"/></svg>',
        danger: true,
        action: async () => {
          const assets = isMultiple ? selectedAssets : [asset];
          const confirmed = await requestConfirmation({
            title: isMultiple ? t("archiveAssetsTitle") : t("archiveAssetTitle"),
            description: isMultiple ? t("archiveAssetsDescription") : t("archiveAssetDescription"),
            confirmLabel: t("archive"),
            tone: "danger",
          });
          if (!confirmed) return;

          await runAction(async () => {
            for (const a of assets) {
              await apiFetch(`/api/assets/${encodeURIComponent(a.project_id)}/${encodeURIComponent(a.id)}/archive`, {
                method: "POST",
              });
            }
            showToast(isMultiple ? t("assetsArchived") : t("assetArchived"), "success");
            window.dispatchEvent(new CustomEvent("mosa:refresh-assets"));
          });
        },
      },
      {
        label: t("deleteAsset"),
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14Z"/></svg>',
        danger: true,
        action: async () => {
          const assets = isMultiple ? selectedAssets : [asset];
          const confirmed = await requestConfirmation({
            title: isMultiple ? t("deleteAssetsTitle") : t("deleteAssetTitle"),
            description: isMultiple ? t("deleteAssetsDescription") : t("deleteAssetDescription"),
            confirmLabel: t("delete"),
            tone: "danger",
          });
          if (!confirmed) return;

          await runAction(async () => {
            for (const a of assets) {
              await apiFetch(`/api/assets/${encodeURIComponent(a.project_id)}/${encodeURIComponent(a.id)}`, {
                method: "DELETE",
              });
            }
            showToast(isMultiple ? t("assetsDeleted") : t("assetDeleted"), "success");
            window.dispatchEvent(new CustomEvent("mosa:refresh-assets"));
          });
        },
      }
    );

    return items;
  }

  /**
   * Get empty grid context menu
   */
  function getEmptyGridMenu() {
    return [
      {
        label: t("importAsset"),
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14M5 12h14"/></svg>',
        action: async () => {
          els.newAssetTopBtn?.click();
        },
      },
      {
        label: t("pasteFromClipboard"),
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
        disabled: true,
        action: async () => {
          try {
            const items = await navigator.clipboard.read();
            for (const item of items) {
              if (item.types.includes("image/png") || item.types.includes("image/jpeg")) {
                showToast(t("clipboardImageDetected"), "success");
                break;
              }
            }
          } catch (err) {
            showToast(t("clipboardAccessDenied"), "error");
          }
        },
      },
      { separator: true },
      {
        label: t("refreshLibrary"),
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6m12-4a9 9 0 0 1-15 6.7L3 16"/></svg>',
        action: async () => {
          window.dispatchEvent(new CustomEvent("mosa:refresh-assets"));
          showToast(t("refreshing"), "default");
        },
      },
      { separator: true },
      {
        label: t("selectAll"),
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>',
        shortcut: "⌘A",
        disabled: true,
        action: async () => {
          showToast(t("allSelected"), "success");
        },
      },
    ];
  }

  return {
    getNavItemMenu,
    getAssetMenu,
    getEmptyGridMenu,
  };
}
