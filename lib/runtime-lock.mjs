import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const LOCK_FILE_NAME = ".mosa-runtime.lock";

/**
 * Ensures that only one HTTP/bridge runtime operates on a library at a time.
 * CLI and MCP clients remain deliberately unlocked: they do not own watchers
 * or derivative workers and must be able to make normal library requests.
 */
export async function acquireMosaRuntimeLock(options = {}) {
  const libraryDir = options.libraryDir ? resolve(options.libraryDir) : null;
  if (!libraryDir) throw new Error("MOSA runtime lock requires a library directory.");

  const lockPath = resolve(libraryDir, options.lockFileName || LOCK_FILE_NAME);
  await mkdir(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomUUID();
    try {
      const handle = await open(lockPath, "wx", 0o600);
      const owner = { token, pid: process.pid, createdAt: new Date().toISOString() };
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => {});
        await removeLockIfOwned(lockPath, token);
        throw error;
      }
      return createLease({ handle, lockPath, token, owner });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;

      const owner = await readLockOwner(lockPath);
      if (!owner) {
        throw new Error(`MOSA runtime lock at ${lockPath} is incomplete or malformed. Stop the existing MOSA runtime or remove the stale lock after confirming no runtime is active.`);
      }
      if (isProcessAlive(owner.pid)) throw activeRuntimeError(lockPath, owner);

      // Atomically move a confirmed-stale lock out of the way. If another
      // starter wins this race, retry and report its live owner instead.
      const retiredPath = `${lockPath}.stale-${randomUUID()}`;
      try {
        await rename(lockPath, retiredPath);
      } catch (renameError) {
        if (renameError?.code === "ENOENT") continue;
        throw renameError;
      }
      await unlink(retiredPath).catch(() => {});
    }
  }

  const owner = await readLockOwner(lockPath);
  if (owner?.pid && isProcessAlive(owner.pid)) throw activeRuntimeError(lockPath, owner);
  throw new Error(`Could not acquire the MOSA runtime lock at ${lockPath}.`);
}

function createLease({ handle, lockPath, token, owner }) {
  let released = false;
  return {
    lockPath,
    owner,
    async release() {
      if (released) return false;
      released = true;
      await handle.close().catch(() => {});
      return removeLockIfOwned(lockPath, token);
    },
  };
}

async function readLockOwner(lockPath) {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8"));
    if (typeof parsed?.token !== "string" || !Number.isInteger(parsed?.pid) || parsed.pid <= 0) return null;
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return null;
  }
}

async function removeLockIfOwned(lockPath, token) {
  const owner = await readLockOwner(lockPath);
  if (!owner || owner.token !== token) return false;
  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function activeRuntimeError(lockPath, owner) {
  return new Error(`MOSA runtime already active for this library (PID ${owner.pid}; lock ${lockPath}). Stop that runtime or choose a different MOSA_LIBRARY_DIR.`);
}
