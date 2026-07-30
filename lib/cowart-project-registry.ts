import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const REGISTRY_VERSION = 1;
interface ProjectEntry { id: string; projectDir: string; canvasDir: string; addedAt: string | null; }
interface RawRegistry { version?: number; projects?: Array<Record<string, unknown>>; }

export interface CowartProjectRegistry {
  registryPath: string;
  list(): Promise<ProjectEntry[]>;
  addProject(input?: { projectDir?: string }): Promise<{ project: ProjectEntry; created: boolean }>;
  removeProject(id: string): Promise<ProjectEntry>;
}

export function defaultCowartProjectRegistryPath(): string {
  return join(homedir(), ".codex", "mosa", "cowart-projects.json");
}

export function createCowartProjectRegistry(options: { registryPath?: string; managerDir?: string } = {}): CowartProjectRegistry {
  const registryPath = resolve(options.registryPath || process.env.MOSA_COWART_REGISTRY_PATH || defaultCowartProjectRegistryPath());
  const managerDir = options.managerDir ? resolve(options.managerDir) : null;
  let mutation: Promise<unknown> = Promise.resolve();

  async function list(): Promise<ProjectEntry[]> { return normalizeProjects(await readRegistry()); }

  function addProject(input: { projectDir?: string } = {}): Promise<{ project: ProjectEntry; created: boolean }> {
    return mutate(async () => {
      const projectDir = await normalizeProjectDir(input.projectDir);
      if (managerDir && projectDir === managerDir) throw new Error("MOSA already uses its dedicated Cowart canvas.");
      const registry = await readRegistry();
      const projects = normalizeProjects(registry);
      const existing = projects.find((p) => p.projectDir === projectDir);
      if (existing) return { project: existing, created: false };
      const project: ProjectEntry = { id: projectIdFor(projectDir), projectDir, canvasDir: join(projectDir, "canvas"), addedAt: new Date().toISOString() };
      projects.push(project);
      await writeRegistry(projects);
      return { project, created: true };
    });
  }

  function removeProject(id: string): Promise<ProjectEntry> {
    return mutate(async () => {
      const cleanId = String(id || "").trim();
      if (!cleanId) throw new Error("Cowart canvas id is required.");
      const registry = await readRegistry();
      const projects = normalizeProjects(registry);
      const index = projects.findIndex((p) => p.id === cleanId);
      if (index < 0) throw new Error("Cowart canvas is not registered.");
      const [project] = projects.splice(index, 1) as [ProjectEntry];
      await writeRegistry(projects);
      return project;
    });
  }

  function mutate<T>(work: () => Promise<T>): Promise<T> {
    const next = mutation.then(work, work);
    mutation = next.catch(() => {});
    return next;
  }

  async function normalizeProjectDir(value: unknown): Promise<string> {
    if (typeof value !== "string" || !value.trim() || !isAbsolute(value.trim())) throw new Error("Cowart project path must be an absolute directory.");
    const requestedPath = resolve(value.trim());
    let projectDir: string;
    try { projectDir = await realpath(requestedPath); } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new Error("Cowart project directory does not exist.");
      throw error;
    }
    const details = await stat(projectDir);
    if (!details.isDirectory()) throw new Error("Cowart project path must point to a directory.");
    return projectDir;
  }

  async function readRegistry(): Promise<RawRegistry> {
    let raw: string;
    try { raw = await readFile(registryPath, "utf8"); } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { version: REGISTRY_VERSION, projects: [] };
      throw error;
    }
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object") throw new Error("not an object");
      return value as RawRegistry;
    } catch { throw new Error("Cowart canvas registry is invalid."); }
  }

  async function writeRegistry(projects: ProjectEntry[]): Promise<void> {
    await mkdir(dirname(registryPath), { recursive: true });
    const temporaryPath = `${registryPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify({ version: REGISTRY_VERSION, projects }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, registryPath);
    } finally { await unlink(temporaryPath).catch(() => {}); }
  }

  return { registryPath, list, addProject, removeProject };
}

function normalizeProjects(value: RawRegistry): ProjectEntry[] {
  const projects: Array<Record<string, unknown>> = Array.isArray(value?.projects) ? value.projects as Array<Record<string, unknown>> : [];
  const seen = new Set<string>();
  const normalized: ProjectEntry[] = [];
  for (const entry of projects) {
    if (typeof entry?.projectDir !== "string" || !entry.projectDir || !isAbsolute(entry.projectDir)) continue;
    const projectDir = resolve(entry.projectDir);
    if (seen.has(projectDir)) continue;
    seen.add(projectDir);
    normalized.push({ id: projectIdFor(projectDir), projectDir, canvasDir: join(projectDir, "canvas"), addedAt: typeof entry.addedAt === "string" ? entry.addedAt : null });
  }
  return normalized.sort((l, r) => String(l.addedAt || l.projectDir).localeCompare(String(r.addedAt || r.projectDir)));
}

function projectIdFor(projectDir: string): string {
  return `project-${createHash("sha256").update(projectDir).digest("hex").slice(0, 16)}`;
}
