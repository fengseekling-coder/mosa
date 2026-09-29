export function parseAssetTimeBound(value, { label = "Asset time filter" } = {}) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) {
    const error = new Error(`${label} must be a valid ISO-8601 date/time.`);
    error.statusCode = 400;
    error.code = "ASSET_TIME_FILTER_INVALID";
    error.expose = true;
    throw error;
  }
  return timestamp;
}

export function normalizeAssetTimeRange({ createdAfter, createdBefore } = {}) {
  const createdAfterMs = parseAssetTimeBound(createdAfter, { label: "createdAfter" });
  const createdBeforeMs = parseAssetTimeBound(createdBefore, { label: "createdBefore" });
  if (createdAfterMs != null && createdBeforeMs != null && createdAfterMs > createdBeforeMs) {
    const error = new Error("createdAfter must not be later than createdBefore.");
    error.statusCode = 400;
    error.code = "ASSET_TIME_RANGE_INVALID";
    error.expose = true;
    throw error;
  }
  return { createdAfterMs, createdBeforeMs };
}
