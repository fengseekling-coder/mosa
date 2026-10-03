import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";import test from "node:test";
import sharp from "sharp";
import { createDerivativeProcessor, processDerivativeJob } from "../lib/derivative-worker.js";
import {
  derivativeTempFileName,
  isDerivativeTempFileName,
  publishDerivativeFile,
  removeStaleDerivativeTempFiles,
} from "../lib/derivative-temp-file.js";
import { createLibraryBackup } from "../lib/library-backup.js";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Directory write permission is only enforceable on POSIX; running as root
// bypasses it even there.
const CHMOD_INJECTION_UNAVAILABLE = process.platform === "win32"
  || (typeof process.getuid === "function" && process.getuid() === 0);

function fakeStore() {
  const completions = [];
  return {
    completions,
    async completeDerivativeJob(_job, result) { completions.push(result); },
    async isAssetActive() { return true; },
  };
}

async function makeJob(root, id, { originalPath } = {}) {
  const imagePath = originalPath || join(root, `${id}.png`);
  if (!originalPath) {
    await sharp({ create: { width: 96, height: 72, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toFile(imagePath);
  }
  const directories = {
    previews: join(root, "previews"),
    mediums: join(root, "mediums"),
    thumbnails: join(root, "thumbnails"),
  };
  for (const directory of Object.values(directories)) await mkdir(directory, { recursive: true });
  return {
    project_id: "default",
    asset_id: id,
    original_path: imagePath,
    previewPath: join(directories.previews, `${id}.webp`),
    mediumPath: join(directories.mediums, `${id}.webp`),
    thumbnailPath: join(directories.thumbnails, `${id}.webp`),
  };
}

async function seedOldDerivatives(job) {
  const seed = async (path, color) => {
    await sharp({ create: { width: 8, height: 8, channels: 3, background: color } }).webp().toFile(path);
    return readFile(path);
  };
  const [thumbnail, medium, preview] = await Promise.all([
    seed(job.thumbnailPath, { r: 200, g: 10, b: 10 }),
    seed(job.mediumPath, { r: 10, g: 200, b: 10 }),
    seed(job.previewPath, { r: 10, g: 10, b: 200 }),
  ]);
  return { thumbnail, medium, preview };
}

function derivativeDirectories(job) {
  return [dirname(job.thumbnailPath), dirname(job.mediumPath), dirname(job.previewPath)];
}

test("derivative temp file naming rule is recognizable and never matches real files", () => {
  const built = derivativeTempFileName("abc123.webp");
  assert.match(built, /^\.abc123\.webp\.\d{1,10}\.[0-9a-f]{12}\.tmp$/);
  assert.notEqual(built, derivativeTempFileName("abc123.webp"), "concurrent runs must not collide");

  assert.equal(isDerivativeTempFileName(built), true);
  assert.equal(isDerivativeTempFileName(".abc123.webp.4242.0123456789ab.tmp"), true);
  assert.equal(isDerivativeTempFileName(".a.b.c.1234567890.deadbeef1234.tmp"), true);

  assert.equal(isDerivativeTempFileName("abc123.webp"), false, "real derivative file");
  assert.equal(isDerivativeTempFileName("IMG_0001.png"), false, "original image name");
  assert.equal(isDerivativeTempFileName("photo (1).jpg"), false);
  assert.equal(isDerivativeTempFileName("abc123.webp.tmp"), false, "lookalike without leading dot");
  assert.equal(isDerivativeTempFileName(".abc123.webp.tmp"), false, "no pid/random part");
  assert.equal(isDerivativeTempFileName(".abc123.webp.4242.tmp"), false, "no random part");
  assert.equal(isDerivativeTempFileName(".abc123.webp.xy.0123456789ab.tmp"), false, "pid must be digits");
  assert.equal(isDerivativeTempFileName(".abc123.webp.4242.0123456789ab.tmp.bak"), false, "wrong suffix");
  assert.equal(isDerivativeTempFileName("index.lock"), false);
});

test("removeStaleDerivativeTempFiles only touches matching residue", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-atomic-sweep-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const residue = join(root, ".asset1.webp.4242.0123456789ab.tmp");
  const lookalike = join(root, "asset1.webp.tmp");
  const other = join(root, ".asset2.webp.4242.0123456789ab.tmp");
  await writeFile(residue, "stale");
  await writeFile(lookalike, "real file");
  await writeFile(other, "other asset residue");

  await removeStaleDerivativeTempFiles([root], ["asset1.webp"]);

  await assert.rejects(stat(residue), /ENOENT/, "matching residue must be removed");
  assert.equal(await readFile(lookalike, "utf8"), "real file");
  assert.equal(await readFile(other, "utf8"), "other asset residue");

  await removeStaleDerivativeTempFiles([join(root, "missing-dir")], ["asset1.webp"]);
});

test("publishDerivativeFile renames atomically and retries transient rename failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-atomic-publish-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const targetDir = join(root, "out");
  await mkdir(targetDir, { recursive: true });
  const tempPath = join(root, "staged.tmp");
  const finalPath = join(targetDir, "final.webp");
  await writeFile(tempPath, "complete bytes");
  await writeFile(finalPath, "old bytes");

  await publishDerivativeFile(tempPath, finalPath);
  assert.equal(await readFile(finalPath, "utf8"), "complete bytes");
  await assert.rejects(stat(tempPath), /ENOENT/, "temp file must not survive the publish");
});

test("publishDerivativeFile keeps the temp file when the rename fails after retries", { skip: CHMOD_INJECTION_UNAVAILABLE && "chmod cannot make a directory unwritable here" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-atomic-retry-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const targetDir = join(root, "out");
  await mkdir(targetDir, { recursive: true });
  const tempPath = join(root, "staged.tmp");
  const finalPath = join(targetDir, "final.webp");
  await writeFile(tempPath, "complete bytes");
  await writeFile(finalPath, "old bytes");

  await chmod(targetDir, 0o500);
  try {
    const startedAt = Date.now();
    await assert.rejects(publishDerivativeFile(tempPath, finalPath), /EACCES/);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 900, `transient failures must be retried before giving up (took ${elapsed}ms)`);
    assert.equal(await readFile(finalPath, "utf8"), "old bytes", "the final file must stay untouched");
    assert.equal(await readFile(tempPath, "utf8"), "complete bytes", "the caller cleans up temp files on failure");
  } finally {
    await chmod(targetDir, 0o755);
  }
});

test("successful generation publishes decodable finals and leaves no temp files", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-atomic-ok-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const job = await makeJob(root, "atomic-ok");
  const result = await processDerivativeJob(fakeStore(), job);

  assert.equal(result.ok, true);
  assert.equal(Number.isInteger(result.width), true);
  assert.equal(Number.isInteger(result.height), true);
  for (const finalPath of [job.previewPath, job.mediumPath, job.thumbnailPath]) {
    const metadata = await sharp(finalPath).metadata();
    assert.equal(metadata.format, "webp", `${finalPath} must be a decodable webp`);
  }
  for (const directory of derivativeDirectories(job)) {
    const names = await readdir(directory);
    assert.deepEqual(
      names.filter((name) => isDerivativeTempFileName(name)),
      [],
      `${directory} must not contain temp files after success`,
    );
  }
});

test("failure while writing the second derivative keeps old finals byte-identical and cleans temps", { skip: CHMOD_INJECTION_UNAVAILABLE && "chmod cannot make a directory unwritable here" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-atomic-fail-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const job = await makeJob(root, "atomic-fail");
  const old = await seedOldDerivatives(job);

  await chmod(dirname(job.mediumPath), 0o500);
  try {
    const result = await processDerivativeJob(fakeStore(), job);
    assert.equal(result.ok, false);
    // sharp wraps the raw fs error, so the message carries the strerror text
    // rather than the EACCES code.
    assert.match(String(result.error), /Permission denied/i);

    assert.deepEqual(await readFile(job.thumbnailPath), old.thumbnail, "old thumbnail must stay byte-identical");
    assert.deepEqual(await readFile(job.mediumPath), old.medium, "old medium must stay byte-identical");
    assert.deepEqual(await readFile(job.previewPath), old.preview, "old preview must stay byte-identical");
    for (const directory of derivativeDirectories(job)) {
      const names = await readdir(directory);
      assert.deepEqual(
        names.filter((name) => isDerivativeTempFileName(name)),
        [],
        `${directory} must not contain temp files after failure`,
      );
    }
  } finally {
    await chmod(dirname(job.mediumPath), 0o755);
  }
});

test("an uncreatable derivative target fails generation and leaves old finals untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-atomic-mkdir-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const job = await makeJob(root, "atomic-mkdir");
  const old = await seedOldDerivatives(job);

  await rm(dirname(job.mediumPath), { recursive: true, force: true });
  await writeFile(dirname(job.mediumPath), "a regular file blocks the medium directory");

  const result = await processDerivativeJob(fakeStore(), job);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /EEXIST/);

  // The injection itself removes the medium directory (and the seeded medium
  // final inside it), so only the other two finals can be checked here.
  assert.deepEqual(await readFile(job.thumbnailPath), old.thumbnail);
  assert.deepEqual(await readFile(job.previewPath), old.preview);
  const names = await readdir(dirname(job.thumbnailPath));
  assert.deepEqual(names.filter((name) => isDerivativeTempFileName(name)), []);
});

test("generation clears same-asset temp residue but never touches lookalike files", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-atomic-residue-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const id = "atomic-res";
  const job = await makeJob(root, id);
  const residuePaths = {
    thumbnail: join(dirname(job.thumbnailPath), `.${id}.webp.424242.0123456789ab.tmp`),
    medium: join(dirname(job.mediumPath), `.${id}.webp.777.abcdefabcdef.tmp`),
    preview: join(dirname(job.previewPath), `.${id}.webp.99.111122223333.tmp`),
  };
  for (const residuePath of Object.values(residuePaths)) await writeFile(residuePath, "stale half-written residue");
  const lookalikePath = join(dirname(job.thumbnailPath), `${id}.webp.tmp`);
  const otherAssetPath = join(dirname(job.thumbnailPath), ".other-asset.webp.424242.0123456789ab.tmp");
  await writeFile(lookalikePath, "not a temp file");
  await writeFile(otherAssetPath, "belongs to another asset");

  const result = await processDerivativeJob(fakeStore(), job);
  assert.equal(result.ok, true);

  for (const residuePath of Object.values(residuePaths)) {
    await assert.rejects(stat(residuePath), /ENOENT/, `stale residue ${residuePath} must be cleared`);
  }
  assert.equal(await readFile(lookalikePath, "utf8"), "not a temp file");
  assert.equal(await readFile(otherAssetPath, "utf8"), "belongs to another asset");

  const metadata = await sharp(job.thumbnailPath).metadata();
  assert.equal(metadata.format, "webp");
});

test("a hard kill during generation never leaves a half-written final file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-atomic-kill-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const originalPath = join(root, "big-source.jpg");
  await sharp({
    create: { width: 4000, height: 2600, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 40 } },
  }).jpeg({ quality: 85 }).toFile(originalPath);
  const job = await makeJob(root, "atomic-kill", { originalPath });
  await seedOldDerivatives(job);

  const store = fakeStore();
  const processor = createDerivativeProcessor();
  let killedMidway = false;
  try {
    const pending = processDerivativeJob(store, job, { processor }).then(
      (value) => ({ finished: true, value }),
      (error) => ({ finished: true, error }),
    );
    const poll = (async () => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if (!processor.pid) {
          await delay(2);
          continue;
        }
        for (const directory of derivativeDirectories(job)) {
          const names = await readdir(directory).catch(() => []);
          if (names.some((name) => isDerivativeTempFileName(name))) return true;
        }
        await delay(2);
      }
      return false;
    })();

    const observed = await Promise.race([poll.then((sawTemp) => ({ sawTemp })), pending]);
    if (!observed.finished) {
      // Kill in every unresolved case so the job below always settles; only a
      // kill after a temp file was seen counts as landing mid-generation.
      if (observed.sawTemp) killedMidway = true;
      if (processor.pid) process.kill(processor.pid, "SIGKILL");
    }
    const outcome = await pending;
    const failure = outcome.value?.error ?? (outcome.error instanceof Error ? outcome.error.message : outcome.error);
    t.diagnostic(`SIGKILL landed mid-generation: ${killedMidway}; job outcome: ${JSON.stringify(outcome.value?.ok ?? null)} ${failure ? String(failure) : ""}`);

    for (const finalPath of [job.thumbnailPath, job.mediumPath, job.previewPath]) {
      const info = await stat(finalPath).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (!info) continue;
      assert.ok(info.size > 0, `${finalPath} must not be empty`);
      const metadata = await sharp(finalPath).metadata();
      assert.equal(metadata.format, "webp", `${finalPath} must be a complete, decodable webp, never a half-written file`);
    }
  } finally {
    await processor.close();
  }
});

test("library backup excludes derivative temp residue", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-atomic-backup-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const libraryDir = join(root, "library");
  const backupDir = join(root, "backup");
  await mkdir(projectRoot, { recursive: true });
  const sourcePath = join(projectRoot, "fixture.png");
  await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 5, g: 5, b: 5 } } }).png().toFile(sourcePath);

  const store = createSqliteAssetStore({ projectRoot, managerDir, libraryDir, initializeFreshLibrary: true });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  const asset = await store.createAsset({ assetId: "atomic-backup", imagePath: sourcePath, prompt: "backup fixture" });

  const previewsDir = store.previewsDir("default");
  await mkdir(previewsDir, { recursive: true });
  const residue = join(previewsDir, derivativeTempFileName("atomic-backup.webp"));
  await writeFile(residue, "half-written residue");

  const backup = await createLibraryBackup({ projectRoot, managerDir, libraryDir, destinationDir: backupDir });
  assert.equal(backup.verification.ok, true, JSON.stringify(backup.verification?.failures ?? backup.verification));

  const manifest = JSON.parse(await readFile(join(backupDir, "backup-manifest.json"), "utf8"));
  const residueRelative = relative(libraryDir, residue);
  assert.equal(
    manifest.files.some((file) => file.path === residueRelative || file.path === residueRelative.split(sep).join("/")),
    false,
    "temp residue must not be listed in the backup manifest",
  );
  await assert.rejects(stat(join(backupDir, residueRelative)), /ENOENT/, "temp residue must not be copied into the backup");
  const originalRelative = relative(libraryDir, String(asset.image_path));
  assert.equal(
    manifest.files.some((file) => file.path === originalRelative || file.path === originalRelative.split(sep).join("/")),
    true,
    "the backup must still contain the original asset file",
  );
});
