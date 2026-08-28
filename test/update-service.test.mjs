import assert from "node:assert/strict";
import test from "node:test";

import {
  MOSA_DOWNLOAD_PAGE_URL,
  MOSA_UPDATE_FEED_URL,
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

test("update check compares the fixed HTTPS feed against the installed version", async () => {
  let request = null;
  const result = await checkForMosaUpdate({
    currentVersion: "0.2.0",
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

  assert.equal(request.url, MOSA_UPDATE_FEED_URL);
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
