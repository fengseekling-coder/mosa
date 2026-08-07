import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import forgeConfig, {
  packageIgnorePatterns,
  removeNativeBuildMetadata,
} from "../desktop/forge.config.mjs";

test("packages MOSA with ASAR and unpacked native dependencies", () => {
  assert.equal(forgeConfig.packagerConfig.name, "MOSA");
  assert.equal(forgeConfig.packagerConfig.appBundleId, "com.azhuilab.mosa");
  assert.equal(
    forgeConfig.packagerConfig.asar.unpackDir,
    "node_modules/@img/sharp-libvips-darwin-arm64",
  );
  assert.equal(typeof forgeConfig.hooks.packageAfterPrune, "function");
  assert.equal(packageIgnorePatterns.some((pattern) => pattern.test("/test/example.test.mjs")), true);
  assert.equal(packageIgnorePatterns.some((pattern) => pattern.test("/scripts/check-source.mjs")), true);
  assert.equal(packageIgnorePatterns.some((pattern) => pattern.test("/dist/lib/server-security.js")), true);
  assert.equal(packageIgnorePatterns.some((pattern) => pattern.test("/lib/mosa-runtime.mjs")), false);
  assert.deepEqual(forgeConfig.packagerConfig.ignore, packageIgnorePatterns);
  assert.equal(forgeConfig.plugins.some((plugin) => plugin.name === "auto-unpack-natives"), true);
  assert.equal(forgeConfig.makers.some((maker) => maker.name === "zip"), true);
});

test("removes compiler metadata without deleting the packaged SQLite binding", async (t) => {
  const buildPath = await mkdtemp(join(tmpdir(), "mosa-desktop-package-"));
  t.after(() => rm(buildPath, { recursive: true, force: true }));
  const packageDir = join(buildPath, "node_modules", "better-sqlite3");
  const metadataPath = join(packageDir, "build", "config.gypi");
  const bindingPath = join(packageDir, "prebuilds", "darwin-arm64.node");
  await mkdir(join(packageDir, "build"), { recursive: true });
  await mkdir(join(packageDir, "prebuilds"), { recursive: true });
  await writeFile(metadataPath, "local_prefix=/Users/example/project\n");
  await writeFile(bindingPath, "binding");

  await removeNativeBuildMetadata(buildPath);

  await assert.rejects(access(metadataPath));
  await access(bindingPath);
});

test("keeps the desktop window single-instance and sandboxed", async () => {
  const source = await readFile(resolve(import.meta.dirname, "..", "desktop", "main.mjs"), "utf8");
  assert.match(source, /app\.requestSingleInstanceLock\(\)/);
  assert.match(source, /app\.on\("window-all-closed", \(\) => \{\}\)/);
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

  const appSource = await readFile(resolve(import.meta.dirname, "..", "app", "app.js"), "utf8");
  const index = await readFile(resolve(import.meta.dirname, "..", "app", "index.html"), "utf8");
  assert.doesNotMatch(appSource, /window\.open\(/);
  assert.match(appSource, /openImagePreview\(asset\.id, event\.currentTarget\)/);
  assert.match(index, /<video id="imagePreviewVideo" controls playsinline hidden>/);
});

test("the packaged app includes build-identity.json in app/", () => {
  // build-identity.json must not be ignored by the forge packaging config.
  assert.equal(packageIgnorePatterns.some((pattern) => pattern.test("/app/build-identity.json")), false);
  assert.equal(packageIgnorePatterns.some((pattern) => pattern.test("/app/index.html")), false);
  assert.equal(packageIgnorePatterns.some((pattern) => pattern.test("/app/app.js")), false);
  assert.equal(packageIgnorePatterns.some((pattern) => pattern.test("/app/styles.css")), false);
  assert.equal(packageIgnorePatterns.some((pattern) => pattern.test("/lib/build-identity.mjs")), false);
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
  for (const api of ["openFileDialog", "pasteImage", "getPathForFile", "setLocale", "onMenuImport", "onMenuSearch"]) {
    assert.match(preload, new RegExp(`${api}:`), `preload keeps exposing ${api}`);
  }
  assert.equal(preload.split("ipcRenderer.invoke").length - 1, 5, "no new invoke channel beyond the existing five (batch 1.2 added stage-dropped-file)");
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
  assert.match(handler, /shell\.showItemInFolder\(target\)/, "uses shell.showItemInFolder");
  assert.doesNotMatch(handler, /openExternal/, "never opens local paths through shell.openExternal");
  assert.match(handler, /return \{ ok: true \}/, "success resolves ok");
  assert.match(handler, /catch \{\n\s+return \{ ok: false, reason: "unavailable" \}/, "failures resolve a structured reason instead of throwing");

  // packaged app 的 sandbox preload 使用相对 main.mjs 解析出的绝对 CommonJS 路径。
  assert.match(main, /const preloadPath = fileURLToPath\(new URL\("\.\/preload\.cjs", import\.meta\.url\)\);/);
  assert.match(main, /preload: preloadPath/);
  assert.equal(packageIgnorePatterns.some((pattern) => pattern.test("/desktop/preload.cjs")), false);
});
