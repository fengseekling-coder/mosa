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
  const allowedPaths = ["/workspace/asset-manager", "/workspace/asset-manager/assets/default"];
  assert.equal(resolveAllowedFolderPath("/workspace/asset-manager/assets/default", allowedPaths), "/workspace/asset-manager/assets/default");
  assert.equal(resolveAllowedFolderPath("/workspace/asset-manager/assets/default/images", allowedPaths), "/workspace/asset-manager/assets/default/images");
  assert.equal(resolveAllowedFolderPath("/workspace-other", allowedPaths), null);
  assert.equal(resolveAllowedFolderPath("/workspace/asset-manager/../secret", allowedPaths), null);
  assert.equal(resolveAllowedFolderPath("", allowedPaths), null);
});
