import { createHash, randomUUID } from "node:crypto";
import { link, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const CODEX_SOURCE_TYPE = "codex-generated";

/**
 * Reclaims the bytes a Codex import duplicated, by re-pointing a library file at the inode of
 * the original it was taken from. Both stores hard-link at ingest, so this only has work to do
 * for entries that were copied instead: an import that crossed a filesystem boundary at the
 * time, and — the common case — every Codex asset carried over by `mosa migrate`, which
 * re-imports each record from the legacy *library* file rather than the Codex path and so
 * always lands as a copy even when the original is still hard-linkable.
 *
 * Shared by both stores so the two `migrateCodexAssetsToHardLinks` methods cannot drift; it
 * only uses the public store contract (`listAssets`, `updateMetadata`).
 */
export async function relinkCodexAssets(store, projectId) {
  const filters = { projectId, source: CODEX_SOURCE_TYPE };
  const assets = [
    ...(await store.listAssets(filters)),
    ...(await store.listAssets({ ...filters, archived: true })),
  ];
  const result = { migrated: [], alreadyLinked: [], skipped: [] };
  for (const asset of assets) {
    const relink = await relinkCodexAsset(asset);
    if (relink.status === "migrated") {
      await store.updateMetadata(asset.project_id, asset.id, {
        source: {
          ...asset.source,
          storage_mode: "hard-link",
          storage_linked_at: new Date().toISOString(),
        },
      });
      result.migrated.push(asset.id);
    } else if (relink.status === "already-linked") result.alreadyLinked.push(asset.id);
    else result.skipped.push({ assetId: asset.id, reason: relink.status });
  }
  return result;
}

/**
 * Swaps one library file for a hard link to its recorded source. Deliberately conservative: it
 * refuses unless both files still exist, sit on the same filesystem, and hash identically, and
 * it publishes the link with an atomic rename so an interrupted run leaves the library file
 * whole rather than truncated.
 */
export async function relinkCodexAsset(asset) {
  const sourcePath = asset.source?.path ? resolve(asset.source.path) : null;
  const targetPath = asset.image_path ? resolve(asset.image_path) : null;
  if (!sourcePath || !targetPath) return { status: "missing-path" };
  let sourceStat;
  let targetStat;
  try {
    [sourceStat, targetStat] = await Promise.all([stat(sourcePath), stat(targetPath)]);
  } catch {
    return { status: "source-or-library-file-missing" };
  }
  if (!sourceStat.isFile() || !targetStat.isFile()) return { status: "not-a-file" };
  if (sourceStat.dev !== targetStat.dev) return { status: "different-filesystem" };
  if (sourceStat.ino === targetStat.ino) return { status: "already-linked" };

  const [sourceHash, targetHash] = await Promise.all([
    createHash("sha256").update(await readFile(sourcePath)).digest("hex"),
    createHash("sha256").update(await readFile(targetPath)).digest("hex"),
  ]);
  if (sourceHash !== targetHash) return { status: "content-mismatch" };

  const temporaryPath = join(dirname(targetPath), `.${basename(targetPath)}.${randomUUID()}.hardlink`);
  try {
    await link(sourcePath, temporaryPath);
    await rename(temporaryPath, targetPath);
    return { status: "migrated" };
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}
