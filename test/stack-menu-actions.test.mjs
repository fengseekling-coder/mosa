import assert from "node:assert/strict";
import test from "node:test";

import { createContextMenuActions } from "../app/context-menu-actions.mjs";

/**
 * Behavioral tests for the collapsed-Stack context-menu mutations. The factory
 * receives stubbed collaborators so the real action bodies run end to end —
 * including how a 207 partial /api/assets/batch response is reported.
 */

const PARAMETERIZED_T = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key);

function createHarness(t, { batchResponses = [], stackMembers = [] } = {}) {
  const calls = [];
  const toasts = [];
  const dispatched = [];
  const originalWindow = globalThis.window;
  let batchCallIndex = 0;

  function apiFetch(url, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    calls.push({ url, method, body: options.body });
    if (method === "GET" && url.includes("/api/asset-stacks/") && url.includes("/assets?")) {
      return { assets: [...stackMembers], page: { total: stackMembers.length, nextCursor: null } };
    }
    if (method === "POST" && url === "/api/assets/batch") {
      const response = batchResponses[Math.min(batchCallIndex, batchResponses.length - 1)];
      batchCallIndex += 1;
      if (!response) throw new Error(`unexpected extra batch call #${batchCallIndex}`);
      if (response instanceof Error) throw response;
      return response;
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }

  globalThis.window = { dispatchEvent: (event) => dispatched.push(event) };
  t.after(() => { globalThis.window = originalWindow; });

  const actions = createContextMenuActions({
    state: { project: "default", assets: [], scope: "all", groups: { groups: [] }, selectedId: null },
    els: {},
    t: PARAMETERIZED_T,
    apiClient: { apiFetch },
    showToast: (message, tone = "default") => toasts.push({ message, tone }),
    runAction: async (action) => {
      try {
        await action();
      } catch (error) {
        toasts.push({ message: error?.message || String(error), tone: "error" });
      }
    },
    requestConfirmation: async () => true,
    requestFollowupConfirmation: async () => true,
    confirmDetailNavigation: async () => true,
    discardDetailDraft() {},
    gallerySelection: {},
  });

  function stackMenu(stack = { id: "stack-1", count: stackMembers.length, name: "" }) {
    const asset = { id: "cover-1", project_id: "default", stack };
    return actions.getAssetMenu(asset, [], { stackNode: true, selectionCount: 1 });
  }

  return { actions, calls, toasts, dispatched, stackMenu };
}

function moveToTrashItem(menu) {
  const item = menu.find((entry) => entry?.label === PARAMETERIZED_T("moveToTrash"));
  assert.ok(item, "menu must contain the moveToTrash action");
  assert.equal(item.danger, true, "moveToTrash keeps the shared danger styling");
  return item;
}

function refreshEvents(dispatched) {
  return dispatched.filter((event) => event.type === "mosa:refresh-assets");
}

test("stack trash reports the full-success toast and refreshes with every member id", async (t) => {
  const harness = createHarness(t, {
    stackMembers: [{ id: "a" }, { id: "b" }, { id: "c" }],
    batchResponses: [{ results: [{ id: "a", trashed: true }, { id: "b", trashed: true }, { id: "c", trashed: true }] }],
  });

  await moveToTrashItem(harness.stackMenu()).action();

  const batchCalls = harness.calls.filter((call) => call.url === "/api/assets/batch");
  assert.equal(batchCalls.length, 1);
  assert.deepEqual(batchCalls[0].body, { action: "trash", projectId: "default", assetIds: ["a", "b", "c"] });
  assert.deepEqual(harness.toasts, [{ message: PARAMETERIZED_T("stackMovedToTrash", { count: 3 }), tone: "success" }]);
  assert.deepEqual(refreshEvents(harness.dispatched).at(-1)?.detail?.removedAssetIds, ["a", "b", "c"]);
});

test("a 207 partial stack trash never claims full success and refreshes only succeeded ids", async (t) => {
  const harness = createHarness(t, {
    stackMembers: [{ id: "a" }, { id: "b" }],
    batchResponses: [{
      partial: true,
      results: [{ id: "a", trashed: true }, { id: "b", ok: false, code: "VERSION_PARENT_HAS_CHILDREN" }],
    }],
  });

  await moveToTrashItem(harness.stackMenu()).action();

  assert.deepEqual(harness.toasts, [{
    message: PARAMETERIZED_T("batchPartialResult", { succeeded: 1, failed: 1 }),
    tone: "error",
  }], "a partial failure must show the succeeded/failed counts instead of the success toast");
  assert.ok(harness.toasts.every((toast) => !toast.message.startsWith("stackMovedToTrash")),
    "the whole-stack success toast must not appear on partial failure");
  assert.deepEqual(refreshEvents(harness.dispatched).at(-1)?.detail?.removedAssetIds, ["a"],
    "only succeeded members are reconciled out of the gallery");
});

test("stack trash chunks member batches at the server's 1000-id cap", async (t) => {
  const members = Array.from({ length: 1001 }, (_, index) => ({ id: `asset-${index}` }));
  const success = (ids) => ({ results: ids.map((id) => ({ id, trashed: true })) });
  const harness = createHarness(t, {
    stackMembers: members,
    batchResponses: [success(members.slice(0, 1000).map((member) => member.id)), success(["asset-1000"])],
  });

  await moveToTrashItem(harness.stackMenu()).action();

  const batchCalls = harness.calls.filter((call) => call.url === "/api/assets/batch");
  assert.equal(batchCalls.length, 2);
  assert.equal(batchCalls[0].body.assetIds.length, 1000);
  assert.deepEqual(batchCalls[1].body.assetIds, ["asset-1000"]);
  assert.deepEqual(harness.toasts, [{ message: PARAMETERIZED_T("stackMovedToTrash", { count: 1001 }), tone: "success" }]);
});

test("stack trash preserves confirmed progress when a later batch request becomes unresolved", async (t) => {
  const members = Array.from({ length: 1001 }, (_, index) => ({ id: `asset-${index}` }));
  const firstChunk = members.slice(0, 1000).map((member) => member.id);
  const harness = createHarness(t, {
    stackMembers: members,
    batchResponses: [
      { results: firstChunk.map((id) => ({ id, trashed: true })) },
      new Error("connection reset after request write"),
    ],
  });

  await moveToTrashItem(harness.stackMenu()).action();

  const batchCalls = harness.calls.filter((call) => call.url === "/api/assets/batch");
  assert.equal(batchCalls.length, 2);
  assert.deepEqual(harness.toasts, [{
    message: PARAMETERIZED_T("stackTrashInterrupted", { succeeded: 1000, failed: 0, unresolved: 1 }),
    tone: "error",
  }]);
  assert.deepEqual(refreshEvents(harness.dispatched).at(-1)?.detail?.removedAssetIds, firstChunk,
    "already-confirmed mutations are reconciled even when a later request outcome is unknown");
  assert.equal(refreshEvents(harness.dispatched).at(-1)?.detail?.projectId, "default");
});

test("a failed member fetch surfaces the error and dispatches no refresh", async (t) => {
  const originalWindow = globalThis.window;
  const dispatched = [];
  globalThis.window = { dispatchEvent: (event) => dispatched.push(event) };
  t.after(() => { globalThis.window = originalWindow; });

  const calls = [];
  const toasts = [];
  const actions = createContextMenuActions({
    state: { project: "default", assets: [], scope: "all", groups: { groups: [] }, selectedId: null },
    els: {},
    t: PARAMETERIZED_T,
    apiClient: {
      apiFetch: async (url) => {
        calls.push(url);
        if (url.includes("/assets?")) throw new Error("network gone");
        throw new Error(`unexpected fetch: ${url}`);
      },
    },
    showToast: (message, tone = "default") => toasts.push({ message, tone }),
    runAction: async (action) => {
      try {
        await action();
      } catch (error) {
        toasts.push({ message: error?.message || String(error), tone: "error" });
      }
    },
    requestConfirmation: async () => true,
    gallerySelection: {},
  });

  const asset = { id: "cover-1", project_id: "default", stack: { id: "stack-1", count: 2, name: "" } };
  const menu = actions.getAssetMenu(asset, [], { stackNode: true, selectionCount: 1 });
  await menu.find((entry) => entry?.label === "moveToTrash").action();

  assert.deepEqual(toasts, [{ message: "network gone", tone: "error" }]);
  assert.deepEqual(dispatched.filter((event) => event.type === "mosa:refresh-assets"), [],
    "no gallery refresh is dispatched when the member manifest never loaded");
});
