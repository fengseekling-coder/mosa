import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CONCURRENCY = 2;
const VIDEO_EXTENSIONS = new Set([".m4v", ".mov", ".mp4", ".webm"]);
const DERIVATIVE_PROCESSOR_PATH = fileURLToPath(new URL("./derivative-processor.js", import.meta.url));

interface DerivativeJob {
  project_id?: string;
  asset_id?: string;
  original_path?: string;
  previewPath: string;
  mediumPath: string;
  thumbnailPath: string;
}

interface DerivativeStore {
  derivativesAvailable?: boolean;
  claimDerivativeJob(): Promise<DerivativeJob | null>;
  completeDerivativeJob(job: DerivativeJob, result: Record<string, unknown>): Promise<void>;
  isAssetActive?(projectId: string, assetId: string): Promise<boolean>;
  withAssetLifecycleLock?<T>(projectId: string, assetId: string, task: () => Promise<T>): Promise<T>;
}

interface DerivativeWorker {
  start(): void;
  stop(): Promise<void>;
  wake(): void;
  readonly active: number;
}

interface DerivativeProcessorResult extends Record<string, unknown> {
  previewPath: string;
  mediumPath: string;
  thumbnailPath: string;
  width: number;
  height: number;
  processorPid: number;
}

interface DerivativeProcessor {
  process(job: DerivativeJob): Promise<DerivativeProcessorResult>;
  close(): Promise<void>;
  readonly pid: number | null;
}

interface ProcessorTransport {
  readonly pid: number | null;
  send(message: Record<string, unknown>): void;
  kill(): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number | null, signal?: string | null) => void): void;
  onError(listener: (error: unknown) => void): void;
}

async function createProcessorTransport(): Promise<ProcessorTransport> {
  const runtimeProcess = process as NodeJS.Process & { type?: string };
  if (process.versions.electron && runtimeProcess.type === "browser") {
    const { utilityProcess } = await import("electron");
    const child = utilityProcess.fork(DERIVATIVE_PROCESSOR_PATH, [], {
      stdio: "ignore",
      serviceName: "MOSA Image Processor",
    });
    return {
      get pid() { return child.pid || null; },
      send(message) { child.postMessage(message); },
      kill() { child.kill(); },
      onMessage(listener) { child.on("message", listener); },
      onExit(listener) { child.once("exit", (code) => listener(code, null)); },
      onError(listener) { child.on("error", listener); },
    };
  }

  const child = fork(DERIVATIVE_PROCESSOR_PATH, [], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  return {
    get pid() { return child.pid || null; },
    send(message) {
      if (!child.connected) throw new Error("Derivative processor IPC channel is closed.");
      child.send(message);
    },
    kill() { child.kill(); },
    onMessage(listener) { child.on("message", listener); },
    onExit(listener) { child.once("exit", listener); },
    onError(listener) { child.on("error", listener); },
  };
}

export function createDerivativeProcessor(): DerivativeProcessor {
  let transport: ProcessorTransport | null = null;
  let starting: Promise<ProcessorTransport> | null = null;
  let generation = 0;
  const pending = new Map<string, {
    resolve: (result: DerivativeProcessorResult) => void;
    reject: (error: Error) => void;
  }>();

  function rejectPending(error: Error) {
    const requests = [...pending.values()];
    pending.clear();
    for (const request of requests) request.reject(error);
  }

  function bindTransport(next: ProcessorTransport, boundGeneration: number) {
    next.onMessage((message) => {
      if (boundGeneration !== generation || !message || typeof message !== "object" || Array.isArray(message)) return;
      const response = message as Record<string, unknown>;
      if (response.type !== "derivative-result" || typeof response.requestId !== "string") return;
      const request = pending.get(response.requestId);
      if (!request) return;
      pending.delete(response.requestId);
      if (response.ok === true && response.result && typeof response.result === "object") {
        request.resolve(response.result as DerivativeProcessorResult);
      } else {
        request.reject(new Error(String(response.error || "Derivative processor failed.")));
      }
    });
    next.onExit((code, signal) => {
      if (boundGeneration !== generation) return;
      transport = null;
      starting = null;
      rejectPending(new Error(`Derivative processor exited unexpectedly${code != null ? ` (code ${code})` : signal ? ` (${signal})` : ""}.`));
    });
    next.onError((error) => {
      if (boundGeneration !== generation) return;
      transport = null;
      starting = null;
      rejectPending(new Error(`Derivative processor failed: ${error instanceof Error ? error.message : String(error)}`));
      try { next.kill(); } catch {}
    });
  }

  async function ensureTransport(): Promise<ProcessorTransport> {
    if (transport) return transport;
    if (!starting) {
      const boundGeneration = ++generation;
      starting = createProcessorTransport().then((next) => {
        if (boundGeneration !== generation) {
          try { next.kill(); } catch {}
          throw new Error("Derivative processor startup was superseded.");
        }
        transport = next;
        bindTransport(next, boundGeneration);
        return next;
      }).finally(() => {
        if (boundGeneration === generation) starting = null;
      });
    }
    return starting;
  }

  return {
    async process(job) {
      const child = await ensureTransport();
      const requestId = randomUUID();
      return new Promise<DerivativeProcessorResult>((resolveResult, rejectResult) => {
        pending.set(requestId, { resolve: resolveResult, reject: rejectResult });
        try {
          child.send({
            type: "process-derivative",
            requestId,
            job: {
              original_path: String(job.original_path || ""),
              previewPath: job.previewPath,
              mediumPath: job.mediumPath,
              thumbnailPath: job.thumbnailPath,
            },
          });
        } catch (error) {
          pending.delete(requestId);
          rejectResult(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    async close() {
      const child = transport || await starting?.catch(() => null) || null;
      generation += 1;
      transport = null;
      starting = null;
      rejectPending(new Error("Derivative processor was stopped."));
      if (!child) return;
      await new Promise<void>((resolveClose) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolveClose();
        };
        child.onExit(() => finish());
        try { child.kill(); } catch { finish(); }
        setTimeout(finish, 1000).unref?.();
      });
    },
    get pid() {
      return transport?.pid || null;
    },
  };
}

/**
 * Drains SQLite-backed derivative jobs without loading native image decoders
 * into the MOSA runtime process. Image decoding lives in a disposable child
 * process, so a native crash fails the current jobs instead of taking down the
 * library service.
 */
export function createDerivativeWorker(options: {
  store?: DerivativeStore;
  concurrency?: number;
  idleDelayMs?: number;
  processor?: DerivativeProcessor;
} = {}): DerivativeWorker {
  const store = options.store;
  const processor = options.processor || createDerivativeProcessor();
  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || DEFAULT_CONCURRENCY, DEFAULT_CONCURRENCY));
  const idleDelayMs = Math.max(250, Number(options.idleDelayMs) || 1000);
  let stopped = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active = 0;
  let stopWaiters: Array<() => void> = [];

  function settleStopWaiters(): void {
    if (!stopped || active !== 0 || stopWaiters.length === 0) return;
    const waiters = stopWaiters;
    stopWaiters = [];
    for (const resolveStop of waiters) resolveStop();
  }

  async function schedule(): Promise<void> {
    if (stopped || !store) return;
    while (active < concurrency && !stopped) {
      const job = await store.claimDerivativeJob();
      if (!job) break;
      active += 1;
      processDerivativeJob(store, job, { processor })
        .catch(() => {})
        .finally(() => {
          active -= 1;
          settleStopWaiters();
          void schedule();
        });
    }
    if (!stopped && active === 0) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void schedule(), idleDelayMs);
    }
  }

  return {
    start() {
      if (!store?.derivativesAvailable || !stopped) return;
      stopped = false;
      void schedule();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (active !== 0) await new Promise<void>((resolveStop) => stopWaiters.push(resolveStop));
      await processor.close();
    },
    wake() {
      if (!stopped) void schedule();
    },
    get active() {
      return active;
    },
  };
}

export async function processDerivativeJob(
  store: DerivativeStore,
  job: DerivativeJob,
  options: { processor?: DerivativeProcessor } = {},
): Promise<Record<string, unknown>> {
  const processor = options.processor || createDerivativeProcessor();
  const ownsProcessor = !options.processor;
  const run = async (): Promise<Record<string, unknown>> => {
    const projectId = String(job.project_id || "default");
    const assetId = String(job.asset_id || "");
    if (assetId && store.isAssetActive && !await store.isAssetActive(projectId, assetId)) {
      return { ok: false, skipped: true, error: "Asset is no longer active." };
    }
    if (VIDEO_EXTENSIONS.has(extname(String(job.original_path || "")).toLowerCase())) {
      const error = "Video assets are served as original media; derivative generation is skipped.";
      await store.completeDerivativeJob(job, { error });
      return { ok: false, error, skipped: true };
    }
    let result: DerivativeProcessorResult;
    try {
      result = await processor.process(job);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.completeDerivativeJob(job, { error: message });
      return { ok: false, error: message };
    }
    await store.completeDerivativeJob(job, result);
    return { ok: true, ...result };
  };
  const projectId = String(job.project_id || "default");
  const assetId = String(job.asset_id || "");
  try {
    return await (assetId && store.withAssetLifecycleLock
      ? store.withAssetLifecycleLock(projectId, assetId, run)
      : run());
  } finally {
    if (ownsProcessor) await processor.close();
  }
}
