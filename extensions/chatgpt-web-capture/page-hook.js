/**
 * Page-world hook: bind generated-image metadata within one ChatGPT message.
 * Never broadcast one old caption onto every image URL in a payload.
 */
(function mosaPageHook() {
  if (window.__mosaPageHookInstalled) return;
  window.__mosaPageHookInstalled = true;

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

  function post(type, payload) {
    try {
      window.postMessage({ source: "mosa-chatgpt-capture", type, payload }, "*");
    } catch {
      // ignore
    }
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
      promptStatus: extra.promptStatus || (p ? "user-message" : "not-available"),
      model: extra.model || "",
      capturedAt: new Date().toISOString(),
      via: extra.via || "network",
      bound: Boolean(p && identity.imageKey),
    };
    post("generation-meta", payload);
    if (url) post("auto-image", payload);
  }

  function emitMessageBindings(node, inherited) {
    const message = node.message && typeof node.message === "object" ? node.message : node;
    const context = contextForNode(node, inherited);
    const prompts = new Map();
    const assetIds = new Set();
    const imageUrls = new Set();
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
    // same tool message exposes a "Model caption:" string in content.parts.
    // Accept it only when the enclosing message also owns an image asset.
    function rememberVisibleCaption(value) {
      const text = cleanPrompt(value);
      if (!/^model caption:/i.test(text) || !looksLikePrompt(text)) return;
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
        if ((URL_KEYS.has(lower) || typeof child === "string") && isImageishUrl(child)) imageUrls.add(child);
        if ((lower === "model" || lower === "model_slug") && typeof child === "string" && child.trim()) model = child.trim();
        if (child && typeof child === "object") scan(child, depth + 1);
      }
    }

    scan(message);
    for (const part of message?.content?.parts || []) {
      if (typeof part === "string") rememberVisibleCaption(part);
    }
    const orderedPrompts = [...prompts.values()].sort((a, b) => b.priority - a.priority);
    const selected = orderedPrompts[0];
    const equallyPreferred = selected ? orderedPrompts.filter((item) => item.priority === selected.priority) : [];
    // Two distinct top-ranked prompts in one message cannot be matched safely.
    if (!selected || equallyPreferred.length !== 1) return;

    const onlyAssetId = assetIds.size === 1 ? [...assetIds][0] : "";
    for (const imageUrl of imageUrls) {
      emitPair(selected.text, imageUrl, {
        assetId: onlyAssetId,
        conversationId: context.conversationId,
        messageId: context.messageId,
        promptStatus: selected.promptStatus,
        model,
        via: "message-metadata-url",
      });
    }
    for (const assetId of assetIds) {
      emitPair(selected.text, "", {
        assetId,
        conversationId: context.conversationId,
        messageId: context.messageId,
        promptStatus: selected.promptStatus,
        model,
        via: "message-metadata-asset",
      });
    }
    if (!imageUrls.size && !assetIds.size) {
      emitPair(selected.text, "", {
        conversationId: context.conversationId,
        messageId: context.messageId,
        promptStatus: selected.promptStatus,
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

  const originalFetch = window.fetch;
  window.fetch = async function mosaFetch(...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      if (/chatgpt\.com|openai\.com|backend-api|conversation|images?|oaiusercontent/i.test(String(url))) {
        const clone = response.clone();
        clone.text().then((text) => harvest(text, "fetch")).catch(() => {});
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
      try {
        const url = String(this.__mosaUrl || "");
        if (/chatgpt\.com|openai\.com|backend-api|conversation|images?|oaiusercontent/i.test(url)) {
          harvest(this.responseText || "", "xhr");
        }
      } catch {
        // ignore
      }
    });
    return originalSend.apply(this, args);
  };

  try {
    const obs = new MutationObserver((mutations) => {
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
