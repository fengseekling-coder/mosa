/*
 * LEGACY / NOT LOADED BY ELECTRON.
 *
 * Electron sandboxed preloads must use the CommonJS implementation in
 * preload.cjs. Keep this marker so older source inventories can identify the
 * migration; there is deliberately no second executable API implementation.
 *
 * API contract (implemented only by preload.cjs):
 * openFileDialog: () => ipcRenderer.invoke("open-file-dialog"),
 * pasteImage: () => ipcRenderer.invoke("paste-image"),
 * setLocale: (locale) => ipcRenderer.invoke("set-locale", locale),
 * showItemInFolder: (path) => ipcRenderer.invoke("show-item-in-folder", path),
 * getPathForFile: async (file) => { const p = webUtils.getPathForFile(file); if (!p) return ""; return ipcRenderer.invoke("stage-dropped-file", p); },
 * onMenuImport: (callback),
 * onMenuSearch: (callback),
 */
