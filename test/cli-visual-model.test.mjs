import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createIsolatedCliEnv, runMosaCli } from "./helpers/cli-runner.mjs";

function manifestFor(bytes, sha256) {
  return {
    schema: "mosa.visual-model-pack/1",
    id: "siglip2-test",
    revision: "2026-09-18",
    model_type: "image-text-embedding",
    embedding_dimension: 768,
    license: {
      id: "apache-2.0",
      source: "https://example.invalid/license",
      commercial_product_use: true,
    },
    preprocessing: { image_size: 224 },
    files: [{ path: "model/model.bin", role: "model", bytes, sha256 }],
  };
}

test("visual-model-verify accepts a well-formed model pack with exit 0", async () => {
  const { root, env } = await createIsolatedCliEnv("mosa-cli-model-valid-");
  const packDir = join(root, "pack");
  await mkdir(join(packDir, "model"), { recursive: true });
  const payload = Buffer.from("verified local visual model bytes");
  const digest = createHash("sha256").update(payload).digest("hex");
  await writeFile(join(packDir, "model", "model.bin"), payload);
  await writeFile(join(packDir, "model-pack.json"), JSON.stringify(manifestFor(payload.length, digest), null, 2));

  const result = runMosaCli(["visual-model-verify", "--from", packDir], { env });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.id, "siglip2-test");
  assert.equal(report.files[0].sha256, digest);
});

test("visual-model-verify rejects a directory without a model pack manifest with exit 1", async () => {
  const { root, env } = await createIsolatedCliEnv("mosa-cli-model-invalid-");
  const packDir = join(root, "not-a-pack");
  await mkdir(packDir, { recursive: true });

  const result = runMosaCli(["visual-model-verify", "--from", packDir], { env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /model-pack\.json/);
  assert.equal(result.stdout, "");
});
