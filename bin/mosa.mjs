#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { createDerivativeWorker } from "../lib/derivative-worker.js";
import { migrateLegacyLibrary, verifySqliteLibrary } from "../lib/library-migration.js";
import { createLibraryBackup, restoreLibraryBackup, verifyLibraryBackup } from "../lib/library-backup.js";
import { verifyVisualModelPack } from "../lib/visual-model-pack.mjs";

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
} else if (command === "backup") {
  await runBackup(args);
} else if (command === "backup-verify") {
  await runBackupVerify(args);
} else if (command === "restore") {
  await runRestore(args);
} else if (command === "visual-model-verify") {
  await runVisualModelVerify(args);
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

async function runBackup(values) {
  const options = parseOptions(values);
  if (!options.to) throw new Error("backup requires --to <backup-dir>.");
  const report = await createLibraryBackup({
    managerDir,
    projectRoot,
    libraryDir: options.library,
    destinationDir: options.to,
  });
  console.log(JSON.stringify(report, null, 2));
}

async function runBackupVerify(values) {
  const options = parseOptions(values);
  if (!options.explicitFrom) throw new Error("backup-verify requires --from <backup-dir>.");
  const report = await verifyLibraryBackup({ managerDir, projectRoot, backupDir: options.from });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

async function runRestore(values) {
  const options = parseOptions(values);
  if (!options.explicitFrom) throw new Error("restore requires --from <backup-dir>.");
  if (!options.to) throw new Error("restore requires --to <empty-library-dir>.");
  const report = await restoreLibraryBackup({
    managerDir,
    projectRoot,
    backupDir: options.from,
    destinationDir: options.to,
  });
  console.log(JSON.stringify(report, null, 2));
}

async function runVisualModelVerify(values) {
  const options = parseOptions(values);
  if (!options.explicitFrom) throw new Error("visual-model-verify requires --from <model-pack-dir>.");
  const report = await verifyVisualModelPack({ packDir: options.from });
  console.log(JSON.stringify(report, null, 2));
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
    try {
      const idleTimeoutMs = 5 * 60 * 1000;
      let lastProgressAt = Date.now();
      let lastSignature = "";
      while (true) {
        const status = await store.derivativeStatus();
        if (!status.pending && !status.running) {
          console.log(JSON.stringify({ queued, status }, null, 2));
          process.exitCode = status.failed ? 1 : 0;
          break;
        }
        const signature = JSON.stringify(status);
        if (signature !== lastSignature) {
          lastSignature = signature;
          lastProgressAt = Date.now();
        } else if (Date.now() - lastProgressAt >= idleTimeoutMs) {
          throw new Error("Thumbnail processing made no progress for 5 minutes; aborting instead of waiting forever.");
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
    } finally {
      worker.stop();
    }
  } finally {
    store.close();
  }
}

function parseOptions(values) {
  const options = {
    library: resolve(process.env.MOSA_LIBRARY_DIR || join(homedir(), "MOSA Library")),
    from: join(managerDir, "assets"),
    explicitFrom: false,
    to: "",
    dryRun: false,
    resume: false,
  };
  while (values.length) {
    const value = values.shift();
    if (value === "--library") options.library = resolve(requiredValue(value, values.shift()));
    else if (value === "--from") {
      options.from = resolve(requiredValue(value, values.shift()));
      options.explicitFrom = true;
    }
    else if (value === "--to") options.to = resolve(requiredValue(value, values.shift()));
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
  mosa backup [--library <path>] --to <backup-dir>
  mosa backup-verify --from <backup-dir>
  mosa restore --from <backup-dir> --to <empty-library-dir>
  mosa visual-model-verify --from <model-pack-dir>
  mosa thumbnails <rebuild|repair> [--library <path>]
`);
}
