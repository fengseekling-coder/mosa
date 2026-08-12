import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { createImagePreviewViewer } from "../app/image-preview.mjs";

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
  const preview = await read("app/image-preview.mjs");
  const setup = functionBody(preview, "setupImageZoomPan");
  for (const eventName of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
    assert.match(setup, new RegExp(`addEventListener\\(\\"${eventName}\\",`), `${eventName} is bound on the Preview stage`);
  }
  assert.doesNotMatch(setup, /mousedown|mousemove|mouseup|document\./, "Preview drag has no parallel document mouse path");
  assert.match(functionBody(preview, "captureImagePreviewPointer"), /setPointerCapture\(pointerId\)/);
  assert.match(functionBody(preview, "releaseImagePreviewPointer"), /releasePointerCapture\(pointerId\)/);
  assert.match(preview, /const imagePreviewActivePointers = new Map\(\)/, "Preview owns a single active-pointer table");
  assert.match(functionBody(preview, "handleImagePreviewPointerMove"), /clampImagePreviewOffsets\(/, "Preview pan clamps on every move");
  assert.match(functionBody(preview, "handleImagePreviewPointerEnd"), /clearImagePreviewPointerSession/, "Preview end/cancel cleans the session");
});

test("Preview pinch uses two touch pointers, distance scaling, midpoint anchoring, and one final announcement", async () => {
  const preview = await read("app/image-preview.mjs");
  assert.match(preview, /function startImagePreviewPinch\(\)/);
  assert.match(functionBody(preview, "startImagePreviewPinch"), /length < 2/);
  assert.match(functionBody(preview, "startImagePreviewPinch"), /startDistance/);
  assert.match(functionBody(preview, "updateImagePreviewPinch"), /startScale \* \(distance \/ session\.startDistance\)/);
  assert.match(functionBody(preview, "updateImagePreviewPinch"), /startMidpoint/);
  assert.match(functionBody(preview, "updateImagePreviewPinch"), /clampImagePreviewOffsets\(/);
  assert.match(functionBody(preview, "finishImagePreviewPinch"), /announceImagePreviewZoom/);
  assert.match(functionBody(preview, "handleImagePreviewPointerEnd"), /finishImagePreviewPinch\(\{ announce: true \}\)/);
  assert.match(functionBody(preview, "imagePreviewTouchPointers"), /pointerType === "touch"/);
});

test("Preview exposes bounded transform reconciliation and consumes drag clicks once", () => {
  const listeners = new Map();
  const classes = new Set();
  const stage = {
    clientWidth: 100,
    clientHeight: 100,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, active) => active ? classes.add(name) : classes.delete(name),
    },
    addEventListener: (name, listener) => listeners.set(name, listener),
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture: () => true,
  };
  const image = { offsetWidth: 100, offsetHeight: 100, hidden: false, style: {} };
  const state = { imagePreviewId: "asset", imageZoom: 2, imagePanX: 90, imagePanY: -90, imageDragging: false };
  const originalGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ paddingLeft: "0", paddingRight: "0", paddingTop: "0", paddingBottom: "0" });
  try {
    const preview = createImagePreviewViewer({
      els: { imagePreviewStage: stage, imagePreviewImage: image },
      state,
      t: (key) => key,
      announceGalleryStatus() {},
    });
    preview.reconcileImagePreviewTransform();
    assert.deepEqual([state.imagePanX, state.imagePanY], [50, -50]);
    assert.equal(image.style.transform, "translate(50px, -50px) scale(2)");

    preview.setupImageZoomPan();
    listeners.get("pointerdown")({ pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, clientX: 0, clientY: 0, target: {} });
    listeners.get("pointermove")({ pointerId: 1, clientX: 10, clientY: 0, preventDefault() {} });
    assert.equal(preview.consumeImagePreviewSuppressedClick(), true);
    assert.equal(preview.consumeImagePreviewSuppressedClick(), false);
  } finally {
    if (originalGetComputedStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = originalGetComputedStyle;
  }
});

test("Viewer keeps its independent transform state and gains the same pointer lifecycle", async () => {
  const viewer = await read("app/asset-view.mjs");
  assert.match(viewer, /const assetViewTransform = \{ mode: "fit"/);
  assert.match(viewer, /const assetViewActivePointers = new Map\(\)/, "Viewer owns a separate active-pointer table");
  const setup = functionBody(viewer, "setupAssetViewInteraction");
  for (const eventName of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
    assert.match(setup, new RegExp(`addEventListener\\(\\"${eventName}\\", handleAssetView`), `${eventName} is bound on the Viewer stage`);
  }
  assert.match(functionBody(viewer, "handleAssetViewPointerDown"), /setPointerCapture\(event\.pointerId\)/);
  assert.match(functionBody(viewer, "handleAssetViewPointerEnd"), /releasePointerCapture\(event\.pointerId\)/);
  assert.match(functionBody(viewer, "handleAssetViewPointerEnd"), /cancelAssetViewPan\(\)/);
  assert.match(functionBody(viewer, "cancelAssetViewPan"), /assetViewActivePointers\.clear\(\)/);
  assert.match(functionBody(viewer, "startAssetViewPinch"), /startDistance/);
  assert.match(functionBody(viewer, "updateAssetViewPinch"), /zoomAssetViewAtPoint\(/);
  assert.match(functionBody(viewer, "updateAssetViewPinch"), /clampAssetViewOffsets\(/);
  assert.match(functionBody(viewer, "finishAssetViewPinch"), /announceAssetViewZoom/);
  assert.match(functionBody(viewer, "resetAssetViewTransform"), /cancelAssetViewPan\(\)/);
  assert.match(functionBody(viewer, "returnToLibrary"), /teardownAssetViewInteraction\(\)/);
});

test("Touch input is scoped to the two complete stages and the existing mouse, keyboard, and wheel paths remain", async () => {
  const app = await read("app/app.mjs");
  const viewer = await read("app/asset-view.mjs");
  const preview = await read("app/image-preview.mjs");
  const css = await read("app/styles.css");
  assert.equal((css.match(/touch-action:\s*none/g) || []).length, 2, "only Preview and Viewer stages disable browser touch scrolling");
  assert.doesNotMatch(app, /document\.addEventListener\("mousemove"/);
  assert.doesNotMatch(app, /document\.addEventListener\("mouseup"/);
  assert.match(preview, /stage\.addEventListener\("wheel"/);
  assert.match(app, /event\.key === "ArrowLeft" \|\| event\.key === "ArrowRight"/);
  assert.match(viewer, /function handleAssetViewWheel\(/);
  assert.match(preview, /function setupImageZoomPan\(/);
});
