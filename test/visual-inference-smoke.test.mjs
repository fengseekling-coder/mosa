// Real-inference smoke test. Skipped unless MOSA_VISUAL_SMOKE_PACK points at
// a verified model pack directory, e.g.:
//   MOSA_VISUAL_SMOKE_PACK="$HOME/Library/Application Support/mosa/visual-model-packs/siglip2-base-patch16-224" \
//     node --import ./test/clean-test-env.mjs --test test/visual-inference-smoke.test.mjs
// Synthetic test images are generated in-memory with sharp so no binary
// fixtures and no network access are required; the near-duplicate assertion
// re-encodes the identical pixels, which any working image-text embedding
// model must score above the near-duplicate threshold.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createVisualInferenceClient } from "../lib/visual-inference-client.mjs";
import { verifyVisualModelPack } from "../lib/visual-model-pack.mjs";
import { createVisualRelationshipIndex } from "../lib/visual-relationship-index.mjs";
import { createValidatedVisualEmbeddingProvider } from "../lib/visual-embedding-provider.mjs";

const packDir = process.env.MOSA_VISUAL_SMOKE_PACK || "";

async function syntheticImage(sharp, fill, accent) {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320">
       <rect width="320" height="320" fill="${fill}"/>
       <circle cx="160" cy="160" r="90" fill="${accent}"/>
     </svg>`,
  );
  return sharp(svg).png().toBuffer();
}

test("visual inference smoke: real worker encodes, searches, and finds near-duplicates", { skip: !packDir }, async () => {
  const sharp = (await import("sharp")).default;
  const tempDir = await mkdtemp(join(tmpdir(), "mosa-visual-smoke-"));
  const verified = await verifyVisualModelPack({ packDir });
  assert.equal(verified.ok, true);
  const model = { id: verified.id, revision: verified.revision, dimension: verified.embedding_dimension };
  const client = createVisualInferenceClient({ pack: verified, model, maxQueue: 4, timeoutMs: 120_000, initTimeoutMs: 120_000 });
  try {
    const ready = await client.start();
    assert.equal(ready.dimension, verified.embedding_dimension);

    const red = join(tempDir, "red.png");
    const blue = join(tempDir, "blue.png");
    await writeFile(red, await syntheticImage(sharp, "#d0d0d0", "#cc2222"));
    await writeFile(blue, await syntheticImage(sharp, "#d0d0d0", "#2255cc"));
    await assert.rejects(client.encodeImage("/tmp/definitely-missing-image.png", {}),
      (error) => typeof error.code === "string");

    const redVector = await client.encodeImage(red, {});
    const blueVector = await client.encodeImage(blue, {});
    assert.equal(redVector.length, verified.embedding_dimension);
    assert.ok(redVector.every((value) => Number.isFinite(value)));
    assert.notEqual(redVector[0], blueVector[0]);

    // Deterministic encoding for identical input.
    const redAgain = await client.encodeImage(red, {});
    let maxDiff = 0;
    for (let i = 0; i < redVector.length; i += 1) maxDiff = Math.max(maxDiff, Math.abs(redVector[i] - redAgain[i]));
    assert.equal(maxDiff, 0);

    const textVector = await client.encodeText("a red circle on a light background", {});
    assert.equal(textVector.length, verified.embedding_dimension);
    const textAgain = await client.encodeText("a red circle on a light background", {});
    let textDiff = 0;
    for (let i = 0; i < textVector.length; i += 1) textDiff = Math.max(textDiff, Math.abs(textVector[i] - textAgain[i]));
    assert.equal(textDiff, 0);

    // Twin-asset retrieval: the same pixels under a second asset id must be
    // the top near-duplicate neighbor at effectively perfect similarity.
    const provider = createValidatedVisualEmbeddingProvider({
      provider: {
        model,
        encodeImage: (path) => client.encodeImage(path, {}),
        encodeText: (text) => client.encodeText(text, {}),
      },
      model,
    });
    const index = createVisualRelationshipIndex({ databasePath: ":memory:" });
    index.upsertEmbedding("default", "asset-red", { ...model, contentSha256: "a".repeat(64), vector: redVector });
    index.upsertEmbedding("default", "asset-red-twin", { ...model, contentSha256: "a".repeat(64), vector: redVector });
    index.upsertEmbedding("default", "asset-blue", { ...model, contentSha256: "b".repeat(64), vector: blueVector });
    const similar = index.similarToAsset("default", "asset-red", { ...model, limit: 3 });
    assert.equal(similar[0].asset_id, "asset-red-twin");
    assert.ok(Number(similar[0].score) >= 0.985);
    // Cross-modal search executes against real text and image vectors.
    const hits = index.querySimilar("default", textVector, { ...model, limit: 3 });
    assert.equal(hits.length, 3);
    assert.ok(Number.isFinite(Number(hits[0].score)));
    index.close();
  } finally {
    await client.close();
  }
});
