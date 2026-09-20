import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { collectDroppedFiles, createBatchImporter, dropErrorMessage } from "../app/batch-import.mjs";
import { dragGestureOwner, dragIdsForCard, pointOutsideWindow } from "../app/drag-gesture.mjs";

const root = resolve(import.meta.dirname, "..");

test("drag gesture ownership stays natural and promotes only after leaving the window", () => {
  assert.equal(dragGestureOwner({}, { startsOnCard: false }), "marquee");
  assert.equal(dragGestureOwner({}, { startsOnCard: true }), "internal-asset");
  assert.equal(dragGestureOwner({ shiftKey: true }, { startsOnCard: true }), "marquee");
  assert.equal(dragGestureOwner({ altKey: true }, { startsOnCard: true }), "internal-asset");
  const metrics = { screenX: 100, screenY: 200, outerWidth: 800, outerHeight: 600 };
  assert.equal(pointOutsideWindow({ screenX: 120, screenY: 220 }, metrics), false);
  assert.equal(pointOutsideWindow({ screenX: 50, screenY: 220 }, metrics), true);
  assert.equal(pointOutsideWindow({ screenX: 920, screenY: 220 }, metrics), true);
  assert.deepEqual(dragIdsForCard({ selectedIds: new Set(["a", "b"]) }, "a"), ["a", "b"]);
  assert.deepEqual(dragIdsForCard({ selectedIds: new Set(["a", "b"]) }, "c"), ["c"]);
});

test("batch importer stages concurrently, creates in batches, and refreshes once", async () => {
  const calls = [];
  let refreshCount = 0;
  const state = { project: "default" };
  const importer = createBatchImporter({
    state,
    isSupportedFile: (file) => file.name.endsWith(".png"),
    stageFile: async (file) => `/stage/${file.name}`,
    cleanupStagedFile: async (path) => calls.push(["cleanup", path]),
    apiFetch: async (path, options) => {
      calls.push([path, options.body.items.map((item) => item.imagePath)]);
      return {
        imported: options.body.items.length,
        failed: 0,
        results: options.body.items.map((item, index) => ({ index, ok: true, asset: { id: item.fileName } })),
      };
    },
    announce: () => {},
    showToast: () => {},
    refreshLibrary: async () => { refreshCount += 1; },
    t: (key, values = {}) => `${key}:${JSON.stringify(values)}`,
  });

  const files = Array.from({ length: 45 }, (_, index) => ({ name: `asset-${index}.png` }));
  const summary = await importer.enqueue(files);
  assert.deepEqual(summary, { imported: 45, failed: 0, skipped: 0 });
  assert.equal(refreshCount, 1);
  assert.equal(calls.filter(([name]) => name === "/api/assets/import-batch").length, 2);
  assert.equal(importer.isBusy(), false);
  assert.equal(importer.queuedJobs(), 0);
});

test("batch importer snapshots drop metadata onto every created asset", async () => {
  const requestBodies = [];
  const importer = createBatchImporter({
    state: { project: "default" },
    isSupportedFile: (file) => file.name.endsWith(".png"),
    stageFile: async (file) => `/stage/${file.name}`,
    cleanupStagedFile: async () => {},
    apiFetch: async (_path, options) => {
      requestBodies.push(options.body);
      return { imported: options.body.items.length, failed: 0, results: [] };
    },
    announce: () => {},
    showToast: () => {},
    refreshLibrary: async () => {},
    t: (key, values = {}) => `${key}:${JSON.stringify(values)}`,
  });

  const metadata = { group: "Mid Autumn" };
  const pending = importer.enqueue([{ name: "a.png" }, { name: "b.png" }], { metadata });
  metadata.group = "Changed after enqueue";
  await pending;

  assert.equal(requestBodies.length, 1);
  assert.deepEqual(requestBodies[0].items.map((item) => item.group), ["Mid Autumn", "Mid Autumn"]);
});

test("batch importer snapshots the active Stack when queued", async () => {
  const requestBodies = [];
  const state = { project: "default", activeStackId: "stack-a" };
  const importer = createBatchImporter({
    state,
    isSupportedFile: (file) => file.name.endsWith(".png"),
    stageFile: async (file) => `/stage/${file.name}`,
    cleanupStagedFile: async () => {},
    apiFetch: async (_path, options) => {
      requestBodies.push(options.body);
      return { imported: options.body.items.length, failed: 0, results: [] };
    },
    announce: () => {},
    showToast: () => {},
    refreshLibrary: async () => {},
    t: (key, values = {}) => `${key}:${JSON.stringify(values)}`,
  });

  const pending = importer.enqueue([{ name: "a.png" }]);
  state.activeStackId = "stack-b";
  await pending;

  assert.equal(requestBodies.length, 1);
  assert.equal(requestBodies[0].stackId, "stack-a");
});

function fileEntry(name) {
  return { isFile: true, isDirectory: false, name, file: (resolve) => resolve({ name }) };
}

function directoryEntry(name, children) {
  const remaining = [...children];
  return {
    isFile: false,
    isDirectory: true,
    name,
    // The DOM FileSystem API is callback-based and hands entries back in
    // chunks; emulate both shapes.
    createReader: () => ({ readEntries: (resolve) => resolve(remaining.splice(0, 2)) }),
  };
}

function isMediaName(name) {
  return /\.(apng|avif|gif|jpe?g|png|svg|webp|m4v|mov|mp4|webm)$/i.test(name);
}

test("collectDroppedFiles walks folders, filters unsupported names, and reports them", async () => {
  const dataTransfer = {
    items: [
      { kind: "file", webkitGetAsEntry: () => fileEntry("a.png") },
      {
        kind: "file",
        webkitGetAsEntry: () => directoryEntry("folder", [
          fileEntry("b.jpg"),
          fileEntry("notes.txt"),
          fileEntry(".DS_Store"),
          directoryEntry("nested", [fileEntry("c.mp4")]),
        ]),
      },
      { kind: "string", webkitGetAsEntry: () => null },
    ],
  };
  const { files, unsupported } = await collectDroppedFiles(dataTransfer, { isSupported: isMediaName });
  assert.deepEqual(files.map((file) => file.name), ["a.png", "b.jpg", "c.mp4"]);
  assert.equal(unsupported, 2);
});

test("the drop budget only counts supported files, so junk cannot exhaust it", async () => {
  const noisyFolder = directoryEntry("noisy", [
    ...Array.from({ length: 500 }, (_, index) => fileEntry(`note-${index}.txt`)),
    fileEntry("keep.png"),
  ]);
  const ok = await collectDroppedFiles(
    { items: [{ kind: "file", webkitGetAsEntry: () => noisyFolder }] },
    { maxFiles: 10, isSupported: isMediaName },
  );
  assert.deepEqual(ok.files.map((file) => file.name), ["keep.png"]);
  assert.equal(ok.unsupported, 500);

  const over = directoryEntry("over", [fileEntry("1.png"), fileEntry("2.png"), fileEntry("3.png")]);
  await assert.rejects(
    collectDroppedFiles({ items: [{ kind: "file", webkitGetAsEntry: () => over }] }, { maxFiles: 2, isSupported: isMediaName }),
    (error) => error.code === "IMPORT_DROP_TOO_LARGE" && error.maxFiles === 2,
  );
});

test("plain file lists fall back without entry support and errors localize at display time", async () => {
  const { files, unsupported } = await collectDroppedFiles(
    { files: [{ name: "x.png" }, { name: "y.txt" }] },
    { isSupported: isMediaName },
  );
  assert.deepEqual(files.map((file) => file.name), ["x.png"]);
  assert.equal(unsupported, 1);

  const t = (key, values = {}) => `${key}:${JSON.stringify(values)}`;
  const tooLarge = new Error("Too many files were dropped.");
  tooLarge.code = "IMPORT_DROP_TOO_LARGE";
  tooLarge.maxFiles = 7;
  assert.equal(dropErrorMessage(tooLarge, t), 'batchImportDropTooLarge:{"max":7}');
  assert.equal(dropErrorMessage(new Error("boom"), t), "boom");
  assert.equal(dropErrorMessage(null, t), "batchImportFailed:{}");
});

test("skipped-only imports toast as info while real failures stay errors", async () => {
  const toasts = [];
  function makeImporter(apiFetch) {
    return createBatchImporter({
      state: { project: "default" },
      isSupportedFile: (file) => isMediaName(file.name),
      stageFile: async (file) => `/stage/${file.name}`,
      cleanupStagedFile: async () => {},
      apiFetch,
      announce: () => {},
      showToast: (message, kind) => toasts.push([message, kind]),
      refreshLibrary: async () => {},
      t: (key, values = {}) => `${key}:${JSON.stringify(values)}`,
    });
  }
  await makeImporter(async () => ({ imported: 1, failed: 0 })).enqueue([{ name: "a.png" }, { name: "b.txt" }]);
  assert.deepEqual(toasts.pop(), ['batchImportSkipped:{"imported":1,"failed":0,"skipped":1}', "info"]);
  await makeImporter(async () => { throw new Error("offline"); }).enqueue([{ name: "a.png" }]);
  assert.deepEqual(toasts.pop(), ['batchImportPartial:{"imported":0,"failed":1,"skipped":0}', "error"]);
});

test("desktop native drag bridge validates library paths in main process", async () => {
  const [preload, main, nativeDrag, stacks] = await Promise.all([
    readFile(resolve(root, "desktop/preload.cjs"), "utf8"),
    readFile(resolve(root, "desktop/main.mjs"), "utf8"),
    readFile(resolve(root, "app/native-asset-drag.mjs"), "utf8"),
    readFile(resolve(root, "app/asset-stacks.mjs"), "utf8"),
  ]);
  assert.match(preload, /startNativeDrag: \(paths\) => ipcRenderer\.invoke\("start-native-file-drag", paths\)/);
  assert.match(main, /ipcMain\.handle\("start-native-file-drag"/);
  assert.match(main, /resolveAllowedFolderPath\(requestedPath\.trim\(\), \[libraryDir\]\)/);
  assert.match(main, /event\.sender\.startDrag\(\{ file: files\[0\], files, icon \}\)/);
  assert.match(nativeDrag, /pointOutsideWindow\(event, window\)/);
  assert.doesNotMatch(nativeDrag, /altKey|draggable\s*=\s*true|addEventListener\("dragstart"/);
  assert.match(stacks, /nativeAssetDrag\?\.startIfOutside\?\.\(event\)/);
  assert.doesNotMatch(stacks, /isNativeFileDragGesture/);
});
