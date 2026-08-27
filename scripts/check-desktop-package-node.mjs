import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DESKTOP_PACKAGING_NODE_MAJOR = 22;

export function desktopPackagingNodeError(version = process.versions.node) {
  const normalized = String(version || "").trim().replace(/^v/u, "");
  const major = Number.parseInt(normalized.split(".")[0] || "", 10);
  if (major === DESKTOP_PACKAGING_NODE_MAJOR) return null;
  const shown = normalized ? `v${normalized}` : "unknown";
  return new Error(
    `MOSA desktop packaging requires Node.js ${DESKTOP_PACKAGING_NODE_MAJOR}.x; current runtime is ${shown}. `
    + "Use the repository's .nvmrc/.node-version (for example `nvm use`) and retry. "
    + "Development and the local MOSA runtime may still use newer Node versions.",
  );
}

export function assertDesktopPackagingNode(version = process.versions.node) {
  const error = desktopPackagingNodeError(version);
  if (error) throw error;
  return true;
}

const executedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (executedPath === fileURLToPath(import.meta.url)) {
  try {
    assertDesktopPackagingNode();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
