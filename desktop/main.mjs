import { app, BrowserWindow, dialog, session } from "electron";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { startMosaService } from "./service-manager.mjs";

const desktopPort = process.env.MOSA_DESKTOP_PORT || 43519;
const libraryDir = resolve(process.env.MOSA_LIBRARY_DIR || join(homedir(), "MOSA Library"));
let mainWindow = null;
let service = null;
let shuttingDown = false;
let shutdownPromise = null;
let windowPromise = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) {
      void openMainWindow().catch(reportStartupFailure);
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(openMainWindow).catch(reportStartupFailure);

  app.on("activate", () => {
    if (!mainWindow) void openMainWindow().catch(reportStartupFailure);
  });

  // Keep the runtime available after the last window closes, matching normal
  // macOS app behavior. Dock activation recreates the BrowserWindow above.
  app.on("window-all-closed", () => {});

  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    void stopOwnedRuntime().catch(console.error).finally(() => app.exit(0));
  });
}

function openMainWindow() {
  if (mainWindow) {
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
    const desktopDataDir = app.getPath("userData");
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
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const blockForeignNavigation = (event, targetUrl) => {
    if (!isVerifiedMosaUrl(targetUrl, url)) event.preventDefault();
  };
  mainWindow.webContents.on("will-navigate", blockForeignNavigation);
  mainWindow.webContents.on("will-redirect", blockForeignNavigation);
  await mainWindow.loadURL(service.url);
  mainWindow.show();
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

function stopOwnedRuntime() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = service?.mode === "owned" ? service.stop() : Promise.resolve();
  return shutdownPromise;
}

function reportStartupFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox("MOSA could not start", message);
  shuttingDown = true;
  void stopOwnedRuntime().catch(console.error).finally(() => app.exit(1));
}
