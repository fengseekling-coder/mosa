import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createLibraryChangeStream } from "../lib/library-change-stream.mjs";

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = new Map();
    this.chunks = [];
    this.writableEnded = false;
    this.destroyed = false;
    this.statusCode = 0;
  }
  setHeader(name, value) { this.headers.set(String(name).toLowerCase(), value); }
  write(chunk) { this.chunks.push(String(chunk)); return true; }
  end() { this.writableEnded = true; this.emit("close"); }
}

test("library change stream pushes a revision change to connected clients", async (t) => {
  let revision = "1:0";
  const stream = createLibraryChangeStream({
    store: {
      projectId: (value) => String(value || "default"),
      libraryRevision: async () => revision,
    },
    checkIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
  });
  t.after(() => stream.close());

  const req = new EventEmitter();
  const res = new FakeResponse();
  await stream.attach(req, res, "default");
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.match(res.chunks.join(""), /event: ready/);

  revision = "1:1";
  await stream.checkNow("default");
  assert.match(res.chunks.join(""), /event: library-changed/);
  assert.match(res.chunks.join(""), /"revision":"1:1"/);
  // 无 journal 能力的 store：事件退化为纯 revision 通知，客户端走 delta API。
  assert.doesNotMatch(res.chunks.join(""), /"changes"/);
});

test("library change stream attaches the journaled delta to library-changed events", async (t) => {
  let revision = 10;
  const journal = new Map([
    [11, [{ revision: 11, kind: "asset-added", entityType: "asset", entityId: "a1" }]],
    [12, [{ revision: 12, kind: "asset-updated", entityType: "asset", entityId: "a2" }]],
  ]);
  const stream = createLibraryChangeStream({
    store: {
      projectId: (value) => String(value || "default"),
      libraryRevision: async () => String(revision),
      listLibraryChangesSince: async (projectId, since) => {
        const changes = [];
        for (let next = since + 1; next <= revision; next += 1) {
          if (journal.has(next)) changes.push(...journal.get(next));
        }
        return { sinceRevision: since, currentRevision: revision, oldestRevision: 1, complete: true, changes };
      },
    },
    checkIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
  });
  t.after(() => stream.close());

  const req = new EventEmitter();
  const res = new FakeResponse();
  await stream.attach(req, res, "default");

  const parseEvents = () => res.chunks.join("").split("event: ").slice(1).map((entry) => (
    JSON.parse(entry.slice(entry.indexOf("data: ") + 6).split("\n\n")[0])
  ));

  revision = 11;
  await stream.checkNow("default");
  let payload = parseEvents().find((event) => event.changes);
  assert.equal(payload.fromRevision, "10");
  assert.equal(payload.complete, true);
  assert.deepEqual(payload.changes.map((change) => change.kind), ["asset-added"]);

  revision = 12;
  await stream.checkNow("default");
  payload = parseEvents().filter((event) => event.changes).at(-1);
  assert.equal(payload.fromRevision, "11");
  assert.deepEqual(payload.changes.map((change) => change.kind), ["asset-updated"]);
});
