function scalar(value) {
  return String(value ?? "").trim();
}

function tags(value) {
  return (Array.isArray(value) ? value : []).map((tag) => scalar(tag)).filter(Boolean).join(", ");
}

export function versionComparisonFields(left = {}, right = {}) {
  const definitions = [
    ["prompt", scalar(left.prompt), scalar(right.prompt)],
    ["style", scalar(left.style), scalar(right.style)],
    ["theme", scalar(left.theme), scalar(right.theme)],
    ["ratio", scalar(left.ratio), scalar(right.ratio)],
    ["group", scalar(left.group), scalar(right.group)],
    ["category", scalar(left.category), scalar(right.category)],
    ["tags", tags(left.tags), tags(right.tags)],
    ["version_change", scalar(left.version_change), scalar(right.version_change)],
  ];
  return definitions.map(([key, before, after]) => ({ key, before, after, changed: before !== after }));
}

export function selectVersionComparisonPair(history, selectedId, baseId = "", targetId = "") {
  const versions = Array.isArray(history?.versions) ? history.versions : [];
  if (versions.length < 2) return null;
  const byId = new Map(versions.map((version) => [String(version.id || ""), version]));
  const target = byId.get(String(targetId || selectedId || "")) || versions.at(-1);
  let base = byId.get(String(baseId || "")) || null;
  if (!base || base.id === target.id) base = byId.get(String(target.parent_asset_id || "")) || null;
  if (!base || base.id === target.id) {
    const targetIndex = versions.findIndex((version) => version.id === target.id);
    base = versions[targetIndex > 0 ? targetIndex - 1 : 1] || versions[0];
  }
  if (base.id === target.id) return null;
  return { base, target, fields: versionComparisonFields(base, target) };
}
