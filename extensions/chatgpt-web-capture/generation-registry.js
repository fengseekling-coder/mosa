(function installMosaGenerationRegistry(globalScope) {
  if (globalScope.MosaGenerationRegistry) return;

  const MAX_ATTEMPTS = 512;
  const MAX_MESSAGE_PROMPTS = 12;
  const MAX_MESSAGE_KEYS = 512;

  function createGenerationRegistry({ imageLookupKeys, promptQuality }) {
    if (typeof imageLookupKeys !== "function") throw new TypeError("imageLookupKeys is required");
    if (typeof promptQuality !== "function") throw new TypeError("promptQuality is required");

    const attempts = new Set();
    const attemptKeyIndex = new Map();
    const outputKeyIndex = new Map();
    const messageIndex = new Map();
    const messagePrompts = new Map();
    let sequence = 0;

    function clean(value) {
      return String(value || "").trim();
    }

    function messageKey(entry) {
      const conversationId = clean(entry?.conversationId || entry?.conversation_id);
      const messageId = clean(entry?.messageId || entry?.message_id);
      if (!messageId) return "";
      return `message:${conversationId}:${messageId}`;
    }

    function imageKeys(entry) {
      return [...new Set(imageLookupKeys(clean(entry?.imageUrl), entry || {}))];
    }

    function isOutputScopedContext(value) {
      const contextId = clean(value);
      return /(?:^|:)asset:[^:]+$/i.test(contextId) || /(?:^|:)output:[^:]+$/i.test(contextId);
    }

    function attemptIdentity(entry) {
      const generationContextId = clean(entry?.generationContextId || entry?.generation_context_id);
      return {
        generationCallId: clean(entry?.providerGenerationCallId || entry?.provider_generation_call_id),
        toolCallId: clean(entry?.providerToolCallId || entry?.provider_tool_call_id),
        generationContextId: isOutputScopedContext(generationContextId) ? "" : generationContextId,
      };
    }

    function attemptKeys(entry) {
      const identity = attemptIdentity(entry);
      const keys = [];
      if (identity.generationCallId) keys.push(`generation-call:${identity.generationCallId}`);
      if (identity.toolCallId) keys.push(`tool-call:${identity.toolCallId}`);
      if (identity.generationContextId) keys.push(`context:${identity.generationContextId}`);
      return keys;
    }

    function normalizePromptScope(entry) {
      const explicit = clean(entry?.promptScope || entry?.prompt_scope).toLowerCase();
      if (["output", "panel"].includes(explicit)) return "output";
      if (["attempt", "shared", "call"].includes(explicit)) return "attempt";
      if (explicit === "message") return "message";
      if (imageKeys(entry).length) return "output";
      if (attemptKeys(entry).length) return "attempt";
      return "message";
    }

    function normalizeGenerationStatus(entry) {
      const raw = clean(entry?.generationStatus || entry?.generation_status).toLowerCase().replace(/[\s-]+/g, "_");
      if (["completed", "complete", "succeeded", "success", "done", "finished"].includes(raw)) return "completed";
      if (["failed", "failure", "error", "errored", "rejected", "timeout", "timed_out"].includes(raw)) return "failed";
      if (["cancelled", "canceled", "aborted", "stopped"].includes(raw)) return "cancelled";
      if (["partial", "incomplete"].includes(raw)) return "partial";
      if (["in_progress", "running", "generating", "streaming", "pending", "queued"].includes(raw)) return "in_progress";
      return "unknown";
    }

    function statusRank(status) {
      return ({ unknown: 0, in_progress: 1, partial: 2, failed: 3, cancelled: 3, completed: 4 })[status] || 0;
    }

    function betterStatus(current, candidate) {
      const next = normalizeGenerationStatus({ generationStatus: candidate });
      if (!current || statusRank(next) >= statusRank(current)) return next;
      return current;
    }

    function promptScore(entry) {
      return clean(entry?.prompt) ? Number(promptQuality(entry)) || 0 : -1;
    }

    function betterPrompt(current, candidate) {
      if (!clean(candidate?.prompt)) return current;
      if (!current) return { ...candidate };
      const nextScore = promptScore(candidate);
      const currentScore = promptScore(current);
      if (nextScore !== currentScore) return nextScore > currentScore ? { ...candidate } : current;
      return clean(candidate.prompt).length > clean(current.prompt).length ? { ...candidate } : current;
    }

    function outputMetaScore(entry) {
      let score = entry?.isGeneration === true ? 100 : 0;
      if (clean(entry?.assetId)) score += 20;
      if (clean(entry?.imageKey)) score += 16;
      if (clean(entry?.imageUrl)) score += 12;
      if (clean(entry?.providerResponseId || entry?.provider_response_id)) score += 4;
      return score;
    }

    function betterOutputMeta(current, candidate) {
      if (!candidate || !imageKeys(candidate).length) return current;
      if (!current || outputMetaScore(candidate) >= outputMetaScore(current)) return { ...candidate };
      return current;
    }

    function createAttempt(entry = {}) {
      const identity = attemptIdentity(entry);
      const attempt = {
        id: `attempt-${++sequence}`,
        generationCallId: identity.generationCallId,
        toolCallId: identity.toolCallId,
        generationContextId: identity.generationContextId,
        attemptKeys: new Set(),
        messageKeys: new Set(),
        outputs: new Set(),
        sharedPrompt: null,
        generationStatus: normalizeGenerationStatus(entry),
        isGeneration: entry?.isGeneration === true,
        updatedAt: Date.now(),
      };
      attempts.add(attempt);
      return attempt;
    }

    function createOutput(attempt) {
      const output = {
        id: `${attempt.id}:output-${attempt.outputs.size + 1}`,
        attempt,
        imageKeys: new Set(),
        bestPrompt: null,
        meta: null,
        generationStatus: "unknown",
        updatedAt: Date.now(),
      };
      attempt.outputs.add(output);
      return output;
    }

    function setIndex(map, key, value) {
      if (!key) return;
      let bucket = map.get(key);
      if (!bucket) {
        bucket = new Set();
        map.set(key, bucket);
      }
      bucket.add(value);
    }

    function removeIndexValue(map, key, value) {
      const bucket = map.get(key);
      if (!bucket) return;
      bucket.delete(value);
      if (!bucket.size) map.delete(key);
    }

    function indexAttempt(attempt) {
      for (const key of attempt.attemptKeys) setIndex(attemptKeyIndex, key, attempt);
      for (const key of attempt.messageKeys) setIndex(messageIndex, key, attempt);
    }

    function indexOutput(output) {
      for (const key of output.imageKeys) setIndex(outputKeyIndex, key, output);
    }

    function attemptsCompatible(left, right) {
      if (!left || !right || left === right) return true;
      if (left.generationCallId && right.generationCallId && left.generationCallId !== right.generationCallId) return false;
      if (left.toolCallId && right.toolCallId && left.toolCallId !== right.toolCallId) return false;
      if (left.generationContextId && right.generationContextId && left.generationContextId !== right.generationContextId) return false;
      return true;
    }

    function attemptCompatibleWithEntry(attempt, entry) {
      const identity = attemptIdentity(entry);
      if (attempt.generationCallId && identity.generationCallId && attempt.generationCallId !== identity.generationCallId) return false;
      if (attempt.toolCallId && identity.toolCallId && attempt.toolCallId !== identity.toolCallId) return false;
      if (attempt.generationContextId && identity.generationContextId && attempt.generationContextId !== identity.generationContextId) return false;
      return true;
    }

    function mergeOutputs(primary, secondary) {
      if (!primary || !secondary || primary === secondary) return primary || secondary;
      primary.bestPrompt = betterPrompt(primary.bestPrompt, secondary.bestPrompt);
      primary.meta = betterOutputMeta(primary.meta, secondary.meta);
      primary.generationStatus = betterStatus(primary.generationStatus, secondary.generationStatus);
      primary.updatedAt = Math.max(primary.updatedAt, secondary.updatedAt);
      for (const key of secondary.imageKeys) {
        primary.imageKeys.add(key);
        removeIndexValue(outputKeyIndex, key, secondary);
      }
      secondary.attempt.outputs.delete(secondary);
      indexOutput(primary);
      return primary;
    }

    function mergeAttempts(primary, secondary) {
      if (!primary || !secondary || primary === secondary || !attemptsCompatible(primary, secondary)) return primary || secondary;
      primary.generationCallId ||= secondary.generationCallId;
      primary.toolCallId ||= secondary.toolCallId;
      primary.generationContextId ||= secondary.generationContextId;
      primary.sharedPrompt = betterPrompt(primary.sharedPrompt, secondary.sharedPrompt);
      primary.generationStatus = betterStatus(primary.generationStatus, secondary.generationStatus);
      primary.isGeneration = primary.isGeneration || secondary.isGeneration;
      primary.updatedAt = Math.max(primary.updatedAt, secondary.updatedAt);

      for (const key of secondary.attemptKeys) {
        primary.attemptKeys.add(key);
        removeIndexValue(attemptKeyIndex, key, secondary);
      }
      for (const key of secondary.messageKeys) {
        primary.messageKeys.add(key);
        removeIndexValue(messageIndex, key, secondary);
      }
      for (const output of [...secondary.outputs]) {
        const overlapping = [...output.imageKeys]
          .flatMap((key) => [...(outputKeyIndex.get(key) || [])])
          .find((candidate) => candidate !== output && candidate.attempt === primary);
        if (overlapping) mergeOutputs(overlapping, output);
        else {
          secondary.outputs.delete(output);
          output.attempt = primary;
          primary.outputs.add(output);
        }
      }
      attempts.delete(secondary);
      indexAttempt(primary);
      for (const output of primary.outputs) indexOutput(output);
      return primary;
    }

    function candidateAttempts(entry) {
      const found = new Set();
      for (const key of attemptKeys(entry)) {
        for (const attempt of attemptKeyIndex.get(key) || []) {
          if (attempts.has(attempt) && attemptCompatibleWithEntry(attempt, entry)) found.add(attempt);
        }
      }
      for (const key of imageKeys(entry)) {
        for (const output of outputKeyIndex.get(key) || []) {
          if (attempts.has(output.attempt) && attemptCompatibleWithEntry(output.attempt, entry)) found.add(output.attempt);
        }
      }
      return [...found];
    }

    function resolveAttemptForEntry(entry, { create = false } = {}) {
      const candidates = candidateAttempts(entry);
      if (candidates.length) {
        let primary = candidates[0];
        for (const candidate of candidates.slice(1)) {
          if (!attemptsCompatible(primary, candidate)) {
            return create ? createAttempt(entry) : null;
          }
          primary = mergeAttempts(primary, candidate);
        }
        return primary;
      }
      return create && (attemptKeys(entry).length || imageKeys(entry).length) ? createAttempt(entry) : null;
    }

    function outputForEntry(attempt, entry, { create = false } = {}) {
      if (!attempt) return null;
      const keys = imageKeys(entry);
      if (!keys.length) return null;
      const matches = new Set();
      for (const key of keys) {
        for (const output of outputKeyIndex.get(key) || []) {
          if (output.attempt === attempt) matches.add(output);
        }
      }
      let output = [...matches][0] || (create ? createOutput(attempt) : null);
      if (!output) return null;
      for (const other of [...matches].slice(1)) output = mergeOutputs(output, other);
      for (const key of keys) output.imageKeys.add(key);
      indexOutput(output);
      return output;
    }

    function applyAttemptIdentity(attempt, entry) {
      if (!attempt) return;
      const identity = attemptIdentity(entry);
      attempt.generationCallId ||= identity.generationCallId;
      attempt.toolCallId ||= identity.toolCallId;
      attempt.generationContextId ||= identity.generationContextId;
      for (const key of attemptKeys(entry)) attempt.attemptKeys.add(key);
      const msgKey = messageKey(entry);
      if (msgKey) attempt.messageKeys.add(msgKey);
      indexAttempt(attempt);
    }

    function rememberMessagePrompt(entry) {
      const key = messageKey(entry);
      if (!key || !clean(entry?.prompt)) return;
      if (["failed", "cancelled"].includes(normalizeGenerationStatus(entry))) return;
      let prompts = messagePrompts.get(key);
      if (!prompts) {
        prompts = [];
      }
      messagePrompts.delete(key);
      messagePrompts.set(key, prompts);
      prompts.push({ ...entry, promptScope: "message" });
      prompts.sort((a, b) => promptScore(b) - promptScore(a));
      if (prompts.length > MAX_MESSAGE_PROMPTS) prompts.length = MAX_MESSAGE_PROMPTS;
      while (messagePrompts.size > MAX_MESSAGE_KEYS) messagePrompts.delete(messagePrompts.keys().next().value);
    }

    function applyEntry(attempt, entry) {
      if (!attempt || !entry) return null;
      applyAttemptIdentity(attempt, entry);
      attempt.updatedAt = Date.now();
      attempt.isGeneration = attempt.isGeneration || entry.isGeneration === true;
      attempt.generationStatus = betterStatus(attempt.generationStatus, normalizeGenerationStatus(entry));

      const output = outputForEntry(attempt, entry, { create: imageKeys(entry).length > 0 });
      if (output) {
        output.updatedAt = Date.now();
        output.meta = betterOutputMeta(output.meta, entry);
        output.generationStatus = betterStatus(output.generationStatus, normalizeGenerationStatus(entry));
      }

      if (clean(entry.prompt)) {
        const scope = normalizePromptScope(entry);
        if (scope === "output" && output) output.bestPrompt = betterPrompt(output.bestPrompt, entry);
        else if (scope === "attempt") attempt.sharedPrompt = betterPrompt(attempt.sharedPrompt, entry);
        else if (scope === "message") rememberMessagePrompt(entry);
      }
      return output;
    }

    function liveMessageAttempts(key) {
      return [...(messageIndex.get(key) || [])].filter((attempt) => attempts.has(attempt));
    }

    function messageFallbackPrompt(attempt) {
      if (!attempt || attempt.sharedPrompt) return null;
      for (const key of attempt.messageKeys) {
        const live = liveMessageAttempts(key);
        if (live.length !== 1 || live[0] !== attempt) continue;
        const candidate = messagePrompts.get(key)?.[0] || null;
        if (candidate) {
          const promptStatus = normalizeGenerationStatus(candidate);
          if (["failed", "cancelled"].includes(promptStatus)) continue;
          if (["failed", "cancelled"].includes(attempt.generationStatus) && promptStatus === "completed") continue;
          return candidate;
        }
      }
      return null;
    }

    function sharedPromptForOutput(attempt, output) {
      const prompt = attempt?.sharedPrompt || null;
      if (!prompt) return null;
      const promptGenerationStatus = normalizeGenerationStatus(prompt);
      const outputStatus = output?.generationStatus !== "unknown"
        ? output.generationStatus
        : attempt.generationStatus;
      // A failed/cancelled prompt-only attempt must never become the prompt of
      // a later completed output merely because the provider reused a weak
      // tool/message identity. Exact output-bound prompts remain eligible.
      if (["failed", "cancelled"].includes(promptGenerationStatus) && outputStatus === "completed") return null;
      return prompt;
    }

    function resolvedOutput(output) {
      if (!output || !attempts.has(output.attempt)) return null;
      const attempt = output.attempt;
      const sharedPrompt = sharedPromptForOutput(attempt, output);
      const prompt = output.bestPrompt || sharedPrompt || messageFallbackPrompt(attempt) || {};
      const meta = output.meta || {};
      const generationStatus = output.generationStatus !== "unknown" ? output.generationStatus : attempt.generationStatus;
      return {
        ...prompt,
        ...meta,
        prompt: clean(prompt.prompt),
        promptStatus: clean(prompt.promptStatus || prompt.prompt_status),
        promptSource: clean(prompt.promptSource || prompt.prompt_source || prompt.via),
        promptPriority: Number(prompt.promptPriority || prompt.prompt_priority) || 0,
        promptScope: output.bestPrompt ? "output" : sharedPrompt ? "attempt" : clean(prompt.prompt) ? "message" : "",
        generationStatus,
        conversationId: clean(meta.conversationId || prompt.conversationId),
        messageId: clean(meta.messageId || prompt.messageId),
        generationContextId: clean(meta.generationContextId || prompt.generationContextId || attempt.generationContextId),
        providerToolCallId: clean(meta.providerToolCallId || prompt.providerToolCallId || attempt.toolCallId),
        providerGenerationCallId: clean(meta.providerGenerationCallId || prompt.providerGenerationCallId || attempt.generationCallId),
        providerResponseId: clean(meta.providerResponseId || prompt.providerResponseId),
        assetId: clean(meta.assetId || prompt.assetId),
        isGeneration: attempt.isGeneration,
      };
    }

    function resolvedAttempt(attempt) {
      if (!attempt || !attempts.has(attempt)) return null;
      if (attempt.outputs.size === 1) return resolvedOutput([...attempt.outputs][0]);
      const prompt = attempt.sharedPrompt || messageFallbackPrompt(attempt) || {};
      return {
        ...prompt,
        prompt: clean(prompt.prompt),
        promptStatus: clean(prompt.promptStatus || prompt.prompt_status),
        promptSource: clean(prompt.promptSource || prompt.prompt_source || prompt.via),
        promptPriority: Number(prompt.promptPriority || prompt.prompt_priority) || 0,
        promptScope: attempt.sharedPrompt ? "attempt" : clean(prompt.prompt) ? "message" : "",
        generationStatus: attempt.generationStatus,
        conversationId: clean(prompt.conversationId),
        messageId: clean(prompt.messageId),
        generationContextId: clean(prompt.generationContextId || attempt.generationContextId),
        providerToolCallId: clean(prompt.providerToolCallId || attempt.toolCallId),
        providerGenerationCallId: clean(prompt.providerGenerationCallId || attempt.generationCallId),
        providerResponseId: clean(prompt.providerResponseId),
        assetId: "",
        isGeneration: attempt.isGeneration,
      };
    }

    function outputsForImage(imageUrl, meta = {}) {
      const outputs = new Set();
      for (const key of imageLookupKeys(clean(imageUrl), meta || {})) {
        for (const output of outputKeyIndex.get(key) || []) {
          if (attempts.has(output.attempt)) outputs.add(output);
        }
      }
      return [...outputs];
    }

    function resolvedForImage(imageUrl, meta = {}) {
      const outputs = outputsForImage(imageUrl, meta);
      if (outputs.length !== 1) return null;
      return resolvedOutput(outputs[0]);
    }

    function resolvedForEntry(entry) {
      const explicit = imageKeys(entry);
      if (explicit.length) {
        const outputs = outputsForImage(clean(entry?.imageUrl), entry);
        if (outputs.length === 1) return resolvedOutput(outputs[0]);
      }
      return resolvedAttempt(resolveAttemptForEntry(entry));
    }

    function resolvedForMessage(conversationId, messageId) {
      const key = messageKey({ conversationId, messageId });
      if (!key) return null;
      const live = liveMessageAttempts(key);
      if (live.length !== 1) return null;
      return resolvedAttempt(live[0]);
    }

    function imageKeysForEntry(entry) {
      const explicit = imageKeys(entry);
      if (explicit.length) return explicit;
      const attempt = resolveAttemptForEntry(entry);
      if (!attempt) return [];
      const scope = normalizePromptScope(entry);
      if (scope !== "attempt" && scope !== "message") return [];
      return [...new Set([...attempt.outputs].flatMap((output) => [...output.imageKeys]))];
    }

    function resolvedOutputsForEntry(entry) {
      const explicit = imageKeys(entry);
      if (explicit.length) {
        return outputsForImage(clean(entry?.imageUrl), entry).map(resolvedOutput).filter(Boolean);
      }
      const attempt = resolveAttemptForEntry(entry);
      if (!attempt) return [];
      return [...attempt.outputs].map(resolvedOutput).filter(Boolean);
    }

    function prune() {
      let prunedAttempts = false;
      if (attempts.size > MAX_ATTEMPTS) {
        prunedAttempts = true;
        const ordered = [...attempts].sort((a, b) => a.updatedAt - b.updatedAt);
        for (const attempt of ordered.slice(0, attempts.size - MAX_ATTEMPTS)) {
          attempts.delete(attempt);
          for (const key of attempt.attemptKeys) removeIndexValue(attemptKeyIndex, key, attempt);
          for (const key of attempt.messageKeys) removeIndexValue(messageIndex, key, attempt);
          for (const output of attempt.outputs) {
            for (const key of output.imageKeys) removeIndexValue(outputKeyIndex, key, output);
          }
        }
      }
      if (prunedAttempts) {
        for (const key of [...messagePrompts.keys()]) {
          if (!liveMessageAttempts(key).length) messagePrompts.delete(key);
        }
      }
    }

    function remember(entry) {
      if (!entry || typeof entry !== "object") return null;
      const attemptIds = attemptKeys(entry);
      const outputs = imageKeys(entry);
      if (!attemptIds.length && !outputs.length) {
        rememberMessagePrompt(entry);
        return null;
      }
      const attempt = resolveAttemptForEntry(entry, { create: true });
      if (!attempt) return null;
      applyEntry(attempt, entry);
      prune();
      return attempt;
    }

    function clear() {
      attempts.clear();
      attemptKeyIndex.clear();
      outputKeyIndex.clear();
      messageIndex.clear();
      messagePrompts.clear();
      sequence = 0;
    }

    function debugSnapshot() {
      return [...attempts].map((attempt) => ({
        id: attempt.id,
        generationCallId: attempt.generationCallId,
        toolCallId: attempt.toolCallId,
        generationContextId: attempt.generationContextId,
        attemptKeys: [...attempt.attemptKeys],
        messageKeys: [...attempt.messageKeys],
        sharedPrompt: attempt.sharedPrompt ? {
          prompt: clean(attempt.sharedPrompt.prompt),
          promptPriority: Number(attempt.sharedPrompt.promptPriority || 0),
        } : null,
        generationStatus: attempt.generationStatus,
        outputs: [...attempt.outputs].map((output) => ({
          id: output.id,
          imageKeys: [...output.imageKeys],
          assetId: clean(output.meta?.assetId),
          prompt: clean(output.bestPrompt?.prompt),
          promptPriority: Number(output.bestPrompt?.promptPriority || 0),
          generationStatus: output.generationStatus,
        })),
      }));
    }

    return {
      clear,
      debugSnapshot,
      imageKeysForEntry,
      remember,
      resolvedForEntry,
      resolvedForImage,
      resolvedForMessage,
      resolvedOutputsForEntry,
    };
  }

  globalScope.MosaGenerationRegistry = { createGenerationRegistry };
})(globalThis);
