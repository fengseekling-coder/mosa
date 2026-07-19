import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

test("returns 404 for a missing library image without stopping the server", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-server-"));
  const port = 44000 + Math.floor(Math.random() * 1000);
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PORT: String(port),
      MOSA_PROJECT_DIR: root,
      CODEX_GENERATED_IMAGES_DIR: join(root, "generated-images"),
      CODEX_SESSIONS_DIR: join(root, "sessions"),
      COWART_MOSA_CANVAS_DIR: join(root, "cowart-data"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await once(server, "exit");
    }
    await rm(root, { recursive: true, force: true });
  });

  await waitForServer(port, server);
  const missingImage = await fetch(`http://127.0.0.1:${port}/library/default/images/does-not-exist.png`);
  assert.equal(missingImage.status, 404);
  assert.deepEqual(await missingImage.json(), { error: "Asset not found" });

  const bridgeStatus = await fetch(`http://127.0.0.1:${port}/api/bridges`);
  assert.equal(bridgeStatus.status, 200);
  assert.equal(server.exitCode, null);
});

async function waitForServer(port, server) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("MOSA server exited during startup.");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/bridges`);
      if (response.ok) return;
    } catch {
      // The listener may not be ready yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("Timed out waiting for MOSA server startup.");
}
