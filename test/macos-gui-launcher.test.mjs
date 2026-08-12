import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMacGuiLauncher, selectGuiEnvironment } from "../scripts/macos-gui-launcher.mjs";

test("selectGuiEnvironment excludes Codex sandbox and unsafe inherited variables", () => {
  const selected = selectGuiEnvironment({
    HOME: "/Users/test",
    PATH: "/usr/bin:/bin",
    CODEX_SANDBOX: "seatbelt",
    CODEX_CI: "1",
    DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib",
    MOSA_RUNTIME_MODE: "qa",
    MOSA_LIBRARY_DIR: "/tmp/library",
    ELECTRON_ENABLE_LOGGING: "1",
  });

  assert.deepEqual(selected, {
    HOME: "/Users/test",
    PATH: "/usr/bin:/bin",
    MOSA_RUNTIME_MODE: "qa",
    MOSA_LIBRARY_DIR: "/tmp/library",
    ELECTRON_ENABLE_LOGGING: "1",
  });
});

test("temporary macOS app launches the GUI with a clean environment", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "mosa-gui-launcher-test-"));
  const pidFile = join(rootDir, "qa-pid.txt");
  const logFile = join(rootDir, "gui-main.log");
  const appDir = await createMacGuiLauncher({
    rootDir,
    executable: "/tmp/MOSA's Binary",
    args: ["--user-data-dir=/tmp/user data"],
    env: {
      CODEX_SANDBOX: "seatbelt",
      MOSA_RUNTIME_MODE: "qa",
      MOSA_LIBRARY_DIR: "/tmp/library dir",
    },
    cwd: "/tmp/repo dir",
    pidFile,
    logFile,
    healthUrl: "http://127.0.0.1:54321/api/health",
    healthFile: join(rootDir, "gui-health.json"),
  });

  const launcher = await readFile(join(appDir, "Contents", "MacOS", "launch-mosa-qa"), "utf8");
  assert.match(launcher, /'\/usr\/bin\/env' '-i'/);
  assert.match(launcher, /'MOSA_RUNTIME_MODE=qa'/);
  assert.match(launcher, /'MOSA_LIBRARY_DIR=\/tmp\/library dir'/);
  assert.match(launcher, /'\/tmp\/MOSA'"'"'s Binary'/);
  assert.match(launcher, /child_pid=\$!/);
  assert.match(launcher, /attempts" -lt 900/);
  assert.match(launcher, /curl -fsS --max-time 1 'http:\/\/127\.0\.0\.1:54321\/api\/health'/);
  assert.doesNotMatch(launcher, /CODEX_SANDBOX/);
  assert.doesNotMatch(launcher, /DYLD_/);
});
