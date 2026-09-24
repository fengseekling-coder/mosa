import test from "node:test";
import assert from "node:assert/strict";
import { desktopPlatformAdapter } from "../desktop/platform/index.mjs";

test("darwin adapter preserves the current MOSA window chrome and lifecycle", () => {
  const adapter = desktopPlatformAdapter("darwin");
  assert.equal(adapter.id, "darwin");
  assert.deepEqual(adapter.windowOptions(), {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
  });
  assert.equal(adapter.capabilities.trafficLights, true);
  assert.equal(adapter.capabilities.pruneInjectedApplicationMenuItems, true);
  assert.equal(adapter.capabilities.hideApplicationMenuBar, false);
  assert.equal(adapter.capabilities.keepRuntimeAfterLastWindow, true);

  let quitCalls = 0;
  adapter.onWindowAllClosed({ quit() { quitCalls += 1; } });
  assert.equal(quitCalls, 0, "current background-runtime behavior stays unchanged");
});

test("win32 adapter removes macOS-only window chrome and quits when its last window closes", () => {
  const adapter = desktopPlatformAdapter("win32");
  assert.equal(adapter.id, "win32");
  assert.deepEqual(adapter.windowOptions(), { autoHideMenuBar: true });
  assert.equal(adapter.capabilities.trafficLights, false);
  assert.equal(adapter.capabilities.pruneInjectedApplicationMenuItems, false);
  assert.equal(adapter.capabilities.hideApplicationMenuBar, true);
  assert.equal(adapter.capabilities.keepRuntimeAfterLastWindow, false);

  let quitCalls = 0;
  adapter.onWindowAllClosed({ quit() { quitCalls += 1; } });
  assert.equal(quitCalls, 1, "Windows must not leave an invisible background process without a tray entry point");
});

test("unknown desktop platforms use the conservative shared shell", () => {
  const adapter = desktopPlatformAdapter("future-os");
  assert.equal(adapter.id, "generic");
  assert.deepEqual(adapter.windowOptions(), {});
  assert.equal(adapter.capabilities.trafficLights, false);
  assert.equal(adapter.capabilities.pruneInjectedApplicationMenuItems, false);
  assert.equal(adapter.capabilities.hideApplicationMenuBar, false);
  assert.equal(adapter.capabilities.keepRuntimeAfterLastWindow, false);

  let quitCalls = 0;
  adapter.onWindowAllClosed({ quit() { quitCalls += 1; } });
  assert.equal(quitCalls, 1);
});

test("adapter lookup falls back to process.platform when no argument is passed", () => {
  const adapter = desktopPlatformAdapter();
  const known = adapter.id === "darwin" || adapter.id === "win32" || adapter.id === "generic";
  assert.equal(known, true, "desktopPlatformAdapter() must always return a known adapter id");
  assert.equal(typeof adapter.windowOptions, "function");
  assert.equal(typeof adapter.onWindowAllClosed, "function");
});

test("adapter capabilities are read-only to keep shell logic from mutating them", () => {
  const win32 = desktopPlatformAdapter("win32");
  // Strict mode would throw on assignment; permissive mode silently fails.
  // Either way, the frozen capability flags must not change after a noop write.
  const before = { ...win32.capabilities };
  try {
    win32.capabilities.keepRuntimeAfterLastWindow = true;
  } catch {}
  assert.equal(win32.capabilities.keepRuntimeAfterLastWindow, before.keepRuntimeAfterLastWindow);
  assert.equal(win32.capabilities.hideApplicationMenuBar, before.hideApplicationMenuBar);

  const darwin = desktopPlatformAdapter("darwin");
  const darwinBefore = { ...darwin.capabilities };
  try {
    darwin.capabilities.trafficLights = false;
  } catch {}
  assert.equal(darwin.capabilities.trafficLights, darwinBefore.trafficLights);
});

test("win32 onWindowAllClosed quits every time it is invoked (no idle background process)", () => {
  const adapter = desktopPlatformAdapter("win32");
  let quitCalls = 0;
  const fakeApp = { quit() { quitCalls += 1; } };
  adapter.onWindowAllClosed(fakeApp);
  adapter.onWindowAllClosed(fakeApp);
  adapter.onWindowAllClosed(fakeApp);
  assert.equal(quitCalls, 3, "Every window-close transition must call app.quit() on Windows; the dock-less shell has no tray re-entry point");
});

test("darwin onWindowAllClosed is intentionally a no-op (runtime stays alive)", () => {
  const adapter = desktopPlatformAdapter("darwin");
  let quitCalls = 0;
  adapter.onWindowAllClosed({ quit() { quitCalls += 1; } });
  adapter.onWindowAllClosed({ quit() { quitCalls += 1; } });
  assert.equal(quitCalls, 0, "macOS Desktop shell keeps the runtime alive so the app can be reopened from the Dock");
});

test("desktopPlatformAdapter returns the same adapter object for repeated lookups", () => {
  // The contract relies on a single canonical adapter per platform; creating
  // a fresh object every call would defeat module-level freezing and let any
  // caller accidentally mutate shared capability flags.
  const first = desktopPlatformAdapter("win32");
  const second = desktopPlatformAdapter("win32");
  assert.equal(first, second, "win32 adapter must be the same reference on every lookup");
  assert.equal(first, desktopPlatformAdapter("win32"), "lookup remains stable across repeated calls");
});

test("desktopPlatformAdapter does not confuse 'win32' with similar platform names", () => {
  // node's process.platform returns 'win32' for both x86 and arm64 Windows.
  // Strings like 'windows' or 'win64' must not alias to the WIN32 adapter
  // because that would silently enable the wrong window-chrome behavior.
  const windowsLike = desktopPlatformAdapter("windows");
  const win64Like = desktopPlatformAdapter("win64");
  const linuxLike = desktopPlatformAdapter("linux");
  assert.equal(windowsLike.id, "generic");
  assert.equal(win64Like.id, "generic");
  assert.equal(linuxLike.id, "generic");
});
