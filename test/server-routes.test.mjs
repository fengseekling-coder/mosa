import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

test("returns 404 for a missing library image without stopping the server", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-server-"));
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PORT: "0",
      MOSA_PROJECT_DIR: root,
      CODEX_GENERATED_IMAGES_DIR: join(root, "generated-images"),
      CODEX_SESSIONS_DIR: join(root, "sessions"),
      COWART_MOSA_CANVAS_DIR: join(root, "cowart-data"),
      MOSA_COWART_REGISTRY_PATH: join(root, "state", "cowart-projects.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });

  const port = await waitForServerPort(server);
  await waitForServer(port, server);
  const missingImage = await fetch(`http://127.0.0.1:${port}/library/default/images/does-not-exist.png`);
  assert.equal(missingImage.status, 404);
  assert.deepEqual(await missingImage.json(), { error: "Asset not found" });

  const bridgeStatus = await fetch(`http://127.0.0.1:${port}/api/bridges`, {
    headers: { origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(bridgeStatus.status, 200);
  assert.equal(server.exitCode, null);

  const otherProject = join(root, "other-project");
  await mkdir(otherProject, { recursive: true });
  const canonicalOtherProject = await realpath(otherProject);
  const addCanvas = await fetch(`http://127.0.0.1:${port}/api/cowart-canvases`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectDir: otherProject }),
  });
  assert.equal(addCanvas.status, 201);
  const added = await addCanvas.json();
  assert.equal(added.canvas.projectDir, canonicalOtherProject);
  assert.equal(added.canvas.canvasDir, join(canonicalOtherProject, "canvas"));

  const canvases = await fetch(`http://127.0.0.1:${port}/api/cowart-canvases`);
  assert.equal(canvases.status, 200);
  assert.equal((await canvases.json()).canvases.length, 2);

  const removeCanvas = await fetch(`http://127.0.0.1:${port}/api/cowart-canvases/${encodeURIComponent(added.canvas.id)}`, { method: "DELETE" });
  assert.equal(removeCanvas.status, 200);
  assert.equal((await removeCanvas.json()).canvas.id, added.canvas.id);
});

async function waitForServerPort(server) {
  server.stdout.setEncoding("utf8");
  return new Promise((resolvePort, rejectPort) => {
    let output = "";
    const timer = setTimeout(() => finish(new Error("Timed out waiting for MOSA server startup.")), 5000);
    const onOutput = (chunk) => {
      output += chunk;
      const match = /MOSA: http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (match) finish(null, Number(match[1]));
    };
    const onExit = () => finish(new Error("MOSA server exited during startup."));
    const finish = (error, port) => {
      clearTimeout(timer);
      server.stdout.off("data", onOutput);
      server.off("exit", onExit);
      if (error) rejectPort(error);
      else resolvePort(port);
    };
    server.stdout.on("data", onOutput);
    server.once("exit", onExit);
  });
}

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
