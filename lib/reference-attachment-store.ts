import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";

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

  function save(input: ReferenceInput): Promise<{ attachment: ReferenceAttachment; created: boolean }> {
    const pending = saveQueue.then(() => saveUnlocked(input));
    saveQueue = pending.catch(() => undefined);
    return pending;
  }

  async function saveUnlocked(input: ReferenceInput): Promise<{ attachment: ReferenceAttachment; created: boolean }> {
    const projectId = cleanSegment(input.projectId || "default", "default");
    const projectRoot = join(root, projectId);
    const filesRoot = join(projectRoot, "files");
    const indexPath = join(projectRoot, "index.json");
    await mkdir(filesRoot, { recursive: true });
    const contentHash = createHash("sha256").update(input.bytes).digest("hex");
    const existing = (await list(projectId)).find((item) => item.content_sha256 === contentHash);
    if (existing) return { attachment: existing, created: false };

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
