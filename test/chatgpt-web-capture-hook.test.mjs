import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import vm from "node:vm";

const hookSource = await readFile(new URL("../extensions/chatgpt-web-capture/page-hook.js", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../extensions/chatgpt-web-capture/manifest.json", import.meta.url), "utf8"));
const backgroundSource = await readFile(new URL("../extensions/chatgpt-web-capture/background.js", import.meta.url), "utf8");
const contentSource = await readFile(new URL("../extensions/chatgpt-web-capture/content.js", import.meta.url), "utf8");
const generationRegistrySource = await readFile(new URL("../extensions/chatgpt-web-capture/generation-registry.js", import.meta.url), "utf8");
const contentCss = await readFile(new URL("../extensions/chatgpt-web-capture/content.css", import.meta.url), "utf8");
const optionsSource = await readFile(new URL("../extensions/chatgpt-web-capture/options.js", import.meta.url), "utf8");
const optionsHtml = await readFile(new URL("../extensions/chatgpt-web-capture/options.html", import.meta.url), "utf8");
const providerPolicySource = await readFile(new URL("../extensions/chatgpt-web-capture/provider-policy.js", import.meta.url), "utf8");
const providerSource = await readFile(new URL("../extensions/chatgpt-web-capture/provider-sites.js", import.meta.url), "utf8");

function createHookHarness(payload, conversationId = "conversation-test", options = {}) {
  const events = [];
  const requestedUrls = [];
  const requestedInits = [];
  let messageListener = null;
  const documentElement = { dataset: {} };
  const window = {
    fetch: async (url, init) => {
      requestedUrls.push(String(url));
      requestedInits.push(init || null);
      if (typeof options.respond === "function") {
        const override = options.respond(String(url), init);
        if (override) return override;
      }
      return {
        ok: true,
        clone: () => ({ text: async () => JSON.stringify(payload) }),
        text: async () => JSON.stringify(payload),
      };
    },
    addEventListener: (type, listener) => {
      if (type === "message") messageListener = listener;
    },
    postMessage: (event) => events.push(event),
    WebSocket: class MockWebSocket {
      constructor(url) {
        this.url = url;
        this.messageListeners = [];
      }

      addEventListener(type, listener) {
        if (type === "message") this.messageListeners.push(listener);
      }

      emit(data) {
        for (const listener of this.messageListeners) listener({ data });
      }
    },
  };
  function MockXHR() {}
  MockXHR.prototype.open = () => {};
  MockXHR.prototype.send = () => {};
  MockXHR.prototype.setRequestHeader = () => {};

  vm.runInNewContext(hookSource, {
    Date,
    JSON,
    Object,
    Set,
    String,
    URL,
    XMLHttpRequest: MockXHR,
    // Base64 and UTF-8 decoding are page APIs the hook needs for socket frames.
    atob: globalThis.atob,
    TextDecoder: globalThis.TextDecoder,
    Uint8Array: globalThis.Uint8Array,
    ArrayBuffer: globalThis.ArrayBuffer,
    document: { documentElement, addEventListener: () => {} },
    location: { origin: "https://chatgpt.com", pathname: `/c/${conversationId}` },
    window,
  }, { filename: "page-hook.js" });

  const bridgeChannel = String(documentElement.dataset.mosaPageHookChannel || "");
  assert.ok(bridgeChannel, "page hook should publish a per-document bridge channel");

  if (options.captureEnabled !== false && messageListener) {
    messageListener({
      source: window,
      data: {
        source: "mosa-chatgpt-capture",
        channel: bridgeChannel,
        type: "set-capture-enabled",
        payload: { enabled: true },
      },
    });
  }

  return {
    events,
    requestedUrls,
    requestedInits,
    async harvest(init) {
      await window.fetch("https://chatgpt.com/backend-api/conversation/test", init);
      await setImmediate();
    },
    async socketFrame(data) {
      const socket = new window.WebSocket("wss://chatgpt.com/client/hubs/conversations");
      socket.emit(data);
      await setImmediate();
      await setImmediate();
    },
    async refreshCurrentConversation() {
      assert.ok(messageListener, "page hook should listen for refresh requests");
      messageListener({
        source: window,
        data: { source: "mosa-chatgpt-capture", channel: bridgeChannel, type: "refresh-current-conversation" },
      });
      await setImmediate();
      await setImmediate();
    },
  };
}

function generationEvents(harness) {
  return harness.events.filter((event) => event.type === "generation-meta" && event.payload?.prompt);
}

function createGenerationRegistryHarness() {
  const sandbox = {};
  vm.runInNewContext(generationRegistrySource, sandbox, { filename: "generation-registry.js" });
  return sandbox.MosaGenerationRegistry.createGenerationRegistry({
    imageLookupKeys: (imageUrl, meta = {}) => {
      const keys = [];
      if (meta.imageKey) keys.push(meta.imageKey);
      if (meta.assetId) keys.push(`asset:${meta.assetId}`);
      if (imageUrl) keys.push(`url:${imageUrl}`);
      return [...new Set(keys)];
    },
    promptQuality: (entry) => Number(entry.promptPriority || 0) * 1_000_000 + String(entry.prompt || "").length,
  });
}

test("installs the page hook in the main world before ChatGPT page scripts", () => {
  const hook = manifest.content_scripts.find((entry) => entry.js?.includes("page-hook.js"));
  assert.equal(hook?.run_at, "document_start");
  assert.equal(hook?.world, "MAIN");
  assert.deepEqual(hook?.js, ["page-hook.js"]);
});

test("declares the supported Google media sites and provider content script", () => {
  assert.equal(manifest.version, "0.15.4");
  assert.deepEqual(
    manifest.content_scripts.find((entry) => entry.js?.includes("provider-sites.js"))?.matches,
    ["https://gemini.google.com/*", "https://labs.google/*", "https://aistudio.google.com/*"],
  );
  for (const host of [
    "https://gemini.google.com/*",
    "https://labs.google/*",
    "https://aistudio.google.com/*",
    "https://*.googleusercontent.com/*",
    "https://storage.googleapis.com/*",
    "https://flow-content.google/*",
  ]) assert.ok(manifest.host_permissions.includes(host), `missing ${host}`);
  assert.match(providerPolicySource, /host === "gemini\.google\.com"/);
  assert.match(providerPolicySource, /host === "labs\.google"/);
  assert.match(providerPolicySource, /host === "aistudio\.google\.com"/);
});

test("Google adapters capture visible images and supported Flow / AI Studio videos with bounded Prompt lookup", () => {
  const executableProviderSource = providerSource.replace(/\/\/.*$/gm, "");
  assert.match(providerSource, /const IMAGE_HOSTS/);
  assert.match(providerSource, /getBoundingClientRect/);
  assert.match(providerSource, /document\.images/);
  assert.match(providerSource, /document\.querySelectorAll\?\.\("video"\)/);
  assert.match(providerSource, /function flowMediaIdFromImage\(img\)/);
  assert.match(providerSource, /media\.getMediaUrlRedirect/);
  assert.match(providerSource, /function captureFlowMediaThumbnail\(img\)/);
  assert.match(providerSource, /if \(!mediaId \|\| !isVisibleFlowMediaThumbnail\(img\)\) return false;/,
    "Flow media capture must not require Prompt text to render before the media");
  assert.match(providerSource, /type: "mosa\.probeFlowMedia"/);
  assert.match(providerSource, /probe\.mediaKind === "video"/);
  assert.match(providerSource, /function isVisibleGeneratedVideo\(video\)/);
  assert.match(providerSource, /function isProviderGeneratedVideo\(provider, video\)/);
  assert.match(providerSource, /AI_STUDIO_VIDEO_PATH = \/\^\\\/generate-video/);
  assert.match(providerSource, /AI_STUDIO_VIDEO_PATH\.test\(String\(location\.pathname/);
  assert.match(providerSource, /document\.addEventListener\("loadedmetadata", \(\) => \{ if \(autoCapture\) scheduleScan\(\); \}, true\)/);
  assert.match(providerSource, /document\.addEventListener\("loadeddata", \(\) => \{ if \(autoCapture\) scheduleScan\(\); \}, true\)/);
  assert.match(providerSource, /document\.addEventListener\("canplay", \(\) => \{ if \(autoCapture\) scheduleScan\(\); \}, true\)/);
  assert.match(providerSource, /"flow-content\.google"/);
  assert.match(providerSource, /media\?\.videoWidth \|\| media\?\.naturalWidth \|\| media\?\.width/);
  assert.match(providerSource, /media\?\.videoHeight \|\| media\?\.naturalHeight \|\| media\?\.height/);
  assert.match(providerSource, /sendCapture\(provider, source, video, \{ mediaKind: "video" \}\)/);
  assert.match(providerSource, /promptStatus: "not-available"/);
  assert.match(providerSource, /promptSource: video \? "provider-visible-video" : "provider-visible-image"/);
  assert.match(providerSource, /promptStatus: "provider-visible-prompt"/);
  assert.match(providerSource, /promptSource: "gemini-visible-user-prompt"/);
  assert.match(providerSource, /promptSource: "flow-visible-prompt"/);
  assert.match(providerSource, /promptSource: "google-ai-studio-visible-user-prompt"/);
  assert.match(providerSource, /function geminiVisibleUserPromptForImage\(image\)/);
  assert.match(providerSource, /ancestorWithTag\(image, "model-response"\)/);
  assert.match(providerSource, /String\(previous\.tagName \|\| ""\)\.toLowerCase\(\) === "user-query"/);
  assert.match(providerSource, /GEMINI_PROMPT_MAX_CHARS = 24_000/);
  assert.match(providerSource, /GEMINI_MAX_PREVIOUS_TURNS = 8/);
  assert.match(providerSource, /FLOW_PROMPT_ANCHOR = \/reuse\\s\+prompt\/i/);
  assert.match(providerSource, /FLOW_PROMPT_MAX_CHARS = 20_000/);
  assert.match(providerSource, /FLOW_PROMPT_MAX_ANCESTORS = 14/);
  assert.match(providerSource, /function flowNodeIsUiGlyph\(node\)/);
  assert.match(providerSource, /className\.includes\("material-symbol"\)/);
  assert.match(providerSource, /className\.includes\("google-symbol"\)/);
  assert.match(providerSource, /if \(flowNodeIsUiGlyph\(node\)\) return true/);
  assert.match(providerSource, /flowHasReusePromptAnchor/);
  assert.match(providerSource, /flowReusePromptAnchorCount/);
  assert.match(providerSource, /const buttonLike = tag === "button" \|\| tag === "a" \|\| role === "button" \|\| Boolean\(label\)/);
  assert.match(providerSource, /flowNearbyPromptCard/);
  assert.match(providerSource, /const reusePromptCards = promptCards\.filter/);
  assert.match(providerSource, /if \(reusePromptCards\.length === 1\)/);
  assert.doesNotMatch(providerSource, /!\/\\bprompt\\b\/i\.test\(raw\)/);
  assert.doesNotMatch(providerSource, /bestPrompt/);
  assert.doesNotMatch(providerSource, /console\.log/);
  assert.match(providerSource, /AI_STUDIO_PROMPT_MAX_CHARS = 24_000/);
  assert.match(providerSource, /AI_STUDIO_PROMPT_MAX_NODES = 12_000/);
  assert.match(providerSource, /AI_STUDIO_MAX_PREVIOUS_TURNS = 16/);
  assert.match(providerSource, /function aiStudioVisibleUserPromptForImage\(image\)/);
  assert.match(providerSource, /function isProviderGeneratedOutput\(provider, img\)/);
  assert.match(providerSource, /if \(!isProviderGeneratedOutput\(provider, img\)\) continue/);
  assert.match(providerSource, /provider === "gemini"/);
  assert.match(providerSource, /provider === "flow"/);
  assert.match(providerSource, /provider === "google-ai-studio"/);
  assert.match(providerSource, /ancestorWithTag\(image, "ms-chat-turn"\)/);
  assert.match(providerSource, /sessionContent\?\.classList\?\.contains\("chat-session-content"\)/);
  assert.match(providerSource, /directTurnContainer\(imageTurn, "model"\)/);
  assert.match(providerSource, /directTurnContainer\(turn, "user"\)/);
  assert.match(providerSource, /descendantsWithClass\(userContainer, "user-prompt-container"\)/);
  assert.match(providerSource, /previous = previous\.previousElementSibling/);
  assert.match(providerSource, /contenteditable/);
  assert.match(providerSource, /"textarea"/);
  assert.match(providerSource, /"mosa\.capture\.saveVideoWithPrompt"/);
  assert.match(providerSource, /function supportedImageUrl\(value\)/);
  assert.match(providerSource, /const PROMPT_RETRY_DELAYS = \[900, 2_700, 7_200, 15_000, 30_000\]/);
  assert.match(providerSource, /function schedulePromptRetry\(provider, source, mediaKind = "image", \{/);
  assert.match(providerSource, /lookupSourceUrl: lookupSource\?\.url \|\| source\.url/);
  assert.match(providerSource, /lookupMediaKind: "image"/);
  assert.match(providerSource, /type: "mosa\.upgradeMetadata"/);
  assert.match(providerSource, /sourceMediaUrl: state\.source\.url/);
  assert.match(providerSource, /function attemptPendingPromptUpgrades\(\)/);
  assert.match(providerSource, /characterData: false/);
  assert.match(providerSource, /attributeFilter: \["src", "srcset", "class", "aria-hidden", "hidden"\]/);
  assert.match(providerSource, /document\.addEventListener\("load", \(\) => \{ if \(autoCapture\) scheduleScan\(\); \}, true\)/);
  assert.match(providerSource, /function startProviderObserver\(\)/);
  assert.match(providerSource, /observer\?\.disconnect\(\)/);
  const providerSourceWithoutVideoQueries = executableProviderSource.replace(/document\.querySelectorAll\?\.\("video"\)/g, "");
  assert.doesNotMatch(providerSourceWithoutVideoQueries, /innerText|textContent|innerHTML|querySelectorAll|conversation/);
  assert.doesNotMatch(executableProviderSource, /document\.body\.innerText|document\.documentElement\.innerText/);
});

test("Google adapters read only eligible page-local bytes and keep CDN URLs remote", () => {
  assert.match(providerSource, /src\.startsWith\("blob:"\)/);
  assert.match(providerSource, /url\.origin !== location\.origin/);
  assert.match(providerSource, /isAllowedLocalImageUrl/);
  assert.match(providerSource, /FLOW_MEDIA_REDIRECT_PATH = "\/fx\/api\/trpc\/media\.getMediaUrlRedirect"/);
  assert.match(providerSource, /credentials: "same-origin"/);
  assert.match(providerSource, /const bytes = video \? await bytesFromVisibleVideo\(source, media\) : await bytesFromVisibleImage\(source, media\)/);
  assert.match(providerSource, /payload\.imageBase64 = bytes\.imageBase64/);
  assert.match(providerSource, /payload\.imageUrl = source\.url/);
  assert.match(providerSource, /if \(source\.kind === "local" && source\.url\.startsWith\("blob:"\)\) \{/);
  assert.match(providerSource, /!isVisibleGeneratedImage\(image\)/);
  assert.match(providerSource, /if \(source\?\.kind !== "local" \|\| !isVisibleGeneratedImage\(img\)\)/);
  assert.match(providerSource, /if \(!response\?\.ok\) seen\.delete\(source\.url\)/);
  assert.match(providerSource, /\.catch\(\(\) => seen\.delete\(source\.url\)\)/);
  assert.match(providerSource, /!changes\.autoCapture && !changes\.mosaBaseUrl && !changes\.mosaToken/);
  assert.match(providerSource, /seen\.clear\(\);/);
  assert.doesNotMatch(providerSource, /chrome\.cookies|document\.cookie|authorization/i);
});

test("Google adapter capture work is limited to two concurrent tasks", async () => {
  assert.match(providerSource, /const CAPTURE_CONCURRENCY = 2/);
  assert.match(providerSource, /return withCaptureSlot\(async \(\) => \{/);

  const helperSource = [
    /const CAPTURE_CONCURRENCY = 2;/.exec(providerSource)?.[0],
    /let captureInFlight = 0;/.exec(providerSource)?.[0],
    /const captureWaiters = \[\];/.exec(providerSource)?.[0],
    /async function withCaptureSlot\(task\) \{[\s\S]*?\n  \}/.exec(providerSource)?.[0],
  ].filter(Boolean).join("\n");
  assert.match(helperSource, /withCaptureSlot/);

  const context = { Promise };
  vm.runInNewContext(`${helperSource}\nthis.withCaptureSlot = withCaptureSlot;`, context, { filename: "provider-capture-limit.js" });

  let active = 0;
  let maxActive = 0;
  const releases = [];
  const tasks = Array.from({ length: 5 }, (_, index) => context.withCaptureSlot(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolveTask) => releases.push(resolveTask));
    active -= 1;
    return index;
  }));

  await setImmediate();
  assert.equal(active, 2);
  assert.equal(maxActive, 2);
  while (releases.length || active) {
    releases.shift()?.();
    await setImmediate();
  }
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4]);
  assert.equal(maxActive, 2);
});

test("uses safe local extension settings without a public Token default", () => {
  assert.equal(typeof manifest.key, "string");
  assert.ok(manifest.key.length > 300);
  assert.match(backgroundSource, /mosaBaseUrl:\s*"http:\/\/127\.0\.0\.1:43517"/);
  assert.match(backgroundSource, /mosaToken:\s*""/);
  assert.doesNotMatch(backgroundSource, /mosaToken:\s*"mosa-web-capture-dev"/);
  assert.match(backgroundSource, /DISCOVERY_PORTS = \[43517, 43518, 43519, 43520, 43521\]/);
  assert.match(backgroundSource, /async function discoverAndPairMosa\(\)/);
  assert.match(backgroundSource, /\/api\/web-capture\/pair/);
  assert.match(backgroundSource, /async function repairPairing\(\)/);
  assert.match(backgroundSource, /chrome\.storage\.local\.get/);
  assert.match(backgroundSource, /chrome\.storage\.local\.set/);
  assert.match(contentSource, /chrome\.storage\?\.local\?\.get\?\./);
  assert.doesNotMatch(contentSource, /chrome\.storage\.sync\.set/);
  assert.match(optionsSource, /chrome\.storage\.local\.set/);
  assert.match(optionsSource, /function normalizeBaseUrl\(value\)/);
  assert.match(optionsSource, /\["127\.0\.0\.1", "localhost"\]\.includes\(url\.hostname\)/);
  assert.match(optionsSource, /baseUrl = normalizeBaseUrl\(baseUrlEl\.value\.trim\(\) \|\| DEFAULTS\.mosaBaseUrl\)/);
  assert.match(optionsHtml, /type="password"/);
});

test("defaults capture off and keeps Chrome permissions minimal", () => {
  assert.deepEqual(manifest.permissions, ["storage", "contextMenus", "alarms"]);
  assert.equal(manifest.permissions.includes("activeTab"), false);
  assert.match(backgroundSource, /autoCapture:\s*false/);
  assert.match(optionsSource, /autoCapture:\s*false/);
  assert.match(contentSource, /let autoCapture = false/);
  assert.match(providerSource, /let autoCapture = false/);
  assert.match(optionsHtml, /默认关闭/);
  assert.match(backgroundSource, /if \(details\?\.reason === "install"\) await chrome\.runtime\.openOptionsPage\(\)/);
});

test("manual fallback controls cover ChatGPT images and Google videos", () => {
  assert.match(contentSource, /data-action="save-visible">保存当前图</);
  assert.match(contentSource, /data-action="save-all">保存全部大图</);
  assert.match(backgroundSource, /id: "mosa-save-video"/);
  assert.match(backgroundSource, /contexts: \["video"\]/);
  assert.match(providerSource, /"mosa\.capture\.saveVideoWithPrompt"/);
  assert.match(providerSource, /mediaKind: videoRequest \? "video" : "image"/);
});

test("ChatGPT hook stays dormant until capture is explicitly enabled", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      generated: {
        message: {
          id: "message-dormant",
          author: { role: "tool", name: "image_gen" },
          content: { parts: [{ asset_pointer: "sediment://file-dormant" }] },
        },
      },
    },
  }, "conversation-test", { captureEnabled: false });

  await harness.harvest();
  assert.equal(harness.events.some((event) => event.payload?.imageKey?.includes("file-dormant")), false);
  assert.match(hookSource, /if \(!isCaptureEnabled\(\)\) return response/);
  assert.match(hookSource, /if \(!isCaptureEnabled\(\)\) return;/);
});

test("ChatGPT generation asset hosts stay consistent across hook, content script, and manifest", () => {
  assert.ok(manifest.host_permissions.includes("https://*.blob.core.windows.net/*"));
  assert.match(hookSource, /blob\.core/);
  assert.match(contentSource, /"blob\.core\.windows\.net"/);
  assert.match(contentSource, /if \(!isLikelyGeneratedUrl\(imageUrl\)\) return;/);
});

test("ChatGPT startup and SPA conversation changes proactively recover missed generation metadata", () => {
  const bootStart = contentSource.indexOf("loadSettings().then(() => {");
  const intervalStart = contentSource.indexOf("autoScanInterval = setInterval", bootStart);
  const boot = contentSource.slice(bootStart, intervalStart);
  assert.ok(bootStart >= 0 && intervalStart > bootStart);
  assert.match(boot, /requestCurrentConversationRefresh\(null\);[\s\S]*scheduleScan\(true\);/);
  assert.match(contentSource, /if \(autoCapture && nextConversationId\) requestCurrentConversationRefresh\(null\);/);
  assert.match(contentSource, /function scheduleGenerationEvidenceRecovery\(candidate\)/);
  assert.match(contentSource, /enqueueDomFallback\(candidate\)/);
});

test("ChatGPT DOM hook reacts to both src and srcset changes", () => {
  assert.match(hookSource, /m\.attributeName === "src" \|\| m\.attributeName === "srcset"/);
  assert.match(hookSource, /attributeFilter: \["src", "srcset"\]/);
});

test("oversized ChatGPT metadata fails visibly while DOM fallback remains available", () => {
  assert.match(hookSource, /via === "conversation-refresh" \? 32_000_000 : 12_000_000/);
  assert.match(hookSource, /post\("harvest-skipped", \{ reason: "payload-too-large", size: text\.length, via \}\)/);
  assert.match(contentSource, /data\.type === "harvest-skipped"/);
  assert.match(contentSource, /会话元数据过大，已启用图片兜底/);
  assert.match(contentSource, /function enqueueDomFallback\(candidate\)/);
});

test("ChatGPT automatic capture work is limited to two concurrent tasks", async () => {
  const helperSource = [
    /const AUTO_CAPTURE_CONCURRENCY = 2;/.exec(contentSource)?.[0],
    /let autoCaptureInFlight = 0;/.exec(contentSource)?.[0],
    /const autoCaptureWaiters = \[\];/.exec(contentSource)?.[0],
    /async function withAutoCaptureSlot\(task\) \{[\s\S]*?\n  \}/.exec(contentSource)?.[0],
  ].filter(Boolean).join("\n");
  assert.match(helperSource, /withAutoCaptureSlot/);

  const context = { Promise };
  vm.runInNewContext(`${helperSource}\nthis.withAutoCaptureSlot = withAutoCaptureSlot;`, context, { filename: "chatgpt-capture-limit.js" });

  let active = 0;
  let maxActive = 0;
  const releases = [];
  const tasks = Array.from({ length: 5 }, (_, index) => context.withAutoCaptureSlot(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolveTask) => releases.push(resolveTask));
    active -= 1;
    return index;
  }));

  await setImmediate();
  assert.equal(active, 2);
  assert.equal(maxActive, 2);
  while (releases.length || active) {
    releases.shift()?.();
    await setImmediate();
  }
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4]);
  assert.equal(maxActive, 2);
});

test("ChatGPT recovery never captures or replays page authentication headers", () => {
  assert.doesNotMatch(hookSource, /forwardedHeaders|rememberRequestHeaders|oai-device-id|oai-client-version|oai-language/i);
  assert.match(hookSource, /function isInterestingResponseUrl\(value\)/);
  assert.doesNotMatch(hookSource, /chatgpt\\\.com\|openai\\\.com\|backend-api\|conversation\|images\?/);
});

test("archives an image-generation tool result even when ChatGPT omits its prompt", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      generated: {
        message: {
          id: "message-no-prompt",
          author: { role: "tool", name: "image_gen" },
          content: { parts: [{ asset_pointer: "sediment://file-no-prompt" }] },
        },
      },
    },
  });

  await harness.harvest();

  const generation = harness.events.find((event) => (
    event.type === "generation-meta"
    && event.payload?.imageKey === "estuary:conversation-test:file-no-prompt"
  ));
  assert.ok(generation, "the image tool result should still emit generation evidence");
  assert.equal(generation.payload.prompt, "");
  assert.equal(generation.payload.promptStatus, "not-available");
  assert.equal(generation.payload.isGeneration, true);
  assert.equal(generation.payload.generationContextId, "chatgpt:conversation-test:message-no-prompt");
});

test("ordinary conversation JSON containing data: is not misclassified as SSE", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      generated: {
        message: {
          id: "message-data-text",
          author: { role: "tool", name: "image_gen" },
          content: {
            parts: [
              "Model caption: poster with literal data: labels in the typography system and editorial lighting.",
              { asset_pointer: "sediment://file-data-text" },
            ],
          },
        },
      },
    },
  });

  await harness.harvest();

  assert.ok(harness.events.some((event) => (
    event.type === "generation-meta"
    && event.payload?.imageKey === "estuary:conversation-test:file-data-text"
  )));
});

test("keeps provider runtime ids separate from MOSA capture context ids", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-provider-ids",
    mapping: {
      generated: {
        message: {
          id: "message-provider-ids",
          response_id: "resp-web-observed",
          author: { role: "tool", name: "image_gen" },
          metadata: { tool_call_id: "call-web-observed" },
          content: { parts: [{ asset_pointer: "sediment://file-provider-ids" }] },
        },
      },
    },
  });

  await harness.harvest();
  const generation = harness.events.find((event) => (
    event.type === "generation-meta"
    && event.payload?.imageKey === "estuary:conversation-provider-ids:file-provider-ids"
  ));
  assert.ok(generation);
  assert.equal(generation.payload.generationContextId, "chatgpt:conversation-provider-ids:call-web-observed");
  assert.equal(generation.payload.providerToolCallId, "call-web-observed");
  assert.equal(generation.payload.providerGenerationCallId, "");
  assert.equal(generation.payload.providerResponseId, "resp-web-observed");
});

test("captures an explicit provider generation-call id without promoting a generic tool-call id", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-generation-call",
    mapping: {
      generated: {
        message: {
          id: "message-generation-call",
          author: { role: "tool", name: "image_gen" },
          metadata: {
            tool_call_id: "call-tool-generic",
            image_generation_call_id: "ig-web-explicit",
          },
          content: { parts: [{ asset_pointer: "sediment://file-generation-call" }] },
        },
      },
    },
  });

  await harness.harvest();
  const generation = harness.events.find((event) => (
    event.type === "generation-meta"
    && event.payload?.imageKey === "estuary:conversation-generation-call:file-generation-call"
  ));
  assert.ok(generation);
  assert.equal(generation.payload.providerToolCallId, "call-tool-generic");
  assert.equal(generation.payload.providerGenerationCallId, "ig-web-explicit");
});

test("preserves event-scoped conversation and generation-call identity through extension ingest", () => {
  assert.match(contentSource, /conversationId: String\(item\.conversationId \|\| item\.conversation_id \|\| ""\)/);
  assert.match(contentSource, /providerGenerationCallId: String\(item\.providerGenerationCallId \|\| item\.provider_generation_call_id \|\| ""\)/);
  assert.match(contentSource, /conversationId: resolved\.conversationId \|\| conversationIdFromUrl\(\)/);
  assert.match(contentSource, /providerGenerationCallId: resolved\.providerGenerationCallId \|\| ""/);
  assert.match(backgroundSource, /providerGenerationCallId: payload\.providerGenerationCallId \|\| ""/);
});

test("accepts an assistant-owned image_gen result when ChatGPT does not use role=tool", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      generated: {
        message: {
          id: "message-assistant-image-gen",
          author: { role: "assistant", name: "image_gen" },
          content: { parts: [{ asset_pointer: "sediment://file-assistant-image" }] },
        },
      },
    },
  });

  await harness.harvest();

  const generation = harness.events.find((event) => (
    event.type === "generation-meta"
    && event.payload?.imageKey === "estuary:conversation-test:file-assistant-image"
  ));
  assert.ok(generation);
  assert.equal(generation.payload.isGeneration, true);
});

test("treats image_gen dalle.prompt as a trusted generation prompt", async () => {
  const prompt = "red sun over mountains";
  const harness = createHookHarness({
    conversation_id: "conversation-dalle-prompt",
    mapping: {
      generated: {
        message: {
          id: "message-dalle-prompt",
          author: { role: "tool", name: "image_gen" },
          metadata: { dalle: { prompt } },
          content: { parts: [{ asset_pointer: "sediment://file-dalle-prompt" }] },
        },
      },
    },
  }, "conversation-dalle-prompt");

  await harness.harvest();
  const generation = harness.events.find((event) => event.payload?.assetId === "file-dalle-prompt");
  assert.equal(generation?.payload.prompt, prompt);
  assert.equal(generation?.payload.promptStatus, "generation-tool-prompt");
  assert.equal(generation?.payload.promptSource, "prompt");
});

test("recognizes dalle metadata as generation provenance when the tool name is omitted", async () => {
  const prompt = "red sun";
  const harness = createHookHarness({
    conversation_id: "conversation-dalle-unnamed",
    mapping: {
      generated: {
        message: {
          id: "message-dalle-unnamed",
          author: { role: "tool" },
          metadata: { dalle: { prompt } },
          content: { parts: [{ asset_pointer: "sediment://file-dalle-unnamed" }] },
        },
      },
    },
  }, "conversation-dalle-unnamed");

  await harness.harvest();
  const generation = harness.events.find((event) => event.payload?.assetId === "file-dalle-unnamed");
  assert.equal(generation?.payload.prompt, prompt);
  assert.equal(generation?.payload.promptStatus, "generation-tool-prompt");
  assert.equal(generation?.payload.isGeneration, true);
});

test("normalizes camelCase ChatGPT prompt and asset fields", async () => {
  const prompt = "A detailed editorial poster with blue type and warm evening light";
  const harness = createHookHarness({
    conversation_id: "conversation-camel-prompt",
    mapping: {
      generated: {
        message: {
          id: "message-camel-prompt",
          author: { role: "tool", name: "imageGen" },
          metadata: { revisedPrompt: prompt },
          content: { parts: [{ assetPointer: "sediment://file-camel-prompt" }] },
        },
      },
    },
  }, "conversation-camel-prompt");

  await harness.harvest();
  const generation = harness.events.find((event) => event.payload?.assetId === "file-camel-prompt");
  assert.equal(generation?.payload.prompt, prompt);
  assert.equal(generation?.payload.promptStatus, "generation-tool-prompt");
  assert.equal(generation?.payload.promptSource, "revised_prompt");
});

test("uses deterministic provider prompt priority instead of dropping equally trusted fields", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-prompt-priority",
    mapping: {
      generated: {
        message: {
          id: "message-prompt-priority",
          author: { role: "tool", name: "image_gen" },
          metadata: {
            generation_prompt: "lower-priority generation prompt",
            revised_prompt: "provider revised prompt wins",
          },
          content: { parts: [{ asset_pointer: "sediment://file-priority" }] },
        },
      },
    },
  }, "conversation-prompt-priority");

  await harness.harvest();
  const generation = harness.events.find((event) => event.payload?.assetId === "file-priority");
  assert.equal(generation?.payload.prompt, "provider revised prompt wins");
  assert.equal(generation?.payload.promptPriority, 700);
});

test("accepts a plain caption from an assistant-owned image_gen message", async () => {
  const prompt = "red sun";
  const harness = createHookHarness({
    conversation_id: "conversation-assistant-caption",
    mapping: {
      generated: {
        message: {
          id: "message-assistant-caption",
          author: { role: "assistant", name: "image_gen" },
          content: { parts: [{ asset_pointer: "sediment://file-assistant-caption" }, prompt] },
        },
      },
    },
  }, "conversation-assistant-caption");

  await harness.harvest();
  const generation = harness.events.find((event) => event.payload?.assetId === "file-assistant-caption");
  assert.equal(generation?.payload.prompt, prompt);
  assert.equal(generation?.payload.promptStatus, "visible-caption");
});

test("keeps revised prompt provenance in generic non-message response objects", async () => {
  const prompt = "A cinematic desert poster with bold type";
  const harness = createHookHarness({
    generation: {
      revisedPrompt: prompt,
      assetPointer: "sediment://file-generic-revised",
    },
  }, "conversation-generic-revised");

  await harness.harvest();
  const generation = harness.events.find((event) => event.payload?.assetId === "file-generic-revised");
  assert.equal(generation?.payload.prompt, prompt);
  assert.equal(generation?.payload.promptStatus, "generation-tool-prompt");
  assert.equal(generation?.payload.isGeneration, true);
});

test("generation registry binds late prompts by stable context and never downgrades the best provider prompt", () => {
  const sandbox = {};
  vm.runInNewContext(generationRegistrySource, sandbox, { filename: "generation-registry.js" });
  const registry = sandbox.MosaGenerationRegistry.createGenerationRegistry({
    imageLookupKeys: (imageUrl, meta = {}) => {
      if (meta.assetId) return [`asset:${meta.assetId}`];
      return imageUrl ? [`url:${imageUrl}`] : [];
    },
    promptQuality: (entry) => Number(entry.promptPriority || 0) * 1_000_000 + String(entry.prompt || "").length,
  });

  registry.remember({
    imageUrl: "https://images.example/generated.png",
    conversationId: "conversation-late",
    messageId: "message-late",
    providerGenerationCallId: "generation-call-late",
    isGeneration: true,
  });
  registry.remember({
    prompt: "provider revised prompt",
    promptStatus: "generation-tool-prompt",
    promptPriority: 700,
    conversationId: "conversation-late",
    messageId: "message-late",
    providerGenerationCallId: "generation-call-late",
  });
  registry.remember({
    prompt: "later but lower-quality caption that must not overwrite revised prompt",
    promptStatus: "visible-caption",
    promptPriority: 325,
    conversationId: "conversation-late",
    messageId: "message-late",
    providerGenerationCallId: "generation-call-late",
  });

  const resolved = registry.resolvedForImage("https://images.example/generated.png");
  assert.equal(resolved.prompt, "provider revised prompt");
  assert.equal(resolved.promptPriority, 700);
  assert.equal(resolved.isGeneration, true);
});

test("generation registry keeps sibling outputs distinct inside one tool call", () => {
  const registry = createGenerationRegistryHarness();
  registry.remember({
    assetId: "file-a",
    prompt: "prompt A",
    promptStatus: "generation-tool-prompt",
    promptPriority: 700,
    promptScope: "output",
    providerToolCallId: "call-shared",
    conversationId: "conversation-multi",
    messageId: "message-multi",
    isGeneration: true,
  });
  registry.remember({
    assetId: "file-b",
    prompt: "a longer prompt B that must stay on output B",
    promptStatus: "generation-tool-prompt",
    promptPriority: 700,
    promptScope: "output",
    providerToolCallId: "call-shared",
    conversationId: "conversation-multi",
    messageId: "message-multi",
    isGeneration: true,
  });

  const a = registry.resolvedForImage("", { assetId: "file-a" });
  const b = registry.resolvedForImage("", { assetId: "file-b" });
  assert.equal(a?.prompt, "prompt A");
  assert.equal(a?.assetId, "file-a");
  assert.equal(b?.prompt, "a longer prompt B that must stay on output B");
  assert.equal(b?.assetId, "file-b");
});

test("generation registry never binds a failed attempt prompt to a different retry call", () => {
  const registry = createGenerationRegistryHarness();
  registry.remember({
    prompt: "prompt from failed attempt A",
    promptStatus: "generation-tool-prompt",
    promptPriority: 700,
    promptScope: "attempt",
    generationStatus: "failed",
    providerGenerationCallId: "gen-a",
    conversationId: "conversation-retry",
    messageId: "message-retry",
    isGeneration: true,
  });
  registry.remember({
    assetId: "file-success",
    generationStatus: "completed",
    providerGenerationCallId: "gen-b",
    conversationId: "conversation-retry",
    messageId: "message-retry",
    isGeneration: true,
  });

  const success = registry.resolvedForImage("", { assetId: "file-success" });
  assert.equal(success?.prompt, "");
  assert.equal(success?.providerGenerationCallId, "gen-b");
  assert.equal(success?.generationStatus, "completed");
  assert.equal(registry.resolvedForMessage("conversation-retry", "message-retry"), null, "ambiguous retry messages must fail closed");
});

test("generation registry suppresses a failed shared prompt when a weak reused tool id later completes", () => {
  const registry = createGenerationRegistryHarness();
  registry.remember({
    prompt: "prompt belonging only to the failed weak-id attempt",
    promptStatus: "generation-tool-prompt",
    promptPriority: 700,
    promptScope: "attempt",
    generationStatus: "failed",
    providerToolCallId: "weak-reused-call",
    conversationId: "conversation-weak-retry",
    messageId: "message-weak-retry",
    isGeneration: true,
  });
  registry.remember({
    assetId: "file-weak-success",
    generationStatus: "completed",
    providerToolCallId: "weak-reused-call",
    conversationId: "conversation-weak-retry",
    messageId: "message-weak-retry",
    isGeneration: true,
  });

  const success = registry.resolvedForImage("", { assetId: "file-weak-success" });
  assert.equal(success?.prompt, "");
  assert.equal(success?.generationStatus, "completed");
  assert.equal(success?.providerToolCallId, "weak-reused-call");
});

test("generation registry never uses failed message-only prose as a later output prompt", () => {
  const registry = createGenerationRegistryHarness();
  registry.remember({
    prompt: "message-level text from a failed generation",
    promptStatus: "generation-tool-prompt",
    promptPriority: 700,
    promptScope: "message",
    generationStatus: "failed",
    conversationId: "conversation-message-retry",
    messageId: "message-message-retry",
    isGeneration: true,
  });
  registry.remember({
    assetId: "file-message-success",
    providerToolCallId: "message-retry-call",
    generationStatus: "completed",
    conversationId: "conversation-message-retry",
    messageId: "message-message-retry",
    isGeneration: true,
  });

  const success = registry.resolvedForImage("", { assetId: "file-message-success" });
  assert.equal(success?.prompt, "");
  assert.equal(success?.generationStatus, "completed");
});

test("attempt-scoped late prompts fan out to every saved output without collapsing output identity", () => {
  const registry = createGenerationRegistryHarness();
  for (const assetId of ["file-a", "file-b", "file-c"]) {
    registry.remember({
      assetId,
      providerToolCallId: "call-shared",
      conversationId: "conversation-fanout",
      messageId: "message-fanout",
      isGeneration: true,
    });
  }
  const promptEvent = {
    prompt: "one provider prompt shared by the whole generation attempt",
    promptStatus: "generation-tool-prompt",
    promptPriority: 700,
    promptScope: "attempt",
    providerToolCallId: "call-shared",
    conversationId: "conversation-fanout",
    messageId: "message-fanout",
    isGeneration: true,
  };
  registry.remember(promptEvent);

  const outputs = registry.resolvedOutputsForEntry(promptEvent);
  assert.equal(outputs.map((item) => item.assetId).sort().join(","), "file-a,file-b,file-c");
  assert.ok(outputs.every((item) => item.prompt === promptEvent.prompt));
  assert.equal(registry.debugSnapshot()[0].outputs.length, 3);
});

test("content capture uses stable generation context instead of time-window prompt guessing", () => {
  assert.match(contentSource, /function generationRegistryForPage\(\)/);
  assert.match(contentSource, /resolvedForImage/);
  assert.match(contentSource, /imageKeysForEntry/);
  assert.doesNotMatch(contentSource, /findRecentUnboundPrompt|recentPrompts/);
});

test("content capture waits for generation stability and upgrades every output independently", () => {
  assert.match(contentSource, /const AUTO_STABILITY_DELAY_MS = 900/);
  assert.match(contentSource, /const AUTO_IN_PROGRESS_STALE_MS = 6_000/);
  assert.match(contentSource, /const AUTO_PARTIAL_FALLBACK_MS = 15_000/);
  assert.match(contentSource, /function autoCandidateReadiness\(candidate, evidence, reason\)/);
  assert.match(contentSource, /if \(status === "in_progress"\)[\s\S]*age < AUTO_IN_PROGRESS_STALE_MS[\s\S]*return \{ ready: true, forceTerminalRefresh: false \};/);
  assert.match(contentSource, /if \(status === "partial"\)[\s\S]*!pixelSignature[\s\S]*age < AUTO_PARTIAL_FALLBACK_MS/);
  assert.match(contentSource, /readiness\.forceTerminalRefresh/);
  assert.match(contentSource, /resolvedOutputsForEntry\?\.\(meta\)/);
  assert.match(contentSource, /for \(const resolvedMeta of targets\)/);
  assert.match(contentSource, /resolvedForMessage\?\.\(conversationIdFromUrl\(\), domMessageId\)/);
});

test("websocket image identifiers are treated as interesting generation metadata", async () => {
  const harness = createHookHarness({});
  await harness.socketFrame(JSON.stringify({
    conversation_id: "conversation-test",
    message: {
      id: "socket-image-message",
      author: { role: "tool", name: "image_gen" },
      content: { parts: [{ image_id: "file-socket-image" }] },
    },
  }));

  const generation = harness.events.find((event) => (
    event.type === "generation-meta"
    && event.payload?.imageKey === "estuary:conversation-test:file-socket-image"
  ));
  assert.ok(generation, "image_id-only socket frames should reach the generation parser");
  assert.equal(generation.payload.isGeneration, true);
});

test("does not treat an unrelated tool image as generated artwork", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      chart: {
        message: {
          id: "message-python-image",
          author: { role: "tool", name: "python" },
          content: { parts: [{ asset_pointer: "sediment://file-chart" }] },
        },
      },
    },
  });

  await harness.harvest();

  assert.equal(harness.events.some((event) => event.type === "generation-meta" && event.payload?.isGeneration), false);
});

test("background limits generated video capture to Flow and Google AI Studio", () => {
  assert.match(backgroundSource, /import "\.\/provider-policy\.js"/);
  assert.match(backgroundSource, /function senderAllowedForMessage\(message, sender\)/);
  assert.match(backgroundSource, /sender\.id !== chrome\.runtime\.id/);
  assert.match(backgroundSource, /Number\(sender\.frameId \?\? 0\) !== 0/);
  assert.match(backgroundSource, /transfer\.senderKey !== senderKey\(sender\)/);
  assert.match(backgroundSource, /new Set\(\["chatgpt", "gemini", "flow", "google-ai-studio"\]\)/);
  assert.match(backgroundSource, /WEB_VIDEO_PROVIDERS = new Set\(\["flow", "google-ai-studio"\]\)/);
  assert.match(backgroundSource, /const provider = String\(payload\.provider \|\| "chatgpt"\)/);
  assert.match(backgroundSource, /if \(!WEB_IMAGE_PROVIDERS\.has\(provider\)\)/);
  assert.match(backgroundSource, /if \(mediaKind === "video" && !WEB_VIDEO_PROVIDERS\.has\(provider\)\)/);
  assert.match(backgroundSource, /fetchMediaAsBase64\(mediaUrl, \{ publicMedia: false, mediaKind, binary: mediaKind === "video" \}\)/);
  assert.match(backgroundSource, /\/api\/ingest\/web-capture-binary/);
  assert.match(backgroundSource, /message\.type === "mosa\.beginVideoTransfer"/);
  assert.match(backgroundSource, /message\.type === "mosa\.videoTransferChunk"/);
  assert.match(backgroundSource, /message\.type === "mosa\.commitVideoTransfer"/);
  assert.match(backgroundSource, /await captureMediaPut\(\{/,
    "page-local videos should spool decoded chunks durably before the tab can disappear");
  assert.match(backgroundSource, /videoChunkKey\(transferId, index\)/);
  assert.match(backgroundSource, /async function ingestQueuedVideoSpool\(item\)/);
  assert.doesNotMatch(backgroundSource, /chunks:\s*new Array\(totalChunks\)/,
    "the extension background must not retain the full video in memory");
  assert.match(backgroundSource, /async function streamRemoteVideoToMosa\(payload, mediaUrl, connection\)/);
  assert.match(backgroundSource, /if \(mediaKind === "video"\) \{\s*return streamRemoteVideoToMosa\(payload, mediaUrl, \{ baseUrl, token \}\);/,
    "remote videos should stream into the upload session instead of being buffered first");
  assert.match(backgroundSource, /CAPTURE_QUEUE_MAX_ATTEMPTS = 3/);
  assert.match(backgroundSource, /await pruneStoredCaptureQueue\(\)/);
  assert.match(backgroundSource, /error\?\.code === "MOSA_UNAVAILABLE"/);
  assert.match(backgroundSource, /function sanitizeProvenanceUrl\(value\)/);
  assert.match(backgroundSource, /function assertAllowedRemoteMediaUrl\(value\)/);
  assert.match(backgroundSource, /const MAX_VIDEO_BYTES = 96 \* 1024 \* 1024/);
  assert.match(backgroundSource, /message\.type === "mosa\.probeFlowMedia"/);
  assert.match(backgroundSource, /async function probeFlowMedia\(url\)/);
  assert.match(backgroundSource, /headers: \{ Range: "bytes=0-31" \}/);
  assert.match(backgroundSource, /finalPath\.includes\("\/video\/"\)/);
  assert.match(backgroundSource, /\.\.\.\(publicMedia \? \[\] : \[\{ credentials: "include", cache: "no-cache" \}\]\)/);
  assert.doesNotMatch(backgroundSource, /provider:\s*"chatgpt"/);
});

test("ChatGPT page bridge rejects messages outside the current document channel", () => {
  assert.match(hookSource, /mosaPageHookChannel = bridgeChannel/);
  assert.match(hookSource, /data\.channel !== bridgeChannel/);
  assert.match(contentSource, /function pageHookChannel\(\)/);
  assert.match(contentSource, /data\.channel !== channel/);
  assert.match(contentSource, /function syncPageHookCaptureEnabled\(attempt = 0\)/);
  assert.match(contentSource, /function desiredPageHookCaptureEnabled\(\)/);
  assert.match(contentSource, /return autoCapture \|\| Date\.now\(\) < manualHookLeaseUntil/);
  assert.match(contentSource, /pageHookCaptureAck === desired/);
  assert.match(contentSource, /const retryDelays = \[25, 100, 300, 750, 1_500, 2_500\]/);
  assert.match(contentSource, /data\.type === "capture-state"/);
  assert.match(hookSource, /post\("capture-state", \{ enabled: captureEnabled \}\)/);
  assert.match(contentSource, /DOMContentLoaded", \(\) => syncPageHookCaptureEnabled\(\)/);
});

test("clears the legacy development Token and verifies the real ingest authorization path", () => {
  assert.match(backgroundSource, /const LEGACY_DEV_TOKEN = "mosa-web-capture-dev"/);
  assert.match(backgroundSource, /const localToken = normalizeStoredToken\(local\.mosaToken\)/);
  assert.match(backgroundSource, /mosaToken: localToken \|\| migratedToken \|\| DEFAULTS\.mosaToken/);
  assert.match(optionsSource, /authorization: `Bearer \$\{token\}`/);
  assert.match(optionsSource, /WEB_CAPTURE_BAD_IMAGE/);
  assert.match(optionsSource, /WEB_CAPTURE_UNAUTHORIZED/);
});

function loadImageLookupKeys() {
  const source = ["chatGptImageProxyInfo", "normalizeAssetId", "imageLookupKeys"].map((name) => {
    const match = new RegExp(`\\n {2}function ${name}\\([\\s\\S]*?\\n {2}\\}`).exec(contentSource);
    assert.ok(match, `${name} should be extractable from content.js`);
    return match[0];
  }).join("\n");
  const context = { Set, String, URL, location: { href: "https://chatgpt.com/c/demo" } };
  vm.runInNewContext(source, context, { filename: "content-lookup.js" });
  return context.imageLookupKeys;
}

test("resolves every URL variant of one ChatGPT file to a shared identity", () => {
  const imageLookupKeys = loadImageLookupKeys();
  const estuary = imageLookupKeys("https://chatgpt.com/backend-api/estuary/content?cid=demo&id=file-abc123def&ts=1&sig=first");
  const estuaryWithoutConversation = imageLookupKeys("https://chatgpt.com/backend-api/estuary/content?id=file-abc123def&ts=2&sig=no-cid");
  const cdn = imageLookupKeys("https://files.oaiusercontent.com/file-abc123def?se=2026-07-26&sig=second");
  const cdnResigned = imageLookupKeys("https://files.oaiusercontent.com/file-abc123def?se=2026-07-27&sig=third");
  const other = imageLookupKeys("https://files.oaiusercontent.com/file-zzz987yyy?se=2026-07-26&sig=fourth");

  assert.ok(estuary.includes("asset:file-abc123def"));
  assert.ok(estuaryWithoutConversation.includes("asset:file-abc123def"), "Estuary asset identity must survive when ChatGPT omits cid");
  assert.ok(cdn.includes("asset:file-abc123def"));
  assert.ok(estuary.some((key) => cdn.includes(key)), "Estuary and CDN links must share an identity");
  assert.deepEqual(cdn, cdnResigned, "a re-signed link is the same image");
  assert.equal(other.some((key) => cdn.includes(key)), false, "different files stay separate");
});

test("archives one row per uploaded reference photo", () => {
  // The same upload surfaces as a composer blob, an Estuary proxy URL and a
  // signed CDN link. Keying on the raw src archived it once per variant.
  assert.match(contentSource, /const savedIdentityKeys = new Set\(\)/);
  assert.match(contentSource, /function isSavedCandidate\(candidate\)/);
  assert.match(contentSource, /function rememberSavedCandidate\(candidate, generationStatus = "unknown"\)/);
  assert.match(contentSource, /if \(isSavedCandidate\(candidate\)\) return false;/);
  assert.doesNotMatch(contentSource, /if \(savedKeys\.has\(key\)\) return false;/);

  // A composer attachment is re-rendered inside the sent message at a capped
  // size, so capturing both produced two differently sized assets.
  assert.match(contentSource, /function isComposerNode\(node\)/);
  assert.match(contentSource, /if \(!manual && isComposerNode\(img\)\) return false;/);
  assert.match(contentSource, /if \(manual\) \{[\s\S]*document\.querySelectorAll\("div, section, main, figure"\)/);

  // The Estuary proxy and the signed CDN link carry the same file id. Without
  // it they read as two images, and their bytes differ (canvas re-encode vs
  // served file), so the server content-hash dedupe cannot merge them either.
  assert.match(contentSource, /if \(fileId\) keys\.push\(`asset:\$\{fileId\}`\);/);

  // Preserve the provider-served original whenever available. The server's
  // pixel hash keeps an older canvas-encoded copy from becoming a second asset.
  const bytesFn = /async function bytesFromUrlOrImg\(candidate\) \{[\s\S]*?\n {2}\}/.exec(contentSource)?.[0] || "";
  assert.ok(bytesFn, "bytesFromUrlOrImg should exist");
  assert.ok(bytesFn.indexOf("originalBytesFromUrl(") < bytesFn.indexOf("canvasBytesFromImage(candidate.el)"));

  assert.match(contentSource, /isReference: isReferenceCandidate\(candidate\)/);
  assert.match(backgroundSource, /is_reference: Boolean\(payload\.isReference\)/);
  assert.match(contentSource, /function hasObservedGenerationEvidence\(candidate\)/);
  assert.match(contentSource, /function findGenerationEvidenceForCandidate\(candidate\)/);
  assert.match(contentSource, /const evidence = findGenerationEvidenceForCandidate\(candidate\);/);
  assert.match(contentSource, /if \(!evidence && isRecoverableGenerationCandidate\(candidate\)\) scheduleGenerationEvidenceRecovery\(candidate\);/);
  assert.match(contentSource, /function enqueueDomFallback\(candidate\)/);
  assert.match(contentSource, /reason: "dom-fallback"/);
  assert.match(contentSource, /const provenGeneration = !manual && !reference/);
  assert.match(contentSource, /const minEdge = reference \? 32 : manual \? 360 : provenGeneration \? 256 : MIN_EDGE/);
  assert.match(contentSource, /if \(!reference && byteLength > 0 && byteLength < MIN_BYTES\) return false/);
  assert.match(contentSource, /const needsReferenceRepair = stagedReferences > 0[\s\S]*isSavedCandidate\(candidate\)/);
  assert.match(contentSource, /force: needsReferenceRepair/);
  assert.match(contentSource, /rememberSet\(referenceSyncKeys, syncKey\)/);
  // A previously-seen reference still has to reach the server for each new
  // generation context. The server deduplicates the blob and appends usage.
  const stageReferences = /async function stageGenerationReferences\(candidate\) \{[\s\S]*?\n {2}\}/.exec(contentSource)?.[0] || "";
  assert.ok(stageReferences, "stageGenerationReferences should exist");
  assert.doesNotMatch(stageReferences, /isSavedCandidate\(reference\)/);
  assert.match(stageReferences, /reason: "auto-reference"/);
  // An optional reference failure must never surface as a user-facing error.
  assert.match(contentSource, /const optionalReferenceFailure = reason === "auto-reference"/);
  assert.match(hookSource, /isGeneration: extra\.isGeneration === true/);
  assert.match(hookSource, /if \(url && payload\.isGeneration\) post\("auto-image", payload\)/);
});

test("automatic capture does not starve new images behind already-saved DOM candidates", () => {
  const scanStart = contentSource.indexOf("const candidates = collectDomCandidates();");
  const scanEnd = contentSource.indexOf("}, force ? 120 : 600);", scanStart);
  const scan = contentSource.slice(scanStart, scanEnd);
  assert.ok(scanStart >= 0 && scanEnd > scanStart, "scan block should be extractable");
  assert.match(scan, /const eligible = candidates\.filter\(\(candidate\) => \{/);
  assert.match(scan, /if \(!canAttempt\(candidate\)\) return false;/);
  assert.match(scan, /if \(hasObservedGenerationEvidence\(candidate\)\) return true;/);
  assert.match(scan, /if \(isRecoverableGenerationCandidate\(candidate\)\) scheduleGenerationEvidenceRecovery\(candidate\);/);
  assert.match(scan, /\}\)\.slice\(0, 6\);/);
  assert.doesNotMatch(scan, /for \(const candidate of candidates\.slice\(0, 6\)\)/);
});

test("ChatGPT DOM fallback recognizes generated-image turn structure without legacy role nesting", () => {
  assert.match(contentSource, /const CHATGPT_TURN_SELECTOR = '\[data-testid\^="conversation-turn-"\]'/);
  assert.match(contentSource, /function hasGeneratedImageDomMarker\(image\)/);
  assert.match(contentSource, /generated image\|image generated/);
  assert.match(contentSource, /const explicitGeneratedImage = hasGeneratedImageDomMarker\(image\)/);
  assert.match(contentSource, /if \(!roleScope && !turnOwnsAssistantContent && !explicitGeneratedImage\) return false;/);
  assert.match(contentSource, /if \(explicitGeneratedImage\) return true;/);
  assert.match(contentSource, /attributeFilter: \["src", "srcset", "alt", "aria-label"\]/);
});

test("ChatGPT generation evidence recovery spans slow multi-image renders", () => {
  assert.match(contentSource, /const GENERATION_EVIDENCE_RECOVERY_DELAYS = \[2_800, 7_200, 15_000\]/);
  assert.match(contentSource, /GENERATION_EVIDENCE_RECOVERY_DELAYS\.map\(\(delay, index\) => setTimeout/);
  assert.match(contentSource, /index !== GENERATION_EVIDENCE_RECOVERY_DELAYS\.length - 1/);
  assert.match(contentSource, /enqueueDomFallback\(candidate\);/);
});

test("temporary small ChatGPT generation candidates remain retryable", () => {
  const ingestStart = contentSource.indexOf("async function ingestCandidate(candidate");
  const enqueueStart = contentSource.indexOf("function enqueueAuto(candidate", ingestStart);
  const ingest = contentSource.slice(ingestStart, enqueueStart);
  assert.ok(ingestStart >= 0 && enqueueStart > ingestStart);
  assert.match(ingest, /hasObservedGenerationEvidence\(candidate\) \|\| isRecoverableGenerationCandidate\(candidate\)/);
  assert.match(ingest, /failedAt\.set\(key, Date\.now\(\)\)/);
});

test("promptless generation events can archive before the DOM finishes rendering", () => {
  const autoImageStart = contentSource.indexOf('if (data.type === "auto-image"');
  const domImageStart = contentSource.indexOf('if (data.type === "dom-image"', autoImageStart);
  const block = contentSource.slice(autoImageStart, domImageStart);
  assert.ok(autoImageStart >= 0 && domImageStart > autoImageStart);
  assert.match(block, /if \(meta\.isGeneration !== true\) return;/);
  assert.match(block, /enqueueAuto\(\{/);
  assert.doesNotMatch(block, /\["generation-tool-prompt", "visible-caption"\]\.includes\(meta\.promptStatus\)/);
  assert.match(contentSource, /const failedNetworkIdentityKeys = new Set\(\)/);
  assert.match(contentSource, /candidateLookupKeys\(candidate\)\.some\(\(identity\) => failedNetworkIdentityKeys\.has\(identity\)\)/);
});

test("splits sibling generations without tool call ids into per-asset reference scopes", async () => {
  // Two generated assets flattened into one tool message, without per-call
  // ids: they are still distinct generations, so references of one must not
  // attach to the sibling output through a shared message-scoped context.
  const harness = createHookHarness({
    conversation_id: "conversation-multi-asset",
    mapping: {
      generated: {
        message: {
          id: "message-multi-asset",
          author: { role: "tool", name: "image_gen" },
          content: { parts: [
            { asset_pointer: "sediment://file-one" },
            { asset_pointer: "sediment://file-two" },
          ] },
        },
      },
    },
  });

  await harness.harvest();

  const generations = harness.events.filter((event) => event.type === "generation-meta" && event.payload?.isGeneration);
  assert.equal(generations.length, 2);
  assert.deepEqual(
    generations.map((event) => event.payload.generationContextId).sort(),
    [
      "chatgpt:conversation-multi-asset:asset:file-one",
      "chatgpt:conversation-multi-asset:asset:file-two",
    ],
  );
  assert.deepEqual(
    manifest.content_scripts.find((entry) => entry.js?.includes("provider-sites.js"))?.js,
    ["provider-policy.js", "provider-sites.js"],
  );
});

test("provider policy classifies only supported top-level product URLs", () => {
  const sandbox = { URL };
  vm.runInNewContext(providerPolicySource, sandbox, { filename: "provider-policy.js" });
  const policy = sandbox.MosaProviderPolicy;
  assert.equal(policy.providerForPageUrl("https://chatgpt.com/c/abc"), "chatgpt");
  assert.equal(policy.providerForPageUrl("https://gemini.google.com/app/abc"), "gemini");
  assert.equal(policy.providerForPageUrl("https://aistudio.google.com/generate-video"), "google-ai-studio");
  assert.equal(policy.providerForPageUrl("https://labs.google/fx/en/tools/flow/project/abc"), "flow");
  assert.equal(policy.providerForPageUrl("https://labs.google/search"), "");
  assert.equal(policy.providerForPageUrl("http://gemini.google.com/app/abc"), "");
  assert.equal(policy.providerForPageUrl("https://evil.example/?next=https://gemini.google.com"), "");
  assert.equal(policy.supportsVideo("flow"), true);
  assert.equal(policy.supportsVideo("google-ai-studio"), true);
  assert.equal(policy.supportsVideo("gemini"), false);
});

test("url and asset events of one generation share a single reference scope", async () => {
  const proxyUrl = "https://chatgpt.com/backend-api/estuary/content?cid=conversation-test&id=file-bangkok&sig=signed-value";
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      bangkok: {
        message: {
          id: "message-bangkok",
          content: { parts: [{ asset_pointer: "file-service://file-bangkok", image_url: proxyUrl }] },
          metadata: { dalle: { revised_prompt: "A detailed travel poster for Bangkok with saffron temples, red typography, and an editorial print layout." } },
        },
      },
    },
  });

  await harness.harvest();

  const contexts = new Set(harness.events
    .filter((event) => (
      event.type === "generation-meta"
      && event.payload?.imageKey === "estuary:conversation-test:file-bangkok"
    ))
    .map((event) => event.payload.generationContextId));
  assert.equal(contexts.size, 1, `URL and asset events must carry one scope, got: ${[...contexts].join(", ")}`);
  assert.ok([...contexts][0], "the shared scope must be non-empty");
});

test("the XHR interceptor skips binary image responses like the fetch interceptor", () => {
  assert.ok(hookSource.includes('this.getResponseHeader?.("content-type")'));
  assert.ok(hookSource.includes('const responseType = String(this.responseType || "").toLowerCase();'));
  assert.ok(hookSource.includes('responseType === "json" && this.response'));
  assert.ok(hookSource.includes('if (text) harvest(text, "xhr");'));
});

test("does not flatten multiple image tool calls into one prompt binding", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-multi-call",
    mapping: {
      generated: {
        message: {
          id: "message-multi-call",
          author: { role: "tool", name: "image_gen" },
          metadata: {
            calls: [
              { tool_call_id: "call-a", prompt: "first detailed cinematic image prompt", asset_pointer: "sediment://file-a" },
              { tool_call_id: "call-b", prompt: "second detailed editorial image prompt", asset_pointer: "sediment://file-b" },
            ],
          },
          content: { parts: [] },
        },
      },
    },
  });

  await harness.harvest();
  const generations = harness.events.filter((event) => event.type === "generation-meta" && event.payload?.isGeneration);
  assert.equal(generations.length, 2);
  assert.deepEqual(generations.map((event) => event.payload.prompt), [
    "first detailed cinematic image prompt",
    "second detailed editorial image prompt",
  ]);
  assert.deepEqual(generations.map((event) => event.payload.promptStatus), ["generation-tool-prompt", "generation-tool-prompt"]);
  assert.deepEqual(generations.map((event) => event.payload.providerToolCallId), ["call-a", "call-b"]);
});

test("one image tool call keeps per-output prompts on their own sibling images", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-one-call-many-outputs",
    mapping: {
      generated: {
        message: {
          id: "message-one-call-many-outputs",
          author: { role: "tool", name: "image_gen" },
          metadata: {
            call: {
              tool_call_id: "call-shared",
              outputs: [
                { revised_prompt: "red editorial poster for output A", asset_pointer: "sediment://file-output-a" },
                { revised_prompt: "blue cinematic poster for output B", asset_pointer: "sediment://file-output-b" },
              ],
            },
          },
          content: { parts: [] },
        },
      },
    },
  }, "conversation-one-call-many-outputs");

  await harness.harvest();
  const outputs = harness.events.filter((event) => event.type === "generation-meta" && event.payload?.assetId?.startsWith("file-output-"));
  assert.equal(outputs.length, 2);
  const byAsset = new Map(outputs.map((event) => [event.payload.assetId, event.payload]));
  assert.equal(byAsset.get("file-output-a")?.prompt, "red editorial poster for output A");
  assert.equal(byAsset.get("file-output-a")?.promptScope, "output");
  assert.equal(byAsset.get("file-output-b")?.prompt, "blue cinematic poster for output B");
  assert.equal(byAsset.get("file-output-b")?.promptScope, "output");
});

test("a promptless sibling output is still emitted when another image call succeeds with a prompt", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-partial-multi",
    mapping: {
      generated: {
        message: {
          id: "message-partial-multi",
          author: { role: "tool", name: "image_gen" },
          metadata: {
            calls: [
              { tool_call_id: "call-a", prompt: "complete prompt for output A", asset_pointer: "sediment://file-a-complete" },
              { tool_call_id: "call-b", asset_pointer: "sediment://file-b-promptless", status: "failed" },
            ],
          },
          content: { parts: [] },
        },
      },
    },
  }, "conversation-partial-multi");

  await harness.harvest();
  const outputs = harness.events.filter((event) => event.type === "generation-meta" && event.payload?.assetId);
  const byAsset = new Map(outputs.map((event) => [event.payload.assetId, event.payload]));
  assert.equal(byAsset.get("file-a-complete")?.prompt, "complete prompt for output A");
  assert.equal(byAsset.get("file-b-promptless")?.prompt, "");
  assert.equal(byAsset.get("file-b-promptless")?.promptStatus, "not-available");
  assert.equal(byAsset.get("file-b-promptless")?.generationStatus, "failed");
  assert.equal(byAsset.get("file-b-promptless")?.isGeneration, true);
});

test("output-specific failure status is not overwritten by an attempt-level completed state", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-mixed-status",
    mapping: {
      generated: {
        message: {
          id: "message-mixed-status",
          author: { role: "tool", name: "image_gen" },
          metadata: {
            call: {
              tool_call_id: "call-mixed-status",
              status: "completed",
              outputs: [
                { asset_pointer: "sediment://file-status-ok", status: "completed" },
                { asset_pointer: "sediment://file-status-failed", status: "failed" },
              ],
            },
          },
          content: { parts: [] },
        },
      },
    },
  }, "conversation-mixed-status");

  await harness.harvest();
  const outputs = harness.events.filter((event) => event.type === "generation-meta" && event.payload?.assetId?.startsWith("file-status-"));
  const byAsset = new Map(outputs.map((event) => [event.payload.assetId, event.payload]));
  assert.equal(byAsset.get("file-status-ok")?.generationStatus, "completed");
  assert.equal(byAsset.get("file-status-failed")?.generationStatus, "failed");
});

test("generation error prose beside a surviving image is status evidence, never a prompt", async () => {
  const errorText = "Generation failed while creating the cinematic poster because the image service timed out; a partial result may still be visible.";
  const harness = createHookHarness({
    conversation_id: "conversation-error-image",
    mapping: {
      generated: {
        message: {
          id: "message-error-image",
          author: { role: "tool", name: "image_gen" },
          metadata: { call: { tool_call_id: "call-error-image", asset_pointer: "sediment://file-error-image" } },
          content: { parts: [errorText] },
        },
      },
    },
  }, "conversation-error-image");

  await harness.harvest();
  const output = harness.events.find((event) => event.type === "generation-meta" && event.payload?.assetId === "file-error-image")?.payload;
  assert.ok(output);
  assert.equal(output.prompt, "");
  assert.equal(output.promptStatus, "not-available");
  assert.equal(output.generationStatus, "failed");
});

test("failed attempt prompt does not leak into a later successful retry in the same tool call", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-retry-boundary",
    mapping: {
      generated: {
        message: {
          id: "message-retry-boundary",
          author: { role: "tool", name: "image_gen" },
          metadata: {
            call: {
              tool_call_id: "call-retry",
              attempts: [
                {
                  generation_call_id: "gen-failed",
                  status: "failed",
                  revised_prompt: "prompt belonging only to the failed attempt",
                },
                {
                  generation_call_id: "gen-success",
                  status: "completed",
                  asset_pointer: "sediment://file-retry-success",
                },
              ],
            },
          },
          content: { parts: [] },
        },
      },
    },
  }, "conversation-retry-boundary");

  await harness.harvest();
  const success = harness.events.find((event) => event.type === "generation-meta" && event.payload?.assetId === "file-retry-success")?.payload;
  assert.ok(success);
  assert.equal(success.providerGenerationCallId, "gen-success");
  assert.equal(success.generationStatus, "completed");
  assert.equal(success.prompt, "");
  const failed = harness.events.find((event) => event.type === "generation-meta" && event.payload?.providerGenerationCallId === "gen-failed")?.payload;
  assert.equal(failed?.prompt, "prompt belonging only to the failed attempt");
  assert.equal(failed?.generationStatus, "failed");
});

test("one collage asset with several panel prompts stays prompt-ambiguous instead of choosing a panel", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-collage",
    mapping: {
      generated: {
        message: {
          id: "message-collage",
          author: { role: "tool", name: "image_gen" },
          metadata: {
            call: {
              tool_call_id: "call-collage",
              panels: [
                { revised_prompt: "panel one revised prompt: a red product poster with dramatic light" },
                { generation_prompt: "panel two generation prompt: a blue product poster with soft light" },
              ],
              result: { asset_pointer: "sediment://file-collage" },
            },
          },
          content: { parts: [] },
        },
      },
    },
  }, "conversation-collage");

  await harness.harvest();
  const collage = harness.events.find((event) => event.type === "generation-meta" && event.payload?.assetId === "file-collage")?.payload;
  assert.ok(collage);
  assert.equal(collage.prompt, "");
  assert.equal(collage.promptStatus, "not-available");
});

test("one shared attempt prompt can legitimately bind to every output in that call", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-shared-prompt",
    mapping: {
      generated: {
        message: {
          id: "message-shared-prompt",
          author: { role: "tool", name: "image_gen" },
          metadata: {
            call: {
              tool_call_id: "call-shared-prompt",
              revised_prompt: "one shared prompt for a coordinated three-image campaign",
              outputs: [
                { asset_pointer: "sediment://file-shared-a" },
                { asset_pointer: "sediment://file-shared-b" },
                { asset_pointer: "sediment://file-shared-c" },
              ],
            },
          },
          content: { parts: [] },
        },
      },
    },
  }, "conversation-shared-prompt");

  await harness.harvest();
  const outputs = harness.events.filter((event) => event.type === "generation-meta" && event.payload?.assetId?.startsWith("file-shared-"));
  assert.equal(outputs.length, 3);
  assert.ok(outputs.every((event) => event.payload.prompt === "one shared prompt for a coordinated three-image campaign"));
  assert.ok(outputs.every((event) => event.payload.promptScope === "attempt"));
});

test("binds prompt and asset when one image call splits them across nested request/result objects", async () => {
  const harness = createHookHarness({
    conversation_id: "conversation-split-call",
    mapping: {
      generated: {
        message: {
          id: "message-split-call",
          author: { role: "tool", name: "image_gen" },
          metadata: {
            calls: [{
              tool_call_id: "call-split",
              request: { revisedPrompt: "A precise split-call prompt for a red architectural poster" },
              result: { assetPointer: "sediment://file-split-call" },
            }],
          },
          content: { parts: [] },
        },
      },
    },
  }, "conversation-split-call");

  await harness.harvest();
  const generation = harness.events.find((event) => event.payload?.assetId === "file-split-call");
  assert.equal(generation?.payload.prompt, "A precise split-call prompt for a red architectural poster");
  assert.equal(generation?.payload.providerToolCallId, "call-split");
  assert.equal(generation?.payload.promptSource, "revised_prompt");
});

test("uses only a same-message Model caption when conversation metadata is cached", () => {
  assert.equal(manifest.version, "0.15.4");
  assert.match(contentSource, /function messageScopeForCandidate\(candidate\)/);
  assert.match(contentSource, /function domCaptionForCandidate\(candidate\)/);
  assert.match(contentSource, /model caption\\s\*:\\s\*\(\.\+\)\$/i);
  assert.match(contentSource, /via: "dom-message-caption"/);
});

test("keeps a same-message user instruction separate and retries for a late caption", () => {
  assert.doesNotMatch(contentSource, /allowUserMessageFallback/);
  assert.doesNotMatch(contentSource, /promptSource: "bound-user-message"/);
  assert.match(contentSource, /function domCandidateForImage\(imageUrl(?:, \{ manual = false \} = \{\})?\)/);
  assert.match(contentSource, /function enqueueDomCandidateForImage\(imageUrl, reason\)/);
  assert.match(contentSource, /function schedulePromptRecovery\(candidate, \{ needPrompt = true, needTerminal = false \} = \{\}\)/);
  assert.match(contentSource, /function currentViewportCandidate\(candidates\)/);
  assert.match(contentSource, /const delays = \[2_800, 7_200, 15_000\]/);
});

test("an orphaned content script explains itself instead of dying on sendMessage", () => {
  // Reloading or re-adding the unpacked extension leaves the injected script
  // running with chrome.runtime gone; every save then failed with a raw
  // "Cannot read properties of undefined (reading 'sendMessage')".
  assert.match(contentSource, /function extensionAlive\(\)/);
  assert.match(contentSource, /function markContextLost\(\)/);
  assert.match(contentSource, /const CONTEXT_LOST_MESSAGE = /);

  const send = /async function runtimeSend\(message\) \{[\s\S]*?\n {2}\}/.exec(contentSource)?.[0] || "";
  assert.ok(send, "runtimeSend should be extractable from content.js");
  assert.ok(
    send.indexOf("extensionAlive()") !== -1
      && send.indexOf("extensionAlive()") < send.indexOf("chrome.runtime.sendMessage(message)"),
    "runtimeSend must verify the extension context before touching chrome.runtime",
  );
  assert.match(send, /reading 'sendMessage'/);

  // The scan interval doubles as the watchdog: an orphaned page flips to the
  // refresh instruction on its own instead of waiting for a failed save.
  const interval = /autoScanInterval = setInterval\(\(\) => \{[\s\S]*?\n {2}\}, 5000\);/.exec(contentSource)?.[0] || "";
  assert.ok(interval, "auto scan interval should be extractable from content.js");
  assert.match(interval, /markContextLost\(\)/);
});

function loadSettingsHarness({ response, responseError, localValue = true } = {}) {
  const loadSettings = /async function loadSettings\(\) \{[\s\S]*?\n {2}\}/.exec(contentSource)?.[0] || "";
  assert.ok(loadSettings, "loadSettings should be extractable from content.js");
  const localReads = [];
  const localWrites = [];
  const context = {
    chrome: {
      storage: {
        local: {
          get: async (defaults) => {
            localReads.push(defaults);
            return { autoCapture: localValue };
          },
          set: async (value) => localWrites.push(value),
        },
      },
    },
    contextLost: false,
    runtimeSend: async () => {
      if (responseError) throw responseError;
      return response;
    },
    syncPageHookCaptureEnabled: () => {},
  };
  vm.runInNewContext(`
    let autoCapture = false;
    let pageHookCaptureAck = null;
    ${loadSettings}
    globalThis.runLoadSettings = async () => {
      await loadSettings();
      return autoCapture;
    };
  `, context, { filename: "content-settings.js" });
  return { context, localReads, localWrites };
}

test("a settings read failure preserves an explicit local auto-capture choice", async () => {
  const harness = loadSettingsHarness({
    responseError: new Error("background temporarily unavailable"),
    localValue: false,
  });

  assert.equal(await harness.context.runLoadSettings(), false);
  assert.equal(harness.localReads.length, 1);
  assert.equal(harness.localReads[0].autoCapture, false);
  assert.deepEqual(harness.localWrites, [], "the content script must not rewrite settings");
});

test("the background setting wins without a redundant local read", async () => {
  const harness = loadSettingsHarness({
    response: { ok: true, settings: { autoCapture: false } },
    localValue: true,
  });

  assert.equal(await harness.context.runLoadSettings(), false);
  assert.deepEqual(harness.localReads, []);
  assert.deepEqual(harness.localWrites, []);
});

test("startup context loss disconnects an initialized observer without a TDZ error", async () => {
  const observerAssignment = contentSource.indexOf("observer = new MutationObserver");
  const settingsBoot = contentSource.indexOf("loadSettings().then");
  assert.ok(observerAssignment !== -1 && observerAssignment < settingsBoot);
  assert.match(contentSource, /observer\?\.disconnect\(\)/);

  const markContextLost = /function markContextLost\(\) \{[\s\S]*?\n {2}\}/.exec(contentSource)?.[0] || "";
  const runtimeSend = /async function runtimeSend\(message\) \{[\s\S]*?\n {2}\}/.exec(contentSource)?.[0] || "";
  const context = {
    CONTEXT_LOST_MESSAGE: "refresh required",
    Error,
    autoScanInterval: null,
    clearInterval,
    clearTimeout,
    chrome: {},
    contextLost: false,
    document: { getElementById: () => null },
    extensionAlive: () => false,
    observer: { disconnectCalled: 0, disconnect() { this.disconnectCalled += 1; } },
    autoStabilityStates: new Map(),
    autoStabilityTimers: new Map(),
    generationEvidenceRecoveryTimers: new Map(),
    manualHookDisableTimer: null,
    promptRecoveryTimers: new Map(),
    scanTimer: null,
    setStatus: () => {},
    showToast: () => {},
  };
  vm.runInNewContext(`
    ${markContextLost}
    ${runtimeSend}
    globalThis.runRuntimeSend = () => runtimeSend({ type: "mosa.getSettings" });
  `, context, { filename: "content-context-loss.js" });

  await assert.rejects(context.runRuntimeSend(), /refresh required/);
  assert.equal(context.observer.disconnectCalled, 1);
  assert.equal(context.contextLost, true);
});

test("an open page follows auto-capture changes from local storage only", () => {
  const listener = /chrome\.storage\?\.onChanged\?\.addListener\(\(changes, area\) => \{[\s\S]*?\n {2}\}\);/.exec(contentSource)?.[0] || "";
  assert.ok(listener, "storage listener should be extractable from content.js");
  let storageListener = null;
  const context = {
    chrome: { storage: { onChanged: { addListener: (callback) => { storageListener = callback; } } } },
    clearTimeout,
    autoStabilityStates: new Map(),
    autoStabilityTimers: new Map(),
    observer: { disconnect() {} },
    scanTimer: null,
    requestCurrentConversationRefresh: () => false,
    setPageHookCaptureEnabled: () => {},
    startObs: () => {},
    state: {},
  };
  vm.runInNewContext(`
    let autoCapture = true;
    let manualHookLeaseUntil = 0;
    let manualHookDisableTimer = null;
    let pageHookCaptureAck = null;
    let scheduled = 0;
    let status = "";
    function scheduleScan() { scheduled += 1; }
    function setStatus(value) { status = value; }
    function syncPageHookCaptureEnabled() {}
    ${listener}
    globalThis.readState = () => ({ autoCapture, scheduled, status });
  `, context, { filename: "content-storage-listener.js" });

  assert.equal(typeof storageListener, "function");
  storageListener({ autoCapture: { newValue: false } }, "local");
  assert.equal(JSON.stringify(context.readState()), JSON.stringify({ autoCapture: false, scheduled: 0, status: "自动关" }));
  storageListener({ autoCapture: { newValue: true } }, "sync");
  assert.equal(JSON.stringify(context.readState()), JSON.stringify({ autoCapture: false, scheduled: 0, status: "自动关" }));
  storageListener({ autoCapture: { newValue: true } }, "local");
  assert.equal(JSON.stringify(context.readState()), JSON.stringify({ autoCapture: true, scheduled: 1, status: "自动开" }));
});

test("refreshes only the active conversation to recover a late Model caption", async () => {
  const caption = "Model caption: A detailed retro travel poster for Nanjing, China, with cream paper, bold red Art Deco typography, city vignettes, and a screen-print editorial layout.";
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      nanjing: {
        message: {
          id: "message-nanjing",
          author: { role: "tool" },
          content: {
            parts: [
              caption,
              { asset_pointer: "sediment://file-nanjing" },
            ],
          },
        },
      },
    },
  });

  await harness.refreshCurrentConversation();

  assert.deepEqual(harness.requestedUrls, [
    "https://chatgpt.com/backend-api/conversation/conversation-test",
  ]);
  assert.deepEqual(generationEvents(harness).map((event) => ({
    imageKey: event.payload.imageKey,
    prompt: event.payload.prompt,
    promptStatus: event.payload.promptStatus,
  })), [{
    imageKey: "estuary:conversation-test:file-nanjing",
    prompt: caption,
    promptStatus: "visible-caption",
  }]);
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

test("refreshes the active conversation without copying authentication headers", async () => {
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} });

  // Even if the page makes an authenticated request, MOSA must not copy or
  // replay any of those request headers into its recovery request.
  await harness.harvest({
    headers: {
      Authorization: "Bearer page-session-token",
      "OAI-Device-Id": "device-abc",
      "X-Unrelated-Secret": "must-not-be-copied",
    },
  });
  await harness.refreshCurrentConversation();

  const refreshIndex = harness.requestedUrls.indexOf("https://chatgpt.com/backend-api/conversation/conversation-test");
  assert.ok(refreshIndex >= 0, "the refresh should reach the conversation endpoint");
  const init = harness.requestedInits[refreshIndex] || {};
  assert.equal(init.credentials, "include");
  assert.equal(init.cache, "no-store");
  assert.equal(Object.hasOwn(init, "headers"), false, "recovery must not replay page request headers");
});

test("does not capture page authentication headers", async () => {
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} });
  await harness.harvest({ headers: { Authorization: "Bearer page-session-token" } });
  await harness.refreshCurrentConversation();

  const posted = JSON.stringify(harness.events);
  assert.equal(posted.includes("page-session-token"), false, "a page token must never be posted out of the page");
  assert.doesNotMatch(contentSource, /authorization/i);
  assert.doesNotMatch(hookSource, /forwardedHeaders|rememberRequestHeaders|oai-device-id|oai-client-version|oai-language/i);
  const refreshIndex = harness.requestedUrls.indexOf("https://chatgpt.com/backend-api/conversation/conversation-test");
  assert.ok(refreshIndex >= 0);
  assert.equal(Object.hasOwn(harness.requestedInits[refreshIndex] || {}, "headers"), false);
});

test("reports a failed conversation refresh instead of losing it silently", async () => {
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} }, "conversation-test", {
    respond: () => ({ ok: false, status: 401, text: async () => "", clone: () => ({ text: async () => "" }) }),
  });

  await harness.refreshCurrentConversation();

  const failure = harness.events.find((event) => event.type === "conversation-refresh-failed");
  assert.ok(failure, "a rejected refresh must be reported");
  assert.equal(failure.payload.status, 401);
  assert.equal(Object.hasOwn(failure.payload, "authorized"), false);
  assert.match(contentSource, /data\.type === "conversation-refresh-failed"/);
});

test("harvests a caption from the live WebSocket stream", async () => {
  // ChatGPT streams a live answer over a socket, so fetch and XHR never see the
  // caption of an image generated while the page stays open.
  const caption = "Model caption: 一张暖色沙漠时装大片海报，构图为低角度仰拍，画面有强烈的电影感光影与胶片颗粒，排版为杂志封面风格。";
  const frame = `data: ${JSON.stringify({
    conversation_id: "conversation-test",
    message: {
      id: "message-live",
      author: { role: "tool" },
      content: { parts: [caption, { asset_pointer: "sediment://file-live" }] },
    },
  })}\n\n`;
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} });

  await harness.socketFrame(JSON.stringify({
    type: "http.response.body",
    body: Buffer.from(frame, "utf8").toString("base64"),
    more_body: true,
  }));

  assert.deepEqual(generationEvents(harness).map((event) => ({
    imageKey: event.payload.imageKey,
    prompt: event.payload.prompt,
    promptStatus: event.payload.promptStatus,
  })), [{
    imageKey: "estuary:conversation-test:file-live",
    prompt: caption,
    promptStatus: "visible-caption",
  }]);
});

test("accepts an unmarked caption in the image tool message", async () => {
  // The "Model caption:" marker is OpenAI wording that has changed before.
  const caption = "A dramatic low-angle sports portrait scene with cinematic side lighting, a warm desert background, bold editorial typography, and a premium magazine cover layout.";
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      unmarked: {
        message: {
          id: "message-unmarked",
          author: { role: "tool" },
          content: { parts: [caption, { asset_pointer: "sediment://file-unmarked" }] },
        },
      },
    },
  });

  await harness.harvest();

  assert.deepEqual(generationEvents(harness).map((event) => ({
    prompt: event.payload.prompt,
    promptStatus: event.payload.promptStatus,
  })), [{ prompt: caption, promptStatus: "visible-caption" }]);
});

test("does not mistake assistant prose about an image for its caption", async () => {
  const prose = "Here is the poster you asked for. I kept the lighting cinematic and the typography bold so the layout reads clearly, and I can adjust the composition or palette if you want a different style.";
  const harness = createHookHarness({
    conversation_id: "conversation-test",
    mapping: {
      prose: {
        message: {
          id: "message-prose",
          author: { role: "assistant" },
          content: { content_type: "multimodal_text", parts: [prose, { asset_pointer: "sediment://file-prose" }] },
        },
      },
    },
  });

  await harness.harvest();

  assert.deepEqual(generationEvents(harness), [], "chat prose is not a generation caption");
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

test("opens the in-page control panel in the lower-right corner instead of relying on popup UI", () => {
  assert.match(contentSource, /mosa\.capture\.togglePanel/);
  assert.match(contentSource, /function ensureControlPanel\(\)/);
  assert.match(contentSource, /function toggleControlPanel\(\)/);
  assert.match(contentSource, /mosa-capture-panel/);
  assert.match(contentCss, /#mosa-capture-panel/);
  assert.match(contentCss, /right:\s*16px/);
  assert.match(contentCss, /bottom:\s*16px/);
  assert.doesNotMatch(contentCss, /top:\s*14px/);
  assert.doesNotMatch(JSON.stringify(manifest.action), /popup\.html/);
});

test("keeps the capture toast compact in the viewport corner", () => {
  const toastCss = contentCss.slice(0, contentCss.indexOf("#mosa-capture-panel"));
  assert.match(toastCss, /right:\s*16px/);
  assert.match(toastCss, /bottom:\s*16px/);
  assert.match(toastCss, /width:\s*max-content/);
  assert.match(toastCss, /max-width:\s*min\(260px/);
  assert.match(toastCss, /font:\s*600 12px/);
  assert.doesNotMatch(toastCss, /left:\s*50%/);
  assert.doesNotMatch(toastCss, /translateX\(\s*-50%\s*\)/);
});
