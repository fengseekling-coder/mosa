const DEFAULT_MAX_DROP_FILES = 10_000;
const STAGING_CONCURRENCY = 4;
const CREATE_BATCH_SIZE = 40;

function readDirectoryEntries(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function fileFromEntry(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function dropTooLargeError(maxFiles) {
  const error = new Error("Too many files were dropped.");
  error.code = "IMPORT_DROP_TOO_LARGE";
  error.maxFiles = maxFiles;
  return error;
}

export function dropErrorMessage(error, t) {
  if (error?.code === "IMPORT_DROP_TOO_LARGE") {
    return t("batchImportDropTooLarge", { max: error.maxFiles ?? DEFAULT_MAX_DROP_FILES });
  }
  return error?.message || t("batchImportFailed");
}

async function visitEntry(entry, files, scan) {
  if (!entry) return;
  if (entry.isFile) {
    // Unsupported names never count against maxFiles, so a folder full of
    // non-media files cannot exhaust the drop budget on its own.
    if (scan.isSupported && !scan.isSupported(entry.name)) {
      scan.unsupported += 1;
      return;
    }
    if (files.length >= scan.maxFiles) throw dropTooLargeError(scan.maxFiles);
    files.push(await fileFromEntry(entry));
    scan.onProgress?.(files.length);
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  while (true) {
    const entries = await readDirectoryEntries(reader);
    if (!entries.length) break;
    for (const child of entries) await visitEntry(child, files, scan);
  }
}

export async function collectDroppedFiles(dataTransfer, { maxFiles = DEFAULT_MAX_DROP_FILES, isSupported, onProgress } = {}) {
  const items = Array.from(dataTransfer?.items || []);
  const entries = items
    .filter((item) => item?.kind === "file")
    .map((item) => item.webkitGetAsEntry?.())
    .filter(Boolean);
  if (entries.length) {
    const files = [];
    const scan = { maxFiles, isSupported, onProgress, unsupported: 0 };
    for (const entry of entries) await visitEntry(entry, files, scan);
    return { files, unsupported: scan.unsupported };
  }
  const dropped = Array.from(dataTransfer?.files || []);
  const files = [];
  let unsupported = 0;
  for (const file of dropped) {
    if (isSupported && !isSupported(file.name)) {
      unsupported += 1;
      continue;
    }
    files.push(file);
  }
  if (files.length > maxFiles) throw dropTooLargeError(maxFiles);
  return { files, unsupported };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await mapper(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export function createBatchImporter({
  state,
  apiFetch,
  stageFile,
  cleanupStagedFile,
  isSupportedFile,
  announce,
  showToast,
  refreshLibrary,
  t,
}) {
  const queue = [];
  let workerPromise = null;

  function progressMessage({ completed, total, imported, failed }) {
    return t("batchImportProgress", { completed, total, imported, failed });
  }

  async function cleanupPaths(paths) {
    await mapWithConcurrency(paths, STAGING_CONCURRENCY, (path) => cleanupStagedFile(path));
  }

  async function processJob(job) {
    const supported = job.files.filter(isSupportedFile);
    const skipped = job.files.length - supported.length;
    if (!supported.length) {
      showToast?.(t("batchImportNoSupportedFiles"), "error");
      return { imported: 0, failed: 0, skipped };
    }

    const summary = { imported: 0, failed: 0, skipped };
    let completed = 0;
    announce?.(progressMessage({ completed, total: supported.length, ...summary }), { persist: true });

    for (let offset = 0; offset < supported.length; offset += CREATE_BATCH_SIZE) {
      const chunk = supported.slice(offset, offset + CREATE_BATCH_SIZE);
      const stagedResults = await mapWithConcurrency(chunk, STAGING_CONCURRENCY, async (file) => ({
        file,
        path: await stageFile(file),
      }));
      const staged = [];
      for (const result of stagedResults) {
        if (result.ok) staged.push(result.value);
        else summary.failed += 1;
      }
      if (staged.length) {
        try {
          const result = await apiFetch("/api/assets/import-batch", {
            method: "POST",
            body: {
              projectId: job.projectId,
              items: staged.map(({ file, path }) => ({
                imagePath: path,
                fileName: file.name,
                ...(job.metadata || {}),
              })),
            },
          });
          summary.imported += Number(result.imported || 0);
          summary.failed += Number(result.failed || 0);
        } catch (error) {
          summary.failed += staged.length;
          await cleanupPaths(staged.map((item) => item.path));
          job.errors.push(error);
        }
      }
      completed += chunk.length;
      announce?.(progressMessage({ completed, total: supported.length, ...summary }), { persist: true });
    }

    await refreshLibrary?.();
    announce?.("");
    if (summary.failed) {
      showToast?.(t("batchImportPartial", summary), "error");
    } else if (summary.skipped) {
      showToast?.(t("batchImportSkipped", summary), "info");
    } else {
      showToast?.(t("batchImportComplete", summary), "success");
    }
    if (job.errors.length) {
      console.warn(`[MOSA] batch import: ${job.errors.length} chunk request(s) failed:`, job.errors);
    }
    return summary;
  }

  async function drain() {
    while (queue.length) {
      const job = queue.shift();
      try {
        job.resolve(await processJob(job));
      } catch (error) {
        announce?.("");
        showToast?.(error?.message || t("batchImportFailed"), "error");
        job.reject(error);
      }
    }
    workerPromise = null;
  }

  function enqueue(files, { metadata = {}, projectId = state.project } = {}) {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length) return Promise.resolve({ imported: 0, failed: 0, skipped: 0 });
    const promise = new Promise((resolve, reject) => {
      queue.push({ files: list, metadata, projectId, resolve, reject, errors: [] });
    });
    showToast?.(t("batchImportQueued", { count: list.length }), "info");
    if (!workerPromise) workerPromise = drain();
    return promise;
  }

  return {
    enqueue,
    isBusy: () => Boolean(workerPromise),
    queuedJobs: () => queue.length,
  };
}
