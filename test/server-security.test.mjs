import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedLocalOrigin, resolveAllowedFolderPath } from "../lib/server-security.mjs";

test("allows only same-origin browser requests", () => {
  assert.equal(isAllowedLocalOrigin(undefined, 43517), true);
  assert.equal(isAllowedLocalOrigin("http://127.0.0.1:43517", 43517), true);
  assert.equal(isAllowedLocalOrigin("http://localhost:43517", 43517), true);
  assert.equal(isAllowedLocalOrigin("https://example.com", 43517), false);
  assert.equal(isAllowedLocalOrigin("null", 43517), false);
});

test("resolves only allowed Finder paths", () => {
  const allowedPaths = ["/workspace/mosa", "/workspace/mosa/assets/default"];
  assert.equal(resolveAllowedFolderPath("/workspace/mosa/assets/default", allowedPaths), "/workspace/mosa/assets/default");
  assert.equal(resolveAllowedFolderPath("/workspace/mosa/assets/default/images", allowedPaths), "/workspace/mosa/assets/default/images");
  assert.equal(resolveAllowedFolderPath("/workspace-other", allowedPaths), null);
  assert.equal(resolveAllowedFolderPath("/workspace/mosa/../secret", allowedPaths), null);
  assert.equal(resolveAllowedFolderPath("", allowedPaths), null);
});
