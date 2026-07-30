import { app, BrowserWindow, Menu, dialog, ipcMain, clipboard, session, Notification, globalShortcut } from "electron";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MOSA_DESKTOP_PORT } from "../lib/runtime-defaults.mjs";
import { startMosaService } from "./service-manager.mjs";

const __dirname = dirname(fileURLToPath(new URL(".", import.meta.url)));
const desktopDataDir = app.getPath("userData");
const desktopPort = process.env.MOSA_DESKTOP_PORT || DEFAULT_MOSA_DESKTOP_PORT;
const libraryDir = resolve(process.env.MOSA_LIBRARY_DIR || join(homedir(), "MOSA Library"));
const BOUNDS_PATH = join(desktopDataDir, "window-bounds.json");
const DEFAULT_BOUNDS = { width: 1320, height: 860 };

let mainWindow = null;
let service = null;
let shuttingDown = false;
let shutdownPromise = null;
let windowPromise = null;
let ipcRegistered = false;
let shortcutsRegistered = false;
let updatesChecked = false;

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      void openMainWindow().catch(reportStartupFailure);
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(openMainWindow).catch(reportStartupFailure);

  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      void openMainWindow().catch(reportStartupFailure);
    }
  });

  // Keep a desktop-owned runtime available after the last window closes.
  app.on("window-all-closed", () => {});

  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    stopBridgeNotificationPoll();
    globalShortcut.unregisterAll();
    void stopOwnedRuntime().catch(console.error).finally(() => app.exit(0));
  });
}

function loadBounds() {
  try {
    if (existsSync(BOUNDS_PATH)) return JSON.parse(readFileSync(BOUNDS_PATH, "utf-8"));
  } catch {}
  return DEFAULT_BOUNDS;
}

function saveBounds(win) {
  if (!win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) {
    try { writeFileSync(BOUNDS_PATH, JSON.stringify(win.getBounds())); } catch {}
  }
}

function sendToWindow(channel) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel);
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "Import Asset…",
          accelerator: "CmdOrCtrl+N",
          click: () => sendToWindow("menu-import"),
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Search",
          accelerator: "CmdOrCtrl+F",
          click: () => sendToWindow("menu-search"),
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIPC() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle("open-file-dialog", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "svg"] },
        { name: "Video", extensions: ["mp4", "webm", "mov", "m4v"] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle("paste-image", async () => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    const pasteDir = join(desktopDataDir, "pastes");
    mkdirSync(pasteDir, { recursive: true });
    const filePath = join(pasteDir, `paste-${Date.now()}.png`);
    writeFileSync(filePath, image.toPNG());
    return filePath;
  });

  ipcMain.handle("open-folder", async (_event, folderPath) => {
    if (!folderPath) return false;
    const { shell } = await import("electron");
    return (await shell.openPath(folderPath)) === "";
  });
}

function registerGlobalShortcuts() {
  if (shortcutsRegistered) return;
  shortcutsRegistered = true;
  globalShortcut.register("CommandOrControl+N", () => sendToWindow("menu-import"));
  globalShortcut.register("CommandOrControl+F", () => sendToWindow("menu-search"));
}

function openMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return Promise.resolve();
  }
  if (windowPromise) return windowPromise;
  windowPromise = createMainWindow().finally(() => { windowPromise = null; });
  return windowPromise;
}

async function createMainWindow() {
  denyBrowserPermissions();
  if (!service) {
    const appPath = app.getAppPath();
    service = await startMosaService({
      port: desktopPort,
      libraryDir,
      runtimeOptions: {
        projectRoot: appPath,
        managerDir: appPath,
        cowartProjectDir: desktopDataDir,
        appDir: join(appPath, "app"),
        // JSON fallback libraries must remain writable when MOSA is packaged.
        assetsRoot: join(libraryDir, "assets"),
        generatedImagesDir: join(libraryDir, "imports"),
      },
    });
  }

  const url = new URL(service.url);
  const bounds = loadBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on("close", () => saveBounds(mainWindow));
  mainWindow.on("closed", () => {
    mainWindow = null;
    stopBridgeNotificationPoll();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const blockForeignNavigation = (event, targetUrl) => {
    if (!isVerifiedMosaUrl(targetUrl, url)) event.preventDefault();
  };
  mainWindow.webContents.on("will-navigate", blockForeignNavigation);
  mainWindow.webContents.on("will-redirect", blockForeignNavigation);

  buildMenu();
  registerIPC();
  registerGlobalShortcuts();
  await mainWindow.loadURL(service.url);
  mainWindow.show();

  startBridgeNotificationPoll(service.port);
  void checkForUpdates();
}

function denyBrowserPermissions() {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
}

function isVerifiedMosaUrl(targetUrl, expectedUrl) {
  try {
    const candidate = new URL(targetUrl);
    return candidate.protocol === "http:"
      && candidate.hostname === expectedUrl.hostname
      && candidate.port === expectedUrl.port;
  } catch {
    return false;
  }
}

let bridgePollTimer = null;
let lastImportedCount = 0;

function startBridgeNotificationPoll(runtimePort) {
  if (bridgePollTimer) return;
  const interval = 15_000;
  bridgePollTimer = setInterval(async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const response = await fetch(`http://127.0.0.1:${runtimePort}/api/bridges`);
      if (!response.ok) return;
      const data = await response.json();
      const codexImported = Number(data.codex?.totalImported || 0);
      const cowartImported = Number(data.cowart?.totalImported || 0);
      const grokImported = Number(data.grok?.totalImported || 0);
      const totalImported = codexImported + cowartImported + grokImported;
      if (lastImportedCount > 0 && totalImported > lastImportedCount) {
        const delta = totalImported - lastImportedCount;
        const body = delta === 1 ? "1 个新素材已导入" : `${delta} 个新素材已导入`;
        if (Notification.isSupported()) {
          new Notification({ title: "MOSA", body, silent: true }).show();
        }
      }
      lastImportedCount = totalImported;
    } catch {
      // Transient fetch errors are expected during shutdown.
    }
  }, interval);
}

function stopBridgeNotificationPoll() {
  if (bridgePollTimer) {
    clearInterval(bridgePollTimer);
    bridgePollTimer = null;
  }
}

async function checkForUpdates() {
  if (updatesChecked) return;
  updatesChecked = true;
  try {
    const { autoUpdater } = await import("electron-updater");
    autoUpdater.logger = { info: () => {}, warn: console.warn, error: console.error };
    autoUpdater.on("update-available", () => {
      if (Notification.isSupported()) {
        new Notification({ title: "MOSA", body: "有新版本可用，正在下载…" }).show();
      }
    });
    autoUpdater.on("update-downloaded", () => {
      if (Notification.isSupported()) {
        new Notification({ title: "MOSA", body: "新版本已下载，重启后将自动安装。" }).show();
      }
    });
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  } catch {
    // electron-updater is optional; silently ignore if not installed.
  }
}

function stopOwnedRuntime() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = service?.mode === "owned" ? service.stop() : Promise.resolve();
  return shutdownPromise;
}

function reportStartupFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox("MOSA could not start", message);
  shuttingDown = true;
  stopBridgeNotificationPoll();
  void stopOwnedRuntime().catch(console.error).finally(() => app.exit(1));
}
