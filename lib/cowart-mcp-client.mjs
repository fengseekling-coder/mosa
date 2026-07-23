import { spawn as defaultSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SERVER_PATH = join(homedir(), "plugins", "cowart", "mcp", "server.mjs");

export function createCowartMcpClient(options = {}) {
  const serverPath = resolve(options.serverPath || process.env.COWART_MCP_SERVER_PATH || DEFAULT_SERVER_PATH);
  const spawnImpl = options.spawnImpl || defaultSpawn;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1000, options.timeoutMs) : DEFAULT_TIMEOUT_MS;

  return {
    status() {
      return { available: existsSync(serverPath) };
    },
    async callTool(name, args = {}) {
      if (!existsSync(serverPath)) throw new Error("Cowart MCP server is not installed or COWART_MCP_SERVER_PATH is invalid.");
      return callMcpTool({ serverPath, name, args, spawnImpl, timeoutMs });
    },
  };
}

export function callMcpTool({ serverPath, name, args = {}, spawnImpl = defaultSpawn, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawnImpl(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let output = "";
    let settled = false;
    let requestId = 1;
    let timer;

    const cleanup = () => {
      clearTimeout(timer);
      if (!child.killed) child.kill("SIGTERM");
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectResult(error instanceof Error ? error : new Error(String(error)));
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveResult(result);
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const handleMessage = (message) => {
      if (message.id === 1 && message.result) {
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        requestId = 2;
        send({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name, arguments: args } });
        return;
      }
      if (message.id !== requestId) return;
      if (message.error) return fail(new Error(message.error.message || `Cowart MCP call failed: ${name}`));
      if (message.result?.isError) return fail(new Error(textFromResult(message.result) || `Cowart MCP call failed: ${name}`));
      finish(message.result || {});
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const lines = output.split("\n");
      output = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try { handleMessage(JSON.parse(line)); } catch (error) { fail(new Error(`Invalid Cowart MCP response: ${error.message}`)); }
      }
    });
    child.on("error", fail);
    child.on("exit", (code, signal) => {
      if (!settled) fail(new Error(`Cowart MCP server exited before replying (${code ?? signal ?? "unknown"}).`));
    });
    timer = setTimeout(() => fail(new Error("Cowart MCP request timed out.")), timeoutMs);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mosa", version: "0.1.0" } } });
  });
}

function textFromResult(result) {
  return (result?.content || []).filter((item) => item?.type === "text").map((item) => item.text).filter(Boolean).join(" ");
}
