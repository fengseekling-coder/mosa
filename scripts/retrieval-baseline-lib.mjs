import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const sourcePath = join(sourceDir, "fixture.png");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir, libraryDir });

  try {
    for (let index = 0; index < fixture.assets.length; index += 1) {
      const asset = fixture.assets[index];
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
