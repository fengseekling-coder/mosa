import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

test("50k SQLite library starts under 3s and FTS P95 is under 100ms", { skip: process.env.MOSA_PERF_TEST !== "1" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-perf-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const libraryDir = join(root, "library");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  const store = createSqliteAssetStore({ projectRoot, managerDir, libraryDir });
  store.close();
  const database = new Database(join(libraryDir, "mosa.db"));
  const timestamp = new Date().toISOString();
  database.prepare("INSERT INTO projects (id, created_at) VALUES ('default', ?)").run(timestamp);
  const insertAsset = database.prepare(`
    INSERT INTO assets (
      project_id, id, asset, original_path, content_sha256, prompt, skill, style, ratio, business_fields_json, theme,
      favorite, archived, group_name, category, rating, version_change, source_type, source_json, metadata_json, search_text, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, '', '', '', '{}', '', 0, 0, '', '', 0, '', 'benchmark', '{}', '{}', ?, ?, ?)
  `);
  const insertFts = database.prepare("INSERT INTO asset_fts (project_id, asset_id, content) VALUES ('default', ?, ?)");
  database.transaction(() => {
    for (let index = 0; index < 50_000; index += 1) {
      const id = `asset-${index}`;
      const content = `red mechanical future city variant ${index}`;
      insertAsset.run("default", id, `${id}.png`, `/bench/${id}.png`, "benchmark", content, content, timestamp, timestamp);
      insertFts.run(id, content);
    }
  })();
  database.close();

  const startupStarted = performance.now();
  const reopened = createSqliteAssetStore({ projectRoot, managerDir, libraryDir });
  const startupMs = performance.now() - startupStarted;
  t.after(() => reopened.close());
  const samples = [];
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    const result = await reopened.listAssetPage({ projectId: "default", query: index % 2 ? "mechanical" : "future city", limit: 100 });
    samples.push(performance.now() - started);
    assert.equal(result.page.total, 50_000);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  assert.ok(startupMs < 3000, `startup ${startupMs.toFixed(1)}ms exceeded 3000ms`);
  assert.ok(p95 < 100, `search P95 ${p95.toFixed(1)}ms exceeded 100ms`);
});
