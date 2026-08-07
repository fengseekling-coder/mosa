// Phase 7 polish contract (F-19 / F-21 / F-24 / F-25 / F-26 + perimeters):
// semantic color tokens defined and consumed, Cowart stays the only blue
// primary, Inspector ten-section order locked, Version behaviour paths intact,
// extension focus-visible / reduced-motion / live-region semantics complete
// with zero business-logic change, conditional card entrance animation
// (no replay on ordinary re-renders), native-title tooltip contract with
// consistent accessible names, no !important, no new dependencies, and the
// protected surfaces (desktop / lib / mcp / server.mjs / manifests) untouched.
// Node standard library only, no network access, never a whole-file SHA as a
// behaviour contract.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const read = (relative) => readFile(resolve(root, relative), "utf8");
const readApp = () => read("app/app.js");
const readHtml = () => read("app/index.html");
const readCss = () => read("app/styles.css");
const count = (source, needle) => source.split(needle).length - 1;

/** Slices a top-level app.js function up to the next top-level function. */
function functionSlice(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function not found: ${name}`);
  const candidates = ["\nfunction ", "\nasync function "]
    .map((marker) => source.indexOf(marker, start + 1))
    .filter((index) => index !== -1);
  const next = candidates.length ? Math.min(...candidates) : -1;
  return source.slice(start, next === -1 ? source.length : next);
}

// 1. F-19: the five new semantic tokens are defined once and consumed.
test("1. F-19 media/scrim tokens are defined and consumed", async () => {
  const css = await readCss();
  assert.equal(count(css, "--color-media-backdrop: #0b0b0d;"), 1, "media-backdrop defined once");
  assert.equal(count(css, "--color-media-surface: rgb(17 17 20 / 0.65);"), 1, "media-surface defined once");
  assert.equal(count(css, "--color-media-border: rgb(255 255 255 / 0.28);"), 1, "media-border defined once");
  assert.equal(count(css, "--color-media-text: #ffffff;"), 1, "media-text defined once");
  assert.equal(count(css, "--color-scrim: rgb(0 0 0 / 0.4);"), 1, "scrim defined once");
  assert.ok(count(css, "var(--color-media-backdrop)") >= 4, "media-backdrop consumed by video thumb, preview surfaces and checkbox");
  assert.ok(count(css, "var(--color-media-surface)") >= 3, "media-surface consumed by badge, header icon and controls");
  assert.ok(count(css, "var(--color-media-text)") >= 5, "media-text consumed by badge/buttons and hover-active states");
  assert.ok(count(css, "var(--color-media-border)") >= 1, "media-border consumed by header icon");
  assert.ok(count(css, "var(--color-scrim)") >= 1, "scrim consumed by modal overlay");
});

// 2. No undefined tokens: every var(--*) reference resolves to a definition.
//    Fallback-bearing refs (e.g. var(--toast-error-stack-height, 0px), injected
//    at runtime by the Toast Manager) are excluded by requiring a closing paren.
test("2. styles.css has no undefined custom properties", async () => {
  const css = await readCss();
  const refs = new Set([...css.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]));
  const defs = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((match) => match[1]));
  const missing = [...refs].filter((name) => !defs.has(name));
  assert.deepEqual(missing, [], "every var(--*) reference is defined");
});

// 3. Cowart stays the only blue primary; success/warning/error stay distinct.
test("3. Cowart is the only blue primary and status colours stay separate", async () => {
  const css = await readCss();
  assert.equal(count(css, "--color-accent: #2424ff;"), 1, "exactly one semantic accent definition");
  assert.equal(count(css, "--color-accent-hover: #1919cc;"), 1, "exactly one accent hover definition");
  assert.equal(count(css, "--accent: #2424ff;"), 1, "deprecated alias keeps the same value");
  assert.equal(count(css, "--color-success: #16a34a;"), 1, "success stays green");
  assert.equal(count(css, "--color-danger: #dc2626;"), 1, "danger stays red");
  assert.equal(count(css, "--color-warning: #d97706;"), 1, "warning stays amber");
});

// 4. Inspector ten-section order is locked in renderDetail.
test("4. Inspector ten-section order is unchanged", async () => {
  const app = await readApp();
  const render = functionSlice(app, "renderDetail");
  const order = [
    "detailFileSectionMarkup",
    "detailFavoriteSectionMarkup",
    "detailPromptSectionMarkup",
    "detailSourceSectionMarkup",
    "detailVersionSectionMarkup",
    "detailGroupSectionMarkup",
    "detailTagsSectionMarkup",
    "detailCowartSectionMarkup",
    "detailNewVersionSectionMarkup",
    "detailMoreSectionMarkup",
  ];
  let cursor = 0;
  for (const name of order) {
    const at = render.indexOf(`${name}(`, cursor);
    assert.notEqual(at, -1, `${name} present in order`);
    cursor = at + 1;
  }
  const sectionTags = ["file", "favorite", "prompt", "source", "version", "group", "tags", "cowart", "more"];
  for (const tag of sectionTags) {
    assert.ok(app.includes(`data-inspector-section="${tag}"`), `semantic section tag ${tag} intact`);
  }
});

// 5. Version behaviour paths are intact (picker, summary, history, recipe).
test("5. Version behaviour paths unchanged", async () => {
  const app = await readApp();
  const picker = functionSlice(app, "versionPickerMarkup");
  assert.match(picker, /data-version-select/, "native select picker kept");
  assert.match(picker, /aria-busy="true"/, "busy state kept");
  assert.match(picker, /detailVersionSummaryMarkup\(asset\)/, "summary kept under picker");
  const summary = functionSlice(app, "detailVersionSummaryMarkup");
  assert.match(summary, /version-summary-label/, "summary label kept");
  assert.match(summary, /version-current/, "current-version marker kept");
  const history = functionSlice(app, "versionHistoryMarkup");
  assert.match(history, /version-timeline-item/, "timeline items kept");
  assert.match(history, /data-version-id/, "version buttons kept");
  assert.match(history, /aria-current/, "aria-current selection kept");
  const section = functionSlice(app, "detailVersionSectionMarkup");
  assert.match(section, /aria-live="polite"/, "history live region kept");
  const recipe = functionSlice(app, "recipeHistoryMarkup");
  assert.match(recipe, /recipe-snapshot/, "recipe snapshot path kept");
});

// 6. Extension focus-visible is present in every extension surface.
test("6. Extension focus-visible completed", async () => {
  assert.match(await read("extensions/chatgpt-web-capture/content.css"), /:focus-visible/, "content.css focus-visible");
  assert.match(await read("extensions/chatgpt-web-capture/options.html"), /:focus-visible/, "options.html focus-visible");
  assert.match(await read("extensions/chatgpt-web-capture/popup.html"), /:focus-visible/, "popup.html focus-visible");
});

// 7. Extension prefers-reduced-motion is present where motion exists.
test("7. Extension prefers-reduced-motion completed", async () => {
  assert.match(await read("extensions/chatgpt-web-capture/content.css"), /prefers-reduced-motion/, "content.css reduced-motion");
  assert.match(await read("extensions/chatgpt-web-capture/options.html"), /prefers-reduced-motion/, "options.html reduced-motion");
});

// 8. Extension polite/error live regions are wired (no double-announcement).
test("8. Extension polite/error live regions complete", async () => {
  const content = await read("extensions/chatgpt-web-capture/content.js");
  const toast = functionSlice(content, "showToast");
  assert.match(toast, /setAttribute\("role", isError \? "alert" : "status"\)/, "toast toggles alert/status role");
  const status = functionSlice(content, "setStatus");
  assert.match(status, /setAttribute\("role", isError \? "alert" : "status"\)/, "dock status toggles alert/status role");
  const dock = functionSlice(content, "ensureDock");
  assert.match(dock, /role="status" aria-live="polite"/, "dock status starts as polite live region");
  const optionsHtml = await read("extensions/chatgpt-web-capture/options.html");
  assert.match(optionsHtml, /id="status" role="status" aria-live="polite"/, "options status is a polite live region");
  const optionsJs = await read("extensions/chatgpt-web-capture/options.js");
  assert.match(optionsJs, /setAttribute\("role", kind === "error" \? "alert" : "status"\)/, "options toggles alert on error");
});

// 9. Extension business message protocol and capture logic are unchanged.
test("9. Extension message protocol and capture logic unchanged", async () => {
  const content = await read("extensions/chatgpt-web-capture/content.js");
  for (const message of ["mosa.fetchImage", "mosa.getSettings", "mosa.ingest"]) {
    assert.ok(content.includes(`"${message}"`), `message protocol ${message} intact`);
  }
  for (const anchor of ["BLOCK_URL_HINTS", "conversationIdFromUrl", "ingestCandidate", "savedIdentityKeys", "collectDomCandidates"]) {
    assert.ok(content.includes(anchor), `capture logic anchor ${anchor} intact`);
  }
  const options = await read("extensions/chatgpt-web-capture/options.js");
  assert.ok(options.includes('"mosa.getSettings"'), "options getSettings intact");
  assert.ok(options.includes("chrome.storage.local.set"), "options storage path intact");
  assert.ok(options.includes("/api/ingest/web-capture"), "options test-connection endpoint intact");
});

// 10. Main app reduced-motion covers all major dynamic surfaces.
test("10. Main app reduced-motion coverage complete", async () => {
  const css = await readCss();
  const blockStart = css.lastIndexOf("@media (prefers-reduced-motion: reduce)");
  assert.notEqual(blockStart, -1, "reduced-motion block exists");
  const block = css.slice(blockStart);
  for (const selector of [".asset-card", ".card-action-btn", ".toast", ".asset-view-control", ".nav-item", ".icon-button", ".segmented-btn", ".toolbar-icon", ".create-button", ".card-checkbox", ".action-btn", ".mini-btn", ".prompt-text", ".btn-primary", ".btn-danger"]) {
    assert.ok(block.includes(selector), `reduced-motion covers ${selector}`);
  }
});

// 11. Card entrance animation only fires for first load / append pages.
test("11. Card animation is conditional and not replayed on ordinary renders", async () => {
  const css = await readCss();
  const baseRule = css.match(/\.asset-card \{[^}]*\}/)?.[0] || "";
  assert.doesNotMatch(baseRule, /animation:/, ".asset-card base rule has no animation");
  assert.match(css, /\.asset-card\.card-enter \{ animation: card-in/, "card-enter conditional animation exists");
  const app = await readApp();
  const grid = functionSlice(app, "renderGrid");
  assert.match(grid, /function renderGrid\(\) \{/, "renderGrid signature stays contract-locked");
  assert.match(grid, /animate = false/, "renderGrid accepts animation options via arguments");
  assert.match(grid, /card-enter/, "renderGrid emits card-enter");
  assert.match(functionSlice(app, "loadAssets"), /renderGrid\(\{ animate: options\.append \|\| previousAssets\.length === 0,/, "loadAssets gates animation to first load or append");
});

// 12. Icon-only buttons keep consistent accessible names (native title tooltip).
test("12. Icon-button aria-label/title contract holds", async () => {
  const html = await readHtml();
  assert.match(html, /title="浏览"[^>]*aria-label="浏览"/, "browse button static name matches title");
  const app = await readApp();
  assert.match(app, /aria-label="\$\{escapeHtml\(favoriteLabel\)\}" title="\$\{escapeHtml\(favoriteLabel\)\}"/, "favorite button name matches title");
  assert.match(app, /title="\$\{t\("copyPrompt"\)\}" aria-label="\$\{t\("copyPrompt"\)\}"/, "copy button name matches title");
  assert.match(app, /title="\$\{t\("copyOriginalPath"\)\}" aria-label="\$\{t\("copyOriginalPath"\)\}"/, "copy-source button name matches title");
});

// 13. No !important anywhere in the polish surfaces (comments about the rule
//     are fine; an actual declaration `value !important;` is not).
test("13. No !important in app or extension surfaces", async () => {
  for (const relative of [
    "app/styles.css",
    "extensions/chatgpt-web-capture/content.css",
    "extensions/chatgpt-web-capture/options.html",
    "extensions/chatgpt-web-capture/popup.html",
  ]) {
    const source = await read(relative);
    assert.doesNotMatch(source, /\s!important\s*;/, `${relative} has no !important declaration`);
  }
});

// 14. Manifest pinned: no new dependencies, lockfile intact.
test("14. package manifest and lockfile unchanged", async () => {
  const manifest = JSON.parse(await read("package.json"));
  assert.deepEqual(manifest.dependencies, { "better-sqlite3": "^13.0.1", sharp: "^0.35.3" }, "dependencies pinned");
  const expectedDevDeps = [
    "eslint",
    "electron",
    "@electron-forge/cli",
    "@electron-forge/maker-zip",
    "@electron-forge/plugin-auto-unpack-natives",
    "typescript",
  ];
  assert.deepEqual(Object.keys(manifest.devDependencies || {}).sort(), [...expectedDevDeps].sort(), "devDependencies pinned");
  const lock = JSON.parse(await read("package-lock.json"));
  assert.ok(lock.packages?.["node_modules/better-sqlite3"], "lockfile resolves better-sqlite3");
  assert.ok(lock.packages?.["node_modules/sharp"], "lockfile resolves sharp");
});

// 15. Protected surfaces keep their structural anchors (desktop/preload/server/lib).
test("15. Protected surfaces structurally unchanged", async () => {
  const main = await read("desktop/main.mjs");
  assert.match(main, /webPreferences:/, "desktop main keeps webPreferences");
  assert.match(main, /ipcMain\.handle\("open-file-dialog"/, "Finder IPC open-file-dialog intact");
  assert.match(main, /ipcMain\.handle\("show-item-in-folder"/, "Finder IPC show-item-in-folder intact");
  const preload = await read("desktop/preload.mjs");
  assert.match(preload, /ipcRenderer\.invoke\("open-file-dialog"\)/, "preload open-file-dialog intact");
  assert.match(preload, /ipcRenderer\.invoke\("paste-image"\)/, "preload paste-image intact");
  const server = await read("server.mjs");
  assert.match(server, /startMosaRuntime/, "server.mjs runtime bootstrap intact");
  const bridge = await read("lib/api/bridge-routes.mjs");
  assert.ok(bridge.includes("web-capture"), "ingest bridge route intact");
});

// 16. No accidental layout dependency: the extension never touches app DOM.
test("16. Extension stays DOM-independent from the app", async () => {
  const content = await read("extensions/chatgpt-web-capture/content.js");
  assert.doesNotMatch(content, /document\.getElementById\("assetGrid"\)|#assetGrid|mosa-app|app-shell/, "content script has no app-DOM coupling");
  assert.match(content, /#mosa-capture-dock|mosa-capture-toast/, "content script scoped to its own nodes");
});
