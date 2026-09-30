#!/usr/bin/env electron

import { app, BrowserWindow } from "electron";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCriticalUiFlowSource, createStackUiFlowSource, createTrashUiFlowSource, E2E_DROP_GROUP_NAME } from "./e2e-ui-flow.mjs";

const cliArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const [cliTargetUrl, cliUserDataDir, cliMode, cliSearchTerm, cliRecipeChange] = cliArgs;
const targetUrl = process.env.MOSA_E2E_WEB_TARGET_URL || cliTargetUrl;
const userDataDir = process.env.MOSA_E2E_WEB_USER_DATA || cliUserDataDir;
const mode = process.env.MOSA_E2E_WEB_MODE || cliMode;
const searchTerm = process.env.MOSA_E2E_WEB_SEARCH || cliSearchTerm;
const recipeChange = process.env.MOSA_E2E_WEB_RECIPE_CHANGE || cliRecipeChange;
const dropGroupName = process.env.MOSA_E2E_WEB_GROUP || E2E_DROP_GROUP_NAME;
const pasteEnabled = (process.env.MOSA_E2E_WEB_PASTE ?? "1") !== "0";
const trashConfigSource = process.env.MOSA_E2E_WEB_TRASH_CONFIG || "";
// Pluggable flows (scripts/e2e-flows) hand over a ready-made source file.
const sourceFile = process.env.MOSA_E2E_WEB_SOURCE_FILE || "";
const flow = sourceFile ? "source" : (process.env.MOSA_E2E_WEB_FLOW || "critical");
if (!targetUrl || !userDataDir) {
  console.error("usage: electron scripts/e2e-web-driver.mjs <url> <userDataDir> [mode] [searchTerm] [recipeChange]");
  process.exit(2);
}
if (flow === "critical" && (!mode || !searchTerm || !recipeChange)) {
  console.error("usage (critical): MOSA_E2E_WEB_MODE / MOSA_E2E_WEB_SEARCH / MOSA_E2E_WEB_RECIPE_CHANGE are required");
  process.exit(2);
}
if (flow === "trash" && !trashConfigSource) {
  console.error("usage (trash): MOSA_E2E_WEB_TRASH_CONFIG (JSON) is required");
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
    let source;
    if (flow === "source") source = readFileSync(sourceFile, "utf8");
    else if (flow === "stack") source = createStackUiFlowSource();
    else if (flow === "trash") source = createTrashUiFlowSource(JSON.parse(trashConfigSource));
    else source = createCriticalUiFlowSource({ mode, searchTerm, recipeChange, dropGroupName, pasteEnabled });
    const result = await win.webContents.executeJavaScript(source, true);
    console.log(JSON.stringify(result));
  } finally {
    win.destroy();
  }
  app.quit();
}).catch((error) => {
  console.error(error?.stack || error);
  app.exit(1);
});
