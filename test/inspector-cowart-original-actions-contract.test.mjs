import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

// Phase 4C 守护契约：原图 App/Web 能力适配（desktop-finder / web-open / unavailable）、
// More 区最终形态（原生 details/summary + 独立 danger 区）与 Phase 1–4B 边界冻结。
// Node 标准库、零网络、源码切片断言；不用整文件 SHA 代替行为契约（package/lockfile 除外）。

const root = resolve(import.meta.dirname, "..");
const readApp = () => readFile(resolve(root, "app/app.mjs"), "utf8");
const readAssetView = () => readFile(resolve(root, "app/asset-view.mjs"), "utf8");
const readInspectorMarkup = () => readFile(resolve(root, "app/inspector-markup.mjs"), "utf8");
const readCss = () => readFile(resolve(root, "app/styles.css"), "utf8");
const readI18n = () => readFile(resolve(root, "app/i18n.mjs"), "utf8");
const readPreload = () => readFile(resolve(root, "desktop/preload.cjs"), "utf8");
const readMain = () => readFile(resolve(root, "desktop/main.mjs"), "utf8");

const count = (source, needle) => source.split(needle).length - 1;
const sha256 = (content) => createHash("sha256").update(content).digest("hex");

/** Slices a function (top-level or 2-space-indented module helper) up to the next function. */
function functionSlice(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function not found: ${name}`);
  const candidates = ["\nfunction ", "\nasync function ", "\n  function ", "\n  async function "]
    .map((marker) => source.indexOf(marker, start + 1))
    .filter((index) => index !== -1);
  const next = candidates.length ? Math.min(...candidates) : -1;
  return source.slice(start, next === -1 ? source.length : next);
}

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `marker not found: ${endMarker}`);
  return source.slice(start, end);
}

// Library v2 keeps favorite in the Overview instead of a detached section.
const SECTION_ORDER = ["file", "tags", "prompt", "source", "version", "group", "more"];
const COMPOSITION = "${detailFileSectionMarkup(asset)}${detailTagsSectionMarkup(asset)}${detailPromptSectionMarkup(asset)}${detailSourceSectionMarkup(asset)}${detailVersionSectionMarkup(asset, cachedHistory, cachedRecipeHistory, cachedGenerationHistory)}${detailGroupSectionMarkup(asset)}${detailMoreSectionMarkup(asset)}";

// 29-35. Desktop capability: preload exposes only showItemInFolder; main validates sender,
// absolute path, existence, and the shared library boundary before using shell.showItemInFolder.
test("29-35. show-item-in-folder IPC is minimal, validated, and shell-correct", async () => {
  const [preload, main] = await Promise.all([readPreload(), readMain()]);

  assert.match(preload, /showItemInFolder: \(path\) =>\s*\n?\s*ipcRenderer\.invoke\("show-item-in-folder", path\)/, "preload exposes showItemInFolder");
  // Renderer keeps only the six currently approved fixed-purpose invokes; no generic shell or URL capability is exposed.
  assert.equal(count(preload, "ipcRenderer.invoke"), 6, "preload exposes only the six approved narrow invoke channels");
  assert.doesNotMatch(preload, /shell\s*[:.]/, "the renderer never receives a shell object");

  const handler = sliceBetween(main, 'ipcMain.handle("show-item-in-folder"', "\n}");
  assert.match(main, /import \{[^}]*\bshell\b[^}]*\} from "electron"/, "main imports shell");
  assert.match(handler, /event\.sender !== mainWindow\.webContents/, "the sender must be the current main window");
  assert.match(handler, /typeof path !== "string" \|\| !path\.trim\(\)/, "empty paths are rejected");
  assert.match(handler, /!isAbsolute\(target\)/, "relative paths are rejected");
  assert.match(handler, /\^\[a-z\]\[a-z0-9\+\.\-\]\*:\/i\.test\(target\)/, "URL-like input is rejected");
  assert.match(handler, /!existsSync\(target\)/, "missing files are rejected");
  assert.match(handler, /resolveAllowedFolderPath\(target, \[libraryDir\]\)/, "Finder uses the shared filesystem boundary");
  assert.match(handler, /shell\.showItemInFolder\(allowedTarget\)/, "the native API receives the canonical allowed path");
  assert.doesNotMatch(handler, /openExternal/, "local paths never go through shell.openExternal");
  assert.match(handler, /return \{ ok: true \}/, "success returns a structured ok result");
  assert.match(handler, /reason: "missing"/, "missing files return a structured reason");
  assert.match(handler, /reason: "invalid"/, "invalid input returns a structured reason");
  assert.match(handler, /reason: "not-allowed"/, "out-of-library paths return a structured reason");
  assert.match(handler, /reason: "unavailable"/, "unavailable capability returns a structured reason");
  assert.doesNotMatch(handler, /writeFile|mkdir|rename|unlink|fetch\(/, "the handler never creates, modifies, moves, or downloads files");
});

// 36-43. Original-media capability: App shows Finder copy, Web shows a safe link, both
// image and video get an explicit entry, and unavailable never renders a dead control.
test("36-43. original media capability adapts between App and Web without dead controls", async () => {
  const app = await readApp();
  const inspector = await readInspectorMarkup();
  const capability = functionSlice(inspector, "originalMediaCapability");
  const markup = functionSlice(inspector, "originalMediaActionMarkup");
  const more = functionSlice(inspector, "detailMoreSectionMarkup");

  assert.match(capability, /typeof window\.electronAPI\?\.showItemInFolder === "function" && imagePath/, "desktop-finder requires the injected API and a real path");
  assert.match(capability, /if \(imageUrl\) return "web-open";/, "web-open requires a non-empty image_url");
  assert.match(capability, /return "unavailable";/, "both missing means unavailable");

  assert.match(markup, /data-action="show-in-finder">\$\{t\("showInFinder"\)\}/, "App uses the Finder copy");
  assert.match(markup, /<a class="action-btn secondary original-media-link" href="\$\{escapeHtml\(asset\.image_url\)\}" target="_blank" rel="noopener noreferrer">\$\{t\("openOriginal"\)\}/, "Web uses a safe new-tab link with the open-original copy");
  assert.match(markup, /<p class="empty-copy original-media-unavailable">\$\{t\("originalUnavailable"\)\}<\/p>/, "unavailable renders honest copy, not a dead button");
  assert.doesNotMatch(markup, /disabled/, "unavailable renders no disabled dead control");

  // The entry is unconditional for images and videos alike — no isVideoAsset gate.
  assert.match(more, /<div class="original-media-action">\$\{originalMediaActionMarkup\(asset\)\}<\/div>/, "the entry renders for every asset");
  assert.doesNotMatch(more, /isVideoAsset/, "the entry is no longer video-only");
  assert.doesNotMatch(inspector, /isVideoAsset\(asset\)\s*\?\s*[^\n]*open-original-media/, "the old video-only gate is gone");

  // One capability per asset — never both entries at once.
  assert.match(markup, /if \(capability === "desktop-finder"\) return/, "finder returns early");
  assert.match(markup, /if \(capability === "web-open"\) return/, "web returns early");

  // The Finder handler never leaks the absolute path into a toast.
  const finderHandler = sliceBetween(app, '[data-action="show-in-finder"]', '[data-action="copy-prompt"]');
  assert.match(finderHandler, /window\.electronAPI\.showItemInFolder\(asset\.image_path\)/, "the handler invokes the IPC with the asset path");
  assert.match(finderHandler, /showToast\(t\("shownInFinder"\), "success"\)/, "the success toast is a fixed string");
  assert.doesNotMatch(finderHandler, /showToast\([^)]*image_path/, "no absolute path in any toast");
  assert.doesNotMatch(app, /file:\/\//, "no file:// URL is ever produced");
});

// 44-52. More section final form: visible original entry, native details disclosure for
// utility actions, separated danger archive, and no custom popover or ellipsis menu.
test("44-52. more section final form keeps the approved hierarchy", async () => {
  const inspector = await readInspectorMarkup();
  const more = functionSlice(inspector, "detailMoreSectionMarkup");

  assert.ok(COMPOSITION.endsWith("${detailMoreSectionMarkup(asset)}"), "more stays the last section");
  const originalIndex = more.indexOf('original-media-action');
  const detailsIndex = more.indexOf("data-more-actions");
  assert.ok(originalIndex > -1 && originalIndex < detailsIndex, "the original entry is visible by default, before the disclosure");
  assert.match(more, /<details class="detail-disclosure" data-more-actions><summary>\$\{t\("moreActions"\)\}<\/summary>/, "more actions use a native details/summary disclosure");
  assert.match(more, /<div class="detail-utility-actions"><button class="action-btn secondary" type="button" data-action="regenerate">/, "regenerate lives inside the disclosure");
  assert.match(more, /\? `<button class="action-btn secondary" type="button" data-action="copy-path">\$\{t\("copyPath"\)\}<\/button>`\n\s+: "";/, "copy-path renders only when a path exists");
  assert.match(more, /<div class="more-location"><span class="meta-key">\$\{t\("imageLocation"\)\}<\/span>/, "the image location row lives inside the disclosure");
  assert.match(more, /<div class="detail-danger-actions"><button class="action-btn danger" type="button" data-action="archive-asset">/, "archive stays a separated danger action");
  assert.doesNotMatch(more, /role="menu|popover|ellipsis|overflow-menu|⋯|…/, "no custom popover, menu role, or ellipsis trigger");

  // The disclosure is closed by default (no open attribute).
  assert.doesNotMatch(more, /<details class="detail-disclosure" data-more-actions open/, "the disclosure starts closed");
});

// 54-58. Neighbouring contracts keep passing and their app.js anchors are intact.
test("54-58. Phase 1-4B neighbouring contracts and anchors stay intact", async () => {
  const app = await readApp();
  const inspector = await readInspectorMarkup();
  const viewer = await readAssetView();

  // V2 migration: large-view-* tests were removed during V2 cleanup
  await Promise.all([
    access(resolve(root, "test/inspector-information-architecture-contract.test.mjs")),
    access(resolve(root, "test/inspector-version-workflow-contract.test.mjs")),
    access(resolve(root, "test/accessibility-contract.test.mjs")),
  ]);
  assert.match(viewer, /assetViewSequence\.ids = state\.assets\.map\(\(asset\) => asset\.id\);/, "viewer navigation anchor intact");
  assert.match(viewer, /function applyAssetViewTransform\(\)/, "viewer transform anchor intact");
  assert.match(viewer, /state\.libraryReturnSnapshot = \{/, "return snapshot anchor intact");
  assert.match(inspector, /function detailVersionSectionMarkup\(asset, cachedHistory, cachedRecipeHistory, cachedGenerationHistory\)/, "Phase 4A IA anchors intact");
  assert.match(app, /function selectDetailVersion\(/, "Phase 4B version workflow anchor intact");
});

// 59-60. package.json and the lockfile stay frozen; app.js gains no new imports.
test("59-60. dependency freeze: manifest, lockfile, and app.js imports unchanged", async () => {
  const [app, pkg, lock] = await Promise.all([
    readApp(),
    readFile(resolve(root, "package.json"), "utf8"),
    readFile(resolve(root, "package-lock.json"), "utf8"),
  ]);

  // R1 isolation fix (2026-08-09, approved scope) added qa:web/qa:electron/
  // qa:packaged launcher scripts, so the whole-manifest hash no longer holds;
  // the dependency sections the freeze really guards stay byte-identical.
  const manifest = JSON.parse(pkg);
  assert.equal(sha256(JSON.stringify(manifest.dependencies)), "73c83773a57e21a20917d81b24288bdfddd9bb7ddd644fdaedd6e6cfba13c405", "package.json dependencies must stay untouched");
  assert.equal(sha256(JSON.stringify(manifest.devDependencies)), "11f67ce00f34b4d3dfb9b9ed0dfb428b0368ad5e0a17bd3bafaa40e3c2124fac", "package.json devDependencies must stay untouched");
  assert.equal(sha256(lock), "ecf0fdc199de87ccd30ffe6a7da4624c2f632700cd8348194a30b79dd2e2a69f", "package-lock.json must stay untouched");
  assert.deepEqual([...app.matchAll(/^import .* from "(.*)";$/gm)].map((match) => match[1]).sort(),
    ["./api-client.mjs", "./asset-stacks.mjs", "./asset-view.mjs", "./bridge-status-poller.mjs", "./confirm-dialog.mjs", "./context-menu-actions.mjs", "./context-menu-bindings.mjs", "./context-menu.mjs", "./gallery-selection.mjs", "./i18n-runtime.mjs", "./image-preview.mjs", "./inspector-markup.mjs", "./tag-utils.mjs", "./toast-manager.mjs"], "app.js imports only approved local helpers");
});

// i18n: every new key exists in both locales, symmetric, and no duplicate synonyms.
test("i18n. new original-media keys are symmetric across zh and en", async () => {
  const i18n = await readI18n();

  const NEW_KEYS = ["showInFinder", "shownInFinder", "showInFinderFailed", "openOriginal", "originalUnavailable", "originalAndMore"];
  for (const key of NEW_KEYS) {
    assert.equal(count(i18n, `${key}:`), 2, `${key} exists exactly once per locale`);
  }
  // Reused keys stay single-sourced — no duplicate synonyms were introduced.
  for (const key of ["moreActions", "imageLocation", "regenerate", "copyPath"]) {
    assert.equal(count(i18n, `${key}:`), 2, `${key} stays exactly one entry per locale`);
  }
});

// Styles: the new original-media styling stays inside the design-token boundary.
test("styles. Phase 4C additions reuse tokens and stay within the boundary", async () => {
  const css = await readCss();

  assert.match(css, /\.original-media-action \{ display: grid; margin-bottom: 10px; \}/, "the original entry keeps the 8px rhythm");
  assert.match(css, /\.more-location \{ display: grid; gap: 6px; margin-top: 8px; \}/, "the location row keeps the 8px rhythm");
  const cssDeclarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(cssDeclarations, /!important/, "no !important in any CSS declaration");
  const phase4cStyles = sliceBetween(css, "/* Phase 4C More 终态", ".action-btn {");
  assert.doesNotMatch(phase4cStyles, /#[0-9a-fA-F]{3,8}\b|backdrop-filter|gradient/, "Phase 4C styles introduce no new colors, glassmorphism, or gradients");
});
