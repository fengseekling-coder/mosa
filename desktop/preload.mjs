import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  openFileDialog: () => ipcRenderer.invoke("open-file-dialog"),
  pasteImage: () => ipcRenderer.invoke("paste-image"),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  openFolder: (path) => ipcRenderer.invoke("open-folder", path),
  onMenuImport: (callback) => ipcRenderer.on("menu-import", callback),
  onMenuSearch: (callback) => ipcRenderer.on("menu-search", callback),
});
