import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { DISABLEABLE_BRIDGES } from "../lib/runtime-bridges.mjs";

const repositoryRoot = new URL("..", import.meta.url).pathname;

test("static resource cache semantics: no-cache for UI files and immutable for library images", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cache-semantics-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  // Use a completely different library path to avoid conflicts with real user library
  const isolatedLibraryDir = join(root, "isolated-test-library");

  const runtime = await startMosaRuntime({
    projectRoot: root,
    managerDir: repositoryRoot,
    cowartProjectDir: join(root, "desktop-data"),
    appDir: join(repositoryRoot, "app"),
    assetsRoot: join(isolatedLibraryDir, "assets"),
    generatedImagesDir: join(root, "generated-images"),
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "codex-sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-canvas"),
    port: 0,
    disabledBridges: [...DISABLEABLE_BRIDGES],
    // Force isolated library dir to prevent lock conflicts with user's real library
    libraryDir: isolatedLibraryDir,
  });
  t.after(() => runtime.stop());

  await t.test("GET / returns Cache-Control: no-cache, must-revalidate", async () => {
    const res = await fetch(`${runtime.url}/`);
    assert.equal(res.status, 200);
    const cc = res.headers.get("cache-control");
    assert.ok(cc?.includes("no-cache"), `Cache-Control should include 'no-cache', got: ${cc}`);
    assert.ok(cc?.includes("must-revalidate"), `Cache-Control should include 'must-revalidate', got: ${cc}`);
  });

  await t.test("GET /styles.css returns same no-cache policy", async () => {
    const res = await fetch(`${runtime.url}/styles.css`);
    assert.equal(res.status, 200);
    const cc = res.headers.get("cache-control");
    assert.ok(cc?.includes("no-cache"), `CSS should have no-cache, got: ${cc}`);
    assert.ok(cc?.includes("must-revalidate"), `CSS should have must-revalidate, got: ${cc}`);
  });

  await t.test("GET /app.js returns same no-cache policy", async () => {
    const res = await fetch(`${runtime.url}/app.js`);
    assert.equal(res.status, 200);
    const cc = res.headers.get("cache-control");
    assert.ok(cc?.includes("no-cache"), `JS should have no-cache, got: ${cc}`);
    assert.ok(cc?.includes("must-revalidate"), `JS should have must-revalidate, got: ${cc}`);
  });

  await t.test("GET /i18n.mjs returns same no-cache policy", async () => {
    const res = await fetch(`${runtime.url}/i18n.mjs`);
    assert.equal(res.status, 200);
    const cc = res.headers.get("cache-control");
    assert.ok(cc?.includes("no-cache"), `MJS should have no-cache, got: ${cc}`);
    assert.ok(cc?.includes("must-revalidate"), `MJS should have must-revalidate, got: ${cc}`);
    assert.match(await res.text(), /export default/, "the real i18n module should be served");
  });

  await t.test("GET /nonexistent.html falls back to index with same cache policy", async () => {
    const res = await fetch(`${runtime.url}/nonexistent-page`);
    assert.equal(res.status, 200);
    const cc = res.headers.get("cache-control");
    assert.ok(cc?.includes("no-cache"), `SPA fallback should have no-cache, got: ${cc}`);
    assert.ok(cc?.includes("must-revalidate"), `SPA fallback should have must-revalidate, got: ${cc}`);
  });

  await t.test("library images use immutable long-term cache when served", async () => {
    // Create the fixture image and import it through the runtime's own API so
    // the asset is served by the same store instance that backs /library/*.
    const fixtureImagePath = join(root, "fixture-cache.png");
    const TINY_PNG = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108020000009001" +
      "2e00000000c494441547801636000020000000500010d0a2db40000000049454e44ae426082",
      "hex",
    );
    await writeFile(fixtureImagePath, TINY_PNG);

    const createRes = await fetch(`${runtime.url}/api/assets/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ asset: "cache-test-fixture", imagePath: fixtureImagePath }),
    });
    assert.equal(createRes.status, 200, "fixture asset creation should succeed");
    const created = (await createRes.json()).asset;

    const res = await fetch(`${runtime.url}${created.image_url}`);
    assert.equal(res.status, 200, "library image should be served");
    const cc = res.headers.get("cache-control");
    assert.ok(cc?.includes("immutable"), `Library image should be immutable, got: ${cc}`);
    assert.ok(cc?.includes("max-age=31536000"), `Library image should have long max-age, got: ${cc}`);
  });
});
