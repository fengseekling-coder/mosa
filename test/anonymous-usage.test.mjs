import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ANONYMOUS_USAGE_PROFILE_SCHEMA_VERSION,
  ANONYMOUS_USAGE_PROFILE_FILE,
  ANONYMOUS_USAGE_TELEMETRY_VERSION,
  prepareAnonymousUsage,
} from "../desktop/anonymous-usage.mjs";

const FIXED_ID = "123e4567-e89b-42d3-a456-426614174000";

test("anonymous usage creates one random install id and reports first launch once", () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "mosa-usage-"));
  const now = Date.parse("2026-08-28T12:00:00Z");
  const prepared = prepareAnonymousUsage({
    userDataDir,
    now,
    platform: "darwin",
    arch: "arm64",
    currentVersion: "0.2.0",
    makeInstallationId: () => FIXED_ID,
  });

  assert.deepEqual(prepared.telemetry, {
    event: "first_launch",
    telemetryVersion: ANONYMOUS_USAGE_TELEMETRY_VERSION,
    installationId: FIXED_ID,
    platform: "macos",
    arch: "arm64",
    version: "0.2.0",
  });
  assert.equal(prepared.commit(), true);

  const profile = JSON.parse(readFileSync(join(userDataDir, ANONYMOUS_USAGE_PROFILE_FILE), "utf8"));
  assert.equal(profile.installationId, FIXED_ID);
  assert.equal(profile.schemaVersion, ANONYMOUS_USAGE_PROFILE_SCHEMA_VERSION);
  assert.equal(profile.firstReportedAt, now);
  assert.equal(profile.lastReportedAt, now);
  assert.equal(profile.lastReportedDay, "2026-08-28");

  const sameDay = prepareAnonymousUsage({ userDataDir, now: now + 60_000, currentVersion: "0.2.0" });
  assert.equal(sameDay.telemetry, null, "manual update checks must not multiply daily-active pings");
});

test("anonymous usage reports once per analytics day and can be disabled", () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "mosa-usage-"));
  const now = Date.parse("2026-08-28T06:55:00Z");
  const first = prepareAnonymousUsage({ userDataDir, now, currentVersion: "0.2.0", makeInstallationId: () => FIXED_ID });
  first.commit();

  const next = prepareAnonymousUsage({
    userDataDir,
    now: Date.parse("2026-08-28T07:05:00Z"),
    platform: "win32",
    arch: "x64",
    currentVersion: "0.2.1",
  });
  assert.equal(next.telemetry.event, "daily_active");
  assert.equal(next.telemetry.installationId, FIXED_ID);
  assert.equal(next.telemetry.platform, "windows");
  assert.equal(next.telemetry.version, "0.2.1");

  next.commit();
  const sameAnalyticsDay = prepareAnonymousUsage({ userDataDir, now: Date.parse("2026-08-29T06:59:00Z"), currentVersion: "0.2.1" });
  assert.equal(sameAnalyticsDay.telemetry, null);

  const disabled = prepareAnonymousUsage({ userDataDir, enabled: false, now: Date.parse("2026-08-29T07:05:00Z") });
  assert.equal(disabled.telemetry, null);
});
