import assert from "node:assert/strict";
import test from "node:test";
import { createDerivativeWorker } from "../lib/derivative-worker.js";

test("derivative worker stop waits for active work to drain", async () => {
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
