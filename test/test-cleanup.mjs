import { rm } from "node:fs/promises";

export function removeTestPath(path, options = {}) {
  return rm(path, {
    ...options,
    maxRetries: options.maxRetries ?? (process.platform === "win32" ? 10 : 3),
    retryDelay: options.retryDelay ?? (process.platform === "win32" ? 200 : 50),
  });
}

// Windows teardown ordering guarantee.
//
// node:test runs t.after hooks in registration order, so a removal registered
// next to mkdtemp always runs BEFORE the stop/close hooks registered later for
// the SQLite stores, runtimes, and servers created inside the same test.
// Deleting a directory that still backs an open database or listening server
// turns every unlink on Windows into an EBUSY retry storm, and when rm finally
// rejects, node:test aborts the remaining after hooks, so the resources are
// never stopped and the test process never exits.
//
// The removal must also stay out of the test hooks entirely: hooks registered
// on the root test are inherited by subtests, so even a file-level after()
// hook ends up running around the subtests' own teardown hooks.
//
// Deferred removals therefore drain from a `beforeExit` handler instead. The
// event loop only drains after every per-test teardown hook has completed, so
// resources are always stopped and closed first, and deletion only ever sees
// released handles. The bounded retries in removeTestPath stay reserved for
// antivirus and filesystem latency, not for resources that were never stopped.
const deferredRemovals = [];
let drainState = "idle";
let drainHookRegistered = false;

function drainDeferredRemovals() {
  if (drainState !== "idle" || deferredRemovals.length === 0) return;
  drainState = "draining";
  void (async () => {
    let firstError = null;
    while (deferredRemovals.length > 0) {
      const [pendingPath, pendingOptions] = deferredRemovals.shift();
      try {
        await removeTestPath(pendingPath, pendingOptions);
      } catch (error) {
        firstError = firstError ?? error;
      }
    }
    drainState = "idle";
    if (firstError) {
      console.error(`[MOSA TEST] temporary path cleanup failed: ${firstError?.message || firstError}`);
      if (process.exitCode === 0 || process.exitCode === undefined) process.exitCode = 1;
    }
  })();
}

export function deferTestPathRemoval(path, options = {}) {
  deferredRemovals.push([path, options]);
  if (!drainHookRegistered) {
    drainHookRegistered = true;
    process.once("beforeExit", drainDeferredRemovals);
  }
}
