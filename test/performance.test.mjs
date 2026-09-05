import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { removeTestPath as rm } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

test("50k SQLite library uses indexed filters, starts under 3s, and keeps search P95 under 100ms", { skip: process.env.MOSA_PERF_TEST !== "1" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-perf-"));
  // Windows can keep SQLite WAL/SHM handles alive for a short moment after
  // close (and Defender may briefly inspect them). Retry the cleanup instead
  // of turning an otherwise-passing performance run red with EBUSY/EPERM.
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const libraryDir = join(root, "library");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  const store = createSqliteAssetStore({ projectRoot, managerDir, libraryDir });
  store.close();
  const database = new Database(join(libraryDir, "mosa.db"));
  const timestamp = new Date().toISOString();
  const timestampEpoch = Date.parse(timestamp);
  database.prepare("INSERT INTO projects (id, created_at) VALUES ('default', ?)").run(timestamp);
  const insertAsset = database.prepare(`
    INSERT INTO assets (
      project_id, id, asset, original_path, content_sha256, prompt, skill, style, ratio, business_fields_json, theme,
      favorite, archived, group_name, category, rating, version_change, source_type, source_json, metadata_json, search_text,
      tags_text, business_search_text, source_search_text, media_kind, source_group, conversation_id, generation_batch,
      created_at, created_at_epoch, updated_at, sort_name
    ) VALUES (
      @project_id, @id, @asset, @original_path, 'benchmark', @prompt, '', @style, '', '{}', '',
      @favorite, 0, @group_name, @category, 0, '', 'web-chatgpt', '{"type":"web-chatgpt"}', '{}', @search_text,
      '', '', 'web-chatgpt', @media_kind, 'web-chatgpt', @conversation_id, @generation_batch,
      @created_at, @created_at_epoch, @updated_at, @sort_name
    )
  `);
  const insertFts = database.prepare("INSERT INTO asset_fts (project_id, asset_id, content) VALUES ('default', ?, ?)");
  database.transaction(() => {
    for (let index = 0; index < 50_000; index += 1) {
      const id = `asset-${index}`;
      const content = `red mechanical future city variant ${index}`;
      insertAsset.run({
        project_id: "default",
        id,
        asset: `${id}.png`,
        original_path: `/bench/${id}.png`,
        prompt: content,
        style: `style-${index % 20}`,
        favorite: index % 17 === 0 ? 1 : 0,
        group_name: `group-${index % 25}`,
        category: `category-${index % 10}`,
        search_text: content,
        media_kind: index % 4 === 0 ? "video" : "image",
        conversation_id: `conversation-${index % 100}`,
        generation_batch: `batch-${index % 10}`,
        created_at: timestamp,
        created_at_epoch: timestampEpoch,
        updated_at: timestamp,
        sort_name: id,
      });
      insertFts.run(id, content);
    }
  })();
  const planDetails = (sql, ...params) => database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => row.detail).join("\n");
  const plans = [
    ["conversation", planDetails("SELECT id FROM assets WHERE project_id = ? AND archived = 0 AND conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 101", "default", "conversation-7"), "assets_project_conversation_idx"],
    ["batch", planDetails("SELECT id FROM assets WHERE project_id = ? AND archived = 0 AND conversation_id = ? AND generation_batch = ? ORDER BY created_at DESC, id DESC LIMIT 101", "default", "conversation-7", "batch-7"), "assets_project_conversation_batch_idx"],
    ["source", planDetails("SELECT id FROM assets WHERE project_id = ? AND deleted_at IS NULL AND archived = 0 AND source_group = ? ORDER BY created_at DESC, id DESC LIMIT 101", "default", "web-chatgpt"), "assets_project_source_group_live_idx"],
    ["media", planDetails("SELECT id FROM assets WHERE project_id = ? AND deleted_at IS NULL AND archived = 0 AND media_kind = ? ORDER BY created_at DESC, id DESC LIMIT 101", "default", "video"), "assets_project_media_kind_live_idx"],
    ["group", planDetails("SELECT id FROM assets WHERE project_id = ? AND archived = 0 AND group_name = ? ORDER BY created_at DESC, id DESC LIMIT 101", "default", "group-7"), "assets_project_group_created_idx"],
    ["category", planDetails("SELECT id FROM assets WHERE project_id = ? AND deleted_at IS NULL AND archived = 0 AND category = ? ORDER BY created_at DESC, id DESC LIMIT 101", "default", "category-7"), "assets_project_category_live_idx"],
    ["style", planDetails("SELECT id FROM assets WHERE project_id = ? AND archived = 0 AND style = ? ORDER BY created_at DESC, id DESC LIMIT 101", "default", "style-7"), "assets_project_style_created_idx"],
    ["favorite", planDetails("SELECT id FROM assets WHERE project_id = ? AND archived = 0 AND (rating > 0 OR favorite = 1) ORDER BY created_at DESC, id DESC LIMIT 101", "default"), "assets_project_favorite_created_idx"],
  ];
  for (const [name, plan, indexName] of plans) {
    assert.match(plan, new RegExp(indexName), `${name} plan must use ${indexName}: ${plan}`);
    assert.doesNotMatch(plan, /USE TEMP B-TREE FOR ORDER BY/, `${name} plan must preserve index order: ${plan}`);
  }
  database.close();

  const startupStarted = performance.now();
  const reopened = createSqliteAssetStore({ projectRoot, managerDir, libraryDir });
  const startupMs = performance.now() - startupStarted;
  t.after(() => reopened.close());
  // Warm the two query shapes before measuring steady-state latency. With only
  // 20 samples, counting both first-use statement/FTS cache fills makes P95 the
  // second coldest request and turns scheduler noise into a false regression.
  // The 100ms budget below is unchanged.
  for (const query of ["mechanical", "future city"]) {
    const result = await reopened.listAssetPage({ projectId: "default", query, limit: 100 });
    assert.equal(result.page.total, 50_000);
  }
  const samples = [];
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    const result = await reopened.listAssetPage({ projectId: "default", query: index % 2 ? "mechanical" : "future city", limit: 100 });
    samples.push(performance.now() - started);
    assert.equal(result.page.total, 50_000);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  const filterCases = [
    ["conversation", { conversation: "conversation-7" }],
    ["conversation+batch", { conversation: "conversation-7", generationBatch: "batch-7" }],
    ["source", { source: "web-chatgpt" }],
    ["media", { mediaKind: "video" }],
    ["group", { group: "group-7" }],
    ["category", { category: "category-7" }],
    ["style", { style: "style-7" }],
    ["favorite", { favorite: true }],
  ];
  for (const [, filters] of filterCases) {
    const result = await reopened.listAssetPage({ projectId: "default", ...filters, limit: 100 });
    assert.ok(result.assets.length > 0);
  }
  const filterP95ByCase = new Map();
  for (const [name, filters] of filterCases) {
    const caseSamples = [];
    for (let sample = 0; sample < 20; sample += 1) {
      const started = performance.now();
      const result = await reopened.listAssetPage({ projectId: "default", ...filters, limit: 100 });
      caseSamples.push(performance.now() - started);
      assert.ok(result.assets.length > 0);
    }
    caseSamples.sort((a, b) => a - b);
    const caseP95 = caseSamples[Math.ceil(caseSamples.length * 0.95) - 1];
    filterP95ByCase.set(name, caseP95);
    t.diagnostic(`indexed filter ${name} P95=${caseP95.toFixed(1)}ms samples=${caseSamples.map((value) => value.toFixed(1)).join(",")}`);
  }
  const slowestFilter = [...filterP95ByCase.entries()].sort((left, right) => right[1] - left[1])[0];
  const stack = await reopened.createAssetStack("default", ["asset-0", "asset-1"], { coverAssetId: "asset-0" });
  const fullList = await reopened.listAssets({ projectId: "default" });
  assert.equal(fullList.length, 50_000, "full 50k listings must not exceed SQLite's bound-variable limit");
  assert.deepEqual(fullList.find((asset) => asset.id === "asset-0")?.stack, { id: stack.id, count: 2 });
  assert.ok(startupMs < 3000, `startup ${startupMs.toFixed(1)}ms exceeded 3000ms`);
  assert.ok(p95 < 100, `search P95 ${p95.toFixed(1)}ms exceeded 100ms`);
  assert.ok(slowestFilter[1] < 50,
    `indexed-filter ${slowestFilter[0]} P95 ${slowestFilter[1].toFixed(1)}ms exceeded 50ms; ${[...filterP95ByCase.entries()].map(([name, value]) => `${name}=${value.toFixed(1)}ms`).join(", ")}`);
});
