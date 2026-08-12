// ===== Phase 5A / F-14：共享锚定浮层 manager（Filter / Settings / Language 唯一基础设施）=====
// 三套锚定浮层共用同一个 vanilla helper：打开/关闭、锚点定位与 viewport 碰撞（翻转/钳制）、
// 唯一一套外部点击、Escape 分层（child 优先）、resize 重定位、return focus、aria-expanded 同步
// 与 hidden 状态。状态模型为 root/child 引用而非单一布尔：Filter 与 Settings 是互斥 root 浮层；
// Language 是 Settings 的 child——打开 Language 不关 Settings，Escape 先关 child。
// 无第三方定位库、不依赖 CSS Anchor Positioning、无轮询/watchdog；定位一律使用 CSS 像素。
// 提取自 app.js（REFACTORING-PLAN R1 批次 3）：自包含工厂，不依赖 app.js 内部状态。
const ANCHORED_OVERLAY_VIEWPORT_PADDING = 12; // 三浮层统一 viewport 安全距离
const ANCHORED_OVERLAY_TRIGGER_GAP = 8;       // 浮层与触发器的统一间距

export function createAnchoredOverlayManager() {
  const overlays = new Map(); // id -> config（panel/trigger 惰性 getter，兼容 Settings DOM 重建）
  let rootId = null;
  let childId = null;

  const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
  const configOf = (id) => overlays.get(id) ?? null;
  const panelOf = (id) => configOf(id)?.getPanel?.() ?? null;
  const triggerOf = (id) => configOf(id)?.getTrigger?.() ?? null;
  const isOpen = (id) => { const panel = panelOf(id); return Boolean(panel && panel.isConnected && !panel.hidden); };
  const insideOverlay = (id, target) => {
    if (!(target instanceof Node)) return false;
    const panel = panelOf(id);
    const trigger = triggerOf(id);
    return Boolean((panel && panel.contains(target)) || (trigger && trigger.contains(target)));
  };

  function syncTriggerExpanded(id, expanded) {
    triggerOf(id)?.setAttribute("aria-expanded", String(expanded));
  }

  function focusTarget(id) {
    const target = configOf(id)?.focusOnOpen?.();
    if (target instanceof HTMLElement && target.isConnected) target.focus();
  }

  function restoreFocus(id) {
    const target = configOf(id)?.returnFocus?.();
    if (target instanceof HTMLElement && target.isConnected) target.focus();
  }

  // 统一定位公式：placement 决定初始方位，空间不足时水平翻转/垂直翻转，最终钳制在
  // viewportPadding 之内；hidden panel 不参与计算；resize 后经同一函数重定位。
  function position(id) {
    const config = configOf(id);
    const panel = panelOf(id);
    const trigger = triggerOf(id);
    if (!config || !panel || panel.hidden || !trigger) return;
    const anchor = trigger.getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = ANCHORED_OVERLAY_VIEWPORT_PADDING;
    const gap = ANCHORED_OVERLAY_TRIGGER_GAP;
    const clampLeft = (value) => clamp(value, pad, Math.max(pad, vw - width - pad));
    const clampTop = (value) => clamp(value, pad, Math.max(pad, vh - height - pad));
    let top;
    let left;
    if (config.placement === "bottom-end") {
      left = clampLeft(anchor.right - width);
      top = anchor.bottom + gap;
      if (top + height > vh - pad) top = clampTop(anchor.top - gap - height); // 下方不足：向上翻转/钳制
    } else if (config.placement === "right-start") {
      top = clampTop(anchor.top);
      left = anchor.right + gap;
      if (left + width > vw - pad) left = Math.max(pad, anchor.left - gap - width); // 右侧不足：向左翻转
    } else if (config.placement === "left-start") {
      top = clampTop(anchor.top);
      left = anchor.left - gap - width;
      if (left < pad) left = clampLeft(anchor.right + gap); // 左侧不足：向右翻转
    } else { // bottom-start（设置菜单：下方通常无空间，碰撞公式翻转为向上展开）
      left = clampLeft(anchor.left);
      top = anchor.bottom + gap;
      if (top + height > vh - pad) top = clampTop(anchor.top - gap - height);
    }
    top = clampTop(top);
    panel.style.top = `${Math.round(top)}px`;
    panel.style.left = `${Math.round(left)}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    if (config.maxHeight) panel.style.maxHeight = `${Math.round(Math.min(config.maxHeight, vh - top - pad))}px`;
  }

  function open(id) {
    const config = configOf(id);
    if (!config || isOpen(id)) return;
    const panel = panelOf(id);
    if (!panel) return;
    if (config.kind === "root") {
      if (childId) close(childId, "parent-closed");
      if (rootId && rootId !== id) close(rootId, "sibling-opened"); // root 浮层互斥
      rootId = id;
    } else {
      if (!rootId) return; // child 浮层不得脱离 root 存在
      if (childId && childId !== id) close(childId, "sibling-opened");
      childId = id;
    }
    panel.hidden = false;
    syncTriggerExpanded(id, true);
    position(id);
    focusTarget(id);
  }

  function close(id, reason = "escape") {
    const config = configOf(id);
    if (!config) return;
    if (config.kind === "root") {
      // Escape child-first：Language 打开时先关 Language，不穿透到 Settings/Viewer。
      if (childId && reason === "escape" && isOpen(childId)) { close(childId, "escape"); return; }
      if (childId) close(childId, "parent-closed"); // 关闭 root 必须同时清理 child
      if (rootId === id) rootId = null;
    } else if (childId === id) {
      childId = null;
    }
    const panel = panelOf(id);
    if (!panel) return;
    panel.hidden = true;
    syncTriggerExpanded(id, false);
    // outside-pointer 不抢焦点（让被点目标自然获得焦点）；selection 的焦点由业务路径接管。
    if (reason === "escape" || reason === "trigger-toggle") restoreFocus(id);
  }

  return {
    register(config) { overlays.set(config.id, config); },
    idForPanel(panel) { for (const [id, config] of overlays) if (config.getPanel?.() === panel) return id; return null; },
    isOpen,
    open,
    close,
    toggle(id) { if (isOpen(id)) close(id, "trigger-toggle"); else open(id); },
    position,
    repositionOpen() { if (rootId) position(rootId); if (childId) position(childId); },
    // 唯一一套外部点击路由：child 内无动作；root 内 child 外只关 child；之外先 child 后 root。
    handleOutsidePointer(target) {
      // 重建期间断开的旧节点不算外部点击：语言选择会触发 Settings DOM 重建，
      // 被点 locale 按钮随即脱离文档；真实的外部点击目标必然仍连接在文档中。
      if (!(target instanceof Node) || !target.isConnected) return;
      if (childId && insideOverlay(childId, target)) return;
      if (rootId && insideOverlay(rootId, target)) { if (childId) close(childId, "outside-pointer"); return; }
      if (childId) close(childId, "outside-pointer");
      if (rootId) close(rootId, "outside-pointer");
    },
    // 唯一一套 Escape 路由（由 setupKeyboardShortcuts 的优先级链调用）。
    handleEscape() {
      if (childId && isOpen(childId)) { close(childId, "escape"); return true; }
      if (rootId && isOpen(rootId)) { close(rootId, "escape"); return true; }
      return false;
    },
    containsTarget(target) {
      for (const id of [rootId, childId]) if (id && insideOverlay(id, target)) return true;
      return false;
    },
    // Settings DOM 重建（语言切换）后：引用经 getter 惰性刷新，只把状态对齐到新 DOM。
    refreshAfterRebuild() {
      if (childId && !isOpen(childId)) childId = null;
      if (rootId && !isOpen(rootId)) rootId = null;
    },
    openRootId: () => rootId,
    openChildId: () => childId,
  };
}
