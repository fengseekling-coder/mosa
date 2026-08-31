import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

/**
 * Regression guard for the settings-menu event-binding refactor.
 *
 * Background: `renderSettingsMenu()` previously attached a fresh click
 * listener to `els.settingsMenu` on every re-render, stacking on top of the
 * delegation listener already registered in `bindEvents()`.  The fix removed
 * all event wiring from `renderSettingsMenu()` so that clicks are handled by a
 * single delegated listener in `bindEvents()`.
 *
 * These tests pin the fix so a future edit cannot silently reintroduce the
 * duplicate-binding bug.
 */
test("renderSettingsMenu does not attach any event listeners", async () => {
  const app = await readFile(resolve(root, "app/app.mjs"), "utf8");

  const match = /function renderSettingsMenu\(\) \{([\s\S]*?)\n\}\n\nfunction cowartCanvasLabel/.exec(app);
  assert.ok(match, "expected to find renderSettingsMenu function body");
  const body = match[1];

  assert.doesNotMatch(body, /addEventListener/, "renderSettingsMenu must not call addEventListener");
});

test("bindEvents registers the settingsMenu click delegation exactly once", async () => {
  const app = await readFile(resolve(root, "app/app.mjs"), "utf8");

  const match = /function bindEvents\(\) \{([\s\S]*?)\n\}\n\nfunction bindDesktopIntegration/.exec(app);
  assert.ok(match, "expected to find bindEvents function body");
  const body = match[1];

  const settingsMenuClickBindings = body.match(/els\.settingsMenu\?\.addEventListener\("click"/g) || [];
  assert.equal(settingsMenuClickBindings.length, 1, "settingsMenu click delegation must be registered exactly once in bindEvents");
});

test("bindEvents contains the theme-switch handler using real state", async () => {
  const app = await readFile(resolve(root, "app/app.mjs"), "utf8");

  const match = /function bindEvents\(\) \{([\s\S]*?)\n\}\n\nfunction bindDesktopIntegration/.exec(app);
  assert.ok(match, "expected to find bindEvents function body");
  const body = match[1];

  // The HTML attribute data-appearance-opt is accessed via the camelCase
  // DOM dataset API as dataset.appearanceOpt in the click delegation handler.
  assert.match(body, /dataset\.appearanceOpt/, "bindEvents must handle data-appearance-opt via dataset.appearanceOpt");
  assert.match(body, /state\.darkMode = newTheme === "dark"/, "bindEvents must set state.darkMode from the selected theme");
});

test("bindEvents contains the density-switch handler using real state", async () => {
  const app = await readFile(resolve(root, "app/app.mjs"), "utf8");

  const match = /function bindEvents\(\) \{([\s\S]*?)\n\}\n\nfunction bindDesktopIntegration/.exec(app);
  assert.ok(match, "expected to find bindEvents function body");
  const body = match[1];

  // The HTML attribute data-density-opt is accessed via the camelCase
  // DOM dataset API as dataset.densityOpt in the click delegation handler.
  assert.match(body, /dataset\.densityOpt/, "bindEvents must handle data-density-opt via dataset.densityOpt");
  assert.match(body, /state\.galleryDensity = normalizeDensity/, "bindEvents must set state.galleryDensity via normalizeDensity");
});

test("legacy densityToggle references have been removed from app.js", async () => {
  const app = await readFile(resolve(root, "app/app.mjs"), "utf8");

  assert.doesNotMatch(app, /els\.densityToggle/, "app.js must not reference els.densityToggle");
  assert.doesNotMatch(app, /renderDensityToggle/, "app.js must not reference renderDensityToggle");
});

test("renderSettingsMenu uses real state for segmented control active status", async () => {
  const app = await readFile(resolve(root, "app/app.mjs"), "utf8");

  const match = /function renderSettingsMenu\(\) \{([\s\S]*?)\n\}\n\nfunction cowartCanvasLabel/.exec(app);
  assert.ok(match, "expected to find renderSettingsMenu function body");
  const body = match[1];

  // Theme active state must key off state.darkMode, not a tautological literal.
  assert.match(body, /state\.darkMode/, "renderSettingsMenu must use state.darkMode for theme active status");
  // Density active state must key off state.galleryDensity, not a tautological literal.
  assert.match(body, /state\.galleryDensity/, "renderSettingsMenu must use state.galleryDensity for density active status");
  assert.match(body, /state\.anonymousUsageEnabled/, "renderSettingsMenu must use state.anonymousUsageEnabled for anonymous metrics status");
  // No tautological self-comparisons that would make the active class always-on.
  assert.doesNotMatch(body, /"light"\s*===\s*"light"/, "renderSettingsMenu must not contain tautological light comparison");
  assert.doesNotMatch(body, /"dark"\s*===\s*"dark"/, "renderSettingsMenu must not contain tautological dark comparison");
  assert.doesNotMatch(body, /"image"\s*===\s*"image"/, "renderSettingsMenu must not contain tautological image comparison");
  assert.doesNotMatch(body, /"info"\s*===\s*"info"/, "renderSettingsMenu must not contain tautological info comparison");
});

test("removed diagnostics panel leaves no dead renderer hooks or copy", async () => {
  const [app, i18n] = await Promise.all([
    readFile(resolve(root, "app/app.mjs"), "utf8"),
    readFile(resolve(root, "app/i18n.mjs"), "utf8"),
  ]);
  assert.doesNotMatch(app, /diagnosticsPanel|diagnosticsContent|diagnosticsExpanded|fetchDiagnostics/);
  assert.doesNotMatch(i18n, /diagMcpVersion|diagUiFingerprint|showDiagnostics|hideDiagnostics/);
});

test("theme switching is owned by settings instead of a duplicate topbar control", async () => {
  const [app, html] = await Promise.all([
    readFile(resolve(root, "app/app.mjs"), "utf8"),
    readFile(resolve(root, "app/index.html"), "utf8"),
  ]);

  assert.doesNotMatch(html, /id="themeToggle"/,
    "the topbar must not duplicate the theme control already available in settings");
  assert.doesNotMatch(app, /themeToggle|toggleDarkMode/,
    "renderer code must not retain dead wiring for the removed topbar theme button");
  assert.match(app, /querySelectorAll\("\[data-appearance-opt\]"\)/,
    "theme changes must synchronize the settings-menu segmented controls");
  assert.match(app, /button\?\.dataset\.appearanceOpt/,
    "settings appearance controls must remain interactive");
});

test("settings popover remains inside the visible desktop viewport", async () => {
  const css = await readFile(resolve(root, "app/styles.css"), "utf8");
  const match = /\.settings-menu \{([^}]*)\}/.exec(css);
  assert.ok(match, "expected a settings-menu CSS rule");

  const rule = match[1];
  assert.match(rule, /position:\s*fixed/, "the popover must escape the clipping sidebar");
  assert.match(rule, /left:\s*8px/, "the popover must have a visible left edge");
  assert.match(rule, /bottom:\s*44px/, "the popover must leave room for its trigger");
  assert.match(rule, /max-height:\s*calc\(100vh - 56px\)/, "the popover must fit vertically");
  assert.match(rule, /overflow-y:\s*auto/, "long settings content must scroll inside the popover");
});

test("settings is the single surface for preferences, storage, privacy, and about", async () => {
  const [html, app, css] = await Promise.all([
    readFile(resolve(root, "app/index.html"), "utf8"),
    readFile(resolve(root, "app/app.mjs"), "utf8"),
    readFile(resolve(root, "app/styles.css"), "utf8"),
  ]);

  assert.doesNotMatch(html, /accountModal|accountToggle/, "standalone About UI is removed");
  assert.doesNotMatch(app, /openAccountModal|closeAccountModal|trapAccountModalFocus/, "standalone About behavior is removed");
  assert.doesNotMatch(css, /account-modal-card|account-modal-overlay/, "standalone About styles are removed");
  assert.match(app, /settings-library-status/, "local library status is persistently visible in the Settings rail");
  assert.match(app, /privacyPolicySummary/, "privacy copy is folded into Settings");
  assert.match(app, /data-change-library/, "Settings exposes library relocation when the desktop bridge supports it");
  assert.match(app, /state\.libraryRoot \|\| state\.libraryPath/, "Settings opens the library root rather than only the active project folder");
  assert.match(app, /function openSettingsModal\(\)[\s\S]*?renderSettingsMenu\(\);[\s\S]*?els\.settingsMenu\.hidden = false/,
    "Settings refreshes live path and summary data every time it opens");
  assert.match(app, /requestAnimationFrame\(\(\) => els\.settingsMenu\?\.querySelector\("\.settings-modal-card"\)\?\.focus\(\)\)/,
    "Settings initially focuses the dialog container without forcing a close-button focus ring");
});

test("settings uses a rail and one focused category instead of the legacy long list", async () => {
  const app = await readFile(resolve(root, "app/app.mjs"), "utf8");

  assert.match(app, /const SETTINGS_SECTIONS = \["appearance", "storage", "about"\]/,
    "Settings declares the three focused categories");
  assert.match(app, /settingsSection: "appearance"/,
    "Settings keeps an explicit active-category state");
  assert.match(app, /class="settings-modal-rail"/,
    "Settings renders a dedicated navigation rail");
  assert.match(app, /class="settings-section-tabs" role="tablist"/,
    "the category rail exposes tablist semantics");
  assert.match(app, /role="tab"[\s\S]*?data-settings-section="\$\{id\}"/,
    "each category is a delegated tab control");
  assert.match(app, /role="tabpanel"[\s\S]*?activeSection === id \? "" : " hidden"/,
    "only the active category panel is visible");
  assert.match(app, /class="settings-library-status"/,
    "the rail retains MOSA's local-library context");
  assert.doesNotMatch(app, /settings-library-summary/,
    "the rejected three-column summary strip stays removed");
});

test("settings category tabs support delegated clicks, arrow keys, and hidden-panel-safe focus", async () => {
  const app = await readFile(resolve(root, "app/app.mjs"), "utf8");

  assert.match(app, /button\?\.dataset\.settingsSection[\s\S]*?state\.settingsSection = button\.dataset\.settingsSection;[\s\S]*?renderSettingsMenu\(\)/,
    "delegated category clicks update state and render once");
  assert.match(app, /function handleSettingsMenuKeydown\(event\)[\s\S]*?\[role="tab"\][\s\S]*?ArrowRight[\s\S]*?ArrowDown[\s\S]*?ArrowLeft[\s\S]*?ArrowUp[\s\S]*?Home[\s\S]*?End/,
    "category tabs support the complete desktop tab-key navigation set");
  assert.match(app, /querySelectorAll\("button:not\(\[disabled\]\):not\(\[tabindex='-1'\]\)[\s\S]*?\.filter\(\(element\) => !element\.closest\("\[hidden\]"\)\)/,
    "the focus trap excludes controls inside inactive hidden panels");
});

test("settings dialog geometry follows the 4px spatial grid", async () => {
  const css = await readFile(resolve(root, "app/styles.css"), "utf8");

  assert.match(css, /\.mosa-v2 \.settings-menu \{[\s\S]*?padding: 32px;[\s\S]*?backdrop-filter: blur\(16px\)/,
    "the modal scrim uses grid-aligned padding and a restrained material blur");
  assert.match(css, /\.mosa-v2 \.settings-modal-card \{[\s\S]*?width: min\(840px, 100%\);[\s\S]*?height: min\(640px, calc\(100dvh - 64px\)\);[\s\S]*?grid-template-columns: 208px minmax\(0, 1fr\);[\s\S]*?border-radius: 20px;/,
    "the wider two-column dialog, rail, viewport inset, and radius stay on the 4px grid");
  assert.match(css, /\.mosa-v2 \.settings-section-tab::before \{[^}]*width: 4px;/,
    "the active category indicator uses a 4px rail");
  assert.match(css, /\.mosa-v2 \.settings-modal-row \{[^}]*grid-template-columns: 32px minmax\(0, 1fr\) auto;[^}]*min-height: 64px;[^}]*padding: 12px 16px;/,
    "setting rows align icon wells, copy, and controls to the 4px grid");
  assert.match(css, /\.mosa-v2 \.settings-menu \.segmented-btn \{[^}]*min-width: 44px;[^}]*height: 28px;[^}]*padding: 0 12px;[^}]*border-radius: 8px;/,
    "segmented controls use grid-aligned hit geometry");
  assert.match(css, /@media \(prefers-reduced-transparency: reduce\) \{[\s\S]*?\.mosa-v2 \.settings-modal-card,[\s\S]*?backdrop-filter: none;/,
    "the settings material has a solid accessibility fallback");
});
