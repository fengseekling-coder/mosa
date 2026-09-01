import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { removeTestPath as rm } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startMosaRuntime } from "../lib/mosa-runtime.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

async function startStackRuntime(t) {
  const root = await mkdtemp(join(tmpdir(), "mosa-stack-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generated = join(root, "generated-images");
  await mkdir(generated, { recursive: true });
  for (const id of ["a", "b", "c"]) await writeFile(join(generated, `${id}.png`), ONE_PIXEL_PNG);

  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: root,
    libraryDir: join(root, "library"),
    generatedImagesDir: generated,
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-data"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
  });
  t.after(() => runtime.stop());
  assert.equal(runtime.storage, "sqlite");

  const create = async (id, extra = {}) => {
    const response = await fetch(`${runtime.url}/api/assets/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "default",
        assetId: id,
        imagePath: join(generated, `${id}.png`),
        prompt: `prompt ${id}`,
        ...extra,
      }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).asset;
  };
  return { runtime, create };
}

test("Stack API keeps raw assets complete while gallery view collapses to one logical node", async (t) => {
  const { runtime, create } = await startStackRuntime(t);
  await create("a", { source: { type: "web-chatgpt" } });
  await create("b", { source: { type: "web-flow", media_kind: "video" }, favorite: true, prompt: "hidden needle" });
  await create("c", { source: { type: "local-file" } });

  const stacked = await fetch(`${runtime.url}/api/asset-stacks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "default", assetIds: ["a", "b"], coverAssetId: "a" }),
  });
  assert.equal(stacked.status, 201);
  const stack = (await stacked.json()).stack;
  assert.equal(stack.count, 2);

  const stackPageOne = await (await fetch(`${runtime.url}/api/asset-stacks/${encodeURIComponent(stack.id)}/assets?project=default&limit=1`)).json();
  assert.deepEqual(stackPageOne.assets.map((asset) => asset.id), ["a"]);
  assert.equal(stackPageOne.page.total, 2);
  assert.equal(typeof stackPageOne.page.nextCursor, "string");
  const stackPageTwo = await (await fetch(`${runtime.url}/api/asset-stacks/${encodeURIComponent(stack.id)}/assets?project=default&limit=1&cursor=${encodeURIComponent(stackPageOne.page.nextCursor)}`)).json();
  assert.deepEqual(stackPageTwo.assets.map((asset) => asset.id), ["b"]);
  assert.equal(stackPageTwo.page.nextCursor, null);

  const raw = await (await fetch(`${runtime.url}/api/assets?project=default&limit=100`)).json();
  assert.deepEqual(raw.assets.map((asset) => asset.id).sort(), ["a", "b", "c"]);

  const gallery = await (await fetch(`${runtime.url}/api/assets?project=default&view=gallery&limit=100`)).json();
  assert.deepEqual(gallery.assets.map((asset) => asset.id).sort(), ["a", "c"]);
  assert.deepEqual(gallery.assets.find((asset) => asset.id === "a").stack, { id: stack.id, count: 2 });

  for (const query of [
    "view=gallery&source=web-flow",
    "view=gallery&favorite=1",
    "view=gallery&mediaKind=video",
    "view=gallery&q=hidden%20needle",
  ]) {
    const result = await (await fetch(`${runtime.url}/api/assets?project=default&limit=100&${query}`)).json();
    assert.deepEqual(result.assets.map((asset) => asset.id), ["a"]);
    assert.deepEqual(result.assets[0].stack, { id: stack.id, count: 2, match_count: 1 });
    assert.equal(result.page.total, 1);
  }

  const inside = await (await fetch(`${runtime.url}/api/asset-stacks/${encodeURIComponent(stack.id)}/assets?project=default&q=hidden%20needle`)).json();
  assert.deepEqual(inside.assets.map((asset) => asset.id), ["b"]);

  const dissolved = await fetch(`${runtime.url}/api/asset-stacks/${encodeURIComponent(stack.id)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "default" }),
  });
  assert.equal(dissolved.status, 200);
  assert.deepEqual((await dissolved.json()).assetIds, ["a", "b"]);
  const afterDissolve = await (await fetch(`${runtime.url}/api/assets?project=default&view=gallery&limit=100`)).json();
  assert.deepEqual(afterDissolve.assets.map((asset) => asset.id).sort(), ["a", "b", "c"]);
});
