// In-page helpers shared by the pluggable e2e flows in this directory. Flow
// sources are evaluated inside the sandboxed renderer, so these helpers are a
// source string, not importable functions: interpolate PAGE_HELPERS at the top
// of a flow's async IIFE. Files starting with "_" are never run as flows.

export const PAGE_HELPERS = String.raw`
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rendererErrors = [];
  window.addEventListener('error', (event) => rendererErrors.push(String(event.error?.stack || event.message || event.error || 'renderer error')));
  window.addEventListener('unhandledrejection', (event) => rendererErrors.push(String(event.reason?.stack || event.reason || 'unhandled rejection')));
  function pageDiagnostic() {
    return {
      cardCount: document.querySelectorAll('.asset-card').length,
      selectedId: document.querySelector('.asset-card.selected')?.dataset.id || '',
      confirmOpen: document.querySelector('#confirmDialog')?.classList.contains('open') || false,
      openMenu: document.querySelector('.context-menu')?.textContent?.trim().slice(0, 160) || '',
      toast: document.querySelector('.toast-message, .toast')?.textContent || '',
      statusText: document.querySelector('#statusText')?.textContent || '',
      rendererErrors: rendererErrors.slice(0, 3),
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
    if (!element) throw new Error('Missing control ' + selector);
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
  const cardSelector = (assetId) => '.asset-card[data-id="' + CSS.escape(assetId) + '"]';
  const rootCardIds = () => [...document.querySelectorAll('#assetGrid > .asset-card')].map((card) => card.dataset.id);
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
