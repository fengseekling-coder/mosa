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

  const match = /function renderSettingsMenu\(\{ force = false \} = \{\}\) \{([\s\S]*?)\n\}\n\nconst ARROW_KEYS/.exec(app);
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

  const match = /function renderSettingsMenu\(\{ force = false \} = \{\}\) \{([\s\S]*?)\n\}\n\nconst ARROW_KEYS/.exec(app);
  assert.ok(match, "expected to find renderSettingsMenu function body");
  const body = match[1];

  // Theme active state must key off state.darkMode, not a tautological literal.
  assert.match(body, /state\.darkMode/, "renderSettingsMenu must use state.darkMode for theme active status");
  // Density active state must key off state.galleryDensity, not a tautological literal.
  assert.match(body, /state\.galleryDensity/, "renderSettingsMenu must use state.galleryDensity for density active status");
  assert.doesNotMatch(body, /anonymousUsage|data-usage-opt/, "anonymous telemetry must not be exposed as a user-facing settings toggle");
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

test("settings is the single surface for preferences, storage, and about", async () => {
  const [html, app, css] = await Promise.all([
    readFile(resolve(root, "app/index.html"), "utf8"),
    readFile(resolve(root, "app/app.mjs"), "utf8"),
    readFile(resolve(root, "app/styles.css"), "utf8"),
  ]);

  assert.doesNotMatch(html, /accountModal|accountToggle/, "standalone About UI is removed");
  assert.doesNotMatch(app, /openAccountModal|closeAccountModal|trapAccountModalFocus/, "standalone About behavior is removed");
  assert.doesNotMatch(css, /account-modal-card|account-modal-overlay/, "standalone About styles are removed");
  assert.match(app, /data-settings-library-path/, "the local library path is visible in the unified Settings surface");
  assert.doesNotMatch(app, /settingsLocalFirst|preferencesSubtitle|settings-header-mark|headerIcon/,
    "Settings avoids redundant explanatory copy and decorative header chrome");
  assert.match(app, /data-change-library/, "Settings exposes library relocation when the desktop bridge supports it");
  assert.match(app, /state\.libraryRoot \|\| state\.libraryPath/, "Settings opens the library root rather than only the active project folder");
  assert.match(app, /function openSettingsModal\(\)[\s\S]*?renderSettingsMenu\(\);[\s\S]*?els\.settingsMenu\.hidden = false/,
    "Settings refreshes live path and summary data every time it opens");
  assert.match(app, /requestAnimationFrame\(\(\) => els\.settingsMenu\?\.querySelector\("\.settings-modal-card"\)\?\.focus\(\)\)/,
    "Settings initially focuses the dialog container without forcing a close-button focus ring");
});

test("settings uses one compact surface instead of category navigation", async () => {
  const app = await readFile(resolve(root, "app/app.mjs"), "utf8");

  assert.doesNotMatch(app, /SETTINGS_SECTIONS|settingsSection|settings-section-tabs|settings-modal-rail/,
    "Settings must not keep category state or a navigation rail");
  assert.doesNotMatch(app, /role="tab"|role="tabpanel"|data-settings-section/,
    "the compact Settings surface has no fake multi-page tab semantics");
  assert.match(app, /section\(t\("appearance"\), appearanceRows\)/,
    "appearance controls render directly in the unified surface");
  assert.match(app, /section\(t\("storageDataSection"\), storageRows\)/,
    "storage controls render directly in the unified surface");
  assert.match(app, /section\(t\("aboutSection"\), aboutRow, "settings-about-block"\)/,
    "about information renders directly in the unified surface");
  assert.match(app, /const aboutRow = row\([\s\S]*?t\("version"\)/,
    "the About section presents version information directly instead of repeating the product name");
  assert.doesNotMatch(app, /settings-section-rows/,
    "settings groups do not wrap rows in visible card containers");
});

test("settings avoids full rerenders for normal interactions and keeps radio keyboard navigation", async () => {
  const app = await readFile(resolve(root, "app/app.mjs"), "utf8");

  assert.match(app, /function syncSettingsMenuView\(\)/,
    "Settings has a local state synchronizer for stable in-place updates");
  assert.match(app, /if \(existingDialog && !force\) \{[\s\S]*?syncSettingsMenuView\(\);[\s\S]*?return;/,
    "normal refreshes synchronize the existing dialog rather than replacing its DOM");
  assert.doesNotMatch(app, /dataset\.usageOpt|data-usage-opt/,
    "anonymous telemetry is not exposed as a user-facing Settings control");
  assert.match(app, /function handleSettingsMenuKeydown\(event\)[\s\S]*?\[role="radio"\][\s\S]*?ArrowRight[\s\S]*?ArrowDown[\s\S]*?ArrowLeft[\s\S]*?ArrowUp[\s\S]*?Home[\s\S]*?End/,
    "segmented controls retain complete desktop arrow-key navigation");
  assert.match(app, /group\.dataset\.activeIndex = String\(Math\.max\(0, activeIndex\)\)/,
    "segmented controls synchronize the sliding thumb with their active radio");
  assert.match(app, /class="segmented-thumb" aria-hidden="true"/,
    "segmented controls render one non-interactive sliding thumb");
  assert.doesNotMatch(app, /handleSettingsMenuKeydown\(event\)[\s\S]*?\[role="tab"\]/,
    "removed category tabs leave no dead keyboard branch");
});

test("settings dialog uses the compact unified geometry", async () => {
  const css = await readFile(resolve(root, "app/styles.css"), "utf8");

  assert.match(css, /\.mosa-v2 \.settings-menu \{[\s\S]*?padding: 24px;[\s\S]*?backdrop-filter: blur\(18px\)/,
    "the modal scrim uses grid-aligned padding and a restrained material blur");
  assert.match(css, /\.mosa-v2 \.settings-modal-card \{[\s\S]*?width: min\(520px, 100%\);[\s\S]*?max-height: min\(560px, calc\(100dvh - 48px\)\);[\s\S]*?border-radius: 20px;/,
    "the dialog is compact, single-column, and viewport constrained");
  assert.match(css, /\.mosa-v2 \.settings-modal-row \{[^}]*grid-template-columns: 24px minmax\(0, 1fr\) 164px;[^}]*min-height: 52px;[^}]*padding: 8px 0;/,
    "setting rows use one stable three-column alignment grid");
  assert.match(css, /\.mosa-v2 \.settings-block \+ \.settings-block \{[^}]*padding-top: 18px;[^}]*border-top: 1px solid var\(--color-border-subtle\);/,
    "settings sections are separated by spacing plus one quiet structural rule");
  assert.match(css, /\.mosa-v2 \.settings-block > h3 \{[^}]*font-size: 12px;[^}]*font-weight: 650;/,
    "section labels have a distinct hierarchy above individual setting rows");
  assert.match(css, /\.mosa-v2 \.settings-block > h3::before \{[^}]*width: 3px;[^}]*height: 12px;/,
    "section labels use one restrained accent marker instead of another container");
  assert.match(css, /\.mosa-v2 \.settings-menu \.segmented \{[^}]*width: 164px;[^}]*height: 30px;[^}]*padding: 2px;[^}]*border-radius: 999px;/,
    "segmented controls use one compact pill track");
  assert.match(css, /\.mosa-v2 \.settings-menu \.segmented-thumb \{[^}]*width: calc\(\(100% - 4px\) \/ 2\);[^}]*transition: transform 180ms/,
    "the selected segment is represented by one smoothly sliding thumb");
  assert.match(css, /\.mosa-v2 \.settings-menu \.segmented\[data-active-index="1"\] \.segmented-thumb \{ transform: translateX\(100%\); \}/,
    "the thumb moves to the second option without rebuilding the dialog");
  assert.match(css, /\.mosa-v2 \.settings-text-action \{[^}]*border: 0;[^}]*background: transparent;/,
    "secondary actions stay visually flat instead of adding nested button boxes");
  assert.match(css, /\.mosa-v2 \.settings-menu\[data-refreshing="true"\] \.settings-modal-card \{ transition: none; \}/,
    "visible Settings rebuilds cannot replay the entrance transition");
  assert.match(css, /@media \(prefers-reduced-transparency: reduce\) \{[\s\S]*?\.mosa-v2 \.settings-menu,[\s\S]*?\.mosa-v2 \.settings-modal-card \{[^}]*backdrop-filter: none;/,
    "the settings material has a solid accessibility fallback");
});
