import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";

import {
  downloadWindowsUpdate,
  launchWindowsUpdateHelper,
  resolveWindowsUpdateReadyFile,
  validateWindowsUpdateArtifact,
  windowsUpdateDownloadUrl,
  windowsUpdateHelperScript,
} from "../desktop/windows-updater.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

function artifactFor(bytes, version = "0.3.0") {
  return {
    platform: "Windows",
    arch: "x64",
    file: `MOSA-win32-x64-${version}.zip`,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

test("Windows update artifacts are pinned to the official filename and HTTPS download origin", () => {
  const artifact = artifactFor(Buffer.from("zip"));
  assert.deepEqual(validateWindowsUpdateArtifact(artifact, "0.3.0"), artifact);
  assert.equal(
    windowsUpdateDownloadUrl(artifact),
    "https://mosa.azhuilab.com/downloads/MOSA-win32-x64-0.3.0.zip",
  );
  assert.throws(() => validateWindowsUpdateArtifact({ ...artifact, file: "other.zip" }, "0.3.0"), /filename/);
  assert.throws(() => validateWindowsUpdateArtifact({ ...artifact, sha256: "bad" }, "0.3.0"), /SHA-256/);
});

test("Windows updater downloads to userData staging and verifies exact size plus SHA-256", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-win-update-"));
  const bytes = Buffer.from("fake-zip-payload");
  const artifact = artifactFor(bytes);
  const progress = [];
  try {
    const result = await downloadWindowsUpdate({
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

    await assert.rejects(downloadWindowsUpdate({
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

test("Windows apply helper waits for MOSA, replaces the whole portable directory, rolls back, and relaunches", async () => {
  const script = windowsUpdateHelperScript();
  assert.match(script, /Wait-Process -Id \$TargetPid/);
  assert.match(script, /\$transactionRoot = Join-Path \$parentDir/);
  assert.match(script, /Move-Item -LiteralPath \$InstallDir -Destination \$backupDir/);
  assert.match(script, /Move-Item -LiteralPath \$backupDir -Destination \$InstallDir/);
  assert.match(script, /--mosa-update-ready-file=/);
  assert.match(script, /Test-Path -LiteralPath \$ReadyFile/);
  assert.match(script, /did not report readiness before the rollback deadline/);

  const root = await mkdtemp(join(tmpdir(), "mosa-win-helper-"));
  const zipPath = join(root, "MOSA-win32-x64-0.3.0.zip");
  let invocation = null;
  try {
    await launchWindowsUpdateHelper({
      zipPath,
      installDir: "C:\\Users\\Example\\MOSA-win32-x64",
      exeName: "MOSA.exe",
      processId: 1234,
      spawnImpl: (command, args, options) => {
        invocation = { command, args, options };
        const child = new EventEmitter();
        child.unref = () => {};
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    });
    assert.equal(invocation.command, "powershell.exe");
    assert.equal(invocation.options.detached, true);
    assert.equal(invocation.args.includes("-ExecutionPolicy"), true);
    assert.equal(invocation.args.includes("Bypass"), true);
    assert.match(await readFile(join(root, "apply-update.ps1"), "utf8"), /Expand-Archive/);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("Windows update helper rejects when PowerShell cannot spawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-win-helper-spawn-error-"));
  try {
    await assert.rejects(launchWindowsUpdateHelper({
      zipPath: join(root, "MOSA-win32-x64-0.3.0.zip"),
      installDir: "C:\\Users\\Example\\MOSA-win32-x64",
      exeName: "MOSA.exe",
      processId: 1234,
      spawnImpl: () => {
        const child = new EventEmitter();
        child.unref = () => {};
        queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT" })));
        return child;
      },
    }), /ENOENT/);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("post-update readiness argument is accepted only inside the updater staging root", () => {
  const root = "C:\\Users\\Example\\AppData\\Roaming\\MOSA\\updates\\windows";
  const ready = `${root}\\0.3.0\\update-ready.json`;
  assert.equal(resolveWindowsUpdateReadyFile([`--mosa-update-ready-file=${ready}`], root), ready);
  assert.equal(resolveWindowsUpdateReadyFile(["--mosa-update-ready-file=C:\\Temp\\fake-ready.json"], root), null);
});
