import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { removeTestPath as rm } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isAllowedIngestOrigin, isAllowedLocalOrigin, isApprovedExtensionOrigin, parseAllowedIngestOrigins, resolveAllowedFolderPath } from "../lib/server-security.js";

test("allows only same-origin browser requests", () => {
  assert.equal(isAllowedLocalOrigin(undefined, 43517), true);
  assert.equal(isAllowedLocalOrigin("http://127.0.0.1:43517", 43517), true);
  assert.equal(isAllowedLocalOrigin("http://localhost:43517", 43517), true);
  assert.equal(isAllowedLocalOrigin("https://example.com", 43517), false);
  assert.equal(isAllowedLocalOrigin("null", 43517), false);
});

test("allows only explicitly configured extension origins for ingest", () => {
  const allowed = parseAllowedIngestOrigins("chrome-extension://approved, moz-extension://firefox, https://example.com");
  assert.deepEqual(allowed, ["chrome-extension://approved", "moz-extension://firefox"]);
  assert.equal(isAllowedIngestOrigin("chrome-extension://approved", 43517, allowed), true);
  assert.equal(isAllowedIngestOrigin("moz-extension://firefox", 43517, allowed), true);
  assert.equal(isAllowedIngestOrigin("chrome-extension://other", 43517, allowed), false);
  assert.equal(isAllowedIngestOrigin("https://chatgpt.com", 43517, allowed), false);
  assert.equal(isAllowedLocalOrigin("chrome-extension://id", 43517), false);
  assert.equal(isApprovedExtensionOrigin("chrome-extension://approved", allowed), true);
  assert.equal(isApprovedExtensionOrigin(undefined, allowed), false);
  assert.equal(isApprovedExtensionOrigin("http://127.0.0.1:43517", allowed), false);
});

test("resolves only real paths inside allowed Finder roots and rejects symlink escapes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-server-security-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const allowedRoot = join(root, "mosa");
  const nested = join(allowedRoot, "assets", "default", "images");
  const outside = join(root, "secret");
  await mkdir(nested, { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(allowedRoot, "escape-link"));

  const allowedPaths = [allowedRoot, join(allowedRoot, "assets", "default")];
  assert.equal(resolveAllowedFolderPath(join(allowedRoot, "assets", "default"), allowedPaths), await realpath(join(allowedRoot, "assets", "default")));
  assert.equal(resolveAllowedFolderPath(nested, allowedPaths), await realpath(nested));
  assert.equal(resolveAllowedFolderPath(outside, allowedPaths), null);
  assert.equal(resolveAllowedFolderPath(join(allowedRoot, "..", "secret"), allowedPaths), null);
  assert.equal(resolveAllowedFolderPath(join(allowedRoot, "escape-link"), allowedPaths), null);
  assert.equal(resolveAllowedFolderPath("", allowedPaths), null);
});

test("keeps copied library images available to both gallery and inspector", async () => {
  const runtime = await readFile(resolve(import.meta.dirname, "..", "lib", "mosa-runtime.mjs"), "utf8");
  assert.match(runtime, /Cache-Control", "private, max-age=31536000, immutable"/);
});
