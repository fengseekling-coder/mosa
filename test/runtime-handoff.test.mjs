import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createMosaDesktopStartupHandoff,
  mosaDesktopStartupHandoffPath,
  probeMosaDesktopStartupHandoff,
} from "../lib/runtime-handoff.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

test("desktop startup handoff is bound to PID/process identity and releases only its own marker", async (t) => {
  const libraryDir = await mkdtemp(join(tmpdir(), "mosa-handoff-"));
  deferTestPathRemoval(libraryDir, { recursive: true, force: true });
  const nowMs = Date.parse("2026-09-18T20:00:00.000Z");
  const lease = await createMosaDesktopStartupHandoff({
    libraryDir,
    pid: 4242,
    ttlMs: 30_000,
    now: () => nowMs,
    readProcessIdentity: async () => "unix-start:desktop-start",
    randomUUIDImpl: () => "handoff-token-1234",
  });
  const marker = JSON.parse(await readFile(mosaDesktopStartupHandoffPath(libraryDir), "utf8"));
  assert.equal(marker.pid, 4242);
  assert.equal(marker.processIdentity, "unix-start:desktop-start");

  const status = await probeMosaDesktopStartupHandoff({
    libraryDir,
    now: () => nowMs + 100,
    isProcessAlive: () => true,
    verifyProcessIdentity: async (owner) => owner.processIdentity === "unix-start:desktop-start",
  });
  assert.equal(status.state, "handoff");
  assert.equal(status.owner.pid, 4242);
  assert.equal(await lease.release(), true);
  assert.equal(await lease.release(), false);
  await assert.rejects(access(mosaDesktopStartupHandoffPath(libraryDir)));
});

test("expired handoff markers are ignored and removed so background fallback can recover", async (t) => {
  const libraryDir = await mkdtemp(join(tmpdir(), "mosa-handoff-expired-"));
  deferTestPathRemoval(libraryDir, { recursive: true, force: true });
  const nowMs = Date.parse("2026-09-18T20:00:00.000Z");
  await createMosaDesktopStartupHandoff({
    libraryDir,
    pid: 4242,
    ttlMs: 1_000,
    now: () => nowMs,
    readProcessIdentity: async () => "unix-start:desktop-start",
  });
  const status = await probeMosaDesktopStartupHandoff({
    libraryDir,
    now: () => nowMs + 1_001,
    isProcessAlive: () => true,
    verifyProcessIdentity: async () => true,
  });
  assert.deepEqual(status, { state: "unavailable" });
  await assert.rejects(access(mosaDesktopStartupHandoffPath(libraryDir)));
});

test("PID reuse cannot keep a handoff alive when process start identity changes", async (t) => {
  const libraryDir = await mkdtemp(join(tmpdir(), "mosa-handoff-recycled-"));
  deferTestPathRemoval(libraryDir, { recursive: true, force: true });
  const nowMs = Date.parse("2026-09-18T20:00:00.000Z");
  await createMosaDesktopStartupHandoff({
    libraryDir,
    pid: 4242,
    ttlMs: 30_000,
    now: () => nowMs,
    readProcessIdentity: async () => "unix-start:first-process",
  });
  const status = await probeMosaDesktopStartupHandoff({
    libraryDir,
    now: () => nowMs + 500,
    isProcessAlive: () => true,
    verifyProcessIdentity: async () => false,
  });
  assert.deepEqual(status, { state: "unavailable" });
  await assert.rejects(access(mosaDesktopStartupHandoffPath(libraryDir)));
});
