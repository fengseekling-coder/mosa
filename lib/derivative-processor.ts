import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import sharp from "./sharp-runtime.js";

const MAX_DERIVATIVE_INPUT_PIXELS = 40_000_000;

interface DerivativeProcessorJob {
  original_path: string;
  previewPath: string;
  mediumPath: string;
  thumbnailPath: string;
}

interface DerivativeProcessorRequest {
  type: "process-derivative";
  requestId: string;
  job: DerivativeProcessorJob;
}

interface ElectronParentPort {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

function normalizeJob(value: unknown): DerivativeProcessorJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Derivative processor received an invalid job.");
  }
  const input = value as Record<string, unknown>;
  const job = {
    original_path: String(input.original_path || "").trim(),
    previewPath: String(input.previewPath || "").trim(),
    mediumPath: String(input.mediumPath || "").trim(),
    thumbnailPath: String(input.thumbnailPath || "").trim(),
  };
  if (!job.original_path || !job.previewPath || !job.mediumPath || !job.thumbnailPath) {
    throw new Error("Derivative processor job paths are incomplete.");
  }
  return job;
}

async function generateDerivatives(job: DerivativeProcessorJob) {
  await Promise.all([
    mkdir(dirname(job.previewPath), { recursive: true }),
    mkdir(dirname(job.mediumPath), { recursive: true }),
    mkdir(dirname(job.thumbnailPath), { recursive: true }),
  ]);
  const sharpInputOptions = { animated: false, limitInputPixels: MAX_DERIVATIVE_INPUT_PIXELS } as const;
  const metadata = await sharp(job.original_path, sharpInputOptions).metadata();
  const orientation = Number(metadata.orientation) || 1;
  const swapsAxes = orientation >= 5 && orientation <= 8;
  const width = swapsAxes ? Number(metadata.height) : Number(metadata.width);
  const height = swapsAxes ? Number(metadata.width) : Number(metadata.height);

  await sharp(job.original_path, sharpInputOptions).rotate().resize({ width: 400, height: 400, fit: "inside", withoutEnlargement: true }).webp({ quality: 78 }).toFile(job.thumbnailPath);
  await sharp(job.original_path, sharpInputOptions).rotate().resize({ width: 960, height: 960, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toFile(job.mediumPath);
  await sharp(job.original_path, sharpInputOptions).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).webp({ quality: 84 }).toFile(job.previewPath);

  return {
    previewPath: job.previewPath,
    mediumPath: job.mediumPath,
    thumbnailPath: job.thumbnailPath,
    width,
    height,
    processorPid: process.pid,
  };
}

function sendToParent(message: unknown) {
  const electronPort = (process as NodeJS.Process & { parentPort?: ElectronParentPort | null }).parentPort;
  if (electronPort) {
    electronPort.postMessage(message);
    return;
  }
  if (typeof process.send === "function") process.send(message);
}

async function handleMessage(message: unknown) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  const request = message as Partial<DerivativeProcessorRequest>;
  if (request.type !== "process-derivative" || typeof request.requestId !== "string" || !request.requestId) return;
  try {
    const result = await generateDerivatives(normalizeJob(request.job));
    sendToParent({ type: "derivative-result", requestId: request.requestId, ok: true, result });
  } catch (error) {
    sendToParent({
      type: "derivative-result",
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const electronPort = (process as NodeJS.Process & { parentPort?: ElectronParentPort | null }).parentPort;
if (electronPort) {
  electronPort.on("message", (event) => { void handleMessage(event.data); });
} else {
  process.on("message", (message) => { void handleMessage(message); });
}
