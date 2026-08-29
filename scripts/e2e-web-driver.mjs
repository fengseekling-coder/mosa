#!/usr/bin/env electron

import { app, BrowserWindow } from "electron";
import { resolve } from "node:path";
import { createCriticalUiFlowSource } from "./e2e-ui-flow.mjs";

const cliArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const [cliTargetUrl, cliUserDataDir, cliMode, cliFixturePath, cliSearchTerm, cliRecipeChange] = cliArgs;
const targetUrl = process.env.MOSA_E2E_WEB_TARGET_URL || cliTargetUrl;
const userDataDir = process.env.MOSA_E2E_WEB_USER_DATA || cliUserDataDir;
const mode = process.env.MOSA_E2E_WEB_MODE || cliMode;
const fixturePath = process.env.MOSA_E2E_WEB_FIXTURE || cliFixturePath;
const searchTerm = process.env.MOSA_E2E_WEB_SEARCH || cliSearchTerm;
const recipeChange = process.env.MOSA_E2E_WEB_RECIPE_CHANGE || cliRecipeChange;
if (!targetUrl || !userDataDir || !mode || !fixturePath || !searchTerm || !recipeChange) {
  console.error("usage: electron scripts/e2e-web-driver.mjs <url> <userDataDir> <exercise|verify> <fixturePath> <searchTerm> <recipeChange>");
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
      recipeChange,
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
