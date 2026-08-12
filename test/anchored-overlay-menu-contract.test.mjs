/**
 * Phase 5A / F-14 + F-12（语义半）守护契约。
 *
 * 守护对象：共享 anchored overlay manager（Filter / Settings / Language 三浮层唯一基础设施）、
 * root 互斥与 parent/child 层级、统一定位与碰撞、唯一一套外部点击/resize 监听、Escape 分层、
 * Settings menu / Language menuitemradio / segmented radiogroup 的键盘与无障碍语义。
 *
 * 全部断言基于 Node 标准库（node:test / node:assert / node:fs），不访问网络；
 * 不使用 app.js / styles.css / index.html 整文件 SHA 作为行为契约。
 */
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

const readApp = () => readFile(resolve(root, "app/app.mjs"), "utf8");
const readOverlay = () => readFile(resolve(root, "app/overlay-manager.mjs"), "utf8");
const readHtml = () => readFile(resolve(root, "app/index.html"), "utf8");
const readCss = () => readFile(resolve(root, "app/styles.css"), "utf8");
const readI18n = () => readFile(resolve(root, "app/i18n.mjs"), "utf8");

const count = (source, needle) => source.split(needle).length - 1;

/** Brace-matched function body extraction (mirrors sibling contract suites). */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) return "";
  const braceStart = source.indexOf("{", start);
  if (braceStart === -1) return "";
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// ---------------------------------------------------------------------------
// 1–6：单一 manager 与三浮层接入；独立定位公式清零
// ---------------------------------------------------------------------------

test("1. single anchored overlay manager exists exactly once", async () => {
  const [app, overlay] = await Promise.all([readApp(), readOverlay()]);
  // R1 batch 3: the factory moved to app/overlay-manager.mjs; app.js keeps the single instance.
  assert.equal(count(overlay, "export function createAnchoredOverlayManager()"), 1, "exactly one manager factory");
  assert.equal(count(app, "const anchoredOverlayManager = createAnchoredOverlayManager();"), 1, "exactly one manager instance");
  assert.equal(count(app, "function createAnchoredOverlayManager()"), 0, "factory no longer defined in app.js");
});

test("2. filter panel rides the shared manager", async () => {
  const app = await readApp();
  assert.match(app, /id: "filter", kind: "root", placement: "bottom-end"/);
  assert.match(app, /getPanel: \(\) => els\.filterPanel/);
  assert.match(app, /getTrigger: \(\) => els\.filterToggle/);
});

test("3. settings menu rides the shared manager", async () => {
  const app = await readApp();
  assert.match(app, /id: "settings", kind: "root", placement: "bottom-start"/);
  assert.match(app, /getPanel: \(\) => els\.settingsMenu/);
  assert.match(app, /getTrigger: \(\) => els\.settingsToggle/);
});

test("4. language menu rides the shared manager", async () => {
  const app = await readApp();
  assert.match(app, /id: "language", kind: "child", parentId: "settings", placement: "right-start"/);
  assert.match(app, /getPanel: \(\) => els\.settingsMenu\?\.querySelector\("#languageMenu"\)/);
});

test("5. no standalone positionFilterPanel formula survives", async () => {
  const app = await readApp();
  assert.doesNotMatch(app, /positionFilterPanel/, "filter positioning must live inside the shared manager");
});

test("6. no standalone positionLanguageMenu formula survives", async () => {
  const app = await readApp();
  assert.doesNotMatch(app, /positionLanguageMenu/, "language positioning must live inside the shared manager");
});

// ---------------------------------------------------------------------------
// 7–13：root 互斥、parent/child 层级、Escape 分层
// ---------------------------------------------------------------------------

test("7. root overlays are mutually exclusive", async () => {
  const overlay = await readOverlay();
  const manager = functionBody(overlay, "createAnchoredOverlayManager");
  assert.match(manager, /close\(rootId, "sibling-opened"\)/, "opening a root closes the other root");
});

test("8. language menu is registered as the settings child", async () => {
  const app = await readApp();
  assert.match(app, /parentId: "settings"/);
});

test("9. opening language never closes settings", async () => {
  const overlay = await readOverlay();
  const manager = functionBody(overlay, "createAnchoredOverlayManager");
  // child 分支只处理 child 引用，不触碰 root；且 child 不得脱离 root 存在。
  assert.match(manager, /if \(!rootId\) return; \/\/ child 浮层不得脱离 root 存在/);
  const openBody = manager.slice(manager.indexOf("function open(id)"));
  const childBranch = openBody.slice(openBody.indexOf("} else {"), openBody.indexOf("panel.hidden = false;"));
  assert.doesNotMatch(childBranch, /close\(rootId/, "the child branch must not close the root overlay");
  assert.doesNotMatch(childBranch, /rootId = /, "the child branch must not reassign the root overlay");
});

test("10. closing settings also closes language", async () => {
  const overlay = await readOverlay();
  const manager = functionBody(overlay, "createAnchoredOverlayManager");
  assert.match(manager, /close\(childId, "parent-closed"\)/, "root closure cleans up the child overlay");
});

test("11. escape closes the child overlay first", async () => {
  const overlay = await readOverlay();
  const manager = functionBody(overlay, "createAnchoredOverlayManager");
  assert.match(manager, /if \(childId && reason === "escape" && isOpen\(childId\)\) \{ close\(childId, "escape"\); return; \}/);
});

test("12. the second escape closes the root via the compatibility wrapper", async () => {
  const app = await readApp();
  const closePanel = functionBody(app, "closePanel");
  assert.match(closePanel, /reason = "escape"/, "escape stays the default close reason");
  assert.match(closePanel, /anchoredOverlayManager\.close\(overlayId, reason\)/, "closePanel routes into the shared manager");
  const shortcuts = functionBody(app, "setupKeyboardShortcuts");
  assert.ok(shortcuts.indexOf("closePanel(els.filterPanel, els.filterToggle)") > -1, "filter escape branch kept");
  assert.ok(shortcuts.indexOf("closePanel(els.settingsMenu, els.settingsToggle)") > -1, "settings escape branch kept");
});

test("13. escape never leaks through overlays into the viewer", async () => {
  const app = await readApp();
  const shortcuts = functionBody(app, "setupKeyboardShortcuts");
  const iFilter = shortcuts.indexOf("if (!els.filterPanel?.hidden)");
  const iSettings = shortcuts.indexOf("if (!els.settingsMenu?.hidden)");
  const iView = shortcuts.indexOf('if (state.viewMode === "asset") { returnToLibrary();');
  const iDetail = shortcuts.indexOf("if (state.detailOpen) { setDetailOpen(false);");
  for (const [name, pos] of [["filter", iFilter], ["settings", iSettings], ["view", iView], ["detail", iDetail]]) {
    assert.ok(pos > -1, `${name} escape branch must exist`);
  }
  assert.ok(iFilter < iSettings && iSettings < iView && iView < iDetail,
    "escape priority must stay filter → settings → asset view → legacy detail");
});

// ---------------------------------------------------------------------------
// 14–17：全局监听器唯一一套 + trigger 契约
// ---------------------------------------------------------------------------

test("14. exactly one document-level outside-pointer listener", async () => {
  const app = await readApp();
  assert.equal(count(app, 'document.addEventListener("click"'), 1, "one global click listener only");
  assert.match(app, /document\.addEventListener\("click", \(event\) => anchoredOverlayManager\.handleOutsidePointer\(event\.target\)\)/);
});

test("15. exactly one resize reposition listener (reposition only, never auto-close)", async () => {
  const app = await readApp();
  assert.equal(count(app, 'window.addEventListener("resize"'), 1, "one global resize listener only");
  assert.match(app, /window\.addEventListener\("resize", \(\) => \{ anchoredOverlayManager\.repositionOpen\(\);/);
  const overlay = await readOverlay();
  const manager = functionBody(overlay, "createAnchoredOverlayManager");
  assert.match(manager, /repositionOpen\(\) \{ if \(rootId\) position\(rootId\); if \(childId\) position\(childId\); \}/);
});

test("16. trigger aria-expanded is synchronized by the manager", async () => {
  const overlay = await readOverlay();
  const manager = functionBody(overlay, "createAnchoredOverlayManager");
  assert.match(manager, /function syncTriggerExpanded\(id, expanded\)/);
  assert.match(manager, /setAttribute\("aria-expanded", String\(expanded\)\)/);
});

test("17. every trigger declares aria-controls", async () => {
  const [html, app] = await Promise.all([readHtml(), readApp()]);
  assert.match(html, /id="filterToggle"[^>]*aria-controls="filterPanel"/);
  assert.match(html, /id="settingsToggle"[^>]*aria-controls="settingsMenu"/);
  assert.match(app, /data-language-menu aria-haspopup="menu" aria-expanded="false" aria-controls="languageMenu"/);
});

// ---------------------------------------------------------------------------
// 18–23：Filter Panel 非菜单语义
// ---------------------------------------------------------------------------

test("18. filter trigger exposes aria-haspopup=dialog", async () => {
  const html = await readHtml();
  assert.match(html, /id="filterToggle"[^>]*aria-haspopup="dialog"/);
});

test("19. settings trigger exposes aria-haspopup=menu", async () => {
  const html = await readHtml();
  assert.match(html, /id="settingsToggle"[^>]*aria-haspopup="menu"/);
});

test("20. language trigger exposes aria-haspopup=menu", async () => {
  const app = await readApp();
  assert.match(app, /data-language-menu aria-haspopup="menu"/);
});

test("21. filter panel is a dialog, never a menu", async () => {
  const html = await readHtml();
  assert.match(html, /id="filterPanel"[^>]*role="dialog"/);
  assert.doesNotMatch(html, /id="filterPanel"[^>]*role="menu"/);
});

test("22. opening the filter panel focuses the facet search first", async () => {
  const app = await readApp();
  assert.match(app, /focusOnOpen: \(\) => els\.facetSearchInput \|\| els\.filterPanel\?\.querySelector\("button, input, select"\)/);
});

test("23. closing the filter panel returns focus to its trigger", async () => {
  const app = await readApp();
  assert.match(app, /returnFocus: \(\) => els\.filterToggle/);
  const manager = functionBody(await readOverlay(), "createAnchoredOverlayManager");
  assert.match(manager, /if \(reason === "escape" \|\| reason === "trigger-toggle"\) restoreFocus\(id\);/);
});

// ---------------------------------------------------------------------------
// 24–32：Settings menu 语义与 roving
// ---------------------------------------------------------------------------

test("24. settings menu is role=menu with an accessible name", async () => {
  const html = await readHtml();
  assert.match(html, /id="settingsMenu" role="menu"/);
  assert.match(html, /id="settingsMenu"[^>]*data-i18n-aria-label="settings"/);
});

test("25. settings menu renders real menuitems", async () => {
  const app = await readApp();
  const body = functionBody(app, "renderSettingsMenu");
  const menuitems = body.match(/role="menuitem"/g) || [];
  assert.ok(menuitems.length >= 3, "open-library, language trigger and diagnostics toggle are menuitems");
});

test("26. the native project select keeps native combobox semantics", async () => {
  const app = await readApp();
  assert.match(app, /<select id="projectSelect" data-project-select aria-label=/);
  assert.doesNotMatch(app, /projectSelect[^>]*role=/, "the select must not gain an overriding role");
});

test("27. the select is never disguised as a menuitem", async () => {
  const app = await readApp();
  assert.doesNotMatch(app, /<select[^>]*role="menuitem"/);
});

test("28. settings roving handles ArrowDown", async () => {
  const app = await readApp();
  assert.match(functionBody(app, "handleSettingsMenuKeydown"), /event\.key === "ArrowDown"/);
});

test("29. settings roving handles ArrowUp", async () => {
  const app = await readApp();
  assert.match(functionBody(app, "handleSettingsMenuKeydown"), /event\.key === "ArrowUp"/);
});

test("30. settings roving handles Home", async () => {
  const app = await readApp();
  assert.match(functionBody(app, "handleSettingsMenuKeydown"), /event\.key === "Home"/);
});

test("31. settings roving handles End", async () => {
  const app = await readApp();
  assert.match(functionBody(app, "handleSettingsMenuKeydown"), /event\.key === "End"/);
});

test("32. settings roving wraps around", async () => {
  const app = await readApp();
  assert.match(functionBody(app, "handleSettingsMenuKeydown"), /\+ items\.length\) % items\.length/);
});

// ---------------------------------------------------------------------------
// 33–43：Language menu 语义、键盘与重渲染焦点恢复
// ---------------------------------------------------------------------------

test("33. language overlay is role=menu", async () => {
  const app = await readApp();
  assert.match(app, /id="languageMenu" role="menu" aria-label=/);
});

test("34. language options are menuitemradio", async () => {
  const app = await readApp();
  assert.match(functionBody(app, "renderSettingsMenu"), /role="menuitemradio"/);
});

test("35. language options expose aria-checked from real state", async () => {
  const app = await readApp();
  assert.match(app, /aria-checked="\$\{state\.languagePreference === value\}"/);
});

test("36. language options use roving tabindex", async () => {
  const app = await readApp();
  assert.match(app, /role="menuitemradio" aria-checked="\$\{state\.languagePreference === value\}" tabindex="-1"/);
  assert.match(functionBody(app, "focusLanguageMenuItem"), /item\.tabIndex = 0;/);
});

test("37. language menu cycles with ArrowDown/ArrowUp", async () => {
  const app = await readApp();
  const body = functionBody(app, "handleLanguageMenuKeydown");
  assert.match(body, /event\.key === "ArrowDown"/);
  assert.match(body, /event\.key === "ArrowUp"/);
  assert.match(body, /\+ items\.length\) % items\.length/);
});

test("38. language menu supports Home/End", async () => {
  const app = await readApp();
  const body = functionBody(app, "handleLanguageMenuKeydown");
  assert.match(body, /event\.key === "Home"/);
  assert.match(body, /event\.key === "End"/);
});

test("39. escape inside language closes only the child", async () => {
  const app = await readApp();
  const body = functionBody(app, "handleLanguageMenuKeydown");
  assert.match(body, /event\.key === "Escape"/);
  assert.match(body, /anchoredOverlayManager\.close\("language", "escape"\)/);
  assert.match(body, /event\.preventDefault\(\)/, "the child handler must stop the escape chain from closing settings");
});

test("40. ArrowLeft closes the language child back to its trigger", async () => {
  const app = await readApp();
  assert.match(functionBody(app, "handleLanguageMenuKeydown"), /event\.key === "ArrowLeft"/);
  assert.match(app, /returnFocus: \(\) => els\.settingsMenu\?\.querySelector\("\[data-language-menu\]"\) \|\| null/);
});

test("41. ArrowRight on the language trigger opens the child", async () => {
  const app = await readApp();
  const body = functionBody(app, "handleSettingsMenuKeydown");
  assert.match(body, /event\.key === "ArrowRight"/);
  assert.match(body, /anchoredOverlayManager\.open\("language"\)/);
});

test("42. language selection keeps flowing through setLanguage", async () => {
  const app = await readApp();
  assert.match(app, /return setLanguage\(localeButton\.dataset\.locale\)/);
  const setLanguage = functionBody(app, "setLanguage");
  assert.match(setLanguage, /safeStorageSet\("mosa\.ui-language", value\)/, "persistence path unchanged");
});

test("43. focus is restored through stable re-query + rAF after the settings rebuild", async () => {
  const app = await readApp();
  const setLanguage = functionBody(app, "setLanguage");
  assert.match(setLanguage, /anchoredOverlayManager\.refreshAfterRebuild\(\)/);
  assert.match(setLanguage, /requestAnimationFrame/);
  assert.match(setLanguage, /querySelector\("\[data-language-menu\]"\)\?\.focus\(\)/);
  const overlay = await readOverlay();
  assert.match(functionBody(overlay, "createAnchoredOverlayManager"), /refreshAfterRebuild\(\)/);
});

// ---------------------------------------------------------------------------
// 44–51：Segmented radiogroup
// ---------------------------------------------------------------------------

test("44. appearance segmented is a named radiogroup", async () => {
  const app = await readApp();
  assert.match(app, /role="radiogroup" aria-label="\$\{escapeHtml\(t\("appearance"\)\)\}"/);
});

test("45. density segmented is a named radiogroup", async () => {
  const app = await readApp();
  assert.match(app, /role="radiogroup" aria-label="\$\{escapeHtml\(t\("galleryDensity"\)\)\}"/);
});

test("46. segmented options are role=radio", async () => {
  const app = await readApp();
  const body = functionBody(app, "renderSettingsMenu");
  const radios = body.match(/role="radio" aria-checked=/g) || [];
  assert.equal(radios.length, 4, "two appearance + two density radio options");
});

test("47. aria-checked stays synchronized with the .active visual state", async () => {
  const app = await readApp();
  const sync = functionBody(app, "syncSegmentedRadios");
  assert.match(sync, /classList\.contains\("active"\)/);
  assert.match(sync, /setAttribute\("aria-checked", String\(checked\)\)/);
  // Both mutation paths run the sync helper.
  assert.match(functionBody(app, "applyDarkMode"), /syncSegmentedRadios\(els\.settingsMenu\)/);
  assert.match(functionBody(app, "bindEvents"), /syncSegmentedRadios\(els\.settingsMenu\)/);
});

test("48. segmented radios use roving tabindex", async () => {
  const app = await readApp();
  const sync = functionBody(app, "syncSegmentedRadios");
  assert.match(sync, /button\.tabIndex = checked \? 0 : -1;/);
  assert.match(functionBody(app, "renderSettingsMenu"), /role="radio" aria-checked="\$\{!state\.darkMode\}" tabindex="\$\{state\.darkMode \? -1 : 0\}"/);
});

test("49. segmented radios answer all four arrow keys plus Home/End", async () => {
  const app = await readApp();
  const body = functionBody(app, "handleSettingsMenuKeydown");
  const radioBranch = body.slice(body.indexOf('closest?.(\'[role="radio"]\')'), body.indexOf("data-language-menu"));
  for (const key of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"]) {
    assert.ok(radioBranch.includes(`"${key}"`), `radio branch must handle ${key}`);
  }
});

test("50. segmented arrows never trigger the settings menu roving", async () => {
  const app = await readApp();
  const body = functionBody(app, "handleSettingsMenuKeydown");
  const radioBranch = body.slice(body.indexOf('closest?.(\'[role="radio"]\')'), body.indexOf("data-language-menu"));
  assert.match(radioBranch, /event\.stopPropagation\(\)/);
  assert.match(radioBranch, /buttons\[next\]\.click\(\)/, "selection reuses the existing click business path");
});

test("51. hidden overlays stay out of the tab order", async () => {
  const [css, app] = await Promise.all([readCss(), readApp()]);
  assert.match(css, /\.anchored-overlay\[hidden\] \{ display: none; \}/);
  const body = functionBody(app, "renderSettingsMenu");
  assert.doesNotMatch(body, /role="menuitem"[^>]*tabindex="0"/, "static menuitem markup starts at tabindex=-1");
  assert.doesNotMatch(body, /role="menuitemradio"[^>]*tabindex="0"/, "static radio markup starts at tabindex=-1");
  // 重建后动态建立 roving 锚点：键盘用户从 projectSelect Tab 一次即可进入菜单层。
  assert.match(app, /function primeSettingsRoving\(\)/);
  assert.match(body, /primeSettingsRoving\(\);/);
  assert.match(functionBody(app, "primeSettingsRoving"), /item\.tabIndex = index === 0 \? 0 : -1;/);
});

// ---------------------------------------------------------------------------
// 52–56：统一定位、碰撞与焦点策略
// ---------------------------------------------------------------------------

test("52. one shared viewport padding constant", async () => {
  const [app, overlay] = await Promise.all([readApp(), readOverlay()]);
  // R1 batch 3: the constant moved to app/overlay-manager.mjs with the factory.
  assert.equal(count(overlay, "const ANCHORED_OVERLAY_VIEWPORT_PADDING = 12;"), 1);
  assert.equal(count(app, "ANCHORED_OVERLAY_VIEWPORT_PADDING"), 0, "padding constant no longer defined in app.js");
  const position = functionBody(overlay, "createAnchoredOverlayManager");
  assert.match(position, /const pad = ANCHORED_OVERLAY_VIEWPORT_PADDING;/);
});

test("53. horizontal collision flips and clamps", async () => {
  const overlay = await readOverlay();
  const manager = functionBody(overlay, "createAnchoredOverlayManager");
  assert.match(manager, /left = Math\.max\(pad, anchor\.left - gap - width\)/, "right-start flips left when space runs out");
  assert.match(manager, /clampLeft/, "left stays clamped inside the viewport padding");
});

test("54. vertical collision flips and clamps", async () => {
  const overlay = await readOverlay();
  const manager = functionBody(overlay, "createAnchoredOverlayManager");
  assert.match(manager, /top = clampTop\(anchor\.top - gap - height\)/, "bottom placements flip upward when space runs out");
  assert.match(manager, /top = clampTop\(top\);/, "final top is always clamped");
});

test("55. the language child flips left when the right side is too tight", async () => {
  const app = await readApp();
  assert.match(app, /id: "language", kind: "child", parentId: "settings", placement: "right-start"/);
  const overlay = await readOverlay();
  const manager = functionBody(overlay, "createAnchoredOverlayManager");
  assert.match(manager, /config\.placement === "right-start"/);
  assert.match(manager, /if \(left \+ width > vw - pad\) left = Math\.max\(pad, anchor\.left - gap - width\);/);
});

test("56. outside pointer never force-grabs focus", async () => {
  const overlay = await readOverlay();
  const manager = functionBody(overlay, "createAnchoredOverlayManager");
  // 焦点恢复只发生在 escape / trigger-toggle；outside-pointer 与 selection 不抢焦点。
  assert.match(manager, /if \(reason === "escape" \|\| reason === "trigger-toggle"\) restoreFocus\(id\);/);
  assert.match(manager, /close\(childId, "outside-pointer"\)/);
  assert.match(manager, /close\(rootId, "outside-pointer"\)/);
  // 语言选择触发 Settings DOM 重建后，被点 locale 按钮脱离文档；断开的旧节点不得被误判为外部点击而关掉 Settings。
  assert.match(manager, /if \(!\(target instanceof Node\) \|\| !target\.isConnected\) return;/);
});

// ---------------------------------------------------------------------------
// 57–62：生命周期、既有契约不退化、依赖与样式边界
// ---------------------------------------------------------------------------

test("57. settings DOM rebuilds never stack overlay listeners", async () => {
  const app = await readApp();
  assert.equal(count(app, 'els.settingsMenu?.addEventListener("keydown"'), 1, "one delegated keydown model");
  assert.equal(count(app, 'els.settingsMenu?.addEventListener("click"'), 1, "one delegated click model");
  const body = functionBody(app, "renderSettingsMenu");
  assert.doesNotMatch(body, /addEventListener/, "renderSettingsMenu must stay listener-free");
});

test("58. F-08 empty-state contract keeps passing", async () => {
  const app = await readApp();
  assert.match(app, /function deriveGalleryEmptyState\(\)/);
  assert.match(app, /function resetLibraryRefinements\(\)/);
  assert.equal(count(app, "resetLibraryRefinements();"), 2, "single reset helper, two call sites");
});

test("59. viewer escape priority contract keeps passing", async () => {
  const app = await readApp();
  const shortcuts = functionBody(app, "setupKeyboardShortcuts");
  assert.match(shortcuts, /if \(event\.defaultPrevented\) return;/, "modal trap consumption still respected");
  assert.ok(shortcuts.indexOf("if (state.viewMode === \"asset\") { returnToLibrary();") > -1, "viewer exit branch kept");
  assert.ok(shortcuts.indexOf("if (state.detailOpen) { setDetailOpen(false);") > -1, "legacy detail branch kept");
});

test("60. package manifest and lockfile remain untouched", async () => {
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(pkg.dependencies || {}).sort(), ["better-sqlite3", "sharp"], "runtime dependency set unchanged");
  assert.equal(pkg.dependencies["better-sqlite3"], "^13.0.1");
  assert.equal(pkg.dependencies.sharp, "^0.35.3");
  await access(resolve(root, "package-lock.json"));
});

test("61. no new dependencies — app.js imports stay the original eight first-party modules", async () => {
  const app = await readApp();
  const imports = app.match(/^import .*$/gm) || [];
  // R1 batch 2 added app/config.mjs + app/utils.mjs, batch 3 added
  // app/overlay-manager.mjs + app/toast-manager.mjs + app/i18n-runtime.mjs +
  // app/api-client.mjs + app/confirm-dialog.mjs (all first-party, same repo); nothing third-party may
  // ever join them. The two bare "import {"
  // lines are the multi-line config/utils imports — their indented
  // continuations are not matched by /^import/.
  assert.deepEqual(imports, [
    'import { createLanguageApplier, createT, resolveLocale } from "./i18n-runtime.mjs";',
    'import { createBridgeStatusPoller } from "./bridge-status-poller.mjs";',
    'import {',
    'import {',
    'import { createAnchoredOverlayManager } from "./overlay-manager.mjs";',
    'import { createToastManager } from "./toast-manager.mjs";',
    'import { createApiClient } from "./api-client.mjs";',
    'import { createConfirmDialog } from "./confirm-dialog.mjs";',
    'import { createImagePreviewViewer } from "./image-preview.mjs";',
    'import { createAssetViewer } from "./asset-view.mjs";',
    'import { createInspectorMarkup } from "./inspector-markup.mjs";',
  ], "no third-party positioning library, no framework, no new state library");
});

test("62. overlay CSS uses no !important", async () => {
  const css = stripCssComments(await readCss());
  assert.doesNotMatch(css, /!important/, "Phase 5A styles must not escalate specificity with !important");
});

test("63. dynamic diagnostics height repositions the open settings overlay", async () => {
  const app = await readApp();
  const diagnostics = functionBody(app, "fetchDiagnostics");
  assert.match(diagnostics, /finally \{\s*anchoredOverlayManager\.repositionOpen\(\);\s*\}/,
    "success and error content both trigger a post-layout reposition");
  assert.match(app, /fetchDiagnostics\(\);\s*\}\s*anchoredOverlayManager\.repositionOpen\(\);\s*return;/,
    "toggle growth and collapse are repositioned synchronously");
});
