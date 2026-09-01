/**
 * Context Menu Actions for MOSA
 * Defines all context menu items and their actions
 */

export function createContextMenuActions({ state, els, t, apiClient, showToast, runAction, requestConfirmation, requestFollowupConfirmation, confirmDetailNavigation, discardDetailDraft, openGroupModal, getGroupColor, saveGroupColor, writeClipboardText, copyOriginalImage, isVideoAsset, pasteClipboardImage }) {
  const { apiFetch } = apiClient;
  // getGroupColor falls back to the deterministic palette so call sites can rely
  // on a single source of truth for group colors (mirrors app.mjs colorForGroup).
  const resolveGroupColor = typeof getGroupColor === "function" ? getGroupColor : () => "#6366f1";

  // Same-origin download of a stored media file; the browser/Electron save
  // dialog picks the destination, so no server-side export surface is needed.
  function downloadAssetFile(asset) {
    if (!asset?.image_url) return;
    const link = document.createElement("a");
    link.href = asset.image_url;
    link.download = asset.asset || asset.id;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function downloadJson(fileName, payload) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function safeFileToken(value) {
    return String(value || "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "group";
  }

  async function confirmSelectedAssetMutation(assets = []) {
    const touchesCurrent = assets.some((asset) => asset?.project_id === state.project && asset?.id === state.selectedId);
    if (!touchesCurrent || !state.detailDirty || typeof confirmDetailNavigation !== "function") return true;
    return confirmDetailNavigation(null);
  }

  function commitSelectedAssetMutation(assets = []) {
    const touchesCurrent = assets.some((asset) => asset?.project_id === state.project && asset?.id === state.selectedId);
    if (touchesCurrent && state.detailDirty && typeof discardDetailDraft === "function") discardDetailDraft();
  }

  function reconcileBatchMutation(assets = [], response = {}) {
    if (!response?.partial) return { succeeded: assets, failed: [] };
    const results = Array.isArray(response.results) ? response.results : [];
    const byId = new Map(results.map((result) => [String(result?.id || ""), result]));
    const succeeded = [];
    const failed = [];
    for (const asset of assets) {
      const result = byId.get(String(asset?.id || ""));
      if (result && result.ok !== false) succeeded.push(asset);
      else failed.push(asset);
    }
    return { succeeded, failed };
  }

  // Full manifest of one group via the existing paged asset query. Never cap a
  // user's export by an arbitrary asset count: cursor-loop detection provides
  // the safety bound without silently truncating large libraries.
  async function fetchGroupAssets(groupName) {
    const collected = [];
    const seenAssetIds = new Set();
    const seenCursors = new Set();
    let cursor = "";
    while (true) {
      if (cursor) {
        if (seenCursors.has(cursor)) throw new Error("Group export pagination stalled.");
        seenCursors.add(cursor);
      }
      const params = new URLSearchParams({ project: state.project, group: groupName, limit: "100" });
      if (cursor) params.set("cursor", cursor);
      const result = await apiFetch(`/api/assets?${params}`);
      for (const asset of result.assets || []) {
        const id = String(asset?.id || "");
        if (id && seenAssetIds.has(id)) continue;
        if (id) seenAssetIds.add(id);
        collected.push(asset);
      }
      cursor = result.page?.nextCursor || "";
      if (!cursor) break;
    }
    return collected;
  }

  /**
   * Get navigation item context menu
   */
  function getNavItemMenu(item, type) {
    const items = [];

    if (type === "group") {
      items.push(
        {
          label: t("renameGroup"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
          action: async () => {
            window.dispatchEvent(new CustomEvent("mosa:rename-group", { detail: { groupName: item.name } }));
          },
        },
        {
          label: t("duplicateGroup"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
          action: async () => {
            await runAction(async () => {
              const newName = `${item.name} ${t("copy")}`;
              await apiFetch("/api/groups", {
                method: "POST",
                body: { projectId: state.project, name: newName },
              });
              // The store keeps colors in the per-project palette (localStorage),
              // not in the create-group API, so duplicate the swatch here too.
              if (typeof saveGroupColor === "function" && item.color) saveGroupColor(newName, item.color);
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
              const assets = await fetchGroupAssets(item.name);
              downloadJson(`mosa-group-${safeFileToken(item.name)}.json`, {
                exportedAt: new Date().toISOString(),
                project: state.project,
                group: item.name,
                assets,
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
            // The sidebar group entry already carries the live count from
            // GET /api/groups; no per-group stats endpoint exists to call.
            showToast(`${item.name}: ${item.count} ${t("assets")}`, "default");
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

              const deleteAssets = await requestFollowupConfirmation({
                title: t("deleteGroupAssetsTitle"),
                description: t("deleteGroupAssetsDescription"),
                confirmLabel: t("deleteGroupAssetsAction"),
                cancelLabel: t("keepGroupAssetsAction"),
                tone: "danger",
              });

              const params = new URLSearchParams({ project: state.project });
              if (deleteAssets) params.set("deleteAssets", "true");
              await apiFetch(`/api/groups/${encodeURIComponent(item.name)}?${params}`, {
                method: "DELETE",
              });
              showToast(t(deleteAssets ? "groupAndAssetsDeleted" : "groupDeleted"), "success");

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
  function getAssetMenu(asset, selectedAssets = [], options = {}) {
    if (options.stackNode && asset?.stack?.id) {
      return [
        {
          label: t("openStack"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h16v12H4z"/><path d="m9 10 3 3 3-3"/></svg>',
          action: async () => {
            window.dispatchEvent(new CustomEvent("mosa:open-stack", { detail: { stackId: asset.stack.id, stack: asset.stack } }));
          },
        },
        { separator: true },
        {
          label: t("dissolveStack"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 7h8M8 12h8M8 17h8"/><path d="M4 7h.01M4 12h.01M4 17h.01"/></svg>',
          action: async () => {
            const confirmed = await requestConfirmation({
              title: t("dissolveStackTitle"),
              description: t("dissolveStackDescription"),
              confirmLabel: t("dissolveStack"),
              tone: "warning",
            });
            if (!confirmed) return;
            await runAction(async () => {
              await apiFetch(`/api/asset-stacks/${encodeURIComponent(asset.stack.id)}`, {
                method: "DELETE",
                body: { projectId: state.project },
              });
              showToast(t("stackDissolvedManual"), "success");
              window.dispatchEvent(new CustomEvent("mosa:refresh-assets"));
            });
          },
        },
      ];
    }
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
                  body: { path: asset.image_path, reveal: true },
                });
              } catch (error) {
                if (error.message.includes("Path not allowed")) throw new Error(t("showInFinderPathNotAllowed"));
                if (error.message.includes("does not exist")) throw new Error(t("showInFinderNotFound"));
                throw new Error(t("showInFinderFailed"));
              }
              showToast(t("shownInFinder"), "success");
            });
          },
        },
        {
          label: t("copyPath"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
          action: async () => {
            // SQLite store uses image_path (and inspector markup does the same);
            // keep the contract consistent across every call site.
            try {
              await writeClipboardText(asset.image_path);
              showToast(t("pathCopied"), "success");
            } catch {
              showToast(t("copyFailed"), "error");
            }
          },
        },
        {
          label: t("copyImage"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 2-2 5 5"/></svg>',
          disabled: typeof copyOriginalImage !== "function" || Boolean(isVideoAsset?.(asset)) || !(asset.image_path || asset.image_url),
          action: async () => {
            try {
              await copyOriginalImage(asset);
              showToast(t("imageCopied"), "success");
            } catch {
              showToast(t("copyImageFailed"), "error");
            }
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
          if (isMultiple) {
            const response = await apiFetch("/api/assets/batch", {
              method: "POST",
              body: {
                action: "favorite",
                projectId: state.project,
                assetIds: assets.map((entry) => entry.id),
                favorite: !asset.favorite,
              },
            });
            const outcome = reconcileBatchMutation(assets, response);
            if (outcome.failed.length) {
              showToast(t("batchPartialResult", { succeeded: outcome.succeeded.length, failed: outcome.failed.length }), "error");
            } else {
              showToast(t("favoriteUpdatedMultiple"), "success");
            }
          } else {
            await apiFetch(`/api/assets/${encodeURIComponent(asset.project_id)}/${encodeURIComponent(asset.id)}/favorite`, {
              method: "POST",
            });
            showToast(asset.favorite ? t("removedFromFavorites") : t("addedToFavorites"), "success");
          }
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
          label: t("createGroup"),
          action: async () => {
            openGroupModal?.();
          },
        },
        { separator: true },
        {
          label: t("noGroup"),
          action: async () => {
            const assets = isMultiple ? selectedAssets : [asset];
            if (!await confirmSelectedAssetMutation(assets)) return;
            await runAction(async () => {
              for (const a of assets) {
                await apiFetch(`/api/assets/${encodeURIComponent(a.project_id)}/${encodeURIComponent(a.id)}`, {
                  method: "PATCH",
                  body: { group: "" },
                });
              }
              commitSelectedAssetMutation(assets);
              showToast(t("movedToGroup"), "success");
              window.dispatchEvent(new CustomEvent("mosa:refresh-assets"));
            });
          },
        },
        { separator: true },
        ...state.groups.groups.map(([groupName, count]) => {
          // Source of truth for group colors lives in app.mjs colorForGroup so
          // the saved palette and the rendered swatch never diverge.
          const savedColor = resolveGroupColor(groupName);
          return {
            label: groupName,
            icon: `<svg width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="${savedColor}"/></svg>`,
            action: async () => {
              const assets = isMultiple ? selectedAssets : [asset];
              if (!await confirmSelectedAssetMutation(assets)) return;
              await runAction(async () => {
                for (const a of assets) {
                  await apiFetch(`/api/assets/${encodeURIComponent(a.project_id)}/${encodeURIComponent(a.id)}`, {
                    method: "PATCH",
                    body: { group: groupName },
                  });
                }
                commitSelectedAssetMutation(assets);
                showToast(t("movedToGroup"), "success");
                window.dispatchEvent(new CustomEvent("mosa:refresh-assets"));
              });
            },
          };
        }),
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
            try {
              await writeClipboardText(asset.prompt || "");
              showToast(t("promptCopied"), "success");
            } catch {
              showToast(t("copyFailed"), "error");
            }
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
            downloadAssetFile(a);
          }
          showToast(isMultiple ? t("exportStartedMultiple") : t("exportStarted"), "success");
        });
      },
    });

    items.push({ separator: true });

    // Danger zone
    items.push(
      {
        label: t("deleteAsset"),
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14Z"/></svg>',
        danger: true,
        action: async () => {
          const assets = isMultiple ? selectedAssets : [asset];
          const confirmed = await requestConfirmation({
            title: isMultiple ? t("deleteAssetsTitle", { count: assets.length }) : t("deleteAssetTitle"),
            description: isMultiple ? t("deleteAssetsDescription") : t("deleteAssetDescription"),
            confirmLabel: t("delete"),
            tone: "danger",
          });
          if (!confirmed) return;
          if (!await confirmSelectedAssetMutation(assets)) return;

          await runAction(async () => {
            for (const a of assets) {
              await apiFetch(`/api/assets/${encodeURIComponent(a.project_id)}/${encodeURIComponent(a.id)}`, {
                method: "DELETE",
              });
            }
            commitSelectedAssetMutation(assets);
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
        label: t("createGroup"),
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v6M9 14h6"/></svg>',
        action: async () => {
          openGroupModal?.();
        },
      },
      {
        label: t("pasteFromClipboard"),
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
        disabled: typeof pasteClipboardImage !== "function",
        action: async () => {
          const pasted = await pasteClipboardImage?.();
          if (!pasted) showToast(t("clipboardNoImage"), "default");
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
