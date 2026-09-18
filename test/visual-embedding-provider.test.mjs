import assert from "node:assert/strict";
import test from "node:test";

import { createValidatedVisualEmbeddingProvider } from "../lib/visual-embedding-provider.mjs";

const MODEL = { id: "example/model", revision: "r1", dimension: 3 };

test("validated visual provider pins model identity and lazily starts once", async () => {
  let starts = 0;
  const provider = createValidatedVisualEmbeddingProvider({
    model: MODEL,
    provider: {
      model: MODEL,
      async start() { starts += 1; },
      async encodeImage() { return [1, 0, 0]; },
      async encodeText() { return [0, 1, 0]; },
    },
  });
  assert.deepEqual(Array.from(await provider.encodeImage("/tmp/a.png")), [1, 0, 0]);
  assert.deepEqual(Array.from(await provider.encodeText("  蓝色   人物 ")), [0, 1, 0]);
  assert.equal(starts, 1);
  assert.equal(provider.status().started, true);
});

test("validated visual provider rejects mismatched vector spaces and malformed outputs", async () => {
  assert.throws(() => createValidatedVisualEmbeddingProvider({
    model: MODEL,
    provider: {
      model: { ...MODEL, revision: "r2" },
      encodeImage() { return [1, 0, 0]; },
      encodeText() { return [0, 1, 0]; },
    },
  }), /does not match/);

  const provider = createValidatedVisualEmbeddingProvider({
    model: MODEL,
    provider: {
      encodeImage() { return [1, 0]; },
      encodeText() { return [0, 0, 0]; },
    },
  });
  await assert.rejects(() => provider.encodeImage("/tmp/a.png"), /wrong dimension/);
  await assert.rejects(() => provider.encodeText("query"), /all-zero/);
});

test("validated visual provider owns optional lifecycle cleanup", async () => {
  let closes = 0;
  const provider = createValidatedVisualEmbeddingProvider({
    model: MODEL,
    provider: {
      encodeImage() { return [1, 0, 0]; },
      encodeText() { return [0, 1, 0]; },
      async close() { closes += 1; },
    },
  });
  await provider.close();
  await provider.close();
  assert.equal(closes, 1);
  await assert.rejects(() => provider.encodeText("query"), /closed/);
});
