import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const REGISTRY_VERSION = 1;

export function defaultCowartProjectRegistryPath() {
  return join(homedir(), ".codex", "mosa", "cowart-projects.json");
}

/**
 * Stores explicit Cowart project opt-ins. Cowart itself stays project-local;
 * this registry only tells MOSA which project canvas directories to watch.
 */
export function createCowartProjectRegistry(options = {}) {
  const registryPath = resolve(options.registryPath || process.env.MOSA_COWART_REGISTRY_PATH || defaultCowartProjectRegistryPath());
  const managerDir = options.managerDir ? resolve(options.managerDir) : null;
  let mutation = Promise.resolve();

  async function list() {
    return normalizeProjects(await readRegistry());
  }

  function addProject(input = {}) {
    return mutate(async () => {
      const projectDir = await normalizeProjectDir(input.projectDir);
      if (managerDir && projectDir === managerDir) {
        throw new Error("MOSA already uses its dedicated Cowart canvas.");
      }

      const registry = await readRegistry();
      const projects = normalizeProjects(registry);
      const existing = projects.find((project) => project.projectDir === projectDir);
      if (existing) return { project: existing, created: false };

      const project = {
        id: projectIdFor(projectDir),
        projectDir,
        canvasDir: join(projectDir, "canvas"),
        addedAt: new Date().toISOString(),
      };
      projects.push(project);
      await writeRegistry(projects);
      return { project, created: true };
    });
  }

  function removeProject(id) {
    return mutate(async () => {
      const cleanId = String(id || "").trim();
      if (!cleanId) throw new Error("Cowart canvas id is required.");

      const registry = await readRegistry();
      const projects = normalizeProjects(registry);
      const index = projects.findIndex((project) => project.id === cleanId);
      if (index < 0) throw new Error("Cowart canvas is not registered.");

      const [project] = projects.splice(index, 1);
      await writeRegistry(projects);
      return project;
    });
  }

  function mutate(work) {
    const next = mutation.then(work, work);
    mutation = next.catch(() => {});
    return next;
  }

  async function normalizeProjectDir(value) {
    if (typeof value !== "string" || !value.trim() || !isAbsolute(value.trim())) {
      throw new Error("Cowart project path must be an absolute directory.");
    }

    const requestedPath = resolve(value.trim());
    let projectDir;
    try {
      projectDir = await realpath(requestedPath);
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error("Cowart project directory does not exist.");
      throw error;
    }

    const details = await stat(projectDir);
    if (!details.isDirectory()) throw new Error("Cowart project path must point to a directory.");
    return projectDir;
  }

  async function readRegistry() {
    let raw;
    try {
      raw = await readFile(registryPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { version: REGISTRY_VERSION, projects: [] };
      throw error;
    }

    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object") throw new Error("not an object");
      return value;
    } catch {
      throw new Error("Cowart canvas registry is invalid.");
    }
  }

  async function writeRegistry(projects) {
    await mkdir(dirname(registryPath), { recursive: true });
    const temporaryPath = `${registryPath}.${process.pid}.${randomUUID()}.tmp`;
    const content = `${JSON.stringify({ version: REGISTRY_VERSION, projects }, null, 2)}\n`;
    try {
      await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, registryPath);
    } finally {
      await unlink(temporaryPath).catch(() => {});
    }
  }

  return { registryPath, list, addProject, removeProject };
}

function normalizeProjects(value) {
  const projects = Array.isArray(value?.projects) ? value.projects : [];
  const seen = new Set();
  const normalized = [];
  for (const entry of projects) {
    if (typeof entry?.projectDir !== "string" || !entry.projectDir || !isAbsolute(entry.projectDir)) continue;
    const projectDir = resolve(entry.projectDir);
    if (seen.has(projectDir)) continue;
    seen.add(projectDir);
    normalized.push({
      id: projectIdFor(projectDir),
      projectDir,
      canvasDir: join(projectDir, "canvas"),
      addedAt: typeof entry.addedAt === "string" ? entry.addedAt : null,
    });
  }
  return normalized.sort((left, right) => String(left.addedAt || left.projectDir).localeCompare(String(right.addedAt || right.projectDir)));
}

function projectIdFor(projectDir) {
  return `project-${createHash("sha256").update(projectDir).digest("hex").slice(0, 16)}`;
}
