import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";

import {
  downloadWindowsUpdate,
  launchWindowsUpdateHelper,
  resolveWindowsUpdateReadyFile,
  validateWindowsUpdateArtifact,
  windowsUpdateDetachedLauncherCommand,
  windowsUpdateDownloadUrl,
  windowsUpdateHelperScript,
  windowsMoveDirectoryRetryScript,
  windowsUpdateTransactionParentDir,
} from "../desktop/windows-updater.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

const execFileAsync = promisify(execFile);

function encodePowerShellCommand(command) {
  return Buffer.from(String(command || ""), "utf16le").toString("base64");
}

function powershellLiteral(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function artifactFor(bytes, version = "0.3.0") {
  return {
    platform: "Windows",
    arch: "x64",
    file: `MOSA-win32-x64-${version}.zip`,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

const EXPECTED_IDENTITY = Object.freeze({
  gitSha: "a".repeat(40),
  uiFingerprint: "b".repeat(64),
  runtimeFingerprint: "c".repeat(64),
  distribution: "preview",
});

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
  assert.match(script, /\$flatPayloadExe = Join-Path \$extractDir \$ExeName/);
  assert.match(script, /\$nestedPayloadDir = Join-Path \$extractDir "MOSA-win32-x64"/);
  assert.match(script, /if \(Test-Path -LiteralPath \$flatPayloadExe -PathType Leaf\)/);
  assert.match(script, /elseif \(Test-Path -LiteralPath \$nestedPayloadExe -PathType Leaf\)/);
  assert.match(script, /Get-AuthenticodeSignature -LiteralPath \$oldExe/);
  assert.match(script, /if \(\$ExpectedDistribution -eq 'production'\)/);
  assert.match(script, /\$signableFiles = @\(Get-ChildItem -LiteralPath \$payloadDir -Recurse -File/);
  assert.match(script, /foreach \(\$file in \$signableFiles\)/);
  assert.match(script, /Get-AuthenticodeSignature -LiteralPath \$file\.FullName/);
  assert.match(script, /signed by a different publisher/);
  assert.match(script, /Move-MosaDirectoryWithRetry -LiteralPath \$InstallDir -Destination \$backupDir/);
  assert.match(script, /Move-MosaDirectoryWithRetry -LiteralPath \$payloadDir -Destination \$InstallDir/);
  assert.match(script, /Move-MosaDirectoryWithRetry -LiteralPath \$backupDir -Destination \$InstallDir/);
  assert.match(script, /\[int\]\$MaxAttempts = 10/);
  assert.match(script, /\$retryDelaysMs = @\(250, 500, 1000, 2000, 3000, 4000, 5000, 5000, 5000\)/);
  assert.match(script, /\$exception -is \[System\.IO\.IOException\]/);
  assert.match(script, /\$exception -is \[System\.UnauthorizedAccessException\]/);
  assert.match(script, /hresult=\$hresultHex/);
  assert.match(script, /nativeCode=\$nativeCode/);
  assert.match(script, /errorId=\$errorId/);
  assert.match(script, /--mosa-update-ready-file=/);
  assert.match(script, /Test-Path -LiteralPath \$ReadyFile/);
  assert.match(script, /did not report readiness before the rollback deadline/);
  assert.match(script, /readiness identity does not match the release manifest/);
  assert.match(script, /distribution does not match the release manifest/);
  // The destructive rollback removal must be explicitly scoped to runs where
  // the original directory is verifiably parked in the backup location.
  assert.match(script, /\$movedOriginal = \$true/);
  assert.match(script, /if \(\$movedOriginal -and \(Test-Path -LiteralPath \$backupDir -PathType Container\)\)/);
  // Recovery data survives a successful apply until the updated app's own
  // boot sweep reclaims it; only the redundant extracted payload is dropped.
  assert.doesNotMatch(script, /Remove-Item -LiteralPath \$backupDir/);
  assert.doesNotMatch(script, /Remove-Item -LiteralPath \$transactionRoot/);
  assert.match(script, /Remove-Item -LiteralPath \$extractDir -Recurse -Force/);
  // The success path must explicitly exit 0 to ensure the helper terminates
  // cleanly and does not keep the updated MOSA process waiting.
  assert.match(script, /Remove-Item -LiteralPath \$extractDir[^\n]*\n\s*exit 0/);
  // The rollback path exits 1 to signal failure.
  assert.match(script, /exit 1/);

  const root = await mkdtemp(join(tmpdir(), "mosa-win-helper-"));
  const zipPath = join(root, "MOSA-win32-x64-0.3.0.zip");
  let invocation = null;
  try {
    await launchWindowsUpdateHelper({
      zipPath,
      installDir: "C:\\Users\\Example\\MOSA-win32-x64",
      exeName: "MOSA.exe",
      version: "0.3.0",
      expectedIdentity: EXPECTED_IDENTITY,
      processId: 1234,
      spawnImpl: (command, args, options) => {
        invocation = { command, args, options };
        const child = new EventEmitter();
        child.unref = () => {};
        child.kill = () => {};
        queueMicrotask(() => child.emit("spawn"));
        queueMicrotask(() => writeFile(join(root, "helper-started.txt"), "4321\n"));
        return child;
      },
    });
    assert.equal(invocation.command, "powershell.exe");
    assert.equal(invocation.options.detached, undefined);
    assert.equal(invocation.args.includes("-ExecutionPolicy"), true);
    assert.equal(invocation.args.includes("Bypass"), true);
    assert.equal(invocation.args.includes("-EncodedCommand"), true);
    assert.match(await readFile(join(root, "apply-update.ps1"), "utf8"), /Expand-Archive/);
    assert.match(await readFile(join(root, "apply-update.ps1"), "utf8"), /Set-Content -LiteralPath \$StartedFile/);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("Windows directory move retries a transient exclusive file lock", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-win-move-retry-"));
  const sourceDir = join(root, "source");
  const destinationDir = join(root, "destination");
  const lockedFile = join(sourceDir, "payload.bin");
  const markerFile = join(root, "lock-held.txt");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(lockedFile, "locked payload", "utf8");

  const lockerCommand = [
    `$stream = [System.IO.File]::Open(${powershellLiteral(lockedFile)}, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)`,
    "try {",
    `  'locked' | Set-Content -LiteralPath ${powershellLiteral(markerFile)} -Encoding ASCII`,
    "  Start-Sleep -Milliseconds 6500",
    "} finally {",
    "  $stream.Dispose()",
    "}",
  ].join("\n");
  const locker = spawn("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", encodePowerShellCommand(lockerCommand),
  ], { stdio: "ignore", windowsHide: true });
  const lockerExit = new Promise((resolveExit) => locker.once("exit", resolveExit));

  try {
    let locked = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await readFile(markerFile, "utf8").then(() => true).catch(() => false)) {
        locked = true;
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    assert.equal(locked, true, "exclusive lock holder must report readiness");

    const moveCommand = [
      windowsMoveDirectoryRetryScript(),
      `Move-MosaDirectoryWithRetry -LiteralPath ${powershellLiteral(sourceDir)} -Destination ${powershellLiteral(destinationDir)}`,
    ].join("\n");
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", encodePowerShellCommand(moveCommand),
    ], { windowsHide: true, timeout: 35_000 });

    assert.equal(await readFile(join(destinationDir, "payload.bin"), "utf8"), "locked payload");
    await lockerExit;
  } finally {
    if (locker.exitCode === null) locker.kill();
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("Windows update transaction cleanup targets the helper transaction parent", () => {
  assert.equal(
    windowsUpdateTransactionParentDir("C:\\Users\\Example\\Downloads\\MOSA-win32-x64-0.2.1-rc.30\\MOSA-win32-x64\\MOSA.exe"),
    "C:\\Users\\Example\\Downloads\\MOSA-win32-x64-0.2.1-rc.30",
  );
});

test("desktop stale transaction cleanup scans the updater transaction parent", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  assert.match(main, /const parentDir = windowsUpdateTransactionParentDir\(process\.execPath\);/);
  assert.doesNotMatch(main, /const parentDir = dirname\(process\.execPath\);/);
});

test("Windows update helper rejects when PowerShell cannot spawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-win-helper-spawn-error-"));
  try {
    await assert.rejects(launchWindowsUpdateHelper({
      zipPath: join(root, "MOSA-win32-x64-0.3.0.zip"),
      installDir: "C:\\Users\\Example\\MOSA-win32-x64",
      exeName: "MOSA.exe",
      version: "0.3.0",
      expectedIdentity: EXPECTED_IDENTITY,
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

test("Windows update helper handoff fails closed when PowerShell spawns but the script never starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-win-helper-no-handoff-"));
  let killed = false;
  try {
    await assert.rejects(launchWindowsUpdateHelper({
      zipPath: join(root, "MOSA-win32-x64-0.3.0.zip"),
      installDir: "C:\\Users\\Example\\MOSA-win32-x64",
      exeName: "MOSA.exe",
      version: "0.3.0",
      expectedIdentity: EXPECTED_IDENTITY,
      processId: 1234,
      helperStartTimeoutMs: 100,
      spawnImpl: () => {
        const child = new EventEmitter();
        child.unref = () => {};
        child.kill = () => { killed = true; };
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    }), /did not start before the handoff deadline/);
    assert.equal(killed, true);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("Windows detached launcher creates the real updater through Win32_Process", () => {
  const command = windowsUpdateDetachedLauncherCommand({
    scriptPath: "C:\\Users\\Example\\AppData\\Roaming\\mosa\\updates\\windows\\0.3.0\\apply-update.ps1",
    processId: 1234,
    zipPath: "C:\\Users\\Example\\AppData\\Roaming\\mosa\\updates\\windows\\0.3.0\\MOSA-win32-x64-0.3.0.zip",
    installDir: "C:\\Users\\Example\\MOSA-win32-x64",
    exeName: "MOSA.exe",
    version: "0.3.0",
    expectedIdentity: EXPECTED_IDENTITY,
    logPath: "C:\\Users\\Example\\AppData\\Roaming\\mosa\\updates\\windows\\0.3.0\\apply-update-error.log",
    startedFile: "C:\\Users\\Example\\AppData\\Roaming\\mosa\\updates\\windows\\0.3.0\\helper-started.txt",
    readyFile: "C:\\Users\\Example\\AppData\\Roaming\\mosa\\updates\\windows\\0.3.0\\update-ready.json",
    launcherLogPath: "C:\\Users\\Example\\AppData\\Roaming\\mosa\\updates\\windows\\0.3.0\\helper-launch-error.log",
  });
  assert.match(command, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/);
  assert.match(command, /Win32_Process\.Create failed with return value/);
  assert.match(command, /helper-launch-error\.log/);
  assert.match(command, /powershell\.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand/);
  assert.match(command, /New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly/);
  assert.match(command, /\$startup\.CreateFlags = \[uint32\]0x08000000/);
  assert.match(command, /\$startup\.ShowWindow = 0/);
  assert.match(command, /ProcessStartupInformation = \$startup/);
  assert.doesNotMatch(command, /Start-Process/);
});

test("Windows helper handoff tolerates bootstrap exit zero while waiting for detached helper marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-win-helper-bootstrap-exit-"));
  try {
    await launchWindowsUpdateHelper({
      zipPath: join(root, "MOSA-win32-x64-0.3.0.zip"),
      installDir: "C:\\Users\\Example\\MOSA-win32-x64",
      exeName: "MOSA.exe",
      version: "0.3.0",
      expectedIdentity: EXPECTED_IDENTITY,
      processId: 1234,
      helperStartTimeoutMs: 500,
      spawnImpl: () => {
        const child = new EventEmitter();
        child.unref = () => {};
        child.kill = () => {};
        queueMicrotask(() => child.emit("spawn"));
        setTimeout(() => child.emit("exit", 0, null), 5);
        setTimeout(() => writeFile(join(root, "helper-started.txt"), "9876\n"), 30);
        return child;
      },
    });
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
