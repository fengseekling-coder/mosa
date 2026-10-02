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
  const app = await readFile(resolve(root, "web/app/app.mjs"), "utf8");

  const match = /function renderSettingsMenu\(\{ force = false \} = \{\}\) \{([\s\S]*?)\n\}\n\nconst ARROW_KEYS/.exec(app);
  assert.ok(match, "expected to find renderSettingsMenu function body");
  const body = match[1];

  assert.doesNotMatch(body, /addEventListener/, "renderSettingsMenu must not call addEventListener");
});

test("bindEvents registers the settingsMenu click delegation exactly once", async () => {
  const app = await readFile(resolve(root, "web/app/app.mjs"), "utf8");

  const match = /function bindEvents\(\) \{([\s\S]*?)\n\}\n\nfunction bindDesktopIntegration/.exec(app);
  assert.ok(match, "expected to find bindEvents function body");
  const body = match[1];

  const settingsMenuClickBindings = body.match(/els\.settingsMenu\?\.addEventListener\("click"/g) || [];
  assert.equal(settingsMenuClickBindings.length, 1, "settingsMenu click delegation must be registered exactly once in bindEvents");
});

test("bindEvents contains the theme-switch handler using real state", async () => {
  const app = await readFile(resolve(root, "web/app/app.mjs"), "utf8");

  const match = /function bindEvents\(\) \{([\s\S]*?)\n\}\n\nfunction bindDesktopIntegration/.exec(app);
  assert.ok(match, "expected to find bindEvents function body");
  const body = match[1];

  // The HTML attribute data-appearance-opt is accessed via the camelCase
  // DOM dataset API as dataset.appearanceOpt in the click delegation handler.
  assert.match(body, /dataset\.appearanceOpt/, "bindEvents must handle data-appearance-opt via dataset.appearanceOpt");
  assert.match(body, /state\.darkMode = newTheme === "dark"/, "bindEvents must set state.darkMode from the selected theme");
});

test("bindEvents no longer contains a density-switch handler", async () => {
  const app = await readFile(resolve(root, "web/app/app.mjs"), "utf8");

  const match = /function bindEvents\(\) \{([\s\S]*?)\n\}\n\nfunction bindDesktopIntegration/.exec(app);
  assert.ok(match, "expected to find bindEvents function body");
  const body = match[1];

  // The card density setting was removed (the gallery is image-only), so the
  // click delegation must not keep a data-density-opt branch or density state.
  assert.doesNotMatch(body, /densityOpt|galleryDensity|normalizeDensity|gallery-density/,
    "bindEvents must not keep the removed density-switch handler");
});

test("the card density setting is gone from the settings menu and shell sources", async () => {
  const [app, utils] = await Promise.all([
    readFile(resolve(root, "web/app/app.mjs"), "utf8"),
    readFile(resolve(root, "web/app/utils.mjs"), "utf8"),
  ]);

  // 任务 17：卡片密度选项整体下线。设置菜单不再渲染 data-density-opt；
  // app.mjs / utils.mjs 不再出现 galleryDensity、normalizeDensity 或
  // mosa.gallery-density（历史 localStorage 值直接忽略，不做迁移）。
  assert.doesNotMatch(app, /data-density-opt/, "settings menu must not render data-density-opt");
  assert.doesNotMatch(app, /galleryDensity|normalizeDensity|mosa\.gallery-density/,
    "app.mjs must not keep galleryDensity / normalizeDensity / mosa.gallery-density");
  assert.doesNotMatch(utils, /normalizeDensity/, "utils.mjs must not keep normalizeDensity");
});

test("legacy densityToggle references have been removed from app.js", async () => {
  const app = await readFile(resolve(root, "web/app/app.mjs"), "utf8");

  assert.doesNotMatch(app, /els\.densityToggle/, "app.js must not reference els.densityToggle");
  assert.doesNotMatch(app, /renderDensityToggle/, "app.js must not reference renderDensityToggle");
});

test("renderSettingsMenu uses real state for segmented control active status", async () => {
  const app = await readFile(resolve(root, "web/app/app.mjs"), "utf8");

  const match = /function renderSettingsMenu\(\{ force = false \} = \{\}\) \{([\s\S]*?)\n\}\n\nconst ARROW_KEYS/.exec(app);
  assert.ok(match, "expected to find renderSettingsMenu function body");
  const body = match[1];

  // Theme active state must key off state.darkMode, not a tautological literal.
  assert.match(body, /state\.darkMode/, "renderSettingsMenu must use state.darkMode for theme active status");
  // The density row was removed: the settings renderer must not reference it.
  assert.doesNotMatch(body, /densityOpt|galleryDensity/, "renderSettingsMenu must not keep density state");
  assert.doesNotMatch(body, /anonymousUsage|data-usage-opt/, "anonymous telemetry must not be exposed as a user-facing settings toggle");
  // No tautological self-comparisons that would make the active class always-on.
  assert.doesNotMatch(body, /"light"\s*===\s*"light"/, "renderSettingsMenu must not contain tautological light comparison");
  assert.doesNotMatch(body, /"dark"\s*===\s*"dark"/, "renderSettingsMenu must not contain tautological dark comparison");
  assert.doesNotMatch(body, /"image"\s*===\s*"image"/, "renderSettingsMenu must not contain tautological image comparison");
  assert.doesNotMatch(body, /"info"\s*===\s*"info"/, "renderSettingsMenu must not contain tautological info comparison");
});

test("removed diagnostics panel leaves no dead renderer hooks or copy", async () => {
  const [app, i18n] = await Promise.all([
    readFile(resolve(root, "web/app/app.mjs"), "utf8"),
    readFile(resolve(root, "web/app/i18n.mjs"), "utf8"),
  ]);
  assert.doesNotMatch(app, /diagnosticsPanel|diagnosticsContent|diagnosticsExpanded|fetchDiagnostics/);
  assert.doesNotMatch(i18n, /diagMcpVersion|diagUiFingerprint|showDiagnostics|hideDiagnostics/);
});

test("theme switching is owned by settings instead of a duplicate topbar control", async () => {
  const [app, html] = await Promise.all([
    readFile(resolve(root, "web/app/app.mjs"), "utf8"),
    readFile(resolve(root, "web/app/index.html"), "utf8"),
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

test("settings is the single surface for preferences, storage, and about", async () => {
  const [html, app, css] = await Promise.all([
    readFile(resolve(root, "web/app/index.html"), "utf8"),
    readFile(resolve(root, "web/app/app.mjs"), "utf8"),
    readFile(resolve(root, "web/app/styles.css"), "utf8"),
  ]);

  assert.doesNotMatch(html, /accountModal|accountToggle/, "standalone About UI is removed");
  assert.doesNotMatch(app, /openAccountModal|closeAccountModal|trapAccountModalFocus/, "standalone About behavior is removed");
  assert.doesNotMatch(css, /account-modal-card|account-modal-overlay/, "standalone About styles are removed");
  assert.match(app, /data-settings-library-path/, "the local library path is visible in the unified Settings surface");
  // R21 两栏设置把「本地优先」说明放进左栏（由 web-r21-settings 锁定其存在）；
  // 这条反模式断言只禁其余的冗余说明文案与装饰性标题 chrome。
  assert.doesNotMatch(app, /preferencesSubtitle|settings-header-mark|headerIcon/,
    "Settings keeps avoiding redundant explanatory copy and decorative header chrome");
  assert.doesNotMatch(app, /captureActivitySection|captureActivityMarkup|captureTaskRowMarkup|capture-task-panel/,
    "Settings does not expose the web-capture runtime activity log");
  assert.match(app, /data-change-library/, "Settings exposes library relocation when the desktop bridge supports it");
  assert.match(app, /state\.libraryRoot \|\| state\.libraryPath/, "Settings opens the library root rather than only the active project folder");
  assert.match(app, /function openSettingsModal\(\)[\s\S]*?renderSettingsMenu\(\);[\s\S]*?els\.settingsMenu\.hidden = false/,
    "Settings refreshes live path and summary data every time it opens");
  assert.match(app, /requestAnimationFrame\(\(\) => els\.settingsMenu\?\.querySelector\("\.settings-modal-card"\)\?\.focus\(\)\)/,
    "Settings initially focuses the dialog container without forcing a close-button focus ring");
});

test("settings avoids full rerenders for normal interactions and keeps radio keyboard navigation", async () => {
  const app = await readFile(resolve(root, "web/app/app.mjs"), "utf8");

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
  // R21 两栏设置给 Web 端加回了分类 tablist（role="tab" 的键盘分支见 web-r21-settings）；
  // 这里只锁与结构无关的行为：segmented 键盘导航、状态同步仍走 Web 端。
});

test("settings dialog keeps scroll containment, thumb mechanics and material fallbacks", async () => {
  // R21 两栏几何（792×592、左栏 168、行 56 高、分段控件 156×32 等）由
  // web-r21-settings 锁定；这里只锁与几何无关的结构行为，全部取 web 现值。
  const css = await readFile(resolve(root, "web/app/styles.css"), "utf8");

  assert.match(css, /\.mosa-v2 \.settings-menu \{[\s\S]*?padding: 24px;[\s\S]*?backdrop-filter: blur\(18px\)/,
    "the modal scrim uses grid-aligned padding and a restrained material blur");
  assert.match(css, /\.mosa-v2 \.settings-modal-body \{ min-height: 0; flex: 1 1 auto; overflow-y: auto;/,
    "the settings body scrolls within the card so the final About and update controls remain reachable");
  assert.doesNotMatch(css, /\.mosa-v2 \.settings-modal-body \{[^}]*max-height:/,
    "the settings body never uses a viewport height larger than the clipped card");
  assert.match(css, /\.mosa-v2 \.settings-menu \.segmented-thumb \{[^}]*width: calc\(\(100% - 4px\) \/ 2\);[^}]*transition: transform 180ms/,
    "the selected segment is represented by one smoothly sliding thumb");
  assert.match(css, /\.mosa-v2 \.settings-menu \.segmented\[data-active-index="1"\] \.segmented-thumb \{ transform: translateX\(100%\); \}/,
    "the thumb moves to the second option without rebuilding the dialog");
  assert.match(css, /\.mosa-v2 \.settings-text-action \{ display: inline-flex; min-height: 28px;[^}]*border: 0;[^}]*background: transparent;/,
    "secondary actions stay visually flat instead of adding nested button boxes");
  assert.match(css, /\.mosa-v2 \.settings-menu\[data-refreshing="true"\] \.settings-modal-card \{ transition: none; \}/,
    "visible Settings rebuilds cannot replay the entrance transition");
  assert.match(css, /@media \(prefers-reduced-transparency: reduce\) \{[\s\S]*?\.mosa-v2 \.settings-menu,[\s\S]*?\.mosa-v2 \.settings-modal-card \{[^}]*backdrop-filter: none;/,
    "the settings material has a solid accessibility fallback");
});
