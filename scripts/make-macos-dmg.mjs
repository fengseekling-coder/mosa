#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MOSA_MAC_APP_NAME = "MOSA";
export const MOSA_MAC_BUNDLE_ID = "com.azhuilab.mosa";
export const MOSA_MAC_ARCH = "arm64";

function nonEmpty(value) {
  return String(value || "").trim();
}

export function macDmgArtifactName(version, arch = MOSA_MAC_ARCH) {
  const cleanVersion = nonEmpty(version);
  const cleanArch = nonEmpty(arch);
  if (!cleanVersion) throw new Error("macOS DMG version is required.");
  if (!/^[0-9A-Za-z._+-]+$/.test(cleanVersion)) throw new Error(`Invalid macOS DMG version: ${cleanVersion}`);
  if (!/^[0-9A-Za-z_-]+$/.test(cleanArch)) throw new Error(`Invalid macOS DMG architecture: ${cleanArch}`);
  return `${MOSA_MAC_APP_NAME}-darwin-${cleanArch}-${cleanVersion}.dmg`;
}

export function macDmgOutputPath({ rootDir, outDir = "out", version, arch = MOSA_MAC_ARCH } = {}) {
  if (!rootDir) throw new Error("rootDir is required.");
  return resolve(rootDir, outDir, "make", "dmg", "darwin", arch, macDmgArtifactName(version, arch));
}

export function assertMacAppMetadata({ bundleId, bundleName, executable, version }, expectedVersion) {
  if (bundleId !== MOSA_MAC_BUNDLE_ID) {
    throw new Error(`Unexpected macOS bundle identifier: ${bundleId || "(missing)"}. Expected ${MOSA_MAC_BUNDLE_ID}.`);
  }
  if (bundleName !== MOSA_MAC_APP_NAME) {
    throw new Error(`Unexpected macOS bundle name: ${bundleName || "(missing)"}. Expected ${MOSA_MAC_APP_NAME}.`);
  }
  if (executable !== MOSA_MAC_APP_NAME) {
    throw new Error(`Unexpected macOS executable name: ${executable || "(missing)"}. Expected ${MOSA_MAC_APP_NAME}.`);
  }
  if (version !== expectedVersion) {
    throw new Error(`Unexpected macOS app version: ${version || "(missing)"}. Expected ${expectedVersion}.`);
  }
  return true;
}

export function macDmgReleaseCredentials(env = process.env) {
  const credentials = {
    identity: nonEmpty(env.MOSA_MACOS_SIGN_IDENTITY),
    appleId: nonEmpty(env.APPLE_ID),
    appleIdPassword: nonEmpty(env.APPLE_APP_SPECIFIC_PASSWORD),
    teamId: nonEmpty(env.APPLE_TEAM_ID),
  };
  const missing = [
    ["MOSA_MACOS_SIGN_IDENTITY", credentials.identity],
    ["APPLE_ID", credentials.appleId],
    ["APPLE_APP_SPECIFIC_PASSWORD", credentials.appleIdPassword],
    ["APPLE_TEAM_ID", credentials.teamId],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`MOSA DMG release requires: ${missing.join(", ")}`);
  return credentials;
}

export function runCommand(command, args, { cwd = process.cwd() } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const renderedArgs = args.map((arg) => JSON.stringify(String(arg))).join(" ");
      const detail = stderr.trim() || stdout.trim() || `exit ${code ?? "?"}${signal ? ` (${signal})` : ""}`;
      rejectPromise(new Error(`${command} ${renderedArgs} failed: ${detail}`));
    });
  });
}

async function readPlistValue(plistPath, key, runner) {
  const result = await runner("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plistPath]);
  return result.stdout.trim();
}

async function readMacAppMetadata(appPath, runner) {
  const plistPath = join(appPath, "Contents", "Info.plist");
  await access(plistPath);
  const [bundleId, bundleName, executable, version] = await Promise.all([
    readPlistValue(plistPath, "CFBundleIdentifier", runner),
    readPlistValue(plistPath, "CFBundleName", runner),
    readPlistValue(plistPath, "CFBundleExecutable", runner),
    readPlistValue(plistPath, "CFBundleShortVersionString", runner),
  ]);
  return { bundleId, bundleName, executable, version };
}

async function verifyMountedDmg({ mountPath, expectedVersion, runner }) {
  const mountedApp = join(mountPath, `${MOSA_MAC_APP_NAME}.app`);
  const applicationsLink = join(mountPath, "Applications");
  await access(mountedApp);
  const link = await lstat(applicationsLink);
  if (!link.isSymbolicLink()) throw new Error("macOS DMG is missing the Applications symlink.");
  const metadata = await readMacAppMetadata(mountedApp, runner);
  assertMacAppMetadata(metadata, expectedVersion);
}

async function signAndNotarizeDmg({ dmgPath, credentials, runner }) {
  await runner("/usr/bin/codesign", [
    "--force",
    "--sign", credentials.identity,
    "--timestamp",
    dmgPath,
  ]);
  await runner("/usr/bin/xcrun", [
    "notarytool", "submit", dmgPath,
    "--apple-id", credentials.appleId,
    "--password", credentials.appleIdPassword,
    "--team-id", credentials.teamId,
    "--wait",
  ]);
  await runner("/usr/bin/xcrun", ["stapler", "staple", dmgPath]);
  await runner("/usr/bin/xcrun", ["stapler", "validate", dmgPath]);
}

export async function makeMacosDmg({
  rootDir = process.cwd(),
  outDir = process.env.MOSA_FORGE_OUT_DIR || "out",
  arch = MOSA_MAC_ARCH,
  release = process.env.MOSA_RELEASE_BUILD === "1",
  platform = process.platform,
  env = process.env,
  runner = runCommand,
} = {}) {
  if (platform !== "darwin") throw new Error("macOS DMG creation must run on macOS.");
  if (arch !== MOSA_MAC_ARCH) throw new Error(`Unsupported MOSA macOS DMG architecture: ${arch}.`);

  const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
  const version = nonEmpty(packageJson.version);
  if (!version) throw new Error("package.json version is required for macOS DMG creation.");

  const appPath = resolve(rootDir, outDir, `${MOSA_MAC_APP_NAME}-darwin-${arch}`, `${MOSA_MAC_APP_NAME}.app`);
  await access(appPath).catch(() => {
    throw new Error(`Packaged macOS app not found: ${appPath}. Run the macOS package step first.`);
  });
  const metadata = await readMacAppMetadata(appPath, runner);
  assertMacAppMetadata(metadata, version);

  let credentials = null;
  if (release) {
    credentials = macDmgReleaseCredentials(env);
    await runner("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  }

  const dmgPath = macDmgOutputPath({ rootDir, outDir, version, arch });
  await mkdir(dirname(dmgPath), { recursive: true });
  await rm(dmgPath, { force: true });

  const scratchRoot = await mkdtemp(join(tmpdir(), "mosa-macos-dmg-"));
  const stagingPath = join(scratchRoot, "volume");
  const mountPath = join(scratchRoot, "mount");
  let mounted = false;
  try {
    await mkdir(stagingPath, { recursive: true });
    await mkdir(mountPath, { recursive: true });
    await runner("/usr/bin/ditto", [appPath, join(stagingPath, `${MOSA_MAC_APP_NAME}.app`)]);
    await symlink("/Applications", join(stagingPath, "Applications"));

    await runner("/usr/bin/hdiutil", [
      "create",
      "-volname", MOSA_MAC_APP_NAME,
      "-srcfolder", stagingPath,
      "-fs", "HFS+",
      "-format", "UDZO",
      "-ov",
      dmgPath,
    ]);

    await runner("/usr/bin/hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-mountpoint", mountPath,
      dmgPath,
    ]);
    mounted = true;
    await verifyMountedDmg({ mountPath, expectedVersion: version, runner });
    await runner("/usr/bin/hdiutil", ["detach", mountPath]);
    mounted = false;

    if (release) await signAndNotarizeDmg({ dmgPath, credentials, runner });
    await access(dmgPath);
    return { dmgPath, appPath, version, bundleId: metadata.bundleId, release };
  } finally {
    if (mounted) {
      await runner("/usr/bin/hdiutil", ["detach", mountPath, "-force"]).catch(() => {});
    }
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

async function main() {
  const result = await makeMacosDmg();
  console.log(`[MOSA] macOS DMG ready: ${result.dmgPath}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`[MOSA] macOS DMG creation failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
