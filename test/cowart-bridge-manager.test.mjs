import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssetStore } from "../lib/asset-store.mjs";
import { createCowartBridgeManager } from "../lib/cowart-bridge-manager.mjs";
import { createCowartProjectRegistry } from "../lib/cowart-project-registry.mjs";

test("archives explicitly registered project-local Cowart canvases", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-manager-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const managerDir = join(root, "mosa");
  const firstProject = join(root, "first-project");
  const secondProject = join(root, "second-project");
  await Promise.all([
    writeCowartImage(firstProject, "first-project-image.png", "第一项目画布图"),
    writeCowartImage(secondProject, "second-project-image.png", "第二项目画布图"),
  ]);

  const store = createAssetStore({
    projectRoot: root,
    managerDir,
    cowartCanvasDir: join(root, "cowart-data", "mosa"),
  });
  const registry = createCowartProjectRegistry({
    managerDir,
    registryPath: join(root, "state", "cowart-projects.json"),
  });
  const first = await registry.addProject({ projectDir: firstProject });
  const second = await registry.addProject({ projectDir: secondProject });
  assert.equal((await registry.addProject({ projectDir: firstProject })).created, false);

  const manager = createCowartBridgeManager({ store, registry, managerDir });
  t.after(() => manager.stop());
  await manager.start();

  const assets = await store.listAssets({ projectId: "default" });
  assert.equal(assets.length, 2);
  assert.deepEqual(
    new Set(assets.map((asset) => asset.source.cowart_project_dir)),
    new Set([first.project.projectDir, second.project.projectDir]),
  );
  assert.deepEqual(
    new Set(assets.map((asset) => asset.source.cowart_source_id)),
    new Set([first.project.id, second.project.id]),
  );

  const status = manager.status();
  assert.equal(status.registeredCount, 2);
  assert.equal(status.monitoredCount, 3);
  assert.equal(status.sources.length, 3);
  assert.equal(status.sources.find((source) => source.id === first.project.id)?.canvasDir, join(first.project.projectDir, "canvas"));

  await manager.removeProject(first.project.id);
  assert.equal(manager.status().registeredCount, 1);
  assert.deepEqual((await registry.list()).map((project) => project.id), [second.project.id]);
});

test("requires an existing absolute Cowart project directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = createCowartProjectRegistry({ registryPath: join(root, "state", "cowart-projects.json") });

  await assert.rejects(registry.addProject({ projectDir: "relative-project" }), /absolute directory/);
  await assert.rejects(registry.addProject({ projectDir: join(root, "missing-project") }), /does not exist/);
});

async function writeCowartImage(projectDir, fileName, altText) {
  const pageDir = join(projectDir, "canvas", "pages", "page");
  const assetsDir = join(pageDir, "assets");
  await mkdir(assetsDir, { recursive: true });
  await writeFile(join(assetsDir, fileName), `fixture ${fileName}`, "utf8");
  await writeFile(join(pageDir, "cowart-canvas.json"), JSON.stringify({
    store: {
      "asset:image": { id: "asset:image", typeName: "asset", type: "image", props: { name: fileName, src: `/page-assets/page/${fileName}` }, meta: {} },
      "shape:image": { id: "shape:image", typeName: "shape", type: "image", props: { assetId: "asset:image", w: 1200, h: 800, altText }, meta: {} },
    },
  }), "utf8");
}
