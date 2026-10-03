import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deferTestPathRemoval } from "../test-cleanup.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");

// parseOptions() in bin/mosa.mjs falls back to `~/MOSA Library` (the user's
// real asset library), the repository's own assets/ directory, and the
// repository's parent as the project directory whenever HOME,
// MOSA_LIBRARY_DIR, or MOSA_PROJECT_DIR are unset, so every spawned CLI
// process must override all three with throwaway directories.
const REQUIRED_ISOLATION_VARIABLES = ["HOME", "MOSA_LIBRARY_DIR", "MOSA_PROJECT_DIR"];

export function runMosaCli(args, { env, timeoutMs = 120000 } = {}) {
  const missing = REQUIRED_ISOLATION_VARIABLES.filter((name) => !env || !env[name]);
  if (missing.length) {
    throw new Error(`runMosaCli refuses to spawn bin/mosa.mjs: env must override ${missing.join(", ")} with temporary directories.`);
  }
  const childEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("MOSA_")) childEnv[name] = value;
  }
  Object.assign(childEnv, env);
  return spawnSync(process.execPath, [join(repoRoot, "bin/mosa.mjs"), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: timeoutMs,
    env: childEnv,
  });
}

export async function createIsolatedCliEnv(label) {
  const root = await mkdtemp(join(tmpdir(), label));
  deferTestPathRemoval(root, { recursive: true, force: true });
  return {
    root,
    env: {
      HOME: join(root, "home"),
      MOSA_LIBRARY_DIR: join(root, "library"),
      MOSA_PROJECT_DIR: join(root, "project"),
    },
  };
}
