// Live cross-process sync e2e flow: an external MCP writer process (its own
// store connection on the same SQLite library) mutates the library while the
// web UI is open, and the gallery / inspector / sidebar counts must follow in
// real time through the SSE push path, never through a full reload.
//
// Why this is a real push and not the 30s fallback: every segment first proves
// an EventSource to /api/library-events is actually OPEN (the recorded source
// instance reports readyState OPEN and the server's "ready" event arrived),
// then the external write lands, and the change must be visible within 10s of
// the MCP write completing — an order of magnitude below LIBRARY_REFRESH_INTERVAL.
//
// Page <-> writer coordination without fixed sleeps: the page settles, proves
// SSE, then PATCHes a marker prompt onto a canary asset through the same
// authenticated asset API the UI itself uses. The Node side polls the canary
// until the marker lands (so the page is provably ready), performs the MCP
// write, and finally asserts the page-recorded sighting time against the write
// completion time. Slow machines only stretch the generous wait budgets, never
// the measured latency.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "live-sync";
export const description = "external MCP writer (separate process, same SQLite library) -> SSE push updates gallery card, inspector favorite/tags, sidebar counts, and the hidden->foreground fallback";

// A live push must land well within the 30s fallback interval; 10s is the task's
// upper bound and is measured from the MCP write completion on the same host.
const LIVE_LATENCY_BUDGET_MS = 10_000;
// Wait budgets are deliberately generous: they absorb slow CI (cold Electron
// spawn, throttled background timers) but never enter the latency measurement.
const PAGE_WAIT_MS = 45_000;
const MARKER_WAIT_MS = 45_000;
const MCP_REQUEST_TIMEOUT_MS = 20_000;

const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const CANARY_FILE = `live-sync-canary-${stamp}.png`;
const META_FILE = `live-sync-meta-${stamp}.png`;
const ARCHIVE_FILE = `live-sync-archive-${stamp}.png`;
const CREATE_FILE = `live-sync-create-${stamp}.png`;
const HIDDEN_FILE = `live-sync-hidden-${stamp}.png`;
const CANARY_PROMPT = `live-sync canary original ${stamp}`;
const META_PROMPT = `live-sync meta target ${stamp}`;
const ARCHIVE_PROMPT = `live-sync archive target ${stamp}`;
const TAG_VALUE = `live-sync-tag-${stamp}`;
// Marker prompts ride on the canary asset's prompt; ASCII-only, no whitespace,
// so the PATCH round-trip is byte-stable and prompt changes never touch counts.
const marker = (label) => `live-sync-marker-${label}-${stamp}`;

function assertOk(condition, message) {
  if (!condition) throw new Error(`live-sync: ${message}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`live-sync: ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function sleep(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

// Asserts the page saw the change within the live budget of the MCP write and
// returns the measured delay (page and Node share this host's wall clock).
function assertLiveLatency(seenAt, writeDoneAt, label) {
  assertOk(Number.isFinite(seenAt) && seenAt > 0, `${label}: page never recorded a sighting time`);
  const latency = seenAt - writeDoneAt;
  assertOk(seenAt >= writeDoneAt - 2_000, `${label}: sighting ${-latency}ms before the write completed — clock or sequencing bug`);
  assertOk(latency <= LIVE_LATENCY_BUDGET_MS, `${label}: change appeared ${latency}ms after the MCP write (budget ${LIVE_LATENCY_BUDGET_MS}ms — that is fallback polling, not a live push)`);
  return latency;
}

// ===== External MCP writer process =====
// A second `node mcp/server.mjs` process holding its own store connection on
// the same SQLite library (WAL allows the App+MCP coexistence). HOME and
// MOSA_PROJECT_DIR pin it to this flow's throwaway workspace so the user's
// real library can never be involved.
function startMcpWriter(ctx, workspaceDir) {
  const env = {
    ...process.env,
    HOME: workspaceDir,
    MOSA_PROJECT_DIR: workspaceDir,
    MOSA_LIBRARY_DIR: ctx.libraryDir,
    CODEX_GENERATED_IMAGES_DIR: ctx.fixturesDir,
  };
  const missing = ["HOME", "MOSA_PROJECT_DIR", "MOSA_LIBRARY_DIR", "CODEX_GENERATED_IMAGES_DIR"].filter((key) => !env[key]);
  if (missing.length) throw new Error(`live-sync: refusing to spawn the MCP writer without ${missing.join(", ")}`);

  const child = spawn(process.execPath, ["mcp/server.mjs"], { cwd: ctx.rootDir, env, stdio: ["pipe", "pipe", "pipe"] });
  const stderrChunks = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  const stderr = () => stderrChunks.join("").slice(-2000);

  const responses = [];
  let lineBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    lineBuffer += chunk;
    for (let newline = lineBuffer.indexOf("\n"); newline !== -1; newline = lineBuffer.indexOf("\n")) {
      const line = lineBuffer.slice(0, newline);
      lineBuffer = lineBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      try { responses.push(JSON.parse(line)); } catch { responses.push({ unparsableLine: line }); }
    }
  });

  let nextId = 1;
  async function request(method, params, { timeoutMs = MCP_REQUEST_TIMEOUT_MS } = {}) {
    const id = nextId;
    nextId += 1;
    const message = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    child.stdin.write(`${JSON.stringify(message)}\n`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = responses.find((entry) => entry.id === id);
      if (found) {
        if (found.error) throw new Error(`live-sync: MCP ${method} returned JSON-RPC error ${found.error.code}: ${found.error.message}`);
        return found.result;
      }
      if (child.exitCode !== null) throw new Error(`live-sync: MCP writer exited with ${child.exitCode} before answering ${method}. stderr: ${stderr()}`);
      await sleep(20);
    }
    throw new Error(`live-sync: MCP writer produced no response for ${method} within ${timeoutMs}ms. stderr: ${stderr()}`);
  }

  async function callTool(toolName, args) {
    const result = await request("tools/call", { name: toolName, arguments: args });
    if (result?.isError) throw new Error(`live-sync: MCP ${toolName} failed: ${JSON.stringify(result.structuredContent ?? result.content)}`);
    return result?.structuredContent || {};
  }

  async function initialize() {
    await request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "mosa-e2e-live-sync", version: "0.0.0" },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }

  // stdin end is the MCP shutdown contract; the server drains its store and
  // exits 0. SIGTERM is the documented fallback, SIGKILL the last resort.
  async function stop() {
    if (child.exitCode !== null) return child.exitCode;
    child.stdin.end();
    let code = await Promise.race([
      once(child, "exit").then(() => child.exitCode),
      sleep(10_000).then(() => null),
    ]);
    if (code === null) {
      child.kill("SIGTERM");
      code = await Promise.race([
        once(child, "exit").then(() => child.exitCode ?? child.signalCode),
        sleep(10_000).then(() => null),
      ]);
    }
    if (code === null) {
      child.kill("SIGKILL");
      code = await once(child, "exit").then(() => child.exitCode ?? child.signalCode);
    }
    return code;
  }

  return { initialize, callTool, stop, stderr };
}

// Polls the canary asset until the page's marker PATCH is visible to the
// server. This is the readiness handshake: the page only writes the marker
// after its gallery settled and the SSE connection was proven, so a resolved
// marker means the external write may start. `failureRef` is the page-run
// state object ({ failure }); reading .failure inside the loop surfaces a
// mid-flight page error immediately instead of after the full timeout.
async function waitForMarker(ctx, server, canaryId, expectedPrompt, { timeoutMs = MARKER_WAIT_MS, failureRef = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastPrompt = "";
  while (Date.now() < deadline) {
    if (failureRef?.failure) throw failureRef.failure;
    try {
      const payload = await ctx.api(server.origin, "GET", `/api/assets/default/${encodeURIComponent(canaryId)}`);
      lastPrompt = String(payload?.asset?.prompt || "");
      if (lastPrompt === expectedPrompt) return;
    } catch { /* asset API hiccup: keep polling until the deadline */ }
    await sleep(150);
  }
  throw new Error(`live-sync: the page never confirmed readiness (canary prompt ${JSON.stringify(lastPrompt)} never became ${JSON.stringify(expectedPrompt)})${failureRef?.failure ? `; page error: ${failureRef.failure.message}` : ""}`);
}

// Node-side wrapper around one runInPage call that may fail: swallows the
// rejection into a variable so the handshake loop can surface it early.
function runPageTrackingFailures(ctx, server, source) {
  const state = { failure: null };
  const promise = ctx.runInPage(server, source).catch((error) => {
    state.failure = error instanceof Error ? error : new Error(String(error));
    return null;
  });
  return { promise, state };
}

// ===== Page sources =====
// Shared prelude: instruments window.EventSource with a recording wrapper (the
// app keeps using its own construction path — startLibraryEventStream), adds
// an async-capable waiter (PAGE_HELPERS.waitFor is sync-check only), and drives
// the real visibilitychange handler to prove both directions of the stream
// lifecycle: hide must close the stream, returning to the foreground must open
// a new one and receive the server's "ready" event.
function pagePrelude(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    const waitTick = (ms) => new Promise((resolveTick) => setTimeout(resolveTick, ms));
    async function waitForAsync(check, label, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      let lastError = null;
      while (Date.now() < deadline) {
        try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
        await waitTick(100);
      }
      throw new Error('Timed out waiting for ' + label + (lastError ? ': ' + lastError.message : '') + ' diagnostic=' + JSON.stringify(pageDiagnostic()));
    }

    // Recording EventSource wrapper: the app's startLibraryEventStream still
    // constructs and owns the source; we only observe readyState and events.
    const sse = { sources: [] };
    const NativeEventSource = window.EventSource;
    window.EventSource = function (url, init) {
      const source = new NativeEventSource(url, init);
      const record = { url: String(url), createdAt: Date.now(), readyAt: 0, changedEvents: 0, source: source };
      source.addEventListener('ready', () => { record.readyAt = Date.now(); });
      source.addEventListener('library-changed', () => { record.changedEvents += 1; });
      sse.sources.push(record);
      return source;
    };

    // Simulated visibility transitions go through the app's real document
    // visibilitychange handler (stopLibraryEventStream / startLibraryEventStream
    // / refreshLibraryIfChanged) — no internal function is called directly.
    let fakeHidden = false;
    function setFakeVisibility(hidden) {
      fakeHidden = hidden;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => fakeHidden });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (fakeHidden ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    }

    const sameIds = (a, b) => JSON.stringify(a.slice().sort()) === JSON.stringify(b.slice().sort());
    const navCount = (filter) => document.querySelector('#quickFilters [data-filter="' + filter + '"] .nav-count')?.textContent || '';
    const allCount = () => navCount('all');
    const favoriteCount = () => navCount('favorite');
    const canaryUrl = () => '/api/assets/default/' + encodeURIComponent(config.canaryId);
    async function readCanaryPrompt() {
      const response = await fetch(canaryUrl(), { headers: { 'x-mosa-client-token': config.clientToken } });
      if (!response.ok) throw new Error('canary GET failed with ' + response.status);
      const body = await response.json();
      return String(body?.asset?.prompt || '');
    }
    async function markCanary(markerPrompt) {
      const response = await fetch(canaryUrl(), {
        method: 'PATCH',
        headers: { 'x-mosa-client-token': config.clientToken, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: markerPrompt }),
      });
      if (!response.ok) throw new Error('canary PATCH failed with ' + response.status + ': ' + (await response.text()).slice(0, 160));
    }
    async function openDetailFor(assetId) {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const button = document.querySelector(cardSelector(assetId) + ' .asset-card-select');
        if (button?.isConnected) break;
        await waitTick(100);
      }
      document.querySelector(cardSelector(assetId) + ' .asset-card-select')?.click();
      await waitFor(() => document.querySelector('#detailPanel')?.getAttribute('aria-hidden') === 'false'
        && document.querySelector('.asset-card.selected')?.dataset.id === assetId, 'inspector shows ' + assetId, 15000);
    }

    // Settles the gallery on the expected baseline, then proves the live SSE
    // connection: hide closes every recorded stream, returning to the
    // foreground opens a fresh one that is OPEN and has received the server's
    // ready event. The very first hide is vacuously true (the app's initial
    // stream was constructed before this script ran and is not recorded); the
    // fresh recorded stream from this dance is what every later assertion and
    // the hidden-phase close check observe.
    await waitFor(() => gallerySettled() && sameIds(rootCardIds(), config.baselineIds), 'baseline gallery settled', 25000);
    // The sidebar counts come from a separate navigation request, so a settled
    // gallery does not mean they are rendered yet. An empty count reads as 0 and
    // every later "count + 1" expectation is then off (seen on Windows CI:
    // expected 1 while the UI correctly showed 4). Take the baseline only once
    // the rendered count agrees with the server.
    await waitForAsync(async () => {
      if (allCount() === '' || favoriteCount() === '') return false;
      const response = await fetch('/api/navigation?project=default', { headers: { 'x-mosa-client-token': config.clientToken } });
      if (!response.ok) return false;
      return Number(allCount()) === Number((await response.json())?.navigation?.total);
    }, 'sidebar counts rendered and matching the server', 25000);
    const initialVisibilityState = document.visibilityState;
    const initialAllCount = Number(allCount());
    const initialFavoriteCount = Number(favoriteCount());
    if (!Number.isFinite(initialAllCount) || !Number.isFinite(initialFavoriteCount)) {
      throw new Error('sidebar counts not rendered: all=' + allCount() + ' favorite=' + favoriteCount());
    }
    setFakeVisibility(true);
    await waitFor(() => sse.sources.every((record) => record.source.readyState === 2), 'recorded streams closed on hide', 5000);
    setFakeVisibility(false);
    await waitFor(() => {
      const record = sse.sources.at(-1);
      return Boolean(record) && record.source.readyState === 1 && record.readyAt > 0;
    }, 'fresh SSE stream connected after returning to the foreground', 15000);
    const liveRecord = sse.sources.at(-1);
`;
}

function pageEpilogue(extraFactNames) {
  const facts = (Array.isArray(extraFactNames) ? extraFactNames : [])
    .map((name) => `${name}: ${name}`)
    .join(", ");
  return `    return Object.assign({
      initialVisibilityState,
      initialAllCount,
      initialFavoriteCount,
      sseUrl: liveRecord.url,
      sseReadyAt: liveRecord.readyAt,
      sseChangedEvents: liveRecord.changedEvents,
      sseSourceCount: sse.sources.length,
      rendererErrors: rendererErrors.slice(0, 3),
    }, { ${facts} });
  })()`;
}

// Segment 1: MCP asset_create while the page watches — new card + sidebar count.
function createSegmentSource(config) {
  return `${pagePrelude(config)}
    await markCanary(config.marker);
    let cardSeenAt = 0;
    await waitFor(() => {
      const card = document.querySelector('.asset-card[data-id^="' + config.createPrefix + '"]');
      if (card && !cardSeenAt) cardSeenAt = Date.now();
      return Boolean(card);
    }, 'MCP-created card appears without reload (live push)', ${PAGE_WAIT_MS});
    let countSeenAt = 0;
    await waitFor(() => {
      const ok = allCount() === String(initialAllCount + 1);
      if (ok && !countSeenAt) countSeenAt = Date.now();
      return ok;
    }, 'all-assets sidebar count increments', ${PAGE_WAIT_MS});
    const cardTitle = document.querySelector('.asset-card[data-id^="' + config.createPrefix + '"] .asset-card-title')?.textContent || '';
  ${pageEpilogue(['cardSeenAt', 'countSeenAt', 'cardTitle'])}`;
}

// Segment 2: MCP asset_update_metadata (favorite + tag) with the inspector
// open on that asset — favorite state, tag chip, favorites count all follow.
function metadataSegmentSource(config) {
  return `${pagePrelude(config)}
    await openDetailFor(config.metaAssetId);
    // No editor must be active, otherwise the reconciler intentionally keeps
    // the user's draft and defers the inspector re-render.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    // Focus rests on the inspector's favorite button before the external
    // write; the re-render replaces the whole panel content, so the focus
    // restore must land back on the fresh button (not the title, not body).
    document.querySelector('#detailPanel [data-action="toggle-favorite"]')?.focus();
    await markCanary(config.marker);
    let detailFavSeenAt = 0;
    let tagSeenAt = 0;
    let favCountSeenAt = 0;
    let focusRestoredSeenAt = 0;
    try {
      await waitFor(() => {
        const button = document.querySelector('#detailPanel [data-action="toggle-favorite"]');
        const ok = Boolean(button) && button.getAttribute('aria-pressed') === 'true' && button.classList.contains('is-fav');
        if (ok && !detailFavSeenAt) detailFavSeenAt = Date.now();
        return ok;
      }, 'inspector favorite state follows the MCP metadata update', ${PAGE_WAIT_MS});
      await waitFor(() => {
        const chip = document.querySelector('#detailPanel .detail-tag[data-tag-value="' + config.tagValue + '"]');
        if (chip && !tagSeenAt) tagSeenAt = Date.now();
        return Boolean(chip);
      }, 'inspector shows the MCP-written tag chip', ${PAGE_WAIT_MS});
      await waitFor(() => {
        const ok = favoriteCount() === String(initialFavoriteCount + 1);
        if (ok && !favCountSeenAt) favCountSeenAt = Date.now();
        return ok;
      }, 'favorites sidebar count increments', ${PAGE_WAIT_MS});
      await waitFor(() => {
        const active = document.activeElement;
        const ok = active instanceof HTMLElement
          && active.getAttribute('data-action') === 'toggle-favorite'
          && document.querySelector('#detailPanel')?.contains(active);
        if (ok && !focusRestoredSeenAt) focusRestoredSeenAt = Date.now();
        return ok;
      }, 'focus returns to the re-rendered favorite button', 15000);
    } catch (error) {
      // Failure facts that make this segment's verdict self-explaining: the
      // write landed (API), the gallery followed (card star), the counts
      // followed (statsDirty) — only the open inspector stayed stale.
      const button = document.querySelector('#detailPanel [data-action="toggle-favorite"]');
      const fresh = await (await fetch('/api/assets/default/' + encodeURIComponent(config.metaAssetId), { headers: { 'x-mosa-client-token': config.clientToken } })).json();
      const active = document.activeElement;
      throw new Error(error.message + ' | sse=' + JSON.stringify(sse.sources.map((record) => ({ ready: record.source.readyState, changed: record.changedEvents })))
        + ' | favButton=' + JSON.stringify(button ? { pressed: button.getAttribute('aria-pressed'), fav: button.classList.contains('is-fav') } : null)
        + ' | apiFavorite=' + JSON.stringify(fresh?.asset?.favorite) + ' | apiTags=' + JSON.stringify(fresh?.asset?.tags)
        + ' | counts=' + allCount() + '/' + favoriteCount()
        + ' | cardFavStar=' + String(document.querySelector(cardSelector(config.metaAssetId) + ' .card-favorite')?.classList.contains('is-fav'))
        + ' | activeElement=' + JSON.stringify(active ? { tag: active.tagName, action: active.getAttribute?.('data-action'), inPanel: Boolean(document.querySelector('#detailPanel')?.contains(active)) } : null));
    }
    const cardFavStar = document.querySelector(cardSelector(config.metaAssetId) + ' .card-favorite')?.classList.contains('is-fav') || false;
  ${pageEpilogue(['detailFavSeenAt', 'tagSeenAt', 'favCountSeenAt', 'focusRestoredSeenAt', 'cardFavStar'])}`;
}

// Segment 3: MCP asset_archive — the card leaves the gallery, count drops.
function archiveSegmentSource(config) {
  return `${pagePrelude(config)}
    await markCanary(config.marker);
    let goneSeenAt = 0;
    await waitFor(() => {
      const gone = !document.querySelector(cardSelector(config.archiveAssetId));
      const countOk = allCount() === String(initialAllCount - 1);
      if (gone && countOk && !goneSeenAt) goneSeenAt = Date.now();
      return gone && countOk;
    }, 'archived card leaves the gallery and the all-assets count drops', ${PAGE_WAIT_MS});
  ${pageEpilogue(['goneSeenAt'])}`;
}

// Segment 4: the visibility fallback. While the page is hidden (real handler
// path, recorded stream provably closed), the MCP writer adds an asset. The
// card must NOT appear during the hidden phase (no live stream, no refresh),
// and must appear within the live budget after returning to the foreground.
function hiddenSegmentSource(config) {
  return `${pagePrelude(config)}
    // Hide again for the write phase: this time the close is provable, because
    // the app's current stream is the recorded one from the prelude dance.
    setFakeVisibility(true);
    await waitFor(() => sse.sources.length >= 1 && sse.sources.at(-1).source.readyState === 2, 'recorded live stream closed while hidden', 5000);
    await markCanary(config.marker1);
    // Node flips marker2 onto the canary once the MCP write has committed; the
    // hidden page polls the authenticated asset API for that rendezvous.
    await waitForAsync(async () => (await readCanaryPrompt()) === config.marker2, 'external write finished while hidden (marker2)', 60000);
    const absenceDeadline = Date.now() + 2000;
    while (Date.now() < absenceDeadline) {
      if (document.querySelector('.asset-card[data-id^="' + config.hiddenPrefix + '"]')) {
        throw new Error('the MCP-written card appeared while the page was hidden — the live stream was not actually stopped');
      }
      await waitTick(100);
    }
    setFakeVisibility(false);
    await waitFor(() => sse.sources.length >= 2 && sse.sources.at(-1).source.readyState === 1 && sse.sources.at(-1).readyAt > 0,
      'SSE stream reconnected on foreground return', 15000);
    let hiddenCardSeenAt = 0;
    await waitFor(() => {
      const card = document.querySelector('.asset-card[data-id^="' + config.hiddenPrefix + '"]');
      if (card && !hiddenCardSeenAt) hiddenCardSeenAt = Date.now();
      return Boolean(card);
    }, 'MCP-written card appears after returning to the foreground (visibility fallback refresh)', ${PAGE_WAIT_MS});
    // The asserted signal is the sidebar count after the foreground return. On a
    // timeout, also record what the server's navigation endpoint reports, so a
    // failure tells a stale server count apart from a UI that never re-rendered.
    let hiddenCountSeenAt = 0;
    try {
      await waitFor(() => {
        const ok = allCount() === String(initialAllCount + 1);
        if (ok && !hiddenCountSeenAt) hiddenCountSeenAt = Date.now();
        return ok;
      }, 'all-assets count increments after the foreground return', ${PAGE_WAIT_MS});
    } catch (error) {
      let serverNavigation = null;
      try {
        const response = await fetch('/api/navigation?project=default', { headers: { 'x-mosa-client-token': config.clientToken } });
        serverNavigation = { status: response.status, total: (await response.json())?.navigation?.total ?? null };
      } catch (fetchError) {
        serverNavigation = { error: String(fetchError?.message || fetchError) };
      }
      throw new Error(error.message + ' serverNavigation=' + JSON.stringify(serverNavigation)
        + ' uiAllCount=' + JSON.stringify(allCount()) + ' expected=' + (initialAllCount + 1));
    }
  ${pageEpilogue(['hiddenCardSeenAt', 'hiddenCountSeenAt'])}`;
}

// ===== Flow =====
export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  let mcp = null;
  let summary = null;
  try {
    // Seed through the app's own authenticated API: meta target, archive
    // target, and the handshake canary. All local-file source, so no sidebar
    // smart-group rows appear and the DOM stays deterministic.
    const createSeed = async (fileName, prompt) => {
      const body = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default",
        imagePath: await ctx.makePng(fileName, [74, 127, 181]),
        prompt,
      });
      assertOk(body?.asset?.id, `seed ${fileName} returned no asset id`);
      return body.asset.id;
    };
    const metaAssetId = await createSeed(META_FILE, META_PROMPT);
    const archiveAssetId = await createSeed(ARCHIVE_FILE, ARCHIVE_PROMPT);
    const canaryId = await createSeed(CANARY_FILE, CANARY_PROMPT);
    const baselineThree = [metaAssetId, archiveAssetId, canaryId];
    // Fixtures for the MCP-side writes must exist before any page starts, so
    // the measured window contains only the MCP call itself.
    const createImagePath = await ctx.makePng(CREATE_FILE, [138, 90, 47]);
    const hiddenImagePath = await ctx.makePng(HIDDEN_FILE, [96, 74, 155]);

    const workspaceDir = join(dirname(ctx.userDataDir), "mcp-writer-workspace");
    await mkdir(workspaceDir, { recursive: true });
    mcp = startMcpWriter(ctx, workspaceDir);
    await mcp.initialize();
    assertEqual((await mcp.callTool("asset_list", { projectId: "default", limit: 10 })).assets.length, 3,
      "MCP writer must see the three seeded assets through its own store connection");

    const clientToken = ctx.token;

    // ===== Segment 1: MCP asset_create -> live card + sidebar count =====
    const createPrefix = `live-sync-create-${stamp}-`;
    const createPage = runPageTrackingFailures(ctx, server, createSegmentSource({
      baselineIds: baselineThree,
      canaryId,
      clientToken,
      createPrefix,
      marker: marker("create"),
    }));
    await waitForMarker(ctx, server, canaryId, marker("create"), { failureRef: createPage.state });
    // Latency is measured from the moment the MCP call is issued (strictest
    // reading of "within 10s of the write"); the write duration itself is
    // reported separately.
    const createWriteAt = Date.now();
    const created = await mcp.callTool("asset_create", {
      projectId: "default",
      imagePath: createImagePath,
      prompt: `live-sync create push ${stamp}`,
    });
    const createWriteMs = Date.now() - createWriteAt;
    const createdAssetId = String(created?.asset?.id || "");
    assertOk(createdAssetId.startsWith(createPrefix), `MCP asset_create returned unexpected id ${createdAssetId} (wanted prefix ${createPrefix})`);
    assertOk(createWriteMs < 15_000, "MCP asset_create took implausibly long");
    const createResult = await createPage.promise;
    if (!createResult) throw createPage.state.failure || new Error("page returned a null result");
    assertEqual(createResult.sseUrl.includes("/api/library-events"), true, "recorded SSE endpoint");
    const createCardLatency = assertLiveLatency(createResult.cardSeenAt, createWriteAt, "segment 1: new card");
    const createCountLatency = assertLiveLatency(createResult.countSeenAt, createWriteAt, "segment 1: all-assets count");
    const createdViaApi = await ctx.api(server.origin, "GET", `/api/assets/default/${encodeURIComponent(createdAssetId)}`);
    assertEqual(createdViaApi?.asset?.id, createdAssetId, "MCP-created asset is listed by the assets API");
    const baselineFour = [...baselineThree, createdAssetId];

    // ===== Segment 2: MCP asset_update_metadata -> inspector + favorites count =====
    // A failure here (e.g. a product bug in the external-update inspector
    // refresh) must not hide the verdicts of segments 3 and 4: the error is
    // recorded and re-thrown after the whole flow ran.
    let segment2Error = null;
    let favLatency = 0;
    let tagLatency = 0;
    let favCountLatency = 0;
    try {
      const metadataPage = runPageTrackingFailures(ctx, server, metadataSegmentSource({
        baselineIds: baselineFour,
        canaryId,
        clientToken,
        metaAssetId,
        tagValue: TAG_VALUE,
        marker: marker("meta"),
      }));
      await waitForMarker(ctx, server, canaryId, marker("meta"), { failureRef: metadataPage.state });
      const metaWriteAt = Date.now();
      await mcp.callTool("asset_update_metadata", {
        projectId: "default",
        assetId: metaAssetId,
        favorite: true,
        tags: [TAG_VALUE],
      });
      const metadataResult = await metadataPage.promise;
      if (!metadataResult) throw metadataPage.state.failure || new Error("page returned a null result");
      favLatency = assertLiveLatency(metadataResult.detailFavSeenAt, metaWriteAt, "segment 2: inspector favorite state");
      tagLatency = assertLiveLatency(metadataResult.tagSeenAt, metaWriteAt, "segment 2: inspector tag chip");
      favCountLatency = assertLiveLatency(metadataResult.favCountSeenAt, metaWriteAt, "segment 2: favorites count");
      assertEqual(metadataResult.cardFavStar, true, "gallery card star reflects the external favorite");
    } catch (error) {
      segment2Error = error instanceof Error ? error : new Error(String(error));
    }
    const metaAfter = await ctx.api(server.origin, "GET", `/api/assets/default/${encodeURIComponent(metaAssetId)}`);
    assertEqual(metaAfter?.asset?.favorite, true, "asset favorite as stored");
    assertOk(JSON.stringify(metaAfter?.asset?.tags || []) === JSON.stringify([TAG_VALUE]),
      `asset tags as stored (got ${JSON.stringify(metaAfter?.asset?.tags)})`);

    // ===== Segment 3: MCP asset_archive -> card leaves + count drops =====
    const archivePage = runPageTrackingFailures(ctx, server, archiveSegmentSource({
      baselineIds: baselineFour,
      canaryId,
      clientToken,
      archiveAssetId,
      marker: marker("archive"),
    }));
    await waitForMarker(ctx, server, canaryId, marker("archive"), { failureRef: archivePage.state });
    const archiveWriteAt = Date.now();
    await mcp.callTool("asset_archive", { projectId: "default", assetId: archiveAssetId });
    const archiveResult = await archivePage.promise;
    if (!archiveResult) throw archivePage.state.failure || new Error("page returned a null result");
    const archiveLatency = assertLiveLatency(archiveResult.goneSeenAt, archiveWriteAt, "segment 3: archived card leaves the gallery");
    const archivedAfter = await ctx.api(server.origin, "GET", `/api/assets/default/${encodeURIComponent(archiveAssetId)}`);
    assertEqual(archivedAfter?.asset?.archived, true, "asset archived as stored");
    const baselineAfterArchive = baselineFour.filter((id) => id !== archiveAssetId);

    // ===== Segment 4: external write while hidden -> foreground fallback =====
    const hiddenPrefix = `live-sync-hidden-${stamp}-`;
    const hiddenPage = runPageTrackingFailures(ctx, server, hiddenSegmentSource({
      baselineIds: baselineAfterArchive,
      canaryId,
      clientToken,
      hiddenPrefix,
      marker1: marker("hidden-start"),
      marker2: marker("hidden-done"),
    }));
    await waitForMarker(ctx, server, canaryId, marker("hidden-start"), { failureRef: hiddenPage.state });
    const hiddenWriteAt = Date.now();
    const hiddenCreated = await mcp.callTool("asset_create", {
      projectId: "default",
      imagePath: hiddenImagePath,
      prompt: `live-sync hidden create ${stamp}`,
    });
    const hiddenAssetId = String(hiddenCreated?.asset?.id || "");
    assertOk(hiddenAssetId.startsWith(hiddenPrefix), `MCP hidden-phase asset_create returned unexpected id ${hiddenAssetId}`);
    // Rendezvous: the page stays hidden until the write has committed.
    await ctx.api(server.origin, "PATCH", `/api/assets/default/${encodeURIComponent(canaryId)}`, { prompt: marker("hidden-done") });
    const hiddenResult = await hiddenPage.promise;
    if (!hiddenResult) throw hiddenPage.state.failure || new Error("page returned a null result");
    assertEqual(hiddenResult.sseSourceCount >= 2, true, "a fresh SSE stream must be created on foreground return");
    const hiddenCardLatency = assertLiveLatency(hiddenResult.hiddenCardSeenAt, hiddenWriteAt, "segment 4: card after foreground return");
    const hiddenCountLatency = assertLiveLatency(hiddenResult.hiddenCountSeenAt, hiddenWriteAt, "segment 4: all-assets count after foreground return");

    const mcpExit = await mcp.stop();
    mcp = null;
    assertEqual(mcpExit, 0, "MCP writer exit code after stdin end");

    if (segment2Error) {
      throw new Error(
        `segment 2 (external metadata -> open inspector) failed and is kept failing on purpose; `
        + `the other segments still ran with these latencies: ${JSON.stringify({
          createCard: createCardLatency,
          createCount: createCountLatency,
          archiveGone: archiveLatency,
          hiddenCard: hiddenCardLatency,
          hiddenCount: hiddenCountLatency,
        })}; cause: ${segment2Error.message}`,
        { cause: segment2Error },
      );
    }

    summary = {
      initialVisibilityState: createResult.initialVisibilityState,
      sseEndpoint: createResult.sseUrl,
      latenciesMs: {
        createCard: createCardLatency,
        createCount: createCountLatency,
        favoriteState: favLatency,
        favoriteTag: tagLatency,
        favoriteCount: favCountLatency,
        archiveGone: archiveLatency,
        hiddenCard: hiddenCardLatency,
        hiddenCount: hiddenCountLatency,
      },
      writeDurationsMs: { create: createWriteMs },
      assets: { created: createdAssetId, hiddenCreated: hiddenAssetId, meta: metaAssetId, archived: archiveAssetId },
    };
  } finally {
    if (mcp) await mcp.stop();
    await server.stop();
  }
  return summary;
}
