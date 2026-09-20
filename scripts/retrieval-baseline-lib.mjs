import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==",
  "base64",
);

export async function loadRetrievalAcceptanceFixture(path = new URL("../test/fixtures/retrieval-acceptance.json", import.meta.url)) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function summarizeRetrievalCases(cases) {
  const tiers = {};
  for (const item of cases) {
    const bucket = tiers[item.tier] ||= { total: 0, hit1: 0, hit5: 0, reciprocalRank: 0 };
    bucket.total += 1;
    if (item.rank === 1) bucket.hit1 += 1;
    if (item.rank != null && item.rank <= 5) bucket.hit5 += 1;
    if (item.rank) bucket.reciprocalRank += 1 / item.rank;
  }
  for (const bucket of Object.values(tiers)) {
    bucket.hitAt1 = bucket.total ? bucket.hit1 / bucket.total : 0;
    bucket.hitAt5 = bucket.total ? bucket.hit5 / bucket.total : 0;
    bucket.mrr = bucket.total ? bucket.reciprocalRank / bucket.total : 0;
    delete bucket.hit1;
    delete bucket.hit5;
    delete bucket.reciprocalRank;
  }
  return tiers;
}

export async function evaluateRetrievalFixture(fixture, { limit = 10 } = {}) {
  validateFixture(fixture);
  const root = await mkdtemp(join(tmpdir(), "mosa-retrieval-baseline-"));
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const libraryDir = join(root, "library");
  const sourceDir = join(projectRoot, "generated-images");
  await mkdir(sourceDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot, managerDir, libraryDir });

  try {
    for (let index = 0; index < fixture.assets.length; index += 1) {
      const asset = fixture.assets[index];
      const sourcePath = join(sourceDir, `fixture-${index}.png`);
      await writeFixtureImage(sourcePath, asset.visual_fixture);
      const created = await store.createAsset({
        assetId: asset.id,
        imagePath: sourcePath,
        prompt: asset.prompt || "",
        tags: asset.tags || [],
        category: asset.category || "",
        group: asset.group || "",
        style: asset.style || "",
        theme: asset.theme || "",
        created_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
        source: { type: "local-file" },
      });
      if (asset.curated || asset.curation_note) {
        await store.updateCuration(created.project_id, created.id, {
          curated: asset.curated === true,
          curation_note: asset.curation_note || "",
        });
      }
    }

    const cases = [];
    for (const query of fixture.queries) {
      const page = await store.listAssetPage({
        projectId: "default",
        query: query.query,
        limit,
        sort: "newest",
      });
      const resultIds = page.assets.map((asset) => asset.id);
      const rankIndex = resultIds.findIndex((id) => query.expected_any.includes(id));
      cases.push({
        ...query,
        rank: rankIndex >= 0 ? rankIndex + 1 : null,
        result_ids: resultIds,
      });
    }
    return {
      schema: fixture.schema,
      cases,
      tiers: summarizeRetrievalCases(cases),
      enforced: cases.filter((item) => item.enforce),
    };
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function writeFixtureImage(path, kind) {
  if (!kind) {
    await writeFile(path, ONE_PIXEL_PNG);
    return;
  }
  const svg = visualFixtureSvg(kind);
  if (!svg) throw new Error("Unknown visual fixture: " + kind);
  await sharp(Buffer.from(svg)).png().toFile(path);
}

function visualFixtureSvg(kind) {
  const frame = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">${body}</svg>`;
  if (kind === "blue-right-portrait") {
    return frame('<rect width="320" height="240" fill="#315fba"/><ellipse cx="245" cy="74" rx="26" ry="34" fill="#171717"/><rect x="213" y="106" width="64" height="112" rx="24" fill="#171717"/>');
  }
  if (kind === "red-circle-left") {
    return frame('<rect width="320" height="240" fill="#f4f1e9"/><circle cx="72" cy="120" r="54" fill="#c72f35"/>');
  }
  if (kind === "green-box-center") {
    return frame('<rect width="320" height="240" fill="#eeeae0"/><rect x="105" y="62" width="110" height="116" rx="8" fill="#3d8a55"/><path d="M105 62l55-28 55 28-55 28z" fill="#64a875"/>');
  }
  if (kind === "black-bottom-whitespace") {
    return frame('<rect width="320" height="240" fill="#fafafa"/><rect x="116" y="184" width="88" height="38" rx="4" fill="#151515"/>');
  }
  return "";
}

function validateFixture(fixture) {
  if (!fixture || fixture.schema !== "mosa.retrieval-acceptance/1") {
    throw new Error("Unsupported retrieval acceptance fixture.");
  }
  if (!Array.isArray(fixture.assets) || !fixture.assets.length) throw new Error("Retrieval fixture requires assets.");
  if (!Array.isArray(fixture.queries) || !fixture.queries.length) throw new Error("Retrieval fixture requires queries.");
  const assetIds = new Set(fixture.assets.map((asset) => String(asset.id || "")));
  if (assetIds.size !== fixture.assets.length || assetIds.has("")) throw new Error("Retrieval fixture asset ids must be unique and non-empty.");
  const queryIds = new Set();
  for (const query of fixture.queries) {
    if (!query.id || queryIds.has(query.id)) throw new Error("Retrieval query ids must be unique and non-empty.");
    queryIds.add(query.id);
    if (!query.query || !query.tier) throw new Error("Retrieval query " + query.id + " is incomplete.");
    if (!Array.isArray(query.expected_any) || !query.expected_any.length) throw new Error("Retrieval query " + query.id + " needs expected_any.");
    for (const id of query.expected_any) {
      if (!assetIds.has(id)) throw new Error("Retrieval query " + query.id + " references unknown asset " + id + ".");
    }
  }
}
