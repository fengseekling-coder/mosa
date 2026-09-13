import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export const MAX_CODEX_SESSION_IMAGE_BYTES = 128 * 1024 * 1024;
const RECOVERY_DIR_NAME = ".codex-session-recovery";
const DEFAULT_ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;

export interface StagedCodexSessionImage {
  path: string;
  root: string;
  extension: string;
  mimeType: string;
  bytes: number;
}

export async function stageCodexSessionImageResult({ assetsRoot, eventKey, result }: {
  assetsRoot: string;
  eventKey: string;
  result: string;
}): Promise<StagedCodexSessionImage> {
  const decoded = decodeCodexSessionImageResult(result);
  const root = resolve(join(resolve(assetsRoot), RECOVERY_DIR_NAME));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const identity = createHash("sha256").update(eventKey).digest("hex").slice(0, 20);
  const target = join(root, `codex-${identity}-${randomBytes(4).toString("hex")}${decoded.extension}`);
  await writeFile(target, decoded.buffer, { flag: "wx", mode: 0o600 });
  return { path: target, root, extension: decoded.extension, mimeType: decoded.mimeType, bytes: decoded.buffer.length };
}

export async function removeCodexSessionStagedImage(staged: StagedCodexSessionImage | null): Promise<void> {
  if (!staged) return;
  const target = resolve(staged.path);
  const root = resolve(staged.root);
  if (!isStrictChild(root, target)) return;
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) return;
    await unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}

export async function cleanupCodexSessionRecoveryRoot(assetsRoot: string, { ttlMs = DEFAULT_ORPHAN_TTL_MS, now = Date.now } = {}): Promise<{ removed: number; failed: number }> {
  const root = resolve(join(resolve(assetsRoot), RECOVERY_DIR_NAME));
  const cutoff = now() - ttlMs;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { removed: 0, failed: 0 }; throw error; }
  let removed = 0;
  let failed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const candidate = join(root, entry.name);
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink() || !info.isFile() || info.mtimeMs > cutoff) continue;
      await unlink(candidate);
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}

export function decodeCodexSessionImageResult(result: string): { buffer: Buffer; extension: string; mimeType: string } {
  const raw = String(result || "").trim();
  if (!raw) throw recoveryError("CODEX_SESSION_IMAGE_EMPTY", "Codex image-generation result is empty.");
  const comma = raw.startsWith("data:") ? raw.indexOf(",") : -1;
  const encoded = comma >= 0 ? raw.slice(comma + 1) : raw;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw recoveryError("CODEX_SESSION_IMAGE_INVALID_BASE64", "Codex image-generation result is not valid base64.");
  }
  const estimatedBytes = Math.floor(encoded.length * 3 / 4);
  if (estimatedBytes <= 0 || estimatedBytes > MAX_CODEX_SESSION_IMAGE_BYTES) {
    throw recoveryError("CODEX_SESSION_IMAGE_TOO_LARGE", "Codex image-generation result exceeds the recovery size limit.");
  }
  const buffer = Buffer.from(encoded, "base64");
  if (!buffer.length || buffer.length > MAX_CODEX_SESSION_IMAGE_BYTES) {
    throw recoveryError("CODEX_SESSION_IMAGE_TOO_LARGE", "Codex image-generation result exceeds the recovery size limit.");
  }
  const format = detectImageFormat(buffer);
  if (!format) throw recoveryError("CODEX_SESSION_IMAGE_UNSUPPORTED", "Codex image-generation result is not a supported image payload.");
  return { buffer, ...format };
}

function detectImageFormat(buffer: Buffer): { extension: string; mimeType: string } | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: ".png", mimeType: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: ".jpg", mimeType: "image/jpeg" };
  }
  if (buffer.length >= 6) {
    const header = buffer.subarray(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") return { extension: ".gif", mimeType: "image/gif" };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return { extension: ".webp", mimeType: "image/webp" };
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("ascii");
    if (brand === "avif" || brand === "avis") return { extension: ".avif", mimeType: "image/avif" };
  }
  return null;
}

function isStrictChild(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return Boolean(rel) && !rel.startsWith("..") && !rel.startsWith("/") && !rel.startsWith("\\");
}

function recoveryError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
