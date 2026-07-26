import assert from "node:assert/strict";
import test from "node:test";
import {
  RECENT_CUTOFF_BUCKET_MS,
  RECENT_WINDOW_MS,
  createdAtTimestamp,
  isRecentCreatedAt,
  normalizeCreatedAt,
  recentCutoffTimestamp,
} from "../lib/recent-window.mjs";

test("recentCutoffTimestamp quantises the cutoff so independent readers agree", () => {
  assert.equal(RECENT_WINDOW_MS, 7 * 24 * 60 * 60 * 1000);

  const now = Date.parse("2026-07-26T12:34:56.789Z");
  const cutoff = recentCutoffTimestamp(now);
  assert.equal(cutoff % RECENT_CUTOFF_BUCKET_MS, 0, "cutoffs are aligned to whole buckets");
  assert.equal(cutoff, Date.parse("2026-07-19T12:34:00.000Z"));

  // Two readers a few milliseconds apart — the recent list and the recent counter, or the JSON
  // and SQLite stores side by side — must derive the identical cutoff.
  assert.equal(recentCutoffTimestamp(now + 1), cutoff);
  assert.equal(recentCutoffTimestamp(now + 999), cutoff);
  assert.equal(recentCutoffTimestamp(now + RECENT_CUTOFF_BUCKET_MS), cutoff + RECENT_CUTOFF_BUCKET_MS);

  // The window never shrinks below seven days and never widens by more than one bucket.
  assert.ok(cutoff <= now - RECENT_WINDOW_MS);
  assert.ok(cutoff > now - RECENT_WINDOW_MS - RECENT_CUTOFF_BUCKET_MS);
});

test("createdAtTimestamp accepts every format ECMA-262 guarantees and rejects unusable values", () => {
  const reference = new Date("2026-07-26T12:34:56.789Z");
  assert.equal(createdAtTimestamp(reference.toISOString()), reference.getTime());
  assert.equal(createdAtTimestamp(`+00${reference.toISOString()}`), reference.getTime(), "expanded-year ISO");
  assert.equal(createdAtTimestamp(reference.toUTCString()), reference.getTime() - 789, "RFC 1123 has second resolution");
  assert.equal(createdAtTimestamp(reference.toString()), reference.getTime() - 789, "Date.prototype.toString output");
  assert.equal(createdAtTimestamp("Sat, 01 Jan 2000 00:00:00 GMT"), Date.parse("2000-01-01T00:00:00.000Z"));

  for (const unusable of [null, undefined, "", "   ", "not-a-real-date", 1785069009602, {}, [], NaN, true]) {
    assert.equal(createdAtTimestamp(unusable), null, `${JSON.stringify(unusable) ?? String(unusable)} must be unusable`);
  }
});

test("isRecentCreatedAt compares instants, including exactly on the boundary", () => {
  const cutoff = Date.parse("2026-07-19T12:34:00.000Z");
  assert.equal(isRecentCreatedAt(new Date(cutoff).toISOString(), cutoff), true, "the cutoff itself is inside the window");
  assert.equal(isRecentCreatedAt(new Date(cutoff - 1).toISOString(), cutoff), false, "one millisecond earlier is outside");
  assert.equal(isRecentCreatedAt(new Date(cutoff + 1).toISOString(), cutoff), true);

  // Values whose lexicographic order contradicts their instant, in both directions.
  assert.equal(isRecentCreatedAt("Sat, 01 Jan 2000 00:00:00 GMT", cutoff), false, "old RFC date sorts high but is ancient");
  assert.equal(isRecentCreatedAt(`+00${new Date(cutoff + 1000).toISOString()}`, cutoff), true, "expanded-year ISO sorts low but is recent");

  for (const unusable of [null, undefined, "", "not-a-real-date"]) {
    assert.equal(isRecentCreatedAt(unusable, cutoff), false);
  }
});

test("normalizeCreatedAt canonicalises parseable values and preserves the rest", () => {
  const reference = new Date("2026-07-26T12:34:56.789Z");
  const iso = reference.toISOString();
  assert.equal(normalizeCreatedAt(iso, "fallback"), iso, "canonical ISO round-trips unchanged");
  assert.equal(normalizeCreatedAt(`+00${iso}`, "fallback"), iso);
  assert.equal(normalizeCreatedAt("Sat, 01 Jan 2000 00:00:00 GMT", "fallback"), "2000-01-01T00:00:00.000Z");
  assert.equal(normalizeCreatedAt("2026-07-26T05:34:56.789-07:00", "fallback"), iso, "offsets are converted to UTC");

  // Unparseable text is kept verbatim: normalising must never destroy data it cannot understand.
  assert.equal(normalizeCreatedAt("not-a-real-date", "fallback"), "not-a-real-date");

  // Blank or missing values fall back to the caller's timestamp.
  for (const blank of [null, undefined, "", "   ", 0, {}]) {
    assert.equal(normalizeCreatedAt(blank, "fallback"), "fallback");
  }
});
