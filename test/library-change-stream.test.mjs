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
  let revision = "sqlite:1:0";
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

  revision = "sqlite:1:1";
  await stream.checkNow("default");
  assert.match(res.chunks.join(""), /event: library-changed/);
  assert.match(res.chunks.join(""), /sqlite:1:1/);
});
