import assert from "node:assert/strict";
import { mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import test from "node:test";

import {
  C2PA_SIGNER_ALGORITHMS,
  preflightC2paProductionSigner,
  sanitizedSignerEnvironment,
  validateSignerExecutable,
} from "../lib/c2pa-production-signer.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

const TEST_CERTIFICATE = rootCertificates[0];

test("C2PA production signer preflight validates algorithm, certificate chain, TSA, and reserve size", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-c2pa-signer-"));
  const signer = join(root, "signer");
  await writeFile(signer, "fixture");
  try {
    const info = await preflightC2paProductionSigner({
      signerPath: signer,
      runner: async (executable, options) => {
        assert.equal(executable, await realpath(signer));
        assert.equal(options.env.C2PA_PRIVATE_KEY, undefined);
        return {
          stdout: JSON.stringify({
            alg: "es256",
            sign_cert: TEST_CERTIFICATE,
            tsa_url: "https://timestamp.example.invalid",
            reserve_size: 16384,
          }),
          stderr: "",
        };
      },
      env: { PATH: "/bin", C2PA_PRIVATE_KEY: "never-forward" },
    });
    assert.equal(info.ok, true);
    assert.equal(info.algorithm, "es256");
    assert.equal(info.certificate_chain_length, 1);
    assert.match(info.certificate_sha256, /^[0-9a-f]{64}$/u);
    assert.equal(info.tsa_url, "https://timestamp.example.invalid");
    assert.equal(info.reserve_size, 16384);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("C2PA production signer preflight rejects unsupported algorithms, HTTP TSA, and private-key leakage", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-c2pa-signer-invalid-"));
  const signer = join(root, "signer");
  await writeFile(signer, "fixture");
  try {
    await assert.rejects(() => preflightC2paProductionSigner({
      signerPath: signer,
      runner: async () => ({ stdout: JSON.stringify({ alg: "hs256", sign_cert: TEST_CERTIFICATE }), stderr: "" }),
    }), (error) => error?.code === "C2PA_SIGNER_ALGORITHM_UNSUPPORTED");

    await assert.rejects(() => preflightC2paProductionSigner({
      signerPath: signer,
      runner: async () => ({ stdout: JSON.stringify({ alg: "es256", sign_cert: TEST_CERTIFICATE, tsa_url: "http://timestamp.invalid" }), stderr: "" }),
    }), (error) => error?.code === "C2PA_SIGNER_TSA_URL_INVALID");

    await assert.rejects(() => preflightC2paProductionSigner({
      signerPath: signer,
      runner: async () => ({
        stdout: JSON.stringify({ alg: "es256", sign_cert: TEST_CERTIFICATE }),
        stderr: "-----BEGIN PRIVATE KEY-----\nleak\n-----END PRIVATE KEY-----",
      }),
    }), (error) => error?.code === "C2PA_SIGNER_PRIVATE_KEY_LEAK");
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("C2PA production signer path must be absolute, regular, non-symlink, and command-string safe", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-c2pa-signer-path-"));
  const signer = join(root, "signer");
  const spaced = join(root, "signer with spaces");
  const link = join(root, "signer-link");
  await writeFile(signer, "fixture");
  await writeFile(spaced, "fixture");
  try {
    await assert.rejects(() => validateSignerExecutable("relative-signer"), (error) => error?.code === "C2PA_SIGNER_PATH_NOT_ABSOLUTE");
    await assert.rejects(() => validateSignerExecutable(spaced), (error) => error?.code === "C2PA_SIGNER_PATH_WHITESPACE_UNSUPPORTED");
    if (process.platform !== "win32") {
      await symlink(signer, link);
      await assert.rejects(() => validateSignerExecutable(link), (error) => error?.code === "C2PA_SIGNER_SYMLINK_REJECTED");
    } else {
      t.diagnostic("symlink rejection covered on non-Windows hosts");
    }
    assert.equal(await validateSignerExecutable(signer), await realpath(signer));
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("C2PA signer environment strips all c2patool local-key channels", () => {
  assert.deepEqual(sanitizedSignerEnvironment({
    PATH: "/bin",
    C2PA_PRIVATE_KEY: "secret",
    C2PA_SIGN_CERT: "cert",
    C2PATOOL_SETTINGS: "settings.toml",
    MOSA_SIGNER_PROFILE: "production",
  }), {
    PATH: "/bin",
    MOSA_SIGNER_PROFILE: "production",
  });
  assert.deepEqual(C2PA_SIGNER_ALGORITHMS, ["ps256", "ps384", "ps512", "es256", "es384", "es512", "ed25519"]);
});
