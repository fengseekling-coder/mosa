// Pluggable flow: seed a >130-asset library through the API (predictable
// created_at / sort_name / source / category / group), then drive the gallery
// UI through load-more pagination, type filters, sidebar smart groups (source),
// the manual-group section, combined refinement + empty-state reset, sort
// switching with its mosa.asset-sort persistence across a page reload, and an
// injected gallery-list outage asserting the error state renders and the grid
// busy flag resets (plus recovery once the outage is lifted).

import { execFile as execFileCallback } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { PAGE_HELPERS } from "./_page-helpers.mjs";

const execFile = promisify(execFileCallback);

export const name = "browse-sort-filter";
export const description = "seed 130 img + 2 vid -> one-page first screen + load-more to 132 -> type/source/group filters -> combined + empty-clear -> sort switch + reload persistence -> injected list outage: error state + busy reset + recovery";

const PROJECT = "default";
const GROUP_NAME = "bsfgroup";
const SEARCH_MARKER = "qmarker";
const SEARCH_MISS = "qqnomatch";
const IMAGE_COUNT = 130;
// web/app/config.mjs: the gallery's first page and every appended page.
const INITIAL_PAGE_SIZE = 60;
const GALLERY_PAGE_SIZE = 40;
// Every asset gets its own explicit minute so created_at is unique and the
// newest/oldest orders are exactly predictable (createAsset accepts created_at).
const BASE_MS = Date.UTC(2026, 7, 1);

const pad3 = (value) => String(value).padStart(3, "0");

function buildPlan({ withVideos }) {
  const images = [];
  for (let index = 0; index < IMAGE_COUNT; index += 1) {
    images.push({
      id: `bsf-img-${pad3(index)}`,
      video: false,
      seedIndex: index,
      createdAt: new Date(BASE_MS + index * 60_000).toISOString(),
      // 12 web-chatgpt images (evens below 24) + 1 video -> a smart group small
      // enough for exact-set assertions; everything else lands in codex-generated.
      sourceType: index % 2 === 0 && index < 24 ? "web-chatgpt" : "codex-generated",
      category: index % 2 === 0 ? "poster" : "icon",
      // theme feeds sort_name (theme || asset || id), so the "name" order is
      // decoupled from created_at: evens, then odds, then the videos.
      theme: `${index % 2 === 0 ? "ka" : "kb"}${pad3(index)}`,
      group: index < 8 ? GROUP_NAME : "",
      prompt: `browse sort filter item ${index}${index % 5 === 0 ? ` ${SEARCH_MARKER}` : ""}`,
      filePath: "",
    });
  }
  const videos = withVideos ? [0, 1].map((index) => ({
    id: `bsf-vid-${pad3(index)}`,
    video: true,
    seedIndex: IMAGE_COUNT + index,
    createdAt: new Date(BASE_MS + (IMAGE_COUNT + index) * 60_000).toISOString(),
    sourceType: index === 0 ? "web-chatgpt" : "codex-generated",
    category: "",
    theme: `kc${pad3(IMAGE_COUNT + index)}`,
    group: "",
    prompt: `browse sort filter video ${index}`,
    filePath: "",
  })) : [];
  return { images, videos, all: [...images, ...videos] };
}

// Mirrors lib/asset-sort.ts + the store's ORDER BY: newest/oldest key off
// created_at (id as tiebreak), name off the lowercased sort_name.
function expectedOrders(plan) {
  const newest = plan.all.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const oldest = plan.all.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const nameKey = (entry) => String(entry.theme || `${entry.id}${entry.video ? ".mp4" : ".png"}`).toLowerCase();
  const byName = plan.all.slice().sort((a, b) => nameKey(a).localeCompare(nameKey(b)) || a.id.localeCompare(b.id));
  return { newest, oldest, byName };
}

function buildPageExpectations(plan, orders) {
  const ids = (list) => list.map((entry) => entry.id);
  return {
    initialCount: Math.min(INITIAL_PAGE_SIZE, plan.all.length),
    newestFirst5: ids(orders.newest.slice(0, 5)),
    nameFirst5: ids(orders.byName.slice(0, 5)),
    // Full orders let the page assert "visible cards are a prefix of the API
    // order": result sets bigger than one page may auto-append (infinite
    // scroll), so exact first-page equality is only required below the limit.
    newestOrder: ids(orders.newest),
    oldestOrder: ids(orders.oldest),
    nameOrder: ids(orders.byName),
    imgOrder: ids(orders.newest.filter((entry) => !entry.video)),
    codexOrder: ids(orders.newest.filter((entry) => entry.sourceType === "codex-generated")),
    videoIds: ids(plan.videos.slice().reverse()),
    webSourceIds: ids(orders.newest.filter((entry) => entry.sourceType === "web-chatgpt")),
    webImgIds: ids(orders.newest.filter((entry) => entry.sourceType === "web-chatgpt" && !entry.video)),
    groupIds: ids(orders.newest.filter((entry) => entry.group === GROUP_NAME)),
    combinedIds: ids(orders.newest.filter((entry) => !entry.video
      && entry.sourceType === "web-chatgpt" && entry.prompt.includes(SEARCH_MARKER))),
  };
}

function assertEqual(actual, expected, label) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label}: expected ${expectedJson.slice(0, 500)}, got ${actualJson.slice(0, 500)}`);
  }
}

async function resolveFfmpeg() {
  for (const candidate of ["ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]) {
    try {
      await execFile(candidate, ["-version"], { timeout: 15_000 });
      return candidate;
    } catch {}
  }
  return null;
}

// The create API accepts .mp4 (VIDEO_EXTENSIONS) and skips derivative work for
// videos, so two tiny lavfi-generated clips are enough; no extra install needed.
async function makeVideoFiles(ctx, videos) {
  if (!videos.length) return { ok: true, reason: "" };
  const ffmpeg = await resolveFfmpeg();
  if (!ffmpeg) return { ok: false, reason: "no ffmpeg on PATH; video steps skipped" };
  const colors = ["steelblue", "firebrick"];
  try {
    for (const [index, video] of videos.entries()) {
      await execFile(ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", `color=c=${colors[index % colors.length]}:size=64x64:rate=10`,
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
        "-t", "0.4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
        join(ctx.fixturesDir, `${video.id}.mp4`),
      ], { timeout: 60_000 });
      video.filePath = join(ctx.fixturesDir, `${video.id}.mp4`);
    }
  } catch (error) {
    return { ok: false, reason: `ffmpeg failed: ${error.message}; video steps skipped` };
  }
  return { ok: true, reason: "" };
}

async function seedAssets(ctx, origin, plan) {
  const palette = [[74, 127, 181], [181, 68, 74], [58, 138, 87], [138, 90, 47], [96, 74, 155], [33, 77, 121]];
  const pngPaths = [];
  for (const [index, color] of palette.entries()) {
    pngPaths.push(await ctx.makePng(`bsf-seed-${index}.png`, color));
  }
  await ctx.api(origin, "POST", "/api/groups", { projectId: PROJECT, name: GROUP_NAME });
  for (const entry of plan.all) {
    const body = {
      projectId: PROJECT,
      imagePath: entry.filePath || pngPaths[entry.seedIndex % pngPaths.length],
      assetId: entry.id,
      prompt: entry.prompt,
      created_at: entry.createdAt,
      sourceType: entry.sourceType,
      theme: entry.theme,
      category: entry.category,
    };
    if (entry.group) body.group = entry.group;
    const created = await ctx.api(origin, "POST", "/api/assets/create", body);
    if (created?.asset?.id !== entry.id) throw new Error(`Seed ${entry.id}: unexpected asset id ${created?.asset?.id}`);
  }
}

async function apiAssetPage(ctx, origin, params) {
  const search = new URLSearchParams({ project: PROJECT, q: "", sort: "newest", view: "gallery", ...params });
  return ctx.api(origin, "GET", `/api/assets?${search}`);
}

async function fetchApiMirrors(ctx, origin, plan) {
  const page = async (params) => {
    const result = await apiAssetPage(ctx, origin, params);
    return (result.assets || []).map((asset) => asset.id);
  };
  const mirrors = {
    full: await apiAssetPage(ctx, origin, { limit: "250" }),
    oldest: await page({ limit: "250", sort: "oldest" }),
    name: await page({ limit: "250", sort: "name" }),
    img: await page({ limit: String(INITIAL_PAGE_SIZE), mediaKind: "img" }),
    video: await page({ limit: String(INITIAL_PAGE_SIZE), mediaKind: "video" }),
    webSource: await page({ limit: String(INITIAL_PAGE_SIZE), source: "web-chatgpt" }),
    codexSource: await page({ limit: String(INITIAL_PAGE_SIZE), source: "codex-generated" }),
    group: await page({ limit: String(INITIAL_PAGE_SIZE), group: GROUP_NAME }),
    combined: await page({ limit: String(INITIAL_PAGE_SIZE), source: "web-chatgpt", mediaKind: "img", q: SEARCH_MARKER }),
    poster: await page({ limit: "250", category: "poster" }),
    icon: await page({ limit: "250", category: "icon" }),
  };
  mirrors.fullIds = (mirrors.full.assets || []).map((asset) => asset.id);
  mirrors.created = new Map((mirrors.full.assets || []).map((asset) => [asset.id, asset.created_at]));
  return mirrors;
}

// The API mirrors must reproduce the designed seed exactly, otherwise every
// later UI comparison would be meaningless.
function assertMirrorsMatchPlan(mirrors, plan, orders, expect, videosReady) {
  const ids = (list) => list.map((entry) => entry.id);
  assertEqual(mirrors.fullIds, ids(orders.newest), "API newest listing matches the seeded created_at order");
  assertEqual(mirrors.oldest, ids(orders.oldest), "API oldest listing matches the designed order");
  assertEqual(mirrors.name, ids(orders.byName), "API name listing matches the designed sort_name order");
  for (const entry of plan.all) {
    const stored = mirrors.created.get(entry.id);
    if (!stored || Date.parse(stored) !== Date.parse(entry.createdAt)) {
      throw new Error(`created_at round-trip failed for ${entry.id}: ${stored}`);
    }
  }
  assertEqual(mirrors.img, expect.imgOrder.slice(0, INITIAL_PAGE_SIZE), "API mediaKind=img first page");
  if (videosReady) assertEqual(mirrors.video, expect.videoIds, "API mediaKind=video listing");
  assertEqual(mirrors.webSource, expect.webSourceIds, "API source=web-chatgpt listing");
  assertEqual(mirrors.codexSource.slice(0, INITIAL_PAGE_SIZE), expect.codexOrder.slice(0, INITIAL_PAGE_SIZE), "API source=codex-generated first page");
  assertEqual(mirrors.group, expect.groupIds, "API group listing");
  assertEqual(mirrors.combined, expect.combinedIds, "API combined source+img+q listing");
  const asSet = (list) => list.slice().sort().join(",");
  assertEqual(asSet(mirrors.poster), asSet(ids(plan.images.filter((entry) => entry.category === "poster"))), "category=poster partition");
  assertEqual(asSet(mirrors.icon), asSet(ids(plan.images.filter((entry) => entry.category === "icon"))), "category=icon partition");
}

function assertSessionOne(obs, plan, orders, expect, videosReady) {
  assertEqual(obs.initialIds.length, expect.initialCount, "first screen loads exactly one gallery page");
  if (!obs.sentinelInitially) throw new Error("first screen should still have a pending next page (infinite scroll sentinel)");
  assertEqual(obs.initialIds, expect.newestOrder.slice(0, expect.initialCount), "first screen is the newest-order first page");
  if (!Array.isArray(obs.stages) || obs.stages.length < 1
    || !obs.stages.every((value, index) => index === 0 ? value > expect.initialCount : value > obs.stages[index - 1])) {
    throw new Error(`load-more stages not strictly growing past the first page: ${JSON.stringify(obs.stages)}`);
  }
  assertEqual(obs.stages.at(-1), plan.all.length, "load-more ends with the whole library");
  assertEqual(obs.loadedIds, orders.newest.map((entry) => entry.id), "fully scrolled gallery equals the API listing (no gaps, no reordering)");
  if (new Set(obs.loadedIds).size !== obs.loadedIds.length) throw new Error("duplicate cards after load-more");

  // Result sets larger than one page may auto-append; the visible cards must
  // still be an exact prefix of the API order under the same params.
  assertPrefix(obs.imgIds, expect.imgOrder, expect.initialCount, "type filter img");
  if (obs.imgIds.some((id) => plan.videos.some((video) => video.id === id))) throw new Error("img filter still shows videos");
  assertEqual(obs.imgPressed, { active: true, pressed: "true" }, "img filter button state");
  if (videosReady) {
    assertEqual(obs.videoIds, expect.videoIds, "type filter video leaves only videos");
    assertEqual(obs.videoPressed, { active: true, pressed: "true" }, "video filter button state");
  }
  assertPrefix(obs.allTypeIds, expect.newestOrder, expect.initialCount, "type filter all restores newest order");
  assertEqual(obs.allPressed, { active: true, pressed: "true" }, "all-types button state");

  assertEqual(obs.newestIds.slice(0, 5), expect.newestFirst5, "sort newest first-5");
  assertPrefix(obs.newestIds, expect.newestOrder, expect.initialCount, "sort newest page");
  assertEqual(obs.oldestIds.slice(0, 5), expect.oldestOrder.slice(0, 5), "sort oldest first-5");
  assertPrefix(obs.oldestIds, expect.oldestOrder, expect.initialCount, "sort oldest page");
  assertEqual(obs.nameIds.slice(0, 5), expect.nameFirst5, "sort name first-5");
  assertPrefix(obs.nameIds, expect.nameOrder, expect.initialCount, "sort name page");
  assertEqual(obs.sortValue, "name", "sort select ends on name");
  assertEqual(obs.storedSort, "name", "sort persisted to mosa.asset-sort");
}

function assertPrefix(actual, order, minCount, label) {
  if (actual.length < minCount) throw new Error(`${label}: only ${actual.length} cards visible (expected at least ${minCount})`);
  assertEqual(actual, order.slice(0, actual.length), `${label} is an exact prefix of the API order`);
}

function assertSessionTwo(obs, plan, orders, expect, videosReady) {
  assertEqual(obs.reloaded.sortValue, "name", "reload keeps the remembered sort in #sortSelect");
  assertEqual(obs.reloaded.storedSort, "name", "reload reads mosa.asset-sort");
  assertEqual(obs.reloaded.firstIds, expect.nameFirst5, "reloaded gallery still renders in name order");

  const sourceCounts = Object.fromEntries(obs.sourceItems.map((item) => [item.value, Number(item.count)]));
  const expectedCounts = { "web-chatgpt": expect.webSourceIds.length, "codex-generated": plan.all.length - expect.webSourceIds.length };
  for (const [value, count] of Object.entries(expectedCounts)) {
    if (sourceCounts[value] !== count) throw new Error(`smart group ${value} count ${sourceCounts[value]} != ${count}`);
  }

  assertEqual(obs.webSource.ids, expect.webSourceIds, "source=web-chatgpt shows exactly that source's assets");
  assertEqual(obs.webSource.item, { active: true, pressed: "true" }, "web-chatgpt item highlighted");
  assertEqual(obs.webSource.allItem, { active: false, pressed: "false" }, "全部素材 de-highlighted while a source is active");
  assertPrefix(obs.codexSource.ids, expect.codexOrder, expect.initialCount, "source=codex-generated");
  assertEqual(obs.codexSource.item, { active: true, pressed: "true" }, "codex-generated item highlighted");

  assertEqual(obs.groupState.ids, expect.groupIds, "manual group filter shows exactly its members");
  assertEqual(obs.groupState.item, { active: true, pressed: "true" }, "group item highlighted");
  assertEqual(obs.groupState.title, GROUP_NAME, "view title names the open group");

  if (obs.categoryEntry.heading !== "素材分类" || obs.categoryEntry.hasCategoryControl
    || obs.categoryEntry.filterValues.includes("category")) {
    throw new Error(`unexpected category filter entry: ${JSON.stringify(obs.categoryEntry)}`);
  }

  assertEqual(obs.combined.ids, expect.combinedIds, "source+img+search intersection");
  assertEqual(obs.combined.searchValue, SEARCH_MARKER, "search box keeps the query");

  assertEqual(obs.emptyState, { kind: "no-results", cardCount: 0, hasClear: true }, "empty state offers 清除筛选");
  if (obs.afterReset.count < expect.initialCount) throw new Error(`clear-filters restored only ${obs.afterReset.count} cards`);
  // Whatever pagination auto-appended after the reset, the visible cards must
  // be exactly the newest-order prefix of the whole library.
  assertEqual(obs.afterReset.ids, orders.newest.slice(0, obs.afterReset.count).map((entry) => entry.id), "clear-filters gallery is the newest-order prefix");
  assertEqual(obs.afterReset.firstIds, expect.newestFirst5, "clear-filters restores newest order");
  assertEqual(obs.afterReset.searchValue, "", "clear-filters empties the search box");
  assertEqual(obs.afterReset.sourceItem, { active: false, pressed: "false" }, "clear-filters deactivates the source facet");
  assertEqual(obs.afterReset.typeAll, { active: true, pressed: "true" }, "clear-filters resets the type filter");
  assertEqual(obs.afterReset.title, "所有素材", "clear-filters restores the view title");
}

function sessionOneSource(expect) {
  return `(async () => {
    const expect = ${JSON.stringify(expect)};
    ${PAGE_HELPERS}
    const gridElement = () => document.querySelector('#assetGrid');
    const sentinel = () => document.querySelector('#assetGrid [data-sentinel="true"]');
    const typePressed = (kind) => {
      const button = document.querySelector('.topbar-type-filters [data-type="' + kind + '"]');
      return { active: Boolean(button?.classList.contains('active')), pressed: button?.getAttribute('aria-pressed') || '' };
    };
    async function scrollToLoadAll(label) {
      const deadline = Date.now() + 90000;
      const stages = [];
      while (sentinel()) {
        if (Date.now() > deadline) {
          throw new Error('pagination timeout at ' + rootCardIds().length + ' cards, stages='
            + JSON.stringify(stages) + ' diagnostic=' + JSON.stringify(pageDiagnostic()));
        }
        const before = rootCardIds().length;
        const grid = gridElement();
        grid.scrollTop = grid.scrollHeight;
        grid.dispatchEvent(new Event('scroll'));
        await waitFor(() => rootCardIds().length > before || !sentinel(), label + ' appended a page', 20000);
        stages.push(rootCardIds().length);
      }
      await waitFor(() => gallerySettled(), label + ' settled');
      return stages;
    }
    // 超过一页的结果集可能触发无限滚动自动追加，等待条件用"是完整顺序的前缀"；
    // 是否恰好一页只在首屏（见 initial first page）与小于 limit 的状态严格要求。
    const isPrefix = (ids, order) => ids.length <= order.length && ids.every((id, index) => order[index] === id);
    const matchesOrder = (order) => gallerySettled() && rootCardIds().length >= expect.initialCount
      && isPrefix(rootCardIds(), order);
    async function applySort(value, order, label) {
      setValue('#sortSelect', value);
      await waitFor(() => matchesOrder(order), label, 20000);
      return rootCardIds();
    }
    await waitFor(() => gallerySettled() && rootCardIds().length === expect.initialCount, 'initial first page');
    const initialIds = rootCardIds();
    const sentinelInitially = Boolean(sentinel());
    const stages = await scrollToLoadAll('pagination');
    const loadedIds = rootCardIds();
    click('.topbar-type-filters [data-type="img"]');
    // Without seeded videos the img order equals the unfiltered order, so the
    // order check alone passes before the click lands; wait for the filter too.
    await waitFor(() => typePressed('img').active && matchesOrder(expect.imgOrder), 'img filter prefix of API order');
    const imgIds = rootCardIds();
    const imgPressed = typePressed('img');
    let videoIds = [];
    let videoPressed = null;
    if (expect.videoIds.length) {
      click('.topbar-type-filters [data-type="video"]');
      await waitFor(() => gallerySettled() && JSON.stringify(rootCardIds()) === JSON.stringify(expect.videoIds), 'video filter');
      videoIds = rootCardIds();
      videoPressed = typePressed('video');
    }
    click('.topbar-type-filters [data-type="all"]');
    await waitFor(() => typePressed('all').active && matchesOrder(expect.newestOrder), 'back to all types');
    const allTypeIds = rootCardIds();
    const allPressed = typePressed('all');
    const newestIds = await applySort('newest', expect.newestOrder, 'sort newest applied');
    const oldestIds = await applySort('oldest', expect.oldestOrder, 'sort oldest applied');
    const nameIds = await applySort('name', expect.nameOrder, 'sort name applied');
    return {
      initialIds, sentinelInitially, stages, loadedIds,
      imgIds, imgPressed, videoIds, videoPressed, allTypeIds, allPressed,
      newestIds, oldestIds, nameIds,
      sortValue: document.querySelector('#sortSelect').value,
      storedSort: localStorage.getItem('mosa.asset-sort') || '',
    };
  })()`;
}

function sessionTwoSource(expect) {
  return `(async () => {
    const expect = ${JSON.stringify(expect)};
    ${PAGE_HELPERS}
    const sourceSelector = (value) => '#sidebarGroupList .nav-item[data-filter="source"][data-value="' + value + '"]';
    const groupSelector = (value) => '#sidebarManualGroupList .nav-item[data-filter="group"][data-value="' + value + '"]';
    const sourceButton = (value) => document.querySelector(sourceSelector(value));
    const groupButton = (value) => document.querySelector(groupSelector(value));
    const navState = (button) => button
      ? { active: button.classList.contains('active'), pressed: button.getAttribute('aria-pressed') || '' }
      : null;
    const viewTitle = () => document.querySelector('#viewTitle')?.textContent || '';
    const typePressed = (kind) => {
      const button = document.querySelector('.topbar-type-filters [data-type="' + kind + '"]');
      return { active: Boolean(button?.classList.contains('active')), pressed: button?.getAttribute('aria-pressed') || '' };
    };
    // 排序记忆是这里的断言目标；"首屏恰好一页"已在 session 1 严格验证过。
    // 重新加载若撞上空态塌陷布局的自动追加（见下方 reset 注释），数量可能 >60。
    await waitFor(() => gallerySettled() && rootCardIds().length >= expect.initialCount, 'gallery reloads after the sort change');
    const reloaded = {
      sortValue: document.querySelector('#sortSelect').value,
      storedSort: localStorage.getItem('mosa.asset-sort') || '',
      firstIds: rootCardIds().slice(0, 5),
    };
    setValue('#sortSelect', 'newest');
    await waitFor(() => gallerySettled() && JSON.stringify(rootCardIds().slice(0, 5)) === JSON.stringify(expect.newestFirst5), 'sort back to newest');
    const sourceItems = [...document.querySelectorAll('#sidebarGroupList .nav-item[data-filter="source"]')]
      .map((button) => ({ value: button.dataset.value, count: button.querySelector('.nav-count')?.textContent || '', active: button.classList.contains('active') }));
    click(sourceSelector('web-chatgpt'));
    await waitFor(() => gallerySettled() && JSON.stringify(rootCardIds()) === JSON.stringify(expect.webSourceIds), 'source web-chatgpt filter');
    const webSource = {
      ids: rootCardIds(),
      item: navState(sourceButton('web-chatgpt')),
      allItem: navState(document.querySelector('#quickFilters [data-filter="all"]')),
      title: viewTitle(),
    };
    click(sourceSelector('codex-generated'));
    await waitFor(() => gallerySettled() && rootCardIds().length >= expect.initialCount
      && rootCardIds().every((id, index) => expect.codexOrder[index] === id), 'source codex-generated prefix of API order');
    const codexSource = { ids: rootCardIds(), item: navState(sourceButton('codex-generated')) };
    click(groupSelector('${GROUP_NAME}'));
    await waitFor(() => gallerySettled() && JSON.stringify(rootCardIds()) === JSON.stringify(expect.groupIds), 'manual group filter');
    const groupState = { ids: rootCardIds(), item: navState(groupButton('${GROUP_NAME}')), title: viewTitle() };
    const categoryEntry = {
      heading: document.querySelector('.sidebar-manual-group-heading .nav-label')?.textContent || '',
      filterValues: [...new Set([...document.querySelectorAll('#quickFilters [data-filter], #sidebarGroupList [data-filter], #sidebarManualGroupList [data-filter]')]
        .map((button) => button.dataset.filter))].sort(),
      hasCategoryControl: Boolean(document.querySelector('[data-filter="category"]')),
      manualItemValues: [...document.querySelectorAll('#sidebarManualGroupList [data-filter]')]
        .map((button) => ({ filter: button.dataset.filter, value: button.dataset.value || '' })),
    };
    click(sourceSelector('web-chatgpt'));
    await waitFor(() => gallerySettled() && JSON.stringify(rootCardIds()) === JSON.stringify(expect.webSourceIds), 'source facet re-applied');
    click('.topbar-type-filters [data-type="img"]');
    await waitFor(() => gallerySettled() && JSON.stringify(rootCardIds()) === JSON.stringify(expect.webImgIds), 'source+img window');
    setValue('#searchInput', '${SEARCH_MARKER}');
    await waitFor(() => gallerySettled() && JSON.stringify(rootCardIds()) === JSON.stringify(expect.combinedIds), 'combined source+img+search', 20000);
    const combined = { ids: rootCardIds(), searchValue: document.querySelector('#searchInput')?.value || '' };
    setValue('#searchInput', '${SEARCH_MISS}');
    await waitFor(() => document.querySelector('.gallery-empty-state') && document.querySelector('[data-action="empty-clear"]'), 'empty state with clear action', 20000);
    const emptyState = {
      kind: document.querySelector('.gallery-empty-state')?.dataset.emptyKind || '',
      cardCount: rootCardIds().length,
      hasClear: Boolean(document.querySelector('[data-action="empty-clear"]')),
    };
    click('[data-action="empty-clear"]');
    // 重置后首屏通常恰好是 60 张；但空态塌陷布局下 IntersectionObserver 的首次
    // 报告可能跑赢瀑布流布局，紧接一次自动追加（60 -> 100），所以这里只要求
    // "至少一页且顺序正确"，完整前缀校验在 Node 端做（见 assertSessionTwo）。
    await waitFor(() => gallerySettled() && rootCardIds().length >= expect.initialCount
      && JSON.stringify(rootCardIds().slice(0, 5)) === JSON.stringify(expect.newestFirst5), 'clear-filters restores the library', 20000);
    const afterReset = {
      count: rootCardIds().length,
      ids: rootCardIds(),
      firstIds: rootCardIds().slice(0, 5),
      searchValue: document.querySelector('#searchInput')?.value || '',
      sourceItem: navState(sourceButton('web-chatgpt')),
      typeAll: typePressed('all'),
      title: viewTitle(),
    };
    return { reloaded, sourceItems, webSource, codexSource, groupState, categoryEntry, combined, emptyState, afterReset };
  })()`;
}

function assertSessionThree(obs, expect) {
  if (!obs?.errorState) throw new Error("error-state step returned no observation");
  const errorState = obs.errorState;
  if (errorState.galleryListFailures < 1) throw new Error("injected outage never failed a gallery list request");
  if (!errorState.hasErrorState || !errorState.hasRetry) {
    throw new Error(`gallery error state did not render: ${JSON.stringify(errorState)}`);
  }
  if (errorState.message !== "e2e injected gallery outage") {
    throw new Error(`error state did not surface the failure message: ${JSON.stringify(errorState)}`);
  }
  if (errorState.ariaBusy !== "false") {
    throw new Error(`#assetGrid stayed busy after the error render (setGalleryBusy regression): ${JSON.stringify(errorState)}`);
  }
  if (errorState.rendererErrors.length) {
    throw new Error(`error render produced renderer errors: ${JSON.stringify(errorState.rendererErrors)}`);
  }
  const recovered = obs.recovered;
  if (!recovered) throw new Error("recovery step returned no observation");
  if (recovered.ariaBusy !== "false") throw new Error(`gallery stayed busy after recovery: ${JSON.stringify(recovered)}`);
  if (recovered.cardCount < expect.initialCount) throw new Error(`gallery recovery restored only ${recovered.cardCount} cards`);
  if (recovered.rendererErrors.length) throw new Error(`gallery recovery produced renderer errors: ${JSON.stringify(recovered.rendererErrors)}`);
}

// Session three faults the gallery list transport (GET /api/assets?..., the
// endpoint loadAssets -> requestAssetPage drives) at the fetch boundary and
// reloads through the real sort control. The error state must render and
// #assetGrid's aria-busy must land back on "false" — the exact path where
// renderErrorState used to throw on the missing setGalleryBusy export, leaving
// the grid busy and killing the caller's tail (e.g. the init status message).
function sessionThreeSource(expect) {
  return `(async () => {
    const expect = ${JSON.stringify(expect)};
    ${PAGE_HELPERS}
    const gridElement = () => document.querySelector('#assetGrid');
    const errorStateNode = () => gridElement().querySelector('.error-state');
    // The driver executes this script once the page loaded, but the first
    // gallery request may still be in flight: wait it out so the injection
    // cannot fault the initial load instead of the one we trigger.
    await waitFor(() => gallerySettled() && rootCardIds().length >= expect.initialCount, 'gallery ready before the injected outage', 30000);
    const originalFetch = window.fetch.bind(window);
    let galleryListFailures = 0;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      if (method === 'GET' && url.indexOf('/api/assets?') === 0) {
        galleryListFailures += 1;
        return Promise.resolve(new Response(JSON.stringify({ error: 'e2e injected gallery outage' }), { status: 500, headers: { 'content-type': 'application/json' } }));
      }
      return originalFetch(input, init);
    };
    setValue('#sortSelect', 'oldest');
    await waitFor(() => errorStateNode(), 'error state renders after the injected outage', 20000);
    const errorState = {
      galleryListFailures,
      hasErrorState: Boolean(errorStateNode()),
      hasRetry: Boolean(errorStateNode()?.querySelector('[data-action="retry"]')),
      message: errorStateNode()?.querySelector('span')?.textContent || '',
      ariaBusy: gridElement().getAttribute('aria-busy'),
      cardCount: rootCardIds().length,
      rendererErrors: rendererErrors.slice(0, 3),
    };
    window.fetch = originalFetch;
    setValue('#sortSelect', 'newest');
    await waitFor(() => gallerySettled() && !errorStateNode() && rootCardIds().length >= expect.initialCount, 'gallery recovers after the outage is lifted', 20000);
    const recovered = {
      ariaBusy: gridElement().getAttribute('aria-busy'),
      cardCount: rootCardIds().length,
      rendererErrors: rendererErrors.slice(0, 3),
    };
    return { errorState, recovered };
  })()`;
}

export async function run(ctx) {
  await ctx.prepare();
  const ffmpegProbe = await resolveFfmpeg();
  const plan = buildPlan({ withVideos: Boolean(ffmpegProbe) });
  const videoResult = await makeVideoFiles(ctx, plan.videos);
  const videosReady = videoResult.ok && plan.videos.length > 0;
  const finalPlan = videosReady ? plan : buildPlan({ withVideos: false });

  const server = await ctx.startServer();
  try {
    await seedAssets(ctx, server.origin, finalPlan);
    const orders = expectedOrders(finalPlan);
    const expect = buildPageExpectations(finalPlan, orders);
    const mirrors = await fetchApiMirrors(ctx, server.origin, finalPlan);
    assertMirrorsMatchPlan(mirrors, finalPlan, orders, expect, videosReady);

    const one = await ctx.runInPage(server, sessionOneSource(expect));
    assertSessionOne(one, finalPlan, orders, expect, videosReady);

    const two = await ctx.runInPage(server, sessionTwoSource(expect));
    assertSessionTwo(two, finalPlan, orders, expect, videosReady);

    const three = await ctx.runInPage(server, sessionThreeSource(expect));
    assertSessionThree(three, expect);

    return {
      seeded: finalPlan.all.length,
      images: finalPlan.images.length,
      videos: videosReady ? finalPlan.videos.length : 0,
      videosSkippedReason: videosReady ? "" : videoResult.reason,
      pagination: { firstPage: expect.initialCount, stages: one.stages },
      filters: ["type-img", ...(videosReady ? ["type-video"] : []), "source-web-chatgpt", "source-codex-generated", `group-${GROUP_NAME}`, "combined-source-img-search", "empty-clear"],
      sorts: ["newest", "oldest", "name"],
      sortPersistedAcrossReload: two.reloaded.sortValue === "name",
      errorState: {
        ariaBusyReset: three.errorState.ariaBusy === "false",
        rendererErrors: three.errorState.rendererErrors.length + three.recovered.rendererErrors.length,
        recoveredCards: three.recovered.cardCount,
      },
      categoryUiEntry: false,
    };
  } finally {
    await server.stop();
  }
}
