/**
 * Shared "recent" window semantics.
 *
 * Both asset stores answer the same two questions — "does this asset belong to the recent
 * filter?" and "how many recent assets are there?" — and they used to answer them with
 * independent lexicographic comparisons against an ISO cutoff string. Raw string comparison
 * misjudges legacy `created_at` values written in other formats: "Sat, 01 Jan 2000 00:00:00 GMT"
 * sorts above any ISO cutoff and slipped in, while "+002026-07-26T00:00:00.000Z" sorts below it
 * and dropped out. Every decision now goes through this module so the JSON store, the SQLite
 * store and their statistics counters cannot drift apart again.
 */

export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Cutoffs are quantised to whole minutes. The gallery asks for the recent list and the recent
 * count in two separate requests, and a library can be served by either store, so an unrounded
 * `Date.now()` would let independent readers land on cutoffs milliseconds apart and disagree
 * about an asset sitting on the boundary. A minute of slack in a seven-day window is harmless.
 */
export const RECENT_CUTOFF_BUCKET_MS = 60_000;

export function recentCutoffTimestamp(now = Date.now()) {
  return Math.floor((now - RECENT_WINDOW_MS) / RECENT_CUTOFF_BUCKET_MS) * RECENT_CUTOFF_BUCKET_MS;
}

/**
 * Numeric timestamp for a stored `created_at`, or null when the value cannot be used: absent,
 * null, non-string, blank, or unparseable.
 *
 * ECMA-262 requires `Date.parse` to accept the Date Time String Format (including expanded years
 * such as "+002026-07-26T00:00:00.000Z") plus whatever `Date.prototype.toString` and `toUTCString`
 * produce. Anything else — "07/26/2026", for instance — falls through to engine-specific
 * heuristics, so such values are best effort: if a future runtime stops parsing them they become
 * "not recent" rather than silently misplaced.
 */
export function createdAtTimestamp(createdAt) {
  if (typeof createdAt !== "string" || !createdAt.trim()) return null;
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function isRecentCreatedAt(createdAt, cutoffTimestamp) {
  const timestamp = createdAtTimestamp(createdAt);
  return timestamp !== null && timestamp >= cutoffTimestamp;
}

/**
 * Canonical form for a `created_at` about to be written. Parseable values become ISO 8601 in UTC
 * so newly written and freshly edited rows can never reintroduce a format whose lexicographic
 * order disagrees with its instant — which is what sorting and cursor pagination still rely on.
 * Values that cannot be parsed are preserved verbatim rather than discarded, and blank or missing
 * values fall back to the caller's timestamp.
 */
export function normalizeCreatedAt(createdAt, fallbackIso) {
  const timestamp = createdAtTimestamp(createdAt);
  if (timestamp !== null) return new Date(timestamp).toISOString();
  if (typeof createdAt === "string" && createdAt.trim()) return createdAt;
  return fallbackIso;
}
