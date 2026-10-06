import assert from "node:assert/strict";
import test from "node:test";
import { createDerivativeWorker } from "../lib/derivative-worker.js";

const BUSY_ERROR = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });

const JOB = {
  project_id: "default",
  asset_id: "video",
  original_path: "/tmp/video.mp4",
  previewPath: "/tmp/video-preview.webp",
  mediumPath: "/tmp/video-medium.webp",
  thumbnailPath: "/tmp/video-thumb.webp",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 5000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(stepMs);
  }
  throw new Error("waitFor timed out");
}

test("derivative worker stop waits for active work to drain", async (t) => {
  let releaseJob;
  let completeCalls = 0;
  let claims = 0;
  const jobGate = new Promise((resolve) => { releaseJob = resolve; });
  const store = {
    derivativesAvailable: true,
    async claimDerivativeJob() {
      claims += 1;
      if (claims > 1) return null;
      return {
        project_id: "default",
        asset_id: "video",
        original_path: "/tmp/video.mp4",
        previewPath: "/tmp/video-preview.webp",
        mediumPath: "/tmp/video-medium.webp",
        thumbnailPath: "/tmp/video-thumb.webp",
      };
    },
    async isAssetActive() {
      await jobGate;
      return true;
    },
    async completeDerivativeJob() {
      completeCalls += 1;
    },
  };
  const worker = createDerivativeWorker({ store, idleDelayMs: 250 });
  worker.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(worker.active, 1);

  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stopped, false);
  releaseJob();
  await stopping;

  assert.equal(worker.active, 0);
  assert.equal(completeCalls, 1);
});

test("derivative worker survives a failed claim and keeps processing without unhandled rejection", async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  let claims = 0;
  let completeCalls = 0;
  let releaseJob;
  const jobGate = new Promise((resolve) => { releaseJob = resolve; });
  const store = {
    derivativesAvailable: true,
    async claimDerivativeJob() {
      claims += 1;
      if (claims === 1) throw BUSY_ERROR;
      if (claims === 2) return { ...JOB };
      return null;
    },
    async isAssetActive() {
      await jobGate;
      return true;
    },
    async completeDerivativeJob() {
      completeCalls += 1;
    },
  };
  const worker = createDerivativeWorker({ store, idleDelayMs: 250 });
  worker.start();

  // The first claim throws SQLITE_BUSY-style; the retry must happen via the
  // idle timer, not crash the process through an unhandled rejection.
  await waitFor(() => claims >= 2 && worker.active === 1);
  assert.equal(completeCalls, 0);
  releaseJob();
  await waitFor(() => completeCalls === 1);

  // Let the post-completion schedule run and reach its idle timer, then stop.
  await sleep(300);
  await worker.stop();
  const claimsAtStop = claims;
  await sleep(700);
  assert.equal(unhandled.length, 0, `unhandled rejections observed: ${unhandled.map((error) => String(error?.message || error)).join("; ")}`);
  assert.equal(claims, claimsAtStop, "stop() must end claim retries");
});

test("derivative worker backs off exponentially on consecutive claim failures and caps the delay", async (t) => {
  let claims = 0;
  const claimTimes = [];
  const store = {
    derivativesAvailable: true,
    async claimDerivativeJob() {
      claims += 1;
      claimTimes.push(Date.now());
      throw BUSY_ERROR;
    },
    async completeDerivativeJob() {},
  };
  // The worker floors idleDelayMs at 250ms, so the observable backoff ladder
  // is 250 → 500 → capped at 500.
  const worker = createDerivativeWorker({ store, idleDelayMs: 250, maxClaimBackoffMs: 500 });
  worker.start();

  // Expected retry gaps: 250, 500, 500 (capped), 500 — five claims total.
  await waitFor(() => claims >= 5);
  await worker.stop();
  const claimsAtStop = claims;
  await sleep(600);
  assert.equal(claims, claimsAtStop, "stop() must end claim retries");

  const gaps = [];
  for (let index = 1; index < Math.min(claimTimes.length, 5); index += 1) {
    gaps.push(claimTimes[index] - claimTimes[index - 1]);
  }
  const expected = [250, 500, 500, 500];
  assert.equal(gaps.length, expected.length);
  for (let index = 0; index < gaps.length; index += 1) {
    // setTimeout never fires early; allow generous scheduler latency on top.
    assert.ok(gaps[index] >= expected[index] * 0.8, `gap ${index} (${gaps[index]}ms) must be at least ~${expected[index]}ms`);
    assert.ok(gaps[index] <= expected[index] + 500, `gap ${index} (${gaps[index]}ms) must be near ${expected[index]}ms`);
  }
  assert.ok(gaps[1] > gaps[0] * 1.5, `backoff must roughly double between the first two retries (gaps: ${gaps.join(", ")}ms)`);
  assert.ok(Math.abs(gaps[2] - expected[2]) <= 250 && Math.abs(gaps[3] - gaps[2]) <= 250, `gaps must plateau at the cap (gaps: ${gaps.join(", ")}ms)`);
});
