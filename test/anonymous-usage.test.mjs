import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ANONYMOUS_USAGE_INTERVAL_MS,
  ANONYMOUS_USAGE_PROFILE_FILE,
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
    installationId: FIXED_ID,
    platform: "macos",
    arch: "arm64",
    version: "0.2.0",
  });
  assert.equal(prepared.commit(), true);

  const profile = JSON.parse(readFileSync(join(userDataDir, ANONYMOUS_USAGE_PROFILE_FILE), "utf8"));
  assert.equal(profile.installationId, FIXED_ID);
  assert.equal(profile.firstReportedAt, now);
  assert.equal(profile.lastReportedAt, now);

  const sameDay = prepareAnonymousUsage({ userDataDir, now: now + 60_000, currentVersion: "0.2.0" });
  assert.equal(sameDay.telemetry, null, "manual update checks must not multiply daily-active pings");
});

test("anonymous usage reports daily activity after 24 hours and can be disabled", () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "mosa-usage-"));
  const now = Date.parse("2026-08-28T12:00:00Z");
  const first = prepareAnonymousUsage({ userDataDir, now, currentVersion: "0.2.0", makeInstallationId: () => FIXED_ID });
  first.commit();

  const next = prepareAnonymousUsage({
    userDataDir,
    now: now + ANONYMOUS_USAGE_INTERVAL_MS,
    platform: "win32",
    arch: "x64",
    currentVersion: "0.2.1",
  });
  assert.equal(next.telemetry.event, "daily_active");
  assert.equal(next.telemetry.installationId, FIXED_ID);
  assert.equal(next.telemetry.platform, "windows");
  assert.equal(next.telemetry.version, "0.2.1");

  const disabled = prepareAnonymousUsage({ userDataDir, enabled: false, now: now + ANONYMOUS_USAGE_INTERVAL_MS * 2 });
  assert.equal(disabled.telemetry, null);
});
