// Reference pluggable flow: seed through the API, drive the UI in the
// sandboxed renderer, assert on the returned result, then restart the server
// on the same library to prove persistence.

import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "favorites-filter";
export const description = "API-seeded favorite -> card star click re-lights the open inspector -> Favorites quick filter -> restart -> still filtered";

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
    const panel = () => document.querySelector('#detailPanel');
    const detailOpen = () => panel()?.getAttribute('aria-hidden') === 'false';
    const detailFavButton = () => panel()?.querySelector('[data-action="toggle-favorite"]');
    await waitFor(() => gallerySettled() && rootCardIds().length === 2, 'two seeded cards');

    // Card star click while the same asset is open in the inspector: the
    // inspector's own favorite button must follow immediately (the local
    // toggle patches every visible favorite button for the shown asset, keyed
    // on the selection, not on state.detailAsset being populated).
    document.querySelector(cardSelector(config.plainId) + ' .asset-card-select').click();
    await waitFor(() => detailOpen(), 'inspector opens for the plain asset', 15000);
    document.querySelector(cardSelector(config.plainId) + ' .card-favorite').click();
    await waitFor(() => {
      const button = detailFavButton();
      return Boolean(button) && button.getAttribute('aria-pressed') === 'true' && button.classList.contains('is-fav');
    }, 'inspector star follows the card star click', 15000);
    // Toggle back from the inspector's own button (idempotent reset + covers
    // the inspector-originated path), then run the original filter assertions.
    detailFavButton().click();
    await waitFor(() => {
      const button = detailFavButton();
      return Boolean(button) && button.getAttribute('aria-pressed') === 'false' && !button.classList.contains('is-fav');
    }, 'inspector star clears via its own button', 15000);
    await waitFor(() => gallerySettled(), 'gallery settles after the toggle pair', 15000);

    const allIds = rootCardIds();
    click('#quickFilters .nav-item[data-filter="favorite"]');
    await waitFor(() => gallerySettled() && rootCardIds().length === 1, 'favorites filter applied');
    return { allIds, favoriteIds: rootCardIds() };
  })()`;
}
