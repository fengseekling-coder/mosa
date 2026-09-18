// Benchmarks the MOSA-local visual inference chain end to end.
//
//   node scripts/benchmark-visual-inference.mjs --pack <pack-dir> [--images 20] [--queries 10]
//
// Measures model startup, first/warm image encode, warm text encode, worker
// memory, and exact Top-K vector search at 1k/10k/50k scale for the pack's
// embedding dimension. Emits schema `mosa.visual-inference-benchmark/1`.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createVisualInferenceClient } from "../lib/visual-inference-client.mjs";
import { verifyVisualModelPack } from "../lib/visual-model-pack.mjs";
import { topKNormalizedEmbeddings } from "../lib/embedding-search.mjs";

const PACK_ARG_INDEX = process.argv.indexOf("--pack");

function parsePositive(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return Number(sorted[index].toFixed(2));
}

function mean(values) {
  if (!values.length) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

async function main() {
  const packDir = PACK_ARG_INDEX === -1 ? process.env.MOSA_VISUAL_BENCH_PACK : process.argv[PACK_ARG_INDEX + 1];
  if (!packDir) {
    console.error("Usage: benchmark-visual-inference.mjs --pack <pack-dir> [--images 20] [--queries 10]");
    process.exit(1);
  }
  const imageRuns = parsePositive("--images", 20);
  const queryRuns = parsePositive("--queries", 10);

  const sharp = (await import("sharp")).default;
  const verified = await verifyVisualModelPack({ packDir });
  if (!verified.ok) throw new Error(`Pack verification failed: ${verified.code || "unknown"}`);
  const model = { id: verified.id, revision: verified.revision, dimension: verified.embedding_dimension };
  const client = createVisualInferenceClient({ pack: verified, model, maxQueue: 4, timeoutMs: 120_000, initTimeoutMs: 120_000 });

  const now = () => Number(process.hrtime.bigint()) / 1e6;
  const result = {
    schema: "mosa.visual-inference-benchmark/1",
    pack: { id: verified.id, revision: verified.revision, dimension: verified.embedding_dimension, total_bytes: verified.total_bytes },
    environment: { platform: process.platform, arch: process.arch, node: process.versions.node },
    startup: {},
    image_encode_ms: [],
    text_encode_ms: [],
    worker_memory_mb: null,
    vector_search: [],
  };

  try {
    const tempDir = await mkdtemp(join(tmpdir(), "mosa-visual-bench-"));
    const imagePath = join(tempDir, "bench.png");
    await writeFile(imagePath, await sharp(Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#20242c"/><circle cx="256" cy="256" r="150" fill="#d8c9a3"/></svg>`,
    )).png().toBuffer());

    const startupStart = now();
    await client.start();
    result.startup.total_ms = Number((now() - startupStart).toFixed(1));

    const firstImage = await timed(() => client.encodeImage(imagePath, {}));
    result.image_encode_ms.push(firstImage);
    for (let i = 0; i < imageRuns; i += 1) {
      result.image_encode_ms.push(await timed(() => client.encodeImage(imagePath, {})));
    }
    for (let i = 0; i < queryRuns; i += 1) {
      result.text_encode_ms.push(await timed(() => client.encodeText("a warm benchmark query", {})));
    }
    const status = await client.requestStatus();
    result.worker_memory_mb = Number((status.memory / 1048576).toFixed(1));
    result.worker_uptime_s = Number(status.uptime.toFixed(1));

    for (const scale of [1_000, 10_000, 50_000]) {
      const matrix = new Float32Array(scale * verified.embedding_dimension);
      for (let i = 0; i < matrix.length; i += 1) matrix[i] = Math.random() - 0.5;
      // L2-normalize rows so the benchmark matches the production cosine scan.
      for (let row = 0; row < scale; row += 1) {
        let norm = 0;
        const offset = row * verified.embedding_dimension;
        for (let c = 0; c < verified.embedding_dimension; c += 1) norm += matrix[offset + c] ** 2;
        norm = Math.sqrt(norm) || 1;
        for (let c = 0; c < verified.embedding_dimension; c += 1) matrix[offset + c] /= norm;
      }
      const query = new Float32Array(verified.embedding_dimension).fill(1 / Math.sqrt(verified.embedding_dimension));
      const timings = [];
      for (let i = 0; i < queryRuns; i += 1) {
        timings.push(await timed(() => topKNormalizedEmbeddings(matrix, verified.embedding_dimension, query, 20)));
      }
      result.vector_search.push({
        assets: scale,
        dimension: verified.embedding_dimension,
        runs: queryRuns,
        p50_ms: percentile(timings, 0.5),
        p95_ms: percentile(timings, 0.95),
      });
    }

    result.image_encode_p50_ms = percentile(result.image_encode_ms.slice(1), 0.5);
    result.image_encode_p95_ms = percentile(result.image_encode_ms.slice(1), 0.95);
    result.text_encode_p50_ms = percentile(result.text_encode_ms, 0.5);
    result.text_encode_p95_ms = percentile(result.text_encode_ms, 0.95);
    delete result.image_encode_ms;
    delete result.text_encode_ms;
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.close().catch(() => {});
  }

  async function timed(operation) {
    const start = now();
    await operation();
    return Number((now() - start).toFixed(2));
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
