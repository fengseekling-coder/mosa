/**
 * Generation message binding. Three concerns share this module:
 *
 * 1. Schema: `generation_events.turn_index` (the turn a generation belongs to
 *    inside its ChatGPT conversation) and the `generation_conversations` table
 *    (how many turns a conversation had when the capture plugin last saw it).
 *    Both are written only through the binding API, never from captures.
 * 2. Message backfill: a generation event with no message id can adopt the one
 *    its output asset recorded in `source_json` when the two agree on the
 *    conversation — same capture, same message. Runs at write time
 *    (`recordGenerationEvent`) and once per library at open, after the
 *    repair-capture-history pass so enrichment always works on the
 *    post-repair set of events.
 * 3. `POST /api/generation-message-bindings`: the capture plugin reads a
 *    conversation's structure (file id → message id, turn index) while the
 *    user has it open and pushes the mapping here. Only ids and numbers cross
 *    this boundary — never conversation text. One batch is one read of the
 *    conversation: every write in it shares the batch's synced_at, turn
 *    numbers always follow the latest read (a record bound by an earlier
 *    batch keeps its number but its stale watermark shows), and message ids
 *    keep the conservative fill-only-when-empty-or-equal rule.
 *
 * "Unidentified duplicate" events (all four provider identifiers empty while
 * an identified sibling exists for the same output asset — the rows the
 * capture-history repair deletes or keeps only because a relation references
 * them) are never backfilled and never matched by the binding API.
 *
 * Writes prefer staying silent over writing a wrong message id; turn numbers
 * are exempt by design — they are a snapshot of the latest read, not an
 * assertion to arbitrate.
 */

export const GENERATION_MESSAGE_BACKFILL_MARKER_KEY = "generation_message_backfill_v1";
export const MAX_GENERATION_MESSAGE_BINDINGS = 2000;

/**
 * Idempotent schema for the binding feature. Runs next to the other ensure*
 * helpers on every open so a library written by an older build upgrades in
 * place; neither the column nor the table carries data that a downgrade could
 * lose (both are derived from the capture plugin's page reads).
 */
export function ensureGenerationMessageBindingSchema(database) {
  const columns = new Set(database.prepare("SELECT name FROM pragma_table_info('generation_events')").all().map((row) => row.name));
  if (!columns.has("turn_index")) {
    database.exec("ALTER TABLE generation_events ADD COLUMN turn_index INTEGER");
  }
  // Watermark for the turn snapshot: which binding batch wrote this row's
  // turn_index. The interface only trusts a turn whose watermark matches the
  // conversation's latest synced_at — a record bound by an earlier batch (the
  // user has since edited or deleted messages, so the conversation moved on)
  // keeps its number but reads as stale.
  if (!columns.has("turn_synced_at")) {
    database.exec("ALTER TABLE generation_events ADD COLUMN turn_synced_at TEXT");
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS generation_conversations (
      project_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      turn_count INTEGER NOT NULL,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (project_id, provider, conversation_id)
    );
  `);
}

/**
 * Write-time supplement for `recordGenerationEvent`: fill an empty event
 * message id from the output asset's own capture record. The event id is
 * already derived at this point and stays untouched — an event recorded
 * without a message keeps that id after the message is filled in.
 */
export function supplementGenerationEventMessageId(database, event, assetRow) {
  if (event.message_id || !event.conversation_id) return event;
  if (String(event.provider || "") !== "chatgpt") return event;
  const message = messageIdFromAssetSource(assetRow, event.conversation_id);
  if (!message) return event;
  if (isUnidentifiedDuplicateEvent(database, event)) return event;
  return { ...event, message_id: message };
}

function messageIdFromAssetSource(assetRow, conversationId) {
  let source;
  try {
    source = JSON.parse(assetRow?.source_json || "{}");
  } catch {
    return "";
  }
  if (!source || typeof source !== "object") return "";
  const message = String(source.message_id || "").trim();
  if (!message) return "";
  const sourceConversation = String(source.conversation_id || "").trim();
  if (sourceConversation && sourceConversation === conversationId) return message;
  const columnConversation = String(assetRow?.conversation_id || "").trim();
  if (columnConversation && columnConversation === conversationId) return message;
  return "";
}

/**
 * The repair-capture-history definition: all four provider identifiers empty
 * while the same output asset has an identified event. `message_id` is empty
 * on every caller's precondition, and an all-empty row can never be its own
 * identified sibling, so no id guard is needed in SQL — same shape as the
 * repair SQL. The write-time check below excludes the event's own id: a row
 * recorded earlier for this same event (possibly already supplemented) is
 * the event itself, not a duplicate sibling.
 */
function isUnidentifiedDuplicateEvent(database, event) {
  if (event.provider_generation_call_id || event.capture_context_id || event.provider_asset_id) return false;
  const sibling = database.prepare(`
    SELECT 1 FROM generation_events
    WHERE project_id = ? AND output_asset_id = ? AND id != ?
      AND (provider_generation_call_id != '' OR capture_context_id != ''
        OR message_id != '' OR provider_asset_id != '')
    LIMIT 1
  `).get(event.project_id, event.output_asset_id, event.id);
  return Boolean(sibling);
}

// Excluded rows: all four identifiers empty AND an identified sibling exists
// for the same output asset. Rows kept alive only by a generation relation
// (the repair pass spares them) land here too and stay untouched.
const NOT_UNIDENTIFIED_DUPLICATE_SQL = `
  NOT (
    generation_events.provider_generation_call_id = ''
    AND generation_events.capture_context_id = ''
    AND generation_events.message_id = ''
    AND generation_events.provider_asset_id = ''
    AND EXISTS (
      SELECT 1 FROM generation_events identified
      WHERE identified.project_id = generation_events.project_id
        AND identified.output_asset_id = generation_events.output_asset_id
        AND (identified.provider_generation_call_id != '' OR identified.capture_context_id != ''
          OR identified.message_id != '' OR identified.provider_asset_id != '')
    )
  )
`;

/**
 * One-time backfill of message ids from output assets, gated by the
 * `generation_message_backfill_v1` marker. Must run after
 * `repairCaptureHistory` so duplicates it deletes are never filled in (a
 * filled row would look identified and survive the repair on the next open).
 * Single transaction: data and marker commit together or not at all.
 */
export function backfillGenerationMessageIdsFromAssets(database, helpers = {}) {
  const { commitLibraryChanges } = helpers;
  const alreadyDone = database.prepare("SELECT value FROM library_meta WHERE key = ?").get(GENERATION_MESSAGE_BACKFILL_MARKER_KEY);
  const stats = { eventsUpdated: 0 };
  if (alreadyDone) return stats;

  // BEGIN IMMEDIATE, not the default deferred transaction: the read snapshot
  // must not upgrade to a write mid-transaction. In WAL mode that upgrade
  // returns SQLITE_BUSY (BUSY_SNAPSHOT) immediately — busy_timeout never
  // applies — whenever another process (MCP/CLI on the same library) commits
  // between the candidate scan and the first UPDATE. Same rationale as the
  // derivative claim/complete transactions.
  database.transaction(() => {
    const candidates = database.prepare(`
      SELECT project_id, id, output_asset_id, conversation_id
      FROM generation_events
      WHERE provider = 'chatgpt'
        AND message_id = ''
        AND conversation_id != ''
        AND ${NOT_UNIDENTIFIED_DUPLICATE_SQL}
    `).all();
    const assetSource = database.prepare("SELECT source_json, conversation_id FROM assets WHERE project_id = ? AND id = ?");
    const updateMessage = database.prepare("UPDATE generation_events SET message_id = ? WHERE project_id = ? AND id = ? AND message_id = ''");
    const perProject = new Map();
    for (const candidate of candidates) {
      const asset = assetSource.get(candidate.project_id, candidate.output_asset_id);
      const message = messageIdFromAssetSource(asset, candidate.conversation_id);
      if (!message) continue;
      if (!updateMessage.run(message, candidate.project_id, candidate.id).changes) continue;
      stats.eventsUpdated += 1;
      perProject.set(candidate.project_id, (perProject.get(candidate.project_id) || 0) + 1);
    }
    if (stats.eventsUpdated) {
      commitLibraryChanges?.([...perProject].map(([projectId, eventsUpdated]) => ({
        projectId,
        kind: "library-backfilled",
        entityType: "generation",
        entityId: "",
        assetIds: [],
        detail: { reason: "generation-message-backfill-v1", eventsUpdated },
      })));
    }
    const timestamp = new Date().toISOString();
    database.prepare(`
      INSERT INTO library_meta (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(GENERATION_MESSAGE_BACKFILL_MARKER_KEY, timestamp, timestamp);
  }).immediate();

  if (stats.eventsUpdated > 0) {
    // stderr, not stdout: the MCP server and CLI speak JSON on stdout.
    console.warn(`[MOSA] generation_message_backfill_v1: filled message ids on ${stats.eventsUpdated} generation event(s) from their output assets.`);
  }
  return stats;
}

/**
 * Validate one `POST /api/generation-message-bindings` body. Throws a 400
 * with an `expose` flag on the first problem; nothing is written for an
 * invalid batch. Only the documented keys are read — anything else in a
 * binding (including free text the plugin might attach by mistake) is
 * ignored and never stored.
 */
export function parseGenerationMessageBindingsPayload(payload = {}) {
  const provider = typeof payload.provider === "string" ? payload.provider.trim() : "";
  if (provider !== "chatgpt") {
    throw generationMessageBindingError('provider must be "chatgpt".');
  }
  const conversationId = typeof payload.conversation_id === "string" ? payload.conversation_id.trim() : "";
  if (!conversationId) {
    throw generationMessageBindingError("conversation_id is required.");
  }
  const turnCount = payload.turn_count;
  if (!Number.isInteger(turnCount) || turnCount < 1) {
    throw generationMessageBindingError("turn_count must be an integer >= 1.");
  }
  const rawBindings = payload.bindings == null ? [] : payload.bindings;
  if (!Array.isArray(rawBindings)) {
    throw generationMessageBindingError("bindings must be an array.");
  }
  if (rawBindings.length > MAX_GENERATION_MESSAGE_BINDINGS) {
    throw generationMessageBindingError(`bindings must contain at most ${MAX_GENERATION_MESSAGE_BINDINGS} entries.`);
  }
  const bindings = rawBindings.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw generationMessageBindingError(`bindings[${index}] must be an object.`);
    }
    const providerAssetId = typeof entry.provider_asset_id === "string" ? entry.provider_asset_id.trim() : "";
    if (!providerAssetId) {
      throw generationMessageBindingError(`bindings[${index}].provider_asset_id is required.`);
    }
    let messageId = "";
    if (entry.message_id != null) {
      if (typeof entry.message_id !== "string") {
        throw generationMessageBindingError(`bindings[${index}].message_id must be a string.`);
      }
      messageId = entry.message_id.trim();
    }
    let turnIndex = null;
    if (entry.turn_index != null) {
      if (!Number.isInteger(entry.turn_index) || entry.turn_index < 1) {
        throw generationMessageBindingError(`bindings[${index}].turn_index must be an integer >= 1.`);
      }
      if (entry.turn_index > turnCount) {
        throw generationMessageBindingError(`bindings[${index}].turn_index must be <= turn_count.`);
      }
      turnIndex = entry.turn_index;
    }
    return { provider_asset_id: providerAssetId, message_id: messageId, turn_index: turnIndex };
  });
  return { provider, conversationId, turnCount, bindings };
}

function generationMessageBindingError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = "GENERATION_MESSAGE_BINDINGS_INVALID";
  error.expose = true;
  return error;
}

const BINDING_MATCH_SQL = `
  SELECT * FROM generation_events
  WHERE project_id = @projectId
    AND provider = @provider
    AND conversation_id = @conversationId
    AND (
      generation_events.provider_asset_id = @providerAssetId
      OR EXISTS (
        SELECT 1 FROM assets
        WHERE assets.project_id = generation_events.project_id
          AND assets.id = generation_events.output_asset_id
          AND assets.provider_asset_id = @providerAssetId
      )
    )
    AND ${NOT_UNIDENTIFIED_DUPLICATE_SQL}
  ORDER BY created_at, id
`;

/**
 * Apply one validated batch. Every write in the batch carries one shared
 * `syncedAt` timestamp — the batch is one read of the conversation, and the
 * numbers it writes are a snapshot of what that read saw.
 *
 * Turn numbers are snapshot data and always follow the latest read: a matched
 * record's turn_index is overwritten with the batch value and its
 * turn_synced_at moves to this batch, even when the number itself is
 * unchanged (the watermark is what tells the interface "this number belongs
 * to the current snapshot"). Records bound by an earlier batch that this
 * batch does not mention are left alone — their stale watermark marks them.
 *
 * Message ids keep the conservative rule: an empty record is filled, an
 * identical value is left alone, and a disagreement changes nothing on the
 * message but is reported as a conflict — without blocking the turn write
 * (captured message ids are not uniform enough to be trusted over the turn).
 *
 * Counts are disjoint per binding: matched = updated + unchanged + conflicts,
 * and matched + unmatched is the number of deduplicated entries (exact repeats
 * and the extra entries of a repeated ambiguous file are not counted again).
 * `updated` means at least
 * one of turn_index/turn_synced_at/message_id actually changed; `unchanged`
 * means nothing was written; `conflicts` means the entry was skipped whole
 * (the same file appeared twice with different values) or its message
 * disagreed. The conversation's turn_count is refreshed unconditionally — a
 * smaller value is legitimate (the user deleted messages) and never a
 * conflict.
 */
export function applyGenerationMessageBindings(database, payload, helpers = {}) {
  const { projectId, commitLibraryChanges } = helpers;
  const { provider, conversationId, turnCount, bindings } = parseGenerationMessageBindingsPayload(payload);
  const syncedAt = new Date().toISOString();
  const { ambiguousFiles, ambiguousRepresentative, duplicateIndexes } = classifyInBatchEntries(bindings);

  const matchRecords = database.prepare(BINDING_MATCH_SQL);
  const writeMessage = database.prepare("UPDATE generation_events SET message_id = ? WHERE project_id = ? AND id = ?");
  const writeTurn = database.prepare("UPDATE generation_events SET turn_index = ?, turn_synced_at = ? WHERE project_id = ? AND id = ?");
  const upsertConversation = database.prepare(`
    INSERT INTO generation_conversations (project_id, provider, conversation_id, turn_count, synced_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id, provider, conversation_id) DO UPDATE SET
      turn_count = excluded.turn_count,
      synced_at = excluded.synced_at
  `);

  const counts = { matched: 0, updated: 0, unchanged: 0, conflicts: 0, unmatched: 0 };
  // BEGIN IMMEDIATE, not the default deferred transaction: same reason as the
  // backfill above — the per-entry reads must not upgrade to writes
  // mid-transaction, which in WAL mode fails immediately with SQLITE_BUSY
  // (BUSY_SNAPSHOT) when another process commits in between.
  database.transaction(() => {
    const affectedAssetIds = new Set();
    bindings.forEach((binding, index) => {
      if (duplicateIndexes.has(index)) return;
      if (ambiguousFiles.has(binding.provider_asset_id)) {
        // The file's ownership is unclear, so nothing from its entries is
        // written; the ambiguity itself is reported once per file.
        if (ambiguousRepresentative.get(binding.provider_asset_id) === index) {
          counts.matched += 1;
          counts.conflicts += 1;
        }
        return;
      }
      const records = matchRecords.all({
        projectId,
        provider,
        conversationId,
        providerAssetId: binding.provider_asset_id,
      });
      if (!records.length) {
        counts.unmatched += 1;
        return;
      }
      counts.matched += 1;
      let changed = false;
      let messageConflict = false;
      for (const record of records) {
        affectedAssetIds.add(record.output_asset_id);
        if (binding.message_id) {
          if (!record.message_id) {
            writeMessage.run(binding.message_id, projectId, record.id);
            changed = true;
          } else if (record.message_id !== binding.message_id) {
            messageConflict = true;
          }
        }
        if (binding.turn_index != null) {
          if (Number(record.turn_index) !== binding.turn_index || record.turn_synced_at !== syncedAt) changed = true;
          writeTurn.run(binding.turn_index, syncedAt, projectId, record.id);
        }
      }
      if (messageConflict) {
        counts.conflicts += 1;
        return;
      }
      if (changed) counts.updated += 1;
      else counts.unchanged += 1;
    });
    upsertConversation.run(projectId, provider, conversationId, turnCount, syncedAt);
    // One announcement per batch; the inspector refreshes the affected
    // assets' generation data through the same channel as generation writes.
    commitLibraryChanges?.([{
      projectId,
      kind: "generation-updated",
      entityType: "generation",
      entityId: conversationId,
      assetIds: [...affectedAssetIds],
      detail: { reason: "generation-message-bindings", conversation_id: conversationId, synced_at: syncedAt, ...counts },
    }]);
  }).immediate();
  return counts;
}

/**
 * Classify repeated files within one batch. A file whose entries disagree on
 * message_id or turn_index is ambiguous — the page data contradicts itself,
 * so none of its entries may write (reported once, under the first entry's
 * position). Entries that repeat the same values exactly are processed once.
 */
function classifyInBatchEntries(bindings) {
  const indexesByFile = new Map();
  bindings.forEach((binding, index) => {
    const list = indexesByFile.get(binding.provider_asset_id);
    if (list) list.push(index);
    else indexesByFile.set(binding.provider_asset_id, [index]);
  });
  const ambiguousFiles = new Set();
  const ambiguousRepresentative = new Map();
  const duplicateIndexes = new Set();
  for (const [file, indexes] of indexesByFile) {
    if (indexes.length < 2) continue;
    const first = bindings[indexes[0]];
    const identical = indexes.every((index) => (
      bindings[index].message_id === first.message_id && bindings[index].turn_index === first.turn_index
    ));
    if (identical) {
      for (let position = 1; position < indexes.length; position += 1) duplicateIndexes.add(indexes[position]);
    } else {
      ambiguousFiles.add(file);
      ambiguousRepresentative.set(file, indexes[0]);
    }
  }
  return { ambiguousFiles, ambiguousRepresentative, duplicateIndexes };
}
