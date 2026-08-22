import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { validateRuntimeIsolation } from "../lib/runtime-isolation-guard.mjs";

const PROD_LIB = resolve(join(homedir(), "MOSA Library"));
const PROD_PORTS = [43517, 43519, 43637];
const PROD_USERDATA = resolve(join(homedir(), "Library", "Application Support", "MOSA"));

/**
 * Happy-path params bag that passes the guard.
 */
function happyParams(overrides = {}) {
  return {
    libraryDir: join(tmpdir(), "mosa-guard-test-lib"),
    port: 44444,
    runtimeMode: "qa",
    qaRun: true,
    userData: join(tmpdir(), "mosa-guard-test-ud"),
    actualUserData: join(tmpdir(), "mosa-guard-test-ud"),
    argv: ["node", "test.mjs"],
    productionLibraryDir: PROD_LIB,
    productionPorts: PROD_PORTS,
    defaultUserData: PROD_USERDATA,
    ...overrides,
  };
}

// =========================================================================
// A. Missing libraryDir
// =========================================================================
test("A: QA mode rejects missing libraryDir", () => {
  const result = validateRuntimeIsolation(happyParams({ libraryDir: undefined }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /MOSA_LIBRARY_DIR is required/);
  assert.equal(result.field, "libraryDir");
});

// =========================================================================
// B. Production library and subdirectory rejection
// =========================================================================
test("B1: QA mode rejects libraryDir equal to production library", () => {
  const result = validateRuntimeIsolation(happyParams({ libraryDir: PROD_LIB }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /must not equal the production library/);
  assert.equal(result.field, "libraryDir");
});

test("B2: QA mode rejects libraryDir as subdirectory of production library", () => {
  const result = validateRuntimeIsolation(happyParams({ libraryDir: join(PROD_LIB, "sub") }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /must not be a subdirectory/);
  assert.equal(result.field, "libraryDir");
});

// =========================================================================
// C. Symlink and path traversal rejection
// =========================================================================
test("C1: QA mode rejects direct symlink to production library", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "mosa-guard-c1-"));
  const linkPath = join(tmpDir, "fake-lib");
  await symlink(PROD_LIB, linkPath);
  const result = validateRuntimeIsolation(happyParams({ libraryDir: linkPath }));
  assert.equal(result.ok, false);
  assert.equal(result.field, "libraryDir");
  try { await import("node:fs/promises").then(fs => fs.rm(tmpDir, { recursive: true, force: true })); } catch {}
});

test("C1b: QA mode rejects a dangling symlink to production library", async (t) => {
  const tmpDir = await mkdtemp(join(tmpdir(), "mosa-guard-c1b-"));
  t.after(() => import("node:fs/promises").then(fs => fs.rm(tmpDir, { recursive: true, force: true })));
  const absentProductionLibrary = join(tmpDir, "production-library");
  const linkPath = join(tmpDir, "fake-lib");
  await symlink(absentProductionLibrary, linkPath);
  const result = validateRuntimeIsolation(happyParams({
    libraryDir: linkPath,
    productionLibraryDir: absentProductionLibrary,
  }));
  assert.equal(result.ok, false);
  assert.equal(result.field, "libraryDir");
});

test("C2: QA mode rejects parent-directory symlink bypass", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "mosa-guard-c2-"));
  // Create a symlink dir that points to parent of PROD_LIB, then traverse
  const prodParent = resolve(PROD_LIB, "..");
  const linkDir = join(tmpDir, "fake-parent");
  await symlink(prodParent, linkDir);
  // Now libraryDir = linkDir/MOSA Library -> should resolve to PROD_LIB
  const traversed = join(linkDir, "MOSA Library");
  const result = validateRuntimeIsolation(happyParams({ libraryDir: traversed }));
  assert.equal(result.ok, false);
  assert.equal(result.field, "libraryDir");
  try { await import("node:fs/promises").then(fs => fs.rm(tmpDir, { recursive: true, force: true })); } catch {}
});

test("C3: QA mode rejects non-existent tail with parent symlink bypass", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "mosa-guard-c3-"));
  const prodParent = resolve(PROD_LIB, "..");
  const linkDir = join(tmpDir, "fake-parent");
  await symlink(prodParent, linkDir);
  // libraryDir = linkDir/MOSA Library/subdir (subdir doesn't exist)
  // parent linkDir/fake-parent exists (symlink to prodParent)
  // safeCanonical: walk up, realpath linkDir -> prodParent, then reconstruct
  const traversed = join(linkDir, "MOSA Library", "subdir");
  const result = validateRuntimeIsolation(happyParams({ libraryDir: traversed }));
  assert.equal(result.ok, false);
  assert.equal(result.field, "libraryDir");
  try { await import("node:fs/promises").then(fs => fs.rm(tmpDir, { recursive: true, force: true })); } catch {}
});

// =========================================================================
// D. Port validation: missing / NaN / out of range / production
// =========================================================================
test("D1: QA mode rejects missing port", () => {
  const result = validateRuntimeIsolation(happyParams({ port: undefined }));
  assert.equal(result.ok, false);
  assert.equal(result.field, "port");
});

test("D2: QA mode rejects NaN port", () => {
  const result = validateRuntimeIsolation(happyParams({ port: "not-a-number" }));
  assert.equal(result.ok, false);
  assert.equal(result.field, "port");
});

test("D3: QA mode rejects port 0", () => {
  const result = validateRuntimeIsolation(happyParams({ port: 0 }));
  assert.equal(result.ok, false);
  assert.equal(result.field, "port");
});

test("D4: QA mode rejects port > 65535", () => {
  const result = validateRuntimeIsolation(happyParams({ port: 70000 }));
  assert.equal(result.ok, false);
  assert.equal(result.field, "port");
});

for (const prodPort of [43517, 43519, 43637]) {
  test(`D5: QA mode rejects production port ${prodPort}`, () => {
    const result = validateRuntimeIsolation(happyParams({ port: prodPort }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /reserved production port/);
    assert.equal(result.field, "port");
  });
}

// =========================================================================
// E. Missing expected/actual userData
// =========================================================================
test("E1: QA mode rejects missing expected userData", () => {
  const result = validateRuntimeIsolation(happyParams({ userData: undefined }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /MOSA_USER_DATA.*is required/);
  assert.equal(result.field, "userData");
});

test("E2: QA mode rejects missing actualUserData", () => {
  // R1 narrow fix (issue 3): actualUserData is mandatory in QA mode. The old
  // "optional actualUserData" fallback silently let a run through with only
  // the expected value checked; Electron QA must always report the real
  // app.getPath("userData") so the actual-vs-default check can never be
  // skipped.
  const result = validateRuntimeIsolation(happyParams({
    userData: join(tmpdir(), "mosa-ud"),
    actualUserData: undefined,
    defaultUserData: PROD_USERDATA,
  }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /actualUserData.*is required/);
  assert.equal(result.field, "userData");
});

test("E3: web QA also requires actualUserData (isolated userData as verifiable parameter)", () => {
  // Web QA has no app.getPath("userData"); its isolated userData root is the
  // verifiable run parameter and must be passed explicitly — there is no
  // optional-actualUserData escape hatch for the web kind either.
  const result = validateRuntimeIsolation(happyParams({
    runtimeKind: "web",
    actualUserData: undefined,
  }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /actualUserData.*is required/);
  assert.equal(result.field, "userData");
});

// =========================================================================
// F. actualUserData mismatch
// =========================================================================
test("F: QA mode rejects actualUserData != expected userData", () => {
  const result = validateRuntimeIsolation(happyParams({
    userData: join(tmpdir(), "mosa-expected-ud"),
    actualUserData: join(tmpdir(), "mosa-actual-ud"),
  }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not match expected/);
  assert.equal(result.field, "userData");
});

// =========================================================================
// G. actualUserData equals or inside default userData
// =========================================================================
test("G1: QA mode rejects actualUserData equal to default production userData", () => {
  const result = validateRuntimeIsolation(happyParams({
    userData: PROD_USERDATA,
    actualUserData: PROD_USERDATA,
    defaultUserData: PROD_USERDATA,
  }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /must not equal the Electron default/);
  assert.equal(result.field, "userData");
});

test("G2: QA mode rejects actualUserData as subdirectory of default userData", () => {
  const result = validateRuntimeIsolation(happyParams({
    userData: join(PROD_USERDATA, "sub"),
    actualUserData: join(PROD_USERDATA, "sub"),
    defaultUserData: PROD_USERDATA,
  }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /must not be a subdirectory/);
  assert.equal(result.field, "userData");
});

test("G3: QA mode rejects actualUserData symlink to default userData", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "mosa-guard-g3-"));
  const linkUd = join(tmpDir, "fake-ud");
  await symlink(PROD_USERDATA, linkUd);
  const result = validateRuntimeIsolation(happyParams({
    userData: linkUd,
    actualUserData: linkUd,
    defaultUserData: PROD_USERDATA,
  }));
  assert.equal(result.ok, false);
  assert.equal(result.field, "userData");
  try { await import("node:fs/promises").then(fs => fs.rm(tmpDir, { recursive: true, force: true })); } catch {}
});

test("G4: QA mode accepts a temporary actualUserData distinct from the production default", () => {
  // R1 narrow fix (issue 1): the production default must stay the stable
  // un-overridden path. A temporary QA actualUserData must never be confused
  // with that default (the old bug passed the overridden app.getPath value as
  // defaultUserData, which made the actual-vs-default comparison trivially
  // pass).
  const tempUserData = join(tmpdir(), "mosa-qa-temp-userdata");
  const result = validateRuntimeIsolation(happyParams({
    userData: tempUserData,
    actualUserData: tempUserData,
    defaultUserData: PROD_USERDATA,
  }));
  assert.equal(result.ok, true);
});

// =========================================================================
// H. Production mode (no QA signal) — no checks
// =========================================================================
test("H: Production mode allows everything without checks", () => {
  const result = validateRuntimeIsolation({
    libraryDir: undefined,
    port: 43517,
    runtimeMode: undefined,
    qaRun: undefined,
    userData: undefined,
    actualUserData: undefined,
    argv: ["node", "server.mjs"],
    productionLibraryDir: PROD_LIB,
    productionPorts: PROD_PORTS,
    hasQaMode: false,
  });
  assert.equal(result.ok, true);
});

// Explicit hasQaMode=false should skip all checks
test("H2: hasQaMode=false skips all checks even with obvious QA signals", () => {
  const result = validateRuntimeIsolation({
    libraryDir: undefined,
    port: 43517,
    runtimeMode: "qa",
    qaRun: "1",
    userData: undefined,
    actualUserData: undefined,
    argv: ["node", "electron", "--remote-debugging-port=9222"],
    productionLibraryDir: PROD_LIB,
    productionPorts: PROD_PORTS,
    hasQaMode: false,
  });
  assert.equal(result.ok, true);
});

// =========================================================================
// I. remote-debugging-port triggers QA mode
// =========================================================================
test("I: remote-debugging-port in argv triggers QA mode", () => {
  const result = validateRuntimeIsolation({
    libraryDir: undefined,
    port: 43517,
    runtimeMode: undefined,
    qaRun: undefined,
    userData: undefined,
    actualUserData: undefined,
    argv: ["node", "electron", "--remote-debugging-port=9222"],
    productionLibraryDir: PROD_LIB,
    productionPorts: PROD_PORTS,
    defaultUserData: PROD_USERDATA,
  });
  assert.equal(result.ok, false);
  assert.equal(result.field, "libraryDir");
});

// =========================================================================
// J. Guard contract: synchronous, no-write, before lock/createServer
// =========================================================================
test("J: guard is a synchronous no-write validator", () => {
  const result = validateRuntimeIsolation(happyParams({ libraryDir: "/nonexistent/qa-test-dir" }));
  assert.equal(result.ok, true);
  // Must be synchronous
  assert.equal(typeof validateRuntimeIsolation, "function");
  assert.equal(validateRuntimeIsolation.constructor.name, "Function");
});

// =========================================================================
// K. Runtime rejection resets state — can start again in same process
// =========================================================================
test("K: guard rejection does not permanently poison the validator", () => {
  // First call: reject
  const r1 = validateRuntimeIsolation(happyParams({ libraryDir: PROD_LIB }));
  assert.equal(r1.ok, false);
  // Second call with same params: still reject (no side effects)
  const r2 = validateRuntimeIsolation(happyParams({ libraryDir: PROD_LIB }));
  assert.equal(r2.ok, false);
  // Third call with valid params: allow
  const r3 = validateRuntimeIsolation(happyParams());
  assert.equal(r3.ok, true);
});

// =========================================================================
// L. service-manager QA scenario: not rejected by secondary guard
// =========================================================================
test("L: QA mode with all params passes for service-manager scenario", () => {
  // Simulates desktop/main.mjs passing params to service-manager -> startMosaRuntime
  const result = validateRuntimeIsolation({
    libraryDir: join(tmpdir(), "mosa-lib-qa"),
    port: 44444,
    runtimeMode: "qa",
    qaRun: "1",
    userData: join(tmpdir(), "mosa-ud-qa"),
    actualUserData: join(tmpdir(), "mosa-ud-qa"),
    argv: ["node", "electron", "desktop/main.mjs"],
    productionLibraryDir: PROD_LIB,
    productionPorts: PROD_PORTS,
    defaultUserData: PROD_USERDATA,
  });
  assert.equal(result.ok, true);
});

// =========================================================================
// M. hasQaMode=true override
// =========================================================================
test("M: hasQaMode=true forces QA mode even without other signals", () => {
  const result = validateRuntimeIsolation({
    libraryDir: undefined,
    port: 43517,
    runtimeMode: undefined,
    qaRun: undefined,
    argv: ["node", "server.mjs"],
    hasQaMode: true,
    productionLibraryDir: PROD_LIB,
    productionPorts: PROD_PORTS,
    defaultUserData: PROD_USERDATA,
  });
  assert.equal(result.ok, false);
  assert.equal(result.field, "libraryDir");
});

// =========================================================================
// N. qaRun parameter triggers QA mode
// =========================================================================
test("N: qaRun trigger QA mode without runtimeMode", () => {
  const result = validateRuntimeIsolation({
    libraryDir: undefined,
    port: 43517,
    runtimeMode: undefined,
    qaRun: "1",
    argv: ["node", "server.mjs"],
    productionLibraryDir: PROD_LIB,
    productionPorts: PROD_PORTS,
    defaultUserData: PROD_USERDATA,
  });
  assert.equal(result.ok, false);
  assert.equal(result.field, "libraryDir");
});
