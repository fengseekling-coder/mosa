import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { createAssetStore } from "../lib/asset-store.mjs";

const managerDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectRoot = resolve(process.env.MOSA_PROJECT_DIR || join(managerDir, ".."));
const store = createAssetStore({ projectRoot, managerDir });
const projectId = process.env.MOSA_PROJECT_ID || "default";
const result = await store.migrateCodexAssetsToHardLinks(projectId);

console.log(JSON.stringify({ projectId, ...result, skippedCount: result.skipped.length }, null, 2));
