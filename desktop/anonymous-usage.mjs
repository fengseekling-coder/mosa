import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ANONYMOUS_USAGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const ANONYMOUS_USAGE_PROFILE_FILE = "anonymous-usage.json";

const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function profilePath(userDataDir) {
  return join(userDataDir, ANONYMOUS_USAGE_PROFILE_FILE);
}

function readProfile(path) {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (!INSTALLATION_ID_PATTERN.test(String(parsed.installationId || ""))) return null;
    return {
      installationId: String(parsed.installationId),
      firstReportedAt: Number(parsed.firstReportedAt) || 0,
      lastReportedAt: Number(parsed.lastReportedAt) || 0,
    };
  } catch {
    return null;
  }
}

function writeProfile(path, profile) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return true;
  } catch {
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
  makeInstallationId = randomUUID,
} = {}) {
  if (!enabled || !userDataDir) return { telemetry: null, commit: () => false };

  const path = profilePath(userDataDir);
  let profile = readProfile(path);
  if (!profile) {
    const installationId = String(makeInstallationId());
    if (!INSTALLATION_ID_PATTERN.test(installationId)) return { telemetry: null, commit: () => false };
    profile = { installationId, firstReportedAt: 0, lastReportedAt: 0 };
    // Persist before the network request so an offline retry keeps the same
    // anonymous installation identifier instead of creating a new one.
    if (!writeProfile(path, profile)) return { telemetry: null, commit: () => false };
  }

  if (profile.lastReportedAt > 0 && now - profile.lastReportedAt < ANONYMOUS_USAGE_INTERVAL_MS) {
    return { telemetry: null, commit: () => false };
  }

  const telemetry = Object.freeze({
    event: profile.firstReportedAt > 0 ? "daily_active" : "first_launch",
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
        firstReportedAt: profile.firstReportedAt || reportedAt,
        lastReportedAt: reportedAt,
      };
      committed = writeProfile(path, nextProfile);
      return committed;
    },
  };
}
