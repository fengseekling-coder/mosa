import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createAssetStore } from "../lib/asset-store.mjs";

const managerDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectRoot = resolve(process.env.MOSA_PROJECT_DIR || join(managerDir, ".."));
// Resolved the same way the service and MCP server resolve it, so the script cannot
// silently reclaim space in a different library than the one MOSA is serving.
const libraryDir = resolve(process.env.MOSA_LIBRARY_DIR || join(homedir(), "MOSA Library"));
const store = createAssetStore({ projectRoot, managerDir, libraryDir });
const projectId = store.projectId(process.env.MOSA_PROJECT_ID || "default");

try {
  const result = await store.migrateCodexAssetsToHardLinks(projectId);
  console.log(JSON.stringify({
    storage: store.storageKind,
    libraryDir: store.storageKind === "sqlite" ? store.libraryDir : store.assetsRoot,
    projectId,
    ...result,
    skippedCount: result.skipped.length,
  }, null, 2));
} finally {
  store.close?.();
}
