export function createCriticalUiFlowSource({ mode, fixturePath, searchTerm, recipeChange }) {
  const config = JSON.stringify({ mode, fixturePath, searchTerm, recipeChange });
  return `
(async () => {
  const config = ${config};
  const editedPrompt = config.searchTerm + ' / ' + config.recipeChange;
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
        && document.querySelectorAll('.asset-card').length >= 1,
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

    const recipeDisclosure = await waitFor(
      () => document.querySelector('[data-inspector-section="prompt"] > details.detail-disclosure'),
      'recipe editing disclosure',
    );
    recipeDisclosure.open = true;
    await waitFor(
      () => document.querySelector('[data-edit="prompt"]')
        && document.querySelector('[data-action="save-recipe"]'),
      'recipe editor',
    );
    setValue('[data-edit="prompt"]', editedPrompt);
    setValue('[data-recipe-change]', config.recipeChange);
    click('[data-action="save-recipe"]');
    await waitFor(
      () => !document.querySelector('[data-detail-dirty="true"][data-detail-dirty-scope="recipe"]'),
      'recipe autosave completion',
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
      () => document.querySelector('[data-edit="prompt"]')?.value === editedPrompt,
      'recipe prompt after restart',
      20000,
    );
    await waitFor(
      () => document.querySelectorAll('[data-recipe-snapshot-id]').length >= 2,
      'recipe snapshot history after restart',
      20000,
    );
    await waitFor(
      () => document.body.textContent.includes(config.recipeChange),
      'recipe change text after restart',
    );
  }

  return {
    mode: config.mode,
    resultCount: document.querySelectorAll('.asset-card').length,
    favorite: document.querySelector('[data-action="toggle-favorite"]')?.getAttribute('aria-pressed') === 'true',
    recipeSnapshotCount: document.querySelectorAll('[data-recipe-snapshot-id]').length,
    selectedId: document.querySelector('.asset-card.selected')?.dataset.id || null,
  };
})()
`;
}

export function createStackUiFlowSource() {
  return `
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function waitFor(check, label, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = check();
      if (value) return value;
      await sleep(100);
    }
    throw new Error('Timed out waiting for ' + label);
  }
  function ctrlClick(element) {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  }
  function doubleClick(element) {
    element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
  }
  function pointer(target, type, x, y, pointerId = 91) {
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: type === 'pointerdown' ? 0 : -1,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: x,
      clientY: y,
    }));
  }

  await waitFor(
    () => document.querySelector('#assetGrid')?.getAttribute('aria-busy') === 'false'
      && document.querySelectorAll('#assetGrid > .asset-card').length >= 2,
    'two root gallery cards',
  );
  const initialCards = [...document.querySelectorAll('#assetGrid > .asset-card')];
  const firstId = initialCards[0].dataset.id;
  const secondId = initialCards[1].dataset.id;
  ctrlClick(initialCards[0].querySelector('.asset-card-select'));
  ctrlClick(initialCards[1].querySelector('.asset-card-select'));
  // A small drag of an existing multi-selection onto one of its own members
  // must be a no-op, not an accidental Stack creation.
  const selfDropFrom = initialCards[0].getBoundingClientRect();
  const selfDropTo = initialCards[1].getBoundingClientRect();
  pointer(initialCards[0].querySelector('.asset-card-select'), 'pointerdown', selfDropFrom.left + selfDropFrom.width / 2, selfDropFrom.top + selfDropFrom.height / 2, 90);
  pointer(window, 'pointermove', selfDropTo.left + selfDropTo.width / 2, selfDropTo.top + selfDropTo.height / 2, 90);
  pointer(window, 'pointerup', selfDropTo.left + selfDropTo.width / 2, selfDropTo.top + selfDropTo.height / 2, 90);
  await sleep(80);
  if (document.querySelector('#assetGrid > .asset-card.is-stack')) throw new Error('Self-drop unexpectedly created a Stack');
  const stackButton = await waitFor(
    () => {
      const button = document.querySelector('#selectionStack');
      return button && !button.disabled ? button : null;
    },
    'enabled Stack action',
  );
  stackButton.click();
  const stackCard = await waitFor(
    () => document.querySelector('#assetGrid > .asset-card.is-stack'),
    'collapsed Stack card',
  );
  const stackId = stackCard.dataset.stackId;
  const rootCountAfterStack = document.querySelectorAll('#assetGrid > .asset-card').length;
  doubleClick(stackCard.querySelector('.asset-card-select'));
  await waitFor(
    () => !document.querySelector('#stackBack')?.hidden
      && document.querySelector('#assetGrid')?.getAttribute('aria-busy') === 'false'
      && document.querySelectorAll('#assetGrid > .asset-card').length === 2,
    'Stack interior',
  );

  let inside = [...document.querySelectorAll('#assetGrid > .asset-card')];
  const originalCoverId = inside[0].dataset.id;
  const reorderCard = inside[1];
  const targetCard = inside[0];
  const reorderId = reorderCard.dataset.id;
  ctrlClick(reorderCard.querySelector('.asset-card-select'));
  const from = reorderCard.getBoundingClientRect();
  const to = targetCard.getBoundingClientRect();
  pointer(reorderCard.querySelector('.asset-card-select'), 'pointerdown', from.left + from.width / 2, from.top + from.height / 2);
  pointer(window, 'pointermove', to.left + Math.max(2, to.width * 0.2), to.top + to.height / 2);
  pointer(window, 'pointerup', to.left + Math.max(2, to.width * 0.2), to.top + to.height / 2);
  await waitFor(
    () => {
      const cards = [...document.querySelectorAll('#assetGrid > .asset-card')];
      return document.querySelector('#assetGrid')?.getAttribute('aria-busy') === 'false'
        && cards[0]?.dataset.id === reorderId;
    },
    'manual reorder and cover change',
  );
  const newCoverId = document.querySelector('#assetGrid > .asset-card')?.dataset.id;
  document.querySelector('#stackBack').click();
  const returnedStack = await waitFor(
    () => document.querySelector('#assetGrid > .asset-card[data-stack-id="' + CSS.escape(stackId) + '"]'),
    'returned Stack node',
  );
  return {
    stackId,
    firstId,
    secondId,
    originalCoverId,
    newCoverId,
    returnedCoverId: returnedStack.dataset.id,
    rootCountAfterStack,
    currentRootCount: document.querySelectorAll('#assetGrid > .asset-card').length,
    stackCount: returnedStack.querySelector('.asset-stack-count')?.textContent || '',
    dualCountLabel: document.querySelector('#assetCount')?.textContent?.includes('·') || false,
  };
})()
`;
}
