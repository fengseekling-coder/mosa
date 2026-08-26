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

  const match = /function renderSettingsMenu\(\) \{([\s\S]*?)\n\}\n\nasync function fetchDiagnostics/.exec(app);
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

  const match = /function renderSettingsMenu\(\) \{([\s\S]*?)\n\}\n\nasync function fetchDiagnostics/.exec(app);
  assert.ok(match, "expected to find renderSettingsMenu function body");
  const body = match[1];

  // Theme active state must key off state.darkMode, not a tautological literal.
  assert.match(body, /state\.darkMode/, "renderSettingsMenu must use state.darkMode for theme active status");
  // Density active state must key off state.galleryDensity, not a tautological literal.
  assert.match(body, /state\.galleryDensity/, "renderSettingsMenu must use state.galleryDensity for density active status");
  // No tautological self-comparisons that would make the active class always-on.
  assert.doesNotMatch(body, /"light"\s*===\s*"light"/, "renderSettingsMenu must not contain tautological light comparison");
  assert.doesNotMatch(body, /"dark"\s*===\s*"dark"/, "renderSettingsMenu must not contain tautological dark comparison");
  assert.doesNotMatch(body, /"image"\s*===\s*"image"/, "renderSettingsMenu must not contain tautological image comparison");
  assert.doesNotMatch(body, /"info"\s*===\s*"info"/, "renderSettingsMenu must not contain tautological info comparison");
});

test("diagnostics shows the product and independent MCP versions", async () => {
  const [app, i18n] = await Promise.all([
    readFile(resolve(root, "app/app.mjs"), "utf8"),
    readFile(resolve(root, "app/i18n.mjs"), "utf8"),
  ]);

  assert.match(app, /data\.productVersion/);
  assert.match(app, /data\.mcpServerVersion/);
  assert.match(app, /t\("diagMcpVersion"\)/);
  assert.match(i18n, /diagMcpVersion: "MCP 版本"/);
  assert.match(i18n, /diagMcpVersion: "MCP version"/);
});

test("topbar theme toggle stays synchronized with the shared theme state", async () => {
  const app = await readFile(resolve(root, "app/app.mjs"), "utf8");

  assert.match(app, /themeToggle:\s*document\.querySelector\("#themeToggle"\)/,
    "app.js must retain a reference to the visible topbar theme control");
  assert.match(app, /els\.themeToggle\?\.addEventListener\("click", toggleDarkMode\)/,
    "the visible topbar theme control must be interactive");
  assert.match(app, /els\.themeToggle\?\.setAttribute\("aria-pressed", String\(state\.darkMode\)\)/,
    "the topbar theme control must expose the current state to assistive technology");
  assert.match(app, /querySelectorAll\("\[data-appearance-opt\]"\)/,
    "theme changes must synchronize the settings-menu segmented controls");
});

test("topbar theme toggle exposes a visible icon for each theme", async () => {
  const [html, css] = await Promise.all([
    readFile(resolve(root, "app/index.html"), "utf8"),
    readFile(resolve(root, "app/styles.css"), "utf8"),
  ]);

  assert.match(html, /id="themeToggle"[\s\S]*?class="theme-icon theme-icon-moon"/,
    "the light theme must show a moon icon");
  assert.match(html, /id="themeToggle"[\s\S]*?class="theme-icon theme-icon-sun"/,
    "the dark theme must show a sun icon");
  assert.match(css, /\.theme-icon-sun \{ display: none; \}/,
    "the sun icon must stay hidden in light mode");
  assert.match(css, /\[data-theme="dark"\] \.theme-icon-sun \{ display: block; \}/,
    "the sun icon must be visible in dark mode");
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
