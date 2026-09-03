import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionDir = resolve(root, "extensions/chatgpt-web-capture");
const manifestPath = resolve(extensionDir, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

const version = String(manifest.version || "").trim();
if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) {
  throw new Error(`Invalid extension version: ${version || "<empty>"}`);
}
const outputDir = resolve(root, "out/store");
const outputZip = resolve(outputDir, `MOSA-Web-Capture-${version}-Chrome-Web-Store.zip`);
await mkdir(outputDir, { recursive: true });

const staging = await mkdtemp(resolve(tmpdir(), "mosa-web-capture-store-"));
const runtimeFiles = [
  "background.js",
  "content.css",
  "content.js",
  "generation-registry.js",
  "options.html",
  "options.js",
  "page-hook.js",
  "provider-policy.js",
  "provider-sites.js",
];

try {
  const storeManifest = { ...manifest };
  delete storeManifest.key;
  await writeFile(resolve(staging, "manifest.json"), `${JSON.stringify(storeManifest, null, 2)}\n`, "utf8");

  for (const relative of runtimeFiles) {
    await copyFile(resolve(extensionDir, relative), resolve(staging, relative));
  }

  await rm(outputZip, { force: true });
  if (process.platform === "win32") {
    const escapedOutput = outputZip.replace(/'/g, "''");
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Compress-Archive -Path * -DestinationPath '${escapedOutput}' -Force`,
    ], { cwd: staging });
  } else {
    await execFileAsync("zip", ["-qr", "-X", outputZip, "."], { cwd: staging });
  }

  const packagedManifest = JSON.parse(await readFile(resolve(staging, "manifest.json"), "utf8"));
  if (Object.hasOwn(packagedManifest, "key")) {
    throw new Error("Store package manifest unexpectedly contains key");
  }

  const info = await stat(outputZip);
  console.log(`Chrome Web Store package: ${outputZip}`);
  console.log(`Version: ${version}`);
  console.log(`Size: ${info.size} bytes`);
  console.log(`Manifest key removed: yes`);
  console.log(`ZIP root: manifest.json + ${runtimeFiles.length} runtime files`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
