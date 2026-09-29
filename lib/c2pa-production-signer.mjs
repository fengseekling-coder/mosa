import { X509Certificate, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const C2PA_SIGNER_ALGORITHMS = Object.freeze([
  "ps256", "ps384", "ps512",
  "es256", "es384", "es512",
  "ed25519",
]);

const CERTIFICATE_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu;
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:EC |RSA )?PRIVATE KEY-----/iu;
const MAX_SIGNER_INFO_BYTES = 256 * 1024;
const MAX_RESERVE_SIZE = 4 * 1024 * 1024;

export async function preflightC2paProductionSigner({
  signerPath,
  runner = runC2paSignerInfo,
  timeoutMs = 10_000,
  env = process.env,
} = {}) {
  const executable = await validateSignerExecutable(signerPath);
  const result = await runner(executable, { timeoutMs, env: sanitizedSignerEnvironment(env) });
  const info = parseSignerInfo(result?.stdout);
  if (PRIVATE_KEY_PATTERN.test(String(result?.stdout || "")) || PRIVATE_KEY_PATTERN.test(String(result?.stderr || ""))) {
    throw signerError("PRIVATE_KEY_LEAK", "C2PA signer info output must never contain private-key material.");
  }
  const algorithm = String(info.alg || "").trim().toLowerCase();
  if (!C2PA_SIGNER_ALGORITHMS.includes(algorithm)) {
    throw signerError("ALGORITHM_UNSUPPORTED", `Unsupported C2PA signer algorithm: ${algorithm || "(empty)"}.`);
  }
  const certPem = String(info.sign_cert || "").trim();
  const certificateBlocks = certPem.match(CERTIFICATE_PATTERN) || [];
  if (!certificateBlocks.length || certificateBlocks.join("\n").replace(/\s+/gu, "") !== certPem.replace(/\s+/gu, "")) {
    throw signerError("CERTIFICATE_INVALID", "C2PA signer info must contain only a PEM certificate chain in sign_cert.");
  }
  const certificates = certificateBlocks.map((pem, index) => {
    try {
      return new X509Certificate(pem);
    } catch (error) {
      throw signerError("CERTIFICATE_INVALID", `C2PA signer certificate ${index + 1} is invalid: ${error?.message || error}`);
    }
  });
  const reserveSize = info.reserve_size == null ? null : Number(info.reserve_size);
  if (reserveSize != null && (!Number.isSafeInteger(reserveSize) || reserveSize <= 0 || reserveSize > MAX_RESERVE_SIZE)) {
    throw signerError("RESERVE_SIZE_INVALID", `C2PA signer reserve_size must be between 1 and ${MAX_RESERVE_SIZE} bytes.`);
  }
  const tsaUrl = String(info.tsa_url || "").trim();
  if (tsaUrl) {
    let parsed;
    try { parsed = new URL(tsaUrl); } catch { throw signerError("TSA_URL_INVALID", "C2PA signer tsa_url must be a valid HTTPS URL."); }
    if (parsed.protocol !== "https:") throw signerError("TSA_URL_INVALID", "C2PA signer tsa_url must use HTTPS.");
  }
  const leaf = certificates[0];
  return Object.freeze({
    ok: true,
    executable,
    algorithm,
    certificate_chain_length: certificates.length,
    certificate_sha256: sha256(leaf.raw),
    certificate_subject: leaf.subject,
    certificate_issuer: leaf.issuer,
    certificate_valid_from: leaf.validFrom,
    certificate_valid_to: leaf.validTo,
    tsa_url: tsaUrl || null,
    reserve_size: reserveSize,
  });
}

export async function runC2paSignerInfo(executable, { timeoutMs = 10_000, env = process.env } = {}) {
  try {
    return await execFileAsync(executable, ["--signer-info"], {
      env,
      timeout: Math.max(1000, Number(timeoutMs) || 10_000),
      maxBuffer: MAX_SIGNER_INFO_BYTES,
      encoding: "utf8",
      windowsHide: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT") throw signerError("NOT_FOUND", `C2PA production signer was not found: ${executable}`);
    throw signerError("INFO_FAILED", `C2PA production signer --signer-info failed: ${String(error?.stderr || error?.message || error).trim()}`);
  }
}

export function sanitizedSignerEnvironment(env = process.env) {
  const clean = { ...env };
  delete clean.C2PA_PRIVATE_KEY;
  delete clean.C2PA_SIGN_CERT;
  delete clean.C2PATOOL_SETTINGS;
  return clean;
}

export async function validateSignerExecutable(value) {
  const raw = String(value || "").trim();
  if (!raw) throw signerError("PATH_REQUIRED", "C2PA production signer path is required.");
  if (!isAbsolute(raw)) throw signerError("PATH_NOT_ABSOLUTE", "C2PA production signer path must be absolute.");
  if (/\s/u.test(raw)) {
    throw signerError("PATH_WHITESPACE_UNSUPPORTED", "C2PA production signer path must not contain whitespace in the current backend contract.");
  }
  const absolute = resolve(raw);
  const link = await lstat(absolute).catch(() => null);
  if (!link) throw signerError("NOT_FOUND", `C2PA production signer was not found: ${absolute}`);
  if (link.isSymbolicLink()) throw signerError("SYMLINK_REJECTED", "C2PA production signer must not be a symbolic link.");
  if (!link.isFile()) throw signerError("NOT_A_FILE", "C2PA production signer must be a regular file.");
  const real = await realpath(absolute);
  const info = await stat(real);
  if (!info.isFile() || info.size <= 0) throw signerError("NOT_A_FILE", "C2PA production signer must be a non-empty regular file.");
  return real;
}

function parseSignerInfo(stdout) {
  const raw = String(stdout || "").trim();
  if (!raw) throw signerError("INFO_EMPTY", "C2PA production signer returned an empty --signer-info response.");
  if (Buffer.byteLength(raw, "utf8") > MAX_SIGNER_INFO_BYTES) throw signerError("INFO_TOO_LARGE", "C2PA production signer info response is too large.");
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw signerError("INFO_INVALID_JSON", "C2PA production signer info response is not valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw signerError("INFO_INVALID", "C2PA production signer info must be a JSON object.");
  return parsed;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function signerError(code, message) {
  const error = new Error(message);
  error.code = `C2PA_SIGNER_${code}`;
  return error;
}
