/**
 * Web capture dedupes on decoded pixels so that the file ChatGPT served and a
 * canvas re-encode of the same picture stay one asset. Assets archived before
 * that carry no pixel hash, so their next capture would import a duplicate.
 * This backfills the hash and reports the duplicate groups already in the
 * library. Reporting is the default; pass --apply to write.
 *
 *   node scripts/backfill-pixel-hashes.mjs [--apply] [--library <path>] [--project <id>]
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

const options = parseArgs(process.argv.slice(2));
const store = createSqliteAssetStore({
  projectRoot: options.library,
  managerDir: options.library,
  libraryDir: options.library,
});

try {
  const assets = [
    ...await store.listAssets({ projectId: options.project }),
    ...await store.listAssets({ projectId: options.project, archived: true }).catch(() => []),
  ];
  const byPixelHash = new Map();
  let hashed = 0;
  let written = 0;
  let unreadable = 0;

  for (const asset of assets) {
    const pixelHash = await pixelDigest(asset.image_path || asset.original_path);
    if (!pixelHash) {
      unreadable += 1;
      continue;
    }
    hashed += 1;
    if (!byPixelHash.has(pixelHash)) byPixelHash.set(pixelHash, []);
    byPixelHash.get(pixelHash).push(asset);

    if (options.apply && asset.source?.pixel_sha256 !== pixelHash) {
      await store.updateMetadata(asset.project_id, asset.id, {
        source: { ...(asset.source || {}), pixel_sha256: pixelHash },
      });
      written += 1;
    }
  }

  const duplicates = [...byPixelHash.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const [keep, ...rest] = [...group].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      return { keep: keep.id, duplicates: rest.map((asset) => asset.id) };
    });

  console.log(JSON.stringify({
    library: options.library,
    project: options.project,
    mode: options.apply ? "apply" : "report",
    assets: assets.length,
    hashed,
    unreadable,
    pixelHashesWritten: written,
    duplicateGroups: duplicates,
  }, null, 2));
  if (!options.apply) console.log("\nReport only. Re-run with --apply to write the pixel hashes.");
} finally {
  store.close?.();
}

async function pixelDigest(imagePath) {
  if (!imagePath) return "";
  try {
    const { data, info } = await sharp(imagePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return createHash("sha256")
      .update(`${info.width}x${info.height}x${info.channels}:`)
      .update(data)
      .digest("hex");
  } catch {
    return "";
  }
}

function parseArgs(argv) {
  const parsed = {
    apply: false,
    library: resolve(process.env.MOSA_LIBRARY_DIR || join(homedir(), "MOSA Library")),
    project: process.env.MOSA_PROJECT_ID || "default",
  };
  const values = [...argv];
  while (values.length) {
    const value = values.shift();
    if (value === "--apply") parsed.apply = true;
    else if (value === "--library") parsed.library = resolve(required("--library", values.shift()));
    else if (value === "--project") parsed.project = required("--project", values.shift());
    else throw new Error(`Unknown argument: ${value}`);
  }
  return parsed;
}

function required(flag, value) {
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
}
