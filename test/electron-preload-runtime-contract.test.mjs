import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const preloadPath = resolve(root, "desktop", "preload.cjs");
const electronPath = process.platform === "darwin"
  ? resolve(root, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron")
  : process.platform === "win32"
    ? resolve(root, "node_modules", "electron", "dist", "electron.exe")
    : resolve(root, "node_modules", "electron", "dist", "electron");
const EXPECTED_API_KEYS = [
  "changeLibraryLocation",
  "checkForUpdates",
  "onMenuImport",
  "onMenuSearch",
  "openDownloadPage",
  "pasteImage",
  "setLocale",
  "showItemInFolder",
  "writeClipboardImage",
  "writeClipboardText",
];
// Audit Fix Batch 1 (BUG-08) changed only the `test` script to load
// test/clean-test-env.mjs; the lockfile fingerprint stays untouched.
// R1 isolation fix (2026-08-09, approved scope) added qa:web/qa:electron/
// qa:packaged launcher scripts to package.json, so only its dependency
// sections stay hash-pinned (see the dependency assertions below).
const LOCKFILE_SHA256 = "ecf0fdc199de87ccd30ffe6a7da4624c2f632700cd8348194a30b79dd2e2a69f";

const read = (relativePath) => readFile(resolve(root, relativePath), "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sortedApiKeys = (source) => [...source.matchAll(/^  ([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1]).sort();

test("preload path, module format, security settings, and API surface are stable", async () => {
  const [main, preload, packageJson, lockfile] = await Promise.all([
    read("desktop/main.mjs"),
    read("desktop/preload.cjs"),
    read("package.json"),
    read("package-lock.json"),
  ]);

  await access(preloadPath);
  await assert.rejects(access(resolve(root, "desktop", "preload.mjs")), { code: "ENOENT" });
  assert.equal(isAbsolute(preloadPath), true);
  assert.equal(extname(preloadPath), ".cjs");
  assert.match(main, /const preloadPath = fileURLToPath\(new URL\("\.\/preload\.cjs", import\.meta\.url\)\);/);
  assert.match(main, /preload: preloadPath/);
  assert.match(main, /webContents\.once\("preload-error"/);
  assert.match(main, /webContents\.once\("render-process-gone"/);
  assert.match(main, /webContents\.on\("console-message"/);
  assert.match(main, /MAX_RENDERER_CONSOLE_ERRORS = 32/);
  assert.doesNotMatch(main, /process\.cwd\(\)|join\(__dirname/);
  assert.match(preload, /^const \{ contextBridge, ipcRenderer \} = require\("electron"\);/);
  assert.doesNotMatch(preload, /^\s*import\s/m);

  for (const setting of ["contextIsolation: true", "sandbox: true", "nodeIntegration: false"]) {
    assert.match(main, new RegExp(setting.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${setting} remains enabled`);
  }

  assert.doesNotMatch(preload, /require\s*:/, "require is not exposed as an API key");
  assert.doesNotMatch(preload, /ipcRenderer\s*:/, "ipcRenderer is not exposed as an API value");
  assert.doesNotMatch(preload, /^\s*shell\s*:/m, "shell is not exposed as an API value");
  assert.doesNotMatch(preload, /openExternal|sendSync|\.send\(/, "generic IPC is not exposed");
  // The preload exposes only narrow, named request channels. Update actions
  // accept no URL from the renderer; the main process owns the fixed website.
  assert.equal(preload.split("ipcRenderer.invoke").length - 1, 8, "only the eight approved invoke channels remain");
  assert.deepEqual(sortedApiKeys(preload), EXPECTED_API_KEYS);
  assert.match(preload, /writeClipboardImage: \(path\) => ipcRenderer\.invoke\("write-clipboard-image", path\)/);
  assert.match(preload, /writeClipboardText: \(text\) => ipcRenderer\.invoke\("write-clipboard-text", text\)/);
  assert.match(preload, /showItemInFolder: \(path\) => ipcRenderer\.invoke\("show-item-in-folder", path\)/);
  assert.match(preload, /checkForUpdates: \(notify = false\) =>[\s\S]*?ipcRenderer\.invoke\("check-for-updates", notify === true\)/);
  assert.match(preload, /openDownloadPage: \(\) => ipcRenderer\.invoke\("open-download-page"\)/);
  assert.match(preload, /changeLibraryLocation: \(\) => ipcRenderer\.invoke\("change-library-location"\)/);
  assert.doesNotMatch(preload, /openDownloadPage:\s*\([^)]*url/i, "renderer cannot choose an update destination");
  assert.match(main, /MOSA_DOWNLOAD_PAGE_URL/);
  assert.match(main, /ipcMain\.handle\("check-for-updates"/);
  assert.match(main, /ipcMain\.handle\("open-download-page"/);
  assert.match(main, /ipcMain\.handle\("change-library-location"/);
  const relocationHandler = main.slice(main.indexOf('ipcMain.handle("change-library-location"'), main.indexOf('\n\n  // Phase 4C', main.indexOf('ipcMain.handle("change-library-location"')));
  assert.match(relocationHandler, /event\.sender !== mainWindow\.webContents/, "library relocation validates the sender");
  assert.match(relocationHandler, /process\.env\.MOSA_LIBRARY_DIR/, "an explicit environment-managed library cannot be overridden in-app");
  assert.match(relocationHandler, /service\?\.mode !== "owned"/, "attached external runtimes cannot be moved by the desktop shell");
  assert.match(relocationHandler, /readdir\(nextLibraryDir\)/, "the destination must be inspected before copying");
  assert.match(relocationHandler, /entries\.length > 0/, "only an empty destination is accepted");
  assert.match(relocationHandler, /await stopOwnedRuntime\(\)/, "SQLite and the runtime lock are closed before migration");
  assert.match(relocationHandler, /entry\.name === "\.mosa-runtime\.lock"/, "runtime locks are never copied to the new library");
  assert.ok(relocationHandler.indexOf("saveLibraryDir(nextLibraryDir)") > relocationHandler.indexOf("await cp(join(previousLibraryDir, entry.name), join(nextLibraryDir, entry.name)"),
    "the persisted location switches only after the copy succeeds");
  assert.ok(relocationHandler.indexOf("await rm(previousLibraryDir") > relocationHandler.indexOf("saveLibraryDir(nextLibraryDir)"),
    "the original library is removed only after a successful copy and preference switch");
  assert.match(main, /ipcMain\.handle\("write-clipboard-text"/);
  const pasteImageHandler = main.slice(main.indexOf('ipcMain.handle("paste-image"'), main.indexOf("\n  });", main.indexOf('ipcMain.handle("paste-image"')));
  assert.match(pasteImageHandler, /event\.sender !== mainWindow\.webContents/);
  assert.match(main, /event\.sender !== mainWindow\.webContents/);
  assert.match(main, /shell\.openExternal\(MOSA_DOWNLOAD_PAGE_URL\)/);
  assert.match(main, /if \(isolationContext\.qaRun\) return Promise\.resolve\(\{ status: "disabled", currentVersion \}\)/,
    "QA/E2E update checks must stay offline and deterministic");

  const finderHandler = main.slice(main.indexOf('ipcMain.handle("show-item-in-folder"'), main.indexOf("\n  });", main.indexOf('ipcMain.handle("show-item-in-folder"')));
  assert.match(finderHandler, /event\.sender !== mainWindow\.webContents/);
  assert.match(finderHandler, /!isAbsolute\(target\)/);
  assert.match(finderHandler, /!existsSync\(target\)/);
  assert.match(finderHandler, /resolveAllowedFolderPath\(target, \[libraryDir\]\)/);
  assert.match(finderHandler, /shell\.showItemInFolder\(allowedTarget\)/);
  assert.match(finderHandler, /reason: "not-allowed"/);
  assert.doesNotMatch(finderHandler, /openExternal/);

  const clipboardHandler = main.slice(main.indexOf('ipcMain.handle("write-clipboard-text"'), main.indexOf("\n  });", main.indexOf('ipcMain.handle("write-clipboard-text"')));
  assert.match(clipboardHandler, /event\.sender !== mainWindow\.webContents/);
  assert.match(clipboardHandler, /typeof text !== "string"/);
  assert.match(clipboardHandler, /text\.length > MAX_CLIPBOARD_TEXT_LENGTH/);
  assert.match(clipboardHandler, /clipboard\.writeText\(text\)/);

  const clipboardImageHandler = main.slice(main.indexOf('ipcMain.handle("write-clipboard-image"'), main.indexOf("\n  });", main.indexOf('ipcMain.handle("write-clipboard-image"')));
  assert.match(clipboardImageHandler, /event\.sender !== mainWindow\.webContents/);
  assert.match(clipboardImageHandler, /!isAbsolute\(target\)/);
  assert.match(clipboardImageHandler, /resolveAllowedFolderPath\(target, \[libraryDir\]\)/);
  assert.match(clipboardImageHandler, /nativeImage\.createFromPath\(allowedTarget\)/);
  assert.match(clipboardImageHandler, /clipboard\.writeImage\(image\)/);

  assert.match(main, /minWidth: 960,/);
  assert.match(main, /minHeight: 640,/);
  const manifest = JSON.parse(packageJson);
  assert.equal(sha256(JSON.stringify(manifest.dependencies)), "73c83773a57e21a20917d81b24288bdfddd9bb7ddd644fdaedd6e6cfba13c405", "package.json dependencies were not changed by this phase");
  assert.equal(sha256(JSON.stringify(manifest.devDependencies)), "11f67ce00f34b4d3dfb9b9ed0dfb428b0368ad5e0a17bd3bafaa40e3c2124fac", "package.json devDependencies were not changed by this phase");
  assert.equal(sha256(lockfile), LOCKFILE_SHA256, "package-lock.json was not changed by this phase");
  assert.doesNotMatch(packageJson, /electron-preload-runtime-contract/);
});

test("packaged preload is present and Forge does not ignore it", async () => {
  const [forge, main] = await Promise.all([read("desktop/forge.config.mjs"), read("desktop/main.mjs")]);
  assert.match(main, /preload\.cjs/);
  assert.doesNotMatch(forge, /preload\.cjs/);
  assert.doesNotMatch(forge, /desktop\/preload/);
});

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function reserveFreePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  assert.ok(port > 0, "a nonzero loopback port is required for runtime isolation");
  return port;
}

async function waitForPort(port, child, getOutput, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    const connected = await new Promise((resolvePromise) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolvePromise(true); });
      socket.once("error", () => { socket.destroy(); resolvePromise(false); });
    });
    if (connected) return;
    await wait(100);
  }
  throw new Error(`Electron did not expose CDP before exit=${child.exitCode}\n${getOutput()}`);
}

async function waitForPageTarget(port, child, getOutput) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await wait(100);
  }
  throw new Error(`Electron page target was not ready before exit=${child.exitCode}\n${getOutput()}`);
}

async function createCdpClient(webSocketDebuggerUrl) {
  const WebSocketCtor = globalThis.WebSocket;
  assert.equal(typeof WebSocketCtor, "function", "Node must provide WebSocket for the real CDP smoke test");
  const socket = new WebSocketCtor(webSocketDebuggerUrl);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 0;
  await new Promise((resolvePromise, reject) => {
    socket.addEventListener("open", resolvePromise, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve: resolvePromise, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolvePromise(message.result);
      return;
    }
    for (const listener of listeners.get(message.method) || []) listener(message.params || {});
  });
  return {
    on(method, listener) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(listener);
    },
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolvePromise, reject) => {
        pending.set(id, { resolve: resolvePromise, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      for (const { reject } of pending.values()) reject(new Error("CDP closed"));
      pending.clear();
      socket.close();
    },
  };
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result?.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Renderer evaluation failed";
    throw new Error(description);
  }
  return result?.result?.value;
}

async function waitForRendererValue(client, expression, predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await evaluate(client, expression);
    if (predicate(value)) return value;
    await wait(100);
  }
  return evaluate(client, expression);
}

function isKnownCdpSandboxStartupNoise(issue) {
  const text = JSON.stringify(issue);
  return text.includes("node:electron/js2c/sandbox_bundle")
    && text.includes("binding.startupData")
    && text.includes("preloadScripts");
}

test("real Electron preload smoke (opt-in)", { skip: process.env.MOSA_ELECTRON_PRELOAD_SMOKE !== "1" }, async (t) => {
  const libraryDir = await mkdtemp(join(tmpdir(), "mosa-preload-smoke-library-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "mosa-preload-smoke-user-data-"));
  const assetsDir = join(libraryDir, "assets");
  await mkdir(assetsDir, { recursive: true });
  const fixturePath = join(assetsDir, "preload-smoke.png");
  await writeFile(fixturePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));

  const [cdpPort, desktopPort] = await Promise.all([reserveFreePort(), reserveFreePort()]);
  const child = spawn(electronPath, [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`, root], {
    cwd: root,
    env: {
      ...process.env,
      MOSA_LIBRARY_DIR: libraryDir,
      MOSA_USER_DATA: userDataDir,
      MOSA_RUNTIME_MODE: "qa",
      MOSA_QA_RUN: "1",
      MOSA_DESKTOP_PORT: String(desktopPort),
      MOSA_DISABLE_BRIDGES: "cowart,cowartDiscovery,codex,grok",
      ELECTRON_ENABLE_LOGGING: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
      child.kill("SIGTERM");
      await Promise.race([exited, wait(2000)]);
      if (child.exitCode === null) {
        const forcedExit = new Promise((resolveExit) => child.once("exit", resolveExit));
        child.kill("SIGKILL");
        await Promise.race([forcedExit, wait(2000)]);
      }
    }
    await rm(libraryDir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  });

  const output = () => `stdout:\n${stdout.slice(-4000)}\nstderr:\n${stderr.slice(-4000)}`;
  await waitForPort(cdpPort, child, output);
  const target = await waitForPageTarget(cdpPort, child, output);
  const client = await createCdpClient(target.webSocketDebuggerUrl);
  t.after(() => client.close());
  const rendererIssues = [];
  client.on("Runtime.consoleAPICalled", (params) => {
    if (["error", "assert"].includes(params.type)) rendererIssues.push(params);
  });
  client.on("Runtime.exceptionThrown", (params) => rendererIssues.push(params));
  await client.send("Runtime.enable");
  await wait(500);

  const state = JSON.parse(await evaluate(client, `JSON.stringify({
    href: location.href,
    hasElectronAPI: Boolean(window.electronAPI),
    keys: window.electronAPI ? Object.keys(window.electronAPI).sort() : [],
    functionKeys: window.electronAPI ? Object.keys(window.electronAPI).filter((key) => typeof window.electronAPI[key] === "function").sort() : [],
    finderButtons: document.querySelectorAll('[data-action="show-in-finder"]').length,
    webLinks: document.querySelectorAll('a.original-media-link').length,
  })`));
  assert.match(state.href, /^http:\/\/127\.0\.0\.1:/, "the real app URL finished loading");
  assert.equal(state.hasElectronAPI, true);
  assert.deepEqual(state.keys, EXPECTED_API_KEYS);
  assert.deepEqual(state.functionKeys, EXPECTED_API_KEYS);
  assert.deepEqual(state.keys, EXPECTED_API_KEYS);
  assert.equal((stderr.match(/\[MOSA\] preload-error/g) || []).length, 0, output());
  assert.doesNotMatch(stderr, /preload.*(error|failed|syntaxerror|ENOENT)/i, output());
  const preloadIssues = rendererIssues.filter((issue) => /preload/i.test(JSON.stringify(issue)) && !isKnownCdpSandboxStartupNoise(issue));
  assert.equal(preloadIssues.length, 0, JSON.stringify(rendererIssues));

  const origin = new URL(state.href).origin;
  const createResponse = await fetch(`${origin}/api/assets/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "default", imagePath: fixturePath, prompt: "preload smoke fixture" }),
  });
  assert.equal(createResponse.status, 200, await createResponse.text());
  const cardReady = await waitForRendererValue(client, `document.querySelectorAll('.asset-card-select').length`, (value) => Number(value) > 0);
  assert.equal(Number(cardReady) > 0, true, "the created asset arrives through the live library refresh path");
  await evaluate(client, `document.querySelector('.asset-card-select')?.click(); true`);
  const actionState = JSON.parse(await waitForRendererValue(client, `JSON.stringify({
    finderButtons: document.querySelectorAll('[data-action="show-in-finder"]').length,
    webLinks: document.querySelectorAll('a.original-media-link').length,
  })`, (value) => {
    try { return JSON.parse(value).finderButtons > 0; } catch { return false; }
  }));
  // The fixture is on the library's trusted temporary root; the real page must
  // choose the desktop branch once the real bridge has initialized.
  assert.equal(actionState.webLinks, 0);
  assert.equal(actionState.finderButtons > 0, true);
  // The contract test above validates every narrow IPC handler and sender/path
  // guard. This real smoke intentionally stops at preload injection + renderer
  // capability selection so CI never invokes Finder or mutates the host
  // clipboard as a side effect of a test run.
});
