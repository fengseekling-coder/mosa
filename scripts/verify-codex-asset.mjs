import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";

const [assetId] = process.argv.slice(2);

if (!assetId) {
  console.error("Usage: npm run verify:codex -- <asset-id>");
  process.exitCode = 1;
} else {
  await verifyCodexAsset(assetId);
}

async function verifyCodexAsset(id) {
  const managerDir = resolve(process.cwd());
  const metadataPath = join(managerDir, "assets", "default", "metadata", `${id}.json`);

  try {
    const asset = JSON.parse(await readFile(metadataPath, "utf8"));
    const source = asset.source || {};

    if (source.type !== "codex-generated") {
      throw new Error(`expected source.type to be codex-generated, received ${JSON.stringify(source.type)}`);
    }

    const requiredFiles = [
      ["Codex original image", source.path],
      ["library image copy", asset.image_path],
      ["prompt file", asset.prompt_path]
    ];
    for (const [label, filePath] of requiredFiles) {
      if (!filePath) throw new Error(`${label} path is missing`);
      await access(filePath, constants.F_OK);
    }

    const prompt = typeof asset.prompt === "string" ? asset.prompt : "";
    console.log(`Asset ID: ${asset.id}`);
    console.log(`Task ID: ${source.codex_task_id || "(missing)"}`);
    console.log(`Model: ${source.model || "(missing)"}`);
    console.log(`Prompt characters: ${prompt.length}`);
    console.log(`Library path: ${asset.image_path}`);
  } catch (error) {
    console.error(`Codex asset verification failed for ${id}: ${error.message}`);
    process.exitCode = 1;
  }
}
