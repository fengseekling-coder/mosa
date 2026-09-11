import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createDerivativeProcessor, processDerivativeJob } from "../lib/derivative-worker.js";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

async function makeJob(root, id) {
  const originalPath = join(root, `${id}.png`);
  await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toFile(originalPath);
  return {
    project_id: "default",
    asset_id: id,
    original_path: originalPath,
    previewPath: join(root, "previews", `${id}.webp`),
    mediumPath: join(root, "mediums", `${id}.webp`),
    thumbnailPath: join(root, "thumbnails", `${id}.webp`),
  };
}

function fakeStore() {
  const completions = [];
  return {
    completions,
    async completeDerivativeJob(_job, result) { completions.push(result); },
    async isAssetActive() { return true; },
  };
}

test("native image decoding runs outside the MOSA runtime process", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-isolation-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const store = fakeStore();
  const result = await processDerivativeJob(store, await makeJob(root, "isolated"));

  assert.equal(result.ok, true);
  assert.equal(Number.isInteger(result.processorPid), true);
  assert.notEqual(result.processorPid, process.pid);
});

test("processor crash rejects current work and the processor can restart cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-restart-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const processor = createDerivativeProcessor();
  const store = fakeStore();

  try {
    const first = await processDerivativeJob(store, await makeJob(root, "first"), { processor });
    assert.equal(first.ok, true);
    const firstPid = processor.pid;
    assert.ok(firstPid && firstPid !== process.pid);

    process.kill(firstPid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = await processDerivativeJob(store, await makeJob(root, "second"), { processor });
    assert.equal(second.ok, true);
    assert.ok(processor.pid && processor.pid !== firstPid);
    assert.notEqual(second.processorPid, firstPid);
  } finally {
    await processor.close();
  }
});
