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
    "default_model_slug",
    "resolved_model_slug",
    "model_name",
    "model",
    "content_type",
    "role",
    "author.role",
    "author.name",
    "recipient",
    "channel",
    "status",
    "end_turn",
    "operation",
    "op",
  ]);
  // Model names are harvested from frames into the record's models list.
  // The field must be one of these (matched against the path's last
  // segment) and the value must pass MODEL_VALUE_PATTERN.
  const MODEL_FIELDS = new Set(["model_slug", "default_model_slug", "resolved_model_slug"]);
  const MODEL_VALUE_PATTERN = /^[A-Za-z0-9_.:\-]{1,64}$/;
  // The record envelope itself is allowed to carry "type" — but the value
  // must still be a structural marker (patch / ws / http / sse-event / etc.),
  // so we constrain it to the enum of recognized frame types below.
  const FRAME_TYPE_VALUES = new Set([
    "patch", "sse-event", "sse-raw", "sse-marker", "ws", "ws-text",
    "http", "raw", "marker", "string", "object", "array", "null",
    "undefined", "number", "boolean", "sanitize-error", "captured",
  ]);
  // SSE patch operation names ("append", "replace", "add", "patch") are
  // safe and small enough to keep verbatim; patch path segments too.
  const SSE_OP_ALLOWLIST = new Set(["append", "replace", "add", "patch", "insert", "delete", "remove"]);
  // Conversation / message / generation ids are reduced to their first eight
  // characters, enough to join back to the library row without leaking the
  // full token. The value must look like an opaque id (alphanumeric, _, -)
  // before it gets the short-id treatment; otherwise it is dropped.
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
  // Allow-list string values are limited to a strict character set so a
  // capture cannot leak conversation text under a "type" or "status" key.
  // The "/" character is added so an HTTP content type like
  // "application/json" can survive the re-check; everything else stays
  // restricted to the alphabet of structural markers.
  const ALLOWED_VALUE_PATTERN = /^[A-Za-z0-9_.:\-\/]{1,64}$/;
  const ID_VALUE_PATTERN = /^[A-Za-z0-9_\-]+$/;
  // Field names, SSE path segments, and SSE op names all use the same strict
  // character set; anything that contains non-ASCII, whitespace, or a
  // structural marker is replaced with the generic "<key>" placeholder.
  const SAFE_KEY_PATTERN = /^[A-Za-z0-9_.:\-]{1,64}$/;
  const KEY_PLACEHOLDER = "<key>";
  const ID_PLACEHOLDER = "<id>";

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
    if (!ID_VALUE_PATTERN.test(text)) return undefined;
    return text.length > 8 ? text.slice(0, 8) : text;
  }

  function safeKey(key) {
    // Field names in a JSON object can be any string the page sends. We
    // accept only the same alphabet we use for allow-list values; anything
    // else (including Chinese field names, emoji, whitespace, the literal
    // "<id>" / "<key>") collapses to a placeholder so the field name itself
    // cannot leak content.
    if (typeof key !== "string") return KEY_PLACEHOLDER;
    return SAFE_KEY_PATTERN.test(key) ? key : KEY_PLACEHOLDER;
  }

  function safePathSegment(segment) {
    if (typeof segment !== "string") return KEY_PLACEHOLDER;
    return SAFE_KEY_PATTERN.test(segment) ? segment : KEY_PLACEHOLDER;
  }

  // SSE patch paths ("/message/content/parts/0") are structure, not content:
  // they survive sanitization segment by segment. Each segment must be a
  // short run of [A-Za-z0-9_\-]; anything else — including a segment that
  // was replaced by the "<key>" placeholder — collapses to "<seg>". The
  // whole path is capped at 12 segments so a hostile payload cannot bloat
  // the record with an unbounded pointer chain.
  const SSE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_\-]{1,64}$/;
  const SSE_PATH_MAX_SEGMENTS = 12;
  const SEGMENT_PLACEHOLDER = "<seg>";

  function safePatchPath(path) {
    if (typeof path !== "string") return "";
    const segments = path
      .split("/")
      .filter(Boolean)
      .slice(0, SSE_PATH_MAX_SEGMENTS)
      .map((segment) => (SSE_PATH_SEGMENT_PATTERN.test(segment) ? segment : SEGMENT_PLACEHOLDER));
    return segments.length ? "/" + segments.join("/") : "";
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

  // Allow-list entries may be dotted paths ("author.name"), so match them
  // against progressively shorter suffixes of the value's path. A bare
  // field name that is not on the list ("name", "title") still never
  // matches — only exact allow-list entries do.
  function allowlistSuffixKey(lowerPath) {
    const parts = lowerPath.split(/[.\[\]]+/).filter(Boolean);
    for (let start = 0; start < parts.length; start += 1) {
      const suffix = parts.slice(start).join(".");
      if (PRIMITIVE_VALUE_ALLOWLIST.has(suffix)) return suffix;
    }
    return "";
  }

  function safeStringValue(key, value) {
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
      const segments = lowerKey.split(/[.\[\]]+/).filter(Boolean);
      const lastSegment = segments[segments.length - 1] || "";
      if (ID_FIELDS.has(lastSegment)) {
        const id = shortId(value);
        if (id === undefined) return undefined;
        return { kind: "id", value: id };
      }
      if (allowlistSuffixKey(lowerKey)) {
        if (ALLOWED_VALUE_PATTERN.test(value)) return { kind: "primitive", text: value };
        return undefined;
      }
      if (SSE_OP_ALLOWLIST.has(lowerKey) && ALLOWED_VALUE_PATTERN.test(value)) {
        return { kind: "op", text: value };
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
      // Pass the whole path: allow-list entries like "author.name" match by
      // dotted suffix, so a bare last segment ("name") would never hit.
      const allowed = safeStringValue(pathText, value);
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
      const rawKeys = Object.keys(value);
      const safeKeys = rawKeys.slice(0, 24).map(safeKey);
      out.push({ path: pathText, type: "object", keys: safeKeys });
      for (let index = 0; index < rawKeys.length && index < 24; index += 1) {
        const key = rawKeys[index];
        const childPath = path ? `${path}.${safePathSegment(key)}` : safePathSegment(key);
        // author.name is only evidence for tool authors (the image tool's
        // namespace); on any other role it can carry a person's name, so it
        // stays length-only there.
        if (key === "name" && typeof value[key] === "string" && value[key].trim() && "role" in value && value.role !== "tool") {
          out.push({ path: childPath, type: "string", length: value[key].length });
          if (out.length >= limits.maxEntries) return;
          continue;
        }
        sanitizeNode(value[key], childPath, depth + 1, out, limits);
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
      op: SSE_OP_ALLOWLIST.has(op) ? op : "",
      path: safePatchPath(path),
      schema: summarizePayload(data.v ?? data.value ?? null, { maxEntries: 32 }),
    };
    // Special-case the "add" event: v carries the message, which is informative.
    if (op === "add" && data.v && typeof data.v === "object") {
      summary.add = summarizePayload(data.v, { maxEntries: 48 });
    }
    // Batch patches ("o":"patch","v":[…]): every sub-patch keeps its own
    // path and op as original values (same rules as the top-level patch)
    // while v is reduced to the usual structure-only schema.
    if (op === "patch" && Array.isArray(data.v)) {
      const patches = [];
      for (const sub of data.v.slice(0, 24)) {
        if (!sub || typeof sub !== "object" || Array.isArray(sub)) continue;
        const subOpRaw = sub.o || sub.op || sub.operation;
        const subOp = typeof subOpRaw === "string" ? subOpRaw.toLowerCase() : "";
        patches.push({
          path: safePatchPath(typeof sub.p === "string" ? sub.p : ""),
          op: SSE_OP_ALLOWLIST.has(subOp) ? subOp : "",
          schema: summarizePayload(sub.v ?? null, { maxEntries: 32 }),
        });
      }
      if (patches.length) summary.patches = patches;
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
    const baseTypeText = typeof baseType === "string" ? baseType : "";
    const envelopeTypeSafe = safePathSegment((baseTypeText.split(".").slice(0, 2).join(".") || "").slice(0, 64));
    const summary = {
      type: "ws",
      envelopeType: envelopeTypeSafe,
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
    const ctRaw = typeof contentType === "string" ? contentType.split(";", 1)[0].trim().toLowerCase().slice(0, 80) : "";
    const out = {
      type: "http",
      url: safeUrlForSummary(url),
      contentType: ALLOWED_VALUE_PATTERN.test(ctRaw) ? ctRaw : "",
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
      entry = { conversationId: key, frames: [], expiresAt: now + BUFFER_TTL_MS, firstAt: now };
      conversationBuffers.set(key, entry);
    }
    if (now > entry.expiresAt) {
      entry.frames.length = 0;
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

  function inferSource(summary) {
    if (!summary || typeof summary !== "object") return "";
    if (typeof summary.source === "string" && ALLOWED_VALUE_PATTERN.test(summary.source)) {
      return summary.source;
    }
    if (typeof summary.type === "string") {
      if (summary.type === "ws" || summary.type === "ws-text") return "ws";
      if (summary.type === "http") return "http";
      if (summary.type === "sse-event" || summary.type === "sse-raw" || summary.type === "sse-marker" || summary.type === "patch") return "sse";
    }
    return "";
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
    // Frame summary may arrive as the structured object returned by the
    // recordSseLine / recordWsFrame / recordHttpResponse adapters, as a
    // bare schema array from summarizePayload(), as a wrapped object
    // carrying `{ schema: [...] }`, or as a pre-built frame envelope
    // `{ source, summary }`. Normalize to a single flat summary object:
    // a double-nested summary is unrecognizable to the scrubbers and
    // collapses the frame to `{ type: "raw" }` with every structure lost.
    let summaryObj;
    if (Array.isArray(summary)) {
      summaryObj = { type: "raw", schema: summary };
    } else if (
      typeof summary.source === "string"
      && summary.summary && typeof summary.summary === "object" && !Array.isArray(summary.summary)
    ) {
      summaryObj = { ...summary.summary };
    } else {
      summaryObj = { ...summary };
    }
    const source = inferSource(summaryObj);
    // The frame envelope carries the source; the summary must not duplicate it.
    delete summaryObj.source;
    entry.frames.push({ t: now, source, summary: summaryObj });
    recordedCounters.frames += 1;
    return true;
  }

  // Model names are harvested from the windowed frames' schema entries so
  // the record lists exactly the models this capture round saw. The value
  // must already be a { kind: "primitive" } wrapper produced by the
  // summarizer (model fields are allow-listed) and pass the strict model
  // pattern before it is collected.
  function harvestModelsFromSchema(entries, models) {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const path = typeof entry.path === "string" ? entry.path : "";
      const lastSegment = path.split(/[.\[\]]+/).filter(Boolean).pop() || "";
      if (!MODEL_FIELDS.has(lastSegment)) continue;
      const value = entry.value;
      if (value && typeof value === "object" && value.kind === "primitive"
        && typeof value.text === "string" && MODEL_VALUE_PATTERN.test(value.text)) {
        models.add(value.text);
      }
    }
  }

  function harvestModels(summary, models) {
    if (!summary || typeof summary !== "object") return;
    harvestModelsFromSchema(summary.schema, models);
    harvestModelsFromSchema(summary.add, models);
    harvestModelsFromSchema(summary.bodySchema, models);
    if (Array.isArray(summary.patches)) {
      for (const patch of summary.patches) {
        if (patch && typeof patch === "object") harvestModelsFromSchema(patch.schema, models);
      }
    }
  }

  function snapshotFor(conversationId, opts = {}) {
    const entry = conversationBuffers.get(String(conversationId || ""));
    if (!entry) return null;
    const windowMs = Number(opts.windowMs) || 35_000;
    const cutoff = Date.now() - windowMs;
    const recent = entry.frames.filter((frame) => frame.t >= cutoff);
    if (!recent.length) return null;
    const scrubbedFrames = [];
    const models = new Set();
    for (const frame of recent) {
      harvestModels(frame.summary, models);
      const scrubbed = scrubFrame(frame);
      if (scrubbed === "leak") {
        recordedCounters.rejects += 1;
        // A leaky frame poisons the whole conversation's snapshot —
        // the user would rather see an empty record than a partial
        // dump that hides which side actually leaked.
        return null;
      }
      if (scrubbed) scrubbedFrames.push(scrubbed);
      if (scrubbedFrames.length >= 200) break;
    }
    return {
      conversationId: entry.conversationId,
      messageId: opts.messageId ? String(opts.messageId).slice(0, 8) : undefined,
      generationId: opts.generationId ? String(opts.generationId).slice(0, 8) : undefined,
      version: opts.version || undefined,
      control: opts.control === true,
      firstAt: entry.firstAt,
      lastAt: scrubbedFrames[scrubbedFrames.length - 1]?.t || entry.firstAt,
      frames: scrubbedFrames,
      models: [...models].slice(0, 16),
    };
  }

  function markCapture(captureKey, conversationId, messageId, hasPrompt, generationId) {
    if (!api.__enabled) return false;
    const key = String(captureKey || `${conversationId}:${messageId}`);
    captureNeedsDiagnostics.set(key, {
      markedAt: Date.now(),
      conversationId: String(conversationId || ""),
      messageId: String(messageId || "").slice(0, 8),
      generationId: generationId ? String(generationId).slice(0, 8) : undefined,
      hasPrompt: hasPrompt === true,
    });
    const set = pendingCaptures.get(String(conversationId || "")) || new Set();
    set.add(key);
    pendingCaptures.set(String(conversationId || ""), set);
    return hasPrompt !== true;
  }

  // Sample-rate override hook for the unit tests. The page hook never
  // touches this; production always goes through randomSample(). Tests
  // pin the value to 0 or 1 to force the sample decision without
  // monkey-patching Math.random.
  api.__sampleRateOverride = null;

  function randomSample(rate) {
    const effective = api.__sampleRateOverride !== null ? api.__sampleRateOverride : rate;
    if (effective <= 0) return false;
    if (effective >= 1) return true;
    try {
      if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
        const buf = new Uint32Array(1);
        crypto.getRandomValues(buf);
        return (buf[0] / 0xFFFFFFFF) < effective;
      }
    } catch {
      // fall through
    }
    return Math.random() < effective;
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
    const snap = snapshotFor(convId, {
      messageId: needs.messageId,
      control: isControl,
    });
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

  // ---------------------------------------------------------------------
  // Last-line-of-defense scrubber applied to a record right before it is
  // mirrored to the content script / background / storage. Every value that
  // can carry text is re-checked against the strict allow-list; if any value
  // is over the sixteen-character leak threshold and not in the allow-list,
  // the whole record is dropped and the rejects counter ticks up. The
  // options page shows the rejected count so the user can tell whether
  // sanitization is silently dropping frames.
  // ---------------------------------------------------------------------
  const LEAK_VALUE_LENGTH = 16;
  const SAFE_PATH_PATTERN = /^[A-Za-z0-9_.\[\]$\-]{1,128}$/;
  // Schema entry paths may carry the "<key>" / "<seg>" placeholders the
  // sanitizers emit for hostile field names and path segments; those paths
  // are structure and must survive instead of collapsing to "$".
  const PLACEHOLDER_PATH_PATTERN = /^(?:[A-Za-z0-9_.\[\]$\-]|<key>|<seg>){1,148}$/;
  // "<id>" appears in summarized HTTP urls where an opaque path segment was.
  const SAFE_URL_PATTERN = /^https:\/\/[A-Za-z0-9.\-:]{1,128}(\/[A-Za-z0-9_.\-:<>]*)*$/;

  function isSafeSchemaPath(value) {
    if (typeof value !== "string") return false;
    if (value === "" || value === "$") return true;
    if (SAFE_PATH_PATTERN.test(value)) return true;
    return PLACEHOLDER_PATH_PATTERN.test(value);
  }

  function scrubFrame(frame, rejectsRef = recordedCounters) {
    if (!frame || typeof frame !== "object") return null;
    const next = { t: Number(frame.t) || 0, source: safeKey(String(frame.source || "")) };
    const sum = frame.summary;
    if (sum && typeof sum === "object") {
      const scrubbedSummary = scrubSummary(sum, rejectsRef);
      // scrubSummary returns the string "leak" when a schema entry in the
      // summary tries to smuggle a non-allow-listed value text. Treat the
      // whole frame as contaminated and propagate the leak signal up to
      // the caller — the storage scrubber will drop the whole record and
      // bump the reject counter.
      if (scrubbedSummary === "leak") {
        rejectsRef.rejects = (rejectsRef.rejects || 0) + 1;
        return "leak";
      }
      if (scrubbedSummary) next.summary = scrubbedSummary;
    }
    return next;
  }

  function scrubSchemaEntry(entry) {
    if (!entry || typeof entry !== "object") return null;
    const next = { path: scrubPathString(entry.path) };
    if (typeof entry.type === "string" && FRAME_TYPE_VALUES.has(entry.type)) next.type = entry.type;
    else return null;
    if (entry.type === "object" && Array.isArray(entry.keys)) {
      next.keys = entry.keys.slice(0, 64).map(safeKey);
    }
    if (entry.type === "array") {
      if (typeof entry.length === "number" && entry.length >= 0) next.length = Math.min(entry.length, 100_000);
    }
    if (entry.type === "string") {
      if (typeof entry.length !== "number" || entry.length < 0) return null;
      next.length = Math.min(entry.length, 1_000_000);
      if (entry.value !== undefined) {
        const v = scrubStringValue(next.path, entry.value);
        if (v === "leak") return "leak";
        if (v !== undefined) next.value = v;
      }
      if (Array.isArray(entry.hints)) {
        const safeHints = entry.hints.filter((h) => h === "starts-with-{" || h === "file-prefix" || h === "model-caption");
        if (safeHints.length) next.hints = safeHints;
      }
    }
    if (entry.type === "marker" && typeof entry.length === "number") {
      next.length = Math.min(entry.length, 1_000_000);
    }
    if (entry.type === "number" || entry.type === "boolean") {
      // no extra value
    }
    return next;
  }

  function scrubPathString(value) {
    if (typeof value !== "string") return "$";
    if (value === "" || value === "$") return "$";
    return isSafeSchemaPath(value) ? value : "$";
  }

  function scrubStringValue(path, value) {
    if (value === null || value === undefined) return undefined;
    if (typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "object") {
      // Wrappers like { kind, text } from sanitizeNode must use the same
      // text restrictions as the raw value they wrap.
      if (value.kind === "primitive" || value.kind === "op") {
        if (typeof value.text !== "string") return undefined;
        if (!ALLOWED_VALUE_PATTERN.test(value.text)) return "leak";
        return { kind: value.kind, text: value.text };
      }
      if (value.kind === "id") {
        if (typeof value.value !== "string") return undefined;
        if (!ID_VALUE_PATTERN.test(value.value)) return "leak";
        return { kind: "id", value: value.value.length > 8 ? value.value.slice(0, 8) : value.value };
      }
      if (value.kind === "marker") return { kind: "marker" };
      return undefined;
    }
    if (typeof value === "string") {
      if (value === "" || /^\s*$/.test(value)) return undefined;
      const lowerKey = String(path || "").toLowerCase();
      const segments = lowerKey.split(/[.\[\]]+/).filter(Boolean);
      if (segments.some((s) => SENSITIVE_TEXT_FIELDS.has(s) || SENSITIVE_ARRAY_FIELDS.has(s))) {
        // Sensitive fields are length-only, never text.
        return undefined;
      }
      if (ID_FIELDS.has(segments[segments.length - 1] || "")) {
        if (!ID_VALUE_PATTERN.test(value)) return "leak";
        return { kind: "id", value: value.length > 8 ? value.slice(0, 8) : value };
      }
      if (allowlistSuffixKey(lowerKey)) {
        if (!ALLOWED_VALUE_PATTERN.test(value)) return "leak";
        return { kind: "primitive", text: value };
      }
      if (SSE_OP_ALLOWLIST.has(segments[segments.length - 1] || "")) {
        if (!ALLOWED_VALUE_PATTERN.test(value)) return "leak";
        return { kind: "op", text: value };
      }
      // Bare value text without an allow-listed parent key — refuse. We
      // never want a raw user-controlled string to slip into a record.
      if (value.length > LEAK_VALUE_LENGTH) return "leak";
      return undefined;
    }
    return undefined;
  }

  function scrubSummary(summary) {
    if (!summary || typeof summary !== "object") return null;
    const out = {};
    if (typeof summary.type === "string" && FRAME_TYPE_VALUES.has(summary.type)) {
      out.type = summary.type;
    } else {
      out.type = "raw";
    }
    if (typeof summary.marker === "string" && ALLOWED_VALUE_PATTERN.test(summary.marker)) {
      out.marker = summary.marker;
    }
    if (typeof summary.kind === "string" && ALLOWED_VALUE_PATTERN.test(summary.kind)) {
      out.kind = summary.kind;
    }
    if (typeof summary.op === "string" && SSE_OP_ALLOWLIST.has(summary.op)) {
      out.op = summary.op;
    }
    if (typeof summary.path === "string") {
      // Patch paths carry "/"-separated structure: re-normalize segment by
      // segment instead of rejecting the whole summary over one "/".
      out.path = safePatchPath(summary.path);
    }
    if (typeof summary.url === "string") {
      out.url = SAFE_URL_PATTERN.test(summary.url) ? summary.url : "";
    }
    if (typeof summary.envelopeType === "string") {
      out.envelopeType = ALLOWED_VALUE_PATTERN.test(summary.envelopeType) ? summary.envelopeType : "";
    }
    if (typeof summary.contentType === "string") {
      out.contentType = ALLOWED_VALUE_PATTERN.test(summary.contentType) ? summary.contentType : "";
    }
    if (typeof summary.bodyLength === "number" && summary.bodyLength >= 0) {
      out.bodyLength = Math.min(summary.bodyLength, 10_000_000);
    }
    // sse-raw frames carry a length marker that says "the data line was N
    // characters long". Preserve it under the same name so a record-only
    // view of the buffer still tells the user how chatty the SSE channel
    // was, without ever exposing the payload itself.
    if (typeof summary.length === "number" && summary.length >= 0) {
      out.length = Math.min(summary.length, 10_000_000);
    }
    if (Array.isArray(summary.schema)) {
      const entries = [];
      for (const item of summary.schema) {
        const scrubbed = scrubSchemaEntry(item);
        if (scrubbed === "leak") return "leak";
        if (scrubbed) entries.push(scrubbed);
        if (entries.length >= 96) break;
      }
      out.schema = entries;
    }
    if (Array.isArray(summary.add)) {
      const entries = [];
      for (const item of summary.add) {
        const scrubbed = scrubSchemaEntry(item);
        if (scrubbed === "leak") return "leak";
        if (scrubbed) entries.push(scrubbed);
        if (entries.length >= 96) break;
      }
      out.add = entries;
    }
    if (Array.isArray(summary.bodySchema)) {
      const entries = [];
      for (const item of summary.bodySchema) {
        const scrubbed = scrubSchemaEntry(item);
        if (scrubbed === "leak") return "leak";
        if (scrubbed) entries.push(scrubbed);
        if (entries.length >= 96) break;
      }
      out.bodySchema = entries;
    }
    if (Array.isArray(summary.patches)) {
      const patches = [];
      for (const patch of summary.patches) {
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) continue;
        const nextPatch = {};
        if (typeof patch.path === "string") nextPatch.path = safePatchPath(patch.path);
        if (typeof patch.op === "string" && SSE_OP_ALLOWLIST.has(patch.op)) nextPatch.op = patch.op;
        if (Array.isArray(patch.schema)) {
          const entries = [];
          for (const item of patch.schema) {
            const scrubbed = scrubSchemaEntry(item);
            if (scrubbed === "leak") return "leak";
            if (scrubbed) entries.push(scrubbed);
            if (entries.length >= 96) break;
          }
          nextPatch.schema = entries;
        }
        patches.push(nextPatch);
        if (patches.length >= 24) break;
      }
      if (patches.length) out.patches = patches;
    }
    return out;
  }

  function scrubRecord(record) {
    if (!record || typeof record !== "object") return "leak";
    const out = {};
    if (typeof record.conversationId === "string") {
      if (!ID_VALUE_PATTERN.test(record.conversationId)) return "leak";
      out.conversationId = record.conversationId.length > 8 ? record.conversationId.slice(0, 8) : record.conversationId;
    } else {
      return "leak";
    }
    if (typeof record.messageId === "string") {
      if (!ID_VALUE_PATTERN.test(record.messageId)) return "leak";
      out.messageId = record.messageId.length > 8 ? record.messageId.slice(0, 8) : record.messageId;
    }
    if (typeof record.generationId === "string") {
      if (!ID_VALUE_PATTERN.test(record.generationId)) return "leak";
      out.generationId = record.generationId.length > 8 ? record.generationId.slice(0, 8) : record.generationId;
    }
    if (typeof record.version === "string") {
      if (!ALLOWED_VALUE_PATTERN.test(record.version)) return "leak";
      out.version = record.version;
    }
    if (record.control === true) out.control = true;
    if (record.firstAt) out.firstAt = Number(record.firstAt) || 0;
    if (record.lastAt) out.lastAt = Number(record.lastAt) || 0;
    if (Array.isArray(record.models)) {
      out.models = record.models
        .filter((m) => typeof m === "string" && MODEL_VALUE_PATTERN.test(m))
        .slice(0, 16);
    }
    if (Array.isArray(record.frames)) {
      const frames = [];
      for (const frame of record.frames) {
        const scrubbed = scrubFrame(frame);
        if (scrubbed === "leak") return "leak";
        if (scrubbed) frames.push(scrubbed);
        if (frames.length >= 200) break;
      }
      out.frames = frames;
    }
    return out;
  }

  function sanitizeRecordForStorage(record) {
    // Returns either a scrubbed record (safe to store) or the string "leak"
    // to signal the record must be dropped. Called by the page hook right
    // before the record is mirrored to the content script and by the
    // background worker right before it is written to chrome.storage.local.
    return scrubRecord(record);
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
  api.sanitizeRecordForStorage = sanitizeRecordForStorage;
  api.MAX_FRAMES_PER_CONVERSATION = MAX_FRAMES_PER_CONVERSATION;
  api.BUFFER_TTL_MS = BUFFER_TTL_MS;
  api.CONTROL_RANDOM_SAMPLE_RATE = CONTROL_RANDOM_SAMPLE_RATE;
  api.PRIMITIVE_VALUE_ALLOWLIST = PRIMITIVE_VALUE_ALLOWLIST;
  api.SSE_OP_ALLOWLIST = SSE_OP_ALLOWLIST;
  api.ID_FIELDS = ID_FIELDS;

  globalThis.MosaCaptureDiagnostics = api;
})();
