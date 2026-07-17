import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssetStore } from "../lib/asset-store.mjs";

test("imports a Codex default generated image and preserves its provenance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "asset-manager-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const codexImagesDir = join(root, ".codex", "generated_images");
  const taskId = "019f-codex-task";
  const sourcePath = join(codexImagesDir, taskId, "generated.png");
  await mkdir(join(codexImagesDir, taskId), { recursive: true });
  await writeFile(sourcePath, "fixture image", "utf8");

  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "asset-manager");
  const store = createAssetStore({ projectRoot, managerDir, codexImagesDir });
  const asset = await store.createAsset({
    projectId: "default",
    assetId: "codex-fixture",
    imagePath: sourcePath,
    prompt: "A verified Codex test image",
    source: { generation_tool: "imagegen", model: "gpt-5.6" }
  });

  assert.equal(asset.source.type, "codex-generated");
  assert.equal(asset.source.path, sourcePath);
  assert.equal(asset.source.codex_generated_images_root, codexImagesDir);
  assert.equal(asset.source.codex_task_id, taskId);
  assert.equal(asset.source.codex_relative_path, `${taskId}/generated.png`);
  assert.equal(asset.source.generation_tool, "imagegen");
  assert.equal(asset.source.model, "gpt-5.6");
  assert.match(asset.image_path, /asset-manager\/assets\/default\/images\/codex-fixture\.png$/);

  const storedMetadata = JSON.parse(await readFile(join(managerDir, "assets", "default", "metadata", "codex-fixture.json"), "utf8"));
  assert.equal(storedMetadata.source.path, sourcePath);
  assert.equal(storedMetadata.prompt, "A verified Codex test image");
});

test("continues to reject image paths outside approved source roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "asset-manager-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const outsidePath = join(root, "outside", "not-allowed.png");
  await mkdir(join(root, "outside"), { recursive: true });
  await writeFile(outsidePath, "fixture image", "utf8");

  const store = createAssetStore({
    projectRoot: join(root, "project"),
    managerDir: join(root, "project", "asset-manager"),
    codexImagesDir: join(root, ".codex", "generated_images")
  });

  await assert.rejects(store.createAsset({ imagePath: outsidePath }), /Refusing to import outside the project roots/);
});
