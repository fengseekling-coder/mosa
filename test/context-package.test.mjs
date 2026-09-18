import assert from "node:assert/strict";
import test from "node:test";

import { buildContextPackage, contextPackageFileName, contextPackageText } from "../app/context-package.mjs";

function fixture() {
  return {
    asset: {
      project_id: "default",
      id: "asset-1",
      asset: "Poster Final.png",
      image_path: "/library/assets/default/poster.png",
      prompt: "fallback prompt",
      curated: true,
      curation_note: "Keep the silhouette; replace the lettering.",
      version_index: 2,
      parent_asset_id: "asset-0",
      version_change: "Darkened background",
      source: {
        type: "web-chatgpt",
        provider: "openai",
        model: "image-model",
        conversation_id: "conv-1",
        message_id: "msg-1",
        provider_asset_id: "provider-1",
        authorization: "Bearer do-not-export",
        signed_url: "https://secret.example/?token=secret",
      },
    },
    recipeHistory: {
      active_snapshot_id: "recipe-active",
      snapshots: [{
        snapshot_id: "recipe-old",
        effective_prompt: "old prompt",
      }, {
        snapshot_id: "recipe-active",
        recipe_digest: "recipe-digest",
        prompt_digest: "prompt-digest",
        effective_prompt: "actual prompt",
        user_prompt: "make a poster",
        negative_prompt: "no watermark",
        prompt_status: "provider-visible",
        generation_tool: "chatgpt",
        model: "image-model",
        provider: "openai",
        style: "editorial",
        ratio: "2:3",
        provenance: {
          source_type: "web-chatgpt",
          provider_generation_call_id: "gen-1",
          provider_asset_id: "provider-1",
          verification_level: "observed",
          secret: "never",
        },
        references: [{
          asset_id: "ref-asset",
          reference_id: "ref-1",
          sha256: "abc123",
          attachment_url: "/library/default/references/ref-1.png",
          role: "composition",
          scope: ["layout"],
          applied: true,
          allowed_uses: ["reference"],
          forbidden_uses: [],
          rights: { copyright: "owned", secret_right: "never-right" },
          hidden_token: "never",
        }],
      }],
    },
    versionHistory: { versions: [
      { id: "asset-0", version_index: 1, version_change: "Initial", created_at: "2026-09-17T00:00:00Z" },
      { id: "asset-1", version_index: 2, parent_asset_id: "asset-0", version_change: "Darkened background", created_at: "2026-09-18T00:00:00Z" },
    ] },
    generationHistory: { events: [{ id: "event-1", provider: "openai", model: "image-model", verification_level: "observed", provider_asset_id: "provider-1", raw_response: "never" }] },
  };
}

test("context package selects the active recipe and exports only allowlisted facts", () => {
  const data = fixture();
  const pkg = buildContextPackage(data.asset, { ...data, generatedAt: "2026-09-18T10:00:00Z" });
  assert.equal(pkg.schema, "mosa.context-package/1");
  assert.equal(pkg.prompt.effective_prompt, "actual prompt");
  assert.equal(pkg.references[0].attachment_url, "/library/default/references/ref-1.png");
  assert.equal(pkg.version.parent_asset_id, "asset-0");
  assert.equal(pkg.generation_events[0].id, "event-1");
  const serialized = JSON.stringify(pkg);
  assert.doesNotMatch(serialized, /do-not-export|signed_url|hidden_token|raw_response|never/);
});

test("context package leaves unavailable prompt facts empty instead of guessing", () => {
  const pkg = buildContextPackage({ id: "empty", project_id: "default", image_path: "/tmp/empty.png", source: { prompt_status: "not-available" } }, { generatedAt: "2026-09-18T10:00:00Z" });
  assert.equal(pkg.prompt.prompt_status, "not-available");
  assert.equal(pkg.prompt.effective_prompt, "");
  assert.equal(pkg.recipe, null);
  assert.deepEqual(pkg.references, []);
  assert.match(contextPackageText(pkg), /do not infer/i);
  assert.match(contextPackageText(pkg), /<not available>/);
});

test("context package text carries local reuse anchors and filename is filesystem-safe", () => {
  const data = fixture();
  const pkg = buildContextPackage(data.asset, { ...data, generatedAt: "2026-09-18T10:00:00Z" });
  const output = contextPackageText(pkg);
  assert.match(output, /\/library\/assets\/default\/poster\.png/);
  assert.match(output, /Keep the silhouette/);
  assert.match(output, /\/library\/default\/references\/ref-1\.png/);
  assert.equal(contextPackageFileName(data.asset), "Poster-Final-mosa-context.json");
});
