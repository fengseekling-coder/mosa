import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const VISUAL_MODEL_PACK_SCHEMA = "mosa.visual-model-pack/1";
export const VISUAL_MODEL_PACK_MANIFEST = "model-pack.json";
export const MAX_VISUAL_MODEL_PACK_FILES = 64;
export const MAX_VISUAL_MODEL_PACK_BYTES = 512 * 1024 * 1024;

export function visualModelPackRoot(userDataDir) {
  const root = String(userDataDir || "").trim();
  if (!root) throw new Error("Desktop userData directory is required for visual model packs.");
  return join(resolve(root), "visual-model-packs");
}

export function validateVisualModelPackManifest(input) {
  if (!input || input.schema !== VISUAL_MODEL_PACK_SCHEMA) throw modelPackError("INVALID_SCHEMA", "Unsupported visual model pack schema.");
  const id = cleanIdentifier(input.id, "id");
  const revision = cleanIdentifier(input.revision, "revision");
  const modelType = String(input.model_type || "").trim();
  if (modelType !== "image-text-embedding") throw modelPackError("INVALID_MODEL_TYPE", "Visual model pack must use image-text-embedding.");
  const embeddingDimension = Number(input.embedding_dimension);
  if (!Number.isInteger(embeddingDimension) || embeddingDimension <= 0 || embeddingDimension > 8192) {
    throw modelPackError("INVALID_EMBEDDING_DIMENSION", "Visual model pack embedding_dimension must be between 1 and 8192.");
  }

  const license = input.license && typeof input.license === "object" ? input.license : {};
  const licenseId = String(license.id || "").trim();
  const licenseSource = String(license.source || "").trim();
  if (!licenseId || !licenseSource) throw modelPackError("LICENSE_MISSING", "Visual model pack license id and source are required.");
  if (license.commercial_product_use !== true) {
    throw modelPackError("LICENSE_PRODUCT_USE_UNCONFIRMED", "Visual model pack must explicitly confirm product/commercial use.");
  }

  if (!Array.isArray(input.files) || !input.files.length || input.files.length > MAX_VISUAL_MODEL_PACK_FILES) {
    throw modelPackError("INVALID_FILES", "Visual model pack files must contain 1-64 entries.");
  }
  const seen = new Set();
  const files = input.files.map((entry) => {
    const path = normalizeRelativePackPath(entry?.path);
    if (seen.has(path)) throw modelPackError("DUPLICATE_FILE", "Visual model pack file paths must be unique.");
    seen.add(path);
    const sha256 = String(entry?.sha256 || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw modelPackError("INVALID_SHA256", "Visual model pack file sha256 must be a 64-character hex digest.");
    const bytes = Number(entry?.bytes);
    if (!Number.isInteger(bytes) || bytes < 0) throw modelPackError("INVALID_FILE_SIZE", "Visual model pack file bytes must be a non-negative integer.");
    const role = String(entry?.role || "").trim();
    if (!role) throw modelPackError("INVALID_FILE_ROLE", "Visual model pack file role is required.");
    return { path, sha256, bytes, role };
  });
  const totalBytes = files.reduce((sum, entry) => sum + entry.bytes, 0);
  if (totalBytes > MAX_VISUAL_MODEL_PACK_BYTES) {
    throw modelPackError("MODEL_PACK_TOO_LARGE", "Visual model pack exceeds the 512 MiB first-stage budget.");
  }

  return {
    schema: VISUAL_MODEL_PACK_SCHEMA,
    id,
    revision,
    model_type: modelType,
    embedding_dimension: embeddingDimension,
    license: {
      id: licenseId,
      source: licenseSource,
      commercial_product_use: true,
      notice: String(license.notice || "").trim(),
    },
    preprocessing: input.preprocessing && typeof input.preprocessing === "object" && !Array.isArray(input.preprocessing)
      ? structuredClone(input.preprocessing)
      : {},
    files,
    total_bytes: totalBytes,
  };
}

export async function verifyVisualModelPack({ packDir }) {
  const rawPackDir = String(packDir || "").trim();
  if (!rawPackDir) throw modelPackError("PACK_DIR_REQUIRED", "Visual model pack directory is required.");
  const root = resolve(rawPackDir);
  const manifestPath = join(root, VISUAL_MODEL_PACK_MANIFEST);
  const manifest = validateVisualModelPackManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const rootReal = await realpath(root);
  const checked = [];

  for (const entry of manifest.files) {
    const absolute = resolve(root, entry.path);
    assertContained(root, absolute, entry.path);
    const linkInfo = await lstat(absolute);
    if (linkInfo.isSymbolicLink()) throw modelPackError("SYMLINK_REJECTED", "Visual model pack files must not be symbolic links: " + entry.path);
    if (!linkInfo.isFile()) throw modelPackError("NOT_A_FILE", "Visual model pack entry is not a regular file: " + entry.path);
    const real = await realpath(absolute);
    assertContained(rootReal, real, entry.path);
    const info = await stat(real);
    if (info.size !== entry.bytes) throw modelPackError("FILE_SIZE_MISMATCH", "Visual model pack file size mismatch: " + entry.path);
    const sha256 = await sha256File(real);
    if (sha256 !== entry.sha256) throw modelPackError("HASH_MISMATCH", "Visual model pack hash mismatch: " + entry.path);
    checked.push({ ...entry, absolute_path: real });
  }

  return {
    ok: true,
    schema: manifest.schema,
    id: manifest.id,
    revision: manifest.revision,
    model_type: manifest.model_type,
    embedding_dimension: manifest.embedding_dimension,
    license: manifest.license,
    total_bytes: manifest.total_bytes,
    files: checked,
  };
}

function normalizeRelativePackPath(value) {
  const candidate = String(value || "").trim().replaceAll("\\", "/");
  if (!candidate || isAbsolute(candidate) || candidate.startsWith("/") || candidate.includes("\0")) {
    throw modelPackError("INVALID_FILE_PATH", "Visual model pack file path must be relative.");
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw modelPackError("INVALID_FILE_PATH", "Visual model pack file path must not contain traversal or empty segments.");
  }
  return segments.join("/");
}

function assertContained(root, candidate, displayPath) {
  const rel = relative(resolve(root), resolve(candidate));
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw modelPackError("PATH_ESCAPE", "Visual model pack file escapes the pack directory: " + displayPath);
  }
}

function cleanIdentifier(value, field) {
  const candidate = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(candidate)) {
    throw modelPackError("INVALID_IDENTIFIER", "Visual model pack " + field + " is invalid.");
  }
  return candidate;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function modelPackError(code, message) {
  const error = new Error(message);
  error.code = "VISUAL_MODEL_PACK_" + code;
  return error;
}
