// Real local image-text embedding provider backed by ONNX Runtime.
//
// Runs inside the dedicated visual inference child process (never the renderer
// or the main MOSA service). The pack it consumes has already passed
// verifyVisualModelPack; the model file is located by manifest role so the
// graph layout stays free-form. Text inputs are padded to the pack's
// max_text_tokens: the community ONNX exports only reproduce the upstream
// model's text space with fixed-length inputs (verified against the PyTorch
// reference; variable-length inputs silently corrupt alignment).
import { join } from "node:path";
import { createRequire } from "node:module";

import { readFile } from "node:fs/promises";

const DEFAULT_MAX_TEXT_TOKENS = 64;
const DEFAULT_IMAGE_SIZE = 224;
const DEFAULT_IMAGE_MEAN = [0.5, 0.5, 0.5];
const DEFAULT_IMAGE_STD = [0.5, 0.5, 0.5];

export function visualPackModelError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createOnnxVisualEmbeddingProvider({
  pack,
  sharpModule = null,
  onnxModule = null,
  tokenizerFactory = null,
} = {}) {
  if (!pack || !Array.isArray(pack.files)) {
    throw visualPackModelError("VISUAL_INFERENCE_PACK_INVALID", "Visual inference provider requires a verified model pack.");
  }
  const modelFiles = pack.files.filter((file) => file.role === "model");
  const tokenizerFiles = pack.files.filter((file) => file.role === "tokenizer");
  if (modelFiles.length !== 1) {
    throw visualPackModelError("VISUAL_INFERENCE_PACK_MODEL_FILE", "Visual model pack must declare exactly one file with role \"model\".");
  }
  if (tokenizerFiles.length !== 1) {
    throw visualPackModelError("VISUAL_INFERENCE_PACK_TOKENIZER_FILE", "Visual model pack must declare exactly one file with role \"tokenizer\".");
  }
  const packDir = pack.pack_dir;
  const preprocessing = normalizePreprocessing(pack.preprocessing);
  let tokenizer = null;
  let session = null;
  let onnx = null;
  let sharpLib = null;
  let textNeedsDummyPixels = false;
  let runtimeRequire = null;

  function resolveFile(entry) {
    return entry.absolute_path || join(packDir, entry.path);
  }

  async function ensureModules() {
    if (!onnx) {
      if (onnxModule) {
        onnx = onnxModule;
      } else if (pack.runtime?.runtime_dir) {
        runtimeRequire ||= createRequire(join(pack.runtime.runtime_dir, "mosa-visual-runtime-loader.cjs"));
        onnx = runtimeRequire("onnxruntime-node");
      } else {
        onnx = (await import("onnxruntime-node")).default;
      }
    }
    if (!sharpLib) {
      sharpLib = sharpModule || (await import("sharp")).default;
    }
  }

  async function ensureSession() {
    if (session) return session;
    await ensureModules();
    session = await onnx.InferenceSession.create(resolveFile(modelFiles[0]), {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
    });
    return session;
  }

  async function ensureTokenizer() {
    if (tokenizer) return tokenizer;
    const tokenizerJson = await readJsonFile(resolveFile(tokenizerFiles[0]));
    const configEntry = pack.files.find((file) => file.role === "tokenizer-config");
    const tokenizerConfig = configEntry ? await readJsonFile(resolveFile(configEntry)) : {};
    if (tokenizerFactory) {
      tokenizer = tokenizerFactory(tokenizerJson, tokenizerConfig);
    } else if (pack.runtime?.runtime_dir) {
      runtimeRequire ||= createRequire(join(pack.runtime.runtime_dir, "mosa-visual-runtime-loader.cjs"));
      const { Tokenizer } = runtimeRequire("@huggingface/tokenizers");
      tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
    } else {
      const { Tokenizer } = await import("@huggingface/tokenizers");
      tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
    }
    return tokenizer;
  }

  function specialTokenId(names) {
    if (!tokenizer || typeof tokenizer.token_to_id !== "function") return undefined;
    for (const name of names) {
      const id = tokenizer.token_to_id(name);
      if (id !== undefined && id !== null) return id;
    }
    return undefined;
  }

  async function encodeText(text) {
    const tok = await ensureTokenizer();
    const graphSession = await ensureSession();
    const eosId = specialTokenId(["<eos>", "</s>", "<|endoftext|>"]);
    const padId = specialTokenId(["<pad>", "</s>"]);
    const encoding = typeof tok.encode === "function" ? tok.encode(text) : tok(text);
    let ids = Array.from(encoding.ids ?? [], Number);
    if (ids.length > preprocessing.max_text_tokens) {
      ids = ids.slice(0, preprocessing.max_text_tokens);
    }
    if (ids.length === preprocessing.max_text_tokens && eosId !== undefined && ids[ids.length - 1] !== eosId) {
      ids = [...ids.slice(0, preprocessing.max_text_tokens - 1), eosId];
    }
    while (ids.length < preprocessing.max_text_tokens) ids.push(padId ?? 0);
    const feeds = {
      input_ids: new onnx.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    };
    if (graphSession.inputNames.includes("pixel_values")) {
      feeds.pixel_values = textNeedsDummyPixels
        ? blackPixelTensor(onnx, preprocessing)
        : emptyPixelTensor(onnx, preprocessing);
    }
    let output;
    try {
      output = await graphSession.run(feeds);
    } catch (error) {
      if (feeds.pixel_values && !textNeedsDummyPixels) {
        // Some exported graphs reject zero-sized vision inputs; fall back to a
        // constant dummy image for the rest of the process lifetime.
        textNeedsDummyPixels = true;
        feeds.pixel_values = blackPixelTensor(onnx, preprocessing);
        output = await graphSession.run(feeds);
      } else {
        throw error;
      }
    }
    return extractVector(output, ["text_embeds", "pooler_output"]);
  }

  async function encodeImage(imagePath) {
    const graphSession = await ensureSession();
    await ensureModules();
    const pixelValues = await imageToTensor(imagePath, sharpLib, onnx, preprocessing);
    const feeds = { pixel_values: pixelValues };
    if (graphSession.inputNames.includes("input_ids")) {
      // Shape-only text input for image-only runs; its output is discarded.
      feeds.input_ids = new onnx.Tensor("int64", BigInt64Array.from([1n]), [1, 1]);
    }
    const output = await graphSession.run(feeds);
    return extractVector(output, ["image_embeds", "pooler_output"]);
  }

  return {
    model: Object.freeze({
      id: pack.id,
      revision: pack.revision,
      dimension: pack.embedding_dimension,
    }),

    async start() {
      await Promise.all([ensureSession(), ensureTokenizer()]);
    },

    encodeImage,

    encodeText,

    async close() {
      tokenizer = null;
      const current = session;
      session = null;
      if (current && typeof current.release === "function") {
        try {
          await current.release();
        } catch {
          // Releasing an already-failing session must not mask the caller's error.
        }
      }
    },

    status() {
      return {
        loaded: Boolean(session),
        tokenizer_loaded: Boolean(tokenizer),
        model_file: modelFiles[0].path,
        tokenizer_file: tokenizerFiles[0].path,
        preprocessing: { ...preprocessing },
      };
    },
  };
}

function normalizePreprocessing(preprocessing) {
  const source = preprocessing && typeof preprocessing === "object" ? preprocessing : {};
  const imageSize = Number(source.image_size ?? source.size ?? DEFAULT_IMAGE_SIZE);
  const maxTextTokens = Number(source.max_text_tokens ?? DEFAULT_MAX_TEXT_TOKENS);
  const mean = Array.isArray(source.image_mean) ? source.image_mean.map(Number) : [...DEFAULT_IMAGE_MEAN];
  const std = Array.isArray(source.image_std) ? source.image_std.map(Number) : [...DEFAULT_IMAGE_STD];
  const rescale = Number(source.rescale_factor ?? 1 / 255);
  if (!Number.isInteger(imageSize) || imageSize <= 0) {
    throw visualPackModelError("VISUAL_INFERENCE_PREPROCESSING_INVALID", "Visual model pack preprocessing requires a positive integer image_size.");
  }
  if (!Number.isInteger(maxTextTokens) || maxTextTokens <= 0) {
    throw visualPackModelError("VISUAL_INFERENCE_PREPROCESSING_INVALID", "Visual model pack preprocessing requires a positive integer max_text_tokens.");
  }
  if (mean.length !== 3 || std.length !== 3 || [...mean, ...std, rescale].some((value) => !Number.isFinite(value))) {
    throw visualPackModelError("VISUAL_INFERENCE_PREPROCESSING_INVALID", "Visual model pack preprocessing requires finite 3-element image_mean/image_std and rescale_factor.");
  }
  return Object.freeze({
    image_size: imageSize,
    max_text_tokens: maxTextTokens,
    image_mean: Object.freeze(mean),
    image_std: Object.freeze(std),
    rescale_factor: rescale,
  });
}

async function imageToTensor(imagePath, sharpLib, ort, preprocessing) {
  const size = preprocessing.image_size;
  const { data } = await sharpLib(imagePath)
    .removeAlpha()
    .resize(size, size, { kernel: "lanczos3", fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = 3;
  const plane = size * size;
  const tensor = new Float32Array(channels * plane);
  const { image_mean: mean, image_std: std, rescale_factor: rescale } = preprocessing;
  for (let i = 0; i < plane; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      tensor[c * plane + i] = (data[i * channels + c] * rescale - mean[c]) / std[c];
    }
  }
  return new ort.Tensor("float32", tensor, [1, channels, size, size]);
}

function emptyPixelTensor(ort, preprocessing) {
  const size = preprocessing.image_size;
  return new ort.Tensor("float32", new Float32Array(0), [0, 3, size, size]);
}

function blackPixelTensor(ort, preprocessing) {
  const size = preprocessing.image_size;
  const value = (0 * preprocessing.rescale_factor - preprocessing.image_mean[0]) / preprocessing.image_std[0];
  return new ort.Tensor("float32", new Float32Array(3 * size * size).fill(value), [1, 3, size, size]);
}

function extractVector(output, preferredNames) {
  for (const name of preferredNames) {
    const match = Object.keys(output).find((key) => key === name || key.endsWith(name));
    if (match) {
      const tensor = output[match];
      const vector = Float32Array.from(tensor.data);
      if (vector.length > 0) return vector;
    }
  }
  throw visualPackModelError(
    "VISUAL_INFERENCE_OUTPUT_MISSING",
    `Visual inference graph produced none of the expected outputs: ${preferredNames.join(", ")}.`,
  );
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
