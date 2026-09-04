import { app, BrowserWindow, Menu, dialog, ipcMain, clipboard, nativeImage, session, shell, Notification } from "electron";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MOSA_DESKTOP_PORT, MOSA_RESERVED_PRODUCTION_PORTS } from "../lib/runtime-defaults.mjs";
import { validateRuntimeIsolation } from "../lib/runtime-isolation-guard.mjs";
import { parseDisabledBridges } from "../lib/runtime-bridges.mjs";
import { cleanupOrphanStagedFiles, importStagingDir, writeStagedPng } from "../lib/import-staging.mjs";
import { shouldAllowSameVersionServiceReplacement, shouldAllowStaleServiceUpgrade, startMosaService } from "./service-manager.mjs";
import { getDesktopText, getNotificationTextForAssetsImported, getUpdateNotificationText } from "./notification-i18n.mjs";
import { loadOrCreateWebCaptureToken, MOSA_WEB_CAPTURE_DEFAULT_ORIGINS } from "./web-capture-pairing.mjs";
import { desktopPlatformAdapter } from "./platform/index.mjs";
import { checkForMosaUpdate, MOSA_DOWNLOAD_PAGE_URL, reportAnonymousUsage } from "./update-service.mjs";
import { prepareAnonymousUsage } from "./anonymous-usage.mjs";
import { resolveAllowedFolderPath } from "../lib/server-security.js";
import { isPathInsideOrEqual, isUrlLikePath, pathsEqual } from "../lib/path-safety.mjs";
import { getBuildIdentity } from "../lib/build-identity.mjs";
import { MOSA_SERVICE_PROTOCOL_VERSION } from "../lib/version-identities.mjs";

const preloadPath = fileURLToPath(new URL("./preload.cjs", import.meta.url));
const desktopPlatform = desktopPlatformAdapter();
// The parent of this module's own directory is the application root: the
// repository root in dev (electron desktop/main.mjs) and the app.asar root
// when packaged. Deriving it from the module location keeps both modes on a
// single source of truth instead of the app path API.
const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const expectedServiceIdentity = Object.freeze({
  ...getBuildIdentity(join(appRoot, "app")),
  serviceProtocolVersion: MOSA_SERVICE_PROTOCOL_VERSION,
});
// `desktopDataDir` is the *actual* userData after Chromium applied the QA
// --user-data-dir override (if any). It is deliberately NOT the production
// default: Electron rewrites userData before any JS runs, so the un-overridden
// default must be reconstructed from appData + app.name, which the switch
// never touches. Dev (`npx electron`) reads the name from package.json
// ("mosa"); the packaged app carries the forge packagerConfig name ("MOSA").
const desktopDataDir = app.getPath("userData");
const productionDefaultUserData = join(app.getPath("appData"), app.name);
const importStagingRoot = importStagingDir(desktopDataDir);
const desktopPort = process.env.MOSA_DESKTOP_PORT || DEFAULT_MOSA_DESKTOP_PORT;
const LIBRARY_LOCATION_PATH = join(desktopDataDir, "library-location.json");
const defaultLibraryDir = join(homedir(), "MOSA Library");

function loadSavedLibraryDir() {
  try {
    const value = JSON.parse(readFileSync(LIBRARY_LOCATION_PATH, "utf8"));
    if (typeof value?.path === "string" && isAbsolute(value.path)) return resolve(value.path);
  } catch {}
  return null;
}

function saveLibraryDir(nextLibraryDir) {
  mkdirSync(dirname(LIBRARY_LOCATION_PATH), { recursive: true });
  const temporaryPath = `${LIBRARY_LOCATION_PATH}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify({ path: resolve(nextLibraryDir) })}\n`, "utf8");
  // The userData directory is local and same-volume, so a rename gives us an
  // atomic preference switch without ever exposing a partially-written path.
  renameSync(temporaryPath, LIBRARY_LOCATION_PATH);
}

let libraryDir = resolve(process.env.MOSA_LIBRARY_DIR || loadSavedLibraryDir() || defaultLibraryDir);

// ---- Runtime isolation context (single source of truth, three layers) ----
// The same context object is passed explicitly through validateRuntimeIsolation,
// startMosaService and (via service-manager) startMosaRuntime. Propagation never
// relies on process.env, so a caller-supplied QA override cannot be dropped or
// replaced by an unrelated environment value somewhere down the chain.
const isolationContext = {
  runtimeMode: process.env.MOSA_RUNTIME_MODE,
  qaRun: process.env.MOSA_QA_RUN,
  expectedUserData: process.env.MOSA_USER_DATA,
  actualUserData: desktopDataDir,
  productionDefaultUserData,
  argv: process.argv,
  runtimeKind: "electron",
};

// ---- Runtime isolation guard: fail closed before any production write ----
const guard = validateRuntimeIsolation({
  libraryDir: process.env.MOSA_LIBRARY_DIR,
  port: desktopPort,
  runtimeMode: isolationContext.runtimeMode,
  qaRun: isolationContext.qaRun,
  userData: isolationContext.expectedUserData,
  actualUserData: isolationContext.actualUserData,
  defaultUserData: isolationContext.productionDefaultUserData,
  argv: isolationContext.argv,
  runtimeKind: isolationContext.runtimeKind,
  productionLibraryDir: join(homedir(), "MOSA Library"),
  productionPorts: MOSA_RESERVED_PRODUCTION_PORTS,
});
if (!guard.ok) {
  console.error(`ISOLATION_GUARD_REJECTED: ${guard.field} ${guard.reason}`);
  console.error(`ISOLATION_GUARD_REJECTED: actualUserData=${desktopDataDir}`);
  app.exit(1);
  // app.exit(1) does not halt execution in all Electron versions.
  // Prevent further lifecycle registration explicitly.
  process.exitCode = 1;
  throw new Error(`ISOLATION_GUARD_REJECTED: ${guard.field} ${guard.reason}`);
}

const MAX_CLIPBOARD_TEXT_LENGTH = 1_000_000;
const BOUNDS_PATH = join(desktopDataDir, "window-bounds.json");
const DEFAULT_BOUNDS = { width: 1320, height: 860 };

let mainWindow = null;
let service = null;
let shuttingDown = false;
let shutdownPromise = null;
let windowPromise = null;
let ipcRegistered = false;
let currentLocale = "zh"; // safe default matching original Chinese-only notifications
let updateCheckPromise = null;
let usageReportPromise = null;
const rendererConsoleErrors = new Set();
const MAX_RENDERER_CONSOLE_ERRORS = 32;

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

  app.whenReady().then(() => {
    // Usage telemetry belongs to the packaged desktop lifecycle, not to the
    // website download flow or renderer initialization. Start it as soon as
    // Electron is ready so GitHub/directly shared packages are counted too.
    void runAnonymousUsageReport();
    return openMainWindow();
  }).catch(reportStartupFailure);

  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      void openMainWindow().catch(reportStartupFailure);
    }
  });

  // Preserve MOSA's current background-runtime behavior while keeping the OS
  // lifecycle decision behind one desktop-platform boundary.
  app.on("window-all-closed", () => desktopPlatform.onWindowAllClosed(app));

  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    stopBridgeNotificationPoll();
    void stopOwnedRuntime().catch(console.error).finally(() => app.exit(0));
  });

  // A newer packaged MOSA may ask this process to yield the shared local
  // runtime with SIGTERM. Route that signal through Electron's normal quit
  // lifecycle so bridge work drains, SQLite closes, and the runtime lock is
  // released before the process exits.
  process.once("SIGTERM", () => app.quit());
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

const MOSA_MENU_ID_PREFIX = "mosa-menu-";

// macOS/Electron may append unlabelled normal items to an application menu
// after it is installed. Keep every explicit MOSA item and remove only those
// injected normal entries, preserving separators and native role behavior.
function pruneInjectedMenuItems(menu) {
  for (const item of menu.items) {
    const submenu = item.submenu;
    if (!submenu) continue;
    const retained = submenu.items.filter((child) => (
      child.type !== "normal" || child.id?.startsWith(MOSA_MENU_ID_PREFIX)
    ));
    if (retained.length !== submenu.items.length) {
      submenu.clear();
      retained.forEach((child) => submenu.append(child));
    }
    pruneInjectedMenuItems(submenu);
  }
}

function buildMenu() {
  const template = [
    {
      id: "mosa-menu-app",
      label: app.name,
      submenu: [
        { id: "mosa-menu-about", role: "about", label: getDesktopText("menuAbout", currentLocale) },
        { id: "mosa-menu-app-separator-1", type: "separator" },
        { id: "mosa-menu-services", role: "services", label: getDesktopText("menuServices", currentLocale) },
        { id: "mosa-menu-app-separator-2", type: "separator" },
        { id: "mosa-menu-hide", role: "hide", label: getDesktopText("menuHide", currentLocale) },
        { id: "mosa-menu-hide-others", role: "hideOthers", label: getDesktopText("menuHideOthers", currentLocale) },
        { id: "mosa-menu-show-all", role: "unhide", label: getDesktopText("menuShowAll", currentLocale) },
        { id: "mosa-menu-app-separator-3", type: "separator" },
        { id: "mosa-menu-quit", role: "quit", label: getDesktopText("menuQuit", currentLocale) },
      ],
    },
    {
      id: "mosa-menu-file",
      label: getDesktopText("menuFile", currentLocale),
      submenu: [
        {
          id: "mosa-menu-import-asset",
          label: getDesktopText("menuImportAsset", currentLocale),
          accelerator: "CmdOrCtrl+N",
          click: () => sendToWindow("menu-import"),
        },
        { id: "mosa-menu-file-separator-1", type: "separator" },
        { id: "mosa-menu-close", role: "close", label: getDesktopText("menuClose", currentLocale) },
      ],
    },
    {
      id: "mosa-menu-edit",
      label: getDesktopText("menuEdit", currentLocale),
      submenu: [
        { id: "mosa-menu-undo", role: "undo", label: getDesktopText("menuUndo", currentLocale) },
        { id: "mosa-menu-redo", role: "redo", label: getDesktopText("menuRedo", currentLocale) },
        { id: "mosa-menu-edit-separator-1", type: "separator" },
        { id: "mosa-menu-cut", role: "cut", label: getDesktopText("menuCut", currentLocale) },
        { id: "mosa-menu-copy", role: "copy", label: getDesktopText("menuCopy", currentLocale) },
        { id: "mosa-menu-paste", role: "paste", label: getDesktopText("menuPaste", currentLocale) },
        { id: "mosa-menu-paste-match-style", role: "pasteAndMatchStyle", label: getDesktopText("menuPasteAndMatchStyle", currentLocale) },
        { id: "mosa-menu-delete", role: "delete", label: getDesktopText("menuDelete", currentLocale) },
        { id: "mosa-menu-select-all", role: "selectAll", label: getDesktopText("menuSelectAll", currentLocale) },
      ],
    },
    {
      id: "mosa-menu-view",
      label: getDesktopText("menuView", currentLocale),
      submenu: [
        {
          id: "mosa-menu-search",
          label: getDesktopText("menuSearch", currentLocale),
          accelerator: "CmdOrCtrl+F",
          click: () => sendToWindow("menu-search"),
        },
        { id: "mosa-menu-view-separator-1", type: "separator" },
        { id: "mosa-menu-reset-zoom", role: "resetZoom", label: getDesktopText("menuResetZoom", currentLocale) },
        { id: "mosa-menu-zoom-in", role: "zoomIn", label: getDesktopText("menuZoomIn", currentLocale) },
        { id: "mosa-menu-zoom-out", role: "zoomOut", label: getDesktopText("menuZoomOut", currentLocale) },
        { id: "mosa-menu-view-separator-2", type: "separator" },
        { id: "mosa-menu-toggle-fullscreen", role: "togglefullscreen", label: getDesktopText("menuToggleFullScreen", currentLocale) },
      ],
    },
    {
      id: "mosa-menu-window",
      label: getDesktopText("menuWindow", currentLocale),
      submenu: [
        { id: "mosa-menu-minimize", role: "minimize", label: getDesktopText("menuMinimize", currentLocale) },
        { id: "mosa-menu-window-zoom", role: "zoom", label: getDesktopText("menuZoom", currentLocale) },
        { id: "mosa-menu-window-separator-1", type: "separator" },
        { id: "mosa-menu-bring-all-to-front", role: "front", label: getDesktopText("menuBringAllToFront", currentLocale) },
      ],
    },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  if (desktopPlatform.capabilities.hideApplicationMenuBar && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setMenuBarVisibility(false);
  }
  if (desktopPlatform.capabilities.pruneInjectedApplicationMenuItems) {
    pruneInjectedMenuItems(menu);
    setImmediate(() => {
      if (Menu.getApplicationMenu() === menu) pruneInjectedMenuItems(menu);
    });
  }
}

function registerIPC() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle("paste-image", async (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return null;
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    try {
      // BUG-01 fix: pastes now land inside the trusted import staging root
      // instead of an untrusted userData/pastes directory.
      return await writeStagedPng(importStagingRoot, image.toPNG());
    } catch (error) {
      console.error(`[MOSA] import-staging paste failed: ${error?.message || error}`);
      throw new Error(`import-staging paste failed (${error?.code || "unknown"})`);
    }
  });

  // Text copy uses Electron's native clipboard rather than the renderer Web
  // Clipboard API. Browser permissions are intentionally denied for the app's
  // local HTTP renderer, so navigator.clipboard.writeText() is not a reliable
  // desktop path (notably on macOS). Keep the bridge narrow: current main
  // window only, text only, and a bounded payload.
  ipcMain.handle("write-clipboard-text", async (event, text) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      return { ok: false, reason: "unavailable" };
    }
    if (typeof text !== "string" || text.length > MAX_CLIPBOARD_TEXT_LENGTH) {
      return { ok: false, reason: "invalid" };
    }
    clipboard.writeText(text);
    return { ok: true };
  });

  // Copy the stored full-resolution asset, never a gallery thumbnail or preview.
  // The renderer may only request files inside the active MOSA library; decoding
  // and clipboard access stay in the trusted main process.
  ipcMain.handle("write-clipboard-image", async (event, path) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      return { ok: false, reason: "unavailable" };
    }
    if (typeof path !== "string" || !path.trim()) return { ok: false, reason: "invalid" };
    const target = path.trim();
    if (!isAbsolute(target) || (isUrlLikePath(target) && /^[a-z][a-z0-9+.-]*:/i.test(target))) {
      return { ok: false, reason: "invalid" };
    }
    if (!existsSync(target)) return { ok: false, reason: "missing" };
    try {
      const allowedTarget = resolveAllowedFolderPath(target, [libraryDir]);
      if (!allowedTarget) return { ok: false, reason: "not-allowed" };
      const image = nativeImage.createFromPath(allowedTarget);
      if (image.isEmpty()) return { ok: false, reason: "unsupported" };
      clipboard.writeImage(image);
      return { ok: true };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  });

  ipcMain.handle("set-locale", async (event, locale) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
    if (locale !== "zh" && locale !== "en") return false;
    if (locale === currentLocale) return true;
    currentLocale = locale;
    buildMenu();
    return true;
  });

  ipcMain.handle("check-for-updates", async (event, notify = false) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      return { status: "unavailable", currentVersion: app.getVersion() };
    }
    return runUpdateCheck({ notify: notify === true });
  });

  ipcMain.handle("open-download-page", async (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return { ok: false };
    try {
      await shell.openExternal(MOSA_DOWNLOAD_PAGE_URL);
      return { ok: true };
    } catch (error) {
      console.warn(`[MOSA] unable to open download page: ${error?.message || error}`);
      return { ok: false };
    }
  });

  ipcMain.handle("change-library-location", async (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      return { ok: false, reason: "unavailable" };
    }
    // An explicit environment override is an administrator/developer contract;
    // do not let a renderer preference silently fight it on the next launch.
    if (process.env.MOSA_LIBRARY_DIR) return { ok: false, reason: "managed" };
    if (service?.mode !== "owned") return { ok: false, reason: "attached" };

    const selection = await dialog.showOpenDialog(mainWindow, {
      title: currentLocale === "en" ? "Choose a new MOSA library location" : "选择新的 MOSA 素材库位置",
      buttonLabel: currentLocale === "en" ? "Choose" : "选择",
      properties: ["openDirectory", "createDirectory"],
    });
    if (selection.canceled || !selection.filePaths?.[0]) return { ok: false, reason: "cancelled" };

    const nextLibraryDir = resolve(selection.filePaths[0]);
    if (pathsEqual(nextLibraryDir, libraryDir)) return { ok: false, reason: "cancelled" };
    // Parent/child moves can recursively copy the library into itself or make
    // rollback ambiguous. Only independent directories are accepted.
    if (isPathInsideOrEqual(libraryDir, nextLibraryDir) || isPathInsideOrEqual(nextLibraryDir, libraryDir)) {
      return { ok: false, reason: "invalid" };
    }
    try {
      const entries = await readdir(nextLibraryDir);
      if (entries.length > 0) return { ok: false, reason: "not-empty" };
    } catch (error) {
      if (error?.code !== "ENOENT") return { ok: false, reason: "unavailable" };
      await mkdir(nextLibraryDir, { recursive: true });
    }

    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: "question",
      title: currentLocale === "en" ? "Move MOSA Library" : "移动 MOSA 素材库",
      message: currentLocale === "en"
        ? "Move the current library to the selected folder?"
        : "将当前素材库移动到所选文件夹？",
      detail: currentLocale === "en"
        ? "MOSA will close its local library service, copy all assets and metadata, then restart. The original is removed only after the copy succeeds."
        : "MOSA 会先关闭本地素材库服务，完整复制素材与元数据，然后自动重启。复制成功前不会删除原素材库。",
      buttons: currentLocale === "en" ? ["Cancel", "Move and Restart"] : ["取消", "移动并重启"],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return { ok: false, reason: "cancelled" };

    const previousLibraryDir = libraryDir;
    try {
      await stopOwnedRuntime();
      service = null;
      // The runtime lock has been released by stopOwnedRuntime(). Never copy a
      // stale lock into the new location even if shutdown cleanup is delayed.
      const sourceEntries = await readdir(previousLibraryDir, { withFileTypes: true });
      for (const entry of sourceEntries) {
        if (entry.name === ".mosa-runtime.lock") continue;
        await cp(join(previousLibraryDir, entry.name), join(nextLibraryDir, entry.name), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      }
      saveLibraryDir(nextLibraryDir);
    } catch (error) {
      console.error(`[MOSA] library relocation failed: ${error?.stack || error}`);
      // The destination was required to be empty before the operation, so it
      // is safe to remove a partial copy. The original remains authoritative.
      await rm(nextLibraryDir, { recursive: true, force: true }).catch(() => {});
      await mkdir(nextLibraryDir, { recursive: true }).catch(() => {});
      libraryDir = previousLibraryDir;
      app.relaunch();
      app.exit(1);
      return { ok: false, reason: "copy-failed" };
    }

    // The new copy and persisted location are now complete. Failure to remove
    // the old directory must never roll back by deleting the new authoritative
    // copy; at worst the user is left with a harmless duplicate to remove.
    libraryDir = nextLibraryDir;
    await rm(previousLibraryDir, { recursive: true, force: true }).catch((error) => {
      console.warn(`[MOSA] new library is active but the old directory could not be removed: ${error?.message || error}`);
    });
    app.relaunch();
    app.exit(0);
    return { ok: true, restarting: true };
  });

  // Phase 4C：「在 Finder 中显示」最小能力适配。只接受当前主窗口渲染进程发来的
  // 真实存在的本地绝对路径；拒绝 URL、相对路径与不存在文件；不用 shell.openExternal
  // 处理本地路径，不创建/修改/移动/下载任何文件；失败返回结构化结果而不抛异常。
  ipcMain.handle("show-item-in-folder", async (event, path) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return { ok: false, reason: "unavailable" };
    if (typeof path !== "string" || !path.trim()) return { ok: false, reason: "invalid" };
    const target = path.trim();
    if (!isAbsolute(target) || (isUrlLikePath(target) && /^[a-z][a-z0-9+.-]*:/i.test(target))) return { ok: false, reason: "invalid" };
    if (!existsSync(target)) return { ok: false, reason: "missing" };
    try {
      const allowedTarget = resolveAllowedFolderPath(target, [libraryDir]);
      if (!allowedTarget) return { ok: false, reason: "not-allowed" };
      shell.showItemInFolder(allowedTarget);
      return { ok: true };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  });
}

function runAnonymousUsageReport() {
  const currentVersion = app.getVersion();
  // Development and QA launches must never pollute production usage metrics.
  // A package obtained from any distribution channel still has isPackaged=true.
  if (isolationContext.qaRun || !app.isPackaged) {
    return Promise.resolve({ status: "disabled", currentVersion });
  }
  if (usageReportPromise) return usageReportPromise;

  const anonymousUsage = prepareAnonymousUsage({
    userDataDir: desktopDataDir,
    enabled: true,
    platform: process.platform,
    arch: process.arch,
    currentVersion,
  });
  if (!anonymousUsage.telemetry) {
    return Promise.resolve({ status: "skipped", currentVersion });
  }

  usageReportPromise = reportAnonymousUsage({ anonymousUsage: anonymousUsage.telemetry })
    .then((result) => {
      if (result.reported && !anonymousUsage.commit()) {
        console.warn("[MOSA] anonymous usage reached the server but the local report timestamp could not be persisted");
      }
      return { status: result.reported ? "ok" : "skipped", currentVersion };
    })
    .catch((error) => {
      console.warn(`[MOSA] anonymous usage report failed: ${error?.message || error}`);
      return { status: "error", currentVersion, code: "USAGE_REPORT_FAILED" };
    })
    .finally(() => {
      usageReportPromise = null;
    });
  return usageReportPromise;
}

function runUpdateCheck({ notify = false } = {}) {
  const currentVersion = app.getVersion();
  if (isolationContext.qaRun) return Promise.resolve({ status: "disabled", currentVersion });
  if (updateCheckPromise) return updateCheckPromise;
  updateCheckPromise = checkForMosaUpdate({ currentVersion })
    .then((result) => {
      if (notify && result.updateAvailable && Notification.isSupported()) {
        const copy = getUpdateNotificationText(result.latestVersion, currentLocale);
        const notification = new Notification({ title: copy.title, body: copy.body, silent: true });
        notification.on("click", () => {
          void shell.openExternal(MOSA_DOWNLOAD_PAGE_URL).catch((error) => {
            console.warn(`[MOSA] unable to open download page: ${error?.message || error}`);
          });
        });
        notification.show();
      }
      return { status: "ok", ...result };
    })
    .catch((error) => {
      console.warn(`[MOSA] update check failed: ${error?.message || error}`);
      return { status: "error", currentVersion, code: "UPDATE_CHECK_FAILED" };
    })
    .finally(() => {
      updateCheckPromise = null;
    });
  return updateCheckPromise;
}

function openMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return Promise.resolve();
  }
  if (windowPromise) return windowPromise;
  // BUG-01 fix: sweep staged files left behind by failed/cancelled imports
  // (older than 24h) at startup; never blocks window creation.
  cleanupOrphanStagedFiles(importStagingRoot).catch((error) => {
    console.error(`[MOSA] import-staging orphan sweep failed: ${error?.message || error}`);
  });
  windowPromise = createMainWindow().finally(() => { windowPromise = null; });
  return windowPromise;
}

async function createMainWindow() {
  denyBrowserPermissions();
  if (!service) {
    const webCaptureToken = process.env.MOSA_WEB_CAPTURE_TOKEN
      || await loadOrCreateWebCaptureToken(desktopDataDir);
    const webCaptureOrigins = process.env.MOSA_WEB_CAPTURE_ORIGINS
      || MOSA_WEB_CAPTURE_DEFAULT_ORIGINS;
    service = await startMosaService({
      port: desktopPort,
      libraryDir,
      allowPortFallback: !process.env.MOSA_DESKTOP_PORT,
      // Normal packaged launches may replace a strictly older MOSA runtime
      // that owns this exact library. QA, source development, and explicit
      // port launches stay fail-closed so test tooling never terminates an
      // unrelated local process.
      allowStaleServiceUpgrade: shouldAllowStaleServiceUpgrade({
        isPackaged: app.isPackaged,
        qaRun: isolationContext.qaRun,
        explicitPort: Boolean(process.env.MOSA_DESKTOP_PORT),
      }),
      // Source development may safely replace a verified same-version MOSA
      // owner for the same library. Packaged builds keep the stricter semver
      // upgrade rule; QA and explicit-port launches remain fail-closed.
      allowSameVersionServiceReplacement: shouldAllowSameVersionServiceReplacement({
        isPackaged: app.isPackaged,
        qaRun: isolationContext.qaRun,
        explicitPort: Boolean(process.env.MOSA_DESKTOP_PORT),
      }),
      expectedIdentity: expectedServiceIdentity,
      importStagingRoot,
      isolationContext,
      runtimeOptions: {
        projectRoot: appRoot,
        managerDir: appRoot,
        cowartProjectDir: desktopDataDir,
        appDir: join(appRoot, "app"),
        // JSON fallback libraries must remain writable when MOSA is packaged.
        assetsRoot: join(libraryDir, "assets"),
        generatedImagesDir: join(libraryDir, "imports"),
        webCaptureToken,
        webCaptureOrigins,
        // MOSA_DISABLE_BRIDGES lets isolated runs (Task 1 verification) keep
        // the local Codex/Grok/Cowart directories invisible, so the gallery
        // reflects only the configured fixture library. Accepted names:
        // cowart, cowartDiscovery, codex, grok.
        disabledBridges: parseDisabledBridges({ env: process.env }),
      },
    });
  }

  const url = new URL(service.url);
  const bounds = loadBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    // F-10（Phase 6A）：桌面最小窗口钳制在批准的最低验收尺寸 960×640（产品规格 §6）。
    // 仅靠 BrowserWindow 原生最小尺寸实现，不用 resize 事件反复 setBounds、不在 renderer 模拟。
    minWidth: 960,
    minHeight: 640,
    show: false,
    ...desktopPlatform.windowOptions(),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  console.info(`[MOSA] preload-path=${preloadPath}`);
  mainWindow.webContents.once("preload-error", (_event, attemptedPath, error) => {
    console.error(`[MOSA] preload-error path=${attemptedPath} ${error?.stack || error}`);
  });
  mainWindow.webContents.once("render-process-gone", (_event, details) => {
    console.error(`[MOSA] render-process-gone ${JSON.stringify(details)}`);
  });
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level < 2 || rendererConsoleErrors.size >= MAX_RENDERER_CONSOLE_ERRORS) return;
    const entry = `${level}:${sourceId}:${line}:${message}`;
    if (rendererConsoleErrors.has(entry)) return;
    rendererConsoleErrors.add(entry);
    console.error(`[MOSA] renderer-console ${entry}`);
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
  await mainWindow.loadURL(service.url);
  mainWindow.show();

  startBridgeNotificationPoll(service.port);
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
        const body = getNotificationTextForAssetsImported(delta, currentLocale);
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

function stopOwnedRuntime() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = service?.mode === "owned" ? service.stop() : Promise.resolve();
  return shutdownPromise;
}

function reportStartupFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  // A shutdown can race an in-flight BrowserWindow.loadURL(). In that case
  // Electron rejects the load promise because the local runtime is being
  // stopped intentionally. Treat it as shutdown noise rather than surfacing a
  // false "MOSA cannot start" dialog to the user.
  if (shuttingDown) {
    console.info(`[MOSA] startup load aborted during shutdown: ${message}`);
    return;
  }
  dialog.showErrorBox(getDesktopText("startupErrorTitle", currentLocale), message);
  shuttingDown = true;
  stopBridgeNotificationPoll();
  void stopOwnedRuntime().catch(console.error).finally(() => app.exit(1));
}
