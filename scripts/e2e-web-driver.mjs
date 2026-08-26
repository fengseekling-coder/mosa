#!/usr/bin/env electron

import { app, BrowserWindow } from "electron";
import { resolve } from "node:path";
import { createCriticalUiFlowSource } from "./e2e-ui-flow.mjs";

const [targetUrl, userDataDir, mode, fixturePath, searchTerm, versionChange] = process.argv.slice(2);
if (!targetUrl || !userDataDir || !mode || !fixturePath || !searchTerm || !versionChange) {
  console.error("usage: electron scripts/e2e-web-driver.mjs <url> <userDataDir> <exercise|verify> <fixturePath> <searchTerm> <versionChange>");
  process.exit(2);
}

app.setPath("userData", resolve(userDataDir));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    await win.loadURL(targetUrl);
    const result = await win.webContents.executeJavaScript(createCriticalUiFlowSource({
      mode,
      fixturePath,
      searchTerm,
      versionChange,
    }), true);
    console.log(JSON.stringify(result));
  } finally {
    win.destroy();
  }
  app.quit();
}).catch((error) => {
  console.error(error?.stack || error);
  app.exit(1);
});
