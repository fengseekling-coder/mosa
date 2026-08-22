/**
 * Desktop notification internationalization module.
 * Exports pure functions to resolve notification bodies by key and locale.
 * Supported notification keys: "assetsImported", "updateAvailable", "updateDownloaded"
 * Desktop menu labels are resolved separately so native role items can follow
 * the renderer's app locale without changing the notification API.
 * Supports {count} placeholder for dynamically-counted messages.
 * Default language is "zh" to preserve existing first-run behavior.
 */

const translations = {
  zh: {
    assetsImported: "{count} 个新素材已导入",
    updateAvailable: "有新版本可用，正在下载…",
    updateDownloaded: "新版本已下载，重启后将自动安装。",
  },
  en: {
    assetsImported: "{count} new assets imported",
    assetsImportedSingular: "1 new asset imported",
    updateAvailable: "A new version is available, downloading…",
    updateDownloaded: "New version downloaded. It will be installed on restart.",
  },
};

const desktopTranslations = {
  zh: {
    menuFile: "文件",
    menuImportAsset: "导入素材…",
    menuEdit: "编辑",
    menuView: "视图",
    menuSearch: "搜索",
    menuWindow: "窗口",
    menuAbout: "关于 MOSA",
    menuServices: "服务",
    menuHide: "隐藏 MOSA",
    menuHideOthers: "隐藏其他",
    menuShowAll: "显示全部",
    menuQuit: "退出 MOSA",
    menuClose: "关闭",
    menuUndo: "撤销",
    menuRedo: "重做",
    menuCut: "剪切",
    menuCopy: "拷贝",
    menuPaste: "粘贴",
    menuPasteAndMatchStyle: "粘贴并匹配样式",
    menuDelete: "删除",
    menuSelectAll: "全选",
    menuResetZoom: "重置缩放",
    menuZoomIn: "放大",
    menuZoomOut: "缩小",
    menuToggleFullScreen: "进入全屏",
    menuMinimize: "最小化",
    menuZoom: "缩放",
    menuBringAllToFront: "将全部置于最前",
    startupErrorTitle: "MOSA 无法启动",
  },
  en: {
    menuFile: "File",
    menuImportAsset: "Import Asset…",
    menuEdit: "Edit",
    menuView: "View",
    menuSearch: "Search",
    menuWindow: "Window",
    menuAbout: "About MOSA",
    menuServices: "Services",
    menuHide: "Hide MOSA",
    menuHideOthers: "Hide Others",
    menuShowAll: "Show All",
    menuQuit: "Quit MOSA",
    menuClose: "Close",
    menuUndo: "Undo",
    menuRedo: "Redo",
    menuCut: "Cut",
    menuCopy: "Copy",
    menuPaste: "Paste",
    menuPasteAndMatchStyle: "Paste and Match Style",
    menuDelete: "Delete",
    menuSelectAll: "Select All",
    menuResetZoom: "Reset Zoom",
    menuZoomIn: "Zoom In",
    menuZoomOut: "Zoom Out",
    menuToggleFullScreen: "Toggle Full Screen",
    menuMinimize: "Minimize",
    menuZoom: "Zoom",
    menuBringAllToFront: "Bring All to Front",
    startupErrorTitle: "MOSA could not start",
  },
};

/**
 * Resolve a notification template by key and locale.
 *
 * @param {string} key - One of: "assetsImported", "updateAvailable", "updateDownloaded"
 * @param {string} locale - Target locale, expected "zh" or "en"
 * @returns {string} - Template string (may include placeholders like {count})
 * @throws Will throw if key is unknown. Unsupported locales use the Chinese
 * fallback to preserve the previous first-run behavior.
 */
export function getNotificationText(key, locale) {
  if (!Object.prototype.hasOwnProperty.call(translations.zh, key)) {
    throw new Error(`Unsupported notification key: ${key}`);
  }

  if (locale === "zh" || locale === "en") {
    return translations[locale][key] ?? translations.en[key];
  }
  return translations.zh[key];
}

/**
 * Resolve a native desktop label. Unknown keys fail loudly so adding a menu
 * item cannot silently reintroduce an untranslated string.
 */
export function getDesktopText(key, locale) {
  if (!Object.prototype.hasOwnProperty.call(desktopTranslations.zh, key)) {
    throw new Error(`Unsupported desktop key: ${key}`);
  }
  const language = locale === "zh" || locale === "en" ? locale : "zh";
  return desktopTranslations[language][key];
}

/**
 * Get the final text for the assets-imported notification, replacing the count.
 * English uses the singular form for exactly one imported asset.
 *
 * @param {number} count - Positive integer representing the number of imported assets
 * @param {string} locale - Current locale ("zh" or "en", defaults to "zh")
 * @returns {string} - Fully resolved notification body
 */
export function getNotificationTextForAssetsImported(count, locale) {
  const lang = (locale === "zh" || locale === "en") ? locale : "zh";
  if (lang === "en" && count === 1) {
    return translations.en.assetsImportedSingular;
  }
  const template = translations[lang].assetsImported;
  return template.replace(/\{count\}/g, String(count));
}
