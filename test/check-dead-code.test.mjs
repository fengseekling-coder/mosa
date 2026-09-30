import test from "node:test";
import assert from "node:assert/strict";

import { analyzeDeadCode, extractExports, extractCssClasses } from "../scripts/check-dead-code.mjs";

function analyze(files) {
  return analyzeDeadCode({ files: new Map(Object.entries(files)) });
}

test("flags an exported symbol with no consumer anywhere", () => {
  const result = analyze({
    "lib/orphan.ts": "export function orphan() { return 2; }\n",
    "lib/other.ts": "import { alive } from './alive.js';\nconsole.log(alive);\n",
  });
  assert.deepEqual(result.deadExports, [{ file: "lib/orphan.ts", name: "orphan" }]);
});

test("keeps exports consumed by another file", () => {
  const result = analyze({
    "lib/alive.ts": "export function alive() { return 1; }\n",
    "lib/other.ts": "import { alive } from './alive.js';\nconsole.log(alive);\n",
  });
  assert.equal(result.deadExports.length, 0);
});

test("keeps exports used only inside their defining file", () => {
  const result = analyze({
    "lib/internal.ts": "export function helper() { return 1; }\nconst value = helper();\n",
    "lib/other.ts": "const other = 1;\n",
  });
  assert.equal(result.deadExports.length, 0);
});

test("skips very short export names", () => {
  const result = analyze({
    "lib/short.ts": "export const ab = 1;\n",
    "lib/other.ts": "const other = 1;\n",
  });
  assert.equal(result.deadExports.length, 0);
});

test("checks renamed list exports by their exported name", () => {
  const result = analyze({
    "lib/listed.ts": "const internal = 1;\nexport { internal as gamma };\n",
    "lib/other.ts": "const other = 1;\n",
  });
  assert.deepEqual(result.deadExports, [{ file: "lib/listed.ts", name: "gamma" }]);
});

test("flags a module no other file references", () => {
  const result = analyze({
    "lib/orphan-mod.mjs": "export const q = 1;\n",
    "lib/main.mjs": "import { r } from './real.js';\nconsole.log(r);\n",
    "docs/entry.md": "The service starts from lib/main.mjs.\n",
  });
  assert.deepEqual(result.deadFiles, ["lib/orphan-mod.mjs"]);
});

test("keeps a module referenced by file name elsewhere", () => {
  const result = analyze({
    "lib/orphan-mod.mjs": "export const q = 1;\n",
    "lib/main.mjs": "import { q } from './orphan-mod.js';\nconsole.log(q);\n",
    "docs/entry.md": "The service starts from lib/main.mjs.\n",
  });
  assert.equal(result.deadFiles.length, 0);
});

test("ignores files outside the source directories", () => {
  const result = analyze({
    "vendor/orphan-mod.mjs": "export const q = 1;\n",
    "lib/main.mjs": "const r = 1;\n",
    "docs/entry.md": "The service starts from lib/main.mjs.\n",
  });
  assert.equal(result.deadFiles.length, 0);
});

test("flags a CSS class no tracked markup or script emits", () => {
  const result = analyze({
    "web/app/styles.css": ".dead-thing { color: red; }\n.live-thing { color: blue; }\n",
    "web/app/app.mjs": "el.classList.add('live-thing');\n",
  });
  assert.deepEqual(result.deadCssClasses, [{ file: "web/app/styles.css", name: "dead-thing" }]);
});

test("keeps classes built by dynamic suffix interpolation", () => {
  const result = analyze({
    "web/app/styles.css": ".depth-0 { color: red; }\n.depth-1 { color: blue; }\n",
    "web/app/app.mjs": "return `<span class=\"depth-${index}\"></span>`;\n",
  });
  assert.equal(result.deadCssClasses.length, 0);
});

test("does not let unrelated template interpolation rescue a class prefix", () => {
  const result = analyze({
    "web/app/styles.css": ".mosa-thing { color: red; }\n",
    "lib/worker.mjs": "const channel = `mosa-${Date.now().toString(36)}`;\n",
  });
  assert.deepEqual(result.deadCssClasses, [{ file: "web/app/styles.css", name: "mosa-thing" }]);
});

test("flags classes built through an intermediate variable for exception listing", () => {
  const result = analyze({
    "web/app/styles.css": ".lineage-depth-0 { color: red; }\n",
    "web/app/app.mjs": "const depthClass = `lineage-depth-${Math.min(depth, 6)}`;\nreturn `<li class=\"node ${depthClass}\"></li>`;\n",
  });
  assert.deepEqual(result.deadCssClasses, [{ file: "web/app/styles.css", name: "lineage-depth-0" }]);
});

test("does not extract class names from CSS comments", () => {
  const css = "/* .ghost-note refers to the retired card */\n.real { color: red; }\n";
  assert.deepEqual([...extractCssClasses(css)], ["real"]);
});

test("extractExports strips export statements from own-file usage detection", () => {
  const { names, strippedSource } = extractExports("export const alpha = beta;\nconst gamma = alpha;\n");
  assert.deepEqual(names, ["alpha"]);
  assert.match(strippedSource, /const gamma = alpha;/);
  assert.doesNotMatch(strippedSource, /export/);
});

test("a UI export kept alive only by its twin tree is dead", () => {
  const result = analyze({
    "web/app/pair.mjs": "export function pairOnly() { return 1; }\n",
    "desktop/app/pair.mjs": "export function pairOnly() { return 1; }\n",
  });
  assert.deepEqual(result.deadExports, [
    { file: "web/app/pair.mjs", name: "pairOnly" },
    { file: "desktop/app/pair.mjs", name: "pairOnly" },
  ]);
});

test("a UI export consumed outside the UI trees stays alive", () => {
  const result = analyze({
    "web/app/shared.mjs": "export function sharedThing() { return 1; }\n",
    "desktop/app/shared.mjs": "export function sharedThing() { return 1; }\n",
    "test/shared.test.mjs": "import { sharedThing } from '../web/app/shared.mjs';\nsharedThing();\n",
  });
  assert.equal(result.deadExports.length, 0);
});

test("a UI module referenced only by its twin is dead", () => {
  const result = analyze({
    "web/app/index.html": '<script type="module" src="/app.mjs"></script>\n',
    "web/app/app.mjs": "const start = 1;\n",
    "web/app/lonely.mjs": "export const lonelyValue = 1;\n",
    "desktop/app/index.html": '<script type="module" src="/app.mjs"></script>\n',
    "desktop/app/app.mjs": "import { lonelyValue } from './lonely.mjs';\nconsole.log(lonelyValue);\n",
    "desktop/app/lonely.mjs": "export const lonelyValue = 1;\n",
  });
  assert.deepEqual(result.deadFiles, ["web/app/lonely.mjs"]);
});

test("scans every stylesheet in the UI trees, not just styles.css", () => {
  const result = analyze({
    "web/app/styles.css": ".alive { color: red; }\n",
    "web/app/extra.css": ".extra-dead { color: blue; }\n",
    "web/app/app.mjs": "el.classList.add('alive');\n",
  });
  assert.deepEqual(result.deadCssClasses, [{ file: "web/app/extra.css", name: "extra-dead" }]);
});

test("treats pluggable e2e flows as entry points but still checks their helpers", () => {
  const result = analyze({
    "scripts/e2e-flows/some-flow.mjs": "export const name = 'some-flow';\nexport async function run() {}\n",
    "scripts/e2e-flows/_unused-helper.mjs": "export const HELPER = 1;\n",
    "scripts/e2e-critical-flows.mjs": "const flows = await readdir(flowsDir);\n",
    "package.json": "{ \"scripts\": { \"test:e2e\": \"node scripts/e2e-critical-flows.mjs\" } }\n",
  });
  assert.deepEqual(result.deadFiles, ["scripts/e2e-flows/_unused-helper.mjs"],
    "flows are discovered by readdir(); only unreferenced helpers are dead");
});
