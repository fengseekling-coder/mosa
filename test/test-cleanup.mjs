import { rm } from "node:fs/promises";

export function removeTestPath(path, options = {}) {
  return rm(path, {
    ...options,
    maxRetries: options.maxRetries ?? (process.platform === "win32" ? 10 : 3),
    retryDelay: options.retryDelay ?? (process.platform === "win32" ? 200 : 50),
  });
}

