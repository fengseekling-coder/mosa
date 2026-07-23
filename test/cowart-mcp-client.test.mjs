import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { createCowartMcpClient } from "../lib/cowart-mcp-client.mjs";

const fakeServer = `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === 1) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { initialized: true } }) + "\\n");
    if (message.id === 2) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { structuredContent: { inserted: true } } }) + "\\n");
  }
});
`;

test("calls a Cowart MCP tool through the stdio handshake", async () => {
  const client = createCowartMcpClient({
    serverPath: process.execPath,
    spawnImpl: (_command, _args, options) => spawn(process.execPath, ["-e", fakeServer], options),
  });
  const result = await client.callTool("insert_cowart_image", { imagePath: "/tmp/image.png" });
  assert.deepEqual(result.structuredContent, { inserted: true });
});

test("reports a missing Cowart MCP server without spawning it", async () => {
  const client = createCowartMcpClient({ serverPath: join("/tmp", "mosa-missing-cowart-server.mjs") });
  assert.equal(client.status().available, false);
  await assert.rejects(() => client.callTool("insert_cowart_image"), /Cowart MCP server is not installed/);
});
