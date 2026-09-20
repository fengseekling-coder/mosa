import { app, BrowserWindow, Menu, dialog, ipcMain, clipboard, nativeImage, screen, session, shell, Notification } from "electron";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MOSA_DESKTOP_PORT, MOSA_RESERVED_PRODUCTION_PORTS } from "../lib/runtime-defaults.mjs";
import { validateRuntimeIsolation } from "../lib/runtime-isolation-guard.mjs";
import { parseDisabledBridges } from "../lib/runtime-bridges.mjs";
import { cleanupOrphanStagedFiles, importStagingDir, writeStagedPng } from "../lib/import-staging.mjs";
import { getDesktopText, getNotificationTextForAssetsImported, getUpdateNotificationText } from "./notification-i18n.mjs";
import { loadOrCreateMosaClientToken, loadOrCreateWebCaptureToken, MOSA_WEB_CAPTURE_DEFAULT_ORIGINS } from "./web-capture-pairing.mjs";
import { desktopPlatformAdapter } from "./platform/index.mjs";
import { checkForMosaUpdate, MOSA_DOWNLOAD_PAGE_URL, reportAnonymousUsage } from "./update-service.mjs";
import { prepareAnonymousUsage } from "./anonymous-usage.mjs";
import { mosaClientTokenFingerprint, resolveAllowedFolderPath } from "../lib/server-security.js";
import { isPathInsideOrEqual, isUrlLikePath, pathsEqual } from "../lib/path-safety.mjs";
import { finalizeCopiedSqliteLibrary } from "../lib/library-relocation.mjs";
import { getBuildIdentity } from "../lib/build-identity.mjs";
import { MOSA_SERVICE_PROTOCOL_VERSION } from "../lib/version-identities.mjs";
import { downloadWindowsUpdate, launchWindowsUpdateHelper, resolveWindowsUpdateReadyFile } from "./windows-updater.mjs";
import {
  downloadMacosUpdate,
  launchMacosUpdateHelper,
  resolveMacosInstallAppPath,
  resolveMacosUpdateReadyFile,
} from "./macos-updater.mjs";
import { createVisualModelManager } from "./visual-model-manager.mjs";
import {
  checkForVisualPackRelease,
  cleanupVisualPackStaging,
  installVisualPack,
  removeVisualPack,
  visualPackTarget,
} from "./visual-pack-installer.mjs";
import { createVisualInferenceClient } from "../lib/visual-inference-client.mjs";
import { createMosaDesktopStartupHandoff } from "../lib/runtime-handoff.mjs";

const preloadPath = fileURLToPath(new URL("./preload.cjs", import.meta.url));
const startupShellPath = fileURLToPath(new URL("./startup.html", import.meta.url));
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
// Runtime availability is measured against the active verified Visual Pack.
// The pack owns its optional ONNX/tokenizer runtime, so MOSA.app itself does
// not need to carry that heavy dependency when visual search is unused.
async function probeVisualRuntime(pack) {
  const model = pack ? { id: pack.id, revision: pack.revision, dimension: pack.embedding_dimension } : null;
  const client = createVisualInferenceClient({ pack, model, initTimeoutMs: 30_000 });
  try {
    await client.start();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: "runtime-unavailable", message: error?.message || "Local inference runtime failed to start." };
  } finally {
    await client.close().catch(() => {});
  }
}
const visualModelManager = createVisualModelManager({ userDataDir: desktopDataDir, probeRuntime: probeVisualRuntime });
const productionDefaultUserData = join(app.getPath("appData"), app.name);
const importStagingRoot = importStagingDir(desktopDataDir);
const desktopPort = process.env.MOSA_DESKTOP_PORT || DEFAULT_MOSA_DESKTOP_PORT;
const LIBRARY_LOCATION_PATH = join(desktopDataDir, "library-location.json");
// `homedir()` follows HOME on macOS, and tool sandboxes may intentionally
// rewrite HOME to a temporary directory. userInfo().homedir comes from the OS
// account record instead, so source desktop launches still resolve the signed-
// in user's real MOSA Library instead of forking a sandbox-only empty library.
const defaultLibraryDir = join(userInfo().homedir, "MOSA Library");

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
const launchedFromMacosUpdate = Boolean(
  resolveMacosUpdateReadyFile(process.argv, join(desktopDataDir, "updates", "macos")),
);
const desktopStartupHandoffEnabled = process.platform === "darwin"
  && app.isPackaged
  && !isolationContext.qaRun
  && !launchedFromMacosUpdate
  && !process.env.MOSA_DESKTOP_PORT;

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
  productionLibraryDir: defaultLibraryDir,
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
const MAX_NATIVE_DRAG_FILES = 512;
// webContents.startDrag requires a non-empty icon on macOS. Most image assets
// can supply their own preview directly; this tiny PNG is only the fallback for
// video/unsupported image formats and never leaves the process.
const NATIVE_DRAG_FALLBACK_ICON = nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAACTSURBVHgBpZKBCYAgEEV/TeAIjuIIbdQIuUGt0CS1gW1iZ2jIVaTnhw+Cvs8/OYDJA4Y8kR3ZR2/kmazxJbpUEfQ/Dm/UG7wVwHkjlQdMFfDdJMFaACebnjJGyDWgcnZu1/lrCrl6NCoEHJBrDwEr5NrT6ko/UV8xdLAC2N49mlc5CylpYh8wCwqrvbBGLoKGvz8Bfq0QPWEUo/EAAAAASUVORK5CYII=");
const BOUNDS_PATH = join(desktopDataDir, "window-bounds.json");
const DEFAULT_BOUNDS = { width: 1320, height: 860 };

let mainWindow = null;
let service = null;
let rendererRecoveryAttempts = 0;
let shuttingDown = false;
let shutdownPromise = null;
let windowPromise = null;
let windowOpenRequested = false;
let ipcRegistered = false;
let currentLocale = "zh"; // safe default matching original Chinese-only notifications
let updateCheckPromise = null;
let macosUpdateInstallPromise = null;
let macosUpdateDownloadController = null;
let windowsUpdateInstallPromise = null;
let windowsUpdateDownloadController = null;
let usageReportPromise = null;
let usageReportTimer = null;
let serviceManagerModulePromise = null;
let serviceStartPromise = null;
let visualPackReleaseCache = null;
let visualPackInstallPromise = null;
let visualPackInstallController = null;
let visualPackProgress = null;
let desktopStartupHandoffPromise = null;
let desktopStartupHandoffLease = null;
let desktopStartupHandoffError = null;
const USAGE_REPORT_RECHECK_MS = 15 * 60 * 1000;
const VISUAL_PACK_RELEASE_CACHE_MS = 15 * 60 * 1000;
const MACOS_UPDATE_STAGING_ROOT = join(desktopDataDir, "updates", "macos");
const WINDOWS_UPDATE_STAGING_ROOT = join(desktopDataDir, "updates", "windows");
const macosUpdateReadyFile = resolveMacosUpdateReadyFile(process.argv, MACOS_UPDATE_STAGING_ROOT);
const windowsUpdateReadyFile = resolveWindowsUpdateReadyFile(process.argv, WINDOWS_UPDATE_STAGING_ROOT);
const rendererConsoleErrors = new Set();
const MAX_RENDERER_CONSOLE_ERRORS = 32;

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  desktopStartupHandoffPromise = desktopStartupHandoffEnabled
    ? createMosaDesktopStartupHandoff({ libraryDir })
      .then((lease) => {
        desktopStartupHandoffLease = lease;
        return lease;
      })
      .catch((error) => {
        desktopStartupHandoffError = error;
        return null;
      })
    : Promise.resolve(null);

  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      void openMainWindow().catch(reportStartupFailure);
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    await desktopStartupHandoffPromise;
    if (desktopStartupHandoffError) throw desktopStartupHandoffError;
    await cleanupVisualPackStaging({ userDataDir: desktopDataDir }).catch((error) => {
      console.warn(`[MOSA] visual pack staging recovery failed: ${error?.message || error}`);
    });
    // First paint wins the startup race. Telemetry and every other non-visual
    // lifecycle task wait until MOSA has at least presented a window.
    await openMainWindow();
    void visualModelManager.cleanupInactivePacks().catch((error) => {
      console.warn(`[MOSA] visual pack cleanup failed: ${error?.message || error}`);
    });
    startAnonymousUsageLifecycle();
    cleanupStaleWindowsUpdateTransactions();
  }).catch(reportStartupFailure);

  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      void openMainWindow().catch(reportStartupFailure);
    }
  });

  // Preserve MOSA's current background-runtime behavior while keeping the OS
  // lifecycle decision behind one desktop-platform boundary. Internal runtime
  // recovery intentionally destroys the last window before rebuilding it, so
  // Windows must not interpret that internal transition as a user quit.
  app.on("window-all-closed", () => {
    if (runtimeRecoveryInProgress) return;
    desktopPlatform.onWindowAllClosed(app);
  });

  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    stopBridgeNotificationPoll();
    stopAnonymousUsageLifecycle();
    void Promise.allSettled([
      stopOwnedRuntime(),
      releaseDesktopStartupHandoff(),
    ]).finally(() => app.exit(0));
  });

  // A newer packaged MOSA may ask this process to yield the shared local
  // runtime with SIGTERM. Route that signal through Electron's normal quit
  // lifecycle so bridge work drains, SQLite closes, and the runtime lock is
  // released before the process exits.
  process.once("SIGTERM", () => app.quit());
}

function loadBounds() {
  let saved = null;
  try {
    if (existsSync(BOUNDS_PATH)) saved = JSON.parse(readFileSync(BOUNDS_PATH, "utf-8"));
  } catch {}
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return DEFAULT_BOUNDS;
  const normalized = {
    width: Math.max(960, Math.round(saved.width)),
    height: Math.max(640, Math.round(saved.height)),
  };
  if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return normalized;
  const candidate = { ...normalized, x: Math.round(saved.x), y: Math.round(saved.y) };
  const visible = screen.getAllDisplays().some(({ workArea }) => {
    const overlapWidth = Math.min(candidate.x + candidate.width, workArea.x + workArea.width) - Math.max(candidate.x, workArea.x);
    const overlapHeight = Math.min(candidate.y + candidate.height, workArea.y + workArea.height) - Math.max(candidate.y, workArea.y);
    return overlapWidth >= 120 && overlapHeight >= 80;
  });
  return visible ? candidate : normalized;
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

// Native, out-of-band consent for handing the long-lived web-capture ingest
// token to a requester that proved nothing beyond a forgeable Origin header.
// Denial is the default: timeout, missing window, or any dialog failure.
const WEB_CAPTURE_PAIR_CONFIRM_TIMEOUT_MS = 120_000;

function confirmWebCapturePairing(origin) {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(false);
  const dialogPromise = dialog.showMessageBox(mainWindow, {
    type: "question",
    buttons: [
      getDesktopText("pairConfirmAllow", currentLocale),
      getDesktopText("pairConfirmDeny", currentLocale),
    ],
    defaultId: 1,
    cancelId: 1,
    title: getDesktopText("pairConfirmTitle", currentLocale),
    message: getDesktopText("pairConfirmMessage", currentLocale),
    detail: origin ? getDesktopText("pairConfirmDetail", currentLocale).replaceAll("{origin}", origin) : "",
  }).then((result) => result.response === 0).catch(() => false);
  let expiry;
  const timeoutPromise = new Promise((resolveTimeout) => {
    expiry = setTimeout(() => resolveTimeout(false), WEB_CAPTURE_PAIR_CONFIRM_TIMEOUT_MS);
  });
  return Promise.race([dialogPromise, timeoutPromise]).finally(() => clearTimeout(expiry));
}

// The Windows update helper parks the previous installation under
// .MOSA-update-*/previous next to the executable and deliberately leaves that
// recovery data in place after a successful apply. A running, packaged
// Windows app can safely sweep those directories once they are old enough
// that no in-flight update transaction can still own them.
const WINDOWS_UPDATE_TRANSACTION_PREFIX = ".MOSA-update-";
const WINDOWS_UPDATE_TRANSACTION_MIN_AGE_MS = 10 * 60 * 1000;

function cleanupStaleWindowsUpdateTransactions() {
  if (process.platform !== "win32" || !app.isPackaged) return;
  const parentDir = dirname(process.execPath);
  void (async () => {
    try {
      const entries = await readdir(parentDir, { withFileTypes: true });
      await Promise.all(entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(WINDOWS_UPDATE_TRANSACTION_PREFIX))
        .map(async (entry) => {
          const transactionDir = join(parentDir, entry.name);
          const info = await stat(transactionDir).catch(() => null);
          if (!info || Date.now() - info.mtimeMs < WINDOWS_UPDATE_TRANSACTION_MIN_AGE_MS) return;
          await rm(transactionDir, { recursive: true, force: true }).catch(() => {});
        }));
    } catch {
      // Sweep is best-effort recovery hygiene; failures must never affect startup.
    }
  })();
}

async function visualPackDistributionState({ forceRelease = false } = {}) {
  const target = visualPackTarget();
  if (!target) return { supported: false, release: null, action: "unsupported", progress: visualPackProgress, error: null };
  if (isolationContext.qaRun) {
    return { supported: true, release: null, action: "offline", progress: visualPackProgress, error: null };
  }
  const now = Date.now();
  if (!forceRelease && visualPackReleaseCache && now - visualPackReleaseCache.checked_at < VISUAL_PACK_RELEASE_CACHE_MS) {
    return structuredClone({ ...visualPackReleaseCache, progress: visualPackProgress });
  }
  try {
    const checked = await checkForVisualPackRelease({
      releaseManifestTrust: expectedServiceIdentity.releaseManifestTrust,
    });
    visualPackReleaseCache = {
      supported: checked.supported === true,
      release: checked.release || null,
      action: checked.release ? "available" : "unavailable",
      error: null,
      checked_at: now,
    };
  } catch (error) {
    visualPackReleaseCache = {
      supported: true,
      release: null,
      action: "unavailable",
      error: error?.message || "Visual Pack release check failed.",
      checked_at: now,
    };
  }
  return structuredClone({ ...visualPackReleaseCache, progress: visualPackProgress });
}

async function visualModelStateSnapshot({ refreshLocal = false, forceRelease = false } = {}) {
  const [local, distribution] = await Promise.all([
    visualModelManager.state({ refresh: refreshLocal }),
    visualPackDistributionState({ forceRelease }),
  ]);
  const release = distribution.release;
  let action = distribution.action;
  if (visualPackInstallPromise) {
    action = "installing";
  } else if (release) {
    const exact = local.packs.some((pack) => pack.id === release.id && pack.revision === release.revision);
    const sameModel = local.packs.some((pack) => pack.id === release.id);
    action = exact ? "installed" : (sameModel ? "update" : "install");
  }
  return {
    ...local,
    distribution: {
      ...distribution,
      action,
      progress: visualPackProgress,
    },
  };
}

function publishVisualPackProgress(progress) {
  visualPackProgress = progress ? { ...progress } : null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("visual-pack-progress", visualPackProgress);
  }
}

function scheduleVisualPackRestart() {
  const timer = setTimeout(() => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopBridgeNotificationPoll();
    stopAnonymousUsageLifecycle();
    void stopOwnedRuntime().catch(console.error).finally(() => {
      app.relaunch();
      app.exit(0);
    });
  }, 350);
  timer.unref?.();
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

  // Native file export is deliberately a one-way, narrow bridge. The renderer
  // may nominate library paths, but the trusted main process canonicalizes
  // every path, rejects directories/out-of-library targets, caps the batch,
  // and only then hands files to the OS drag session.
  ipcMain.handle("start-native-file-drag", async (event, requestedPaths) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return { ok: false };
    const input = Array.isArray(requestedPaths) ? requestedPaths.slice(0, MAX_NATIVE_DRAG_FILES) : [];
    const files = [];
    const seen = new Set();
    for (const requestedPath of input) {
      if (typeof requestedPath !== "string" || !requestedPath.trim()) continue;
      let allowed;
      try {
        allowed = resolveAllowedFolderPath(requestedPath.trim(), [libraryDir]);
        if (!allowed || seen.has(allowed) || !existsSync(allowed) || !statSync(allowed).isFile()) continue;
      } catch {
        continue;
      }
      seen.add(allowed);
      files.push(allowed);
    }
    if (!files.length) return { ok: false };
    let icon = nativeImage.createFromPath(files[0]);
    if (icon.isEmpty()) icon = NATIVE_DRAG_FALLBACK_ICON;
    event.sender.startDrag({ file: files[0], files, icon });
    return { ok: true, count: files.length };
  });

  ipcMain.handle("set-locale", async (event, locale) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
    if (locale !== "zh" && locale !== "en") return false;
    if (locale === currentLocale) return true;
    currentLocale = locale;
    buildMenu();
    return true;
  });

  ipcMain.handle("visual-model-state", async (event, refresh = false) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      return { mode: "mosa-local", state: "unavailable", installed: false, enabled: false };
    }
    return visualModelStateSnapshot({ refreshLocal: refresh === true });
  });

  ipcMain.handle("visual-model-set-enabled", async (event, enabled) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      return { mode: "mosa-local", state: "unavailable", installed: false, enabled: false };
    }
    if (service && service.mode !== "owned") {
      throw new Error("Local visual settings cannot change while MOSA Desktop is attached to an external runtime. Close that runtime and reopen MOSA.");
    }
    await visualModelManager.setEnabled(enabled === true);
    const state = await visualModelStateSnapshot({ refreshLocal: true });
    scheduleVisualPackRestart();
    return { ...state, restarting: true };
  });

  ipcMain.handle("visual-pack-install", async (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      return { ok: false, reason: "unavailable" };
    }
    if (service && service.mode !== "owned") {
      throw new Error("Visual Pack installation requires the runtime owned by MOSA Desktop. Close the external MOSA runtime and reopen the app.");
    }
    if (visualPackInstallPromise) return visualPackInstallPromise;
    visualPackInstallController = new AbortController();
    visualPackInstallPromise = (async () => {
      try {
        const distribution = await visualPackDistributionState({ forceRelease: true });
        if (!distribution.release) throw new Error("No compatible MOSA Visual Pack is currently published for this platform.");
        publishVisualPackProgress({ phase: "preparing", receivedBytes: 0, totalBytes: distribution.release.total_size, percent: 0 });
        const installed = await installVisualPack({
          userDataDir: desktopDataDir,
          release: distribution.release,
          signal: visualPackInstallController.signal,
          onProgress: publishVisualPackProgress,
        });
        await visualModelManager.selectPack(installed.id, installed.revision);
        await visualModelManager.setEnabled(true);
        visualPackReleaseCache = null;
        publishVisualPackProgress({ phase: "complete", receivedBytes: installed.total_bytes, totalBytes: installed.total_bytes, percent: 100 });
        const state = await visualModelStateSnapshot({ refreshLocal: true });
        scheduleVisualPackRestart();
        return { ok: true, restarting: true, state };
      } catch (error) {
        publishVisualPackProgress({ phase: "error", message: error?.message || "Visual Pack installation failed." });
        throw error;
      } finally {
        visualPackInstallController = null;
        visualPackInstallPromise = null;
      }
    })();
    return visualPackInstallPromise;
  });

  ipcMain.handle("visual-pack-cancel", async (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return { ok: false };
    if (!visualPackInstallController || visualPackInstallController.signal.aborted) return { ok: false };
    visualPackInstallController.abort(new Error("Visual Pack download cancelled by the user."));
    return { ok: true };
  });

  ipcMain.handle("visual-pack-remove", async (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return { ok: false };
    if (service && service.mode !== "owned") {
      throw new Error("Visual Pack removal requires the runtime owned by MOSA Desktop. Close the external MOSA runtime and reopen the app.");
    }
    if (visualPackInstallPromise) return { ok: false, reason: "busy" };
    const current = await visualModelManager.state({ refresh: true });
    const activeId = current.active_pack?.id || current.packs?.[0]?.id || "";
    if (!activeId) return { ok: true, removed: 0 };
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "MOSA",
      message: currentLocale === "en" ? "Remove the local Visual Pack?" : "删除本地视觉能力包？",
      detail: currentLocale === "en"
        ? "This removes the optional model, runtime, and derived visual index. Your original assets and Prompt/provenance data are not changed."
        : "这会删除可选模型、推理运行时和派生视觉索引，不会修改你的原始素材、Prompt 或溯源数据。",
      buttons: currentLocale === "en" ? ["Cancel", "Remove"] : ["取消", "删除"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return { ok: false, cancelled: true };

    await visualModelManager.setEnabled(false);
    if (service?.mode === "owned") {
      await service.stop();
      service = null;
      shutdownPromise = null;
      stopBridgeNotificationPoll();
    }
    const removed = await removeVisualPack({ userDataDir: desktopDataDir, id: activeId });
    await rm(join(desktopDataDir, "visual-relationship-indexes"), { recursive: true, force: true });
    visualPackReleaseCache = null;
    publishVisualPackProgress(null);
    scheduleVisualPackRestart();
    return { ok: true, restarting: true, removed: removed.removed };
  });

  ipcMain.handle("renderer-ready", async (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
    if (!service) return false;
    const updateReadyFiles = [macosUpdateReadyFile, windowsUpdateReadyFile].filter(Boolean);
    for (const readyFile of updateReadyFiles) {
      try {
        mkdirSync(dirname(readyFile), { recursive: true });
        writeFileSync(readyFile, JSON.stringify({
          version: app.getVersion(),
          gitSha: expectedServiceIdentity.gitSha,
          uiFingerprint: expectedServiceIdentity.uiFingerprint,
          runtimeFingerprint: expectedServiceIdentity.runtimeFingerprint,
          distribution: expectedServiceIdentity.distribution,
          readyAt: new Date().toISOString(),
          port: service.port,
        }), "utf8");
      } catch (error) {
        console.error(`[MOSA] unable to report post-update readiness: ${error?.message || error}`);
        return false;
      }
    }
    return true;
  });

  ipcMain.handle("check-for-updates", async (event, notify = false) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      return { status: "unavailable", currentVersion: app.getVersion() };
    }
    return runUpdateCheck({ notify: notify === true });
  });

  ipcMain.handle("download-and-install-update", async (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      return { status: "unavailable", currentVersion: app.getVersion() };
    }
    if (!app.isPackaged || isolationContext.qaRun) {
      return { status: "unsupported", currentVersion: app.getVersion() };
    }
    if (process.platform === "darwin") {
      if (macosUpdateInstallPromise) return macosUpdateInstallPromise;
      macosUpdateInstallPromise = (async () => {
        const controller = new AbortController();
        macosUpdateDownloadController = controller;
        try {
          const release = await checkForMosaUpdate({
            currentVersion: app.getVersion(),
            currentDistribution: expectedServiceIdentity.distribution,
            releaseManifestTrust: expectedServiceIdentity.releaseManifestTrust,
          });
          if (!release.updateAvailable) return { status: "current", currentVersion: release.currentVersion };
          if (!release.macArtifact) return { status: "unavailable", currentVersion: release.currentVersion };
          const installAppPath = resolveMacosInstallAppPath(process.execPath);
          if (!installAppPath) return { status: "unsupported", currentVersion: release.currentVersion };
          const download = await downloadMacosUpdate({
            artifact: release.macArtifact,
            version: release.latestVersion,
            stagingRoot: MACOS_UPDATE_STAGING_ROOT,
            signal: controller.signal,
            onProgress: (progress) => {
              if (!mainWindow || mainWindow.isDestroyed()) return;
              mainWindow.webContents.send("update-download-progress", progress);
            },
          });
          if (macosUpdateDownloadController === controller) macosUpdateDownloadController = null;
          await launchMacosUpdateHelper({
            zipPath: download.zipPath,
            installAppPath,
            version: release.latestVersion,
            expectedIdentity: release.buildIdentity,
            processId: process.pid,
            libraryDir,
          });
          shuttingDown = true;
          stopBridgeNotificationPoll();
          stopAnonymousUsageLifecycle();
          await stopOwnedRuntime();
          await releaseDesktopStartupHandoff();
          app.exit(0);
          return { status: "installing", latestVersion: release.latestVersion };
        } catch (error) {
          if (controller.signal.aborted) {
            return { status: "cancelled", currentVersion: app.getVersion() };
          }
          console.warn(`[MOSA] macOS update failed: ${error?.message || error}`);
          return { status: "error", currentVersion: app.getVersion(), code: "MACOS_UPDATE_FAILED" };
        } finally {
          if (macosUpdateDownloadController === controller) macosUpdateDownloadController = null;
        }
      })().finally(() => { macosUpdateInstallPromise = null; });
      return macosUpdateInstallPromise;
    }
    if (process.platform !== "win32") {
      return { status: "unsupported", currentVersion: app.getVersion() };
    }
    if (windowsUpdateInstallPromise) return windowsUpdateInstallPromise;
    windowsUpdateInstallPromise = (async () => {
      const controller = new AbortController();
      windowsUpdateDownloadController = controller;
      try {
      // Re-read the first-party manifest in the trusted main process instead of
      // accepting a renderer-supplied URL, filename or digest.
      const release = await checkForMosaUpdate({
        currentVersion: app.getVersion(),
        currentDistribution: expectedServiceIdentity.distribution,
        releaseManifestTrust: expectedServiceIdentity.releaseManifestTrust,
      });
      if (!release.updateAvailable) return { status: "current", currentVersion: release.currentVersion };
      if (!release.windowsArtifact) return { status: "unavailable", currentVersion: release.currentVersion };
      const download = await downloadWindowsUpdate({
        artifact: release.windowsArtifact,
        version: release.latestVersion,
        stagingRoot: WINDOWS_UPDATE_STAGING_ROOT,
        signal: controller.signal,
        onProgress: (progress) => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          mainWindow.webContents.send("update-download-progress", progress);
        },
      });
      if (windowsUpdateDownloadController === controller) windowsUpdateDownloadController = null;
      await launchWindowsUpdateHelper({
        zipPath: download.zipPath,
        installDir: dirname(process.execPath),
        exeName: "MOSA.exe",
        version: release.latestVersion,
        expectedIdentity: release.buildIdentity,
        processId: process.pid,
      });

      // Give the external helper exclusive ownership of the replacement only
      // after MOSA has drained its local service and released SQLite/runtime locks.
      shuttingDown = true;
      stopBridgeNotificationPoll();
      stopAnonymousUsageLifecycle();
      await stopOwnedRuntime();
      app.exit(0);
      return { status: "installing", latestVersion: release.latestVersion };
      } catch (error) {
        if (controller.signal.aborted) {
          return { status: "cancelled", currentVersion: app.getVersion() };
        }
        console.warn(`[MOSA] Windows update failed: ${error?.message || error}`);
        return { status: "error", currentVersion: app.getVersion(), code: "WINDOWS_UPDATE_FAILED" };
      } finally {
        if (windowsUpdateDownloadController === controller) windowsUpdateDownloadController = null;
      }
    })().finally(() => { windowsUpdateInstallPromise = null; });
    return windowsUpdateInstallPromise;
  });

  ipcMain.handle("cancel-update-download", async (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return { ok: false };
    const controller = process.platform === "darwin" ? macosUpdateDownloadController : windowsUpdateDownloadController;
    if (!controller || controller.signal.aborted) return { ok: false };
    controller.abort(new Error("MOSA update download cancelled by the user."));
    return { ok: true };
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
      // SQLite stores the managed original/derivative locations as absolute
      // paths. Rebase and verify the copied database before changing the saved
      // preference or deleting a single byte from the old authoritative tree.
      await finalizeCopiedSqliteLibrary({
        sourceLibraryDir: previousLibraryDir,
        destinationLibraryDir: nextLibraryDir,
      });
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

function startAnonymousUsageLifecycle() {
  // Explicit local opt-out. The daily HEAD ping carries no identifiers beyond
  // a random install id, but the machine owner can still switch it off.
  if (process.env.MOSA_DISABLE_TELEMETRY === "1") return;
  if (usageReportTimer || isolationContext.qaRun || !app.isPackaged) return;
  void runAnonymousUsageReport();
  usageReportTimer = setInterval(() => {
    void runAnonymousUsageReport();
  }, USAGE_REPORT_RECHECK_MS);
  usageReportTimer.unref?.();
}

function stopAnonymousUsageLifecycle() {
  if (!usageReportTimer) return;
  clearInterval(usageReportTimer);
  usageReportTimer = null;
}

function runUpdateCheck({ notify = false } = {}) {
  const currentVersion = app.getVersion();
  if (isolationContext.qaRun) return Promise.resolve({ status: "disabled", currentVersion });
  if (updateCheckPromise) return updateCheckPromise;
  updateCheckPromise = checkForMosaUpdate({
    currentVersion,
    currentDistribution: expectedServiceIdentity.distribution,
    releaseManifestTrust: expectedServiceIdentity.releaseManifestTrust,
  })
    .then((result) => {
      if (notify && result.updateAvailable && Notification.isSupported()) {
        const copy = getUpdateNotificationText(result.latestVersion, currentLocale);
        const notification = new Notification({ title: copy.title, body: copy.body, silent: true });
        notification.on("click", () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
          }
        });
        notification.show();
      }
      return {
        status: "ok",
        ...result,
        canInstallInApp: app.isPackaged && (
          (process.platform === "win32" && Boolean(result.windowsArtifact))
          || (process.platform === "darwin" && Boolean(result.macArtifact) && Boolean(resolveMacosInstallAppPath(process.execPath)))
        ),
      };
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
    windowOpenRequested = false;
    mainWindow.show();
    mainWindow.focus();
    return Promise.resolve();
  }
  windowOpenRequested = true;
  if (windowPromise) return windowPromise;
  // BUG-01 fix: sweep staged files left behind by failed/cancelled imports
  // (older than 24h) at startup; never blocks window creation.
  cleanupOrphanStagedFiles(importStagingRoot).catch((error) => {
    console.error(`[MOSA] import-staging orphan sweep failed: ${error?.message || error}`);
  });
  windowPromise = (async () => {
    do {
      windowOpenRequested = false;
      await createMainWindow();
    } while (!shuttingDown && windowOpenRequested && (!mainWindow || mainWindow.isDestroyed()));
  })().finally(() => { windowPromise = null; });
  return windowPromise;
}

async function createMainWindow() {
  denyBrowserPermissions();
  const bounds = loadBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    // F-10（Phase 6A）：桌面最小窗口钳制在批准的最低验收尺寸 960×640（产品规格 §6）。
    // 仅靠 BrowserWindow 原生最小尺寸实现，不用 resize 事件反复 setBounds、不在 renderer 模拟。
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#f5f5f4",
    ...desktopPlatform.windowOptions(),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const windowRef = mainWindow;

  console.info(`[MOSA] preload-path=${preloadPath}`);
  mainWindow.webContents.once("preload-error", (_event, attemptedPath, error) => {
    console.error(`[MOSA] preload-error path=${attemptedPath} ${error?.stack || error}`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[MOSA] render-process-gone ${JSON.stringify(details)}`);
    if (shuttingDown || !mainWindow || mainWindow.isDestroyed()) return;
    if (details?.reason === "clean-exit") return;
    rendererRecoveryAttempts += 1;
    if (rendererRecoveryAttempts > 2) {
      void dialog.showMessageBox(mainWindow, {
        type: "error",
        title: "MOSA",
        message: "MOSA's interface stopped unexpectedly and could not recover automatically.",
        buttons: ["Restart MOSA", "Close"],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response === 0) {
          app.relaunch();
          app.quit();
        }
      });
      return;
    }
    setTimeout(() => {
      if (!shuttingDown && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
    }, 250 * rendererRecoveryAttempts);
  });
  mainWindow.webContents.on("did-finish-load", () => { rendererRecoveryAttempts = 0; });
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

  buildMenu();
  registerIPC();
  await windowRef.loadFile(startupShellPath);
  if (windowRef.isDestroyed()) return;
  windowRef.show();

  const activeService = await ensureDesktopService();
  if (windowRef.isDestroyed() || mainWindow !== windowRef) return;
  const url = new URL(activeService.url);
  const blockForeignNavigation = (event, targetUrl) => {
    if (!isVerifiedMosaUrl(targetUrl, url)) event.preventDefault();
  };
  windowRef.webContents.on("will-navigate", blockForeignNavigation);
  windowRef.webContents.on("will-redirect", blockForeignNavigation);
  const clientUrl = new URL(activeService.url);
  if (activeService.clientToken) clientUrl.hash = `mosa-client-token=${encodeURIComponent(activeService.clientToken)}`;
  await windowRef.loadURL(clientUrl.toString());
  if (windowRef.isDestroyed()) return;
  windowRef.show();

  startBridgeNotificationPoll(activeService.port);
}

async function ensureDesktopService() {
  if (service) return service;
  if (serviceStartPromise) return serviceStartPromise;
  serviceStartPromise = (async () => {
    serviceManagerModulePromise ||= import("./service-manager.mjs");
    const {
      probeMosaService,
      shouldAllowSameVersionServiceReplacement,
      shouldAllowStaleServiceUpgrade,
      startMosaService,
    } = await serviceManagerModulePromise;
    await desktopStartupHandoffPromise;
    if (desktopStartupHandoffError) throw desktopStartupHandoffError;
    await waitForSupervisorHandoffYield({ probeMosaService });
    const clientToken = process.env.MOSA_CLIENT_TOKEN
      || await loadOrCreateMosaClientToken(desktopDataDir);
    const webCaptureToken = process.env.MOSA_WEB_CAPTURE_TOKEN
      || await loadOrCreateWebCaptureToken(desktopDataDir);
    const webCaptureOrigins = process.env.MOSA_WEB_CAPTURE_ORIGINS
      || MOSA_WEB_CAPTURE_DEFAULT_ORIGINS;
    const nextService = await startMosaService({
      port: desktopPort,
      libraryDir,
      preferOwnedRuntime: process.platform === "darwin" && app.isPackaged && Boolean(desktopStartupHandoffLease || macosUpdateReadyFile),
      allowPortFallback: !process.env.MOSA_DESKTOP_PORT,
      failOnPrimaryLibraryMismatch: true,
      allowStaleServiceUpgrade: shouldAllowStaleServiceUpgrade({
        isPackaged: app.isPackaged,
        qaRun: isolationContext.qaRun,
        explicitPort: Boolean(process.env.MOSA_DESKTOP_PORT),
      }),
      allowSameVersionServiceReplacement: shouldAllowSameVersionServiceReplacement({
        isPackaged: app.isPackaged,
        qaRun: isolationContext.qaRun,
        explicitPort: Boolean(process.env.MOSA_DESKTOP_PORT),
      }),
      expectedIdentity: {
        ...expectedServiceIdentity,
        clientAuthFingerprint: mosaClientTokenFingerprint(clientToken),
      },
      clientToken,
      importStagingRoot,
      isolationContext,
      runtimeOptions: {
        projectRoot: appRoot,
        managerDir: appRoot,
        cowartProjectDir: desktopDataDir,
        visualModel: {
          userDataDir: desktopDataDir,
          settings: await visualModelManager.runtimeConfig(),
        },
        appDir: join(appRoot, "app"),
        assetsRoot: join(libraryDir, "assets"),
        generatedImagesDir: join(libraryDir, "imports"),
        webCaptureToken,
        webCaptureOrigins,
        webCapturePairingConfirm: ({ origin } = {}) => confirmWebCapturePairing(origin),
        clientToken,
        disabledBridges: parseDisabledBridges({ env: process.env }),
      },
    });
    if (shuttingDown) {
      if (nextService.mode === "owned") await nextService.stop().catch(() => {});
      throw new Error("MOSA startup was cancelled during shutdown.");
    }
    service = nextService;
    await releaseDesktopStartupHandoff();
    return service;
  })().finally(() => {
    serviceStartPromise = null;
  });
  return serviceStartPromise;
}

async function waitForSupervisorHandoffYield({ probeMosaService, timeoutMs = 2_000, pollMs = 100 } = {}) {
  if (process.platform !== "darwin" || (!desktopStartupHandoffLease && !macosUpdateReadyFile) || typeof probeMosaService !== "function") return;
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    const status = await probeMosaService({
      port: desktopPort,
      libraryDir,
      timeoutMs: Math.min(500, Math.max(100, Number(pollMs) || 100)),
    });
    if (status.state !== "attached") return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(25, Number(pollMs) || 100)));
  }
}

async function releaseDesktopStartupHandoff() {
  const lease = desktopStartupHandoffLease;
  desktopStartupHandoffLease = null;
  if (!lease) return false;
  try {
    return await lease.release();
  } catch (error) {
    console.warn(`[MOSA] failed to release desktop startup handoff marker: ${error?.message || error}`);
    return false;
  }
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
let bridgePollAbortController = null;
let lastImportedCount = 0;
let bridgePollFailures = 0;
let runtimeRecoveryPromise = null;
let runtimeRecoveryInProgress = false;
const BRIDGE_POLL_INTERVAL_MS = 15_000;
const BRIDGE_POLL_TIMEOUT_MS = 5_000;

function startBridgeNotificationPoll(runtimePort) {
  if (bridgePollTimer || bridgePollAbortController) return;
  const scheduleNext = () => {
    if (shuttingDown || runtimeRecoveryInProgress || bridgePollTimer || bridgePollAbortController) return;
    bridgePollTimer = setTimeout(() => {
      bridgePollTimer = null;
      void pollOnce();
    }, BRIDGE_POLL_INTERVAL_MS);
    bridgePollTimer.unref?.();
  };
  const pollOnce = async () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      scheduleNext();
      return;
    }
    const controller = new AbortController();
    bridgePollAbortController = controller;
    const timeout = setTimeout(() => controller.abort(), BRIDGE_POLL_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const response = await fetch(`http://127.0.0.1:${runtimePort}/api/bridges`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Bridge health returned HTTP ${response.status}`);
      const data = await response.json();
      bridgePollFailures = 0;
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
    } catch (error) {
      if (shuttingDown) return;
      bridgePollFailures += 1;
      if (bridgePollFailures >= 3) {
        void recoverRuntimeAfterHealthFailure(error);
        return;
      }
    } finally {
      clearTimeout(timeout);
      if (bridgePollAbortController === controller) bridgePollAbortController = null;
      scheduleNext();
    }
  };
  scheduleNext();
}

function recoverRuntimeAfterHealthFailure(cause) {
  if (runtimeRecoveryPromise || shuttingDown) return runtimeRecoveryPromise;
  runtimeRecoveryInProgress = true;
  const recovery = (async () => {
    console.error(`[MOSA] local runtime health failed repeatedly; rebuilding desktop runtime: ${cause?.message || cause}`);
    stopBridgeNotificationPoll();
    bridgePollFailures = 0;
    const failedWindow = mainWindow;
    if (failedWindow && !failedWindow.isDestroyed()) failedWindow.destroy();
    if (mainWindow === failedWindow) mainWindow = null;
    const failedService = service;
    service = null;
    await failedService?.stop?.().catch((error) => {
      console.warn(`[MOSA] failed runtime cleanup during recovery: ${error?.message || error}`);
    });
    lastImportedCount = 0;
    await openMainWindow();
  })();
  runtimeRecoveryPromise = recovery
    .catch(reportStartupFailure)
    .finally(() => {
      runtimeRecoveryPromise = null;
      runtimeRecoveryInProgress = false;
    });
  return runtimeRecoveryPromise;
}

function stopBridgeNotificationPoll() {
  if (bridgePollTimer) {
    clearTimeout(bridgePollTimer);
    bridgePollTimer = null;
  }
  bridgePollAbortController?.abort();
  bridgePollAbortController = null;
  bridgePollFailures = 0;
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
  void Promise.allSettled([
    stopOwnedRuntime(),
    releaseDesktopStartupHandoff(),
  ]).finally(() => app.exit(1));
}
