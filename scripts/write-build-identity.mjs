#!/usr/bin/env node

/**
 * Build-time script that generates build-identity.json for both web and desktop UIs:
 *   - productVersion  (from package.json)
 *   - gitSha          (from git, or "unknown")
 *   - uiFingerprint   (SHA-256 of all browser-delivered app shell files)
 *
 * Run as part of `npm run build` so both the web runtime and the packaged
 * desktop app carry an immutable record of what UI they were built with.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeRuntimeFingerprint, computeUiFingerprint } from "../lib/build-identity.mjs";
import { desktopDistributionFromEnvironment } from "../lib/release-distribution.mjs";
import { releaseManifestTrustFromEnvironment } from "../lib/release-manifest-signature.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const webAppDir = join(root, "web", "app");
const desktopAppDir = join(root, "desktop", "app");

// --- productVersion --------------------------------------------------
const productVersion = pkg.version || "0.0.0";

// --- gitSha ----------------------------------------------------------
let gitSha = "unknown";
try {
  gitSha = execSync("git rev-parse HEAD", { cwd: root, stdio: "pipe" })
    .toString()
    .trim();
} catch {
  // Git unavailable (e.g. packaged app without .git) — leave as "unknown".
}

// --- uiFingerprint (web) ---------------------------------------------
const webUiFingerprint = computeUiFingerprint(webAppDir);
if (webUiFingerprint === "unknown") {
  throw new Error("Cannot compute MOSA web UI fingerprint: required app shell files are missing or unreadable.");
}

// --- uiFingerprint (desktop) -----------------------------------------
const desktopUiFingerprint = computeUiFingerprint(desktopAppDir);
if (desktopUiFingerprint === "unknown") {
  throw new Error("Cannot compute MOSA desktop UI fingerprint: required app shell files are missing or unreadable.");
}

// --- runtimeFingerprint ----------------------------------------------
const runtimeFingerprint = computeRuntimeFingerprint(root);
if (runtimeFingerprint === "unknown") {
  throw new Error("Cannot compute MOSA runtime fingerprint: server/runtime files are missing or unreadable.");
}

// --- Write web identity ----------------------------------------------
const releaseManifestTrust = releaseManifestTrustFromEnvironment(process.env);
const distribution = desktopDistributionFromEnvironment(process.env);
const webIdentity = {
  productVersion,
  gitSha,
  uiFingerprint: webUiFingerprint,
  runtimeFingerprint,
  distribution,
  ...(releaseManifestTrust ? { releaseManifestTrust } : {}),
};
const webOutPath = join(webAppDir, "build-identity.json");
writeFileSync(webOutPath, JSON.stringify(webIdentity, null, 2) + "\n");
console.log(`Web build identity written to ${webOutPath}`);
console.log("Web:", JSON.stringify(webIdentity));

// --- Write desktop identity ------------------------------------------
const desktopIdentity = {
  productVersion,
  gitSha,
  uiFingerprint: desktopUiFingerprint,
  runtimeFingerprint,
  distribution,
  ...(releaseManifestTrust ? { releaseManifestTrust } : {}),
};
const desktopOutPath = join(desktopAppDir, "build-identity.json");
writeFileSync(desktopOutPath, JSON.stringify(desktopIdentity, null, 2) + "\n");
console.log(`Desktop build identity written to ${desktopOutPath}`);
console.log("Desktop:", JSON.stringify(desktopIdentity));
