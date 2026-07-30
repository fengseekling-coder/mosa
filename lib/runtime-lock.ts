import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const LOCK_FILE_NAME = ".mosa-runtime.lock";

interface LockOwner {
  token: string;
  pid: number;
  createdAt: string;
}

interface Lease {
  lockPath: string;
  owner: LockOwner;
  release(): Promise<boolean>;
}

export async function acquireMosaRuntimeLock(options: { libraryDir?: string; lockFileName?: string } = {}): Promise<Lease> {
  const libraryDir = options.libraryDir ? resolve(options.libraryDir) : null;
  if (!libraryDir) throw new Error("MOSA runtime lock requires a library directory.");
  const lockPath = resolve(libraryDir, options.lockFileName || LOCK_FILE_NAME);
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomUUID();
    try {
      const handle = await open(lockPath, "wx", 0o600);
      const owner: LockOwner = { token, pid: process.pid, createdAt: new Date().toISOString() };
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => {});
        await removeLockIfOwned(lockPath, token);
        throw error;
      }
      let released = false;
      return {
        lockPath,
        owner,
        async release(): Promise<boolean> {
          if (released) return false;
          released = true;
          await handle.close().catch(() => {});
          return removeLockIfOwned(lockPath, token);
        },
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      const owner = await readLockOwner(lockPath);
      if (!owner) throw new Error(`MOSA runtime lock at ${lockPath} is incomplete or malformed. Stop the existing MOSA runtime or remove the stale lock after confirming no runtime is active.`);
      if (isProcessAlive(owner.pid)) throw activeRuntimeError(lockPath, owner);
      const retiredPath = `${lockPath}.stale-${randomUUID()}`;
      try { await rename(lockPath, retiredPath); } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") continue;
        throw e;
      }
      await unlink(retiredPath).catch(() => {});
    }
  }
  const owner = await readLockOwner(lockPath);
  if (owner?.pid && isProcessAlive(owner.pid)) throw activeRuntimeError(lockPath, owner);
  throw new Error(`Could not acquire the MOSA runtime lock at ${lockPath}.`);
}

async function readLockOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8"));
    if (typeof parsed?.token !== "string" || !Number.isInteger(parsed?.pid) || parsed.pid <= 0) return null;
    return parsed as LockOwner;
  } catch { return null; }
}

async function removeLockIfOwned(lockPath: string, token: string): Promise<boolean> {
  const owner = await readLockOwner(lockPath);
  if (!owner || owner.token !== token) return false;
  try { await unlink(lockPath); return true; } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw e;
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: unknown) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function activeRuntimeError(lockPath: string, owner: LockOwner): Error {
  return new Error(`MOSA runtime already active for this library (PID ${owner.pid}; lock ${lockPath}). Stop that runtime or choose a different MOSA_LIBRARY_DIR.`);
}
