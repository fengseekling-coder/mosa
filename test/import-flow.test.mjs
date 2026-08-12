import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createJsonAssetStore, SUPPORTED_MEDIA_EXTENSIONS } from "../lib/asset-store.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";

const root = resolve(import.meta.dirname, "..");
const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

async function makeWorkspace(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const projectRoot = join(dir, "project");
  const generated = join(projectRoot, "generated-images");
  await mkdir(generated, { recursive: true });
  const imagePath = join(generated, "fixture.png");
  await writeFile(imagePath, ONE_PIXEL_PNG);
  return { dir, projectRoot, generated, imagePath };
}

for (const kind of ["json", "sqlite"]) {
  test(`${kind} store tags every import rejection with the field that caused it`, async (t) => {
    const { dir, projectRoot, generated, imagePath } = await makeWorkspace(t, `mosa-import-${kind}-`);
    const store = kind === "sqlite"
      ? createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir: join(dir, "library") })
      : createJsonAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa") });
    if (kind === "sqlite") t.after(() => store.close());

    // Codes let the form place each message; the prose stays as it was.
    await assert.rejects(store.createAsset({}), (error) => {
      assert.equal(error.code, "IMAGE_PATH_REQUIRED");
      assert.equal(error.statusCode, 400);
      return true;
    });

    await assert.rejects(store.createAsset({ imagePath: join(generated, "missing.png") }), (error) => {
      assert.equal(error.code, "IMAGE_PATH_NOT_FOUND");
      assert.equal(error.statusCode, 400);
      return true;
    });

    const textPath = join(generated, "notes.txt");
    await writeFile(textPath, "not an image");
    await assert.rejects(store.createAsset({ imagePath: textPath }), (error) => {
      assert.equal(error.code, "IMAGE_PATH_UNSUPPORTED_TYPE");
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /Unsupported media type/);
      return true;
    });

    const linkPath = join(generated, "link.png");
    await symlink(imagePath, linkPath);
    await assert.rejects(store.createAsset({ imagePath: linkPath }), (error) => {
      assert.equal(error.code, "IMAGE_PATH_NOT_READABLE");
      assert.match(error.message, /Refusing to import symbolic links/);
      return true;
    });

    const outsideDir = await mkdtemp(join(tmpdir(), `mosa-import-outside-${kind}-`));
    t.after(() => rm(outsideDir, { recursive: true, force: true }));
    const outsidePath = join(outsideDir, "outside.png");
    await writeFile(outsidePath, ONE_PIXEL_PNG);
    await assert.rejects(store.createAsset({ imagePath: outsidePath }), (error) => {
      assert.equal(error.code, "IMAGE_PATH_NOT_READABLE");
      assert.match(error.message, /Refusing to import outside the project roots/);
      return true;
    });

    // A valid import still succeeds with only a path.
    const asset = await store.createAsset({ imagePath });
    assert.ok(asset.id);
  });
}

test("import rejections reach the client as 400 with a code, and the format list is served", async (t) => {
  const { dir, projectRoot, generated, imagePath } = await makeWorkspace(t, "mosa-import-api-");
  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: dir,
    libraryDir: join(dir, "library"),
    assetsRoot: join(dir, "assets"),
    generatedImagesDir: generated,
    codexImagesDir: join(dir, "codex-images"),
    codexSessionsDir: join(dir, "sessions"),
    grokSessionsDir: join(dir, "grok-sessions"),
    cowartCanvasDir: join(dir, "cowart-data"),
    cowartRegistryPath: join(dir, "state", "cowart-projects.json"),
  });
  t.after(() => runtime.stop());

  const post = (body) => fetch(`${runtime.url}/api/assets/create`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  const missingPath = await post({ projectId: "default" });
  assert.equal(missingPath.status, 400);
  assert.equal((await missingPath.json()).code, "IMAGE_PATH_REQUIRED");

  const notFound = await post({ projectId: "default", imagePath: join(generated, "nope.png") });
  assert.equal(notFound.status, 400);
  assert.equal((await notFound.json()).code, "IMAGE_PATH_NOT_FOUND");

  const textPath = join(generated, "notes.txt");
  await writeFile(textPath, "not an image");
  const unsupported = await post({ projectId: "default", imagePath: textPath });
  assert.equal(unsupported.status, 400);
  assert.equal((await unsupported.json()).code, "IMAGE_PATH_UNSUPPORTED_TYPE");

  // The hint is served rather than duplicated in the client, so it cannot claim
  // a format the store would reject.
  const library = await (await fetch(`${runtime.url}/api/library-path`)).json();
  assert.deepEqual(library.supportedMediaExtensions, SUPPORTED_MEDIA_EXTENSIONS);
  assert.ok(library.supportedMediaExtensions.includes(".png"));
  assert.ok(library.supportedMediaExtensions.includes(".mp4"));

  const created = await post({ projectId: "default", imagePath });
  assert.equal(created.status, 200);
  const asset = (await created.json()).asset;
  const batch = (body) => fetch(`${runtime.url}/api/assets/batch`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  // A batch "Favorite" is idempotent. It never unfavorites a selected asset.
  const favorite = await batch({ action: "favorite", projectId: "default", assetIds: [asset.id] });
  assert.equal(favorite.status, 200);
  assert.deepEqual((await favorite.json()).results, [{ id: asset.id, favorite: true }]);
  const favoriteAgain = await batch({ action: "favorite", projectId: "default", assetIds: [asset.id] });
  assert.equal(favoriteAgain.status, 200);
  assert.deepEqual((await favoriteAgain.json()).results, [{ id: asset.id, favorite: true }]);

  const invalidBatch = await batch({ action: "delete", projectId: "default", assetIds: [asset.id] });
  assert.equal(invalidBatch.status, 400);
  const archive = await batch({ action: "archive", projectId: "default", assetIds: [asset.id] });
  assert.equal(archive.status, 200);
  assert.deepEqual((await archive.json()).results, [{ id: asset.id, archived: true }]);
});

test("shows only the four everyday fields and hides the rest behind advanced settings", async () => {
  const html = await readFile(resolve(root, "app/index.html"), "utf8");
  const body = html.slice(html.indexOf('<div class="modal-body">'), html.indexOf('<div class="modal-footer">'));
  const advanced = body.slice(body.indexOf('<details class="import-advanced"'));
  const everyday = body.slice(0, body.indexOf('<details class="import-advanced"'));

  for (const id of ["imagePathInput", "promptInput", "groupInput", "categoryInput"]) {
    assert.match(everyday, new RegExp(`id="${id}"`), `${id} should be visible by default`);
  }
  for (const id of ["skillInput", "styleInput", "ratioInput", "themeInput", "businessInput"]) {
    assert.doesNotMatch(everyday, new RegExp(`id="${id}"`), `${id} should not be visible by default`);
    assert.match(advanced, new RegExp(`id="${id}"`), `${id} should live under advanced settings`);
  }
  // Collapsed by default: no `open` attribute on the disclosure.
  assert.match(body, /<details class="import-advanced" id="importAdvanced">/);
});

test("explains the path field with server-sourced formats, an example, and the Codex folder", async () => {
  const [html, app, apiClient] = await Promise.all([
    readFile(resolve(root, "app/index.html"), "utf8"),
    readFile(resolve(root, "app/app.mjs"), "utf8"),
    readFile(resolve(root, "app/api-client.mjs"), "utf8"),
  ]);

  assert.match(html, /id="importFormatList"/);
  assert.match(html, /id="importPathExample"/);
  assert.match(html, /id="codexSourceHint"/);
  assert.match(app, /els\.importFormatList\.textContent = state\.supportedMediaExtensions\.join\(" "\)/);
  assert.match(apiClient, /state\.supportedMediaExtensions = Array\.isArray\(library\?\.supportedMediaExtensions\)/);
  // The sandbox cannot supply an absolute path via a file picker, so the form
  // guides typing.  Drag-and-drop is allowed: it fills the path input, but the
  // user still verifies and submits the form.
  assert.doesNotMatch(app, /showOpenFilePicker|webkitdirectory/);
  assert.doesNotMatch(html, /type="file"/);
});

test("keeps desktop drag-and-drop and batch actions truthful", async () => {
  const [html, app, preload, i18n] = await Promise.all([
    readFile(resolve(root, "app/index.html"), "utf8"),
    readFile(resolve(root, "app/app.mjs"), "utf8"),
    readFile(resolve(root, "desktop/preload.cjs"), "utf8"),
    readFile(resolve(root, "app/i18n.mjs"), "utf8"),
  ]);

  assert.match(html, /id="batchToggle"/);
  assert.match(html, /id="batchBar" role="region"/);
  assert.doesNotMatch(html, /id="dropOverlay"/);
  assert.ok(app.includes("async function droppedFilePath(file)"));
  assert.ok(app.includes("await window.electronAPI.getPathForFile(file)"));
  assert.equal(app.includes("file.webkitRelativePath || file.name"), false);
  assert.ok(preload.includes("webUtils.getPathForFile(file)"));
  assert.ok(app.includes('els.batchFavorite?.addEventListener("click"'));
  assert.ok(app.includes('apiFetch("/api/assets/batch"'));
  assert.ok(app.includes("body: { action, projectId: state.project, assetIds }"));
  // Phase 5B：单素材归档迁移到全应用唯一 ConfirmDialog（window.confirm 清零）。
  assert.match(app, /title: t\("archiveOneTitle"\)/);
  assert.doesNotMatch(app, /window\.confirm\(/);
  // Theme toggle is now in settings-menu segmented control, not a standalone button.
  // Verify the new entry point is wired correctly.
  assert.ok(app.includes('data-appearance-opt'));
  assert.ok(app.includes('showToast(t("darkModeChanged"), "success")'));

  for (const key of [
    "batchMode", "batchFavoriteDone", "batchArchiveDone", "batchOperationIncomplete",
    "addFavorite", "removeFavorite", "dropPathUnavailable", "appearance", "darkModeToggle", "darkModeChanged",
  ]) {
    assert.match(i18n, new RegExp(`\\b${key}:`), `translation missing for ${key}`);
  }
});

test("attaches import errors to their field with aria wiring and non-colour cues", async () => {
  const [html, app, css, apiClient] = await Promise.all([
    readFile(resolve(root, "app/index.html"), "utf8"),
    readFile(resolve(root, "app/app.mjs"), "utf8"),
    readFile(resolve(root, "app/styles.css"), "utf8"),
    readFile(resolve(root, "app/api-client.mjs"), "utf8"),
  ]);

  assert.match(html, /id="imagePathInput"[^>]*aria-describedby="imagePathGuidance imagePathError"/);
  assert.match(html, /id="businessInput"[^>]*aria-describedby="businessFieldsError"/);
  assert.match(html, /<p class="field-error" id="imagePathError" role="alert" hidden><\/p>/);
  assert.match(html, /<p class="field-error" id="businessFieldsError" role="alert" hidden><\/p>/);
  assert.match(app, /target\.input\?\.setAttribute\("aria-invalid", "true"\)/);
  assert.match(app, /target\.input\?\.focus\(\)/);
  // An error inside the collapsed section has to reveal that section.
  assert.match(app, /if \(target\.disclosure\) target\.disclosure\.open = true/);
  // Icon plus text, so colour is not the only carrier of meaning.
  assert.match(css, /\.field-error::before \{ content: "⚠"/);
  // The flex display above outranks the UA [hidden] rule, so it needs restating
  // or an empty warning icon sits under the field with no error to report.
  assert.match(css, /\.field-error\[hidden\] \{ display: none; \}/);

  for (const code of ["IMAGE_PATH_REQUIRED", "IMAGE_PATH_NOT_FOUND", "IMAGE_PATH_UNSUPPORTED_TYPE", "IMAGE_PATH_NOT_READABLE"]) {
    assert.match(app, new RegExp(`${code}: \\{ field: "imagePath"`), `${code} must map to the path field`);
  }
  assert.match(apiClient, /if \(payload\.code\) error\.code = payload\.code/);
});

test("blocks a double submit and shows a loading state while saving", async () => {
  const app = await readFile(resolve(root, "app/app.mjs"), "utf8");

  assert.match(app, /if \(state\.importSaving\) return;/);
  assert.match(app, /els\.saveAssetBtn\.disabled = busy/);
  assert.match(app, /els\.saveAssetBtn\.setAttribute\("aria-busy", String\(busy\)\)/);
  assert.match(app, /els\.saveAssetBtn\.textContent = busy \? t\("savingAsset"\) : t\("saveAsset"\)/);
  // The button has to be released whether the request succeeded or failed.
  assert.match(app, /\} finally \{\s*setImportBusy\(false\);/);
  // Success still selects the new asset and refreshes the gallery.
  assert.match(app, /state\.selectedId = result\.asset\.id;\s*\n\s*clearImportForm\(\); closeImportModal\(\);/);
  assert.match(app, /await loadStats\(\); await loadAssets\(\);/);
});

test("keeps the import dialog's focus contract and translates every new string", async () => {
  const app = await readFile(resolve(root, "app/app.mjs"), "utf8");

  assert.match(app, /function trapImportModalFocus\(event\)/);
  assert.match(app, /if \(event\.key === "Escape"\) \{ event\.preventDefault\(\); closeImportModal\(\); return; \}/);
  assert.match(app, /function closeImportModal\(\) \{[^}]*state\.modalReturnFocus\.focus\(\)/);
  // Opening resets any error left from a previous attempt.
  assert.match(app, /function openImportModal\(\) \{[\s\S]{0,320}clearImportErrors\(\);[\s\S]{0,160}setImportBusy\(false\);/);

  const keys = [
    "advancedSettings", "importPathFormats", "importPathExample", "importPathCodexDir", "importPathCodexDirUnknown",
    "errorPathRequired", "errorPathNotFound", "errorPathUnsupported", "errorPathNotReadable", "errorInvalidJson", "savingAsset",
  ];
  const i18n = await readFile(resolve(root, "app/i18n.mjs"), "utf8");
  for (const key of keys) {
    assert.match(i18n, new RegExp(`\\b${key}:`), `translation missing for ${key}`);
  }
});
