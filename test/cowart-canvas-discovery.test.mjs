import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverCowartProjectsFromCodexSessions } from "../lib/cowart-canvas-discovery.mjs";

test("discovers only projects with a real Cowart launch call and canvas marker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionsDir = join(root, "sessions");
  const nativeProject = join(root, "native-project");
  const fallbackProject = join(root, "fallback-project");
  const incidentalProject = join(root, "incidental-project");
  await Promise.all([
    writeCanvasMarker(nativeProject),
    writeCanvasMarker(fallbackProject),
    writeCanvasMarker(incidentalProject),
    mkdir(sessionsDir, { recursive: true }),
  ]);

  await Promise.all([
    writeSession(join(sessionsDir, "native.jsonl"), nativeProject, {
      type: "mcp_tool_call",
      name: "mcp__cowart_mcp__render_cowart_canvas_widget",
      arguments: JSON.stringify({ projectDir: nativeProject }),
    }),
    writeSession(join(sessionsDir, "fallback.jsonl"), fallbackProject, {
      type: "custom_tool_call",
      name: "exec",
      arguments: `const result = await tools.exec_command({cmd:"./scripts/start-canvas.sh ${fallbackProject}",workdir:"${fallbackProject}"});`,
    }),
    writeSession(join(sessionsDir, "incidental.jsonl"), incidentalProject, {
      type: "custom_tool_call",
      name: "exec",
      arguments: "const result = await tools.exec_command({cmd:\"rg -n start-canvas.sh .\"});",
    }),
  ]);

  const discovered = await discoverCowartProjectsFromCodexSessions({ sessionsDir, fullScan: true });
  const canonicalNativeProject = await realpath(nativeProject);
  const canonicalFallbackProject = await realpath(fallbackProject);
  assert.deepEqual(
    new Set(discovered.map((entry) => entry.projectDir)),
    new Set([canonicalNativeProject, canonicalFallbackProject]),
  );
  assert.equal(discovered.every((entry) => entry.canvasDir === join(entry.projectDir, "canvas")), true);
});

test("discovers project from structured JSON arguments with workdir and no turn_context.cwd", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-workdir-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionsDir = join(root, "sessions");
  const workdirProject = join(root, "workdir-project");
  await Promise.all([
    writeCanvasMarker(workdirProject),
    mkdir(sessionsDir, { recursive: true }),
  ]);

  // Session with NO turn_context -- the project dir is only in structured
  // JSON arguments as { cmd, workdir }.
  await writeFile(join(sessionsDir, "workdir-only.jsonl"), [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        arguments: JSON.stringify({
          cmd: "./scripts/start-canvas.sh",
          workdir: workdirProject,
        }),
      },
    }),
  ].join("\n") + "\n", "utf8");

  const discovered = await discoverCowartProjectsFromCodexSessions({ sessionsDir, fullScan: true });
  const canonicalWorkdirProject = await realpath(workdirProject);
  assert.deepEqual(
    discovered.map((entry) => entry.projectDir),
    [canonicalWorkdirProject],
  );
  assert.equal(discovered[0].canvasDir, join(canonicalWorkdirProject, "canvas"));
});

test("discovers project from structured JSON arguments with cwd and no turn_context.cwd", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-cwd-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionsDir = join(root, "sessions");
  const cwdProject = join(root, "cwd-project");
  await Promise.all([
    writeCanvasMarker(cwdProject),
    mkdir(sessionsDir, { recursive: true }),
  ]);

  await writeFile(join(sessionsDir, "cwd-only.jsonl"), [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        arguments: JSON.stringify({
          cmd: "./scripts/start-canvas.sh",
          cwd: cwdProject,
        }),
      },
    }),
  ].join("\n") + "\n", "utf8");

  const discovered = await discoverCowartProjectsFromCodexSessions({ sessionsDir, fullScan: true });
  const canonicalCwdProject = await realpath(cwdProject);
  assert.deepEqual(
    discovered.map((entry) => entry.projectDir),
    [canonicalCwdProject],
  );
});

test("does not discover project when cmd only mentions start-canvas.sh in a search", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-falsepos-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionsDir = join(root, "sessions");
  const searchProject = join(root, "search-project");
  await Promise.all([
    writeCanvasMarker(searchProject),
    mkdir(sessionsDir, { recursive: true }),
  ]);

  // The cmd is a search/rg command that merely mentions start-canvas.sh as
  // a search term -- this must NOT be treated as a launch.
  await writeFile(join(sessionsDir, "search-mention.jsonl"), [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        arguments: JSON.stringify({
          cmd: "rg -n start-canvas.sh .",
          workdir: searchProject,
        }),
      },
    }),
  ].join("\n") + "\n", "utf8");

  const discovered = await discoverCowartProjectsFromCodexSessions({ sessionsDir, fullScan: true });
  assert.equal(discovered.length, 0);
});

test("does not discover project when arguments mention start-canvas.sh in a comment or string", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-comment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionsDir = join(root, "sessions");
  const commentProject = join(root, "comment-project");
  await Promise.all([
    writeCanvasMarker(commentProject),
    mkdir(sessionsDir, { recursive: true }),
  ]);

  // The cmd is an echo/comment that mentions start-canvas.sh -- not a launch.
  await writeFile(join(sessionsDir, "comment-mention.jsonl"), [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        arguments: JSON.stringify({
          cmd: 'echo "run start-canvas.sh to open canvas"',
          workdir: commentProject,
        }),
      },
    }),
  ].join("\n") + "\n", "utf8");

  const discovered = await discoverCowartProjectsFromCodexSessions({ sessionsDir, fullScan: true });
  assert.equal(discovered.length, 0);
});

test("discovered project is the projectDir even when workdir and cwd point to other canvas-bearing projects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-priority-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionsDir = join(root, "sessions");
  const projectDirProject = join(root, "projectdir-project");
  const workdirProject = join(root, "workdir-project");
  const cwdProject = join(root, "cwd-project");
  // All three have a Cowart marker so the test would only show wrong-priority
  // picks if the function returned multiple fields.
  await Promise.all([
    writeCanvasMarker(projectDirProject),
    writeCanvasMarker(workdirProject),
    writeCanvasMarker(cwdProject),
    mkdir(sessionsDir, { recursive: true }),
  ]);

  await writeFile(join(sessionsDir, "priority.jsonl"), [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        arguments: JSON.stringify({
          cmd: "./scripts/start-canvas.sh",
          projectDir: projectDirProject,
          workdir: workdirProject,
          cwd: cwdProject,
        }),
      },
    }),
  ].join("\n") + "\n", "utf8");

  const discovered = await discoverCowartProjectsFromCodexSessions({ sessionsDir, fullScan: true });
  const canonicalProjectDirProject = await realpath(projectDirProject);
  assert.deepEqual(
    discovered.map((entry) => entry.projectDir),
    [canonicalProjectDirProject],
    "expected only the projectDir project to be discovered",
  );
});

test("falls back to workdir when projectDir is missing and cwd points to another canvas", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-workdir-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionsDir = join(root, "sessions");
  const workdirProject = join(root, "workdir-project");
  const cwdProject = join(root, "cwd-project");
  await Promise.all([
    writeCanvasMarker(workdirProject),
    writeCanvasMarker(cwdProject),
    mkdir(sessionsDir, { recursive: true }),
  ]);

  await writeFile(join(sessionsDir, "workdir-fallback.jsonl"), [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        arguments: JSON.stringify({
          cmd: "./scripts/start-canvas.sh",
          workdir: workdirProject,
          cwd: cwdProject,
        }),
      },
    }),
  ].join("\n") + "\n", "utf8");

  const discovered = await discoverCowartProjectsFromCodexSessions({ sessionsDir, fullScan: true });
  const canonicalWorkdirProject = await realpath(workdirProject);
  assert.deepEqual(
    discovered.map((entry) => entry.projectDir),
    [canonicalWorkdirProject],
    "expected only the workdir project to be discovered when projectDir is absent",
  );
});

test("regex fallback on an un-stringified JS call still picks only the first valid field by priority", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-cowart-js-priority-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionsDir = join(root, "sessions");
  const projectDirProject = join(root, "projectdir-project");
  const workdirProject = join(root, "workdir-project");
  const cwdProject = join(root, "cwd-project");
  await Promise.all([
    writeCanvasMarker(projectDirProject),
    writeCanvasMarker(workdirProject),
    writeCanvasMarker(cwdProject),
    mkdir(sessionsDir, { recursive: true }),
  ]);

  // The Codex session records the raw source of the tool call verbatim.
  // parseArguments() cannot turn an un-stringified JS expression into a
  // structured object, so the extractor must consult `source` via the
  // projectDir > workdir > cwd regex fallback.  All three directories
  // have valid Cowart markers; the test only passes if the regex
  // fallback honours the same priority order and stops at projectDir.
  const jsExpression = [
    "const result = await tools.exec_command({",
    `  cmd:"./scripts/start-canvas.sh",`,
    `  projectDir:"${projectDirProject}",`,
    `  workdir:"${workdirProject}",`,
    `  cwd:"${cwdProject}"`,
    "});",
  ].join("\n");

  await writeFile(join(sessionsDir, "js-call-priority.jsonl"), [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        arguments: jsExpression,
      },
    }),
  ].join("\n") + "\n", "utf8");

  const discovered = await discoverCowartProjectsFromCodexSessions({ sessionsDir, fullScan: true });
  const canonicalProjectDirProject = await realpath(projectDirProject);
  assert.deepEqual(
    discovered.map((entry) => entry.projectDir),
    [canonicalProjectDirProject],
    "expected regex fallback to discover only the projectDir project",
  );
});

async function writeCanvasMarker(projectDir) {
  const canvasDir = join(projectDir, "canvas");
  await mkdir(canvasDir, { recursive: true });
  await writeFile(join(canvasDir, "cowart-view-state.json"), "{}\n", "utf8");
}

async function writeSession(sessionPath, cwd, call) {
  await writeFile(sessionPath, [
    { type: "turn_context", payload: { cwd } },
    { type: "response_item", payload: call },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}
