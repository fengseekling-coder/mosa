import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { moveBlockBefore, moveBlockRelative } from "../app/asset-stacks.mjs";

test("stack manual ordering makes the first asset the cover", () => {
  assert.deepEqual(moveBlockBefore(["a", "b", "c", "d"], ["d"], "a"), ["d", "a", "b", "c"]);
  assert.deepEqual(moveBlockBefore(["a", "b", "c", "d"], ["b", "c"], "a"), ["b", "c", "a", "d"]);
  assert.deepEqual(moveBlockBefore(["a", "b", "c"], ["a"], "c"), ["b", "a", "c"]);
  assert.deepEqual(moveBlockRelative(["a", "b", "c", "d"], ["d"], "b", "before"), ["a", "d", "b", "c"]);
  assert.deepEqual(moveBlockRelative(["a", "b", "c", "d"], ["a"], "c", "after"), ["b", "c", "a", "d"]);
});

test("visual stack behavior is wired into the shared web and desktop renderer", async () => {
  const [app, apiClient, stackController, selection, contextActions, contextBindings, html, css, i18n] = await Promise.all([
    readFile(new URL("../app/app.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/api-client.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/asset-stacks.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/gallery-selection.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/context-menu-actions.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/context-menu-bindings.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/index.html", import.meta.url), "utf8"),
    readFile(new URL("../app/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../app/i18n.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(app, /activeStackId: ""/);
  assert.match(app, /createAssetStackController\(/);
  assert.match(app, /assetStacks\.bind\(\)/);
  assert.match(app, /asset\?\.stack\?\.id/);
  assert.match(app, /assetStacks\.enterStack\(asset\.stack\.id, asset\.stack\)/);
  assert.match(app, /asset-stack-count/);
  assert.match(app, /galleryEntryAssetCount/);
  assert.match(app, /stackMatchAccessibleName/);
  assert.match(css, /\.asset-card\.is-stack \.card-actions \{ opacity: 0; pointer-events: none; \}/);
  assert.match(app, /actions\?\.setAttribute\("inert", ""\)/);
  assert.match(app, /assetStacks\.isBusy\(\)/);
  assert.match(app, /state\.activeStackId[\s\S]*?stackItemCount/);

  assert.match(apiClient, /request\.stackId[\s\S]*?\/api\/asset-stacks\//);
  assert.match(apiClient, /params\.set\("limit", "100"\)/);
  assert.match(apiClient, /sort: state\.activeStackId \? "manual" : state\.sort/);
  assert.match(apiClient, /mosa:active-stack-missing/);
  assert.match(apiClient, /params\.set\("view", "gallery"\)/);

  assert.match(stackController, /POST[\s\S]*?\/api\/asset-stacks/);
  assert.match(stackController, /\/order/);
  assert.match(stackController, /removeSelectedFromStack/);
  assert.match(stackController, /stackViewIsUnfiltered/);
  assert.match(stackController, /!state\.nextCursor && state\.assets\.length >= Number\(state\.pageTotal/);
  assert.match(stackController, /if \(event\.shiftKey\) return/);
  assert.match(stackController, /selected\.has\(assetId\) \|\| state\.selectedId === assetId/);
  assert.match(stackController, /if \(!targetId \|\| drag\.assetIds\.includes\(targetId\)\) return false/);
  assert.match(stackController, /if \(movingIds\.includes\(targetId\)\) return false/);
  assert.match(stackController, /STACK_DRAG_THRESHOLD_PX = 8/);
  assert.match(stackController, /setPointerCapture\(event\.pointerId\)/);
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

  assert.match(contextActions, /if \(options\.stackNode && asset\?\.stack\?\.id\)/);
  assert.match(contextActions, /mosa:open-stack/);
  assert.match(contextActions, /dissolveStack/);
  assert.match(contextActions, /method: "DELETE"/);
  assert.match(contextBindings, /stackNode: !state\.activeStackId && Boolean\(asset\.stack\?\.id\)/);
  assert.match(contextBindings, /selectionContainsStack/);
  assert.match(contextBindings, /const actionAssets = selectionContainsStack && !asset\.stack\?\.id \? \[asset\] : selectedAssets/);

  assert.match(html, /id="stackBack"/);
  assert.match(html, /id="selectionStack"/);
  assert.match(html, /id="selectionRemoveFromStack"/);
  assert.match(css, /\.asset-card\.is-stack/);
  assert.match(css, /\.asset-stack-count/);
  assert.match(css, /\.asset-card\.stack-drop-target/);
  assert.match(css, /\.stack-reorder-before/);
  assert.match(css, /\.stack-reorder-after/);
  assert.match(css, /\.asset-card\.is-stack\.is-video \.video-badge/);

  assert.match(i18n, /stackAssets: "堆叠"/);
  assert.match(i18n, /stackAssets: "Stack"/);
  assert.match(i18n, /operationInProgress:/);
  assert.match(i18n, /searchStack:/);
  assert.match(i18n, /stackMatchCount:/);
  assert.match(i18n, /galleryEntryAssetCount:/);
  assert.match(i18n, /dissolveStack:/);
});
