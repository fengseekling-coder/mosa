export const MOSA_UPDATE_FEED_URL = "https://mosa.azhuilab.com/releases/latest.json";
export const MOSA_DOWNLOAD_PAGE_URL = "https://mosa.azhuilab.com/";

const UPDATE_MANIFEST_MAX_BYTES = 16 * 1024;
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(value) {
  const match = VERSION_PATTERN.exec(String(value || "").trim());
  if (!match) return null;
  return {
    version: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${match[4] ? `-${match[4]}` : ""}`,
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(left, right) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) > Number(b) ? 1 : -1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

export function compareVersions(leftVersion, rightVersion) {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);
  if (!left || !right) throw new Error("Invalid MOSA version.");
  for (let index = 0; index < left.parts.length; index += 1) {
    if (left.parts[index] === right.parts[index]) continue;
    return left.parts[index] > right.parts[index] ? 1 : -1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function cleanNote(value) {
  return typeof value === "string" ? value.trim().slice(0, 1200) : "";
}

export function parseUpdateManifest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid update manifest.");
  const parsedVersion = parseVersion(input.version);
  if (!parsedVersion) throw new Error("Invalid update manifest version.");
  const publishedAt = typeof input.publishedAt === "string" && input.publishedAt.length <= 64
    ? input.publishedAt.trim()
    : "";
  const notes = typeof input.notes === "string"
    ? { zh: cleanNote(input.notes), en: cleanNote(input.notes) }
    : {
        zh: cleanNote(input.notes?.zh),
        en: cleanNote(input.notes?.en),
      };
  return {
    version: parsedVersion.version,
    publishedAt,
    notes,
  };
}

export async function checkForMosaUpdate({ currentVersion, fetchImpl = globalThis.fetch, timeoutMs = 8_000 } = {}) {
  const current = parseVersion(currentVersion);
  if (!current) throw new Error("Invalid current MOSA version.");
  if (typeof fetchImpl !== "function") throw new Error("Update fetch is unavailable.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetchImpl(MOSA_UPDATE_FEED_URL, {
      method: "GET",
      headers: {
        accept: "application/json",
        "cache-control": "no-cache",
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response?.ok) throw new Error(`Update feed returned HTTP ${response?.status || 0}.`);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > UPDATE_MANIFEST_MAX_BYTES) throw new Error("Update manifest is too large.");
    const release = parseUpdateManifest(JSON.parse(text));
    return {
      currentVersion: current.version,
      latestVersion: release.version,
      updateAvailable: compareVersions(release.version, current.version) > 0,
      publishedAt: release.publishedAt,
      notes: release.notes,
    };
  } finally {
    clearTimeout(timeout);
  }
}
