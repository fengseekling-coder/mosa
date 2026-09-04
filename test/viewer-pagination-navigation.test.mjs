// Viewer pagination navigation contract (BUG-10 / Audit Fix Batch 2A): the Viewer
// session navigates the full query set beyond the first loaded page by loading the
// next page on demand at the loaded-sequence end, reusing the exact Gallery paging
// semantics (project/query/scope/facets/sort/shared gallery limit/cursor) through shared
// helpers, without ever reading live filter state, without limit=0, without copying
// asset objects, and without a second store. Failure and race behaviour: keep the
// current asset, release the loading guard, allow retry, drop late responses after
// Return or a new session, keep the Return Snapshot untouched. Static guards only —
// Node standard library, no network access.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const readApp = () => readFile(resolve(root, "app/asset-view.mjs"), "utf8");
const readGalleryApp = () => readFile(resolve(root, "app/app.mjs"), "utf8");
const readApiClient = () => readFile(resolve(root, "app/api-client.mjs"), "utf8");
const readLock = () => readFile(resolve(root, "package-lock.json"), "utf8");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Extracts a source slice between two markers. */
function sliceBetween(source, openMarker, closeMarker) {
  const start = source.indexOf(openMarker);
  assert.notEqual(start, -1, `marker not found: ${openMarker}`);
  const end = source.indexOf(closeMarker, start);
  assert.notEqual(end, -1, `marker not found: ${closeMarker}`);
  return source.slice(start, end);
}

/**
 * The body of a top-level app.js function (declaration through the balanced
 * brace). The parameter list is skipped first — default values may themselves
 * contain braces, so the first `{` after the name is not the function body.
 */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `marker not found: function ${name}(`);
  let parenDepth = 0;
  let cursor = source.indexOf("(", start);
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === "(") parenDepth += 1;
    if (source[cursor] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) { cursor += 1; break; }
    }
  }
  const open = source.indexOf("{", cursor);
  let braceDepth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") braceDepth += 1;
    if (source[i] === "}") {
      braceDepth -= 1;
      if (braceDepth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced function body: ${name}`);
}

test("viewer navigation indexes loaded asset ids with a Set", async () => {
  const viewer = await readApp();
  const indexHelpers = sliceBetween(viewer, "let assetViewAssetSetSource = null;", "// 从 fromIndex 沿 direction");
  const nav = functionBody(viewer, "updateAssetViewNav");

  assert.match(indexHelpers, /new Set\(state\.assets\.map\(\(asset\) => asset\.id\)\)/);
  assert.match(indexHelpers, /return currentAssetViewAssetIds\(\)\.has\(id\)/);
  assert.match(nav, /const availableIds = currentAssetViewAssetIds\(\);/);
  assert.doesNotMatch(nav, /ids\.filter\(/);
  assert.doesNotMatch(nav, /state\.assets\.some\(/);
});

/** Strips JS line/block comments so documented intent never trips negative assertions. */
function stripJsComments(source) {
  let output = "";
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const char = source[i];
    const pair = source.slice(i, i + 2);
    if (quote) {
      output += char;
      if (char === "\\") {
        output += source[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (char === quote) quote = null;
      i += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      output += char;
      i += 1;
      continue;
    }
    if (pair === "//") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (pair === "/*") {
      const close = source.indexOf("*/", i + 2);
      i = close === -1 ? source.length : close + 2;
      continue;
    }
    output += char;
    i += 1;
  }
  return output;
}

// 1. Gallery and Viewer share the same tuned page size.
test("1. first screen uses the shared gallery page size", async () => {
  const apiClient = await readApiClient();
  const params = functionBody(apiClient, "buildAssetPageParams");
  assert.match(params, /Number\(options\.limit\) \|\| GALLERY_PAGE_SIZE/, "the shared page params default to the tuned gallery page size");
  assert.match(functionBody(apiClient, "loadAssets"), /requestAssetPage\(request/, "loadAssets pages through the shared helper");
});

// 2. limit=0 is never used anywhere in the paging path.
test("2. no limit=0", async () => {
  const apiClient = await readApiClient();
  const paging = sliceBetween(apiClient, "function buildAssetPageParams", "let libraryRefreshInFlight");
  const load = stripJsComments(paging);
  assert.doesNotMatch(load, /params\.set\("limit",\s*"0"\)|limit\s*:\s*0/, "the paging path never requests an unlimited page");
});

// 2a. Any same-result gallery refresh rebuilds the cards, so the actual
// overflow element—not its non-scrolling parent—must retain the prior position.
// Result-set changes are the explicit exception and start from the top.
test("2a. gallery refresh preserves scroll unless result semantics changed", async () => {
  const [app, apiClient] = await Promise.all([readGalleryApp(), readApiClient()]);
  const render = functionBody(app, "renderGrid");
  assert.match(render, /const scrollContainer = els\.assetGrid;/, "the grid itself owns overflow scrolling");
  assert.match(render, /preserveScroll = true/, "direct UI rerenders preserve the current viewport by default");
  assert.match(render, /const savedScrollTop = \(isAppendMode \|\| preserveScroll\) \? scrollContainer\.scrollTop : null;/, "same-result refreshes and append capture the grid position before replacing cards");
  assert.doesNotMatch(render, /els\.assetGrid\?\.parentElement/, "the non-scrolling library view must not receive scroll restoration");
  assert.match(render, /setupMasonryLayout\(requiresFullMasonry \? \{\} : \{ cards: changedCards, full: false \}\);/, "masonry reconciliation runs before restoration is scheduled");
  assert.match(render, /requestAnimationFrame\(\(\) => \{\s*const maxScrollTop = Math\.max\(0, scrollContainer\.scrollHeight - scrollContainer\.clientHeight\);\s*scrollContainer\.scrollTop = Math\.min\(savedScrollTop, maxScrollTop\);/, "restoration waits for the post-layout frame and stays within the new scroll range");

  const load = functionBody(apiClient, "loadAssets");
  assert.match(apiClient, /let lastCommittedAssetRequestKey = null;/, "the loader tracks the last committed result-set semantics");
  assert.match(load, /const requestKey = assetRequestKey\(request\);/);
  assert.match(load, /const preserveScroll = options\.preserveScroll\s*\?\? \(options\.append \|\| lastCommittedAssetRequestKey === requestKey\);/, "same-query mutations preserve scroll while query/scope/sort/project changes do not");
  assert.match(load, /renderGrid\(\{[\s\S]*?preserveScroll,[\s\S]*?\}\);/, "the loader forwards the centralized scroll policy to renderGrid");
  assert.match(load, /lastCommittedAssetRequestKey = requestKey;/, "only an accepted request becomes the next scroll-policy baseline");
});

// 3. The Viewer total comes from state.pageTotal at open time.
test("3. viewer total uses pageTotal", async () => {
  const app = await readApp();
  assert.match(functionBody(app, "openAssetView"), /assetViewSequence\.total = state\.pageTotal;/, "session total captures pageTotal");
  assert.match(functionBody(app, "openAssetView"), /assetViewSequence\.nextCursor = state\.nextCursor;/, "session cursor captures nextCursor");
});

// 4. Opening at item 100 of a 106-item query renders `100 / 106`.
test("4. position renders against session total", async () => {
  const app = await readApp();
  const nav = functionBody(app, "updateAssetViewNav");
  assert.match(nav, /const total = Math\.max\(assetViewSequence\.total, validCount\);/, "total resolves from the stable session total");
  assert.match(nav, /els\.assetViewPosition\.textContent = visiblePosition > 0 \? `\$\{visiblePosition\} \/ \$\{total\}` : "—"/, "position output uses the session total");
});

// 5. Next stays available at the loaded boundary while a next page exists.
test("5. next available at loaded boundary", async () => {
  const app = await readApp();
  const can = stripJsComments(functionBody(app, "canNavigateAssetView"));
  assert.match(can, /direction === 1 && assetViewCanLoadNext\(\)/, "boundary Next is enabled when a page remains");
  const available = stripJsComments(functionBody(app, "assetViewCanLoadNext"));
  assert.match(available, /Boolean\(assetViewSequence\.nextCursor\)/, "a cursor must exist");
  assert.match(available, /assetViewSequence\.ids\.length < assetViewSequence\.total/, "loaded ids must stay below the query total");
});

// 6. A single Next press issues exactly one cursor request.
test("6. one cursor request per press", async () => {
  const app = await readApp();
  const available = stripJsComments(functionBody(app, "assetViewCanLoadNext"));
  assert.match(available, /!assetViewSequence\.loading/, "in-flight page load blocks further requests");
  const load = stripJsComments(functionBody(app, "loadNextAssetViewPage"));
  assert.match(load, /session\.loading = true;/, "the guard is set before the request");
  assert.match(load, /requestAssetPage\(session\.snapshot, \{ cursor \}\)/, "exactly one page request per guard");
});

// 7. The lazy request keeps project/query/scope/facets/sort from the captured snapshot.
test("7. request keeps captured query semantics", async () => {
  const app = await readApp();
  const apiClient = await readApiClient();
  const load = stripJsComments(functionBody(app, "loadNextAssetViewPage"));
  assert.match(load, /requestAssetPage\(session\.snapshot/, "the page request reads only the captured snapshot");
  assert.doesNotMatch(load, /state\.query|state\.scope|state\.facets|state\.sort/, "lazy loads never read live filter state");
  const params = functionBody(apiClient, "buildAssetPageParams");
  assert.match(params, /project: request\.project, q: request\.query/, "project and query travel");
  assert.match(params, /params\.set\("sort", request\.sort\)/, "sort travels");
  assert.match(params, /request\.scope === "favorite"\) params\.set\("favorite", "1"/, "favorite scope travels");
  assert.match(params, /request\.scope === "recent"\) params\.set\("recent", "1"/, "recent scope travels");
  assert.match(params, /for \(const key of FACET_KEYS\)/, "group/category/style facets travel");
  assert.match(functionBody(app, "openAssetView"), /assetViewSequence\.snapshot = currentAssetRequest\(\);/, "snapshot is captured at open");
});

// 8. After the boundary load the viewer advances to the first item of the new page.
test("8. advances to item 101 after boundary load", async () => {
  const app = await readApp();
  const navigate = stripJsComments(functionBody(app, "navigateAssetView"));
  assert.match(navigate, /await loadNextAssetViewPage\(\);/, "the boundary load runs before advancing");
  assert.match(navigate, /nextIndex = nextValidAssetViewIndex\(assetViewSequence\.index, 1\);/, "the advance re-scans the grown sequence");
  assert.match(navigate, /assetViewSequence\.index = nextIndex;/, "the session index moves to the new item");
});

// 9. New assets are appended deduplicated, in server order.
test("9. new assets append deduplicated", async () => {
  const app = await readApp();
  const load = functionBody(app, "loadNextAssetViewPage");
  assert.match(load, /const knownAssetIds = currentAssetViewAssetIds\(\);/, "incoming ids dedupe against the loaded-id index");
  assert.match(load, /if \(knownAssetIds\.has\(asset\.id\)\) return false;\s*knownAssetIds\.add\(asset\.id\);/, "the filter also blocks duplicates within the same page");
  assert.match(load, /state\.assets = state\.assets\.concat\(incoming\);/, "appended at the tail preserves server order");
  assert.match(load, /session\.ids = session\.ids\.concat\(incoming\.map\(\(asset\) => asset\.id\)\)/, "only new ids enter the session sequence");
});

// 10. The position updates to `101 / 106` after the advance.
test("10. position updates after advance", async () => {
  const app = await readApp();
  const navigate = stripJsComments(functionBody(app, "navigateAssetView"));
  assert.match(navigate, /updateAssetViewNav\(\)/, "navigation refreshes the position output");
  assert.match(functionBody(app, "openAssetView"), /updateAssetViewNav\(\)/, "open renders the initial position");
});

// 11. The last item of the query disables Next.
test("11. last item disables next", async () => {
  const app = await readApp();
  const available = stripJsComments(functionBody(app, "assetViewCanLoadNext"));
  assert.match(available, /Boolean\(assetViewSequence\.nextCursor\)/, "no cursor means no further page");
  assert.match(available, /assetViewSequence\.ids\.length < assetViewSequence\.total/, "loaded count at total means no further page");
  assert.match(functionBody(app, "updateAssetViewNav"), /setAssetViewControlDisabled\(els\.assetViewNext, !canNavigateAssetView\(1\)\)/, "next mirrors canNavigate(+1)");
});

// 12. A 206-item query can cross two page boundaries (100→101 and 200→201).
test("12. multiple boundaries supported", async () => {
  const app = await readApp();
  const load = functionBody(app, "loadNextAssetViewPage");
  assert.match(load, /const cursor = session\.nextCursor;/, "each boundary load uses the current cursor");
  assert.match(load, /session\.nextCursor = nextCursor;/, "the cursor advances after each page");
  const available = stripJsComments(functionBody(app, "assetViewCanLoadNext"));
  assert.match(available, /Boolean\(assetViewSequence\.nextCursor\)/, "a fresh cursor re-enables the next boundary");
});

// 13. Previous never issues a paging request.
test("13. previous never pages", async () => {
  const app = await readApp();
  const navigate = stripJsComments(functionBody(app, "navigateAssetView"));
  assert.match(navigate, /direction === 1 && assetViewCanLoadNext\(\)/, "the boundary load is gated to direction=1 only");
  assert.doesNotMatch(navigate, /loadNextAssetViewPage\(\)[\s\S]*direction === -1|direction === -1[\s\S]*loadNextAssetViewPage\(\)/, "no reverse pagination path");
});

// 14. Rapid repeated Next presses issue one request.
test("14. rapid next sends one request", async () => {
  const app = await readApp();
  const available = stripJsComments(functionBody(app, "assetViewCanLoadNext"));
  assert.match(available, /!assetViewSequence\.loading/, "the loading guard suppresses repeat triggers");
  assert.match(stripJsComments(functionBody(app, "loadNextAssetViewPage")), /if \(!assetViewCanLoadNext\(\)\) return false;/, "the guard short-circuits before any request");
});

// 15. A failed page request keeps the current asset untouched.
test("15. failure keeps current asset", async () => {
  const app = await readApp();
  const load = stripJsComments(functionBody(app, "loadNextAssetViewPage"));
  assert.doesNotMatch(load, /state\.selectedId =|renderAssetView\(\)|renderDetail\(\)/, "failure never moves the selection or repaints the stage");
  const failure = load.slice(load.indexOf("catch (error)"));
  assert.doesNotMatch(failure, /state\.assets =|state\.assets\.concat|session\.ids/, "the failure branch never appends assets or ids");
});

// 16. The loading guard is released on failure.
test("16. failure releases loading", async () => {
  const app = await readApp();
  const load = stripJsComments(functionBody(app, "loadNextAssetViewPage"));
  assert.match(load, /finally \{[\s\S]*?session\.loading = false;[\s\S]*?\}/, "the guard releases on every exit path");
});

// 17. After a failure Next can retry the same cursor.
test("17. failure allows retry", async () => {
  const app = await readApp();
  const load = stripJsComments(functionBody(app, "loadNextAssetViewPage"));
  assert.match(load, /catch \(error\) \{[\s\S]*?showToast\(error\.message, "error"\);[\s\S]*?return false;/, "failure toasts and returns without consuming the cursor");
  const available = stripJsComments(functionBody(app, "assetViewCanLoadNext"));
  assert.match(available, /!assetViewSequence\.loading/, "released guard re-enables the boundary");
  assert.doesNotMatch(available, /nextCursor = null/, "retry keeps the cursor");
});

// 18. Late responses after Return are dropped.
test("18. return drops late responses", async () => {
  const app = await readApp();
  const load = stripJsComments(functionBody(app, "loadNextAssetViewPage"));
  assert.match(load, /state\.viewMode !== "asset" \|\| session\.generation !== generation \|\| session\.requestKey !== requestKey\) return false;/, "Return/session/key changes discard the response");
  assert.match(functionBody(app, "returnToLibrary"), /assetViewSequence\.generation \+= 1;/, "Return advances the generation");
});

// 19. A new Viewer session invalidates old in-flight responses.
test("19. new session drops old responses", async () => {
  const app = await readApp();
  assert.match(functionBody(app, "openAssetView"), /assetViewSequence\.generation \+= 1;/, "each open advances the generation");
  const load = stripJsComments(functionBody(app, "loadNextAssetViewPage"));
  assert.match(load, /session\.generation !== generation/, "stale generation is rejected");
});

// 20. The lazy loader never touches the Library Return Snapshot.
test("20. return snapshot untouched", async () => {
  const app = await readApp();
  const load = stripJsComments(functionBody(app, "loadNextAssetViewPage"));
  assert.doesNotMatch(load, /libraryReturnSnapshot/, "the paging path never reads or writes the snapshot");
  assert.doesNotMatch(load, /scrollTop|focusedAssetId|selectedAssetId/, "the paging path never touches snapshot fields");
});

// 21. Gallery nextCursor stays in sync with the Viewer cursor.
test("21. gallery cursor syncs", async () => {
  const app = await readApp();
  const load = functionBody(app, "loadNextAssetViewPage");
  assert.match(load, /state\.nextCursor = nextCursor;/, "gallery cursor mirrors the viewer cursor");
  assert.match(load, /state\.pageTotal = total;/, "gallery total mirrors the query total");
  assert.doesNotMatch(load, /renderGrid\(/, "hidden gallery is not rendered while the viewer is open");
  assert.match(load, /assetViewGalleryDirty = true;/, "viewer marks the gallery for one deferred reconciliation on return");
  assert.match(load, /state\.loadedPageCount \+= 1;/, "the appended page counts towards loadedPageCount");
});

// 22. No id is ever duplicated across pages.
test("22. no duplicate ids", async () => {
  const app = await readApp();
  const load = stripJsComments(functionBody(app, "loadNextAssetViewPage"));
  assert.match(load, /knownAssetIds\.has\(asset\.id\)/, "incoming filters out loaded ids through the Set index");
  assert.match(load, /incoming\.map\(\(asset\) => asset\.id\)/, "only new ids are appended to the session");
});

// 23. A fully loaded query (no cursor) never triggers an extra request.
test("23. no request when fully loaded", async () => {
  const app = await readApp();
  const available = stripJsComments(functionBody(app, "assetViewCanLoadNext"));
  assert.match(available, /Boolean\(assetViewSequence\.nextCursor\)/, "no cursor means canLoadNext is false");
  assert.doesNotMatch(stripJsComments(functionBody(app, "updateAssetViewNav")), /requestAssetPage|loadNextAssetViewPage/, "boundary rendering never pages by itself");
});

// 24. Search/filter totals and navigation order survive lazy loading.
test("24. query semantics and order preserved", async () => {
  const app = await readApp();
  const load = stripJsComments(functionBody(app, "loadNextAssetViewPage"));
  assert.match(load, /requestAssetPage\(session\.snapshot, \{ cursor \}\)/, "the request rides the captured query snapshot");
  assert.match(load, /state\.assets = state\.assets\.concat\(incoming\);/, "server order appends at the tail");
  assert.match(functionBody(app, "openAssetView"), /assetViewSequence\.ids = state\.assets\.map\(\(asset\) => asset\.id\);/, "the session starts from the exact rendered order");
});

// 25. The Inspector data pipeline remains intact, but is deliberately deferred
// until after the main media frame during in-sequence navigation.
test("25. inspector pipeline intact and deferred", async () => {
  const app = await readApp();
  const load = stripJsComments(functionBody(app, "loadNextAssetViewPage"));
  assert.doesNotMatch(load, /renderDetail|versionHistory|recipeHistory/, "lazy loading never re-renders or resets the inspector");
  assert.match(stripJsComments(functionBody(app, "navigateAssetView")), /scheduleAssetViewDetailRender\(id\)/, "in-sequence navigation defers the inspector until after the media frame");
  assert.match(stripJsComments(functionBody(app, "scheduleAssetViewDetailRender")), /renderDetail\(\{ syncAssetView: false \}\)/, "the deferred inspector does not redundantly render the main media again");
});

// 26. Switching assets after a boundary load still resets the transform to fit.
test("26. transform resets on switch", async () => {
  const app = await readApp();
  assert.match(stripJsComments(functionBody(app, "navigateAssetView")), /renderAssetView\(\)/, "boundary advance re-renders the stage");
  assert.match(functionBody(app, "renderAssetView"), /if \(asset\.id !== assetViewStageAssetId\) \{[\s\S]*?resetAssetViewTransform\(\)/, "asset switch resets the transform");
});

// 27. The lockfile is untouched by Batch 2A.
test("27. package-lock unchanged", async () => {
  const lock = await readLock();
  assert.equal(sha256(lock), "5f63f56e0757215ab2e5f2773de24afe1e7fa9a5bddc41adde805856f0fe09ec", "package-lock.json must not change in Batch 2A");
});
