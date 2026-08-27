import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const preloadPath = resolve(root, "desktop", "preload.cjs");
const electronPath = resolve(root, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
const EXPECTED_API_KEYS = [
  "getPathForFile",
  "onMenuImport",
  "onMenuSearch",
  "openFileDialog",
  "pasteImage",
  "setLocale",
  "showItemInFolder",
];
const EXPECTED_API_FINGERPRINT = "d074335886412fcbee37e74b1ec6b50bd3e75c3f14d86a1247e4c44e8ea00659";
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
  assert.match(preload, /^const \{ contextBridge, ipcRenderer, webUtils \} = require\("electron"\);/);
  assert.doesNotMatch(preload, /^\s*import\s/m);

  for (const setting of ["contextIsolation: true", "sandbox: true", "nodeIntegration: false"]) {
    assert.match(main, new RegExp(setting.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${setting} remains enabled`);
  }

  assert.doesNotMatch(preload, /require\s*:/, "require is not exposed as an API key");
  assert.doesNotMatch(preload, /ipcRenderer\s*:/, "ipcRenderer is not exposed as an API value");
  assert.doesNotMatch(preload, /^\s*shell\s*:/m, "shell is not exposed as an API value");
  assert.doesNotMatch(preload, /openExternal|sendSync|\.send\(/, "generic IPC is not exposed");
  // The preload exposes five narrow request channels for import, locale,
  // Finder, and drag/drop staging. Generic IPC remains unavailable.
  assert.equal(preload.split("ipcRenderer.invoke").length - 1, 5, "only the five approved invoke channels remain");
  assert.deepEqual(sortedApiKeys(preload), EXPECTED_API_KEYS);
  assert.equal(sha256(JSON.stringify(sortedApiKeys(preload))), EXPECTED_API_FINGERPRINT);
  assert.match(preload, /showItemInFolder: \(path\) => ipcRenderer\.invoke\("show-item-in-folder", path\)/);

  const finderHandler = main.slice(main.indexOf('ipcMain.handle("show-item-in-folder"'), main.indexOf("\n  });", main.indexOf('ipcMain.handle("show-item-in-folder"')));
  assert.match(finderHandler, /event\.sender !== mainWindow\.webContents/);
  assert.match(finderHandler, /!isAbsolute\(target\)/);
  assert.match(finderHandler, /!existsSync\(target\)/);
  assert.match(finderHandler, /resolveAllowedFolderPath\(target, \[libraryDir\]\)/);
  assert.match(finderHandler, /shell\.showItemInFolder\(allowedTarget\)/);
  assert.match(finderHandler, /reason: "not-allowed"/);
  assert.doesNotMatch(finderHandler, /openExternal/);

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

test("real Electron preload smoke (opt-in)", { skip: process.env.MOSA_ELECTRON_PRELOAD_SMOKE !== "1" }, async (t) => {
  const libraryDir = await mkdtemp(join(tmpdir(), "mosa-preload-smoke-library-"));
  const assetsDir = join(libraryDir, "assets");
  await mkdir(assetsDir, { recursive: true });
  const fixturePath = join(assetsDir, "preload-smoke.png");
  await writeFile(fixturePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));

  const cdpPort = 43681;
  const child = spawn(electronPath, [`--remote-debugging-port=${cdpPort}`, root], {
    cwd: root,
    env: {
      ...process.env,
      MOSA_LIBRARY_DIR: libraryDir,
      MOSA_DESKTOP_PORT: "0",
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
    if (child.exitCode === null) child.kill("SIGTERM");
    await rm(libraryDir, { recursive: true, force: true });
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
  assert.equal(sha256(JSON.stringify(state.keys)), EXPECTED_API_FINGERPRINT);
  assert.equal((stderr.match(/\[MOSA\] preload-error/g) || []).length, 0, output());
  assert.doesNotMatch(stderr, /preload.*(error|failed|syntaxerror|ENOENT)/i, output());
  assert.equal(rendererIssues.filter((issue) => JSON.stringify(issue).match(/preload/i)).length, 0, JSON.stringify(rendererIssues));

  const origin = new URL(state.href).origin;
  const createResponse = await fetch(`${origin}/api/assets/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "default", imagePath: fixturePath, prompt: "preload smoke fixture" }),
  });
  assert.equal(createResponse.status, 200, await createResponse.text());
  await client.send("Page.reload", { ignoreCache: true });
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
  const finderResult = JSON.parse(await evaluate(client, `JSON.stringify(await window.electronAPI.showItemInFolder(${JSON.stringify(fixturePath)}))`));
  assert.deepEqual(finderResult, { ok: true });
});
