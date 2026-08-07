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

test("Preview uses one Pointer Events path with capture and no document mouse drag", async () => {
  const app = await read("app/app.js");
  const setup = functionBody(app, "setupImageZoomPan");
  for (const eventName of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
    assert.match(setup, new RegExp(`addEventListener\\(\\"${eventName}\\",`), `${eventName} is bound on the Preview stage`);
  }
  assert.doesNotMatch(setup, /mousedown|mousemove|mouseup|document\./, "Preview drag has no parallel document mouse path");
  assert.match(functionBody(app, "captureImagePreviewPointer"), /setPointerCapture\(pointerId\)/);
  assert.match(functionBody(app, "releaseImagePreviewPointer"), /releasePointerCapture\(pointerId\)/);
  assert.match(app, /const imagePreviewActivePointers = new Map\(\)/, "Preview owns a single active-pointer table");
  assert.match(functionBody(app, "handleImagePreviewPointerMove"), /clampImagePreviewOffsets\(/, "Preview pan clamps on every move");
  assert.match(functionBody(app, "handleImagePreviewPointerEnd"), /clearImagePreviewPointerSession/, "Preview end/cancel cleans the session");
});

test("Preview pinch uses two touch pointers, distance scaling, midpoint anchoring, and one final announcement", async () => {
  const app = await read("app/app.js");
  assert.match(app, /function startImagePreviewPinch\(\)/);
  assert.match(functionBody(app, "startImagePreviewPinch"), /length < 2/);
  assert.match(functionBody(app, "startImagePreviewPinch"), /startDistance/);
  assert.match(functionBody(app, "updateImagePreviewPinch"), /startScale \* \(distance \/ session\.startDistance\)/);
  assert.match(functionBody(app, "updateImagePreviewPinch"), /startMidpoint/);
  assert.match(functionBody(app, "updateImagePreviewPinch"), /clampImagePreviewOffsets\(/);
  assert.match(functionBody(app, "finishImagePreviewPinch"), /announceImagePreviewZoom/);
  assert.match(functionBody(app, "handleImagePreviewPointerEnd"), /finishImagePreviewPinch\(\{ announce: true \}\)/);
  assert.match(functionBody(app, "imagePreviewTouchPointers"), /pointerType === "touch"/);
});

test("Viewer keeps its independent transform state and gains the same pointer lifecycle", async () => {
  const app = await read("app/app.js");
  assert.match(app, /const assetViewTransform = \{ mode: "fit"/);
  assert.match(app, /const assetViewActivePointers = new Map\(\)/, "Viewer owns a separate active-pointer table");
  const setup = functionBody(app, "setupAssetViewInteraction");
  for (const eventName of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
    assert.match(setup, new RegExp(`addEventListener\\(\\"${eventName}\\", handleAssetView`), `${eventName} is bound on the Viewer stage`);
  }
  assert.match(functionBody(app, "handleAssetViewPointerDown"), /setPointerCapture\(event\.pointerId\)/);
  assert.match(functionBody(app, "handleAssetViewPointerEnd"), /releasePointerCapture\(event\.pointerId\)/);
  assert.match(functionBody(app, "handleAssetViewPointerEnd"), /cancelAssetViewPan\(\)/);
  assert.match(functionBody(app, "cancelAssetViewPan"), /assetViewActivePointers\.clear\(\)/);
  assert.match(functionBody(app, "startAssetViewPinch"), /startDistance/);
  assert.match(functionBody(app, "updateAssetViewPinch"), /zoomAssetViewAtPoint\(/);
  assert.match(functionBody(app, "updateAssetViewPinch"), /clampAssetViewOffsets\(/);
  assert.match(functionBody(app, "finishAssetViewPinch"), /announceAssetViewZoom/);
  assert.match(functionBody(app, "resetAssetViewTransform"), /cancelAssetViewPan\(\)/);
  assert.match(functionBody(app, "returnToLibrary"), /teardownAssetViewInteraction\(\)/);
});

test("Touch input is scoped to the two complete stages and the existing mouse, keyboard, and wheel paths remain", async () => {
  const app = await read("app/app.js");
  const css = await read("app/styles.css");
  assert.equal((css.match(/touch-action:\s*none/g) || []).length, 2, "only Preview and Viewer stages disable browser touch scrolling");
  assert.doesNotMatch(app, /document\.addEventListener\("mousemove"/);
  assert.doesNotMatch(app, /document\.addEventListener\("mouseup"/);
  assert.match(app, /stage\.addEventListener\("wheel"/);
  assert.match(app, /event\.key === "ArrowLeft" \|\| event\.key === "ArrowRight"/);
  assert.match(app, /function handleAssetViewWheel\(/);
  assert.match(app, /function setupImageZoomPan\(/);
});
