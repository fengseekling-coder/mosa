// Defense-in-depth scrubber for capture-diagnostics records.
//
// The page hook (extensions/chatgpt-web-capture/capture-diagnostics.js)
// has already produced a safe record, but anything that crosses the
// page-world / content-script / service-worker boundary is a hostile
// surface. This module re-validates every value against the strict
// allow-list before the background writes the record to chrome.storage.local.
// A record that fails the check is dropped (the caller bumps a user-visible
// reject counter) so a tampered message can never reach the export
// pipeline.
//
// The page-world module exports the same allow-list values; the background
// imports them so the two sides cannot drift. Adding a new allow-listed
// field requires editing this file and capture-diagnostics.js in lockstep.

const SAFE_URL = /^https:\/\/[A-Za-z0-9.\-:]{1,128}(\/[A-Za-z0-9_.\-:<>]*)?$/;
const SAFE_PATH = /^[A-Za-z0-9_.\[\]$\-]{1,128}$/;
// Schema entry paths may carry the "<key>" / "<seg>" placeholders the page
// sanitizers emit; those are structure and must survive the re-check.
const PLACEHOLDER_PATH = /^(?:[A-Za-z0-9_.\[\]$\-]|<key>|<seg>){1,148}$/;
// SSE patch paths ("/message/content/parts/0") are structure: each segment
// must be a short [A-Za-z0-9_\-] run, at most 12 of them. Invalid segments
// collapse to "<seg>" — the path is never a reason to drop a summary.
const SSE_PATH_SEGMENT = /^[A-Za-z0-9_\-]{1,64}$/;
const SSE_PATH_MAX_SEGMENTS = 12;
const SAFE_VALUE = /^[A-Za-z0-9_.:\-]{1,64}$/;
const SAFE_ID = /^[A-Za-z0-9_\-]{1,64}$/;
const FRAME_TYPES = new Set([
  "patch", "sse-event", "sse-raw", "sse-marker", "ws", "ws-text",
  "http", "raw", "marker",
]);
const SSE_OPS = new Set(["append", "replace", "add", "patch", "insert", "delete", "remove"]);
const RECORD_KEY_ALLOWLIST = new Set([
  "conversationId", "messageId", "generationId", "version", "control",
  "firstAt", "lastAt", "models", "frames", "recordedAt",
]);
const FRAME_KEY_ALLOWLIST = new Set(["t", "source", "summary"]);
const SUMMARY_KEY_ALLOWLIST = new Set([
  "type", "marker", "kind", "op", "path", "url", "envelopeType",
  "contentType", "bodyLength", "schema", "add", "bodySchema", "patches",
]);
const SCHEMA_KEY_ALLOWLIST = new Set([
  "path", "type", "length", "keys", "hints", "value",
]);
const VALUE_KIND_ALLOWLIST = new Set(["primitive", "id", "op", "marker"]);

function isSafeId(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}
function isSafePrimitive(value) {
  return typeof value === "string" && SAFE_VALUE.test(value);
}
function isSafeSchemaPath(value) {
  if (typeof value !== "string") return false;
  if (value === "" || value === "$") return true;
  if (SAFE_PATH.test(value)) return true;
  return PLACEHOLDER_PATH.test(value);
}
function isSafeUrl(value) {
  return typeof value === "string" && (value === "" || SAFE_URL.test(value));
}
// Re-normalize a patch path instead of rejecting it: invalid segments become
// "<seg>", the segment count is capped, and the result is always safe to
// store. An empty / non-string path normalizes to "".
function normalizePatchPath(value) {
  if (typeof value !== "string") return "";
  const segments = value
    .split("/")
    .filter(Boolean)
    .slice(0, SSE_PATH_MAX_SEGMENTS)
    .map((segment) => (SSE_PATH_SEGMENT.test(segment) ? segment : "<seg>"));
  return segments.length ? "/" + segments.join("/") : "";
}

function scrubSchemaEntry(entry, rejectsRef) {
  if (!entry || typeof entry !== "object") return null;
  const next = {};
  for (const [key, value] of Object.entries(entry)) {
    // An unknown or invalid field costs that field, never the whole entry —
    // only a leaked string value ("leak" below) may reject the record.
    if (!SCHEMA_KEY_ALLOWLIST.has(key)) continue;
    if (key === "path") {
      if (isSafeSchemaPath(value)) next.path = value;
    } else if (key === "type") {
      if (typeof value !== "string" || value.length > 32) return null;
      next.type = value;
    } else if (key === "length") {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        next.length = Math.min(Math.round(value), 1_000_000);
      }
    } else if (key === "keys") {
      if (!Array.isArray(value)) continue;
      const keys = [];
      for (const k of value.slice(0, 64)) {
        if (typeof k !== "string") continue;
        keys.push(isSafePrimitive(k) || k === "<key>" ? k : "<key>");
      }
      next.keys = keys;
    } else if (key === "hints") {
      if (!Array.isArray(value)) continue;
      const hints = [];
      for (const h of value.slice(0, 6)) {
        if (typeof h !== "string") continue;
        if (h === "starts-with-{" || h === "file-prefix" || h === "model-caption") hints.push(h);
      }
      if (hints.length) next.hints = hints;
    } else if (key === "value") {
      const scrubbed = scrubValue(value, rejectsRef);
      if (scrubbed === "leak") return "leak";
      if (scrubbed) next.value = scrubbed;
    }
  }
  return Object.keys(next).length ? next : null;
}

function scrubValue(value, rejectsRef) {
  if (!value || typeof value !== "object") return null;
  const kind = value.kind;
  if (!VALUE_KIND_ALLOWLIST.has(kind)) return null;
  if (kind === "marker") return { kind: "marker" };
  if (kind === "primitive" || kind === "op") {
    if (typeof value.text !== "string") return null;
    if (!isSafePrimitive(value.text)) {
      rejectsRef.value += 1;
      return "leak";
    }
    return { kind, text: value.text };
  }
  if (kind === "id") {
    if (typeof value.value !== "string") return null;
    if (!isSafeId(value.value)) {
      rejectsRef.value += 1;
      return "leak";
    }
    return { kind: "id", value: value.value.slice(0, 8) };
  }
  return null;
}

// One entry of a summary's `patches` array: a sub-patch of a batch patch
// carrying its own path / op / value schema.
function scrubPatchEntry(patch, rejectsRef) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return null;
  const next = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "path") {
      const normalized = normalizePatchPath(value);
      if (normalized) next.path = normalized;
    } else if (key === "op") {
      if (typeof value === "string" && SSE_OPS.has(value)) next.op = value;
    } else if (key === "schema") {
      if (!Array.isArray(value)) continue;
      const entries = [];
      for (const item of value.slice(0, 96)) {
        const scrubbed = scrubSchemaEntry(item, rejectsRef);
        if (scrubbed === "leak") return "leak";
        if (scrubbed) entries.push(scrubbed);
      }
      next.schema = entries;
    }
    // unknown sub-patch fields are dropped with the field, not the frame
  }
  return Object.keys(next).length ? next : null;
}

function scrubSummary(summary, rejectsRef) {
  if (!summary || typeof summary !== "object") return null;
  const next = {};
  for (const [key, value] of Object.entries(summary)) {
    // An unknown field costs that field only; the rest of the summary
    // survives. Only a leaked string value may reject the whole record.
    if (!SUMMARY_KEY_ALLOWLIST.has(key) && key !== "length") continue;
    if (key === "type") {
      if (typeof value === "string" && FRAME_TYPES.has(value)) next.type = value;
    } else if (key === "marker" || key === "kind") {
      if (typeof value === "string" && isSafePrimitive(value)) next[key] = value;
    } else if (key === "op") {
      if (typeof value === "string" && SSE_OPS.has(value)) next.op = value;
    } else if (key === "path") {
      const normalized = normalizePatchPath(value);
      if (normalized) next.path = normalized;
    } else if (key === "url") {
      if (isSafeUrl(value)) next.url = value;
    } else if (key === "envelopeType" || key === "contentType") {
      if (typeof value === "string" && isSafePrimitive(value)) next[key] = value;
    } else if (key === "bodyLength" || key === "length") {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        next[key] = Math.min(Math.round(value), 10_000_000);
      }
    } else if (key === "schema" || key === "add" || key === "bodySchema") {
      if (!Array.isArray(value)) continue;
      const entries = [];
      for (const item of value.slice(0, 96)) {
        const scrubbed = scrubSchemaEntry(item, rejectsRef);
        if (scrubbed === "leak") {
          rejectsRef.value += 1;
          return "leak";
        }
        if (scrubbed) entries.push(scrubbed);
      }
      next[key] = entries;
    } else if (key === "patches") {
      if (!Array.isArray(value)) continue;
      const patches = [];
      for (const patch of value.slice(0, 24)) {
        const scrubbed = scrubPatchEntry(patch, rejectsRef);
        if (scrubbed === "leak") {
          rejectsRef.value += 1;
          return "leak";
        }
        if (scrubbed) patches.push(scrubbed);
      }
      if (patches.length) next.patches = patches;
    }
  }
  return Object.keys(next).length ? next : null;
}

function scrubFrame(frame, rejectsRef) {
  if (!frame || typeof frame !== "object") return null;
  const next = {};
  for (const [key, value] of Object.entries(frame)) {
    if (!FRAME_KEY_ALLOWLIST.has(key)) continue;
    if (key === "t") {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        next.t = Math.min(Math.round(value), 32_503_680_000_000);
      }
    } else if (key === "source") {
      if (typeof value === "string" && isSafePrimitive(value)) next.source = value;
    } else if (key === "summary") {
      const scrubbed = scrubSummary(value, rejectsRef);
      if (scrubbed === "leak") return "leak";
      if (scrubbed) next.summary = scrubbed;
    }
  }
  return Object.keys(next).length ? next : null;
}

export function scrubRecord(payload) {
  if (!payload || typeof payload !== "object") return "leak";
  const rejectsRef = { value: 0 };
  const next = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!RECORD_KEY_ALLOWLIST.has(key)) continue;
    if (key === "conversationId") {
      if (!isSafeId(value)) return "leak";
      next.conversationId = value.slice(0, 8);
    } else if (key === "messageId" || key === "generationId") {
      if (typeof value !== "string" || value === "") continue;
      if (!isSafeId(value)) return "leak";
      next[key] = value.slice(0, 8);
    } else if (key === "version") {
      if (typeof value !== "string" || !isSafePrimitive(value)) return "leak";
      next.version = value;
    } else if (key === "control") {
      if (typeof value !== "boolean") return "leak";
      next.control = value;
    } else if (key === "firstAt" || key === "lastAt") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "leak";
      next[key] = Math.round(value);
    } else if (key === "models") {
      if (!Array.isArray(value)) return "leak";
      const models = [];
      for (const m of value.slice(0, 16)) {
        if (typeof m !== "string") return "leak";
        if (!isSafePrimitive(m)) {
          rejectsRef.value += 1;
          return "leak";
        }
        models.push(m);
      }
      next.models = models;
    } else if (key === "frames") {
      if (!Array.isArray(value)) return "leak";
      const frames = [];
      for (const f of value.slice(0, 200)) {
        const scrubbed = scrubFrame(f, rejectsRef);
        if (scrubbed === "leak") {
          rejectsRef.value += 1;
          return "leak";
        }
        if (scrubbed) frames.push(scrubbed);
      }
      next.frames = frames;
    } else if (key === "recordedAt") {
      if (typeof value !== "number" || !Number.isFinite(value)) return "leak";
      next.recordedAt = Math.round(value);
    }
  }
  if (!next.conversationId) return "leak";
  return { record: next, rejects: rejectsRef.value };
}

export const internals = {
  SAFE_URL, SAFE_PATH, SAFE_VALUE, SAFE_ID,
  FRAME_TYPES, SSE_OPS,
  RECORD_KEY_ALLOWLIST, FRAME_KEY_ALLOWLIST, SUMMARY_KEY_ALLOWLIST, SCHEMA_KEY_ALLOWLIST, VALUE_KIND_ALLOWLIST,
  scrubSchemaEntry, scrubValue, scrubSummary, scrubFrame, scrubPatchEntry,
  isSafeId, isSafePrimitive, isSafeSchemaPath, isSafeUrl, normalizePatchPath,
};
