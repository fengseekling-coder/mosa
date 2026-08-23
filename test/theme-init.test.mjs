import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);

function runtimeOptions(root) {
  const libraryDir = join(root, "library");
  return {
    port: 0,
    projectRoot: root,
    managerDir: repositoryRoot,
    cowartProjectDir: join(root, "desktop-data"),
    appDir: join(repositoryRoot, "app"),
    libraryDir,
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

/**
 * Run theme-init.mjs against mocked browser globals (no DOM needed) and return
 * the data-theme value the script would apply. Mirrors app.js which reads the
 * same `mosa-dark-mode` key and compares against the string "true".
 */
function runThemeScript(localStorageMock, electronAPI = undefined) {
  const documentMock = { documentElement: { dataset: {}, classList: { added: [], add(value) { this.added.push(value); } } } };
  // new Function lets us inject browser globals without requiring a real renderer.
  const fn = new Function("localStorage", "document", "window", themeScriptSource);
  fn(localStorageMock, documentMock, { electronAPI });
  return {
    theme: documentMock.documentElement.dataset.theme,
    classes: documentMock.documentElement.classList.added,
  };
}

function makeStore(storedValue) {
  const map = new Map();
  if (storedValue !== undefined) map.set("mosa-dark-mode", storedValue);
  return { getItem: (key) => (map.has(key) ? map.get(key) : null) };
}

let themeScriptSource;

test("theme-init.mjs loads before the stylesheet in index.html", async () => {
  themeScriptSource = await readFile(join(repositoryRoot, "app", "theme-init.mjs"), "utf8");
  const indexHtml = await readFile(join(repositoryRoot, "app", "index.html"), "utf8");

  const scriptTag = '<script src="/theme-init.mjs"></script>';
  const scriptIdx = indexHtml.indexOf(scriptTag);
  const cssIdx = indexHtml.indexOf('<link rel="stylesheet"');
  assert.ok(scriptIdx > -1, "index.html must reference /theme-init.mjs");
  assert.ok(cssIdx > -1, "index.html must reference the stylesheet");
  assert.ok(
    scriptIdx < cssIdx,
    "theme-init.mjs must execute before the stylesheet to avoid FOUC",
  );
  // No inline theme script — the runtime CSP is script-src 'self'.
  assert.doesNotMatch(indexHtml, /<script>[^<]*document\.documentElement/);
});

test("theme-init applies dark only for the stored string 'true'", () => {
  assert.equal(runThemeScript(makeStore("true")).theme, "dark", '"true" -> dark');
  assert.equal(runThemeScript(makeStore("false")).theme, "light", '"false" -> light');
  assert.equal(runThemeScript(makeStore(null)).theme, "light", "null -> light");
  assert.equal(runThemeScript(makeStore(undefined)).theme, "light", "absent -> light");
  assert.equal(runThemeScript(makeStore("1")).theme, "light", "unexpected value -> light");
});

test("theme-init marks only Electron renderers for desktop-only brand safe area", () => {
  assert.deepEqual(runThemeScript(makeStore(undefined)).classes, [], "web has no desktop class");
  assert.deepEqual(runThemeScript(makeStore(undefined), {}).classes, ["electron-shell"], "Electron gets desktop class");
});

test("theme-init falls back to light when localStorage is unavailable", () => {
  const throwingStore = { getItem: () => { throw new Error("localStorage denied"); } };
  assert.equal(runThemeScript(throwingStore).theme, "light", "read failure -> light fallback");
});

test("brand safe-area offset remains desktop-only", async () => {
  const css = await readFile(join(repositoryRoot, "app", "styles.css"), "utf8");
  assert.match(css, /\.mosa-v2 \.brand-info h1 \{ color: var\(--color-text-primary\);/);
  assert.match(css, /html\.electron-shell body\.mosa-v2 \.brand-info h1 \{ margin-left: 76px; \}/);
  assert.doesNotMatch(css, /(?:^|\n)\.mosa-v2 \.brand-info h1 \{[^}]*margin-left/);
});

test("the runtime serves /theme-init.mjs same-origin for CSP compliance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-theme-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await startMosaRuntime(runtimeOptions(root));
  t.after(() => runtime.stop());

  const response = await fetch(`${runtime.url}/theme-init.mjs`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(await response.text(), themeScriptSource);

  // index.html served from the same origin references the script with a same-origin URL.
  const html = await (await fetch(`${runtime.url}/`)).text();
  assert.match(html, /<script src="\/theme-init\.mjs"><\/script>/);
});
