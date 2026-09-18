export function createValidatedVisualEmbeddingProvider({ provider, model } = {}) {
  if (!provider || typeof provider.encodeImage !== "function" || typeof provider.encodeText !== "function") {
    throw new Error("Visual embedding provider requires encodeImage and encodeText.");
  }
  const identity = normalizeModel(model);
  if (provider.model) assertMatchingModel(provider.model, identity);
  let started = false;
  let closed = false;

  return {
    model: Object.freeze({ ...identity }),

    async start() {
      if (closed) throw new Error("Visual embedding provider is already closed.");
      if (started) return;
      if (typeof provider.start === "function") await provider.start();
      started = true;
    },

    async encodeImage(imagePath, context = {}) {
      if (closed) throw new Error("Visual embedding provider is closed.");
      if (!started) await this.start();
      const path = String(imagePath || "").trim();
      if (!path) throw new Error("Visual embedding image path is required.");
      return validateVector(await provider.encodeImage(path, context), identity.dimension);
    },

    async encodeText(text, context = {}) {
      if (closed) throw new Error("Visual embedding provider is closed.");
      if (!started) await this.start();
      const query = normalizeText(text);
      return validateVector(await provider.encodeText(query, context), identity.dimension);
    },

    status() {
      return {
        started,
        closed,
        model: { ...identity },
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      if (typeof provider.close === "function") await provider.close();
    },
  };
}

function assertMatchingModel(candidate, expected) {
  const actual = normalizeModel(candidate);
  if (
    actual.id !== expected.id
    || actual.revision !== expected.revision
    || actual.dimension !== expected.dimension
  ) {
    throw new Error("Visual embedding provider model identity does not match the configured relationship index.");
  }
}

function validateVector(value, dimension) {
  const vector = value instanceof Float32Array
    ? new Float32Array(value)
    : Array.isArray(value)
      ? Float32Array.from(value)
      : null;
  if (!vector || vector.length !== dimension) {
    throw new Error("Visual embedding provider returned a vector with the wrong dimension.");
  }
  let magnitude = 0;
  for (const number of vector) {
    if (!Number.isFinite(number)) throw new Error("Visual embedding provider returned a non-finite vector.");
    magnitude += number * number;
  }
  if (!(magnitude > 0)) throw new Error("Visual embedding provider returned an all-zero vector.");
  return vector;
}

function normalizeText(value) {
  const text = String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!text) throw new Error("Visual text query is required.");
  if (text.length > 2000) throw new Error("Visual text query exceeds the 2000-character limit.");
  return text;
}

function normalizeModel(model = {}) {
  const id = String(model.id || model.modelId || "").trim();
  const revision = String(model.revision || model.modelRevision || "").trim();
  const dimension = Number(model.dimension);
  if (!id || !revision || !Number.isInteger(dimension) || dimension <= 0 || dimension > 8192) {
    throw new Error("Visual embedding provider requires model id, revision, and a valid dimension.");
  }
  return { id, revision, dimension };
}
