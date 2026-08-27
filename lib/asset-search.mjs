import { compareAssets } from "./asset-sort.js";

const ASSET_KIND_ALIASES = Object.freeze([
  ["logo", ["logo", "logomark", "brandmark", "brand mark", "品牌logo", "品牌 logo", "品牌标志", "品牌标识", "徽标", "标志", "标识"]],
  ["poster", ["poster", "海报"]],
  ["icon", ["icon", "图标"]],
  ["banner", ["banner", "横幅", "条幅"]],
  ["cover", ["cover", "封面"]],
  ["avatar", ["avatar", "头像"]],
  ["illustration", ["illustration", "illustrative", "插画"]],
  ["photo", ["photo", "photograph", "photography", "照片", "摄影"]],
  ["mockup", ["mockup", "样机"]],
  ["packaging", ["packaging", "package design", "包装"]],
  ["ui", ["ui", "interface", "界面"]],
  ["wallpaper", ["wallpaper", "壁纸"]],
]);

const ASSET_KIND_ALIAS_MAP = new Map(ASSET_KIND_ALIASES);
const ASSET_KIND_ALIAS_REGEX_MAP = new Map(
  ASSET_KIND_ALIASES.flatMap(([, aliases]) => aliases)
    .filter((alias) => /^[a-z0-9][a-z0-9 -]*$/i.test(alias))
    .map((alias) => [alias, new RegExp(`(^|[^a-z0-9])(${escapeRegex(alias)})(?=$|[^a-z0-9])`, "i")]),
);

export const ASSET_SEARCH_WEIGHTS = Object.freeze({
  assetExact: 120,
  idExact: 112,
  tagExact: 108,
  categoryExact: 100,
  groupExact: 96,
  assetContains: 88,
  idContains: 82,
  tagContains: 80,
  categoryContains: 76,
  groupContains: 72,
  styleExact: 68,
  themeExact: 64,
  skillExact: 60,
  styleContains: 54,
  themeContains: 50,
  skillContains: 46,
  promptExact: 44,
  promptContains: 26,
  promptFrequencyStep: 4,
  promptFrequencyCap: 16,
  promptPrefixBonus: 8,
  businessContains: 10,
  sourceContains: 6,
  fallbackContains: 4,
  phraseAssetBonus: 28,
  phraseTagBonus: 24,
  phraseCategoryBonus: 20,
  phraseGroupBonus: 18,
  phrasePromptBonus: 6,
});

export function normalizeAssetSearchQuery(query) {
  return String(query || "").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

export function assetSearchTerms(query) {
  const normalized = normalizeAssetSearchQuery(query);
  return normalized ? normalized.split(" ").filter(Boolean) : [];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aliasIndex(text, alias) {
  if (!text || !alias) return -1;
  const aliasRegex = ASSET_KIND_ALIAS_REGEX_MAP.get(alias);
  if (aliasRegex) {
    const match = aliasRegex.exec(text);
    return match ? match.index + match[1].length : -1;
  }
  return text.indexOf(alias);
}

function aliasesForKind(kind) {
  return ASSET_KIND_ALIAS_MAP.get(String(kind || "")) || [];
}

export function assetSearchKind(query) {
  const normalized = normalizeAssetSearchQuery(query);
  if (!normalized) return "";
  const matches = ASSET_KIND_ALIASES
    .filter(([, aliases]) => aliases.some((alias) => aliasIndex(normalized, alias) >= 0))
    .map(([kind]) => kind);
  return matches.length === 1 ? matches[0] : "";
}

export function valueMatchesAssetSearchKind(value, kind) {
  const normalized = normalizedScalar(value);
  return aliasesForKind(kind).some((alias) => aliasIndex(normalized, alias) >= 0);
}

export function dominantPromptSearchKind(prompt) {
  const normalized = normalizeAssetSearchQuery(prompt);
  if (!normalized) return "";
  let winner = "";
  let winnerIndex = Number.POSITIVE_INFINITY;
  let winnerAliasLength = 0;
  for (const [kind, aliases] of ASSET_KIND_ALIASES) {
    for (const alias of aliases) {
      const index = aliasIndex(normalized, alias);
      if (index < 0) continue;
      if (index < winnerIndex || (index === winnerIndex && alias.length > winnerAliasLength)) {
        winner = kind;
        winnerIndex = index;
        winnerAliasLength = alias.length;
      }
    }
  }
  return winner;
}

function normalizedScalar(value) {
  return typeof value === "string" || typeof value === "number"
    ? String(value).toLocaleLowerCase()
    : "";
}

function normalizedObjectValues(value) {
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap((item) => {
    if (Array.isArray(item)) return item.map(normalizedScalar).filter(Boolean);
    return [normalizedScalar(item)].filter(Boolean);
  });
}

export function assetMatchesSearchKind(asset, kind) {
  if (!kind) return true;
  const structuredValues = [
    asset?.asset,
    asset?.id,
    asset?.category,
    asset?.group,
    asset?.style,
    asset?.theme,
    asset?.skill,
    ...(Array.isArray(asset?.tags) ? asset.tags : []),
  ];
  if (structuredValues.some((value) => valueMatchesAssetSearchKind(value, kind))) return true;
  return dominantPromptSearchKind(asset?.prompt) === kind;
}

function assetMatchesKindIntent(asset, query) {
  return assetMatchesSearchKind(asset, assetSearchKind(query));
}

function promptTermScore(prompt, term) {
  if (!prompt || !term || !prompt.includes(term)) return 0;
  if (prompt === term) return ASSET_SEARCH_WEIGHTS.promptExact;
  const occurrences = prompt.split(term).length - 1;
  const frequencyBonus = Math.min(
    ASSET_SEARCH_WEIGHTS.promptFrequencyCap,
    Math.max(0, occurrences - 1) * ASSET_SEARCH_WEIGHTS.promptFrequencyStep,
  );
  const prefixBonus = prompt.trimStart().startsWith(term) ? ASSET_SEARCH_WEIGHTS.promptPrefixBonus : 0;
  return ASSET_SEARCH_WEIGHTS.promptContains + frequencyBonus + prefixBonus;
}

function bestTermScore(asset, term) {
  const name = normalizedScalar(asset?.asset);
  const id = normalizedScalar(asset?.id);
  const tags = Array.isArray(asset?.tags) ? asset.tags.map(normalizedScalar).filter(Boolean) : [];
  const category = normalizedScalar(asset?.category);
  const group = normalizedScalar(asset?.group);
  const style = normalizedScalar(asset?.style);
  const theme = normalizedScalar(asset?.theme);
  const skill = normalizedScalar(asset?.skill);
  const prompt = normalizedScalar(asset?.prompt);
  const businessValues = normalizedObjectValues(asset?.business_fields);
  const sourceValues = normalizedObjectValues(asset?.source);

  if (name === term) return ASSET_SEARCH_WEIGHTS.assetExact;
  if (id === term) return ASSET_SEARCH_WEIGHTS.idExact;
  if (tags.includes(term)) return ASSET_SEARCH_WEIGHTS.tagExact;
  if (category === term) return ASSET_SEARCH_WEIGHTS.categoryExact;
  if (group === term) return ASSET_SEARCH_WEIGHTS.groupExact;
  if (name.includes(term)) return ASSET_SEARCH_WEIGHTS.assetContains;
  if (id.includes(term)) return ASSET_SEARCH_WEIGHTS.idContains;
  if (tags.some((value) => value.includes(term))) return ASSET_SEARCH_WEIGHTS.tagContains;
  if (category.includes(term)) return ASSET_SEARCH_WEIGHTS.categoryContains;
  if (group.includes(term)) return ASSET_SEARCH_WEIGHTS.groupContains;
  if (style === term) return ASSET_SEARCH_WEIGHTS.styleExact;
  if (theme === term) return ASSET_SEARCH_WEIGHTS.themeExact;
  if (skill === term) return ASSET_SEARCH_WEIGHTS.skillExact;
  if (style.includes(term)) return ASSET_SEARCH_WEIGHTS.styleContains;
  if (theme.includes(term)) return ASSET_SEARCH_WEIGHTS.themeContains;
  if (skill.includes(term)) return ASSET_SEARCH_WEIGHTS.skillContains;
  const promptScore = promptTermScore(prompt, term);
  if (promptScore) return promptScore;
  if (businessValues.some((value) => value.includes(term))) return ASSET_SEARCH_WEIGHTS.businessContains;
  if (sourceValues.some((value) => value.includes(term))) return ASSET_SEARCH_WEIGHTS.sourceContains;
  return 0;
}

function phraseBonus(asset, phrase) {
  if (!phrase) return 0;
  const name = normalizedScalar(asset?.asset);
  const tags = Array.isArray(asset?.tags) ? asset.tags.map(normalizedScalar).filter(Boolean) : [];
  const category = normalizedScalar(asset?.category);
  const group = normalizedScalar(asset?.group);
  const prompt = normalizedScalar(asset?.prompt);
  if (name === phrase || name.includes(phrase)) return ASSET_SEARCH_WEIGHTS.phraseAssetBonus;
  if (tags.some((value) => value === phrase || value.includes(phrase))) return ASSET_SEARCH_WEIGHTS.phraseTagBonus;
  if (category === phrase || category.includes(phrase)) return ASSET_SEARCH_WEIGHTS.phraseCategoryBonus;
  if (group === phrase || group.includes(phrase)) return ASSET_SEARCH_WEIGHTS.phraseGroupBonus;
  if (prompt.includes(phrase)) return ASSET_SEARCH_WEIGHTS.phrasePromptBonus;
  return 0;
}

export function assetSearchScore(asset, query) {
  const terms = assetSearchTerms(query);
  if (!terms.length) return 0;
  if (!assetMatchesKindIntent(asset, query)) return 0;
  let score = 0;
  for (const term of terms) {
    const termScore = bestTermScore(asset, term);
    if (!termScore) return 0;
    score += termScore;
  }
  return score + phraseBonus(asset, normalizeAssetSearchQuery(query));
}

export function compareAssetSearchResults(query, sort, left, right) {
  const rankDifference = assetSearchScore(right, query) - assetSearchScore(left, query);
  return rankDifference || compareAssets(sort, left, right);
}
