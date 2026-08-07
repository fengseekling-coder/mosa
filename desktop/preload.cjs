const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  openFileDialog: () => ipcRenderer.invoke("open-file-dialog"),
  pasteImage: () => ipcRenderer.invoke("paste-image"),
  // Audit fix batch 1.2：拖放文件同样走 staging。这里只把 File 解析出的原始路径
  // 字符串交给主进程，主进程复制进受信任的 import-staging 根后返回 staging 路径；
  // 用户外部原始路径永不跨过桥接到达 renderer。
  getPathForFile: async (file) => {
    const sourcePath = webUtils.getPathForFile(file);
    if (!sourcePath) return "";
    return ipcRenderer.invoke("stage-dropped-file", sourcePath);
  },
  setLocale: (locale) => ipcRenderer.invoke("set-locale", locale),
  // Phase 4C：仅暴露「在 Finder 中显示」最小能力——不暴露通用 shell、不暴露任意命令
  // 执行或文件读取能力；路径校验与存在性检查在 main 进程完成。
  showItemInFolder: (path) => ipcRenderer.invoke("show-item-in-folder", path),
  onMenuImport: (callback) => ipcRenderer.on("menu-import", callback),
  onMenuSearch: (callback) => ipcRenderer.on("menu-search", callback),
});
