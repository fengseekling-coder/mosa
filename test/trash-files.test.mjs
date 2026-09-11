import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { cleanupPermanentDeletionStaging, stageFilesForPermanentDeletion } from "../lib/trash-files.mjs";

test("permanent deletion preserves staged bytes when rollback cannot restore immediately", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-trash-rollback-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
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
  deferTestPathRemoval(root, { recursive: true, force: true });
  const source = join(root, "asset.png");
  await writeFile(source, "deleted-bytes");

  const staged = await stageFilesForPermanentDeletion(root, [source]);
  assert.equal(await staged.commit(), true);
  const recovered = await cleanupPermanentDeletionStaging(root);
  assert.deepEqual(recovered, { removed: 0, restored: 0, failed: 0 });
  await assert.rejects(readFile(source, "utf8"), /ENOENT/);
});

test("permanent deletion rejects lexical and symlink-resolved paths outside the project", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-trash-boundary-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const project = join(root, "project");
  const outside = join(root, "outside");
  await mkdir(project);
  await mkdir(outside);
  const outsideFile = join(outside, "keep.png");
  await writeFile(outsideFile, "keep-me");

  await assert.rejects(stageFilesForPermanentDeletion(project, [outsideFile]), /outside the project directory/);
  const escape = join(project, "escape");
  await symlink(outside, escape, "dir");
  await assert.rejects(stageFilesForPermanentDeletion(project, [join(escape, "keep.png")]), /symlink-resolved file outside/);
  assert.equal(await readFile(outsideFile, "utf8"), "keep-me");
});
