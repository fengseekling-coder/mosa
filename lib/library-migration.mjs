import { cp, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { createSqliteAssetStore } from "./sqlite-asset-store.mjs";

export async function inspectLegacyLibrary(options = {}) {
  const managerDir = resolve(options.managerDir || process.cwd());
  const legacyAssetsRoot = resolve(options.legacyAssetsRoot || join(managerDir, "assets"));
  const records = [];
  const groups = [];
  const issues = [];
  let projectEntries = [];
  try {
    projectEntries = await readdir(legacyAssetsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { legacyAssetsRoot, records, groups, issues: [{ kind: "legacy-assets-missing", path: legacyAssetsRoot, detail: "Legacy assets directory does not exist." }] };
    throw error;
  }

  for (const entry of projectEntries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const projectId = entry.name;
    const groupsPath = join(legacyAssetsRoot, projectId, "groups.json");
    try {
      const parsedGroups = JSON.parse(await readFile(groupsPath, "utf8"));
      if (!Array.isArray(parsedGroups)) {
        issues.push({ kind: "invalid-groups", path: groupsPath, detail: "groups.json must contain an array." });
      } else {
        const names = new Map();
        for (const value of parsedGroups) {
          const name = normalizeGroupName(value);
          if (name && !names.has(name.toLocaleLowerCase())) names.set(name.toLocaleLowerCase(), name);
        }
        for (const name of names.values()) groups.push({ projectId, name });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") issues.push({ kind: "corrupt-groups-json", path: groupsPath, detail: error instanceof Error ? error.message : String(error) });
    }
    const metadataDir = join(legacyAssetsRoot, projectId, "metadata");
    const imagesDir = join(legacyAssetsRoot, projectId, "images");
    let metadataEntries = [];
    try {
      metadataEntries = await readdir(metadataDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const metadataEntry of metadataEntries.filter((item) => item.isFile() && item.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name))) {
      const metadataPath = join(metadataDir, metadataEntry.name);
      let metadata;
      try {
        metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      } catch (error) {
        issues.push({ kind: "corrupt-json", path: metadataPath, detail: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (!metadata?.id || !metadata?.asset) {
        issues.push({ kind: "invalid-metadata", path: metadataPath, detail: "Metadata requires id and asset." });
        continue;
      }
      const imagePath = join(imagesDir, metadata.asset);
      try {
        const imageStat = await stat(imagePath);
        if (!imageStat.isFile()) throw new Error("not a regular file");
      } catch (error) {
        issues.push({ kind: "missing-image", path: imagePath, detail: `${metadataPath}: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      records.push({ projectId, metadataPath, imagePath, metadata });
    }
  }
  return { legacyAssetsRoot, records, groups, issues };
}

export async function migrateLegacyLibrary(options = {}) {
  const inspection = await inspectLegacyLibrary(options);
  const report = {
    legacyAssetsRoot: inspection.legacyAssetsRoot,
    discovered: inspection.records.length,
    discoveredGroups: inspection.groups.length,
    imported: 0,
    importedGroups: 0,
    skipped: 0,
    skippedGroups: 0,
    verified: 0,
    issues: inspection.issues,
    backupPath: null,
    completed: false,
  };
  if (options.dryRun || inspection.issues.length) return report;

  const libraryDir = resolve(options.libraryDir);
  const managerDir = resolve(options.managerDir || process.cwd());
  const projectRoot = resolve(options.projectRoot || dirname(managerDir));
  const store = createSqliteAssetStore({ projectRoot, managerDir, libraryDir, legacyAssetsRoot: inspection.legacyAssetsRoot, storage: "sqlite" });
  await store.clearMigrationIssues();
  await store.setMigrationState("migrating", { legacyAssetsRoot: inspection.legacyAssetsRoot, discovered: inspection.records.length });
  try {
    report.backupPath = await backupLegacyJson({ libraryDir, legacyAssetsRoot: inspection.legacyAssetsRoot });
    const knownGroups = new Map();
    for (const group of inspection.groups) {
      if (!knownGroups.has(group.projectId)) {
        const stats = await store.listGroups(group.projectId);
        knownGroups.set(group.projectId, new Set(stats.groups.map(([name]) => name.toLocaleLowerCase())));
      }
      const names = knownGroups.get(group.projectId);
      if (names.has(group.name.toLocaleLowerCase())) {
        report.skippedGroups += 1;
        continue;
      }
      await store.createGroup({ projectId: group.projectId, name: group.name });
      names.add(group.name.toLocaleLowerCase());
      report.importedGroups += 1;
    }
    for (const record of inspection.records) {
      let existing = null;
      try {
        existing = await store.getAsset(record.projectId, record.metadata.id);
      } catch {
        existing = null;
      }
      if (existing) {
        const [sourceHash, storedHash] = await Promise.all([hashFile(record.imagePath), hashFile(existing.image_path)]);
        if (sourceHash !== storedHash) {
          const issue = { kind: "resume-hash-mismatch", path: record.metadataPath, detail: `Existing SQLite asset ${record.metadata.id} differs from legacy image.` };
          report.issues.push(issue);
          await store.recordMigrationIssue(issue);
          continue;
        }
        report.skipped += 1;
        report.verified += 1;
        continue;
      }
      const asset = await store.createAsset({
        ...record.metadata,
        projectId: record.projectId,
        assetId: record.metadata.id,
        imagePath: record.imagePath,
        sourceType: record.metadata.source?.type,
        source: record.metadata.source,
      });
      const [sourceHash, storedHash] = await Promise.all([hashFile(record.imagePath), hashFile(asset.image_path)]);
      if (sourceHash !== storedHash) {
        const issue = { kind: "post-import-hash-mismatch", path: record.metadataPath, detail: `Imported SQLite asset ${asset.id} does not match legacy original.` };
        report.issues.push(issue);
        await store.recordMigrationIssue(issue);
        continue;
      }
      report.imported += 1;
      report.verified += 1;
    }
    if (report.issues.length) {
      await store.setMigrationState("failed", report);
      return report;
    }
    report.completed = true;
    await store.setMigrationState("completed", report);
    return report;
  } catch (error) {
    await store.setMigrationState("failed", { ...report, error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    store.close();
  }
}

export async function verifySqliteLibrary(options = {}) {
  const store = createSqliteAssetStore({
    projectRoot: resolve(options.projectRoot || process.cwd()),
    managerDir: resolve(options.managerDir || process.cwd()),
    libraryDir: resolve(options.libraryDir),
    storage: "sqlite",
  });
  try {
    const [verification, status, issues] = await Promise.all([store.verifyLibrary(), store.migrationStatus(), store.listMigrationIssues()]);
    return { ...verification, migration: status, migrationIssues: issues };
  } finally {
    store.close();
  }
}

async function backupLegacyJson({ libraryDir, legacyAssetsRoot }) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(libraryDir, "legacy-json-backup", timestamp);
  const projects = await readdir(legacyAssetsRoot, { withFileTypes: true });
  for (const project of projects.filter((entry) => entry.isDirectory())) {
    const source = join(legacyAssetsRoot, project.name);
    const destination = join(backupPath, project.name);
    await mkdir(destination, { recursive: true });
    for (const name of ["metadata", "prompts", "groups.json"]) {
      try {
        await cp(join(source, name), join(destination, name), { recursive: true, errorOnExist: false });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return backupPath;
}

async function hashFile(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function normalizeGroupName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
}
