import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  downloadMacosUpdate,
  launchMacosUpdateHelper,
  macosUpdateDownloadUrl,
  macosUpdateHelperScript,
  resolveMacosInstallAppPath,
  resolveMacosUpdateReadyFile,
  validateMacosUpdateArtifact,
} from "../desktop/macos-updater.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

function artifactFor(bytes, version = "0.3.0") {
  return {
    platform: "macOS",
    arch: "arm64",
    file: `MOSA-darwin-arm64-${version}.zip`,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

const EXPECTED_IDENTITY = Object.freeze({
  gitSha: "a".repeat(40),
  uiFingerprint: "b".repeat(64),
  runtimeFingerprint: "c".repeat(64),
});

test("macOS update artifacts are pinned to the official filename and HTTPS download origin", () => {
  const artifact = artifactFor(Buffer.from("zip"));
  assert.deepEqual(validateMacosUpdateArtifact(artifact, "0.3.0"), artifact);
  assert.equal(
    macosUpdateDownloadUrl(artifact),
    "https://mosa.azhuilab.com/downloads/MOSA-darwin-arm64-0.3.0.zip",
  );
  assert.throws(() => validateMacosUpdateArtifact({ ...artifact, file: "other.zip" }, "0.3.0"), /filename/);
  assert.throws(() => validateMacosUpdateArtifact({ ...artifact, sha256: "bad" }, "0.3.0"), /SHA-256/);
});

test("macOS updater downloads to userData staging and verifies exact size plus SHA-256", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-mac-update-"));
  const bytes = Buffer.from("fake-macos-zip-payload");
  const artifact = artifactFor(bytes);
  const progress = [];
  try {
    const result = await downloadMacosUpdate({
      artifact,
      version: "0.3.0",
      stagingRoot: root,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: (name) => name === "content-length" ? String(bytes.length) : null },
        body: Readable.from([bytes]),
      }),
      onProgress: (entry) => progress.push(entry.percent),
    });
    assert.deepEqual(await readFile(result.zipPath), bytes);
    assert.equal(progress.at(-1), 100);

    await assert.rejects(downloadMacosUpdate({
      artifact: { ...artifact, sha256: "f".repeat(64) },
      version: "0.3.0",
      stagingRoot: root,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => String(bytes.length) },
        body: Readable.from([bytes]),
      }),
    }), /SHA-256 verification failed/);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("macOS apply helper waits for MOSA, verifies the replacement, rolls back, and relaunches", async () => {
  const script = macosUpdateHelperScript();
  assert.match(script, /while kill -0 \"\$TARGET_PID\"/);
  assert.match(script, /\/usr\/bin\/ditto -x -k/);
  assert.match(script, /CFBundleIdentifier/);
  assert.match(script, /CFBundleShortVersionString/);
  assert.match(script, /codesign --verify --deep --strict/);
  assert.match(script, /OLD_TEAM=.*TeamIdentifier/);
  assert.match(script, /\[ "\$NEW_TEAM" = "\$OLD_TEAM" \]/);
  assert.match(script, /flags=.*runtime/);
  assert.match(script, /spctl -a -vv --type execute/);
  assert.match(script, /mv \"\$INSTALL_APP\" \"\$BACKUP_APP\"/);
  assert.match(script, /mv \"\$BACKUP_APP\" \"\$INSTALL_APP\"/);
  assert.match(script, /--mosa-update-ready-file=/);
  assert.match(script, /\[ -f \"\$READY_FILE\" \]/);
  assert.match(script, /READY_GIT_SHA=.*gitSha/);
  assert.match(script, /READY_UI_FINGERPRINT=.*uiFingerprint/);
  assert.match(script, /READY_RUNTIME_FINGERPRINT=.*runtimeFingerprint/);
  assert.match(script, /exit 32/);

  const root = await mkdtemp(join(tmpdir(), "mosa-mac-helper-"));
  const zipPath = join(root, "MOSA-darwin-arm64-0.3.0.zip");
  let invocation = null;
  try {
    await launchMacosUpdateHelper({
      zipPath,
      installAppPath: "/Applications/MOSA.app",
      version: "0.3.0",
      expectedIdentity: EXPECTED_IDENTITY,
      processId: 1234,
      libraryDir: "/tmp/mosa-library",
      createUpdateHandoff: async ({ libraryDir, pid }) => {
        assert.equal(libraryDir, "/tmp/mosa-library");
        assert.equal(pid, 4321);
        return { markerPath: "/tmp/mosa-library/.mosa-desktop-starting.json" };
      },
      spawnImpl: (command, args, options) => {
        invocation = { command, args, options };
        const child = new EventEmitter();
        child.pid = 4321;
        child.kill = () => true;
        child.unref = () => {};
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    });
    assert.equal(invocation.command, "/bin/sh");
    assert.equal(invocation.options.detached, true);
    assert.equal(invocation.args.includes("/Applications/MOSA.app"), true);
    assert.equal(invocation.args.includes(EXPECTED_IDENTITY.gitSha), true);
    assert.equal(invocation.args.includes(EXPECTED_IDENTITY.uiFingerprint), true);
    assert.equal(invocation.args.includes(EXPECTED_IDENTITY.runtimeFingerprint), true);
    assert.equal(invocation.args.includes("/tmp/mosa-library/.mosa-desktop-starting.json"), true);
    assert.match(await readFile(join(root, "apply-update.sh"), "utf8"), /ditto -x -k/);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("macOS apply helper keeps supervisor handoff active until readiness and clears it before rollback relaunch", () => {
  const script = macosUpdateHelperScript();
  assert.match(script, /shift 9\nHANDOFF_FILE="\$1"/);
  assert.match(script, /rollback\(\) \{\n  rm -f "\$HANDOFF_FILE"/);
  assert.match(script, /\[ "\$READY_RUNTIME_FINGERPRINT" = "\$EXPECTED_RUNTIME_FINGERPRINT" \]\n    trap - HUP INT TERM EXIT\n    rm -f "\$HANDOFF_FILE"/);
});

test("macOS updater resolves only the MOSA.app that contains the running executable", () => {
  assert.equal(
    resolveMacosInstallAppPath("/Applications/MOSA.app/Contents/MacOS/MOSA"),
    "/Applications/MOSA.app",
  );
  assert.equal(resolveMacosInstallAppPath("/Applications/Other.app/Contents/MacOS/MOSA"), null);
  assert.equal(resolveMacosInstallAppPath("/usr/local/bin/MOSA"), null);
});

test("macOS post-update readiness argument is accepted only inside the updater staging root", () => {
  const root = "/Users/example/Library/Application Support/MOSA/updates/macos";
  const ready = `${root}/0.3.0/update-ready.json`;
  assert.equal(resolveMacosUpdateReadyFile([`--mosa-update-ready-file=${ready}`], root), ready);
  assert.equal(resolveMacosUpdateReadyFile(["--mosa-update-ready-file=/tmp/fake-ready.json"], root), null);
});
