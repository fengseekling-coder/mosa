import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  C2PA_HELPER_PACK_SCHEMA,
  c2paHelperTarget,
  validateC2paHelperPackManifest,
  verifyC2paHelperPack,
} from "../lib/c2pa-helper-pack.mjs";

const execFileAsync = promisify(execFile);

export async function prepareC2paHelperPack({
  binaryPath,
  version,
  licenseFiles = [],
  outputDir,
  licenseId = "MIT OR Apache-2.0",
  force = false,
  platform = process.platform,
  arch = process.arch,
  probeRunner = probeC2paToolVersion,
  upstreamRepository = "https://github.com/contentauth/c2pa-rs",
} = {}) {
  const target = c2paHelperTarget(platform, arch);
  if (!target) throw packError("TARGET_UNSUPPORTED", `Unsupported C2PA helper build target: ${platform}-${arch}.`);
  const binary = resolveRequiredFile(binaryPath, "binary");
  const output = resolveRequiredPath(outputDir, "output directory");
  const expectedVersion = normalizeVersion(version);
  const nativeName = platform === "win32" ? "c2patool.exe" : "c2patool";
  if (basename(binary).toLowerCase() !== nativeName) {
    throw packError("BINARY_NAME_INVALID", `Expected native c2patool binary named ${nativeName}.`);
  }
  const binaryInfo = await stat(binary).catch(() => null);
  if (!binaryInfo?.isFile() || binaryInfo.size <= 0) throw packError("BINARY_MISSING", "c2patool binary is missing or empty.");
  const probedVersion = parseReportedVersion(await probeRunner(binary));
  if (probedVersion !== expectedVersion) {
    throw packError("VERSION_MISMATCH", `c2patool reports ${probedVersion}, expected ${expectedVersion}.`);
  }
  if (!Array.isArray(licenseFiles) || licenseFiles.length < 1 || licenseFiles.length > 4) {
    throw packError("LICENSE_REQUIRED", "At least one upstream license file is required.");
  }
  const resolvedLicenses = [];
  for (const value of licenseFiles) {
    const path = resolveRequiredFile(value, "license file");
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size <= 0) throw packError("LICENSE_MISSING", `License file is missing or empty: ${path}`);
    resolvedLicenses.push(path);
  }

  const cleanLicenseId = String(licenseId || "").trim();
  if (!cleanLicenseId) throw packError("ARGUMENT_REQUIRED", "licenseId is required.");

  // The output layout is generated exclusively by this script, but the path
  // comes from the caller: refuse to wipe pre-existing content unless the
  // caller explicitly accepts it with force.
  if (!force) {
    const existing = await readdir(output).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    if (existing.length > 0) {
      throw packError("OUTPUT_NOT_EMPTY", `Output directory is not empty: ${output}. Pass --force to replace its contents.`);
    }
  }
  await rm(output, { recursive: true, force: true });
  await mkdir(join(output, "bin"), { recursive: true });
  await mkdir(join(output, "licenses"), { recursive: true });
  const executableRelative = `bin/${nativeName}`;
  const executableOutput = join(output, "bin", nativeName);
  await copyFile(binary, executableOutput);
  if (platform === "darwin") await chmod(executableOutput, 0o755);

  const files = [await describeFile(executableOutput, executableRelative, "executable")];
  const usedLicenseNames = new Set();
  for (const licensePath of resolvedLicenses) {
    const safeName = safeLicenseName(basename(licensePath), usedLicenseNames);
    const relativePath = `licenses/${safeName}`;
    const destination = join(output, "licenses", safeName);
    await copyFile(licensePath, destination);
    files.push(await describeFile(destination, relativePath, "license"));
  }
  const noticeRelative = "THIRD_PARTY_NOTICE.txt";
  const notice = [
    `c2patool ${expectedVersion}`,
    `Upstream: ${upstreamRepository}`,
    `License: ${cleanLicenseId}`,
    "This MOSA helper pack redistributes an unmodified upstream c2patool executable with the supplied upstream license files.",
    "",
  ].join("\n");
  const noticePath = join(output, noticeRelative);
  await writeFile(noticePath, notice, "utf8");
  files.push(await describeFile(noticePath, noticeRelative, "notice"));

  const manifest = validateC2paHelperPackManifest({
    schema: C2PA_HELPER_PACK_SCHEMA,
    id: "c2patool",
    version: expectedVersion,
    target,
    executable: executableRelative,
    upstream: `${upstreamRepository}/releases/tag/c2patool-v${expectedVersion}`,
    license: {
      id: cleanLicenseId,
      source: upstreamRepository,
    },
    files,
  });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestPath = join(output, "helper-pack.json");
  await writeFile(manifestPath, manifestBytes);
  const verified = await verifyC2paHelperPack({ packDir: output, platform, arch });

  return {
    pack: verified,
    release_manifest_patch: {
      helperPacks: {
        c2patool: {
          [target]: {
            version: expectedVersion,
            totalSize: manifest.total_bytes,
            manifest: {
              size: manifestBytes.length,
              sha256: sha256(manifestBytes),
            },
            license: {
              id: manifest.license.id,
              source: manifest.license.source,
            },
          },
        },
      },
    },
  };
}

export async function probeC2paToolVersion(binaryPath) {
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, ["-V"], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const text = `${stdout || ""}\n${stderr || ""}`;
    const match = /(?:c2patool\s+)?v?(\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?)/iu.exec(text);
    if (!match) throw new Error("version output was not recognized");
    return match[1];
  } catch (error) {
    throw packError("PROBE_FAILED", `Unable to run c2patool -V: ${error?.message || error}`);
  }
}

function parseArgs(argv) {
  const options = { licenses: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    if (arg === "--binary") options.binary = next();
    else if (arg === "--version") options.version = next();
    else if (arg === "--license") options.licenses.push(next());
    else if (arg === "--license-id") options.licenseId = next();
    else if (arg === "--output") options.output = next();
    else if (arg === "--force") options.force = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await prepareC2paHelperPack({
    binaryPath: args.binary,
    version: args.version,
    licenseFiles: args.licenses,
    outputDir: args.output,
    licenseId: args.licenseId,
    force: args.force,
  });
  process.stdout.write(`${JSON.stringify(result.release_manifest_patch, null, 2)}\n`);
}

function resolveRequiredPath(value, label) {
  const raw = String(value || "").trim();
  if (!raw) throw packError("ARGUMENT_REQUIRED", `${label} is required.`);
  return resolve(raw);
}

function resolveRequiredFile(value, label) {
  return resolveRequiredPath(value, label);
}

function normalizeVersion(value) {
  const version = String(value || "").trim().replace(/^v/u, "");
  if (!/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/iu.test(version)) throw packError("VERSION_INVALID", "c2patool version is invalid.");
  return version;
}

function parseReportedVersion(value) {
  const raw = String(value || "").trim();
  const match = /(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?)(?:\s|$)/iu.exec(raw);
  if (!match) throw packError("VERSION_INVALID", "c2patool version is invalid.");
  return normalizeVersion(match[1]);
}

function safeLicenseName(value, used) {
  const base = String(value || "LICENSE").replace(/[^a-z0-9._-]+/giu, "-").replace(/^-+|-+$/gu, "") || "LICENSE";
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${base}-${suffix++}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

async function describeFile(path, relativePath, role) {
  const bytes = await readFile(path);
  return { path: relativePath, role, bytes: bytes.length, sha256: sha256(bytes) };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function packError(code, message) {
  const error = new Error(message);
  error.code = `C2PA_HELPER_PREPARE_${code}`;
  return error;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
