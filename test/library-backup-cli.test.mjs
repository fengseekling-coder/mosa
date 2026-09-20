import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

function runCli(args) {
  return spawnSync(process.execPath, ["bin/mosa.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, MOSA_LIBRARY_DIR: "" },
  });
}

test("mosa CLI advertises explicit backup, verification, restore, and visual-model verification commands", () => {
  const result = runCli(["help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /mosa backup \[--library <path>\] --to <backup-dir>/);
  assert.match(result.stdout, /mosa backup-verify --from <backup-dir>/);
  assert.match(result.stdout, /mosa restore --from <backup-dir> --to <empty-library-dir>/);
  assert.match(result.stdout, /mosa visual-model-verify --from <model-pack-dir>/);
});

test("backup and restore never infer destructive destination paths", () => {
  const backup = runCli(["backup", "--library", "/tmp/does-not-matter"]);
  assert.notEqual(backup.status, 0);
  assert.match(`${backup.stdout}${backup.stderr}`, /backup requires --to/);

  const verify = runCli(["backup-verify"]);
  assert.notEqual(verify.status, 0);
  assert.match(`${verify.stdout}${verify.stderr}`, /backup-verify requires --from/);

  const restore = runCli(["restore", "--from", "/tmp/does-not-matter"]);
  assert.notEqual(restore.status, 0);
  assert.match(`${restore.stdout}${restore.stderr}`, /restore requires --to/);

  const visualModelVerify = runCli(["visual-model-verify"]);
  assert.notEqual(visualModelVerify.status, 0);
  assert.match(`${visualModelVerify.stdout}${visualModelVerify.stderr}`, /visual-model-verify requires --from/);
});
