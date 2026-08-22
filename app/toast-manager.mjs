// ===== Phase 5C / F-16：双通道可排队 Toast Manager =====
// 单一 Manager 管理两条物理独立的反馈通道：polite（success/default，容器 role=status，
// aria-live=polite）与 assertive（error，每条 Toast 自身 role=alert）。每条 lane 同时最多
// 2 条，超出进入 FIFO 等待队列；计时只在真正可见后开始（success/default 2200ms，
// error 6000ms），排队不消耗时长。hover/focus 暂停可多原因叠加，全部解除后按剩余
// 时长恢复；error 可手动关闭（关闭按钮仅 error 有，键盘关闭有安全焦点策略）；进出
// 过渡为 class + transition 可中断，transitionend 后移除并有短 fallback 防僵尸节点。
// Toast 状态不进素材 state、不写 localStorage；消息一律 textContent，绝不接受任意 HTML。
// 提取自 app.js（REFACTORING-PLAN R1 批次 3）：els/state/t/isConfirmFocusTarget 经参数注入。
export const TOAST_DURATIONS = { success: 2200, default: 2200, error: 6000 };
export const TOAST_VISIBLE_LIMIT = 2;
export const TOAST_LEAVE_FALLBACK_MS = 400;
let toastSequence = 0;

export function normalizeToastMessage(message) {
  if (typeof message === "string") return message;
  if (message == null) return "";
  if (typeof message.message === "string") return message.message;
  const text = String(message);
  return text === "[object Object]" ? "" : text;
}

function toastSvgIcon(className) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", className === "toast-icon"
    ? "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4.5V13m0 3.5v.01"
    : "m6 6 12 12M18 6 6 18");
  svg.appendChild(path);
  return svg;
}

export function createToastManager(deps) {
  const { els, state, t, isConfirmFocusTarget } = deps;
  const lanes = {
    polite: { containerKey: "toastContainer", visible: [], pending: [] },
    assertive: { containerKey: "toastErrorContainer", visible: [], pending: [] },
  };
  const entries = new Map(); // id -> 记录（稳定唯一 ID，每条独立生命周期）
  const laneOf = (type) => (type === "error" ? "assertive" : "polite");
  const containerOf = (laneName) => els[lanes[laneName].containerKey];

  function syncPoliteStackOffset() {
    // 两通道物理独立但共享右下角：错误栈占底，polite 栈浮在其上方；
    // 偏移由 Manager 实测 error 栈高度得出，避免两栈重叠。
    const assertive = els.toastErrorContainer;
    const polite = els.toastContainer;
    if (!assertive || !polite) return;
    const height = assertive.offsetHeight;
    polite.style.setProperty("--toast-error-stack-height", height > 0 ? `${height + 8}px` : "0px");
  }

  function pump(laneName) {
    const lane = lanes[laneName];
    while (lane.visible.length < TOAST_VISIBLE_LIMIT && lane.pending.length) {
      present(laneName, lane.pending.shift());
    }
    if (laneName === "assertive") syncPoliteStackOffset();
  }

  function present(laneName, entry) {
    const container = containerOf(laneName);
    if (!container) { entry.state = "removed"; entries.delete(entry.id); return; }
    entry.state = "visible";
    entry.shownAt = Date.now();
    entry.startedAt = entry.shownAt;
    entry.remaining = entry.duration;

    const element = document.createElement("div");
    element.className = `toast ${entry.type}`;
    element.dataset.toastId = entry.id;
    if (entry.type === "error") {
      element.setAttribute("role", "alert");
      element.appendChild(toastSvgIcon("toast-icon"));
    }
    const message = document.createElement("span");
    message.className = "toast-message";
    // Include polite text in the live-region insertion. VoiceOver can otherwise
    // miss a later text mutation when the toast is initially appended empty.
    message.textContent = entry.message;
    element.appendChild(message);
    if (entry.type === "error") {
      const dismissButton = document.createElement("button");
      dismissButton.type = "button";
      dismissButton.className = "toast-dismiss";
      dismissButton.dataset.i18nAriaLabel = "dismissNotification"; // Language 切换后经 applyI18n 更新
      dismissButton.setAttribute("aria-label", t("dismissNotification"));
      dismissButton.appendChild(toastSvgIcon("toast-dismiss-icon"));
      // event.detail === 0 即键盘激活（Enter/Space）；指针点击 detail > 0，不强制动焦点。
      dismissButton.addEventListener("click", (event) => dismiss(entry.id, "manual", event.detail === 0));
      element.appendChild(dismissButton);
    }
    entry.element = element;
    lanes[laneName].visible.push(entry);
    container.appendChild(element);
    void element.offsetHeight; // 强制回流，使进场 transition 可播放且可中断
    element.classList.add("is-visible");

    // 暂停/恢复：pointer 与 focus 两类原因可叠加，全部解除后才继续计时。
    element.addEventListener("pointerenter", () => pause(entry.id, "pointer"));
    element.addEventListener("pointerleave", () => resume(entry.id, "pointer"));
    element.addEventListener("focusin", () => pause(entry.id, "focus"));
    element.addEventListener("focusout", (event) => { if (!element.contains(event.relatedTarget)) resume(entry.id, "focus"); });

    entry.timer = setTimeout(() => beginLeave(entry.id, "timeout"), entry.remaining);
  }

  function pause(id, reason) {
    const entry = entries.get(id);
    if (!entry || entry.state !== "visible") return;
    const first = entry.pauseReasons.size === 0;
    entry.pauseReasons.add(reason);
    if (!first) return; // 已有暂停原因在途，只叠加不重复结算
    clearTimeout(entry.timer);
    entry.timer = null;
    entry.remaining = Math.max(0, entry.remaining - (Date.now() - entry.startedAt));
  }

  function resume(id, reason) {
    const entry = entries.get(id);
    if (!entry || entry.state !== "visible") return;
    entry.pauseReasons.delete(reason);
    if (entry.pauseReasons.size > 0 || entry.timer) return; // 仍有其他原因或已有 timer，绝不重复创建
    entry.startedAt = Date.now();
    if (entry.remaining <= 0) { beginLeave(entry.id, "timeout"); return; }
    entry.timer = setTimeout(() => beginLeave(entry.id, "timeout"), entry.remaining);
  }

  function beginLeave(id, reason) {
    const entry = entries.get(id);
    if (!entry || entry.state !== "visible") return; // 单条只移除一次：leaving/removed 不再进场
    entry.state = "leaving";
    entry.dismissedReason = reason;
    clearTimeout(entry.timer);
    entry.timer = null;
    const lane = lanes[entry.lane];
    lane.visible = lane.visible.filter((item) => item !== entry);
    const element = entry.element;
    if (element?.isConnected) {
      element.classList.remove("is-visible");
      element.classList.add("is-leaving");
      element.addEventListener("transitionend", (event) => { if (event.target === element) finalize(entry.id); }, { once: true });
    }
    entry.leaveTimer = setTimeout(() => finalize(entry.id), TOAST_LEAVE_FALLBACK_MS);
    pump(entry.lane); // 前一条离场即泵送最早等待项（新 Toast 不取消本条离场清理）
  }

  function finalize(id) {
    const entry = entries.get(id);
    if (!entry || entry.state === "removed") return;
    entry.state = "removed";
    clearTimeout(entry.leaveTimer);
    entry.leaveTimer = null;
    entry.element?.remove();
    entries.delete(id);
    if (entry.lane === "assertive") syncPoliteStackOffset();
  }

  function restoreAssertiveDismissFocus(closedEntry) {
    // 键盘关闭后的安全焦点：1）下一条 Error 的关闭按钮；2）创建时仍连接的 origin；
    // 3）当前视图安全可达元素。绝不落回 body，绝不恢复 hidden/disabled/断开节点。
    requestAnimationFrame(() => {
      const next = lanes.assertive.visible[0];
      const nextDismiss = next?.element?.querySelector(".toast-dismiss");
      if (nextDismiss?.isConnected) { nextDismiss.focus(); return; }
      if (isConfirmFocusTarget(closedEntry.originFocus)) { closedEntry.originFocus.focus(); return; }
      const fallback = state.viewMode === "asset" ? els.assetViewBack : els.searchInput;
      if (isConfirmFocusTarget(fallback)) fallback.focus();
    });
  }

  function show(rawMessage, type = "default") {
    const normalizedType = type === "success" || type === "error" ? type : "default";
    const lane = laneOf(normalizedType);
    const entry = {
      id: `toast-${++toastSequence}`,
      message: normalizeToastMessage(rawMessage),
      type: normalizedType,
      lane,
      duration: TOAST_DURATIONS[normalizedType],
      remaining: TOAST_DURATIONS[normalizedType],
      createdAt: Date.now(),
      shownAt: null,
      startedAt: null,
      timer: null,
      leaveTimer: null,
      state: "queued",
      originFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      pauseReasons: new Set(),
      element: null,
      dismissedReason: null,
    };
    entries.set(entry.id, entry);
    lanes[lane].pending.push(entry);
    pump(lane);
    return entry.id;
  }

  function dismiss(id, reason = "manual", viaKeyboard = false) {
    const entry = entries.get(id);
    if (!entry || entry.state !== "visible") return;
    const laneName = entry.lane;
    beginLeave(id, reason);
    if (viaKeyboard && laneName === "assertive") restoreAssertiveDismissFocus(entry);
  }

  function clearAll(reason = "clear") {
    for (const entry of [...entries.values()]) {
      clearTimeout(entry.timer);
      clearTimeout(entry.leaveTimer);
      entry.state = "removed";
      entry.dismissedReason = entry.dismissedReason || reason;
      entry.element?.remove();
    }
    entries.clear();
    for (const laneName of Object.keys(lanes)) { lanes[laneName].visible = []; lanes[laneName].pending = []; }
    syncPoliteStackOffset();
  }

  function laneSnapshot(laneName) {
    const lane = lanes[laneName];
    const pack = (entry, position) => ({ id: entry.id, type: entry.type, state: entry.state, duration: entry.duration, remaining: entry.remaining, createdAt: entry.createdAt, shownAt: entry.shownAt, queuePosition: position, pauseReasons: [...entry.pauseReasons], dismissedReason: entry.dismissedReason });
    return { visible: lane.visible.map((entry, index) => pack(entry, index)), pending: lane.pending.map((entry, index) => pack(entry, index)) };
  }

  return { show, dismiss, pause, resume, clearAll, snapshot: () => ({ polite: laneSnapshot("polite"), assertive: laneSnapshot("assertive") }) };
}
