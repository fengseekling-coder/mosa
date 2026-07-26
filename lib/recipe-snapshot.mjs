import { createHash } from "node:crypto";
import { defaultReferenceRights, normalizeReferenceRights, normalizeUseList } from "./reference-rights.mjs";

export const RECIPE_SNAPSHOT_SCHEMA_VERSION = "1.0.0";

export function buildRecipeSnapshot(asset = {}, options = {}) {
  const material = recipeMaterial(asset);
  const recipeDigest = sha256(stableStringify(digestMaterial(material)));
  const createdAt = String(options.createdAt || asset.updated_at || asset.created_at || new Date().toISOString());
  return {
    snapshot_id: `recipe-${recipeDigest.slice(0, 24)}`,
    schema_version: RECIPE_SNAPSHOT_SCHEMA_VERSION,
    project_id: String(asset.project_id || asset.projectId || "default"),
    asset_id: String(asset.id || asset.assetId || ""),
    recipe_digest: recipeDigest,
    prompt_digest: sha256(material.effective_prompt),
    effective_prompt: material.effective_prompt,
    user_prompt: material.user_prompt,
    negative_prompt: material.negative_prompt,
    prompt_status: material.prompt_status,
    generation_tool: material.generation_tool,
    model: material.model,
    provider: material.provider,
    skill: material.skill,
    style: material.style,
    ratio: material.ratio,
    theme: material.theme,
    references: material.references,
    provenance: material.provenance,
    change_summary: String(options.changeSummary || asset.version_change || "").trim(),
    created_at: createdAt,
  };
}

export function ensureRecipeSnapshots(asset = {}) {
  const snapshots = normalizeExistingSnapshots(asset.recipe_snapshots, asset);
  if (!snapshots.length) {
    snapshots.push(buildRecipeSnapshot(asset, {
      createdAt: asset.created_at,
      changeSummary: asset.version_change || "Initial recipe",
    }));
  }
  const activeId = snapshots.some((snapshot) => snapshot.snapshot_id === asset.active_recipe_snapshot_id)
    ? asset.active_recipe_snapshot_id
    : snapshots.at(-1).snapshot_id;
  return {
    ...asset,
    recipe_snapshots: snapshots,
    active_recipe_snapshot_id: activeId,
  };
}

export function appendRecipeSnapshot(previous = {}, next = {}, options = {}) {
  const current = previous.id || Array.isArray(previous.recipe_snapshots)
    ? ensureRecipeSnapshots(previous)
    : { recipe_snapshots: [] };
  const snapshot = buildRecipeSnapshot(next, options);
  const snapshots = [...current.recipe_snapshots];
  const existing = snapshots.findIndex((item) => item.recipe_digest === snapshot.recipe_digest);
  if (existing < 0) snapshots.push(snapshot);
  else snapshots[existing] = refreshReferenceRights(snapshots[existing], snapshot);
  const active = snapshots.find((item) => item.recipe_digest === snapshot.recipe_digest) || snapshots.at(-1);
  return {
    ...next,
    recipe_snapshots: snapshots,
    active_recipe_snapshot_id: active.snapshot_id,
  };
}

export function recipeHistory(asset = {}) {
  const normalized = ensureRecipeSnapshots(asset);
  return {
    project_id: normalized.project_id,
    asset_id: normalized.id,
    active_snapshot_id: normalized.active_recipe_snapshot_id,
    snapshots: normalized.recipe_snapshots,
  };
}

/**
 * Normalise a stored snapshot's reference list on read.
 *
 * Exported for the SQLite store, which returns snapshot rows directly rather
 * than routing them through `ensureRecipeSnapshots`. Both stores must present
 * the same reference shape.
 */
export function normalizeSnapshotReferences(value) {
  return normalizeReferences(value);
}

export function recipeMaterial(asset = {}) {
  const source = isObject(asset.source) ? asset.source : {};
  const business = isObject(asset.business_fields) ? asset.business_fields : {};
  return {
    effective_prompt: cleanText(asset.prompt),
    user_prompt: cleanText(asset.user_prompt || source.user_prompt || source.user_message || business.user_prompt || business.user_message),
    negative_prompt: cleanText(asset.negative_prompt || business.negative_prompt),
    prompt_status: cleanText(source.prompt_status || business.prompt_status || (asset.prompt ? "manual" : "not-available")),
    generation_tool: cleanText(source.generation_tool || business.generation_tool),
    model: cleanText(source.model || business.model),
    provider: cleanText(source.provider || business.provider),
    skill: cleanText(asset.skill),
    style: cleanText(asset.style),
    ratio: cleanText(asset.ratio),
    theme: cleanText(asset.theme),
    references: normalizeReferences(asset.references || business.references || source.references),
    provenance: {
      source_type: cleanText(source.type || asset.sourceType || "local-file"),
      task_id: cleanText(source.codex_task_id || source.task_id),
      session_id: cleanText(source.codex_session_id || source.grok_session_id || source.conversation_id),
      generation_call_id: cleanText(source.codex_image_generation_call_id || source.call_id || source.message_id),
    },
  };
}

function normalizeExistingSnapshots(value, asset) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const snapshots = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const normalized = {
      ...item,
      snapshot_id: cleanText(item.snapshot_id),
      schema_version: cleanText(item.schema_version || RECIPE_SNAPSHOT_SCHEMA_VERSION),
      project_id: cleanText(item.project_id || asset.project_id || "default"),
      asset_id: cleanText(item.asset_id || asset.id),
      recipe_digest: cleanText(item.recipe_digest),
      prompt_digest: cleanText(item.prompt_digest),
      effective_prompt: cleanText(item.effective_prompt),
      user_prompt: cleanText(item.user_prompt),
      negative_prompt: cleanText(item.negative_prompt),
      prompt_status: cleanText(item.prompt_status),
      generation_tool: cleanText(item.generation_tool),
      model: cleanText(item.model),
      provider: cleanText(item.provider),
      skill: cleanText(item.skill),
      style: cleanText(item.style),
      ratio: cleanText(item.ratio),
      theme: cleanText(item.theme),
      references: normalizeReferences(item.references),
      provenance: normalizeProvenance(item.provenance),
      change_summary: cleanText(item.change_summary),
      created_at: cleanText(item.created_at || asset.created_at),
    };
    if (!normalized.recipe_digest) normalized.recipe_digest = sha256(stableStringify(digestMaterial(snapshotMaterial(normalized))));
    if (!normalized.snapshot_id) normalized.snapshot_id = `recipe-${normalized.recipe_digest.slice(0, 24)}`;
    if (!normalized.prompt_digest) normalized.prompt_digest = sha256(normalized.effective_prompt);
    if (seen.has(normalized.snapshot_id)) continue;
    seen.add(normalized.snapshot_id);
    snapshots.push(normalized);
  }
  return snapshots.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at))
    || String(left.snapshot_id).localeCompare(String(right.snapshot_id)));
}

function snapshotMaterial(snapshot) {
  return {
    effective_prompt: snapshot.effective_prompt,
    user_prompt: snapshot.user_prompt,
    negative_prompt: snapshot.negative_prompt,
    prompt_status: snapshot.prompt_status,
    generation_tool: snapshot.generation_tool,
    model: snapshot.model,
    provider: snapshot.provider,
    skill: snapshot.skill,
    style: snapshot.style,
    ratio: snapshot.ratio,
    theme: snapshot.theme,
    references: snapshot.references,
    provenance: snapshot.provenance,
  };
}

function normalizeReferences(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((item) => {
    if (typeof item === "string") {
      return withRights({ asset_id: cleanText(item), sha256: "", role: "", scope: [], applied: true }, {});
    }
    if (!isObject(item)) return null;
    return withRights({
      asset_id: cleanText(item.asset_id || item.assetId || item.id || item.reference_id),
      sha256: cleanText(item.sha256 || item.content_sha256 || item.digest),
      role: cleanText(item.role || item.purpose || item.use),
      scope: Array.isArray(item.scope || item.applies_to)
        ? [...new Set((item.scope || item.applies_to).map(cleanText).filter(Boolean))]
        : [],
      applied: item.applied !== false,
    }, item);
  }).filter(Boolean).sort((left, right) =>
    stableStringify(referenceDigestMaterial(left)).localeCompare(stableStringify(referenceDigestMaterial(right))));
}

/**
 * Attach permitted-use and rights declarations to a normalized reference.
 *
 * A reference that declares nothing still carries the fields, all unknown, so
 * that "nobody has recorded this yet" is visible in the record rather than
 * absent from it.
 */
function withRights(base, source) {
  return {
    ...base,
    allowed_uses: normalizeUseList(source.allowed_uses),
    forbidden_uses: normalizeUseList(source.forbidden_uses),
    // No gate on which rights keys are present: `normalizeReferenceRights`
    // already yields exactly the defaults when nothing is declared. An earlier
    // gate keyed on `rights`/`consent` silently dropped a flat `redistribution`
    // or `copyright` declaration while honouring the same shape whenever an
    // unrelated `consent` key happened to be there too.
    rights: normalizeReferenceRights(source.rights ?? source),
  };
}

/**
 * The part of a reference that identifies the generation recipe.
 *
 * Rights and permitted-use declarations are excluded on purpose. They describe
 * a reference rather than the generation it fed, so recording copyright or
 * portrait consent for an already-archived asset must not change its
 * `recipe_digest` or append a snapshot. This mirrors the existing rule that
 * rating, group, category, favorite, and archive changes never rewrite recipe
 * history. The sort order above uses this same shape so that enriching a
 * reference cannot silently reorder the list and change the digest that way.
 */
function referenceDigestMaterial(reference) {
  return {
    asset_id: reference.asset_id,
    sha256: reference.sha256,
    role: reference.role,
    scope: reference.scope,
    applied: reference.applied,
  };
}

function digestMaterial(material) {
  return { ...material, references: (material.references || []).map(referenceDigestMaterial) };
}

/**
 * Carry newly recorded rights onto an existing snapshot with the same recipe.
 *
 * Rights are the one mutable part of a snapshot, and only because they are
 * excluded from the digest: refreshing them provably cannot change the recipe
 * the snapshot froze. Without this, recording consent for an already-archived
 * asset would be discarded by digest deduplication — the annotation would
 * append no snapshot, and the stored snapshot would keep its original unknown
 * values, so the whole workflow this module exists for would be write-only.
 *
 * References are matched by digest identity, not by position, because the
 * canonical reference list is sorted.
 */
function refreshReferenceRights(stored, incoming) {
  const byIdentity = new Map(
    (incoming.references || []).map((reference) => [stableStringify(referenceDigestMaterial(reference)), reference]),
  );
  return {
    ...stored,
    references: (stored.references || []).map((reference) => {
      const match = byIdentity.get(stableStringify(referenceDigestMaterial(reference)));
      if (!match) return reference;
      return {
        ...reference,
        allowed_uses: match.allowed_uses,
        forbidden_uses: match.forbidden_uses,
        rights: match.rights,
      };
    }),
  };
}

function normalizeProvenance(value) {
  const source = isObject(value) ? value : {};
  return {
    source_type: cleanText(source.source_type),
    task_id: cleanText(source.task_id),
    session_id: cleanText(source.session_id),
    generation_call_id: cleanText(source.generation_call_id),
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function cleanText(value) {
  return String(value || "").trim();
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
