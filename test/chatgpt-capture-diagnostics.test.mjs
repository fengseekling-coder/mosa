import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import vm from "node:vm";

import {
  captureDiagnosticsSourceSync,
  diagnosticsSourceFromHook,
  fakeSseStreamPayload,
  fakeWsFrameText,
  fakeHttpConversationPayload,
} from "./helpers/capture-diagnostics-fixtures.mjs";

test("summarizes a patch frame to paths, types and lengths without keeping the payload", () => {
  const api = captureDiagnosticsSourceSync();
  const summary = api.summarizeSsePatch({
    p: "/message/metadata/dalle",
    o: "append",
    v: {
      prompt: "Model caption: a candid street photograph of a neon alley at night",
      revised_prompt: "yes a revised prompt that is well over sixteen characters long",
      caption: "the actual leaked caption text to detect in the output",
    },
  });
  const json = JSON.stringify(summary);
  // Every literal from the input must never appear in the output. The value
  // object carries forbidden terms across multiple fields to verify the
  // sanitizer walks the whole structure, not just the top-level keys.
  for (const forbidden of [
    "candid street photograph",
    "neon alley at night",
    "revised prompt that is well",
    "leaked caption text to detect",
  ]) {
    assert.ok(!json.includes(forbidden), `forbidden literal must be dropped: ${forbidden}`);
  }
  assert.equal(summary.type, "patch");
  assert.equal(summary.op, "append");
  assert.equal(summary.path, "/message/metadata/dalle");
});

test("string values over the sixteen-character limit are dropped unless the field name is allow-listed", () => {
  const api = captureDiagnosticsSourceSync();
  const allowed = api.summarizePayload({
    model_slug: "this-is-a-model-slug-name-with-more-than-sixteen-characters",
    role: "assistant",
    long: "this string is definitely longer than the sixteen character ceiling",
    short: "ok",
    very_long: "x".repeat(120),
    // intentionally absent the empty case
  });
  const allowedJson = JSON.stringify(allowed);
  // Allow-list values are truncated to 80 chars but never rejected.
  assert.match(allowedJson, /model_slug/);
  assert.match(allowedJson, /role/);
  assert.match(allowedJson, /assistant/);
  // Long non-allow-listed strings lose their text but keep a length marker.
  const longLength = "this string is definitely longer than the sixteen character ceiling".length;
  assert.match(allowedJson, new RegExp(`"path":"long","type":"string","length":${longLength}`));
  assert.doesNotMatch(allowedJson, /this string is definitely longer/);
  // Primitive allow-list keeps short strings under the ceiling.
  assert.match(allowedJson, /"path":"short"/);
  // The very-long field is recorded as a length-only entry (no value).
  assert.match(allowedJson, new RegExp(`"path":"very_long","type":"string","length":120`));
  // Strings with no content (empty / whitespace-only) are entirely skipped
  // so the receiver does not see noise.
  const emptyAllowed = api.summarizePayload({ empty: "", whitespace: "   " });
  const emptyJson = JSON.stringify(emptyAllowed);
  assert.doesNotMatch(emptyJson, /"path":"empty"/);
  assert.doesNotMatch(emptyJson, /"path":"whitespace"/);
});

test("strings without an allow-list match drop the value and keep only the length", () => {
  const api = captureDiagnosticsSourceSync();
  const out = api.summarizePayload({ short_code: "ABC123" });
  const json = JSON.stringify(out);
  // short_code is not on the allow-list, so the text must be discarded even
  // when it is short. A title like "水彩橘猫绘画" must not survive under any
  // name; downstream readers only see a path, type, and length.
  assert.doesNotMatch(json, /ABC123/);
  const entry = out.find((e) => e.path === "short_code");
  assert.ok(entry, "a length-only entry should still exist");
  assert.equal(entry.type, "string");
  assert.equal(entry.length, "ABC123".length);
});

test("string values flagged as prompt-like are reduced to length only", () => {
  const api = captureDiagnosticsSourceSync();
  const promptText = "user input pasted by themself, definitely over sixteen chars";
  const out = api.summarizePayload({ caption: promptText });
  const json = JSON.stringify(out);
  assert.doesNotMatch(json, /user input pasted/);
  assert.match(json, new RegExp(`"path":"caption","type":"string","length":${promptText.length}`));
});

test("Model caption marker is preserved as a hint without text", () => {
  const api = captureDiagnosticsSourceSync();
  const out = api.summarizePayload({ caption_text: "Model caption: huge caption describing the image …" });
  const json = JSON.stringify(out);
  assert.match(json, /model-caption/);
  assert.doesNotMatch(json, /huge caption describing the image/);
});

test("summarizes a SSE data line with the patch op recorded and the path normalized", () => {
  const api = captureDiagnosticsSourceSync();
  const dataLine = `data: ${JSON.stringify({ p: "/message/metadata", o: "append", v: { prompt: "long prompt text we must never see again" } })}`;
  const summary = api.summarizeSseLine(dataLine);
  assert.ok(summary, "SSE data lines must produce a summary");
  assert.equal(summary.type, "patch");
  assert.equal(summary.op, "append");
  assert.equal(summary.path, "/message/metadata");
  assert.ok(!JSON.stringify(summary).includes("long prompt text"));
});

test("summarizes a websocket frame envelope, including the decoded body schema, without leaking the body", () => {
  const api = captureDiagnosticsSourceSync();
  const text = fakeWsFrameText();
  const summary = api.summarizeWsFrame(text);
  assert.ok(summary);
  assert.equal(summary.type, "ws");
  assert.equal(summary.envelopeType, "update_content");
  assert.ok(Array.isArray(summary.schema));
  assert.ok(Array.isArray(summary.bodySchema));
  // The fake body carries a caption that must never reappear in the summary.
  assert.ok(!JSON.stringify(summary).includes("foggy morning in Taipei"));
  assert.ok(!JSON.stringify(summary).includes("daan-park"));
});

test("summarizes an HTTP conversation response with a safe url and a structural schema", () => {
  const api = captureDiagnosticsSourceSync();
  const fakeUrl = "https://chatgpt.com/backend-api/conversation/68d5b8c0-1234-5678-9abc-def012345678?sig=token-shhh";
  const summary = api.summarizeHttpResponse(fakeUrl, "application/json", fakeHttpConversationPayload());
  assert.equal(summary.type, "http");
  assert.equal(summary.contentType, "application/json");
  assert.equal(summary.url, "https://chatgpt.com/backend-api/conversation/<id>");
  // Original sig parameter is gone.
  assert.ok(!summary.url.includes("token-shhh"));
  assert.ok(Array.isArray(summary.schema));
});

test("isEnabled can be toggled and disables recording instantly", () => {
  const api = captureDiagnosticsSourceSync();
  api.setEnabled(true);
  assert.ok(api.isEnabled());
  api.setEnabled(false);
  api.recordFrame("conversation-test", { source: "sse", type: "patch", op: "append" });
  // After disabling, frames are not buffered; a snapshot is empty.
  api.setEnabled(true);
  api.recordFrame("conversation-test", { source: "sse", type: "patch", op: "append" });
  const snapshot = api.snapshotFor("conversation-test", { windowMs: 1_000_000 });
  assert.ok(snapshot, "frames recorded after re-enabling are still in the buffer");
  assert.equal(snapshot.frames.length, 1);
});

test("trims the conversation buffer at 400 frames and keeps the most recent", () => {
  const api = captureDiagnosticsSourceSync();
  api.setEnabled(true);
  for (let index = 0; index < api.MAX_FRAMES_PER_CONVERSATION + 50; index += 1) {
    api.recordFrame("conversation-test", { source: "http", type: "http", url: "https://chatgpt.com/backend-api/conversation/<id>" });
  }
  const snapshot = api.snapshotFor("conversation-test", { windowMs: 60_000 });
  assert.ok(snapshot, "the buffer should still have frames after trimming");
  assert.ok(snapshot.frames.length <= api.MAX_FRAMES_PER_CONVERSATION);
  assert.ok(api.counters().truncated >= 50, "trimming must increment the truncated counter");
});

test("control captures are recorded roughly ten percent of the time when prompt is available", () => {
  const api = captureDiagnosticsSourceSync();
  api.setEnabled(true);
  let recordedControls = 0;
  for (let index = 0; index < 200; index += 1) {
    const captureKey = `conv-test:message-${index}:file-poster`;
    api.markCapture(captureKey, "conv-test", `message-${index}`, true);
    const finished = api.finalizeCapture("conv-test", captureKey);
    if (finished && finished.control === true && !finished.skipped) recordedControls += 1;
  }
  // The sample ratio is 0.1; allow a generous band so the test does not flake.
  assert.ok(recordedControls >= 5 && recordedControls <= 60, `expected ~20 controls, got ${recordedControls}`);
});

test("prompt-less captures are always recorded and get the conversation's recent frames", () => {
  const api = captureDiagnosticsSourceSync();
  api.setEnabled(true);
  api.recordFrame("conv-1", { source: "sse", type: "patch", op: "append", path: "/message/metadata", t: Date.now() });
  api.recordFrame("conv-1", { source: "ws", type: "ws", envelopeType: "update_content", t: Date.now() });
  api.recordFrame("conv-1", { source: "http", type: "http", url: "https://chatgpt.com/backend-api/conversation/<id>", t: Date.now() });
  api.markCapture("conv-1:msg-a:file-1", "conv-1", "msg-a", false);
  const finished = api.finalizeCapture("conv-1", "conv-1:msg-a:file-1");
  assert.ok(finished && finished.snapshot);
  assert.equal(finished.snapshot.frames.length, 3);
  const sources = new Set(finished.snapshot.frames.map((frame) => frame.source));
  assert.ok(sources.has("sse") && sources.has("ws") && sources.has("http"));
});

test("integration: a real SSE 5.6-style stream emits a diagnostic record with a prompt-null path", async () => {
  const api = captureDiagnosticsSourceSync();
  // The fixture mimics the 5.6 SSE shape with a prompt: null call argument.
  const sseText = fakeSseStreamPayload();
  let recorded = 0;
  for (const line of sseText.split("\n")) {
    if (!line.trim().startsWith("data:")) continue;
    api.setEnabled(true);
    api.recordFrame("conversation-test", api.summarizeSseLine(line));
    recorded += 1;
  }
  api.markCapture("conversation-test:msg-tool-image:file-poster", "conversation-test", "msg-tool-image", false);
  const finished = api.finalizeCapture("conversation-test", "conversation-test:msg-tool-image:file-poster");
  assert.ok(finished && finished.snapshot, "a prompt-less capture must always produce a snapshot");
  const flat = JSON.stringify(finished.snapshot.frames);
  assert.ok(flat.includes("prompt"), "the snapshot must record that the prompt field existed in the SSE stream");
  assert.ok(flat.includes("null"), "the prompt path's type must be reported as null");
});

test("integration: harness-level hook exposure of the diagnostics helper covers SSE / WS / HTTP", () => {
  const helper = diagnosticsSourceFromHook();
  assert.ok(helper);
  assert.ok(typeof helper.recordSseLine === "function");
  assert.ok(typeof helper.recordWsFrame === "function");
  assert.ok(typeof helper.recordHttpResponse === "function");
});
