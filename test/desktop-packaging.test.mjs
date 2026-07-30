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
