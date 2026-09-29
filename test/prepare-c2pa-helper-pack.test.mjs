import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareC2paHelperPack } from "../scripts/prepare-c2pa-helper-pack.mjs";
import { verifyC2paHelperPack } from "../lib/c2pa-helper-pack.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

test("C2PA helper preparation pins binary/license bytes and emits release-feed metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-c2pa-helper-prepare-"));
  const binary = join(root, "c2patool");
  const license = join(root, "LICENSE-MIT");
  const output = join(root, "pack");
  await writeFile(binary, "fake-c2patool-binary");
  await writeFile(license, "MIT license fixture");
  try {
    const result = await prepareC2paHelperPack({
      binaryPath: binary,
      version: "0.27.22",
      licenseFiles: [license],
      outputDir: output,
      platform: "darwin",
      arch: "arm64",
      probeRunner: async () => "c2patool 0.27.22",
    });
    assert.equal(result.pack.version, "0.27.22");
    assert.equal(result.pack.target, "darwin-arm64");
    assert.equal(result.release_manifest_patch.helperPacks.c2patool["darwin-arm64"].version, "0.27.22");
    assert.match(await readFile(join(output, "THIRD_PARTY_NOTICE.txt"), "utf8"), /unmodified upstream c2patool executable/i);
    const verified = await verifyC2paHelperPack({ packDir: output, platform: "darwin", arch: "arm64" });
    assert.equal(verified.files.some((entry) => entry.role === "license"), true);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("C2PA helper preparation rejects a binary whose probed version differs", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-c2pa-helper-version-"));
  const binary = join(root, "c2patool.exe");
  const license = join(root, "LICENSE-APACHE");
  await writeFile(binary, "fake-windows-binary");
  await writeFile(license, "Apache license fixture");
  try {
    await assert.rejects(() => prepareC2paHelperPack({
      binaryPath: binary,
      version: "0.27.22",
      licenseFiles: [license],
      outputDir: join(root, "pack"),
      platform: "win32",
      arch: "x64",
      probeRunner: async () => "0.27.21",
    }), /reports 0\.27\.21, expected 0\.27\.22/i);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});
