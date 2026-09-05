import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ANONYMOUS_USAGE_PROFILE_FILE = "anonymous-usage.json";
export const ANONYMOUS_USAGE_PROFILE_SCHEMA_VERSION = 2;
export const ANONYMOUS_USAGE_TELEMETRY_VERSION = 2;
export const ANONYMOUS_USAGE_ANALYTICS_TIME_ZONE = "America/Los_Angeles";

const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function profilePath(userDataDir) {
  return join(userDataDir, ANONYMOUS_USAGE_PROFILE_FILE);
}

function analyticsDayKey(timestamp, timeZone = ANONYMOUS_USAGE_ANALYTICS_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function readProfile(path) {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (!INSTALLATION_ID_PATTERN.test(String(parsed.installationId || ""))) return null;
    const schemaVersion = Number(parsed.schemaVersion) || 1;
    return {
      schemaVersion: ANONYMOUS_USAGE_PROFILE_SCHEMA_VERSION,
      installationId: String(parsed.installationId),
      firstReportedAt: Number(parsed.firstReportedAt) || 0,
      lastReportedAt: Number(parsed.lastReportedAt) || 0,
      // Legacy profiles used a rolling 24-hour throttle. Do not infer a day
      // from that timestamp: forcing one v2 report on upgrade cleanly moves the
      // existing stable UUID into the calendar-day protocol without minting a
      // second installation identity.
      lastReportedDay: schemaVersion >= ANONYMOUS_USAGE_PROFILE_SCHEMA_VERSION
        ? String(parsed.lastReportedDay || "")
        : "",
    };
  } catch {
    return null;
  }
}

function writeProfile(path, profile) {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporaryPath, `${JSON.stringify(profile, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
    return true;
  } catch {
    try { rmSync(temporaryPath, { force: true }); } catch {}
    return false;
  }
}

function normalizedPlatform(platform) {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "other";
}

export function prepareAnonymousUsage({
  userDataDir,
  enabled = true,
  platform = process.platform,
  arch = process.arch,
  currentVersion = "",
  now = Date.now(),
  analyticsTimeZone = ANONYMOUS_USAGE_ANALYTICS_TIME_ZONE,
  makeInstallationId = randomUUID,
} = {}) {
  if (!enabled || !userDataDir) return { telemetry: null, commit: () => false };

  const path = profilePath(userDataDir);
  let profile = readProfile(path);
  if (!profile) {
    const installationId = String(makeInstallationId());
    if (!INSTALLATION_ID_PATTERN.test(installationId)) return { telemetry: null, commit: () => false };
    profile = {
      schemaVersion: ANONYMOUS_USAGE_PROFILE_SCHEMA_VERSION,
      installationId,
      firstReportedAt: 0,
      lastReportedAt: 0,
      lastReportedDay: "",
    };
    // Persist before the network request so an offline retry keeps the same
    // anonymous installation identifier instead of creating a new one.
    if (!writeProfile(path, profile)) return { telemetry: null, commit: () => false };
  }

  const reportDay = analyticsDayKey(now, analyticsTimeZone);
  if (profile.firstReportedAt > 0 && profile.lastReportedDay === reportDay) {
    return { telemetry: null, commit: () => false };
  }

  const telemetry = Object.freeze({
    event: profile.firstReportedAt > 0 ? "daily_active" : "first_launch",
    telemetryVersion: ANONYMOUS_USAGE_TELEMETRY_VERSION,
    installationId: profile.installationId,
    platform: normalizedPlatform(platform),
    arch: String(arch || "unknown").slice(0, 24),
    version: String(currentVersion || "unknown").replace(/^v/i, "").slice(0, 48),
  });

  let committed = false;
  return {
    telemetry,
    commit() {
      if (committed) return true;
      const reportedAt = Number(now) || Date.now();
      const nextProfile = {
        ...profile,
        schemaVersion: ANONYMOUS_USAGE_PROFILE_SCHEMA_VERSION,
        firstReportedAt: profile.firstReportedAt || reportedAt,
        lastReportedAt: reportedAt,
        lastReportedDay: reportDay,
      };
      committed = writeProfile(path, nextProfile);
      return committed;
    },
  };
}
