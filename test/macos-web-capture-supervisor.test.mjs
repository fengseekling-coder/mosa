import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
  probeMosaOwner,
  probeRuntimeLease,
  runSupervisor,
  watchOwnedRuntimeSources,
  waitForReplacementOwner,
} from "../scripts/macos-web-capture-supervisor.mjs";

test("supervisor recognizes a verified MOSA owner for the same library", async () => {
  const status = await probeMosaOwner({
    port: 43517,
    libraryDir: "/tmp/mosa-library",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ product: "mosa", libraryDir: "/tmp/mosa-library" }),
    }),
  });
  assert.equal(status.state, "attached");
});

test("supervisor refuses to start over a different library or non-MOSA listener", async () => {
  const differentLibrary = await probeMosaOwner({
    libraryDir: "/tmp/mosa-library",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ product: "mosa", libraryDir: "/tmp/other-library" }),
    }),
  });
  assert.deepEqual(differentLibrary, { state: "conflict", reason: "different-library" });

  const foreign = await probeMosaOwner({
    libraryDir: "/tmp/mosa-library",
    fetchImpl: async () => ({ ok: true, json: async () => ({ product: "other" }) }),
  });
  assert.deepEqual(foreign, { state: "conflict", reason: "non-mosa-listener" });
});

test("supervisor treats an active verified runtime lock as an owner while HTTP is still starting", async () => {
  const lease = await probeRuntimeLease({
    libraryDir: "/tmp/mosa-library",
    readFileImpl: async () => JSON.stringify({ token: "owner-token", pid: 4242, processIdentity: "start-1" }),
    isProcessAlive: () => true,
    verifyProcessIdentity: async () => true,
  });
  assert.deepEqual(lease, { state: "starting", owner: { pid: 4242 } });

  const status = await probeMosaOwner({
    libraryDir: "/tmp/mosa-library",
    fetchImpl: async () => {
      const error = new Error("connection refused");
      error.code = "ECONNREFUSED";
      throw error;
    },
    leaseProbe: async () => lease,
  });
  assert.deepEqual(status, lease);
});

test("stale or recycled runtime locks never suppress background recovery", async () => {
  const dead = await probeRuntimeLease({
    libraryDir: "/tmp/mosa-library",
    readFileImpl: async () => JSON.stringify({ token: "owner-token", pid: 4242, processIdentity: "start-1" }),
    isProcessAlive: () => false,
  });
  assert.deepEqual(dead, { state: "unavailable" });

  const recycled = await probeRuntimeLease({
    libraryDir: "/tmp/mosa-library",
    readFileImpl: async () => JSON.stringify({ token: "owner-token", pid: 4242, processIdentity: "start-1" }),
    isProcessAlive: () => true,
    verifyProcessIdentity: async () => false,
  });
  assert.deepEqual(recycled, { state: "unavailable" });
});

test("takeover grace observes a desktop owner before restarting the background runtime", async () => {
  const states = [
    { state: "unavailable" },
    { state: "unavailable" },
    { state: "attached", health: { product: "mosa" } },
  ];
  let sleeps = 0;
  const result = await waitForReplacementOwner({
    probe: async () => states.shift() || { state: "attached" },
    sleep: async () => { sleeps += 1; },
    graceMs: 1000,
    pollMs: 250,
  });
  assert.equal(result.state, "attached");
  assert.equal(sleeps, 2);
});

test("supervisor stands by while desktop owns the library and starts service after it leaves", async () => {
  const signalTarget = new EventEmitter();
  let probeCount = 0;
  let spawnCount = 0;
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  };

  await runSupervisor({
    signalTarget,
    probe: async () => {
      probeCount += 1;
      if (probeCount <= 2) return { state: "attached" };
      return { state: "unavailable" };
    },
    spawnRuntime: () => {
      spawnCount += 1;
      queueMicrotask(() => signalTarget.emit("SIGTERM"));
      return child;
    },
    sleep: async () => {},
    idlePollMs: 1,
    takeoverGraceMs: 1,
    takeoverPollMs: 1,
    logger: { info() {}, warn() {} },
  });

  assert.equal(spawnCount, 1);
  assert.ok(probeCount >= 3);
});

test("source watcher resolves once and closes every watched handle", async () => {
  const callbacks = [];
  const handles = [];
  const sourceWatch = watchOwnedRuntimeSources({
    settleMs: 1,
    sources: [
      { path: "/tmp/app", recursive: true },
      { path: "/tmp/server.mjs", recursive: false },
    ],
    watchImpl: (_path, _options, callback) => {
      callbacks.push(callback);
      const handle = new EventEmitter();
      handle.closed = false;
      handle.close = () => { handle.closed = true; };
      handles.push(handle);
      return handle;
    },
  });

  callbacks[0]();
  callbacks[1]();
  assert.deepEqual(await sourceWatch.promise, { reason: "source-change" });
  assert.equal(handles.every((handle) => handle.closed), true);
});

test("supervisor restarts an owned background runtime when source changes", async () => {
  const signalTarget = new EventEmitter();
  let spawnCount = 0;
  let watchCount = 0;
  const children = [];

  function makeChild(pid) {
    const child = new EventEmitter();
    child.pid = pid;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => {
      child.signalCode = signal;
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    };
    children.push(child);
    return child;
  }

  await runSupervisor({
    signalTarget,
    probe: async () => ({ state: "unavailable" }),
    spawnRuntime: () => {
      spawnCount += 1;
      const child = makeChild(5000 + spawnCount);
      if (spawnCount === 2) queueMicrotask(() => signalTarget.emit("SIGTERM"));
      return child;
    },
    watchSources: () => {
      watchCount += 1;
      return {
        promise: watchCount === 1
          ? Promise.resolve({ reason: "source-change" })
          : new Promise(() => {}),
        close() {},
      };
    },
    sleep: async () => {},
    takeoverGraceMs: 1,
    takeoverPollMs: 1,
    logger: { info() {}, warn() {} },
  });

  assert.equal(spawnCount, 2);
  assert.equal(children[0].signalCode, "SIGTERM");
  assert.equal(children[1].signalCode, "SIGTERM");
});
