import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { discoverVisualModelPacks } from "../lib/visual-model-pack.mjs";

const SETTINGS_SCHEMA = "mosa.visual-model-settings/1";

export function createVisualModelManager({
  userDataDir,
  runtimeAvailable = false,
  discoverPacks = discoverVisualModelPacks,
} = {}) {
  const baseDir = String(userDataDir || "").trim();
  if (!baseDir) throw new Error("Visual model manager requires Electron userData.");
  const settingsPath = join(baseDir, "visual-model-settings.json");
  let cache = null;

  async function refresh() {
    const [discovery, settings] = await Promise.all([
      discoverPacks({ userDataDir: baseDir }),
      readSettings(settingsPath),
    ]);
    const selected = discovery.packs.find((pack) =>
      pack.id === settings.active_pack_id && pack.revision === settings.active_revision);
    const active = selected || discovery.packs[0] || null;
    const enabled = settings.enabled === true && Boolean(active);
    cache = {
      mode: "mosa-local",
      state: !active
        ? "not-installed"
        : !enabled
          ? "disabled"
          : runtimeAvailable
            ? "ready"
            : "runtime-unavailable",
      installed: discovery.packs.length > 0,
      enabled,
      runtime_available: runtimeAvailable === true,
      active_pack: active ? summarizePack(active) : null,
      packs: discovery.packs.map(summarizePack),
      invalid_packs: discovery.invalid,
      model_pack_root: discovery.root,
    };
    return structuredClone(cache);
  }

  return {
    async state({ refresh: force = false } = {}) {
      if (!cache || force) return refresh();
      return structuredClone(cache);
    },

    async setEnabled(enabled) {
      const current = await refresh();
      if (enabled && !current.active_pack) {
        const error = new Error("Install a verified MOSA visual model pack before enabling local visual search.");
        error.code = "VISUAL_MODEL_NOT_INSTALLED";
        throw error;
      }
      const settings = await readSettings(settingsPath);
      settings.enabled = enabled === true;
      if (current.active_pack) {
        settings.active_pack_id = current.active_pack.id;
        settings.active_revision = current.active_pack.revision;
      }
      await writeSettings(settingsPath, settings);
      return refresh();
    },

    async selectPack(id, revision) {
      const current = await refresh();
      const selected = current.packs.find((pack) => pack.id === String(id || "") && pack.revision === String(revision || ""));
      if (!selected) {
        const error = new Error("Requested MOSA visual model pack is not installed or failed verification.");
        error.code = "VISUAL_MODEL_PACK_NOT_FOUND";
        throw error;
      }
      const settings = await readSettings(settingsPath);
      settings.active_pack_id = selected.id;
      settings.active_revision = selected.revision;
      await writeSettings(settingsPath, settings);
      return refresh();
    },
  };
}

function summarizePack(pack) {
  return {
    id: pack.id,
    revision: pack.revision,
    embedding_dimension: pack.embedding_dimension,
    total_bytes: pack.total_bytes,
    license: pack.license,
    pack_dir: pack.pack_dir,
  };
}

async function readSettings(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (parsed?.schema !== SETTINGS_SCHEMA) return defaultSettings();
    return {
      ...defaultSettings(),
      enabled: parsed.enabled === true,
      active_pack_id: String(parsed.active_pack_id || ""),
      active_revision: String(parsed.active_revision || ""),
    };
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return defaultSettings();
    throw error;
  }
}

async function writeSettings(path, settings) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + ".tmp";
  await writeFile(temporary, JSON.stringify({
    schema: SETTINGS_SCHEMA,
    enabled: settings.enabled === true,
    active_pack_id: String(settings.active_pack_id || ""),
    active_revision: String(settings.active_revision || ""),
  }, null, 2) + "\n", "utf8");
  await rename(temporary, path);
}

function defaultSettings() {
  return {
    schema: SETTINGS_SCHEMA,
    enabled: false,
    active_pack_id: "",
    active_revision: "",
  };
}
