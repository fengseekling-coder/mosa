import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  C2PA_HELPER_PACK_MANIFEST,
  c2paHelperPackRoot,
  c2paHelperTarget,
  discoverC2paHelperPacks,
  resolveInstalledC2paToolPath,
  validateC2paHelperPackManifest,
  verifyC2paHelperPack,
} from "../lib/c2pa-helper-pack.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture(target = "darwin-arm64", version = "0.27.22") {
  const executable = target === "win32-x64" ? "bin/c2patool.exe" : "bin/c2patool";
  const binary = Buffer.from(`c2patool-${version}-${target}`);
  const notice = Buffer.from("c2patool is provided under MIT OR Apache-2.0.\n");
  const files = [
    { path: executable, role: "executable", bytes: binary.length, sha256: sha256(binary) },
    { path: "THIRD_PARTY_NOTICE.txt", role: "notice", bytes: notice.length, sha256: sha256(notice) },
  ];
  const manifest = {
    schema: "mosa.c2pa-helper-pack/1",
    id: "c2patool",
    version,
    target,
    executable,
    upstream: `https://github.com/contentauth/c2pa-rs/releases/tag/c2patool-v${version}`,
    license: { id: "MIT OR Apache-2.0", source: "https://github.com/contentauth/c2pa-rs" },
    files,
  };
  return { manifest, files: new Map([[executable, binary], ["THIRD_PARTY_NOTICE.txt", notice]]) };
}

test("C2PA helper manifest is target-bound and requires pinned executable plus license material", () => {
  const parsed = validateC2paHelperPackManifest(fixture().manifest);
  assert.equal(parsed.id, "c2patool");
  assert.equal(parsed.version, "0.27.22");
  assert.equal(parsed.target, "darwin-arm64");
  assert.equal(parsed.executable, "bin/c2patool");
  assert.throws(() => validateC2paHelperPackManifest({
    ...fixture().manifest,
    executable: "../c2patool",
  }), /path must be relative|traversal/i);
  assert.throws(() => validateC2paHelperPackManifest({
    ...fixture().manifest,
    files: fixture().manifest.files.filter((entry) => entry.role !== "notice"),
  }), /2-8 files|license or notice/i);
});

test("C2PA helper pack verification pins every file and resolves installed executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-c2pa-helper-pack-"));
  const userDataDir = join(root, "userdata");
  const target = c2paHelperTarget() || "darwin-arm64";
  const pack = fixture(target);
  const packDir = join(c2paHelperPackRoot(userDataDir), `${pack.manifest.version}-${target}`);
  await mkdir(join(packDir, "bin"), { recursive: true });
  for (const [relativePath, bytes] of pack.files) {
    await mkdir(join(packDir, relativePath, ".."), { recursive: true });
    await writeFile(join(packDir, relativePath), bytes);
  }
  await writeFile(join(packDir, C2PA_HELPER_PACK_MANIFEST), `${JSON.stringify(pack.manifest, null, 2)}\n`);
  try {
    const verified = await verifyC2paHelperPack({
      packDir,
      platform: target === "win32-x64" ? "win32" : "darwin",
      arch: target === "win32-x64" ? "x64" : "arm64",
    });
    assert.equal(verified.version, "0.27.22");
    assert.match(verified.executable_path, /c2patool(?:\.exe)?$/u);

    const discovery = await discoverC2paHelperPacks({
      userDataDir,
      platform: target === "win32-x64" ? "win32" : "darwin",
      arch: target === "win32-x64" ? "x64" : "arm64",
    });
    assert.equal(discovery.packs.length, 1);
    if (c2paHelperTarget()) {
      assert.equal(await resolveInstalledC2paToolPath({ userDataDir }), discovery.packs[0].executable_path);
    }
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("C2PA helper verifier detects tampered executable bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-c2pa-helper-tamper-"));
  const pack = fixture("win32-x64");
  const packDir = join(root, "pack");
  await mkdir(join(packDir, "bin"), { recursive: true });
  await writeFile(join(packDir, "bin", "c2patool.exe"), "tampered");
  await writeFile(join(packDir, "THIRD_PARTY_NOTICE.txt"), pack.files.get("THIRD_PARTY_NOTICE.txt"));
  await writeFile(join(packDir, C2PA_HELPER_PACK_MANIFEST), JSON.stringify(pack.manifest));
  try {
    await assert.rejects(() => verifyC2paHelperPack({ packDir, platform: "win32", arch: "x64" }), /size mismatch|SHA-256 mismatch/i);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});
