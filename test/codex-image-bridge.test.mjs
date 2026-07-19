import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssetStore } from "../lib/asset-store.mjs";
import { createCodexImageBridge, reconcileCodexGeneratedImages } from "../lib/codex-image-bridge.mjs";

test("archives Codex generated images with task metadata and avoids duplicates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const taskId = "019f776f-f6d5-7692-b9e5-dd280fc09f04";
  const imagePath = join(imagesDir, taskId, "exec-test.png");
  const sessionPath = join(sessionsDir, "2026", "07", "18", `rollout-test-${taskId}.jsonl`);
  await mkdir(join(imagesDir, taskId), { recursive: true });
  await mkdir(join(sessionsDir, "2026", "07", "18"), { recursive: true });
  await writeFile(imagePath, pngFixture(1024, 1536));
  const revisedPrompt = "Use case: stylized-concept\nAsset type: premium sci-fi keyframe, 2:3 portrait\nPrimary request: Build a luminous vertical megacity with rain and suspended transit rings.";
  await writeFile(sessionPath, `${JSON.stringify({
    type: "turn_context",
    payload: { model: "gpt-5.6-terra" },
  })}\n${JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "生成五张高级艺术视觉图，2:3" }] },
  })}\n${JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-18T22:55:27.133Z",
    payload: { type: "image_generation_end", call_id: "exec-test", saved_path: imagePath, revised_prompt: revisedPrompt },
  })}\n`);

  const store = createAssetStore({ projectRoot, managerDir, codexImagesDir: imagesDir });
  const first = await reconcileCodexGeneratedImages({ store, imagesDir, sessionsDir });
  assert.equal(first.imported.length, 1);
  assert.equal(first.imported[0].source.type, "codex-generated");
  assert.equal(first.imported[0].source.codex_task_id, taskId);
  assert.equal(first.imported[0].prompt, revisedPrompt);
  assert.equal(first.imported[0].source.prompt_status, "image-generation-revised-prompt");
  assert.equal(first.imported[0].source.codex_image_generation_call_id, "exec-test");
  assert.equal(first.imported[0].source.model, "gpt-5.6-terra");
  assert.equal(first.imported[0].ratio, "2:3");
  assert.equal(first.imported[0].business_fields.width, 1024);
  assert.match(first.imported[0].source.content_sha256, /^[a-f0-9]{64}$/);

  const second = await reconcileCodexGeneratedImages({ store, imagesDir, sessionsDir });
  assert.equal(second.imported.length, 0);
  assert.equal(second.skipped[0].reason, "already-archived");
});

test("upgrades an archived task instruction to the matching image generation prompt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const taskId = "019f776f-f6d5-7692-b9e5-dd280fc09f06";
  const imagePath = join(imagesDir, taskId, "exec-upgrade.png");
  const sessionPath = join(sessionsDir, "2026", "07", "18", `rollout-test-${taskId}.jsonl`);
  await mkdir(join(imagesDir, taskId), { recursive: true });
  await mkdir(join(sessionsDir, "2026", "07", "18"), { recursive: true });
  await writeFile(imagePath, pngFixture(768, 1024));
  await writeFile(sessionPath, `${JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "生成一张科幻图" }] },
  })}\n`);

  const store = createAssetStore({ projectRoot, managerDir, codexImagesDir: imagesDir });
  await reconcileCodexGeneratedImages({ store, imagesDir, sessionsDir });
  const [fallbackAsset] = await store.listAssets({ projectId: "default" });
  assert.equal(fallbackAsset.source.prompt_status, "task-user-prompt");

  const revisedPrompt = "Use case: stylized-concept\nAsset type: alien observatory, 3:4 portrait\nPrimary request: Create a luminous ancient observatory above a cloud ocean.";
  await appendFile(sessionPath, `${JSON.stringify({
    type: "turn_context",
    payload: { model: "gpt-5.6-terra" },
  })}\n${JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-18T22:55:27.133Z",
    payload: { type: "image_generation_end", call_id: "exec-upgrade", saved_path: imagePath, revised_prompt: revisedPrompt },
  })}\n`);
  const second = await reconcileCodexGeneratedImages({ store, imagesDir, sessionsDir });
  assert.deepEqual(second.updated, [fallbackAsset.id]);
  const upgraded = await store.getAsset("default", fallbackAsset.id);
  assert.equal(upgraded.prompt, revisedPrompt);
  assert.equal(upgraded.source.prompt_status, "image-generation-revised-prompt");
  assert.equal(upgraded.source.model, "gpt-5.6-terra");
});

test("watches a later Codex image and stores fallback metadata when no session is available", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const imagesDir = join(root, "generated_images");
  const taskId = "019f776f-f6d5-7692-b9e5-dd280fc09f05";
  const store = createAssetStore({ projectRoot, managerDir, codexImagesDir: imagesDir });
  const bridge = createCodexImageBridge({ store, imagesDir, sessionsDir: join(root, "sessions"), debounceMs: 10, pollIntervalMs: 100 });
  t.after(() => bridge.stop());
  await bridge.start();

  await mkdir(join(imagesDir, taskId), { recursive: true });
  await writeFile(join(imagesDir, taskId, "watch.png"), pngFixture(800, 800));
  await waitFor(() => bridge.status().totalImported === 1);
  const [asset] = await store.listAssets({ projectId: "default" });
  assert.equal(asset.source.codex_task_id, taskId);
  assert.equal(asset.source.prompt_status, "not-available");
  assert.equal(asset.ratio, "1:1");
});

function pngFixture(width, height) {
  const image = Buffer.alloc(24);
  image.write("\x89PNG\r\n\x1a\n", 0, "binary");
  image.writeUInt32BE(width, 16);
  image.writeUInt32BE(height, 20);
  return image;
}

async function waitFor(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Codex image bridge.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
