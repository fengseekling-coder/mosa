import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { moveBlockBefore } from "../app/asset-stacks.mjs";

test("stack manual ordering makes the first asset the cover", () => {
  assert.deepEqual(moveBlockBefore(["a", "b", "c", "d"], ["d"], "a"), ["d", "a", "b", "c"]);
  assert.deepEqual(moveBlockBefore(["a", "b", "c", "d"], ["b", "c"], "a"), ["b", "c", "a", "d"]);
  assert.deepEqual(moveBlockBefore(["a", "b", "c"], ["a"], "c"), ["b", "a", "c"]);
});

test("visual stack behavior is wired into the shared web and desktop renderer", async () => {
  const [app, apiClient, stackController, selection, html, css, i18n] = await Promise.all([
    readFile(new URL("../app/app.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/api-client.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/asset-stacks.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/gallery-selection.mjs", import.meta.url), "utf8"),
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
  assert.match(app, /state\.activeStackId[\s\S]*?stackItemCount/);

  assert.match(apiClient, /request\.stackId[\s\S]*?\/api\/asset-stacks\//);
  assert.match(apiClient, /sort: state\.activeStackId \? "manual" : state\.sort/);
  assert.match(apiClient, /mosa:active-stack-missing/);

  assert.match(stackController, /POST[\s\S]*?\/api\/asset-stacks/);
  assert.match(stackController, /\/order/);
  assert.match(stackController, /removeSelectedFromStack/);
  assert.match(stackController, /stackViewIsUnfiltered/);
  assert.match(stackController, /if \(event\.shiftKey\) return/);
  assert.match(stackController, /selected\.has\(assetId\) \|\| state\.selectedId === assetId/);
  assert.doesNotMatch(stackController, /create.*folder|folder.*create/i);

  assert.match(selection, /state\.assetStackDragCandidate/);
  assert.match(selection, /includesExistingStack/);

  assert.match(html, /id="stackBack"/);
  assert.match(html, /id="selectionStack"/);
  assert.match(html, /id="selectionRemoveFromStack"/);
  assert.match(css, /\.asset-card\.is-stack/);
  assert.match(css, /\.asset-stack-count/);
  assert.match(css, /\.asset-card\.stack-drop-target/);

  assert.match(i18n, /stackAssets: "堆叠"/);
  assert.match(i18n, /stackAssets: "Stack"/);
  assert.match(i18n, /searchStack:/);
});
