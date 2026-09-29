import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ignored = new Set([".git", "node_modules", "coverage", "out", "assets", "production", "canvas", "outputs"]);

// The whole-repo sweep runs only when invoked as a CLI; importing the module
// (e.g. from a test) must not trigger it.
const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath && import.meta.url === invokedPath) {
  await main();
}

async function main() {
  const trackedIgnored = await gitLines(["ls-files", "-ci", "--exclude-standard"]);
  if (trackedIgnored.length > 0) {
    throw new Error(`Tracked files match .gitignore and must be removed from Git tracking:\n${trackedIgnored.join("\n")}`);
  }

  const files = await collectJavaScript(root);

  for (const file of files) await check(file);
  console.log(`Syntax checked ${files.length} JavaScript files.`);
}

async function collectJavaScript(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignored.has(entry.name)) files.push(...await collectJavaScript(path));
    } else if (entry.isFile() && /\.(?:mjs|cjs|js)$/.test(entry.name)) files.push(path);
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

function gitLines(args) {
  return new Promise((resolveLines, rejectLines) => {
    const child = spawn("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectLines);
    child.once("exit", (code) => {
      if (code !== 0) {
        rejectLines(new Error(`git ${args.join(" ")} failed: ${stderr.trim() || `exit ${code}`}`));
        return;
      }
      resolveLines(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    });
  });
}
