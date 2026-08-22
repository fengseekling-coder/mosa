import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  getNotificationText,
  getNotificationTextForAssetsImported,
} from "../desktop/notification-i18n.mjs";

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);

test("getNotificationText returns Chinese text for zh locale", () => {
  assert.equal(getNotificationText("assetsImported", "zh"), "{count} 个新素材已导入");
  assert.equal(getNotificationText("updateAvailable", "zh"), "有新版本可用，正在下载…");
  assert.equal(getNotificationText("updateDownloaded", "zh"), "新版本已下载，重启后将自动安装。");
});

test("getNotificationText returns English text for en locale", () => {
  assert.equal(getNotificationText("assetsImported", "en"), "{count} new assets imported");
  assert.equal(getNotificationText("updateAvailable", "en"), "A new version is available, downloading…");
  assert.equal(getNotificationText("updateDownloaded", "en"), "New version downloaded. It will be installed on restart.");
});

test("getNotificationText falls back to zh for unknown locale", () => {
  // Unknown locale uses the safe Chinese default (matches original behaviour).
  assert.equal(getNotificationText("updateAvailable", "ja"), "有新版本可用，正在下载…");
  assert.equal(getNotificationText("updateDownloaded", "fr"), "新版本已下载，重启后将自动安装。");
  assert.equal(getNotificationText("assetsImported", "de"), "{count} 个新素材已导入");
});

test("getNotificationText rejects unknown keys", () => {
  assert.throws(() => getNotificationText("nonexistent", "zh"), /Unsupported notification key/);
});

test("getNotificationTextForAssetsImported formats the count placeholder", () => {
  assert.equal(getNotificationTextForAssetsImported(1, "zh"), "1 个新素材已导入");
  assert.equal(getNotificationTextForAssetsImported(5, "zh"), "5 个新素材已导入");
  assert.equal(getNotificationTextForAssetsImported(1, "en"), "1 new asset imported");
  assert.equal(getNotificationTextForAssetsImported(12, "en"), "12 new assets imported");
});

test("getNotificationTextForAssetsImported falls back to zh for unknown locale", () => {
  assert.equal(getNotificationTextForAssetsImported(3, "es"), "3 个新素材已导入");
});

test("main.mjs imports the i18n module and tracks currentLocale", async () => {
  const source = await readFile(resolve(repositoryRoot, "desktop/main.mjs"), "utf8");
  assert.match(source, /import \{ getNotificationText,\s*getNotificationTextForAssetsImported \} from "\.\/notification-i18n\.mjs"/);
  assert.match(source, /let currentLocale\s*=\s*"zh"/);
  // Bridge poll uses the i18n helper instead of a hardcoded string.
  assert.match(source, /getNotificationTextForAssetsImported\(delta,\s*currentLocale\)/);
  // Update notifications use getNotificationText instead of hardcoded text.
  assert.match(source, /getNotificationText\("updateAvailable",\s*currentLocale\)/);
  assert.match(source, /getNotificationText\("updateDownloaded",\s*currentLocale\)/);
  // No remaining hardcoded Chinese notification bodies.
  assert.doesNotMatch(source, /body:\s*"有新版本可用/);
  assert.doesNotMatch(source, /body:\s*"新版本已下载/);
  assert.doesNotMatch(source, /`?\$\{delta\} 个新素材已导入`?/);
});

test("set-locale IPC validates sender and locale values", async () => {
  const source = await readFile(resolve(repositoryRoot, "desktop/main.mjs"), "utf8");
  assert.match(source, /ipcMain\.handle\("set-locale"/);
  assert.match(source, /async \(event,\s*locale\)/);
  // Sender must be the main window's webContents.
  assert.match(source, /event\.sender\s*!==\s*mainWindow\.webContents/);
  // Only zh/en accepted; anything else is rejected.
  assert.match(source, /locale\s*!==\s*"zh"\s*&&\s*locale\s*!==\s*"en"/);
  assert.match(source, /currentLocale\s*=\s*locale/);
});

test("preload exposes setLocale and no longer exposes openFolder", async () => {
  const preload = await readFile(resolve(repositoryRoot, "desktop/preload.cjs"), "utf8");
  assert.match(preload, /setLocale:\s*\(locale\)\s*=>\s*ipcRenderer\.invoke\("set-locale"/);
  assert.doesNotMatch(preload, /openFolder/);
  assert.doesNotMatch(preload, /open-folder/);
});

test("main.mjs no longer registers an open-folder IPC handler", async () => {
  const source = await readFile(resolve(repositoryRoot, "desktop/main.mjs"), "utf8");
  assert.doesNotMatch(source, /ipcMain\.handle\("open-folder"/);
  assert.doesNotMatch(source, /shell\.openPath/);
  // The renderer's /api/open-folder HTTP route (validated server-side) is the
  // only remaining folder-opening path; the desktop IPC shortcut is gone.
  const appSource = await readFile(resolve(repositoryRoot, "app/app.mjs"), "utf8");
  assert.doesNotMatch(appSource, /electronAPI\?\.openFolder|electronAPI\.openFolder/);
});

test("app.mjs syncs the resolved locale to the main process", async () => {
  const appSource = await readFile(resolve(repositoryRoot, "app/app.mjs"), "utf8");
  assert.match(appSource, /window\.electronAPI\?\.setLocale\?\.\(state\.locale\)/);
});
