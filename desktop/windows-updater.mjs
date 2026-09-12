import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const MOSA_WINDOWS_DOWNLOAD_BASE_URL = "https://mosa.azhuilab.com/downloads/";
const MAX_WINDOWS_UPDATE_BYTES = 1_500_000_000;
const DEFAULT_WINDOWS_UPDATE_IDLE_TIMEOUT_MS = 30_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

function safeVersion(value) {
  const version = String(value || "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Invalid Windows update version.");
  }
  return version;
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

export function windowsUpdateHelperScript() {
  return String.raw`param(
  [Parameter(Mandatory=$true)][int]$TargetPid,
  [Parameter(Mandatory=$true)][string]$ZipPath,
  [Parameter(Mandatory=$true)][string]$InstallDir,
  [Parameter(Mandatory=$true)][string]$ExeName,
  [Parameter(Mandatory=$true)][string]$LogPath,
  [Parameter(Mandatory=$true)][string]$ReadyFile
)

$ErrorActionPreference = "Stop"
$parentDir = Split-Path -Parent $InstallDir
$transactionRoot = Join-Path $parentDir (".MOSA-update-" + [Guid]::NewGuid().ToString("N"))
$extractDir = Join-Path $transactionRoot "extracted"
$payloadDir = Join-Path $extractDir "MOSA-win32-x64"
$backupDir = Join-Path $transactionRoot "previous"
$oldExe = Join-Path $InstallDir $ExeName
$newProcess = $null

try {
  Wait-Process -Id $TargetPid -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $transactionRoot -Force | Out-Null
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $extractDir -Force
  $payloadExe = Join-Path $payloadDir $ExeName
  if (-not (Test-Path -LiteralPath $payloadExe -PathType Leaf)) {
    throw "Downloaded MOSA package does not contain the expected executable."
  }

  Move-Item -LiteralPath $InstallDir -Destination $backupDir
  try {
    Move-Item -LiteralPath $payloadDir -Destination $InstallDir
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
    Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue
  } catch {
    if ($newProcess -and -not $newProcess.HasExited) {
      Stop-Process -Id $newProcess.Id -Force -ErrorAction SilentlyContinue
      Wait-Process -Id $newProcess.Id -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $backupDir) {
      Move-Item -LiteralPath $backupDir -Destination $InstallDir
    }
    throw
  }
  Remove-Item -LiteralPath $transactionRoot -Recurse -Force -ErrorAction SilentlyContinue
} catch {
  if (Test-Path -LiteralPath $oldExe -PathType Leaf) {
    Start-Process -FilePath $oldExe -WorkingDirectory $InstallDir -ErrorAction SilentlyContinue
  }
  ($_ | Out-String) | Set-Content -LiteralPath $LogPath -Encoding UTF8
  exit 1
}
`;
}

export async function launchWindowsUpdateHelper({
  zipPath,
  installDir,
  exeName,
  processId,
  spawnImpl = spawn,
} = {}) {
  if (!zipPath || !installDir || !exeName || !Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error("Invalid Windows update helper arguments.");
  }
  const stagingDir = dirname(zipPath);
  const scriptPath = join(stagingDir, "apply-update.ps1");
  const logPath = join(stagingDir, "apply-update-error.log");
  const readyFile = join(stagingDir, "update-ready.json");
  await writeFile(scriptPath, windowsUpdateHelperScript(), "utf8");
  const child = spawnImpl("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-TargetPid", String(processId),
    "-ZipPath", zipPath,
    "-InstallDir", installDir,
    "-ExeName", exeName,
    "-LogPath", logPath,
    "-ReadyFile", readyFile,
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  });
  child.unref?.();
  return { scriptPath, logPath, readyFile };
}
