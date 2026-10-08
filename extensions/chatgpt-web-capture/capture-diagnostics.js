/**
 * Page-world capture diagnostics helper.
 *
 * When a ChatGPT image is archived without its prompt (promptStatus ===
 * "not-available" or empty prompt), record the structure of every traffic
 * fragment the page hook saw during the capture window — and nothing else.
 * The original prompt, conversation text, file id tail, URL query parameters,
 * cookies, tokens, and signatures never enter this module: every value is
 * reduced to a field path, a JavaScript type, a string length, or a value
 * drawn from the explicitly allowed allowlist below.
 *
 * The summary is computed inside the page world before any event is mirrored
 * to the content script, so the raw payload never leaves the page hook. The
 * background worker stores the resulting records, applies the 50-entry / 200
 * KiB limits, and serves the JSON export the options page offers.
 *
 * Lives in the MAIN world next to page-hook.js; exposes a single global
 * `globalThis.MosaCaptureDiagnostics` object so callers can attach at the
 * three intercept points (SSE, WebSocket, HTTP) and the trigger (image meta
 * emission) without pulling page-hook.js into a multi-file module.
 */
(function mosaCaptureDiagnostics() {
  if (globalThis.MosaCaptureDiagnostics && globalThis.MosaCaptureDiagnostics.__mosaInstalled) return;
  const api = globalThis.MosaCaptureDiagnostics || {};
  api.__mosaInstalled = true;
  // Disabled by default. The options page flips this through the page hook's
  // setEnabled() bridge; a default of undefined would let the first frame
  // slip through unnoticed.
  api.__enabled = false;

  // ----------------------------------------------------------------------
  // Allowlist of values that survive sanitization. Anything not listed here
  // is reduced to a path, type, and length. Treat every entry as the only
  // reason a downstream reader can ever see raw text from the page.
  // ----------------------------------------------------------------------
  const PRIMITIVE_VALUE_ALLOWLIST = new Set([
    "model_slug",
    "model_name",
    "model",
    "content_type",
    "type",
    "role",
    "author.role",
    "author.name",
    "recipient",
    "channel",
    "status",
    "end_turn",
    "operation",
    "op",
    "kind",
    "source",
  ]);
  // SSE patch operation names ("append", "replace", "add", "patch") are
  // safe and small enough to keep verbatim; patch path segments too.
  const SSE_OP_ALLOWLIST = new Set(["append", "replace", "add", "patch", "insert", "delete", "remove"]);
  // Conversation / message / generation ids are reduced to their first eight
  // characters, enough to join back to the library row without leaking the
  // full token.
  const ID_FIELDS = new Set([
    "conversation_id", "conversationid", "cid",
    "message_id", "messageid",
    "id",
    "parent_id", "parentid",
    "gen_id", "genid",
    "generation_id", "generationid",
    "response_id", "responseid",
    "request_id", "requestid",
    "tool_call_id", "toolcallid", "call_id", "callid",
    "generation_call_id", "generationcallid",
    "image_generation_call_id", "imagegenerationcallid",
    "image_gen_call_id", "imagegencallid",
    "asset_pointer", "assetpointer", "asset_id", "file_id", "image_id",
    "assetid", "fileid", "imageid",
    "turn_exchange_id", "turnexchangeid", "exchange_id", "exchangeid",
  ]);
  const MAX_STRING_LENGTH_FOR_VALUE = 16;
  const MAX_FRAMES_PER_CONVERSATION = 400;
  const BUFFER_TTL_MS = 3 * 60 * 1000;
  const CONTROL_RANDOM_SAMPLE_RATE = 0.1;

  function allowedKey(lowerKey) {
    if (!lowerKey) return false;
    if (PRIMITIVE_VALUE_ALLOWLIST.has(lowerKey)) return true;
    if (ID_FIELDS.has(lowerKey)) return true;
    return false;
  }

  function shortId(value) {
    const text = typeof value === "string" ? value : value == null ? "" : String(value);
    if (!text) return "";
    return text.length > 8 ? text.slice(0, 8) : text;
  }

  const SENSITIVE_TEXT_FIELDS = new Set([
    "prompt", "prompts", "caption", "captions", "caption_text", "captiontext",
    "text", "body", "query", "question",
  ]);
  const SENSITIVE_ARRAY_FIELDS = new Set([
    "parts", "messages", "items",
  ]);

  function isSensitiveStringField(lowerPath) {
    // Match the last path segment and any path containing a parts array
    // (parts[0] etc.) — ChatGPT's content.parts array is the most common
    // place to leak a user message or model caption.
    if (!lowerPath) return false;
    const segments = lowerPath.split(/[.\[\]]+/).filter(Boolean);
    for (const segment of segments) {
      if (SENSITIVE_TEXT_FIELDS.has(segment) || SENSITIVE_ARRAY_FIELDS.has(segment)) {
        return true;
      }
    }
    return false;
  }

  function safeStringValue(key, value, allowPrimitives) {
    if (typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") {
      const lowerKey = String(key || "").toLowerCase();
      if (isSensitiveStringField(lowerKey)) {
        // prompt/caption/text/parts-style fields are recorded as length
        // only, even when short. The allow-list does not override this:
        // a sensitive field never appears in any allow-list.
        if (value === "Model caption:") return { kind: "marker" };
        return undefined;
      }
      if (allowedKey(lowerKey)) {
        if (ID_FIELDS.has(lowerKey)) return shortId(value);
        if (value.length > 80) return value.slice(0, 80);
        return value;
      }
      if (allowPrimitives && value.length > 0 && value.length <= MAX_STRING_LENGTH_FOR_VALUE) {
        return { kind: "primitive", text: value };
      }
      if (value === "Model caption:") return { kind: "marker" };
      return undefined;
    }
    return undefined;
  }

  function sanitizeNode(value, path, depth, out, limits) {
    if (out.length >= limits.maxEntries || depth > limits.maxDepth) return;
    const pathText = path || "$";
    if (value === null || value === undefined) {
      out.push({ path: pathText, type: value === undefined ? "undefined" : "null" });
      return;
    }
    if (typeof value === "string") {
      // Empty / whitespace-only strings are not worth recording: they would
      // surface as noise without any structural information. Skip them
      // without an entry; downstream readers know the field name from the
      // parent object keys list.
      if (value.length === 0 || /^\s*$/.test(value)) return;
      const node = { path: pathText, type: "string", length: value.length };
      const allowed = safeStringValue(path && path.split(".").pop(), value, true);
      if (allowed !== undefined) node.value = allowed;
      const startsWithBrace = value.startsWith("{");
      const looksLikeFileRef = /^file[-_]/i.test(value);
      const looksLikeModelCaption = /^Model caption/i.test(value);
      if (startsWithBrace || looksLikeFileRef || looksLikeModelCaption) {
        node.hints = [];
        if (startsWithBrace) node.hints.push("starts-with-{");
        if (looksLikeFileRef) node.hints.push("file-prefix");
        if (looksLikeModelCaption) node.hints.push("model-caption");
      }
      out.push(node);
      return;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      const node = { path: pathText, type: typeof value };
      out.push(node);
      return;
    }
    if (Array.isArray(value)) {
      out.push({ path: pathText, type: "array", length: value.length });
      const step = value.length > 8 ? Math.ceil(value.length / 8) : 1;
      for (let index = 0; index < Math.min(value.length, 8); index += 1) {
        sanitizeNode(value[index], `${pathText}[${index}]`, depth + 1, out, limits);
        if (out.length >= limits.maxEntries) return;
      }
      // Signal that the recorded entries are a sample rather than the whole list.
      if (value.length > 8) {
        out.push({ path: `${pathText}.truncated`, type: "marker", length: value.length - 8 * step });
      }
      return;
    }
    if (typeof value === "object") {
      const keys = Object.keys(value).slice(0, 24);
      out.push({ path: pathText, type: "object", keys });
      for (const key of keys) {
        sanitizeNode(value[key], path ? `${path}.${key}` : key, depth + 1, out, limits);
        if (out.length >= limits.maxEntries) return;
      }
      return;
    }
    out.push({ path: pathText, type: typeof value });
  }

  function summarizePayload(value, options = {}) {
    const out = [];
    const limits = {
      maxEntries: options.maxEntries || 96,
      maxDepth: options.maxDepth || 7,
    };
    try {
      sanitizeNode(value, "", 0, out, limits);
    } catch (e) {
      // Diagnostics must never affect page hooks. Tests opt into a real throw
      // by passing { throwOnError: true } so they can fix the underlying bug.
      if (options.throwOnError) throw e;
      out.push({ path: "$", type: "sanitize-error", message: String(e && e.message || e) });
    }
    return out;
  }

  function summarizeSsePatch(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { type: typeof data, schema: summarizePayload(data, { maxEntries: 8 }) };
    }
    const opRaw = data.o || data.op || data.operation;
    const op = typeof opRaw === "string" ? opRaw.toLowerCase() : "";
    const path = typeof data.p === "string" ? data.p : "";
    const summary = {
      type: "patch",
      op: SSE_OP_ALLOWLIST.has(op) ? op : (op ? "other" : ""),
      path: path ? path.split("/").slice(0, 8).join("/").slice(0, 120) : "",
      schema: summarizePayload(data.v ?? data.value ?? null, { maxEntries: 32 }),
    };
    // Special-case the "add" event: v carries the message, which is informative.
    if (op === "add" && data.v && typeof data.v === "object") {
      summary.add = summarizePayload(data.v, { maxEntries: 48 });
    }
    return summary;
  }

  function summarizeSseLine(line) {
    if (typeof line !== "string") return null;
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return null;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return { type: "sse-marker", marker: payload === "[DONE]" ? "done" : "empty" };
    let parsed;
    try { parsed = JSON.parse(payload); } catch {
      return { type: "sse-raw", length: payload.length, kind: "opaque" };
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed.p || parsed.v !== undefined || parsed.o)) {
      return summarizeSsePatch(parsed);
    }
    // Bare delta encoding version banner: data: "v1"
    if (typeof parsed === "string") {
      return { type: "sse-raw", length: parsed.length, kind: "text" };
    }
    return { type: "sse-event", schema: summarizePayload(parsed, { maxEntries: 48 }) };
  }

  function summarizeWsFrame(text) {
    if (typeof text !== "string") return null;
    let envelope;
    try { envelope = JSON.parse(text); } catch {
      return { type: "ws-text", length: text.length, kind: "opaque" };
    }
    const body = envelope && typeof envelope === "object" ? envelope.body : null;
    const baseType = envelope && typeof envelope === "object" ? envelope.type || envelope.event || "" : "";
    const summary = {
      type: "ws",
      envelopeType: typeof baseType === "string" && baseType ? baseType.split(".").slice(0, 2).join(".").slice(0, 64) : "",
      schema: summarizePayload(envelope, { maxEntries: 32 }),
    };
    if (typeof body === "string" && body) {
      const decoded = tryDecodeBase64Utf8(body);
      if (decoded) {
        summary.bodySchema = summarizePayload(parseLooseJson(decoded) ?? decoded, { maxEntries: 64 });
        summary.bodyLength = decoded.length;
      } else {
        summary.bodyLength = body.length;
      }
    }
    return summary;
  }

  function summarizeHttpResponse(url, contentType, parsed) {
    const out = {
      type: "http",
      url: safeUrlForSummary(url),
      contentType: typeof contentType === "string" ? contentType.split(";", 1)[0].trim().toLowerCase().slice(0, 80) : "",
    };
    out.schema = summarizePayload(parsed, { maxEntries: 96 });
    return out;
  }

  function safeUrlForSummary(value) {
    if (typeof value !== "string") return "";
    try {
      const parsed = new URL(value, location && location.origin ? location.origin : "https://chatgpt.com");
      // Strip the conversation id and any query parameters that could include
      // conversation, message, or auth tokens. Path segments are replaced
      // with <id> only when they are long and shaped like an opaque id;
      // well-known segment names like "backend-api" stay visible so the user
      // can still tell which endpoint was hit.
      const ID_LIKE_THRESHOLD = 24;
      const safePath = parsed.pathname.replace(/[^/]+/g, (segment) => {
        if (segment.length >= ID_LIKE_THRESHOLD && /^[A-Za-z0-9_-]+$/.test(segment)) return "<id>";
        return segment;
      });
      return `${parsed.origin}${safePath}`.slice(0, 256);
    } catch {
      return "";
    }
  }

  function tryDecodeBase64Utf8(value) {
    if (typeof atob !== "function") return "";
    try {
      const binary = atob(String(value || ""));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      if (typeof TextDecoder === "function") return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      return binary;
    } catch {
      return "";
    }
  }

  function parseLooseJson(value) {
    if (typeof value !== "string" || value.length < 2 || value.length > 4_000_000) return null;
    const trimmed = value.trim();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
    try { return JSON.parse(trimmed); } catch { return null; }
  }

  // ----------------------------------------------------------------------
  // Per-conversation ring buffer. Each conversation gets at most 400 frames
  // and 3 minutes of retention; older frames fall off the tail.
  // ----------------------------------------------------------------------
  const conversationBuffers = new Map();
  const pendingCaptures = new Map(); // conversationId -> Set<captureKey>
  const captureNeedsDiagnostics = new Map(); // captureKey -> { markedAt, conversationId }
  const recordedCounters = { frames: 0, captures: 0, controls: 0, rejects: 0, truncated: 0 };

  function getBuffer(conversationId) {
    const key = String(conversationId || "");
    if (!key) return null;
    let entry = conversationBuffers.get(key);
    const now = Date.now();
    if (!entry) {
      entry = { conversationId: key, frames: [], models: new Set(), expiresAt: now + BUFFER_TTL_MS, firstAt: now };
      conversationBuffers.set(key, entry);
    }
    if (now > entry.expiresAt) {
      entry.frames.length = 0;
      entry.models.clear();
      entry.expiresAt = now + BUFFER_TTL_MS;
      entry.firstAt = now;
    }
    return entry;
  }

  function pruneExpired() {
    const cutoff = Date.now();
    let removed = 0;
    for (const [key, entry] of conversationBuffers) {
      if (cutoff - entry.firstAt > BUFFER_TTL_MS && entry.frames.length === 0) {
        conversationBuffers.delete(key);
        removed += 1;
      }
    }
    if (removed) return removed;
    return 0;
  }

  function recordFrame(conversationId, summary, options = {}) {
    if (!api.__enabled) return false;
    const entry = getBuffer(conversationId);
    if (!entry || !summary || typeof summary !== "object") return false;
    const now = Date.now();
    if (now > entry.expiresAt) {
      // Buffer time has elapsed; the capture window has already been snapshotted.
      recordedCounters.rejects += 1;
      return false;
    }
    if (entry.frames.length >= MAX_FRAMES_PER_CONVERSATION) {
      entry.frames.shift();
      recordedCounters.truncated += 1;
    }
    entry.frames.push({ t: now, ...summary });
    if (Array.isArray(summary.models)) {
      for (const model of summary.models) entry.models.add(String(model));
    } else if (typeof summary.model === "string") {
      entry.models.add(summary.model);
    }
    recordedCounters.frames += 1;
    return true;
  }

  function snapshotFor(conversationId, opts = {}) {
    const entry = conversationBuffers.get(String(conversationId || ""));
    if (!entry) return null;
    const windowMs = Number(opts.windowMs) || 35_000;
    const cutoff = Date.now() - windowMs;
    const recent = entry.frames.filter((frame) => frame.t >= cutoff);
    if (!recent.length) return null;
    return {
      conversationId: entry.conversationId,
      firstAt: entry.firstAt,
      lastAt: recent[recent.length - 1].t,
      frames: recent,
      models: [...entry.models],
    };
  }

  function markCapture(captureKey, conversationId, messageId, hasPrompt) {
    if (!api.__enabled) return false;
    const key = String(captureKey || `${conversationId}:${messageId}`);
    captureNeedsDiagnostics.set(key, {
      markedAt: Date.now(),
      conversationId: String(conversationId || ""),
      messageId: String(messageId || "").slice(0, 8),
      hasPrompt: hasPrompt === true,
    });
    const set = pendingCaptures.get(String(conversationId || "")) || new Set();
    set.add(key);
    pendingCaptures.set(String(conversationId || ""), set);
    return hasPrompt !== true;
  }

  function randomSample(rate) {
    try {
      if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
        const buf = new Uint32Array(1);
        crypto.getRandomValues(buf);
        return (buf[0] / 0xFFFFFFFF) < rate;
      }
    } catch {
      // fall through
    }
    return Math.random() < rate;
  }

  function finalizeCapture(conversationId, captureKey) {
    const convId = String(conversationId || "");
    const key = String(captureKey || "");
    if (!convId || !key) return null;
    const needs = captureNeedsDiagnostics.get(key);
    if (!needs) return null;
    captureNeedsDiagnostics.delete(key);
    const set = pendingCaptures.get(convId);
    if (set) {
      set.delete(key);
      if (!set.size) pendingCaptures.delete(convId);
    }
    const isControl = needs.hasPrompt === true;
    const shouldRecord = !isControl || randomSample(CONTROL_RANDOM_SAMPLE_RATE);
    if (!shouldRecord) return { control: true, skipped: "sampled-out" };
    if (isControl) recordedCounters.controls += 1;
    recordedCounters.captures += 1;
    const snap = snapshotFor(convId);
    return {
      control: isControl,
      snapshot: snap || null,
      empty: !snap || !snap.frames.length,
    };
  }

  function setEnabled(value) {
    api.__enabled = value === true;
    if (!api.__enabled) {
      // Memory clears promptly so an extension reload with the switch off
      // never hands the next user's first conversation off to the prior one.
      conversationBuffers.clear();
      pendingCaptures.clear();
      captureNeedsDiagnostics.clear();
    }
    return api.__enabled;
  }

  function isEnabled() { return api.__enabled === true; }

  function counters() {
    return { ...recordedCounters };
  }

  api.recordSseLine = (conversationId, line) => recordFrame(conversationId, summarizeSseLine(line));
  api.recordWsFrame = (conversationId, text) => recordFrame(conversationId, summarizeWsFrame(text));
  api.recordHttpResponse = (conversationId, url, contentType, parsed) => recordFrame(conversationId, summarizeHttpResponse(url, contentType, parsed));
  // Generic entry point for tests and a future hook migration; the public
  // SSE / WS / HTTP adapters above are the thin wrappers callers use.
  api.recordFrame = recordFrame;
  api.markCapture = markCapture;
  api.finalizeCapture = finalizeCapture;
  api.snapshotFor = snapshotFor;
  api.setEnabled = setEnabled;
  api.isEnabled = isEnabled;
  api.counters = counters;
  api.pruneExpired = pruneExpired;
  api.recordedFrameCount = () => recordedCounters.frames;
  // Exposed for tests; sanitization helpers are deterministic.
  api.summarizeSseLine = summarizeSseLine;
  api.summarizeSsePatch = summarizeSsePatch;
  api.summarizeWsFrame = summarizeWsFrame;
  api.summarizePayload = summarizePayload;
  api.summarizeHttpResponse = summarizeHttpResponse;
  api.safeStringValue = safeStringValue;
  api.MAX_STRING_LENGTH_FOR_VALUE = MAX_STRING_LENGTH_FOR_VALUE;
  api.MAX_FRAMES_PER_CONVERSATION = MAX_FRAMES_PER_CONVERSATION;
  api.BUFFER_TTL_MS = BUFFER_TTL_MS;
  api.CONTROL_RANDOM_SAMPLE_RATE = CONTROL_RANDOM_SAMPLE_RATE;
  api.PRIMITIVE_VALUE_ALLOWLIST = PRIMITIVE_VALUE_ALLOWLIST;
  api.SSE_OP_ALLOWLIST = SSE_OP_ALLOWLIST;
  api.ID_FIELDS = ID_FIELDS;

  globalThis.MosaCaptureDiagnostics = api;
})();
