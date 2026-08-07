import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import {
  cleanupOrphanStagedFiles,
  ImportStagingError,
  importStagingDir,
  isWithinStagingRoot,
  removeStagedImport,
  STAGING_EXTENSIONS,
  stageFileForImport,
  writeStagedPng,
} from "../lib/import-staging.mjs";
import { SUPPORTED_MEDIA_EXTENSIONS } from "../lib/asset-store.mjs";

const root = resolve(import.meta.dirname, "..");
const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function makeWorkspace(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeFixture(dir, name, bytes = ONE_PIXEL_PNG) {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

async function waitFor(condition, timeoutMs = 3000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, stepMs));
  }
  throw new Error("waitFor timed out");
}

function assertStagingError(error, code) {
  assert.ok(error instanceof ImportStagingError, `expected ImportStagingError, got ${error?.constructor?.name}`);
  assert.equal(error.code, code);
}

// ── pure helper contract ──────────────────────────────────────────────────────

test("external plain PNG is copied into the staging root (original untouched)", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-copy-");
  const sourcePath = await writeFixture(dir, "original.png");
  const stagingRoot = importStagingDir(join(dir, "userData"));
  const staged = await stageFileForImport({ sourcePath, stagingRoot });

  assert.ok(isWithinStagingRoot(stagingRoot, staged), "staged path must be inside the staging root");
  assert.equal(sha256(await readFile(staged)), sha256(ONE_PIXEL_PNG), "staged copy must match source bytes");
  assert.equal(sha256(await readFile(sourcePath)), sha256(ONE_PIXEL_PNG), "original must be untouched");
  assert.equal(existsSync(sourcePath), true);
});

test("staged file name is generated, unique, and cannot traverse directories", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-name-");
  const sourcePath = await writeFixture(dir, "name.png");
  const stagingRoot = importStagingDir(join(dir, "userData"));
  const names = new Set();
  for (let i = 0; i < 5; i += 1) {
    const staged = await stageFileForImport({ sourcePath, stagingRoot });
    const name = basename(staged);
    assert.equal(name, staged.slice(stagingRoot.length + 1), "target name must be a plain basename");
    assert.ok(!name.includes(sep) && !name.includes(".."), "target name must not contain path separators");
    assert.match(name, /^import-\d+-[0-9a-f]{8}\.png$/);
    names.add(name);
  }
  assert.equal(names.size, 5, "concurrent same-ms stages must stay unique");
});

test("extension is preserved for supported media types", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-ext-");
  const sourcePath = await writeFixture(dir, "photo.JPG");
  const staged = await stageFileForImport({ sourcePath, stagingRoot: importStagingDir(join(dir, "userData")) });
  assert.ok(staged.endsWith(".JPG") || staged.endsWith(".jpg"), "staged file must keep a supported extension");
});

test("symbolic links are rejected", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-link-");
  const target = await writeFixture(dir, "target.png");
  const link = join(dir, "link.png");
  await symlink(target, link);
  await assert.rejects(
    stageFileForImport({ sourcePath: link, stagingRoot: importStagingDir(join(dir, "userData")) }),
    (error) => { assertStagingError(error, "STAGING_SOURCE_IS_SYMLINK"); return true; },
  );
});

test("directories are rejected", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-dir-");
  const sourcePath = join(dir, "folder.png");
  await mkdir(sourcePath, { recursive: true });
  await assert.rejects(
    stageFileForImport({ sourcePath, stagingRoot: importStagingDir(join(dir, "userData")) }),
    (error) => { assertStagingError(error, "STAGING_SOURCE_NOT_FILE"); return true; },
  );
});

test("missing files are rejected", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-missing-");
  await assert.rejects(
    stageFileForImport({ sourcePath: join(dir, "nope.png"), stagingRoot: importStagingDir(join(dir, "userData")) }),
    (error) => { assertStagingError(error, "STAGING_SOURCE_NOT_FOUND"); return true; },
  );
});

test("URL-like sources are rejected", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-url-");
  await assert.rejects(
    stageFileForImport({ sourcePath: "http://example.com/a.png", stagingRoot: importStagingDir(join(dir, "userData")) }),
    (error) => { assertStagingError(error, "STAGING_URL_NOT_ALLOWED"); return true; },
  );
  await assert.rejects(
    stageFileForImport({ sourcePath: "file:///etc/hosts", stagingRoot: importStagingDir(join(dir, "userData")) }),
    (error) => { assertStagingError(error, "STAGING_URL_NOT_ALLOWED"); return true; },
  );
});

test("unsupported media types are rejected", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-type-");
  const sourcePath = await writeFixture(dir, "note.txt", Buffer.from("hello"));
  await assert.rejects(
    stageFileForImport({ sourcePath, stagingRoot: importStagingDir(join(dir, "userData")) }),
    (error) => { assertStagingError(error, "STAGING_UNSUPPORTED_TYPE"); return true; },
  );
});

test("pasted PNG bytes land inside the same staging root with a unique name", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-paste-");
  const stagingRoot = importStagingDir(join(dir, "userData"));
  const pasted = await writeStagedPng(stagingRoot, ONE_PIXEL_PNG);
  assert.ok(isWithinStagingRoot(stagingRoot, pasted), "paste must live inside the staging root");
  assert.ok(basename(pasted).startsWith("paste-"), "paste file must use the paste prefix");
  assert.ok(pasted.endsWith(".png"));
  const second = await writeStagedPng(stagingRoot, ONE_PIXEL_PNG);
  assert.notEqual(pasted, second, "paste files must stay unique");
});

test("removeStagedImport deletes only plain files inside the exact staging root", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-remove-");
  const userDataDir = join(dir, "userData");
  const stagingRoot = importStagingDir(userDataDir);
  const sourcePath = await writeFixture(dir, "original.png");
  const staged = await stageFileForImport({ sourcePath, stagingRoot });
  const outside = await writeFixture(userDataDir, "other.png");

  assert.equal((await removeStagedImport(stagingRoot, staged)).ok, true);
  assert.equal(existsSync(staged), false, "staged copy must be removed");
  assert.equal(existsSync(sourcePath), true, "user original must never be deleted");
  assert.equal(existsSync(outside), true, "files outside staging must never be deleted");

  const result = await removeStagedImport(stagingRoot, outside);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "outside-staging");
  assert.equal(existsSync(outside), true);
});

test("removeStagedImport refuses symlinks even when placed inside the staging root", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-remove-link-");
  const stagingRoot = importStagingDir(join(dir, "userData"));
  const target = await writeFixture(dir, "target.png");
  const link = join(stagingRoot, "import-link.png");
  await mkdir(stagingRoot, { recursive: true });
  await symlink(target, link);
  const result = await removeStagedImport(stagingRoot, link);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-plain-file");
  assert.equal(existsSync(target), true);
});

test("orphan sweep removes only stale plain files inside the staging root", async (t) => {
  const dir = await makeWorkspace(t, "mosa-stage-orphan-");
  const userDataDir = join(dir, "userData");
  const stagingRoot = importStagingDir(userDataDir);
  const now = Date.now();
  const fresh = await writeFixture(stagingRoot, "import-fresh.png");
  const stale = await writeFixture(stagingRoot, "import-stale.png");
  await writeFile(join(stagingRoot, "import-stale-2.png"), ONE_PIXEL_PNG);
  await utimes(stale, new Date(now - 3_600_000), new Date(now - 3_600_000));
  await utimes(join(stagingRoot, "import-stale-2.png"), new Date(now - 3_600_000), new Date(now - 3_600_000));
  const outside = await writeFixture(userDataDir, "outside-old.png");
  await utimes(outside, new Date(now - 3_600_000), new Date(now - 3_600_000));
  const dirEntry = join(stagingRoot, "keep-dir");
  await mkdir(dirEntry, { recursive: true });

  const result = await cleanupOrphanStagedFiles(stagingRoot, { ttlMs: 60_000, now: () => now });
  assert.equal(result.removed, 2, "only the two stale plain files are removed");
  assert.equal(result.failed, 0);
  assert.equal(existsSync(fresh), true, "fresh staged file must survive");
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(dirEntry), true, "directories must never be removed");
  assert.equal(existsSync(outside), true, "staging-adjacent files must never be removed");
});

test("cleanupOrphanStagedFiles tolerates a missing staging root", async () => {
  const result = await cleanupOrphanStagedFiles(join(await mkdtemp(join(tmpdir(), "mosa-stage-missing-root-")), "never-created"));
  assert.deepEqual(result, { removed: 0, failed: 0 });
});

test("preload surface and Electron security boundaries are unchanged", async () => {
  const preload = await readFile(join(root, "desktop", "preload.cjs"), "utf8");
  const exposed = [...preload.matchAll(/^\s{2}(\w+):/gm)].map((match) => match[1]).sort();
  assert.deepEqual(exposed, [
    "getPathForFile",
    "onMenuImport",
    "onMenuSearch",
    "openFileDialog",
    "pasteImage",
    "setLocale",
    "showItemInFolder",
  ], "electronAPI surface must not grow or shrink");

  const main = await readFile(join(root, "desktop", "main.mjs"), "utf8");
  assert.match(main, /ipcMain\.handle\("show-item-in-folder"/, "Finder IPC handler must remain");
  assert.match(main, /contextIsolation: true/, "contextIsolation must remain");
  assert.match(main, /nodeIntegration: false/, "nodeIntegration must remain disabled");
  assert.match(main, /sandbox: true/, "sandbox must remain enabled");
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)/, "window open handler must stay deny");
});

// ── runtime integration: trust boundary and cleanup ──────────────────────────

async function startAuditRuntime(t, { userDataDir, withStagingRoot }) {
  const libraryDir = join(userDataDir, "library");
  const projectRoot = join(userDataDir, "project");
  await mkdir(projectRoot, { recursive: true });
  const runtime = await startMosaRuntime({
    port: 0,
    libraryDir,
    projectRoot,
    managerDir: userDataDir,
    appDir: join(userDataDir, "app"),
    assetsRoot: join(libraryDir, "assets"),
    generatedImagesDir: join(libraryDir, "imports"),
    disabledBridges: ["cowart", "cowartDiscovery", "codex", "grok"],
    importStagingRoot: withStagingRoot ? importStagingDir(userDataDir) : null,
  });
  t.after(async () => { await runtime.stop(); });
  return runtime;
}

async function createViaApi(runtime, imagePath) {
  const response = await fetch(`${runtime.url}/api/assets/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: "default", imagePath, prompt: "staging contract" }),
  });
  return { status: response.status, body: await response.json() };
}

test("desktop runtime trusts only the exact staging root, never its parent", async (t) => {
  const userDataDir = await makeWorkspace(t, "mosa-stage-runtime-");
  const stagingRoot = importStagingDir(userDataDir);
  const outsideRoot = await writeFixture(userDataDir, "outside-root.png");
  const parentSibling = await writeFixture(dirname(stagingRoot), "sibling-of-staging.png");
  const runtime = await startAuditRuntime(t, { userDataDir, withStagingRoot: true });
  const staged = await stageFileForImport({ sourcePath: outsideRoot, stagingRoot });

  const inside = await createViaApi(runtime, staged);
  assert.equal(inside.status, 200, `staged import should succeed, got ${inside.status} ${JSON.stringify(inside.body)}`);

  const sibling = await createViaApi(runtime, parentSibling);
  assert.equal(sibling.status, 400, "staging parent directory must not be trusted");
  assert.match(sibling.body.error, /outside the project roots/);

  const unrelated = await createViaApi(runtime, outsideRoot);
  assert.equal(unrelated.status, 400, "other userData files must not be trusted");
  assert.match(unrelated.body.error, /outside the project roots/);
});

test("successful staged import removes the staged copy after the store copied it", async (t) => {
  const userDataDir = await makeWorkspace(t, "mosa-stage-cleanup-");
  const stagingRoot = importStagingDir(userDataDir);
  const sourcePath = await writeFixture(userDataDir, "original.png");
  const runtime = await startAuditRuntime(t, { userDataDir, withStagingRoot: true });
  const staged = await stageFileForImport({ sourcePath, stagingRoot });

  const result = await createViaApi(runtime, staged);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.asset.image_path.startsWith(join(userDataDir, "library")), true, "asset must live in the library");
  await waitFor(async () => !existsSync(staged));
  assert.equal(existsSync(sourcePath), true, "user original must survive the import");
});

test("Web/server mode without a staging root keeps the default boundary", async (t) => {
  const userDataDir = await makeWorkspace(t, "mosa-stage-web-");
  const stagingRoot = importStagingDir(userDataDir);
  const sourcePath = await writeFixture(userDataDir, "original.png");
  const runtime = await startAuditRuntime(t, { userDataDir, withStagingRoot: false });
  const staged = await stageFileForImport({ sourcePath, stagingRoot });

  const result = await createViaApi(runtime, staged);
  assert.equal(result.status, 400, "Web mode must not gain Electron staging privileges");
  assert.match(result.body.error, /outside the project roots/);
});

// ── batch 1.1: one format set, visible failures ──────────────────────────────

test("staging extensions mirror the store's supported media set exactly", () => {
  assert.deepEqual([...STAGING_EXTENSIONS].sort(), SUPPORTED_MEDIA_EXTENSIONS);
});

test("native dialog is single-file and derives its filters from STAGING_EXTENSIONS", async () => {
  const main = await readFile(join(root, "desktop", "main.mjs"), "utf8");
  const dialog = main.match(/ipcMain\.handle\("open-file-dialog"[\s\S]*?\n  }\);/)[0];

  assert.match(dialog, /properties: \["openFile"\]/, "dialog must be single-file");
  assert.doesNotMatch(dialog, /multiSelections/, "no multi-selection dialog");
  assert.match(dialog, /filters: importDialogFilters\(\)/, "filters must derive from the staging set");
  assert.equal(dialog.match(/stageFileForImport/g)?.length, 1, "exactly one file is staged");
  assert.doesNotMatch(main, /"bmp"|"tiff"|"tif"/, "BMP/TIFF must never be advertised");
  assert.match(main, /"\.apng"/, "APNG must be advertised");
  assert.match(main, /"\.avif"/, "AVIF must be advertised");

  const groupLiteral = (name) => {
    const match = main.match(new RegExp(`${name} = new Set\\(\\[([^\\]]+)\\]\\)`));
    assert.ok(match, `${name} group literal must exist`);
    return [...match[1].matchAll(/"(\.[a-z0-9]+)"/g)].map((entry) => entry[1]);
  };
  const dialogSet = [...groupLiteral("DIALOG_IMAGE_GROUP"), ...groupLiteral("DIALOG_VIDEO_GROUP")].sort();
  assert.deepEqual(dialogSet, SUPPORTED_MEDIA_EXTENSIONS, "dialog groups must cover exactly the store set");
});

test("staging failure propagates via IPC rejection without the raw path", async () => {
  const main = await readFile(join(root, "desktop", "main.mjs"), "utf8");
  const dialog = main.match(/ipcMain\.handle\("open-file-dialog"[\s\S]*?\n  }\);/)[0];
  assert.match(dialog, /console\.error/, "main-process diagnostics are kept");
  assert.match(dialog, /throw new Error/, "failure must reject instead of returning []");
  assert.match(dialog, /import-staging failed \(\$\{error\?\.code/, "rejection is sanitized (code only, no path)");
  assert.doesNotMatch(dialog, /return staged/, "no partial-result return");
});

test("drag/drop pattern matches the store set and renderer failures are visible", async () => {
  const app = await readFile(join(root, "app", "app.js"), "utf8");
  const pattern = app.match(/\/\\\.\(([a-z0-9|?]+)\)\$\/i/);
  assert.ok(pattern, "drop extension pattern must exist");
  const dropSet = pattern[1]
    .split("|")
    .flatMap((alt) => {
      const optional = alt.match(/^(.+)([a-z])\?([a-z]+)$/);
      if (!optional) return [alt];
      const [, prefix, optionalLetter, rest] = optional;
      return [`${prefix}${optionalLetter}${rest}`, `${prefix}${rest}`];
    })
    .map((extension) => `.${extension}`)
    .sort();
  assert.deepEqual(dropSet, SUPPORTED_MEDIA_EXTENSIONS, "drag/drop must accept exactly the store set");

  const browse = app.match(/#browseFileBtn[\s\S]*?\n  }\);/)[0];
  assert.match(browse, /try \{/, "browse handler must catch");
  assert.match(browse, /catch \{/, "browse handler must catch");
  assert.match(browse, /showToast\(t\("fileSelectionFailed"\), "error"\)/, "visible failure toast");

  const i18n = await readFile(join(root, "app", "i18n.mjs"), "utf8");
  assert.equal((i18n.match(/fileSelectionFailed:/g) || []).length, 2, "zh + en keys exist");
});

// ── batch 1.2: drag & drop staging ───────────────────────────────────────────

test("drag & drop paths are staged in the main process, never handed to the renderer", async () => {
  const [preload, main, app] = await Promise.all([
    readFile(join(root, "desktop", "preload.cjs"), "utf8"),
    readFile(join(root, "desktop", "main.mjs"), "utf8"),
    readFile(join(root, "app", "app.js"), "utf8"),
  ]);

  // preload: getPathForFile must not synchronously return the raw path; it
  // forwards the resolved path string to the main-process staging channel.
  assert.doesNotMatch(
    preload,
    /getPathForFile: \(file\) => webUtils\.getPathForFile\(file\)/,
    "getPathForFile must no longer return the raw external path",
  );
  assert.match(preload, /getPathForFile: async \(file\) => \{/, "getPathForFile must be async");
  assert.match(preload, /webUtils\.getPathForFile\(file\)/, "path resolution still uses webUtils");
  assert.match(preload, /ipcRenderer\.invoke\("stage-dropped-file", sourcePath\)/, "raw path only goes to the staging channel");

  // main: the staging handler copies into the trusted root and rejects with a
  // sanitized error (code only), keeping main-process diagnostics.
  const handler = main.match(/ipcMain\.handle\("stage-dropped-file"[\s\S]*?\n  }\);/)[0];
  assert.match(handler, /event\.sender !== mainWindow\.webContents/, "only the main window renderer may stage drops");
  assert.match(handler, /stageFileForImport\(\{ sourcePath, stagingRoot: importStagingRoot \}\)/, "drop staging reuses the trusted root");
  assert.match(handler, /console\.error/, "main-process diagnostics are kept");
  assert.match(handler, /throw new Error\(`import-staging failed \(\$\{error\?\.code/, "failure rejects with a sanitized error");

  // app: the drop handler awaits staging and never falls back to File.path in
  // Electron (File.path would be exactly the raw path this batch removes).
  assert.match(app, /async function droppedFilePath\(file\)/, "droppedFilePath must be async");
  assert.match(app, /await window\.electronAPI\.getPathForFile\(file\)/, "renderer awaits the staged path");
  assert.match(app, /library\.addEventListener\("drop", async \(e\) => \{/, "drop handler must await staging");
  assert.match(app, /filePath = await droppedFilePath\(file\);/, "drop handler consumes the staged path");
  assert.match(app, /showToast\(t\("fileSelectionFailed"\), "error"\);/, "staging failure is visible to the user");
  const electronBranch = app.slice(app.indexOf("async function droppedFilePath"), app.indexOf("// 纯浏览器回退"));
  assert.doesNotMatch(electronBranch, /file\.path/, "Electron branch must never fall back to the raw File.path");
});

// ── batch 1.3: drop failure state hygiene + legacy contract sync ─────────────

test("drop failures clear the live region and never open an empty import modal", async () => {
  const app = await readFile(join(root, "app", "app.js"), "utf8");
  const drop = app.match(/library\.addEventListener\("drop", async \(e\) => \{[\s\S]*?\n  }\);/)[0];

  // staging 异常：必须清空 live region 后 toast，绝不落入打开 Modal 的路径。
  const catchBlock = drop.slice(drop.indexOf("} catch {"), drop.indexOf("if (!filePath)"));
  assert.match(catchBlock, /announceGalleryStatus\(""\);/, "staging failure clears the live region");
  assert.match(catchBlock, /showToast\(t\("fileSelectionFailed"\), "error"\);/, "staging failure shows the visible toast");

  // 无路径：先清空并 return，openImportModal 必须位于该 return 之后。
  const noPathBlock = drop.slice(drop.indexOf("if (!filePath)"));
  assert.match(noPathBlock, /announceGalleryStatus\(""\);/, "no-path branch clears the live region");
  assert.match(noPathBlock, /showToast\(t\("dropPathUnavailable"\), "error"\);/, "no-path branch shows the unavailable toast");
  const modalOpenIndex = noPathBlock.indexOf("openImportModal();");
  const noPathReturnIndex = noPathBlock.indexOf("return;");
  assert.ok(modalOpenIndex > noPathReturnIndex, "openImportModal must run only after the no-path return");

  // 无文件：清空持久 live region，不留误导性的"已收到文件"。
  const noFilesBlock = drop.slice(drop.indexOf("if (!files || !files.length)"), drop.indexOf("const file = files[0];"));
  assert.match(noFilesBlock, /announceGalleryStatus\(""\);/, "no-files branch clears the live region");
});

test("legacy preload.mjs contract comment reflects the staged drag & drop flow", async () => {
  const legacy = await readFile(join(root, "desktop", "preload.mjs"), "utf8");
  assert.match(legacy, /LEGACY \/ NOT LOADED BY ELECTRON/, "legacy marker remains");
  assert.match(legacy, /preload\.cjs/, "migration note remains");
  assert.doesNotMatch(legacy, /getPathForFile: \(file\) => webUtils\.getPathForFile\(file\)/, "legacy comment must not claim the old synchronous contract");
  assert.match(legacy, /getPathForFile: async \(file\) => \{/, "legacy comment tracks the async staging flow");
  assert.match(legacy, /stage-dropped-file/, "legacy comment tracks the staging channel");
});
