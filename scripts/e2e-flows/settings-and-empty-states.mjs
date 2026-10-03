// Settings modal (open / Escape / outside-click, theme, language, read-only
// info), refresh persistence, gallery empty states (search miss and empty
// trash), and the narrow-viewport navigation probe. The final phase exercises
// 任务 20's card-info setting: the retired density option stays gone, the new
// segmented control defaults to 隐藏, 显示 really reveals the info block (the
// masonry row grows past the media), the choice survives a fresh page load,
// and 隐藏 restores the hidden state.

import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "settings-and-empty-states";
export const description = "settings modal lifecycle + theme/language persistence + read-only info -> empty-state clear + trash drop-hint rule -> card-info setting (default hidden / show / persist / hide)";

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

    // 任务 20: the card-info setting. Density stays gone (asserted inside the
    // lifecycle phase); the new segmented control defaults to 隐藏, 显示
    // really reveals the info block (the card grows past the media), the
    // choice survives a fresh page load, and 隐藏 restores the hidden state.
    // Each phase runs in its own page; localStorage is shared across them, so
    // a new page is the same thing as a refresh.
    const cardInfoDefault = await ctx.runInPage(server, cardInfoDefaultSource());
    assertCardInfoDefault(cardInfoDefault);
    const cardInfoShown = await ctx.runInPage(server, cardInfoShowSource());
    assertCardInfoShown(cardInfoShown);
    const cardInfoPersisted = await ctx.runInPage(server, cardInfoPersistedSource());
    assertCardInfoPersisted(cardInfoPersisted);
    const cardInfoHidden = await ctx.runInPage(server, cardInfoHideSource());
    assertCardInfoHiddenAgain(cardInfoHidden);

    // 任务 25: the two-pane settings pages. Default page, category switching,
    // roving arrow-key navigation and the language-rebuild focus contract.
    const pages = await ctx.runInPage(server, settingsPagesSource());
    assertSettingsPages(pages);

    return {
      seededIds,
      lifecycle: opened,
      persisted,
      empties,
      cardInfo: { default: cardInfoDefault, shown: cardInfoShown, persisted: cardInfoPersisted, hidden: cardInfoHidden },
      pages,
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

// 任务 20: the card-info setting. The retired density option stays gone; the
// new segmented control defaults to 隐藏 (info block hidden), 显示 really
// displays the info block, and the choice persists in localStorage.
function assertCardInfoDefault(r) {
  const dump = JSON.stringify(r);
  expect(r?.densityOptCount === 0, `settings menu must not render a card density option: ${dump}`);
  expect(r.cardInfoOptCount === 2, `settings menu must render both card-info options: ${dump}`);
  expect(r.showActive === false && r.hideActive === true, `card-info must default to the 隐藏 option highlighted: ${dump}`);
  expect(r.storedBefore === null || r.storedBefore === undefined, `card-info must default to hidden without a stored value: ${dump}`);
  expect(r.infoDisplay === "none", `.asset-card-info must be hidden by default: ${dump}`);
}

function assertCardInfoShown(r) {
  const dump = JSON.stringify(r);
  expect(r?.stored === "show", `the show choice must be persisted to mosa.card-info: ${dump}`);
  expect(r.gridAttr === "show", `#assetGrid must carry data-card-info="show": ${dump}`);
  expect(r.infoDisplay === "block", `card info did not display after switching to show: ${dump}`);
  expect(r.titleText.length > 0, `card info title must have text when shown: ${dump}`);
  expect(r.mediaHeight > 0 && r.cardHeight > r.mediaHeight,
    `card height (${r.cardHeight}) must exceed the media height (${r.mediaHeight}) once info is shown: ${dump}`);
}

function assertCardInfoPersisted(r) {
  const dump = JSON.stringify(r);
  expect(r?.stored === "show", `card-info preference lost after refresh: ${dump}`);
  expect(r.gridAttr === "show", `#assetGrid must still carry data-card-info="show" after refresh: ${dump}`);
  expect(r.infoDisplay === "block", `card info did not stay visible after refresh: ${dump}`);
  expect(r.showActive === true && r.hideActive === false, `settings must highlight 显示 after refresh: ${dump}`);
}

function assertCardInfoHiddenAgain(r) {
  const dump = JSON.stringify(r);
  expect(r?.stored === "hide", `the hide choice must be persisted to mosa.card-info: ${dump}`);
  expect(r.gridAttr === "hide", `#assetGrid must carry data-card-info="hide": ${dump}`);
  expect(r.infoDisplay === "none", `card info did not return to hidden: ${dump}`);
}

// 任务 25: the two-pane settings pages (常规与外观 / 素材库与存储 / 本地视觉能力 /
// 关于 MOSA). Locks the default page, category switching with panel visibility,
// the roving arrow-key navigation and the language-rebuild focus contract.
function assertSettingsPages(r) {
  const dump = JSON.stringify(r);
  expect(r?.default?.selected.join(",") === "true,false,false,false",
    `settings must open on 常规与外观 with only it selected: ${dump}`);
  expect(r.default.hidden.join(",") === "false,true,true,true",
    `the three inactive panels must carry the hidden attribute: ${dump}`);
  expect(r.library?.generalHidden === true && r.library.pathVisible === true,
    `素材库与存储 must show its panel and reveal the library path: ${dump}`);
  expect(r.library?.headTitle === "素材库与存储",
    `the right-pane header must show the current category name: ${dump}`);
  expect(r.keyboard?.visualSelected === true && r.keyboard.focusOnVisualTab === true,
    `ArrowDown must move selection and focus to the next category: ${dump}`);
  expect(r.keyboard?.libraryHidden === true && r.keyboard.visualPanelVisible === true,
    `ArrowDown must swap panel visibility: ${dump}`);
  expect(r.homeKey?.selected === true && r.homeKey.focusOnGeneralTab === true,
    `Home must return to the first category with focus: ${dump}`);
  expect(r.endKey?.selected === true,
    `End must jump to the last category: ${dump}`);
  expect(r.rebuild?.pageKept === true,
    `the language rebuild must keep the current category: ${dump}`);
  expect(r.rebuild?.focusOffBody === true && r.rebuild.focusInMenu === true,
    `focus must not drop to body after the language rebuild: ${dump}`);
  expect(r.rebuild?.focusIsLocaleButton === true,
    `focus should land near the locale control after the rebuild: ${dump}`);
  expect(r.closed === true, `settings should close after the pages check: ${dump}`);
}

// ===== in-page sources =====

function settingsPagesSource() {
  return `(async () => {
    ${PAGE_HELPERS}
    await waitFor(() => gallerySettled() && rootCardIds().length === 2, 'two cards for the pages check');
    click('#settingsToggle');
    await waitFor(() => !document.querySelector('#settingsMenu')?.hidden, 'settings opens for the pages check');
    const tab = (page) => document.querySelector('#settingsMenu [data-settings-page="' + page + '"]');
    const panel = (page) => document.querySelector('#settingsMenu [data-settings-panel="' + page + '"]');
    const PAGES = ['general', 'library', 'visual', 'about'];
    const result = {};

    // 1) 默认停在「常规与外观」：aria-selected 正确，其余三页 hidden。
    await waitFor(() => tab('general')?.getAttribute('aria-selected') === 'true', 'general selected by default');
    result.default = {
      selected: PAGES.map((page) => tab(page)?.getAttribute('aria-selected')),
      hidden: PAGES.map((page) => panel(page)?.hidden === true),
    };

    // 2) 点「素材库与存储」：面板显示、素材库路径可见、右栏标题跟分类名。
    tab('library').click();
    await waitFor(() => panel('library')?.hidden === false, 'library panel visible');
    const pathNode = document.querySelector('#settingsMenu [data-settings-library-path]');
    result.library = {
      generalHidden: panel('general')?.hidden === true,
      pathVisible: Boolean(pathNode) && pathNode.offsetWidth > 0 && pathNode.getBoundingClientRect().height > 0,
      headTitle: document.querySelector('#settingsMenu [data-settings-active-title]')?.textContent || '',
    };

    // 3) 焦点在导航上按 ↓：切到下一分类且焦点跟着走；Home / End 到首 / 末。
    tab('library').focus();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    await waitFor(() => tab('visual')?.getAttribute('aria-selected') === 'true', 'ArrowDown activates the next category');
    result.keyboard = {
      visualSelected: tab('visual')?.getAttribute('aria-selected') === 'true',
      focusOnVisualTab: document.activeElement === tab('visual'),
      libraryHidden: panel('library')?.hidden === true,
      visualPanelVisible: panel('visual')?.hidden === false,
    };
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    await waitFor(() => tab('general')?.getAttribute('aria-selected') === 'true', 'Home returns to general');
    result.homeKey = {
      selected: tab('general')?.getAttribute('aria-selected') === 'true',
      focusOnGeneralTab: document.activeElement === tab('general'),
    };
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    await waitFor(() => tab('about')?.getAttribute('aria-selected') === 'true', 'End jumps to about');
    result.endKey = { selected: tab('about')?.getAttribute('aria-selected') === 'true' };

    // 4) 在「常规与外观」切语言触发重绘：仍停在当前分类，焦点不丢到 body。
    tab('general').click();
    await waitFor(() => panel('general')?.hidden === false, 'back on general');
    const localeValue = document.documentElement.lang === 'en' ? 'zh' : 'en';
    document.querySelector('#settingsMenu [data-locale="' + localeValue + '"]').click();
    await waitFor(() => document.documentElement.lang === localeValue, 'locale switched for the rebuild check');
    await waitFor(() => document.activeElement?.dataset?.locale === localeValue, 'focus lands near the locale control after rebuild');
    result.rebuild = {
      pageKept: tab('general')?.getAttribute('aria-selected') === 'true',
      focusOffBody: document.activeElement !== document.body,
      focusInMenu: document.querySelector('#settingsMenu').contains(document.activeElement),
      focusIsLocaleButton: document.activeElement?.dataset?.locale === localeValue,
    };
    // 还原语言，不给后续阶段留状态。
    document.querySelector('#settingsMenu [data-locale="' + (localeValue === 'en' ? 'zh' : 'en') + '"]').click();
    await waitFor(() => document.documentElement.lang === (localeValue === 'en' ? 'zh-CN' : 'en'), 'locale restored');

    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await waitFor(() => document.querySelector('#settingsMenu')?.hidden === true, 'settings closes after the pages check');
    result.closed = document.querySelector('#settingsMenu')?.hidden === true;
    return result;
  })()`;
}

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

    // 任务 42：主题预览卡的方向键切换——焦点在卡上时 ←/→ 直接切换主题并生效。
    // 走合成 KeyboardEvent（与设置弹窗里 tabs 键盘段同一手法：命中同一 keydown 处理）。
    const arrowTheme = {};
    const themeCards = () => [...document.querySelectorAll('#settingsMenu [data-appearance-opt]')];
    const tabStopCard = themeCards().find((card) => card.tabIndex === 0);
    tabStopCard.focus();
    arrowTheme.focusLandsOnActiveCard = document.activeElement === opt('dark');
    arrowTheme.groupRole = tabStopCard.closest('[role="radiogroup"]')?.getAttribute('aria-label') || '';
    arrowTheme.previewHidden = tabStopCard.querySelector('.settings-theme-preview')?.getAttribute('aria-hidden');
    arrowTheme.activeCardMarked = Boolean(opt('dark').querySelector('.settings-theme-check')?.offsetParent);
    tabStopCard.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    await waitFor(() => document.documentElement.dataset.theme === 'light', 'ArrowLeft flips to light');
    arrowTheme.afterArrowLeft = document.documentElement.dataset.theme;
    arrowTheme.focusFollowsToLight = document.activeElement === opt('light');
    arrowTheme.lightCardChecked = opt('light').getAttribute('aria-checked');
    arrowTheme.lightCardTabIndex = opt('light').tabIndex;
    arrowTheme.darkCardTabIndexAfter = opt('dark').tabIndex;
    opt('light').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    await waitFor(() => document.documentElement.dataset.theme === 'dark', 'ArrowRight flips back to dark');
    arrowTheme.afterArrowRight = document.documentElement.dataset.theme;
    arrowTheme.darkCardCheckedAgain = opt('dark').getAttribute('aria-checked');
    theme.arrowKeys = arrowTheme;

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
    // 任务 25 两栏布局：不在当前分类的控件是隐藏的——读取前先切到对应分类。
    const openPage = async (page) => {
      const pageTab = document.querySelector('#settingsMenu [data-settings-page="' + page + '"]');
      if (pageTab?.getAttribute('aria-selected') !== 'true') {
        pageTab.click();
        await waitFor(() => document.querySelector('#settingsMenu [data-settings-page="' + page + '"]')?.getAttribute('aria-selected') === 'true', page + ' tab selected');
      }
      await waitFor(() => document.querySelector('#settingsMenu [data-settings-panel="' + page + '"]')?.hidden === false, page + ' panel visible');
    };
    await openPage('library');
    const readOnly = {
      libraryPathText: document.querySelector('#settingsMenu [data-settings-library-path]')?.textContent || '',
      storageText: document.querySelector('#settingsMenu [data-settings-storage-engine]')?.textContent || '',
      hasChangeLibraryButton: Boolean(document.querySelector('#settingsMenu [data-change-library]')),
      hasOpenLibraryButton: Boolean(document.querySelector('#settingsMenu [data-open-library]')),
    };
    await openPage('about');
    readOnly.versionText = document.querySelector('#settingsMenu [data-settings-version]')?.textContent || '';
    await openPage('general');

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

function cardInfoDefaultSource() {
  return `(async () => {
    ${PAGE_HELPERS}
    await waitFor(() => gallerySettled() && rootCardIds().length === 2, 'two cards for the card-info default check');
    click('#settingsToggle');
    await waitFor(() => !document.querySelector('#settingsMenu')?.hidden, 'settings opens for the card-info default check');
    const result = {
      densityOptCount: document.querySelectorAll('#settingsMenu [data-density-opt]').length,
      cardInfoOptCount: document.querySelectorAll('#settingsMenu [data-card-info-opt]').length,
      showActive: document.querySelector('#settingsMenu [data-card-info-opt="show"]')?.classList.contains('active') === true,
      hideActive: document.querySelector('#settingsMenu [data-card-info-opt="hide"]')?.classList.contains('active') === true,
      storedBefore: localStorage.getItem('mosa.card-info'),
    };
    click('#settingsMenu .settings-modal-close');
    await waitFor(() => document.querySelector('#settingsMenu')?.hidden === true, 'settings closes after the card-info default check');
    const info = document.querySelector('#assetGrid .asset-card .asset-card-info');
    if (!info) throw new Error('card info area missing from the gallery markup');
    result.infoDisplay = getComputedStyle(info).display;
    return result;
  })()`;
}

function cardInfoShowSource() {
  return `(async () => {
    ${PAGE_HELPERS}
    await waitFor(() => gallerySettled() && rootCardIds().length === 2, 'two cards before showing card info');
    click('#settingsToggle');
    await waitFor(() => !document.querySelector('#settingsMenu')?.hidden, 'settings opens to show card info');
    document.querySelector('#settingsMenu [data-card-info-opt="show"]').click();
    await waitFor(() => localStorage.getItem('mosa.card-info') === 'show', 'the show choice is stored');
    click('#settingsMenu .settings-modal-close');
    await waitFor(() => document.querySelector('#settingsMenu')?.hidden === true, 'settings closes after showing card info');
    await waitFor(() => gallerySettled(), 'gallery settles after the card-info switch');
    const card = document.querySelector('#assetGrid .asset-card');
    const info = card?.querySelector(':scope > .asset-card-info');
    if (!info) throw new Error('card info area missing after switching to show');
    const media = card.querySelector(':scope > .asset-card-select');
    return {
      stored: localStorage.getItem('mosa.card-info'),
      gridAttr: document.querySelector('#assetGrid')?.dataset.cardInfo ?? null,
      infoDisplay: getComputedStyle(info).display,
      titleText: info.querySelector('.asset-card-title')?.textContent || '',
      mediaHeight: media ? media.getBoundingClientRect().height : 0,
      cardHeight: card.getBoundingClientRect().height,
    };
  })()`;
}

function cardInfoPersistedSource() {
  return `(async () => {
    ${PAGE_HELPERS}
    await waitFor(() => gallerySettled() && rootCardIds().length === 2, 'two cards after refresh');
    // Fresh page (== refresh): mosa.card-info still says show and the info
    // block is visible without any interaction.
    const card = document.querySelector('#assetGrid .asset-card');
    const info = card?.querySelector(':scope > .asset-card-info');
    if (!info) throw new Error('card info area missing after refresh');
    const result = {
      stored: localStorage.getItem('mosa.card-info'),
      gridAttr: document.querySelector('#assetGrid')?.dataset.cardInfo ?? null,
      infoDisplay: getComputedStyle(info).display,
    };
    click('#settingsToggle');
    await waitFor(() => !document.querySelector('#settingsMenu')?.hidden, 'settings opens for the persistence check');
    result.showActive = document.querySelector('#settingsMenu [data-card-info-opt="show"]')?.classList.contains('active') === true;
    result.hideActive = document.querySelector('#settingsMenu [data-card-info-opt="hide"]')?.classList.contains('active') === true;
    click('#settingsMenu .settings-modal-close');
    await waitFor(() => document.querySelector('#settingsMenu')?.hidden === true, 'settings closes after the persistence check');
    return result;
  })()`;
}

function cardInfoHideSource() {
  return `(async () => {
    ${PAGE_HELPERS}
    await waitFor(() => gallerySettled() && rootCardIds().length === 2, 'two cards before hiding card info');
    click('#settingsToggle');
    await waitFor(() => !document.querySelector('#settingsMenu')?.hidden, 'settings opens to hide card info');
    document.querySelector('#settingsMenu [data-card-info-opt="hide"]').click();
    await waitFor(() => localStorage.getItem('mosa.card-info') === 'hide', 'the hide choice is stored');
    click('#settingsMenu .settings-modal-close');
    await waitFor(() => document.querySelector('#settingsMenu')?.hidden === true, 'settings closes after hiding card info');
    await waitFor(() => gallerySettled(), 'gallery settles after hiding card info');
    const info = document.querySelector('#assetGrid .asset-card .asset-card-info');
    if (!info) throw new Error('card info area missing after switching back to hide');
    return {
      stored: localStorage.getItem('mosa.card-info'),
      gridAttr: document.querySelector('#assetGrid')?.dataset.cardInfo ?? null,
      infoDisplay: getComputedStyle(info).display,
    };
  })()`;
}
