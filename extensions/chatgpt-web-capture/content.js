(() => {
  // Real generation CDNs. ChatGPT may proxy a generated asset through Estuary.
  const GENERATION_HOST_HINTS = [
    "oaiusercontent.com",
    "oaidalle",
    "files.oaiusercontent",
    "images.openai.com",
  ];
  const BLOCK_URL_HINTS = [
    "oaistatic.com",
    "avatar",
    "favicon",
    "emoji",
    "sprite",
    "logo",
    "icon",
    "/_next/",
    "profile",
  ];
  const MIN_EDGE = 480; // px — drop small UI logos
  const MIN_BYTES = 20 * 1024; // server also enforces this
  const COMPOSER_SELECTOR = 'form, [data-type="unified-composer"], [data-testid="composer"]';
  const STYLE_HINTS = [
    "poster", "illustration", "typography", "vector", "style", "lighting",
    "camera", "composition", "palette", "cinematic", "editorial", "scene",
    "caption", "graphic", "layout", "海报", "插画", "构图", "光影", "风格", "场景",
  ];

  /** @type {Array<{prompt:string,promptScore:number,imageUrl:string,imageKey:string,assetId:string,promptStatus:string,messageId:string,model:string,capturedAt:string,via:string,bound?:boolean}>} */
  const networkMeta = [];
  /** Stable image identity -> latest bound prompt for that exact generated asset */
  const imagePromptMap = new Map();
  /** Recent unbound prompts (prompt-only events), newest last */
  const recentPrompts = [];
  const inFlight = new Set();
  const savedKeys = new Set();
  /**
   * Stable image identities already archived in this page session. One uploaded
   * reference photo renders under several URLs (composer blob, Estuary proxy,
   * signed CDN link), so keying only on the raw src archived it once per URL.
   */
  const savedIdentityKeys = new Set();
  /** Stable image identity -> candidate retained for a late prompt upgrade. */
  const capturedCandidates = new Map();
  /** Stable image identity -> best prompt rank sent to MOSA in this page session. */
  const savedPromptRanks = new Map();
  const promptUpgradeInFlight = new Set();
  const promptRecoveryTimers = new Map();
  const failedAt = new Map(); // key -> timestamp, retry after cooldown
  // The conversation endpoint is enough to recover a caption that was rendered
  // from ChatGPT's cache, but was never seen by the page network hook.
  const conversationRefreshRequestedAt = new Map();
  const CONVERSATION_REFRESH_COOLDOWN_MS = 2_500;
  let toastTimer = null;
  let autoCapture = true;
  let scanTimer = null;
  let lastUrl = location.href;
  let hookReady = document.documentElement?.dataset?.mosaPageHook === "1";
  let lastError = "";
  let lastStatus = "starting";
  let autoQueue = Promise.resolve();
  let contextLost = false;
  let autoScanInterval = null;
  let observer = null;

  function showToast(message, isError = false) {
    let el = document.getElementById("mosa-capture-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "mosa-capture-toast";
      el.className = "mosa-capture-toast";
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = message;
    el.classList.toggle("is-error", Boolean(isError));
    el.classList.add("is-visible");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-visible"), 4200);
  }

  function setStatus(text, isError = false) {
    lastStatus = text;
    if (isError) lastError = text;
    const dock = document.getElementById("mosa-capture-dock");
    const status = dock?.querySelector?.('[data-role="status"]');
    if (status) {
      status.textContent = text;
      status.classList.toggle("is-error", Boolean(isError));
    }
  }

  function conversationIdFromUrl() {
    const match = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/);
    return match ? match[1] : "";
  }

  function isBlockedUrl(src) {
    const lower = String(src || "").toLowerCase();
    return BLOCK_URL_HINTS.some((hint) => lower.includes(hint));
  }

  function chatGptImageProxyInfo(src) {
    try {
      const url = new URL(src, location.href);
      const host = url.hostname.toLowerCase();
      if (!(["chatgpt.com", "chat.openai.com"].includes(host)) || url.pathname !== "/backend-api/estuary/content") {
        return null;
      }
      const conversationId = url.searchParams.get("cid") || "";
      const assetId = url.searchParams.get("id") || "";
      if (!conversationId || !assetId) return null;
      return { conversationId, assetId, imageKey: `estuary:${conversationId}:${assetId}` };
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

  function imageLookupKeys(imageUrl, meta = {}) {
    const keys = [];
    const explicitKey = String(meta.imageKey || "").trim();
    if (explicitKey) keys.push(explicitKey);
    const explicitAssetId = normalizeAssetId(meta.assetId);
    if (explicitAssetId) keys.push(`asset:${explicitAssetId}`);

    const direct = String(imageUrl || "").trim();
    if (/^(?:estuary|asset|url):/.test(direct)) keys.push(direct);
    const proxy = chatGptImageProxyInfo(direct);
    if (proxy) {
      keys.push(proxy.imageKey, `asset:${proxy.assetId}`);
    } else if (direct) {
      try {
        const url = new URL(direct, location.href);
        // One ChatGPT file is served both through the Estuary proxy and from a
        // signed CDN link. Without the shared file id those read as two images.
        const fileId = /\/(file[-_][A-Za-z0-9]{6,})(?:[./]|$)/.exec(url.pathname)?.[1] || "";
        if (fileId) keys.push(`asset:${fileId}`);
        keys.push(`url:${url.origin}${url.pathname}`);
      } catch {
        // Ignore malformed lookup values.
      }
    }
    return [...new Set(keys)];
  }

  function isLikelyGeneratedUrl(src) {
    if (!src) return false;
    if (isBlockedUrl(src)) return false;
    if (src.startsWith("blob:")) return true;
    if (src.startsWith("data:image/")) return !src.startsWith("data:image/svg");
    if (chatGptImageProxyInfo(src)) return true;
    try {
      const full = new URL(src, location.href).hostname + src;
      return GENERATION_HOST_HINTS.some((hint) => full.includes(hint));
    } catch {
      return false;
    }
  }

  function scorePromptText(text) {
    const t = String(text || "").trim();
    if (!t) return 0;
    let score = Math.min(t.length, 2500) / 15;
    for (const word of STYLE_HINTS) {
      if (t.toLowerCase().includes(word.toLowerCase())) score += 10;
    }
    if (t.length < 50 && /^(换|改|再|生成|做|来|版本|三版|两版|地区|继续|好的|嗯|在做)/.test(t)) score -= 40;
    if (/^model caption:/i.test(t)) score += 30;
    const latin = (t.match(/[A-Za-z]/g) || []).length;
    if (latin > 80) score += 20;
    return score;
  }

  function isWeakChatPrompt(text) {
    const t = String(text || "").trim();
    if (!t) return true;
    if (/^model caption:/i.test(t)) return false;
    if (t.length >= 120 && scorePromptText(t) >= 25) return false;
    if (t.length < 100) return true;
    if (/^(换|改|再|做|来|在做|生成|请|帮)/.test(t)) return true;
    return false;
  }

  function looksLikeGenerationCaption(text) {
    const t = String(text || "").trim();
    if (t.length < 80) return false;
    if (/^model caption:/i.test(t)) return true;
    const hits = STYLE_HINTS.filter((w) => t.toLowerCase().includes(w.toLowerCase()));
    return hits.length >= 2 || (t.length > 200 && hits.length >= 1);
  }

  /**
   * An attachment still sitting in the composer is not part of the conversation
   * yet, and ChatGPT re-renders it inside the sent message at a capped size.
   * Capturing both archived one upload as two differently sized assets.
   */
  function isComposerNode(node) {
    const scope = node?.closest?.(COMPOSER_SELECTOR);
    if (!scope) return false;
    if (scope.matches?.('[data-type="unified-composer"], [data-testid="composer"]')) return true;
    // A bare <form> is the composer only when it owns the prompt input, so a
    // future ChatGPT layout cannot silently mute capture for the whole thread.
    return Boolean(scope.querySelector?.('textarea, [contenteditable="true"]'));
  }

  /** A picture inside a user turn is an uploaded reference, not a generation. */
  function isReferenceCandidate(candidate) {
    return Boolean(candidate?.el?.closest?.('[data-message-author-role="user"]'));
  }

  function looksLikeGeneratedImage(img, { manual = false } = {}) {
    if (!(img instanceof HTMLImageElement)) return false;
    if (img.closest("#mosa-capture-dock")) return false;
    if (!manual && isComposerNode(img)) return false;
    const src = img.currentSrc || img.src || "";
    if (!src || isBlockedUrl(src)) return false;
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    const minEdge = manual ? 360 : MIN_EDGE;
    if (w > 0 && h > 0) {
      if (w < minEdge || h < minEdge) return false;
      const ratio = w / h;
      // Block smallish square logos; allow large square gens.
      if (ratio > 0.85 && ratio < 1.15 && Math.min(w, h) < 700 && !isLikelyGeneratedUrl(src) && !manual) {
        return false;
      }
    }
    if (isLikelyGeneratedUrl(src)) return true;
    if (src.startsWith("blob:") && (w >= minEdge || manual)) return true;
    // Manual: accept any large on-page image (full viewer often uses non-CDN hosts).
    if (manual && w >= minEdge && h >= minEdge) return true;
    if (w >= 700 && h >= 700) return true;
    return false;
  }

  function isArchiveWorthyCandidate(candidate, { manual = false, byteLength = 0 } = {}) {
    if (!candidate) return false;
    if (byteLength > 0 && byteLength < MIN_BYTES) return false;
    const w = candidate.width || 0;
    const h = candidate.height || 0;
    const minEdge = manual ? 360 : MIN_EDGE;
    if (w > 0 && h > 0 && (w < minEdge || h < minEdge)) return false;
    const url = candidate.imageUrl || candidate.key || "";
    if (isBlockedUrl(url)) return false;
    if (manual) return true;
    // Network-only auto candidates without dimensions: require generation CDN or blob.
    if ((!w || !h) && url && !url.startsWith("blob:") && !isLikelyGeneratedUrl(url)) return false;
    return true;
  }

  function collectDomCandidates({ manual = false } = {}) {
    const byKey = new Map();
    for (const img of document.querySelectorAll("img")) {
      if (!looksLikeGeneratedImage(img, { manual })) continue;
      const src = img.currentSrc || img.src;
      if (!src || byKey.has(src)) continue;
      byKey.set(src, {
        key: src,
        el: img,
        imageUrl: src.startsWith("data:") ? "" : src,
        dataUrl: src.startsWith("data:") ? src : "",
        width: img.naturalWidth || img.width || 0,
        height: img.naturalHeight || img.height || 0,
      });
    }
    // CSS backgrounds
    for (const el of document.querySelectorAll("div, section, main, figure")) {
      const rect = el.getBoundingClientRect?.();
      if (!rect || rect.width < (manual ? 300 : 360) || rect.height < (manual ? 300 : 360)) continue;
      if (!manual && isComposerNode(el)) continue;
      const bg = getComputedStyle(el).backgroundImage || "";
      const match = /url\(["']?(https?:\/\/[^"')]+|blob:[^"')]+)["']?\)/i.exec(bg);
      if (!match) continue;
      const url = match[1];
      if (isBlockedUrl(url) || byKey.has(url)) continue;
      if (!manual && !isLikelyGeneratedUrl(url) && !url.startsWith("blob:")) continue;
      byKey.set(url, {
        key: url,
        el,
        imageUrl: url.startsWith("data:") ? "" : url,
        dataUrl: url.startsWith("data:") ? url : "",
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    }
    return [...byKey.values()].sort((a, b) => (b.width * b.height) - (a.width * a.height));
  }

  function currentViewportCandidate(candidates) {
    const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
    const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
    const visible = candidates
      .map((candidate) => ({ candidate, rect: candidate.el?.getBoundingClientRect?.() }))
      .filter(({ rect }) => rect && rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight && rect.left < viewportWidth)
      .sort((a, b) => {
        const aVisibleArea = Math.max(0, Math.min(a.rect.bottom, viewportHeight) - Math.max(a.rect.top, 0))
          * Math.max(0, Math.min(a.rect.right, viewportWidth) - Math.max(a.rect.left, 0));
        const bVisibleArea = Math.max(0, Math.min(b.rect.bottom, viewportHeight) - Math.max(b.rect.top, 0))
          * Math.max(0, Math.min(b.rect.right, viewportWidth) - Math.max(b.rect.left, 0));
        return bVisibleArea - aVisibleArea;
      });
    return visible[0]?.candidate || candidates[0] || null;
  }

  function domCandidateForImage(imageUrl) {
    const wantedKeys = imageLookupKeys(imageUrl);
    if (!wantedKeys.length) return null;
    return collectDomCandidates().find((candidate) => (
      candidateLookupKeys(candidate).some((key) => wantedKeys.includes(key))
    )) || null;
  }

  function enqueueDomCandidateForImage(imageUrl, reason) {
    const candidate = domCandidateForImage(imageUrl);
    if (candidate) {
      enqueueAuto(candidate, reason);
      return true;
    }
    scheduleScan(true);
    return false;
  }

  const CONTEXT_LOST_MESSAGE = "MOSA 扩展已更新或重载，本页脚本已失联：请按 Cmd+Shift+R 硬刷新本页恢复捕获";

  function extensionAlive() {
    try {
      return typeof chrome === "object" && Boolean(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  /**
   * Reloading or re-adding the unpacked extension orphans this already-injected
   * script: the dock stays on screen while chrome.runtime is gone, so every
   * save died with a raw "Cannot read properties of undefined". Say what
   * happened once, freeze the buttons, and stop the scan machinery.
   */
  function markContextLost() {
    if (contextLost) return;
    contextLost = true;
    if (autoScanInterval) clearInterval(autoScanInterval);
    if (scanTimer) clearTimeout(scanTimer);
    observer?.disconnect();
    for (const timers of promptRecoveryTimers.values()) {
      for (const timer of timers) clearTimeout(timer);
    }
    promptRecoveryTimers.clear();
    const dock = document.getElementById("mosa-capture-dock");
    for (const btn of dock?.querySelectorAll?.("[data-action]") || []) {
      btn.disabled = true;
    }
    setStatus(CONTEXT_LOST_MESSAGE, true);
    showToast(CONTEXT_LOST_MESSAGE, true);
  }

  async function runtimeSend(message) {
    if (!extensionAlive() || typeof chrome.runtime?.sendMessage !== "function") {
      markContextLost();
      throw new Error(CONTEXT_LOST_MESSAGE);
    }
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (chrome.runtime.lastError) {
        throw new Error(chrome.runtime.lastError.message);
      }
      if (response === undefined) {
        throw new Error("扩展后台无响应：请到 chrome://extensions 刷新 MOSA 扩展，再 Cmd+Shift+R 刷新本页");
      }
      return response;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/Extension context invalidated|context invalidated|reading 'sendMessage'/i.test(msg)) {
        markContextLost();
        throw new Error(CONTEXT_LOST_MESSAGE);
      }
      if (/Receiving end does not exist|Could not establish connection/i.test(msg)) {
        throw new Error("扩展后台未连接：请在 chrome://extensions 打开 MOSA 并点刷新，再硬刷新本页");
      }
      throw error instanceof Error ? error : new Error(msg);
    }
  }

  function cleanPromptText(text) {
    return String(text || "")
      .replace(/<\|has_watermark\|>/g, "")
      .replace(/\n?展开\s*$/g, "")
      .trim();
  }

  function isShortEditCommand(text) {
    const t = String(text || "").trim();
    if (!t) return false;
    if (t.length > 160) return false;
    return /^(换|改|再|生成|做|来|版本|三版|两版|地区|继续|改成|换成|变成|变成|用|请)/.test(t)
      || /改成|换成|变成|版本|地区|北京|上海|东京|曼谷|bangkok|beijing/i.test(t) && t.length < 120;
  }

  function extractPlaceHints(text) {
    const t = String(text || "");
    const hints = [];
    const pairs = [
      [/北京|beijing/i, ["北京", "beijing", "peking"]],
      [/上海|shanghai/i, ["上海", "shanghai"]],
      [/东京|tokyo/i, ["东京", "tokyo"]],
      [/曼谷|bangkok/i, ["曼谷", "bangkok"]],
      [/首尔|seoul/i, ["首尔", "seoul"]],
      [/巴黎|paris/i, ["巴黎", "paris"]],
      [/伦敦|london/i, ["伦敦", "london"]],
      [/纽约|new york/i, ["纽约", "new york"]],
    ];
    for (const [re, keys] of pairs) {
      if (re.test(t)) hints.push(...keys);
    }
    return hints;
  }

  function promptMentionsPlace(prompt, placeHints) {
    if (!placeHints.length) return true;
    const lower = String(prompt || "").toLowerCase();
    return placeHints.some((h) => lower.includes(String(h).toLowerCase()));
  }

  function rememberMeta(item) {
    const prompt = cleanPromptText(item.prompt || "");
    const imageUrl = String(item.imageUrl || "");
    const imageKey = String(item.imageKey || "");
    const assetId = normalizeAssetId(item.assetId);
    const entry = {
      prompt,
      promptScore: Number(item.promptScore) || scorePromptText(prompt),
      imageUrl,
      imageKey,
      assetId,
      promptStatus: String(item.promptStatus || item.prompt_status || ""),
      messageId: String(item.messageId || item.message_id || ""),
      model: String(item.model || ""),
      capturedAt: String(item.capturedAt || new Date().toISOString()),
      via: String(item.via || "network"),
      bound: Boolean(item.bound || (prompt && imageUrl)),
    };
    networkMeta.push(entry);
    if (networkMeta.length > 120) networkMeta.splice(0, networkMeta.length - 120);

    const lookupKeys = imageLookupKeys(imageUrl, { imageKey, assetId });
    if (prompt && lookupKeys.length) {
      for (const key of lookupKeys) imagePromptMap.set(key, entry);
    } else if (prompt) {
      recentPrompts.push({ ...entry, at: Date.now() });
      if (recentPrompts.length > 40) recentPrompts.splice(0, recentPrompts.length - 40);
    }
    return entry;
  }

  /**
   * Bound prompt only — never reuse the highest-score caption from the whole chat
   * (that was attaching the first Bangkok caption to every later city image).
   */
  function findBoundPromptForImage(imageUrl) {
    const wantedKeys = imageLookupKeys(imageUrl);
    for (const key of wantedKeys) {
      if (imagePromptMap.has(key)) return imagePromptMap.get(key);
    }
    return [...networkMeta].reverse().find((item) => (
      item.prompt && imageLookupKeys(item.imageUrl, item).some((key) => wantedKeys.includes(key))
    )) || null;
  }

  function promptQuality(promptStatus, prompt) {
    const rank = {
      "not-available": 0,
      "user-message": 1,
      "visible-caption": 2,
      "generation-tool-prompt": 3,
    }[String(promptStatus || "")] ?? 0;
    return rank * 10_000 + Math.min(cleanPromptText(prompt).length, 5_000);
  }

  function candidateLookupKeys(candidate) {
    return imageLookupKeys(candidate?.imageUrl || candidate?.key || "");
  }

  function rememberCandidate(candidate) {
    for (const key of candidateLookupKeys(candidate)) capturedCandidates.set(key, candidate);
  }

  /** One archived picture, whichever URL variant or DOM node surfaced it. */
  function isSavedCandidate(candidate) {
    const key = candidate?.key || candidate?.imageUrl;
    if (key && savedKeys.has(key)) return true;
    return candidateLookupKeys(candidate).some((identity) => savedIdentityKeys.has(identity));
  }

  function rememberSavedCandidate(candidate) {
    const key = candidate?.key || candidate?.imageUrl;
    if (key) savedKeys.add(key);
    for (const identity of candidateLookupKeys(candidate)) savedIdentityKeys.add(identity);
  }

  function rememberSavedPrompt(candidate, resolved) {
    const rank = promptQuality(resolved?.promptStatus, resolved?.prompt);
    for (const key of candidateLookupKeys(candidate)) {
      savedPromptRanks.set(key, Math.max(savedPromptRanks.get(key) ?? -1, rank));
    }
  }

  function savedPromptRankForMeta(meta) {
    const keys = imageLookupKeys(meta?.imageUrl || "", meta || {});
    let rank = -1;
    for (const key of keys) rank = Math.max(rank, savedPromptRanks.get(key) ?? -1);
    return { keys, rank };
  }

  function findCandidateForMeta(keys) {
    for (const key of keys) {
      const remembered = capturedCandidates.get(key);
      if (remembered) return remembered;
    }
    return collectDomCandidates().find((candidate) => (
      candidateLookupKeys(candidate).some((key) => keys.includes(key))
    )) || null;
  }

  /**
   * The conversation metadata can arrive after the image bytes. Re-send only
   * an already archived, lower-quality image; MOSA's hash dedupe upgrades it.
   */
  function schedulePromptUpgrade(meta) {
    if (!cleanPromptText(meta?.prompt)) return;
    const { keys, rank: savedRank } = savedPromptRankForMeta(meta);
    const nextRank = promptQuality(meta.promptStatus, meta.prompt);
    if (!keys.length || savedRank < 0 || savedRank >= nextRank) return;
    const candidate = findCandidateForMeta(keys);
    if (!candidate) return;
    const candidateKey = candidate.key || candidate.imageUrl;
    if (!candidateKey || promptUpgradeInFlight.has(candidateKey)) return;
    clearPromptRecovery(candidateKey);

    promptUpgradeInFlight.add(candidateKey);
    autoQueue = autoQueue
      .then(() => ingestCandidate(candidate, {
        silentSkip: true,
        reason: "prompt-upgrade",
        force: true,
      }))
      .catch(() => {})
      .finally(() => promptUpgradeInFlight.delete(candidateKey));
  }

  function clearPromptRecovery(candidateKey) {
    const timers = promptRecoveryTimers.get(candidateKey);
    if (timers) {
      for (const timer of timers) clearTimeout(timer);
      promptRecoveryTimers.delete(candidateKey);
    }
  }

  function schedulePromptRecovery(candidate) {
    const candidateKey = candidate?.key || candidate?.imageUrl;
    const imageRef = candidate?.imageUrl || candidateKey || "";
    if (!candidateKey || !imageRef || promptRecoveryTimers.has(candidateKey)) return;

    // The image can become visible before ChatGPT stores its tool caption.
    // Retry only this conversation twice; a later bound caption upgrades the
    // already archived fallback through the normal hash-dedupe route.
    const delays = [2_800, 7_200];
    const timers = delays.map((delay, index) => setTimeout(() => {
      if (findBoundPromptForImage(imageRef)) {
        clearPromptRecovery(candidateKey);
        return;
      }
      requestCurrentConversationRefresh(candidate);
      if (index === delays.length - 1) promptRecoveryTimers.delete(candidateKey);
    }, delay));
    promptRecoveryTimers.set(candidateKey, timers);
  }

  function findRecentUnboundPrompt(withinMs = 8000) {
    const now = Date.now();
    for (let i = recentPrompts.length - 1; i >= 0; i -= 1) {
      const item = recentPrompts[i];
      if (now - item.at <= withinMs && item.prompt) return item;
    }
    return null;
  }

  function buildStoredPrompt({ generationPrompt, generationStatus = "", userMessage, via }) {
    const gen = cleanPromptText(generationPrompt);
    const user = cleanPromptText(userMessage).slice(0, 8000);
    const places = extractPlaceHints(user);
    const trustedGeneration = generationStatus === "generation-tool-prompt";
    const visibleCaption = generationStatus === "visible-caption";
    const genOk = gen && (trustedGeneration || visibleCaption || looksLikeGenerationCaption(gen));
    const resolvedStatus = trustedGeneration
      ? "generation-tool-prompt"
      : visibleCaption
        ? "visible-caption"
        : "generation-tool-prompt";

    // Real generation caption that matches place intent.
    if (genOk && places.length && promptMentionsPlace(gen, places)) {
      return {
        prompt: gen,
        promptStatus: resolvedStatus,
        userMessage: user,
        promptSource: via || "bound-place-match",
      };
    }

    // Caption present but may be stale vs user place request — still store caption as main prompt,
    // never replace it with the short chat line alone.
    if (genOk && places.length && !promptMentionsPlace(gen, places)) {
      return {
        prompt: gen,
        promptStatus: resolvedStatus,
        userMessage: user,
        promptSource: "bound-caption-place-mismatch",
      };
    }

    if (genOk) {
      return {
        prompt: gen,
        promptStatus: resolvedStatus,
        userMessage: user,
        promptSource: via || "generation",
      };
    }

    // A user turn is context, not ChatGPT's revised generation prompt.
    return {
      prompt: "",
      promptStatus: "not-available",
      userMessage: user || (isWeakChatPrompt(gen) ? "" : gen),
      promptSource: user || gen ? "awaiting-generation-caption" : "none",
    };
  }

  function userMessageForCandidate(candidate) {
    const image = candidate?.el instanceof HTMLImageElement ? candidate.el : null;
    if (!image) return "";
    let nearest = null;
    for (const user of document.querySelectorAll('[data-message-author-role="user"]')) {
      if (!(user.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      nearest = user;
    }
    return String(nearest?.innerText || "").trim();
  }

  function messageScopeForCandidate(candidate) {
    const image = candidate?.el instanceof HTMLImageElement ? candidate.el : null;
    if (!image) return null;
    return image.closest(
      '[data-message-author-role="assistant"], [data-message-author-role="tool"], [data-message-id], article',
    );
  }

  function domCaptionForCandidate(candidate) {
    const image = candidate?.el instanceof HTMLImageElement ? candidate.el : null;
    if (!image) return "";
    const scope = messageScopeForCandidate(candidate);
    const sources = [
      image.getAttribute("alt"),
      image.getAttribute("aria-label"),
      scope?.innerText,
    ];
    for (const source of sources) {
      const text = String(source || "").replace(/\s+/g, " ").trim();
      const match = /model caption\s*:\s*(.+)$/i.exec(text);
      const caption = cleanPromptText(match?.[0] || "");
      if (looksLikeGenerationCaption(caption)) return caption;
    }
    return "";
  }

  function messageIdForCandidate(candidate) {
    return String(messageScopeForCandidate(candidate)?.getAttribute?.("data-message-id") || "").trim();
  }

  function requestCurrentConversationRefresh(candidate) {
    const conversationId = conversationIdFromUrl();
    if (!conversationId) return false;

    const imageRef = candidate?.imageUrl || candidate?.key || "";
    const proxy = chatGptImageProxyInfo(imageRef);
    // Do not ask the page hook to inspect the active conversation for an image
    // from a different ChatGPT conversation.
    if (proxy?.conversationId && proxy.conversationId !== conversationId) return false;

    const now = Date.now();
    const lastRequested = conversationRefreshRequestedAt.get(conversationId) || 0;
    if (now - lastRequested < CONVERSATION_REFRESH_COOLDOWN_MS) return false;
    conversationRefreshRequestedAt.set(conversationId, now);
    if (conversationRefreshRequestedAt.size > 20) {
      for (const [id, at] of conversationRefreshRequestedAt) {
        if (now - at > CONVERSATION_REFRESH_COOLDOWN_MS * 4) conversationRefreshRequestedAt.delete(id);
      }
    }

    // page-hook.js derives the endpoint from its own location; the content
    // script never supplies a URL or any credential-bearing request detail.
    window.postMessage({
      source: "mosa-chatgpt-capture",
      type: "refresh-current-conversation",
      payload: { conversationId },
    }, "*");
    return true;
  }

  function resolvePrompt(imageUrl, candidate) {
    const userMessage = userMessageForCandidate(candidate);

    const bound = findBoundPromptForImage(imageUrl);
    if (bound?.prompt) {
      const built = buildStoredPrompt({
        generationPrompt: bound.prompt,
        generationStatus: bound.promptStatus,
        userMessage,
        via: `bound:${bound.via || "network"}`,
      });
      return { ...built, model: bound.model || "", messageId: bound.messageId || "" };
    }

    // Cached ChatGPT routes can render an image without replaying the
    // conversation response. Keep the fallback inside that image's own
    // message and accept only the explicit Model caption marker.
    const domCaption = domCaptionForCandidate(candidate);
    if (domCaption) {
      const built = buildStoredPrompt({
        generationPrompt: domCaption,
        generationStatus: "visible-caption",
        userMessage,
        via: "dom-message-caption",
      });
      return { ...built, model: "", messageId: messageIdForCandidate(candidate) };
    }

    // Only use a very recent unbound prompt (same generation turn), never session-global best.
    const recent = findRecentUnboundPrompt(8000);
    if (recent?.prompt) {
      const built = buildStoredPrompt({
        generationPrompt: recent.prompt,
        generationStatus: recent.promptStatus,
        userMessage,
        via: `recent:${recent.via || "network"}`,
      });
      return { ...built, model: recent.model || "", messageId: recent.messageId || "" };
    }

    const built = buildStoredPrompt({
      generationPrompt: "",
      userMessage,
      via: "user-fallback",
    });
    return { ...built, model: "", messageId: "" };
  }

  async function originalBytesFromUrl(url) {
    if (!url) throw new Error("未能读取图片字节（下载失败或跨域）");
    if (url.startsWith("blob:")) {
      // A blob handle only resolves inside the page, not in the service worker.
      const response = await fetch(url);
      if (!response.ok) throw new Error(`blob/img fetch failed (${response.status})`);
      const blob = await response.blob();
      const buffer = await blob.arrayBuffer();
      return { mimeType: blob.type || "image/png", imageBase64: arrayBufferToBase64(buffer) };
    }
    const response = await runtimeSend({ type: "mosa.fetchImage", url });
    if (!response?.ok) throw new Error(response?.error || "Image download failed");
    return response.result;
  }

  function canvasBytesFromImage(el) {
    if (!(el instanceof HTMLImageElement) || !el.complete || !el.naturalWidth) {
      throw new Error("未能读取图片字节（下载失败或跨域）");
    }
    const canvas = document.createElement("canvas");
    canvas.width = el.naturalWidth;
    canvas.height = el.naturalHeight;
    canvas.getContext("2d").drawImage(el, 0, 0);
    const dataUrl = canvas.toDataURL("image/png");
    const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl);
    if (!match) throw new Error("未能读取图片字节（下载失败或跨域）");
    return { mimeType: match[1], imageBase64: match[2] };
  }

  /**
   * The canvas snapshot stays first. It re-encodes to different bytes than the
   * file ChatGPT served, so switching the order would re-import every asset
   * already archived from a canvas. Two encodings of one picture are kept apart
   * by image identity instead, before either one is ever uploaded.
   */
  async function bytesFromUrlOrImg(candidate) {
    if (candidate.dataUrl) {
      const match = /^data:([^;]+);base64,(.+)$/i.exec(candidate.dataUrl);
      if (!match) throw new Error("Unsupported data URL");
      return { mimeType: match[1], imageBase64: match[2] };
    }

    try {
      return canvasBytesFromImage(candidate.el);
    } catch {
      // No usable element, or a tainted cross-origin canvas → download instead.
    }
    return originalBytesFromUrl(candidate.imageUrl || candidate.key || "");
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function canAttempt(candidate, { force = false } = {}) {
    const key = candidate?.key || candidate?.imageUrl;
    if (!key) return false;
    if (inFlight.has(key)) return false;
    if (force) return true;
    if (isSavedCandidate(candidate)) return false;
    const failed = failedAt.get(key);
    if (failed && Date.now() - failed < 8_000) return false;
    return true;
  }

  async function ingestCandidate(candidate, { silentSkip = false, reason = "manual", force = false } = {}) {
    const key = candidate.key || candidate.imageUrl;
    const manual = reason === "manual" || reason === "manual-all";
    rememberCandidate(candidate);
    if (!canAttempt(candidate, { force: manual || force })) {
      if (!silentSkip) {
        const saved = isSavedCandidate(candidate);
        showToast(saved ? "这张已处理过（或已入库）" : "请稍后再试（冷却中）", true);
        setStatus(saved ? "已处理过" : "冷却中");
      }
      return null;
    }
    if (!isArchiveWorthyCandidate(candidate, { manual })) {
      if (!manual) savedKeys.add(key);
      if (!silentSkip) showToast("已跳过：不像生成大图（logo/小图）", true);
      setStatus("跳过小图/logo");
      return null;
    }
    inFlight.add(key);
    setStatus(`保存中… (${reason})`);

    try {
      // Ask the MAIN-world hook to re-read only the active conversation before
      // waiting. Cached ChatGPT pages otherwise render the image without
      // replaying the conversation response through the fetch/XHR interceptors.
      const imageRef = candidate.imageUrl || key;
      const refreshRequested = !findBoundPromptForImage(imageRef)
        && requestCurrentConversationRefresh(candidate);
      const waits = refreshRequested ? 6 : (manual ? 2 : 5);
      for (let i = 0; i < waits && !findBoundPromptForImage(imageRef); i += 1) {
        await new Promise((r) => setTimeout(r, 350));
      }
      const resolved = resolvePrompt(imageRef, candidate);
      const { mimeType, imageBase64 } = await bytesFromUrlOrImg(candidate);
      if (!imageBase64) throw new Error("未能读取图片字节（下载失败或跨域）");

      // Approximate decoded size from base64.
      const approxBytes = Math.floor((imageBase64.length || 0) * 0.75);
      if (approxBytes > 0 && approxBytes < MIN_BYTES) {
        if (!manual) savedKeys.add(key);
        if (!silentSkip) showToast(`已跳过小文件 ${(approxBytes / 1024).toFixed(0)}KB（logo）`, true);
        setStatus("跳过小文件");
        return null;
      }

      // Auto may still save without caption (prompt empty / not-available). Manual always saves.

      const response = await runtimeSend({
        type: "mosa.ingest",
        payload: {
          prompt: resolved.prompt,
          promptStatus: resolved.promptStatus,
          userMessage: resolved.userMessage,
          model: resolved.model,
          promptSource: resolved.promptSource,
          isReference: isReferenceCandidate(candidate),
          mimeType,
          imageBase64,
          pageUrl: location.href,
          conversationId: conversationIdFromUrl(),
          messageId: resolved.messageId,
          capturedAt: new Date().toISOString(),
        },
      });
      if (!response?.ok) throw new Error(response?.error || "Unknown extension error");

      const result = response.result;
      rememberSavedCandidate(candidate);
      failedAt.delete(key);
      rememberSavedPrompt(candidate, resolved);

      // Capture the narrow race where metadata appeared while image bytes were
      // downloading, after resolvePrompt had already returned no prompt.
      const lateBound = findBoundPromptForImage(imageRef);
      if (lateBound?.prompt) schedulePromptUpgrade(lateBound);
      else if (!["visible-caption", "generation-tool-prompt"].includes(resolved.promptStatus)) {
        schedulePromptRecovery(candidate);
      }

      if (result.status === "imported") {
        const label = resolved.prompt ? resolved.promptStatus : "no-caption";
        showToast(`MOSA 入库 ✓ ${label}`);
        setStatus(`已入库 · ${label} · 共${savedKeys.size}`);
      } else if (result.upgraded) {
        showToast("MOSA 已升级提示词");
        setStatus(`提示词已升级 · 共${savedKeys.size}`);
      } else if (!silentSkip) {
        showToast("MOSA 已存在相同图片");
        setStatus(`已存在 · 共${savedKeys.size}`);
      } else {
        setStatus(`已同步(跳过) · 共${savedKeys.size}`);
      }
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/too small|IMAGE_TOO_SMALL|logo/i.test(msg)) {
        if (!manual) savedKeys.add(key);
      } else {
        failedAt.set(key, Date.now());
      }
      // Always surface manual errors; auto stays quiet for pure size junk.
      if (!silentSkip || !/too small|IMAGE_TOO_SMALL/i.test(msg)) {
        showToast(msg, true);
      }
      setStatus(`失败: ${msg.slice(0, 120)}`, true);
      throw error;
    } finally {
      inFlight.delete(key);
    }
  }

  function enqueueAuto(candidate, reason) {
    if (!autoCapture) return;
    if (!isArchiveWorthyCandidate(candidate, { manual: false })) return;
    rememberCandidate(candidate);
    autoQueue = autoQueue
      .then(async () => {
        try {
          await ingestCandidate(candidate, { silentSkip: true, reason });
        } catch {
          // keep queue alive
        }
      });
  }

  function ensureDock() {
    if (document.getElementById("mosa-capture-dock")) return;
    const mount = () => {
      if (document.getElementById("mosa-capture-dock")) return;
      const host = document.body || document.documentElement;
      if (!host) return;
      const dock = document.createElement("div");
      dock.id = "mosa-capture-dock";
      dock.innerHTML = `
        <div class="mosa-dock-title">MOSA 自动入库</div>
        <button type="button" class="mosa-dock-btn mosa-dock-primary" data-action="save-visible">保存当前图</button>
        <button type="button" class="mosa-dock-btn" data-action="save-all">保存全部大图</button>
        <button type="button" class="mosa-dock-btn" data-action="toggle-auto">切换自动</button>
        <div class="mosa-dock-status" data-role="status">${lastStatus}</div>
      `;
      dock.addEventListener("click", async (event) => {
        const btn = event.target.closest("[data-action]");
        if (!btn) return;
        event.preventDefault();
        event.stopPropagation();
        if (contextLost || !extensionAlive()) {
          markContextLost();
          showToast(CONTEXT_LOST_MESSAGE, true);
          return;
        }
        const action = btn.getAttribute("data-action");
        if (action === "toggle-auto") {
          autoCapture = !autoCapture;
          chrome.storage?.local?.set?.({ autoCapture });
          setStatus(autoCapture ? "自动开" : "自动关");
          if (autoCapture) scheduleScan(true);
          return;
        }
        const candidates = collectDomCandidates({ manual: true });
        if (!candidates.length) {
          showToast("没找到大图：等图片加载完，或确认扩展版本 0.9 已刷新", true);
          setStatus("未找到图片", true);
          return;
        }
        if (action === "save-visible") {
          try {
            const current = currentViewportCandidate(candidates);
            if (!current) throw new Error("未找到当前可见图片");
            await ingestCandidate(current, { reason: "manual" });
          } catch {
            // toast already shown
          }
        } else if (action === "save-all") {
          for (const c of candidates.slice(0, 8)) {
            try {
              await ingestCandidate(c, { silentSkip: false, reason: "manual-all" });
            } catch {
              // continue
            }
          }
        }
      });
      host.appendChild(dock);
    };
    if (document.body) mount();
    else document.addEventListener("DOMContentLoaded", mount, { once: true });
  }

  function scheduleScan(force = false) {
    if (contextLost) return;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(async () => {
      if (contextLost) return;
      if (!extensionAlive()) {
        markContextLost();
        return;
      }
      ensureDock();
      hookReady ||= document.documentElement?.dataset?.mosaPageHook === "1";
      if (location.href !== lastUrl) lastUrl = location.href;
      const net = networkMeta.filter((x) => x.prompt).length;
      setStatus(`${autoCapture ? "自动开" : "自动关"} · hook${hookReady ? "✓" : "…"} · 缓存${net} · 已存${savedKeys.size}`);
      if (!autoCapture && !force) return;

      const candidates = collectDomCandidates();
      // Auto-save only generation-sized images that are fully loaded.
      for (const candidate of candidates.slice(0, 6)) {
        if (!canAttempt(candidate)) continue;
        if (!isArchiveWorthyCandidate(candidate)) continue;
        if (candidate.el instanceof HTMLImageElement) {
          if (!candidate.el.complete) continue;
          if (candidate.el.naturalWidth > 0 && candidate.el.naturalWidth < MIN_EDGE) continue;
        }
        enqueueAuto(candidate, "dom-scan");
      }
    }, force ? 120 : 600);
  }

  async function loadSettings() {
    try {
      const response = await runtimeSend({ type: "mosa.getSettings" });
      if (response?.ok && response.settings) {
        autoCapture = response.settings.autoCapture !== false;
        return;
      }
    } catch {
      if (contextLost) return;
    }

    // The background owns defaults and migration. A temporary messaging failure
    // must never overwrite an explicit local "off" preference.
    try {
      const stored = await chrome.storage?.local?.get?.({ autoCapture });
      if (stored) autoCapture = stored.autoCapture !== false;
    } catch {
      // Keep the in-memory value when both settings paths are unavailable.
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "mosa-chatgpt-capture") return;

    if (data.type === "generation-meta" && data.payload) {
      if (data.payload.hookReady) {
        hookReady = true;
        setStatus(`${autoCapture ? "自动开" : "自动关"} · hook✓`);
        return;
      }
      if (data.payload.prompt || data.payload.imageUrl || data.payload.imageKey) {
        const meta = rememberMeta(data.payload);
        schedulePromptUpgrade(meta);
      }
    }

    // A failed recovery used to be invisible, so captures kept landing without
    // a caption and nothing on screen said why.
    if (data.type === "conversation-refresh-failed") {
      const status = Number(data.payload?.status) || 0;
      const authorized = Boolean(data.payload?.authorized);
      setStatus(
        `会话元数据读取失败${status ? ` (${status})` : ""}${authorized ? "" : "：未捕获登录头"}，提示词可能缺失`,
        true,
      );
      return;
    }

    // Network image URLs: only auto-ingest generation CDN URLs (never static UI).
    if (data.type === "auto-image" && data.payload?.imageUrl && autoCapture) {
      const imageUrl = String(data.payload.imageUrl);
      const meta = rememberMeta(data.payload);
      if (!isLikelyGeneratedUrl(imageUrl)) return;
      if (enqueueDomCandidateForImage(imageUrl, "network-dom")) return;
      if (["generation-tool-prompt", "visible-caption"].includes(meta.promptStatus) && meta.prompt) {
        enqueueAuto({
          key: imageUrl,
          imageUrl,
          dataUrl: "",
          el: null,
          width: 0,
          height: 0,
        }, "network");
      }
    }

    if (data.type === "dom-image" && data.payload?.imageUrl && autoCapture) {
      const imageUrl = String(data.payload.imageUrl);
      const w = Number(data.payload.width) || 0;
      const h = Number(data.payload.height) || 0;
      if (!isLikelyGeneratedUrl(imageUrl)) return;
      if (w > 0 && h > 0 && (w < MIN_EDGE || h < MIN_EDGE)) return;
      enqueueDomCandidateForImage(imageUrl, "dom-hook");
    }
  });

  observer = new MutationObserver(() => scheduleScan(false));
  const startObs = () => {
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "style", "class"],
    });
  };
  if (document.documentElement) startObs();
  else document.addEventListener("DOMContentLoaded", startObs, { once: true });

  // Boot. page-hook.js is a document_start MAIN-world content script.
  ensureDock();
  loadSettings().then(() => scheduleScan(true));
  scheduleScan(true);

  // Aggressive periodic auto scan — user explicitly wants hands-free save.
  // Doubles as the orphan watchdog: an extension reload flips the dock to the
  // refresh instruction within 2s instead of waiting for a failed save.
  autoScanInterval = setInterval(() => {
    if (!extensionAlive()) {
      markContextLost();
      return;
    }
    if (autoCapture) scheduleScan(true);
  }, 2000);

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !changes.autoCapture) return;
    autoCapture = changes.autoCapture.newValue !== false;
    setStatus(autoCapture ? "自动开" : "自动关");
    if (autoCapture) scheduleScan(true);
  });
})();
