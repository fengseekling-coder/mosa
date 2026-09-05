import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { moveBlockBefore, moveBlockRelative } from "../app/asset-stacks.mjs";
import { createInspectorMarkup } from "../app/inspector-markup.mjs";

test("stack manual ordering makes the first asset the cover", () => {
  assert.deepEqual(moveBlockBefore(["a", "b", "c", "d"], ["d"], "a"), ["d", "a", "b", "c"]);
  assert.deepEqual(moveBlockBefore(["a", "b", "c", "d"], ["b", "c"], "a"), ["b", "c", "a", "d"]);
  assert.deepEqual(moveBlockBefore(["a", "b", "c"], ["a"], "c"), ["b", "a", "c"]);
  assert.deepEqual(moveBlockRelative(["a", "b", "c", "d"], ["d"], "b", "before"), ["a", "d", "b", "c"]);
  assert.deepEqual(moveBlockRelative(["a", "b", "c", "d"], ["a"], "c", "after"), ["b", "c", "a", "d"]);
});

test("Stack Inspector falls back to real media when a thumbnail is not ready", () => {
  const { stackInspectorMarkup } = createInspectorMarkup({
    state: { groups: { groups: [] }, locale: "zh-CN" },
    t: (key) => key,
    referenceRightsMarkup: () => "",
  });
  const markup = stackInspectorMarkup({
    id: "stack-a",
    count: 1,
    members: [{
      id: "asset-a",
      image_url: "/api/assets/default/asset-a/media",
      thumbnail_url: "/api/assets/default/asset-a/thumbnail",
      thumbnail_ready: false,
      medium_url: "/api/assets/default/asset-a/medium",
      medium_ready: false,
      preview_url: "/api/assets/default/asset-a/preview",
      preview_ready: false,
      source: { media_kind: "image" },
    }],
  });
  assert.match(markup, /src="\/api\/assets\/default\/asset-a\/media"/,
    "Stack Inspector uses the original image when no derivative is ready");
  assert.doesNotMatch(markup, /<svg class="thumb image-thumb-pending"/,
    "Stack Inspector must not inherit the gallery's blank thumbnail placeholder");
  assert.doesNotMatch(markup, /stack-inspector-summary|stackItemCount|<h3>/,
    "Stack Inspector goes straight to member media without repeating a redundant Stack/count summary");
});

test("visual stack behavior is wired into the shared web and desktop renderer", async () => {
  const [app, apiClient, stackController, selection, contextActions, contextBindings, html, css, i18n, inspector] = await Promise.all([
    readFile(new URL("../app/app.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/api-client.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/asset-stacks.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/gallery-selection.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/context-menu-actions.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/context-menu-bindings.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/index.html", import.meta.url), "utf8"),
    readFile(new URL("../app/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../app/i18n.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/inspector-markup.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(app, /activeStackId: ""/);
  assert.match(app, /createAssetStackController\(/);
  assert.match(app, /assetStacks\.bind\(\)/);
  assert.ok(app.indexOf("assetStacks.bind();") < app.indexOf("gallerySelection.bind();"),
    "asset drag arbitration must bind before marquee selection so a card press is claimed synchronously");
  assert.match(app, /asset\?\.stack\?\.id/);
  assert.match(app, /assetStacks\.enterStack\(asset\.stack\.id, asset\.stack\)/);
  const singleClick = app.slice(
    app.indexOf('els.assetGrid?.addEventListener("click"'),
    app.indexOf('els.assetGrid?.addEventListener("dblclick"'),
  );
  const doubleClick = app.slice(
    app.indexOf('els.assetGrid?.addEventListener("dblclick"'),
    app.indexOf('els.newAssetTopBtn?.addEventListener'),
  );
  assert.doesNotMatch(singleClick, /assetStacks\.enterStack/,
    "collapsed Stack single-click must not navigate");
  assert.match(singleClick, /void selectStackNode\(asset\)/,
    "collapsed Stack single-click opens the Stack inspector instead of impersonating its cover asset");
  assert.match(app, /async function selectStackNode\(asset\)[\s\S]*?state\.detailStack = \{[\s\S]*?loading: true[\s\S]*?\/api\/asset-stacks\/\$\{encodeURIComponent\(stackId\)\}\/assets/,
    "Stack inspection owns an explicit detail state and loads the complete member list");
  assert.match(app, /const stackDetail = state\.detailStack\?\.coverAssetId === state\.selectedId \? state\.detailStack : null/,
    "the inspector distinguishes a logical Stack from the cover asset that represents it in the gallery");
  assert.match(app, /stackInspectorMarkup\(stackDetail\)/,
    "the detail renderer has a dedicated Stack member view");
  assert.match(app, /bindStackInspectorMediaFallbacks\(els\.detailPanel\)/,
    "Stack Inspector retries a missing derivative with the original media URL");
  assert.match(inspector, /function stackInspectorMediaMarkup\(asset = \{\}\)[\s\S]*?thumbnailUrl \|\| mediumUrl \|\| previewUrl \|\| originalUrl/,
    "Stack Inspector owns a real-media fallback chain instead of the gallery placeholder contract");
  assert.match(doubleClick, /if \(!state\.activeStackId && \(card\?\.dataset\.stackId \|\| asset\?\.stack\?\.id\)\)/,
    "only the collapsed Stack node intercepts double-click; active Stack members remain openable");
  assert.match(doubleClick, /assetStacks\.enterStack\(asset\.stack\.id, asset\.stack\)/,
    "collapsed Stack double-click opens the Stack");
  assert.match(doubleClick, /void openAssetView\(id, selectButton\)/,
    "a member double-click inside the active Stack opens the dedicated Viewer");
  assert.match(app, /asset-stack-count/);
  assert.match(app, /stackMatchAccessibleName/);
  assert.match(css, /\.asset-card\.is-stack \.card-actions \{ opacity: 0; pointer-events: none; \}/);
  assert.match(app, /actions\?\.setAttribute\("inert", ""\)/);
  assert.match(app, /assetStacks\.isBusy\(\)/);
  assert.match(app, /state\.activeStackId[\s\S]*?stackItemCount/);

  assert.match(apiClient, /request\.stackId[\s\S]*?\/api\/asset-stacks\//);
  assert.match(apiClient, /Number\(options\.limit\) \|\| GALLERY_PAGE_SIZE/);
  assert.match(apiClient, /sort: state\.activeStackId \? "manual" : state\.sort/);
  assert.match(apiClient, /mosa:active-stack-missing/);
  assert.match(apiClient, /params\.set\("view", "gallery"\)/);

  assert.match(stackController, /POST[\s\S]*?\/api\/asset-stacks/);
  assert.match(stackController, /\/order/);
  assert.match(stackController, /removeSelectedFromStack/);
  assert.match(stackController, /stackViewIsUnfiltered/);
  assert.match(stackController, /!state\.nextCursor && state\.assets\.length >= Number\(state\.pageTotal/);
  assert.match(stackController, /if \(event\.shiftKey\) return/);
  assert.doesNotMatch(stackController, /selected\.has\(assetId\) \|\| state\.selectedId === assetId/,
    "an unselected ordinary card must be draggable without a preparatory click");
  assert.match(stackController, /const candidateIds = dragIdsForCard\(state, assetId\)/,
    "direct drag still preserves an existing multi-selection when appropriate");
  assert.match(stackController, /if \(!targetId \|\| drag\.assetIds\.includes\(targetId\)\) return false/);
  assert.match(stackController, /if \(movingIds\.includes\(targetId\)\) return false/);
  assert.match(stackController, /STACK_DRAG_THRESHOLD_PX = 8/);
  assert.match(stackController, /setPointerCapture\(event\.pointerId\)/);
  assert.match(stackController, /if \(pointerMoveFrame !== null\) \{\s+cancelAnimationFrame\(pointerMoveFrame\);\s+pointerMoveFrame = null;\s+flushPointerMove\(\);/,
    "pointerup flushes a coalesced move before resolving the drop target");
  assert.match(stackController, /lostpointercapture/);
  assert.match(stackController, /window\.addEventListener\("blur"/);
  assert.match(stackController, /moveBlockRelative\(currentIds, drag\.assetIds, targetId, placement\)/);
  assert.match(stackController, /runStackMutation/);
  assert.match(stackController, /state\.storageKind !== "sqlite"/);
  assert.match(stackController, /abandonStackContext/);
  assert.match(stackController, /function isBusy\(\)/);
  assert.doesNotMatch(stackController, /create.*folder|folder.*create/i);

  assert.match(selection, /state\.assetStackDragCandidate/);
  assert.match(selection, /includesExistingStack/);
  assert.match(selection, /state\.storageKind !== "sqlite"/);

  assert.match(contextActions, /if \(options\.stackNode && asset\?\.stack\?\.id && logicalSelectionCount\(selectedAssets, options\) === 1\)/);
  assert.match(contextActions, /mosa:open-stack/);
  assert.match(contextActions, /dissolveStack/);
  assert.match(contextActions, /method: "DELETE"/);
  assert.match(contextActions, /gallerySelection\?\.resolveSelectedAssetIds/,
    "mixed Stack selections resolve to real member asset IDs at mutation time");
  assert.match(contextBindings, /stackNode: !state\.activeStackId && Boolean\(asset\.stack\?\.id\)/);
  assert.match(contextBindings, /if \(!selectedIds\.has\(asset\.id\)\) \{[\s\S]*?gallerySelection\?\.replaceWith\?\.\(asset\.id\)/,
    "right-clicking outside the current selection first makes that card the selection");
  assert.match(contextBindings, /selectionCount: selectedIds\.size/);

  assert.match(html, /id="stackBack"/);
  assert.match(html, /id="selectionStack"/);
  assert.match(html, /id="selectionRemoveFromStack"/);
  assert.match(css, /\.asset-card\.is-stack/);
  assert.match(css, /\.asset-stack-count/);
  assert.match(css, /\.asset-card\.stack-drop-target/);
  assert.match(css, /\.stack-reorder-before/);
  assert.match(css, /\.stack-reorder-after/);
  assert.match(css, /\.asset-card\.is-stack\.is-video \.video-badge/);
  assert.match(css, /\.stack-inspector-grid \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);

  assert.match(i18n, /stackAssets: "堆叠"/);
  assert.match(i18n, /stackInspectorTitle: "堆叠检视器"/);
  assert.match(i18n, /stackOrderChanged: "堆叠内容已发生变化，已刷新，请重新拖动排序"/);
  assert.match(i18n, /stackAssets: "Stack"/);
  assert.match(i18n, /stackInspectorTitle: "Stack inspector"/);
  assert.match(i18n, /stackOrderChanged: "The stack changed while you were reordering it\. It has been refreshed; drag again\."/);
  assert.match(i18n, /operationInProgress:/);
  assert.match(i18n, /searchStack:/);
  assert.match(i18n, /stackMatchCount:/);
  assert.match(i18n, /dissolveStack:/);
});
