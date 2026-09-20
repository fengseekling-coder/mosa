import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createOnnxVisualEmbeddingProvider,
  visualPackModelError,
} from "../lib/visual-embedding-onnx-provider.mjs";

// One shared temp pack directory; tests only ever read the tokenizer files.
const tempPackDir = await mkdtemp(join(tmpdir(), "mosa-visual-provider-"));
await mkdir(join(tempPackDir, "tokenizer"), { recursive: true });
await writeFile(join(tempPackDir, "tokenizer", "tokenizer.json"), JSON.stringify({ model: { vocab: {} } }), "utf8");
await writeFile(join(tempPackDir, "tokenizer", "tokenizer_config.json"), JSON.stringify({}), "utf8");

import { mkdir } from "node:fs/promises";

function fakePack(overrides = {}) {
  return {
    ok: true,
    id: "fake-pack",
    revision: "rev-1",
    model_type: "image-text-embedding",
    embedding_dimension: 4,
    pack_dir: tempPackDir,
    preprocessing: { image_size: 4, max_text_tokens: 8 },
    files: [
      { path: "model/model.onnx", role: "model", sha256: "0".repeat(64), bytes: 10, absolute_path: join(tempPackDir, "model", "model.onnx") },
      { path: "tokenizer/tokenizer.json", role: "tokenizer", sha256: "1".repeat(64), bytes: 10, absolute_path: join(tempPackDir, "tokenizer", "tokenizer.json") },
      { path: "tokenizer/tokenizer_config.json", role: "tokenizer-config", sha256: "2".repeat(64), bytes: 10, absolute_path: join(tempPackDir, "tokenizer", "tokenizer_config.json") },
    ],
    ...overrides,
  };
}

function fakeTokenizer({ eosId = 1, padId = 0 } = {}) {
  return {
    token_to_id(name) {
      if (name === "<eos>" || name === "</s>") return eosId;
      if (name === "<pad>") return padId;
      return undefined;
    },
    encode(text) {
      const ids = [...text].slice(0, 4).map((character) => character.charCodeAt(0));
      return { ids: [...ids, eosId] };
    },
  };
}

function fakeOnnx({ outputs = null, failEmptyPixels = false, runs = [] } = {}) {
  class Tensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }
  const calls = [];
  const session = {
    inputNames: ["input_ids", "pixel_values"],
    async run(feeds) {
      calls.push({ feeds: structuredCloneFeeds(feeds) });
      if (failEmptyPixels && feeds.pixel_values?.dims?.[0] === 0) {
        throw new Error("Reshape failed: zero-size input rejected");
      }
      runs.push(1);
      return outputs ?? {
        text_embeds: new Tensor("float32", Float32Array.from([1, 0, 0, 0]), [1, 4]),
        image_embeds: new Tensor("float32", Float32Array.from([0, 1, 0, 0]), [1, 4]),
      };
    },
  };
  return {
    Tensor,
    InferenceSession: {
      async create() {
        return session;
      },
    },
    __session: session,
    __calls: calls,
  };
}

function structuredCloneFeeds(feeds) {
  const clone = {};
  for (const [key, value] of Object.entries(feeds)) {
    if (value && typeof value === "object" && "data" in value && "dims" in value) {
      clone[key] = { dims: value.dims, data: Array.from(value.data, (item) => Number(item)) };
    } else {
      clone[key] = value;
    }
  }
  return clone;
}

function fakeSharp({ width = 4 } = {}) {
  const buffer = Buffer.alloc(width * width * 3);
  for (let i = 0; i < width * width; i += 1) {
    buffer[i * 3] = 255;
    buffer[i * 3 + 1] = 128;
    buffer[i * 3 + 2] = 0;
  }
  const chain = {
    removeAlpha() { return chain; },
    resize() { return chain; },
    raw() { return chain; },
    async toBuffer() {
      return { data: buffer, info: { width, height: width, channels: 3 } };
    },
  };
  return () => chain;
}

test("provider resolves model and tokenizer files by manifest role", async () => {
  const onnx = fakeOnnx();
  const provider = createOnnxVisualEmbeddingProvider({
    pack: fakePack(),
    onnxModule: onnx,
    sharpModule: fakeSharp(),
    tokenizerFactory: () => fakeTokenizer(),
  });
  assert.deepEqual(provider.model, { id: "fake-pack", revision: "rev-1", dimension: 4 });
  await provider.start();
  assert.equal(provider.status().loaded, true);
  await provider.close();
});

test("provider rejects packs without exactly one model or tokenizer file", () => {
  assert.throws(
    () => createOnnxVisualEmbeddingProvider({
      pack: fakePack({ files: [fakePack().files[1], fakePack().files[2]] }),
      onnxModule: fakeOnnx(),
      sharpModule: fakeSharp(),
    }),
    (error) => error.code === "VISUAL_INFERENCE_PACK_MODEL_FILE",
  );
  assert.throws(
    () => createOnnxVisualEmbeddingProvider({
      pack: fakePack({ files: [fakePack().files[0]] }),
      onnxModule: fakeOnnx(),
      sharpModule: fakeSharp(),
    }),
    (error) => error.code === "VISUAL_INFERENCE_PACK_TOKENIZER_FILE",
  );
});

test("provider pads text ids to max_text_tokens and keeps a trailing eos token", async () => {
  const onnx = fakeOnnx();
  const provider = createOnnxVisualEmbeddingProvider({
    pack: fakePack(),
    onnxModule: onnx,
    sharpModule: fakeSharp(),
    tokenizerFactory: () => fakeTokenizer(),
  });
  await provider.encodeText("abc", {});
  const feeds = onnx.__calls[0].feeds;
  const ids = feeds.input_ids.data;
  // fake tokenizer emits [97, 98, 99, eos]; padding fills to 8 with pad id 0
  assert.deepEqual(ids, [97, 98, 99, 1, 0, 0, 0, 0]);
  assert.deepEqual(feeds.pixel_values?.dims ?? null, [0, 3, 4, 4]);
  await provider.close();
});

test("provider truncates over-long text and keeps the eos token in place", async () => {
  const onnx = fakeOnnx();
  const provider = createOnnxVisualEmbeddingProvider({
    pack: fakePack(),
    onnxModule: onnx,
    sharpModule: fakeSharp(),
    // A tokenizer that does not truncate on its own so the provider's
    // truncation path is exercised.
    tokenizerFactory: () => ({
      token_to_id: (name) => (name === "<eos>" || name === "</s>" ? 1 : name === "<pad>" ? 0 : undefined),
      encode: (text) => ({ ids: [...[...text].map((character) => character.charCodeAt(0)), 1] }),
    }),
  });
  await provider.encodeText("a".repeat(40), {});
  const ids = onnx.__calls[0].feeds.input_ids.data;
  assert.equal(ids.length, 8);
  assert.equal(ids[7], 1);
  await provider.close();
});

test("provider falls back to a dummy image when the graph rejects zero-sized pixels", async () => {
  const onnx = fakeOnnx({ failEmptyPixels: true });
  const provider = createOnnxVisualEmbeddingProvider({
    pack: fakePack(),
    onnxModule: onnx,
    sharpModule: fakeSharp(),
    tokenizerFactory: () => fakeTokenizer(),
  });
  const vector = await provider.encodeText("abc", {});
  assert.equal(vector.length, 4);
  const second = onnx.__calls[1].feeds.pixel_values;
  assert.deepEqual(second.dims, [1, 3, 4, 4]);
  assert.equal(second.data.every((value) => value === -1), true);
  // The fallback sticks for the process lifetime.
  await provider.encodeText("abcde", {});
  assert.deepEqual(onnx.__calls[2].feeds.pixel_values.dims, [1, 3, 4, 4]);
  await provider.close();
});

test("provider builds a normalized CHW image tensor and reads image_embeds", async () => {
  const onnx = fakeOnnx();
  const provider = createOnnxVisualEmbeddingProvider({
    pack: fakePack(),
    onnxModule: onnx,
    sharpModule: fakeSharp(),
    tokenizerFactory: () => fakeTokenizer(),
  });
  const vector = await provider.encodeImage("/tmp/fake.png", {});
  assert.deepEqual([...vector], [0, 1, 0, 0]);
  const feeds = onnx.__calls[0].feeds;
  assert.deepEqual(feeds.pixel_values.dims, [1, 3, 4, 4]);
  assert.equal(feeds.pixel_values.data.length, 3 * 16);
  // channel 0 holds (255/255 - 0.5) / 0.5 = 1 for every pixel
  assert.equal(feeds.pixel_values.data[0], 1);
  // channel 1 holds (128/255 - 0.5) / 0.5 for every pixel
  assert.equal(Math.abs(feeds.pixel_values.data[16] - 0.00392156862745098) < 1e-9, true);
  await provider.close();
});

test("provider reports a missing output with a coded error", async () => {
  const onnx = fakeOnnx({ outputs: { unrelated: { data: Float32Array.from([1, 2, 3, 4]), dims: [1, 4] } } });
  const provider = createOnnxVisualEmbeddingProvider({
    pack: fakePack(),
    onnxModule: onnx,
    sharpModule: fakeSharp(),
    tokenizerFactory: () => fakeTokenizer(),
  });
  await assert.rejects(provider.encodeText("abc", {}), (error) => {
    assert.equal(error.code, "VISUAL_INFERENCE_OUTPUT_MISSING");
    return true;
  });
  await provider.close();
});

test("provider validates preprocessing metadata", () => {
  assert.throws(
    () => createOnnxVisualEmbeddingProvider({ pack: fakePack({ preprocessing: { image_size: 0 } }) }),
    (error) => error instanceof Error && error.code === "VISUAL_INFERENCE_PREPROCESSING_INVALID",
  );
});
