import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MARQUEE_DRAG_THRESHOLD_PX,
  cardSelectionFlags,
  createGallerySelection,
  rectFromPoints,
  rectsIntersect,
  selectionRangeIds,
} from "../web/app/gallery-selection.mjs";

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
  const assets = ["a", "b", "c", "d"].map((id) => ({ id }));
  assert.deepEqual(selectionRangeIds(assets, "b", "d"), ["b", "c", "d"]);
  assert.deepEqual(selectionRangeIds(assets, "d", "b"), ["b", "c", "d"]);
});

test("entering batch selection promotes the current detail selection", () => {
  const state = {
    project: "default",
    assets: ["a", "b", "c"].map((id) => ({ id })),
    selectedId: "a",
    selectedIds: new Set(),
    selectedStackNodes: new Map(),
    selectionProject: "default",
    selectionRequestKey: "",
    activeStackId: "",
    viewMode: "library",
    scope: "all",
    storageKind: "sqlite",
    pageTotal: 3,
  };
  const selection = createGallerySelection({
    els: {},
    state,
    t: (key) => key,
  });
  let prevented = false;
  const handled = selection.handleCardClick({
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    preventDefault() { prevented = true; },
  }, "b");

  assert.equal(handled, true);
  assert.equal(prevented, true);
  assert.deepEqual([...state.selectedIds].sort(), ["a", "b"]);
  assert.deepEqual(cardSelectionFlags("a", state.selectedIds, state.selectedId), {
    multiSelected: true,
    detailSelected: false,
  });

  selection.clear();
  assert.deepEqual(cardSelectionFlags("a", state.selectedIds, state.selectedId), {
    multiSelected: false,
    detailSelected: true,
  });
});

test("selection commits reconcile stack metadata from changed IDs without walking the full asset list", () => {
  const originalHTMLElement = globalThis.HTMLElement;
  class FakeHTMLElement {}
  globalThis.HTMLElement = FakeHTMLElement;
  try {
    let assetListWalks = 0;
    const assets = {
      [Symbol.iterator]() {
        assetListWalks += 1;
        throw new Error("selection commit must not walk the full asset list");
      },
      some() { return false; },
      find() { throw new Error("selection commit must use the injected asset lookup"); },
    };
    const state = {
      project: "default",
      assets,
      selectedId: "",
      selectedIds: new Set(),
      selectedStackNodes: new Map(),
      selectionProject: "default",
      selectionRequestKey: "",
      activeStackId: "",
      viewMode: "library",
      scope: "all",
      storageKind: "sqlite",
      pageTotal: 1,
    };
    let assetLookups = 0;
    const selection = createGallerySelection({
      els: {},
      state,
      t: (key) => key,
      getSelectionAsset(id) {
        assetLookups += 1;
        return { id, stack: { id: "stack-1" } };
      },
    });

    selection.toggle("a", { announce: false });

    assert.equal(assetListWalks, 0);
    assert.equal(assetLookups, 1);
    assert.deepEqual([...state.selectedIds], ["a"]);
    assert.deepEqual([...state.selectedStackNodes], [["a", "stack-1"]]);
  } finally {
    globalThis.HTMLElement = originalHTMLElement;
  }
});

test("large selection diffs scan mounted cards once instead of resolving every changed id", () => {
  const originalHTMLElement = globalThis.HTMLElement;
  class FakeHTMLElement {
    constructor(id) {
      this.dataset = { id };
      this.classList = { toggle() {} };
    }
    querySelector() { return { setAttribute() {} }; }
  }
  globalThis.HTMLElement = FakeHTMLElement;
  try {
    const mountedCards = [new FakeHTMLElement("a"), new FakeHTMLElement("b")];
    let mountedScans = 0;
    let renderedCardLookups = 0;
    const grid = {
      childElementCount: mountedCards.length,
      classList: { toggle() {} },
      querySelectorAll(selector) {
        assert.equal(selector, ":scope > .asset-card");
        mountedScans += 1;
        return mountedCards;
      },
    };
    const selectedIds = new Set(Array.from({ length: 500 }, (_, index) => `id-${index}`));
    selectedIds.add("a");
    const state = {
      project: "default",
      assets: [],
      selectedId: "",
      selectedIds,
      selectedStackNodes: new Map(),
      selectionProject: "default",
      selectionRequestKey: "",
      activeStackId: "",
      viewMode: "library",
      scope: "all",
      storageKind: "sqlite",
      pageTotal: selectedIds.size,
    };
    const selection = createGallerySelection({
      els: { assetGrid: grid },
      state,
      t: (key) => key,
      getSelectionAsset: () => null,
      getRenderedSelectionCard() {
        renderedCardLookups += 1;
        return null;
      },
    });
    const changedIds = new Set(selectedIds);

    selection.syncRenderedSelection({ prune: false, changedIds });

    assert.equal(mountedScans, 1);
    assert.equal(renderedCardLookups, 0);
  } finally {
    globalThis.HTMLElement = originalHTMLElement;
  }
});

test("selection removal clears a deleted anchor without toggling selection semantics", () => {
  const state = {
    project: "default",
    assets: ["a", "b", "c", "d"].map((id) => ({ id })),
    selectedId: "",
    selectedIds: new Set(),
    selectedStackNodes: new Map(),
    selectionProject: "default",
    selectionRequestKey: "",
    activeStackId: "",
    viewMode: "library",
    scope: "all",
    storageKind: "sqlite",
    pageTotal: 4,
  };
  const selection = createGallerySelection({ els: {}, state, t: (key) => key });
  selection.restoreSelection({ selectedIds: ["b", "c"], stackNodes: [], anchorId: "b" });

  assert.equal(selection.removeIds(["b"]), true);
  assert.deepEqual([...state.selectedIds], ["c"]);
  selection.selectRange("d", { announce: false });
  assert.deepEqual([...state.selectedIds], ["d"],
    "removing the anchor must not leave a stale deleted anchor behind for the next Shift range");
});

test("selection snapshots restore anchor, stack metadata, filtering, and revision ownership", () => {
  const state = {
    project: "default",
    assets: [{ id: "a", stack: { id: "stack-1" } }, { id: "b" }, { id: "c" }],
    selectedId: "",
    selectedIds: new Set(),
    selectedStackNodes: new Map(),
    selectionProject: "default",
    selectionRequestKey: "",
    activeStackId: "",
    viewMode: "library",
    scope: "all",
    storageKind: "sqlite",
    pageTotal: 3,
  };
  const selection = createGallerySelection({ els: {}, state, t: (key) => key });
  selection.restoreSelection({ selectedIds: ["a", "b"], stackNodes: [["a", "stack-1"]], anchorId: "a" });
  const snapshot = selection.snapshotSelection();
  const oldContext = selection.captureActionContext();

  selection.clear();
  assert.equal(selection.isActionContextCurrent(oldContext), false,
    "clearing/restoring selection must advance the private selection revision");
  selection.restoreSelection(snapshot, { allowedIds: new Set(["a", "c"]) });
  assert.deepEqual([...state.selectedIds], ["a"]);
  assert.deepEqual([...state.selectedStackNodes], [["a", "stack-1"]]);
  selection.selectRange("c", { announce: false });
  assert.deepEqual([...state.selectedIds], ["a", "b", "c"],
    "restoring the snapshot also restores its private range anchor");
  state.assets[0] = { id: "a" };
  selection.restoreSelection(snapshot, { allowedIds: new Set(["a"]) });
  assert.equal(state.selectedStackNodes.size, 0,
    "restore revalidates loaded stack-node metadata that changed while the Stack view was open");
});

test("selected Stack members resolve with bounded cross-Stack concurrency", async () => {
  const stackNodes = new Map(Array.from({ length: 6 }, (_, index) => [`cover-${index}`, `stack-${index}`]));
  const state = {
    project: "default",
    assets: [],
    selectedId: "",
    selectedIds: new Set(["plain", ...stackNodes.keys()]),
    selectedStackNodes: stackNodes,
    selectionProject: "default",
    selectionRequestKey: "",
    activeStackId: "",
    viewMode: "library",
    scope: "all",
    storageKind: "sqlite",
    pageTotal: 7,
  };
  let active = 0;
  let maxActive = 0;
  const calls = [];
  const selection = createGallerySelection({
    els: {},
    state,
    t: (key) => key,
    apiFetch: async (url) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(url);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      const stackId = decodeURIComponent(/\/api\/asset-stacks\/([^/]+)\/assets/.exec(url)?.[1] || "");
      return { assets: [{ id: `member-${stackId}` }], page: { nextCursor: null } };
    },
  });

  const resolved = await selection.resolveSelectedAssetIds();

  assert.equal(calls.length, 6);
  assert.ok(maxActive > 1, "independent Stack member queries should overlap");
  assert.ok(maxActive <= 4, "Stack member resolution remains bounded");
  assert.deepEqual(new Set(resolved.ids), new Set([
    "plain",
    ...Array.from({ length: 6 }, (_, index) => `member-stack-${index}`),
  ]));
});

test("active marquee refreshes its geometry after infinite-scroll append and stale click suppression expires on pointerdown", () => {
  const originals = {
    HTMLElement: globalThis.HTMLElement,
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  class FakeHTMLElement {
    constructor(id = "") {
      this.dataset = id ? { id } : {};
      this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
      this.style = {};
      this.isConnected = true;
    }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    setAttribute() {}
    remove() { this.isConnected = false; }
  }
  const gridHandlers = new Map();
  const windowHandlers = new Map();
  const frames = new Map();
  let frameId = 0;
  const flushFrames = () => {
    let guard = 0;
    while (frames.size && guard < 20) {
      const batch = [...frames.entries()];
      frames.clear();
      batch.forEach(([, callback]) => callback());
      guard += 1;
    }
    assert.ok(guard < 20, "animation-frame queue must settle");
  };
  globalThis.HTMLElement = FakeHTMLElement;
  globalThis.requestAnimationFrame = (callback) => {
    frameId += 1;
    frames.set(frameId, callback);
    return frameId;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  globalThis.document = {
    body: {
      classList: { add() {}, remove() {} },
      append(node) { node.isConnected = true; },
    },
    createElement() { return new FakeHTMLElement(); },
  };
  globalThis.window = {
    addEventListener(type, handler) { windowHandlers.set(type, handler); },
  };
  try {
    const grid = {
      scrollLeft: 0,
      scrollTop: 0,
      childElementCount: 0,
      classList: { toggle() {} },
      addEventListener(type, handler) { gridHandlers.set(type, handler); },
      getBoundingClientRect() { return { left: 0, right: 200, top: 0, bottom: 200 }; },
      querySelectorAll() { return []; },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    const state = {
      project: "default",
      assets: [{ id: "a" }],
      selectedId: "",
      selectedIds: new Set(),
      selectedStackNodes: new Map(),
      selectionProject: "default",
      selectionRequestKey: "",
      activeStackId: "",
      viewMode: "library",
      scope: "all",
      storageKind: "sqlite",
      pageTotal: 2,
    };
    let geometryVersion = 0;
    let rects = [{ id: "a", rect: { left: 70, right: 90, top: 70, bottom: 90 } }];
    const selection = createGallerySelection({
      els: { assetGrid: grid },
      state,
      t: (key) => key,
      getCardSelectionRects: () => rects,
      getCardSelectionGeometryVersion: () => geometryVersion,
    });
    selection.bind();
    const whitespace = { closest() { return null; } };
    gridHandlers.get("pointerdown")({
      pointerId: 1, clientX: 60, clientY: 60, button: 0, isPrimary: true, pointerType: "mouse", shiftKey: false, target: whitespace,
    });
    windowHandlers.get("pointermove")({ pointerId: 1, clientX: 100, clientY: 100, preventDefault() {} });
    flushFrames();
    assert.deepEqual([...state.selectedIds], ["a"]);

    state.assets.push({ id: "b" });
    rects = [
      ...rects,
      { id: "b", rect: { left: 120, right: 150, top: 120, bottom: 150 } },
    ];
    geometryVersion += 1;
    windowHandlers.get("pointermove")({ pointerId: 1, clientX: 160, clientY: 160, preventDefault() {} });
    flushFrames();
    assert.deepEqual(new Set(state.selectedIds), new Set(["a", "b"]),
      "newly appended geometry participates in the still-active marquee");

    windowHandlers.get("pointerup")({ pointerId: 1 });
    // Deliberately omit the synthetic click from the completed drag. A later
    // real pointerdown must expire that stale suppression before its own click.
    gridHandlers.get("pointerdown")({
      pointerId: 2, clientX: 50, clientY: 50, button: 0, isPrimary: true, pointerType: "mouse", shiftKey: false, target: whitespace,
    });
    selection.handleGridClick({ target: whitespace, preventDefault() {} });
    assert.equal(state.selectedIds.size, 0,
      "a stale post-marquee click guard must never swallow the next real gesture's click");
  } finally {
    globalThis.HTMLElement = originals.HTMLElement;
    globalThis.document = originals.document;
    globalThis.window = originals.window;
    globalThis.requestAnimationFrame = originals.requestAnimationFrame;
    globalThis.cancelAnimationFrame = originals.cancelAnimationFrame;
  }
});

// Drives createGallerySelection's real pointer handlers against a fake grid:
// whitespace pointerdown at `from`, pointermove to `to`, pointerup.
function runMarquee({ selectedId = "", selectedIds = [], rects, from, to, shiftKey = false }) {
  const originals = {
    HTMLElement: globalThis.HTMLElement,
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  class FakeHTMLElement {
    constructor() {
      this.dataset = {};
      this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
      this.style = {};
      this.isConnected = true;
    }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    setAttribute() {}
    remove() { this.isConnected = false; }
  }
  const gridHandlers = new Map();
  const windowHandlers = new Map();
  const frames = [];
  globalThis.HTMLElement = FakeHTMLElement;
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  globalThis.cancelAnimationFrame = () => {};
  globalThis.document = {
    body: { classList: { add() {}, remove() {} }, append(node) { node.isConnected = true; } },
    createElement() { return new FakeHTMLElement(); },
  };
  globalThis.window = { addEventListener(type, handler) { windowHandlers.set(type, handler); } };
  try {
    const grid = {
      scrollLeft: 0,
      scrollTop: 0,
      childElementCount: 0,
      classList: { toggle() {} },
      addEventListener(type, handler) { gridHandlers.set(type, handler); },
      getBoundingClientRect() { return { left: 0, right: 400, top: 0, bottom: 400 }; },
      querySelectorAll() { return []; },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    const state = {
      project: "default",
      assets: rects.map(({ id }) => ({ id })),
      selectedId,
      selectedIds: new Set(selectedIds),
      selectedStackNodes: new Map(),
      selectionProject: "default",
      selectionRequestKey: "",
      activeStackId: "",
      viewMode: "library",
      scope: "all",
      storageKind: "sqlite",
      pageTotal: rects.length,
    };
    const selection = createGallerySelection({
      els: { assetGrid: grid },
      state,
      t: (key) => key,
      getCardSelectionRects: () => rects,
      getCardSelectionGeometryVersion: () => 0,
    });
    selection.bind();
    const whitespace = { closest() { return null; } };
    gridHandlers.get("pointerdown")({
      pointerId: 1, clientX: from[0], clientY: from[1], button: 0, isPrimary: true, pointerType: "mouse", shiftKey, target: whitespace,
    });
    windowHandlers.get("pointermove")({ pointerId: 1, clientX: to[0], clientY: to[1], preventDefault() {} });
    while (frames.length) frames.shift()();
    windowHandlers.get("pointerup")({ pointerId: 1 });
    return new Set(state.selectedIds);
  } finally {
    Object.assign(globalThis, originals);
  }
}

test("a plain marquee replaces the selection instead of keeping the card open in the Inspector", () => {
  // Card a sits on the first row and is open in the Inspector (single
  // selection); b and c are on the second row, which the marquee sweeps.
  const rects = [
    { id: "a", rect: { left: 10, right: 90, top: 10, bottom: 90 } },
    { id: "b", rect: { left: 10, right: 90, top: 150, bottom: 230 } },
    { id: "c", rect: { left: 110, right: 190, top: 150, bottom: 230 } },
  ];
  assert.deepEqual(runMarquee({ selectedId: "a", rects, from: [5, 180], to: [200, 200] }), new Set(["b", "c"]),
    "only the swept cards are selected; the Inspector card is not pulled in");
  assert.deepEqual(runMarquee({ selectedIds: ["a"], rects, from: [5, 180], to: [200, 200] }), new Set(["b", "c"]),
    "an existing batch selection is replaced too");
  assert.deepEqual(runMarquee({ selectedId: "a", rects, from: [5, 180], to: [60, 200], shiftKey: true }), new Set(["a", "b"]),
    "Shift extends the selection, starting from the Inspector card");
});

test("gallery marquee selection is wired into shared web/app renderer", async () => {
  const app = await readFile(new URL("../web/app/app.mjs", import.meta.url), "utf8");
  const html = await readFile(new URL("../web/app/index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../web/app/styles.css", import.meta.url), "utf8");
  const bindings = await readFile(new URL("../web/app/context-menu-bindings.mjs", import.meta.url), "utf8");
  const selection = await readFile(new URL("../web/app/gallery-selection.mjs", import.meta.url), "utf8");

  assert.match(app, /selectedIds: new Set\(\)/);
  assert.match(app, /createGallerySelection\(\{[\s\S]*?currentAssetRequest,[\s\S]*?requestAssetPage,[\s\S]*?apiFetch,[\s\S]*?showToast/);
  assert.match(app, /gallerySelection\.bind\(\)/);
  assert.match(app, /gallerySelection\.handleCardClick\(event, id\)/);
  assert.match(app, /gallerySelection\.handleGridClick\(event\)/);
  assert.match(app, /gallerySelection\.selectAll\(\{ announce: true \}\)/);
  assert.match(app, /state\.viewMode === "library" && state\.selectedIds\?\.size/);
  assert.match(app, /gallerySelection\.syncRenderedSelection\(\)/);

  // 底部批量栏已按右键菜单统一方案移除：全选/取消选择走右键菜单（⌘A/Esc
  // 快捷键标注见 context-menu-actions.mjs selectAllMenuItem/deselectAllMenuItem），
  // DOM 与 CSS 都不允许残留批量栏。
  assert.doesNotMatch(html, /id="selectionBar"/);
  assert.doesNotMatch(html, /id="selectionSelectAll"|id="selectionClear"/);
  assert.doesNotMatch(css, /\.selection-bar\b/);
  const contextActionsSource = await readFile(new URL("../web/app/context-menu-actions.mjs", import.meta.url), "utf8");
  assert.match(contextActionsSource, /function selectAllMenuItem\(\)/);
  assert.match(contextActionsSource, /function deselectAllMenuItem\(\)/);
  assert.match(contextActionsSource, /gallerySelection\?\.clear\?\.\(\{ announce: true \}\)/,
    "取消选择菜单项复用与 Esc 相同的选区清理管线");
  assert.match(css, /\.marquee-selection-box \{/);
  assert.match(css, /\.asset-card\.multi-selected \.asset-card-select/);
  assert.match(css, /\.asset-card\.multi-selected \.card-check/);
  assert.doesNotMatch(css, /\.asset-card\.selected \.asset-card-select \{ box-shadow:/,
    "selected cards must not keep the retired outer shadow ring");
  assert.doesNotMatch(css, /\.asset-card\.multi-selected \.asset-card-select \{ box-shadow:/,
    "multi-selected cards must not keep the retired outer shadow ring");
  assert.match(css, /\.mosa-v2 \.asset-card\.selected \.asset-card-select::after, \.mosa-v2 \.asset-card\.multi-selected \.asset-card-select::after \{ box-shadow: none; \}/,
    "selected cards suppress the thumbnail hairline so the selection state never reads as a double ring");
  // R21（web-r21-gallery「R21 card radius」）把选中环改为 1.5px、圆角跟随
  // --radius-md（8+1px，派生 1px 走 --border-width），网格 padding 阶梯值不变；旧的
  // var(--border-width)/13px 圆角与 1px 顶部防裁切断言随之退役，由该契约覆盖。
  assert.match(css, /\.asset-card\.masonry-content-virtualized\.selected,\s*\.asset-card\.masonry-content-virtualized\.multi-selected \{[\s\S]*?content-visibility: visible;/,
    "selected virtualized cards must not paint-contain the external selection ring");
  assert.doesNotMatch(css, /--border-width-selected/,
    "the retired 2px selection-width token must not remain as dead CSS");
  assert.doesNotMatch(app, /card-scrim/,
    "gallery card markup must not keep the retired gradient scrim node");
  assert.doesNotMatch(css, /\.card-scrim/,
    "retired gradient scrim CSS must be deleted instead of disabled by overrides");
  assert.doesNotMatch(css, /\.selection-bar \{/);
  assert.match(css, /\.grid \{[^}]*grid-auto-rows: 1px;[^}]*column-gap: var\(--gallery-gap\);[^}]*row-gap: 0;/,
    "marquee/masonry geometry assumptions are locked to the CSS grid contract");
  assert.match(app, /const gap = Number\.parseFloat\(styles\.getPropertyValue\("--gallery-gap"\)\) \|\| Number\.parseFloat\(styles\.columnGap\) \|\| 0;/,
    "selection geometry and masonry resolve the same gallery-gap source");
  assert.match(app, /function pruneGalleryVirtualSpanCache\(activeIds\)[\s\S]*?galleryCardVirtualSpanCache\.delete\(key\)/,
    "virtual span measurements are pruned when the active result window changes");
  assert.match(app, /if \(!canAppendFast\) \{[\s\S]*?pruneGalleryVirtualSpanCache\(currentIds\)/,
    "full gallery renders bound the span cache to the current result set");

  // Plain card drags belong to asset movement, not marquee selection. Shift is
  // the explicit escape hatch for starting a marquee on top of a card.
  assert.match(selection, /const startCard = event\.target\.closest\?\.\("\.asset-card"\)/);
  assert.match(selection, /if \(startCard && !event\.shiftKey\) return/);
  assert.match(selection, /startCardId: startCard\?\.dataset\.id \|\| ""/);
  assert.doesNotMatch(selection, /promoteDetailId/,
    "a plain marquee replaces the selection; the Inspector card joins only through Shift");
  assert.match(selection, /const next = pointer\.additive \? new Set\(pointer\.additiveBaseSelection\) : new Set\(\);/);
  assert.match(selection, /additiveBaseSelection: event\.shiftKey \? additiveSelectionBase\(\) : new Set\(explicitSelection\)/);
  assert.match(selection, /if \(pointer\.startCardId\) next\.add\(pointer\.startCardId\)/);
  assert.match(selection, /pointer\.dragging = true;\s+captureDragGeometry\(\);\s+try \{ els\.assetGrid\?\.setPointerCapture/);
  assert.match(selection, /pointer\.startContentX/);
  assert.match(selection, /pointer\.cardRects/);
  assert.match(selection, /scheduleDragSelectionUpdate\(event\.clientX, event\.clientY\)/);
  const beginPointerSection = selection.slice(selection.indexOf("function beginPointer"), selection.indexOf("function movePointer"));
  assert.match(beginPointerSection, /suppressNextGridClick = false;/,
    "a new pointer gesture expires stale post-marquee click suppression without relying on task timing");
  assert.match(beginPointerSection, /if \(startCard && !event\.shiftKey\) return/,
    "plain card drags must never fall through into marquee selection");
  assert.doesNotMatch(selection, /setTimeout\(\(\) => \{ suppressNextGridClick = false;/,
    "post-marquee click suppression must not depend on timer-vs-click dispatch ordering");
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
  assert.match(selection, /getCardSelectionGeometryVersion[\s\S]*?refreshDragGeometrySnapshot\(\)/,
    "active marquee refreshes its candidate snapshot when infinite-scroll/masonry geometry changes");
  assert.match(selection, /candidateById/,
    "pointermove intersects only vertical-band candidates instead of every loaded card");
  assert.match(selection, /STACK_SELECTION_RESOLVE_CONCURRENCY = 4/);
  assert.match(selection, /Promise\.all\(Array\.from\([\s\S]*?STACK_SELECTION_RESOLVE_CONCURRENCY/,
    "logical Stack expansion resolves independent Stacks concurrently with a fixed bound");
  assert.match(selection, /\/api\/asset-stacks\/\$\{encodeURIComponent\(stackId\)\}\/assets/,
    "logical Stack selections expand to their member asset IDs only when an action executes");
  assert.match(selection, /addEventListener\("dragstart"/);
  assert.match(css, /\.asset-card-select, \.asset-card-select \.thumb \{ user-select: none; -webkit-user-drag: none; \}/);

  assert.match(bindings, /state\.selectedIds instanceof Set/);
  assert.match(bindings, /getAssetMenu\(asset, selectedAssets, \{/);
  assert.match(bindings, /gallerySelection\?\.replaceWith\?\.\(asset\.id\)/);
});
