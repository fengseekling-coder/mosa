import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import {
  DEFAULT_MOSA_DESKTOP_PORT,
  DEFAULT_MOSA_DISCOVERY_PORTS,
  MOSA_RESERVED_PRODUCTION_PORTS,
  normalizeMosaPort,
} from "../lib/runtime-defaults.mjs";
import { validateRuntimeIsolation } from "../lib/runtime-isolation-guard.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PROBE_TIMEOUT_MS = 1500;

export class MosaServiceConflictError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "MosaServiceConflictError";
  }
}

/**
 * Attaches to a verified local MOSA service or starts one that this process
 * owns. It deliberately never terminates a process that already owns a port.
 *
 * `options.isolationContext` carries the QA runtime parameters that
 * desktop/main.mjs resolved once (runtimeMode, qaRun, expected/actual
 * userData, production default, argv, runtimeKind) and forwards them to the
 * guard and into startMosaRuntime. Propagation never falls back to
 * process.env inside this layer.
 */
export async function startMosaService(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port = normalizeMosaPort(options.port ?? DEFAULT_MOSA_DESKTOP_PORT, { label: "MOSA desktop port" });
  const libraryDir = resolve(options.libraryDir || join(homedir(), "MOSA Library"));
  const isolation = options.isolationContext || {};

  // ---- Runtime isolation guard: fail closed before any production write ----
  const guard = validateRuntimeIsolation({
    libraryDir: options.libraryDir,
    port,
    runtimeMode: isolation.runtimeMode ?? options.runtimeMode ?? process.env.MOSA_RUNTIME_MODE,
    qaRun: isolation.qaRun ?? options.qaRun ?? process.env.MOSA_QA_RUN,
    userData: isolation.expectedUserData ?? options.userData ?? process.env.MOSA_USER_DATA,
    actualUserData: isolation.actualUserData ?? options.actualUserData,
    argv: isolation.argv ?? options.argv ?? process.argv,
    defaultUserData: isolation.productionDefaultUserData,
    runtimeKind: isolation.runtimeKind,
    productionLibraryDir: join(homedir(), "MOSA Library"),
    productionPorts: MOSA_RESERVED_PRODUCTION_PORTS,
  });
  if (!guard.ok) {
    throw new Error(`ISOLATION_GUARD_REJECTED: ${guard.field} ${guard.reason}`);
  }

  const discoveryPorts = Array.isArray(options.discoveryPorts) && options.discoveryPorts.length
    ? options.discoveryPorts.map((candidate) => normalizeMosaPort(candidate, { label: "MOSA discovery port" }))
    : DEFAULT_MOSA_DISCOVERY_PORTS;
  const candidatePorts = options.allowPortFallback
    ? [...new Set([port, ...discoveryPorts])]
    : [port];
  let lastConflict = null;
  let identityMismatch = null;
  const availablePorts = [];

  for (const candidatePort of candidatePorts) {
    const probeOptions = {
      host,
      port: candidatePort,
      libraryDir,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.probeTimeoutMs,
    };

    const initial = await probeMosaService(probeOptions);
    if (initial.state === "attached") {
      const identityConflict = serviceIdentityConflict(initial, options.expectedIdentity);
      if (!identityConflict) return attachedService(initial);
      lastConflict = identityConflict;
      identityMismatch = identityConflict;
      continue;
    }
    if (initial.state === "conflict") {
      lastConflict = initial.error;
      continue;
    }
    availablePorts.push(candidatePort);
  }

  // A verified MOSA for this exact library is already alive, but it does not
  // match the desktop build. Starting a second runtime on another port would
  // race the same library lock and, worse, conceal the stale-service problem.
  if (identityMismatch) throw identityMismatch;

  for (const candidatePort of availablePorts) {
    const probeOptions = {
      host,
      port: candidatePort,
      libraryDir,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.probeTimeoutMs,
    };

    try {
      const runtime = await (options.startRuntime || startMosaRuntime)({
        ...(options.runtimeOptions || {}),
        port: candidatePort,
        libraryDir,
        isolationContext: options.isolationContext,
        importStagingRoot: options.importStagingRoot ?? null,
      });
      return ownedService(runtime);
    } catch (error) {
      const retry = await probeMosaService(probeOptions);
      if (retry.state === "attached") {
        const identityConflict = serviceIdentityConflict(retry, options.expectedIdentity);
        if (!identityConflict) return attachedService(retry);
        lastConflict = identityConflict;
        continue;
      }
      if (retry.state === "conflict") {
        lastConflict = retry.error;
        continue;
      }
      if (error?.code === "EADDRINUSE") continue;
      throw error;
    }
  }

  if (lastConflict) throw lastConflict;
  throw new MosaServiceConflictError("No MOSA desktop discovery port is available.");
}

export async function probeMosaService(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port = normalizeMosaPort(options.port ?? DEFAULT_MOSA_DESKTOP_PORT, { label: "MOSA desktop port" });
  const libraryDir = resolve(options.libraryDir || join(homedir(), "MOSA Library"));
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(100, Number(options.timeoutMs))
    : DEFAULT_PROBE_TIMEOUT_MS;
  const url = `http://${host}:${port}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${url}/api/health`, { signal: controller.signal });
    let health;
    if (response.ok) {
      health = await response.json();
    } else if (response.status === 404) {
      health = await probeLegacyMosaIdentity({ url, fetchImpl, signal: controller.signal });
    } else {
      return conflict(`Port ${port} is occupied by a service that is not a healthy MOSA runtime.`);
    }
    if (health?.product !== "mosa" || typeof health.libraryDir !== "string") {
      return conflict(`Port ${port} is occupied by a service that is not MOSA.`);
    }
    if (resolve(health.libraryDir) !== libraryDir) {
      return conflict(`Port ${port} is serving a different MOSA library.`);
    }
    return {
      state: "attached",
      url,
      port,
      libraryDir,
      storage: typeof health.storage === "string" ? health.storage : "unknown",
      productVersion: typeof health.productVersion === "string" ? health.productVersion : "unknown",
      gitSha: typeof health.gitSha === "string" ? health.gitSha : "unknown",
      uiFingerprint: typeof health.uiFingerprint === "string" ? health.uiFingerprint : "unknown",
      runtimeFingerprint: typeof health.runtimeFingerprint === "string" ? health.runtimeFingerprint : "unknown",
    };
  } catch (error) {
    if (isConnectionRefused(error)) return { state: "unavailable" };
    const reason = error?.name === "AbortError"
      ? `Port ${port} did not respond before the MOSA probe timed out.`
      : `Port ${port} is occupied but could not be verified as MOSA.`;
    return conflict(reason, error);
  } finally {
    clearTimeout(timer);
  }
}

async function probeLegacyMosaIdentity({ url, fetchImpl, signal }) {
  const [libraryResponse, bridgesResponse] = await Promise.all([
    fetchImpl(`${url}/api/library-path`, { signal }),
    fetchImpl(`${url}/api/bridges`, { signal }),
  ]);
  if (!libraryResponse.ok || !bridgesResponse.ok) return null;

  const [library, bridges] = await Promise.all([
    libraryResponse.json(),
    bridgesResponse.json(),
  ]);
  const hasLibraryContract = typeof library?.libraryDir === "string"
    && typeof library?.path === "string"
    && typeof library?.storage === "string";
  const hasBridgeContract = bridges && typeof bridges === "object"
    && bridges.codex && typeof bridges.codex === "object"
    && bridges.cowart && typeof bridges.cowart === "object";
  if (!hasLibraryContract || !hasBridgeContract) return null;

  return {
    product: "mosa",
    libraryDir: library.libraryDir,
    storage: library.storage,
  };
}

function attachedService(details) {
  return {
    mode: "attached",
    url: details.url,
    port: details.port,
    libraryDir: details.libraryDir,
    storage: details.storage,
    productVersion: details.productVersion || "unknown",
    gitSha: details.gitSha || "unknown",
    uiFingerprint: details.uiFingerprint || "unknown",
    runtimeFingerprint: details.runtimeFingerprint || "unknown",
    stop: async () => {},
  };
}

function ownedService(runtime) {
  let stopPromise = null;
  return {
    mode: "owned",
    url: runtime.url,
    port: runtime.port,
    libraryDir: runtime.libraryDir,
    storage: runtime.storage,
    stop() {
      if (!stopPromise) stopPromise = runtime.stop();
      return stopPromise;
    },
  };
}

function conflict(message, cause) {
  return { state: "conflict", error: new MosaServiceConflictError(message, { cause }) };
}

function serviceIdentityConflict(details, expectedIdentity) {
  if (!expectedIdentity || typeof expectedIdentity !== "object") return null;
  const fields = ["productVersion", "gitSha", "uiFingerprint", "runtimeFingerprint"];
  const mismatches = [];
  for (const field of fields) {
    const expected = String(expectedIdentity[field] || "unknown");
    const actual = String(details[field] || "unknown");
    if (expected === "unknown") continue;
    if (actual === "unknown") {
      mismatches.push(`${field} expected ${expected} but the running service cannot report it`);
      continue;
    }
    if (expected !== actual) mismatches.push(`${field} expected ${expected} but found ${actual}`);
  }
  if (!mismatches.length) return null;
  return new MosaServiceConflictError(
    `A MOSA service for this library is already running with a different build identity (${mismatches.join("; ")}). Restart MOSA so the service and desktop app use the same build.`,
  );
}

function isConnectionRefused(error) {
  return error?.cause?.code === "ECONNREFUSED" || error?.code === "ECONNREFUSED";
}
