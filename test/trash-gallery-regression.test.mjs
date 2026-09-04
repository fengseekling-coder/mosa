import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("Trash removal reflows masonry topology without remeasuring every survivor", async () => {
  const app = await readFile(resolve(root, "app/app.mjs"), "utf8");
  const reconcileStart = app.indexOf("function reconcileAssetCards(entries)");
  const renderStart = app.indexOf("function renderGrid()", reconcileStart);
  const reconcile = app.slice(reconcileStart, renderStart);
  const masonryStart = app.indexOf("function layoutMasonry(cards = null)");
  const masonryEnd = app.indexOf("function scheduleMasonryLayout", masonryStart);
  const masonry = app.slice(masonryStart, masonryEnd);
  const renderEnd = app.indexOf("/** Routed through the state machine", renderStart);
  const render = app.slice(renderStart, renderEnd);

  assert.match(reconcile, /const structureChanged = existingOrder\.length !== desiredOrder\.length/,
    "card removals/reorders must be distinguished from render-key replacements");
  assert.match(reconcile, /return \{ changedCards, replacedFocusedCard, structureChanged \};/);
  assert.match(masonry, /function reflowMasonryPlacement\(\)/);
  assert.match(masonry, /placeMasonryCards\(grid, getComputedStyle\(grid\)\)/,
    "structural reflow must reuse existing row spans instead of measuring every card");
  assert.match(render, /if \(!requiresFullMasonry && structureChanged\) reflowMasonryPlacement\(\);/,
    "a pure removal must close masonry holes immediately");
});

test("Move to Trash uses one batch mutation and reconciles removed cards before the background refresh", async () => {
  const [actions, bindings] = await Promise.all([
    readFile(resolve(root, "app/context-menu-actions.mjs"), "utf8"),
    readFile(resolve(root, "app/context-menu-bindings.mjs"), "utf8"),
  ]);

  assert.match(actions, /apiFetch\("\/api\/assets\/batch"[\s\S]*?action: "trash"[\s\S]*?assetIds: assets\.map/,
    "Trash selection must not issue one HTTP DELETE per card");
  assert.match(actions, /removedAssetIds: outcome\.succeeded\.map/,
    "partial batches must remove only server-confirmed successes from the visible gallery");
  assert.match(bindings, /function applyImmediateAssetRemoval\(assetIds = \[\]\)/);
  assert.match(bindings, /renderGrid\?\.\(\{ preserveScroll: true \}\)/,
    "confirmed removals must repaint/reflow before network refresh latency is visible");
  assert.match(bindings, /state\.loadedPageCount > 1[\s\S]*?reloadLoadedAssetPages\(\{ background: true \}\)/,
    "mutations in a deep gallery must preserve the currently loaded page window");
  assert.match(bindings, /loadStats\(\{ background: true \}\)/,
    "mutation refreshes should not re-fetch the static library-path payload");
});
