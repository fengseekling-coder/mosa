import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { normalizeDesktopDistribution } from "../lib/release-distribution.mjs";

export const MOSA_WINDOWS_DOWNLOAD_BASE_URL = "https://mosa.azhuilab.com/downloads/";
const MAX_WINDOWS_UPDATE_BYTES = 1_500_000_000;
const DEFAULT_WINDOWS_UPDATE_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_WINDOWS_HELPER_START_TIMEOUT_MS = 5_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

function safeVersion(value) {
  const version = String(value || "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Invalid Windows update version.");
  }
  return version;
}

function safeBuildIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Windows update build identity is missing.");
  const gitSha = String(value.gitSha || "").trim().toLowerCase();
  const uiFingerprint = String(value.uiFingerprint || "").trim().toLowerCase();
  const runtimeFingerprint = String(value.runtimeFingerprint || "").trim().toLowerCase();
  const distribution = normalizeDesktopDistribution(value.distribution, { defaultValue: "preview", releaseOnly: true });
  if (!GIT_SHA_PATTERN.test(gitSha) || !SHA256_PATTERN.test(uiFingerprint) || !SHA256_PATTERN.test(runtimeFingerprint)) {
    throw new Error("Windows update build identity is invalid.");
  }
  return { gitSha, uiFingerprint, runtimeFingerprint, distribution };
}

export function validateWindowsUpdateArtifact(input, version) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Windows update artifact is missing.");
  }
  const normalizedVersion = safeVersion(version);
  const expectedFile = `MOSA-win32-x64-${normalizedVersion}.zip`;
  const file = String(input.file || "").trim();
  const size = Number(input.size);
  const sha256 = String(input.sha256 || "").trim().toLowerCase();
  if (String(input.platform || "").trim() !== "Windows") {
    throw new Error("Windows update artifact has an unexpected platform.");
  }
  if (String(input.arch || "").trim() !== "x64") {
    throw new Error("Windows update artifact has an unexpected architecture.");
  }
  if (file !== expectedFile) {
    throw new Error("Windows update artifact filename does not match the release version.");
  }
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_WINDOWS_UPDATE_BYTES) {
    throw new Error("Windows update artifact has an invalid size.");
  }
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error("Windows update artifact has an invalid SHA-256 digest.");
  }
  return { platform: "Windows", arch: "x64", file, size, sha256 };
}

export function windowsUpdateDownloadUrl(artifact) {
  const file = String(artifact?.file || "").trim();
  if (!/^MOSA-win32-x64-[0-9A-Za-z.-]+\.zip$/.test(file)) {
    throw new Error("Unsafe Windows update filename.");
  }
  return new URL(encodeURIComponent(file), MOSA_WINDOWS_DOWNLOAD_BASE_URL).toString();
}

function readableBody(body) {
  if (!body) return null;
  if (typeof body.getReader === "function") return Readable.fromWeb(body);
  if (typeof body.pipe === "function" || body[Symbol.asyncIterator]) return body;
  return null;
}

export async function downloadWindowsUpdate({
  artifact,
  version,
  stagingRoot,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  signal,
  idleTimeoutMs = DEFAULT_WINDOWS_UPDATE_IDLE_TIMEOUT_MS,
} = {}) {
  const safeArtifact = validateWindowsUpdateArtifact(artifact, version);
  if (typeof fetchImpl !== "function") throw new Error("Windows update download is unavailable.");
  const normalizedVersion = safeVersion(version);
  const stagingDir = join(stagingRoot, normalizedVersion);
  const partialPath = join(stagingDir, `${safeArtifact.file}.partial`);
  const zipPath = join(stagingDir, safeArtifact.file);
  // Only one downloaded release is ever useful. Removing the updater-owned
  // root prevents 150MB-class ZIPs from accumulating across versions.
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  const controller = new AbortController();
  let activeSource = null;
  let idleTimer = null;
  let timedOut = false;
  const timeoutMs = Math.max(1000, Number(idleTimeoutMs) || DEFAULT_WINDOWS_UPDATE_IDLE_TIMEOUT_MS);
  const timeoutError = () => Object.assign(new Error("Windows update download stalled."), { code: "WINDOWS_UPDATE_DOWNLOAD_TIMEOUT" });
  const armIdleTimeout = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      const error = timeoutError();
      controller.abort(error);
      activeSource?.destroy?.(error);
    }, timeoutMs);
    idleTimer.unref?.();
  };
  const abortFromCaller = () => {
    const reason = signal?.reason instanceof Error ? signal.reason : new Error("Windows update download cancelled.");
    controller.abort(reason);
    activeSource?.destroy?.(reason);
  };
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener?.("abort", abortFromCaller, { once: true });
  armIdleTimeout();

  try {
    const response = await fetchImpl(windowsUpdateDownloadUrl(safeArtifact), {
      method: "GET",
      headers: {
        accept: "application/zip, application/octet-stream",
        "cache-control": "no-cache",
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response?.ok) throw new Error(`Windows update download returned HTTP ${response?.status || 0}.`);
    const contentLength = Number(response.headers?.get?.("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > 0 && contentLength !== safeArtifact.size) {
      throw new Error("Windows update download size does not match the release manifest.");
    }
    activeSource = readableBody(response.body);
    if (!activeSource) throw new Error("Windows update response has no readable body.");
    armIdleTimeout();

    const hash = createHash("sha256");
    let receivedBytes = 0;
    let lastReportedPercent = -1;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        armIdleTimeout();
        receivedBytes += chunk.length;
        if (receivedBytes > safeArtifact.size) {
          callback(new Error("Windows update download exceeded the expected size."));
          return;
        }
        hash.update(chunk);
        const percent = Math.min(100, Math.floor((receivedBytes / safeArtifact.size) * 100));
        if (percent !== lastReportedPercent) {
          lastReportedPercent = percent;
          onProgress({ receivedBytes, totalBytes: safeArtifact.size, percent });
        }
        callback(null, chunk);
      },
    });
    await pipeline(activeSource, meter, createWriteStream(partialPath, { flags: "wx" }));
    if (receivedBytes !== safeArtifact.size) {
      throw new Error("Windows update download is incomplete.");
    }
    const digest = hash.digest("hex");
    if (digest !== safeArtifact.sha256) {
      throw new Error("Windows update SHA-256 verification failed.");
    }
    await rename(partialPath, zipPath);
    onProgress({ receivedBytes, totalBytes: safeArtifact.size, percent: 100 });
    return { stagingDir, zipPath, artifact: safeArtifact };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    if (timedOut && error?.code !== "WINDOWS_UPDATE_DOWNLOAD_TIMEOUT") throw timeoutError();
    throw error;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    signal?.removeEventListener?.("abort", abortFromCaller);
  }
}

export function resolveWindowsUpdateReadyFile(argv = process.argv, stagingRoot = "") {
  const prefix = "--mosa-update-ready-file=";
  const raw = (Array.isArray(argv) ? argv : []).find((value) => String(value).startsWith(prefix));
  if (!raw || !stagingRoot) return null;
  const rawCandidate = String(raw).slice(prefix.length);
  const windowsStyle = /^[a-z]:[\\/]/i.test(rawCandidate) || /^[a-z]:[\\/]/i.test(String(stagingRoot));
  const pathApi = windowsStyle ? win32 : { resolve, relative: (from, to) => relative(from, to), isAbsolute };
  const candidate = pathApi.resolve(rawCandidate);
  const root = pathApi.resolve(stagingRoot);
  const suffix = pathApi.relative(root, candidate);
  if (suffix === "") return candidate;
  if (suffix === ".." || suffix.startsWith(`..${windowsStyle ? "\\" : "/"}`) || pathApi.isAbsolute(suffix)) return null;
  return candidate;
}

export function windowsUpdateTransactionParentDir(execPath) {
  const value = String(execPath || "").trim();
  if (!value) return "";
  return win32.dirname(win32.dirname(value));
}

export function windowsMoveDirectoryRetryScript() {
  return String.raw`function Move-MosaDirectoryWithRetry {
  param(
    [Parameter(Mandatory=$true)][string]$LiteralPath,
    [Parameter(Mandatory=$true)][string]$Destination,
    [int]$MaxAttempts = 6
  )

  $retryDelaysMs = @(250, 500, 750, 1000, 1500)
  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    try {
      Move-Item -LiteralPath $LiteralPath -Destination $Destination -ErrorAction Stop
      return
    } catch {
      $errorRecord = $_
      $exception = $errorRecord.Exception
      $retryable = ($exception -is [System.IO.IOException]) -or ($exception -is [System.UnauthorizedAccessException])
      if (-not $retryable -or $attempt -ge $MaxAttempts) {
        $exceptionType = if ($exception) { $exception.GetType().FullName } else { "unknown" }
        $hresultHex = if ($exception) { "0x" + $exception.HResult.ToString("X8") } else { "unknown" }
        $nativeCode = if ($exception) { $exception.HResult -band 0xffff } else { "unknown" }
        $errorId = [string]$errorRecord.FullyQualifiedErrorId
        $moveDiagnostic = "MOSA directory move failed: source=$LiteralPath; destination=$Destination; attempt=$attempt/$MaxAttempts; exceptionType=$exceptionType; hresult=$hresultHex; nativeCode=$nativeCode; errorId=$errorId"
        if ($script:MosaLastMoveDiagnostic) {
          $script:MosaLastMoveDiagnostic += [Environment]::NewLine + $moveDiagnostic
        } else {
          $script:MosaLastMoveDiagnostic = $moveDiagnostic
        }
        throw
      }
      $delayIndex = [Math]::Min($attempt - 1, $retryDelaysMs.Count - 1)
      Start-Sleep -Milliseconds $retryDelaysMs[$delayIndex]
    }
  }
}`;
}

export function windowsUpdateHelperScript() {
  return String.raw`param(
  [Parameter(Mandatory=$true)][int]$TargetPid,
  [Parameter(Mandatory=$true)][string]$ZipPath,
  [Parameter(Mandatory=$true)][string]$InstallDir,
  [Parameter(Mandatory=$true)][string]$ExeName,
  [Parameter(Mandatory=$true)][string]$ExpectedVersion,
  [Parameter(Mandatory=$true)][string]$ExpectedGitSha,
  [Parameter(Mandatory=$true)][string]$ExpectedUiFingerprint,
  [Parameter(Mandatory=$true)][string]$ExpectedRuntimeFingerprint,
  [Parameter(Mandatory=$true)][ValidateSet('preview','production')][string]$ExpectedDistribution,
  [Parameter(Mandatory=$true)][string]$LogPath,
  [Parameter(Mandatory=$true)][string]$StartedFile,
  [Parameter(Mandatory=$true)][string]$ReadyFile
)

${windowsMoveDirectoryRetryScript()}

$ErrorActionPreference = "Stop"
$script:MosaLastMoveDiagnostic = $null
$parentDir = Split-Path -Parent $InstallDir
$transactionRoot = Join-Path $parentDir (".MOSA-update-" + [Guid]::NewGuid().ToString("N"))
$extractDir = Join-Path $transactionRoot "extracted"
$payloadDir = $null
$backupDir = Join-Path $transactionRoot "previous"
$oldExe = Join-Path $InstallDir $ExeName
$newProcess = $null
$movedOriginal = $false

try {
  [string]$PID | Set-Content -LiteralPath $StartedFile -Encoding ASCII
  $expectedSignerThumbprint = $null
  if ($ExpectedDistribution -eq 'production') {
    $oldSignature = Get-AuthenticodeSignature -LiteralPath $oldExe
    if ($oldSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or -not $oldSignature.SignerCertificate) {
      throw "Installed MOSA does not have a valid Authenticode signature."
    }
    $expectedSignerThumbprint = $oldSignature.SignerCertificate.Thumbprint
  }
  Wait-Process -Id $TargetPid -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $transactionRoot -Force | Out-Null
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $extractDir -Force
  $flatPayloadExe = Join-Path $extractDir $ExeName
  $nestedPayloadDir = Join-Path $extractDir "MOSA-win32-x64"
  $nestedPayloadExe = Join-Path $nestedPayloadDir $ExeName
  if (Test-Path -LiteralPath $flatPayloadExe -PathType Leaf) {
    $payloadDir = $extractDir
    $payloadExe = $flatPayloadExe
  } elseif (Test-Path -LiteralPath $nestedPayloadExe -PathType Leaf) {
    $payloadDir = $nestedPayloadDir
    $payloadExe = $nestedPayloadExe
  } else {
    throw "Downloaded MOSA package does not contain the expected executable."
  }
  if ($ExpectedDistribution -eq 'production') {
    $signableFiles = @(Get-ChildItem -LiteralPath $payloadDir -Recurse -File | Where-Object { $_.Extension -in @('.exe', '.dll', '.node') })
    if ($signableFiles.Count -eq 0) {
      throw "Downloaded MOSA package contains no signable executable payload."
    }
    foreach ($file in $signableFiles) {
      $payloadSignature = Get-AuthenticodeSignature -LiteralPath $file.FullName
      if ($payloadSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or -not $payloadSignature.SignerCertificate) {
        throw "Downloaded MOSA payload contains an invalid Authenticode signature: $($file.FullName)"
      }
      if ($payloadSignature.SignerCertificate.Thumbprint -ne $expectedSignerThumbprint) {
        throw "Downloaded MOSA payload is signed by a different publisher: $($file.FullName)"
      }
    }
  }

  Move-MosaDirectoryWithRetry -LiteralPath $InstallDir -Destination $backupDir
  $movedOriginal = $true
  try {
    Move-MosaDirectoryWithRetry -LiteralPath $payloadDir -Destination $InstallDir
    $newExe = Join-Path $InstallDir $ExeName
    if (-not (Test-Path -LiteralPath $newExe -PathType Leaf)) {
      throw "Updated MOSA executable is missing after replacement."
    }
    Remove-Item -LiteralPath $ReadyFile -Force -ErrorAction SilentlyContinue
    $readyArgument = '--mosa-update-ready-file="' + $ReadyFile + '"'
    $newProcess = Start-Process -FilePath $newExe -WorkingDirectory $InstallDir -ArgumentList @($readyArgument) -PassThru
    $readyDeadline = [DateTime]::UtcNow.AddSeconds(45)
    while ([DateTime]::UtcNow -lt $readyDeadline) {
      if (Test-Path -LiteralPath $ReadyFile -PathType Leaf) { break }
      if ($newProcess.HasExited) { throw "Updated MOSA exited before reporting readiness." }
      Start-Sleep -Milliseconds 250
    }
    if (-not (Test-Path -LiteralPath $ReadyFile -PathType Leaf)) {
      throw "Updated MOSA did not report readiness before the rollback deadline."
    }
    $ready = Get-Content -LiteralPath $ReadyFile -Raw | ConvertFrom-Json
    if ([string]$ready.version -ne $ExpectedVersion -or
        [string]$ready.gitSha -ne $ExpectedGitSha -or
        [string]$ready.uiFingerprint -ne $ExpectedUiFingerprint -or
        [string]$ready.runtimeFingerprint -ne $ExpectedRuntimeFingerprint) {
      throw "Updated MOSA readiness identity does not match the release manifest."
    }
    if ([string]$ready.distribution -ne $ExpectedDistribution) {
      throw "Updated MOSA distribution does not match the release manifest."
    }
    # Keep $backupDir parked inside $transactionRoot. The updated app sweeps
    # stale .MOSA-update-* directories on a later boot, so a crash shortly
    # after this point remains recoverable from the parked previous copy.
    Remove-Item -LiteralPath $extractDir -Recurse -Force -ErrorAction SilentlyContinue
  } catch {
    if ($newProcess -and -not $newProcess.HasExited) {
      Stop-Process -Id $newProcess.Id -Force -ErrorAction SilentlyContinue
      Wait-Process -Id $newProcess.Id -ErrorAction SilentlyContinue
    }
    # The destructive removal is explicitly scoped: it only runs once the
    # original directory is verifiably parked in $backupDir, so whatever sits
    # at $InstallDir at this point is replacement payload this helper moved
    # in — never files that predate the update.
    if ($movedOriginal -and (Test-Path -LiteralPath $backupDir -PathType Container)) {
      if (Test-Path -LiteralPath $InstallDir) {
        Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
      }
      Move-MosaDirectoryWithRetry -LiteralPath $backupDir -Destination $InstallDir
    }
    throw
  }
} catch {
  if (Test-Path -LiteralPath $oldExe -PathType Leaf) {
    Start-Process -FilePath $oldExe -WorkingDirectory $InstallDir -ErrorAction SilentlyContinue
  }
  $errorText = ($_ | Out-String)
  if ($script:MosaLastMoveDiagnostic) {
    $errorText += [Environment]::NewLine + $script:MosaLastMoveDiagnostic + [Environment]::NewLine
  }
  $errorText | Set-Content -LiteralPath $LogPath -Encoding UTF8
  exit 1
}
`;
}

async function waitForWindowsUpdateHelperStarted({
  child,
  startedFile,
  timeoutMs = DEFAULT_WINDOWS_HELPER_START_TIMEOUT_MS,
} = {}) {
  const deadline = Date.now() + Math.max(250, Number(timeoutMs) || DEFAULT_WINDOWS_HELPER_START_TIMEOUT_MS);
  let childExit = null;
  const onExit = (code, signal) => {
    childExit = { code, signal };
  };
  child.once?.("exit", onExit);
  try {
    while (Date.now() < deadline) {
      const marker = await readFile(startedFile, "utf8").catch((error) => {
        if (error?.code === "ENOENT") return "";
        throw error;
      });
      if (String(marker || "").trim()) return true;
      if (childExit && (childExit.signal || childExit.code !== 0)) {
        throw new Error(
          `Windows update helper exited before startup handoff (code=${childExit.code ?? "null"}, signal=${childExit.signal ?? "none"}).`,
        );
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    throw new Error("Windows update helper did not start before the handoff deadline.");
  } finally {
    child.off?.("exit", onExit);
  }
}

function powershellLiteral(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function encodePowerShellCommand(command) {
  return Buffer.from(String(command || ""), "utf16le").toString("base64");
}

export function windowsUpdateDetachedLauncherCommand({
  scriptPath,
  processId,
  zipPath,
  installDir,
  exeName,
  version,
  expectedIdentity,
  logPath,
  startedFile,
  readyFile,
  launcherLogPath,
} = {}) {
  const identity = safeBuildIdentity(expectedIdentity);
  const normalizedVersion = safeVersion(version);
  const helperCommand = [
    `& ${powershellLiteral(scriptPath)}`,
    `-TargetPid ${Number(processId)}`,
    `-ZipPath ${powershellLiteral(zipPath)}`,
    `-InstallDir ${powershellLiteral(installDir)}`,
    `-ExeName ${powershellLiteral(exeName)}`,
    `-ExpectedVersion ${powershellLiteral(normalizedVersion)}`,
    `-ExpectedGitSha ${powershellLiteral(identity.gitSha)}`,
    `-ExpectedUiFingerprint ${powershellLiteral(identity.uiFingerprint)}`,
    `-ExpectedRuntimeFingerprint ${powershellLiteral(identity.runtimeFingerprint)}`,
    `-ExpectedDistribution ${powershellLiteral(identity.distribution)}`,
    `-LogPath ${powershellLiteral(logPath)}`,
    `-StartedFile ${powershellLiteral(startedFile)}`,
    `-ReadyFile ${powershellLiteral(readyFile)}`,
  ].join(" ");
  const helperEncoded = encodePowerShellCommand(helperCommand);
  const detachedCommandLine = `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ${helperEncoded}`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    `  $commandLine = ${powershellLiteral(detachedCommandLine)}`,
    "  $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine } -ErrorAction Stop",
    "  if (-not $result -or [int]$result.ReturnValue -ne 0) {",
    "    throw ('Win32_Process.Create failed with return value ' + [string]$result.ReturnValue)",
    "  }",
    "} catch {",
    `  ($_ | Out-String) | Set-Content -LiteralPath ${powershellLiteral(launcherLogPath)} -Encoding UTF8`,
    "  exit 1",
    "}",
  ].join("; ");
}

export async function launchWindowsUpdateHelper({
  zipPath,
  installDir,
  exeName,
  version,
  expectedIdentity,
  processId,
  spawnImpl = spawn,
  helperStartTimeoutMs = DEFAULT_WINDOWS_HELPER_START_TIMEOUT_MS,
} = {}) {
  const identity = safeBuildIdentity(expectedIdentity);
  const normalizedVersion = safeVersion(version);
  if (!zipPath || !installDir || !exeName || !Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error("Invalid Windows update helper arguments.");
  }
  const stagingDir = dirname(zipPath);
  const scriptPath = join(stagingDir, "apply-update.ps1");
  const logPath = join(stagingDir, "apply-update-error.log");
  const launcherLogPath = join(stagingDir, "helper-launch-error.log");
  const startedFile = join(stagingDir, "helper-started.txt");
  const readyFile = join(stagingDir, "update-ready.json");
  await Promise.all([
    rm(startedFile, { force: true }),
    rm(launcherLogPath, { force: true }),
  ]);
  await writeFile(scriptPath, windowsUpdateHelperScript(), "utf8");
  const launcherCommand = windowsUpdateDetachedLauncherCommand({
    scriptPath,
    processId,
    zipPath,
    installDir,
    exeName,
    version: normalizedVersion,
    expectedIdentity: identity,
    logPath,
    startedFile,
    readyFile,
    launcherLogPath,
  });
  const child = spawnImpl("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", encodePowerShellCommand(launcherCommand),
  ], {
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  });
  try {
    await waitForWindowsUpdateHelperStarted({
      child,
      startedFile,
      timeoutMs: helperStartTimeoutMs,
    });
  } catch (error) {
    child.kill?.();
    throw error;
  }
  child.unref?.();
  return { scriptPath, logPath, launcherLogPath, startedFile, readyFile };
}
