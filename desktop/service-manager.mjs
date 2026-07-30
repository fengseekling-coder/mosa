import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { DEFAULT_MOSA_DESKTOP_PORT, normalizeMosaPort } from "../lib/runtime-defaults.mjs";

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
 */
export async function startMosaService(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port = normalizeMosaPort(options.port ?? DEFAULT_MOSA_DESKTOP_PORT, { label: "MOSA desktop port" });
  const libraryDir = resolve(options.libraryDir || join(homedir(), "MOSA Library"));
  const probeOptions = {
    host,
    port,
    libraryDir,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.probeTimeoutMs,
  };

  const initial = await probeMosaService(probeOptions);
  if (initial.state === "attached") return attachedService(initial);
  if (initial.state === "conflict") throw initial.error;

  try {
    const runtime = await (options.startRuntime || startMosaRuntime)({
      ...(options.runtimeOptions || {}),
      port,
      libraryDir,
    });
    return ownedService(runtime);
  } catch (error) {
    // Another desktop/CLI process can bind the port or acquire the library lock
    // after the first probe. A single re-probe distinguishes a safe attach from
    // a real conflict without ever replacing the new owner.
    const retry = await probeMosaService(probeOptions);
    if (retry.state === "attached") return attachedService(retry);
    if (retry.state === "conflict") throw retry.error;
    throw error;
  }
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

function isConnectionRefused(error) {
  return error?.cause?.code === "ECONNREFUSED" || error?.code === "ECONNREFUSED";
}
