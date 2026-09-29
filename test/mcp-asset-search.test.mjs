import assert from "node:assert/strict";
import test from "node:test";

import { searchMcpAssets, searchVisualViaLocalRuntime } from "../lib/mcp-asset-search.mjs";

test("MCP visual search verifies the local runtime library before querying embeddings", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/api/health")) {
      return new Response(JSON.stringify({ product: "mosa", libraryDir: "/other/library" }), { status: 200 });
    }
    throw new Error("visual search must not run after a library mismatch");
  };
  const result = await searchVisualViaLocalRuntime({
    query: "red poster",
    projectId: "default",
    libraryDir: "/expected/library",
    port: 43517,
    fetchImpl,
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, "runtime-library-mismatch");
  assert.equal(calls.length, 1);
});

test("MCP asset search fuses lexical and visual results while honoring time bounds", async () => {
  const assets = new Map([
    ["lexical", { id: "lexical", prompt: "red poster", created_at: "2026-09-20T10:00:00.000Z" }],
    ["shared", { id: "shared", prompt: "poster", created_at: "2026-09-21T10:00:00.000Z" }],
    ["old-visual", { id: "old-visual", prompt: "", created_at: "2026-09-01T10:00:00.000Z" }],
  ]);
  const store = {
    async listAssetPage(filters) {
      assert.equal(filters.createdAfterMs, Date.parse("2026-09-15T00:00:00.000Z"));
      return { assets: [assets.get("lexical"), assets.get("shared")], page: { nextCursor: null } };
    },
    async getAsset(_projectId, assetId) {
      const asset = assets.get(assetId);
      if (!asset) throw Object.assign(new Error("not found"), { code: "ASSET_NOT_FOUND" });
      return asset;
    },
  };
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.endsWith("/api/health")) {
      return new Response(JSON.stringify({ product: "mosa", libraryDir: "/library" }), { status: 200 });
    }
    if (value.includes("/api/visual/search?")) {
      return new Response(JSON.stringify({
        model: { id: "model", revision: "r1", dimension: 4 },
        results: [
          { asset_id: "shared", score: 0.9 },
          { asset_id: "old-visual", score: 0.8 },
        ],
      }), { status: 200 });
    }
    throw new Error(`unexpected URL ${value}`);
  };
  const result = await searchMcpAssets({
    store,
    libraryDir: "/library",
    projectId: "default",
    query: "red poster",
    createdAfter: "2026-09-15T00:00:00.000Z",
    visual: true,
    limit: 10,
    fetchImpl,
  });
  assert.equal(result.visual.available, true);
  assert.deepEqual(result.results.map((item) => item.asset.id), ["shared", "lexical"]);
  assert.equal(result.results[0].match.lexical_rank, 2);
  assert.equal(result.results[0].match.visual_rank, 1);
  assert.equal(result.results.some((item) => item.asset.id === "old-visual"), false);
});

test("MCP asset search rejects inverted time ranges", async () => {
  await assert.rejects(() => searchMcpAssets({
    store: { listAssetPage: async () => ({ assets: [], page: {} }) },
    libraryDir: "/library",
    createdAfter: "2026-09-20T00:00:00.000Z",
    createdBefore: "2026-09-19T00:00:00.000Z",
  }), (error) => error?.code === "ASSET_TIME_RANGE_INVALID");
});

test("MCP visual search scans every discovery port when the runtime is not on the first one", async () => {
  const probedPorts = [];
  const fetchImpl = async (url) => {
    const value = String(url);
    const port = Number(new URL(value).port);
    if (value.endsWith("/api/health")) {
      probedPorts.push(port);
      if (port === 43517) return new Response(JSON.stringify({ product: "mosa", libraryDir: "/other/library" }), { status: 200 });
      if (port === 43518) return new Response(JSON.stringify({ product: "mosa", libraryDir: "/expected/library" }), { status: 200 });
      throw new Error("must stop scanning once the runtime is found");
    }
    if (value.includes("/api/visual/search?")) {
      assert.equal(port, 43518, "the visual query must go to the discovered runtime port");
      return new Response(JSON.stringify({ model: { id: "model" }, results: [] }), { status: 200 });
    }
    throw new Error(`unexpected URL ${value}`);
  };
  const result = await searchVisualViaLocalRuntime({
    query: "poster",
    libraryDir: "/expected/library",
    fetchImpl,
  });
  assert.equal(result.available, true);
  assert.deepEqual(probedPorts, [43517, 43518]);
});

test("MCP visual search honors an explicit single port without scanning", async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/api/health")) {
      return Response.error();
    }
    throw new Error("visual search must not run without a healthy runtime");
  };
  const result = await searchVisualViaLocalRuntime({
    query: "poster",
    libraryDir: "/library",
    port: 43519,
    fetchImpl,
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, "runtime-health-unavailable");
});
