/**
 * Serializes bridge-status polling for the SPA:
 * - at most one in-flight request at any moment;
 * - triggers arriving during a flight coalesce into a single follow-up request,
 *   so timer ticks and manual refreshes never pile up;
 * - only the newest response commits, and responses that finish after teardown
 *   are dropped, so stale state can never overwrite fresher UI state.
 */
export function createBridgeStatusPoller(options = {}) {
  const { fetchStatus, onSuccess, onError } = options;
  if (typeof fetchStatus !== "function") throw new Error("Bridge status poller requires a fetchStatus callback.");
  const intervalMs = Number.isFinite(options.intervalMs) ? Math.max(1, options.intervalMs) : 5000;
  const setTimer = typeof options.setInterval === "function" ? options.setInterval : (callback, ms) => setInterval(callback, ms);
  const clearTimer = typeof options.clearInterval === "function" ? options.clearInterval : (handle) => clearInterval(handle);

  let timer = null;
  let inFlight = false;
  let queuedRefresh = false;
  let stopped = false;
  let issuedSequence = 0;
  let appliedSequence = 0;
  let activeCycle = null;

  function commit(sequence, error, payload) {
    if (stopped || sequence <= appliedSequence) return;
    appliedSequence = sequence;
    try {
      if (error) onError?.(error);
      else onSuccess?.(payload);
    } catch {
      // A failing commit callback must never break the polling loop.
    }
  }

  async function runCycle() {
    try {
      do {
        queuedRefresh = false;
        const sequence = ++issuedSequence;
        try {
          commit(sequence, null, await fetchStatus());
        } catch (error) {
          commit(sequence, error, undefined);
        }
      } while (queuedRefresh && !stopped);
    } finally {
      inFlight = false;
      activeCycle = null;
    }
  }

  function refresh() {
    if (stopped) return Promise.resolve();
    if (inFlight) {
      queuedRefresh = true;
      return activeCycle;
    }
    inFlight = true;
    activeCycle = runCycle();
    return activeCycle;
  }

  function start() {
    if (timer !== null || stopped) return;
    timer = setTimer(() => { void refresh(); }, intervalMs);
  }

  function stop() {
    stopped = true;
    queuedRefresh = false;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  // M6：隐藏标签页暂停定时触发（在途请求照常完成并提交，commit 的代际守卫不变）。
  // stop 的 teardown 语义保持不可逆——resume 不复活已 stop 的实例；bfcache 恢复
  // 由 app.mjs 重建新实例。
  function pause() {
    if (stopped || timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function resume() {
    if (stopped) return;
    start();
  }

  return { refresh, start, stop, pause, resume };
}
