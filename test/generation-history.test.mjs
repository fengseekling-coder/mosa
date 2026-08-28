import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createJsonAssetStore } from "../lib/asset-store.mjs";
import { resolveGenerationRelationCandidates } from "../lib/generation-history.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

test("GPT relation resolver proposes lineage without turning proximity into fact", () => {
  const events = [
    {
      id: "gen-a",
      output_asset_id: "asset-a",
      provider: "chatgpt",
      provider_asset_id: "file-a",
      conversation_id: "conversation-a",
      message_id: "message-a",
      effective_prompt: "create a product poster",
      created_at: "2026-08-27T10:00:00.000Z",
    },
    {
      id: "gen-b",
      output_asset_id: "asset-b",
      provider: "chatgpt",
      conversation_id: "conversation-a",
      message_id: "message-b",
      effective_prompt: "生成一个蓝色汽车海报",
      created_at: "2026-08-27T10:05:00.000Z",
    },
    {
      id: "gen-c",
      output_asset_id: "asset-c",
      provider: "chatgpt",
      conversation_id: "conversation-a",
      message_id: "message-c",
      effective_prompt: "把背景换成黑色，其他保持不变",
      created_at: "2026-08-27T10:10:00.000Z",
    },
    {
      id: "gen-d",
      output_asset_id: "asset-d",
      provider: "chatgpt",
      conversation_id: "conversation-b",
      message_id: "message-d",
      effective_prompt: "把背景换成白色",
      created_at: "2026-08-27T10:11:00.000Z",
    },
    {
      id: "gen-e",
      output_asset_id: "asset-e",
      provider: "chatgpt",
      conversation_id: "conversation-a",
      message_id: "message-e",
      effective_prompt: "参考这张图做一个横版",
      references: [{ provider_asset_id: "file-a" }],
      created_at: "2026-08-27T10:20:00.000Z",
    },
  ];

  const candidates = resolveGenerationRelationCandidates({
    projectId: "default",
    events,
    relations: [],
    candidates: [],
    now: "2026-08-27T10:21:00.000Z",
  });

  assert.equal(candidates.some((candidate) => candidate.child_generation_id === "gen-b"), false, "a nearby fresh generation is not treated as a version automatically");
  assert.ok(candidates.some((candidate) => (
    candidate.child_generation_id === "gen-c"
    && candidate.parent_generation_id === "gen-b"
    && candidate.suggested_relation_type === "edited_from"
    && candidate.verification_level === "inferred"
  )), "an edit-like follow-up becomes a candidate, not a relation");
  assert.equal(candidates.some((candidate) => candidate.child_generation_id === "gen-d"), false, "candidate parents never cross conversations");
  assert.ok(candidates.some((candidate) => (
    candidate.child_generation_id === "gen-e"
    && candidate.parent_generation_id === "gen-a"
    && candidate.suggested_relation_type === "edited_from"
    && candidate.evidence?.parent_provider_asset_id === "file-a"
  )), "an observed reused provider asset strengthens the correct parent candidate");

  const dismissed = resolveGenerationRelationCandidates({
    projectId: "default",
    events,
    relations: [],
    candidates: [{
      project_id: "default",
      child_generation_id: "gen-e",
      parent_generation_id: "gen-a",
      suggested_relation_type: "based_on",
      confidence: 0.9,
      verification_level: "inferred",
      status: "dismissed",
      created_at: "2026-08-27T10:20:30.000Z",
      updated_at: "2026-08-27T10:20:30.000Z",
    }],
    now: "2026-08-27T10:22:00.000Z",
  });
  assert.equal(dismissed.find((candidate) => candidate.child_generation_id === "gen-e" && candidate.parent_generation_id === "gen-a")?.status, "dismissed", "dismissed guesses are not resurrected by a later resolver pass");
});

for (const [name, createStore] of [
  ["JSON", (root) => createJsonAssetStore({ projectRoot: root, managerDir: join(root, "manager"), assetsRoot: join(root, "json-assets") })],
  ["SQLite", (root) => createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir: join(root, "sqlite-library"), initializeFreshLibrary: true })],
]) {
  test(`${name} store keeps generation events independent from deduplicated assets`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `mosa-generation-${name.toLowerCase()}-`));
    let store;
    t.after(async () => {
      store?.close?.();
      await rm(root, { recursive: true, force: true });
    });
    await mkdir(join(root, "input"), { recursive: true });
    const firstPath = join(root, "input", "first.png");
    const secondPath = join(root, "input", "second.png");
    await writeFile(firstPath, Buffer.from("generation-history-first-image"));
    await writeFile(secondPath, Buffer.from("generation-history-second-image"));

    store = createStore(root);
    await store.ensureProject("default");
    const sharedAsset = await store.createAsset({ projectId: "default", assetId: "shared-output", imagePath: firstPath });
    const childAsset = await store.createAsset({ projectId: "default", assetId: "child-output", imagePath: secondPath });

    const observedA = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: sharedAsset.id,
      provider: "chatgpt",
      capture_context_id: "chatgpt:conversation-a:call-a",
      provider_asset_id: "file-observed-a",
      conversation_id: "conversation-a",
      message_id: "message-a",
      effective_prompt: "observed prompt a",
      verification_level: "observed",
      created_at: "2026-08-27T10:00:00.000Z",
    });
    const observedB = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: sharedAsset.id,
      provider: "chatgpt",
      capture_context_id: "chatgpt:conversation-b:call-b",
      conversation_id: "conversation-b",
      message_id: "message-b",
      effective_prompt: "observed prompt b",
      verification_level: "observed",
      created_at: "2026-08-27T11:00:00.000Z",
    });

    assert.notEqual(observedA.id, observedB.id, "one media asset may represent several independent generations");
    const sharedEvents = await store.listGenerationEvents("default", { assetId: sharedAsset.id });
    assert.equal(sharedEvents.length, 2);
    assert.deepEqual(sharedEvents.map((event) => event.capture_context_id), [
      "chatgpt:conversation-a:call-a",
      "chatgpt:conversation-b:call-b",
    ]);
    assert.ok(sharedEvents.every((event) => event.provider_generation_call_id === ""), "MOSA capture context must not impersonate a provider call id");

    const verifiedChild = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: childAsset.id,
      provider: "openai",
      provider_generation_call_id: "ig_verified_child",
      provider_response_id: "resp_verified_child",
      user_prompt: "make the background black",
      effective_prompt: "make the background black",
      verification_level: "provider_verified",
      created_at: "2026-08-27T12:00:00.000Z",
    });
    const attemptedDowngrade = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: childAsset.id,
      provider: "openai",
      provider_generation_call_id: "ig_verified_child",
      provider_response_id: "spoofed-response",
      effective_prompt: "untrusted overwrite",
      verification_level: "observed",
      created_at: "2026-08-27T12:00:00.000Z",
    });
    assert.equal(attemptedDowngrade.verification_level, "provider_verified");
    assert.equal(attemptedDowngrade.provider_response_id, "resp_verified_child");
    assert.equal(attemptedDowngrade.effective_prompt, "make the background black");

    await store.recordGenerationRelation({
      project_id: "default",
      child_generation_id: verifiedChild.id,
      parent_generation_id: observedA.id,
      relation_type: "edited_from",
      verification_level: "provider_verified",
      evidence: { source: "trusted-provider-link" },
      created_at: "2026-08-27T12:00:01.000Z",
    });
    const relationDowngrade = await store.recordGenerationRelation({
      project_id: "default",
      child_generation_id: verifiedChild.id,
      parent_generation_id: observedA.id,
      relation_type: "edited_from",
      verification_level: "inferred",
      evidence: { source: "untrusted-guess" },
      created_at: "2026-08-27T12:00:02.000Z",
    });
    assert.equal(relationDowngrade.verification_level, "provider_verified");
    assert.deepEqual(relationDowngrade.evidence, { source: "trusted-provider-link" });

    const lineage = await store.getGenerationLineage("default", verifiedChild.id);
    assert.equal(lineage.events.length, 2);
    assert.equal(lineage.relations.length, 1);
    assert.equal(lineage.relations[0].verification_level, "provider_verified");
    const child = lineage.events.find((event) => event.id === verifiedChild.id);
    assert.deepEqual(child.parent_generation_ids, [observedA.id]);

    await assert.rejects(
      store.recordGenerationRelation({
        project_id: "default",
        child_generation_id: observedA.id,
        parent_generation_id: verifiedChild.id,
        relation_type: "edited_from",
        verification_level: "inferred",
      }),
      /cycle/i,
    );

    const upgraded = await store.recordGenerationEvent({
      ...observedA,
      effective_prompt: "better recovered observed prompt",
    });
    assert.equal(upgraded.id, observedA.id);
    const afterUpgrade = await store.listGenerationEvents("default", { captureContextId: observedA.capture_context_id });
    assert.equal(afterUpgrade.length, 1, "re-observing one generation updates evidence instead of duplicating history");
    assert.equal(afterUpgrade[0].effective_prompt, "better recovered observed prompt");

    const unrelatedProvider = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: childAsset.id,
      provider: "gemini",
      conversation_id: "conversation-a",
      message_id: "gemini-message-a",
      effective_prompt: "same conversation id on another provider",
      verification_level: "observed",
      created_at: "2026-08-27T13:00:00.000Z",
    });
    const sameContextCandidate = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: childAsset.id,
      provider: "chatgpt",
      conversation_id: "conversation-a",
      message_id: "message-candidate",
      effective_prompt: "same ChatGPT conversation candidate",
      references: [{ provider_asset_id: "file-observed-a", role: "" }],
      verification_level: "observed",
      created_at: "2026-08-27T13:10:00.000Z",
    });
    const assetHistory = await store.getAssetGenerationHistory("default", sharedAsset.id);
    assert.ok(assetHistory.context_events.every((event) => event.id !== unrelatedProvider.id), "context candidates stay within the same provider and conversation");
    assert.ok(assetHistory.context_events.some((event) => event.id === sameContextCandidate.id), "same-provider same-conversation generations are exposed as unlinked candidates");
    assert.ok(assetHistory.relation_candidates.some((candidate) => (
      candidate.child_generation_id === sameContextCandidate.id
      && candidate.parent_generation_id === observedA.id
      && candidate.suggested_relation_type === "based_on"
      && candidate.verification_level === "inferred"
      && candidate.status === "suggested"
      && candidate.confidence >= 0.55
      && candidate.evidence?.parent_provider_asset_id === "file-observed-a"
    )), "a reused provider asset becomes an inferred based_on candidate, not a confirmed edge");
    assert.equal(assetHistory.relations.some((relation) => (
      relation.child_generation_id === sameContextCandidate.id
      && relation.parent_generation_id === observedA.id
    )), false, "reference evidence must not silently become a formal relation");

    await assert.rejects(
      store.deleteGenerationRelation({
        project_id: "default",
        child_generation_id: verifiedChild.id,
        parent_generation_id: observedA.id,
        relation_type: "edited_from",
      }),
      /provider-verified/i,
      "provider-verified lineage edges stay immutable from the management surface",
    );
    await store.recordGenerationRelation({
      project_id: "default",
      child_generation_id: sameContextCandidate.id,
      parent_generation_id: observedA.id,
      relation_type: "variant_of",
      verification_level: "user_confirmed",
      evidence: { user_selected_parent: true },
    });
    const confirmedHistory = await store.getAssetGenerationHistory("default", sharedAsset.id);
    assert.equal(confirmedHistory.relation_candidates.some((candidate) => (
      candidate.child_generation_id === sameContextCandidate.id
      && candidate.parent_generation_id === observedA.id
    )), false, "confirmed candidates leave the possible-relation surface");
    await store.deleteGenerationRelation({
      project_id: "default",
      child_generation_id: sameContextCandidate.id,
      parent_generation_id: observedA.id,
      relation_type: "variant_of",
    });
    const detachedLineage = await store.getAssetGenerationHistory("default", sharedAsset.id);
    assert.ok(detachedLineage.context_events.some((event) => event.id === sameContextCandidate.id), "deleting a user-managed relation keeps the generation available in the same-conversation context");
    assert.equal(detachedLineage.relation_candidates.some((candidate) => (
      candidate.child_generation_id === sameContextCandidate.id
      && candidate.parent_generation_id === observedA.id
    )), false, "a dismissed candidate is not resurrected after the relation is removed");

    const childEventIds = new Set((await store.listGenerationEvents("default", { assetId: childAsset.id })).map((event) => event.id));
    await store.deleteAsset("default", childAsset.id);
    assert.equal((await store.listGenerationEvents("default", { assetId: childAsset.id })).length, 0,
      "hard-deleting an asset removes its generation events in every backend");
    const remainingHistory = await store.getAssetGenerationHistory("default", sharedAsset.id);
    assert.equal(remainingHistory.relations.some((relation) => (
      childEventIds.has(relation.child_generation_id) || childEventIds.has(relation.parent_generation_id)
    )), false, "relations referencing deleted generation events must be removed");
    assert.equal(remainingHistory.relation_candidates.some((candidate) => (
      childEventIds.has(candidate.child_generation_id) || childEventIds.has(candidate.parent_generation_id)
    )), false, "relation candidates referencing deleted generation events must be removed");
  });
}
