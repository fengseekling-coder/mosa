import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  createReleaseManifestTrust,
  signReleaseManifest,
  verifyReleaseManifestSignature,
} from "../lib/release-manifest-signature.mjs";

test("release manifest signatures bind every published field to a pinned Ed25519 key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const trust = createReleaseManifestTrust(publicKey);
  const manifest = signReleaseManifest({
    version: "0.2.1-rc.23",
    build: {
      gitSha: "a".repeat(40),
      uiFingerprint: "b".repeat(64),
      runtimeFingerprint: "c".repeat(64),
    },
    platforms: {
      macos: { file: "MOSA-darwin-arm64-0.2.1-rc.23.zip", size: 123, sha256: "d".repeat(64) },
    },
  }, { privateKey, expectedTrust: trust });

  assert.equal(manifest.signature.algorithm, "ed25519");
  assert.equal(manifest.signature.keyId, trust.keyId);
  assert.equal(verifyReleaseManifestSignature(manifest, trust), true);
  assert.throws(
    () => verifyReleaseManifestSignature({ ...manifest, version: "0.2.1-rc.24" }, trust),
    /verification failed/,
  );
});

test("release manifest signatures reject an untrusted signing key", () => {
  const trusted = generateKeyPairSync("ed25519");
  const attacker = generateKeyPairSync("ed25519");
  const trust = createReleaseManifestTrust(trusted.publicKey);
  assert.throws(
    () => signReleaseManifest({ version: "0.2.1-rc.23" }, {
      privateKey: attacker.privateKey,
      expectedTrust: trust,
    }),
    /does not match packaged trust key/,
  );
});
