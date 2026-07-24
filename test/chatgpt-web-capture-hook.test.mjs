import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import vm from "node:vm";

const hookSource = await readFile(new URL("../extensions/chatgpt-web-capture/page-hook.js", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../extensions/chatgpt-web-capture/manifest.json", import.meta.url), "utf8"));
const backgroundSource = await readFile(new URL("../extensions/chatgpt-web-capture/background.js", import.meta.url), "utf8");
const contentSource = await readFile(new URL("../extensions/chatgpt-web-capture/content.js", import.meta.url), "utf8");
const optionsSource = await readFile(new URL("../extensions/chatgpt-web-capture/options.js", import.meta.url), "utf8");
const optionsHtml = await readFile(new URL("../extensions/chatgpt-web-capture/options.html", import.meta.url), "utf8");

function createHookHarness(payload, conversationId = "conversation-test") {
  const events = [];
  const window = {
    fetch: async () => ({
      clone: () => ({ text: async () => JSON.stringify(payload) }),
    }),
    postMessage: (event) => events.push(event),
  };
  function MockXHR() {}
  MockXHR.prototype.open = () => {};
  MockXHR.prototype.send = () => {};

  vm.runInNewContext(hookSource, {
    Date,
    JSON,
    Object,
    Set,
    String,
    URL,
    XMLHttpRequest: MockXHR,
    document: { documentElement: {}, addEventListener: () => {} },
    location: { pathname: `/c/${conversationId}` },
    window,
  }, { filename: "page-hook.js" });

  return {
    events,
    async harvest() {
      await window.fetch("https://chatgpt.com/backend-api/conversation/test");
      await setImmediate();
    },
  };
}

function generationEvents(harness) {
  return harness.events.filter((event) => event.type === "generation-meta" && event.payload?.prompt);
}

test("installs the page hook in the main world before ChatGPT page scripts", () => {
  const hook = manifest.content_scripts.find((entry) => entry.js?.includes("page-hook.js"));
  assert.equal(hook?.run_at, "document_start");
  assert.equal(hook?.world, "MAIN");
  assert.deepEqual(hook?.js, ["page-hook.js"]);
});

test("uses safe local extension settings without a public Token default", () => {
  assert.match(backgroundSource, /mosaBaseUrl:\s*"http:\/\/127\.0\.0\.1:43517"/);
  assert.match(backgroundSource, /mosaToken:\s*""/);
  assert.doesNotMatch(backgroundSource, /mosaToken:\s*"mosa-web-capture-dev"/);
  assert.match(backgroundSource, /chrome\.storage\.local\.get/);
  assert.match(backgroundSource, /chrome\.storage\.local\.set/);
  assert.match(contentSource, /chrome\.storage\.local\.set/);
  assert.doesNotMatch(contentSource, /chrome\.storage\.sync\.set/);
  assert.match(optionsSource, /chrome\.storage\.local\.set/);
  assert.match(optionsHtml, /type="password"/);
});

test("binds revised prompts to ChatGPT Estuary cid/id keys", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      bangkok: {
        message: {
          id: "message-bangkok",
          content: { parts: [{ asset_pointer: "file-service://file-bangkok" }] },
          metadata: { dalle: { revised_prompt: "red sun" } },
        },
      },
    },
  });

  await harness.harvest();

  assert.deepEqual(generationEvents(harness).map((event) => ({
    imageKey: event.payload.imageKey,
    assetId: event.payload.assetId,
    promptStatus: event.payload.promptStatus,
    prompt: event.payload.prompt,
  })), [{
    imageKey: "estuary:conversation-test:file-bangkok",
    assetId: "file-bangkok",
    promptStatus: "generation-tool-prompt",
    prompt: "red sun",
  }]);
});

test("keeps prompts separate when Estuary images share a pathname", async () => {
  const proxyUrl = (assetId) => `https://chatgpt.com/backend-api/estuary/content?cid=conversation-test&id=${assetId}&sig=signed-value`;
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      bangkok: {
        message: {
          id: "message-bangkok",
          content: { parts: [{ asset_pointer: "file-service://file-bangkok", image_url: proxyUrl("file-bangkok") }] },
          metadata: { dalle: { revised_prompt: "A detailed travel poster for Bangkok with saffron temples, red typography, geometric clouds, and a premium editorial layout." } },
        },
      },
      shanghai: {
        message: {
          id: "message-shanghai",
          content: { parts: [{ asset_pointer: "file-service://file-shanghai", image_url: proxyUrl("file-shanghai") }] },
          metadata: { dalle: { revised_prompt: "A detailed travel poster for Shanghai with neon skyline reflections, blue typography, a river promenade, and an editorial print layout." } },
        },
      },
    },
  });

  await harness.harvest();

  const byKey = new Map(generationEvents(harness).map((event) => [event.payload.imageKey, event.payload.prompt]));
  assert.equal(byKey.get("estuary:conversation-test:file-bangkok"), "A detailed travel poster for Bangkok with saffron temples, red typography, geometric clouds, and a premium editorial layout.");
  assert.equal(byKey.get("estuary:conversation-test:file-shanghai"), "A detailed travel poster for Shanghai with neon skyline reflections, blue typography, a river promenade, and an editorial print layout.");
  assert.equal(byKey.size, 2);
});

test("binds a Model caption in the same tool message when dalle.prompt is blank", async () => {
  const caption = "Model caption: A detailed retro travel poster for Chengdu, China, with a cream field, bold red and black Art Deco typography, illustrated city vignettes, a skyline strip, and an editorial print layout.";
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      chengdu: {
        message: {
          id: "message-chengdu",
          author: { role: "tool" },
          content: {
            content_type: "multimodal_text",
            parts: [
              caption,
              {
                asset_pointer: "sediment://file-chengdu",
                metadata: { dalle: { prompt: "" } },
              },
            ],
          },
        },
      },
    },
  });

  await harness.harvest();

  assert.deepEqual(generationEvents(harness).map((event) => ({
    imageKey: event.payload.imageKey,
    assetId: event.payload.assetId,
    promptStatus: event.payload.promptStatus,
    prompt: event.payload.prompt,
  })), [{
    imageKey: "estuary:conversation-test:file-chengdu",
    assetId: "file-chengdu",
    promptStatus: "visible-caption",
    prompt: caption,
  }]);
});

test("does not attach a prompt from one message to an unrelated image message", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      promptOnly: {
        message: {
          id: "message-prompt",
          content: { parts: ["Image generation complete"] },
          metadata: { dalle: { revised_prompt: "A richly detailed landscape illustration with a misty mountain valley, ceramic blue palette, morning light, and cinematic composition." } },
        },
      },
      imageOnly: {
        message: {
          id: "message-image",
          content: { parts: [{ asset_pointer: "file-service://file-unrelated" }] },
        },
      },
    },
  });

  await harness.harvest();

  assert.equal(generationEvents(harness).some((event) => event.payload.imageKey === "estuary:conversation-test:file-unrelated"), false);
});
