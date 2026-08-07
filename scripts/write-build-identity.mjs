#!/usr/bin/env node

/**
 * Build-time script that generates `app/build-identity.json` containing:
 *   - productVersion  (from package.json)
 *   - gitSha          (from git, or "unknown")
 *   - uiFingerprint   (SHA-256 of index.html + styles.css + app.js content)
 *
 * Run as part of `npm run build` so both the web runtime and the packaged
 * desktop app carry an immutable record of what UI they were built with.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const appDir = join(root, "app");

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

// --- uiFingerprint ---------------------------------------------------
// Hash the three core UI files so any change to the visual layer produces
// a new fingerprint.  Order matters: index.html → styles.css → app.js.
const UI_FILES = ["index.html", "styles.css", "app.js"];
const hash = createHash("sha256");
for (const name of UI_FILES) {
  const content = readFileSync(join(appDir, name));
  hash.update(content);
}
const uiFingerprint = hash.digest("hex");

// --- Write -----------------------------------------------------------
const identity = { productVersion, gitSha, uiFingerprint };
const outPath = join(appDir, "build-identity.json");
writeFileSync(outPath, JSON.stringify(identity, null, 2) + "\n");
console.log(`Build identity written to ${outPath}`);
console.log(JSON.stringify(identity));
