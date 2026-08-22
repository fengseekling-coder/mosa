import { createHash, randomUUID } from "node:crypto";
import { link, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

interface Asset {
  id: string;
  project_id: string;
  image_path?: string;
  source?: Record<string, unknown>;
  [key: string]: unknown;
}

interface Store {
  listAssets(filters: Record<string, unknown>): Promise<Asset[]>;
  updateMetadata(projectId: string, assetId: string, metadata: Record<string, unknown>): Promise<void>;
}

interface RelinkResult {
  migrated: string[];
  alreadyLinked: string[];
  skipped: Array<{ assetId: string; reason: string }>;
}

interface SingleRelinkResult {
  status: string;
}

export async function relinkCodexAssets(store: Store, projectId: string): Promise<RelinkResult> {
  const filters = { projectId, source: "codex-generated" };
  const assets = [
    ...(await store.listAssets(filters)),
    ...(await store.listAssets({ ...filters, archived: true })),
  ];
  const result: RelinkResult = { migrated: [], alreadyLinked: [], skipped: [] };
  for (const asset of assets) {
    const relink = await relinkCodexAsset(asset);
    if (relink.status === "migrated") {
      await store.updateMetadata(asset.project_id, asset.id, {
        source: { ...asset.source, storage_mode: "hard-link", storage_linked_at: new Date().toISOString() },
      });
      result.migrated.push(asset.id);
    } else if (relink.status === "already-linked") result.alreadyLinked.push(asset.id);
    else result.skipped.push({ assetId: asset.id, reason: relink.status });
  }
  return result;
}

export async function relinkCodexAsset(asset: Asset): Promise<SingleRelinkResult> {
  const sourcePath = asset.source?.path ? resolve(asset.source.path as string) : null;
  const targetPath = asset.image_path ? resolve(asset.image_path) : null;
  if (!sourcePath || !targetPath) return { status: "missing-path" };
  let sourceStat, targetStat;
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
