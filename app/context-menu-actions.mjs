/**
 * Context Menu Actions for MOSA
 * Defines all context menu items and their actions
 */

export function createContextMenuActions({ state, els, t, apiClient, showToast, runAction, requestConfirmation, requestFollowupConfirmation, confirmDetailNavigation, discardDetailDraft, releaseAssetMedia, openGroupModal, loadAssets, getGroupColor, saveGroupColor, writeClipboardText, copyOriginalImage, isVideoAsset, pasteClipboardImage, gallerySelection }) {
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

  function logicalSelectionCount(selectedAssets = [], options = {}) {
    const count = Number(options.selectionCount);
    return Number.isFinite(count) && count > 0 ? count : Math.max(1, selectedAssets.length);
  }

  async function selectedMutationContext(asset, selectedAssets = [], options = {}) {
    const count = logicalSelectionCount(selectedAssets, options);
    const selectionContext = typeof gallerySelection?.captureActionContext === "function"
      ? gallerySelection.captureActionContext()
      : null;
    if (count > 1 && typeof gallerySelection?.resolveSelectedAssetIds === "function") {
      const resolved = await gallerySelection.resolveSelectedAssetIds(selectionContext || undefined);
      if (resolved?.ids?.length) return { ...resolved, selectionContext };
      if (resolved === null) return null;
    }
    return { projectId: selectionContext?.projectId || state.project, ids: [asset.id], selectionContext };
  }

  function mutationContextIsCurrent(context) {
    if (!context) return false;
    if (context.projectId !== state.project) return false;
    return !context.selectionContext
      || typeof gallerySelection?.isActionContextCurrent !== "function"
      || gallerySelection.isActionContextCurrent(context.selectionContext);
  }

  function mutationAssetsForIds(ids = [], projectId = state.project) {
    const loaded = new Map((state.assets || []).map((entry) => [entry.id, entry]));
    return ids.map((id) => loaded.get(id) || { id, project_id: projectId });
  }

  async function applyGroupMutation(projectId, ids, group) {
    return apiFetch("/api/assets/batch", {
      method: "POST",
      body: { action: "group", projectId, assetIds: ids, group },
    });
  }

  function selectionHasGroupedAsset(asset, selectedAssets = [], options = {}) {
    const count = logicalSelectionCount(selectedAssets, options);
    if (count > 1) {
      const selection = selectedAssets.length ? selectedAssets : [];
      if (selection.some((entry) => String(entry?.group || "").trim())) return true;
      // 折叠 Stack / 跨页选择无法在此刻展开校验时保留入口可用。
      return selection.length !== count;
    }
    return Boolean(String(asset?.group || "").trim());
  }

  /**
   * 版本家族防拆散提示：移动家族的一部分（而非全部）时软确认一次。
   * 家族成员可以合法分属不同分组（删除分组时服务端才硬拦），但多数拆散
   * 是无意的——这里只在已加载行里能判定时提示，不为此发额外请求。
   */
  async function confirmVersionFamilySplit(ids = []) {
    const selected = new Set(ids.map(String));
    const loaded = state.assets || [];
    const straddle = loaded.some((entry) => {
      const parentId = String(entry?.parent_asset_id || "");
      if (parentId && selected.has(entry.id) && !selected.has(parentId)) return true;
      return parentId && !selected.has(entry.id) && selected.has(parentId);
    });
    if (!straddle) return true;
    return requestConfirmation({
      title: t("versionSplitTitle"),
      description: t("versionSplitDescription"),
      confirmLabel: t("versionSplitConfirm"),
      cancelLabel: t("cancel"),
      tone: "warning",
    });
  }

  // Full manifest of one group via the existing paged asset query. Never cap a
  // user's export by an arbitrary asset count: cursor-loop detection provides
  // the safety bound without silently truncating large libraries.
  async function fetchGroupAssets(groupName, projectId = state.project) {
    const collected = [];
    const seenAssetIds = new Set();
    const seenCursors = new Set();
    let cursor = "";
    while (true) {
      if (cursor) {
        if (seenCursors.has(cursor)) throw new Error("Group export pagination stalled.");
        seenCursors.add(cursor);
      }
      const params = new URLSearchParams({ project: projectId, group: groupName, limit: "100" });
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
      const otherGroups = (Array.isArray(state.groups.groups) ? state.groups.groups : [])
        .filter((group) => group.name !== item.name);
      const order = (Array.isArray(state.groups.groups) ? state.groups.groups : []).map((group) => group.name);
      const orderIndex = order.indexOf(item.name);
      items.push(
        {
          label: t("moveGroupUp"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 15 6-6 6 6"/></svg>',
          disabled: orderIndex <= 0,
          action: async () => {
            await runAction(async () => {
              const next = order.slice();
              [next[orderIndex - 1], next[orderIndex]] = [next[orderIndex], next[orderIndex - 1]];
              await apiFetch("/api/groups/order", { method: "PATCH", body: { projectId: state.project, names: next } });
              window.dispatchEvent(new CustomEvent("mosa:refresh-groups"));
            });
          },
        },
        {
          label: t("moveGroupDown"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 9 6 6 6-6"/></svg>',
          disabled: orderIndex < 0 || orderIndex >= order.length - 1,
          action: async () => {
            await runAction(async () => {
              const next = order.slice();
              [next[orderIndex], next[orderIndex + 1]] = [next[orderIndex + 1], next[orderIndex]];
              await apiFetch("/api/groups/order", { method: "PATCH", body: { projectId: state.project, names: next } });
              window.dispatchEvent(new CustomEvent("mosa:refresh-groups"));
            });
          },
        },
        { separator: true },
        {
          label: t("renameGroup"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
          action: async () => {
            window.dispatchEvent(new CustomEvent("mosa:rename-group", { detail: { groupName: item.name } }));
          },
        },
        {
          // 单一分组成员模型下“复制分组”不可能复制成员（一个素材只能属于一个
          // 分组），真正有用的是把成员并入另一组并删除当前组。
          label: t("mergeGroupInto"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 7h13M13 17H3"/><path d="m17 4 3 3-3 3"/><path d="m7 14-3 3 3 3"/></svg>',
          disabled: !otherGroups.length,
          submenu: otherGroups.map((group) => ({
            label: group.name,
            icon: `<svg width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="${resolveGroupColor(group.name)}"/></svg>`,
            action: async () => {
              const confirmed = await requestConfirmation({
                title: t("mergeGroupTitle", { from: item.name, into: group.name }),
                description: t("mergeGroupDescription", { from: item.name, into: group.name, count: Number(item.count || 0) }),
                confirmLabel: t("mergeGroupConfirm"),
                tone: "warning",
              });
              if (!confirmed) return;
              await runAction(async () => {
                const result = await apiFetch(`/api/groups/${encodeURIComponent(item.name)}/merge`, {
                  method: "POST",
                  body: { projectId: state.project, into: group.name },
                });
                // 本窗口正在浏览被并入的分组时直接跟随到目标分组；跨窗口由
                // journal 的 group-deleted + mergedInto 详情重定向。过滤器语义
                // 变化必须整视图重载，行级增量覆盖不了目标组原有成员。
                if (state.facets.group === item.name) {
                  state.facets.group = result.into || group.name;
                  state.nextCursor = null;
                  await loadAssets?.();
                }
                showToast(t("groupMerged", { into: result.into || group.name, count: result.movedAssets || 0 }), "success");
                window.dispatchEvent(new CustomEvent("mosa:refresh-groups"));
                window.dispatchEvent(new CustomEvent("mosa:refresh-assets"));
              });
            },
          })),
        },
        {
          label: t("exportGroup"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5-5 5 5"/><path d="M12 5v12"/></svg>',
          action: async () => {
            await runAction(async () => {
              const projectId = state.project;
              const assets = await fetchGroupAssets(item.name, projectId);
              downloadJson(`mosa-group-${safeFileToken(item.name)}.json`, {
                exportedAt: new Date().toISOString(),
                project: projectId,
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
            window.dispatchEvent(new CustomEvent("mosa:show-group-stats", { detail: { groupName: item.name } }));
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

              // Clear group filter if the deleted group was active. The filter
              // semantics changed, so the gallery reloads under the widened
              // scope instead of reconciling only the affected rows.
              const filterWasActive = state.facets.group === item.name;
              if (filterWasActive) {
                state.facets.group = "";
                state.nextCursor = null;
              }

              window.dispatchEvent(new CustomEvent("mosa:refresh-groups"));
              if (filterWasActive) await loadAssets?.();
              else window.dispatchEvent(new CustomEvent("mosa:refresh-assets"));
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
    if (state.scope === "trash") {
      const selectionCount = logicalSelectionCount(selectedAssets, options);
      return [
        {
          label: selectionCount > 1 ? t("restoreAssets", { count: selectionCount }) : t("restoreAsset"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 8v5h5"/><path d="M5.5 13a7 7 0 1 0 2-7"/></svg>',
          action: async () => {
            await runAction(async () => {
              const context = await selectedMutationContext(asset, selectedAssets, options);
              if (!context || !mutationContextIsCurrent(context)) return;
              const { ids, projectId } = context;
              const assets = mutationAssetsForIds(ids, projectId);
              for (const item of assets) {
                await apiFetch(`/api/assets/${encodeURIComponent(item.project_id)}/${encodeURIComponent(item.id)}/restore`, { method: "POST" });
              }
              if (!mutationContextIsCurrent(context)) return;
              showToast(assets.length > 1 ? t("assetsRestored", { count: assets.length }) : t("assetRestored"), "success");
              window.dispatchEvent(new CustomEvent("mosa:refresh-groups"));
              window.dispatchEvent(new CustomEvent("mosa:refresh-assets", {
                detail: { restoredAssetIds: assets.map((item) => item.id) },
              }));
            });
          },
        },
        { separator: true },
        {
          label: t("permanentDelete"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4h8v2m2 0-1 15H7L6 6"/><path d="M10 10v7M14 10v7"/></svg>',
          danger: true,
          action: async () => {
            const context = await selectedMutationContext(asset, selectedAssets, options);
            if (!context || !mutationContextIsCurrent(context)) return;
            const { ids, projectId } = context;
            const assets = mutationAssetsForIds(ids, projectId);
            const confirmed = await requestConfirmation({
              title: assets.length > 1 ? t("permanentDeleteAssetsTitle", { count: assets.length }) : t("permanentDeleteTitle"),
              description: t("permanentDeleteDescription"),
              confirmLabel: t("permanentDelete"),
              tone: "danger",
            });
            if (!confirmed || !mutationContextIsCurrent(context)) return;
            await runAction(async () => {
              await releaseAssetMedia?.(assets);
              const failed = [];
              for (const item of assets) {
                try {
                  await apiFetch(`/api/assets/${encodeURIComponent(item.project_id)}/${encodeURIComponent(item.id)}/permanent`, { method: "DELETE" });
                } catch (error) {
                  failed.push({ assetId: item.id, error });
                }
              }
              if (!mutationContextIsCurrent(context)) return;
              if (failed.length) showToast(t("trashPartialDelete", { count: failed.length }), "error");
              else showToast(assets.length > 1 ? t("assetsPermanentlyDeleted", { count: assets.length }) : t("assetPermanentlyDeleted"), "success");
              window.dispatchEvent(new CustomEvent("mosa:refresh-groups"));
              window.dispatchEvent(new CustomEvent("mosa:refresh-assets", {
                detail: { permanentlyDeletedAssetIds: assets.filter((item) => !failed.some((entry) => entry.assetId === item.id)).map((item) => item.id) },
              }));
            });
          },
        },
      ];
    }
    if (options.stackNode && asset?.stack?.id && logicalSelectionCount(selectedAssets, options) === 1) {
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
              window.dispatchEvent(new CustomEvent("mosa:refresh-assets", {
                detail: { stackDissolved: { id: asset.stack.id } },
              }));
            });
          },
        },
      ];
    }
    const selectionCount = logicalSelectionCount(selectedAssets, options);
    const isMultiple = selectionCount > 1;
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
        const context = await selectedMutationContext(asset, selectedAssets, options);
        if (!context || !mutationContextIsCurrent(context)) return;
        const { ids, projectId } = context;
        const assets = mutationAssetsForIds(ids, projectId);
        await runAction(async () => {
          if (isMultiple) {
            const response = await apiFetch("/api/assets/batch", {
              method: "POST",
              body: {
                action: "favorite",
                projectId,
                assetIds: ids,
                favorite: !asset.favorite,
              },
            });
            if (!mutationContextIsCurrent(context)) return;
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
              if (!mutationContextIsCurrent(context)) return;
              showToast(asset.favorite ? t("removedFromFavorites") : t("addedToFavorites"), "success");
            }
            window.dispatchEvent(new CustomEvent("mosa:refresh-assets", {
              detail: { updatedAssetIds: isMultiple ? ids : [asset.id] },
            }));
        });
      },
    });

    // Move to group submenu
    const moveSelectionToGroup = (groupName) => async () => {
      const context = await selectedMutationContext(asset, selectedAssets, options);
      if (!context || !mutationContextIsCurrent(context)) return;
      const { ids, projectId } = context;
      const assets = mutationAssetsForIds(ids, projectId);
      if (!await confirmSelectedAssetMutation(assets)) return;
      if (!await confirmVersionFamilySplit(ids)) return;
      if (!mutationContextIsCurrent(context)) return;
      await runAction(async () => {
        const response = await applyGroupMutation(projectId, ids, groupName);
        if (!mutationContextIsCurrent(context)) return;
        const outcome = reconcileBatchMutation(assets, response);
        commitSelectedAssetMutation(assets);
        if (outcome.failed.length) showToast(t("batchPartialResult", { succeeded: outcome.succeeded.length, failed: outcome.failed.length }), "error");
        else showToast(groupName ? t("movedToGroup") : t("removedFromGroup"), "success");
        window.dispatchEvent(new CustomEvent("mosa:refresh-assets", {
          detail: { updatedAssetIds: outcome.succeeded.map((entry) => entry.id), groupChanged: true },
        }));
      });
    };
    items.push({
      label: t("moveToGroup"),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>',
      submenu: [
        {
          // 建组即分配：弹窗创建成功后把当前选中的素材直接移入新分组，
          // 不再让用户回到画廊右键第二轮。
          label: t("createGroupWithSelection"),
          action: async () => {
            const context = await selectedMutationContext(asset, selectedAssets, options);
            if (!context) return;
            const { ids, projectId } = context;
            openGroupModal?.({
              onCreated: async (groupName) => {
                if (projectId !== state.project) return;
                const assets = mutationAssetsForIds(ids, projectId);
                const response = await applyGroupMutation(projectId, ids, groupName);
                const outcome = reconcileBatchMutation(assets, response);
                commitSelectedAssetMutation(assets);
                if (outcome.failed.length) showToast(t("batchPartialResult", { succeeded: outcome.succeeded.length, failed: outcome.failed.length }), "error");
                else showToast(t("movedToGroup"), "success");
                window.dispatchEvent(new CustomEvent("mosa:refresh-assets", {
                  detail: { updatedAssetIds: outcome.succeeded.map((entry) => entry.id), groupChanged: true },
                }));
              },
            });
          },
        },
        {
          // 移出分组：后端批量接口传空分组名即解除归属，这里补上唯一缺失的入口。
          label: t("removeFromGroup"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="m9 12 6 0"/></svg>',
          disabled: !selectionHasGroupedAsset(asset, selectedAssets, options),
          action: moveSelectionToGroup(""),
        },
        { separator: true },
        ...(Array.isArray(state.groups.groups) ? state.groups.groups : []).map((group) => {
          const groupName = group.name;
          // Source of truth for group colors lives in app.mjs colorForGroup so
          // the saved palette and the rendered swatch never diverge.
          const savedColor = resolveGroupColor(groupName);
          return {
            label: groupName,
            icon: `<svg width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="${savedColor}"/></svg>`,
            action: moveSelectionToGroup(groupName),
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
      disabled: isMultiple && (selectedAssets.length !== selectionCount || Boolean(gallerySelection?.hasSelectedStacks?.())),
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
        label: t("moveToTrash"),
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14Z"/></svg>',
        danger: true,
        action: async () => {
          const context = await selectedMutationContext(asset, selectedAssets, options);
          if (!context || !mutationContextIsCurrent(context)) return;
          const { ids, projectId } = context;
          const assets = mutationAssetsForIds(ids, projectId);
          const confirmed = await requestConfirmation({
            title: ids.length > 1 ? t("moveAssetsToTrashTitle", { count: ids.length }) : t("moveToTrashTitle"),
            description: t("moveToTrashDescription"),
            confirmLabel: t("moveToTrash"),
            tone: "danger",
          });
          if (!confirmed || !mutationContextIsCurrent(context)) return;
          if (!await confirmSelectedAssetMutation(assets)) return;
          if (!mutationContextIsCurrent(context)) return;

          await runAction(async () => {
            const response = await apiFetch("/api/assets/batch", {
              method: "POST",
              body: {
                action: "trash",
                projectId,
                assetIds: ids,
              },
            });
            if (!mutationContextIsCurrent(context)) return;
            const outcome = reconcileBatchMutation(assets, response);
            commitSelectedAssetMutation(outcome.succeeded);
            if (outcome.failed.length) {
              showToast(t("batchPartialResult", { succeeded: outcome.succeeded.length, failed: outcome.failed.length }), "error");
            } else {
              showToast(isMultiple ? t("assetsMovedToTrash", { count: assets.length }) : t("assetMovedToTrash"), "success");
            }
            window.dispatchEvent(new CustomEvent("mosa:refresh-assets", {
              detail: { removedAssetIds: outcome.succeeded.map((entry) => entry.id) },
            }));
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
        shortcut: /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘A" : "Ctrl+A",
        disabled: !state.pageTotal,
        action: async () => {
          await gallerySelection?.selectAll?.({ announce: true });
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
