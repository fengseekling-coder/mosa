// Main-process client for the dedicated visual inference child process.
//
// Fail-closed contract: when the worker dies, every pending request rejects
// with a coded error and the client stays dead until restart() is called
// explicitly; nothing silently re-spawns inference. Requests are bounded
// (maxQueue) and time-bounded (timeoutMs) so a hung native session cannot
// leak pending promises. The renderer never receives file paths or spawn
// capabilities through this module.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_QUEUE = 32;
const DEFAULT_INIT_TIMEOUT_MS = 120_000;

export const VISUAL_INFERENCE_ERRORS = Object.freeze({
  BUSY: "VISUAL_INFERENCE_BUSY",
  TIMEOUT: "VISUAL_INFERENCE_TIMEOUT",
  WORKER_EXIT: "VISUAL_INFERENCE_WORKER_EXIT",
  INIT_FAILED: "VISUAL_INFERENCE_INIT_FAILED",
  INIT_TIMEOUT: "VISUAL_INFERENCE_INIT_TIMEOUT",
  IDENTITY_MISMATCH: "VISUAL_INFERENCE_IDENTITY_MISMATCH",
  CLOSED: "VISUAL_INFERENCE_CLOSED",
  PROTOCOL: "VISUAL_INFERENCE_PROTOCOL",
});

export function visualInferenceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createVisualInferenceClient({
  workerEntryPath = defaultWorkerEntryPath(),
  pack = null,
  model = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  initTimeoutMs = DEFAULT_INIT_TIMEOUT_MS,
  maxQueue = DEFAULT_MAX_QUEUE,
  forkOptions = null,
  spawnImpl = null,
  onStateChange = null,
} = {}) {
  let child = null;
  let childState = "idle"; // idle | starting | ready | dead
  let initMessage = null;
  let nextRequestId = 1;
  const pending = new Map();
  const client = {
    get state() {
      return childState;
    },
    get pendingCount() {
      return pending.size;
    },
    isReady() {
      return childState === "ready";
    },
    isRunning() {
      return childState === "starting" || childState === "ready";
    },
    model: null,
    start,
    restart,
    encodeImage,
    encodeText,
    requestStatus,
    close,
  };

  function notifyState() {
    if (typeof onStateChange === "function") {
      try {
        onStateChange({ state: childState, pending: pending.size });
      } catch {
        // Observer failures must not affect request handling.
      }
    }
  }

  function nextId() {
    const id = nextRequestId;
    nextRequestId = (nextRequestId + 1) % Number.MAX_SAFE_INTEGER;
    return id;
  }

  function attachChild(spawned) {
    child = spawned;
    child.on("message", (message) => handleWorkerMessage(message));
    child.on("exit", (code, signal) => {
      const wasConnected = childState === "starting" || childState === "ready";
      child = null;
      childState = "dead";
      failAllPending(wasConnected
        ? visualInferenceError(VISUAL_INFERENCE_ERRORS.WORKER_EXIT,
          `Visual inference worker exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`)
        : visualInferenceError(VISUAL_INFERENCE_ERRORS.WORKER_EXIT, "Visual inference worker is not running."));
      notifyState();
    });
    child.on("error", (error) => {
      // Spawn-level failures (missing entry, permissions) surface here.
      childState = "dead";
      failAllPending(visualInferenceError(VISUAL_INFERENCE_ERRORS.WORKER_EXIT,
        `Visual inference worker failed to start: ${error?.message || error}`));
      notifyState();
    });
  }

  function failAllPending(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function handleWorkerMessage(message) {
    if (!message || typeof message !== "object" || message.requestId === undefined) return;
    const entry = pending.get(message.requestId);
    if (!entry) return;
    pending.delete(message.requestId);
    clearTimeout(entry.timer);
    switch (message.type) {
      case "result":
        entry.resolve(message.vector);
        return;
      case "error":
        entry.reject(visualInferenceError(
          typeof message.code === "string" ? message.code : VISUAL_INFERENCE_ERRORS.PROTOCOL,
          message.message || "Visual inference request failed."));
        return;
      case "ready": {
        if (initMessage && message.model && initMessage.expectedModel) {
          const expected = initMessage.expectedModel;
          const actual = message.model;
          if (actual.id !== expected.id || actual.revision !== expected.revision || Number(actual.dimension) !== Number(expected.dimension)) {
            childState = "dead";
            killChild();
            entry.reject(visualInferenceError(VISUAL_INFERENCE_ERRORS.IDENTITY_MISMATCH,
              `Visual inference worker model identity (${actual.id}@${actual.revision}, dim ${actual.dimension}) does not match the configured index (${expected.id}@${expected.revision}, dim ${expected.dimension}).`));
            notifyState();
            return;
          }
        }
        client.model = message.model || null;
        childState = "ready";
        entry.resolve(message);
        notifyState();
        return;
      }
      case "pong":
      case "report":
        entry.resolve(message);
        return;
      default:
        entry.reject(visualInferenceError(VISUAL_INFERENCE_ERRORS.PROTOCOL,
          `Visual inference worker sent an unexpected message type: ${String(message.type)}.`));
        return;
    }
  }

  function spawnWorker() {
    const base = forkOptions || {};
    const env = { ...(base.env || process.env) };
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
    const stdio = base.stdio
      ? (Array.isArray(base.stdio) && !base.stdio.includes("ipc") ? [...base.stdio, "ipc"] : base.stdio)
      : ["ignore", "ignore", "inherit", "ipc"];
    const spawned = (spawnImpl || fork)(workerEntryPath, base.args || [], {
      serialization: "advanced",
      stdio,
      ...base,
      env,
    });
    attachChild(spawned);
    childState = "starting";
    notifyState();
    return spawned;
  }

  function killChild() {
    if (child) {
      const current = child;
      child = null;
      try {
        current.kill();
      } catch {
        // A worker that refuses to die still fails the pending requests above.
      }
    }
  }

  async function start() {
    if (childState === "ready") return client.model;
    if (childState === "starting") {
      // Join the in-flight initialization instead of spawning a duplicate.
      return withInitWait();
    }
    failAllPending(visualInferenceError(VISUAL_INFERENCE_ERRORS.WORKER_EXIT, "Visual inference worker is restarting."));
    killChild();
    const spawned = spawnWorker();
    const requestId = nextId();
    initMessage = {
      requestId,
      expectedModel: model || (pack ? { id: pack.id, revision: pack.revision, dimension: pack.embedding_dimension } : null),
    };
    const timer = setTimeout(() => {
      const entry = pending.get(requestId);
      if (entry) {
        pending.delete(requestId);
        childState = "dead";
        killChild();
        entry.reject(visualInferenceError(VISUAL_INFERENCE_ERRORS.INIT_TIMEOUT,
          `Visual inference worker did not initialize within ${initTimeoutMs} ms.`));
        notifyState();
      }
    }, initTimeoutMs);
    const initPromise = new Promise((resolve, reject) => {
      pending.set(requestId, {
        resolve: (value) => resolve(value?.model ?? client.model),
        reject,
        timer,
      });
    });
    spawned.send({
      type: "init",
      requestId,
      packDir: pack?.pack_dir || null,
      model: initMessage.expectedModel,
    });
    return initPromise;
  }

  async function withInitWait() {
    const startedAt = Date.now();
    while (childState === "starting" && Date.now() - startedAt < initTimeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (childState === "ready") return client.model;
    if (childState === "dead") {
      throw visualInferenceError(VISUAL_INFERENCE_ERRORS.INIT_FAILED, "Visual inference worker failed to initialize.");
    }
    throw visualInferenceError(VISUAL_INFERENCE_ERRORS.INIT_TIMEOUT, "Visual inference worker initialization timed out.");
  }

  async function restart() {
    childState = "idle";
    client.model = null;
    killChild();
    return start();
  }

  function request(type, payload, timeout) {
    if (childState !== "ready") {
      return Promise.reject(visualInferenceError(
        VISUAL_INFERENCE_ERRORS.WORKER_EXIT,
        "Visual inference worker is not ready; call start() or restart() first."));
    }
    if (pending.size >= maxQueue) {
      return Promise.reject(visualInferenceError(VISUAL_INFERENCE_ERRORS.BUSY,
        `Visual inference queue is full (${maxQueue} pending requests).`));
    }
    const requestId = nextId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        // A request that outruns its timeout is treated as a hung native
        // session: kill the worker and fail closed instead of leaving it
        // wedged while new requests queue behind the stuck one.
        childState = "dead";
        killChild();
        notifyState();
        reject(visualInferenceError(VISUAL_INFERENCE_ERRORS.TIMEOUT,
          `Visual inference request timed out after ${timeout} ms; the worker was stopped.`));
      }, timeout);
      pending.set(requestId, { resolve, reject, timer });
      child.send({ type, requestId, ...payload }, (error) => {
        if (error) {
          pending.delete(requestId);
          clearTimeout(timer);
          reject(visualInferenceError(VISUAL_INFERENCE_ERRORS.WORKER_EXIT,
            `Visual inference worker rejected the request: ${error.message}`));
        }
      });
    });
  }

  function encodeImage(imagePath, context = {}) {
    return request("encode-image", {
      imagePath,
      projectId: context.projectId ?? null,
      assetId: context.assetId ?? null,
      contentSha256: context.contentSha256 ?? null,
    }, timeoutMs);
  }

  function encodeText(text, context = {}) {
    return request("encode-text", {
      text,
      projectId: context.projectId ?? null,
    }, timeoutMs);
  }

  function requestStatus() {
    if (childState !== "ready") {
      return Promise.resolve({ initialized: false, model: null, memory: null, uptime: null });
    }
    return request("status", {}, timeoutMs);
  }

  async function close() {
    if (child && childState !== "dead") {
      const current = child;
      try {
        current.send({ type: "shutdown" });
      } catch {
        // The exit handler will clean up regardless.
      }
      const exited = new Promise((resolve) => {
        if (!current.connected) return resolve();
        current.once("exit", () => resolve());
      });
      const grace = new Promise((resolve) => setTimeout(resolve, 1500));
      await Promise.race([exited, grace]);
      if (current.exitCode === null && current.signalCode === null) current.kill();
    }
    child = null;
    childState = "dead";
    failAllPending(visualInferenceError(VISUAL_INFERENCE_ERRORS.CLOSED, "Visual inference client is closed."));
    notifyState();
  }

  return client;
}

function defaultWorkerEntryPath() {
  return fileURLToPath(new URL("./visual-inference-worker-entry.mjs", import.meta.url));
}
