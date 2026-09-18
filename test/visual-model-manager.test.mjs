import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createVisualModelManager } from "../desktop/visual-model-manager.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

function pack(id = "model-a", revision = "r1") {
  return {
    id,
    revision,
    embedding_dimension: 512,
    total_bytes: 123,
    license: { id: "apache-2.0", source: "https://example.invalid", commercial_product_use: true },
    pack_dir: "/tmp/" + id,
  };
}

test("visual model manager reports MOSA-local not-installed state without an external daemon", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-visual-manager-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const manager = createVisualModelManager({
    userDataDir: root,
    discoverPacks: async () => ({ root: join(root, "visual-model-packs"), packs: [], invalid: [] }),
  });
  const state = await manager.state();
  assert.equal(state.mode, "mosa-local");
  assert.equal(state.state, "not-installed");
  assert.equal(state.installed, false);
  assert.equal(state.enabled, false);
});

test("visual model manager persists enablement and keeps runtime readiness separate from installation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-visual-manager-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const discoverPacks = async () => ({ root: join(root, "visual-model-packs"), packs: [pack()], invalid: [] });
  const manager = createVisualModelManager({ userDataDir: root, runtimeAvailable: false, discoverPacks });
  assert.equal((await manager.state()).state, "disabled");
  const enabled = await manager.setEnabled(true);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.state, "runtime-unavailable");

  const reopened = createVisualModelManager({ userDataDir: root, runtimeAvailable: true, discoverPacks });
  assert.equal((await reopened.state()).state, "ready");
});

test("visual model manager measures runtime readiness through the injected probe", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-visual-manager-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const discoverPacks = async () => ({ root: join(root, "visual-model-packs"), packs: [pack()], invalid: [] });
  const manager = createVisualModelManager({
    userDataDir: root,
    discoverPacks,
    probeRuntime: async () => ({ ok: true }),
  });
  await manager.setEnabled(true);
  const ready = await manager.state({ refresh: true });
  assert.equal(ready.state, "ready");
  assert.equal(ready.runtime_available, true);
  assert.deepEqual(ready.probe, { ok: true, reason: null, message: null });

  const failing = createVisualModelManager({
    userDataDir: root,
    discoverPacks,
    probeRuntime: async () => ({ ok: false, reason: "runtime-unavailable", message: "onnxruntime-node failed to load" }),
  });
  const unavailable = await failing.state({ refresh: true });
  assert.equal(unavailable.state, "runtime-unavailable");
  assert.equal(unavailable.runtime_available, false);
  assert.equal(unavailable.probe.reason, "runtime-unavailable");

  const broken = createVisualModelManager({
    userDataDir: root,
    discoverPacks,
    probeRuntime: async () => ({ ok: false, reason: "error", message: "pack identity mismatch" }),
  });
  const errored = await broken.state({ refresh: true });
  assert.equal(errored.state, "error");
});

test("visual model manager keeps the disabled state ahead of the probe", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-visual-manager-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const discoverPacks = async () => ({ root: join(root, "visual-model-packs"), packs: [pack()], invalid: [] });
  let probeCalls = 0;
  const manager = createVisualModelManager({
    userDataDir: root,
    discoverPacks,
    probeRuntime: async () => {
      probeCalls += 1;
      return { ok: true };
    },
  });
  const disabled = await manager.state();
  assert.equal(disabled.state, "disabled");
  assert.equal(probeCalls, 0);
  assert.equal(disabled.probe, null);
});

test("visual model manager exposes the runtime config consumed by the service", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-visual-manager-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const discoverPacks = async () => ({ root: join(root, "visual-model-packs"), packs: [pack("model-a", "r1")], invalid: [] });
  const manager = createVisualModelManager({
    userDataDir: root,
    discoverPacks,
    probeRuntime: async () => ({ ok: true }),
  });
  const off = await manager.runtimeConfig();
  assert.deepEqual(off, { enabled: false, active_pack_id: "model-a", active_revision: "r1" });
  await manager.setEnabled(true);
  const on = await manager.runtimeConfig();
  assert.deepEqual(on, { enabled: true, active_pack_id: "model-a", active_revision: "r1" });
});

test("visual model manager selects only verified discovered packs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-visual-manager-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const manager = createVisualModelManager({
    userDataDir: root,
    discoverPacks: async () => ({
      root: join(root, "visual-model-packs"),
      packs: [pack("model-a", "r1"), pack("model-b", "r2")],
      invalid: [{ directory: "broken", code: "INVALID", message: "bad pack" }],
    }),
  });
  const selected = await manager.selectPack("model-b", "r2");
  assert.equal(selected.active_pack.id, "model-b");
  await assert.rejects(() => manager.selectPack("missing", "r1"), /not installed|failed verification/);
});
