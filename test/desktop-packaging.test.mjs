import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import forgeConfig, {
  createForgeConfig,
  macReleasePackagingConfig,
  packageIgnorePatterns,
  packageIgnorePatternsForTarget,
  preparePackagedRuntime,
  resolveDesktopPackagingTarget,
} from "../desktop/forge.config.mjs";
import {
  assertDesktopPackagingNode,
  desktopPackagingNodeError,
} from "../scripts/check-desktop-package-node.mjs";

const isIgnored = (path) => packageIgnorePatterns.some((pattern) => pattern.test(path));

test("desktop packaging accepts Node 22 and rejects other major versions", () => {
  assert.equal(assertDesktopPackagingNode("22.23.1"), true);
  assert.equal(desktopPackagingNodeError("v22.0.0"), null);
  assert.match(desktopPackagingNodeError("24.16.0")?.message || "", /requires Node\.js 22\.x/);
  assert.throws(() => assertDesktopPackagingNode("24.16.0"), /current runtime is v24\.16\.0/);
});

test("packages MOSA with ASAR and unpacked native dependencies", () => {
  assert.equal(forgeConfig.outDir, "out");
  assert.equal(forgeConfig.packagerConfig.name, "MOSA");
  assert.equal(forgeConfig.packagerConfig.appBundleId, "com.azhuilab.mosa");
  const sign = forgeConfig.packagerConfig.osxSign;
  assert.equal(sign.identity, "-");
  assert.equal(sign.identityValidation, false);
  assert.equal(sign.preAutoEntitlements, false);
  assert.equal(sign.strictVerify, true);
  assert.equal(sign.continueOnError, false);
  assert.deepEqual(sign.optionsForFile("/tmp/MOSA.app"), {
    hardenedRuntime: false,
    additionalArguments: ["--options=0"],
  });
  assert.equal(
    forgeConfig.packagerConfig.asar.unpackDir,
    "node_modules/@img/sharp-libvips-darwin-arm64",
  );
  assert.equal(typeof forgeConfig.hooks.packageAfterPrune, "function");
  assert.deepEqual(forgeConfig.packagerConfig.ignore, packageIgnorePatterns);
  assert.equal(forgeConfig.plugins.some((plugin) => plugin.name === "auto-unpack-natives"), true);
  assert.equal(forgeConfig.makers.some((maker) => maker.name === "zip"), true);
});

test("desktop packaging target resolution supports only the approved macOS and Windows targets", () => {
  assert.equal(resolveDesktopPackagingTarget({ platform: "darwin", arch: "arm64", env: {}, argv: [] }).id, "darwin-arm64");
  assert.equal(resolveDesktopPackagingTarget({ platform: "win32", arch: "x64", env: {}, argv: [] }).id, "win32-x64");
  assert.equal(resolveDesktopPackagingTarget({ env: {}, argv: ["node", "forge", "--platform", "win32", "--arch=x64"] }).id, "win32-x64");
  assert.equal(resolveDesktopPackagingTarget({ env: { MOSA_DESKTOP_PLATFORM: "win32", MOSA_DESKTOP_ARCH: "x64" }, argv: [] }).id, "win32-x64");
  assert.throws(
    () => resolveDesktopPackagingTarget({ platform: "win32", arch: "arm64", env: {}, argv: [] }),
    /Unsupported MOSA desktop packaging target: win32-arm64/,
  );
});

test("Windows Forge config omits mac signing and selects Windows native runtime packages", () => {
  const target = resolveDesktopPackagingTarget({ platform: "win32", arch: "x64", env: {}, argv: [] });
  const config = createForgeConfig({ target, env: { MOSA_RELEASE_BUILD: "1" } });
  assert.equal("appBundleId" in config.packagerConfig, false);
  assert.equal("osxSign" in config.packagerConfig, false);
  assert.equal("osxNotarize" in config.packagerConfig, false);
  assert.equal(config.packagerConfig.asar.unpackDir, "node_modules/@img/sharp-win32-x64");
  assert.equal(config.makers.some((maker) => maker.name === "zip" && maker.platforms.includes("win32")), true);

  const patterns = packageIgnorePatternsForTarget(target);
  const ignored = (path) => patterns.some((pattern) => pattern.test(path));
  assert.equal(ignored("/node_modules/@img/sharp-win32-x64/package.json"), false);
  assert.equal(ignored("/node_modules/@img/sharp-darwin-arm64/package.json"), true);
  assert.equal(ignored("/node_modules/better-sqlite3/prebuilds/win32-x64.node"), false);
});

test("release packaging fails closed when Apple signing credentials are incomplete", () => {
  assert.throws(
    () => macReleasePackagingConfig({ MOSA_RELEASE_BUILD: "1" }),
    /MOSA release build requires: MOSA_MACOS_SIGN_IDENTITY, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID/,
  );
  assert.throws(
    () => macReleasePackagingConfig({
      MOSA_RELEASE_BUILD: "1",
      MOSA_MACOS_SIGN_IDENTITY: "Developer ID Application: Example",
      APPLE_ID: "release@example.com",
      APPLE_TEAM_ID: "TEAM123456",
    }),
    /APPLE_APP_SPECIFIC_PASSWORD/,
  );
});

test("release packaging enables Developer ID hardened signing and notarization", () => {
  const config = macReleasePackagingConfig({
    MOSA_RELEASE_BUILD: "1",
    MOSA_MACOS_SIGN_IDENTITY: "Developer ID Application: Example (TEAM123456)",
    APPLE_ID: "release@example.com",
    APPLE_APP_SPECIFIC_PASSWORD: "app-specific-password",
    APPLE_TEAM_ID: "TEAM123456",
  });

  assert.equal(config.osxSign.identity, "Developer ID Application: Example (TEAM123456)");
  assert.equal(config.osxSign.identityValidation, true);
  assert.equal(config.osxSign.preAutoEntitlements, true);
  assert.equal(config.osxSign.strictVerify, true);
  assert.equal(config.osxSign.continueOnError, false);
  assert.deepEqual(config.osxSign.optionsForFile("/tmp/MOSA.app"), { hardenedRuntime: true });
  assert.deepEqual(config.osxNotarize, {
    appleId: "release@example.com",
    appleIdPassword: "app-specific-password",
    teamId: "TEAM123456",
  });
  assert.equal("tool" in config.osxNotarize, false, "Forge uses the current notarization credential shape");
});

test("desktop package excludes every non-runtime project surface", () => {
  for (const path of [
    "/.github/workflows/verify.yml",
    "/.gitignore",
    "/AGENTS.md",
    "/assets/default/images/library-image.png",
    "/bin/mosa.mjs",
    "/CHANGELOG.md",
    "/COMMERCIAL-LICENSE.md",
    "/desktop/forge.config.mjs",
    "/desktop/preload.mjs",
    "/dist/lib/server-security.js",
    "/docs/operations.md",
    "/extensions/chatgpt-web-capture/manifest.json",
    "/lib/asset-sort.d.ts",
    "/lib/asset-sort.js.map",
    "/lib/asset-sort.ts",
    "/mcp/server.mjs",
    "/node_modules/.package-lock.json",
    "/node_modules/@electron/asar/lib/asar.js",
    "/node_modules/@img/sharp-darwin-x64/package.json",
    "/node_modules/eslint/lib/api.js",
    "/out/MOSA-darwin-arm64/MOSA.app/Contents/Info.plist",
    "/package-lock.json",
    "/README.md",
    "/scripts/check-source.mjs",
    "/server.mjs",
    "/test/desktop-packaging.test.mjs",
    "/tsconfig.json",
  ]) {
    assert.equal(isIgnored(path), true, `${path} must stay out of the desktop package`);
  }
});

test("desktop package keeps every required runtime surface", () => {
  for (const path of [
    "/LICENSE",
    "/package.json",
    "/app/app.mjs",
    "/app/build-identity.json",
    "/app/index.html",
    "/app/styles.css",
    "/app/font-instrument-sans.woff2",
    "/desktop/main.mjs",
    "/desktop/notification-i18n.mjs",
    "/desktop/platform/index.mjs",
    "/desktop/preload.cjs",
    "/desktop/service-manager.mjs",
    "/lib/api/asset-routes.mjs",
    "/lib/asset-sort.js",
    "/lib/mosa-runtime.mjs",
    "/lib/runtime-isolation-guard.mjs",
    "/node_modules/better-sqlite3/lib/index.js",
    "/node_modules/better-sqlite3/prebuilds/darwin-arm64.node",
    "/node_modules/detect-libc/lib/detect-libc.js",
    "/node_modules/node-addon-api/index.js",
    "/node_modules/semver/index.js",
    "/node_modules/sharp/dist/index.cjs",
    "/node_modules/@img/colour/index.cjs",
    "/node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.3.node",
    "/node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.3.dylib",
  ]) {
    assert.equal(isIgnored(path), false, `${path} must remain available to the desktop runtime`);
  }
});

test("reduces the packaged dependency tree to arm64 runtime files", async (t) => {
  const buildPath = await mkdtemp(join(tmpdir(), "mosa-desktop-package-"));
  t.after(() => rm(buildPath, { recursive: true, force: true }));
  const packageDir = join(buildPath, "node_modules", "better-sqlite3");
  const metadataPath = join(packageDir, "build", "config.gypi");
  const bindingPath = join(packageDir, "prebuilds", "darwin-arm64.node");
  const foreignBindingPath = join(packageDir, "prebuilds", "linux-x64.node");
  const sqliteSourcePath = join(packageDir, "src", "addon.cpp");
  const sharpRuntimePath = join(buildPath, "node_modules", "sharp", "dist", "index.cjs");
  const sharpTypePath = join(buildPath, "node_modules", "sharp", "dist", "index.d.cts");
  const nodeAddonPath = join(buildPath, "node_modules", "node-addon-api", "index.js");
  const sharpBindingDir = join(buildPath, "node_modules", "@img", "sharp-darwin-arm64");
  const sharpLibvipsDir = join(buildPath, "node_modules", "@img", "sharp-libvips-darwin-arm64");
  await mkdir(join(packageDir, "build"), { recursive: true });
  await mkdir(join(packageDir, "prebuilds"), { recursive: true });
  await mkdir(join(packageDir, "src"), { recursive: true });
  await mkdir(join(buildPath, "node_modules", "sharp", "dist"), { recursive: true });
  await mkdir(join(buildPath, "node_modules", "node-addon-api"), { recursive: true });
  await mkdir(sharpBindingDir, { recursive: true });
  await mkdir(sharpLibvipsDir, { recursive: true });
  await writeFile(metadataPath, "local_prefix=/Users/example/project\n");
  await writeFile(bindingPath, "binding");
  await writeFile(foreignBindingPath, "foreign binding");
  await writeFile(sqliteSourcePath, "source");
  await writeFile(sharpRuntimePath, "runtime");
  await writeFile(sharpTypePath, "types");
  await writeFile(nodeAddonPath, "build helper");
  await writeFile(
    join(buildPath, "package.json"),
    JSON.stringify({
      name: "mosa",
      version: "0.2.0",
      private: true,
      license: "test-license",
      type: "module",
      main: "desktop/main.mjs",
      config: { forge: "desktop/forge.config.mjs" },
      scripts: { test: "node --test" },
      bin: { mosa: "bin/mosa.mjs" },
      engines: { node: ">=22" },
      dependencies: { "better-sqlite3": "1", sharp: "1" },
      devDependencies: { electron: "1" },
    }),
  );

  await preparePackagedRuntime(buildPath);

  await assert.rejects(access(metadataPath));
  await assert.rejects(access(foreignBindingPath));
  await assert.rejects(access(sqliteSourcePath));
  await assert.rejects(access(sharpTypePath));
  await assert.rejects(access(nodeAddonPath));
  await access(bindingPath);
  await access(sharpRuntimePath);
  await access(sharpBindingDir);
  await access(sharpLibvipsDir);
  assert.deepEqual(JSON.parse(await readFile(join(buildPath, "package.json"), "utf8")), {
    name: "mosa",
    version: "0.2.0",
    private: true,
    license: "test-license",
    type: "module",
    main: "desktop/main.mjs",
    engines: { node: ">=22" },
    dependencies: { "better-sqlite3": "1", sharp: "1" },
  });
});

test("reduces a Windows package to win32-x64 native runtime files", async (t) => {
  const buildPath = await mkdtemp(join(tmpdir(), "mosa-desktop-package-win32-"));
  t.after(() => rm(buildPath, { recursive: true, force: true }));
  const packageDir = join(buildPath, "node_modules", "better-sqlite3");
  const windowsBinding = join(packageDir, "prebuilds", "win32-x64.node");
  const macBinding = join(packageDir, "prebuilds", "darwin-arm64.node");
  const windowsSharp = join(buildPath, "node_modules", "@img", "sharp-win32-x64");
  await mkdir(join(packageDir, "prebuilds"), { recursive: true });
  await mkdir(windowsSharp, { recursive: true });
  await writeFile(windowsBinding, "windows binding");
  await writeFile(macBinding, "mac binding");
  await writeFile(join(buildPath, "package.json"), JSON.stringify({
    name: "mosa",
    version: "0.2.0",
    private: true,
    license: "test-license",
    type: "module",
    main: "desktop/main.mjs",
    engines: { node: ">=22" },
    dependencies: { "better-sqlite3": "1", sharp: "1" },
  }));

  const target = resolveDesktopPackagingTarget({ platform: "win32", arch: "x64", env: {}, argv: [] });
  await preparePackagedRuntime(buildPath, target);

  await access(windowsBinding);
  await access(windowsSharp);
  await assert.rejects(access(macBinding));
});

test("Windows packaging fails closed with actionable cross-packaging guidance when target Sharp is absent", async (t) => {
  const buildPath = await mkdtemp(join(tmpdir(), "mosa-desktop-package-win32-missing-sharp-"));
  t.after(() => rm(buildPath, { recursive: true, force: true }));
  const packageDir = join(buildPath, "node_modules", "better-sqlite3");
  await mkdir(join(packageDir, "prebuilds"), { recursive: true });
  await writeFile(join(packageDir, "prebuilds", "win32-x64.node"), "windows binding");

  const target = resolveDesktopPackagingTarget({ platform: "win32", arch: "x64", env: {}, argv: [] });
  await assert.rejects(
    preparePackagedRuntime(buildPath, target),
    /Missing Sharp runtime for win32-x64: @img\/sharp-win32-x64[\s\S]*Build win32-x64 on Windows\/CI[\s\S]*cross-packaging requires the target OS optional Sharp package/,
  );
});

test("desktop:start has a native Windows launch path while preserving the macOS GUI workaround", async () => {
  const source = await readFile(resolve(import.meta.dirname, "..", "scripts", "desktop-start.mjs"), "utf8");
  assert.match(source, /process\.platform === "darwin"/);
  assert.match(source, /process\.platform === "win32"/);
  assert.match(source, /electron\.exe/);
  assert.match(source, /Using the native Windows Electron launch path/);
  assert.match(source, /tryOpenViaLaunchServices\(\)/);
  assert.match(source, /tryOpenViaTerminal\(\)/);
});

test("keeps the desktop window single-instance and sandboxed", async () => {
  const source = await readFile(resolve(import.meta.dirname, "..", "desktop", "main.mjs"), "utf8");
  assert.match(source, /app\.requestSingleInstanceLock\(\)/);
  assert.match(source, /desktopPlatformAdapter\(\)/);
  assert.match(source, /app\.on\("window-all-closed", \(\) => desktopPlatform\.onWindowAllClosed\(app\)\)/);
  assert.match(source, /\.\.\.desktopPlatform\.windowOptions\(\)/);
  assert.match(source, /desktopPlatform\.capabilities\.hideApplicationMenuBar/);
  assert.match(source, /mainWindow\.setMenuBarVisibility\(false\)/);
  assert.match(source, /startMosaService/);
  assert.match(source, /DEFAULT_MOSA_DESKTOP_PORT/);
  assert.match(source, /const desktopDataDir = app\.getPath\("userData"\)/);
  assert.match(source, /cowartProjectDir: desktopDataDir/);
  assert.match(source, /loadURL\(service\.url\)/);
  assert.doesNotMatch(source, /loadFile\(/);
  assert.match(source, /app\.on\("before-quit"/);
  assert.match(source, /service\?\.mode === "owned"/);
  assert.match(source, /contextIsolation: true/);
  assert.match(source, /nodeIntegration: false/);
  assert.match(source, /sandbox: true/);
  assert.match(source, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(source, /webContents\.on\("will-navigate", blockForeignNavigation\)/);
  assert.match(source, /webContents\.on\("will-redirect", blockForeignNavigation\)/);
  assert.match(source, /setPermissionCheckHandler\(\(\) => false\)/);
  assert.match(source, /setPermissionRequestHandler\(\(_webContents, _permission, callback\) => callback\(false\)\)/);
  assert.match(source, /app\.exit\(0\)/);
  assert.match(
    source,
    /if \(shuttingDown\) \{[\s\S]*startup load aborted during shutdown/,
    "shutdown must not surface a false startup error dialog",
  );

  const appSource = await readFile(resolve(import.meta.dirname, "..", "app", "app.mjs"), "utf8");
  const index = await readFile(resolve(import.meta.dirname, "..", "app", "index.html"), "utf8");
  assert.doesNotMatch(appSource, /window\.open\(/);
  assert.match(appSource, /openImagePreview\(asset\.id, event\.currentTarget\)/);
  assert.match(index, /<video id="imagePreviewVideo" controls playsinline hidden>/);
});

test("packaged smoke waits for the real renderer and tears Electron down before cleanup", async () => {
  const source = await readFile(resolve(import.meta.dirname, "..", "scripts", "packaged-smoke.mjs"), "utf8");
  assert.match(source, /--remote-debugging-port=/, "packaged smoke must inspect the packaged renderer");
  assert.match(source, /waitForRenderer\(/, "packaged smoke must wait for renderer readiness");
  assert.match(source, /document\.querySelector\('#appShell'\)/, "renderer readiness must require the real MOSA app shell");
  assert.match(source, /window\.electronAPI/, "renderer readiness must verify preload exposure");
  assert.match(source, /await stopChild\(child\)/, "cleanup must wait for Electron teardown");
  assert.match(source, /signalProcessTree\(childProcess\.pid, \{ force: true \}\)/, "teardown must have a bounded process-tree hard-stop fallback");
});

test("the packaged app includes build-identity.json in app/", () => {
  // build-identity.json must not be ignored by the forge packaging config.
  assert.equal(isIgnored("/app/build-identity.json"), false);
  assert.equal(isIgnored("/app/index.html"), false);
  assert.equal(isIgnored("/app/app.mjs"), false);
  assert.equal(isIgnored("/app/styles.css"), false);
  assert.equal(isIgnored("/lib/build-identity.mjs"), false);
  assert.equal(isIgnored("/desktop/preload.cjs"), false);
});

// Phase 4C：「在 Finder 中显示」桌面能力契约。自动测试不真正打开用户 Finder——以源码
// 契约断言验证 preload 暴露面、IPC 名称一致性、main 的 sender/路径/存在性校验与
// shell.showItemInFolder 调用；完整行为断言见 inspector-cowart-original-actions-contract。
test("exposes only the minimal show-in-folder capability to the renderer", async () => {
  const preload = await readFile(resolve(import.meta.dirname, "..", "desktop", "preload.cjs"), "utf8");
  const main = await readFile(resolve(import.meta.dirname, "..", "desktop", "main.mjs"), "utf8");

  // preload 暴露 showItemInFolder，IPC 名称与 main 完全一致。
  assert.match(preload, /showItemInFolder: \(path\) => ipcRenderer\.invoke\("show-item-in-folder", path\)/);
  assert.match(main, /ipcMain\.handle\("show-item-in-folder",/);
  // preload 其余 API 不变，不向 renderer 暴露 shell 对象或任意命令执行能力。
  for (const api of ["pasteImage", "setLocale", "onMenuImport", "onMenuSearch"]) {
    assert.match(preload, new RegExp(`${api}:`), `preload keeps exposing ${api}`);
  }
  // Dead IPC channels stay removed rather than expanding renderer authority.
  assert.doesNotMatch(preload, /getPathForFile:/, "getPathForFile was removed as dead code");
  assert.doesNotMatch(preload, /stage-dropped-file/, "stage-dropped-file IPC was removed as dead code");
  assert.doesNotMatch(preload, /openFileDialog:/, "unused open-file dialog IPC was removed");
  assert.doesNotMatch(main, /ipcMain\.handle\("open-file-dialog"/, "unused open-file dialog handler was removed");
  assert.equal(preload.split("ipcRenderer.invoke").length - 1, 7, "no invoke channel beyond the seven currently approved narrow requests");
  assert.doesNotMatch(preload, /shell\s*[:.]/, "shell is never exposed to the renderer");
  assert.doesNotMatch(preload, /exec\(|spawn\(|execFile\(/, "no arbitrary command execution");

  // main：sender 必须是当前 mainWindow.webContents；拒绝空字符串/相对路径/URL/不存在文件；
  // 使用 shell.showItemInFolder 而非 openExternal；成功 ok:true，失败结构化 reason；不抛未处理异常。
  const handlerStart = main.indexOf('ipcMain.handle("show-item-in-folder"');
  assert.notEqual(handlerStart, -1);
  const handler = main.slice(handlerStart, main.indexOf("\n}", handlerStart));
  assert.match(handler, /event\.sender !== mainWindow\.webContents/, "rejects a non-main-window sender");
  assert.match(handler, /typeof path !== "string" \|\| !path\.trim\(\)/, "rejects an empty path");
  assert.match(handler, /!isAbsolute\(target\)/, "rejects a relative path");
  assert.match(handler, /\^\[a-z\]\[a-z0-9\+\.\-\]\*:\/i\.test\(target\)/, "rejects URL input");
  assert.match(handler, /!existsSync\(target\)/, "rejects a missing file");
  assert.match(handler, /shell\.showItemInFolder\(allowedTarget\)/, "uses shell.showItemInFolder only after boundary validation");
  assert.doesNotMatch(handler, /openExternal/, "never opens local paths through shell.openExternal");
  assert.match(handler, /return \{ ok: true \}/, "success resolves ok");
  assert.match(handler, /catch \{\n\s+return \{ ok: false, reason: "unavailable" \}/, "failures resolve a structured reason instead of throwing");

  // packaged app 的 sandbox preload 使用相对 main.mjs 解析出的绝对 CommonJS 路径。
  assert.match(main, /const preloadPath = fileURLToPath\(new URL\("\.\/preload\.cjs", import\.meta\.url\)\);/);
  assert.match(main, /preload: preloadPath/);
  assert.equal(isIgnored("/desktop/preload.cjs"), false);
});
