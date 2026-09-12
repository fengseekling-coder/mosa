const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  pasteImage: () => ipcRenderer.invoke("paste-image"),
  writeClipboardText: (text) => ipcRenderer.invoke("write-clipboard-text", text),
  writeClipboardImage: (path) => ipcRenderer.invoke("write-clipboard-image", path),
  setLocale: (locale) => ipcRenderer.invoke("set-locale", locale),
  checkForUpdates: (notify = false) =>
    ipcRenderer.invoke("check-for-updates", notify === true),
  downloadAndInstallUpdate: () => ipcRenderer.invoke("download-and-install-update"),
  cancelUpdateDownload: () => ipcRenderer.invoke("cancel-update-download"),
  reportRendererReady: () => ipcRenderer.invoke("renderer-ready"),
  onUpdateDownloadProgress: (callback) =>
    ipcRenderer.on("update-download-progress", (_event, progress) => callback(progress)),
  openDownloadPage: () => ipcRenderer.invoke("open-download-page"),
  changeLibraryLocation: () => ipcRenderer.invoke("change-library-location"),
  onMenuImport: (callback) => ipcRenderer.on("menu-import", (_event, ...args) => callback(...args)),
  onMenuSearch: (callback) => ipcRenderer.on("menu-search", (_event, ...args) => callback(...args)),
});
