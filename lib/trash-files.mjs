import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const PURGE_PREFIX = ".trash-purge-";

export async function stageFilesForPermanentDeletion(projectDir, filePaths = []) {
  const root = resolve(projectDir);
  const uniquePaths = [...new Set(filePaths.filter(Boolean).map((filePath) => resolve(filePath)))];
  const stageDir = join(root, `${PURGE_PREFIX}${randomUUID()}`);
  await mkdir(stageDir, { recursive: false });
  const staged = [];
  let settled = false;

  try {
    for (let index = 0; index < uniquePaths.length; index += 1) {
      const source = uniquePaths[index];
      const target = join(stageDir, `${index}-${basename(source)}`);
      try {
        await rename(source, target);
        staged.push({ source, target });
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
    }
  } catch (error) {
    for (const entry of [...staged].reverse()) {
      await rename(entry.target, entry.source).catch(() => {});
    }
    await rm(stageDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return {
    stageDir,
    async rollback() {
      if (settled) return;
      settled = true;
      for (const entry of [...staged].reverse()) {
        await rename(entry.target, entry.source).catch(() => {});
      }
      await rm(stageDir, { recursive: true, force: true }).catch(() => {});
    },
    async commit() {
      if (settled) return true;
      settled = true;
      try {
        await rm(stageDir, {
          recursive: true,
          force: true,
          maxRetries: process.platform === "win32" ? 8 : 2,
          retryDelay: process.platform === "win32" ? 150 : 50,
        });
        return true;
      } catch {
        // The logical item is already gone and the bytes are isolated under a
        // hidden staging directory. The runtime sweeps these directories on
        // startup and hourly, so report pending cleanup instead of turning a
        // successful permanent deletion into a contradictory API error.
        return false;
      }
    },
  };
}

export async function cleanupPermanentDeletionStaging(projectDir) {
  const root = resolve(projectDir);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { removed: 0, failed: 0 };
    throw error;
  }
  let removed = 0;
  let failed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(PURGE_PREFIX)) continue;
    try {
      await rm(join(root, entry.name), {
        recursive: true,
        force: true,
        maxRetries: process.platform === "win32" ? 8 : 2,
        retryDelay: process.platform === "win32" ? 150 : 50,
      });
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}
