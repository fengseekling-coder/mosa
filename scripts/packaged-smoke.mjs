#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { packagedExecutablePath } from "./desktop-runtime-paths.mjs";
import { signalProcessTree } from "./process-tree.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const forgeOutDir = resolve(rootDir, process.env.MOSA_FORGE_OUT_DIR || "out");
const binary = packagedExecutablePath({ rootDir, outDir: forgeOutDir });
const ELECTRON_QA_FLAGS = process.platform === "win32" ? ["--disable-gpu"] : [];

if (!existsSync(binary)) throw new Error(`Missing packaged binary: ${binary}`);

const temp = await mkdtemp(join(tmpdir(), "mosa-smoke-"));
const libraryDir = join(temp, "library");
const userData = join(temp, "user-data");
await mkdir(libraryDir, { recursive: true });
await mkdir(userData, { recursive: true });
const port = await freePort();
const cdpPort = await freePort();

const child = spawn(binary, [...ELECTRON_QA_FLAGS, `--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`], {
  env: {
    ...process.env,
    MOSA_RUNTIME_MODE: "qa",
    MOSA_LIBRARY_DIR: libraryDir,
    MOSA_DESKTOP_PORT: String(port),
    MOSA_USER_DATA: userData,
    MOSA_QA_RUN: "1",
    MOSA_DISABLE_BRIDGES: "cowart,cowartDiscovery,codex,grok",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const stdout = collect(child.stdout);
const stderr = collect(child.stderr);

try {
  const health = await waitForHealth(`http://127.0.0.1:${port}/api/health`, child);
  if (health.product !== "mosa") throw new Error("Unexpected packaged product.");
  if (resolve(health.libraryDir) !== resolve(libraryDir)) throw new Error("Library isolation failed.");
  if (health.storage !== "sqlite") throw new Error(`Expected sqlite, got ${health.storage}`);
  const renderer = await waitForRenderer(`http://127.0.0.1:${port}`, cdpPort, child);
  if (!renderer.appShell) throw new Error("Packaged renderer did not mount the MOSA app shell.");
  if (!renderer.preload) throw new Error("Packaged renderer did not expose the Electron preload API.");
  console.log(JSON.stringify({ ok: true, storage: health.storage, renderer: true, preload: true }));
} catch (error) {
  const details = [stderr().trim(), stdout().trim()].filter(Boolean).join("\n");
  throw new Error(`${error instanceof Error ? error.message : String(error)}${details ? `\n${details}` : ""}`, { cause: error });
} finally {
  await stopChild(child);
  await rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

function freePort() {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForHealth(url, childProcess) {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    if (childProcess.exitCode !== null) throw new Error("Packaged app exited early.");
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("Packaged app health timeout.");
}

async function waitForRenderer(expectedOrigin, cdpPort, childProcess) {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    if (childProcess.exitCode !== null) throw new Error("Packaged app exited before the renderer was ready.");
    let socket = null;
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      if (!response.ok) throw new Error("CDP target list unavailable.");
      const targets = await response.json();
      const target = targets.find((entry) => entry.type === "page" && String(entry.url || "").startsWith(expectedOrigin));
      if (!target?.webSocketDebuggerUrl) throw new Error("MOSA renderer target not ready.");
      socket = await openWebSocket(target.webSocketDebuggerUrl);
      const result = await evaluate(socket, `({
        href: location.href,
        readyState: document.readyState,
        appShell: Boolean(document.querySelector('#appShell')),
        preload: Boolean(window.electronAPI && typeof window.electronAPI.showItemInFolder === 'function')
      })`);
      if (result?.appShell && result?.preload && result.readyState !== "loading") return result;
    } catch {
      // The renderer and CDP endpoint become available a little after the
      // runtime health endpoint. Keep polling until both are genuinely ready.
    } finally {
      socket?.close();
    }
    await sleep(100);
  }
  throw new Error("Packaged renderer readiness timeout.");
}

function openWebSocket(url) {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => resolveSocket(socket), { once: true });
    socket.addEventListener("error", () => rejectSocket(new Error("CDP websocket failed to open.")), { once: true });
  });
}

function evaluate(socket, expression) {
  return new Promise((resolveEvaluation, rejectEvaluation) => {
    const id = 1;
    const onMessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      socket.removeEventListener("message", onMessage);
      if (message.error) {
        rejectEvaluation(new Error(message.error.message || "CDP evaluation failed."));
        return;
      }
      if (message.result?.exceptionDetails) {
        rejectEvaluation(new Error(message.result.exceptionDetails.text || "Renderer evaluation failed."));
        return;
      }
      resolveEvaluation(message.result?.result?.value);
    };
    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
  });
}

async function stopChild(childProcess) {
  if (childProcess.exitCode !== null || childProcess.signalCode) return;
  const exited = onceExit(childProcess);
  await signalProcessTree(childProcess.pid);
  if (await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])) return;
  if (childProcess.exitCode === null && !childProcess.signalCode) {
    await signalProcessTree(childProcess.pid, { force: true });
  }
  await Promise.race([exited, sleep(5000)]);
}

function onceExit(childProcess) {
  return new Promise((resolveExit) => childProcess.once("exit", resolveExit));
}

function collect(stream) {
  let value = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk) => { value += chunk; });
  return () => value;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
