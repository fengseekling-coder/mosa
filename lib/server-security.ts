import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";

const CLIENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

export function normalizeMosaClientToken(value: unknown): string {
  const token = String(value || "").trim();
  if (!token) return "";
  if (!CLIENT_TOKEN_PATTERN.test(token)) {
    throw new Error("MOSA client token must be a 32-byte-or-stronger base64url secret.");
  }
  return token;
}

export function isAuthorizedMosaClientToken(provided: unknown, configured: unknown): boolean {
  const left = String(provided || "").trim();
  const right = String(configured || "").trim();
  if (!left || !right) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function mosaClientTokenFingerprint(value: unknown): string {
  const token = normalizeMosaClientToken(value);
  return token ? createHash("sha256").update(token).digest("base64url").slice(0, 22) : "";
}

/**
 * Read-only loopback APIs remain probeable for health/discovery and SSE.
 * Every state-changing management request needs a high-entropy runtime
 * capability. Web Capture routes have their own bearer-token boundary and are
 * intentionally excluded by the runtime before this predicate is applied.
 */
export function requiresMosaClientToken(method: unknown, pathname: unknown): boolean {
  const verb = String(method || "GET").toUpperCase();
  const path = String(pathname || "");
  if (!path.startsWith("/api/")) return false;
  return verb !== "GET" && verb !== "HEAD" && verb !== "OPTIONS";
}

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
