import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SAVED_FILTERS,
  captureSavedFilterSnapshot,
  normalizeSavedFilterSnapshot,
  parseSavedFilters,
  savedFilterSnapshotEquals,
  savedFilterStorageKey,
  upsertSavedFilter,
} from "../app/saved-filters.mjs";

test("saved filters normalize only supported gallery semantics", () => {
  assert.deepEqual(normalizeSavedFilterSnapshot({
    query: "poster",
    scope: "favorite",
    mediaKind: "video",
    sort: "name",
    facets: { source: "web-chatgpt", group: "Launch", category: "Poster", unknown: "ignored" },
  }), {
    query: "poster",
    scope: "favorite",
    mediaKind: "video",
    sort: "name",
    facets: {
      source: "web-chatgpt",
      group: "Launch",
      category: "Poster",
      style: "",
      conversation: "",
      generationBatch: "",
    },
  });
  assert.equal(normalizeSavedFilterSnapshot({ scope: "bogus", mediaKind: "audio", sort: "random" }).scope, "all");
});

test("saved filter storage is isolated by project", () => {
  assert.notEqual(savedFilterStorageKey("project-a"), savedFilterStorageKey("project-b"));
  assert.match(savedFilterStorageKey("project / a"), /^mosa\.saved-filters\.v1\./);
});

test("same-name saves update one preset and move it to the front", () => {
  const first = upsertSavedFilter([], {
    id: "one",
    name: "Launch posters",
    snapshot: captureSavedFilterSnapshot({ query: "poster", scope: "all", mediaKind: "all", sort: "newest", facets: {} }),
    now: "2026-09-18T01:00:00.000Z",
  });
  const second = upsertSavedFilter([
    { id: "two", name: "Other", snapshot: {} },
    ...first.entries,
  ], {
    id: "ignored",
    name: " launch   posters ",
    snapshot: { query: "poster final", scope: "favorite", mediaKind: "image", sort: "name", facets: {} },
    now: "2026-09-18T02:00:00.000Z",
  });
  assert.equal(second.updated, true);
  assert.equal(second.entries.length, 2);
  assert.equal(second.entries[0].id, "one");
  assert.equal(second.entries[0].snapshot.query, "poster final");
});

test("parser rejects malformed rows, deduplicates ids, and enforces the bounded preference list", () => {
  const input = Array.from({ length: MAX_SAVED_FILTERS + 5 }, (_, index) => ({
    id: `id-${index}`,
    name: `Filter ${index}`,
    snapshot: { query: String(index) },
  }));
  input.splice(2, 0, { id: "id-1", name: "duplicate id", snapshot: {} });
  input.splice(3, 0, { id: "", name: "missing id", snapshot: {} });
  const parsed = parseSavedFilters(JSON.stringify(input));
  assert.equal(parsed.length, MAX_SAVED_FILTERS);
  assert.equal(new Set(parsed.map((entry) => entry.id)).size, parsed.length);
});

test("snapshot equality ignores unsupported extra fields", () => {
  assert.equal(savedFilterSnapshotEquals(
    { query: "x", scope: "all", mediaKind: "all", sort: "newest", facets: {}, transient: true },
    { query: "x", scope: "all", mediaKind: "all", sort: "newest", facets: {} },
  ), true);
});
