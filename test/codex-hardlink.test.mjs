import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("SQLite Codex hard-link maintenance skips session-recovered assets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-sqlite-codex-session-copy-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const codexImagesDir = join(root, ".codex", "generated_images");
  const recoveryRoot = join(root, "library", "assets", ".codex-session-recovery");
  const recoveredPath = join(recoveryRoot, "recovered.png");
  await mkdir(codexImagesDir, { recursive: true });
  await mkdir(recoveryRoot, { recursive: true });
  await writeFile(recoveredPath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({
    projectRoot,
    managerDir: join(projectRoot, "mosa"),
    libraryDir: join(root, "library"),
    codexImagesDir,
  });
  t.after(() => store.close());

  const asset = await store.createAsset({
    assetId: "codex-session-recovered",
    imagePath: recoveredPath,
    sourceType: "codex-generated",
    source: {
      generation_tool: "codex-imagegen-session-recovery",
      codex_session_event_key: "session::call",
      codex_recovered_from_session: true,
    },
  }, { trustedSourceRoots: [recoveryRoot] });
  assert.equal(asset.source.storage_mode, "copy");

  const result = await store.migrateCodexAssetsToHardLinks("default");
  assert.deepEqual(result.migrated, []);
  assert.deepEqual(result.alreadyLinked, []);
  assert.deepEqual(result.skipped, [{ assetId: "codex-session-recovered", reason: "non-generated-images-source" }]);
});
