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

test("declares the supported Google image sites and provider content script", () => {
  assert.equal(manifest.version, "0.11.0");
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
  ]) assert.ok(manifest.host_permissions.includes(host), `missing ${host}`);
  assert.match(providerSource, /"gemini\.google\.com": "gemini"/);
  assert.match(providerSource, /"labs\.google": "flow"/);
  assert.match(providerSource, /"aistudio\.google\.com": "google-ai-studio"/);
});

test("Google adapters capture visible images with bounded Gemini, Flow, and AI Studio Prompt lookup", () => {
  const executableProviderSource = providerSource.replace(/\/\/.*$/gm, "");
  assert.match(providerSource, /const IMAGE_HOSTS/);
  assert.match(providerSource, /getBoundingClientRect/);
  assert.match(providerSource, /document\.images/);
  assert.match(providerSource, /promptStatus: "not-available"/);
  assert.match(providerSource, /promptSource: "provider-visible-image"/);
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
  assert.match(providerSource, /function schedulePromptRetry\(provider, source\)/);
  assert.match(providerSource, /function attemptPendingPromptUpgrades\(\)/);
  assert.match(providerSource, /characterData: true/);
  assert.match(providerSource, /document\.addEventListener\("load", scheduleScan, true\)/);
  assert.doesNotMatch(executableProviderSource, /innerText|textContent|innerHTML|querySelectorAll|conversation/);
  assert.doesNotMatch(executableProviderSource, /document\.body\.innerText|document\.documentElement\.innerText/);
});

test("Google adapters read only eligible page-local bytes and keep CDN URLs remote", () => {
  assert.match(providerSource, /src\.startsWith\("blob:"\)/);
  assert.match(providerSource, /url\.origin !== location\.origin/);
  assert.match(providerSource, /isAllowedLocalImageUrl/);
  assert.match(providerSource, /url\.pathname === "\/fx\/api\/trpc\/media\.getMediaUrlRedirect"/);
  assert.match(providerSource, /credentials: "same-origin"/);
  assert.match(providerSource, /const bytes = await bytesFromVisibleImage\(source, img\)/);
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

test("uses safe local extension settings without a public Token default", () => {
  assert.match(backgroundSource, /mosaBaseUrl:\s*"http:\/\/127\.0\.0\.1:43517"/);
  assert.match(backgroundSource, /mosaToken:\s*""/);
  assert.doesNotMatch(backgroundSource, /mosaToken:\s*"mosa-web-capture-dev"/);
  assert.match(backgroundSource, /chrome\.storage\.local\.get/);
  assert.match(backgroundSource, /chrome\.storage\.local\.set/);
  assert.match(contentSource, /chrome\.storage\?\.local\?\.get\?\./);
  assert.doesNotMatch(contentSource, /chrome\.storage\.sync\.set/);
  assert.match(optionsSource, /chrome\.storage\.local\.set/);
  assert.match(optionsHtml, /type="password"/);
});

test("background forwards only the four fixed web-image provider IDs", () => {
  assert.match(backgroundSource, /new Set\(\["chatgpt", "gemini", "flow", "google-ai-studio"\]\)/);
  assert.match(backgroundSource, /const provider = String\(payload\.provider \|\| "chatgpt"\)/);
  assert.match(backgroundSource, /if \(!WEB_IMAGE_PROVIDERS\.has\(provider\)\)/);
  assert.match(backgroundSource, /fetchImageAsBase64\(payload\.imageUrl, \{ publicImage: provider !== "chatgpt" \}\)/);
  assert.match(backgroundSource, /\.\.\.\(publicImage \? \[\] : \[\{ credentials: "include", cache: "no-cache" \}\]\)/);
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
  assert.match(contentSource, /function hasVerifiedGenerationEvidence\(candidate\)/);
  assert.match(contentSource, /if \(!hasVerifiedGenerationEvidence\(candidate\)\) return;/);
  assert.match(contentSource, /if \(!hasVerifiedGenerationEvidence\(candidate\)\) continue;/);
  assert.match(hookSource, /isGeneration: extra\.isGeneration === true/);
  assert.match(hookSource, /if \(url && payload\.isGeneration\) post\("auto-image", payload\)/);
});

test("uses only a same-message Model caption when conversation metadata is cached", () => {
  assert.equal(manifest.version, "0.11.0");
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
