/**
 * Search-scope whitelist: the single authority for which metadata values may
 * enter asset search. Everything a user can see and would think to search for
 * is listed below; every other source/business_fields value (paths, hashes,
 * capture internals, ids, mime types, sizes, timestamps, …) stays out of
 * search, and any key added in the future defaults to out until it is added
 * here. Consumers: sqlite-asset-store.mjs (search_text assembly, the two
 * scoring columns, the SQL backfill functions), asset-search.mjs (in-memory
 * scoring for the JSON store) and repair-capture-history.mjs — the three must
 * never disagree.
 */

import { canonicalSourceTypeOf } from "./generation-session.mjs";

export const SEARCH_SCOPE_MARKER_KEY = "search_scope_v2";

// Prompt-like text the Inspector shows (instruction, request prompt, user /
// negative prompt) plus the provider and model names. The web app reads the
// same keys from either bag (source first, business_fields as the fallback),
// so both lists carry them.
export const SOURCE_SEARCHABLE_KEYS = Object.freeze([
  "user_message",
  "generation_request_prompt",
  "user_prompt",
  "negative_prompt",
  "provider",
  "model",
]);

export const BUSINESS_FIELD_SEARCHABLE_KEYS = Object.freeze([
  "user_message",
  "user_prompt",
  "negative_prompt",
  "provider",
  "model",
]);

// Searchable display name per canonical source type (lib/generation-session.mjs
// classifies; local-file and unknown types contribute no name). Derived from
// the already-normalized source type, never from raw source strings.
const SOURCE_TYPE_SEARCH_NAMES = Object.freeze({
  "web-chatgpt": "ChatGPT",
  "web-gemini": "Gemini",
  "web-flow": "Flow",
  "web-google-ai-studio": "Google AI Studio",
  "codex-generated": "Codex",
  "grok-generated": "Grok",
  "cowart-generated": "Cowart",
});

export function sourceSearchDisplayName(sourceGroup) {
  return SOURCE_TYPE_SEARCH_NAMES[sourceGroup] || "";
}

function searchableValues(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return keys.flatMap((key) => {
    const item = value[key];
    if (item == null) return [];
    if (Array.isArray(item)) {
      return item.filter((entry) => typeof entry === "string" || typeof entry === "number").map(String);
    }
    if (typeof item === "string" || typeof item === "number") return [String(item)];
    return [];
  });
}

export function searchableSourceValues(source, sourceGroup) {
  const values = searchableValues(source, SOURCE_SEARCHABLE_KEYS);
  const display = sourceSearchDisplayName(sourceGroup);
  if (display) values.push(display);
  return values;
}

export function searchableBusinessFieldValues(businessFields) {
  return searchableValues(businessFields, BUSINESS_FIELD_SEARCHABLE_KEYS);
}

// Same separator the store historically used between object values, so an
// exact phrase still cannot span two values inside one scoring column.
const SEARCH_VALUE_SEPARATOR = "\u001f";

export function searchableSourceObjectText(source, sourceGroup) {
  return searchableSourceValues(source, sourceGroup).join(SEARCH_VALUE_SEPARATOR);
}

export function searchableBusinessObjectText(businessFields) {
  return searchableBusinessFieldValues(businessFields).join(SEARCH_VALUE_SEPARATOR);
}

function parseJsonObject(value) {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * One-time rebuild for libraries written before this whitelist: their
 * search_text, asset_fts and asset_short_terms rows still carry the old
 * match-everything text. Rewrites the three search columns and re-syncs the
 * two indexes for every asset (trash rows included in the column rewrite; the
 * injected syncAssetFtsEntry keeps the trash invariant — delete only), without
 * touching updated_at and without emitting library changes, so no client sees
 * "asset changed".
 *
 * Marker and data share one BEGIN IMMEDIATE transaction: a failure rolls both
 * back and the next open retries; the caller's catch must never write the
 * marker. The marker is re-checked inside the write lock, so two processes
 * opening the same library can never both run the rebuild — the loser only
 * acquires the lock after the winner committed and then sees the marker.
 */
export function rebuildSearchScopeTexts(database, helpers = {}) {
  const { loadMetadata, searchableText, syncAssetFtsEntry, replaceAssetShortTerms } = helpers;
  if (typeof loadMetadata !== "function" || typeof searchableText !== "function") {
    throw new Error("rebuildSearchScopeTexts requires loadMetadata and searchableText helpers");
  }
  const stats = { assetsRebuilt: 0, assetsUnchanged: 0 };
  // Cheap read first: once the marker exists, an open must not take the write
  // lock just to find that out (it would queue behind, or fail BUSY against,
  // an MCP/CLI writer on every single open). The check inside the transaction
  // below stays the authority for the race between two first opens.
  const markerQuery = database.prepare("SELECT 1 FROM library_meta WHERE key = ?");
  if (markerQuery.get(SEARCH_SCOPE_MARKER_KEY)) return stats;
  const timestamp = new Date().toISOString();
  database.transaction(() => {
    const alreadyDone = markerQuery.get(SEARCH_SCOPE_MARKER_KEY);
    if (alreadyDone) return;
    const rows = database.prepare("SELECT * FROM assets").all();
    const update = database.prepare(`
      UPDATE assets SET search_text = ?, source_search_text = ?, business_search_text = ?
      WHERE project_id = ? AND id = ?
    `);
    for (const row of rows) {
      const metadata = loadMetadata(row);
      const searchText = searchableText(metadata);
      const sourceSearchText = searchableSourceObjectText(
        parseJsonObject(row.source_json),
        canonicalSourceTypeOf(metadata),
      );
      const businessSearchText = searchableBusinessObjectText(parseJsonObject(row.business_fields_json));
      if (
        searchText === (row.search_text || "") &&
        sourceSearchText === (row.source_search_text || "") &&
        businessSearchText === (row.business_search_text || "")
      ) {
        stats.assetsUnchanged += 1;
        continue;
      }
      update.run(searchText, sourceSearchText, businessSearchText, row.project_id, row.id);
      syncAssetFtsEntry(row.project_id, row.id, searchText, row.deleted_at);
      replaceAssetShortTerms(row.project_id, row.id, searchText);
      stats.assetsRebuilt += 1;
    }
    database.prepare(`
      INSERT INTO library_meta (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(SEARCH_SCOPE_MARKER_KEY, timestamp, timestamp);
  }).immediate();
  return stats;
}
