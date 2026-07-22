#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { createDerivativeWorker } from "../lib/derivative-worker.mjs";
import { migrateLegacyLibrary, verifySqliteLibrary } from "../lib/library-migration.mjs";

const managerDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectRoot = resolve(process.env.MOSA_PROJECT_DIR || dirname(managerDir));
const args = process.argv.slice(2);
const command = args.shift();

if (!command || command === "--help" || command === "help") {
  printHelp();
  process.exitCode = command ? 0 : 1;
} else if (command === "migrate") {
  await runMigrate(args);
} else if (command === "verify") {
  await runVerify(args);
} else if (command === "thumbnails") {
  await runThumbnails(args);
} else {
  console.error(`Unknown MOSA command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

async function runMigrate(values) {
  const options = parseOptions(values);
  const report = await migrateLegacyLibrary({
    managerDir,
    projectRoot,
    libraryDir: options.library,
    legacyAssetsRoot: options.from,
    dryRun: options.dryRun,
    resume: options.resume,
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.issues.length || (!options.dryRun && !report.completed)) process.exitCode = 1;
}

async function runVerify(values) {
  const options = parseOptions(values);
  const report = await verifySqliteLibrary({ managerDir, projectRoot, libraryDir: options.library });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok || report.migration?.migration_state !== "completed") process.exitCode = 1;
}

async function runThumbnails(values) {
  const action = values.shift();
  if (!new Set(["rebuild", "repair"]).has(action)) {
    console.error("Usage: mosa thumbnails <rebuild|repair> [--library <path>]");
    process.exitCode = 1;
    return;
  }
  const options = parseOptions(values);
  const store = createSqliteAssetStore({ managerDir, projectRoot, libraryDir: options.library, storage: "sqlite" });
  try {
    const migration = await store.migrationStatus();
    if (migration.migration_state !== "completed") throw new Error("Run `mosa migrate` successfully before rebuilding derivatives.");
    const queued = await store.enqueueMissingDerivatives();
    const worker = createDerivativeWorker({ store });
    worker.start();
    while (true) {
      const status = await store.derivativeStatus();
      if (!status.pending && !status.running) {
        console.log(JSON.stringify({ queued, status }, null, 2));
        process.exitCode = status.failed ? 1 : 0;
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    worker.stop();
  } finally {
    store.close();
  }
}

function parseOptions(values) {
  const options = {
    library: resolve(process.env.MOSA_LIBRARY_DIR || join(homedir(), "MOSA Library")),
    from: join(managerDir, "assets"),
    dryRun: false,
    resume: false,
  };
  while (values.length) {
    const value = values.shift();
    if (value === "--library") options.library = resolve(requiredValue(value, values.shift()));
    else if (value === "--from") options.from = resolve(requiredValue(value, values.shift()));
    else if (value === "--dry-run") options.dryRun = true;
    else if (value === "--resume") options.resume = true;
    else throw new Error(`Unknown option: ${value}`);
  }
  return options;
}

function requiredValue(flag, value) {
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a path.`);
  return value;
}

function printHelp() {
  console.log(`MOSA local library commands

  mosa migrate [--library <path>] [--from <legacy-assets>] [--dry-run] [--resume]
  mosa verify [--library <path>]
  mosa thumbnails <rebuild|repair> [--library <path>]
`);
}
