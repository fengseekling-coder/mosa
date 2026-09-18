// Builds a MOSA visual model pack from a downloaded candidate source.
//
// Offline path (preferred):
//   node scripts/build-visual-model-pack.mjs --source <dir> --output <pack-dir>
// where <dir> follows the pinned candidate layout (onnx/, tokenizer/, config/).
//
// Network path (explicit opt-in):
//   node scripts/build-visual-model-pack.mjs --download --output <pack-dir>
// fetches the pinned files from the candidate registry below.
//
// The manifest pins upstream id/revision, embedding dimension, license, and
// per-file SHA-256; verify with `mosa visual-model-verify --from <pack-dir>`.
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACK_SCHEMA = "mosa.visual-model-pack/1";
const ONNX_RUNTIME_VERSION = "1.30.0";
const TOKENIZER_RUNTIME_VERSION = "0.2.0";
const SUPPORTED_RUNTIME_TARGETS = new Set(["darwin-arm64", "win32-x64"]);

// The first product candidate. License and file digests are pinned so a
// rebuild is byte-reproducible; re-check the upstream license before shipping.
const CANDIDATES = {
  "siglip2-base-patch16-224": {
    upstream: "onnx-community/siglip2-base-patch16-224-ONNX",
    revision: "ba1f3b0843f24bc5417d38e19c37b287d719b2f4",
    license: {
      id: "apache-2.0",
      source: "https://huggingface.co/google/siglip2-base-patch16-224",
      notice: "SigLIP2 Base is distributed under the Apache License 2.0 by Google.",
      commercial_product_use: true,
    },
    embedding_dimension: 768,
    files: [
      { source: "onnx/model_int8.onnx", path: "model/model_int8.onnx", role: "model", sha256: "bfe28fe2ccdb685874586648035ea349593e487ce33bd0939b28813681a8f167" },
      { source: "tokenizer/tokenizer.json", path: "tokenizer/tokenizer.json", role: "tokenizer", sha256: "cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322" },
      { source: "tokenizer/tokenizer_config.json", path: "tokenizer/tokenizer_config.json", role: "tokenizer-config", sha256: "7c3a247599e741bceba1a3fe0285aea88d1044dc1fad2caa1e48cdd9fd25f630" },
      { source: "tokenizer/special_tokens_map.json", path: "tokenizer/special_tokens_map.json", role: "special-tokens", sha256: "baec30ea10906f16adb8c18af7a34023002c1746542612b8b41c9f09e1351351" },
      { source: "config/config.json", path: "config/config.json", role: "config", sha256: "e43a9f7692d3819886a82cb2097048258d444f123c67d37ec825f9345b019cf2" },
      { source: "config/preprocessor_config.json", path: "config/preprocessor_config.json", role: "preprocessor-config", sha256: "9b36b57ebaf20f09bf4c22100ccc21877ea6bfe5aead0c00c59f8af8ccefacfc" },
    ],
    preprocessing: {
      image_size: 224,
      resize: "squash_to_square",
      interpolation: "lanczos3",
      rescale_factor: 0.00392156862745098,
      image_mean: [0.5, 0.5, 0.5],
      image_std: [0.5, 0.5, 0.5],
      max_text_tokens: 64,
      text_padding: "max_length",
    },
  },
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const output = resolve(String(args.output || ""));
  if (!output) throw new Error("Usage: build-visual-model-pack.mjs --output <pack-dir> [--source <dir>] [--candidate <id>] [--download] [--runtime-target <darwin-arm64|win32-x64>] [--model-only]");
  const candidate = CANDIDATES[String(args.candidate || "siglip2-base-patch16-224")];
  if (!candidate) throw new Error(`Unknown candidate: ${args.candidate}`);
  const sourceDir = args.source ? resolve(String(args.source)) : null;
  const download = args.download === true;
  const includeRuntime = args["model-only"] !== true;
  const runtimeTarget = String(args["runtime-target"] || `${process.platform}-${process.arch}`);
  if (includeRuntime && !SUPPORTED_RUNTIME_TARGETS.has(runtimeTarget)) {
    throw new Error(`Unsupported visual runtime target: ${runtimeTarget}. Supported: darwin-arm64, win32-x64.`);
  }

  const staged = [];
  for (const file of candidate.files) {
    const bytes = await obtainFile({ file, sourceDir, download, candidate });
    staged.push(bytes);
  }
  if (includeRuntime) staged.push(...await collectRuntimeFiles(runtimeTarget));

  await mkdir(output, { recursive: true });
  for (const file of staged) {
    const destination = join(output, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.data);
  }
  const manifest = {
    schema: PACK_SCHEMA,
    id: String(args.candidate || "siglip2-base-patch16-224"),
    revision: candidate.revision,
    model_type: "image-text-embedding",
    embedding_dimension: candidate.embedding_dimension,
    license: { ...candidate.license },
    preprocessing: { ...candidate.preprocessing },
    ...(includeRuntime ? {
      runtime: {
        provider: "onnxruntime-node",
        version: ONNX_RUNTIME_VERSION,
        tokenizer_version: TOKENIZER_RUNTIME_VERSION,
        platform: runtimeTarget.split("-")[0],
        arch: runtimeTarget.split("-")[1],
        root: "runtime",
      },
    } : {}),
    files: staged.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
      role: file.role,
    })),
  };
  await writeFile(join(output, "model-pack.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const totalBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
  console.log(JSON.stringify({ ok: true, output, files: manifest.files.length, total_bytes: totalBytes }, null, 2));
}

async function obtainFile({ file, sourceDir, download, candidate }) {
  const local = sourceDir ? join(sourceDir, file.source) : null;
  if (local && !isAbsoluteOutside(local)) {
    try {
      const data = await readFile(local);
      assertDigest(data, file, local);
      return { ...file, data, bytes: data.length };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (!download) throw new Error(`Missing source file ${local}; re-run with --download to fetch pinned files.`);
    }
  } else if (!download) {
    throw new Error("Provide --source <dir> or pass --download to fetch pinned files.");
  }
  const url = `https://huggingface.co/${candidate.upstream}/resolve/${candidate.revision}/${file.source}`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed for ${file.source}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  assertDigest(data, file, url);
  return { ...file, data, bytes: data.length };
}

async function collectRuntimeFiles(runtimeTarget) {
  const [platform, arch] = runtimeTarget.split("-");
  const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const nodeModules = join(projectRoot, "node_modules");
  const specs = [
    { source: "onnxruntime-node/package.json", role: "runtime-metadata" },
    { source: "onnxruntime-common/package.json", role: "runtime-metadata" },
    { source: "onnxruntime-common/dist/cjs/package.json", role: "runtime-metadata" },
    { source: "@huggingface/tokenizers/package.json", role: "runtime-metadata" },
    { source: "@huggingface/tokenizers/dist/tokenizers.cjs", role: "runtime-js" },
  ];

  for (const name of await listMatchingFiles(join(nodeModules, "onnxruntime-node", "dist"), (name) => name.endsWith(".js"))) {
    specs.push({ source: `onnxruntime-node/dist/${name}`, role: "runtime-js" });
  }
  for (const name of await listMatchingFiles(join(nodeModules, "onnxruntime-common", "dist", "cjs"), (name) => name.endsWith(".js"))) {
    specs.push({ source: `onnxruntime-common/dist/cjs/${name}`, role: "runtime-js" });
  }
  const nativeRelativeDir = `onnxruntime-node/bin/napi-v6/${platform}/${arch}`;
  for (const name of await listMatchingFiles(join(nodeModules, nativeRelativeDir), () => true)) {
    specs.push({ source: `${nativeRelativeDir}/${name}`, role: "runtime-native" });
  }

  const versions = await Promise.all([
    readPackageVersion(join(nodeModules, "onnxruntime-node", "package.json")),
    readPackageVersion(join(nodeModules, "onnxruntime-common", "package.json")),
    readPackageVersion(join(nodeModules, "@huggingface", "tokenizers", "package.json")),
  ]);
  if (versions[0] !== ONNX_RUNTIME_VERSION || versions[1] !== ONNX_RUNTIME_VERSION || versions[2] !== TOKENIZER_RUNTIME_VERSION) {
    throw new Error(`Visual runtime dependency versions drifted: onnxruntime-node=${versions[0]}, onnxruntime-common=${versions[1]}, tokenizers=${versions[2]}.`);
  }

  const files = [];
  for (const spec of specs) {
    const sourcePath = join(nodeModules, spec.source);
    const data = await readFile(sourcePath);
    files.push({
      path: `runtime/node_modules/${spec.source}`,
      role: spec.role,
      sha256: createHash("sha256").update(data).digest("hex"),
      bytes: data.length,
      data,
    });
  }
  return files;
}

async function listMatchingFiles(directory, predicate) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && predicate(entry.name)).map((entry) => entry.name).sort();
}

async function readPackageVersion(path) {
  return String(JSON.parse(await readFile(path, "utf8")).version || "");
}

function assertDigest(data, file, label) {
  const digest = createHash("sha256").update(data).digest("hex");
  if (digest !== file.sha256) {
    throw new Error(`SHA-256 mismatch for ${label}: expected ${file.sha256}, got ${digest}.`);
  }
}

function isAbsoluteOutside(path) {
  return isAbsolute(path) && !path.startsWith(resolve(fileURLToPath(new URL("..", import.meta.url))));
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--download") args.download = true;
    else if (token === "--model-only") args["model-only"] = true;
    else if (token.startsWith("--")) args[token.slice(2)] = argv[i + 1];
  }
  return args;
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
