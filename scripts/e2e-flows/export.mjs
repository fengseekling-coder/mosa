// Pluggable e2e flow: export. Single-asset and batch export must land the
// managed originals byte-for-byte in the driver's download capture directory
// (scripts/e2e-web-driver.mjs auto-saves every download into
// <userData>/downloads), a multi-selection containing a collapsed Stack must
// leave the export item out of the context menu entirely and produce no
// download, and "导出分组" must
// download mosa-group-<name>.json whose payload equals the /api/assets?group=
// listing run through sanitizeAssetForExport — no local machine path or
// /library/ URL survives anywhere in the exported tree.
// Seed via API, drive the real context menus, assert in Node.

import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { PAGE_HELPERS } from "./_page-helpers.mjs";
// Import the real sanitizer instead of a local copy: a duplicated rule silently
// drifts out of sync with web/app/utils.mjs and the comparison would stop
// detecting regressions (the missed *_dir fields were exactly that failure).
import { sanitizeAssetForExport } from "../../web/app/utils.mjs";

export const name = "export";
export const description =
  "export: single asset download == managed original -> batch export of 2 -> Stack-in-selection hides export with no download -> group export JSON == sanitized /api/assets?group= (no local paths/URLs)";

// Menu labels verified against web/app/i18n.mjs (zh is the default locale):
// exportAsset=导出素材, exportGroup=导出分组, stackSelected=堆叠所选,
// exportStarted=导出已开始, exportStartedMultiple=批量导出已开始.
const MENU = {
  exportAsset: "导出素材",
  exportGroup: "导出分组",
  stackSelected: "堆叠所选",
};
const TOAST = { started: "导出已开始", startedMultiple: "批量导出已开始" };

// Mirrors safeFileToken in web/app/context-menu-actions.mjs, which builds the
// downloadJson file name for group exports.
const safeFileToken = (value) => String(value || "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "group";

// Recursively collected evidence for the privacy assertions below.
function collectExportLeakEvidence(value, key = "", into = { pathOrUrlKeys: [], strings: [] }) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectExportLeakEvidence(item, key, into));
    return into;
  }
  if (value && typeof value === "object") {
    for (const [childKey, item] of Object.entries(value)) {
      if (/(^|_)(path|url|dir)$/.test(childKey) || childKey === "prompt_file") into.pathOrUrlKeys.push(childKey);
      collectExportLeakEvidence(item, childKey, into);
    }
    return into;
  }
  if (typeof value === "string") into.strings.push(value);
  return into;
}

// In-page helpers specific to this flow, interpolated after PAGE_HELPERS.
const EXPORT_HELPERS = String.raw`
  const selectedCardIds = () => [...document.querySelectorAll('.asset-card.multi-selected')].map((card) => card.dataset.id).sort();
  const allToastTexts = () => [...document.querySelectorAll('.toast-message')].map((node) => node.textContent || '');
  const stackNodeSelector = (stackId) => '#assetGrid > .asset-card.is-stack[data-stack-id="' + CSS.escape(stackId) + '"]';
  const groupNavSelector = (groupName) => '#sidebarManualGroupList .nav-item[data-filter="group"][data-value="' + CSS.escape(groupName) + '"]';
  // Ctrl/Cmd+click toggles a card into the gallery multi-selection
  // (handleCardClick in gallery-selection.mjs tests metaKey || ctrlKey).
  function ctrlClickCard(assetId) {
    const target = document.querySelector(cardSelector(assetId) + ' .asset-card-select');
    if (!target) throw new Error('Missing card select for ' + assetId);
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true, metaKey: true }));
  }
  // Like openContextMenu but matches the exact .context-menu-label and returns
  // the item whatever its disabled state, so the disabled case can be observed.
  async function findMenu(label, triggerSelector) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const trigger = document.querySelector(triggerSelector);
      if (trigger?.isConnected) {
        trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
        const item = [...document.querySelectorAll('.context-menu-item')]
          .find((entry) => entry.querySelector('.context-menu-label')?.textContent === label);
        if (item) return item;
      }
      await sleep(100);
    }
    throw new Error('Timed out waiting for menu item ' + label + ' diagnostic=' + JSON.stringify(pageDiagnostic()));
  }
  async function clickMenuItem(label, triggerSelector) {
    const item = await findMenu(label, triggerSelector);
    const disabled = item.disabled || item.classList.contains('disabled');
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return disabled;
  }
`;

function source(config, body) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    const MENU = ${JSON.stringify(MENU)};
    const TOAST = ${JSON.stringify(TOAST)};
    ${PAGE_HELPERS}
    ${EXPORT_HELPERS}
    ${body}
  })()`;
}

function expect(condition, message) {
  if (!condition) throw new Error(`export: ${message}`);
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function listDownloads(downloadsDir) {
  return readdir(downloadsDir).catch((error) => (error?.code === "ENOENT" ? [] : Promise.reject(error)));
}

// The download is written by the Electron main process while the page only
// shows its toast, so the file may lag runInPage: poll for it here.
async function waitForDownload(downloadsDir, fileName) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      return await readFile(join(downloadsDir, fileName));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`export: timed out waiting for download ${fileName}; have ${JSON.stringify(await listDownloads(downloadsDir))}`);
}

export async function run(ctx) {
  await ctx.prepare();
  const downloadsDir = join(ctx.userDataDir, "downloads");
  const server = await ctx.startServer();
  try {
    // ===== Seed via API: e1/e2 -> group Export-G, e3 free for the Stack =====
    // e1 differs from the other two in both size and colour, so a mix-up with
    // another original can never byte-compare by accident.
    const e1Path = await ctx.makePng("export-e1.png", [220, 68, 74], { width: 96, height: 72 });
    const e2Path = await ctx.makePng("export-e2.png", [74, 181, 92]);
    const e3Path = await ctx.makePng("export-e3.png", [240, 180, 40]);
    const created = [];
    for (const [imagePath, prompt] of [[e1Path, "export flow e1"], [e2Path, "export flow e2"], [e3Path, "export flow e3"]]) {
      const response = await ctx.api(server.origin, "POST", "/api/assets/create", { projectId: "default", imagePath, prompt });
      created.push(response.asset);
    }
    const [e1, e2, e3] = created;
    await ctx.api(server.origin, "POST", "/api/groups", { projectId: "default", name: "Export-G" });
    await ctx.api(server.origin, "POST", "/api/assets/batch", {
      action: "group", projectId: "default", assetIds: [e1.id, e2.id], group: "Export-G",
    });
    // The managed originals are the bytes an export must reproduce.
    const originals = new Map([
      [e1.id, { file: e1.asset, bytes: await readFile(e1.image_path) }],
      [e2.id, { file: e2.asset, bytes: await readFile(e2.image_path) }],
      [e3.id, { file: e3.asset, bytes: await readFile(e3.image_path) }],
    ]);
    const downloadName = (asset) => asset.asset || asset.id; // downloadAssetFile rule
    const config = { e1: e1.id, e2: e2.id, e3: e3.id, groupName: "Export-G" };

    // ===== Pass 1: single-asset export via the card context menu =====
    const p1 = await ctx.runInPage(server, source(config, `
      await waitFor(() => gallerySettled() && rootCardIds().length === 3, 'three seeded cards');
      const disabled = await clickMenuItem(MENU.exportAsset, cardSelector(config.e1));
      await waitFor(() => allToastTexts().some((text) => text.includes(TOAST.started)), 'single export toast');
      // downloadAssetFile's anchor click starts an async download navigation;
      // the toast only proves the action ran. Give the main process time to
      // fire will-download (and the driver to capture the file) before this
      // source resolves and the driver destroys the window.
      await sleep(1200);
      return { disabled, toast: allToastTexts().find((text) => text.includes(TOAST.started)) || '' };
    `));
    expect(p1.disabled === false, `single export item enabled before click: ${JSON.stringify(p1)}`);
    expect(p1.toast.includes(TOAST.started), `single export toast: ${JSON.stringify(p1.toast)}`);
    const e1Download = downloadName(e1);
    const e1Bytes = await waitForDownload(downloadsDir, e1Download);
    expect(e1Bytes.equals(originals.get(e1.id).bytes), `single export ${e1Download} is not byte-identical to the managed original`);
    expect(JSON.stringify(await listDownloads(downloadsDir)) === JSON.stringify([e1Download]),
      `single export produced unexpected downloads: ${JSON.stringify(await listDownloads(downloadsDir))}`);

    // ===== Pass 2: batch export of e1+e2 via the multi-selection menu =====
    const p2 = await ctx.runInPage(server, source(config, `
      await waitFor(() => gallerySettled() && rootCardIds().length === 3, 'gallery before batch export');
      ctrlClickCard(config.e1);
      await waitFor(() => selectedCardIds().length === 1, 'e1 multi-selected');
      ctrlClickCard(config.e2);
      await waitFor(() => JSON.stringify(selectedCardIds()) === JSON.stringify([config.e1, config.e2].sort()), 'e1+e2 multi-selected');
      const disabled = await clickMenuItem(MENU.exportAsset, cardSelector(config.e1));
      await waitFor(() => allToastTexts().some((text) => text.includes(TOAST.startedMultiple)), 'batch export toast');
      // Same download-initiation window as the single export above; both batch
      // downloads are clicked back to back before the toast.
      await sleep(1200);
      return { disabled, toast: allToastTexts().find((text) => text.includes(TOAST.startedMultiple)) || '' };
    `));
    expect(p2.disabled === false, `batch export item enabled before click: ${JSON.stringify(p2)}`);
    expect(p2.toast.includes(TOAST.startedMultiple), `batch export toast: ${JSON.stringify(p2.toast)}`);
    // e1's file name is taken by pass 1, so the driver's will-download handler
    // must number the repeat download instead of overwriting it.
    const e1Repeat = `${e1Download.replace(/\.png$/, "")}-1.png`;
    const e2Download = downloadName(e2);
    const [e1RepeatBytes, e2Bytes] = await Promise.all([
      waitForDownload(downloadsDir, e1Repeat),
      waitForDownload(downloadsDir, e2Download),
    ]);
    expect(e1RepeatBytes.equals(originals.get(e1.id).bytes), `batch export ${e1Repeat} is not byte-identical to e1's original`);
    expect(e2Bytes.equals(originals.get(e2.id).bytes), `batch export ${e2Download} is not byte-identical to e2's original`);
    expect(JSON.stringify(await listDownloads(downloadsDir)) === JSON.stringify([e1Download, e1Repeat, e2Download].sort()),
      `batch export left unexpected downloads: ${JSON.stringify(await listDownloads(downloadsDir))}`);

    // ===== Pass 3: multi-selection containing a Stack -> export is absent =====
    const beforeHidden = await listDownloads(downloadsDir);
    const p3 = await ctx.runInPage(server, source(config, `
      await waitFor(() => gallerySettled() && rootCardIds().length === 3, 'gallery before stacking');
      ctrlClickCard(config.e2);
      await waitFor(() => selectedCardIds().length === 1, 'e2 selected for stack');
      ctrlClickCard(config.e3);
      await waitFor(() => JSON.stringify(selectedCardIds()) === JSON.stringify([config.e2, config.e3].sort()), 'e2+e3 selected for stack');
      await clickMenuItem(MENU.stackSelected, cardSelector(config.e2));
      const stackCard = await waitFor(() => document.querySelector('#assetGrid > .asset-card.is-stack'), 'stack node appears');
      await waitFor(() => gallerySettled() && rootCardIds().length === 2, 'root collapses to e1 + stack node');
      const coverId = stackCard.dataset.id;
      ctrlClickCard(coverId);
      await waitFor(() => selectedCardIds().length === 1, 'stack node multi-selected');
      ctrlClickCard(config.e1);
      await waitFor(() => JSON.stringify(selectedCardIds()) === JSON.stringify([coverId, config.e1].sort()), 'stack node + e1 multi-selected');
      // 右键菜单统一：选区含 Stack 时“导出素材/堆叠所选”整段不出现（不再置灰）。
      const trigger = document.querySelector(cardSelector(config.e1) + ' .asset-card-select');
      trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
      await sleep(200);
      const labels = [...document.querySelectorAll('.context-menu .context-menu-label')].map((node) => node.textContent || '');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await sleep(100);
      return { coverId, labels, toasts: allToastTexts() };
    `));
    expect(typeof p3.coverId === "string" && p3.coverId.startsWith("export-e"), `stack node cover id: ${p3.coverId}`);
    expect(p3.labels.includes(MENU.exportAsset) === false, `export item must be hidden with a Stack in the selection: ${JSON.stringify(p3.labels)}`);
    expect(p3.labels.includes(MENU.stackSelected) === false, `stack-selected item must be hidden with a Stack in the selection: ${JSON.stringify(p3.labels)}`);
    expect(p3.labels.includes("移到回收站") === true, `the mixed-selection menu still renders its danger zone: ${JSON.stringify(p3.labels)}`);
    expect(p3.toasts.some((text) => text.includes(TOAST.started) || text.includes(TOAST.startedMultiple)) === false,
      `hidden export must not show an export toast: ${JSON.stringify(p3.toasts)}`);
    expect(JSON.stringify(await listDownloads(downloadsDir)) === JSON.stringify(beforeHidden.sort()),
      `hidden export must not download anything: ${JSON.stringify(await listDownloads(downloadsDir))}`);

    // ===== Pass 4: group export via the sidebar group context menu =====
    const jsonName = `mosa-group-${safeFileToken(config.groupName)}.json`;
    const p4 = await ctx.runInPage(server, source(config, `
      await waitFor(() => document.querySelector(groupNavSelector(config.groupName)), 'sidebar group appears');
      const disabled = await clickMenuItem(MENU.exportGroup, groupNavSelector(config.groupName));
      await waitFor(() => allToastTexts().some((text) => text.includes(TOAST.started)), 'group export toast');
      // Same download-initiation window as the asset exports above.
      await sleep(1200);
      return { disabled, toast: allToastTexts().find((text) => text.includes(TOAST.started)) || '' };
    `));
    expect(p4.disabled === false, `group export item enabled before click: ${JSON.stringify(p4)}`);
    expect(p4.toast.includes(TOAST.started), `group export toast: ${JSON.stringify(p4.toast)}`);
    const jsonBytes = await waitForDownload(downloadsDir, jsonName);
    const payload = JSON.parse(jsonBytes.toString("utf8"));

    // downloadJson payload shape from context-menu-actions.mjs getNavItemMenu.
    expect(typeof payload.exportedAt === "string" && !Number.isNaN(Date.parse(payload.exportedAt)),
      `exportedAt is an ISO timestamp: ${JSON.stringify(payload.exportedAt)}`);
    expect(payload.project === "default", `payload project: ${JSON.stringify(payload.project)}`);
    expect(payload.group === config.groupName, `payload group: ${JSON.stringify(payload.group)}`);
    expect(Array.isArray(payload.assets) && payload.assets.length === 2, `payload asset count: ${payload.assets?.length}`);
    expect(JSON.stringify(payload.assets.map((asset) => asset.id).sort()) === JSON.stringify([e1.id, e2.id].sort()),
      `payload asset ids: ${JSON.stringify(payload.assets.map((asset) => asset.id))}`);

    // The exported assets must equal the authoritative API listing run through
    // the same sanitize rule the export applies (mirrored above), item by item.
    const listed = (await ctx.api(server.origin, "GET", `/api/assets?project=default&group=${encodeURIComponent(config.groupName)}&limit=250`)).assets || [];
    const listedById = new Map(listed.map((asset) => [asset.id, asset]));
    for (const exported of payload.assets) {
      const authoritative = listedById.get(exported.id);
      expect(Boolean(authoritative), `exported asset ${exported.id} exists in /api/assets?group=`);
      expect(JSON.stringify(exported) === JSON.stringify(sanitizeAssetForExport(authoritative)),
        `exported asset ${exported.id} is not the sanitized API listing item`);
    }

    // Privacy: the export file leaves the machine, so it must not carry local
    // absolute paths (which embed the user name and directory structure) or
    // /library/... URLs that only resolve against the local server. Assert the
    // whole exported tree: no string may contain the library dir, the Electron
    // userData dir, or the user's home directory, and no field name may end in
    // _path/_url (or be the bare path/prompt_file legacy keys).
    const evidence = collectExportLeakEvidence(payload);
    // macOS symlinks (/var -> /private/var) can make stored paths use the
    // resolved form while ctx carries the mkdtemp form, so assert both.
    const machineRoots = [...new Set([ctx.libraryDir, ctx.userDataDir, homedir()]
      .filter(Boolean)
      .flatMap((dir) => [dir, resolve(dir)]))];
    const leakedStrings = evidence.strings.filter((text) => machineRoots.some((root) => root && text.includes(root)));
    expect(leakedStrings.length === 0,
      `export JSON leaks local machine paths: ${JSON.stringify(leakedStrings.slice(0, 5))}`);
    expect(evidence.pathOrUrlKeys.length === 0,
      `export JSON keeps path/url field names: ${JSON.stringify([...new Set(evidence.pathOrUrlKeys)])}`);

    return {
      seeded: [e1.id, e2.id, e3.id],
      single: { file: e1Download, sha256: sha256(e1Bytes) },
      batch: { files: [e1Repeat, e2Download] },
      stackCoverId: p3.coverId,
      group: { file: jsonName, topLevelFields: Object.keys(payload).sort(), assetIds: payload.assets.map((asset) => asset.id), exportedAt: payload.exportedAt },
      privacy: {
        topLevelFields: Object.keys(payload).sort(),
        assetFields: Object.keys(payload.assets[0]).sort(),
        machineRootsChecked: machineRoots.length,
        pathOrUrlKeys: evidence.pathOrUrlKeys,
        leakedStrings: leakedStrings.length,
        sanitizedAgainstApiListing: true,
      },
    };
  } finally {
    await server.stop();
  }
}
