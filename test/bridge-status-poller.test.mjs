import assert from "node:assert/strict";
import test from "node:test";
import { createBridgeStatusPoller } from "../app/bridge-status-poller.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Drives the poller with manually resolved fetches and a captured interval
 * callback, so concurrency, coalescing, and commit order are observed as real
 * behavior rather than asserted from source text.
 */
function createPollerHarness() {
  const fetches = [];
  const applied = [];
  const clearedHandles = [];
  let activeFetches = 0;
  let maxActiveFetches = 0;
  let intervalCalls = 0;
  let tick = null;
  const poller = createBridgeStatusPoller({
    fetchStatus: () => {
      activeFetches += 1;
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
      const request = deferred();
      fetches.push(request);
      return request.promise.finally(() => { activeFetches -= 1; });
    },
    onSuccess: (payload) => applied.push({ ok: true, payload }),
    onError: (error) => applied.push({ ok: false, error }),
    setInterval: (callback) => { intervalCalls += 1; tick = callback; return { id: intervalCalls }; },
    clearInterval: (handle) => { clearedHandles.push(handle); },
  });
  return {
    poller,
    fetches,
    applied,
    clearedHandles,
    fireTick: () => tick?.(),
    maxActiveFetches: () => maxActiveFetches,
    intervalCalls: () => intervalCalls,
  };
}

test("a slow request and a queued refresh never overlap, and the newest response wins", async () => {
  const harness = createPollerHarness();
  const firstRefresh = harness.poller.refresh();
  assert.equal(harness.fetches.length, 1, "first refresh issues one request");

  const queuedRefresh = harness.poller.refresh();
  assert.equal(harness.fetches.length, 1, "a refresh during a flight does not start a parallel request");

  harness.fetches[0].resolve({ marker: "older" });
  await flushMicrotasks();
  assert.equal(harness.fetches.length, 2, "the queued refresh issues exactly one follow-up request");
  assert.equal(harness.maxActiveFetches(), 1, "requests never run concurrently");

  harness.fetches[1].resolve({ marker: "newest" });
  await Promise.all([firstRefresh, queuedRefresh]);
  assert.deepEqual(harness.applied.map((entry) => entry.payload.marker), ["older", "newest"]);
  assert.equal(harness.applied.at(-1).payload.marker, "newest", "final committed state comes from the follow-up response");
});

test("repeated timer ticks during a flight coalesce into a single follow-up request", async () => {
  const harness = createPollerHarness();
  harness.poller.start();
  assert.equal(harness.intervalCalls(), 1);

  harness.fireTick();
  assert.equal(harness.fetches.length, 1);
  harness.fireTick();
  harness.fireTick();
  harness.fireTick();
  assert.equal(harness.fetches.length, 1, "ticks during a flight never pile up extra requests");

  harness.fetches[0].resolve({ tick: 1 });
  await flushMicrotasks();
  assert.equal(harness.fetches.length, 2, "coalesced ticks produce one follow-up");

  harness.fetches[1].resolve({ tick: 2 });
  await flushMicrotasks();
  assert.equal(harness.fetches.length, 2, "no backlog remains after the follow-up completes");
  assert.deepEqual(harness.applied.map((entry) => entry.payload.tick), [1, 2]);
  harness.poller.stop();
});

test("responses completing after page teardown never commit UI state", async () => {
  const harness = createPollerHarness();
  harness.poller.start();
  harness.fireTick();
  assert.equal(harness.fetches.length, 1);

  harness.poller.stop();
  assert.equal(harness.clearedHandles.length, 1, "the polling timer is cancelled on teardown");

  harness.fetches[0].resolve({ marker: "stale" });
  await flushMicrotasks();
  assert.equal(harness.applied.length, 0, "a late response is dropped after teardown");

  harness.fireTick();
  await harness.poller.refresh();
  assert.equal(harness.fetches.length, 1, "no further requests are issued after teardown");
});

test("a rejected request is reported through onError without rejecting the refresh promise", async () => {
  const harness = createPollerHarness();
  const failedRefresh = harness.poller.refresh();
  harness.fetches[0].reject(new Error("network down"));
  await failedRefresh;

  assert.equal(harness.applied.length, 1);
  assert.equal(harness.applied[0].ok, false);
  assert.match(harness.applied[0].error.message, /network down/);

  const recoveredRefresh = harness.poller.refresh();
  assert.equal(harness.fetches.length, 2, "polling recovers after a failure");
  harness.fetches[1].resolve({ healthy: true });
  await recoveredRefresh;
  assert.deepEqual(harness.applied[1], { ok: true, payload: { healthy: true } });
});

test("successful polls keep committing in order and start is idempotent", async () => {
  const harness = createPollerHarness();
  harness.poller.start();
  harness.poller.start();
  assert.equal(harness.intervalCalls(), 1, "repeated start calls keep a single timer");

  harness.fireTick();
  harness.fetches[0].resolve({ codex: { enabled: true } });
  await flushMicrotasks();
  harness.fireTick();
  harness.fetches[1].resolve({ codex: { enabled: false } });
  await flushMicrotasks();

  assert.deepEqual(harness.applied.map((entry) => entry.payload.codex.enabled), [true, false]);
  harness.poller.stop();
  assert.equal(harness.clearedHandles.length, 1);
});
