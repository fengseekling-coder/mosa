// Real installation rehearsals for the Windows update helper, mirroring
// test/macos-updater-install-rehearsal.test.mjs. They build fake portable
// installs and update ZIPs (the payload executable is a tiny C# binary
// compiled on the fly with Add-Type), and run the generated apply-update.ps1
// end-to-end. Authenticode verification runs against a stub probe passed to
// launchWindowsUpdateHelper as the signatureProbe option, which becomes the
// -SignatureProbe script parameter — deliberately not an environment variable,
// because the helper is started through Win32_Process.Create and inherits the
// registry environment, not the caller's. The fake binary reads its behavior
// (readyJson / launchLog) from a mosa-fake-config.json next to itself for the
// same reason. Everything lives in per-test temp directories; no real install,
// library, or userData is touched.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { launchWindowsUpdateHelper } from "../desktop/windows-updater.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

const execFileAsync = promisify(execFile);

const MAY_RUN_HERE = process.platform === "win32";
const scope = MAY_RUN_HERE ? test : test.skip;

const VERSION = "0.3.0";
const GIT_SHA = "a".repeat(40);
const UI_FINGERPRINT = "b".repeat(64);
const RUNTIME_FINGERPRINT = "c".repeat(64);

const THUMBPRINT_RENEWED = "AB12CD34AB12CD34AB12CD34AB12CD34AB12CD34";
const THUMBPRINT_PREVIOUS = "000102030405060708090A0B0C0D0E0F10111213";
const THUMBPRINT_OTHER = "FEDCBA9876543210FEDCBA9876543210FEDCBA98";
const SUBJECT_PUBLISHER = "CN=MOSA Publisher, O=MOSA, C=DE";
const SUBJECT_OTHER = "CN=Other Publisher, O=Other, C=DE";

const FAKE_CONFIG_NAME = "mosa-fake-config.json";

// A tiny console app. It logs every launch (launch-log entries are the
// bracketed argument list, so a relaunch without arguments shows as "[]") and,
// when its config carries a non-null readyJson, writes that JSON into the file
// given by the --mosa-update-ready-file argument. All behavior comes from
// mosa-fake-config.json next to the executable — never from environment
// variables, which a Start-Process-launched GUI child would inherit from the
// helper's registry-built environment rather than the test's.
const FAKE_EXE_SOURCE = [
  "using System;",
  "using System.IO;",
  "using System.Text;",
  "public static class MosaFakeApp {",
  "  public static string ExtractJsonString(string json, string field) {",
  "    string key = \"\\\"\" + field + \"\\\"\";",
  "    int keyIdx = json.IndexOf(key, StringComparison.Ordinal);",
  "    if (keyIdx < 0) return null;",
  "    int i = json.IndexOf(':', keyIdx + key.Length);",
  "    if (i < 0) return null;",
  "    i++;",
  "    while (i < json.Length && char.IsWhiteSpace(json[i])) i++;",
  "    if (i >= json.Length || json[i] != '\"') return null;",
  "    i++;",
  "    StringBuilder sb = new StringBuilder();",
  "    while (i < json.Length && json[i] != '\"') {",
  "      if (json[i] == '\\\\' && i + 1 < json.Length) {",
  "        char c = json[i + 1];",
  "        if (c == '\"') sb.Append('\"');",
  "        else if (c == '\\\\') sb.Append('\\\\');",
  "        else if (c == 'n') sb.Append('\\n');",
  "        else if (c == 'r') sb.Append('\\r');",
  "        else if (c == 't') sb.Append('\\t');",
  "        else sb.Append(c);",
  "        i += 2;",
  "      } else {",
  "        sb.Append(json[i]);",
  "        i++;",
  "      }",
  "    }",
  "    return sb.ToString();",
  "  }",
  "  public static int Main(string[] args) {",
  "    string configPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, \"" + FAKE_CONFIG_NAME + "\");",
  "    string readyBody = null;",
  "    string launchLog = null;",
  "    if (File.Exists(configPath)) {",
  "      string json = File.ReadAllText(configPath);",
  "      readyBody = ExtractJsonString(json, \"readyJson\");",
  "      launchLog = ExtractJsonString(json, \"launchLog\");",
  "    }",
  "    if (!string.IsNullOrEmpty(launchLog)) {",
  "      try { File.AppendAllText(launchLog, \"[\" + String.Join(\"|\", args) + \"]\" + Environment.NewLine); } catch {}",
  "    }",
  "    string prefix = \"--mosa-update-ready-file=\";",
  "    string ready = null;",
  "    foreach (string a in args) {",
  "      if (a != null && a.StartsWith(prefix, StringComparison.Ordinal)) {",
  "        ready = a.Substring(prefix.Length).Trim('\"');",
  "      }",
  "    }",
  "    if (ready != null && !string.IsNullOrEmpty(readyBody)) {",
  "      File.WriteAllText(ready, readyBody);",
  "    }",
  "    return 0;",
  "  }",
  "}",
].join("\n");

function encodePowerShellCommand(command) {
  return Buffer.from(String(command || ""), "utf16le").toString("base64");
}

function psLiteral(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

async function runPowerShell(command, timeoutMs = 120_000) {
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", encodePowerShellCommand(command),
  ], { windowsHide: true, timeout: timeoutMs });
}

// Compiled once per process and copied everywhere; compilation takes a couple
// of seconds and every scenario needs the same binary behavior.
let fakeExeSource = null;
async function compileFakeExe(root) {
  const exePath = join(root, "MosaFakeApp.exe");
  await runPowerShell([
    `$source = @'`,
    FAKE_EXE_SOURCE,
    `'@`,
    `Add-Type -TypeDefinition $source -OutputAssembly ${psLiteral(exePath)} -OutputType ConsoleApplication`,
  ].join("\n"));
  return exePath;
}

async function sharedFakeExe() {
  if (!fakeExeSource) fakeExeSource = await compileFakeExe(await mkdtemp(join(tmpdir(), "mosa-rehearsal-exe-")));
  return fakeExeSource;
}

if (MAY_RUN_HERE) {
  test.after(async () => {
    // The shared compile output is only ever copied, never executed; every
    // launched binary lives in a per-test temp directory removed separately.
    if (fakeExeSource) await removeTestPath(dirname(fakeExeSource), { recursive: true, force: true });
  });
}

// The install carries its own fake config: the previous app logs relaunches
// (that is how the rollback path proves it reopened the old exe) and never
// reports readiness itself (readyJson: null).
async function makeInstallDir({ root, exeSource, name = "MOSA.exe", marker, launchLog = null }) {
  const installDir = join(root, "install", "MOSA-win32-x64");
  await mkdir(join(installDir, "resources"), { recursive: true });
  await copyFile(exeSource, join(installDir, name));
  await writeFile(join(installDir, "resources", "version-marker"), marker, "utf8");
  await writeFile(join(installDir, FAKE_CONFIG_NAME), JSON.stringify({ readyJson: null, launchLog }), "utf8");
  return installDir;
}

// layout "flat" zips the payload contents at the archive root; layout "nested"
// wraps them in a <stem>\ directory the way the real update ZIPs are built.
// The payload's fake config travels inside the package (readyJson decides
// whether the replacement reports readiness; null exercises the rollback).
async function makePayloadZip({ root, exeSource, stem, payloadExeName, marker, layout, readyBody = null, launchLog = null, extraFiles = [] }) {
  const payloadRoot = join(root, "payload");
  const contentRoot = layout === "nested" ? join(payloadRoot, stem) : payloadRoot;
  await mkdir(join(contentRoot, "resources"), { recursive: true });
  await copyFile(exeSource, join(contentRoot, payloadExeName));
  await writeFile(join(contentRoot, "resources", "version-marker"), marker, "utf8");
  await writeFile(join(contentRoot, FAKE_CONFIG_NAME), JSON.stringify({ readyJson: readyBody, launchLog }), "utf8");
  for (const extra of extraFiles) {
    await writeFile(join(contentRoot, extra.name), extra.body, "utf8");
  }
  const zipPath = join(root, "downloads", `${stem}-${VERSION}.zip`);
  await mkdir(dirname(zipPath), { recursive: true });
  const source = layout === "nested" ? join(payloadRoot, stem) : join(payloadRoot, "*");
  await runPowerShell(`Compress-Archive -Path ${psLiteral(source)} -DestinationPath ${psLiteral(zipPath)} -Force`);
  return zipPath;
}

// The probe answers with the first matching -like rule, defaulting to
// NotSigned. Paths under the transaction's extracted payload match the
// wildcard rule because the transaction directory name contains a random GUID.
async function writeSignatureProbe(root, rules) {
  const lines = [
    "$candidates = @(",
    ...rules.map((rule) => `  @{ Like = ${psLiteral(rule.like)}; Status = ${psLiteral(rule.status || "Valid")}; Thumbprint = ${psLiteral(rule.thumbprint || "")}; Subject = ${psLiteral(rule.subject || "")} },`),
    ")",
    "foreach ($candidate in $candidates) {",
    "  if ($args[0] -like $candidate.Like) {",
    "    Write-Output ('Status=' + $candidate.Status)",
    "    Write-Output ('Thumbprint=' + $candidate.Thumbprint)",
    "    Write-Output ('Subject=' + $candidate.Subject)",
    "    exit 0",
    "  }",
    "}",
    "Write-Output 'Status=NotSigned'",
    "Write-Output 'Thumbprint='",
    "Write-Output 'Subject='",
    "exit 0",
  ];
  const probePath = join(root, "sig-probe.ps1");
  await writeFile(probePath, lines.join("\n"), "utf8");
  return probePath;
}

function identity(distribution) {
  return { gitSha: GIT_SHA, uiFingerprint: UI_FINGERPRINT, runtimeFingerprint: RUNTIME_FINGERPRINT, distribution };
}

function readyJson(distribution) {
  return JSON.stringify({ version: VERSION, gitSha: GIT_SHA, uiFingerprint: UI_FINGERPRINT, runtimeFingerprint: RUNTIME_FINGERPRINT, distribution });
}

async function launchHelper({ root, signatureProbe = "", installDir, zipPath, currentExeName, payloadExeName, signerThumbprint = "", distribution = "preview" }) {
  // The helper only waits for this PID to exit; a real update quits the app,
  // which the rehearsal simulates with a short-lived Node child.
  const target = spawn(process.execPath, ["-e", "setTimeout(() => {}, 400)"], { stdio: "ignore" });
  return launchWindowsUpdateHelper({
    zipPath,
    installDir,
    currentExeName,
    payloadExeName,
    signerThumbprint,
    signatureProbe,
    version: VERSION,
    expectedIdentity: identity(distribution),
    processId: target.pid,
  });
}

async function waitFor(predicate, { timeoutMs = 45_000, stepMs = 150, label } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveStep) => setTimeout(resolveStep, stepMs));
  }
  throw new Error(`Rehearsal timed out waiting for ${label}`);
}

function markerOf(installDir) {
  // The replacement window briefly has no directory at the install path; the
  // polling predicates treat null as "not yet".
  try {
    return readFileSync(join(installDir, "resources", "version-marker"), "utf8");
  } catch {
    return null;
  }
}

function launchLogEntries(launchLog) {
  try {
    return readFileSync(launchLog, "utf8").split(/\r?\n/).filter((line) => line.startsWith("["));
  } catch {
    return [];
  }
}

scope("rehearsal: same-name preview update installs the flat payload in place", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-rehearsal-win-same-"));
  const exeSource = await sharedFakeExe();
  try {
    const launchLog = join(root, "launch.log");
    const installDir = await makeInstallDir({ root, exeSource, marker: "old", launchLog });
    const zipPath = await makePayloadZip({ root, exeSource, stem: "MOSA-win32-x64", payloadExeName: "MOSA.exe", marker: "new", layout: "flat", readyBody: readyJson("preview"), launchLog });
    const { readyFile, logPath } = await launchHelper({
      root,
      installDir,
      zipPath,
      currentExeName: "MOSA.exe",
      payloadExeName: "MOSA.exe",
    });

    await waitFor(() => markerOf(installDir) === "new", { label: "same-name success (replacement installed)" });
    assert.equal(existsSync(join(installDir, "MOSA.exe")), true);
    assert.equal(existsSync(join(installDir, "GravityPort.exe")), false);
    assert.equal(existsSync(logPath), false, `helper failure log must be absent, got: ${existsSync(logPath) ? readFileSync(logPath, "utf8") : ""}`);
    assert.equal(existsSync(readyFile), true, "the replacement reports readiness into the userData staging root");
    assert.equal(JSON.parse(readFileSync(readyFile, "utf8")).version, VERSION);
    // The relaunched replacement reports readiness; the previous app quit for
    // the update and is not relaunched on success.
    const entries = launchLogEntries(launchLog);
    assert.equal(entries.length, 1, `expected one relaunch entry, got: ${JSON.stringify(entries)}`);
    assert.equal(entries[0].startsWith("[--mosa-update-ready-file="), true, entries[0]);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

scope("rehearsal: cross-name preview update renames the nested GravityPort payload into place", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-rehearsal-win-cross-"));
  const exeSource = await sharedFakeExe();
  try {
    const installDir = await makeInstallDir({ root, exeSource, marker: "old" });
    const zipPath = await makePayloadZip({ root, exeSource, stem: "GravityPort-win32-x64", payloadExeName: "GravityPort.exe", marker: "new", layout: "nested", readyBody: readyJson("preview") });
    const { readyFile, logPath } = await launchHelper({
      root,
      installDir,
      zipPath,
      currentExeName: "MOSA.exe",
      payloadExeName: "GravityPort.exe",
    });

    await waitFor(() => markerOf(installDir) === "new", { label: "cross-name success (replacement installed)" });
    // The old user's folder name and exe name both survive the update; only
    // the content changed.
    assert.equal(installDir, join(root, "install", "MOSA-win32-x64"));
    assert.equal(existsSync(join(installDir, "MOSA.exe")), true, "the payload was renamed to the installed exe name");
    assert.equal(existsSync(join(installDir, "GravityPort.exe")), false, "no file keeps the payload name");
    assert.equal(existsSync(logPath), false);
    assert.equal(existsSync(readyFile), true);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

scope("rehearsal: cross-name update with a silent payload rolls back and relaunches MOSA.exe", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-rehearsal-win-fail-"));
  const exeSource = await sharedFakeExe();
  try {
    const launchLog = join(root, "launch.log");
    const installDir = await makeInstallDir({ root, exeSource, marker: "old", launchLog });
    // readyJson null in the package config: the replacement launches but never
    // reports readiness, which drives the helper into its rollback path.
    const zipPath = await makePayloadZip({ root, exeSource, stem: "GravityPort-win32-x64", payloadExeName: "GravityPort.exe", marker: "new", layout: "nested", readyBody: null, launchLog });
    const { logPath } = await launchHelper({
      root,
      installDir,
      zipPath,
      currentExeName: "MOSA.exe",
      payloadExeName: "GravityPort.exe",
    });

    await waitFor(() => existsSync(logPath), { label: "helper failure log" });
    assert.match(readFileSync(logPath, "utf8"), /did not report readiness/);
    await waitFor(() => markerOf(installDir) === "old", { label: "previous install restored" });
    assert.equal(existsSync(join(installDir, "MOSA.exe")), true);
    assert.equal(existsSync(join(installDir, "GravityPort.exe")), false);
    // The rollback must reopen the previous app: the fake exe logs its
    // argument list, and the relaunch without arguments shows as "[]".
    await waitFor(() => launchLogEntries(launchLog).includes("[]"), { label: "previous app relaunched" });
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

scope("rehearsal: production signer rules anchor trust to the manifest thumbprint", async () => {
  const exeSource = await sharedFakeExe();
  const payloadRule = (thumbprint, subject) => ({
    like: "*\\.MOSA-update-*\\extracted\\*",
    status: "Valid",
    thumbprint,
    subject,
  });
  const oldRule = (installDir, thumbprint, subject) => ({
    like: join(installDir, "MOSA.exe").replaceAll("[", "[[]"),
    status: "Valid",
    thumbprint,
    subject,
  });
  const signableExtra = [{ name: "resources/fake.native.node", body: "fake-native" }];

  async function scenario(name, { oldSignature = null, manifestThumbprint, expectedPayload = { thumbprint: THUMBPRINT_RENEWED, subject: SUBJECT_PUBLISHER } }) {
    const root = await mkdtemp(join(tmpdir(), `mosa-rehearsal-win-prod-${name}-`));
    try {
      const installDir = await makeInstallDir({ root, exeSource, marker: "old" });
      const zipPath = await makePayloadZip({ root, exeSource, stem: "MOSA-win32-x64", payloadExeName: "MOSA.exe", marker: "new", layout: "nested", readyBody: readyJson("production"), extraFiles: signableExtra });
      const rules = [payloadRule(expectedPayload.thumbprint, expectedPayload.subject)];
      if (oldSignature) rules.push(oldRule(installDir, oldSignature.thumbprint, oldSignature.subject));
      const signatureProbe = await writeSignatureProbe(root, rules);
      const { readyFile, logPath } = await launchHelper({
        root,
        signatureProbe,
        installDir,
        zipPath,
        currentExeName: "MOSA.exe",
        payloadExeName: "MOSA.exe",
        signerThumbprint: manifestThumbprint,
        distribution: "production",
      });
      return { root, installDir, readyFile, logPath };
    } catch (error) {
      await removeTestPath(root, { recursive: true, force: true });
      throw error;
    }
  }

  // 1) Unsigned preview install crosses into production: the payload only has
  // to match the signed manifest.
  {
    const { root, installDir, readyFile, logPath } = await scenario("old-none", { manifestThumbprint: THUMBPRINT_RENEWED });
    try {
      await waitFor(() => markerOf(installDir) === "new", { label: "old-none production success (replacement installed)" });
      assert.equal(existsSync(logPath), false, `helper failure log must be absent, got: ${existsSync(logPath) ? readFileSync(logPath, "utf8") : ""}`);
      assert.equal(existsSync(readyFile), true);
    } finally {
      await removeTestPath(root, { recursive: true, force: true });
    }
  }

  // 2) Renewed certificate: the thumbprint rotated, the publisher subject did
  // not, so the update goes through.
  {
    const { root, installDir, readyFile, logPath } = await scenario("renewal", {
      oldSignature: { thumbprint: THUMBPRINT_PREVIOUS, subject: SUBJECT_PUBLISHER },
      manifestThumbprint: THUMBPRINT_RENEWED,
    });
    try {
      await waitFor(() => markerOf(installDir) === "new", { label: "renewal production success (replacement installed)" });
      assert.equal(existsSync(logPath), false);
      assert.equal(existsSync(readyFile), true);
    } finally {
      await removeTestPath(root, { recursive: true, force: true });
    }
  }

  // 3) Publisher subject changed: refused, and the previous install stays in
  // place untouched.
  {
    const { root, installDir, readyFile, logPath } = await scenario("subject", {
      oldSignature: { thumbprint: THUMBPRINT_PREVIOUS, subject: SUBJECT_PUBLISHER },
      manifestThumbprint: THUMBPRINT_RENEWED,
      expectedPayload: { thumbprint: THUMBPRINT_RENEWED, subject: SUBJECT_OTHER },
    });
    try {
      await waitFor(() => existsSync(logPath), { label: "subject-change failure log" });
      assert.match(readFileSync(logPath, "utf8"), /publisher changed between releases/);
      assert.equal(markerOf(installDir), "old", "a refused payload must never replace the install");
      assert.equal(existsSync(readyFile), false);
    } finally {
      await removeTestPath(root, { recursive: true, force: true });
    }
  }

  // 4) Payload thumbprint disagrees with the signed manifest: refused the
  // same way — the manifest, not the old install, is the trust anchor.
  {
    const { root, installDir, readyFile, logPath } = await scenario("manifest", {
      manifestThumbprint: THUMBPRINT_OTHER,
    });
    try {
      await waitFor(() => existsSync(logPath), { label: "manifest-mismatch failure log" });
      assert.match(readFileSync(logPath, "utf8"), /signed by a different publisher/);
      assert.equal(markerOf(installDir), "old");
      assert.equal(existsSync(readyFile), false);
    } finally {
      await removeTestPath(root, { recursive: true, force: true });
    }
  }
});
