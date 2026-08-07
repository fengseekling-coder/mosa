import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { DISABLEABLE_BRIDGES } from "../lib/runtime-bridges.mjs";

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);

function runtimeOptions(root) {
  const libraryDir = join(root, "library");
  return {
    projectRoot: root,
    managerDir: repositoryRoot,
    cowartProjectDir: join(root, "desktop-data"),
    appDir: join(repositoryRoot, "app"),
    assetsRoot: join(libraryDir, "assets"),
    generatedImagesDir: join(root, "generated-images"),
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "codex-sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-canvas"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
    cowartMcpServerPath: join(root, "missing-cowart-mcp-server.mjs"),
  };
}

// ---------------------------------------------------------------------------
// Test 1: /api/health returns all required fields
// ---------------------------------------------------------------------------
describe("diagnostics: health API fields", () => {
  it("returns productVersion, gitSha, uiFingerprint, libraryDir, and storage", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "mosa-diag-health-"));
    t.after(() => rm(root, { recursive: true, force: true }));

    const libraryDir = join(root, "library");
    const runtime = await startMosaRuntime({
      ...runtimeOptions(root),
      port: 0,
      libraryDir,
      disabledBridges: [...DISABLEABLE_BRIDGES],
    });
    t.after(() => runtime.stop());

    const res = await fetch(`${runtime.url}/api/health`);
    assert.equal(res.status, 200);

    const body = await res.json();
    for (const key of ["productVersion", "gitSha", "uiFingerprint", "libraryDir", "storage"]) {
      assert.ok(key in body, `/api/health should contain field "${key}"`);
      assert.equal(typeof body[key], "string", `"${key}" should be a string`);
    }
    assert.equal(body.libraryDir, libraryDir, "libraryDir should match the temp library dir");
  });
});

// ---------------------------------------------------------------------------
// Test 2: app.js source contains the diagnostics entry point
// ---------------------------------------------------------------------------
describe("diagnostics: app.js contains diagnostics entry", () => {
  let appSource;

  it("includes toggle-diagnostics data-action, fetchDiagnostics, diagnosticsPanel, and settings section", async () => {
    appSource = await readFile(join(repositoryRoot, "app/app.js"), "utf8");

    assert.match(appSource, /data-action="toggle-diagnostics"/,
      "app.js should contain toggle-diagnostics data-action");
    assert.match(appSource, /async function fetchDiagnostics\(\)/,
      "app.js should define fetchDiagnostics function");
    assert.match(appSource, /id="diagnosticsPanel"/,
      "app.js should reference diagnosticsPanel element ID");
    assert.match(appSource, /id="diagnosticsContent"/,
      "app.js should reference diagnosticsContent element ID");
    // Verify renderSettingsMenu includes the diagnostics section HTML
    assert.match(appSource, /settings-diagnostics-toggle/,
      "renderSettingsMenu should include the diagnostics toggle CSS class");
    assert.match(appSource, /diagnosticsSectionHtml/,
      "renderSettingsMenu should compose a diagnosticsSectionHtml variable");
  });
});

// ---------------------------------------------------------------------------
// Test 3: event delegation handles diagnostics toggle
// ---------------------------------------------------------------------------
describe("diagnostics: event delegation pattern", () => {
  let appSource;

  it("handles diagnostics, theme, and density settings through menu delegation", async () => {
    appSource = await readFile(join(repositoryRoot, "app/app.js"), "utf8");

    // toggle-diagnostics is handled via closest() inside the settingsMenu click handler
    assert.match(appSource, /closest\("\[data-action='toggle-diagnostics'\]"\)/,
      "toggle-diagnostics should be handled via event.target.closest()");

    assert.match(appSource, /dataset\.appearanceOpt/,
      "theme segmented controls should be handled via event delegation");
    assert.match(appSource, /dataset\.densityOpt/,
      "density segmented controls should be handled via event delegation");
    assert.doesNotMatch(appSource, /#darkModeToggle/,
      "the removed standalone dark-mode toggle must not remain as dead code");

    // fetchDiagnostics is called after toggle
    assert.match(appSource, /fetchDiagnostics\(\)/,
      "fetchDiagnostics() should be invoked after expanding diagnostics");
  });
});

// ---------------------------------------------------------------------------
// Test 4: DOM consistency between index.html and app.js
// ---------------------------------------------------------------------------
describe("diagnostics: DOM consistency", () => {
  let htmlSource, appSource;

  it("settingsMenu exists in index.html; diagnosticsPanel is dynamically created in app.js", async () => {
    [htmlSource, appSource] = await Promise.all([
      readFile(join(repositoryRoot, "app/index.html"), "utf8"),
      readFile(join(repositoryRoot, "app/app.js"), "utf8"),
    ]);

    // settingsMenu is a static element in index.html
    assert.match(htmlSource, /id="settingsMenu"/,
      "index.html should contain #settingsMenu element");

    // settingsToggle exists in index.html
    assert.match(htmlSource, /id="settingsToggle"/,
      "index.html should contain #settingsToggle element");

    // diagnosticsPanel is NOT statically in index.html — it's created dynamically
    assert.doesNotMatch(htmlSource, /id="diagnosticsPanel"/,
      "diagnosticsPanel should NOT exist statically in index.html");

    // diagnosticsPanel IS created dynamically inside renderSettingsMenu in app.js
    assert.match(appSource, /id="diagnosticsPanel"/,
      "diagnosticsPanel should be dynamically created in app.js renderSettingsMenu");

    // diagnosticsContent is also dynamic
    assert.doesNotMatch(htmlSource, /id="diagnosticsContent"/,
      "diagnosticsContent should NOT exist statically in index.html");
    assert.match(appSource, /id="diagnosticsContent"/,
      "diagnosticsContent should be dynamically created in app.js");
  });
});
