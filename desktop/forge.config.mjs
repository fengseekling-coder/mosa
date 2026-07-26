import { MakerZIP } from "@electron-forge/maker-zip";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { rm } from "node:fs/promises";
import { join } from "node:path";

export async function removeNativeBuildMetadata(buildPath) {
  await rm(join(buildPath, "node_modules", "better-sqlite3", "build"), {
    recursive: true,
    force: true,
  });
}

export const packageIgnorePatterns = [
  /^\/(?:\.github|scripts|test)(?:\/|$)/,
  /^\/(?:\.gitignore|\.nvmrc|AGENTS\.md|CODE_OF_CONDUCT\.md|CONTRIBUTING\.md|eslint\.config\.js)$/,
];

export default {
  packagerConfig: {
    name: "MOSA",
    appBundleId: "com.azhuilab.mosa",
    ignore: packageIgnorePatterns,
    asar: {
      // sharp's native binding loads this sibling dylib at runtime.
      unpackDir: "node_modules/@img/sharp-libvips-darwin-arm64",
    },
  },
  rebuildConfig: {},
  hooks: {
    // Electron Forge rebuilds native modules before this hook. better-sqlite3
    // runs from its prebuilt binding, so compiler metadata must not enter ASAR.
    packageAfterPrune: async (_config, buildPath) => removeNativeBuildMetadata(buildPath),
  },
  plugins: [
    new AutoUnpackNativesPlugin(),
  ],
  makers: [
    new MakerZIP({}, ["darwin"]),
  ],
};
