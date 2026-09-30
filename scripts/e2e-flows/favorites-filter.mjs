// Reference pluggable flow: seed through the API, drive the UI in the
// sandboxed renderer, assert on the returned result, then restart the server
// on the same library to prove persistence.

import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "favorites-filter";
export const description = "API-seeded favorite -> Favorites quick filter -> restart -> still filtered";

export async function run(ctx) {
  await ctx.prepare();
  let seeded;
  const first = await ctx.startServer();
  try {
    const plain = await ctx.api(first.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("plain.png", [74, 127, 181]), prompt: "favorites flow plain",
    });
    const starred = await ctx.api(first.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("starred.png", [181, 68, 74]), prompt: "favorites flow starred",
    });
    await ctx.api(first.origin, "POST", `/api/assets/default/${encodeURIComponent(starred.asset.id)}/favorite`);
    seeded = { plainId: plain.asset.id, starredId: starred.asset.id };
    assertFiltered(await ctx.runInPage(first, favoritesSource(seeded)), seeded, "before restart");
  } finally {
    await first.stop();
  }

  const second = await ctx.startServer();
  try {
    assertFiltered(await ctx.runInPage(second, favoritesSource(seeded)), seeded, "after restart");
  } finally {
    await second.stop();
  }
  return seeded;
}

function assertFiltered(result, { plainId, starredId }, phase) {
  if (JSON.stringify(result?.allIds?.slice().sort()) !== JSON.stringify([plainId, starredId].sort())
    || JSON.stringify(result?.favoriteIds) !== JSON.stringify([starredId])) {
    throw new Error(`Favorites filter ${phase}: ${JSON.stringify(result)}`);
  }
}

function favoritesSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    await waitFor(() => gallerySettled() && rootCardIds().length === 2, 'two seeded cards');
    const allIds = rootCardIds();
    click('#quickFilters .nav-item[data-filter="favorite"]');
    await waitFor(() => gallerySettled() && rootCardIds().length === 1, 'favorites filter applied');
    return { allIds, favoriteIds: rootCardIds() };
  })()`;
}
