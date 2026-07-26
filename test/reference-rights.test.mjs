import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultReferenceRights,
  isReferenceCleared,
  normalizeReferenceRights,
  normalizeUseList,
  referenceRightsStatus,
  referenceUsePermission,
  summarizeReferenceRights,
} from "../lib/reference-rights.mjs";
import { appendRecipeSnapshot, buildRecipeSnapshot, ensureRecipeSnapshots } from "../lib/recipe-snapshot.mjs";

test("a forbidden use beats an allowed use for the same purpose", () => {
  const reference = { allowed_uses: ["identity", "style"], forbidden_uses: ["identity"] };

  // A declaration that both permits and forbids identity is not ambiguous:
  // the refusal is the one that must survive.
  assert.equal(referenceUsePermission(reference, "identity"), "forbidden");
  assert.equal(referenceUsePermission(reference, "style"), "allowed");
});

test("an undeclared reference reports undeclared rather than guessing", () => {
  const reference = { asset_id: "R1" };

  assert.equal(referenceUsePermission(reference, "identity"), "undeclared");
  assert.equal(referenceUsePermission(reference, ""), "undeclared");
  assert.equal(referenceUsePermission(undefined, "style"), "undeclared");
});

test("once a permitted list exists, everything outside it is forbidden", () => {
  const reference = { allowed_uses: ["style"] };

  assert.equal(referenceUsePermission(reference, "style"), "allowed");
  assert.equal(referenceUsePermission(reference, "identity"), "forbidden");
});

test("use tokens are compared after normalisation", () => {
  assert.deepEqual(normalizeUseList([" Identity ", "STYLE", "style", ""]), ["identity", "style"]);
  assert.equal(referenceUsePermission({ forbidden_uses: ["  IDENTITY "] }, "identity"), "forbidden");
});

test("rights default to unknown so silence is never read as permission", () => {
  assert.deepEqual(defaultReferenceRights(), {
    copyright: "unknown",
    portrait_consent: "unknown",
    redistribution: "unknown",
    attribution: "",
  });
  assert.equal(referenceRightsStatus({}), "unresolved");
  assert.equal(isReferenceCleared({}), false);
});

test("an unrecognised rights value falls back to unknown instead of passing through", () => {
  const rights = normalizeReferenceRights({ copyright: "probably fine", portrait_consent: "granted", redistribution: true });

  assert.equal(rights.copyright, "unknown");
  assert.equal(rights.portrait_consent, "granted");
  assert.equal(rights.redistribution, "allowed", "a boolean redistribution flag maps onto the vocabulary");
});

test("a reference is cleared only when every rights field is known and permissive", () => {
  const cleared = { rights: { copyright: "owned", portrait_consent: "granted", redistribution: "allowed" } };
  const partial = { rights: { copyright: "owned", portrait_consent: "granted" } };

  assert.equal(referenceRightsStatus(cleared), "cleared");
  assert.equal(isReferenceCleared(cleared), true);
  assert.equal(referenceRightsStatus(partial), "unresolved", "an unstated field keeps the reference unresolved");
});

test("an explicit refusal outranks an unknown field", () => {
  // Filling in the remaining fields later must not promote a refused reference,
  // so the denial has to win while other values are still unknown.
  const denied = { rights: { portrait_consent: "denied" } };
  const blocked = { rights: { copyright: "owned", redistribution: "forbidden" } };

  assert.equal(referenceRightsStatus(denied), "restricted");
  assert.equal(referenceRightsStatus(blocked), "restricted");
});

test("summarizeReferenceRights counts a mixed list without inspecting each entry", () => {
  const summary = summarizeReferenceRights([
    { rights: { copyright: "owned", portrait_consent: "granted", redistribution: "allowed" } },
    { rights: { portrait_consent: "denied" } },
    {},
    {},
  ]);

  assert.deepEqual(summary, { total: 4, cleared: 1, restricted: 1, unresolved: 2 });
  assert.deepEqual(summarizeReferenceRights(undefined), { total: 0, cleared: 0, restricted: 0, unresolved: 0 });
});

test("recording rights on a reference never changes the recipe digest", () => {
  // This is the load-bearing regression. Rights describe a reference; they are
  // not generation inputs. If annotating consent changed the digest, every
  // already-archived asset would sprout a spurious snapshot the first time
  // somebody recorded its permissions, and existing stored digests would stop
  // matching their own recipes.
  const bare = {
    id: "A",
    project_id: "p",
    prompt: "quiet window portrait",
    references: [{ asset_id: "R1", sha256: "ab", role: "identity", scope: ["SHOT_01"] }],
  };
  const annotated = {
    ...bare,
    references: [{
      asset_id: "R1",
      sha256: "ab",
      role: "identity",
      scope: ["SHOT_01"],
      allowed_uses: ["identity"],
      forbidden_uses: ["composition"],
      rights: { copyright: "owned", portrait_consent: "granted", redistribution: "forbidden", attribution: "Jane" },
    }],
  };

  const before = buildRecipeSnapshot(bare);
  const after = buildRecipeSnapshot(annotated);

  assert.equal(after.recipe_digest, before.recipe_digest);
  assert.equal(after.snapshot_id, before.snapshot_id);
  assert.equal(after.references[0].rights.attribution, "Jane", "the declaration is still stored");
  assert.deepEqual(after.references[0].forbidden_uses, ["composition"]);
});

test("a real generation-input change still changes the recipe digest", () => {
  const base = { id: "A", project_id: "p", prompt: "quiet window portrait" };

  assert.notEqual(
    buildRecipeSnapshot({ ...base, prompt: "a different photograph" }).recipe_digest,
    buildRecipeSnapshot(base).recipe_digest,
  );
  assert.notEqual(
    buildRecipeSnapshot({ ...base, references: [{ asset_id: "R1", role: "identity" }] }).recipe_digest,
    buildRecipeSnapshot(base).recipe_digest,
    "binding a reference is a generation-input change",
  );
});

test("enriching a reference cannot reorder the reference list", () => {
  // The list is sorted for canonicalisation. Sorting on the enriched shape
  // would let a rights annotation move an entry and change the digest through
  // ordering alone, so the sort has to use the digest shape.
  const references = [
    { asset_id: "R2", sha256: "ff", role: "style" },
    { asset_id: "R1", sha256: "ab", role: "identity" },
  ];
  const enriched = [
    { asset_id: "R2", sha256: "ff", role: "style", rights: { copyright: "owned" } },
    { asset_id: "R1", sha256: "ab", role: "identity", allowed_uses: ["zzz-last-alphabetically"] },
  ];

  const plain = buildRecipeSnapshot({ id: "A", project_id: "p", prompt: "x", references });
  const annotated = buildRecipeSnapshot({ id: "A", project_id: "p", prompt: "x", references: enriched });

  assert.deepEqual(annotated.references.map((item) => item.asset_id), plain.references.map((item) => item.asset_id));
  assert.equal(annotated.recipe_digest, plain.recipe_digest);
});

test("rights recorded after archival reach the stored snapshot instead of being deduplicated away", () => {
  // Rights are digest-inert, so an annotation appends no snapshot. Discarding
  // the rebuilt snapshot entirely left the stored one frozen at unknown, which
  // made the whole workflow write-only: the badge would report "unconfirmed"
  // forever and an explicit refusal would never surface.
  const asset = { id: "A", project_id: "p", prompt: "x", references: [{ asset_id: "R1", sha256: "ab", role: "identity" }] };
  const archived = appendRecipeSnapshot({}, asset);
  const annotated = appendRecipeSnapshot(archived, {
    ...asset,
    references: [{ asset_id: "R1", sha256: "ab", role: "identity", rights: { portrait_consent: "denied" } }],
  });

  assert.equal(annotated.recipe_snapshots.length, 1, "an annotation must not append a snapshot");
  assert.equal(annotated.recipe_snapshots[0].recipe_digest, archived.recipe_snapshots[0].recipe_digest);
  assert.equal(annotated.recipe_snapshots[0].references[0].rights.portrait_consent, "denied");
  assert.equal(referenceRightsStatus(annotated.recipe_snapshots[0].references[0]), "restricted");
});

test("refreshing rights matches references by identity, not by position", () => {
  // The canonical reference list is sorted, so a positional merge would move
  // one reference's rights onto another.
  const base = {
    id: "A",
    project_id: "p",
    prompt: "x",
    references: [{ asset_id: "R2", sha256: "ff", role: "style" }, { asset_id: "R1", sha256: "ab", role: "identity" }],
  };
  const archived = appendRecipeSnapshot({}, base);
  const annotated = appendRecipeSnapshot(archived, {
    ...base,
    references: [
      { asset_id: "R1", sha256: "ab", role: "identity", rights: { portrait_consent: "denied" } },
      { asset_id: "R2", sha256: "ff", role: "style" },
    ],
  });

  const byId = Object.fromEntries(annotated.recipe_snapshots[0].references.map((item) => [item.asset_id, item]));
  assert.equal(byId.R1.rights.portrait_consent, "denied");
  assert.equal(byId.R2.rights.portrait_consent, "unknown", "the untouched reference keeps its own rights");
});

test("a flat rights declaration is honoured whichever field carries it", () => {
  // An earlier gate keyed on `rights`/`consent` dropped a flat `redistribution`
  // while honouring a flat `copyright` whenever an unrelated `consent` key
  // happened to be present as well.
  const flat = ensureRecipeSnapshots({
    id: "B",
    project_id: "p",
    prompt: "x",
    references: [{ asset_id: "R", redistribution: "forbidden" }],
  });

  assert.equal(flat.recipe_snapshots[0].references[0].rights.redistribution, "forbidden");
  assert.equal(referenceRightsStatus(flat.recipe_snapshots[0].references[0]), "restricted");
});

test("a boolean portrait consent maps onto its own vocabulary", () => {
  // Consent has no allowed/forbidden pair. Dropping `false` to unknown would
  // demote an explicit refusal to merely unreviewed.
  assert.equal(normalizeReferenceRights({ portrait_consent: false }).portrait_consent, "denied");
  assert.equal(normalizeReferenceRights({ portrait_consent: true }).portrait_consent, "granted");
  assert.equal(referenceRightsStatus({ rights: { portrait_consent: false } }), "restricted");
  assert.equal(normalizeReferenceRights({ redistribution: false }).redistribution, "forbidden");
});

test("referenceRightsStatus reads a raw reference whose rights are still flat", () => {
  // The first caller to pass un-normalized asset.references must not silently
  // read a refusal as merely unresolved.
  assert.equal(referenceRightsStatus({ consent: "denied" }), "restricted");
  assert.equal(referenceRightsStatus({ rights: { portrait_consent: "denied" } }), "restricted");
});

test("every normalized reference carries the rights fields even when nothing was declared", () => {
  // Absent fields would make "nobody has recorded this yet" invisible in the
  // stored record; unknown values make it reviewable.
  const snapshot = buildRecipeSnapshot({ id: "A", project_id: "p", prompt: "x", references: ["R1"] });

  assert.deepEqual(snapshot.references[0].rights, defaultReferenceRights());
  assert.deepEqual(snapshot.references[0].allowed_uses, []);
  assert.deepEqual(snapshot.references[0].forbidden_uses, []);
  assert.equal(referenceRightsStatus(snapshot.references[0]), "unresolved");
});
