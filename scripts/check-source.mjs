import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ignored = new Set([".git", "node_modules", "assets", "production", "canvas", "outputs"]);
const files = await collectJavaScript(root);

for (const file of files) await check(file);
console.log(`Syntax checked ${files.length} JavaScript files.`);

async function collectJavaScript(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignored.has(entry.name)) files.push(...await collectJavaScript(path));
    } else if (entry.isFile() && /\.(?:mjs|js)$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

function check(file) {
  return new Promise((resolveCheck, rejectCheck) => {
    const child = spawn(process.execPath, ["--check", file], { stdio: "inherit" });
    child.once("error", rejectCheck);
    child.once("exit", (code) => code === 0 ? resolveCheck() : rejectCheck(new Error(`Syntax check failed: ${file}`)));
  });
}
