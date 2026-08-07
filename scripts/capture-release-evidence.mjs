#!/usr/bin/env node

/**
 * Release-hardening evidence capture (verification tooling only).
 *
 * Loads a running MOSA runtime URL into one hidden Electron BrowserWindow at a
 * requested size, optionally performs UI actions, then captures a screenshot.
 * One window per process keeps capture reliable in constrained environments.
 *
 * Usage:
 *   electron scripts/capture-release-evidence.mjs <url> <outputDir> <mode>
 * Modes:
 *   gallery-<W>x<H>            plain gallery home capture
 *   detail-<W>x<H>             open the first asset's detail drawer, then capture
 *   settings-<W>x<H>           open settings -> diagnostics panel, then capture
 */

import { app, BrowserWindow } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Electron keeps CLI flags (e.g. --no-sandbox) inside process.argv, so locate
// arguments by shape instead of fixed positions.
const targetUrl = process.argv.find((arg) => /^https?:\/\//.test(arg));
const mode = process.argv.find((arg) => /^(gallery|detail|settings)-\d+x\d+$/.test(arg));
const outputDir = process.argv
  .filter((arg) => !arg.startsWith("-") && !/\.(mjs|js)$/.test(arg) && !/^https?:/.test(arg) && arg !== mode)
  .pop();

if (!targetUrl || !outputDir || !mode) {
  console.error("usage: electron scripts/capture-release-evidence.mjs <url> <outputDir> <mode>");
  process.exit(1);
}

const [kind, sizeText] = mode.split("-");
const [width, height] = sizeText.split("x").map(Number);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  mkdirSync(outputDir, { recursive: true });
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try {
    await win.loadURL(targetUrl);
    await sleep(1500);

    if (kind === "detail") {
      await win.webContents.executeJavaScript(`document.querySelector(".asset-card-select")?.click(); true`);
      await sleep(1500);
    } else if (kind === "settings") {
      await win.webContents.executeJavaScript(`document.querySelector("#settingsToggle")?.click(); true`);
      await sleep(400);
      await win.webContents.executeJavaScript(`document.querySelector("[data-action='toggle-diagnostics']")?.click(); true`);
      await sleep(1200);
    }

    const image = await win.webContents.capturePage();
    const file = join(outputDir, `electron-${mode}.png`);
    writeFileSync(file, image.toPNG());
    console.log(`captured ${file}`);
  } finally {
    win.destroy();
  }
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
