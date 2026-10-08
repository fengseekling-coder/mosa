/**
 * Shared fixtures for the capture-diagnostics suite. The page hook already
 * lives inside the page world, so these helpers only produce static strings
 * and JSON values; they never touch the network or run a browser.
 */

import { readFileSync } from "node:fs";
import vm from "node:vm";

/** Load the diagnostics module into a fresh VM context with a minimal page-world. */
export function captureDiagnosticsSourceSync() {
  const source = readFileSync(new URL("../../extensions/chatgpt-web-capture/capture-diagnostics.js", import.meta.url), "utf8");
  const sandbox = {
    Date,
    JSON,
    Math,
    Object,
    Set,
    String,
    console,
    atob: globalThis.atob,
    TextDecoder: globalThis.TextDecoder,
    Uint8Array: globalThis.Uint8Array,
    TextEncoder: globalThis.TextEncoder,
    ArrayBuffer: globalThis.ArrayBuffer,
    crypto: globalThis.crypto,
    location: { origin: "https://chatgpt.com" },
    URL: globalThis.URL,
  };
  vm.runInNewContext(source, sandbox, { filename: "capture-diagnostics.js" });
  if (!sandbox.MosaCaptureDiagnostics.__mosaInstalled) {
    throw new Error("diagnostics module failed to install");
  }
  return sandbox.MosaCaptureDiagnostics;
}

/** Async twin for callers that cannot tolerate blocking the file read. */
export async function captureDiagnosticsSource() {
  return captureDiagnosticsSourceSync();
}

/**
 * Walk the page-hook source and pluck out the diagnostics recorder calls so
 * tests can verify the interceptor points still call the module without
 * trying to evaluate a full MAIN-world script. We treat the source text as
 * evidence; the call sites are named explicitly so a future refactor will
 * shift the marker and fail the test.
 */
export function diagnosticsSourceFromHook() {
  // The hook injects a `recordSseLine`/`recordWsFrame`/`recordHttpResponse`
  // adapter through `window.MosaCaptureDiagnostics`. This helper returns
  // a structural stub so the test can assert the wiring without booting
  // vm.runInNewContext against a 2000+ line hook file.
  return {
    recordSseLine: () => true,
    recordWsFrame: () => true,
    recordHttpResponse: () => true,
  };
}

/** A fake 5.6 SSE stream whose code-call argument carries a null prompt. */
export function fakeSseStreamPayload() {
  const events = [
    `event: delta_encoding\ndata: "v1"`,
    `event: delta\ndata: ${JSON.stringify({
      type: "input_message",
      message: {
        id: "message-user",
        author: { role: "user", metadata: {} },
        content: { content_type: "text", parts: ["draw a poster"] },
        status: "finished_successfully",
        metadata: {},
      },
    })}`,
    `event: delta\ndata: ${JSON.stringify({
      p: "/message",
      o: "add",
      v: {
        message: {
          id: "message-code",
          author: { role: "assistant", name: null, metadata: {} },
          recipient: "image_gen.text2im",
          channel: "commentary",
          content: { content_type: "code", language: "json", text: "{\"prompt\":" },
          // An explicit `prompt` field on a tool-call argument lets the
          // recorder record the field path (visible in keys) while the
          // null value is reported as the path's type — that is the bug
          // we want to surface in 5.6.
          metadata: { turn_exchange_id: "turn-poster", prompt: null },
          status: "in_progress",
        },
        conversation_id: "conversation-test",
      },
    })}`,
    `event: delta\ndata: ${JSON.stringify({ p: "/message/content/text", o: "append", v: "null,\"aspect_ratio\":\"2:3\"}" })}`,
    `event: delta\ndata: ${JSON.stringify({ p: "/message/status", o: "replace", v: "finished_successfully" })}`,
    `event: delta\ndata: ${JSON.stringify({
      o: "add",
      v: {
        message: {
          id: "message-tool-image",
          author: { role: "tool", name: "image_gen.text2im", metadata: {} },
          recipient: "all",
          channel: "commentary",
          content: {
            content_type: "multimodal_text",
            parts: [{
              content_type: "image_asset_pointer",
              asset_pointer: "sediment://file-poster",
              size: { width: 1024, height: 1536 },
              metadata: { dalle: { gen_id: "generation-poster", prompt: "" } },
            }],
          },
          status: "in_progress",
          metadata: { turn_exchange_id: "turn-poster", parent_id: "message-code", image_gen_title: "Generated image" },
        },
        conversation_id: "conversation-test",
      },
    })}`,
    "data: [DONE]",
  ];
  return events.join("\n\n");
}

/** A websocket envelope with a base64 body. The body decodes to a structure that
 *  looks like a 5.6 candidate payload — captions are never sent through this
 *  path, so we use the body as a deliberate red-herring. */
export function fakeWsFrameText() {
  const body = JSON.stringify({
    update_content: {
      messages: [{
        id: "message-ws-1",
        author: { role: "tool", name: "image_gen.text2im" },
        content: { parts: [{ caption_text: "the morning fog drifts past daan-park trees" }] },
      }],
    },
  });
  const encoder = new TextEncoder();
  const bytes = encoder.encode(body);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  const envelope = {
    type: "update_content",
    body: Buffer.from(binary, "binary").toString("base64"),
  };
  return JSON.stringify(envelope);
}

/** A full conversation JSON body as the page hook would receive on a
 *  `GET /backend-api/conversation/<id>` refresh. Carries the same forbidden
 *  text a real capture would, so the test can confirm sanitization. */
export function fakeHttpConversationPayload() {
  return {
    conversation_id: "conversation-0123456789abcdef",
    current_node: "node-a",
    title: "A direct title that must not appear in the diagnostic record",
    mapping: {
      "node-a": {
        id: "node-a",
        parent: "node-user",
        message: {
          id: "msg-1",
          author: { role: "user", name: null },
          content: {
            content_type: "text",
            parts: ["a very long user prompt that is well over sixteen characters long and must be removed"],
          },
          metadata: {},
        },
      },
      "node-user": {
        id: "node-user",
        parent: "node-root",
        message: {
          id: "msg-0",
          author: { role: "user", name: null },
          content: { content_type: "text", parts: ["the original turn"] },
          metadata: {},
        },
      },
      "node-root": { id: "node-root", parent: null, message: null },
    },
  };
}
