/**
 * Page-world hook: bind generated-image metadata within one ChatGPT message.
 * Never broadcast one old caption onto every image URL in a payload.
 */
(function mosaPageHook() {
  if (window.__mosaPageHookInstalled) return;
  window.__mosaPageHookInstalled = true;
  let captureEnabled = false;

  function markReady() {
    if (document.documentElement) {
      try {
        document.documentElement.dataset.mosaPageHook = "1";
      } catch {
        // The hook itself still works in test/minimal document environments.
      }
      return;
    }
    document.addEventListener("DOMContentLoaded", markReady, { once: true });
  }
  markReady();

  const PROMPT_KEYS = new Set([
    "prompt", "revised_prompt", "generation_prompt", "image_prompt",
    "original_prompt", "caption", "model_caption", "alt_text", "metadata_caption",
  ]);
  const URL_KEYS = new Set([
    "url", "download_url", "src", "image_url", "asset_url", "file_url",
    "encoded_image_url",
  ]);
  const ASSET_REFERENCE_KEYS = new Set([
    "asset_pointer", "asset_id", "file_id", "image_id", "assetid", "fileid", "imageid",
  ]);
  const CONVERSATION_ID_KEYS = new Set(["conversation_id", "conversationid", "cid"]);
  const MESSAGE_ID_KEYS = new Set(["message_id", "messageid"]);
  const RESPONSE_ID_KEYS = new Set(["response_id", "responseid"]);
  const TOOL_CALL_ID_KEYS = new Set(["tool_call_id", "toolcallid", "call_id", "callid"]);
  // Keep provider generation-call identity separate from generic tool-call
  // identity. Only accept fields whose names explicitly say they are image /
  // generation call ids; never promote tool_call_id into this slot.
  const GENERATION_CALL_ID_KEYS = new Set([
    "generation_call_id", "generationcallid",
    "image_generation_call_id", "imagegenerationcallid",
    "image_gen_call_id", "imagegencallid",
  ]);

  function post(type, payload) {
    try {
      window.postMessage({ source: "mosa-chatgpt-capture", type, payload }, "*");
    } catch {
      // ignore
    }
  }

  function isCaptureEnabled() {
    return captureEnabled === true;
  }

  function isHttpUrl(value) {
    return typeof value === "string" && /^https?:\/\//i.test(value);
  }

  function chatGptImageProxyInfo(value) {
    if (!isHttpUrl(value)) return null;
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      if (!(["chatgpt.com", "chat.openai.com"].includes(host)) || url.pathname !== "/backend-api/estuary/content") {
        return null;
      }
      const conversationId = url.searchParams.get("cid") || "";
      const assetId = url.searchParams.get("id") || "";
      if (!conversationId || !assetId) return null;
      return {
        conversationId,
        assetId,
        imageKey: `estuary:${conversationId}:${assetId}`,
      };
    } catch {
      return null;
    }
  }

  function normalizeAssetId(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const pointer = /^(?:file-service|asset|sediment):\/\/([^/?#]+)/i.exec(raw);
    if (pointer) return pointer[1];
    return /^[a-z0-9][a-z0-9._:-]{2,200}$/i.test(raw) ? raw : "";
  }

  function genericImageKey(value) {
    if (!isHttpUrl(value)) return "";
    try {
      const url = new URL(value);
      return `url:${url.origin}${url.pathname}`;
    } catch {
      return "";
    }
  }

  function imageIdentity(imageUrl, extra = {}) {
    const proxy = chatGptImageProxyInfo(imageUrl);
    const assetId = normalizeAssetId(extra.assetId) || proxy?.assetId || "";
    const conversationId = String(extra.conversationId || proxy?.conversationId || "").trim();
    const imageKey = String(extra.imageKey || proxy?.imageKey || "").trim()
      || (assetId && conversationId ? `estuary:${conversationId}:${assetId}` : "")
      || (assetId ? `asset:${assetId}` : "")
      || genericImageKey(imageUrl);
    return { imageKey, assetId, conversationId };
  }

  function isImageishUrl(value) {
    if (!isHttpUrl(value)) return false;
    if (chatGptImageProxyInfo(value)) return true;
    const lower = value.toLowerCase();
    // Never treat ChatGPT UI static assets as generations.
    if (
      lower.includes("oaistatic")
      || lower.includes("sprite")
      || lower.includes("favicon")
      || lower.includes("emoji")
      || lower.includes("avatar")
      || lower.includes("logo")
      || lower.includes("/_next/")
    ) return false;
    return (
      lower.includes("oaiusercontent")
      || lower.includes("oaidalle")
      || lower.includes("files.oaiusercontent")
      || lower.includes("images.openai.com")
      || lower.includes("blob.core")
      || lower.includes("dalle")
      || lower.includes("generated")
    );
  }

  function cleanPrompt(text) {
    return String(text || "")
      .replace(/<\|has_watermark\|>/g, "")
      .replace(/\n?展开\s*$/g, "")
      .trim();
  }

  function looksLikePrompt(text) {
    const t = cleanPrompt(text);
    if (t.length < 24 || t.length > 12000) return false;
    if (/^(ok|yes|no|thanks|继续|好的)\b/i.test(t) && t.length < 60) return false;
    return true;
  }

  function scorePrompt(text) {
    const t = cleanPrompt(text);
    if (!looksLikePrompt(t)) return 0;
    let score = Math.min(t.length, 2000) / 20;
    const keywords = [
      "poster", "illustration", "typography", "vector", "style", "lighting",
      "caption", "graphic", "layout", "city", "travel",
      "海报", "插画", "构图", "风格", "场景",
    ];
    for (const word of keywords) {
      if (t.toLowerCase().includes(word.toLowerCase())) score += 6;
    }
    if (/^model caption:/i.test(t)) score += 15;
    return score;
  }

  const CAPTION_STYLE_HINTS = [
    "poster", "illustration", "typography", "vector", "style", "lighting",
    "camera", "composition", "palette", "cinematic", "editorial", "scene",
    "caption", "graphic", "layout", "portrait", "background", "photo",
    "海报", "插画", "构图", "光影", "风格", "场景", "画面", "镜头",
  ];

  /** Reads like generation instructions rather than a chat reply. */
  function looksLikeGenerationCaption(text) {
    const t = cleanPrompt(text);
    if (t.length < 120) return false;
    const hits = CAPTION_STYLE_HINTS.filter((word) => t.toLowerCase().includes(word.toLowerCase()));
    return hits.length >= 2;
  }

  function promptPriority(key) {
    if (["revised_prompt", "generation_prompt", "image_prompt"].includes(key)) return 3;
    if (["metadata_caption", "caption", "model_caption", "alt_text"].includes(key)) return 2;
    return 1;
  }

  function promptStatusForKey(key) {
    if (["revised_prompt", "generation_prompt", "image_prompt"].includes(key)) return "generation-tool-prompt";
    if (["metadata_caption", "caption", "model_caption", "alt_text"].includes(key)) return "visible-caption";
    return "user-message";
  }

  function isTrustedGenerationPromptKey(key) {
    return promptStatusForKey(key) === "generation-tool-prompt";
  }

  function conversationIdFromLocation() {
    const match = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/);
    return match ? match[1] : "";
  }

  function pickString(node, keys) {
    if (!node || typeof node !== "object") return "";
    for (const [key, value] of Object.entries(node)) {
      if (keys.has(String(key).toLowerCase()) && typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  }

  function contextForNode(node, inherited = {}) {
    const message = node?.message && typeof node.message === "object" ? node.message : node;
    return {
      conversationId: pickString(node, CONVERSATION_ID_KEYS)
        || pickString(message, CONVERSATION_ID_KEYS)
        || inherited.conversationId
        || conversationIdFromLocation(),
      messageId: pickString(node, MESSAGE_ID_KEYS)
        || pickString(message, MESSAGE_ID_KEYS)
        || (typeof message?.id === "string" ? message.id : "")
        || inherited.messageId
        || "",
      responseId: pickString(node, RESPONSE_ID_KEYS)
        || pickString(message, RESPONSE_ID_KEYS)
        || inherited.responseId
        || "",
      generationCallId: pickString(node, GENERATION_CALL_ID_KEYS)
        || pickString(message, GENERATION_CALL_ID_KEYS)
        || inherited.generationCallId
        || "",
    };
  }

  function isMessageCarrier(node) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return false;
    const message = node.message && typeof node.message === "object" ? node.message : node;
    return Boolean(message?.content && (message?.id || message?.author || message?.metadata));
  }

  /** Emit a tightly bound pair. Empty prompt is allowed for an image-only event. */
  function emitPair(prompt, imageUrl, extra = {}) {
    const p = cleanPrompt(prompt);
    const url = isImageishUrl(imageUrl) ? imageUrl : "";
    const identity = imageIdentity(url || imageUrl, extra);
    if (!p && !url && !identity.imageKey) return;
    const payload = {
      prompt: p,
      promptScore: scorePrompt(p),
      imageUrl: url,
      imageKey: identity.imageKey,
      assetId: identity.assetId,
      conversationId: identity.conversationId,
      messageId: extra.messageId || "",
      generationContextId: extra.generationContextId || "",
      providerToolCallId: extra.providerToolCallId || "",
      providerGenerationCallId: extra.providerGenerationCallId || "",
      providerResponseId: extra.providerResponseId || "",
      promptStatus: extra.promptStatus || (p ? "user-message" : "not-available"),
      model: extra.model || "",
      capturedAt: new Date().toISOString(),
      via: extra.via || "network",
      bound: Boolean(p && identity.imageKey),
      // A CDN URL is not proof of generation: ChatGPT serves uploads through
      // the same asset path. Only a tool-owned generation prompt is evidence
      // that this exact asset is an output we may auto-archive.
      isGeneration: extra.isGeneration === true,
    };
    post("generation-meta", payload);
    if (url && payload.isGeneration) post("auto-image", payload);
  }

  function emitMessageBindings(node, inherited) {
    const message = node.message && typeof node.message === "object" ? node.message : node;
    const context = contextForNode(node, inherited);
    const prompts = new Map();
    const assetIds = new Set();
    const imageUrls = new Set();
    const toolCallIds = new Set();
    const generationCallIds = new Set();
    let model = "";

    function rememberPrompt(key, value) {
      if (!PROMPT_KEYS.has(key) || typeof value !== "string") return;
      const text = cleanPrompt(value);
      if (!text || text.length > 12000 || (!isTrustedGenerationPromptKey(key) && !looksLikePrompt(text))) return;
      const current = prompts.get(text);
      const priority = promptPriority(key);
      if (!current || priority > current.priority) {
        prompts.set(text, { text, priority, promptStatus: promptStatusForKey(key) });
      }
    }

    // ChatGPT's current image tool often leaves dalle.prompt blank, while the
    // same tool message exposes the caption as a plain string in content.parts.
    // The "Model caption:" marker is OpenAI wording that has changed before, so
    // an unmarked caption is accepted too — but only inside a tool message that
    // owns the image, which is where a caption lives and chat prose does not.
    function rememberVisibleCaption(value, { hasImageAsset, authorRole }) {
      const text = cleanPrompt(value);
      if (!looksLikePrompt(text)) return;
      if (!/^model caption\s*:/i.test(text)) {
        if (!hasImageAsset || authorRole !== "tool") return;
        if (!looksLikeGenerationCaption(text)) return;
      }
      const current = prompts.get(text);
      if (!current || 2 > current.priority) {
        prompts.set(text, { text, priority: 2, promptStatus: "visible-caption" });
      }
    }

    function scan(value, depth = 0) {
      if (!value || depth > 14 || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) scan(item, depth + 1);
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        const lower = String(key).toLowerCase();
        rememberPrompt(lower, child);
        if (ASSET_REFERENCE_KEYS.has(lower) && typeof child === "string") {
          const assetId = normalizeAssetId(child);
          if (assetId) assetIds.add(assetId);
        }
        if (TOOL_CALL_ID_KEYS.has(lower) && typeof child === "string" && child.trim()) {
          toolCallIds.add(child.trim());
        }
        if (GENERATION_CALL_ID_KEYS.has(lower) && typeof child === "string" && child.trim()) {
          generationCallIds.add(child.trim());
        }
        if ((URL_KEYS.has(lower) || typeof child === "string") && isImageishUrl(child)) imageUrls.add(child);
        if ((lower === "model" || lower === "model_slug") && typeof child === "string" && child.trim()) model = child.trim();
        if (child && typeof child === "object") scan(child, depth + 1);
      }
    }

    scan(message);
    const captionContext = {
      hasImageAsset: assetIds.size > 0 || imageUrls.size > 0,
      authorRole: String(message?.author?.role || "").toLowerCase(),
    };
    for (const part of message?.content?.parts || []) {
      if (typeof part === "string") rememberVisibleCaption(part, captionContext);
    }
    const orderedPrompts = [...prompts.values()].sort((a, b) => b.priority - a.priority);
    const selected = orderedPrompts[0];
    const equallyPreferred = selected ? orderedPrompts.filter((item) => item.priority === selected.priority) : [];
    const toolMarker = [
      message?.author?.name,
      message?.recipient,
      message?.metadata?.tool_name,
      message?.metadata?.command,
      message?.metadata?.invoked_plugin?.namespace,
    ].filter(Boolean).join(" ");
    const generationToolMarker = /(dall[-_.]?e|image[_ .-]?(gen|generation)|text2im|imagegen)/i.test(toolMarker);
    const toolOwnedGeneration = captionContext.hasImageAsset
      && generationToolMarker
      && ["tool", "assistant"].includes(captionContext.authorRole);
    // Prompt availability and generation provenance are separate facts. A
    // tool-owned image remains safe to archive even when ChatGPT omits the
    // caption; a later metadata event can upgrade the prompt by image hash.
    const usablePrompt = selected && equallyPreferred.length === 1 ? selected : null;
    if (!usablePrompt && !toolOwnedGeneration) return;

    const onlyAssetId = assetIds.size === 1 ? [...assetIds][0] : "";
    const onlyToolCallId = toolCallIds.size === 1 ? [...toolCallIds][0] : "";
    const onlyGenerationCallId = generationCallIds.size === 1
      ? [...generationCallIds][0]
      : (!generationCallIds.size ? context.generationCallId : "");
    const ambiguousToolCalls = toolCallIds.size > 1;
    // If multiple image calls were flattened into one message, keep generation
    // provenance but do not assign one ambiguous prompt to every output.
    const boundPrompt = ambiguousToolCalls ? null : usablePrompt;
    // URL events and asset events for one generation must carry the same
    // reference-linking scope. A single tool call or a single asset covers the
    // whole message; several assets without one shared call id are distinct
    // generations, and each output keeps its own scope so references of one
    // generation never attach to a sibling output.
    const sharedScopeId = onlyToolCallId
      || (assetIds.size <= 1 && !ambiguousToolCalls ? context.messageId : "");
    const scopeForAsset = (assetId) => sharedScopeId || `asset:${assetId}`;
    const scopeForUrl = (imageUrl) => {
      if (sharedScopeId) return sharedScopeId;
      const proxy = chatGptImageProxyInfo(imageUrl);
      return proxy?.assetId && assetIds.has(proxy.assetId) ? `asset:${proxy.assetId}` : "";
    };
    const contextIdFor = (scopeId) => (
      context.conversationId && scopeId
        ? `chatgpt:${context.conversationId}:${scopeId}`
        : scopeId ? `chatgpt:${scopeId}` : ""
    );
    for (const imageUrl of imageUrls) {
      emitPair(boundPrompt?.text || "", imageUrl, {
        assetId: onlyAssetId,
        conversationId: context.conversationId,
        messageId: context.messageId,
        generationContextId: contextIdFor(scopeForUrl(imageUrl)),
        providerToolCallId: onlyToolCallId,
        providerGenerationCallId: onlyGenerationCallId,
        providerResponseId: context.responseId,
        promptStatus: boundPrompt?.promptStatus || "not-available",
        model,
        via: "message-metadata-url",
        isGeneration: toolOwnedGeneration || boundPrompt?.promptStatus === "generation-tool-prompt" || boundPrompt?.promptStatus === "visible-caption",
      });
    }
    for (const assetId of assetIds) {
      emitPair(boundPrompt?.text || "", "", {
        assetId,
        conversationId: context.conversationId,
        messageId: context.messageId,
        generationContextId: contextIdFor(scopeForAsset(assetId)),
        providerToolCallId: onlyToolCallId,
        providerGenerationCallId: onlyGenerationCallId,
        providerResponseId: context.responseId,
        promptStatus: boundPrompt?.promptStatus || "not-available",
        model,
        via: "message-metadata-asset",
        isGeneration: toolOwnedGeneration || boundPrompt?.promptStatus === "generation-tool-prompt" || boundPrompt?.promptStatus === "visible-caption",
      });
    }
    if (boundPrompt && !imageUrls.size && !assetIds.size) {
      emitPair(boundPrompt.text, "", {
        conversationId: context.conversationId,
        messageId: context.messageId,
        providerGenerationCallId: onlyGenerationCallId,
        providerResponseId: context.responseId,
        promptStatus: boundPrompt.promptStatus,
        model,
        via: "message-prompt-only",
      });
    }
  }

  /** Walk objects without sharing prompt data across sibling message nodes. */
  function walkObject(node, inherited = {}, depth = 0) {
    if (!node || depth > 18) return;
    if (typeof node === "string") return;
    if (typeof node !== "object") return;

    if (Array.isArray(node)) {
      for (const item of node) walkObject(item, inherited, depth + 1);
      return;
    }

    const context = contextForNode(node, inherited);
    if (isMessageCarrier(node)) {
      emitMessageBindings(node, context);
      return;
    }

    let localPrompt = "";
    let localUrl = "";
    let localAssetId = "";
    let localModel = "";

    for (const [key, value] of Object.entries(node)) {
      const lower = String(key).toLowerCase();
      if (PROMPT_KEYS.has(lower) && typeof value === "string" && looksLikePrompt(value)) {
        localPrompt = cleanPrompt(value);
      } else if ((lower === "model" || lower === "model_slug") && typeof value === "string") {
        localModel = value;
      } else if (URL_KEYS.has(lower) && isImageishUrl(value)) {
        localUrl = value;
      } else if (ASSET_REFERENCE_KEYS.has(lower) && typeof value === "string") {
        localAssetId = normalizeAssetId(value);
      } else if (value && typeof value === "object") {
        walkObject(value, context, depth + 1);
      }
    }

    if (localPrompt && localUrl) {
      emitPair(localPrompt, localUrl, { ...context, model: localModel, via: "same-object" });
      return;
    }
    if (localPrompt && localAssetId) {
      emitPair(localPrompt, "", { ...context, assetId: localAssetId, model: localModel, via: "same-object-asset" });
      return;
    }
    if (localUrl) {
      emitPair("", localUrl, { ...context, model: localModel, via: "url-only" });
    }
    if (localPrompt && !localUrl && !localAssetId) {
      emitPair(localPrompt, "", { ...context, model: localModel, via: "prompt-only" });
    }
  }

  function harvest(text, via) {
    if (!text || text.length < 20 || text.length > 12_000_000) return;
    if (text.includes("data:")) {
      for (const line of text.split(/\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          walkObject(JSON.parse(payload), { conversationId: conversationIdFromLocation() });
        } catch {
          // ignore
        }
      }
      return;
    }
    try {
      walkObject(JSON.parse(text), { conversationId: conversationIdFromLocation() });
    } catch {
      const urls = text.match(/https?:\/\/[^\s"'\\]+/g) || [];
      for (const url of urls) {
        const cleaned = url.replace(/[),;]+$/, "");
        if (isImageishUrl(cleaned)) emitPair("", cleaned, { via: via + "-urlscan" });
      }
    }
  }

  // Keep the original fetch so an explicit refresh cannot recurse through the
  // general fetch interceptor below.
  const originalFetch = window.fetch;
  const conversationRefreshAt = new Map();
  const CONVERSATION_REFRESH_COOLDOWN_MS = 2_500;

  async function refreshCurrentConversation() {
    if (!isCaptureEnabled()) return;
    const conversationId = conversationIdFromLocation();
    if (!conversationId) return;

    const now = Date.now();
    const previous = conversationRefreshAt.get(conversationId) || 0;
    if (now - previous < CONVERSATION_REFRESH_COOLDOWN_MS) return;
    conversationRefreshAt.set(conversationId, now);
    if (conversationRefreshAt.size > 20) {
      for (const [id, at] of conversationRefreshAt) {
        if (now - at > CONVERSATION_REFRESH_COOLDOWN_MS * 4) conversationRefreshAt.delete(id);
      }
    }

    const encodedConversationId = encodeURIComponent(conversationId);
    const base = location.origin || "https://chatgpt.com";
    const endpoints = [
      `${base}/backend-api/conversation/${encodedConversationId}`,
      `${base}/backend-api/f/conversation/${encodedConversationId}`,
    ];
    let lastStatus = 0;
    for (const endpoint of endpoints) {
      try {
        const response = await originalFetch(endpoint, {
          credentials: "include",
          cache: "no-store",
        });
        if (!response?.ok) {
          lastStatus = Number(response?.status) || 0;
          continue;
        }
        harvest(await response.text(), "conversation-refresh");
        return;
      } catch {
        // Try the alternate first-party conversation endpoint.
      }
    }
    post("conversation-refresh-failed", { status: lastStatus });
  }

  // The payload is intentionally ignored. The page hook derives the ID from
  // location, so a page script cannot make the extension fetch another chat.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data?.source !== "mosa-chatgpt-capture") return;
    if (data.type === "set-capture-enabled") {
      captureEnabled = data.payload?.enabled === true;
      return;
    }
    if (data.type === "refresh-current-conversation") refreshCurrentConversation().catch(() => {});
  });

  function isInterestingResponseUrl(value) {
    try {
      const url = new URL(String(value || ""), location.origin);
      if (url.origin !== location.origin) return false;
      const path = url.pathname.toLowerCase();
      return path.startsWith("/backend-api/conversation/")
        || path.startsWith("/backend-api/f/conversation/")
        || path.includes("/backend-api/estuary/")
        || /\/(image|images|imagegen|image-generation|generation)(?:\/|$)/.test(path);
    } catch {
      return false;
    }
  }

  window.fetch = async function mosaFetch(...args) {
    const response = await originalFetch.apply(this, args);
    if (!isCaptureEnabled()) return response;
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      if (isInterestingResponseUrl(url)) {
        const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
        const textLike = /json|text|event-stream|javascript/.test(contentType)
          || /backend-api|conversation/i.test(String(url));
        if (textLike && !/^image\//.test(contentType)) {
          const clone = response.clone();
          clone.text().then((text) => harvest(text, "fetch")).catch(() => {});
        }
      }
    } catch {
      // ignore
    }
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function mosaOpen(method, url, ...rest) {
    this.__mosaUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function mosaSend(...args) {
    this.addEventListener("load", function onLoad() {
      if (!isCaptureEnabled()) return;
      try {
        const url = String(this.__mosaUrl || "");
        if (isInterestingResponseUrl(url)) {
          // Mirror the fetch interceptor: never harvest raw image bytes.
          const contentType = String(this.getResponseHeader?.("content-type") || "").toLowerCase();
          if (!/^image\//.test(contentType)) harvest(this.responseText || "", "xhr");
        }
      } catch {
        // ignore
      }
    });
    return originalSend.apply(this, args);
  };

  /**
   * ChatGPT streams a live answer over a WebSocket for most consumer accounts,
   * so fetch and XHR never see the caption of an image generated while the page
   * is open. Frames arrive as JSON envelopes whose `body` is base64 SSE text.
   */
  const WS_INTEREST = /asset_pointer|asset_id|file_id|image_id|file-service|sediment|revised_prompt|generation_prompt|image_prompt|generation_call_id|image_generation_call_id|image_gen_call_id|model[ _]caption|image[_ .-]?(gen|generation)|imagegen|dalle|oaiusercontent|estuary/i;

  function decodeBase64Utf8(value) {
    if (typeof atob !== "function") return "";
    const binary = atob(String(value || ""));
    if (typeof TextDecoder !== "function" || typeof Uint8Array !== "function") return binary;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    // A caption is often Chinese; the raw binary string would mangle it.
    return new TextDecoder("utf-8").decode(bytes);
  }

  function harvestSocketText(text) {
    if (!text || typeof text !== "string") return;
    // Token-by-token deltas dominate the stream. Parse only image-bearing frames.
    if (WS_INTEREST.test(text)) harvest(text, "websocket");
    // Skip anything that is not a JSON envelope carrying a base64 body, so a
    // fast answer stream does not pay for a parse per token.
    if (text.charCodeAt(0) !== 123 || !text.includes('"body"')) return;
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      return;
    }
    const body = envelope?.body;
    if (typeof body !== "string" || !body) return;
    try {
      const decoded = decodeBase64Utf8(body);
      if (decoded && WS_INTEREST.test(decoded)) harvest(decoded, "websocket-body");
    } catch {
      // A frame we cannot decode is skipped; the refresh path still recovers it.
    }
  }

  function harvestSocketData(data) {
    try {
      if (typeof data === "string") {
        harvestSocketText(data);
      } else if (typeof ArrayBuffer === "function" && data instanceof ArrayBuffer) {
        if (typeof TextDecoder === "function") harvestSocketText(new TextDecoder("utf-8").decode(data));
      } else if (data && typeof data.text === "function") {
        data.text().then(harvestSocketText).catch(() => {});
      }
    } catch {
      // ignore
    }
  }

  try {
    const OriginalWebSocket = window.WebSocket;
    if (typeof OriginalWebSocket === "function") {
      class MosaWebSocket extends OriginalWebSocket {
        constructor(...args) {
          super(...args);
          try {
            this.addEventListener("message", (event) => {
              if (isCaptureEnabled()) harvestSocketData(event?.data);
            });
          } catch {
            // A socket that rejects listeners still works for the page.
          }
        }
      }
      window.WebSocket = MosaWebSocket;
    }
  } catch {
    // ignore
  }

  try {
    const obs = new MutationObserver((mutations) => {
      if (!isCaptureEnabled()) return;
      for (const m of mutations) {
        for (const node of m.addedNodes || []) {
          const imgs = [];
          if (node instanceof HTMLImageElement) imgs.push(node);
          else if (node?.querySelectorAll) imgs.push(...node.querySelectorAll("img"));
          for (const img of imgs) {
            const src = img.currentSrc || img.src;
            if (src) post("dom-image", { ...imageIdentity(src), imageUrl: src, width: img.naturalWidth, height: img.naturalHeight });
          }
        }
        if (m.type === "attributes" && m.target instanceof HTMLImageElement && m.attributeName === "src") {
          const src = m.target.currentSrc || m.target.src;
          if (src) post("dom-image", { ...imageIdentity(src), imageUrl: src, width: m.target.naturalWidth, height: m.target.naturalHeight });
        }
      }
    });
    const startObs = () => obs.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset"],
    });
    if (document.documentElement) startObs();
    else document.addEventListener("DOMContentLoaded", startObs, { once: true });
  } catch {
    // ignore
  }

  post("generation-meta", { prompt: "", promptScore: 0, imageUrl: "", via: "hook-ready", hookReady: true });
})();
