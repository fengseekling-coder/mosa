import { normalizeAssetSearchQuery } from "./asset-search.mjs";

const CONVERSATIONAL_MARKERS = Object.freeze([
  "帮我", "找一下", "找找", "之前", "以前", "那个", "那张", "这张", "我记得", "我之前", "做过", "精选过", "版本",
]);

const CJK_STOP_TERMS = new Set([
  "帮我", "找一", "一下", "找找", "之前", "以前", "那个", "那张", "这张", "我记", "记得",
  "做过", "做的", "很多", "设计", "版本", "素材", "图片", "照片", "精选", "选过",
]);

const ASCII_STOP_TERMS = new Set([
  "a", "an", "the", "me", "my", "find", "show", "please", "previous", "earlier", "version", "image", "picture",
]);

const SCAFFOLDING_REPLACEMENTS = Object.freeze([
  "帮我找一下", "帮我找找", "帮我找", "我之前", "我记得", "找一下", "找找", "之前", "以前",
  "那个", "那张", "这张", "做过的", "做过", "精选过", "的版本", "很多", "设计",
]);

export function conversationalAssetSearchPlan(query) {
  const original = normalizeAssetSearchQuery(query);
  if (!original || !looksConversational(original)) return null;

  let cleaned = original.normalize("NFKC");
  for (const phrase of SCAFFOLDING_REPLACEMENTS) cleaned = cleaned.replaceAll(phrase, " ");
  cleaned = cleaned
    .replace(/[的了着呢吧吗]/gu, " ")
    .replace(/做/gu, " ")
    .replace(/[，。、“”‘’！？；：,.!?;:()[\]{}<>/\\|~·…—–_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  const cjkTerms = [];
  const asciiTerms = [];
  for (const match of cleaned.matchAll(/[\p{Script=Han}]+|[a-z0-9][a-z0-9._-]*/giu)) {
    const token = match[0].toLocaleLowerCase();
    if (/^\p{Script=Han}+$/u.test(token)) {
      const chars = [...token];
      for (let index = 0; index < chars.length; index += 2) {
        const term = chars.slice(index, index + 2).join("");
        if (term && !CJK_STOP_TERMS.has(term)) cjkTerms.push(term);
      }
    } else if (token.length >= 2 && !ASCII_STOP_TERMS.has(token)) {
      asciiTerms.push(token);
    }
  }

  const uniqueCjk = [...new Set(cjkTerms)];
  const uniqueAscii = [...new Set(asciiTerms)];
  if (uniqueCjk.length + uniqueAscii.length < 2) return null;
  return { original, cleaned, cjkTerms: uniqueCjk, asciiTerms: uniqueAscii };
}

export function finalizeConversationalSearchPlan(plan, knownCjkTerms) {
  if (!plan) return null;
  const known = knownCjkTerms instanceof Set ? knownCjkTerms : new Set(knownCjkTerms || []);
  const terms = [
    ...plan.cjkTerms.filter((term) => known.has(term)),
    ...plan.asciiTerms,
  ];
  const unique = [...new Set(terms)].slice(0, 12);
  if (unique.length < 2) return null;
  const query = normalizeAssetSearchQuery(unique.join(" "));
  if (!query || query === plan.original) return null;
  return { ...plan, terms: unique, query };
}

function looksConversational(query) {
  const hasMarker = CONVERSATIONAL_MARKERS.some((marker) => query.includes(marker));
  if (!hasMarker) return false;
  const cjkLength = [...query].filter((char) => /\p{Script=Han}/u.test(char)).length;
  return cjkLength >= 6;
}
