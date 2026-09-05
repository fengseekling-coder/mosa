import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const LEGACY_PURGE_PREFIX = ".trash-purge-";
const STAGED_PURGE_PREFIX = ".trash-purge-staged-";
const COMMITTED_PURGE_PREFIX = ".trash-purge-committed-";
const JOURNAL_FILE = "journal.json";

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJournal(stageDir, entries) {
  await writeFile(join(stageDir, JOURNAL_FILE), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { flag: "wx" });
}

async function readJournal(stageDir) {
  const parsed = JSON.parse(await readFile(join(stageDir, JOURNAL_FILE), "utf8"));
  if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) throw new Error("Invalid permanent-deletion recovery journal.");
  return parsed.entries.map((entry) => ({
    source: resolve(String(entry?.source || "")),
    target: resolve(String(entry?.target || "")),
  }));
}

async function restoreStagedFiles(stageDir, entries) {
  const failures = [];
  for (const entry of [...entries].reverse()) {
    const targetExists = await pathExists(entry.target);
    if (!targetExists) continue;
    if (await pathExists(entry.source)) {
      failures.push(new Error(`Cannot restore staged asset because the original path is occupied: ${entry.source}`));
      continue;
    }
    try {
      await rename(entry.target, entry.source);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, `Permanent-deletion rollback is incomplete; recovery data is preserved in ${stageDir}.`);
  }
  await rm(stageDir, { recursive: true, force: true });
}

export async function stageFilesForPermanentDeletion(projectDir, filePaths = []) {
  const root = resolve(projectDir);
  const uniquePaths = [...new Set(filePaths.filter(Boolean).map((filePath) => resolve(filePath)))];
  const transactionId = randomUUID();
  const stageDir = join(root, `${STAGED_PURGE_PREFIX}${transactionId}`);
  const committedDir = join(root, `${COMMITTED_PURGE_PREFIX}${transactionId}`);
  await mkdir(stageDir, { recursive: false });
  const entries = uniquePaths.map((source, index) => ({
    source,
    target: join(stageDir, `${index}-${basename(source)}`),
  }));
  let settled = false;

  try {
    // Write the complete recovery plan before moving the first byte. A process
    // crash can therefore always distinguish an uncommitted transaction and
    // restore every target that made it into the staging directory.
    await writeJournal(stageDir, entries);
    for (const entry of entries) {
      try {
        await rename(entry.source, entry.target);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
    }
  } catch (error) {
    try {
      await restoreStagedFiles(stageDir, entries);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Permanent-deletion staging failed and rollback requires recovery.");
    }
    throw error;
  }

  return {
    stageDir,
    async rollback() {
      if (settled) return;
      await restoreStagedFiles(stageDir, entries);
      settled = true;
    },
    async commit() {
      if (settled) return true;
      // The directory rename is the commit marker. Recovery only restores
      // STAGED directories; COMMITTED directories contain bytes whose logical
      // records are already gone and are therefore safe to sweep later.
      try {
        await rename(stageDir, committedDir);
      } catch {
        return false;
      }
      settled = true;
      try {
        await rm(committedDir, {
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
  let restored = 0;
  let failed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if (entry.name.startsWith(STAGED_PURGE_PREFIX)) {
      try {
        const journal = await readJournal(path);
        await restoreStagedFiles(path, journal);
        restored += 1;
      } catch {
        failed += 1;
      }
      continue;
    }
    const committed = entry.name.startsWith(COMMITTED_PURGE_PREFIX);
    const legacy = entry.name.startsWith(LEGACY_PURGE_PREFIX)
      && !entry.name.startsWith(STAGED_PURGE_PREFIX)
      && !entry.name.startsWith(COMMITTED_PURGE_PREFIX);
    if (!committed && !legacy) continue;
    try {
      await rm(path, {
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
  return { removed, restored, failed };
}
