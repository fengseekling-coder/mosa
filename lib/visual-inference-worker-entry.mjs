// Entry module for the dedicated visual inference child process.
//
// Spawned only by visual-inference-client.mjs over a private IPC channel.
// Messages:
//   { type: "init", requestId, packDir?, model?, verifyPack? }
//     -> { type: "ready", requestId, model, status } | { type: "error", requestId, code, message }
//   { type: "encode-image", requestId, imagePath }     -> result | error
//   { type: "encode-text", requestId, text }           -> result | error
//   { type: "status", requestId }                      -> { type: "report", requestId, ... }
//   { type: "ping", requestId }                        -> { type: "pong", requestId }
//   { type: "shutdown" }                               -> process exits 0
// Vectors travel as Float32Array over the "advanced" IPC serializer; the
// renderer never sees this channel or any file path.
import { createValidatedVisualEmbeddingProvider } from "./visual-embedding-provider.mjs";
import { createOnnxVisualEmbeddingProvider } from "./visual-embedding-onnx-provider.mjs";
import { verifyVisualModelPack } from "./visual-model-pack.mjs";

if (process.send) {
  process.on("message", (message) => {
    handleMessage(message).catch((error) => {
      // Last-resort containment: a request handler must never take the
      // process down. Unknown failures still keep the channel open.
      if (message && typeof message === "object" && message.requestId !== undefined) {
        sendSafe({
          type: "error",
          requestId: message.requestId,
          code: "VISUAL_INFERENCE_INTERNAL",
          message: error?.message || "Visual inference worker internal failure.",
        });
      }
    });
  });
  process.on("disconnect", () => {
    process.exit(0);
  });
}

let provider = null;

async function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  switch (message.type) {
    case "init": {
      if (provider) {
        sendSafe({ type: "ready", requestId: message.requestId, model: { ...provider.model }, status: provider.status() });
        return;
      }
      let pack = message.pack;
      if (message.packDir) {
        // Re-verify inside the worker so a pack swapped between discovery and
        // load cannot bypass the checksum contract (TOCTOU defense).
        const verified = await verifyVisualModelPack({ packDir: message.packDir });
        if (!verified.ok) {
          sendSafe({
            type: "error",
            requestId: message.requestId,
            code: "VISUAL_MODEL_PACK_VERIFICATION_FAILED",
            message: `Visual model pack verification failed: ${verified.code || "unknown"}.`,
          });
          return;
        }
        pack = verified;
      }
      if (!pack) {
        // Runtime-only probe: no pack, no model load.
        sendSafe({
          type: "ready",
          requestId: message.requestId,
          model: null,
          status: { probe: true, runtime: { onnx: await importOnnxVersion() } },
        });
        return;
      }
      const inner = createOnnxVisualEmbeddingProvider({ pack });
      provider = createValidatedVisualEmbeddingProvider({
        provider: inner,
        model: message.model || { id: pack.id, revision: pack.revision, dimension: pack.embedding_dimension },
      });
      await provider.start();
      sendSafe({ type: "ready", requestId: message.requestId, model: { ...provider.model }, status: provider.status() });
      return;
    }
    case "encode-image": {
      if (!provider) throw new Error("Visual inference worker is not initialized.");
      try {
        const vector = await provider.encodeImage(String(message.imagePath || ""), {
          projectId: message.projectId,
          assetId: message.assetId,
          contentSha256: message.contentSha256,
        });
        sendSafe({ type: "result", requestId: message.requestId, vector });
      } catch (error) {
        sendSafe({ type: "error", requestId: message.requestId, code: encodeErrorCode(error), message: error?.message || "Image encoding failed." });
      }
      return;
    }
    case "encode-text": {
      if (!provider) throw new Error("Visual inference worker is not initialized.");
      try {
        const vector = await provider.encodeText(String(message.text || ""), {
          projectId: message.projectId,
        });
        sendSafe({ type: "result", requestId: message.requestId, vector });
      } catch (error) {
        sendSafe({ type: "error", requestId: message.requestId, code: encodeErrorCode(error), message: error?.message || "Text encoding failed." });
      }
      return;
    }
    case "status": {
      sendSafe({
        type: "report",
        requestId: message.requestId,
        initialized: Boolean(provider),
        model: provider ? { ...provider.model } : null,
        status: provider ? provider.status() : null,
        memory: process.memoryUsage.rss(),
        uptime: process.uptime(),
      });
      return;
    }
    case "ping": {
      sendSafe({ type: "pong", requestId: message.requestId });
      return;
    }
    case "shutdown": {
      try {
        if (provider) await provider.close();
      } finally {
        provider = null;
        process.exit(0);
      }
      return;
    }
    default:
      return;
  }
}

function encodeErrorCode(error) {
  if (error?.code && typeof error.code === "string" && error.code.startsWith("VISUAL_")) return error.code;
  const message = String(error?.message || "");
  if (error?.code === "ENOENT") return "VISUAL_IMAGE_NOT_FOUND";
  if (/image|decode|sharp|premultiplied|corrupt/i.test(message)) return "VISUAL_IMAGE_DECODE_FAILED";
  if (/text query/i.test(message)) return "VISUAL_TEXT_INVALID";
  return "VISUAL_INFERENCE_ENCODE_FAILED";
}

async function importOnnxVersion() {
  try {
    const onnx = (await import("onnxruntime-node")).default;
    return { available: true, version: onnx?.env?.version || onnx?.env?.orthello?.version || null };
  } catch (error) {
    return { available: false, message: error?.message || "onnxruntime-node failed to load." };
  }
}

function sendSafe(message) {
  if (process.send && process.connected) {
    try {
      process.send(message);
    } catch {
      // Channel closed mid-response; the client's exit handler owns recovery.
    }
  }
}
