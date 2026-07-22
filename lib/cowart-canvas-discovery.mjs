import { watch } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const DEFAULT_LOOKBACK_DAYS = 14;

/**
 * Discovers project-local Cowart canvases from actual canvas launch calls in
 * local Codex task records. This keeps discovery event-based and avoids
 * scanning arbitrary project directories on the machine.
 */
export function createCowartCanvasDiscovery(options = {}) {
  if (typeof options.onDiscover !== "function") {
    throw new Error("Cowart canvas discovery requires an onDiscover callback.");
  }

  const sessionsDir = resolve(options.sessionsDir || join(homedir(), ".codex", "sessions"));
  const managerDir = options.managerDir ? resolve(options.managerDir) : null;
  const dedicatedCanvasDir = options.dedicatedCanvasDir ? resolve(options.dedicatedCanvasDir) : null;
  const knownProjectDirs = typeof options.knownProjectDirs === "function" ? options.knownProjectDirs : () => [];
  const debounceMs = Number.isFinite(options.debounceMs) ? Math.max(0, options.debounceMs) : 500;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? Math.max(500, options.pollIntervalMs) : 5000;
  const lookbackDays = Number.isFinite(options.lookbackDays) ? Math.max(1, options.lookbackDays) : DEFAULT_LOOKBACK_DAYS;
  const cache = new Map();
  const dirtySessionPaths = new Set();
  let watcher = null;
  let poller = null;
  let timer = null;
  let reconciling = false;
  let reconcileAgain = false;
  let initialScan = true;
  const state = {
    sessionsDir,
    enabled: false,
    lastScanAt: null,
    lastDiscoveredAt: null,
    lastDiscoveredCount: 0,
    totalDiscovered: 0,
    candidateCount: 0,
    lastError: null,
  };

  async function reconcile() {
    if (reconciling) {
      reconcileAgain = true;
      return { discovered: [], candidates: [], queued: true };
    }
    reconciling = true;
    try {
      const candidates = await discoverCowartProjectsFromCodexSessions({
        sessionsDir,
        lookbackDays,
        cache,
        dirtySessionPaths,
        fullScan: initialScan,
      });
      initialScan = false;
      dirtySessionPaths.clear();
      state.candidateCount = candidates.length;

      const known = new Set(knownProjectDirs().filter(Boolean).map((value) => resolve(value)));
      const discovered = [];
      let discoveryError = null;
      for (const candidate of candidates) {
        if (known.has(candidate.projectDir)) continue;
        if (managerDir && candidate.projectDir === managerDir) continue;
        if (dedicatedCanvasDir && candidate.canvasDir === dedicatedCanvasDir) continue;
        try {
          const result = await options.onDiscover({
            projectDir: candidate.projectDir,
            discoveredBy: "codex-cowart-launch",
            discoveredAt: candidate.lastSeenAt,
          });
          known.add(candidate.projectDir);
          discovered.push(result?.canvas || result?.project || candidate);
        } catch (error) {
          discoveryError = error instanceof Error ? error.message : String(error);
        }
      }

      state.lastScanAt = new Date().toISOString();
      state.lastDiscoveredCount = discovered.length;
      state.totalDiscovered += discovered.length;
      if (discovered.length > 0) state.lastDiscoveredAt = state.lastScanAt;
      state.lastError = discoveryError;
      return { discovered, candidates, queued: false };
    } catch (error) {
      state.lastScanAt = new Date().toISOString();
      state.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      reconciling = false;
      if (reconcileAgain) {
        reconcileAgain = false;
        scheduleReconcile();
      }
    }
  }

  function scheduleReconcile(sessionPath = null) {
    if (sessionPath) dirtySessionPaths.add(resolve(sessionsDir, sessionPath));
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      reconcile().catch(() => {});
    }, debounceMs);
  }

  async function start() {
    await reconcile();
    try {
      watcher = watch(sessionsDir, { recursive: true }, (_event, fileName) => {
        const changedPath = fileName == null ? "" : String(fileName);
        const sessionPath = changedPath.endsWith(".jsonl") ? changedPath : null;
        scheduleReconcile(sessionPath);
      });
      watcher.on("error", () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      watcher = null;
    }
    poller = setInterval(() => reconcile().catch(() => {}), pollIntervalMs);
    state.enabled = true;
    return status();
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (poller) clearInterval(poller);
    poller = null;
    watcher?.close();
    watcher = null;
    state.enabled = false;
  }

  function status() {
    return { ...state, watching: Boolean(watcher), polling: Boolean(poller) };
  }

  return { start, stop, reconcile, scheduleReconcile, status };
}

export async function discoverCowartProjectsFromCodexSessions(options = {}) {
  const sessionsDir = resolve(options.sessionsDir || join(homedir(), ".codex", "sessions"));
  const lookbackDays = Number.isFinite(options.lookbackDays) ? Math.max(1, options.lookbackDays) : DEFAULT_LOOKBACK_DAYS;
  const cache = options.cache instanceof Map ? options.cache : new Map();
  const dirtyPaths = new Set([...(options.dirtySessionPaths || [])].map((value) => resolve(value)));
  const sessionPaths = new Set(await recentSessionPaths(sessionsDir, lookbackDays, options.fullScan === true));
  for (const filePath of options.dirtySessionPaths || []) {
    if (isSafeChildPath(sessionsDir, filePath) && String(filePath).endsWith(".jsonl")) sessionPaths.add(resolve(filePath));
  }

  const candidatesByProject = new Map();
  for (const sessionPath of sessionPaths) {
    let details;
    try {
      details = await stat(sessionPath);
    } catch {
      continue;
    }
    if (!details.isFile()) continue;
    const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
    if (options.fullScan === true && details.mtimeMs < cutoff && !dirtyPaths.has(sessionPath)) continue;

    const cached = cache.get(sessionPath);
    let projectDirs;
    if (cached?.mtimeMs === details.mtimeMs && cached?.size === details.size) {
      projectDirs = cached.projectDirs;
    } else {
      projectDirs = await projectDirsFromSession(sessionPath);
      cache.set(sessionPath, { mtimeMs: details.mtimeMs, size: details.size, projectDirs });
    }

    for (const requestedProjectDir of projectDirs) {
      const candidate = await cowartProjectCandidate(requestedProjectDir, sessionPath, details.mtime);
      if (!candidate) continue;
      const previous = candidatesByProject.get(candidate.projectDir);
      if (!previous || previous.lastSeenAt < candidate.lastSeenAt) candidatesByProject.set(candidate.projectDir, candidate);
    }
  }

  return [...candidatesByProject.values()].sort((left, right) => left.lastSeenAt.localeCompare(right.lastSeenAt));
}

async function projectDirsFromSession(sessionPath) {
  const raw = await readFile(sessionPath, "utf8");
  const contextDirs = new Set();
  const explicitDirs = new Set();
  let openedDefaultCanvas = false;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === "turn_context" && isAbsoluteString(event.payload?.cwd)) {
      contextDirs.add(resolve(event.payload.cwd));
      continue;
    }
    if (event?.type !== "response_item") continue;
    const call = cowartLaunchCall(event.payload);
    if (!call.opened) continue;
    openedDefaultCanvas = true;
    for (const projectDir of call.projectDirs) explicitDirs.add(resolve(projectDir));
  }

  if (!openedDefaultCanvas) return [];
  return explicitDirs.size > 0 ? [...explicitDirs] : [...contextDirs];
}

function cowartLaunchCall(payload = {}) {
  const name = String(payload.name || payload.tool_name || "");
  const rawArguments = payload.arguments ?? payload.input ?? payload.params ?? "";
  const parsedArguments = parseArguments(rawArguments);
  if (name.includes("render_cowart_canvas_widget")) {
    return { opened: true, projectDirs: projectDirsFromArguments(parsedArguments) };
  }

  if (payload.type !== "custom_tool_call" && payload.type !== "function_call") {
    return { opened: false, projectDirs: [] };
  }
  const source = typeof rawArguments === "string" ? rawArguments : JSON.stringify(rawArguments);
  const invokesNativeWidget = /tools\.[A-Za-z0-9_$]*render_cowart_canvas_widget\s*\(/.test(source);
  const invokesLocalCanvas = /\bcmd\s*:\s*["'](?:\.\/|\/[^"']*\/)?scripts\/start-canvas\.sh(?:\s|["'])/.test(source)
    || /^\s*(?:\.\/|\/\S*\/)?scripts\/start-canvas\.sh(?:\s|$)/.test(String(parsedArguments?.cmd || ""));
  if (!invokesNativeWidget && !invokesLocalCanvas) return { opened: false, projectDirs: [] };

  const projectDirs = invokesLocalCanvas
    ? projectDirsFromExecArguments(parsedArguments, source)
    : projectDirsFromArguments(parsedArguments);
  if (projectDirs.length === 0 && invokesNativeWidget) {
    const match = /\bprojectDir\s*:\s*["']([^"']+)["']/.exec(source);
    if (isAbsoluteString(match?.[1])) projectDirs.push(match[1]);
  }
  return { opened: true, projectDirs };
}

function parseArguments(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function projectDirsFromArguments(args) {
  return isAbsoluteString(args?.projectDir) ? [args.projectDir] : [];
}

/**
 * Extracts candidate project directories from a structured exec_command call
 * that launches start-canvas.sh.  Priority: projectDir > workdir > cwd, deduped.
 * Falls back to regex on the raw source string for JS-call-style arguments
 * where the structured fields are absent.
 */
function projectDirsFromExecArguments(args, source) {
  const dirs = [];
  for (const field of ["projectDir", "workdir", "cwd"]) {
    if (isAbsoluteString(args?.[field])) dirs.push(args[field].trim());
  }
  if (dirs.length > 0) return dedupeResolved(dirs);

  // Regex fallback for JS-call-style arguments (e.g. {cmd:"...", workdir:"..."})
  // that were parsed into an object but whose keys may use quoted strings.
  const workdirMatch = /\bworkdir\s*:\s*["']([^"']+)["']/i.exec(source);
  const cwdMatch = /\bcwd\s*:\s*["']([^"']+)["']/i.exec(source);
  const projectDirMatch = /\bprojectDir\s*:\s*["']([^"']+)["']/i.exec(source);
  if (isAbsoluteString(projectDirMatch?.[1])) dirs.push(projectDirMatch[1]);
  if (isAbsoluteString(workdirMatch?.[1])) dirs.push(workdirMatch[1]);
  if (isAbsoluteString(cwdMatch?.[1])) dirs.push(cwdMatch[1]);
  return dedupeResolved(dirs);
}

function dedupeResolved(dirs) {
  const seen = new Set();
  const result = [];
  for (const dir of dirs) {
    const resolved = resolve(dir);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      result.push(dir);
    }
  }
  return result;
}

async function cowartProjectCandidate(requestedProjectDir, sessionPath, lastSeen) {
  if (!isAbsoluteString(requestedProjectDir)) return null;
  let projectDir;
  try {
    projectDir = await realpath(requestedProjectDir);
  } catch {
    return null;
  }
  const canvasDir = join(projectDir, "canvas");
  if (!(await hasCowartCanvasMarker(canvasDir))) return null;
  return {
    projectDir,
    canvasDir,
    sessionPath,
    lastSeenAt: lastSeen.toISOString(),
  };
}

async function hasCowartCanvasMarker(canvasDir) {
  for (const marker of ["cowart-view-state.json", "cowart-selection.json", join("pages", "manifest.json")]) {
    try {
      if ((await stat(join(canvasDir, marker))).isFile()) return true;
    } catch {
      // Continue checking the narrow set of Cowart-owned marker files.
    }
  }
  return false;
}

async function recentSessionPaths(sessionsDir, lookbackDays, fullScan) {
  if (fullScan) return walkJsonlFiles(sessionsDir);
  const directories = new Set([sessionsDir]);
  for (let offset = 0; offset < lookbackDays; offset += 1) {
    const date = new Date(Date.now() - offset * 24 * 60 * 60 * 1000);
    directories.add(join(sessionsDir, datePart(date.getFullYear()), datePart(date.getMonth() + 1), datePart(date.getDate())));
    directories.add(join(sessionsDir, datePart(date.getUTCFullYear()), datePart(date.getUTCMonth() + 1), datePart(date.getUTCDate())));
  }

  const files = [];
  for (const directory of directories) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(directory, entry.name));
    }
  }
  return files;
}

async function walkJsonlFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkJsonlFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(entryPath);
  }
  return files;
}

function isSafeChildPath(parent, child) {
  const root = `${resolve(parent)}/`;
  return resolve(child).startsWith(root);
}

function isAbsoluteString(value) {
  return typeof value === "string" && value.trim() && isAbsolute(value.trim());
}

function datePart(value) {
  return String(value).padStart(2, "0");
}
