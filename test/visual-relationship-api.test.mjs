import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

async function startRuntime(t, suffix, visualRelationshipService = null) {
  const root = await mkdtemp(join(tmpdir(), suffix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: root,
    libraryDir: join(root, "library"),
    assetsRoot: join(root, "assets"),
    generatedImagesDir: join(root, "generated-images"),
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart"),
    cowartRegistryPath: join(root, "state", "cowart.json"),
    visualRelationshipService,
  });
  t.after(() => runtime.stop());
  return runtime;
}

test("visual status is a stable no-model contract instead of a runtime error", async (t) => {
  const runtime = await startRuntime(t, "mosa-visual-api-off-");
  const status = await fetch(runtime.url + "/api/visual/status");
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { visual: { available: false, reason: "model-not-configured" } });
  const similar = await fetch(runtime.url + "/api/visual/assets/example/similar");
  assert.equal(similar.status, 409);
  assert.equal((await similar.json()).code, "VISUAL_RELATIONSHIPS_UNAVAILABLE");
});

test("visual API delegates similarity and derived-index cleanup to the configured provider-neutral service", async (t) => {
  const calls = [];
  const service = {
    model: { id: "example/model", revision: "r1", dimension: 512 },
    async status(projectId) { calls.push(["status", projectId]); return { available: true, index: { count: 3 } }; },
    async similarAssets(projectId, assetId, options) {
      calls.push(["similar", projectId, assetId, options]);
      return [{ asset_id: "neighbor", score: 0.93, model_id: "example/model", model_revision: "r1" }];
    },
    async relationshipCandidates(projectId, assetId, options) {
      calls.push(["candidates", projectId, assetId, options]);
      return [{
        asset_id: "neighbor",
        score: 0.93,
        kinds: ["stack_candidate"],
        evidence: { source: "visual_embedding_similarity" },
      }];
    },
    async clear(projectId) { calls.push(["clear", projectId]); return 3; },
  };
  const runtime = await startRuntime(t, "mosa-visual-api-on-", service);
  const status = await (await fetch(runtime.url + "/api/visual/status?project=project-a")).json();
  assert.equal(status.visual.available, true);
  assert.equal(status.visual.index.count, 3);
  const similarResponse = await fetch(runtime.url + "/api/visual/assets/anchor/similar?project=project-a&limit=7&minScore=0.8");
  assert.equal(similarResponse.status, 200);
  const similar = await similarResponse.json();
  assert.deepEqual(similar.model, service.model);
  assert.deepEqual(similar.similar.map((item) => item.asset_id), ["neighbor"]);
  const candidateResponse = await fetch(runtime.url + "/api/visual/assets/anchor/candidates?project=project-a&limit=9&minScore=0.7");
  assert.equal(candidateResponse.status, 200);
  const candidates = await candidateResponse.json();
  assert.deepEqual(candidates.candidates[0].kinds, ["stack_candidate"]);
  const cleared = await fetch(runtime.url + "/api/visual/index?project=project-a", { method: "DELETE" });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).removed, 3);
  assert.deepEqual(calls, [
    ["status", "project-a"],
    ["similar", "project-a", "anchor", { limit: 7, minScore: 0.8 }],
    ["candidates", "project-a", "anchor", { limit: 9, minScore: 0.7 }],
    ["clear", "project-a"],
  ]);
});

test("visual API rejects malformed similarity controls before they reach a provider", async (t) => {
  const service = {
    model: { id: "example/model", revision: "r1", dimension: 512 },
    status() { return { available: true, index: { count: 0 } }; },
    similarAssets() { throw new Error("should not run"); },
    clear() { return 0; },
  };
  const runtime = await startRuntime(t, "mosa-visual-api-invalid-", service);
  assert.equal((await fetch(runtime.url + "/api/visual/assets/a/similar?limit=nope")).status, 400);
  assert.equal((await fetch(runtime.url + "/api/visual/assets/a/similar?minScore=2")).status, 400);
});
