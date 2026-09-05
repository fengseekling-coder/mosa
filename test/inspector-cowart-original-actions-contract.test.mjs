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

// 29-35. The inspector no longer needs a dedicated Finder IPC. The renderer
// keeps the narrower shared HTTP open-folder path and the preload surface stays small.
test("29-35. retired show-item-in-folder IPC stays removed", async () => {
  const [preload, main] = await Promise.all([readPreload(), readMain()]);

  assert.doesNotMatch(preload, /showItemInFolder|show-item-in-folder/);
  assert.doesNotMatch(main, /ipcMain\.handle\("show-item-in-folder"/);
  assert.equal(count(preload, "ipcRenderer.invoke"), 7, "preload exposes only the seven approved narrow invoke channels");
  assert.doesNotMatch(preload, /shell\s*[:.]/, "the renderer never receives a shell object");
});

// 36-43. 2026-09-04: the App/Web original-media capability (Finder button /
// web open-original link / unavailable copy) retired from the inspector along
// with its helpers. Finder and copy-path stay reachable via the context menu.
test("36-43. original media capability is fully retired from the inspector", async () => {
  const app = await readApp();
  const inspector = await readInspectorMarkup();

  assert.doesNotMatch(inspector, /function originalMediaCapability\(/, "the capability helper is gone");
  assert.doesNotMatch(inspector, /function originalMediaActionMarkup\(/, "the action markup helper is gone");
  assert.doesNotMatch(inspector, /original-media-link|original-media-unavailable|data-action="show-in-finder"/, "no original-media entry renders");
  assert.doesNotMatch(app, /data-action="show-in-finder"/, "no Finder listener survives in app.mjs");
  assert.doesNotMatch(app, /file:\/\//, "no file:// URL is ever produced");
});

// 44-52. More section final form: the image path shown directly (no disclosure,
// no original-media entry, no heading), and no custom popover or ellipsis menu.
// 2026-09-04: the More disclosure (utility buttons / archive entry) and the
// "original & more" heading + open-original button all retired.
test("44-52. more section final form keeps the approved hierarchy", async () => {
  const inspector = await readInspectorMarkup();
  const more = functionSlice(inspector, "detailMoreSectionMarkup");

  assert.ok(COMPOSITION.endsWith("${detailMoreSectionMarkup(asset)}"), "more stays the last section");
  assert.doesNotMatch(more, /data-more-actions/, "no More disclosure survives");
  assert.doesNotMatch(more, /<details /, "no details element renders in the more section");
  assert.doesNotMatch(more, /original-media|originalAndMore|show-in-finder/, "no original-media entry or heading renders in the section");
  assert.doesNotMatch(more, /data-action="regenerate"|data-action="copy-path"/, "no utility buttons render in the section");
  assert.doesNotMatch(more, /detail-utility-actions/, "no utility action cluster in the section");
  assert.match(more, /<div class="more-location"><span class="meta-key">\$\{t\("imageLocation"\)\}<\/span>/, "the image location row renders directly in the section");
  assert.doesNotMatch(more, /data-action="archive-asset"/, "no archive entry renders in the more section");
  assert.doesNotMatch(more, /role="menu|popover|ellipsis|overflow-menu|⋯|…/, "no custom popover, menu role, or ellipsis trigger");
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
  assert.equal(sha256(lock), "5f63f56e0757215ab2e5f2773de24afe1e7fa9a5bddc41adde805856f0fe09ec", "package-lock.json must stay untouched");
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

  // 2026-09-04: the original-media entry retired; its styles went with it.
  assert.doesNotMatch(css, /\.original-media-action|\.original-media-link|\.original-media-unavailable/, "no original-media styles survive");
  // 2026-09-04: the location row lays the path box inline after the label,
  // single line, overflow hidden (ellipsis) instead of the stacked grid.
  assert.match(css, /\.more-location \{ display: flex; align-items: center; gap: 6px; margin-top: 8px; \}/, "the location row keeps the 8px rhythm");
  assert.match(css, /\.more-location \.path-box \{ flex: 1 1 auto; min-width: 0; overflow: hidden;/, "the path box fills the row, single line, clipped");
  const cssDeclarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(cssDeclarations, /!important/, "no !important in any CSS declaration");
  const phase4cStyles = sliceBetween(css, "/* Phase 4C More 终态", ".action-btn {");
  assert.doesNotMatch(phase4cStyles, /#[0-9a-fA-F]{3,8}\b|backdrop-filter|gradient/, "Phase 4C styles introduce no new colors, glassmorphism, or gradients");
});
