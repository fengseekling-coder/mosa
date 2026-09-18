import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  validateVisualModelPackManifest,
  verifyVisualModelPack,
  visualModelPackRoot,
} from "../lib/visual-model-pack.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

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

test("visual model pack manifest requires product-use licensing and safe relative files", () => {
  const digest = "a".repeat(64);
  const valid = validateVisualModelPackManifest(manifestFor(10, digest));
  assert.equal(valid.embedding_dimension, 768);
  assert.equal(valid.total_bytes, 10);
  assert.throws(() => validateVisualModelPackManifest({
    ...manifestFor(10, digest),
    license: { id: "research-only", source: "https://example.invalid", commercial_product_use: false },
  }), /product\/commercial use/);
  assert.throws(() => validateVisualModelPackManifest({
    ...manifestFor(10, digest),
    files: [{ path: "../model.bin", role: "model", bytes: 10, sha256: digest }],
  }), /traversal|relative/);
});

test("visual model pack verifier checks bytes and hashes without allowing symlink substitution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-model-pack-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  await mkdir(join(root, "model"), { recursive: true });
  const payload = Buffer.from("verified local visual model bytes");
  const digest = createHash("sha256").update(payload).digest("hex");
  await writeFile(join(root, "model", "model.bin"), payload);
  await writeFile(join(root, "model-pack.json"), JSON.stringify(manifestFor(payload.length, digest), null, 2));
  const verified = await verifyVisualModelPack({ packDir: root });
  assert.equal(verified.ok, true);
  assert.equal(verified.files[0].sha256, digest);

  await writeFile(join(root, "model", "model.bin"), Buffer.from("tampered"));
  await assert.rejects(() => verifyVisualModelPack({ packDir: root }), /size mismatch|hash mismatch/);

  await writeFile(join(root, "model", "model.bin"), payload);
  await writeFile(join(root, "target.bin"), payload);
  await symlink(join(root, "target.bin"), join(root, "model", "linked.bin"));
  const symlinkManifest = manifestFor(payload.length, digest);
  symlinkManifest.files[0].path = "model/linked.bin";
  await writeFile(join(root, "model-pack.json"), JSON.stringify(symlinkManifest, null, 2));
  await assert.rejects(() => verifyVisualModelPack({ packDir: root }), /symbolic links/);
});

test("visual model pack root lives under desktop userData, not the asset library", () => {
  assert.equal(visualModelPackRoot("/tmp/mosa-user-data"), "/tmp/mosa-user-data/visual-model-packs");
  assert.throws(() => visualModelPackRoot(""), /userData/);
});
