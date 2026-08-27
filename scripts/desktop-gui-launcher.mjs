import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createMacGuiLauncher, openMacGuiLauncher } from "./macos-gui-launcher.mjs";

export async function launchDesktopGui({
  platform = process.platform,
  rootDir,
  executable,
  args,
  env,
  cwd,
  pidFile,
  logFile,
  healthUrl,
  healthFile,
}) {
  if (platform === "darwin") {
    const appDir = await createMacGuiLauncher({
      rootDir,
      executable,
      args,
      env,
      cwd,
      pidFile,
      logFile,
      healthUrl,
      healthFile,
    });
    const waiter = openMacGuiLauncher(appDir);
    return { waiter, pid: null, logFile, healthFile, launchMode: "launch-services" };
  }

  if (platform !== "win32" && platform !== "linux") {
    throw new Error(`Unsupported desktop GUI launch platform: ${platform}`);
  }

  const log = createWriteStream(logFile, { flags: "a" });
  const child = spawn(executable, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.once("close", () => log.end());
  await writeFile(pidFile, String(child.pid), "utf8");
  void mirrorHealthWhenReady(healthUrl, healthFile, child);
  return { waiter: child, pid: child.pid, logFile, healthFile, launchMode: "direct" };
}

async function mirrorHealthWhenReady(url, healthFile, child, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        await writeFile(healthFile, `${JSON.stringify(await response.json())}\n`, "utf8");
        return;
      }
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}
