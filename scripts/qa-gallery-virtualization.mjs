import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { GALLERY_PAGE_SIZE } from "../app/config.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

const root = resolve(import.meta.dirname, "..");
const ASSET_COUNT = Number.parseInt(process.env.MOSA_GALLERY_QA_ASSET_COUNT || "2000", 10);
const MAX_HYDRATED_CARDS = Number.parseInt(process.env.MOSA_GALLERY_QA_MAX_HYDRATED || "320", 10);
const MAX_MOUNTED_CARDS = Number.parseInt(process.env.MOSA_GALLERY_QA_MAX_MOUNTED || "400", 10);
const MAX_DOM_NODES = Number.parseInt(process.env.MOSA_GALLERY_QA_MAX_DOM_NODES || "9000", 10);
const MAX_LONG_TASK_MS = Number.parseInt(process.env.MOSA_GALLERY_QA_MAX_LONG_TASK_MS || "500", 10);
const MAX_LONG_TASK_TOTAL_MS = Number.parseInt(process.env.MOSA_GALLERY_QA_MAX_LONG_TASK_TOTAL_MS || "4000", 10);
const SKIP_BOTTOM_CHECK = process.env.MOSA_GALLERY_QA_SKIP_BOTTOM === "1";
// Optional structured diagnostics sink. Unset => script behavior is unchanged.
// Set => a JSON verdict (pass/fail + key metrics) is written even when the
// caller loses the process handle on a long run, so the exit status can be
// recovered from the file. QA diagnostics only; never read by product code.
const RESULT_FILE = process.env.MOSA_GALLERY_QA_RESULT_FILE || "";
const qaResult = {
  status: "unknown",
  assetCount: ASSET_COUNT,
  loaded: null,
  cards: null,
  hydrated: null,
  placeholders: null,
  domNodes: null,
  longTaskCount: null,
  longTaskMax: null,
  longTaskTotal: null,
  appendLatencyMax: null,
  boundaryStallMax: null,
  elapsedMs: null,
  fullReloadCount: null,
  incrementalScenarios: [],
  error: null,
};

async function writeResultFile() {
  if (!RESULT_FILE) return;
  await writeFile(RESULT_FILE, `${JSON.stringify(qaResult, null, 2)}\n`);
}

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
  const libraryDir = await mkdtemp(join(tmpdir(), "mosa-gallery-qa-library-"));  const userDataDir = await mkdtemp(join(tmpdir(), "mosa-gallery-qa-user-"));
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
      await store.ensureProject("default");
    } finally {
      store.close();
    }
    // Seed the scale fixture in one SQLite transaction, matching the same
    // canonical row shape used by test:performance. The GUI QA is measuring
    // renderer/runtime pagination and incremental reconciliation, not 50k file
    // copies or 50k Sharp jobs; real mutations below still go through the public
    // Runtime APIs. This keeps the 50k gate deterministic and fast enough to
    // return a trustworthy exit status in CI/tool environments.
    const database = new Database(join(libraryDir, "mosa.db"));
    try {
      const timestamp = new Date().toISOString();
      const timestampEpoch = Date.parse(timestamp);
      const insertAsset = database.prepare(`
        INSERT INTO assets (
          project_id, id, asset, original_path, content_sha256, prompt, skill, style, ratio,
          business_fields_json, theme, favorite, archived, group_name, category, rating,
          version_change, source_type, source_json, metadata_json, search_text, tags_text,
          business_search_text, source_search_text, media_kind, source_group, conversation_id,
          generation_batch, created_at, created_at_epoch, updated_at, sort_name
        ) VALUES (
          'default', @id, @asset, @original_path, @content_sha256, @prompt, '', '', '',
          '{"width":1024,"height":1024}', '', 0, 0, '', '', 0,
          '', 'qa-gallery', '{"type":"qa-gallery"}', '{}', @prompt, '',
          '1024 1024', 'qa-gallery', 'image', 'qa-gallery', '', '',
          @created_at, @created_at_epoch, @updated_at, @sort_name
        )
      `);
      const insertFts = database.prepare("INSERT INTO asset_fts (project_id, asset_id, content) VALUES ('default', ?, ?)");
      database.transaction(() => {
        for (let index = 0; index < ASSET_COUNT; index += 1) {
          const id = `perf-${String(index).padStart(5, "0")}`;
          const prompt = `gallery virtualization fixture ${index}`;
          insertAsset.run({
            id,
            asset: `${id}.png`,
            original_path: sourcePath,
            content_sha256: `qa-${index}`,
            prompt,
            created_at: timestamp,
            created_at_epoch: timestampEpoch,
            updated_at: timestamp,
            sort_name: id,
          });
          insertFts.run(id, prompt);
        }
      })();
      const seededCount = Number(database.prepare("SELECT COUNT(*) AS count FROM assets WHERE project_id = 'default'").get().count || 0);
      assert.equal(seededCount, ASSET_COUNT, `QA seed wrote ${seededCount} of ${ASSET_COUNT} assets`);
      console.log(`[gallery-qa] seeded ${seededCount}/${ASSET_COUNT} in one isolated fixture transaction`);
    } finally {
      database.close();
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
    await evaluate(client, `window.__mosaLongTasks=[]; window.__mosaAppendMarks=[]; window.__mosaBoundaryStalls=[]; window.__mosaBoundaryStall=null; window.__mosaLongTaskObserver=new PerformanceObserver((list)=>window.__mosaLongTasks.push(...list.getEntries().map((entry)=>({startTime:entry.startTime,duration:entry.duration})))); window.__mosaLongTaskObserver.observe({entryTypes:['longtask']}); true`);

    const startedAt = Date.now();
    // Exercise the real product path: a fast continuous scroll, not synthetic
    // clicks on the hidden fallback button. The browser records how long each
    // pagination boundary stays pending from entering the sentinel warm zone to
    // the new cards being present. This directly measures the wait a user could
    // perceive while flinging through the library.
    // Windowed DOM means mounted card count no longer grows with loaded pages.
    // Give each expected page enough animation frames to cross the preload
    // boundary, commit, remount the new warm window, and re-arm pagination.
    const maxScrollSteps = Math.ceil(ASSET_COUNT / GALLERY_PAGE_SIZE) * 30 + 400;
    for (let step = 0; step < maxScrollSteps; step += 1) {
      const scrollState = JSON.parse(await evaluate(client, `JSON.stringify((()=>{
        const grid=document.querySelector('#assetGrid');
        const cards=document.querySelectorAll('#assetGrid > .asset-card').length;
        const loaded=Number(grid.dataset.loadedAssets||0);
        const more=Boolean(document.querySelector('[data-action="load-more"]'));
        const now=performance.now();
        const pending=window.__mosaBoundaryPending;
        if(pending && loaded>pending.loaded){window.__mosaAppendMarks.push({at:pending.at,committedAt:now,loaded:pending.loaded,phase:'auto-append',latency:now-pending.at});window.__mosaBoundaryPending=null;}
        if(window.__mosaBoundaryStall && loaded>window.__mosaBoundaryStall.loaded){window.__mosaBoundaryStalls.push({at:window.__mosaBoundaryStall.at,endedAt:now,loaded:window.__mosaBoundaryStall.loaded,duration:now-window.__mosaBoundaryStall.at});window.__mosaBoundaryStall=null;}
        const remaining=Math.max(0,grid.scrollHeight-grid.scrollTop-grid.clientHeight);
        const triggerDistance=Math.max(600,grid.clientHeight*0.85)+32;
        if(!window.__mosaBoundaryPending && more && remaining<=triggerDistance){window.__mosaBoundaryPending={at:now,loaded};}
        const maxScrollTop=Math.max(0,grid.scrollHeight-grid.clientHeight);
        grid.scrollTop=Math.min(maxScrollTop,grid.scrollTop+Math.max(160,grid.clientHeight*0.7));
        if(more && grid.scrollTop>=maxScrollTop-0.5 && !window.__mosaBoundaryStall){window.__mosaBoundaryStall={at:now,loaded};}
        return {cards,loaded,more,scrollTop:grid.scrollTop,scrollHeight:grid.scrollHeight,clientHeight:grid.clientHeight};
      })())`));
      if (scrollState.loaded >= ASSET_COUNT || !scrollState.more) break;
      await wait(16);
    }
    await evaluate(client, `(()=>{const pending=window.__mosaBoundaryPending;const loaded=Number(document.querySelector('#assetGrid')?.dataset.loadedAssets||0);if(pending&&loaded>pending.loaded){const now=performance.now();window.__mosaAppendMarks.push({at:pending.at,committedAt:now,loaded:pending.loaded,phase:'auto-append',latency:now-pending.at});window.__mosaBoundaryPending=null;}return true;})()`);
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
      await evaluate(client, `window.__mosaAppendMarks.push({at:performance.now(),cards:document.querySelectorAll('#assetGrid > .asset-card').length,phase:'bottom-jump'}); true`);
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
      loaded:Number(document.querySelector('#assetGrid')?.dataset.loadedAssets||0),
      cards:document.querySelectorAll('#assetGrid > .asset-card').length,
      hydrated:document.querySelectorAll('#assetGrid > .asset-card:not(.asset-card-virtual-placeholder)').length,
      placeholders:document.querySelectorAll('#assetGrid > .asset-card-virtual-placeholder').length,
      nodes:document.querySelectorAll('*').length,
      gridText:(document.querySelector('#assetGrid')?.textContent||'').slice(0,500),
      gridHtml:(document.querySelector('#assetGrid')?.innerHTML||'').slice(0,1000),
      longTasks:window.__mosaLongTasks.length,
      longTaskTotal:Math.round(window.__mosaLongTasks.reduce((sum,entry)=>sum+entry.duration,0)),
      longTaskMax:Math.round(Math.max(0,...window.__mosaLongTasks.map((entry)=>entry.duration))),
      longTaskEntries:window.__mosaLongTasks,
      appendMarks:window.__mosaAppendMarks,
      appendLatencyMax:Math.round(Math.max(0,...window.__mosaAppendMarks.filter((entry)=>Number.isFinite(entry.latency)).map((entry)=>entry.latency))),
      boundaryStalls:window.__mosaBoundaryStalls,
      boundaryStallMax:Math.round(Math.max(0,...window.__mosaBoundaryStalls.map((entry)=>entry.duration))),
      scrollHeight:document.querySelector('#assetGrid').scrollHeight
    })`));
    metrics.apiSnapshot = apiSnapshot;
    metrics.healthSnapshot = healthSnapshot;
    metrics.expectedLibraryDir = libraryDir;
    metrics.topMetrics = topMetrics;
    metrics.bottomMetrics = bottomMetrics;
    console.log(JSON.stringify(metrics, null, 2));
    metrics.elapsedMs = Date.now() - startedAt;
    qaResult.loaded = metrics.loaded;
    qaResult.cards = metrics.cards;
    qaResult.hydrated = metrics.hydrated;
    qaResult.placeholders = metrics.placeholders;
    qaResult.domNodes = metrics.nodes;
    qaResult.longTaskCount = metrics.longTasks;
    qaResult.longTaskMax = metrics.longTaskMax;
    qaResult.longTaskTotal = metrics.longTaskTotal;
    qaResult.appendLatencyMax = metrics.appendLatencyMax;
    qaResult.boundaryStallMax = metrics.boundaryStallMax;
    qaResult.elapsedMs = metrics.elapsedMs;

    assert.equal(metrics.loaded, ASSET_COUNT, `expected ${ASSET_COUNT} loaded assets: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.cards <= MAX_MOUNTED_CARDS, `mounted cards ${metrics.cards} exceeds ${MAX_MOUNTED_CARDS}`);
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

    // ------------------------------------------------------------------
    // Library Change 增量同步专项场景：在 50k 全部加载的状态下逐个触发
    // 单实体变化，度量「revision before/after、delta 数、页面请求数、
    // 全量重载次数、UI 反馈耗时」。普通变更的 Full Gallery Reload 必须
    // 恒为 0（limit=250 的已加载窗口重取是唯一全量信号）。
    // ------------------------------------------------------------------
    const runtimeHealth = await fetch(`http://127.0.0.1:${desktopPort}/api/health`).then((response) => response.json());
    assert.ok(runtimeHealth?.productVersion, "desktop runtime must be reachable for the incremental scenarios");

    await evaluate(client, `(()=>{
      window.__mosaReqLog=[];
      if(!window.__mosaFetchPatched){
        window.__mosaFetchPatched=true;
        const original=window.fetch;
        window.fetch=(...args)=>{
          const url=String(args[0] instanceof Request?args[0].url:args[0]);
          window.__mosaReqLog.push({url,at:performance.now()});
          return original(...args);
        };
      }
      return true;
    })()`);
    // 回到画廊顶部：新增素材（newest 排序）的卡片要出现在可见 DOM 里。
    await evaluate(client, `(()=>{const grid=document.querySelector('#assetGrid');grid.scrollTop=0;grid.dispatchEvent(new Event('scroll'));return true})()`);
    await wait(1200);

    const runtimeFetch = async (path, options) => {
      const response = await fetch(`http://127.0.0.1:${desktopPort}${path}`, options);
      const body = await response.json();
      assert.ok(response.ok, `runtime mutation ${path} failed: ${response.status} ${JSON.stringify(body)}`);
      return body;
    };
    const revisionNow = async () => Number.parseInt((await runtimeFetch(`/api/library-revision?project=default`)).revision, 10);
    const deltaCount = async (since) => (await runtimeFetch(`/api/library-changes?project=default&since=${since}`)).changes.length;
    const isFullReloadRequest = (url) => url.includes("limit=250") && (url.includes("/api/assets?") || url.includes("/assets?"));
    const drainRequests = () => evaluate(client, "(()=>{const log=window.__mosaReqLog;window.__mosaReqLog=[];return JSON.stringify(log)})()").then(JSON.parse);
    const waitForPage = async (expression, description, timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(client, expression)) return;
        await wait(80);
      }
      throw new Error(`Timed out waiting for ${description}`);
    };

    const scenarios = [];
    qaResult.incrementalScenarios = scenarios;
    const runScenario = async (name, mutate, waitExpression, waitDescription) => {
      await drainRequests();
      const revisionBefore = await revisionNow();
      const startedAt = Date.now();
      const result = await mutate();
      if (waitExpression) await waitForPage(waitExpression, waitDescription);
      // 权威完成信号：UI 的 sync baseline 吸收了 mutation 之后的 revision
      // （即 delta 已成功应用并推进），弱条件（如 loadedAssets 不变）只作辅助。
      const revisionAfterMutation = await revisionNow();
      await waitForPage(`(window.__mosa.librarySync?.baseline()||'').startsWith('${revisionAfterMutation}:')`, "the sync baseline to absorb the change");
      const elapsedMs = Date.now() - startedAt;
      await wait(250);
      const requests = await drainRequests();
      const revisionAfter = await revisionNow();
      const deltas = revisionAfter > revisionBefore ? await deltaCount(revisionBefore) : 0;
      const fullReloads = requests.filter((entry) => isFullReloadRequest(entry.url)).length;
      const galleryRowsRequests = requests.filter((entry) => entry.url.includes("/api/gallery-rows")).length;
      const pageRequests = requests.filter((entry) => entry.url.includes("/api/assets?") || entry.url.includes("asset-stacks")).length;
      scenarios.push({ name, revisionBefore, revisionAfter, deltaCount: deltas, requestCount: requests.length, galleryRowsRequests, pageRequests, fullReloads, elapsedMs, ...result });
    };

    const liveId = `perf-live-${Date.now()}`;

    // 外部 ingest 走正规 staging 流程（desktop runtime 只信任自己的 staging 根）。
    const liveAssetBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const stageLiveAsset = async () => {
      const staged = await fetch(`http://127.0.0.1:${desktopPort}/api/import/stage`, {
        method: "POST",
        headers: { "x-mosa-file-name": encodeURIComponent(`${liveId}.png`), "content-type": "application/octet-stream" },
        body: liveAssetBytes,
      });
      const stagedBody = await staged.json();
      assert.ok(staged.ok, `staging failed: ${staged.status} ${JSON.stringify(stagedBody)}`);
      return stagedBody.path;
    };

    await runScenario(
      "external-ingest-add",
      async () => {
        const stagedPath = await stageLiveAsset();
        const created = await runtimeFetch("/api/assets/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ assetId: liveId, imagePath: stagedPath, prompt: "live incremental ingest" }),
        });
        return { id: created.asset?.id };
      },
      `document.querySelector('#assetGrid > .asset-card')?.dataset.id === '${liveId}'`,
      "the ingested card to appear at the gallery top",
    ).then(() => assert.equal((scenarios.at(-1)).fullReloads, 0, "single ingest must not reload the loaded window"));

    await runScenario(
      "favorite",
      async () => {
        const toggled = await runtimeFetch(`/api/assets/default/${liveId}/favorite`, { method: "POST" });
        return { favorite: toggled.asset?.favorite };
      },
      `document.querySelector('#assetGrid > .asset-card[data-id="${liveId}"] .card-favorite')?.getAttribute('aria-pressed') === 'true'`,
      "the card star to flip to favorited",
    ).then(() => assert.equal((scenarios.at(-1)).fullReloads, 0, "favorite must not reload the loaded window"));

    await runScenario(
      "trash-delete",
      () => runtimeFetch("/api/assets/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "trash", projectId: "default", assetIds: [liveId] }),
      }),
      `document.querySelector('#assetGrid > .asset-card')?.dataset.id !== '${liveId}'`,
      "the deleted card to leave the gallery top",
    ).then(() => assert.equal((scenarios.at(-1)).fullReloads, 0, "delete must not reload the loaded window"));

    await runScenario(
      "restore",
      async () => {
        const restored = await runtimeFetch(`/api/assets/default/${liveId}/restore`, { method: "POST" });
        return { id: restored.asset?.id };
      },
      `document.querySelector('#assetGrid > .asset-card')?.dataset.id === '${liveId}'`,
      "the restored card to re-enter the gallery top",
    ).then(() => assert.equal((scenarios.at(-1)).fullReloads, 0, "restore must not reload the loaded window"));

    // 深处 Stack 场景：成员都在 50k 窗口内但不在视口 DOM 中，度量纯数据增量。
    const stackMembers = (await runtimeFetch("/api/assets?project=default&sort=oldest&limit=2")).assets.map((asset) => asset.id);
    assert.equal(stackMembers.length, 2);
    const loadedBeforeStack = Number(await evaluate(client, "Number(document.querySelector('#assetGrid')?.dataset.loadedAssets||0)"));
    let createdStackId = "";
    await runScenario(
      "stack-create",
      async () => {
        const created = await runtimeFetch("/api/asset-stacks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: "default", assetIds: stackMembers, coverAssetId: stackMembers[0] }),
        });
        createdStackId = created.stack?.id || "";
        return { stackId: createdStackId };
      },
      `Number(document.querySelector('#assetGrid')?.dataset.loadedAssets||0) === ${loadedBeforeStack - 1}`,
      "two member nodes to collapse into one stack node",
    ).then(() => assert.equal((scenarios.at(-1)).fullReloads, 0, "stack creation must not reload the loaded window"));
    assert.ok(createdStackId, "stack id returned by creation");

    await runScenario(
      "stack-cover-change",
      () => runtimeFetch(`/api/asset-stacks/${encodeURIComponent(createdStackId)}/order`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: "default", assetIds: [stackMembers[1], stackMembers[0]] }),
      }),
      `Number(document.querySelector('#assetGrid')?.dataset.loadedAssets||0) === ${loadedBeforeStack - 1}`,
      "the stack node to re-anchor on the new cover",
    ).then(async () => {
      assert.equal((scenarios.at(-1)).fullReloads, 0, "cover change must not reload the loaded window");
      const summary = await runtimeFetch(`/api/asset-stacks/${encodeURIComponent(createdStackId)}?project=default`);
      assert.equal(summary.stack?.cover_asset_id, stackMembers[1], "server anchor follows the reorder");
    });

    await runScenario(
      "stack-member-delete",
      () => runtimeFetch("/api/assets/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "trash", projectId: "default", assetIds: [stackMembers[1]] }),
      }),
      `Number(document.querySelector('#assetGrid')?.dataset.loadedAssets||0) === ${loadedBeforeStack - 1}`,
      "the stack to dissolve into its remaining member",
    ).then(() => assert.equal((scenarios.at(-1)).fullReloads, 0, "member deletion must not reload the loaded window"));

    // 隐藏/恢复与 SSE 重连共享同一条 resume 代码路径（revision 对账 → delta 回放）。
    const resumeBaseline = await evaluate(client, "window.__mosa.librarySync?.baseline()");
    const favoriteFlip = await runtimeFetch(`/api/assets/default/${liveId}/favorite`, { method: "POST" });
    assert.equal(typeof favoriteFlip.asset?.favorite, "boolean");
    const resumeRevision = await revisionNow();
    await drainRequests();
    const resumeStartedAt = Date.now();
    const resumed = await evaluate(client, "window.__mosa.librarySync ? window.__mosa.librarySync.syncNow() : false");
    await waitForPage(`window.__mosa.librarySync?.baseline() === '${resumeRevision}:0' || window.__mosa.librarySync?.baseline()?.startsWith('${resumeRevision}:')`, "the baseline to catch up after resume", 8000);
    const resumeElapsedMs = Date.now() - resumeStartedAt;
    const resumeRequests = await drainRequests();
    const resumeFullReloads = resumeRequests.filter((entry) => isFullReloadRequest(entry.url)).length;
    assert.equal(resumed, true, "resume reconciliation ran");
    assert.equal(resumeFullReloads, 0, "resume after missed events must not reload the loaded window");
    assert.ok(resumeElapsedMs < 5000, `resume reconciliation took ${resumeElapsedMs}ms`);
    scenarios.push({ name: "hidden-resume-sync", revisionBefore: Number.parseInt(String(resumeBaseline), 10), revisionAfter: resumeRevision, deltaCount: resumeRevision - Number.parseInt(String(resumeBaseline), 10), requestCount: resumeRequests.length, fullReloads: resumeFullReloads, elapsedMs: resumeElapsedMs });

    const totalFullReloads = scenarios.reduce((sum, scenario) => sum + scenario.fullReloads, 0);
    qaResult.fullReloadCount = totalFullReloads;
    assert.equal(totalFullReloads, 0, `ordinary library changes must never reload the loaded window (saw ${totalFullReloads})`);
    console.log("INCREMENTAL_SCENARIOS");
    console.log(JSON.stringify(scenarios, null, 2));
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

let exitCode = 0;
try {
  await main();
  qaResult.status = "pass";
} catch (error) {
  qaResult.status = "fail";
  qaResult.error = { message: error?.message || String(error), stack: error?.stack || null };
  console.error(error);
  exitCode = 1;
}
try {
  await writeResultFile();
} catch (error) {
  console.error(`[gallery-qa] failed to write result file ${RESULT_FILE}: ${error?.message || error}`);
  exitCode = 1;
}
console.log(`[gallery-qa] result: ${qaResult.status} (exit ${exitCode})${RESULT_FILE ? `, verdict file: ${RESULT_FILE}` : ""}`);
process.exitCode = exitCode;
