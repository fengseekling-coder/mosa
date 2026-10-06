// ===== GravityPort A4a：检视器浮层控制器（参考图 / 版本树与上下文共用）=====
//
// 纯控制层：只负责开合、定位、焦点陷阱与外部点击关闭；浮层内容由 app.mjs 用
// inspector-markup 的既有 helper 生成并填进 [data-gp-overlay-body]。浮层 DOM 是
// .detail-inspector 持久外壳的一部分（shell 由 app.mjs 创建），body 按 type 切换
// hidden——关闭只是隐藏，内容保留在 DOM 里，这样现有 region 更新
// （renderVersionHistoryRegion / renderReferenceRightsRegion 等，全部按
// els.detailPanel 查询）和脏草稿守卫（panelHasDirtyDraft）不需要感知浮层的存在。
//
// 定位：容器 position:fixed。宽屏（>1120px）出现在检视器卡片左侧、紧贴检视器、
// 与卡片顶部对齐，宽 480、最大高度视口高度减 48；≤1120px（既有紧凑档）与
// ≤767px（窄屏，检视器本身是浮层）时改为盖在检视器上（与检视器同宽同位）。
// 祖先链（.shell/.detail）没有 transform/filter/will-change，fixed 不会被
// .detail 的 overflow:hidden 裁剪。窗口 resize 时重算位置。
//
// 键盘：打开时焦点进入卡片；Tab 在浮层内循环；Esc 关闭（document 捕获段拦截 +
// preventDefault + stopPropagation，优先级高于全局快捷键路由）；关闭后焦点回到
// 触发它的「查看」按钮。hasBlockingOverlay（app.mjs）把本浮层纳入统一判定，
// 全局快捷键在浮层打开时不响应。

const SIDE_OVERLAY_WIDTH = 480;
// 最大高度 = 视口高度 - 48（上下各留 24）；侧浮层与检视器卡片之间留 8px 间距。
const OVERLAY_VIEWPORT_INSET = 24;
const OVERLAY_CARD_GAP = 8;
const OVERLAY_MIN_LEFT = 8;
// ≤1120px 是既有紧凑桌面档（styles.css 响应式节），此时浮层盖在检视器上。
const COVER_BREAKPOINT = 1120;

const FOCUSABLE_SELECTOR = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export function createInspectorOverlay({ panel, t, isSuspended = null }) {
  let openType = null;
  let returnFocusTarget = null;

  const rootElement = () => panel?.querySelector("[data-gp-overlay]") || null;

  // 任务 73 返工 1：确认框等更高层弹窗叠在浮层上时（isSuspended() 为真，由 app.mjs
  // 按 hasBlockingOverlay 的清单注入），浮层必须完全让位——keydown/pointerdown
  // 处理函数直接返回，不消费事件、不改变浮层状态，让上层弹窗自己处理 Esc/Tab/点击。
  function suspended() {
    return typeof isSuspended === "function" && isSuspended();
  }

  function isOpen(type = "") {
    return Boolean(openType) && (!type || openType === type);
  }

  function positionRootElement(element) {
    const panelRect = panel?.getBoundingClientRect();
    if (!panelRect || !panelRect.width) return;
    if (window.innerWidth <= COVER_BREAKPOINT) {
      element.style.left = `${panelRect.left}px`;
      element.style.top = `${panelRect.top}px`;
      element.style.width = `${panelRect.width}px`;
      element.style.maxHeight = `${panelRect.height}px`;
      return;
    }
    const left = Math.max(OVERLAY_MIN_LEFT, panelRect.left - OVERLAY_CARD_GAP - SIDE_OVERLAY_WIDTH);
    element.style.left = `${left}px`;
    element.style.top = `${panelRect.top}px`;
    element.style.width = `${SIDE_OVERLAY_WIDTH}px`;
    element.style.maxHeight = `${window.innerHeight - OVERLAY_VIEWPORT_INSET * 2}px`;
  }

  function onWindowResize() {
    const element = rootElement();
    if (element && openType) positionRootElement(element);
  }

  function onDocumentPointerDown(event) {
    if (!openType || suspended()) return;
    const element = rootElement();
    if (!element || element.contains(event.target)) return;
    close({ restoreFocus: false });
  }

  function onDocumentKeydown(event) {
    if (!openType || suspended()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const element = rootElement();
    if (!element) return;
    const focusable = [...element.querySelectorAll(FOCUSABLE_SELECTOR)]
      .filter((node) => !node.closest("[hidden]"));
    if (!focusable.length) {
      event.preventDefault();
      element.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && element.contains(active);
    if (event.shiftKey) {
      if (!inside || active === element || active === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      }
      return;
    }
    if (!inside || active === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }

  function open(type, titleText, trigger) {
    const element = rootElement();
    if (!element) return;
    // 同一时间只能开一个：切换类型时直接换内容，原触发点不还焦点。
    if (openType && openType !== type) close({ restoreFocus: false });
    if (trigger instanceof HTMLElement && trigger.isConnected) returnFocusTarget = trigger;
    openType = type;
    element.dataset.gpOverlayOpen = type;
    element.hidden = false;
    for (const body of element.querySelectorAll("[data-gp-overlay-body]")) {
      body.hidden = body.dataset.gpOverlayBody !== type;
    }
    const titleNode = element.querySelector("[data-gp-overlay-title]");
    if (titleNode) titleNode.textContent = titleText;
    element.querySelector("[data-action='close-inspector-overlay']")?.setAttribute("aria-label", t("close"));
    positionRootElement(element);
    window.addEventListener("resize", onWindowResize);
    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    document.addEventListener("keydown", onDocumentKeydown, true);
    element.focus({ preventScroll: true });
  }

  function close({ restoreFocus = true } = {}) {
    if (!openType) return;
    openType = null;
    const element = rootElement();
    if (element) {
      element.hidden = true;
      delete element.dataset.gpOverlayOpen;
    }
    window.removeEventListener("resize", onWindowResize);
    document.removeEventListener("pointerdown", onDocumentPointerDown, true);
    document.removeEventListener("keydown", onDocumentKeydown, true);
    const returnTarget = returnFocusTarget;
    returnFocusTarget = null;
    if (restoreFocus && returnTarget instanceof HTMLElement && returnTarget.isConnected) {
      returnTarget.focus({ preventScroll: true });
    }
  }

  // app.mjs 往浮层里填内容 / 查询 region 用。
  function body(type) {
    return rootElement()?.querySelector(`[data-gp-overlay-body="${type}"]`) || null;
  }

  // 任务 73 返工 1：浮层内的动作触发确认框并重建浮层内容后（如删除版本关系），
  // 确认框的焦点恢复可能因原按钮已被替换而落到浮层外。等确认框自己的 rAF 焦点
  // 恢复跑完（双 rAF 在其后），若焦点仍不在浮层里，落回浮层容器。
  function restoreFocusInside() {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!openType) return;
      const element = rootElement();
      if (!element || element.contains(document.activeElement)) return;
      element.focus({ preventScroll: true });
    }));
  }

  return { open, close, isOpen, body, reposition: onWindowResize, restoreFocusInside };
}
