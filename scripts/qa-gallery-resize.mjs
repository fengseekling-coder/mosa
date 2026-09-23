import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

// Real Chromium layout, real gallery virtualization, isolated synthetic assets.
// MOSA_RESIZE_QA_EXECUTABLE also exercises an installed/packaged application.
const root = resolve(import.meta.dirname, "..");
const scratch = await mkdtemp(join(tmpdir(), "mosa-resize-qa-"));
const libraryDir = join(scratch, "library");
const userData = join(scratch, "user-data");
const executable = process.env.MOSA_RESIZE_QA_EXECUTABLE || resolve(root,
  process.platform === "darwin" ? "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
    : process.platform === "win32" ? "node_modules/electron/dist/electron.exe" : "node_modules/electron/dist/electron");
const result = { status: "running", cases: [] };
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
let child;
let client;
let mainClient;
let output = "";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function seed() {
  const projectRoot = join(scratch, "project");
  const images = join(projectRoot, "generated-images");
  await mkdir(images, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir, initializeFreshLibrary: true });
  try {
    const dimensions = [[300, 300], [300, 534], [534, 300], [300, 800], [400, 300], [300, 450]];
    for (let index = 0; index < dimensions.length; index += 1) {
      const [width, height] = dimensions[index];
      const imagePath = join(images, `ratio-${index}.png`);
      await sharp({ create: { width, height, channels: 3, background: { r: 50 + index * 30, g: 100, b: 180 } } }).png().toFile(imagePath);
      await store.createAsset({ assetId: `resize-${index}`, imagePath, prompt: `resize fixture ${index}`, business_fields: { width, height } });
    }
  } finally { store.close(); }
  const database = new Database(join(libraryDir, "mosa.db"));
  try {
    // Geometry QA needs decoded mixed-ratio media, not asynchronous derivative jobs.
    database.prepare("DELETE FROM derivative_jobs").run();
    const templates = database.prepare("SELECT * FROM assets ORDER BY id").all();
    const previews = await Promise.all(templates.map((item) => sharp(item.original_path).webp({ lossless: true }).toBuffer()));
    for (let index = 0; index < 300; index += 1) {
      await Promise.all([store.thumbnailsDir(), store.mediumsDir(), store.previewsDir()].map((directory) =>
        writeFile(join(directory, `resize-${index}.webp`), previews[index % templates.length])));
    }
    const columns = Object.keys(templates[0]);
    const insert = database.prepare(`INSERT INTO assets (${columns.join(",")}) VALUES (${columns.map((key) => `@${key}`).join(",")})`);
    const updatePaths = database.prepare("UPDATE assets SET thumbnail_path = ?, medium_path = ?, preview_path = ? WHERE id = ?");
    database.transaction(() => {
      for (let index = 6; index < 300; index += 1) {
        insert.run({ ...templates[index % templates.length], id: `resize-${index}`, asset: `resize-${index}.png` });
      }
      for (let index = 0; index < 300; index += 1) {
        updatePaths.run(...[store.thumbnailsDir(), store.mediumsDir(), store.previewsDir()].map((directory) => join(directory, `resize-${index}.webp`)), `resize-${index}`);
      }
    })();
  } finally { database.close(); }
}

async function connect() {
  const cdpPort = await freePort();
  const desktopPort = await freePort();
  const inspectPort = await freePort();
  child = spawn(executable, [
    `--remote-debugging-port=${cdpPort}`, `--inspect=${inspectPort}`, `--user-data-dir=${userData}`,
    ...(process.env.MOSA_RESIZE_QA_EXECUTABLE ? [] : [root]),
  ], { cwd: root, env: { ...process.env, MOSA_LIBRARY_DIR: libraryDir, MOSA_USER_DATA: userData,
    MOSA_RUNTIME_MODE: "qa", MOSA_QA_RUN: "1", MOSA_DESKTOP_PORT: String(desktopPort),
    MOSA_DISABLE_BRIDGES: "cowart,cowartDiscovery,codex,grok" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-6000); });
  child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-6000); });
  await once(child, "spawn");
  let target;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Electron exited: ${output}`);
    try {
      const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((response) => response.json());
      target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (target) break;
    } catch {}
    await wait(100);
  }
  assert.ok(target, `No renderer: ${output}`);
  const mainTargets = await fetch(`http://127.0.0.1:${inspectPort}/json/list`).then((response) => response.json());
  mainClient = await createClient(mainTargets[0].webSocketDebuggerUrl);
  return createClient(target.webSocketDebuggerUrl);
}

async function createClient(url) {
  const socket = new WebSocket(url);
  await new Promise((done, reject) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const pending = new Map();
  let sequence = 0;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.done(message.result);
  });
  return { close: () => socket.close(), send(method, params = {}) {
    return new Promise((done, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      pending.set(id, { done, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  } };
}

async function resizeWindow(width) {
  const response = await mainClient.send("Runtime.evaluate", { expression:
    `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(root, "package.json"))})('electron').BrowserWindow.getAllWindows()[0].setSize(${width}, 780)`,
  });
  assert.ok(!response.exceptionDetails, response.exceptionDetails?.exception?.description);
}

async function evaluate(expression) {
  const response = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  assert.ok(!response.exceptionDetails, response.exceptionDetails?.exception?.description);
  return response.result?.value;
}

async function snapshot(label) {
  await wait(600);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await evaluate("[...document.querySelectorAll('#assetGrid img.thumb')].some(img => img.naturalWidth > 0)")) break;
    await wait(100);
  }
  const metrics = await evaluate(`(() => {
    const grid = document.querySelector('#assetGrid');
    const bounds = grid.getBoundingClientRect();
    const tracks = getComputedStyle(grid).gridTemplateColumns.split(/\\s+/).map(Number.parseFloat);
    const cards = [...grid.querySelectorAll(':scope > .asset-card')];
    const visible = cards.filter(card => {
      const rect = card.getBoundingClientRect();
      // On mobile the grid can exceed the viewport. Offscreen content-visibility
      // boxes are estimates, not painted cards; measure the actual visible area.
      return rect.bottom > Math.max(0, bounds.top) && rect.top < Math.min(innerHeight, bounds.bottom);
    });
    const media = visible.flatMap(card => [...card.querySelectorAll('img.thumb')]).filter(img => img.naturalWidth > 0);
    const aspectErrors = media.map(img => {
      const rect = img.getBoundingClientRect();
      // Responsive srcset density/thumbnail rounding can change naturalWidth;
      // the original dimensions are the renderer's explicit aspect contract.
      return Math.abs(rect.height - rect.width * Number(img.getAttribute('height')) / Number(img.getAttribute('width')));
    });
    const rects = visible.filter(card => !card.classList.contains('asset-card-virtual-placeholder')).map(card => {
      const rect = card.getBoundingClientRect();
      return { column: Number(card.style.gridColumnStart), top: rect.top, bottom: rect.bottom, width: rect.width };
    });
    let overlaps = 0;
    for (const rect of rects) if (rects.some(other => other !== rect && other.column === rect.column && other.top > rect.top && other.top < rect.bottom - 1)) overlaps++;
    return { width: innerWidth, loaded: Number(grid.dataset.loadedAssets || 0), tracks,
      visible: visible.length, images: media.length, overlaps, maxAspectError: Math.max(0, ...aspectErrors),
      widthSpread: rects.length ? Math.max(...rects.map(r => r.width)) - Math.min(...rects.map(r => r.width)) : null,
      maxColumn: Math.max(0, ...cards.map(card => Number(card.style.gridColumnStart) || 0)),
      overflow: grid.scrollWidth - grid.clientWidth,
      visiblePlaceholders: visible.filter(card => card.classList.contains('asset-card-virtual-placeholder')).length };
  })()`);
  result.cases.push({ label, ...metrics });
  console.log(JSON.stringify({ label, ...metrics }));
  if (metrics.overlaps) console.log(await evaluate(`(() => {
    const cards = [...document.querySelectorAll('#assetGrid > .asset-card')].map(card => ({ id: card.dataset.id, column: card.style.gridColumnStart, row: card.style.gridRowStart, span: card.style.gridRowEnd, top: card.getBoundingClientRect().top, bottom: card.getBoundingClientRect().bottom, html: card.querySelector('img')?.outerHTML }));
    return cards.filter(card => cards.some(other => other.column === card.column && other.top > card.top && other.top < card.bottom - 1)).slice(0, 4);
  })()`));
  if (!metrics.images) console.log(await evaluate("[...document.querySelectorAll('#assetGrid .asset-card-select')].slice(0,2).map(node=>node.outerHTML)"));
  const expected = metrics.width >= 1280 ? 5 : metrics.width >= 768 ? 3 : 2;
  assert.equal(metrics.tracks.length, expected, `${label}: implicit columns`);
  assert.ok(Math.max(...metrics.tracks) - Math.min(...metrics.tracks) <= 1, `${label}: unequal tracks`);
  assert.ok(metrics.maxColumn <= expected, `${label}: stale column placement`);
  assert.ok(metrics.widthSpread !== null && metrics.widthSpread <= 1, `${label}: unequal card widths`);
  assert.ok(metrics.images > 0, `${label}: no visible decoded images`);
  assert.ok(metrics.maxAspectError < 1.1, `${label}: image aspect ratio changed`);
  assert.equal(metrics.overlaps, 0, `${label}: cards overlap`);
  assert.equal(metrics.visiblePlaceholders, 0, `${label}: unhydrated visible cards`);
  assert.ok(metrics.overflow <= 1, `${label}: horizontal overflow`);
}

try {
  await seed();
  client = await connect();
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await evaluate("document.querySelectorAll('#assetGrid > .asset-card').length > 5")) break;
    await wait(100);
  }
  for (const width of [1512, 1400, 1280, 1279, 1052, 960, 1279, 1280, 1512]) {
    await resizeWindow(width);
    await snapshot(`native-${width}`);
  }
  // The native App has a 960px minimum; the shared web gallery has a 2-column band.
  for (const width of [767, 640, 768, 1279, 1280]) {
    await client.send("Emulation.setDeviceMetricsOverride", { width, height: 720, deviceScaleFactor: 1, mobile: false });
    await snapshot(`web-${width}`);
  }
  await client.send("Emulation.clearDeviceMetricsOverride");
  for (let step = 0; step < 60; step += 1) {
    const loaded = await evaluate("(()=>{const grid=document.querySelector('#assetGrid');grid.scrollTop=grid.scrollHeight;return Number(grid.dataset.loadedAssets||0)})()");
    if (loaded === 300) break;
    await wait(100);
  }
  assert.equal(await evaluate("Number(document.querySelector('#assetGrid').dataset.loadedAssets)"), 300);
  for (const width of [1512, 1052, 960, 1512]) {
    await resizeWindow(width);
    await snapshot(`scrolled-${width}`);
  }
  await evaluate("document.querySelector('#assetGrid').scrollTop = 0");
  for (const width of [1279, 1280, 960, 1512, 1052, 1512]) {
    await resizeWindow(width);
  }
  await snapshot("rapid-resize-return-top");
  result.status = "PASS";
} catch (error) {
  result.status = "FAIL";
  result.error = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  client?.close();
  mainClient?.close();
  if (child?.pid && child.exitCode === null) {
    child.kill("SIGTERM");
    for (let attempt = 0; attempt < 50 && child.exitCode === null && child.signalCode === null; attempt += 1) await wait(100);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
  }
  if (process.env.MOSA_RESIZE_QA_RESULT) await writeFile(process.env.MOSA_RESIZE_QA_RESULT, JSON.stringify(result, null, 2));
  await rm(scratch, { recursive: true, force: true });
}
