import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createCowartAssetBridge } from "./cowart-bridge.mjs";

/**
 * Runs one narrow Cowart bridge per detected and persisted project canvas.
 * It deliberately has no filesystem discovery, so MOSA never scans unrelated
 * projects or arbitrary directories on the machine.
 */
export function createCowartBridgeManager(options = {}) {
  const store = options.store;
  const registry = options.registry;
  if (!store || typeof store.createAsset !== "function") throw new Error("Cowart bridge manager requires a MOSA store.");
  if (!registry || typeof registry.list !== "function") throw new Error("Cowart bridge manager requires a project registry.");

  const primarySource = {
    id: "mosa",
    projectDir: resolve(options.managerDir || store.managerDir),
    canvasDir: resolve(options.canvasDir || store.cowartCanvasDir),
    managed: true,
    addedAt: null,
  };
  const bridges = new Map();
  const sourceErrors = new Map();
  let registeredSources = [];
  let started = false;

  async function start() {
    registeredSources = await registry.list();
    await startSource(primarySource, { allowMissingProject: true });
    for (const source of registeredSources) await startSource(source);
    started = true;
    return status();
  }

  async function addProject(input = {}) {
    const result = await registry.addProject(input);
    if (!registeredSources.some((source) => source.id === result.project.id)) registeredSources.push(result.project);
    if (started) await startSource(result.project);
    return { ...result, canvas: sourceStatus(result.project) };
  }

  async function removeProject(id) {
    const project = await registry.removeProject(id);
    const bridge = bridges.get(project.id);
    bridge?.stop();
    bridges.delete(project.id);
    sourceErrors.delete(project.id);
    registeredSources = registeredSources.filter((source) => source.id !== project.id);
    return project;
  }

  async function startSource(source, options = {}) {
    if (bridges.has(source.id)) return sourceStatus(source);
    if (!options.allowMissingProject && !(await isDirectory(source.projectDir))) {
      sourceErrors.set(source.id, `Cowart project directory is unavailable: ${source.projectDir}`);
      return sourceStatus(source);
    }

    const bridge = createCowartAssetBridge({
      store,
      canvasDir: source.canvasDir,
      projectId: "default",
      cowartProjectDir: source.projectDir,
      sourceId: source.id,
    });
    bridges.set(source.id, bridge);
    try {
      await bridge.start();
      sourceErrors.delete(source.id);
    } catch (error) {
      bridge.stop();
      bridges.delete(source.id);
      sourceErrors.set(source.id, error instanceof Error ? error.message : String(error));
    }
    return sourceStatus(source);
  }

  function sources() {
    return [primarySource, ...registeredSources].map(sourceStatus);
  }

  function sourceStatus(source) {
    const bridgeStatus = bridges.get(source.id)?.status() || {};
    return {
      id: source.id,
      projectDir: source.projectDir,
      canvasDir: source.canvasDir,
      managed: Boolean(source.managed),
      addedAt: source.addedAt || null,
      enabled: Boolean(bridgeStatus.enabled),
      watching: Boolean(bridgeStatus.watching),
      polling: Boolean(bridgeStatus.polling),
      lastScanAt: bridgeStatus.lastScanAt || null,
      lastImportedAt: bridgeStatus.lastImportedAt || null,
      lastImportCount: Number(bridgeStatus.lastImportCount || 0),
      totalImported: Number(bridgeStatus.totalImported || 0),
      lastSkippedCount: Number(bridgeStatus.lastSkippedCount || 0),
      lastError: sourceErrors.get(source.id) || bridgeStatus.lastError || null,
    };
  }

  function status() {
    const entries = sources();
    return {
      canvasDir: primarySource.canvasDir,
      enabled: entries.some((entry) => entry.enabled),
      watching: entries.some((entry) => entry.watching),
      polling: entries.some((entry) => entry.polling),
      lastScanAt: newest(entries, "lastScanAt"),
      lastImportedAt: newest(entries, "lastImportedAt"),
      lastImportCount: entries.reduce((total, entry) => total + entry.lastImportCount, 0),
      totalImported: entries.reduce((total, entry) => total + entry.totalImported, 0),
      lastSkippedCount: entries.reduce((total, entry) => total + entry.lastSkippedCount, 0),
      lastError: entries.find((entry) => entry.lastError)?.lastError || null,
      monitoredCount: entries.filter((entry) => entry.enabled).length,
      registeredCount: registeredSources.length,
      sources: entries,
    };
  }

  function stop() {
    for (const bridge of bridges.values()) bridge.stop();
    bridges.clear();
    started = false;
  }

  return { start, stop, addProject, removeProject, sources, status };
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function newest(entries, key) {
  return entries.map((entry) => entry[key]).filter(Boolean).sort().at(-1) || null;
}
