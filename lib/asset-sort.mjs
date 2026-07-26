/**
 * Canonical gallery sort orders shared by the HTTP API and both asset stores.
 *
 * Sorting has to be resolved by the store, not the client: the gallery pages
 * 100 assets at a time, so re-ordering an already-loaded page would silently
 * present a partial ordering as if it covered the whole library.
 */
export const ASSET_SORTS = ["newest", "oldest", "name"];
export const DEFAULT_ASSET_SORT = "newest";

export function normalizeAssetSort(value) {
  const sort = String(value || "").trim().toLowerCase();
  return ASSET_SORTS.includes(sort) ? sort : DEFAULT_ASSET_SORT;
}

/**
 * The gallery labels a card with its theme and falls back to the stored file
 * name, so a name sort has to key on the same string the reader actually sees.
 */
export function assetSortName(asset = {}) {
  return String(asset.theme || asset.asset || asset.id || "").trim().toLocaleLowerCase();
}

/** Comparator matching the SQLite ORDER BY for a given sort. */
export function compareAssets(sort, left, right) {
  const order = normalizeAssetSort(sort);
  if (order === "name") {
    return assetSortName(left).localeCompare(assetSortName(right))
      || String(left.id || "").localeCompare(String(right.id || ""));
  }
  const direction = order === "oldest" ? 1 : -1;
  return direction * (String(left.created_at || "").localeCompare(String(right.created_at || ""))
    || String(left.id || "").localeCompare(String(right.id || "")));
}
