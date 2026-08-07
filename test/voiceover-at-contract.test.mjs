import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const read = (relativePath) => readFile(resolve(root, relativePath), "utf8");

function functionBody(source, name) {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing function: ${name}`);
  const signatureEnd = source.indexOf(") {", start);
  assert.notEqual(signatureEnd, -1, `missing function body: ${name}`);
  const open = signatureEnd + 2;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function: ${name}`);
}

test("AT has one shared polite status announcement route and separate error alerts", async () => {
  const html = await read("app/index.html");
  const app = await read("app/app.js");
  assert.match(html, /id="statusText" role="status" aria-live="polite"/);
  assert.match(html, /id="statusText"[^>]*aria-relevant="text"[^>]*aria-atomic="true"/);
  assert.match(html, /id="toastContainer" role="status" aria-live="polite"/);
  assert.match(html, /id="toastContainer"[^>]*aria-relevant="additions text"/);
  assert.match(html, /id="toastErrorContainer"[^>]*aria-label=/);
  assert.doesNotMatch(html, /id="toastErrorContainer"[^>]*aria-live=/, "error container must not add a second live region");
  assert.match(functionBody(app, "writeStatusText"), /els\.statusText\.textContent = ""/);
  assert.match(functionBody(app, "writeStatusText"), /window\.setTimeout/);
  assert.match(functionBody(app, "announceGalleryStatus"), /writeStatusText\(/);
  const present = functionBody(app, "present");
  assert.match(present, /element\.setAttribute\("role", "alert"\)/);
  assert.match(present, /message\.textContent = entry\.message/);
  assert.ok(
    present.indexOf("message.textContent = entry.message") < present.indexOf("container.appendChild(element)"),
    "polite toast text must be present before insertion into the status region",
  );
  assert.doesNotMatch(present, /announceTimer|setTimeout\(\(\) =>[\s\S]*message\.textContent/);
  assert.match(functionBody(app, "pump"), /lane\.pending\.length/);
  assert.match(present, /entry\.state = "visible"/);
});

test("Transient status announcements outrank bridge polling and restore the latest persistent status", async () => {
  const app = await read("app/app.js");
  const announce = functionBody(app, "announceGalleryStatus");
  const setStatus = functionBody(app, "setStatus");
  assert.match(announce, /window\.clearTimeout\(statusAnnouncementTimer\)/);
  assert.match(announce, /statusAnnouncementTimer = window\.setTimeout/);
  assert.match(announce, /writeStatusText\(persistentStatus\.value\)/);
  assert.match(announce, /statusAnnouncementActive = true/);
  assert.match(announce, /if \(persist\) return/);
  assert.match(setStatus, /persistentStatus = \{ value, stateName \}/);
  assert.match(setStatus, /if \(!statusAnnouncementActive\) writeStatusText\(value\)/);
  assert.match(app, /const STATUS_ANNOUNCEMENT_DURATION = 3000/);
});

test("ConfirmDialog exposes modal naming and removes the application background with inert", async () => {
  const html = await read("app/index.html");
  const app = await read("app/app.js");
  assert.match(html, /id="confirmDialogCard"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /aria-labelledby="confirmDialogTitle" aria-describedby="confirmDialogDescription"/);
  assert.match(functionBody(app, "requestConfirmation"), /els\.appShell\?\.setAttribute\("inert", ""\)/);
  assert.match(functionBody(app, "closeConfirmDialog"), /els\.appShell\?\.removeAttribute\("inert"\)/);
  assert.match(functionBody(app, "trapConfirmDialogFocus"), /closeConfirmDialog\(false\)/);
});

test("Settings, Language, Theme, and Density preserve menu/radio semantics and selected state", async () => {
  const app = await read("app/app.js");
  const settings = functionBody(app, "renderSettingsMenu");
  assert.match(settings, /role=radiogroup/);
  assert.match(settings, /role=radio/);
  assert.match(settings, /aria-checked=/);
  assert.match(settings, /role="menuitemradio"/);
  assert.match(settings, /data-language-menu aria-haspopup="menu" aria-expanded="false"/);
  assert.match(app, /function addVoiceOverLabel\(/);
  assert.match(settings, /addVoiceOverLabel\(/);
  assert.match(functionBody(app, "syncSegmentedRadios"), /button\.setAttribute\("aria-checked", String\(checked\)\)/);
  assert.match(functionBody(app, "setLanguage"), /refreshAfterRebuild/);
});

test("Zoom and Preview reuse the existing status region instead of adding live regions", async () => {
  const html = await read("app/index.html");
  const app = await read("app/app.js");
  assert.match(html, /id="assetZoomValue"[^>]*aria-live="off"/);
  assert.match(functionBody(app, "announceAssetViewZoom"), /announceGalleryStatus/);
  assert.match(functionBody(app, "announceImagePreviewZoom"), /announceGalleryStatus/);
  assert.match(functionBody(app, "fitAssetView"), /announceGalleryStatus/);
  assert.match(functionBody(app, "resetAssetViewToHundred"), /announceGalleryStatus/);
});

test("Gallery busy and drag overlay remain distinct from alert semantics", async () => {
  const html = await read("app/index.html");
  const app = await read("app/app.js");
  assert.match(html, /id="assetGrid"[^>]*aria-busy="true"/);
  assert.match(html, /id="dragOverlay" role="region"/);
  assert.doesNotMatch(html, /id="dragOverlay"[^>]*role="alert"/);
  assert.match(functionBody(app, "setGalleryBusy"), /setAttribute\("aria-busy", String\(Boolean\(busy\)\)\)/);
  assert.match(functionBody(app, "setupDragDrop"), /state\.dragCounter === 0/);
  assert.match(functionBody(app, "setupDragDrop"), /announceGalleryStatus\(t\("dropImportReady"\), \{ persist: true \}\)/);
  assert.match(functionBody(app, "setupDragDrop"), /announceGalleryStatus\(t\("dropImportReceived"\), \{ persist: true \}\)/);
  assert.match(functionBody(app, "setupDragDrop"), /hideDragOverlay\(\{ announce: false \}\);\s+announceGalleryStatus\(t\("dropImportReceived"\), \{ persist: true \}\)/);
});

test("Accessible action names and i18n keys have static coverage", async () => {
  const html = await read("app/index.html");
  const app = await read("app/app.js");
  const i18n = (await import("../app/i18n.mjs")).default;
  assert.deepEqual(Object.keys(i18n.zh).sort(), Object.keys(i18n.en).sort());
  assert.ok(i18n.zh.imagePathPlaceholder && i18n.en.imagePathPlaceholder);
  assert.doesNotMatch(app, /aria-label=""/);
  assert.doesNotMatch(html, /<button[^>]*aria-label=""/);
  assert.match(html, /id="imagePreviewStage" role="region"[^>]*aria-labelledby="imagePreviewTitle"/);
});
