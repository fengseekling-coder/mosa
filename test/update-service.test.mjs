import assert from "node:assert/strict";
import test from "node:test";

import {
  MOSA_DOWNLOAD_PAGE_URL,
  MOSA_UPDATE_FEED_URL,
  buildUpdateFeedUrl,
  checkForMosaUpdate,
  compareVersions,
  parseUpdateManifest,
} from "../desktop/update-service.mjs";

test("version comparison follows semver ordering for MOSA releases", () => {
  assert.equal(compareVersions("0.2.1", "0.2.0"), 1);
  assert.equal(compareVersions("v0.2.0", "0.2.0"), 0);
  assert.equal(compareVersions("0.2.0-beta.2", "0.2.0-beta.10"), -1);
  assert.equal(compareVersions("0.2.0", "0.2.0-beta.10"), 1);
  assert.throws(() => compareVersions("latest", "0.2.0"), /Invalid MOSA version/);
});

test("update manifest keeps only bounded release metadata", () => {
  assert.deepEqual(parseUpdateManifest({
    version: "v0.3.0",
    publishedAt: "2026-09-01T10:00:00Z",
    notes: { zh: " 新版 ", en: " New release " },
    url: "https://evil.example/download",
  }), {
    version: "0.3.0",
    publishedAt: "2026-09-01T10:00:00Z",
    notes: { zh: "新版", en: "New release" },
  });
  assert.equal(MOSA_UPDATE_FEED_URL, "https://mosa.azhuilab.com/releases/latest.json");
  assert.equal(MOSA_DOWNLOAD_PAGE_URL, "https://mosa.azhuilab.com/");
});

test("anonymous usage tagging keeps the update origin and path fixed", () => {
  const url = new URL(buildUpdateFeedUrl({
    event: "daily_active",
    installationId: "123e4567-e89b-42d3-a456-426614174000",
    platform: "macos",
    arch: "arm64",
    version: "0.2.0",
  }));
  assert.equal(`${url.origin}${url.pathname}`, MOSA_UPDATE_FEED_URL);
  assert.equal(url.searchParams.get("event"), "daily_active");
  assert.equal(url.searchParams.get("install_id"), "123e4567-e89b-42d3-a456-426614174000");
  assert.equal(url.searchParams.get("platform"), "macos");
  assert.equal(url.searchParams.get("arch"), "arm64");
  assert.equal(url.searchParams.get("version"), "0.2.0");
  assert.equal(buildUpdateFeedUrl({ event: "daily_active", installationId: "not-a-uuid" }), MOSA_UPDATE_FEED_URL);
});

test("update check compares the fixed HTTPS feed against the installed version", async () => {
  let request = null;
  const result = await checkForMosaUpdate({
    currentVersion: "0.2.0",
    anonymousUsage: {
      event: "first_launch",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      platform: "windows",
      arch: "x64",
      version: "0.2.0",
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          version: "0.2.1",
          publishedAt: "2026-09-01T10:00:00Z",
          notes: { zh: "修复问题", en: "Fixes" },
        }),
      };
    },
  });

  const requestUrl = new URL(request.url);
  assert.equal(`${requestUrl.origin}${requestUrl.pathname}`, MOSA_UPDATE_FEED_URL);
  assert.equal(requestUrl.searchParams.get("event"), "first_launch");
  assert.equal(requestUrl.searchParams.get("platform"), "windows");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.redirect, "error");
  assert.equal(result.currentVersion, "0.2.0");
  assert.equal(result.latestVersion, "0.2.1");
  assert.equal(result.updateAvailable, true);
});

test("same or older website versions never report an update", async () => {
  for (const version of ["0.2.0", "0.1.9"]) {
    const result = await checkForMosaUpdate({
      currentVersion: "0.2.0",
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ version }) }),
    });
    assert.equal(result.updateAvailable, false, version);
  }
});
