import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { buildAssetVersionHistory } from "../lib/asset-version-history.mjs";
import { createJsonAssetStore, mimeTypeForFile } from "../lib/asset-store.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

for (const implementation of [
  ["JSON", createJsonAssetStore],
  ["SQLite", createSqliteAssetStore],
]) {
  test(`${implementation[0]} store creates and reads deterministic recipe version trees`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `mosa-version-${implementation[0].toLowerCase()}-`));
    const projectRoot = join(root, "project");
    const managerDir = join(projectRoot, "mosa");
    const sourcePath = join(projectRoot, "generated-images", "fixture.png");
    const replacementPath = join(projectRoot, "generated-images", "replacement.webp");
    await mkdir(join(projectRoot, "generated-images"), { recursive: true });
    await writeFile(sourcePath, ONE_PIXEL_PNG);
    await sharp({ create: { width: 2, height: 2, channels: 4, background: "#2456d8" } }).webp({ lossless: true }).toFile(replacementPath);
    const replacementImage = await readFile(replacementPath);
    const store = implementation[1]({ projectRoot, managerDir, libraryDir: join(root, "library") });
    t.after(async () => {
      store.close?.();
      await rm(root, { recursive: true, force: true });
    });

    const parent = await store.createAsset({
      assetId: "root",
      imagePath: sourcePath,
      prompt: "Original prompt",
      skill: "imagegen",
      style: "editorial",
      ratio: "4:5",
      theme: "Original theme",
      group: "Campaign",
      category: "concept",
      rating: 4,
      tags: ["launch"],
      business_fields: { audience: "designers" },
      source: { model: "gpt-5.6", generation_tool: "imagegen" },
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const parentBeforeVersion = await store.getAsset("default", parent.id);

    const firstChild = await store.createAssetVersion("default", parent.id, {
      assetId: "child-a",
      version_change: "Warmer palette",
      prompt: "Warm prompt",
      theme: "Warm theme",
    });
    await delay(2);
    const grandchild = await store.createAssetVersion("default", firstChild.id, {
      assetId: "grandchild",
      version_change: "Tighter crop",
      ratio: "1:1",
    });
    await delay(2);
    const secondChild = await store.createAssetVersion("default", parent.id, {
      assetId: "child-b",
      version_change: "Alternate typography",
    });

    assert.equal(firstChild.parent_asset_id, parent.id);
    assert.equal(firstChild.version_change, "Warmer palette");
    assert.equal(firstChild.prompt, "Warm prompt");
    assert.equal(firstChild.style, parent.style);
    assert.equal(firstChild.source.model, "gpt-5.6");
    assert.equal(firstChild.source.versioned_from, parent.id);
    assert.deepEqual(firstChild.child_asset_ids, []);
    assert.notEqual(firstChild.image_path, parent.image_path);
    assert.deepEqual(await readFile(firstChild.image_path), await readFile(parent.image_path));

    const parentAfterVersion = await store.getAsset("default", parent.id);
    assert.equal(parentAfterVersion.prompt, parentBeforeVersion.prompt);
    assert.equal(parentAfterVersion.updated_at, parentBeforeVersion.updated_at);
    assert.deepEqual(parentAfterVersion.child_asset_ids, [firstChild.id, secondChild.id]);

    await store.archiveAsset("default", parent.id);
    const fromRoot = await store.getAssetVersionHistory("default", parent.id);
    const fromGrandchild = await store.getAssetVersionHistory("default", grandchild.id);
    assert.equal(fromRoot.root_asset_id, parent.id);
    assert.equal(fromGrandchild.root_asset_id, parent.id);
    assert.equal(fromGrandchild.selected_asset_id, grandchild.id);
    assert.deepEqual(fromRoot.versions.map((asset) => asset.id), [parent.id, firstChild.id, grandchild.id, secondChild.id]);
    assert.deepEqual(fromGrandchild.versions.map((asset) => asset.id), fromRoot.versions.map((asset) => asset.id));
    assert.deepEqual(fromRoot.versions.map((asset) => asset.version_depth), [0, 1, 2, 1]);
    assert.equal(fromRoot.versions[0].archived, true);

    const imageChild = await store.createAssetVersion("default", parent.id, {
      assetId: "child-image",
      imagePath: replacementPath,
      version_change: "Regenerated composition",
      source: {
        model: "gpt-5.6",
        generation_tool: "imagegen",
        versioned_from: "stale-parent",
        duplicated_from: "stale-copy",
        storage_mode: "stale-storage",
      },
    });
    assert.equal(imageChild.parent_asset_id, parent.id);
    assert.equal(imageChild.source.versioned_from, parent.id);
    assert.equal(imageChild.source.duplicated_from, undefined);
    assert.notEqual(imageChild.source.storage_mode, "stale-storage");
    assert.equal(imageChild.source.path, replacementPath);
    assert.match(imageChild.asset, /\.webp$/);
    assert.match(imageChild.image_path, /\.webp$/);
    assert.equal(mimeTypeForFile(imageChild.asset), "image/webp");
    assert.deepEqual(await readFile(imageChild.image_path), replacementImage);
    assert.notDeepEqual(await readFile(imageChild.image_path), await readFile(parent.image_path));
    const historyWithReplacement = await store.getAssetVersionHistory("default", imageChild.id);
    assert.deepEqual(historyWithReplacement.versions.map((asset) => asset.id), [parent.id, firstChild.id, grandchild.id, secondChild.id, imageChild.id]);

    const duplicate = await store.duplicateAsset("default", firstChild.id, { assetId: "independent-copy" });
    assert.equal(duplicate.parent_asset_id, null);
    assert.equal(duplicate.version_change, "");
    assert.deepEqual(duplicate.child_asset_ids, []);
    assert.equal(duplicate.archived, false);
    assert.equal(duplicate.source.duplicated_from, firstChild.id);
    assert.equal(duplicate.source.versioned_from, undefined);
    assert.notEqual(duplicate.created_at, parent.created_at);
    const duplicateHistory = await store.getAssetVersionHistory("default", duplicate.id);
    assert.deepEqual(duplicateHistory.versions.map((asset) => asset.id), [duplicate.id]);

    await assert.rejects(
      store.createAssetVersion("default", parent.id, { version_change: "   " }),
      errorWithCode("INVALID_VERSION_CHANGE"),
    );
    await assert.rejects(
      store.createAsset({ assetId: "child-without-summary", imagePath: sourcePath, parent_asset_id: parent.id }),
      errorWithCode("INVALID_VERSION_CHANGE"),
    );
    await assert.rejects(
      store.createAssetVersion("default", parent.id, { assetId: firstChild.id, version_change: "collision" }),
      errorWithCode("ASSET_ALREADY_EXISTS"),
    );
    await assert.rejects(
      store.updateMetadata("default", firstChild.id, { parent_asset_id: secondChild.id }),
      errorWithCode("VERSION_RELATION_IMMUTABLE"),
    );

    await store.createAsset({ projectId: "other", assetId: "foreign-parent", imagePath: sourcePath });
    await assert.rejects(
      store.createAsset({ assetId: "orphan", imagePath: sourcePath, parent_asset_id: "missing" }),
      errorWithCode("VERSION_PARENT_NOT_FOUND"),
    );
    await assert.rejects(
      store.createAsset({ assetId: "cross-project", imagePath: sourcePath, parent_asset_id: "foreign-parent" }),
      errorWithCode("VERSION_PROJECT_MISMATCH"),
    );
    await assert.rejects(
      store.createAsset({ assetId: "self-parent", imagePath: sourcePath, parent_asset_id: "self-parent" }),
      errorWithCode("VERSION_CYCLE"),
    );

    const concurrentCreates = await Promise.allSettled([
      store.createAsset({ assetId: "concurrent-id", imagePath: sourcePath, prompt: "first contender" }),
      store.createAsset({ assetId: "concurrent-id", imagePath: replacementPath, prompt: "second contender" }),
    ]);
    assert.equal(concurrentCreates.filter((result) => result.status === "fulfilled").length, 1);
    const conflict = concurrentCreates.find((result) => result.status === "rejected");
    assert.equal(conflict.reason.code, "ASSET_ALREADY_EXISTS");
  });
}

test("shared history builder rejects corrupt parent graphs", () => {
  const base = { project_id: "default", child_asset_ids: [], created_at: "2026-01-01T00:00:00.000Z" };
  assert.throws(
    () => buildAssetVersionHistory({
      projectId: "default",
      selectedAssetId: "orphan",
      assets: [{ ...base, id: "orphan", parent_asset_id: "missing" }],
    }),
    errorWithCode("VERSION_PARENT_NOT_FOUND"),
  );
  assert.throws(
    () => buildAssetVersionHistory({
      projectId: "default",
      selectedAssetId: "orphan",
      assets: [{ ...base, id: "orphan", parent_asset_id: "foreign" }],
      foreignProjectsByAssetId: new Map([["foreign", ["other"]]]),
    }),
    errorWithCode("VERSION_PROJECT_MISMATCH"),
  );
  assert.throws(
    () => buildAssetVersionHistory({
      projectId: "default",
      selectedAssetId: "a",
      assets: [
        { ...base, id: "a", parent_asset_id: "b" },
        { ...base, id: "b", parent_asset_id: "a" },
      ],
    }),
    errorWithCode("VERSION_CYCLE"),
  );
});

function errorWithCode(code) {
  return (error) => error?.code === code;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
