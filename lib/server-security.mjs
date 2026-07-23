import { isAbsolute, relative, resolve, sep } from "node:path";

export function isAllowedLocalOrigin(origin, port) {
  if (!origin) return true;
  const allowedOrigins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);
  return allowedOrigins.has(origin);
}

export function resolveAllowedFolderPath(requestedPath, allowedPaths) {
  if (typeof requestedPath !== "string" || !requestedPath.trim()) return null;

  let candidate;
  try {
    candidate = resolve(requestedPath);
  } catch {
    return null;
  }

  for (const allowedPath of allowedPaths) {
    if (!allowedPath) continue;
    const root = resolve(allowedPath);
    const pathFromRoot = relative(root, candidate);
    if (pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))) {
      return candidate;
    }
  }
  return null;
}
