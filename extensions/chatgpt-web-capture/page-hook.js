/**
 * Page-world hook: bind generated-image metadata within one ChatGPT message.
 * Never broadcast one old caption onto every image URL in a payload.
 */
(function mosaPageHook() {
  if (window.__mosaPageHookInstalled) return;
  window.__mosaPageHookInstalled = true;
  let captureEnabled = false;
  const bridgeChannel = globalThis.crypto?.randomUUID?.()
    || `mosa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  function markReady() {
    if (document.documentElement) {
      try {
        document.documentElement.dataset.mosaPageHook = "1";
        document.documentElement.dataset.mosaPageHookChannel = bridgeChannel;
      } catch {
        // The hook itself still works in test/minimal document environments.
      }
      return;
    }
    document.addEventListener("DOMContentLoaded", markReady, { once: true });
  }
  markReady();

  const PROMPT_KEY_ALIASES = new Map([
    ["prompt", "prompt"],
    ["revised_prompt", "revised_prompt"], ["revisedprompt", "revised_prompt"],
    ["generation_prompt", "generation_prompt"], ["generationprompt", "generation_prompt"],
    ["image_prompt", "image_prompt"], ["imageprompt", "image_prompt"],
    ["original_prompt", "original_prompt"], ["originalprompt", "original_prompt"],
    ["caption", "caption"],
    ["model_caption", "model_caption"], ["modelcaption", "model_caption"],
    ["alt_text", "alt_text"], ["alttext", "alt_text"],
    ["metadata_caption", "metadata_caption"], ["metadatacaption", "metadata_caption"],
  ]);
  const URL_KEYS = new Set([
    "url", "download_url", "src", "image_url", "asset_url", "file_url",
    "encoded_image_url", "downloadurl", "imageurl", "asseturl", "fileurl", "encodedimageurl",
  ]);
  const ASSET_REFERENCE_KEYS = new Set([
    "asset_pointer", "assetpointer", "asset_id", "file_id", "image_id", "assetid", "fileid", "imageid",
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
  const GENERATION_STATUS_KEYS = new Set([
    "status", "state", "generation_status", "generationstatus",
    "result_status", "resultstatus", "finish_reason", "finishreason",
  ]);

  function post(type, payload) {
    try {
      window.postMessage({ source: "mosa-chatgpt-capture", channel: bridgeChannel, type, payload }, "*");
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
      if (!assetId) return null;
      return {
        conversationId,
        assetId,
        imageKey: conversationId ? `estuary:${conversationId}:${assetId}` : `asset:${assetId}`,
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

  function canonicalPromptKey(key) {
    return PROMPT_KEY_ALIASES.get(String(key || "").toLowerCase()) || "";
  }

  function looksLikePrompt(text) {
    const t = cleanPrompt(text);
    if (t.length < 24 || t.length > 12000) return false;
    if (/^(ok|yes|no|thanks|继续|好的)\b/i.test(t) && t.length < 60) return false;
    return true;
  }

  function looksLikeGenerationErrorText(text) {
    const t = cleanPrompt(text);
    if (!t) return false;
    return /^(?:generation|image generation|image|request|tool|operation)\b.{0,80}\b(?:failed|failure|error|timed?\s*out|timeout|cancelled|canceled|aborted|blocked|rejected|stopped)\b/i.test(t)
      || /\b(?:failed|unable|could(?:n't| not))\s+to\s+(?:generate|create|render|produce)\b/i.test(t)
      || /\b(?:image|generation)\s+(?:service|request)\b.{0,80}\b(?:timed?\s*out|timeout|failed|error)\b/i.test(t)
      || /\bpartial result\b.{0,80}\b(?:visible|available|returned)\b/i.test(t)
      || /\bpolicy violation\b/i.test(t)
      || /(?:生成失败|生成图片时出错|生成时出错|生成错误|生成超时|已取消生成|取消生成|生成已中止|生成被阻止|未能生成|生成已停止|仅返回部分结果|部分结果仍可见)/.test(t);
  }

  function normalizeGenerationStatus(value) {
    const raw = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (!raw) return "unknown";
    if (/^(?:completed?|succeeded|success|done|finished)$/.test(raw)) return "completed";
    if (/^(?:failed|failure|error|errored|rejected|timeout|timed_out)$/.test(raw)) return "failed";
    if (/^(?:cancelled|canceled|aborted|stopped)$/.test(raw)) return "cancelled";
    if (/^(?:partial|incomplete)$/.test(raw)) return "partial";
    if (/^(?:in_progress|running|generating|streaming|pending|queued)$/.test(raw)) return "in_progress";
    return "unknown";
  }

  function generationStatusFromObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
    for (const [key, child] of Object.entries(value)) {
      const lower = String(key).toLowerCase();
      if (GENERATION_STATUS_KEYS.has(lower) && typeof child === "string") {
        const status = normalizeGenerationStatus(child);
        if (status !== "unknown") return status;
      }
      if ((lower === "error" || lower === "failure") && child) return "failed";
    }
    return "unknown";
  }

  function generationStatusRank(status) {
    return ({ unknown: 0, in_progress: 1, partial: 2, failed: 3, cancelled: 3, completed: 4 })[status] || 0;
  }

  function preferGenerationStatus(current, candidate) {
    const next = normalizeGenerationStatus(candidate);
    return generationStatusRank(next) >= generationStatusRank(current) ? next : current;
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

  function promptPriority(key, { generationOwned = false } = {}) {
    const canonical = canonicalPromptKey(key);
    return ({
      revised_prompt: 700,
      generation_prompt: 650,
      image_prompt: 600,
      original_prompt: generationOwned ? 550 : 100,
      prompt: generationOwned ? 500 : 100,
      model_caption: 400,
      metadata_caption: 380,
      caption: 350,
      alt_text: 300,
    })[canonical] || 0;
  }

  function promptStatusForKey(key, { generationOwned = false } = {}) {
    const canonical = canonicalPromptKey(key);
    if (["revised_prompt", "generation_prompt", "image_prompt"].includes(canonical)) return "generation-tool-prompt";
    if (generationOwned && ["original_prompt", "prompt"].includes(canonical)) return "generation-tool-prompt";
    if (["metadata_caption", "caption", "model_caption", "alt_text"].includes(canonical)) return "visible-caption";
    return "user-message";
  }

  function isTrustedGenerationPromptKey(key, options = {}) {
    return promptStatusForKey(key, options) === "generation-tool-prompt";
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
      promptSource: extra.promptSource || "",
      promptPriority: Number(extra.promptPriority) || 0,
      promptScope: extra.promptScope || (p && identity.imageKey ? "output" : p ? "attempt" : ""),
      generationStatus: normalizeGenerationStatus(extra.generationStatus),
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
    const toolMarker = [
      message?.author?.name,
      message?.recipient,
      message?.metadata?.tool_name,
      message?.metadata?.command,
      message?.metadata?.invoked_plugin?.namespace,
    ].filter(Boolean).join(" ");
    const generationToolMarker = /(dall[-_.]?e|image[_ .-]?(gen|generation)|text2im|imagegen)/i.test(toolMarker)
      || Boolean(
        message?.metadata?.dalle
        || message?.metadata?.image_gen
        || message?.metadata?.imageGen
        || message?.metadata?.image_generation
        || message?.metadata?.imageGeneration,
      );
    const authorRole = String(message?.author?.role || "").toLowerCase();
    const generationOwnedMessage = generationToolMarker && ["tool", "assistant"].includes(authorRole);

    function emitScopedGenerationUnits(root) {
      if (!generationOwnedMessage) return 0;
      const units = new Map();
      const toolDefaults = new Map();

      function promptCandidate(key, value) {
        const canonical = canonicalPromptKey(key);
        if (!canonical || typeof value !== "string") return null;
        const text = cleanPrompt(value);
        const priority = promptPriority(canonical, { generationOwned: true });
        const status = promptStatusForKey(canonical, { generationOwned: true });
        if (!text || text.length > 12000 || looksLikeGenerationErrorText(text)) return null;
        if (status !== "generation-tool-prompt" && !looksLikePrompt(text)) return null;
        return { text, priority, promptStatus: status, promptSource: canonical };
      }

      function selectPrompt(candidates) {
        if (!candidates?.length) return null;
        const ordered = [...candidates].sort((a, b) => b.priority - a.priority);
        const best = ordered[0];
        const tied = ordered.filter((item) => item.priority === best.priority && item.text !== best.text);
        return tied.length ? null : best;
      }

      function selectPromptGroups(groups) {
        const selected = (groups || []).map(selectPrompt).filter(Boolean);
        if (!selected.length) return null;
        const byText = new Map();
        for (const prompt of selected) {
          const current = byText.get(prompt.text);
          if (!current || prompt.priority > current.priority) byText.set(prompt.text, prompt);
        }
        // Different prompt-only sibling objects are different scopes until the
        // provider proves otherwise. This keeps collage/panel prompts from
        // competing by field priority for ownership of the whole output.
        if (byText.size !== 1) return null;
        return [...byText.values()][0];
      }

      function unitFor(toolCallId, generationCallId) {
        const key = generationCallId ? `generation:${generationCallId}` : toolCallId ? `tool:${toolCallId}` : "";
        if (!key) return null;
        if (!units.has(key)) {
          units.set(key, {
            toolCallId: toolCallId || "",
            generationCallId: generationCallId || "",
            sharedPromptGroups: [],
            outputs: new Map(),
            model: "",
            generationStatus: "unknown",
          });
        }
        const unit = units.get(key);
        if (toolCallId) unit.toolCallId = toolCallId;
        if (generationCallId) unit.generationCallId = generationCallId;
        return unit;
      }

      function toolDefault(toolCallId) {
        if (!toolCallId) return null;
        if (!toolDefaults.has(toolCallId)) {
          toolDefaults.set(toolCallId, { promptGroups: [], model: "", generationStatus: "unknown" });
        }
        return toolDefaults.get(toolCallId);
      }

      function outputFor(unit, assetId, imageUrl) {
        if (!unit || (!assetId && !imageUrl)) return null;
        const proxy = imageUrl ? chatGptImageProxyInfo(imageUrl) : null;
        const resolvedAssetId = assetId || proxy?.assetId || "";
        const key = resolvedAssetId ? `asset:${resolvedAssetId}` : `url:${genericImageKey(imageUrl) || imageUrl}`;
        if (!unit.outputs.has(key)) {
          unit.outputs.set(key, {
            assetId: resolvedAssetId,
            imageUrl: imageUrl || "",
            prompts: [],
            generationStatus: "unknown",
          });
        }
        const output = unit.outputs.get(key);
        if (resolvedAssetId) output.assetId = resolvedAssetId;
        if (imageUrl && !output.imageUrl) output.imageUrl = imageUrl;
        return output;
      }

      const visit = (value, inheritedIds = {}, depth = 0) => {
        if (!value || depth > 14 || typeof value !== "object") return;
        if (Array.isArray(value)) {
          for (const item of value) visit(item, inheritedIds, depth + 1);
          return;
        }

        let toolCallId = inheritedIds.toolCallId || "";
        let generationCallId = inheritedIds.generationCallId || "";
        for (const [key, child] of Object.entries(value)) {
          const lower = String(key).toLowerCase();
          if (TOOL_CALL_ID_KEYS.has(lower) && typeof child === "string" && child.trim()) toolCallId = child.trim();
          if (GENERATION_CALL_ID_KEYS.has(lower) && typeof child === "string" && child.trim()) generationCallId = child.trim();
        }

        const unit = unitFor(toolCallId, generationCallId);
        const defaults = toolDefault(toolCallId);
        const localPrompts = [];
        const localAssets = [];
        const localUrls = [];
        let localModel = "";
        let localStatus = generationStatusFromObject(value);

        for (const [key, child] of Object.entries(value)) {
          const lower = String(key).toLowerCase();
          const prompt = promptCandidate(lower, child);
          if (prompt) localPrompts.push(prompt);
          if (ASSET_REFERENCE_KEYS.has(lower) && typeof child === "string") {
            const assetId = normalizeAssetId(child);
            if (assetId) localAssets.push(assetId);
          }
          if ((URL_KEYS.has(lower) || typeof child === "string") && isImageishUrl(child)) localUrls.push(child);
          if ((lower === "model" || lower === "model_slug") && typeof child === "string" && child.trim()) localModel = child.trim();
          if ((lower === "error" || lower === "failure") && child) localStatus = "failed";
        }

        if (unit) {
          if (localModel) unit.model = localModel;
          unit.generationStatus = preferGenerationStatus(unit.generationStatus, localStatus);

          const uniqueAssets = [...new Set(localAssets)];
          const uniqueUrls = [...new Set(localUrls)];
          const localOutputCount = uniqueAssets.length || uniqueUrls.length;

          if (uniqueAssets.length === 1) {
            const output = outputFor(unit, uniqueAssets[0], uniqueUrls[0] || "");
            output.generationStatus = preferGenerationStatus(output.generationStatus, localStatus);
            if (localPrompts.length) output.prompts.push(...localPrompts);
            for (const extraUrl of uniqueUrls.slice(1)) outputFor(unit, uniqueAssets[0], extraUrl);
          } else if (uniqueAssets.length > 1) {
            for (const assetId of uniqueAssets) {
              const output = outputFor(unit, assetId, "");
              output.generationStatus = preferGenerationStatus(output.generationStatus, localStatus);
            }
            if (localPrompts.length) unit.sharedPromptGroups.push(localPrompts);
          } else if (uniqueUrls.length === 1) {
            const output = outputFor(unit, "", uniqueUrls[0]);
            output.generationStatus = preferGenerationStatus(output.generationStatus, localStatus);
            if (localPrompts.length) output.prompts.push(...localPrompts);
          } else if (uniqueUrls.length > 1) {
            for (const imageUrl of uniqueUrls) {
              const output = outputFor(unit, "", imageUrl);
              output.generationStatus = preferGenerationStatus(output.generationStatus, localStatus);
            }
            if (localPrompts.length) unit.sharedPromptGroups.push(localPrompts);
          } else if (localPrompts.length) {
            unit.sharedPromptGroups.push(localPrompts);
          }

          if (!generationCallId && defaults) {
            if (localPrompts.length && !localOutputCount) defaults.promptGroups.push(localPrompts);
            if (localModel) defaults.model = localModel;
            defaults.generationStatus = preferGenerationStatus(defaults.generationStatus, localStatus);
          }
        }

        const nextIds = { toolCallId, generationCallId };
        for (const child of Object.values(value)) {
          if (child && typeof child === "object") visit(child, nextIds, depth + 1);
        }
      };

      visit(root);
      const explicitGenerationCounts = new Map();
      for (const unit of units.values()) {
        if (!unit.toolCallId || !unit.generationCallId) continue;
        explicitGenerationCounts.set(unit.toolCallId, (explicitGenerationCounts.get(unit.toolCallId) || 0) + 1);
      }
      const explicitGenerationUnitCount = [...units.values()].filter((unit) => unit.generationCallId).length;
      const outputUnitCount = [...units.values()].filter((unit) => unit.outputs.size > 0).length;
      const visibleMessageFailure = (message?.content?.parts || []).some((part) => (
        typeof part === "string" && looksLikeGenerationErrorText(part)
      ));
      let emitted = 0;
      for (const unit of units.values()) {
        const defaults = toolDefaults.get(unit.toolCallId) || null;
        const explicitGenerationCount = explicitGenerationCounts.get(unit.toolCallId) || 0;
        const canInheritToolDefaults = !unit.generationCallId || explicitGenerationCount <= 1;
        const sharedPrompt = selectPromptGroups(unit.sharedPromptGroups)
          || (canInheritToolDefaults ? selectPromptGroups(defaults?.promptGroups || []) : null);
        const model = unit.model || defaults?.model || "";
        let unitStatus = canInheritToolDefaults
          ? preferGenerationStatus(unit.generationStatus, defaults?.generationStatus || "unknown")
          : unit.generationStatus;
        if (visibleMessageFailure && explicitGenerationUnitCount <= 1 && outputUnitCount === 1 && unit.outputs.size) {
          unitStatus = preferGenerationStatus(unitStatus, "failed");
        }
        const attemptScope = unit.generationCallId || unit.toolCallId;
        const generationContextId = context.conversationId && attemptScope
          ? `chatgpt:${context.conversationId}:${attemptScope}`
          : attemptScope ? `chatgpt:${attemptScope}` : "";

        for (const output of unit.outputs.values()) {
          const outputPrompt = selectPrompt(output.prompts);
          const selected = outputPrompt || sharedPrompt;
          emitPair(selected?.text || "", output.imageUrl, {
            assetId: output.assetId,
            conversationId: context.conversationId,
            messageId: context.messageId,
            generationContextId,
            providerToolCallId: unit.toolCallId,
            providerGenerationCallId: unit.generationCallId,
            providerResponseId: context.responseId,
            promptStatus: selected?.promptStatus || "not-available",
            promptSource: selected?.promptSource || "",
            promptPriority: selected?.priority || 0,
            promptScope: outputPrompt ? "output" : selected ? "attempt" : "",
            generationStatus: output.generationStatus !== "unknown" ? output.generationStatus : unitStatus,
            model,
            via: "message-generation-unit",
            isGeneration: true,
          });
          emitted += 1;
        }

        const shadowedByExplicitGeneration = !unit.generationCallId && explicitGenerationCount > 0;
        if (!unit.outputs.size && sharedPrompt && !shadowedByExplicitGeneration) {
          emitPair(sharedPrompt.text, "", {
            conversationId: context.conversationId,
            messageId: context.messageId,
            generationContextId,
            providerToolCallId: unit.toolCallId,
            providerGenerationCallId: unit.generationCallId,
            providerResponseId: context.responseId,
            promptStatus: sharedPrompt.promptStatus,
            promptSource: sharedPrompt.promptSource,
            promptPriority: sharedPrompt.priority,
            promptScope: "attempt",
            generationStatus: unitStatus,
            model,
            via: "message-generation-attempt",
            isGeneration: true,
          });
          emitted += 1;
        }
      }
      return emitted;
    }

    const emittedNestedUnits = emitScopedGenerationUnits(message);
    if (emittedNestedUnits > 0) return;

    function rememberPrompt(key, value) {
      const canonical = canonicalPromptKey(key);
      if (!canonical || typeof value !== "string") return;
      const text = cleanPrompt(value);
      if (!text || text.length > 12000 || looksLikeGenerationErrorText(text)) return;
      if (!isTrustedGenerationPromptKey(canonical, { generationOwned: generationOwnedMessage }) && !looksLikePrompt(text)) return;
      const current = prompts.get(text);
      const priority = promptPriority(canonical, { generationOwned: generationOwnedMessage });
      if (!current || priority > current.priority) {
        prompts.set(text, {
          text,
          priority,
          promptStatus: promptStatusForKey(canonical, { generationOwned: generationOwnedMessage }),
          promptSource: canonical,
        });
      }
    }

    // ChatGPT's current image tool often leaves dalle.prompt blank, while the
    // same tool message exposes the caption as a plain string in content.parts.
    // The "Model caption:" marker is OpenAI wording that has changed before, so
    // an unmarked caption is accepted too — but only inside a tool message that
    // owns the image, which is where a caption lives and chat prose does not.
    function rememberVisibleCaption(value, { hasImageAsset, authorRole, generationOwned }) {
      const text = cleanPrompt(value);
      if (!text || text.length > 12000 || looksLikeGenerationErrorText(text)) return;
      const markedCaption = /^model caption\s*:/i.test(text);
      if (!markedCaption) {
        if (!hasImageAsset || !["tool", "assistant"].includes(authorRole)) return;
        if (authorRole === "assistant" && !generationOwned) return;
        if (authorRole === "tool" && !generationOwned && !looksLikeGenerationCaption(text)) return;
        if (/^(?:image generated|generated image|done|completed|success|已生成|生成完成|完成)[.!。！]?$/i.test(text)) return;
      } else if (!looksLikePrompt(text)) {
        return;
      }
      const current = prompts.get(text);
      const priority = markedCaption ? 425 : 325;
      if (!current || priority > current.priority) {
        prompts.set(text, { text, priority, promptStatus: "visible-caption", promptSource: "message-visible-caption" });
      }
    }

    let messageGenerationStatus = generationStatusFromObject(message);
    function scan(value, depth = 0) {
      if (!value || depth > 14 || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) scan(item, depth + 1);
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        const lower = String(key).toLowerCase();
        if (GENERATION_STATUS_KEYS.has(lower) && typeof child === "string") {
          messageGenerationStatus = preferGenerationStatus(messageGenerationStatus, child);
        }
        if ((lower === "error" || lower === "failure") && child) {
          messageGenerationStatus = preferGenerationStatus(messageGenerationStatus, "failed");
        }
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
      authorRole,
      generationOwned: generationOwnedMessage,
    };
    for (const part of message?.content?.parts || []) {
      if (typeof part === "string") {
        if (looksLikeGenerationErrorText(part)) {
          messageGenerationStatus = preferGenerationStatus(messageGenerationStatus, "failed");
        }
        rememberVisibleCaption(part, captionContext);
      }
    }
    const orderedPrompts = [...prompts.values()].sort((a, b) => b.priority - a.priority);
    const selected = orderedPrompts[0];
    const equallyPreferred = selected ? orderedPrompts.filter((item) => item.priority === selected.priority) : [];
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
        promptSource: boundPrompt?.promptSource || "",
        promptPriority: boundPrompt?.priority || 0,
        promptScope: boundPrompt ? (assetIds.size + imageUrls.size > 1 ? "attempt" : "output") : "",
        generationStatus: messageGenerationStatus,
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
        promptSource: boundPrompt?.promptSource || "",
        promptPriority: boundPrompt?.priority || 0,
        promptScope: boundPrompt ? (assetIds.size + imageUrls.size > 1 ? "attempt" : "output") : "",
        generationStatus: messageGenerationStatus,
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
        promptSource: boundPrompt.promptSource || "",
        promptPriority: boundPrompt.priority || 0,
        promptScope: "attempt",
        generationStatus: messageGenerationStatus,
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
    let localPromptStatus = "not-available";
    let localPromptPriority = 0;
    let localPromptSource = "";
    let localUrl = "";
    let localAssetId = "";
    let localModel = "";
    let localGenerationStatus = generationStatusFromObject(node);

    for (const [key, value] of Object.entries(node)) {
      const lower = String(key).toLowerCase();
      const canonical = canonicalPromptKey(lower);
      if (canonical && typeof value === "string") {
        const status = promptStatusForKey(canonical);
        const text = cleanPrompt(value);
        const priority = promptPriority(canonical);
        if (text && !looksLikeGenerationErrorText(text) && text.length <= 12000 && (status === "generation-tool-prompt" || looksLikePrompt(text)) && priority >= localPromptPriority) {
          localPrompt = text;
          localPromptStatus = status;
          localPromptPriority = priority;
          localPromptSource = canonical;
        }
      } else if ((lower === "error" || lower === "failure") && value) {
        localGenerationStatus = preferGenerationStatus(localGenerationStatus, "failed");
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

    const localGenerationEvidence = localPromptStatus === "generation-tool-prompt" || Boolean(context.generationCallId);

    if (localPrompt && localUrl) {
      emitPair(localPrompt, localUrl, {
        ...context,
        model: localModel,
        promptStatus: localPromptStatus,
        promptSource: localPromptSource,
        promptPriority: localPromptPriority,
        promptScope: "output",
        generationStatus: localGenerationStatus,
        via: "same-object",
        isGeneration: localGenerationEvidence,
      });
      return;
    }
    if (localPrompt && localAssetId) {
      emitPair(localPrompt, "", {
        ...context,
        assetId: localAssetId,
        model: localModel,
        promptStatus: localPromptStatus,
        promptSource: localPromptSource,
        promptPriority: localPromptPriority,
        promptScope: "output",
        generationStatus: localGenerationStatus,
        via: "same-object-asset",
        isGeneration: localGenerationEvidence,
      });
      return;
    }
    if (localUrl) {
      emitPair("", localUrl, { ...context, model: localModel, generationStatus: localGenerationStatus, via: "url-only", isGeneration: localGenerationEvidence });
    } else if (localAssetId && localGenerationEvidence) {
      emitPair("", "", { ...context, assetId: localAssetId, model: localModel, generationStatus: localGenerationStatus, via: "asset-only", isGeneration: true });
    }
    if (localPrompt && !localUrl && !localAssetId) {
      emitPair(localPrompt, "", {
        ...context,
        model: localModel,
        promptStatus: localPromptStatus,
        promptSource: localPromptSource,
        promptPriority: localPromptPriority,
        promptScope: "attempt",
        generationStatus: localGenerationStatus,
        via: "prompt-only",
        isGeneration: localGenerationEvidence,
      });
    }
  }

  function harvest(text, via) {
    if (!text || text.length < 20) return;
    const maxHarvestBytes = via === "conversation-refresh" ? 32_000_000 : 12_000_000;
    if (text.length > maxHarvestBytes) {
      post("harvest-skipped", { reason: "payload-too-large", size: text.length, via });
      return;
    }
    // Only enter the SSE parser when the payload actually contains an SSE
    // data record. Ordinary conversation JSON may contain the substring
    // "data:" inside prompts, code blocks, captions, or data URLs; treating
    // that as SSE used to skip JSON.parse() for the whole conversation.
    if (/^\s*data:/m.test(text)) {
      let parsedEvent = false;
      for (const line of text.split(/\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          walkObject(JSON.parse(payload), { conversationId: conversationIdFromLocation() });
          parsedEvent = true;
        } catch {
          // ignore
        }
      }
      if (parsedEvent) return;
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
        const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
        if (/json/.test(contentType)) {
          // The explicit recovery endpoint is already structured conversation
          // JSON. Parse it directly instead of materializing a second giant
          // text copy and rejecting long chats by byte count. This keeps late
          // Prompt recovery working for very large creative conversations.
          walkObject(await response.json(), { conversationId });
        } else {
          harvest(await response.text(), "conversation-refresh");
        }
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
    if (data.channel !== bridgeChannel) return;
    if (data.type === "set-capture-enabled") {
      captureEnabled = data.payload?.enabled === true;
      post("capture-state", { enabled: captureEnabled });
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
          if (/json/.test(contentType) && /\/backend-api\/(?:f\/)?conversation\//i.test(String(url))) {
            clone.json()
              .then((payload) => walkObject(payload, { conversationId: conversationIdFromLocation() }))
              .catch(() => {});
          } else {
            clone.text().then((text) => harvest(text, "fetch")).catch(() => {});
          }
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
          if (!/^image\//.test(contentType)) {
            const responseType = String(this.responseType || "").toLowerCase();
            const text = responseType === "" || responseType === "text"
              ? (this.responseText || "")
              : responseType === "json" && this.response
                ? JSON.stringify(this.response)
                : "";
            if (text) harvest(text, "xhr");
          }
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
  const WS_INTEREST = /asset_pointer|asset_id|file_id|image_id|file-service|sediment|revised_prompt|generation_prompt|image_prompt|generation_call_id|image_generation_call_id|image_gen_call_id|tool_call_id|toolcallid|model[ _]caption|["']prompt["']\s*:|generation_status|finish_reason|["'](?:error|failure)["']\s*:|image[_ .-]?(gen|generation)|imagegen|dalle|oaiusercontent|estuary/i;

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
        if (
          m.type === "attributes"
          && m.target instanceof HTMLImageElement
          && (m.attributeName === "src" || m.attributeName === "srcset")
        ) {
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
