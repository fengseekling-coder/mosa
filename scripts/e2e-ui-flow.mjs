export function createCriticalUiFlowSource({ mode, fixturePath, searchTerm, versionChange }) {
  const config = JSON.stringify({ mode, fixturePath, searchTerm, versionChange });
  return `
(async () => {
  const config = ${config};
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
    const diagnostic = {
      selectedId: document.querySelector('.asset-card.selected')?.dataset.id || '',
      detailTitle: document.querySelector('#detailTitle')?.textContent || '',
      toast: document.querySelector('.toast-message, .toast')?.textContent || '',
      confirmOpen: document.querySelector('#confirmDialog')?.classList.contains('open') || false,
      detailBusy: document.querySelector('#detailPanel [aria-busy="true"]')?.getAttribute('data-action') || '',
    };
    throw new Error('Timed out waiting for ' + label + (lastError ? ': ' + lastError.message : '') + ' diagnostic=' + JSON.stringify(diagnostic));
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
  function click(selector) {
    const element = document.querySelector(selector);
    if (!element) throw new Error('Missing control ' + selector);
    if (element.disabled) throw new Error('Disabled control ' + selector);
    element.click();
    return element;
  }
  async function search() {
    setValue('#searchInput', config.searchTerm);
    // The search handler is debounced. A pre-existing card can satisfy the
    // result-count assertion before the query has actually committed, which
    // lets the delayed search clear an Inspector opened by the next step. Wait
    // for the query chip first, then for the corresponding request to settle.
    await waitFor(
      () => document.querySelector('[data-chip="query"]')?.textContent?.includes(config.searchTerm),
      'committed search query',
    );
    await waitFor(
      () => document.querySelector('#assetGrid')?.getAttribute('aria-busy') === 'false'
        && document.querySelectorAll('.asset-card').length >= (config.mode === 'verify' ? 2 : 1),
      'search results',
    );
  }
  async function openNewestResult() {
    const card = await waitFor(() => document.querySelector('.asset-card .asset-card-select'), 'asset card');
    card.click();
    await waitFor(
      () => document.querySelector('#detailPanel')?.getAttribute('aria-hidden') === 'false',
      'detail inspector',
    );
  }

  await waitFor(
    () => document.querySelector('#newAssetTopBtn')
      && document.querySelector('#assetGrid')?.getAttribute('aria-busy') === 'false',
    'initialized MOSA application shell',
  );

  if (config.mode === 'exercise') {
    click('#newAssetTopBtn');
    await waitFor(() => document.querySelector('#importModal')?.classList.contains('open'), 'import modal');
    setValue('#imagePathInput', config.fixturePath);
    setValue('#promptInput', config.searchTerm);
    setValue('#groupInput', 'E2E');
    click('#saveAssetBtn');
    await waitFor(() => !document.querySelector('#importModal')?.classList.contains('open'), 'import completion');
    await waitFor(() => document.querySelectorAll('.asset-card').length >= 1, 'imported gallery card');

    await search();
    await openNewestResult();

    let favorite = await waitFor(
      () => document.querySelector('[data-action="toggle-favorite"]'),
      'favorite action',
    );
    if (favorite.getAttribute('aria-pressed') !== 'true') favorite.click();
    favorite = await waitFor(
      () => {
        const button = document.querySelector('[data-action="toggle-favorite"]');
        return button?.getAttribute('aria-pressed') === 'true' ? button : null;
      },
      'favorite persistence in renderer',
    );

    const selectedBefore = document.querySelector('.asset-card.selected')?.dataset.id || '';
    setValue('[data-version-change]', config.versionChange);
    click('[data-action="save-version"]');
    await waitFor(
      () => {
        const selected = document.querySelector('.asset-card.selected')?.dataset.id || '';
        return selected && selected !== selectedBefore ? selected : null;
      },
      'new version selection',
      20000,
    );
    await waitFor(
      () => document.querySelectorAll('[data-version-id]').length >= 2,
      'version history after save',
      20000,
    );
  } else {
    await search();
    await openNewestResult();
    await waitFor(
      () => document.querySelector('[data-action="toggle-favorite"]')?.getAttribute('aria-pressed') === 'true',
      'favorite after restart',
    );
    await waitFor(
      () => document.querySelectorAll('[data-version-id]').length >= 2,
      'version history after restart',
      20000,
    );
    await waitFor(
      () => document.body.textContent.includes(config.versionChange),
      'version change text after restart',
    );
  }

  return {
    mode: config.mode,
    resultCount: document.querySelectorAll('.asset-card').length,
    favorite: document.querySelector('[data-action="toggle-favorite"]')?.getAttribute('aria-pressed') === 'true',
    versionCount: document.querySelectorAll('[data-version-id]').length,
    selectedId: document.querySelector('.asset-card.selected')?.dataset.id || null,
  };
})()
`;
}
