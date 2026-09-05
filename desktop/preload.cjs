const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  pasteImage: () => ipcRenderer.invoke("paste-image"),
  writeClipboardText: (text) => ipcRenderer.invoke("write-clipboard-text", text),
  writeClipboardImage: (path) => ipcRenderer.invoke("write-clipboard-image", path),
  setLocale: (locale) => ipcRenderer.invoke("set-locale", locale),
  checkForUpdates: (notify = false) =>
    ipcRenderer.invoke("check-for-updates", notify === true),
  openDownloadPage: () => ipcRenderer.invoke("open-download-page"),
  changeLibraryLocation: () => ipcRenderer.invoke("change-library-location"),
  onMenuImport: (callback) => ipcRenderer.on("menu-import", (_event, ...args) => callback(...args)),
  onMenuSearch: (callback) => ipcRenderer.on("menu-search", (_event, ...args) => callback(...args)),
});
