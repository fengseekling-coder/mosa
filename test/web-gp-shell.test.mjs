// GravityPort A1 外壳契约：侧栏/检视器宽度 token、检视器圆角卡片、
// Lexend Deca 本地字体（@font-face + 磁盘文件 + 静态服务的 MIME）。
// 只读 web/app/styles.css、web/app/fonts/，并通过本地运行时验证字体响应头。
import assert from "node:assert/strict";
import { access, readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { DISABLEABLE_BRIDGES } from "../lib/runtime-bridges.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const readWebCss = () => readFile(resolve(repositoryRoot, "web/app/styles.css"), "utf8");

test("GravityPort shell width tokens land in web styles", async () => {
  const css = await readWebCss();
  assert.match(css, /--sidebar-width: 220px;/, "--sidebar-width must be the spec-table v1 220px (was GravityPort 280px)");
  assert.match(css, /--sidebar-width-narrow: 200px;/, "--sidebar-width-narrow must be the spec-table v1 200px (was GravityPort 240px)");
  assert.match(css, /--inspector-width: 280px;/, "--inspector-width must be the spec-table v1 280px (was GravityPort 320px)");
  assert.match(css, /--inspector-width-compact: 280px;/, "--inspector-width-compact must be the spec-table v1 280px (was GravityPort 320px)");
  // 旧宽度不允许再出现在任何 token 赋值里。
  assert.doesNotMatch(css, /--sidebar-width:\s*216px|--sidebar-width-narrow:\s*208px|--inspector-width:\s*344px|--inspector-width-compact:\s*340px;/);
});

test("GravityPort inspector shell card: radius token consumed by .mosa-v2 .detail", async () => {
  const css = await readWebCss();
  // （旧 --radius-shell-card=32px 已并入 --radius-lg，任务 107）解析 :root 实际值，
  // 守卫语义保留：检视器卡片圆角走统一 lg 档（12px），不许被悄悄改动。
  assert.equal([...css.matchAll(/--radius-lg\s*:\s*(\d+)px\s*;/g)][0]?.[1], "12", "--radius-lg (merged --radius-shell-card) must be 12px");
  // 检视器卡片：圆角由 .detail 自身的 overflow:hidden 裁住内容。
  // 卡片规则刻意放在 max-width:767px 媒体查询之前——≤767px 浮层卡规格
  // （同特异性、靠后生效）继续赢，窄档行为不变。
  assert.match(css, /\.mosa-v2 \.detail \{ border-radius: var\(--radius-lg\); \}/, "the inspector card must consume --radius-lg");
  assert.ok(
    css.indexOf(".mosa-v2 .detail { border-radius: var(--radius-lg); }")
    < css.indexOf("@media (max-width: 767px)"),
    "the card rule must precede the ≤767px media query so the floating-card overrides keep winning there",
  );
  assert.match(css, /\.mosa-v2 \.detail \{ overflow: hidden; \}/, "card content must clip inside the radius");
  assert.match(css, /\.mosa-v2 \.detail \{ top: 12px; right: 12px; bottom: 12px; width: min\(360px, calc\(100vw - 24px\)\); border-radius: var\(--radius-lg\); \}/, "the ≤767px floating card uses the same merged --radius-lg");
});

test("GravityPort shell drops the sidebar and inspector separator lines", async () => {
  const css = await readWebCss();
  // 侧栏右边线：基础与 .mosa-v2 规则都不得再声明 border-right。
  assert.doesNotMatch(css, /^\.sidebar \{[^}]*border-right/m, "the base sidebar must not draw a right border");
  assert.doesNotMatch(css, /^\.mosa-v2 \.sidebar \{[^}]*border-right/m, "the v2 sidebar must not draw a right border");
  assert.doesNotMatch(css, /:root\[data-theme="light"\] \.mosa-v2 \.sidebar \{[^}]*border-right/, "light theme must not restore the sidebar border");
  // 检视器左边线：.detail 全部作用域不得再声明 border-left。
  assert.doesNotMatch(css, /^\.detail \{[^}]*border-left/m, "the base detail must not draw a left border");
  assert.doesNotMatch(css, /^\.mosa-v2 \.detail \{[^}]*border-left/m, "the v2 detail must not draw a left border");
  assert.doesNotMatch(css, /:root\[data-theme="dark"\] \.mosa-v2 \.detail \{[^}]*border-left/, "dark theme must not restore the detail border");
  assert.doesNotMatch(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail \{[^}]*border-left/, "light theme must not restore the detail border");
});

test("Lexend Deca @font-face points at packaged woff2 files on disk", async () => {
  const css = await readWebCss();
  const faces = [...css.matchAll(/@font-face \{[^}]*\}/g)].map((m) => m[0]);
  const lexFaces = faces.filter((face) => face.includes('font-family: "Lexend Deca"'));
  assert.equal(lexFaces.length, 2, "exactly two Lexend Deca @font-face blocks (latin + latin-ext) are expected");
  for (const face of lexFaces) {
    assert.match(face, /font-weight: 100 900;/, "the variable weight axis must stay 100–900");
    assert.match(face, /font-display: swap;/, "font-display: swap is required");
  }
  const latinFace = lexFaces.find((face) => face.includes("lexend-deca-latin-wght-normal.woff2"));
  const latinExtFace = lexFaces.find((face) => face.includes("lexend-deca-latin-ext-wght-normal.woff2"));
  assert.ok(latinFace, "the latin subset @font-face must be declared");
  assert.ok(latinExtFace, "the latin-ext subset @font-face must be declared");
  assert.match(latinFace, /unicode-range: U\+0000-00FF,/, "latin unicode-range must come from the fontsource subset CSS");
  assert.match(latinExtFace, /unicode-range: U\+0100-02BA,/, "latin-ext unicode-range must come from the fontsource subset CSS");
  // 指向的文件必须真实打包进应用（离线可用），许可证随附。
  const fontsDir = resolve(repositoryRoot, "web/app/fonts");
  for (const file of ["lexend-deca-latin-wght-normal.woff2", "lexend-deca-latin-ext-wght-normal.woff2", "OFL.txt"]) {
    await assert.doesNotReject(access(join(fontsDir, file)), `${file} must exist in web/app/fonts/`);
  }
});

test("--font-family-ui leads with Lexend Deca; mono stays untouched", async () => {
  const css = await readWebCss();
  assert.match(
    css,
    /--font-family-ui: "Lexend Deca", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;/,
    "--font-family-ui must lead with Lexend Deca and keep the CJK system fallbacks",
  );
  assert.match(css, /--font-family-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, Consolas, monospace;/);
});

test("the local runtime serves packaged fonts with font/woff2", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-gp-shell-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const isolatedLibraryDir = join(root, "isolated-test-library");

  const runtime = await startMosaRuntime({
    projectRoot: root,
    managerDir: repositoryRoot,
    cowartProjectDir: join(root, "desktop-data"),
    appDir: join(repositoryRoot, "web", "app"),
    assetsRoot: join(isolatedLibraryDir, "assets"),
    generatedImagesDir: join(root, "generated-images"),
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "codex-sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-canvas"),
    port: 0,
    disabledBridges: [...DISABLEABLE_BRIDGES],
    libraryDir: isolatedLibraryDir,
  });
  t.after(() => runtime.stop());

  await t.test("GET /fonts/*.woff2 returns 200 font/woff2", async () => {
    for (const file of ["lexend-deca-latin-wght-normal.woff2", "lexend-deca-latin-ext-wght-normal.woff2"]) {
      const res = await fetch(`${runtime.url}/fonts/${file}`);
      assert.equal(res.status, 200, `${file} must be served`);
      assert.equal(res.headers.get("content-type"), "font/woff2", `${file} must have the font/woff2 content type`);
      assert.ok((await res.arrayBuffer()).byteLength > 0, `${file} must not be empty`);
    }
  });

  await t.test("a missing font file still 404s as itself instead of falling back to HTML", async () => {
    const res = await fetch(`${runtime.url}/fonts/lexend-deca-missing-wght-normal.woff2`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  });

  await t.test("only allowlisted subdirectories are served; other nested paths 404", async () => {
    const nested = await fetch(`${runtime.url}/not-a-static-dir/styles.css`);
    assert.equal(nested.status, 404);
    const deep = await fetch(`${runtime.url}/fonts/nested/OFL.txt`);
    assert.equal(deep.status, 404);
    const topLevel = await fetch(`${runtime.url}/styles.css`);
    assert.equal(topLevel.status, 200);
  });
});
