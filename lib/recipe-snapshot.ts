import { createHash } from "node:crypto";
import { normalizeReferenceRights, normalizeUseList } from "./reference-rights.js";

export const RECIPE_SNAPSHOT_SCHEMA_VERSION = "1.0.0";

interface RecipeSnapshot {
  snapshot_id: string; schema_version: string; project_id: string; asset_id: string; recipe_digest: string; prompt_digest: string;
  effective_prompt: string; user_prompt: string; negative_prompt: string; prompt_status: string; generation_tool: string;
  model: string; provider: string; skill: string; style: string; ratio: string; theme: string;
  references: NormalizedReference[]; provenance: Provenance; change_summary: string; created_at: string;
}
interface Provenance {
  source_type: string;
  task_id: string;
  session_id: string;
  capture_context_id: string;
  provider_tool_call_id: string;
  provider_generation_call_id: string;
  provider_response_id: string;
  provider_asset_id: string;
  verification_level: string;
}
interface NormalizedReference { asset_id: string; reference_id?: string; sha256: string; attachment_url?: string; mime_type?: string; width?: number; height?: number; role: string; scope: string[]; applied: boolean; allowed_uses: string[]; forbidden_uses: string[]; rights: Record<string, unknown>; }
interface Asset { id?: string; [key: string]: unknown; }
interface DigestReference { asset_id: string; sha256: string; role: string; scope: string[]; applied: boolean; }

export function buildRecipeSnapshot(asset: Asset = {}, options: { createdAt?: string; changeSummary?: string } = {}): RecipeSnapshot {
  const material = recipeMaterial(asset);
  const recipeDigest = sha256(stableStringify(digestMaterial(material)));
  const createdAt = String(options.createdAt || asset.updated_at || asset.created_at || new Date().toISOString());
  return {
    snapshot_id: `recipe-${recipeDigest.slice(0, 24)}`, schema_version: RECIPE_SNAPSHOT_SCHEMA_VERSION,
    project_id: String(asset.project_id || asset.projectId || "default"), asset_id: String(asset.id || asset.assetId || ""),
    recipe_digest: recipeDigest, prompt_digest: sha256(material.effective_prompt),
    effective_prompt: material.effective_prompt, user_prompt: material.user_prompt, negative_prompt: material.negative_prompt,
    prompt_status: material.prompt_status, generation_tool: material.generation_tool, model: material.model, provider: material.provider,
    skill: material.skill, style: material.style, ratio: material.ratio, theme: material.theme,
    references: material.references, provenance: material.provenance,
    change_summary: String(options.changeSummary || asset.version_change || "").trim(), created_at: createdAt,
  };
}

export function ensureRecipeSnapshots(asset: Asset = {}): Asset {
  const snapshots = normalizeExistingSnapshots(asset.recipe_snapshots as RecipeSnapshot[] | undefined, asset);
  if (!snapshots.length) snapshots.push(buildRecipeSnapshot(asset, { createdAt: asset.created_at as string, changeSummary: (asset.version_change as string) || "Initial recipe" }));
  const activeId = snapshots.some((s) => s.snapshot_id === asset.active_recipe_snapshot_id) ? asset.active_recipe_snapshot_id : snapshots.at(-1)!.snapshot_id;
  return { ...asset, recipe_snapshots: snapshots as RecipeSnapshot[], active_recipe_snapshot_id: activeId } as Asset;
}

export function appendRecipeSnapshot(previous: Asset = {}, next: Asset = {}, options: { createdAt?: string; changeSummary?: string } = {}): Asset {
  const current: Asset = previous.id || Array.isArray(previous.recipe_snapshots) ? ensureRecipeSnapshots(previous) : { recipe_snapshots: [] as RecipeSnapshot[] };
  const snapshot = buildRecipeSnapshot(next, options);
  const snapshots = [...((current.recipe_snapshots as RecipeSnapshot[] | undefined) || [])];
  const existing = snapshots.findIndex((s) => s.recipe_digest === snapshot.recipe_digest);
  if (existing < 0) snapshots.push(snapshot); else snapshots[existing] = refreshReferenceRights(snapshots[existing], snapshot);
  const active = snapshots.find((s) => s.recipe_digest === snapshot.recipe_digest) || snapshots.at(-1)!;
  return { ...next, recipe_snapshots: snapshots, active_recipe_snapshot_id: active.snapshot_id };
}

export function recipeHistory(asset: Asset = {}) {
  const normalized = ensureRecipeSnapshots(asset);
  return { project_id: normalized.project_id, asset_id: normalized.id, active_snapshot_id: normalized.active_recipe_snapshot_id, snapshots: normalized.recipe_snapshots };
}

export function normalizeSnapshotReferences(value: unknown): NormalizedReference[] { return normalizeReferences(value); }

export function recipeMaterial(asset: Asset = {}) {
  const source = isObject(asset.source) ? asset.source : {};
  const business = isObject(asset.business_fields) ? asset.business_fields : {};
  return {
    effective_prompt: cleanText(asset.prompt), user_prompt: cleanText(asset.user_prompt || source.user_prompt || source.user_message || business.user_prompt || business.user_message),
    negative_prompt: cleanText(asset.negative_prompt || business.negative_prompt),
    prompt_status: cleanText(source.prompt_status || business.prompt_status || (asset.prompt ? "manual" : "not-available")),
    generation_tool: cleanText(source.generation_tool || business.generation_tool), model: cleanText(source.model || business.model),
    provider: cleanText(source.provider || business.provider), skill: cleanText(asset.skill), style: cleanText(asset.style),
    ratio: cleanText(asset.ratio), theme: cleanText(asset.theme),
    references: normalizeReferences(asset.references || business.references || source.references),
    provenance: {
      source_type: cleanText(source.type || asset.sourceType || "local-file"),
      task_id: cleanText(source.codex_task_id || source.task_id),
      session_id: cleanText(source.codex_session_id || source.grok_session_id || source.conversation_id),
      capture_context_id: cleanText(source.capture_context_id || source.generation_context_id),
      provider_tool_call_id: cleanText(source.provider_tool_call_id),
      provider_generation_call_id: cleanText(source.provider_generation_call_id || source.codex_image_generation_call_id),
      provider_response_id: cleanText(source.provider_response_id),
      provider_asset_id: cleanText(source.provider_asset_id),
      verification_level: cleanText(source.verification_level || "observed"),
    },
  };
}

function normalizeExistingSnapshots(value: RecipeSnapshot[] | undefined, asset: Asset): RecipeSnapshot[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>(); const snapshots: RecipeSnapshot[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const normalized: RecipeSnapshot = { ...(item as unknown as RecipeSnapshot), snapshot_id: cleanText(item.snapshot_id), schema_version: cleanText(item.schema_version || RECIPE_SNAPSHOT_SCHEMA_VERSION), project_id: cleanText(item.project_id || asset.project_id || "default"), asset_id: cleanText(item.asset_id || asset.id), recipe_digest: cleanText(item.recipe_digest), prompt_digest: cleanText(item.prompt_digest), effective_prompt: cleanText(item.effective_prompt), user_prompt: cleanText(item.user_prompt), negative_prompt: cleanText(item.negative_prompt), prompt_status: cleanText(item.prompt_status), generation_tool: cleanText(item.generation_tool), model: cleanText(item.model), provider: cleanText(item.provider), skill: cleanText(item.skill), style: cleanText(item.style), ratio: cleanText(item.ratio), theme: cleanText(item.theme), references: normalizeReferences(item.references), provenance: normalizeProvenance(item.provenance), change_summary: cleanText(item.change_summary), created_at: cleanText(item.created_at || asset.created_at) };
    if (!normalized.recipe_digest) normalized.recipe_digest = sha256(stableStringify(digestMaterial(snapshotMaterial(normalized))));
    if (!normalized.snapshot_id) normalized.snapshot_id = `recipe-${normalized.recipe_digest.slice(0, 24)}`;
    if (!normalized.prompt_digest) normalized.prompt_digest = sha256(normalized.effective_prompt);
    if (seen.has(normalized.snapshot_id)) continue; seen.add(normalized.snapshot_id); snapshots.push(normalized);
  }
  return snapshots.sort((l, r) => String(l.created_at).localeCompare(String(r.created_at)) || String(l.snapshot_id).localeCompare(String(r.snapshot_id)));
}

function snapshotMaterial(s: RecipeSnapshot) { return { effective_prompt: s.effective_prompt, user_prompt: s.user_prompt, negative_prompt: s.negative_prompt, prompt_status: s.prompt_status, generation_tool: s.generation_tool, model: s.model, provider: s.provider, skill: s.skill, style: s.style, ratio: s.ratio, theme: s.theme, references: s.references, provenance: s.provenance }; }

function normalizeReferences(value: unknown): NormalizedReference[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((item) => {
    if (typeof item === "string") return withRights({ asset_id: cleanText(item), sha256: "", role: "", scope: [], applied: true }, {});
    if (!isObject(item)) return null;
    const ref = item as Record<string, unknown>;
    const base: Omit<NormalizedReference, "allowed_uses" | "forbidden_uses" | "rights"> = { asset_id: cleanText(ref.asset_id || ref.assetId || ref.id || ref.reference_id), sha256: cleanText(ref.sha256 || ref.content_sha256 || ref.digest), role: cleanText(ref.role || ref.purpose || ref.use), scope: (Array.isArray(ref.scope || ref.applies_to) ? [...new Set(((ref.scope || ref.applies_to) as string[]).map(cleanText).filter(Boolean))] : []) as string[], applied: ref.applied !== false };
    const referenceId = cleanText(ref.reference_id);
    const attachmentUrl = cleanText(ref.attachment_url);
    const mimeType = cleanText(ref.mime_type);
    if (referenceId) base.reference_id = referenceId;
    if (attachmentUrl) base.attachment_url = attachmentUrl;
    if (mimeType) base.mime_type = mimeType;
    if (Number(ref.width) > 0) base.width = Number(ref.width);
    if (Number(ref.height) > 0) base.height = Number(ref.height);
    return withRights(base, ref);
  }).filter((r): r is NormalizedReference => r !== null).sort((l, r) => stableStringify(referenceDigestMaterial(l)).localeCompare(stableStringify(referenceDigestMaterial(r))));
}

function withRights(base: Omit<NormalizedReference, "allowed_uses" | "forbidden_uses" | "rights">, source: Record<string, unknown>): NormalizedReference {
  return { ...base, allowed_uses: normalizeUseList(source.allowed_uses), forbidden_uses: normalizeUseList(source.forbidden_uses), rights: normalizeReferenceRights(source.rights ?? source) };
}

function referenceDigestMaterial(r: NormalizedReference): DigestReference { return { asset_id: r.asset_id, sha256: r.sha256, role: r.role, scope: r.scope, applied: r.applied }; }
function digestMaterial(m: { references: NormalizedReference[] }) { return { ...m, references: (m.references || []).map(referenceDigestMaterial) }; }

function refreshReferenceRights(stored: RecipeSnapshot, incoming: RecipeSnapshot): RecipeSnapshot {
  const byIdentity = new Map((incoming.references || []).map((r) => [stableStringify(referenceDigestMaterial(r)), r]));
  return { ...stored, references: (stored.references || []).map((r) => { const match = byIdentity.get(stableStringify(referenceDigestMaterial(r))); if (!match) return r; return { ...r, allowed_uses: match.allowed_uses, forbidden_uses: match.forbidden_uses, rights: match.rights }; }) };
}

function normalizeProvenance(value: unknown): Provenance {
  const s = isObject(value) ? value : {};
  return {
    source_type: cleanText(s.source_type),
    task_id: cleanText(s.task_id),
    session_id: cleanText(s.session_id),
    capture_context_id: cleanText(s.capture_context_id || s.generation_call_id),
    provider_tool_call_id: cleanText(s.provider_tool_call_id),
    provider_generation_call_id: cleanText(s.provider_generation_call_id),
    provider_response_id: cleanText(s.provider_response_id),
    provider_asset_id: cleanText(s.provider_asset_id),
    verification_level: cleanText(s.verification_level || "observed"),
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isObject(value)) { const obj = value as Record<string, unknown>; return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`; }
  return JSON.stringify(value);
}

function sha256(value: string): string { return createHash("sha256").update(String(value)).digest("hex"); }
function cleanText(value: unknown): string { return String(value || "").trim(); }
function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
