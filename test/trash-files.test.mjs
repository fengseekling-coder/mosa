import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanupPermanentDeletionStaging, stageFilesForPermanentDeletion } from "../lib/trash-files.mjs";

test("permanent deletion preserves staged bytes when rollback cannot restore immediately", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-trash-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "asset.png");
  await writeFile(source, "original-bytes");

  const staged = await stageFilesForPermanentDeletion(root, [source]);
  await mkdir(source);

  await assert.rejects(staged.rollback(), /rollback is incomplete/i);
  assert.equal(await readFile(join(staged.stageDir, "0-asset.png"), "utf8"), "original-bytes");

  await rm(source, { recursive: true, force: true });
  const recovered = await cleanupPermanentDeletionStaging(root);
  assert.deepEqual(recovered, { removed: 0, restored: 1, failed: 0 });
  assert.equal(await readFile(source, "utf8"), "original-bytes");
});

test("committed permanent deletion is swept instead of restored", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-trash-commit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "asset.png");
  await writeFile(source, "deleted-bytes");

  const staged = await stageFilesForPermanentDeletion(root, [source]);
  assert.equal(await staged.commit(), true);
  const recovered = await cleanupPermanentDeletionStaging(root);
  assert.deepEqual(recovered, { removed: 0, restored: 0, failed: 0 });
  await assert.rejects(readFile(source, "utf8"), /ENOENT/);
});
