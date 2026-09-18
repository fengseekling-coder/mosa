import assert from "node:assert/strict";
import test from "node:test";

import {
  createVisualInferenceClient,
  VISUAL_INFERENCE_ERRORS,
} from "../lib/visual-inference-client.mjs";

const FAKE_WORKER = new URL("./fixtures/visual-inference-fake-worker.mjs", import.meta.url).pathname;

function fakeClient(mode, overrides = {}) {
  return createVisualInferenceClient({
    workerEntryPath: FAKE_WORKER,
    forkOptions: { args: [mode] },
    initTimeoutMs: 5_000,
    timeoutMs: 2_000,
    ...overrides,
  });
}

test("client completes the init handshake and reports the pinned model identity", async () => {
  const client = fakeClient("ok", { model: { id: "fake-model", revision: "r1", dimension: 4 } });
  try {
    const model = await client.start();
    assert.deepEqual(model, { id: "fake-model", revision: "r1", dimension: 4 });
    assert.equal(client.isReady(), true);
    assert.equal(client.state, "ready");
  } finally {
    await client.close();
  }
});

test("client round-trips encode requests with matching request and response ids", async () => {
  const client = fakeClient("ok");
  try {
    await client.start();
    const vector = await client.encodeText("hello", { projectId: "default" });
    assert.equal(vector.length, 4);
    assert.ok(vector.every((value) => Number.isFinite(value)));
    const again = await client.encodeText("hello", {});
    assert.deepEqual([...again], [...vector]);
  } finally {
    await client.close();
  }
});

test("client rejects requests beyond the bounded queue without dropping the worker", async () => {
  const client = fakeClient("slow", { maxQueue: 1 });
  try {
    await client.start();
    const first = client.encodeText("first", {});
    await assert.rejects(client.encodeText("second", {}), (error) => {
      assert.equal(error.code, VISUAL_INFERENCE_ERRORS.BUSY);
      return true;
    });
    // The queue is still full, so another request is rejected the same way.
    await assert.rejects(client.encodeText("third", {}), (error) => {
      assert.equal(error.code, VISUAL_INFERENCE_ERRORS.BUSY);
      return true;
    });
    // The queued request still completes once the worker answers.
    const vector = await first;
    assert.equal(vector.length, 4);
    assert.equal(client.isReady(), true);
  } finally {
    await client.close();
  }
});

test("client times out a hung request and fails closed by stopping the worker", async () => {
  const client = fakeClient("slow", { timeoutMs: 120 });
  try {
    await client.start();
    await assert.rejects(client.encodeText("slow query", {}), (error) => {
      assert.equal(error.code, VISUAL_INFERENCE_ERRORS.TIMEOUT);
      return true;
    });
    assert.equal(client.isReady(), false);
    await assert.rejects(client.encodeText("after timeout", {}), (error) => {
      assert.equal(error.code, VISUAL_INFERENCE_ERRORS.WORKER_EXIT);
      return true;
    });
  } finally {
    await client.close();
  }
});

test("worker crash rejects pending requests and restart() restores service", async () => {
  const client = fakeClient("crash-on-encode");
  try {
    await client.start();
    await assert.rejects(client.encodeImage("/tmp/whatever.png", {}), (error) => {
      assert.equal(error.code, VISUAL_INFERENCE_ERRORS.WORKER_EXIT);
      return true;
    });
    assert.equal(client.isReady(), false);
    await client.restart();
    // Text encodes never crash in this fixture, proving the restarted worker
    // serves requests again after the fail-closed window.
    const vector = await client.encodeText("recovered", {});
    assert.equal(vector.length, 4);
  } finally {
    await client.close();
  }
});

test("per-request failures are contained and the worker stays ready", async () => {
  const client = fakeClient("ok");
  try {
    await client.start();
    await assert.rejects(client.encodeImage("/tmp/broken.png", {}), (error) => {
      assert.equal(error.code, "VISUAL_IMAGE_DECODE_FAILED");
      return true;
    });
    assert.equal(client.isReady(), true);
    const vector = await client.encodeImage("/tmp/healthy.png", {});
    assert.equal(vector.length, 4);
  } finally {
    await client.close();
  }
});

test("client fails closed when the worker reports a different model identity", async () => {
  const client = fakeClient("wrong-identity", { model: { id: "expected-model", revision: "r1", dimension: 4 } });
  try {
    await assert.rejects(client.start(), (error) => {
      assert.equal(error.code, VISUAL_INFERENCE_ERRORS.IDENTITY_MISMATCH);
      return true;
    });
    assert.equal(client.isReady(), false);
  } finally {
    await client.close();
  }
});

test("close() shuts the worker down gracefully and rejects late requests", async () => {
  const client = fakeClient("ok");
  await client.start();
  await client.close();
  assert.equal(client.state, "dead");
  await assert.rejects(client.encodeText("late", {}), (error) => {
    assert.equal(error.code, VISUAL_INFERENCE_ERRORS.WORKER_EXIT);
    return true;
  });
});
