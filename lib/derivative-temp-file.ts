import { randomBytes } from "node:crypto";
import { readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

// Derivative files are published by writing a temp file next to the final
// path and renaming it into place, so a hard kill can never leave a
// half-written file at a path the database points at. The trailing ".tmp"
// also keeps residue out of library backups, which skip "*.tmp" entries
// wholesale (regularFilesUnder in library-backup.ts).
const TEMP_SUFFIX = ".tmp";
const TEMP_RANDOM_BYTES = 6;
const DERIVATIVE_TEMP_NAME_PATTERN = new RegExp(
  `^\\..+\\.\\d{1,10}\\.[0-9a-f]{${TEMP_RANDOM_BYTES * 2}}${TEMP_SUFFIX.replace(".", "\\.")}$`,
);

export function derivativeTempFileName(finalName: string): string {
  return `.${finalName}.${process.pid}.${randomBytes(TEMP_RANDOM_BYTES).toString("hex")}${TEMP_SUFFIX}`;
}

export function isDerivativeTempFileName(name: string): boolean {
  return DERIVATIVE_TEMP_NAME_PATTERN.test(name);
}

// Best-effort sweep of the temp files a hard-killed earlier run of the same
// derivative set left behind. Nothing here may block generation: a directory
// that cannot be scanned and a file that cannot be unlinked are both left for
// the next run or for the orphan sweeps in sqlite-asset-store.
export async function removeStaleDerivativeTempFiles(dirs: string[], finalNames: string[]): Promise<void> {
  const prefixes = finalNames.map((name) => `.${name}.`);
  await Promise.all([...new Set(dirs)].map(async (dir) => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    const stale = names.filter((name) => isDerivativeTempFileName(name) && prefixes.some((prefix) => name.startsWith(prefix)));
    await Promise.all(stale.map((name) => unlink(join(dir, name)).catch(() => {})));
  }));
}

const PUBLISH_RETRY_DELAYS_MS = [100, 200, 300, 400];
const PUBLISH_RETRY_ERROR_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export async function publishDerivativeFile(tempPath: string, finalPath: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tempPath, finalPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      // On Windows the destination stays locked while a reader (browser,
      // indexer, antivirus) holds it open; a short bounded retry rides out
      // that window, then the error surfaces unchanged.
      if (!code || !PUBLISH_RETRY_ERROR_CODES.has(code) || attempt >= PUBLISH_RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, PUBLISH_RETRY_DELAYS_MS[attempt]));
    }
  }
}
