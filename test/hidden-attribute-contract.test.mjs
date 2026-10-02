import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

/**
 * A class rule that sets `display` outranks the user-agent `[hidden]` rule, so an
 * element toggled through the `hidden` attribute keeps rendering unless the rule
 * is restated for `[hidden]`. This has shipped twice — an always-on filter badge
 * and an empty active-filter bar — so the pairing is asserted rather than
 * remembered.
 *
 * 界面合一后只剩 web 一棵树：用它的 index.html 静态壳和 app.mjs 动态渲染出的
 * 标记，对照同一棵树的 styles.css 检查。
 */
test("every hidden-toggled element with a display rule restates it for [hidden]", async () => {
  const offenders = [];
  for (const tree of ["web/app"]) {
    const [html, app, css] = await Promise.all([
      readFile(resolve(root, tree, "index.html"), "utf8"),
      readFile(resolve(root, tree, "app.mjs"), "utf8"),
      readFile(resolve(root, tree, "styles.css"), "utf8"),
    ]);

    // Classes on elements that carry the boolean `hidden` attribute, in both the
    // static shell and the dynamically rendered markup. The lookbehind on
    // whitespace keeps `aria-hidden` from matching.
    const hiddenClasses = new Set();
    for (const source of [html, app]) {
      for (const tag of source.matchAll(/<[a-z]+\b[^>]*\shidden(?=[\s>])[^>]*>/gi)) {
        const classAttr = /\bclass="([^"]*)"/.exec(tag[0]);
        if (!classAttr) continue;
        for (const name of classAttr[1].split(/\s+/).filter(Boolean)) hiddenClasses.add(name);
      }
    }
    assert.ok(hiddenClasses.size > 0, `expected to find hidden-toggled elements to check in ${tree}`);

    for (const className of hiddenClasses) {
      // Does any plain `.class { ... display: ... }` rule exist for it?
      const rule = new RegExp(`(^|[\\s,])\\.${className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "gm");
      let setsDisplay = false;
      for (const match of css.matchAll(rule)) {
        if (/(^|;)\s*display\s*:/.test(match[2])) { setsDisplay = true; break; }
      }
      if (!setsDisplay) continue;
      const guard = new RegExp(`\\.${className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\[hidden\\]\\s*\\{[^}]*display:\\s*none`);
      if (!guard.test(css)) offenders.push(`${tree}: ${className}`);
    }
  }

  assert.deepEqual(offenders, [], `these classes set display but never restate it for [hidden]: ${offenders.join(", ")}`);
});
