#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(scriptDir, "..");

const result = spawnSync(
  process.execPath,
  ["--test", "test/performance.test.mjs"],
  {
    cwd: repoRoot,
    env: { ...process.env, MOSA_PERF_TEST: "1" },
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
