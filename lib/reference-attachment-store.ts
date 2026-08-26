import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PIXEL_HASH_VERSION, safePixelDigest } from "./image-pixel-hash.js";

type ReferenceInput = {
  projectId?: string;
  bytes: Buffer;
  extension: string;
  mimeType: string;
  width: number;
  height: number;
  provider: string;
  pageUrl?: string;
  conversationId?: string;
  messageId?: string;
  capturedAt: string;
  userMessage?: string;
};

export type ReferenceAttachment = {
  id: string;
  project_id: string;
  content_sha256: string;
  pixel_sha256: string;
  pixel_hash_version: string;
  file_name: string;
  mime_type: string;
  width: number;
  height: number;
  provider: string;
  page_url: string;
  conversation_id: string;
  message_id: string;
  captured_at: string;
  user_message: string;
  attachment_url: string;
};

export function createReferenceAttachmentStore(libraryDir: string) {
  const root = resolve(libraryDir, "reference-attachments");
  // A runtime owns one store instance. Serialize the read-modify-write index
  // transaction so two captures arriving together cannot overwrite each
  // other's metadata entry.
  let saveQueue: Promise<unknown> = Promise.resolve();

  function save(input: ReferenceInput): Promise<{ attachment: ReferenceAttachment; created: boolean; duplicateKind?: "content" | "pixel" }> {
    const pending = saveQueue.then(() => withProjectWriteLock(root, input.projectId || "default", () => saveUnlocked(input)));
    saveQueue = pending.catch(() => undefined);
    return pending;
  }

  async function saveUnlocked(input: ReferenceInput): Promise<{ attachment: ReferenceAttachment; created: boolean; duplicateKind?: "content" | "pixel" }> {
    const projectId = cleanSegment(input.projectId || "default", "default");
    const projectRoot = join(root, projectId);
    const filesRoot = join(projectRoot, "files");
    const indexPath = join(projectRoot, "index.json");
    await mkdir(filesRoot, { recursive: true });
    const contentHash = createHash("sha256").update(input.bytes).digest("hex");
    const pixelHash = await safePixelDigest(input.bytes).catch(() => "");
    const indexed = await list(projectId);
    const existingByContent = indexed.find((item) => item.content_sha256 === contentHash);
    if (existingByContent) return { attachment: existingByContent, created: false, duplicateKind: "content" };
    const existingByPixel = pixelHash
      ? indexed.find((item) => item.pixel_hash_version === PIXEL_HASH_VERSION && item.pixel_sha256 === pixelHash)
      : undefined;
    if (existingByPixel) return { attachment: existingByPixel, created: false, duplicateKind: "pixel" };

    const extension = safeExtension(input.extension);
    const id = `ref-${contentHash.slice(0, 24)}`;
    const fileName = `${id}${extension}`;
    const filePath = join(filesRoot, fileName);
    const temporary = join(filesRoot, `.${id}-${randomUUID()}.tmp`);
    await writeFile(temporary, input.bytes, { flag: "wx" });
    try {
      await rename(temporary, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
    const attachment: ReferenceAttachment = {
      id,
      project_id: projectId,
      content_sha256: contentHash,
      pixel_sha256: pixelHash,
      pixel_hash_version: pixelHash ? PIXEL_HASH_VERSION : "",
      file_name: fileName,
      mime_type: String(input.mimeType || "application/octet-stream"),
      width: Number(input.width || 0),
      height: Number(input.height || 0),
      provider: String(input.provider || ""),
      page_url: String(input.pageUrl || ""),
      conversation_id: String(input.conversationId || ""),
      message_id: String(input.messageId || ""),
      captured_at: String(input.capturedAt || new Date().toISOString()),
      user_message: String(input.userMessage || ""),
      attachment_url: attachmentUrl(projectId, fileName),
    };
    const items = [...await list(projectId), attachment];
    const indexTemporary = `${indexPath}.${randomUUID()}.tmp`;
    await writeFile(indexTemporary, `${JSON.stringify(items, null, 2)}\n`, "utf8");
    await rename(indexTemporary, indexPath);
    return { attachment, created: true };
  }

  async function list(projectId = "default"): Promise<ReferenceAttachment[]> {
    const cleanProjectId = cleanSegment(projectId, "default");
    const indexPath = join(root, cleanProjectId, "index.json");
    try {
      const parsed = JSON.parse(await readFile(indexPath, "utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item) => item && typeof item === "object").map((item) => ({
        ...item,
        project_id: cleanProjectId,
        pixel_sha256: String(item.pixel_sha256 || ""),
        pixel_hash_version: String(item.pixel_hash_version || ""),
        attachment_url: attachmentUrl(cleanProjectId, cleanSegment(item.file_name, "reference.bin")),
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw error;
    }
  }

  async function read(projectId: string, fileName: string) {
    const cleanProjectId = cleanSegment(projectId, "default");
    const cleanFileName = cleanSegment(fileName, "");
    if (!cleanFileName) throw new Error("Reference attachment not found.");
    const filePath = join(root, cleanProjectId, "files", cleanFileName);
    const rootPath = resolve(root, cleanProjectId, "files");
    const resolved = resolve(filePath);
    if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${sep}`)) throw new Error("Reference attachment not found.");
    await stat(resolved);
    return { stream: createReadStream(resolved), fileName: basename(resolved) };
  }

  return { root, save, list, read };
}

function cleanSegment(value: unknown, fallback: string): string {
  const cleaned = String(value || "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160);
  return cleaned || fallback;
}

function safeExtension(value: string): string {
  const extension = extname(`file${String(value || "")}`).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"].includes(extension) ? extension : ".bin";
}

function attachmentUrl(projectId: string, fileName: string): string {
  return `/library/${encodeURIComponent(projectId)}/references/${encodeURIComponent(fileName)}`;
}

async function withProjectWriteLock<T>(root: string, projectId: string, task: () => Promise<T>): Promise<T> {
  const projectRoot = join(root, cleanSegment(projectId, "default"));
  const lockPath = join(projectRoot, ".index.lock");
  await mkdir(projectRoot, { recursive: true });
  for (let attempt = 0; attempt < 250; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid}:${Date.now()}\n`, "utf8");
    } catch (error) {
      await handle?.close().catch(() => {});
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > 30_000) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException)?.code === "ENOENT") continue;
        throw statError;
      }
      await delay(20);
      continue;
    }
    try {
      return await task();
    } finally {
      await handle.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
    }
  }
  throw new Error("Reference attachment index is busy.");
}
