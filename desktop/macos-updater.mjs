import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createMosaMacosUpdateHelperHandoff,
  mosaDesktopStartupHandoffPath,
} from "../lib/runtime-handoff.mjs";
import { normalizeDesktopDistribution } from "../lib/release-distribution.mjs";

export const MOSA_MACOS_DOWNLOAD_BASE_URL = "https://mosa.azhuilab.com/downloads/";
const MAX_MACOS_UPDATE_BYTES = 1_500_000_000;
const DEFAULT_MACOS_UPDATE_IDLE_TIMEOUT_MS = 30_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

function safeVersion(value) {
  const version = String(value || "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Invalid macOS update version.");
  return version;
}

function safeBuildIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("macOS update build identity is missing.");
  const gitSha = String(value.gitSha || "").trim().toLowerCase();
  const uiFingerprint = String(value.uiFingerprint || "").trim().toLowerCase();
  const runtimeFingerprint = String(value.runtimeFingerprint || "").trim().toLowerCase();
  const distribution = normalizeDesktopDistribution(value.distribution, { defaultValue: "preview", releaseOnly: true });
  if (!GIT_SHA_PATTERN.test(gitSha) || !SHA256_PATTERN.test(uiFingerprint) || !SHA256_PATTERN.test(runtimeFingerprint)) {
    throw new Error("macOS update build identity is invalid.");
  }
  return { gitSha, uiFingerprint, runtimeFingerprint, distribution };
}

export function validateMacosUpdateArtifact(input, version) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("macOS update artifact is missing.");
  const normalizedVersion = safeVersion(version);
  const expectedFile = `MOSA-darwin-arm64-${normalizedVersion}.zip`;
  const file = String(input.file || "").trim();
  const size = Number(input.size);
  const sha256 = String(input.sha256 || "").trim().toLowerCase();
  if (String(input.platform || "").trim() !== "macOS") throw new Error("macOS update artifact has an unexpected platform.");
  if (String(input.arch || "").trim() !== "arm64") throw new Error("macOS update artifact has an unexpected architecture.");
  if (file !== expectedFile) throw new Error("macOS update artifact filename does not match the release version.");
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_MACOS_UPDATE_BYTES) throw new Error("macOS update artifact has an invalid size.");
  if (!SHA256_PATTERN.test(sha256)) throw new Error("macOS update artifact has an invalid SHA-256 digest.");
  return { platform: "macOS", arch: "arm64", file, size, sha256 };
}

export function macosUpdateDownloadUrl(artifact) {
  const file = String(artifact?.file || "").trim();
  if (!/^MOSA-darwin-arm64-[0-9A-Za-z.-]+\.zip$/.test(file)) throw new Error("Unsafe macOS update filename.");
  return new URL(encodeURIComponent(file), MOSA_MACOS_DOWNLOAD_BASE_URL).toString();
}

export function resolveMacosInstallAppPath(execPath = process.execPath) {
  const executable = resolve(String(execPath || ""));
  const marker = "/Contents/MacOS/";
  const index = executable.lastIndexOf(marker);
  if (index <= 0) return null;
  const appPath = executable.slice(0, index);
  return appPath.endsWith("/MOSA.app") ? appPath : null;
}

export async function downloadMacosUpdate({
  artifact,
  version,
  stagingRoot,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  signal,
  idleTimeoutMs = DEFAULT_MACOS_UPDATE_IDLE_TIMEOUT_MS,
} = {}) {
  const safeArtifact = validateMacosUpdateArtifact(artifact, version);
  if (typeof fetchImpl !== "function") throw new Error("macOS update download is unavailable.");
  const normalizedVersion = safeVersion(version);
  const stagingDir = join(stagingRoot, normalizedVersion);
  const partialPath = join(stagingDir, `${safeArtifact.file}.partial`);
  const zipPath = join(stagingDir, safeArtifact.file);
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  const controller = new AbortController();
  let activeSource = null;
  let idleTimer = null;
  let timedOut = false;
  const timeoutMs = Math.max(1000, Number(idleTimeoutMs) || DEFAULT_MACOS_UPDATE_IDLE_TIMEOUT_MS);
  const timeoutError = () => Object.assign(new Error("macOS update download stalled."), { code: "MACOS_UPDATE_DOWNLOAD_TIMEOUT" });
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
    const reason = signal?.reason instanceof Error ? signal.reason : new Error("macOS update download cancelled.");
    controller.abort(reason);
    activeSource?.destroy?.(reason);
  };
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener?.("abort", abortFromCaller, { once: true });
  armIdleTimeout();

  try {
    const response = await fetchImpl(macosUpdateDownloadUrl(safeArtifact), {
      method: "GET",
      headers: {
        accept: "application/zip, application/octet-stream",
        "accept-encoding": "identity",
        "cache-control": "no-cache",
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response?.ok) throw new Error(`macOS update download returned HTTP ${response?.status || 0}.`);
    const contentLength = Number(response.headers?.get?.("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > 0 && contentLength !== safeArtifact.size) {
      throw new Error("macOS update download size does not match the release manifest.");
    }
    activeSource = readableBody(response.body);
    if (!activeSource) throw new Error("macOS update response has no readable body.");
    armIdleTimeout();

    const hash = createHash("sha256");
    let receivedBytes = 0;
    let lastReportedPercent = -1;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        armIdleTimeout();
        receivedBytes += chunk.length;
        if (receivedBytes > safeArtifact.size) return callback(new Error("macOS update download exceeded the expected size."));
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
    if (receivedBytes !== safeArtifact.size) throw new Error("macOS update download is incomplete.");
    if (hash.digest("hex") !== safeArtifact.sha256) throw new Error("macOS update SHA-256 verification failed.");
    await rename(partialPath, zipPath);
    onProgress({ receivedBytes, totalBytes: safeArtifact.size, percent: 100 });
    return { stagingDir, zipPath, artifact: safeArtifact };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    if (timedOut && error?.code !== "MACOS_UPDATE_DOWNLOAD_TIMEOUT") throw timeoutError();
    throw error;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    signal?.removeEventListener?.("abort", abortFromCaller);
  }
}

export function resolveMacosUpdateReadyFile(argv = process.argv, stagingRoot = "") {
  const prefix = "--mosa-update-ready-file=";
  const raw = (Array.isArray(argv) ? argv : []).find((value) => String(value).startsWith(prefix));
  if (!raw || !stagingRoot) return null;
  const candidate = resolve(String(raw).slice(prefix.length));
  const root = resolve(stagingRoot);
  return candidate === root || candidate.startsWith(`${root}/`) ? candidate : null;
}

export function macosUpdateHelperScript() {
  return String.raw`#!/bin/sh
set -eu

TARGET_PID="$1"
ZIP_PATH="$2"
INSTALL_APP="$3"
EXPECTED_VERSION="$4"
EXPECTED_GIT_SHA="$5"
EXPECTED_UI_FINGERPRINT="$6"
EXPECTED_RUNTIME_FINGERPRINT="$7"
LOG_PATH="$8"
READY_FILE="$9"
shift 9
HANDOFF_FILE="$1"
EXPECTED_DISTRIBUTION="$2"

PARENT_DIR="$(dirname "$INSTALL_APP")"
TRANSACTION_ROOT="$PARENT_DIR/.MOSA-update-$(date +%s)-$$"
EXTRACT_DIR="$TRANSACTION_ROOT/extracted"
REPLACEMENT_APP="$TRANSACTION_ROOT/replacement.app"
BACKUP_APP="$TRANSACTION_ROOT/previous.app"
FAILED_APP="$TRANSACTION_ROOT/failed.app"
MOVED_ORIGINAL=0
NEW_PID=""

rollback() {
  rm -f "$HANDOFF_FILE" 2>/dev/null || true
  if [ -n "$NEW_PID" ] && kill -0 "$NEW_PID" 2>/dev/null; then
    kill -TERM "$NEW_PID" 2>/dev/null || true
    i=0
    while kill -0 "$NEW_PID" 2>/dev/null && [ "$i" -lt 40 ]; do sleep 0.25; i=$((i + 1)); done
  fi
  if [ "$MOVED_ORIGINAL" -eq 1 ] && [ -d "$BACKUP_APP" ]; then
    if [ -e "$INSTALL_APP" ]; then mv "$INSTALL_APP" "$FAILED_APP" 2>/dev/null || rm -rf "$INSTALL_APP"; fi
    mv "$BACKUP_APP" "$INSTALL_APP"
    /usr/bin/open -n "$INSTALL_APP" >/dev/null 2>&1 || true
  fi
}

trap 'code=$?; rollback; echo "macOS update helper failed (exit $code)" > "$LOG_PATH"; exit $code' HUP INT TERM EXIT

while kill -0 "$TARGET_PID" 2>/dev/null; do sleep 0.25; done

mkdir -p "$EXTRACT_DIR"
/usr/bin/ditto -x -k "$ZIP_PATH" "$EXTRACT_DIR"
PAYLOAD_APP="$EXTRACT_DIR/MOSA.app"
test -x "$PAYLOAD_APP/Contents/MacOS/MOSA"

BUNDLE_ID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PAYLOAD_APP/Contents/Info.plist")
VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PAYLOAD_APP/Contents/Info.plist")
[ "$BUNDLE_ID" = "com.azhuilab.mosa" ]
[ "$VERSION" = "$EXPECTED_VERSION" ]
/usr/bin/codesign --verify --deep --strict "$PAYLOAD_APP"
PAYLOAD_CODESIGN=$(/usr/bin/codesign -dv --verbose=4 "$PAYLOAD_APP" 2>&1)
if [ "$EXPECTED_DISTRIBUTION" = "production" ]; then
  OLD_TEAM=$(/usr/bin/codesign -dv --verbose=4 "$INSTALL_APP" 2>&1 | /usr/bin/sed -n 's/^TeamIdentifier=//p' | /usr/bin/head -n 1)
  test -n "$OLD_TEAM"
  NEW_TEAM=$(printf '%s\n' "$PAYLOAD_CODESIGN" | /usr/bin/sed -n 's/^TeamIdentifier=//p' | /usr/bin/head -n 1)
  [ "$NEW_TEAM" = "$OLD_TEAM" ]
  printf '%s\n' "$PAYLOAD_CODESIGN" | /usr/bin/grep -q 'flags=.*runtime'
  /usr/sbin/spctl -a -vv --type execute "$PAYLOAD_APP"
else
  [ "$EXPECTED_DISTRIBUTION" = "preview" ]
fi

/usr/bin/ditto "$PAYLOAD_APP" "$REPLACEMENT_APP"
mv "$INSTALL_APP" "$BACKUP_APP"
MOVED_ORIGINAL=1
mv "$REPLACEMENT_APP" "$INSTALL_APP"
rm -f "$READY_FILE"

/usr/bin/open -n "$INSTALL_APP" --args "--mosa-update-ready-file=$READY_FILE"
i=0
while [ "$i" -lt 180 ]; do
  if [ -f "$READY_FILE" ]; then
    READY_VERSION=$(/usr/bin/plutil -extract version raw -o - "$READY_FILE")
    READY_GIT_SHA=$(/usr/bin/plutil -extract gitSha raw -o - "$READY_FILE")
    READY_UI_FINGERPRINT=$(/usr/bin/plutil -extract uiFingerprint raw -o - "$READY_FILE")
    READY_RUNTIME_FINGERPRINT=$(/usr/bin/plutil -extract runtimeFingerprint raw -o - "$READY_FILE")
    READY_DISTRIBUTION=$(/usr/bin/plutil -extract distribution raw -o - "$READY_FILE")
    [ "$READY_VERSION" = "$EXPECTED_VERSION" ]
    [ "$READY_GIT_SHA" = "$EXPECTED_GIT_SHA" ]
    [ "$READY_UI_FINGERPRINT" = "$EXPECTED_UI_FINGERPRINT" ]
    [ "$READY_RUNTIME_FINGERPRINT" = "$EXPECTED_RUNTIME_FINGERPRINT" ]
    [ "$READY_DISTRIBUTION" = "$EXPECTED_DISTRIBUTION" ]
    trap - HUP INT TERM EXIT
    rm -f "$HANDOFF_FILE" 2>/dev/null || true
    rm -rf "$TRANSACTION_ROOT"
    exit 0
  fi
  if [ -z "$NEW_PID" ]; then
    NEW_PID=$(/usr/bin/pgrep -f "^$INSTALL_APP/Contents/MacOS/MOSA" | /usr/bin/head -n 1 || true)
  elif ! kill -0 "$NEW_PID" 2>/dev/null; then
    exit 31
  fi
  sleep 0.25
  i=$((i + 1))
done
exit 32
`;
}

export async function launchMacosUpdateHelper({
  zipPath,
  installAppPath,
  version,
  expectedIdentity,
  processId,
  libraryDir,
  spawnImpl = spawn,
  createUpdateHandoff = createMosaMacosUpdateHelperHandoff,
} = {}) {
  const identity = safeBuildIdentity(expectedIdentity);
  if (!zipPath || !installAppPath || !safeVersion(version) || !Number.isSafeInteger(processId) || processId <= 0 || !libraryDir) {
    throw new Error("Invalid macOS update helper arguments.");
  }
  const stagingDir = dirname(zipPath);
  const scriptPath = join(stagingDir, "apply-update.sh");
  const logPath = join(stagingDir, "apply-update-error.log");
  const readyFile = join(stagingDir, "update-ready.json");
  const handoffFile = mosaDesktopStartupHandoffPath(libraryDir);
  await writeFile(scriptPath, macosUpdateHelperScript(), { encoding: "utf8", mode: 0o700 });
  const child = spawnImpl("/bin/sh", [
    scriptPath,
    String(processId),
    zipPath,
    installAppPath,
    safeVersion(version),
    identity.gitSha,
    identity.uiFingerprint,
    identity.runtimeFingerprint,
    logPath,
    readyFile,
    handoffFile,
    identity.distribution,
  ], {
    detached: true,
    stdio: "ignore",
  });
  await new Promise((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  });
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    child.kill?.("SIGTERM");
    throw new Error("macOS update helper did not expose a valid process id.");
  }
  try {
    await createUpdateHandoff({ libraryDir, pid: child.pid });
  } catch (error) {
    child.kill?.("SIGTERM");
    throw error;
  }
  child.unref?.();
  return { scriptPath, logPath, readyFile, handoffFile, helperPid: child.pid };
}

function readableBody(body) {
  if (!body) return null;
  if (typeof body.getReader === "function") return Readable.fromWeb(body);
  if (typeof body.pipe === "function" || body[Symbol.asyncIterator]) return body;
  return null;
}
