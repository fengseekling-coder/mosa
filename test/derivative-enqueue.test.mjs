import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import test from "node:test";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

// Unit tests for enqueueMissingDerivatives modes: the metadata-only legacy
// scan, the CLI "repair" mode that also checks the filesystem, and the CLI
// "rebuild" mode that re-enqueues every eligible asset.

async function createLibraryWithAssets(t, assetIds) {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-enqueue-"));
  const libraryDir = join(root, "library");
  await mkdir(join(root, "generated-images"), { recursive: true });
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: join(root, "manager"), libraryDir });
  t.after(() => store.close());
  t.after(() => removeTestPath(root, { recursive: true, force: true }));

  for (const [index, assetId] of assetIds.entries()) {
    const imagePath = join(root, "generated-images", `${assetId}.png`);
    await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 16 * index, g: 32, b: 64 } } })
      .png()
      .toFile(imagePath);
    await store.createAsset({ assetId, imagePath, prompt: `prompt for ${assetId}` });
  }
  return { root, libraryDir, store };
}

function derivativeBytes() {
  return sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 16, g: 32, b: 64 } } }).webp().toBuffer();
}

// Mimics what the derivative worker does on success: claim the canonical
// output paths, then record them on the asset row. Pass writeFiles=false to
// model the "database says the derivatives exist but the files are gone" state.
async function drainDerivativeJobs(store, { writeFiles = true } = {}) {
  for (let job = await store.claimDerivativeJob(); job; job = await store.claimDerivativeJob()) {
    await store.completeDerivativeJob(job, {
      width: 8,
      height: 8,
      previewPath: job.previewPath,
      mediumPath: job.mediumPath,
      thumbnailPath: job.thumbnailPath,
    });
    if (writeFiles) {
      for (const path of [job.previewPath, job.mediumPath, job.thumbnailPath]) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, await derivativeBytes());
      }
    }
  }
}

async function writeRecordedDerivativeFiles(store, assetId) {
  const asset = await store.getAsset("default", assetId);
  for (const path of [asset.preview_path, asset.medium_path, asset.thumbnail_path]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await derivativeBytes());
  }
}

test("repair mode enqueues assets whose derivative files are missing and skips complete ones", async (t) => {
  const { store } = await createLibraryWithAssets(t, ["alpha", "beta"]);

  // Fresh assets have no derivatives at all, so every mode sees them.
  assert.equal(await store.enqueueMissingDerivatives(), 2, "no options keeps the metadata-only scan");
  assert.equal(await store.enqueueMissingDerivatives({ mode: "repair" }), 2);
  await drainDerivativeJobs(store, { writeFiles: false });

  // Columns are now filled but the files were never written: the legacy scan
  // must stay quiet while repair mode catches the missing files.
  assert.equal(await store.enqueueMissingDerivatives(), 0, "no options ignores the filesystem, as before");
  assert.equal(await store.enqueueMissingDerivatives({ mode: "repair" }), 2, "missing files get enqueued");

  await writeRecordedDerivativeFiles(store, "alpha");
  await writeRecordedDerivativeFiles(store, "beta");
  assert.equal(await store.enqueueMissingDerivatives({ mode: "repair" }), 0, "a library with all files present is quiet");

  await rm(join(store.projectDir("default"), "mediums", "beta.webp"));
  assert.equal(await store.enqueueMissingDerivatives({ mode: "repair" }), 1, "only beta misses a file");

  await rm(join(store.projectDir("default"), "thumbnails", "alpha.webp"));
  assert.equal(await store.enqueueMissingDerivatives({ mode: "repair" }), 2);
});

test("rebuild mode enqueues every eligible asset regardless of file state", async (t) => {
  const { store } = await createLibraryWithAssets(t, ["alpha", "beta"]);
  await drainDerivativeJobs(store);

  assert.equal(await store.enqueueMissingDerivatives(), 0, "a complete library is quiet in metadata mode");
  assert.equal(await store.enqueueMissingDerivatives({ mode: "repair" }), 0, "a complete library is quiet in repair mode");
  assert.equal(await store.enqueueMissingDerivatives({ mode: "rebuild" }), 2, "rebuild re-enqueues everything eligible");
});

test("video, archived, and deleted assets are never enqueued", async (t) => {
  const { store } = await createLibraryWithAssets(t, ["keeper", "trashed"]);
  const videoPath = join(store.projectRoot, "generated-images", "clip.mp4");
  await writeFile(videoPath, Buffer.from("not really a video, but the extension decides"));
  await store.createAsset({ assetId: "clip", imagePath: videoPath, prompt: "prompt for clip" });

  // clip is a video: its metadata columns stay empty forever, yet it never
  // enters the queue.
  assert.equal(await store.enqueueMissingDerivatives(), 2, "the video is excluded despite empty derivative columns");
  await drainDerivativeJobs(store);
  assert.equal(await store.enqueueMissingDerivatives({ mode: "repair" }), 0);

  await rm(join(store.projectDir("default"), "thumbnails", "keeper.webp"));
  assert.equal(await store.enqueueMissingDerivatives({ mode: "repair" }), 1, "only keeper is repairable");

  await store.archiveAsset("default", "keeper");
  assert.equal(await store.enqueueMissingDerivatives({ mode: "repair" }), 0, "archived assets stay out even with missing files");

  await rm(join(store.projectDir("default"), "thumbnails", "trashed.webp"));
  await store.deleteAsset("default", "trashed");
  assert.equal(await store.enqueueMissingDerivatives({ mode: "repair" }), 0, "trashed assets stay out even with missing files");
});
