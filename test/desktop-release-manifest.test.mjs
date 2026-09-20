import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseUpdateManifest } from "../desktop/update-service.mjs";
import { createReleaseManifestTrust, verifyReleaseManifestSignature } from "../lib/release-manifest-signature.mjs";
import { prepareDesktopReleaseManifest } from "../scripts/prepare-desktop-release-manifest.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

async function fixtureArtifacts(version) {
  const root = await mkdtemp(join(tmpdir(), "mosa-release-manifest-"));
  const mac = join(root, `MOSA-darwin-arm64-${version}.zip`);
  const windows = join(root, `MOSA-win32-x64-${version}.zip`);
  await writeFile(mac, `mac-${version}`);
  await writeFile(windows, `windows-${version}`);
  return { root, mac, windows };
}

const RELEASE_KEYS = generateKeyPairSync("ed25519");
const RELEASE_TRUST = createReleaseManifestTrust(RELEASE_KEYS.publicKey);

function buildIdentity(version) {
  return {
    productVersion: version,
    gitSha: "a".repeat(40),
    uiFingerprint: "b".repeat(64),
    runtimeFingerprint: "c".repeat(64),
    distribution: "preview",
    releaseManifestTrust: RELEASE_TRUST,
  };
}

function signingOptions(version) {
  return {
    buildIdentity: buildIdentity(version),
    signingPrivateKey: RELEASE_KEYS.privateKey,
  };
}

test("release manifest emits only unified platforms schema and preserves Visual Packs", async () => {
  const version = "0.2.1-rc.16";
  const files = await fixtureArtifacts(version);
  try {
    const visualPacks = {
      "darwin-arm64": {
        id: "siglip2-base-patch16-224",
        revision: "model-revision",
        totalSize: 123,
        manifest: { size: 42, sha256: "a".repeat(64) },
        license: { id: "apache-2.0", source: "https://example.com/license" },
      },
    };
    const result = await prepareDesktopReleaseManifest({
      version,
      macArtifactPath: files.mac,
      ...signingOptions(version),
      previousManifest: {
        version: "0.2.1-rc.15",
        artifacts: { mac: { url: "legacy" }, windows: { url: "legacy" } },
        platforms: { windows: { file: "MOSA-win32-x64-0.2.1-rc.15.zip" } },
        visualPacks,
      },
      publishedAt: "2026-09-19T01:00:00Z",
      notes: { zh: "rc.16", en: "rc.16" },
    });
    assert.equal(result.version, version);
    assert.deepEqual(result.build, {
      gitSha: "a".repeat(40),
      uiFingerprint: "b".repeat(64),
      runtimeFingerprint: "c".repeat(64),
      distribution: "preview",
    });
    assert.equal(verifyReleaseManifestSignature(result, RELEASE_TRUST), true);
    assert.deepEqual(Object.keys(result.platforms), ["macos"]);
    assert.equal("artifacts" in result, false);
    assert.deepEqual(result.visualPacks, visualPacks);
    assert.equal(result.platforms.macos.file, `MOSA-darwin-arm64-${version}.zip`);
    const parsed = parseUpdateManifest(result);
    assert.equal(parsed.macArtifact.file, result.platforms.macos.file);
    assert.equal(parsed.windowsArtifact, null);
  } finally {
    await removeTestPath(files.root, { recursive: true, force: true });
  }
});

test("release manifest includes Windows only when a same-version real artifact is supplied", async () => {
  const version = "0.2.1-rc.16";
  const files = await fixtureArtifacts(version);
  try {
    const result = await prepareDesktopReleaseManifest({
      version,
      macArtifactPath: files.mac,
      windowsArtifactPath: files.windows,
      ...signingOptions(version),
      publishedAt: "2026-09-19T01:00:00Z",
      notes: { zh: "rc.16 中文说明", en: "rc.16 English notes" },
    });
    const parsed = parseUpdateManifest(result);
    assert.equal(parsed.macArtifact.file, `MOSA-darwin-arm64-${version}.zip`);
    assert.equal(parsed.windowsArtifact.file, `MOSA-win32-x64-${version}.zip`);
  } finally {
    await removeTestPath(files.root, { recursive: true, force: true });
  }
});

test("release manifest refuses stale artifact versions instead of publishing a mixed-version feed", async () => {
  const files = await fixtureArtifacts("0.2.1-rc.15");
  try {
    await assert.rejects(
      prepareDesktopReleaseManifest({
        version: "0.2.1-rc.16",
        macArtifactPath: files.mac,
        ...signingOptions("0.2.1-rc.16"),
        publishedAt: "2026-09-19T01:00:00Z",
      }),
      /filename must be MOSA-darwin-arm64-0\.2\.1-rc\.16\.zip/,
    );
  } finally {
    await removeTestPath(files.root, { recursive: true, force: true });
  }
});

test("release manifest requires explicit bilingual notes and never inherits previous release notes", async () => {
  const version = "0.2.1-rc.16";
  const files = await fixtureArtifacts(version);
  const previousManifest = {
    version: "0.2.1-rc.15",
    notes: { zh: "旧版中文说明", en: "Previous English notes" },
  };
  try {
    await assert.rejects(
      prepareDesktopReleaseManifest({
        version,
        macArtifactPath: files.mac,
        ...signingOptions(version),
        previousManifest,
        publishedAt: "2026-09-19T01:00:00Z",
      }),
      /notes\.zh and notes\.en must both be non-empty/,
    );
    await assert.rejects(
      prepareDesktopReleaseManifest({
        version,
        macArtifactPath: files.mac,
        ...signingOptions(version),
        previousManifest,
        publishedAt: "2026-09-19T01:00:00Z",
        notes: { zh: "新版本中文说明", en: "   " },
      }),
      /notes\.zh and notes\.en must both be non-empty/,
    );
    await assert.rejects(
      prepareDesktopReleaseManifest({
        version,
        macArtifactPath: files.mac,
        ...signingOptions(version),
        previousManifest,
        publishedAt: "2026-09-19T01:00:00Z",
        notes: { zh: "   ", en: "New release English notes" },
      }),
      /notes\.zh and notes\.en must both be non-empty/,
    );
  } finally {
    await removeTestPath(files.root, { recursive: true, force: true });
  }
});

test("release manifest refuses missing or mismatched build identity", async () => {
  const version = "0.2.1-rc.16";
  const files = await fixtureArtifacts(version);
  try {
    await assert.rejects(
      prepareDesktopReleaseManifest({
        version,
        macArtifactPath: files.mac,
        publishedAt: "2026-09-19T01:00:00Z",
        notes: { zh: "说明", en: "Notes" },
      }),
      /build identity is required/,
    );
    await assert.rejects(
      prepareDesktopReleaseManifest({
        version,
        macArtifactPath: files.mac,
        ...signingOptions("0.2.1-rc.15"),
        publishedAt: "2026-09-19T01:00:00Z",
        notes: { zh: "说明", en: "Notes" },
      }),
      /does not match/,
    );
  } finally {
    await removeTestPath(files.root, { recursive: true, force: true });
  }
});
