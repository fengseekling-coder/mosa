import { resolve, dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";

/**
 * Synchronous, no-write validator for MOSA QA/debug/automation instances.
 *
 * This validator never accesses the database, creates files, or starts
 * services. Callers invoke it after resolving their runtime parameters but
 * before acquiring the runtime lock, opening SQLite, starting the HTTP
 * server, or creating a BrowserWindow.
 *
 * In production mode (no QA signal detected) the guard passes without any
 * checks so that normal startup behaviour is never altered.
 *
 * QA mode is detected through any of:
 *   - `params.runtimeMode` is "qa" / "test" / "debug"
 *   - `params.argv` contains `--remote-debugging-port` (Electron CDP)
 *   - `params.qaRun` is truthy (legacy automation marker)
 *   - `params.hasQaMode` is explicitly true (override)
 *
 * @param {object} params
 * @param {string|null|undefined} params.libraryDir  Raw library directory.
 * @param {number|string|null|undefined} params.port  Port number.
 * @param {string|null|undefined} params.runtimeMode  Runtime mode signal.
 * @param {boolean|string|null|undefined} params.qaRun  Explicit QA run flag.
 * @param {string[]} [params.argv]  process.argv to scan for CDP flags.
 *     Defaults to process.argv.
 * @param {boolean} [params.hasQaMode]  Force QA mode on/off.  When set the
 *     auto-detection logic is skipped entirely.
 * @param {string} [params.productionLibraryDir]  Real production library dir.
 *     Defaults to ~/MOSA Library.
 * @param {number[]} [params.productionPorts]  Forbidden port numbers.
 *     Defaults to [43517, 43519, 43637].
 * @param {string|null|undefined} [params.userData]  Expected userData
 *     (from env or options).  Must be provided in QA mode.
 * @param {string|null|undefined} [params.actualUserData]  Actual userData
 *     from app.getPath("userData") for Electron, or the isolated userData
 *     root for web QA.  Required in QA mode and must match expected.
 * @param {string|null|undefined} [params.defaultUserData]  Stable default
 *     userData path when no QA --user-data-dir override is applied.
 *     actualUserData must not equal or be contained within.
 * @param {"web"|"electron"} [params.runtimeKind]  Runtime family the
 *     parameters come from.  Web QA has no app.getPath, so its isolated
 *     userData is the verifiable run parameter; Electron must report the
 *     real app.getPath("userData").  Both kinds still require an explicit
 *     actualUserData — there is no optional-actualUserData fallback.
 * @returns {{ ok: true } | { ok: false, reason: string, field: string }}
 */
export function validateRuntimeIsolation(params = {}) {
  const {
    libraryDir,
    port,
    runtimeMode,
    qaRun,
    argv = process.argv,
    hasQaMode,
    productionLibraryDir = "",
    productionPorts = [43517, 43519, 43637],
    userData,
    actualUserData,
    defaultUserData,
    runtimeKind = "web",
  } = params;

  // ---- Detect QA mode ----
  let detectedQa;
  if (hasQaMode === true) {
    detectedQa = true;
  } else if (hasQaMode === false) {
    detectedQa = false;
  } else {
    const mode = (runtimeMode || "").toLowerCase();
    detectedQa =
      mode === "qa" || mode === "test" || mode === "debug" ||
      qaRun ||
      argv.some((a) => a.startsWith("--remote-debugging-port"));
  }

  if (!detectedQa) {
    return { ok: true };
  }

  // ---- Safe canonicalization ----
  // For a path that exists, use realpath.  For one that does not, walk up to
  // the first existing ancestor, realpath that, then reconstruct the tail.
  function safeCanonical(path) {
    const resolved = resolve(path);
    try {
      return realpathSync(resolved);
    } catch {
      let current = resolved;
      const tail = [];
      while (true) {
        const parent = dirname(current);
        if (parent === current) {
          // Reached filesystem root without finding any existing ancestor
          return resolve(path);
        }
        // Push the basename of current (relative to parent) before checking
        tail.push(current.slice(parent.length + 1));
        try {
          const canonParent = realpathSync(parent);
          return resolve(canonParent, ...tail.reverse());
        } catch {
          // Parent does not exist either — keep walking up
          current = parent;
        }
      }
    }
  }

  // ---- Resolve production paths ----
  const prodLib = safeCanonical(productionLibraryDir || resolve(join(homedir(), "MOSA Library")));

  // ---- 1. libraryDir must be explicit ----
  if (!libraryDir) {
    return {
      ok: false,
      reason: "MOSA_LIBRARY_DIR is required in QA/debug mode but was not set.",
      field: "libraryDir",
    };
  }

  const canonLib = safeCanonical(libraryDir);

  // ---- 2. libraryDir must not equal production library ----
  if (canonLib === prodLib) {
    return {
      ok: false,
      reason: "libraryDir must not equal the production library directory.",
      field: "libraryDir",
    };
  }

  // ---- 3. libraryDir must not be a subdirectory of production library ----
  if (canonLib.startsWith(prodLib + "/")) {
    return {
      ok: false,
      reason: "libraryDir must not be a subdirectory of the production library directory.",
      field: "libraryDir",
    };
  }

  // ---- 4. Port must be explicit, valid integer, and not production ----
  if (port === undefined || port === null || port === "") {
    return {
      ok: false,
      reason: "Port is required in QA/debug mode but was not set.",
      field: "port",
    };
  }

  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return {
      ok: false,
      reason: `Port must be an integer between 1 and 65535, got ${JSON.stringify(port)}.`,
      field: "port",
    };
  }

  if (productionPorts.includes(portNum)) {
    return {
      ok: false,
      reason: `Port ${portNum} is a reserved production port. QA/debug mode must use a non-production port.`,
      field: "port",
    };
  }

  // ---- 5. userData (expected) must be explicit ----
  if (!userData) {
    return {
      ok: false,
      reason: "MOSA_USER_DATA (expected userData) is required in QA/debug mode but was not set.",
      field: "userData",
    };
  }

  // ---- 6. actualUserData must be explicit and match expected userData ----
  // Electron QA must report the real app.getPath("userData"); web QA reports
  // its isolated userData root.  Either way a missing value is a hard reject:
  // there is no optional-actualUserData fallback that could silently allow a
  // production userData directory through.
  if (!actualUserData) {
    const label = runtimeKind === "electron"
      ? "Electron app.getPath(\"userData\") (actualUserData)"
      : "Isolated userData (actualUserData)";
    return {
      ok: false,
      reason: `${label} is required in QA/debug mode but was not set.`,
      field: "userData",
    };
  }

  const canonActual = safeCanonical(actualUserData);
  const canonExpected = safeCanonical(userData);
  if (canonActual !== canonExpected) {
    return {
      ok: false,
      reason: `actualUserData ${canonActual} does not match expected userData ${canonExpected}.`,
      field: "userData",
    };
  }

  // ---- 7. actualUserData must not equal or be inside defaultUserData ----
  if (defaultUserData) {
    const canonDefault = safeCanonical(defaultUserData);
    if (canonActual === canonDefault) {
      return {
        ok: false,
        reason: "actualUserData must not equal the Electron default production userData directory.",
        field: "userData",
      };
    }
    if (canonActual.startsWith(canonDefault + "/")) {
      return {
        ok: false,
        reason: "actualUserData must not be a subdirectory of the Electron default production userData directory.",
        field: "userData",
      };
    }
  }

  return { ok: true };
}