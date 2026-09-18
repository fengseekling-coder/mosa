// Fake visual inference worker used by client protocol tests. The mode comes
// from the first fork argument so tests can drive every failure class without
// loading a real model.
const mode = process.argv[2] || "ok";
let crashedOnce = false;
const dimension = Number(process.env.FAKE_DIMENSION || 4);

function vector(seed) {
  const out = new Float32Array(dimension);
  for (let i = 0; i < dimension; i += 1) out[i] = ((seed.charCodeAt(seed.length - 1) + i) % 7 + 1) / 7;
  return out;
}

process.on("message", async (message) => {
  if (!message || typeof message !== "object") return;
  const { type, requestId } = message;
  if (type === "init") {
    if (mode === "hang") return;
    if (mode === "crash-on-init") process.exit(1);
    const report = mode === "wrong-identity"
      ? { id: "other-model", revision: "r2", dimension: dimension + 2 }
      : { id: message.model?.id ?? "fake-model", revision: message.model?.revision ?? "r1", dimension };
    process.send({ type: "ready", requestId, model: report, status: { fake: true } });
    if (mode === "crash-after-init") setTimeout(() => process.exit(1), 20);
    return;
  }
  if (type === "encode-image") {
    if (mode === "slow-image") {
      setTimeout(() => process.send({ type: "result", requestId, vector: vector(message.imagePath || "x") }), 1000);
      return;
    }
    if (String(message.imagePath).includes("broken")) {
      process.send({ type: "error", requestId, code: "VISUAL_IMAGE_DECODE_FAILED", message: "fake decode failure" });
      return;
    }
    if (mode === "crash-on-encode" && !crashedOnce) {
      crashedOnce = true;
      process.exit(1);
    }
    process.send({ type: "result", requestId, vector: vector(message.imagePath || "x") });
    return;
  }
  if (type === "encode-text") {
    if (mode === "slow") {
      setTimeout(() => process.send({ type: "result", requestId, vector: vector(message.text || "x") }), 1000);
      return;
    }
    process.send({ type: "result", requestId, vector: vector(message.text || "x") });
    return;
  }
  if (type === "status") {
    process.send({ type: "report", requestId, initialized: true, model: null, memory: 1, uptime: 1 });
    return;
  }
  if (type === "ping") {
    process.send({ type: "pong", requestId });
    return;
  }
  if (type === "shutdown") process.exit(0);
});
