import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireMosaRuntimeLock } from "../lib/runtime-lock.mjs";

test("permits only one MOSA bridge runtime for a library", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-runtime-lock-"));
  const libraryDir = join(root, "library");
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await acquireMosaRuntimeLock({ libraryDir });
  await assert.rejects(
    acquireMosaRuntimeLock({ libraryDir }),
    /MOSA runtime already active for this library/,
  );
  assert.equal(await first.release(), true);

  const replacement = await acquireMosaRuntimeLock({ libraryDir });
  assert.equal(replacement.owner.pid, process.pid);
  assert.equal(await replacement.release(), true);
});

test("recovers a lock left by a terminated runtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-runtime-lock-stale-"));
  const libraryDir = join(root, "library");
  const lockPath = join(libraryDir, ".mosa-runtime.lock");
  await mkdir(libraryDir, { recursive: true });
  await writeFile(lockPath, `${JSON.stringify({ token: "stale", pid: 999_999_999, createdAt: "2026-07-23T00:00:00.000Z" })}\n`, "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));

  const lock = await acquireMosaRuntimeLock({ libraryDir });
  assert.equal(lock.owner.pid, process.pid);
  assert.equal(await lock.release(), true);
});
