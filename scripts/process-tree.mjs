import { spawn } from "node:child_process";

/**
 * Signal one process on POSIX or the complete process tree on Windows.
 * Windows' process.kill() only targets the selected PID, which can leave
 * Electron renderer/GPU children behind after QA and smoke runs.
 */
export async function signalProcessTree(pid, { force = false, platform = process.platform } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  if (platform !== "win32") {
    try {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      throw error;
    }
  }

  return new Promise((resolveSignal) => {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    const killer = spawn("taskkill", args, {
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolveSignal(value);
    };
    killer.once("error", () => finish(false));
    killer.once("exit", (code) => finish(code === 0));
  });
}
