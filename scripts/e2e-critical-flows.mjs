#!/usr/bin/env node

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { importStagingDir } from "../lib/import-staging.mjs";
import { launchDesktopGui } from "./desktop-gui-launcher.mjs";
import { electronExecutablePath } from "./desktop-runtime-paths.mjs";
import { createCriticalUiFlowSource } from "./e2e-ui-flow.mjs";
import { signalProcessTree } from "./process-tree.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const electronBinary = electronExecutablePath({ rootDir });
const webDriver = join(rootDir, "scripts", "e2e-web-driver.mjs");
const DISABLED_BRIDGES = "cowart,cowartDiscovery,codex,grok";
const ELECTRON_QA_FLAGS = process.platform === "win32" ? ["--disable-gpu"] : [];

if (!existsSync(electronBinary)) throw new Error(`Electron binary not found: ${electronBinary}`);

const root = await mkdtemp(join(tmpdir(), "mosa-critical-e2e-"));
const libraryDir = join(root, "library");
const generatedDir = join(root, "generated-images");
const webUserData = join(root, "web-user-data");
const desktopUserData = join(root, "desktop-user-data");
const webFixturePath = join(generatedDir, "critical-flow.png");
const desktopStagingRoot = importStagingDir(desktopUserData);
const desktopFixturePath = join(desktopStagingRoot, "critical-flow.png");
const stamp = Date.now().toString(36);
const webSearchTerm = `MOSA E2E WEB ${stamp}`;
const webVersionChange = `web-version-${stamp}`;
const desktopSearchTerm = `MOSA E2E ELECTRON ${stamp}`;
const desktopVersionChange = `electron-version-${stamp}`;

await Promise.all([
  mkdir(libraryDir, { recursive: true }),
  mkdir(generatedDir, { recursive: true }),
  mkdir(webUserData, { recursive: true }),
  mkdir(desktopUserData, { recursive: true }),
  mkdir(desktopStagingRoot, { recursive: true }),
]);
await Promise.all([
  sharp({ create: { width: 32, height: 24, channels: 4, background: { r: 33, g: 77, b: 121, alpha: 1 } } }).png().toFile(webFixturePath),
  sharp({ create: { width: 32, height: 24, channels: 4, background: { r: 67, g: 102, b: 138, alpha: 1 } } }).png().toFile(desktopFixturePath),
]);

try {
  console.log("[e2e] Web renderer: import -> search -> detail -> favorite -> version");
  await runWebRound("exercise", webSearchTerm, webVersionChange);
  console.log("[e2e] Web renderer: restart -> persistence verification");
  await runWebRound("verify", webSearchTerm, webVersionChange);

  console.log("[e2e] Electron renderer: import -> search -> detail -> favorite -> version");
  await runElectronRound("exercise", desktopSearchTerm, desktopVersionChange);
  console.log("[e2e] Electron renderer: restart -> persistence verification");
  await runElectronRound("verify", desktopSearchTerm, desktopVersionChange);

  console.log(JSON.stringify({ ok: true, storage: "sqlite", flows: ["web", "electron"], restartVerified: true }));
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

async function runWebRound(mode, searchTerm, versionChange) {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: rootDir,
    env: qaEnvironment({
      portVariable: "MOSA_PORT",
      port,
      userData: webUserData,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = collect(child.stderr);
  try {
    const health = await waitForHealth(`http://127.0.0.1:${port}/api/health`, child);
    assertHealth(health);
    await runCommand(electronBinary, [...ELECTRON_QA_FLAGS, webDriver], {
      cwd: rootDir,
      env: {
        ...process.env,
        MOSA_E2E_WEB_TARGET_URL: `http://127.0.0.1:${port}`,
        MOSA_E2E_WEB_USER_DATA: webUserData,
        MOSA_E2E_WEB_MODE: mode,
        MOSA_E2E_WEB_FIXTURE: webFixturePath,
        MOSA_E2E_WEB_SEARCH: searchTerm,
        MOSA_E2E_WEB_VERSION: versionChange,
      },
    });
  } catch (error) {
    const detail = stderr().trim();
    throw new Error(`Web E2E ${mode} failed${detail ? `\n${detail}` : ""}`, { cause: error });
  } finally {
    await stopProcess(child);
  }
}

async function runElectronRound(mode, searchTerm, versionChange) {
  const servicePort = await freePort();
  const cdpPort = await freePort();
  const runDir = join(root, `desktop-${mode}-${servicePort}`);
  await mkdir(runDir, { recursive: true });
  const pidFile = join(runDir, "pid.txt");
  const logFile = join(runDir, "main.log");
  const healthFile = join(runDir, "health.json");
  const env = qaEnvironment({
    portVariable: "MOSA_DESKTOP_PORT",
    port: servicePort,
    userData: desktopUserData,
  });
  const launched = await launchDesktopGui({
    platform: process.platform,
    rootDir: runDir,
    executable: electronBinary,
    args: [...ELECTRON_QA_FLAGS, "desktop/main.mjs", `--user-data-dir=${desktopUserData}`, `--remote-debugging-port=${cdpPort}`],
    env,
    cwd: rootDir,
    pidFile,
    logFile,
    healthUrl: `http://127.0.0.1:${servicePort}/api/health`,
    healthFile,
  });
  const waiter = launched.waiter;
  let pid = null;
  try {
    pid = launched.pid || await waitForPid(pidFile);
    const health = await waitForHealthFile(healthFile);
    assertHealth(health);
    const cdp = await connectCdp(cdpPort, `http://127.0.0.1:${servicePort}`);
    try {
      const result = await cdp.evaluate(createCriticalUiFlowSource({ mode, fixturePath: desktopFixturePath, searchTerm, versionChange }));
      if (!result?.favorite || result.versionCount < 2) {
        throw new Error(`Unexpected Electron UI result: ${JSON.stringify(result)}`);
      }
    } finally {
      cdp.close();
    }
  } catch (error) {
    const log = await readFile(logFile, "utf8").catch(() => "");
    throw new Error(`Electron E2E ${mode} failed${log ? `\n${log}` : ""}`, { cause: error });
  } finally {
    if (pid) await stopPid(pid);
    if (waiter.exitCode === null) waiter.kill("SIGTERM");
  }
}

function qaEnvironment({ portVariable, port, userData }) {
  return {
    ...process.env,
    MOSA_RUNTIME_MODE: "qa",
    MOSA_QA_RUN: "1",
    MOSA_LIBRARY_DIR: libraryDir,
    MOSA_USER_DATA: userData,
    MOSA_DISABLE_BRIDGES: DISABLED_BRIDGES,
    MOSA_PROJECT_DIR: root,
    CODEX_GENERATED_IMAGES_DIR: generatedDir,
    CODEX_SESSIONS_DIR: join(root, "codex-sessions"),
    GROK_SESSIONS_DIR: join(root, "grok-sessions"),
    COWART_MOSA_CANVAS_DIR: join(root, "cowart-data"),
    MOSA_COWART_REGISTRY_PATH: join(root, "cowart-projects.json"),
    [portVariable]: String(port),
  };
}

function assertHealth(health) {
  if (health?.product !== "mosa") throw new Error("E2E runtime is not MOSA.");
  if (resolve(health.libraryDir) !== resolve(libraryDir)) throw new Error("E2E library isolation failed.");
  if (health.storage !== "sqlite") throw new Error(`E2E expected SQLite storage, got ${health.storage}`);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForHealth(url, child, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Runtime exited early with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await sleep(100);
  }
  throw new Error(`Health timeout: ${url}`);
}

async function waitForHealthFile(filePath, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(filePath, "utf8")); } catch {}
    await sleep(100);
  }
  throw new Error(`Health file timeout: ${filePath}`);
}

async function waitForPid(filePath, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(await readFile(filePath, "utf8"), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {}
    await sleep(100);
  }
  throw new Error(`PID timeout: ${filePath}`);
}

async function connectCdp(port, expectedUrlPrefix, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let target = null;
  while (Date.now() < deadline && !target) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        target = targets.find((entry) => entry.type === "page" && String(entry.url || "").startsWith(expectedUrlPrefix));
      }
    } catch {}
    if (!target) await sleep(100);
  }
  if (!target?.webSocketDebuggerUrl) throw new Error(`No Electron CDP target found on ${port}`);
  return openCdpSession(target.webSocketDebuggerUrl);
}

async function openCdpSession(url) {
  const socket = new WebSocket(url);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP websocket failed to open")), { once: true });
  });

  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message || "CDP command failed"));
    else request.resolve(message.result);
  });

  function command(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolveCommand, rejectCommand) => {
      pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  await command("Runtime.enable");
  return {
    async evaluate(expression) {
      const response = await command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      });
      if (response.exceptionDetails) {
        const description = response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Renderer evaluation failed";
        throw new Error(description);
      }
      return response.result?.value;
    },
    close() {
      socket.close();
    },
  };
}

function collect(stream) {
  let text = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk) => { text += chunk; });
  return () => text;
}

async function runCommand(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const code = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", resolveExit);
  });
  if (code !== 0) throw new Error(`${command} exited with ${code}\n${stderr()}\n${stdout()}`);
  const output = stdout().trim();
  if (output) console.log(`[e2e] renderer ${output.split("\n").at(-1)}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  await signalProcessTree(child.pid);
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    sleep(5000).then(async () => {
      if (child.exitCode === null) await signalProcessTree(child.pid, { force: true });
    }),
  ]);
}

async function stopPid(pid) {
  if (!(await signalProcessTree(pid))) return;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await sleep(100);
  }
  await signalProcessTree(pid, { force: true }).catch(() => {});
}

function sleep(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}
