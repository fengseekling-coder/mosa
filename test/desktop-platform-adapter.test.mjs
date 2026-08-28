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
