/*
 * Theme initialisation — runs synchronously before the stylesheet so that a
 * user who already saved a dark-mode preference never sees the light first
 * paint (FOUC). This is a plain external script (not inline) so it stays
 * inside the runtime CSP of `script-src 'self'`.
 *
 * The storage key and value format mirror app.mjs exactly:
 *   key:   "mosa-dark-mode"
 *   value: "true" (dark) | "false" (light) | "system" — 任务 81 返工 1
 *
 * A missing/"system"/unexpected value follows the system appearance
 * (prefers-color-scheme), matching app.mjs; if that is unavailable too,
 * the safe light default keeps the first paint valid.
 */
(function applyInitialTheme() {
  function systemTheme() {
    try {
      if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
        return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
    } catch (error) {
      // matchMedia unavailable — fall through to the light default.
    }
    return "light";
  }
  var stored = null;
  try {
    stored = localStorage.getItem("mosa-dark-mode");
  } catch (error) {
    // localStorage may be unavailable (private mode, sandbox reset).
    stored = null;
  }
  var theme = stored === "true" ? "dark" : stored === "false" ? "light" : systemTheme();
  document.documentElement.dataset.theme = theme;
  if (typeof window !== "undefined" && window.electronAPI) {
    document.documentElement.classList.add("electron-shell");
  }
})();
