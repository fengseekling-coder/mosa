/**
 * One-time repair for ChatGPT generation records whose prompt was blanked by
 * the pre-#153 re-observation bug: reopening the conversation overwrote the
 * captured prompt with an empty value. The overwrite fix (#153) only stops new
 * damage; this pass restores what is still recoverable, once per library,
 * gated by the `repair_cleared_capture_prompt_v1` marker in library_meta.
 *
 * Only the determined cases are repaired: the record is the image's ONLY
 * generation record (for a duplicated pair the intact sibling already holds
 * the prompt and the blank duplicate is the other repair's business), and the
 * image itself stores the model caption ("Model caption: …"), which is
 * exactly what the cleared record used to carry. The model is not recoverable
 * and stays blank. Everything else on the record is left untouched.
 *
 * One IMMEDIATE transaction holds the reads, the writes, and the marker so a
 * crash (or a SQLITE_BUSY loss to a concurrent MCP/CLI writer) leaves both
 * the data and the marker untouched; the open-path try/catch turns such a
 * failure into a skipped pass that retries on the next open.
 */

export const CLEARED_PROMPT_REPAIR_MARKER_KEY = "repair_cleared_capture_prompt_v1";

export function repairClearedCapturePrompts(database, helpers = {}) {
  const { commitLibraryChanges } = helpers;
  const markerValue = database.prepare("SELECT value FROM library_meta WHERE key = ?").get(CLEARED_PROMPT_REPAIR_MARKER_KEY);
  const stats = { promptsRestored: 0 };
  if (markerValue) return stats;

  const perProject = new Map();

  // BEGIN IMMEDIATE, not the default deferred transaction: the read snapshot
  // must not upgrade to a write mid-transaction. In WAL mode that upgrade
  // returns SQLITE_BUSY (BUSY_SNAPSHOT) immediately — busy_timeout never
  // applies — whenever another process (MCP/CLI on the same library) commits
  // between the reads and the UPDATE. Same rationale as the other one-time
  // open repairs.
  database.transaction(() => {
    // Re-checked under the write lock: a concurrent opener may have completed
    // this repair between the pre-read above and acquiring the lock.
    if (database.prepare("SELECT value FROM library_meta WHERE key = ?").get(CLEARED_PROMPT_REPAIR_MARKER_KEY)) return;

    const restored = database.prepare(`
      UPDATE generation_events AS event
      SET effective_prompt = asset.prompt,
          prompt_status = 'visible-caption'
      FROM assets AS asset
      WHERE asset.project_id = event.project_id
        AND asset.id = event.output_asset_id
        AND event.provider = 'chatgpt'
        AND event.capture_channel = 'chrome-extension'
        AND json_extract(event.evidence_json, '$.source') = 'web-capture'
        AND (event.effective_prompt IS NULL OR event.effective_prompt = '')
        AND event.prompt_status = 'not-available'
        AND asset.deleted_at IS NULL
        AND asset.source_type = 'web-chatgpt'
        AND TRIM(asset.prompt) != ''
        AND asset.prompt LIKE 'Model caption%'
        AND (
          SELECT COUNT(*) FROM generation_events AS sibling
          WHERE sibling.project_id = event.project_id
            AND sibling.output_asset_id = event.output_asset_id
        ) = 1
      RETURNING project_id
    `).all();
    for (const { project_id: projectId } of restored) {
      perProject.set(projectId, (perProject.get(projectId) || 0) + 1);
      stats.promptsRestored += 1;
    }

    // One full-refresh announcement per affected project, the same shape the
    // captured-history repair uses, so every open window re-reads the
    // generation history it is showing.
    if (perProject.size) {
      commitLibraryChanges([...perProject].map(([projectId, count]) => ({
        projectId,
        kind: "library-repaired",
        entityType: "library",
        entityId: "",
        assetIds: [],
        detail: { reason: "repair-cleared-capture-prompt-v1", promptsRestored: count },
      })));
    }

    database.prepare(`
      INSERT INTO library_meta (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(CLEARED_PROMPT_REPAIR_MARKER_KEY, new Date().toISOString(), new Date().toISOString());
  }).immediate();

  // stderr, not stdout: the MCP server and CLI speak JSON on stdout, so a
  // startup log line there would corrupt the protocol channel. Like the other
  // one-time repairs, fresh libraries and re-openings stay silent.
  if (stats.promptsRestored > 0) {
    console.warn(`[MOSA] repair_cleared_capture_prompt_v1: restored ${stats.promptsRestored} prompt(s).`);
  }
  return stats;
}
