#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseUpdateManifest } from "../desktop/update-service.mjs";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export async function prepareDesktopReleaseManifest({
  version,
  macArtifactPath = "",
  windowsArtifactPath = "",
  previousManifest = null,
  publishedAt = new Date().toISOString(),
  notes = null,
} = {}) {
  const cleanVersion = String(version || "").trim();
  if (!VERSION_PATTERN.test(cleanVersion)) throw new Error("Invalid MOSA release version.");

  const macos = macArtifactPath
    ? await artifactMetadata({
        path: macArtifactPath,
        expectedFile: `MOSA-darwin-arm64-${cleanVersion}.zip`,
        platform: "macOS",
        arch: "arm64",
      })
    : null;
  const windows = windowsArtifactPath
    ? await artifactMetadata({
        path: windowsArtifactPath,
        expectedFile: `MOSA-win32-x64-${cleanVersion}.zip`,
        platform: "Windows",
        arch: "x64",
      })
    : null;

  const previous = previousManifest && typeof previousManifest === "object" && !Array.isArray(previousManifest)
    ? previousManifest
    : {};
  const normalizedNotes = normalizeRequiredNotes(notes);
  const manifest = {
    version: cleanVersion,
    publishedAt: normalizePublishedAt(publishedAt),
    notes: normalizedNotes,
    platforms: {
      ...(macos ? { macos } : {}),
      ...(windows ? { windows } : {}),
    },
    ...(validVisualPacks(previous.visualPacks) ? { visualPacks: structuredClone(previous.visualPacks) } : {}),
  };

  // The release writer and Desktop reader share the exact same parser. This
  // deliberately fails the publishing step if schema/filename/version rules
  // ever drift apart again.
  parseUpdateManifest(manifest);
  return manifest;
}

export async function artifactMetadata({ path, expectedFile, platform, arch }) {
  const absolute = resolve(String(path || ""));
  if (basename(absolute) !== expectedFile) {
    throw new Error(`Release artifact filename must be ${expectedFile}.`);
  }
  const info = await stat(absolute);
  if (!info.isFile() || info.size <= 0) throw new Error(`Release artifact is missing or empty: ${absolute}`);
  const hash = createHash("sha256");
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(absolute);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", resolveHash);
  });
  return {
    platform,
    arch,
    file: expectedFile,
    size: info.size,
    sha256: hash.digest("hex"),
  };
}

function normalizePublishedAt(value) {
  const raw = String(value || "").trim();
  const parsed = Date.parse(raw);
  if (!raw || !Number.isFinite(parsed)) throw new Error("Invalid release publishedAt timestamp.");
  return new Date(parsed).toISOString();
}

function normalizeRequiredNotes(value) {
  const zh = typeof value?.zh === "string" ? value.zh.trim().slice(0, 1200) : "";
  const en = typeof value?.en === "string" ? value.en.trim().slice(0, 1200) : "";
  if (!zh || !en) {
    throw new Error("Release notes are required: notes.zh and notes.en must both be non-empty.");
  }
  return { zh, en };
}

function validVisualPacks(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    args[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version || !args.output) {
    throw new Error("Usage: prepare-desktop-release-manifest.mjs --version <version> --output <latest.json> [--previous <latest.json>] [--mac <zip>] [--windows <zip>] [--published-at <ISO>] [--notes-zh <text>] [--notes-en <text>]");
  }
  const previousManifest = args.previous ? JSON.parse(await readFile(resolve(args.previous), "utf8")) : null;
  const manifest = await prepareDesktopReleaseManifest({
    version: args.version,
    macArtifactPath: args.mac || "",
    windowsArtifactPath: args.windows || "",
    previousManifest,
    publishedAt: args["published-at"] || new Date().toISOString(),
    notes: { zh: args["notes-zh"] || "", en: args["notes-en"] || "" },
  });
  const output = resolve(args.output);
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, output, manifest }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`[MOSA] release manifest preparation failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
