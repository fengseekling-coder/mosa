import { FACET_KEYS, SCOPES, SORT_ORDERS } from "./config.mjs";

export const MAX_SAVED_FILTERS = 24;
const MEDIA_KINDS = new Set(["all", "image", "video"]);

export function savedFilterStorageKey(projectId) {
  return `mosa.saved-filters.v1.${encodeURIComponent(String(projectId || "default"))}`;
}

export function normalizeSavedFilterSnapshot(input = {}) {
  const facets = {};
  for (const key of FACET_KEYS) facets[key] = String(input?.facets?.[key] || "");
  const scope = SCOPES.includes(input?.scope) ? input.scope : "all";
  const mediaKind = MEDIA_KINDS.has(input?.mediaKind) ? input.mediaKind : "all";
  const sort = SORT_ORDERS.includes(input?.sort) ? input.sort : "newest";
  return {
    query: String(input?.query || ""),
    scope,
    mediaKind,
    sort,
    facets,
  };
}

export function captureSavedFilterSnapshot(state = {}) {
  return normalizeSavedFilterSnapshot(state);
}

export function parseSavedFilters(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw || "[]"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set();
  const result = [];
  for (const item of parsed) {
    const id = String(item?.id || "").trim();
    const name = String(item?.name || "").trim().replace(/\s+/gu, " ").slice(0, 80);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      name,
      createdAt: String(item?.createdAt || ""),
      updatedAt: String(item?.updatedAt || item?.createdAt || ""),
      snapshot: normalizeSavedFilterSnapshot(item?.snapshot),
    });
    if (result.length >= MAX_SAVED_FILTERS) break;
  }
  return result;
}

export function savedFilterSnapshotEquals(left, right) {
  return JSON.stringify(normalizeSavedFilterSnapshot(left)) === JSON.stringify(normalizeSavedFilterSnapshot(right));
}

export function upsertSavedFilter(entries, { id, name, snapshot, now = new Date().toISOString() } = {}) {
  const normalized = parseSavedFilters(JSON.stringify(entries || []));
  const cleanName = String(name || "").trim().replace(/\s+/gu, " ").slice(0, 80);
  if (!cleanName) throw new Error("SAVED_FILTER_NAME_REQUIRED");
  const existingIndex = normalized.findIndex((entry) => entry.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase());
  if (existingIndex >= 0) {
    const existing = normalized[existingIndex];
    const updated = {
      ...existing,
      name: cleanName,
      updatedAt: now,
      snapshot: normalizeSavedFilterSnapshot(snapshot),
    };
    normalized.splice(existingIndex, 1);
    return { entries: [updated, ...normalized].slice(0, MAX_SAVED_FILTERS), entry: updated, updated: true };
  }
  const entry = {
    id: String(id || "").trim(),
    name: cleanName,
    createdAt: now,
    updatedAt: now,
    snapshot: normalizeSavedFilterSnapshot(snapshot),
  };
  if (!entry.id) throw new Error("SAVED_FILTER_ID_REQUIRED");
  return { entries: [entry, ...normalized].slice(0, MAX_SAVED_FILTERS), entry, updated: false };
}
