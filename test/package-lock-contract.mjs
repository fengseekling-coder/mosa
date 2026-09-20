import assert from "node:assert/strict";

export function assertPackageLockMatchesManifest(lockText, manifest, message = "package-lock.json must match package.json") {
  const lock = JSON.parse(lockText);
  const root = lock.packages?.[""];
  assert.ok(root && typeof root === "object", `${message}: root package entry is missing`);
  assert.equal(lock.name, manifest.name, `${message}: package name drift`);
  assert.equal(lock.version, manifest.version, `${message}: top-level version drift`);
  assert.equal(root.name, manifest.name, `${message}: root package name drift`);
  assert.equal(root.version, manifest.version, `${message}: root package version drift`);
  assert.deepEqual(root.dependencies || {}, manifest.dependencies || {}, `${message}: runtime dependency drift`);
  assert.deepEqual(root.devDependencies || {}, manifest.devDependencies || {}, `${message}: development dependency drift`);
  assert.equal(lock.lockfileVersion, 3, `${message}: unexpected lockfile format`);
}
