/**
 * Reference rights and permitted-use declarations.
 *
 * A reference image carried by a recipe is a picture that belongs to someone.
 * MOSA records what a reference may and may not be used for, and whether its
 * copyright, portrait consent, and redistribution state are actually known.
 *
 * Two rules are load-bearing:
 *
 * 1. A forbidden use always beats an allowed use. A declaration that both
 *    permits and forbids the same purpose resolves to forbidden.
 * 2. Undeclared is not permitted, and it is not forbidden either. It is
 *    reported as `undeclared`, the same way an unavailable Prompt is reported
 *    rather than invented.
 *
 * These declarations are deliberately excluded from `recipe_digest`. They
 * describe a reference; they are not generation inputs. Recording consent for
 * an image that already exists must never fabricate a new recipe. See
 * `lib/recipe-snapshot.mjs`.
 */

/** Canonical reference purposes. Unknown values are preserved, not rejected. */
export const REFERENCE_USES = Object.freeze([
  "identity",
  "subject",
  "world",
  "space",
  "composition",
  "lighting",
  "wardrobe",
  "color",
  "style",
  "prop",
]);

export const COPYRIGHT_STATES = Object.freeze(["unknown", "owned", "licensed", "third-party"]);
export const PORTRAIT_CONSENT_STATES = Object.freeze(["unknown", "granted", "not-required", "denied"]);
export const REDISTRIBUTION_STATES = Object.freeze(["unknown", "allowed", "forbidden"]);

/** Every rights field starts unknown. Silence is never treated as permission. */
export function defaultReferenceRights() {
  return { copyright: "unknown", portrait_consent: "unknown", redistribution: "unknown", attribution: "" };
}

export function normalizeUse(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeUseList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeUse).filter(Boolean))].sort();
}

export function normalizeReferenceRights(value) {
  const source = isObject(value) ? value : {};
  return {
    copyright: pickState(source.copyright, COPYRIGHT_STATES),
    portrait_consent: pickState(source.portrait_consent ?? source.consent, PORTRAIT_CONSENT_STATES, CONSENT_BOOLEANS),
    redistribution: pickState(source.redistribution ?? source.redistribution_allowed, REDISTRIBUTION_STATES),
    attribution: String(source.attribution ?? "").trim(),
  };
}

/**
 * Resolve one reference to `cleared`, `restricted`, or `unresolved`.
 *
 * An explicit denial outranks an unknown, because it is actionable now: a
 * reference whose consent was refused stays unusable however many other fields
 * are later filled in.
 */
export function referenceRightsStatus(reference) {
  // Accept both a normalized reference and a raw one whose rights are still
  // flat, so a caller holding un-normalized `asset.references` reads the same
  // status the stored snapshot will show.
  const source = isObject(reference) ? reference : {};
  const rights = normalizeReferenceRights(source.rights ?? source);
  if (rights.portrait_consent === "denied" || rights.redistribution === "forbidden") return "restricted";
  const stated = [rights.copyright, rights.portrait_consent, rights.redistribution];
  if (stated.some((state) => state === "unknown")) return "unresolved";
  return "cleared";
}

/**
 * Resolve one purpose against one reference.
 *
 * Returns `forbidden`, `allowed`, or `undeclared`. A caller that needs a
 * boolean must decide for itself what to do with `undeclared`; this module
 * will not guess.
 */
export function referenceUsePermission(reference, use) {
  const target = normalizeUse(use);
  if (!target || !isObject(reference)) return "undeclared";
  if (normalizeUseList(reference.forbidden_uses).includes(target)) return "forbidden";
  const allowed = normalizeUseList(reference.allowed_uses);
  if (allowed.includes(target)) return "allowed";
  if (allowed.length) return "forbidden";
  return "undeclared";
}

/** True only for a reference whose rights are fully known and permissive. */
export function isReferenceCleared(reference) {
  return referenceRightsStatus(reference) === "cleared";
}

/** Summarise a reference list for display without inspecting every entry. */
export function summarizeReferenceRights(references) {
  const list = Array.isArray(references) ? references : [];
  const summary = { total: list.length, cleared: 0, restricted: 0, unresolved: 0 };
  for (const reference of list) summary[referenceRightsStatus(reference)] += 1;
  return summary;
}

/**
 * Portrait consent has no allowed/forbidden pair, so a boolean has to be
 * mapped onto its own vocabulary. Dropping `false` to `unknown` would demote an
 * explicit refusal to merely unreviewed, which is the wrong direction: a
 * refusal must stay a refusal however it was written.
 */
const CONSENT_BOOLEANS = Object.freeze({ true: "granted", false: "denied" });
const DEFAULT_BOOLEANS = Object.freeze({ true: "allowed", false: "forbidden" });

function pickState(value, allowed, booleans = DEFAULT_BOOLEANS) {
  if (typeof value === "boolean") {
    const mapped = booleans[String(value)];
    return allowed.includes(mapped) ? mapped : "unknown";
  }
  const normalized = normalizeUse(value);
  return allowed.includes(normalized) ? normalized : "unknown";
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
