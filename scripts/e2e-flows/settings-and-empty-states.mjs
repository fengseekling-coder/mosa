// Settings modal (open / Escape / outside-click, theme, language, read-only
// info), refresh persistence, gallery empty states (search miss and empty
// trash), and the narrow-viewport navigation probe. The final step regresses
// 任务 17: the card density setting is gone — the settings menu renders no
// density option and the image-only gallery keeps .asset-card-info hidden.

import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "settings-and-empty-states";
export const description = "settings modal lifecycle + theme/language persistence + read-only info -> empty-state clear + trash drop-hint rule -> density setting removed (image-only gallery)";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const alpha = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("settings-alpha.png", [74, 127, 181]), prompt: "settings flow alpha",
    });
    const beta = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("settings-beta.png", [181, 68, 74]), prompt: "settings flow beta",
    });
    const seededIds = [alpha.asset.id, beta.asset.id].sort();
    const health = await ctx.api(server.origin, "GET", "/api/health");
    const libraryPath = await ctx.api(server.origin, "GET", "/api/library-path?project=default");
    const config = { missingTerm: `no-such-asset-${Date.now().toString(36)}` };

    const opened = await ctx.runInPage(server, settingsLifecycleSource(config));
    assertSettingsLifecycle(opened, seededIds, health, libraryPath, ctx);

    // Refresh: every setting survives because localStorage lives in this
    // flow's userData dir, shared by all runInPage calls below.
    const persisted = await ctx.runInPage(server, persistedSettingsSource(config));
    assertPersistedSettings(persisted, opened, seededIds);

    const empties = await ctx.runInPage(server, emptyStatesSource(config));
    await assertEmptyStates(empties, seededIds, server, ctx);

    // 任务 17 regression (ordered last, after the other phases): the card
    // density setting is gone — no density option in the settings menu, and
    // .asset-card-info stays invisible in the image-only gallery.
    const densityGone = await ctx.runInPage(server, densitySettingGoneSource());
    assertDensitySettingGone(densityGone);

    return {
      seededIds,
      lifecycle: opened,
      persisted,
      empties,
      densitySettingGone: densityGone,
    };
  } finally {
    await server.stop();
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function assertSettingsLifecycle(r, seededIds, health, libraryPath, ctx) {
  const dump = JSON.stringify(r);
  expect(r?.zh?.lang === "zh-CN", `expected zh-CN baseline after locale normalisation: ${dump}`);
  expect(r.zh.viewTitle === "所有素材" && r.zh.filterAll === "所有素材", `zh baseline texts wrong: ${dump}`);
  expect(r.open?.focusInDialog === true, `focus did not enter the settings dialog: ${dump}`);
  expect(r.open?.ariaExpanded === "true", `settingsToggle aria-expanded not true while open: ${dump}`);
  expect(r.escapeClose?.menuHidden === true && r.escapeClose?.focusOnToggle === true,
    `Escape did not close settings and restore focus to the toggle: ${dump}`);
  expect(r.escapeClose?.ariaExpanded === "false", `aria-expanded not false after Escape: ${dump}`);
  expect(r.outsideClose?.menuHidden === true && r.outsideClose?.focusOnToggle === true,
    `outside click did not close settings (focus should return to toggle): ${dump}`);
  expect(r.reopened?.menuOpen === true, `settings did not reopen for the preference steps: ${dump}`);

  const theme = r.theme;
  expect(theme.htmlThemeBefore === "light", `expected light theme before switching: ${dump}`);
  expect(theme.htmlThemeDark === "dark" && theme.bodyBgDark !== theme.bodyBgLight,
    `dark theme marker/background did not change: ${dump}`);
  expect(theme.darkRadioActive === true && theme.darkRadioChecked === "true",
    `dark option not marked active/aria-checked: ${dump}`);
  expect(theme.storedDark === "true", `localStorage mosa-dark-mode not "true": ${dump}`);
  expect(theme.htmlThemeLightAgain === "light" && theme.bodyBgLightAgain === theme.bodyBgLight,
    `switching back to light did not restore the light background: ${dump}`);
  expect(theme.bodyBgDarkAgain === theme.bodyBgDark, `second dark switch changed the background: ${dump}`);

  const density = r.density;
  expect(density.densityOptCount === 0, `settings menu must not render card density options: ${dump}`);
  expect(density.gridDensityAttr === null, `assetGrid must not carry a density attribute: ${dump}`);

  const lang = r.language;
  expect(lang.htmlLang === "en" && lang.viewTitle === "All assets" && lang.filterAll === "All assets",
    `en locale did not switch title/quick filter: ${dump}`);
  expect(lang.filterFavorite === "Favorites" && lang.searchPlaceholder === "Search all assets...",
    `en locale did not switch favourites/placeholder: ${dump}`);
  expect(lang.stored === "en" && lang.themeLightLabel === "Light",
    `en locale not stored / settings copy not rebuilt: ${dump}`);

  const info = r.readOnly;
  expect(info.libraryPathText === ctx.libraryDir && libraryPath.libraryDir === ctx.libraryDir,
    `settings library path mismatch: shown=${info.libraryPathText} ctx=${ctx.libraryDir} api=${libraryPath.libraryDir}`);
  expect(info.storageText.startsWith("SQLite"), `storage engine does not show SQLite: ${dump}`);
  expect(health.productVersion && health.productVersion !== "unknown", `health productVersion missing: ${JSON.stringify(health)}`);
  expect(info.versionText === `v${health.productVersion}`, `settings version ${info.versionText} != v${health.productVersion}`);
  // Web mode (sandboxed driver has no preload, so window.electronAPI is
  // undefined): renderSettingsMenu renders no change-library button at all,
  // while open-library stays per code (it works over /api/open-folder).
  expect(info.hasChangeLibraryButton === false, `data-change-library rendered without electronAPI: ${dump}`);
  expect(info.hasOpenLibraryButton === true, `data-open-library missing (code renders it in web mode): ${dump}`);

  expect(r.closeButton?.menuHidden === true, `settings close button did not close: ${dump}`);
  expect(r.mobileProbe?.queryMatches === false && r.mobileProbe?.toggleDisplay === "none",
    `mobile nav controls must stay hidden at the fixed 1280x800 driver viewport: ${JSON.stringify(r.mobileProbe)}`);
  expect(r.mobileProbe?.matchMediaAfterShrink === false,
    `documentElement.style.width unexpectedly changed the media query: ${JSON.stringify(r.mobileProbe)}`);
}

function assertPersistedSettings(r, opened, seededIds) {
  const dump = JSON.stringify(r);
  expect(r?.theme?.htmlTheme === "dark" && r.theme.stored === "true",
    `theme not remembered after refresh: ${dump}`);
  expect(r.theme.bodyBg === opened.theme.bodyBgDark,
    `dark background changed across refresh: kept=${r.theme.bodyBg} before=${opened.theme.bodyBgDark}`);
  expect(r.language?.stillEn === true, `language not remembered after refresh: ${dump}`);
  expect(r.backToZh?.htmlLang === "zh-CN" && r.backToZh?.viewTitle === "所有素材",
    `switching back to zh failed: ${dump}`);
  expect(r.backToZh?.filterAll === "所有素材" && r.backToZh?.searchPlaceholder === "搜索所有素材...",
    `zh copy incomplete after switching back: ${dump}`);
  expect(r.backToZh?.stored === "zh", `zh preference not stored: ${dump}`);
  expect(JSON.stringify(r.cardIds?.slice().sort()) === JSON.stringify(seededIds),
    `gallery cards wrong after refresh: ${dump}`);
}

async function assertEmptyStates(r, seededIds, server, ctx) {
  const dump = JSON.stringify(r);
  const search = r?.searchEmpty;
  expect(search?.kind === "no-results" && search.cardCount === 0,
    `search miss did not render the no-results empty state: ${dump}`);
  expect(search.hasClear === true, `empty-clear missing on the search empty state: ${dump}`);
  expect(search.dropHintText === "把图片或文件夹拖进窗口，或直接粘贴剪贴板图片即可导入" && search.paragraphCount === 2,
    `drop hint wrong/missing on the search empty state: ${dump}`);
  // Dead handlers: the click router matches empty-view-all / empty-open-library
  // (app.mjs empty-state comment "清除与查看全部共用同一个 reset helper"), but the
  // current galleryEmptyMarkup renders neither button.
  expect(search.hasViewAll === false && search.hasOpenLibrary === false,
    `empty-view-all/empty-open-library unexpectedly rendered: ${dump}`);
  expect(JSON.stringify(r.afterClear?.cardIds?.slice().sort()) === JSON.stringify(seededIds),
    `empty-clear did not restore all assets: ${dump}`);
  expect(r.afterClear?.searchValue === "", `empty-clear left the query in the input: ${dump}`);

  const trash = r?.trashEmpty;
  expect(trash?.kind === "no-results" && trash.cardCount === 0, `empty trash view missing empty state: ${dump}`);
  // 回收站是只读范围：galleryEmptyMarkup drops the import hint paragraph, so the
  // copy keeps only the description <p> (paragraphCount 1) — the rule decided earlier.
  expect(trash.paragraphCount === 1 && trash.lastParagraphText === "尝试调整搜索词或筛选条件",
    `trash empty state must not show the drag-to-import hint (定下的规则): ${dump}`);
  expect(trash.viewTitle === "回收站" && trash.emptyTrashBtnHidden === true,
    `trash header wrong for an empty trash: ${dump}`);
  expect(trash.hasClear === true, `empty-clear missing on the trash empty state: ${dump}`);
  expect(JSON.stringify(r.afterTrashClear?.cardIds?.slice().sort()) === JSON.stringify(seededIds),
    `trash empty-clear did not return to all assets: ${dump}`);
  expect(r.afterTrashClear?.viewTitle === "所有素材", `view title not reset after trash clear: ${dump}`);

  // Re-check the key result through the API: the UI round must not have moved
  // anything in or out of the library or the trash.
  const normalListing = await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=250");
  const trashListing = await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=250&trash=1");
  const normalIds = (normalListing.assets || []).map((asset) => asset.id).sort();
  const trashIds = (trashListing.assets || []).map((asset) => asset.id);
  if (JSON.stringify(normalIds) !== JSON.stringify(seededIds) || trashIds.length) {
    throw new Error(`API cross-check after empty-state round failed: normal=${JSON.stringify(normalIds)} trash=${JSON.stringify(trashIds)}`);
  }
}

// 任务 17: the card density setting is gone. The settings menu renders no
// data-density-opt control, and the always-image-only gallery keeps the card
// info block (kept in markup) hidden.
function assertDensitySettingGone(r) {
  expect(r?.densityOptCount === 0, `settings menu must not render a card density option: ${JSON.stringify(r)}`);
  expect(r.infoDisplay === "none", `.asset-card-info must stay hidden in the image-only gallery: ${JSON.stringify(r)}`);
}

// ===== in-page sources =====

function settingsLifecycleSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    await waitFor(() => gallerySettled() && rootCardIds().length === 2, 'two seeded cards');

    const toggle = document.querySelector('#settingsToggle');
    const menuOpen = async () => {
      toggle.focus();
      click('#settingsToggle');
      await waitFor(() => !document.querySelector('#settingsMenu')?.hidden
        && document.querySelector('#settingsMenu .settings-modal-card'), 'settings modal opens');
      await waitFor(() => document.activeElement === document.querySelector('#settingsMenu .settings-modal-card'),
        'focus moves into the settings dialog');
    };
    const menuHidden = () => document.querySelector('#settingsMenu')?.hidden === true;

    await menuOpen();
    const open = {
      focusInDialog: document.activeElement === document.querySelector('#settingsMenu .settings-modal-card'),
      ariaExpanded: toggle.getAttribute('aria-expanded'),
    };
    // Normalise the locale first: the sandbox resolves "system" from the OS, so
    // anchor every later zh/en comparison by explicitly selecting 中文.
    document.querySelector('#settingsMenu [data-locale="zh"]')?.click();
    await waitFor(() => document.documentElement.lang === 'zh-CN', 'zh locale normalised');
    const zh = {
      lang: document.documentElement.lang,
      viewTitle: document.querySelector('#viewTitle')?.textContent || '',
      filterAll: document.querySelector('#quickFilters [data-filter="all"] .nav-item-text')?.textContent || '',
    };

    // Escape closes; focus returns to the toggle (settingsReturnFocus).
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await waitFor(menuHidden, 'settings closes on Escape');
    const escapeClose = {
      menuHidden: menuHidden(),
      focusOnToggle: document.activeElement === toggle,
      ariaExpanded: toggle.getAttribute('aria-expanded'),
    };

    // Reopen, then close by clicking the overlay outside the dialog card.
    await menuOpen();
    document.querySelector('#settingsMenu').click();
    await waitFor(menuHidden, 'settings closes on outside click');
    const outsideClose = {
      menuHidden: menuHidden(),
      focusOnToggle: document.activeElement === toggle,
    };

    await menuOpen();
    const reopened = { menuOpen: !menuHidden() };

    // Theme: light baseline -> dark -> light -> dark (left dark for refresh).
    const bodyBg = () => getComputedStyle(document.body).backgroundColor;
    const opt = (value) => document.querySelector('#settingsMenu [data-appearance-opt="' + value + '"]');
    const theme = {
      htmlThemeBefore: document.documentElement.dataset.theme,
      bodyBgLight: bodyBg(),
    };
    opt('dark').click();
    await waitFor(() => document.documentElement.dataset.theme === 'dark', 'dark theme applied');
    theme.htmlThemeDark = document.documentElement.dataset.theme;
    theme.bodyBgDark = bodyBg();
    theme.darkRadioActive = opt('dark').classList.contains('active');
    theme.darkRadioChecked = opt('dark').getAttribute('aria-checked');
    theme.storedDark = localStorage.getItem('mosa-dark-mode');
    opt('light').click();
    await waitFor(() => document.documentElement.dataset.theme === 'light', 'light theme restored');
    theme.htmlThemeLightAgain = document.documentElement.dataset.theme;
    theme.bodyBgLightAgain = bodyBg();
    opt('dark').click();
    await waitFor(() => document.documentElement.dataset.theme === 'dark', 'dark theme reapplied');
    theme.bodyBgDarkAgain = bodyBg();

    // Density setting is gone: the menu renders no data-density-opt control
    // and the grid carries no density attribute (image-only gallery).
    const density = {
      densityOptCount: document.querySelectorAll('#settingsMenu [data-density-opt]').length,
      gridDensityAttr: document.querySelector('#assetGrid')?.dataset.density ?? null,
    };

    // Language: zh -> en.
    document.querySelector('#settingsMenu [data-locale="en"]').click();
    await waitFor(() => document.documentElement.lang === 'en', 'en locale applied');
    const language = {
      htmlLang: document.documentElement.lang,
      viewTitle: document.querySelector('#viewTitle')?.textContent || '',
      filterAll: document.querySelector('#quickFilters [data-filter="all"] .nav-item-text')?.textContent || '',
      filterFavorite: document.querySelector('#quickFilters [data-filter="favorite"] .nav-item-text')?.textContent || '',
      searchPlaceholder: document.querySelector('#searchInput')?.placeholder || '',
      stored: localStorage.getItem('mosa.ui-language'),
      themeLightLabel: document.querySelector('#settingsMenu [data-appearance-opt="light"]')?.textContent || '',
    };

    // Read-only info + web-mode library buttons (observed, never clicked).
    const readOnly = {
      libraryPathText: document.querySelector('#settingsMenu [data-settings-library-path]')?.textContent || '',
      storageText: document.querySelector('#settingsMenu [data-settings-storage-engine]')?.textContent || '',
      versionText: document.querySelector('#settingsMenu [data-settings-version]')?.textContent || '',
      hasChangeLibraryButton: Boolean(document.querySelector('#settingsMenu [data-change-library]')),
      hasOpenLibraryButton: Boolean(document.querySelector('#settingsMenu [data-open-library]')),
    };

    click('#settingsMenu .settings-modal-close');
    await waitFor(menuHidden, 'settings closes via its close button');
    const closeButton = { menuHidden: menuHidden() };

    // Narrow-viewport probe at the fixed 1280x800 driver viewport: the drawer
    // controls belong to (max-width: 767px); documentElement.style.width is a
    // layout change, not a viewport change, so it cannot trigger them.
    const mobileProbe = {
      viewportWidth: window.innerWidth,
      queryMatches: window.matchMedia('(max-width: 767px)').matches,
      toggleDisplay: getComputedStyle(document.querySelector('#mobileNavToggle')).display,
      scrimHidden: document.querySelector('#mobileNavScrim')?.hidden === true,
      closeDisplay: getComputedStyle(document.querySelector('#mobileNavClose')).display,
    };
    document.documentElement.style.width = '600px';
    mobileProbe.matchMediaAfterShrink = window.matchMedia('(max-width: 767px)').matches;
    mobileProbe.toggleDisplayAfterShrink = getComputedStyle(document.querySelector('#mobileNavToggle')).display;
    document.documentElement.style.width = '';

    return { open, zh, escapeClose, outsideClose, reopened, theme, density, language, readOnly, closeButton, mobileProbe };
  })()`;
}

function persistedSettingsSource() {
  return `(async () => {
    ${PAGE_HELPERS}
    await waitFor(() => gallerySettled() && rootCardIds().length === 2, 'two cards after refresh');
    const theme = {
      htmlTheme: document.documentElement.dataset.theme,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      stored: localStorage.getItem('mosa-dark-mode'),
    };
    const language = {
      stillEn: document.documentElement.lang === 'en'
        && document.querySelector('#viewTitle')?.textContent === 'All assets'
        && document.querySelector('#searchInput')?.placeholder === 'Search all assets...',
    };
    // Finally switch back to 中文.
    click('#settingsToggle');
    await waitFor(() => !document.querySelector('#settingsMenu')?.hidden, 'settings opens for zh switch');
    document.querySelector('#settingsMenu [data-locale="zh"]').click();
    await waitFor(() => document.documentElement.lang === 'zh-CN', 'zh locale restored');
    const backToZh = {
      htmlLang: document.documentElement.lang,
      viewTitle: document.querySelector('#viewTitle')?.textContent || '',
      filterAll: document.querySelector('#quickFilters [data-filter="all"] .nav-item-text')?.textContent || '',
      searchPlaceholder: document.querySelector('#searchInput')?.placeholder || '',
      stored: localStorage.getItem('mosa.ui-language'),
    };
    return { theme, language, backToZh, cardIds: rootCardIds() };
  })()`;
}

function emptyStatesSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    await waitFor(() => gallerySettled() && rootCardIds().length === 2, 'two cards before empty states');

    setValue('#searchInput', config.missingTerm);
    await waitFor(() => document.querySelector('#assetGrid .gallery-empty-state'), 'empty state for the missing search');
    const searchEmpty = {
      kind: document.querySelector('#assetGrid .gallery-empty-state')?.dataset.emptyKind,
      cardCount: rootCardIds().length,
      hasClear: Boolean(document.querySelector('#assetGrid [data-action="empty-clear"]')),
      hasViewAll: Boolean(document.querySelector('#assetGrid [data-action="empty-view-all"]')),
      hasOpenLibrary: Boolean(document.querySelector('#assetGrid [data-action="empty-open-library"]')),
      paragraphCount: document.querySelectorAll('#assetGrid .gallery-empty-state .empty-state-copy p').length,
      dropHintText: [...document.querySelectorAll('#assetGrid .gallery-empty-state .empty-state-copy p')].pop()?.textContent || '',
    };
    click('#assetGrid [data-action="empty-clear"]');
    await waitFor(() => gallerySettled() && rootCardIds().length === 2, 'empty-clear restores all assets');
    const afterClear = {
      cardIds: rootCardIds(),
      searchValue: document.querySelector('#searchInput')?.value || '',
    };

    click('#quickFilters .nav-item[data-filter="trash"]');
    await waitFor(() => document.querySelector('#assetGrid .gallery-empty-state') && rootCardIds().length === 0,
      'empty state in the trash scope');
    const trashEmpty = {
      kind: document.querySelector('#assetGrid .gallery-empty-state')?.dataset.emptyKind,
      cardCount: rootCardIds().length,
      hasClear: Boolean(document.querySelector('#assetGrid [data-action="empty-clear"]')),
      paragraphCount: document.querySelectorAll('#assetGrid .gallery-empty-state .empty-state-copy p').length,
      lastParagraphText: [...document.querySelectorAll('#assetGrid .gallery-empty-state .empty-state-copy p')].pop()?.textContent || '',
      viewTitle: document.querySelector('#viewTitle')?.textContent || '',
      emptyTrashBtnHidden: document.querySelector('#emptyTrashBtn')?.hidden === true,
    };
    click('#assetGrid [data-action="empty-clear"]');
    await waitFor(() => gallerySettled() && rootCardIds().length === 2, 'trash empty-clear returns to all');
    const afterTrashClear = {
      cardIds: rootCardIds(),
      viewTitle: document.querySelector('#viewTitle')?.textContent || '',
    };
    return { searchEmpty, afterClear, trashEmpty, afterTrashClear };
  })()`;
}

function densitySettingGoneSource() {
  return `(async () => {
    ${PAGE_HELPERS}
    await waitFor(() => gallerySettled() && rootCardIds().length === 2, 'two cards for the density check');
    click('#settingsToggle');
    await waitFor(() => !document.querySelector('#settingsMenu')?.hidden, 'settings opens for the density check');
    const densityOptCount = document.querySelectorAll('#settingsMenu [data-density-opt]').length;
    click('#settingsMenu .settings-modal-close');
    await waitFor(() => document.querySelector('#settingsMenu')?.hidden === true, 'settings closes after the density check');
    const info = document.querySelector('#assetGrid .asset-card .asset-card-info');
    if (!info) throw new Error('card info area missing from the gallery markup');
    const infoDisplay = getComputedStyle(info).display;
    return { densityOptCount, infoDisplay };
  })()`;
}
