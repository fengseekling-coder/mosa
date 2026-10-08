import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { scrubRecord } from "../extensions/chatgpt-web-capture/diagnostics-storage.js";
import {
  captureDiagnosticsSourceSync,
  fakeSseStreamPayload,
} from "./helpers/capture-diagnostics-fixtures.mjs";

test("leak test: short Chinese title, short English phrase, Chinese object key, and full conversation id never reach the stored record", () => {
  // Walk the page-world recorder with a payload that includes a Chinese
  // title, a short English phrase under "name", a length-30 "type"
  // string, a Chinese object key, and a full conversation id. The
  // page-side sanitizer must drop the value text. The storage scrubber
  // then re-validates and keeps the record. None of the forbidden
  // literals must survive, and the only place the conversation id may
  // appear is its first 8 characters.
  const api = captureDiagnosticsSourceSync();
  api.setEnabled(true);
  api.recordFrame("68d5b8c0-1234-5678-9abc-def012345678", {
    type: "sse-event",
    schema: api.summarizePayload({
      title: "水彩橘猫绘画",
      name: "draw a cat",
      summary: "draw a cat",
      content: "draw a cat",
      type: "a thirty character long type string!",
      id: "68d5b8c0-1234-5678-9abc-def012345678",
      水彩橘猫: "an entire key whose name is Chinese",
    }),
  });
  api.markCapture("68d5b8c0-1234-5678-9abc-def012345678:msg:gen", "68d5b8c0-1234-5678-9abc-def012345678", "msg", false, "gen");
  const finished = api.finalizeCapture("68d5b8c0-1234-5678-9abc-def012345678", "68d5b8c0-1234-5678-9abc-def012345678:msg:gen");
  assert.ok(finished.snapshot, "the capture must produce a snapshot");
  const record = {
    conversationId: finished.snapshot.conversationId,
    messageId: finished.snapshot.messageId,
    generationId: finished.snapshot.generationId,
    version: "0.15.28",
    control: false,
    firstAt: finished.snapshot.firstAt,
    lastAt: finished.snapshot.lastAt,
    models: finished.snapshot.models,
    frames: finished.snapshot.frames,
  };
  const out = scrubRecord(record);
  assert.notEqual(out, "leak", "the legitimate capture should not be rejected outright");
  const stored = out.record;
  const json = JSON.stringify(stored);
  for (const forbidden of [
    "水彩橘猫",
    "draw a cat",
    "a thirty character long type string!",
    "68d5b8c0-1234-5678-9abc-def012345678",
    "an entire key whose name is Chinese",
  ]) {
    assert.ok(!json.includes(forbidden), `forbidden literal must be dropped: ${forbidden}`);
  }
  assert.ok(json.includes("68d5b8c0"), "the 8-char conversation id prefix must survive");
  assert.ok(json.includes("<key>"), "non-ASCII object keys must be replaced with <key>");
});

test("strict pre-storage check: a record that smuggles a 30-character non-allow-list string is dropped wholesale", () => {
  // A "leak" tries to carry a 30-character string under a non-allow-list
  // key. The whole record must be rejected and the rejects counter
  // bumped. This is the last-line-of-defense behavior for tampered
  // postMessage payloads that try to slip text past the page-world
  // sanitizer.
  const record = {
    conversationId: "conv-1",
    frames: [{
      t: 1,
      source: "sse",
      summary: {
        type: "sse-event",
        schema: [{
          path: "leak",
          type: "string",
          length: 30,
          value: { kind: "primitive", text: "this string is way too long to be allowed" },
        }],
      },
    }],
  };
  const out = scrubRecord(record);
  assert.equal(out, "leak", "the record must be dropped because the value text does not match the allow-list");
});

test("switch behavior: set-capture-enabled must not flip the diagnostics recorder", () => {
  // The diagnostics recorder is independent of captureEnabled. The
  // bridge in page-hook.js calls setEnabled only for the
  // set-diagnostics-enabled message.
  const pageHookSource = readFileSync(
    new URL("../extensions/chatgpt-web-capture/page-hook.js", import.meta.url),
    "utf8",
  );
  const captureBranch = pageHookSource.match(/if \(data\.type === "set-capture-enabled"\)\s*\{[\s\S]*?\n {4,6}return;\n {4,6}\}\n/);
  assert.ok(captureBranch, "the set-capture-enabled handler must exist");
  assert.ok(
    !/captureDiagnostics\s*\.\s*setEnabled\s*\(/.test(captureBranch[0]),
    "set-capture-enabled must not call setEnabled on the diagnostics recorder",
  );
  const diagnosticsBranch = pageHookSource.match(/if \(data\.type === "set-diagnostics-enabled"\)\s*\{[\s\S]*?\n {4,6}return;\n {4,6}\}\n/);
  assert.ok(diagnosticsBranch, "the set-diagnostics-enabled handler must exist");
  assert.ok(
    /captureDiagnostics\s*\.\s*setEnabled\s*\(/.test(diagnosticsBranch[0]),
    "set-diagnostics-enabled must call setEnabled on the diagnostics recorder",
  );

  // Behavioral check: turning captureEnabled on without diagnostics must
  // not enable the recorder.
  const api = captureDiagnosticsSourceSync();
  api.setEnabled(false);
  api.recordFrame("conv", { source: "sse", summary: { type: "sse-raw", length: 2, kind: "text" } });
  assert.equal(api.counters().frames, 0, "set-capture-enabled alone must not enable the recorder");
  api.setEnabled(true);
  api.recordFrame("conv", { source: "sse", summary: { type: "sse-raw", length: 2, kind: "text" } });
  assert.equal(api.counters().frames, 1, "set-diagnostics-enabled alone must enable the recorder");
  api.setEnabled(false);
  api.recordFrame("conv", { source: "sse", summary: { type: "sse-raw", length: 2, kind: "text" } });
  assert.equal(api.counters().frames, 1, "a set-diagnostics-enabled: false must immediately stop recording");
});

test("control captures: has-prompt captures are scheduled and the 1/10 sampling decides whether they become a record", () => {
  // The page hook no longer short-circuits on hasPrompt; the sample
  // decision lives inside finalizeCapture. The page-world module
  // exposes a sampling-rate override so the test can force the
  // decision deterministically.
  const api = captureDiagnosticsSourceSync();
  api.setEnabled(true);
  api.__sampleRateOverride = 1;
  api.recordFrame("conv-control", { source: "sse", type: "patch", op: "add", path: "/message" });
  api.markCapture("conv-control:msg:gen", "conv-control", "msg", true, "gen");
  const finished = api.finalizeCapture("conv-control", "conv-control:msg:gen");
  assert.ok(finished && finished.snapshot, "a control capture that sampled-in must produce a snapshot");
  assert.equal(finished.control, true);

  api.__sampleRateOverride = 0;
  api.markCapture("conv-control:msg:miss", "conv-control", "msg-miss", true, "gen-miss");
  const missed = api.finalizeCapture("conv-control", "conv-control:msg:miss");
  assert.ok(missed && missed.skipped === "sampled-out", "a sampled-out control must return { skipped: 'sampled-out' }");
  assert.ok(!missed.snapshot, "a sampled-out control must not produce a snapshot");
});

test("5.6 fixture snapshot: a prompt-less record carries the prompt path with a null type and never the prompt text", () => {
  // Re-run the 5.6 fixture end-to-end through the page-world recorder
  // and the storage scrubber. The stored record must reference the
  // prompt field by its path (the keys list keeps "prompt" inside
  // metadata) and report the path's type as "null" — but the prompt
  // text itself is never stored.
  const api = captureDiagnosticsSourceSync();
  const sseText = fakeSseStreamPayload();
  api.setEnabled(true);
  for (const line of sseText.split("\n")) {
    if (!line.trim().startsWith("data:")) continue;
    const lineSummary = api.summarizeSseLine(line);
    if (lineSummary) api.recordFrame("conv", { ...lineSummary });
  }
  api.markCapture("conv:msg:gen", "conv", "msg", false, "gen");
  const finished = api.finalizeCapture("conv", "conv:msg:gen");
  assert.ok(finished.snapshot);
  const record = {
    conversationId: finished.snapshot.conversationId,
    messageId: finished.snapshot.messageId,
    generationId: "generati",
    version: "0.15.28",
    control: finished.snapshot.control,
    firstAt: finished.snapshot.firstAt,
    lastAt: finished.snapshot.lastAt,
    models: finished.snapshot.models,
    frames: finished.snapshot.frames,
  };
  const scrubbed = scrubRecord(record);
  assert.notEqual(scrubbed, "leak", "the legitimate 5.6 capture must survive the storage check");
  const stored = scrubbed.record;
  const flat = JSON.stringify(stored);
  assert.ok(flat.includes("prompt"), "the prompt path must be present in the stored record");
  assert.ok(flat.includes("null"), "the prompt path's type must be reported as null");
  assert.ok(!flat.includes("draw a poster"), "the prompt text must never reach the stored record");
});

test("structure survival: the three-line 5.6 probe keeps ops, paths, sub-patches and models after scrubRecord", () => {
  // Privacy is not the only requirement: a record that scrubs itself down
  // to `{ type: "raw" }` frames is useless for diagnosis. Walk the same
  // three SSE lines the manual probe uses through the page-world recorder
  // and the storage scrubber, then assert every structural marker the
  // record must retain — while the conversation text still never appears.
  const api = captureDiagnosticsSourceSync();
  api.setEnabled(true);
  const conversationId = "6ac79cc5-e244-83e8-8264-deaf50f49b97";
  const lines = [
    'data: {"p":"/message/content/parts/0","o":"append","v":"一只橘猫 cat"}',
    'data: {"o":"add","v":{"message":{"id":"abc","author":{"role":"tool","name":"t2uay3k.sj1i4kz"},"recipient":"all","content":{"content_type":"multimodal_text","parts":[{"asset_pointer":"sediment://file_abc"}]},"metadata":{"model_slug":"gpt-5-6-thinking","title":"水彩橘猫绘画"}}}}',
    'data: {"v":[{"p":"/message/metadata/prompt","o":"replace","v":null}],"o":"patch"}',
  ];
  for (const line of lines) {
    const summary = api.summarizeSseLine(line);
    assert.ok(summary, "each probe line must produce a summary");
    api.recordFrame(conversationId, { source: "sse", summary });
  }
  api.markCapture("conv-key", conversationId, "abc", false, "gen-1");
  const finished = api.finalizeCapture(conversationId, "conv-key");
  assert.ok(finished && finished.snapshot, "a prompt-less capture must produce a snapshot");
  const record = {
    conversationId: finished.snapshot.conversationId,
    messageId: finished.snapshot.messageId,
    generationId: finished.snapshot.generationId,
    version: "0.15.28",
    control: false,
    firstAt: finished.snapshot.firstAt,
    lastAt: finished.snapshot.lastAt,
    models: finished.snapshot.models,
    frames: finished.snapshot.frames,
  };
  const scrubbed = scrubRecord(record);
  assert.notEqual(scrubbed, "leak", "the probe capture must survive the storage check");
  const stored = scrubbed.record;

  assert.equal(stored.conversationId, "6ac79cc5", "only the 8-char conversation id prefix may survive");
  assert.equal(stored.frames.length, 3, "all three frames must be stored");
  const [first, second, third] = stored.frames.map((frame) => frame.summary);

  // Frame 1: the append patch keeps its op and its "/"-separated path; the
  // appended string is reduced to type and length only.
  assert.equal(first.type, "patch");
  assert.equal(first.op, "append");
  assert.equal(first.path, "/message/content/parts/0");
  const firstValue = first.schema.find((entry) => entry.path === "$");
  assert.ok(firstValue, "the appended value must keep a schema entry");
  assert.equal(firstValue.type, "string");
  assert.equal(firstValue.length, "一只橘猫 cat".length);
  assert.equal(firstValue.value, undefined, "the appended string must carry no value text");

  // Frame 2: the "add" message keeps the allow-listed original values and
  // the structural fields, while the title stays length-only.
  assert.equal(second.type, "patch");
  assert.equal(second.op, "add");
  const addByPath = new Map(second.add.map((entry) => [entry.path, entry]));
  const expectValue = (path, text) => {
    const entry = addByPath.get(path);
    assert.ok(entry, `the add schema must keep the ${path} entry`);
    assert.ok(entry.value && entry.value.kind === "primitive", `${path} must carry a primitive value`);
    assert.equal(entry.value.text, text);
  };
  expectValue("message.author.role", "tool");
  expectValue("message.author.name", "t2uay3k.sj1i4kz");
  expectValue("message.recipient", "all");
  expectValue("message.content.content_type", "multimodal_text");
  expectValue("message.metadata.model_slug", "gpt-5-6-thinking");
  const titleEntry = addByPath.get("message.metadata.title");
  assert.ok(titleEntry, "the title must keep a schema entry");
  assert.equal(titleEntry.type, "string");
  assert.equal(titleEntry.length, "水彩橘猫绘画".length);
  assert.equal(titleEntry.value, undefined, "the title must be length-only");

  // Frame 3: the batch patch keeps each sub-patch's path and op, and the
  // replaced value's type (null) — without the prompt text, which does not
  // exist here anyway.
  assert.equal(third.type, "patch");
  assert.equal(third.op, "patch");
  assert.ok(Array.isArray(third.patches) && third.patches.length === 1, "the batch patch must keep its sub-patch");
  const subPatch = third.patches[0];
  assert.equal(subPatch.path, "/message/metadata/prompt");
  assert.equal(subPatch.op, "replace");
  assert.ok(
    subPatch.schema.some((entry) => entry.path === "$" && entry.type === "null"),
    "the sub-patch value must be reported as type null",
  );

  // The models list is harvested from the frames' model_slug fields.
  assert.ok(Array.isArray(stored.models) && stored.models.includes("gpt-5-6-thinking"));

  // And the privacy half: none of the conversation text may appear.
  const json = JSON.stringify(stored);
  for (const forbidden of ["橘猫", "cat", "水彩", "sediment://", "6ac79cc5-e244"]) {
    assert.ok(!json.includes(forbidden), `forbidden literal must be dropped: ${forbidden}`);
  }
});

test("author.name keeps its value only for tool authors; a user author's name stays length-only", () => {
  const api = captureDiagnosticsSourceSync();
  const schema = api.summarizePayload({
    tool: { author: { role: "tool", name: "t2uay3k.sj1i4kz" } },
    user: { author: { role: "user", name: "zebracat" } },
  });
  const text = JSON.stringify(schema);
  assert.ok(text.includes("t2uay3k.sj1i4kz"), "the image tool's namespace is kept as evidence");
  assert.ok(!text.includes("zebracat"), "a user author's name never appears");
  const userName = schema.find((entry) => entry.path === "user.author.name");
  assert.deepEqual(JSON.parse(JSON.stringify(userName)), { path: "user.author.name", type: "string", length: 8 });
});
