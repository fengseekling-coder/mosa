export const MOSA_PROVENANCE_BUNDLE_SCHEMA = "mosa.provenance.bundle/1";
export const MOSA_C2PA_ASSERTION_LABEL = "com.azhuilab.mosa.provenance";

export async function buildAssetProvenanceBundle(store, projectId, assetId, { includePrompts = true } = {}) {
  if (!store || typeof store.getAsset !== "function") throw new Error("Provenance export requires an asset store.");
  const project = String(projectId || "default");
  const asset = await store.getAsset(project, assetId);
  const [recipes, generationHistory] = await Promise.all([
    typeof store.getRecipeSnapshotHistory === "function"
      ? store.getRecipeSnapshotHistory(project, assetId)
      : Promise.resolve(null),
    typeof store.getAssetGenerationHistory === "function"
      ? store.getAssetGenerationHistory(project, assetId)
      : fallbackGenerationHistory(store, project, assetId),
  ]);

  const bundle = {
    schema: MOSA_PROVENANCE_BUNDLE_SCHEMA,
    exported_at: new Date().toISOString(),
    project_id: project,
    asset: sanitizeAsset(asset, includePrompts),
    recipe_history: sanitizeValue(recipes, { includePrompts }),
    generation_history: sanitizeValue(generationHistory, { includePrompts }),
  };
  return {
    bundle,
    c2pa_assertion: {
      label: MOSA_C2PA_ASSERTION_LABEL,
      schema: "mosa.c2pa.assertion/1",
      data: bundle,
      signed: false,
      note: "Assertion payload only. A C2PA SDK/signer must bind and sign it before it becomes a Content Credential.",
    },
  };
}

async function fallbackGenerationHistory(store, projectId, assetId) {
  const events = typeof store.listGenerationEvents === "function"
    ? await store.listGenerationEvents(projectId, { assetId })
    : [];
  return { asset_id: assetId, generation_ids: events.map((event) => event.id), events, relations: [] };
}

function sanitizeAsset(asset, includePrompts) {
  const source = sanitizeValue(asset?.source || {}, { includePrompts });
  return {
    id: asset?.id || "",
    file_name: asset?.asset || "",
    content_sha256: asset?.content_sha256 || "",
    pixel_sha256: asset?.pixel_sha256 || "",
    created_at: asset?.created_at || "",
    updated_at: asset?.updated_at || "",
    source_type: asset?.source_type || asset?.sourceType || asset?.source?.type || "",
    source,
    ...(includePrompts ? {
      prompt: asset?.prompt || "",
      recipe_snapshots: sanitizeValue(asset?.recipe_snapshots || [], { includePrompts }),
    } : {}),
  };
}

function sanitizeValue(value, { includePrompts }) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, { includePrompts }));
  if (typeof value !== "object") return String(value);
  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const normalized = childKey.toLowerCase();
    if (/token|secret|authorization|cookie|password|private[_-]?key|sign[_-]?cert|api[_-]?key|access[_-]?key|credential/.test(normalized)) continue;
    if (/(^|_)(path|url|uri)$/.test(normalized) || normalized.endsWith("_path") || normalized.endsWith("_url")) continue;
    if (!includePrompts && /prompt/.test(normalized)) continue;
    output[childKey] = sanitizeValue(childValue, { includePrompts });
  }
  return output;
}
