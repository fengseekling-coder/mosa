/*
 * Theme initialisation — runs synchronously before the stylesheet so that a
 * user who already saved a dark-mode preference never sees the light first
 * paint (FOUC). This is a plain external script (not inline) so it stays
 * inside the runtime CSP of `script-src 'self'`.
 *
 * The storage key and value format mirror app.js exactly:
 *   key:   "mosa-dark-mode"
 *   value: "true" | "false"  (string)
 *
 * Any read failure or unexpected value falls back to light, matching app.mjs.
 */
(function applyInitialTheme() {
  var theme = "light";
  try {
    var stored = localStorage.getItem("mosa-dark-mode");
    if (stored === "true") theme = "dark";
  } catch (error) {
    // localStorage may be unavailable (private mode, sandbox reset). Keep the
    // safe light default so the first paint is always valid.
  }
  document.documentElement.dataset.theme = theme;
})();
