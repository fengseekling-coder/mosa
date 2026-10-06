import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createSqliteAssetStore, sqliteDatabasePath } from "../lib/sqlite-asset-store.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const require = createRequire(import.meta.url);
const betterSqlite3Path = require.resolve("better-sqlite3");

// better-sqlite3 is synchronous, so a write lock must be held from another
// process: a same-process holder would deadlock the event loop instead of
// exercising the busy wait.
const LOCK_HOLDER_SCRIPT = `
const Database = require(process.env.MOSA_BUSY_TEST_BETTER_SQLITE3);
const db = new Database(process.env.MOSA_BUSY_TEST_DB);
db.pragma("busy_timeout = 5000");
db.exec("BEGIN IMMEDIATE");
db.prepare("UPDATE library_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'library_revision'").run();
process.stdout.write("LOCKED\\n");
setTimeout(() => {
  db.exec("COMMIT");
  db.close();
  process.stdout.write("RELEASED\\n");
}, Number(process.env.MOSA_BUSY_TEST_HOLD_MS || "300"));
`;

function holdWriteLock(databasePath, holdMs) {
  const child = spawn(process.execPath, ["-e", LOCK_HOLDER_SCRIPT], {
    env: {
      ...process.env,
      MOSA_BUSY_TEST_BETTER_SQLITE3: betterSqlite3Path,
      MOSA_BUSY_TEST_DB: databasePath,
      MOSA_BUSY_TEST_HOLD_MS: String(holdMs),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const locked = new Promise((resolveLocked, failLocked) => {
    const onData = (chunk) => {
      output += chunk;
      if (output.includes("LOCKED")) {
        child.stdout.off("data", onData);
        resolveLocked();
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => failLocked(new Error(`lock holder exited before locking (code ${code}): ${output}${child.stderr.read() || ""}`)));
  });
  const done = new Promise((resolveDone) => child.once("exit", (code) => resolveDone({ code })));
  return { locked, done, kill: () => child.kill("SIGKILL") };
}

async function createBusyTestStore(t, assetId) {
  const root = await mkdtemp(join(tmpdir(), "mosa-busy-claim-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const sourcePath = join(projectRoot, "generated-images", "image.png");
  await mkdir(dirname(sourcePath), { recursive: true });
  await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 32, g: 64, b: 96, alpha: 1 } } }).png().toFile(sourcePath);
  const libraryDir = join(root, "library");
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => store.close());
  await store.createAsset({ assetId, imagePath: sourcePath, prompt: "busy claim" });
  return { store, libraryDir };
}

test("claimDerivativeJob waits out a concurrent cross-process writer instead of throwing SQLITE_BUSY", async (t) => {
  const { store, libraryDir } = await createBusyTestStore(t, "busy");

  const holder = holdWriteLock(sqliteDatabasePath(libraryDir), 300);
  t.after(() => holder.kill());
  await holder.locked;

  const started = Date.now();
  const job = await store.claimDerivativeJob();
  const waited = Date.now() - started;
  assert.ok(job, "claim must succeed once the other process releases the write lock");
  assert.equal(job.asset_id, "busy");
  assert.ok(waited >= 200, `claim must have waited for the held write lock (waited ${waited}ms)`);

  await holder.done;
  const status = await store.derivativeStatus();
  assert.equal(status.running, 1, "the claimed job must be marked running");
});

test("completeDerivativeJob waits out a concurrent cross-process writer instead of throwing SQLITE_BUSY", async (t) => {
  const { store, libraryDir } = await createBusyTestStore(t, "busy-complete");

  const job = await store.claimDerivativeJob();
  assert.equal(job.asset_id, "busy-complete");

  const holder = holdWriteLock(sqliteDatabasePath(libraryDir), 300);
  t.after(() => holder.kill());
  await holder.locked;

  const started = Date.now();
  await store.completeDerivativeJob(job, {
    previewPath: job.previewPath,
    mediumPath: job.mediumPath,
    thumbnailPath: job.thumbnailPath,
    width: 8,
    height: 8,
  });
  const waited = Date.now() - started;
  assert.ok(waited >= 200, `complete must have waited for the held write lock (waited ${waited}ms)`);

  await holder.done;
  const status = await store.derivativeStatus();
  assert.equal(status.completed, 1, "the completed job must be recorded");
});
