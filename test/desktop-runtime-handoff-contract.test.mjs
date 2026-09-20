import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("desktop publishes startup handoff before opening the runtime and releases it after ownership resolves", async () => {
  const source = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  const handoffIndex = source.indexOf("createMosaDesktopStartupHandoff({ libraryDir })");
  const readyIndex = source.indexOf("app.whenReady().then");
  assert.ok(handoffIndex >= 0, "desktop creates the startup handoff marker");
  assert.ok(readyIndex > handoffIndex, "handoff creation begins before app-ready runtime startup");
  assert.ok(source.includes('const desktopStartupHandoffEnabled = process.platform === "darwin"'), "handoff is scoped to macOS");
  assert.ok(source.includes("&& app.isPackaged"), "handoff is scoped to packaged Desktop");
  assert.ok(source.includes("&& !launchedFromMacosUpdate"), "post-update relaunch relies on the helper-owned handoff marker");
  assert.ok(source.includes("&& !process.env.MOSA_DESKTOP_PORT"), "explicit separate desktop ports do not disturb the background supervisor");
  assert.ok(source.includes("await desktopStartupHandoffPromise;"), "service startup waits for the handoff marker");
  assert.ok(source.includes("await waitForSupervisorHandoffYield({ probeMosaService });"), "desktop allows the supervisor to yield before probing ownership");
  assert.ok(source.includes('preferOwnedRuntime: process.platform === "darwin" && app.isPackaged && Boolean(desktopStartupHandoffLease || macosUpdateReadyFile)'), "packaged macOS prefers owning the primary runtime during startup and update handoff");
  assert.ok(source.includes("(!desktopStartupHandoffLease && !macosUpdateReadyFile)"), "post-update relaunch still waits for the supervisor to yield");
  assert.ok(source.includes("service = nextService;\n    await releaseDesktopStartupHandoff();"), "successful service ownership releases the marker");
  assert.ok(source.includes("stopOwnedRuntime(),\n      releaseDesktopStartupHandoff(),"), "shutdown releases runtime ownership and the handoff marker together");
});
