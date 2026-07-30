export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const RECENT_CUTOFF_BUCKET_MS = 60_000;

export function recentCutoffTimestamp(now: number = Date.now()): number {
  return Math.floor((now - RECENT_WINDOW_MS) / RECENT_CUTOFF_BUCKET_MS) * RECENT_CUTOFF_BUCKET_MS;
}

export function createdAtTimestamp(createdAt: unknown): number | null {
  if (typeof createdAt !== "string" || !createdAt.trim()) return null;
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function isRecentCreatedAt(createdAt: unknown, cutoffTimestamp: number): boolean {
  const timestamp = createdAtTimestamp(createdAt);
  return timestamp !== null && timestamp >= cutoffTimestamp;
}

export function normalizeCreatedAt(createdAt: unknown, fallbackIso: string): string {
  const timestamp = createdAtTimestamp(createdAt);
  if (timestamp !== null) return new Date(timestamp).toISOString();
  if (typeof createdAt === "string" && createdAt.trim()) return createdAt;
  return fallbackIso;
}
