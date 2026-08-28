import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("Windows QA teardown targets the full process tree", async () => {
  const source = await readFile(resolve(import.meta.dirname, "..", "scripts", "process-tree.mjs"), "utf8");
  assert.match(source, /platform !== "win32"/);
  assert.match(source, /spawn\("taskkill", args/);
  assert.match(source, /\["\/PID", String\(pid\), "\/T"\]/, "Windows cleanup must include child processes");
  assert.match(source, /if \(force\) args\.push\("\/F"\)/, "hard-stop cleanup must force-terminate the process tree");
});
