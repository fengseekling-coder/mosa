import { MakerZIP } from "@electron-forge/maker-zip";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PACKAGED_MANIFEST_KEYS = [
  "name",
  "version",
  "private",
  "license",
  "type",
  "main",
  "engines",
  "dependencies",
];

const BUILD_ONLY_RUNTIME_PATHS = [
  "node_modules/better-sqlite3/binding.gyp",
  "node_modules/better-sqlite3/build",
  "node_modules/better-sqlite3/deps",
  "node_modules/better-sqlite3/src",
  "node_modules/better-sqlite3/README.md",
  "node_modules/node-addon-api",
  "node_modules/sharp/install",
  "node_modules/sharp/src",
  "node_modules/sharp/lib",
  "node_modules/sharp/dist/index.d.cts",
  "node_modules/sharp/dist/index.d.mts",
  "node_modules/sharp/README.md",
  "node_modules/@img/colour/index.d.ts",
  "node_modules/@img/colour/README.md",
  "node_modules/@img/sharp-darwin-arm64/README.md",
  "node_modules/@img/sharp-libvips-darwin-arm64/README.md",
  "node_modules/detect-libc/index.d.ts",
  "node_modules/detect-libc/README.md",
  "node_modules/semver/bin",
  "node_modules/semver/range.bnf",
  "node_modules/semver/README.md",
];

export async function preparePackagedRuntime(buildPath) {
  await Promise.all(
    BUILD_ONLY_RUNTIME_PATHS.map((path) =>
      rm(join(buildPath, path), { recursive: true, force: true }),
    ),
  );

  const prebuildDir = join(buildPath, "node_modules", "better-sqlite3", "prebuilds");
  const prebuilds = await readdir(prebuildDir).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  await Promise.all(
    prebuilds
      .filter((name) => name !== "darwin-arm64.node")
      .map((name) => rm(join(prebuildDir, name), { force: true })),
  );

  const manifestPath = join(buildPath, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const runtimeManifest = Object.fromEntries(
    PACKAGED_MANIFEST_KEYS.filter((key) => manifest[key] !== undefined).map((key) => [key, manifest[key]]),
  );
  await writeFile(manifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`);
}

export const packageIgnorePatterns = [
  // The desktop bundle has one runtime surface. Everything else at the
  // repository root is development, documentation, or another distribution.
  /^\/(?!app(?:\/|$)|desktop(?:\/|$)|lib(?:\/|$)|node_modules(?:\/|$)|LICENSE$|package\.json$).+/,
  /^\/desktop\/(?:forge\.config\.mjs|preload\.mjs)$/,
  /^\/lib\/.*(?:\.ts|\.js\.map)$/,
  /^\/node_modules\/\.package-lock\.json$/,
  /^\/node_modules\/(?!(?:better-sqlite3|detect-libc|node-addon-api|semver|sharp)(?:\/|$)|@img(?:\/(?:colour|sharp-darwin-arm64|sharp-libvips-darwin-arm64)(?:\/|$)|$)).+/,
];

export default {
  packagerConfig: {
    name: "MOSA",
    appBundleId: "com.azhuilab.mosa",
    osxSign: {
      identity: "-",
      identityValidation: false,
      preAutoEntitlements: false,
      // Electron's nested binaries arrive hardened under an upstream identity.
      // A local ad-hoc package must clear that flag on every signed component.
      optionsForFile: () => ({
        hardenedRuntime: false,
        additionalArguments: ["--options=0"],
      }),
      strictVerify: true,
      continueOnError: false,
    },
    ignore: packageIgnorePatterns,
    asar: {
      // sharp's native binding loads this sibling dylib at runtime.
      unpackDir: "node_modules/@img/sharp-libvips-darwin-arm64",
    },
  },
  rebuildConfig: {},
  hooks: {
    // Electron Forge rebuilds native modules before this hook. Keep only the
    // arm64 runtime files that can be loaded by the packaged application.
    packageAfterPrune: async (_config, buildPath) => preparePackagedRuntime(buildPath),
  },
  plugins: [
    new AutoUnpackNativesPlugin(),
  ],
  makers: [
    new MakerZIP({}, ["darwin"]),
  ],
};
