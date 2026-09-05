// ===== Phase 5B / F-15：全应用唯一 ConfirmDialog（提取自 app.js，REFACTORING-PLAN R1 批次 3）=====
// els/state/t/closePanel 经 createConfirmDialog 工厂注入；单 pending Promise、焦点/Escape
// 生命周期、焦点恢复策略与原先完全一致；confirmDialogState 随闭包迁移并原样暴露。

export function createConfirmDialog({ els, state, t, closePanel }) {
  // ===== Confirm Dialog（Phase 5B / F-15） =====
  // 全应用唯一 ConfirmDialog。业务只传文案、tone 与可选的显式焦点返回目标；
  // 不持久化到 state/localStorage/素材数据，不建确认队列或第二套 Modal Manager。
  const confirmDialogState = { pending: false, resolve: null, returnFocus: null, triggerElement: null };

  // 单 pending 策略：已有确认显示时，新请求直接返回 false——不排队、第二个请求不覆盖
  // 第一个 resolver，两个不同业务绝不共享同一确认结果（重复快速点击不叠加第二个 Modal）。
  function requestConfirmation({ title = "", description = "", confirmLabel = "", cancelLabel = "", tone = "danger", returnFocus = null } = {}) {
    if (confirmDialogState.pending || !els.confirmDialog) return Promise.resolve(false);
    // 打开前保存当前焦点元素，并关闭 Settings，避免两个 modal surface 叠加。
    confirmDialogState.triggerElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closePanel(els.settingsMenu, els.settingsToggle, "confirm-dialog");
    // 3）填充标题/说明/按钮文案与 tone；4）打开 overlay。
    if (els.confirmDialogTitle) els.confirmDialogTitle.textContent = title;
    if (els.confirmDialogDescription) els.confirmDialogDescription.textContent = description;
    if (els.confirmDialogConfirm) {
      els.confirmDialogConfirm.textContent = confirmLabel;
      // tone：danger → DestructiveButton 红色 outline；warning → primary 层级（品牌蓝），不误用归档红色语义。
      els.confirmDialogConfirm.classList.toggle("btn-danger", tone === "danger");
      els.confirmDialogConfirm.classList.toggle("btn-primary", tone !== "danger");
    }
    if (els.confirmDialogCancel) els.confirmDialogCancel.textContent = cancelLabel || t("cancel");
    if (els.confirmDialogCard) els.confirmDialogCard.dataset.tone = tone === "danger" ? "danger" : "warning";
    confirmDialogState.pending = true;
    confirmDialogState.returnFocus = returnFocus instanceof HTMLElement ? returnFocus : null;
    // The dialog sits outside #appShell; inert keeps the complete application
    // background out of assistive-technology and keyboard navigation while it is open.
    els.appShell?.setAttribute("inert", "");
    els.confirmDialog.classList.add("open");
    els.confirmDialog.setAttribute("aria-hidden", "false");
    return new Promise((resolve) => {
      confirmDialogState.resolve = resolve;
      // 默认焦点落 Cancel——破坏性操作不得默认聚焦确认按钮；焦点不落容器或 body。
      requestAnimationFrame(() => { if (confirmDialogState.pending) els.confirmDialogCancel?.focus(); });
    });
  }

  async function requestFollowupConfirmation(options = {}) {
    // A follow-up must not reopen the same transitioning overlay in the same
    // frame. Give the closed state two paints so the next dialog is guaranteed
    // to materialize as a distinct confirmation instead of being swallowed by
    // the discrete display/opacity transition.
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    return requestConfirmation(options);
  }

  function closeConfirmDialog(result) {
    if (!confirmDialogState.pending) return;
    const { resolve } = confirmDialogState;
    confirmDialogState.pending = false;
    confirmDialogState.resolve = null;
    // 焦点恢复经 rAF 延后，先取走引用再清理状态。
    restoreConfirmDialogFocus(confirmDialogState.returnFocus, confirmDialogState.triggerElement);
    confirmDialogState.returnFocus = null;
    confirmDialogState.triggerElement = null;
    els.confirmDialog?.classList.remove("open");
    els.confirmDialog?.setAttribute("aria-hidden", "true");
    els.appShell?.removeAttribute("inert");
    // 清理临时文案与 tone，单一 Dialog 壳回到静态空壳。
    if (els.confirmDialogTitle) els.confirmDialogTitle.textContent = "";
    if (els.confirmDialogDescription) els.confirmDialogDescription.textContent = "";
    if (els.confirmDialogConfirm) {
      els.confirmDialogConfirm.textContent = "";
      els.confirmDialogConfirm.classList.remove("btn-danger");
      els.confirmDialogConfirm.classList.add("btn-primary");
    }
    delete els.confirmDialogCard?.dataset.tone;
    if (resolve) resolve(result); // Confirm=true；Cancel/Escape/Backdrop=false；resolver 只结算一次
  }

  // 焦点恢复目标必须仍连接、非 disabled、非 hidden 且可见；body 不在候选之列。
  function isConfirmFocusTarget(element) {
    return element instanceof HTMLElement && element.isConnected && !element.disabled && !element.hidden && element.offsetParent !== null;
  }

  function restoreConfirmDialogFocus(returnFocus, triggerElement) {
    requestAnimationFrame(() => {
      // 优先级 1）业务显式 returnFocus；2）打开前的 activeElement。
      for (const candidate of [returnFocus, triggerElement]) {
        if (isConfirmFocusTarget(candidate)) { candidate.focus(); return; }
      }
      // 3）安全区：查看模式的返回按钮或搜索框，绝不落回 body。
      const fallback = state.viewMode === "asset" ? els.assetViewBack : els.searchInput;
      if (isConfirmFocusTarget(fallback)) fallback.focus();
    });
  }

  function trapConfirmDialogFocus(event) {
    if (!confirmDialogState.pending) return;
    if (event.key === "Escape") {
      // Escape 优先级链最前：消费后不穿透 Viewer/既有 Modal/锚定浮层（后续监听器
      // 经 defaultPrevented 检查，与既有 Modal 陷阱同先例）。
      event.preventDefault();
      event.stopPropagation();
      closeConfirmDialog(false);
      return;
    }
    if (event.key !== "Tab") return;
    // Tab 在 Cancel/Confirm 之间正/反向循环；Enter/Space 保持聚焦原生按钮的默认行为，
    // 无全局 Enter 自动确认。
    const focusable = [els.confirmDialogCancel, els.confirmDialogConfirm].filter((button) => button && !button.disabled);
    if (!focusable.length) return;
    const current = focusable.indexOf(document.activeElement);
    const next = event.shiftKey ? (current <= 0 ? focusable.length - 1 : current - 1) : (current === focusable.length - 1 ? 0 : current + 1);
    event.preventDefault();
    focusable[next].focus();
  }

  return {
    requestConfirmation, requestFollowupConfirmation, closeConfirmDialog, trapConfirmDialogFocus, isConfirmFocusTarget, confirmDialogState,
  };
}
