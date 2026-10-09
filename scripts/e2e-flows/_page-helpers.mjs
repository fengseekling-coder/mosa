// In-page helpers shared by the pluggable e2e flows in this directory. Flow
// sources are evaluated inside the sandboxed renderer, so these helpers are a
// source string, not importable functions: interpolate PAGE_HELPERS at the top
// of a flow's async IIFE. Files starting with "_" are never run as flows.

export const PAGE_HELPERS = String.raw`
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rendererErrors = [];
  window.addEventListener('error', (event) => rendererErrors.push(String(event.error?.stack || event.message || event.error || 'renderer error')));
  window.addEventListener('unhandledrejection', (event) => rendererErrors.push(String(event.reason?.stack || event.reason || 'unhandled rejection')));
  // CI 诊断：记录窗口尺寸变化（Windows 跑器疑似中途把窗口压到屏幕宽）。
  const viewportChanges = [];
  window.addEventListener('resize', () => {
    if (viewportChanges.length < 12) viewportChanges.push([Math.round(performance.now()), window.innerWidth, window.innerHeight]);
  });
  // 任务 108：toast 记录器（只在测试页面里用）。撤销提示在移动请求完成那一刻
  // 就弹出并开始 6 秒计时，画廊刷新却在这之后才结束——CI 慢跑器上测试等到画廊
  // 再去找提示时它可能已经离场，pageDiagnostic 的瞬时快照（toast:""、队列空）
  // 分不清「出现过又消失」和「根本没出现」。watchToasts() 用 MutationObserver
  // 观察两条通道容器（polite #toastContainer / assertive #toastErrorContainer），
  // 每条提示的进场、离场（is-visible 摘除）、移除各记一条：相对安装点的毫秒、
  // 消息文本、有没有撤销按钮及按钮文案。记录经 pageDiagnostic 带出（最近 20 条）。
  const toastWatch = { events: [], epoch: performance.now(), observer: null };
  function watchToasts({ keepAliveActionToasts = false } = {}) {
    toastWatch.events.length = 0;
    toastWatch.epoch = performance.now();
    toastWatch.observer?.disconnect();
    const tracked = new Map(); // toast 元素 -> { visible }；只记本次观察期内出现过的
    const record = (event, element) => {
      const actionButton = element.querySelector('.toast-action');
      toastWatch.events.push({
        t: Math.round(performance.now() - toastWatch.epoch),
        event,
        lane: element.closest('#toastErrorContainer') ? 'assertive' : 'polite',
        text: (element.querySelector('.toast-message')?.textContent || '').trim(),
        hasAction: Boolean(actionButton),
        actionLabel: (actionButton?.textContent || '').trim(),
      });
      if (toastWatch.events.length > 40) toastWatch.events.shift();
      // keepAlive：带操作按钮的提示一进场就派发 pointerenter，触发 toast-manager
      // 自带的 hover 暂停（暂停倒计时；不派发 pointerleave 就不恢复）。慢跑器上
      // 画廊刷新可能吃掉 6 秒的大半，保活让断言走完后按钮仍然可点；点击本身照常
      // onAction + dismiss 离场。这是产品既有行为，不经产品代码加测试后门。
      if (event === 'appear' && keepAliveActionToasts && actionButton) {
        element.dispatchEvent(new PointerEvent('pointerenter', { pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      }
    };
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1 && node.classList?.contains('toast') && !tracked.has(node)) {
              tracked.set(node, { visible: node.classList.contains('is-visible') });
              record('appear', node);
            }
          }
          for (const node of mutation.removedNodes) {
            if (node.nodeType === 1 && node.classList?.contains('toast') && tracked.has(node)) {
              tracked.delete(node);
              record('removed', node);
            }
          }
        } else if (mutation.type === 'attributes' && mutation.target.classList?.contains('toast')) {
          const state = tracked.get(mutation.target);
          if (!state) continue;
          const visible = mutation.target.classList.contains('is-visible');
          if (state.visible && !visible) { state.visible = false; record('leave', mutation.target); }
        }
      }
    });
    for (const selector of ['#toastContainer', '#toastErrorContainer']) {
      const container = document.querySelector(selector);
      if (container) observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    }
    toastWatch.observer = observer;
  }
  const toastClock = () => Math.round(performance.now() - toastWatch.epoch);
  const toastEventLog = () => toastWatch.events.slice(-20);
  function pageDiagnostic() {
    return {
      cardCount: document.querySelectorAll('.asset-card').length,
      firstCardIds: [...document.querySelectorAll('#assetGrid > .asset-card')].slice(0, 4).map((card) => card.dataset.id || ''),
      galleryBusy: document.querySelector('#assetGrid')?.getAttribute('aria-busy') || '',
      selectedId: document.querySelector('.asset-card.selected')?.dataset.id || '',
      confirmOpen: document.querySelector('#confirmDialog')?.classList.contains('open') || false,
      openMenu: document.querySelector('.context-menu')?.textContent?.trim().slice(0, 160) || '',
      toast: document.querySelector('.toast-message, .toast')?.textContent || '',
      statusText: document.querySelector('#statusText')?.textContent || '',
      rendererErrors: rendererErrors.slice(0, 3),
      viewport: {
        inner: [window.innerWidth, window.innerHeight],
        outer: [window.outerWidth, window.outerHeight],
        screen: [window.screen?.width, window.screen?.height],
        avail: [window.screen?.availWidth, window.screen?.availHeight],
        visibility: document.visibilityState,
        focused: document.hasFocus(),
        changes: viewportChanges,
      },
      toastQueue: (() => {
        try { return window.__mosaToastDebug?.() ?? null; } catch { return null; }
      })(),
      toastEvents: toastEventLog(),
    };
  }
  async function waitFor(check, label, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const value = check();
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await sleep(100);
    }
    throw new Error('Timed out waiting for ' + label + (lastError ? ': ' + lastError.message : '') + ' diagnostic=' + JSON.stringify(pageDiagnostic()));
  }
  function click(selector) {
    const element = document.querySelector(selector);
    if (!element) {
      // 任务 100：browse-sort-filter 在 macOS CI 偶发找不到侧栏来源项，带上侧栏现状。
      const sidebarItems = [...document.querySelectorAll('#sidebarGroupList .nav-item')]
        .map((item) => (item.dataset.filter || '') + ':' + (item.dataset.value || '')).slice(0, 20);
      throw new Error('Missing control ' + selector + ' diagnostic=' + JSON.stringify({ ...pageDiagnostic(), sidebarItems }));
    }
    if (element.disabled) throw new Error('Disabled control ' + selector);
    element.click();
    return element;
  }
  function setValue(selector, value) {
    const element = document.querySelector(selector);
    if (!element) throw new Error('Missing input ' + selector);
    element.focus();
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return element;
  }
  const gallerySettled = () => document.querySelector('#assetGrid')?.getAttribute('aria-busy') === 'false';
  // Records every aria-busy transition of #assetGrid from this point on. The
  // busy phase of a localhost request can be shorter than one waitFor poll, so
  // a flow that must prove "this filter change really issued a gallery request"
  // installs the recorder BEFORE setValue and then waits for
  // galleryRequestRecordedBusy(transitions). Polling aria-busy alone can miss
  // the true phase entirely; a recorded 'true' can only come from a request
  // that started after installation (stale completions never clear a newer
  // request's busy state, so settled + recorded busy = this change applied).
  function watchGalleryBusyTransitions() {
    const grid = document.querySelector('#assetGrid');
    if (!grid) throw new Error('Missing #assetGrid for the busy watcher');
    const transitions = [];
    new MutationObserver(() => transitions.push(grid.getAttribute('aria-busy') || ''))
      .observe(grid, { attributes: true, attributeFilter: ['aria-busy'] });
    return transitions;
  }
  const galleryRequestRecordedBusy = (transitions) => transitions.includes('true');
  const cardSelector = (assetId) => '.asset-card[data-id="' + CSS.escape(assetId) + '"]';
  const rootCardIds = () => [...document.querySelectorAll('#assetGrid > .asset-card')].map((card) => card.dataset.id);
  // "Wait for a state, then click" races the re-render that the state change
  // itself triggers: the node satisfying the wait can be replaced before the
  // dispatch lands, and a click on the detached node is silently lost. Retry
  // as one unit — re-query the LIVE node, click it, check the post-condition —
  // but click each node incarnation at most once, so a landed click on a
  // toggle button is never double-applied while its state update is in flight.
  async function clickUntil(target, condition, label, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let clickedNode = null;
    let lastError = null;
    while (Date.now() < deadline) {
      const element = typeof target === 'function' ? target() : document.querySelector(target);
      if (element && element.isConnected && !element.disabled && element !== clickedNode) {
        clickedNode = element;
        try { element.click(); } catch (error) { lastError = error; }
      }
      try {
        const value = await condition();
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await sleep(100);
    }
    throw new Error('clickUntil timed out for ' + label + (lastError ? ': ' + lastError.message : '') + ' diagnostic=' + JSON.stringify(pageDiagnostic()));
  }
  // Background reconciliation may replace a card node between query and
  // dispatch, so query -> dispatch -> look for the item retries as one unit.
  async function openContextMenu(selector, label) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const trigger = document.querySelector(selector);
      if (trigger?.isConnected) {
        trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
        const item = [...document.querySelectorAll('.context-menu-item')].find((entry) => entry.textContent.includes(label));
        if (item) return item;
      }
      await sleep(100);
    }
    throw new Error('Timed out waiting for context menu item ' + label + ' diagnostic=' + JSON.stringify(pageDiagnostic()));
  }
  // Resolves the open ConfirmDialog; returns its description text.
  async function answerConfirmDialog({ confirm = true } = {}) {
    await waitFor(() => document.querySelector('#confirmDialog')?.classList.contains('open'), 'confirm dialog opens');
    const description = document.querySelector('#confirmDialogDescription')?.textContent || '';
    document.querySelector(confirm ? '#confirmDialogConfirm' : '#confirmDialogCancel').click();
    await waitFor(() => !document.querySelector('#confirmDialog')?.classList.contains('open'), 'confirm dialog closes');
    return description;
  }
  // The sandboxed renderer cannot read local files: draw an image in-page.
  async function makePngFile(name, color = '#4a7fb5', width = 32, height = 24) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = color;
    context.fillRect(0, 0, width, height);
    const blob = await new Promise((resolveBlob, rejectBlob) => canvas.toBlob(
      (value) => (value ? resolveBlob(value) : rejectBlob(new Error('canvas.toBlob produced no blob'))),
      'image/png',
    ));
    return new File([blob], name, { type: 'image/png' });
  }
  // Dispatches dragenter + dragover with the files and returns a function that
  // dispatches the drop, so callers can assert drag feedback before dropping.
  function beginFileDrag(target, files) {
    const dataTransfer = new DataTransfer();
    for (const file of [].concat(files)) dataTransfer.items.add(file);
    const rect = target.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, dataTransfer, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    const fire = (type) => target.dispatchEvent(new DragEvent(type, init));
    fire('dragenter');
    fire('dragover');
    return () => fire('drop');
  }
`;
