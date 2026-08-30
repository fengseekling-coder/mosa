const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  pasteImage: () => ipcRenderer.invoke("paste-image"),
  writeClipboardText: (text) => ipcRenderer.invoke("write-clipboard-text", text),
  setLocale: (locale) => ipcRenderer.invoke("set-locale", locale),
  checkForUpdates: (notify = false, anonymousUsageEnabled = true) =>
    ipcRenderer.invoke("check-for-updates", notify === true, anonymousUsageEnabled !== false),
  openDownloadPage: () => ipcRenderer.invoke("open-download-page"),
  // Phase 4C：仅暴露「在 Finder 中显示」最小能力——不暴露通用 shell、不暴露任意命令
  // 执行或文件读取能力；路径校验与存在性检查在 main 进程完成。
  showItemInFolder: (path) => ipcRenderer.invoke("show-item-in-folder", path),
  onMenuImport: (callback) => ipcRenderer.on("menu-import", (_event, ...args) => callback(...args)),
  onMenuSearch: (callback) => ipcRenderer.on("menu-search", (_event, ...args) => callback(...args)),
});
