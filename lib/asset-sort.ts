export interface SortableAsset {
  id?: string;
  theme?: string;
  asset?: string;
  created_at?: string;
}

export const ASSET_SORTS: readonly string[] = ["newest", "oldest", "name"];
export const DEFAULT_ASSET_SORT = "newest";

export function normalizeAssetSort(value: unknown): string {
  const sort = String(value || "").trim().toLowerCase();
  return ASSET_SORTS.includes(sort) ? sort : DEFAULT_ASSET_SORT;
}

export function assetSortName(asset: SortableAsset = {}): string {
  return String(asset.theme || asset.asset || asset.id || "").trim().toLocaleLowerCase();
}

export function compareAssets(sort: string, left: SortableAsset, right: SortableAsset): number {
  const order = normalizeAssetSort(sort);
  if (order === "name") {
    return assetSortName(left).localeCompare(assetSortName(right))
      || String(left.id || "").localeCompare(String(right.id || ""));
  }
  const direction = order === "oldest" ? 1 : -1;
  return direction * (String(left.created_at || "").localeCompare(String(right.created_at || ""))
    || String(left.id || "").localeCompare(String(right.id || "")));
}
