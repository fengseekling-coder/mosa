import { join, resolve } from "node:path";

export function electronExecutablePath({ rootDir, platform = process.platform } = {}) {
  if (!rootDir) throw new Error("rootDir is required.");
  const dist = join(resolve(rootDir), "node_modules", "electron", "dist");
  if (platform === "darwin") return join(dist, "Electron.app", "Contents", "MacOS", "Electron");
  if (platform === "win32") return join(dist, "electron.exe");
  if (platform === "linux") return join(dist, "electron");
  throw new Error(`Unsupported Electron QA platform: ${platform}`);
}

export function packagedExecutablePath({
  rootDir,
  outDir,
  platform = process.platform,
  arch = platform === "win32" ? "x64" : "arm64",
} = {}) {
  if (!rootDir) throw new Error("rootDir is required.");
  const outputRoot = resolve(outDir || join(rootDir, "out"));
  if (platform === "darwin" && arch === "arm64") {
    return join(outputRoot, "MOSA-darwin-arm64", "MOSA.app", "Contents", "MacOS", "MOSA");
  }
  if (platform === "win32" && arch === "x64") {
    return join(outputRoot, "MOSA-win32-x64", "MOSA.exe");
  }
  throw new Error(`Unsupported packaged MOSA target: ${platform}-${arch}`);
}
