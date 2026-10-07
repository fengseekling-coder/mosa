/**
 * 任务 93：堆叠之间剪切粘贴的界面（A4e）。
 *
 * 剪切 = 标记一组素材待移动（卡片变淡）+ 尽力把第一张原图写进系统剪贴板
 * （在 MOSA 外粘贴得到的是普通图片复制）；粘贴 = 调
 * POST /api/asset-stacks/move 把整批原子移进目标堆叠（targetStackId=null
 * 表示移出成散图）。失败保留剪切状态方便重试。
 *
 * 剪贴板一致性口径（任务单第 3 条的实测结论，回报里有原始数据）：
 * Chromium 的 web 自定义格式既不出现在 paste 事件的 DataTransfer 里，
 * 桌面端又因权限硬化（denyBrowserPermissions 全拒）从渲染进程写不进、读不出。
 * 故采用任务单的回退规则：**窗口失焦即取消剪切**；应用内再次写剪贴板
 * （复制图片/复制提示词/复制路径等）同样取消。于是「剪切状态还活着」
 * 就等价于「系统剪贴板里仍是本次剪切写入的内容」，⌘V 无需读剪贴板即可分流。
 */

export function createCutPasteController({
  state,
  els,
  t,
  apiFetch,
  showToast,
  announceGalleryStatus,
  librarySync,
  loadStats,
  copyOriginalImage,
}) {
  // 剪切自身也会写一次剪贴板（cutAssetIds → copyOriginalImage），
  // 这次写入不能触发「应用内再次写剪贴板」的取消。
  let selfClipboardWrite = false;

  function cutIdSet() {
    if (!(state.cutAssetIds instanceof Set)) state.cutAssetIds = new Set();
    // 剪切内容永远属于发起时的项目；项目口径变化视为已取消。
    if (state.cutProjectId !== state.project) {
      state.cutAssetIds = new Set();
      state.cutProjectId = "";
    }
    return state.cutAssetIds;
  }

  function cutIds() {
    return [...cutIdSet()];
  }

  function isCutActive() {
    return cutIdSet().size > 0;
  }

  function isCutAsset(id) {
    return cutIdSet().has(String(id || ""));
  }

  /** 立即把已挂载卡片的变淡态刷成与剪切集合一致（不等待下一次渲染）。 */
  function syncRenderedCutState() {
    const grid = els?.assetGrid;
    if (!grid) return;
    const ids = cutIdSet();
    grid.querySelectorAll(":scope > .asset-card").forEach((card) => {
      card.classList.toggle("is-cut", ids.has(card.dataset.id || ""));
    });
  }

  function cancelCut({ announce = false } = {}) {
    if (!cutIdSet().size) return false;
    state.cutAssetIds = new Set();
    state.cutProjectId = "";
    syncRenderedCutState();
    if (announce) announceGalleryStatus?.(t("cutCancelled"));
    return true;
  }

  /**
   * 进入剪切状态（再次剪切覆盖上一次）。系统剪贴板尽力写第一张原图；
   * 写入失败不影响剪切本身（error 被吞掉，剪切态照常生效）。
   */
  async function cutAssetIds(ids, { projectId = state.project } = {}) {
    if (state.scope === "trash" || projectId !== state.project) return false;
    const cleanIds = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "")).filter(Boolean))];
    if (!cleanIds.length) return false;
    state.cutAssetIds = new Set(cleanIds);
    state.cutProjectId = state.project;
    syncRenderedCutState();
    announceGalleryStatus?.(t("cutPending", { count: cleanIds.length }));
    const first = (state.assets || []).find((asset) => cleanIds.includes(asset.id));
    if (first) {
      selfClipboardWrite = true;
      try {
        await copyOriginalImage?.(first, { skipCutInvalidation: true });
      } catch {
        // 系统剪贴板写入失败不影响剪切本身。
      } finally {
        selfClipboardWrite = false;
      }
    }
    return true;
  }

  /** 应用内任何一次写剪贴板（复制图片/提示词/路径/用户 ID）都使剪切失效。 */
  function noteClipboardWrite() {
    if (selfClipboardWrite) return;
    cancelCut();
  }

  /**
   * 粘贴目标判定（纯读 state，单测钉行为）：回收站 → 拒绝；显式 stackId
   * （堆叠卡片右键）→ 那个堆叠；堆叠内部 → 当前堆叠；其余画廊视图 →
   * 移出成散图（targetStackId = null）。
   */
  function resolvePasteTarget({ stackId, stackName = "" } = {}) {
    if (state.scope === "trash") return { kind: "trash", targetStackId: null, targetName: "" };
    if (stackId) return { kind: "stack", targetStackId: String(stackId), targetName: String(stackName || "") };
    if (state.activeStackId) {
      return { kind: "stack", targetStackId: state.activeStackId, targetName: String(state.activeStackSummary?.name || "") };
    }
    return { kind: "unstack", targetStackId: null, targetName: "" };
  }

  /** 执行移动。失败（请求抛错）保留剪切状态；成功或空操作都取消剪切。 */
  async function pasteCut({ stackId, stackName } = {}) {
    if (!isCutActive()) return false;
    const target = resolvePasteTarget({ stackId, stackName });
    if (target.kind === "trash") return false;
    const assetIds = cutIds();
    let result;
    try {
      result = await apiFetch("/api/asset-stacks/move", {
        method: "POST",
        body: { project: state.project, assetIds, targetStackId: target.targetStackId },
      });
    } catch (error) {
      showToast?.(error?.message || t("cutPasteFailed"), "error");
      return false;
    }
    cancelCut();
    const movedIds = (Array.isArray(result?.movedAssetIds) ? result.movedAssetIds : []).map((id) => String(id));
    const sources = Array.isArray(result?.sources) ? result.sources : [];
    const dissolvedSources = sources.filter((source) => source?.dissolved);
    if (!movedIds.length) {
      // 空操作也取消剪切：散图移出堆叠（任务单点名的口径），或目标堆叠里
      // 全部成员原位不动。
      showToast?.(target.kind === "stack" ? t("cutNothingMoved") : t("cutAlreadyLoose"), "default");
      return true;
    }
    const movedCount = movedIds.length;
    const base = target.kind === "stack" && target.targetName
      ? t("cutMovedToStack", { count: movedCount, name: target.targetName })
      : target.kind === "stack"
        ? t("cutMovedCount", { count: movedCount })
        : t("cutMovedOut", { count: movedCount });
    showToast?.(dissolvedSources.length ? `${base} ${t("cutSourceDissolved")}` : base, "success");
    // 本地增量与既有堆叠 mutation 同一套 change kind：解散 → stack-dissolved
    // （affected = 本批 moved + 幸存者），换堆 → 两侧 stack-members-changed。
    // 响应没有按源堆叠拆分 moved id，这里用整批 over-approximate——增量层
    // 只按 id 重取行，多列的 id 无害。
    const movedSet = new Set(movedIds);
    const changes = [];
    for (const source of sources) {
      if (!source?.stackId) continue;
      if (source.dissolved) {
        changes.push({
          kind: "stack-dissolved",
          entityType: "stack",
          entityId: String(source.stackId),
          assetIds: [...new Set([...movedSet, String(source.remainingAssetId || "")].filter(Boolean))],
        });
      } else {
        changes.push({
          kind: "stack-members-changed",
          entityType: "stack",
          entityId: String(source.stackId),
          assetIds: [...movedSet],
        });
      }
    }
    if (target.targetStackId) {
      changes.push({
        kind: "stack-members-changed",
        entityType: "stack",
        entityId: String(target.targetStackId),
        assetIds: movedIds,
      });
    }
    if (changes.length && typeof librarySync?.applyLocalChanges === "function") {
      await librarySync.applyLocalChanges(changes).catch((error) => console.warn("Cut paste reconcile failed:", error));
    }
    try {
      await loadStats?.({ background: true });
    } catch {
      // 统计刷新失败不移动结果无关紧要，后台刷新会兜底。
    }
    return true;
  }

  /** 任务单回退规则：窗口失焦后剪贴板可能已被其他程序改写，取消剪切。 */
  function bind() {
    window.addEventListener("blur", () => cancelCut());
  }

  return {
    bind,
    cutAssetIds,
    cancelCut,
    isCutActive,
    isCutAsset,
    cutIds,
    noteClipboardWrite,
    resolvePasteTarget,
    pasteCut,
    syncRenderedCutState,
  };
}
