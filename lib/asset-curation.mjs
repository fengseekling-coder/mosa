export const CURATION_NOTE_MAX_LENGTH = 4000;

export function normalizeAssetCuration(input = {}) {
  return {
    curated: input.curated === true,
    curation_note: String(input.curation_note ?? input.note ?? "").trim().slice(0, CURATION_NOTE_MAX_LENGTH),
  };
}
