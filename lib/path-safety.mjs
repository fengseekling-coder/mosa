import * as nodePath from "node:path";

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_DRIVE_PATH_RE = /^[a-z]:[\\/]/i;
const WINDOWS_UNC_PATH_RE = /^\\\\[^\\]+\\[^\\]+/;

/**
 * Return true when a string is an absolute local filesystem path on the
 * current platform or an unmistakable absolute Windows path. The Windows
 * cases are recognized explicitly so shared validation code does not mistake
 * a drive letter (for example C:\\...) for a URL scheme.
 */
export function isAbsoluteLocalPath(value, pathApi = nodePath) {
  if (typeof value !== "string") return false;
  const candidate = value.trim();
  if (!candidate) return false;
  return pathApi.isAbsolute(candidate) || WINDOWS_DRIVE_PATH_RE.test(candidate) || WINDOWS_UNC_PATH_RE.test(candidate);
}

/**
 * Return true only for URL-like strings that are not absolute local paths.
 * This preserves the existing URL rejection while allowing Windows drive and
 * UNC paths through the local-file validation path.
 */
export function isUrlLikePath(value, pathApi = nodePath) {
  if (typeof value !== "string") return false;
  const candidate = value.trim();
  return Boolean(candidate) && !isAbsoluteLocalPath(candidate, pathApi) && URL_SCHEME_RE.test(candidate);
}

/**
 * Return true when candidate is strictly contained by parent. `relative()`
 * may return an absolute path for a different Windows drive, so the explicit
 * `isAbsolute()` guard is required in addition to rejecting `..` traversal.
 */
export function isPathInside(parent, candidate, pathApi = nodePath) {
  if (typeof parent !== "string" || typeof candidate !== "string" || !parent || !candidate) return false;
  const rel = pathApi.relative(pathApi.resolve(parent), pathApi.resolve(candidate));
  return Boolean(rel)
    && !rel.startsWith("..")
    && !pathApi.isAbsolute(rel);
}

/** Return true when candidate equals parent or is contained by it. */
export function isPathInsideOrEqual(parent, candidate, pathApi = nodePath) {
  if (typeof parent !== "string" || typeof candidate !== "string" || !parent || !candidate) return false;
  const rel = pathApi.relative(pathApi.resolve(parent), pathApi.resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !pathApi.isAbsolute(rel));
}

/**
 * Compare filesystem paths using the host path implementation's equality
 * semantics. In particular, path.win32.relative() treats drive/path casing as
 * equivalent on Windows, while POSIX comparisons remain case-sensitive.
 */
export function pathsEqual(left, right, pathApi = nodePath) {
  if (typeof left !== "string" || typeof right !== "string" || !left || !right) return false;
  return pathApi.relative(pathApi.resolve(left), pathApi.resolve(right)) === "";
}
