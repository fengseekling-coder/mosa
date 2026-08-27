const DARWIN = "darwin";
const WIN32 = "win32";

const ADAPTERS = Object.freeze({
  [DARWIN]: Object.freeze({
    id: DARWIN,
    capabilities: Object.freeze({
      keepRuntimeAfterLastWindow: true,
      trafficLights: true,
      pruneInjectedApplicationMenuItems: true,
      hideApplicationMenuBar: false,
    }),
    windowOptions() {
      return {
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 16, y: 18 },
      };
    },
    onWindowAllClosed() {},
  }),
  [WIN32]: Object.freeze({
    id: WIN32,
    capabilities: Object.freeze({
      keepRuntimeAfterLastWindow: false,
      trafficLights: false,
      pruneInjectedApplicationMenuItems: false,
      hideApplicationMenuBar: true,
    }),
    windowOptions() {
      // Keep the native Windows title bar, but do not let Electron consume a
      // second row for the application menu. The application menu itself stays
      // installed so accelerators such as Ctrl+N / Ctrl+F keep working.
      return { autoHideMenuBar: true };
    },
    onWindowAllClosed(app) {
      // Windows has no Dock-style re-entry point and MOSA does not expose a
      // tray icon. Keeping the runtime alive after the last window closes
      // would therefore leave an invisible process with no discoverable UI.
      app.quit();
    },
  }),
});

const GENERIC_ADAPTER = Object.freeze({
  id: "generic",
  capabilities: Object.freeze({
    keepRuntimeAfterLastWindow: false,
    trafficLights: false,
    pruneInjectedApplicationMenuItems: false,
    hideApplicationMenuBar: false,
  }),
  windowOptions() {
    return {};
  },
  onWindowAllClosed(app) {
    app.quit();
  },
});

/**
 * Small OS boundary for the Electron shell. Shared product/runtime behavior
 * must stay outside this adapter; only desktop-shell differences belong here.
 */
export function desktopPlatformAdapter(platform = process.platform) {
  return ADAPTERS[platform] || GENERIC_ADAPTER;
}
