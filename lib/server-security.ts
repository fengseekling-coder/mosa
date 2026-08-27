import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

export function isAllowedLocalOrigin(origin: unknown, port: number | string): boolean {
  if (!origin) return true;
  const allowedOrigins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);
  return allowedOrigins.has(String(origin));
}

export function parseAllowedIngestOrigins(value: unknown): string[] {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(values
    .map((entry) => String(entry || "").trim())
    .filter((entry) => /^(chrome-extension|moz-extension):\/\/[a-z0-9-]+$/i.test(entry)))];
}

/** Origins allowed for an explicitly approved local browser extension. */
export function isAllowedIngestOrigin(
  origin: unknown,
  port: number | string,
  allowedExtensionOrigins: unknown = [],
): boolean {
  if (isAllowedLocalOrigin(origin, port)) return true;
  if (!origin) return true;
  return parseAllowedIngestOrigins(allowedExtensionOrigins).includes(String(origin));
}

/** Extension-only check used by explicit pairing routes. Unlike normal ingest
 * requests, pairing must never accept an absent/local-page Origin implicitly. */
export function isApprovedExtensionOrigin(origin: unknown, allowedExtensionOrigins: unknown = []): boolean {
  if (!origin) return false;
  return parseAllowedIngestOrigins(allowedExtensionOrigins).includes(String(origin));
}

export function resolveAllowedFolderPath(requestedPath: unknown, allowedPaths: unknown): string | null {
  if (typeof requestedPath !== "string" || !requestedPath.trim() || !Array.isArray(allowedPaths)) return null;

  let candidate: string;
  try {
    candidate = realpathSync(resolve(requestedPath));
  } catch {
    return null;
  }

  for (const allowedPath of allowedPaths) {
    if (!allowedPath) continue;
    let root;
    try {
      root = realpathSync(resolve(String(allowedPath)));
    } catch {
      continue;
    }
    const pathFromRoot = relative(root, candidate);
    if (pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))) {
      return candidate;
    }
  }
  return null;
}
