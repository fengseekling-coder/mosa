import { MakerZIP } from "@electron-forge/maker-zip";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { access, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  desktopIconBasePath,
  desktopIconOutputDir,
  generateDesktopIcons,
} from "./icon-assets.mjs";

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

const COMMON_BUILD_ONLY_RUNTIME_PATHS = [
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
  "node_modules/detect-libc/index.d.ts",
  "node_modules/detect-libc/README.md",
  "node_modules/semver/bin",
  "node_modules/semver/range.bnf",
  "node_modules/semver/README.md",
];

const DESKTOP_PACKAGING_TARGETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    id: "darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    sqlitePrebuild: "darwin-arm64.node",
    sharpPackages: Object.freeze(["sharp-darwin-arm64", "sharp-libvips-darwin-arm64"]),
    asarUnpackDir: "node_modules/@img/sharp-libvips-darwin-arm64",
  }),
  "win32-x64": Object.freeze({
    id: "win32-x64",
    platform: "win32",
    arch: "x64",
    sqlitePrebuild: "win32-x64.node",
    sharpPackages: Object.freeze(["sharp-win32-x64"]),
    asarUnpackDir: "node_modules/@img/sharp-win32-x64",
  }),
});

function cliOption(argv, name) {
  const exact = `--${name}`;
  const prefix = `${exact}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === exact) return argv[index + 1] || "";
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return "";
}

export function resolveDesktopPackagingTarget({
  platform,
  arch,
  env = process.env,
  argv = process.argv,
} = {}) {
  const requestedPlatform = String(platform || env.MOSA_DESKTOP_PLATFORM || cliOption(argv, "platform") || "darwin").trim();
  const defaultArch = requestedPlatform === "win32" ? "x64" : "arm64";
  const requestedArch = String(arch || env.MOSA_DESKTOP_ARCH || cliOption(argv, "arch") || defaultArch).trim();
  const target = DESKTOP_PACKAGING_TARGETS[`${requestedPlatform}-${requestedArch}`];
  if (!target) {
    throw new Error(`Unsupported MOSA desktop packaging target: ${requestedPlatform}-${requestedArch}. Supported targets: darwin-arm64, win32-x64.`);
  }
  return target;
}

const AD_HOC_SIGN_CONFIG = {
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
};

export function macReleasePackagingConfig(env = process.env) {
  if (env.MOSA_RELEASE_BUILD !== "1") return { osxSign: AD_HOC_SIGN_CONFIG };

  const identity = String(env.MOSA_MACOS_SIGN_IDENTITY || "").trim();
  const appleId = String(env.APPLE_ID || "").trim();
  const appleIdPassword = String(env.APPLE_APP_SPECIFIC_PASSWORD || "").trim();
  const teamId = String(env.APPLE_TEAM_ID || "").trim();
  const missing = [
    ["MOSA_MACOS_SIGN_IDENTITY", identity],
    ["APPLE_ID", appleId],
    ["APPLE_APP_SPECIFIC_PASSWORD", appleIdPassword],
    ["APPLE_TEAM_ID", teamId],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw new Error(`MOSA release build requires: ${missing.join(", ")}`);
  }

  return {
    osxSign: {
      identity,
      identityValidation: true,
      preAutoEntitlements: true,
      optionsForFile: () => ({ hardenedRuntime: true }),
      strictVerify: true,
      continueOnError: false,
    },
    osxNotarize: {
      appleId,
      appleIdPassword,
      teamId,
    },
  };
}

function buildOnlyRuntimePaths(target) {
  return [
    ...COMMON_BUILD_ONLY_RUNTIME_PATHS,
    ...target.sharpPackages.map((name) => `node_modules/@img/${name}/README.md`),
  ];
}

export async function preparePackagedRuntime(buildPath, target = resolveDesktopPackagingTarget()) {
  await Promise.all(
    buildOnlyRuntimePaths(target).map((path) =>
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
      .filter((name) => name !== target.sqlitePrebuild)
      .map((name) => rm(join(prebuildDir, name), { force: true })),
  );

  await access(join(prebuildDir, target.sqlitePrebuild)).catch(() => {
    throw new Error(`Missing better-sqlite3 runtime for ${target.id}: ${target.sqlitePrebuild}`);
  });
  for (const packageName of target.sharpPackages) {
    await access(join(buildPath, "node_modules", "@img", packageName)).catch(() => {
      const canonicalHost = target.platform === "win32" ? "Windows/CI" : "macOS/CI";
      throw new Error(
        `Missing Sharp runtime for ${target.id}: @img/${packageName}. `
        + `Build ${target.id} on ${canonicalHost}; cross-packaging requires the target OS optional Sharp package to be provisioned explicitly.`,
      );
    });
  }

  const manifestPath = join(buildPath, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const runtimeManifest = Object.fromEntries(
    PACKAGED_MANIFEST_KEYS.filter((key) => manifest[key] !== undefined).map((key) => [key, manifest[key]]),
  );
  await writeFile(manifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function packageIgnorePatternsForTarget(target = resolveDesktopPackagingTarget()) {
  const allowedImagePackages = ["colour", ...target.sharpPackages].map(escapeRegex).join("|");
  return [
  // The desktop bundle has one runtime surface. Everything else at the
  // repository root is development, documentation, or another distribution.
  /^\/(?!app(?:\/|$)|desktop(?:\/|$)|lib(?:\/|$)|node_modules(?:\/|$)|LICENSE$|package\.json$).+/,
  /^\/desktop\/assets(?:\/|$)/,
  /^\/desktop\/(?:forge\.config\.mjs|icon-assets\.mjs|preload\.mjs)$/,
  /^\/lib\/.*(?:\.ts|\.js\.map)$/,
  /^\/node_modules\/\.package-lock\.json$/,
  new RegExp(`^/node_modules/(?!(?:better-sqlite3|detect-libc|node-addon-api|semver|sharp)(?:/|$)|@img(?:/(?:${allowedImagePackages})(?:/|$)|$)).+`),
  ];
}

const activeTarget = resolveDesktopPackagingTarget();
export const packageIgnorePatterns = packageIgnorePatternsForTarget(activeTarget);

export function createForgeConfig({ target = activeTarget, env = process.env } = {}) {
  const macPackaging = target.platform === "darwin" ? macReleasePackagingConfig(env) : {};
  const ignore = packageIgnorePatternsForTarget(target);
  const outDir = env.MOSA_FORGE_OUT_DIR || "out";
  const iconOutputDir = desktopIconOutputDir({ outDir });
  const icon = desktopIconBasePath({ outDir });
  return {
  // Forge normally writes to repository-local out/. QA environments may route
  // generated packages elsewhere without changing the release layout.
  outDir,
  packagerConfig: {
    name: "MOSA",
    icon,
    ...(target.platform === "darwin" ? { appBundleId: "com.azhuilab.mosa" } : {}),
    ...macPackaging,
    ignore,
    asar: {
      // Sharp's target package contains native siblings that must stay outside
      // app.asar. The exact package differs between macOS and Windows.
      unpackDir: target.asarUnpackDir,
    },
  },
  rebuildConfig: {},
  hooks: {
    // Keep one SVG source of truth in the repository and create native icon
    // containers immediately before Forge packages a desktop target.
    generateAssets: async () => {
      await generateDesktopIcons({ outputDir: iconOutputDir });
    },
    // Electron Forge passes the actual target into this hook. Prune only to
    // that native runtime and fail closed if the target dependency is absent.
    packageAfterPrune: async (_config, buildPath, _electronVersion, platform, arch) => {
      const hookTarget = resolveDesktopPackagingTarget({ platform, arch, env: {}, argv: [] });
      await preparePackagedRuntime(buildPath, hookTarget);
    },
  },
  plugins: [
    new AutoUnpackNativesPlugin(),
  ],
  makers: [
    new MakerZIP({}, ["darwin", "win32"]),
  ],
  };
}

export default createForgeConfig();
