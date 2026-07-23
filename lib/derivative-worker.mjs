import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { dirname, extname } from "node:path";

const DEFAULT_CONCURRENCY = 2;
const VIDEO_EXTENSIONS = new Set([".m4v", ".mov", ".mp4", ".webm"]);

/**
 * Drains SQLite-backed derivative jobs without blocking archive operations.
 * Jobs are durable: a running job becomes eligible again after its lease ages
 * out, so restarting MOSA never loses thumbnail work.
 */
export function createDerivativeWorker(options = {}) {
  const store = options.store;
  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || DEFAULT_CONCURRENCY, DEFAULT_CONCURRENCY));
  const idleDelayMs = Math.max(250, Number(options.idleDelayMs) || 1000);
  let stopped = true;
  let timer = null;
  let active = 0;

  async function schedule() {
    if (stopped) return;
    while (active < concurrency && !stopped) {
      const job = await store.claimDerivativeJob();
      if (!job) break;
      active += 1;
      processDerivativeJob(store, job)
        .catch(() => {})
        .finally(() => {
          active -= 1;
          void schedule();
        });
    }
    if (!stopped && active === 0) {
      clearTimeout(timer);
      timer = setTimeout(() => void schedule(), idleDelayMs);
    }
  }

  return {
    start() {
      if (!store?.derivativesAvailable || !stopped) return;
      stopped = false;
      void schedule();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    wake() {
      if (!stopped) void schedule();
    },
    get active() {
      return active;
    },
  };
}

export async function processDerivativeJob(store, job) {
  try {
    if (VIDEO_EXTENSIONS.has(extname(String(job.original_path || "")).toLowerCase())) {
      const error = "Video assets are served as original media; derivative generation is skipped.";
      await store.completeDerivativeJob(job, { error });
      return { ok: false, error, skipped: true };
    }
    await Promise.all([
      mkdir(dirname(job.previewPath), { recursive: true }),
      mkdir(dirname(job.thumbnailPath), { recursive: true }),
    ]);
    await Promise.all([
      sharp(job.original_path, { animated: false }).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).webp({ quality: 84 }).toFile(job.previewPath),
      sharp(job.original_path, { animated: false }).rotate().resize({ width: 400, height: 400, fit: "inside", withoutEnlargement: true }).webp({ quality: 78 }).toFile(job.thumbnailPath),
    ]);
    await store.completeDerivativeJob(job, { previewPath: job.previewPath, thumbnailPath: job.thumbnailPath });
    return { ok: true, previewPath: job.previewPath, thumbnailPath: job.thumbnailPath };
  } catch (error) {
    await store.completeDerivativeJob(job, { error: error instanceof Error ? error.message : String(error) });
    return { ok: false, error };
  }
}
