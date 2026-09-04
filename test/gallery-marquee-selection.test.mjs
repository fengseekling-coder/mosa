import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MARQUEE_CARD_DRAG_THRESHOLD_PX, MARQUEE_DRAG_THRESHOLD_PX, rectFromPoints, rectsIntersect, selectionRangeIds } from "../app/gallery-selection.mjs";

test("marquee geometry normalizes drag direction and detects overlap", () => {
  assert.deepEqual(rectFromPoints(40, 50, 10, 20), {
    left: 10,
    top: 20,
    right: 40,
    bottom: 50,
    width: 30,
    height: 30,
  });
  assert.equal(rectsIntersect({ left: 0, top: 0, right: 20, bottom: 20 }, { left: 20, top: 20, right: 30, bottom: 30 }), true);
  assert.equal(rectsIntersect({ left: 0, top: 0, right: 19, bottom: 19 }, { left: 20, top: 20, right: 30, bottom: 30 }), false);
  assert.equal(MARQUEE_DRAG_THRESHOLD_PX, 3);
  assert.equal(MARQUEE_CARD_DRAG_THRESHOLD_PX, 6);
  const assets = ["a", "b", "c", "d"].map((id) => ({ id }));
  assert.deepEqual(selectionRangeIds(assets, "b", "d"), ["b", "c", "d"]);
  assert.deepEqual(selectionRangeIds(assets, "d", "b"), ["b", "c", "d"]);
});

test("gallery marquee selection is wired into shared web/app renderer", async () => {
  const app = await readFile(new URL("../app/app.mjs", import.meta.url), "utf8");
  const html = await readFile(new URL("../app/index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/styles.css", import.meta.url), "utf8");
  const bindings = await readFile(new URL("../app/context-menu-bindings.mjs", import.meta.url), "utf8");
  const selection = await readFile(new URL("../app/gallery-selection.mjs", import.meta.url), "utf8");

  assert.match(app, /selectedIds: new Set\(\)/);
  assert.match(app, /createGallerySelection\(\{[\s\S]*?currentAssetRequest,[\s\S]*?requestAssetPage,[\s\S]*?apiFetch,[\s\S]*?showToast/);
  assert.match(app, /gallerySelection\.bind\(\)/);
  assert.match(app, /gallerySelection\.handleCardClick\(event, id\)/);
  assert.match(app, /gallerySelection\.handleGridClick\(event\)/);
  assert.match(app, /gallerySelection\.selectAll\(\{ announce: true \}\)/);
  assert.match(app, /state\.viewMode === "library" && state\.selectedIds\?\.size/);
  assert.match(app, /gallerySelection\.syncRenderedSelection\(\)/);

  assert.match(html, /id="selectionBar"/);
  assert.match(html, /id="selectionSelectAll"/);
  assert.match(html, /id="selectionClear"/);
  assert.match(css, /\.marquee-selection-box \{/);
  assert.match(css, /\.asset-card\.multi-selected \.asset-card-select/);
  assert.match(css, /\.asset-card\.multi-selected \.card-check/);
  assert.match(css, /\.selection-bar \{/);

  // A marquee may start directly on a card. Pointer capture is deliberately
  // delayed until drag intent is established so a normal click still reaches
  // the card button. Window-level tracking keeps fast edge starts reliable.
  assert.match(selection, /const startCard = event\.target\.closest\?\.\("\.asset-card"\)/);
  assert.match(selection, /startCardId: startCard\?\.dataset\.id \|\| ""/);
  assert.match(selection, /pointer\.startCardId \? MARQUEE_CARD_DRAG_THRESHOLD_PX : MARQUEE_DRAG_THRESHOLD_PX/);
  assert.match(selection, /if \(pointer\.startCardId\) next\.add\(pointer\.startCardId\)/);
  assert.match(selection, /pointer\.dragging = true;\s+captureDragGeometry\(\);\s+try \{ els\.assetGrid\?\.setPointerCapture/);
  assert.match(selection, /pointer\.startContentX/);
  assert.match(selection, /pointer\.cardRects/);
  assert.match(selection, /scheduleDragSelectionUpdate\(event\.clientX, event\.clientY\)/);
  const beginPointerSection = selection.slice(selection.indexOf("function beginPointer"), selection.indexOf("function movePointer"));
  assert.doesNotMatch(beginPointerSection, /event\.target\.closest\?\.\("\.asset-card, button/);
  assert.match(selection, /window\.addEventListener\("pointermove", movePointer, \{ capture: true \}\)/);
  assert.match(selection, /window\.addEventListener\("blur", cancelPointerGesture\)/,
    "window blur must cancel an in-flight marquee instead of leaving capture/crosshair state behind");
  assert.match(selection, /addEventListener\("lostpointercapture"[\s\S]*?cancelPointerGesture\(\)/,
    "lost pointer capture cancels the marquee state machine just like Stack dragging");
  assert.match(selection, /if \(canceled && completedDrag\) \{\s+suppressNextGridClick = false;/,
    "pointercancel must not eat the next real gallery click");
  assert.match(selection, /if \(event\.shiftKey\)[\s\S]*?selectRange\(id/,
    "Shift-click uses desktop-style contiguous range selection");
  assert.match(selection, /while \(true\) \{[\s\S]*?requestAssetPage\(request, \{ cursor, limit: 250/,
    "Select all walks the complete cursor result instead of only selecting loaded DOM cards");
  assert.match(selection, /resolveSelectedAssetIds/);
  assert.match(selection, /MARQUEE_GEOMETRY_BAND_PX = 512/);
  assert.match(selection, /pointer\.cardRectBands = new Map\(\)/);
  assert.match(selection, /candidateById/,
    "pointermove intersects only vertical-band candidates instead of every loaded card");
  assert.match(selection, /\/api\/asset-stacks\/\$\{encodeURIComponent\(stackId\)\}\/assets/,
    "logical Stack selections expand to their member asset IDs only when an action executes");
  assert.match(selection, /addEventListener\("dragstart"/);
  assert.match(css, /\.asset-card-select, \.asset-card-select \.thumb \{ user-select: none; -webkit-user-drag: none; \}/);

  assert.match(bindings, /state\.selectedIds instanceof Set/);
  assert.match(bindings, /getAssetMenu\(asset, selectedAssets, \{/);
  assert.match(bindings, /gallerySelection\?\.replaceWith\?\.\(asset\.id\)/);
});
