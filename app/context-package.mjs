const PACKAGE_SCHEMA = "mosa.context-package/1";

function text(value) {
  return String(value ?? "").trim();
}

function list(value) {
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function activeRecipeSnapshot(asset, recipeHistory) {
  const snapshots = Array.isArray(recipeHistory?.snapshots)
    ? recipeHistory.snapshots
    : Array.isArray(asset?.recipe_snapshots)
      ? asset.recipe_snapshots
      : [];
  if (!snapshots.length) return null;
  const activeId = text(recipeHistory?.active_snapshot_id || asset?.active_recipe_snapshot_id);
  return snapshots.find((snapshot) => text(snapshot?.snapshot_id) === activeId) || snapshots.at(-1) || null;
}

function allowlistedProvenance(asset, recipe) {
  const source = asset?.source && typeof asset.source === "object" ? asset.source : {};
  const provenance = recipe?.provenance && typeof recipe.provenance === "object" ? recipe.provenance : {};
  return {
    source_type: text(provenance.source_type || source.type || asset?.source_type),
    provider: text(recipe?.provider || source.provider),
    generation_tool: text(recipe?.generation_tool || source.generation_tool),
    model: text(recipe?.model || source.model),
    conversation_id: text(source.conversation_id),
    message_id: text(source.message_id),
    task_id: text(provenance.task_id || source.task_id || source.codex_task_id),
    session_id: text(provenance.session_id || source.codex_session_id || source.grok_session_id),
    capture_context_id: text(provenance.capture_context_id || source.capture_context_id),
    provider_tool_call_id: text(provenance.provider_tool_call_id || source.provider_tool_call_id),
    provider_generation_call_id: text(provenance.provider_generation_call_id || source.provider_generation_call_id),
    provider_response_id: text(provenance.provider_response_id || source.provider_response_id),
    provider_asset_id: text(provenance.provider_asset_id || source.provider_asset_id),
    verification_level: text(provenance.verification_level || source.verification_level || "observed"),
  };
}

function allowlistedReferences(recipe) {
  const references = Array.isArray(recipe?.references) ? recipe.references : [];
  return references.slice(0, 100).map((reference) => ({
    asset_id: text(reference?.asset_id),
    reference_id: text(reference?.reference_id),
    sha256: text(reference?.sha256),
    attachment_url: text(reference?.attachment_url),
    mime_type: text(reference?.mime_type),
    width: positiveNumber(reference?.width),
    height: positiveNumber(reference?.height),
    role: text(reference?.role),
    scope: list(reference?.scope),
    applied: reference?.applied !== false,
    allowed_uses: list(reference?.allowed_uses),
    forbidden_uses: list(reference?.forbidden_uses),
    rights: {
      copyright: text(reference?.rights?.copyright),
      portrait_consent: text(reference?.rights?.portrait_consent),
      redistribution: text(reference?.rights?.redistribution),
      attribution: text(reference?.rights?.attribution),
    },
  }));
}

function versionSummary(version) {
  return {
    id: text(version?.id),
    version_index: positiveNumber(version?.version_index),
    parent_asset_id: text(version?.parent_asset_id),
    version_change: text(version?.version_change),
    created_at: text(version?.created_at),
  };
}

function generationSummaries(generationHistory) {
  const events = Array.isArray(generationHistory?.events) ? generationHistory.events : [];
  return events.slice(0, 100).map((event) => ({
    id: text(event?.id),
    provider: text(event?.provider),
    model: text(event?.model),
    capture_channel: text(event?.capture_channel),
    verification_level: text(event?.verification_level || "observed"),
    provider_tool_call_id: text(event?.provider_tool_call_id),
    provider_generation_call_id: text(event?.provider_generation_call_id),
    provider_response_id: text(event?.provider_response_id),
    provider_asset_id: text(event?.provider_asset_id),
    created_at: text(event?.created_at),
  }));
}

export function buildContextPackage(asset = {}, options = {}) {
  const recipe = activeRecipeSnapshot(asset, options.recipeHistory);
  const prompt = {
    effective_prompt: text(recipe?.effective_prompt || asset.prompt),
    user_prompt: text(recipe?.user_prompt || asset.user_prompt || asset.source?.user_message),
    negative_prompt: text(recipe?.negative_prompt || asset.negative_prompt),
    prompt_status: text(recipe?.prompt_status || asset.source?.prompt_status || (asset.prompt ? "available" : "not-available")),
  };
  const versions = Array.isArray(options.versionHistory?.versions) ? options.versionHistory.versions : [];
  const currentVersion = versions.find((version) => text(version?.id) === text(asset.id)) || asset;
  return {
    schema: PACKAGE_SCHEMA,
    generated_at: text(options.generatedAt || new Date().toISOString()),
    asset: {
      project_id: text(asset.project_id || asset.projectId || "default"),
      id: text(asset.id),
      file_name: text(asset.asset),
      image_path: text(asset.image_path),
      media_kind: text(asset.media_kind || asset.source?.media_kind || asset.business_fields?.media_kind),
      created_at: text(asset.created_at),
      curated: asset.curated === true,
      curation_note: text(asset.curation_note),
    },
    prompt,
    recipe: recipe ? {
      snapshot_id: text(recipe.snapshot_id),
      recipe_digest: text(recipe.recipe_digest),
      prompt_digest: text(recipe.prompt_digest),
      generation_tool: text(recipe.generation_tool),
      model: text(recipe.model),
      provider: text(recipe.provider),
      skill: text(recipe.skill),
      style: text(recipe.style),
      ratio: text(recipe.ratio),
      theme: text(recipe.theme),
      change_summary: text(recipe.change_summary),
      created_at: text(recipe.created_at),
    } : null,
    references: allowlistedReferences(recipe),
    provenance: allowlistedProvenance(asset, recipe),
    version: versionSummary(currentVersion),
    version_family: versions.slice(0, 250).map(versionSummary),
    generation_events: generationSummaries(options.generationHistory),
  };
}

export function contextPackageText(pkg = {}) {
  const lines = [
    "MOSA reuse context",
    "Use only the facts below. Missing or empty fields are unknown; do not infer them.",
    "",
    `Asset path: ${text(pkg.asset?.image_path) || "<not recorded>"}`,
    `Asset id: ${text(pkg.asset?.id) || "<not recorded>"}`,
    `Prompt status: ${text(pkg.prompt?.prompt_status) || "<not recorded>"}`,
    `Effective prompt: ${text(pkg.prompt?.effective_prompt) || "<not available>"}`,
  ];
  if (text(pkg.prompt?.user_prompt)) lines.push(`User instruction: ${text(pkg.prompt.user_prompt)}`);
  if (text(pkg.prompt?.negative_prompt)) lines.push(`Negative prompt: ${text(pkg.prompt.negative_prompt)}`);
  if (text(pkg.asset?.curation_note)) lines.push(`Curation note: ${text(pkg.asset.curation_note)}`);
  if (text(pkg.version?.version_change)) lines.push(`Version change: ${text(pkg.version.version_change)}`);
  if (pkg.recipe) {
    lines.push(`Model: ${text(pkg.recipe.model) || "<not recorded>"}`);
    lines.push(`Provider: ${text(pkg.recipe.provider) || "<not recorded>"}`);
    lines.push(`Style: ${text(pkg.recipe.style) || "<not recorded>"}`);
    lines.push(`Ratio: ${text(pkg.recipe.ratio) || "<not recorded>"}`);
  }
  const references = Array.isArray(pkg.references) ? pkg.references : [];
  if (references.length) {
    lines.push("", "References:");
    for (const [index, reference] of references.entries()) {
      const identity = text(reference.attachment_url || reference.reference_id || reference.asset_id || reference.sha256) || "<unresolved reference>";
      const role = text(reference.role) ? ` (${text(reference.role)})` : "";
      lines.push(`${index + 1}. ${identity}${role}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function contextPackageFileName(asset = {}) {
  const stem = text(asset.asset || asset.id || "asset").replace(/\.[^.]+$/u, "");
  const safe = stem.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80) || "asset";
  return `${safe}-mosa-context.json`;
}
