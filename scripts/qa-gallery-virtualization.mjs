import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

const root = resolve(import.meta.dirname, "..");
const ASSET_COUNT = Number.parseInt(process.env.MOSA_GALLERY_QA_ASSET_COUNT || "2000", 10);
const MAX_HYDRATED_CARDS = Number.parseInt(process.env.MOSA_GALLERY_QA_MAX_HYDRATED || "320", 10);
const MAX_DOM_NODES = Number.parseInt(process.env.MOSA_GALLERY_QA_MAX_DOM_NODES || "9000", 10);
const MAX_LONG_TASK_MS = Number.parseInt(process.env.MOSA_GALLERY_QA_MAX_LONG_TASK_MS || "500", 10);
const MAX_LONG_TASK_TOTAL_MS = Number.parseInt(process.env.MOSA_GALLERY_QA_MAX_LONG_TASK_TOTAL_MS || "4000", 10);
const SKIP_BOTTOM_CHECK = process.env.MOSA_GALLERY_QA_SKIP_BOTTOM === "1";

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
  assert.ok(port > 0);
  return port;
}

function electronExecutable() {
  if (process.platform === "darwin") return resolve(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  if (process.platform === "win32") return resolve(root, "node_modules/electron/dist/electron.exe");
  return resolve(root, "node_modules/electron/dist/electron");
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
  throw new Error(`Electron page target was not ready.\n${getOutput()}`);
}

async function createCdpClient(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", rejectOpen, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve: resolvePending, reject: rejectPending } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) rejectPending(new Error(JSON.stringify(message.error)));
    else resolvePending(message.result);
  });
  return {
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolvePending, rejectPending) => {
        pending.set(id, { resolve: resolvePending, reject: rejectPending });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Renderer evaluation failed");
  return result?.result?.value;
}

async function main() {
  const libraryDir = await mkdtemp(join(tmpdir(), "mosa-gallery-qa-library-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "mosa-gallery-qa-user-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "mosa-gallery-qa-project-"));
  let child = null;
  let client = null;
  try {
    const sourceDir = join(projectRoot, "generated-images");
    await mkdir(sourceDir, { recursive: true });
    const sourcePath = join(sourceDir, "pixel.png");
    await writeFile(sourcePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    const store = createSqliteAssetStore({
      projectRoot,
      managerDir: join(projectRoot, "mosa"),
      libraryDir,
      initializeFreshLibrary: true,
    });
    try {
      for (let start = 0; start < ASSET_COUNT; start += 50) {
        await Promise.all(Array.from({ length: Math.min(50, ASSET_COUNT - start) }, (_, offset) => {
          const index = start + offset;
          return store.createAsset({
            assetId: `perf-${String(index).padStart(5, "0")}`,
            imagePath: sourcePath,
            prompt: `gallery virtualization fixture ${index}`,
            businessFields: { width: 1024, height: 1024 },
          });
        }));
      }
      const seeded = await store.listAssets({ projectId: "default" });
      assert.equal(seeded.length, ASSET_COUNT, `QA seed wrote ${seeded.length} of ${ASSET_COUNT} assets`);
    } finally {
      store.close();
    }

    const [cdpPort, desktopPort] = await Promise.all([reserveFreePort(), reserveFreePort()]);
    child = spawn(electronExecutable(), [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`, root], {
      cwd: root,
      env: {
        ...process.env,
        MOSA_LIBRARY_DIR: libraryDir,
        MOSA_USER_DATA: userDataDir,
        MOSA_RUNTIME_MODE: "qa",
        MOSA_QA_RUN: "1",
        MOSA_DESKTOP_PORT: String(desktopPort),
        MOSA_DISABLE_BRIDGES: "cowart,cowartDiscovery,codex,grok",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const output = () => `stdout:\n${stdout.slice(-4000)}\nstderr:\n${stderr.slice(-4000)}`;
    const target = await waitForPageTarget(cdpPort, child, output);
    client = await createCdpClient(target.webSocketDebuggerUrl);
    await client.send("Runtime.enable");
    // QA must measure the unfiltered library rather than inheriting any
    // default/remembered facet state attached to the renderer origin.
    if (await evaluate(client, "Boolean(document.querySelector('[data-action=\"empty-clear\"]'))")) {
      await evaluate(client, "document.querySelector('[data-action=\"empty-clear\"]')?.click(); true");
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (Number(await evaluate(client, "document.querySelectorAll('#assetGrid > .asset-card').length")) > 0) break;
      await wait(100);
    }
    await evaluate(client, `window.__mosaLongTasks=[]; window.__mosaLongTaskObserver=new PerformanceObserver((list)=>window.__mosaLongTasks.push(...list.getEntries().map((entry)=>entry.duration))); window.__mosaLongTaskObserver.observe({entryTypes:['longtask']}); true`);

    const startedAt = Date.now();
    for (let page = 0; page < Math.ceil(ASSET_COUNT / 100) + 5; page += 1) {
      const state = JSON.parse(await evaluate(client, `JSON.stringify({cards:document.querySelectorAll('#assetGrid > .asset-card').length,more:Boolean(document.querySelector('[data-action="load-more"]'))})`));
      if (state.cards >= ASSET_COUNT || !state.more) break;
      await evaluate(client, `document.querySelector('[data-action="load-more"]')?.click(); true`);
      const previousCount = state.cards;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const count = Number(await evaluate(client, "document.querySelectorAll('#assetGrid > .asset-card').length"));
        if (count > previousCount) break;
        await wait(50);
      }
    }
    await wait(1200);
    const topMetrics = JSON.parse(await evaluate(client, `JSON.stringify({
      scrollHeight:document.querySelector('#assetGrid').scrollHeight,
      clientHeight:document.querySelector('#assetGrid').clientHeight,
      lastTop:document.querySelector('#assetGrid > .asset-card:last-of-type')?.getBoundingClientRect().top || 0,
      columns:getComputedStyle(document.querySelector('#assetGrid')).gridTemplateColumns,
      firstPlaceholderSpan:document.querySelector('.asset-card-virtual-placeholder')?.style.gridRowEnd || '',
      firstPlaceholderHeight:document.querySelector('.asset-card-virtual-placeholder')?.getBoundingClientRect().height || 0
    })`));
    let bottomMetrics = null;
    if (!SKIP_BOTTOM_CHECK) {
      await evaluate(client, `(()=>{const grid=document.querySelector('#assetGrid');grid.scrollTop=grid.scrollHeight;grid.dispatchEvent(new Event('scroll'));return grid.scrollTop})()`);
      await wait(1200);
      await evaluate(client, `window.__mosaLongTaskObserver?.disconnect(); true`);
      bottomMetrics = JSON.parse(await evaluate(client, `JSON.stringify({
        scrollTop:document.querySelector('#assetGrid').scrollTop,
        scrollHeight:document.querySelector('#assetGrid').scrollHeight,
        hydrated:document.querySelectorAll('#assetGrid > .asset-card:not(.asset-card-virtual-placeholder)').length,
        visibleHydrated:(()=>{const grid=document.querySelector('#assetGrid');const bounds=grid.getBoundingClientRect();return [...grid.querySelectorAll(':scope > .asset-card:not(.asset-card-virtual-placeholder)')].filter((card)=>{const rect=card.getBoundingClientRect();return rect.bottom>bounds.top&&rect.top<bounds.bottom}).length})(),
        visiblePlaceholders:(()=>{const grid=document.querySelector('#assetGrid');const bounds=grid.getBoundingClientRect();return [...grid.querySelectorAll(':scope > .asset-card-virtual-placeholder')].filter((card)=>{const rect=card.getBoundingClientRect();return rect.bottom>bounds.top&&rect.top<bounds.bottom}).length})()
      })`));
    } else {
      await evaluate(client, `window.__mosaLongTaskObserver?.disconnect(); true`);
    }
    const healthSnapshot = JSON.parse(await evaluate(client, `(async()=>{const response=await fetch('/api/health');return JSON.stringify(await response.json())})()`));
    const apiSnapshot = JSON.parse(await evaluate(client, `(async()=>{const response=await fetch('/api/assets?project=default&limit=2');return JSON.stringify(await response.json())})()`));
    const metrics = JSON.parse(await evaluate(client, `JSON.stringify({
      href:location.href,
      cards:document.querySelectorAll('#assetGrid > .asset-card').length,
      hydrated:document.querySelectorAll('#assetGrid > .asset-card:not(.asset-card-virtual-placeholder)').length,
      placeholders:document.querySelectorAll('#assetGrid > .asset-card-virtual-placeholder').length,
      nodes:document.querySelectorAll('*').length,
      gridText:(document.querySelector('#assetGrid')?.textContent||'').slice(0,500),
      gridHtml:(document.querySelector('#assetGrid')?.innerHTML||'').slice(0,1000),
      longTasks:window.__mosaLongTasks.length,
      longTaskTotal:Math.round(window.__mosaLongTasks.reduce((sum,duration)=>sum+duration,0)),
      longTaskMax:Math.round(Math.max(0,...window.__mosaLongTasks)),
      scrollHeight:document.querySelector('#assetGrid').scrollHeight
    })`));
    metrics.apiSnapshot = apiSnapshot;
    metrics.healthSnapshot = healthSnapshot;
    metrics.expectedLibraryDir = libraryDir;
    metrics.topMetrics = topMetrics;
    metrics.bottomMetrics = bottomMetrics;
    console.log(JSON.stringify(metrics, null, 2));
    metrics.elapsedMs = Date.now() - startedAt;

    assert.equal(metrics.cards, ASSET_COUNT, `expected ${ASSET_COUNT} loaded cards: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.hydrated <= MAX_HYDRATED_CARDS, `hydrated cards ${metrics.hydrated} exceeds ${MAX_HYDRATED_CARDS}`);
    assert.ok(metrics.nodes <= MAX_DOM_NODES, `DOM nodes ${metrics.nodes} exceeds ${MAX_DOM_NODES}`);
    assert.ok(metrics.longTaskMax <= MAX_LONG_TASK_MS, `long task max ${metrics.longTaskMax}ms exceeds ${MAX_LONG_TASK_MS}ms`);
    assert.ok(metrics.longTaskTotal <= MAX_LONG_TASK_TOTAL_MS, `long task total ${metrics.longTaskTotal}ms exceeds ${MAX_LONG_TASK_TOTAL_MS}ms`);
    assert.equal(metrics.hydrated + metrics.placeholders, metrics.cards);
    assert.ok(topMetrics.scrollHeight > topMetrics.clientHeight * 2, "large gallery must preserve a real scrollable extent");
    if (bottomMetrics) {
      assert.ok(bottomMetrics.scrollTop > 0, "gallery must be able to scroll away from the first viewport");
      assert.ok(bottomMetrics.visibleHydrated > 0, "the far end of the gallery must render hydrated cards in the viewport");
      assert.equal(bottomMetrics.visiblePlaceholders, 0, "virtual placeholders must never be exposed inside the visible viewport");
    }
  } finally {
    client?.close();
    if (child?.exitCode === null) {
      const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
      child.kill("SIGTERM");
      await Promise.race([exited, wait(2000)]);
      if (child.exitCode === null) {
        const forcedExit = new Promise((resolveExit) => child.once("exit", resolveExit));
        child.kill("SIGKILL");
        await Promise.race([forcedExit, wait(2000)]);
      }
    }
    await Promise.allSettled([
      rm(libraryDir, { recursive: true, force: true }),
      rm(userDataDir, { recursive: true, force: true }),
      rm(projectRoot, { recursive: true, force: true }),
    ]);
  }
}

await main();
