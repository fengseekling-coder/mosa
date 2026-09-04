import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import {
  MosaServiceBuildMismatchError,
  MosaServiceConflictError,
  compareMosaVersions,
  retireOlderMosaService,
  shouldAllowSameVersionServiceReplacement,
  shouldAllowStaleServiceUpgrade,
  startMosaService,
} from "../desktop/service-manager.mjs";
import { removeTestPath as rm } from "./test-cleanup.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function temporaryRoot(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function runtimeOptions(root) {
  const libraryDir = join(root, "library");
  return {
    projectRoot: root,
    managerDir: repositoryRoot,
    cowartProjectDir: join(root, "desktop-data"),
    appDir: join(repositoryRoot, "app"),
    assetsRoot: join(libraryDir, "assets"),
    generatedImagesDir: join(root, "generated-images"),
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "codex-sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-canvas"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
  };
}

function listen(server, port = 0) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

async function availablePort() {
  const server = createServer();
  await listen(server);
  const port = server.address().port;
  await close(server);
  return port;
}

test("attaches only to a matching MOSA health identity and leaves it running", async (t) => {
  const root = await temporaryRoot(t, "mosa-service-attach-");
  const libraryDir = join(root, "library");
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ product: "mosa", libraryDir, storage: "sqlite" }));
  });
  await listen(server);
  t.after(() => close(server));
  const port = server.address().port;

  const service = await startMosaService({ port, libraryDir });
  assert.equal(service.mode, "attached");
  assert.equal(service.storage, "sqlite");
  await service.stop();
  assert.equal(server.listening, true);
});

test("rejects a same-library MOSA runtime whose build identity is stale", async (t) => {
  const root = await temporaryRoot(t, "mosa-service-stale-build-");
  const libraryDir = join(root, "library");
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      product: "mosa",
      libraryDir,
      storage: "sqlite",
      productVersion: "0.2.0",
      gitSha: "old-sha",
      uiFingerprint: "old-ui",
      runtimeFingerprint: "old-runtime",
    }));
  });
  await listen(server);
  t.after(() => close(server));

  await assert.rejects(
    startMosaService({
      port: server.address().port,
      libraryDir,
      expectedIdentity: {
        productVersion: "0.2.0",
        gitSha: "new-sha",
        uiFingerprint: "new-ui",
        runtimeFingerprint: "new-runtime",
      },
    }),
    (error) => {
      assert.ok(error instanceof MosaServiceBuildMismatchError);
      assert.equal(error.code, "MOSA_SERVICE_BUILD_MISMATCH");
      assert.equal(error.upgradeEligible, false, "same product version is not an automatic upgrade target");
      assert.match(error.message, /v0\.2\.0/);
      assert.doesNotMatch(error.message, /sha|fingerprint|new-sha|old-sha/i, "startup copy does not expose internal build identifiers");
      return true;
    },
  );
  assert.equal(server.listening, true, "desktop must not kill a process it does not own");
});

test("rejects unversioned same-library services when desktop has a verifiable build identity", async (t) => {
  const root = await temporaryRoot(t, "mosa-service-unversioned-build-");
  const libraryDir = join(root, "library");
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ product: "mosa", libraryDir, storage: "sqlite" }));
  });
  await listen(server);
  t.after(() => close(server));

  await assert.rejects(
    startMosaService({
      port: server.address().port,
      libraryDir,
      expectedIdentity: { runtimeFingerprint: "expected-runtime" },
    }),
    (error) => {
      assert.ok(error instanceof MosaServiceBuildMismatchError);
      assert.equal(error.upgradeEligible, false, "an unversioned service is never terminated automatically");
      assert.doesNotMatch(error.message, /runtimeFingerprint|expected-runtime/);
      return true;
    },
  );
  assert.equal(server.listening, true);
});

test("compares MOSA release and prerelease versions for upgrade eligibility", () => {
  assert.equal(compareMosaVersions("0.2.1-rc.1", "0.2.0"), 1);
  assert.equal(compareMosaVersions("0.2.1", "0.2.1-rc.1"), 1);
  assert.equal(compareMosaVersions("0.2.1-rc.2", "0.2.1-rc.1"), 1);
  assert.equal(compareMosaVersions("0.2.1-rc.1", "0.2.1"), -1);
  assert.equal(compareMosaVersions("0.2.1", "0.2.1"), 0);
  assert.equal(compareMosaVersions("unknown", "0.2.0"), null);
});

test("automatic stale-service retirement is enabled only for normal packaged launches", () => {
  assert.equal(shouldAllowStaleServiceUpgrade({ isPackaged: true, qaRun: false, explicitPort: false }), true);
  assert.equal(shouldAllowStaleServiceUpgrade({ isPackaged: false, qaRun: false, explicitPort: false }), false, "development launches stay fail-closed");
  assert.equal(shouldAllowStaleServiceUpgrade({ isPackaged: true, qaRun: "1", explicitPort: false }), false, "QA launches stay fail-closed");
  assert.equal(shouldAllowStaleServiceUpgrade({ isPackaged: true, qaRun: false, explicitPort: true }), false, "explicit port launches stay fail-closed");
});

test("same-version service replacement is enabled only for normal source desktop launches", () => {
  assert.equal(shouldAllowSameVersionServiceReplacement({ isPackaged: false, qaRun: false, explicitPort: false }), true);
  assert.equal(shouldAllowSameVersionServiceReplacement({ isPackaged: true, qaRun: false, explicitPort: false }), false, "packaged launches do not replace an unordered same-version build");
  assert.equal(shouldAllowSameVersionServiceReplacement({ isPackaged: false, qaRun: "1", explicitPort: false }), false, "QA launches stay fail-closed");
  assert.equal(shouldAllowSameVersionServiceReplacement({ isPackaged: false, qaRun: false, explicitPort: true }), false, "explicit port launches stay fail-closed");
});

test("source desktop hands off a verified same-version stale runtime to the current build", async (t) => {
  const root = await temporaryRoot(t, "mosa-service-same-version-handoff-");
  const libraryDir = join(root, "library");
  const staleHealth = {
    product: "mosa",
    libraryDir,
    storage: "sqlite",
    serviceProtocolVersion: "unknown",
    productVersion: "0.2.1-rc.4",
    gitSha: "old-sha",
    uiFingerprint: "old-ui",
    runtimeFingerprint: "old-runtime",
  };
  const expectedIdentity = {
    serviceProtocolVersion: "1",
    productVersion: "0.2.1-rc.4",
    gitSha: "new-sha",
    uiFingerprint: "new-ui",
    runtimeFingerprint: "new-runtime",
  };
  const replacement = {
    state: "attached",
    url: "http://127.0.0.1:43517",
    port: 43517,
    libraryDir,
    storage: "sqlite",
    ...expectedIdentity,
  };
  let handoffCalls = 0;

  const attached = await startMosaService({
    port: 43517,
    libraryDir,
    expectedIdentity,
    allowSameVersionServiceReplacement: true,
    fetchImpl: async () => ({ ok: true, json: async () => staleHealth }),
    upgradeService: async (conflict, options) => {
      handoffCalls += 1;
      assert.equal(conflict.sameVersionReplacementEligible, true);
      assert.equal(options.allowSameVersionReplacement, true);
      return true;
    },
    upgradeProbeImpl: async () => replacement,
  });

  assert.equal(handoffCalls, 1);
  assert.equal(attached.url, replacement.url);
  assert.equal(attached.productVersion, expectedIdentity.productVersion);
});

test("automatic retirement does not target same-version, newer, unknown, or different-library services", async (t) => {
  const root = await temporaryRoot(t, "mosa-service-upgrade-protections-");
  const libraryDir = join(root, "library");
  let health = null;
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(health));
  });
  await listen(server);
  t.after(() => close(server));
  const port = server.address().port;
  let upgradeCalls = 0;
  const expectedIdentity = {
    productVersion: "0.2.1-rc.2",
    gitSha: "target-sha",
    uiFingerprint: "target-ui",
    runtimeFingerprint: "target-runtime",
  };
  const cases = [
    {
      label: "same version",
      identity: { productVersion: "0.2.1-rc.2", gitSha: "other-sha", uiFingerprint: "other-ui", runtimeFingerprint: "other-runtime" },
    },
    {
      label: "newer version",
      identity: { productVersion: "0.2.2", gitSha: "newer-sha", uiFingerprint: "newer-ui", runtimeFingerprint: "newer-runtime" },
    },
    {
      label: "unknown version",
      identity: { productVersion: "unknown", gitSha: "unknown", uiFingerprint: "unknown", runtimeFingerprint: "unknown" },
    },
  ];

  for (const item of cases) {
    health = { product: "mosa", libraryDir, storage: "sqlite", ...item.identity };
    await assert.rejects(
      startMosaService({
        port,
        libraryDir,
        expectedIdentity,
        allowStaleServiceUpgrade: true,
        upgradeService: async () => {
          upgradeCalls += 1;
          return true;
        },
      }),
      MosaServiceBuildMismatchError,
      item.label,
    );
  }

  health = {
    product: "mosa",
    libraryDir: join(root, "different-library"),
    storage: "sqlite",
    productVersion: "0.2.0",
    gitSha: "old-sha",
    uiFingerprint: "old-ui",
    runtimeFingerprint: "old-runtime",
  };
  await assert.rejects(
    startMosaService({
      port,
      libraryDir,
      expectedIdentity,
      allowStaleServiceUpgrade: true,
      upgradeService: async () => {
        upgradeCalls += 1;
        return true;
      },
    }),
    MosaServiceConflictError,
  );
  assert.equal(upgradeCalls, 0, "protected services are never passed to the retirement path");
});

test("packaged upgrade path waits through KeepAlive unavailability and attaches to the target build", async (t) => {
  const root = await temporaryRoot(t, "mosa-service-upgrade-retry-");
  const libraryDir = join(root, "library");
  const port = await availablePort();
  const oldServer = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      product: "mosa",
      libraryDir,
      storage: "sqlite",
      productVersion: "0.2.0",
      gitSha: "old-sha",
      uiFingerprint: "old-ui",
      runtimeFingerprint: "unknown",
    }));
  });
  await listen(oldServer, port);
  t.after(() => close(oldServer));

  let upgradeCalls = 0;
  let runtimeStarts = 0;
  let replacementProbes = 0;
  const expectedIdentity = {
    productVersion: "0.2.1-rc.1",
    gitSha: "new-sha",
    uiFingerprint: "new-ui",
    runtimeFingerprint: "new-runtime",
  };
  const replacement = {
    state: "attached",
    url: `http://127.0.0.1:${port}`,
    port,
    libraryDir,
    storage: "sqlite",
    ...expectedIdentity,
  };
  const service = await startMosaService({
    port,
    libraryDir,
    expectedIdentity,
    allowStaleServiceUpgrade: true,
    upgradeService: async (conflict) => {
      upgradeCalls += 1;
      assert.ok(conflict instanceof MosaServiceBuildMismatchError);
      assert.equal(conflict.upgradeEligible, true);
      await close(oldServer);
      return true;
    },
    upgradeProbeImpl: async () => {
      replacementProbes += 1;
      if (replacementProbes === 1) return { state: "unavailable" };
      if (replacementProbes === 2) {
        return {
          state: "conflict",
          retryable: true,
          error: new MosaServiceConflictError("replacement is still starting"),
        };
      }
      return replacement;
    },
    upgradeReadySleepImpl: async () => {},
    upgradeReadyTimeoutMs: 1000,
    startRuntime: async () => {
      runtimeStarts += 1;
      throw new Error("startRuntime must not run during a KeepAlive upgrade handoff");
    },
  });

  assert.equal(upgradeCalls, 1);
  assert.equal(replacementProbes, 3);
  assert.equal(runtimeStarts, 0);
  assert.equal(service.mode, "attached");
  assert.equal(service.port, port);
  assert.equal(service.productVersion, expectedIdentity.productVersion);
  assert.equal(service.gitSha, expectedIdentity.gitSha);
  await service.stop();
});

test("packaged upgrade handoff fails closed when a different build appears after retirement", async (t) => {
  const root = await temporaryRoot(t, "mosa-service-upgrade-stranger-");
  const libraryDir = join(root, "library");
  const port = await availablePort();
  const oldServer = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      product: "mosa",
      libraryDir,
      storage: "sqlite",
      productVersion: "0.2.0",
      gitSha: "old-sha",
      uiFingerprint: "old-ui",
      runtimeFingerprint: "old-runtime",
    }));
  });
  await listen(oldServer, port);
  t.after(() => close(oldServer));

  let upgradeCalls = 0;
  let runtimeStarts = 0;
  const expectedIdentity = {
    productVersion: "0.2.1-rc.2",
    gitSha: "target-sha",
    uiFingerprint: "target-ui",
    runtimeFingerprint: "target-runtime",
  };
  const stranger = {
    state: "attached",
    url: `http://127.0.0.1:${port}`,
    port,
    libraryDir,
    storage: "sqlite",
    productVersion: "0.2.1-rc.1",
    gitSha: "stranger-sha",
    uiFingerprint: "stranger-ui",
    runtimeFingerprint: "stranger-runtime",
  };

  await assert.rejects(
    startMosaService({
      port,
      libraryDir,
      expectedIdentity,
      allowStaleServiceUpgrade: true,
      upgradeService: async () => {
        upgradeCalls += 1;
        await close(oldServer);
        return true;
      },
      upgradeProbeImpl: async () => stranger,
      startRuntime: async () => {
        runtimeStarts += 1;
        throw new Error("startRuntime must not run after a verified retirement");
      },
    }),
    MosaServiceBuildMismatchError,
  );

  assert.equal(upgradeCalls, 1, "the verified old service is retired only once");
  assert.equal(runtimeStarts, 0, "a stranger is never replaced by a second runtime");
});

test("packaged upgrade handoff times out without starting a second runtime", async (t) => {
  const root = await temporaryRoot(t, "mosa-service-upgrade-timeout-");
  const libraryDir = join(root, "library");
  const port = await availablePort();
  const oldServer = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      product: "mosa",
      libraryDir,
      storage: "sqlite",
      productVersion: "0.2.0",
      gitSha: "old-sha",
      uiFingerprint: "old-ui",
      runtimeFingerprint: "old-runtime",
    }));
  });
  await listen(oldServer, port);
  t.after(() => close(oldServer));

  let now = 0;
  let runtimeStarts = 0;
  await assert.rejects(
    startMosaService({
      port,
      libraryDir,
      expectedIdentity: {
        productVersion: "0.2.1-rc.2",
        gitSha: "target-sha",
        uiFingerprint: "target-ui",
        runtimeFingerprint: "target-runtime",
      },
      allowStaleServiceUpgrade: true,
      upgradeService: async () => {
        await close(oldServer);
        return true;
      },
      upgradeProbeImpl: async () => ({ state: "unavailable" }),
      upgradeReadyNowImpl: () => now,
      upgradeReadySleepImpl: async (delayMs) => { now += delayMs; },
      upgradeReadyTimeoutMs: 300,
      upgradeReadyPollMs: 100,
      startRuntime: async () => {
        runtimeStarts += 1;
        throw new Error("startRuntime must not run after retirement");
      },
    }),
    (error) => {
      assert.ok(error instanceof MosaServiceConflictError);
      assert.doesNotMatch(error.message, /sha|fingerprint/i);
      return true;
    },
  );
  assert.equal(runtimeStarts, 0);
});

test("controlled retirement requires matching service identity and lock owner, then sends SIGTERM only", async () => {
  const libraryDir = resolve("/tmp/mosa-controlled-upgrade-library");
  const service = {
    state: "attached",
    url: "http://127.0.0.1:43517",
    port: 43517,
    libraryDir,
    storage: "sqlite",
    productVersion: "0.2.0",
    gitSha: "old-sha",
    uiFingerprint: "old-ui",
    runtimeFingerprint: "unknown",
  };
  const conflict = new MosaServiceBuildMismatchError({
    details: service,
    expectedIdentity: {
      productVersion: "0.2.1-rc.1",
      gitSha: "new-sha",
      uiFingerprint: "new-ui",
      runtimeFingerprint: "new-runtime",
    },
    mismatches: [{ field: "productVersion", expected: "0.2.1-rc.1", actual: "0.2.0" }],
  });
  const probes = [service, { state: "unavailable" }];
  const alive = [true, false];
  const signals = [];

  const retired = await retireOlderMosaService(conflict, {
    readFileImpl: async () => JSON.stringify({ token: "old-runtime-token", pid: 4242 }),
    probeImpl: async () => probes.shift() || { state: "unavailable" },
    isProcessAlive: () => alive.shift() ?? false,
    terminateProcess: (pid) => signals.push({ pid, signal: "SIGTERM" }),
    sleepImpl: async () => {},
    timeoutMs: 100,
    pollMs: 100,
  });

  assert.equal(retired, true);
  assert.deepEqual(signals, [{ pid: 4242, signal: "SIGTERM" }]);
});

test("controlled retirement accepts a KeepAlive replacement only after it matches the requested build", async () => {
  const libraryDir = resolve("/tmp/mosa-keepalive-upgrade-library");
  const staleService = {
    state: "attached",
    url: "http://127.0.0.1:43517",
    port: 43517,
    libraryDir,
    storage: "sqlite",
    productVersion: "0.2.0",
    gitSha: "old-sha",
    uiFingerprint: "old-ui",
    runtimeFingerprint: "old-runtime",
  };
  const expectedIdentity = {
    productVersion: "0.2.1-rc.1",
    gitSha: "new-sha",
    uiFingerprint: "new-ui",
    runtimeFingerprint: "new-runtime",
  };
  const restartedService = { ...staleService, ...expectedIdentity };
  const conflict = new MosaServiceBuildMismatchError({
    details: staleService,
    expectedIdentity,
    mismatches: [{ field: "productVersion", expected: "0.2.1-rc.1", actual: "0.2.0" }],
  });
  const probes = [staleService, restartedService];
  const alive = [true, false];
  const signals = [];

  const retired = await retireOlderMosaService(conflict, {
    readFileImpl: async () => JSON.stringify({ token: "old-runtime-token", pid: 4242 }),
    probeImpl: async () => probes.shift() || restartedService,
    isProcessAlive: () => alive.shift() ?? false,
    terminateProcess: (pid) => signals.push({ pid, signal: "SIGTERM" }),
    sleepImpl: async () => {},
    timeoutMs: 100,
    pollMs: 100,
  });

  assert.equal(retired, true);
  assert.deepEqual(signals, [{ pid: 4242, signal: "SIGTERM" }]);
});

test("attaches to a matching pre-health-endpoint MOSA runtime", async (t) => {
  const root = await temporaryRoot(t, "mosa-service-legacy-attach-");
  const libraryDir = join(root, "library");
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/health") {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    if (req.url === "/api/library-path") {
      res.end(JSON.stringify({
        path: join(libraryDir, "assets", "default"),
        libraryDir,
        storage: "sqlite",
      }));
      return;
    }
    if (req.url === "/api/bridges") {
      res.end(JSON.stringify({ codex: { enabled: true }, cowart: { enabled: true } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "Not found" }));
  });
  await listen(server);
  t.after(() => close(server));

  const service = await startMosaService({ port: server.address().port, libraryDir });
  assert.equal(service.mode, "attached");
  assert.equal(service.storage, "sqlite");
  await service.stop();
  assert.equal(server.listening, true);
});

test("rejects non-MOSA listeners and mismatched libraries", async (t) => {
  const root = await temporaryRoot(t, "mosa-service-conflict-");
  const server = createServer((_req, res) => res.end("not mosa"));
  await listen(server);
  t.after(() => close(server));
  const port = server.address().port;

  await assert.rejects(
    startMosaService({ port, libraryDir: join(root, "library") }),
    MosaServiceConflictError,
  );
  assert.equal(server.listening, true);

  const mosaServer = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ product: "mosa", libraryDir: join(root, "other-library"), storage: "sqlite" }));
  });
  await listen(mosaServer);
  t.after(() => close(mosaServer));
  await assert.rejects(
    startMosaService({ port: mosaServer.address().port, libraryDir: join(root, "library") }),
    MosaServiceConflictError,
  );
  assert.equal(mosaServer.listening, true);
});

test("owns a new runtime and releases its lock on stop", async (t) => {
  const root = await temporaryRoot(t, "mosa-service-owned-");
  const libraryDir = join(root, "library");
  const port = await availablePort();
  const runtimeOptionsForRoot = runtimeOptions(root);
  const service = await startMosaService({ port, libraryDir, runtimeOptions: runtimeOptionsForRoot });
  t.after(() => service.stop());
  assert.equal(service.mode, "owned");
  assert.equal((await fetch(`${service.url}/api/health`)).status, 200);

  await service.stop();
  await assert.rejects(fetch(`${service.url}/api/health`));

  const runtime = await startMosaRuntime({ ...runtimeOptionsForRoot, port: 0, libraryDir });
  await runtime.stop();
});

test("attaches after a port race instead of replacing the new owner", async (t) => {
  const root = await temporaryRoot(t, "mosa-service-race-");
  const libraryDir = join(root, "library");
  const port = await availablePort();
  let raceOwner;
  t.after(() => close(raceOwner));

  const service = await startMosaService({
    port,
    libraryDir,
    startRuntime: async () => {
      raceOwner = createServer((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ product: "mosa", libraryDir, storage: "json" }));
      });
      await listen(raceOwner, port);
      const error = new Error("Address already in use");
      error.code = "EADDRINUSE";
      throw error;
    },
  });

  assert.equal(service.mode, "attached");
  await service.stop();
  assert.equal(raceOwner.listening, true);
});

test("falls back to another discovery port when the preferred port is occupied", async (t) => {
  const root = await temporaryRoot(t, "mosa-service-fallback-");
  const libraryDir = join(root, "library");
  const preferredPort = await availablePort();
  const fallbackPort = await availablePort();
  const foreign = createServer((_req, res) => res.end("foreign listener"));
  await listen(foreign, preferredPort);
  t.after(() => close(foreign));

  const service = await startMosaService({
    port: preferredPort,
    libraryDir,
    allowPortFallback: true,
    discoveryPorts: [preferredPort, fallbackPort],
    runtimeOptions: runtimeOptions(root),
  });
  t.after(() => service.stop());

  assert.equal(service.mode, "owned");
  assert.equal(service.port, fallbackPort);
  assert.equal(foreign.listening, true);
  assert.equal((await fetch(`${service.url}/api/health`)).status, 200);
});

test("discovers an already-running matching MOSA on a fallback port before acquiring the library lock", async (t) => {
  const root = await temporaryRoot(t, "mosa-service-fallback-attach-");
  const libraryDir = join(root, "library");
  const preferredPort = await availablePort();
  const fallbackPort = await availablePort();
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ product: "mosa", libraryDir, storage: "sqlite" }));
  });
  await listen(server, fallbackPort);
  t.after(() => close(server));

  const service = await startMosaService({
    port: preferredPort,
    libraryDir,
    allowPortFallback: true,
    discoveryPorts: [preferredPort, fallbackPort],
  });

  assert.equal(service.mode, "attached");
  assert.equal(service.port, fallbackPort);
  await service.stop();
  assert.equal(server.listening, true);
});
