import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import vm from "node:vm";

const hookSource = await readFile(new URL("../extensions/chatgpt-web-capture/page-hook.js", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../extensions/chatgpt-web-capture/manifest.json", import.meta.url), "utf8"));
const backgroundSource = await readFile(new URL("../extensions/chatgpt-web-capture/background.js", import.meta.url), "utf8");
const contentSource = await readFile(new URL("../extensions/chatgpt-web-capture/content.js", import.meta.url), "utf8");
const contentCss = await readFile(new URL("../extensions/chatgpt-web-capture/content.css", import.meta.url), "utf8");
const optionsSource = await readFile(new URL("../extensions/chatgpt-web-capture/options.js", import.meta.url), "utf8");
const optionsHtml = await readFile(new URL("../extensions/chatgpt-web-capture/options.html", import.meta.url), "utf8");
const providerSource = await readFile(new URL("../extensions/chatgpt-web-capture/provider-sites.js", import.meta.url), "utf8");

function createHookHarness(payload, conversationId = "conversation-test", options = {}) {
  const events = [];
  const requestedUrls = [];
  const requestedInits = [];
  let messageListener = null;
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
    document: { documentElement: {}, addEventListener: () => {} },
    location: { origin: "https://chatgpt.com", pathname: `/c/${conversationId}` },
    window,
  }, { filename: "page-hook.js" });

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
        data: { source: "mosa-chatgpt-capture", type: "refresh-current-conversation" },
      });
      await setImmediate();
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

test("declares the supported Google media sites and provider content script", () => {
  assert.equal(manifest.version, "0.14.0");
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
  assert.match(providerSource, /"gemini\.google\.com": "gemini"/);
  assert.match(providerSource, /"labs\.google": "flow"/);
  assert.match(providerSource, /"aistudio\.google\.com": "google-ai-studio"/);
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
  assert.match(providerSource, /type: "mosa\.probeFlowMedia"/);
  assert.match(providerSource, /probe\.mediaKind === "video"/);
  assert.match(providerSource, /function isVisibleGeneratedVideo\(video\)/);
  assert.match(providerSource, /function isProviderGeneratedVideo\(provider, video\)/);
  assert.match(providerSource, /AI_STUDIO_VIDEO_PATH = \/\^\\\/generate-video/);
  assert.match(providerSource, /AI_STUDIO_VIDEO_PATH\.test\(String\(location\.pathname/);
  assert.match(providerSource, /document\.addEventListener\("loadedmetadata", scheduleScan, true\)/);
  assert.match(providerSource, /document\.addEventListener\("loadeddata", scheduleScan, true\)/);
  assert.match(providerSource, /document\.addEventListener\("canplay", scheduleScan, true\)/);
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
  assert.match(providerSource, /"mosa\.capture\.saveImage", "mosa\.capture\.saveImageWithPrompt"/);
  assert.match(providerSource, /function supportedImageUrl\(value\)/);
  assert.match(providerSource, /const PROMPT_RETRY_DELAYS = \[900, 2_700, 7_200\]/);
  assert.match(providerSource, /function schedulePromptRetry\(provider, source, mediaKind = "image"\)/);
  assert.match(providerSource, /function attemptPendingPromptUpgrades\(\)/);
  assert.match(providerSource, /characterData: true/);
  assert.match(providerSource, /document\.addEventListener\("load", scheduleScan, true\)/);
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
  assert.match(providerSource, /if \(source\.kind === "local"\) \{/);
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
  assert.match(backgroundSource, /new Set\(\["chatgpt", "gemini", "flow", "google-ai-studio"\]\)/);
  assert.match(backgroundSource, /WEB_VIDEO_PROVIDERS = new Set\(\["flow", "google-ai-studio"\]\)/);
  assert.match(backgroundSource, /const provider = String\(payload\.provider \|\| "chatgpt"\)/);
  assert.match(backgroundSource, /if \(!WEB_IMAGE_PROVIDERS\.has\(provider\)\)/);
  assert.match(backgroundSource, /if \(mediaKind === "video" && !WEB_VIDEO_PROVIDERS\.has\(provider\)\)/);
  assert.match(backgroundSource, /fetchMediaAsBase64\(mediaUrl, \{ publicMedia: provider !== "chatgpt", mediaKind \}\)/);
  assert.match(backgroundSource, /message\.type === "mosa\.probeFlowMedia"/);
  assert.match(backgroundSource, /async function probeFlowMedia\(url\)/);
  assert.match(backgroundSource, /headers: \{ Range: "bytes=0-31" \}/);
  assert.match(backgroundSource, /finalPath\.includes\("\/video\/"\)/);
  assert.match(backgroundSource, /\.\.\.\(publicMedia \? \[\] : \[\{ credentials: "include", cache: "no-cache" \}\]\)/);
  assert.doesNotMatch(backgroundSource, /provider:\s*"chatgpt"/);
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
  const cdn = imageLookupKeys("https://files.oaiusercontent.com/file-abc123def?se=2026-07-26&sig=second");
  const cdnResigned = imageLookupKeys("https://files.oaiusercontent.com/file-abc123def?se=2026-07-27&sig=third");
  const other = imageLookupKeys("https://files.oaiusercontent.com/file-zzz987yyy?se=2026-07-26&sig=fourth");

  assert.ok(estuary.includes("asset:file-abc123def"));
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
  assert.match(contentSource, /function rememberSavedCandidate\(candidate\)/);
  assert.match(contentSource, /if \(isSavedCandidate\(candidate\)\) return false;/);
  assert.doesNotMatch(contentSource, /if \(savedKeys\.has\(key\)\) return false;/);

  // A composer attachment is re-rendered inside the sent message at a capped
  // size, so capturing both produced two differently sized assets.
  assert.match(contentSource, /function isComposerNode\(node\)/);
  assert.match(contentSource, /if \(!manual && isComposerNode\(img\)\) return false;/);
  assert.match(contentSource, /if \(!manual && isComposerNode\(el\)\) continue;/);

  // The Estuary proxy and the signed CDN link carry the same file id. Without
  // it they read as two images, and their bytes differ (canvas re-encode vs
  // served file), so the server content-hash dedupe cannot merge them either.
  assert.match(contentSource, /if \(fileId\) keys\.push\(`asset:\$\{fileId\}`\);/);

  // Canvas stays the primary byte source: reordering it would re-import every
  // asset already archived from a canvas snapshot under a new content hash.
  const bytesFn = /async function bytesFromUrlOrImg\(candidate\) \{[\s\S]*?\n {2}\}/.exec(contentSource)?.[0] || "";
  assert.ok(bytesFn, "bytesFromUrlOrImg should exist");
  assert.ok(bytesFn.indexOf("canvasBytesFromImage(candidate.el)") < bytesFn.indexOf("originalBytesFromUrl("));

  assert.match(contentSource, /isReference: isReferenceCandidate\(candidate\)/);
  assert.match(backgroundSource, /is_reference: Boolean\(payload\.isReference\)/);
  assert.match(contentSource, /function hasObservedGenerationEvidence\(candidate\)/);
  assert.match(contentSource, /const evidence = findGenerationEvidenceForImage\(candidate\?\.imageUrl \|\| candidate\?\.key \|\| ""\);/);
  assert.match(contentSource, /if \(!evidence \|\| isReferenceCandidate\(candidate\)\) return;/);
  assert.match(contentSource, /return hasObservedGenerationEvidence\(candidate\);/);
  assert.match(contentSource, /const minEdge = reference \? 32 : manual \? 360 : MIN_EDGE/);
  assert.match(contentSource, /if \(!reference && byteLength > 0 && byteLength < MIN_BYTES\) return false/);
  assert.match(contentSource, /const needsReferenceRepair = stagedReferences > 0[\s\S]*isSavedCandidate\(candidate\)/);
  assert.match(contentSource, /force: needsReferenceRepair/);
  assert.match(contentSource, /referenceSyncKeys\.add\(syncKey\)/);
  // Staging counts an already-saved reference instead of re-uploading its
  // bytes: one turn can yield several outputs and each used to re-send all.
  assert.match(contentSource, /if \(isSavedCandidate\(reference\)\) \{/);
  assert.doesNotMatch(contentSource, /reason: "auto-reference", force: true/);
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
  assert.match(scan, /return hasObservedGenerationEvidence\(candidate\);/);
  assert.match(scan, /\}\)\.slice\(0, 6\);/);
  assert.doesNotMatch(scan, /for \(const candidate of candidates\.slice\(0, 6\)\)/);
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
  assert.ok(hookSource.includes('if (!/^image\\//.test(contentType)) harvest(this.responseText || "", "xhr");'));
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
  assert.deepEqual(generations.map((event) => event.payload.prompt), ["", ""]);
  assert.deepEqual(generations.map((event) => event.payload.promptStatus), ["not-available", "not-available"]);
  assert.ok(generations.every((event) => /asset:file-[ab]$/.test(event.payload.generationContextId)), "ambiguous calls should fall back to per-output asset contexts");
});

test("uses only a same-message Model caption when conversation metadata is cached", () => {
  assert.equal(manifest.version, "0.14.0");
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
  assert.match(contentSource, /function schedulePromptRecovery\(candidate\)/);
  assert.match(contentSource, /function currentViewportCandidate\(candidates\)/);
  assert.match(contentSource, /const delays = \[2_800, 7_200\]/);
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
  const interval = /autoScanInterval = setInterval\(\(\) => \{[\s\S]*?\n {2}\}, 2000\);/.exec(contentSource)?.[0] || "";
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
  };
  vm.runInNewContext(`
    let autoCapture = true;
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
  assert.equal(harness.localReads[0].autoCapture, true);
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
    state: {},
  };
  vm.runInNewContext(`
    let autoCapture = true;
    let scheduled = 0;
    let status = "";
    function scheduleScan() { scheduled += 1; }
    function setStatus(value) { status = value; }
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

test("reuses the page's own backend-api credentials when refreshing a conversation", async () => {
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} });

  // The ChatGPT app itself calls backend-api with a bearer token. A refresh that
  // omits it is rejected, which is what disabled late-caption recovery.
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
  const headers = harness.requestedInits[refreshIndex]?.headers || {};
  assert.equal(headers.authorization, "Bearer page-session-token");
  assert.equal(headers["oai-device-id"], "device-abc");
  assert.equal(Object.hasOwn(headers, "x-unrelated-secret"), false, "only the known auth headers are replayed");
});

test("keeps page credentials inside the page world", async () => {
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} });
  await harness.harvest({ headers: { Authorization: "Bearer page-session-token" } });
  await harness.refreshCurrentConversation();

  const posted = JSON.stringify(harness.events);
  assert.equal(posted.includes("page-session-token"), false, "a captured token must never be posted out of the page");
  assert.doesNotMatch(contentSource, /authorization/i);
  // The captured values may leave the map for exactly one destination: the
  // same-origin conversation request. Reporting only whether one exists is fine.
  assert.doesNotMatch(hookSource, /forwardedHeaders\.get\b/);
  assert.equal((hookSource.match(/Object\.fromEntries\(forwardedHeaders\)/g) || []).length, 1);
});

test("reports a failed conversation refresh instead of losing it silently", async () => {
  const harness = createHookHarness({ conversation_id: "conversation-test", mapping: {} }, "conversation-test", {
    respond: () => ({ ok: false, status: 401, text: async () => "", clone: () => ({ text: async () => "" }) }),
  });

  await harness.refreshCurrentConversation();

  const failure = harness.events.find((event) => event.type === "conversation-refresh-failed");
  assert.ok(failure, "a rejected refresh must be reported");
  assert.equal(failure.payload.status, 401);
  assert.equal(failure.payload.authorized, false);
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
