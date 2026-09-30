// E2E flow: change-library-location without the native dialogs. The library
// service seeds a rich dataset through the API, stops, relocates with the same
// lib helpers the desktop handler uses (validate -> copy -> delete the old
// tree), restarts on the new location, and then proves the gallery, managed
// files and every relation survived with no managed path left behind.

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { copyLibraryForRelocation, validateRelocationTarget } from "../../lib/library-relocation.mjs";
import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "library-relocation";
export const description = "seed tags/group/stack/versions/favorite/trash -> stop -> validate+copy relocation -> restart on the new dir -> gallery and files intact, no path left in the old location";

const GROUP_NAME = "迁移分组";
const STACK_TAGS = ["迁移", "e2e标签"];
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

export async function run(ctx) {
  await ctx.prepare();
  const oldLibraryDir = ctx.libraryDir;
  const nextLibraryDir = join(dirname(ctx.userDataDir), "relocated-library");

  let before;
  const first = await ctx.startServer();
  try {
    before = await seedAndCapture(ctx, first.origin);
    // Baseline render of the seeded library so the post-relocation comparison
    // is meaningful.
    before.rootIds = await ctx.runInPage(first, rootIdsSource());
  } finally {
    await first.stop();
  }

  // Same sequence as ipcMain.handle("change-library-location") minus dialogs:
  // validate (creates the target), stop (already stopped), copy+rebase, then
  // delete the old tree only after the copy is authoritative.
  const validation = await validateRelocationTarget({ currentLibraryDir: oldLibraryDir, nextLibraryDir });
  if (!validation.ok) throw new Error(`Relocation target rejected unexpectedly: ${JSON.stringify(validation)}`);
  await copyLibraryForRelocation({ sourceLibraryDir: oldLibraryDir, destinationLibraryDir: nextLibraryDir });
  await rm(oldLibraryDir, { recursive: true, force: true });

  const second = await ctx.startServer({ libraryDir: nextLibraryDir });
  try {
    assertRelocatedGallery(await ctx.runInPage(second, relocatedGallerySource(before)), before);
    await assertRelocatedData(ctx, second.origin, before, { oldLibraryDir, nextLibraryDir });
  } finally {
    await second.stop();
  }

  await assertValidationRejects(nextLibraryDir);
  return {
    listedAssets: before.listedIds.length,
    trashAssets: before.trashIds.length,
    versions: before.versionIds.length,
    relocatedTo: nextLibraryDir,
    rootIdsBefore: before.rootIds.length,
  };
}

async function seedAndCapture(ctx, origin) {
  const api = (method, path, body) => ctx.api(origin, method, path, body);
  const create = async (key, [r, g, b], extra = {}) => {
    const body = await api("POST", "/api/assets/create", {
      projectId: "default",
      imagePath: await ctx.makePng(`relocation-${key}.png`, [r, g, b]),
      prompt: `${key} 的提示词`,
      ...extra,
    });
    if (!body?.asset?.id) throw new Error(`Asset seed returned no id for ${key}`);
    return body.asset.id;
  };
  const tagged = await create("tagged", [74, 127, 181]);
  const grouped = await create("grouped", [58, 138, 87]);
  const stackCover = await create("stack-cover", [181, 68, 74]);
  const stackMember = await create("stack-member", [138, 90, 47]);
  const favorite = await create("favorite", [96, 74, 155]);
  const versionRoot = await create("version-root", [33, 77, 121]);
  const trashed = await create("trashed", [160, 100, 40]);

  await waitForReady(api);
  const versionChild = (await api("POST", `/api/assets/default/${encodeURIComponent(versionRoot)}/versions`, {
    version_change: "迁移第一版",
    prompt: "迁移版本链第二张",
  })).asset.id;
  const versionGrandchild = (await api("POST", `/api/assets/default/${encodeURIComponent(versionChild)}/versions`, {
    version_change: "迁移第二版",
    prompt: "迁移版本链第三张",
  })).asset.id;
  await waitForReady(api, [versionChild, versionGrandchild]);

  await api("PATCH", `/api/assets/default/${encodeURIComponent(tagged)}`, { tags: STACK_TAGS });
  await api("POST", `/api/assets/default/${encodeURIComponent(favorite)}/favorite`);
  await api("DELETE", `/api/assets/default/${encodeURIComponent(trashed)}`);
  const stack = (await api("POST", "/api/asset-stacks", {
    projectId: "default",
    assetIds: [stackCover, stackMember],
    coverAssetId: stackCover,
  })).stack;
  if (!stack?.id) throw new Error("Stack seed returned no stack id.");
  await api("POST", "/api/groups", { projectId: "default", name: GROUP_NAME });
  await api("PATCH", `/api/assets/default/${encodeURIComponent(grouped)}`, { group: GROUP_NAME });

  const listing = await api("GET", "/api/assets?project=default&limit=250");
  const trashListing = await api("GET", "/api/assets?project=default&limit=250&trash=1");
  const groups = await api("GET", "/api/groups?project=default");
  const versionHistory = await api("GET", `/api/assets/default/${encodeURIComponent(versionRoot)}/versions`);
  const listedAssets = listing.assets || [];
  const trashAssets = trashListing.assets || [];
  const groupList = Array.isArray(groups?.groups) ? groups.groups : groups?.groups?.groups || [];
  const group = groupList.find((entry) => (Array.isArray(entry) ? entry[0] : entry.name) === GROUP_NAME);
  return {
    listedIds: listedAssets.map((asset) => asset.id).sort(),
    trashIds: trashAssets.map((asset) => asset.id).sort(),
    tagged,
    tags: STACK_TAGS,
    favorite,
    grouped,
    groupName: GROUP_NAME,
    groupCount: Array.isArray(group) ? group[1] : group?.count,
    stackId: stack.id,
    stackCount: stack.count,
    stackCover: stack.cover_asset_id,
    versionIds: (versionHistory?.history?.versions || []).map((version) => version.id),
  };
}

// Polls until every currently listed asset (plus the explicitly named ones)
// reports both thumbnail and preview as ready.
async function waitForReady(api, extraAssetIds = []) {
  const deadline = Date.now() + 90000;
  const assetReady = async (assetId) => {
    const body = await api("GET", `/api/assets/default/${encodeURIComponent(assetId)}`);
    return Boolean(body?.asset?.thumbnail_ready && body?.asset?.preview_ready);
  };
  for (;;) {
    const page = await api("GET", "/api/assets?project=default&limit=250");
    const assets = page.assets || [];
    const extraReady = (await Promise.all(extraAssetIds.map(assetReady))).every(Boolean);
    if (assets.length > 0 && assets.every((asset) => asset.thumbnail_ready && asset.preview_ready) && extraReady) return;
    if (Date.now() > deadline) {
      throw new Error(`Derivatives never became ready: ${JSON.stringify(assets.map((asset) => ({ id: asset.id, t: asset.thumbnail_ready, p: asset.preview_ready })))}`);
    }
    await sleep(500);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

// ===== Page phases =====

function rootIdsSource() {
  return `(async () => {
    ${PAGE_HELPERS}
    await waitFor(() => gallerySettled() && rootCardIds().length > 0, 'seeded gallery renders');
    return rootCardIds();
  })()`;
}

function relocatedGallerySource(before) {
  return `(async () => {
    const config = ${JSON.stringify({ rootIds: before.rootIds })};
    ${PAGE_HELPERS}
    await waitFor(() => gallerySettled() && rootCardIds().length === config.rootIds.length, 'relocated gallery renders the same card count');
    const rootIds = rootCardIds();
    await waitFor(() => [...document.querySelectorAll('#assetGrid .asset-card img')]
      .every((img) => img.complete && img.naturalWidth > 0), 'every relocated card thumbnail decodes');
    const images = [...document.querySelectorAll('#assetGrid .asset-card img')].map((img) => ({
      src: img.getAttribute('src'),
      loaded: img.complete && img.naturalWidth > 0,
    }));
    return { rootIds, images, rendererErrors: rendererErrors.slice(0, 3) };
  })()`;
}

function assertRelocatedGallery(result, before) {
  expect(Array.isArray(result?.rootIds), `Relocated gallery page returned nothing: ${JSON.stringify(result)}`);
  expect(JSON.stringify(result.rootIds.slice().sort()) === JSON.stringify(before.rootIds.slice().sort()),
    `Gallery card set changed across relocation: ${JSON.stringify({ before: before.rootIds, after: result.rootIds })}`);
  expect(result.images.length > 0, "Relocated gallery rendered no card images");
  expect(result.images.every((image) => image.loaded), `Some card images failed to decode: ${JSON.stringify(result.images.filter((image) => !image.loaded))}`);
  expect(JSON.stringify(result.rendererErrors || []) === "[]", `Renderer errors after relocation: ${JSON.stringify(result.rendererErrors)}`);
}

// ===== Post-relocation API assertions =====

async function assertRelocatedData(ctx, origin, before, { oldLibraryDir, nextLibraryDir }) {
  const api = (method, path, body) => ctx.api(origin, method, path, body);
  const listing = await api("GET", "/api/assets?project=default&limit=250");
  const trashListing = await api("GET", "/api/assets?project=default&limit=250&trash=1");
  const assets = [...(listing.assets || []), ...(trashListing.assets || [])];
  expect(assets.length === before.listedIds.length + before.trashIds.length,
    `Asset count changed across relocation: ${assets.length} vs ${before.listedIds.length + before.trashIds.length}`);

  const problems = [];
  for (const asset of assets) {
    for (const [label, value] of [["image_path", asset.image_path], ["thumbnail_path", asset.thumbnail_path], ["preview_path", asset.preview_path], ["medium_path", asset.medium_path]]) {
      if (!value) continue;
      if (!resolve(value).startsWith(resolve(nextLibraryDir))) problems.push(`${asset.id} ${label} outside the new library: ${value}`);
      if (resolve(value).startsWith(resolve(oldLibraryDir))) problems.push(`${asset.id} ${label} still in the old library: ${value}`);
    }
  }
  if (problems.length) throw new Error(`Managed paths were not fully rebased:\n${problems.join("\n")}`);

  // The bytes behind every managed URL must still be served from the new tree.
  for (const asset of assets) {
    for (const [label, url, ready] of [["original", asset.image_url, true], ["thumbnail", asset.thumbnail_url, asset.thumbnail_ready], ["preview", asset.preview_url, asset.preview_ready]]) {
      if (!ready) continue;
      const response = await fetch(`${origin}${url}`);
      const body = await response.arrayBuffer();
      expect(response.status === 200 && body.byteLength > 0,
        `${label} of ${asset.id} did not load from the new library (${response.status}, ${body.byteLength} bytes): ${url}`);
    }
  }

  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  // Tags come back name-sorted (ORDER BY name COLLATE NOCASE), so compare sets.
  expect(JSON.stringify((byId.get(before.tagged)?.tags || []).slice().sort()) === JSON.stringify(before.tags.slice().sort()),
    `Tags missing after relocation: ${JSON.stringify(byId.get(before.tagged))}`);
  expect(byId.get(before.favorite)?.favorite === true, `Favorite flag lost for ${before.favorite}`);
  expect(byId.get(before.grouped)?.group === before.groupName, `Group membership lost for ${before.grouped}`);
  expect(byId.get(before.trashIds[0]) !== undefined, `Trashed asset left the trash during relocation`);

  const groups = await api("GET", "/api/groups?project=default");
  const groupList = Array.isArray(groups?.groups) ? groups.groups : groups?.groups?.groups || [];
  const group = groupList.find((entry) => (Array.isArray(entry) ? entry[0] : entry.name) === before.groupName);
  expect((Array.isArray(group) ? group[1] : group?.count) === before.groupCount, `Group count changed across relocation: ${JSON.stringify(group)}`);

  const stack = await api("GET", `/api/asset-stacks/${encodeURIComponent(before.stackId)}?project=default`);
  expect(stack?.stack?.count === before.stackCount && stack?.stack?.cover_asset_id === before.stackCover,
    `Stack survived relocation but changed: ${JSON.stringify(stack?.stack)}`);

  const versionHistory = await api("GET", `/api/assets/default/${encodeURIComponent(before.versionIds[0])}/versions`);
  expect(JSON.stringify((versionHistory?.history?.versions || []).map((version) => version.id)) === JSON.stringify(before.versionIds),
    `Version chain changed across relocation: ${JSON.stringify(versionHistory?.history?.versions)}`);

  const favorites = await api("GET", "/api/assets?project=default&limit=250&favorite=1");
  expect((favorites.assets || []).some((asset) => asset.id === before.favorite), "Favorites filter lost the favorited asset after relocation");
}

// ===== Negative validations: nothing may be touched on rejection =====

async function assertValidationRejects(currentLibraryDir) {
  const entriesBefore = (await readdir(currentLibraryDir)).sort();

  const occupiedDir = join(dirname(currentLibraryDir), "relocation-negative-occupied");
  await mkdir(occupiedDir, { recursive: true });
  await writeFile(join(occupiedDir, "marker.txt"), "occupied");
  const occupied = await validateRelocationTarget({ currentLibraryDir, nextLibraryDir: occupiedDir });
  expect(occupied.ok === false && occupied.reason === "not-empty", `Occupied target was not rejected as not-empty: ${JSON.stringify(occupied)}`);
  expect((await readdir(occupiedDir)).join(",") === "marker.txt", "The occupied target was modified by a rejected validation");

  const nested = await validateRelocationTarget({
    currentLibraryDir,
    nextLibraryDir: join(currentLibraryDir, "nested-probe"),
  });
  expect(nested.ok === false && nested.reason === "invalid", `Nested target was not rejected as invalid: ${JSON.stringify(nested)}`);

  const entriesAfter = (await readdir(currentLibraryDir)).sort();
  expect(JSON.stringify(entriesAfter) === JSON.stringify(entriesBefore),
    `Rejected validations modified the library: ${JSON.stringify({ entriesBefore, entriesAfter })}`);
}
