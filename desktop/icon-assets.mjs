import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ICON_BASENAME = "mosa-app-icon";
const ICNS_VARIANTS = Object.freeze([
  Object.freeze({ size: 16, type: "icp4" }),
  Object.freeze({ size: 32, type: "icp5" }),
  Object.freeze({ size: 64, type: "icp6" }),
  Object.freeze({ size: 128, type: "ic07" }),
  Object.freeze({ size: 256, type: "ic08" }),
  Object.freeze({ size: 512, type: "ic09" }),
  Object.freeze({ size: 1024, type: "ic10" }),
]);
const ICO_SIZES = Object.freeze([16, 24, 32, 48, 64, 128, 256]);

export const DESKTOP_ICON_SOURCE_PATH = join(PROJECT_ROOT, "desktop", "assets", "mosa-app-icon.svg");

export function desktopIconOutputDir({ outDir = "out", projectRoot = PROJECT_ROOT } = {}) {
  return resolve(projectRoot, outDir, ".desktop-icons");
}

export function desktopIconBasePath(options = {}) {
  return join(desktopIconOutputDir(options), ICON_BASENAME);
}

function encodeIcns(pngBySize) {
  const chunks = ICNS_VARIANTS.map(({ size, type }) => {
    const png = pngBySize.get(size);
    const chunk = Buffer.allocUnsafe(8 + png.length);
    chunk.write(type, 0, 4, "ascii");
    chunk.writeUInt32BE(chunk.length, 4);
    png.copy(chunk, 8);
    return chunk;
  });
  const totalLength = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const header = Buffer.allocUnsafe(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(totalLength, 4);
  return Buffer.concat([header, ...chunks], totalLength);
}

function encodeIco(pngBySize) {
  const headerSize = 6;
  const directoryEntrySize = 16;
  const directorySize = directoryEntrySize * ICO_SIZES.length;
  const header = Buffer.alloc(headerSize + directorySize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(ICO_SIZES.length, 4);

  let imageOffset = header.length;
  const images = [];
  ICO_SIZES.forEach((size, index) => {
    const png = pngBySize.get(size);
    const entryOffset = headerSize + (index * directoryEntrySize);
    header.writeUInt8(size === 256 ? 0 : size, entryOffset);
    header.writeUInt8(size === 256 ? 0 : size, entryOffset + 1);
    header.writeUInt8(0, entryOffset + 2);
    header.writeUInt8(0, entryOffset + 3);
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(png.length, entryOffset + 8);
    header.writeUInt32LE(imageOffset, entryOffset + 12);
    imageOffset += png.length;
    images.push(png);
  });
  return Buffer.concat([header, ...images], imageOffset);
}

async function renderPng(svg, size) {
  return sharp(svg)
    .resize(size, size, { fit: "fill" })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

export async function generateDesktopIcons({
  outputDir,
  sourcePath = DESKTOP_ICON_SOURCE_PATH,
} = {}) {
  if (!outputDir) throw new Error("generateDesktopIcons requires outputDir");

  const svg = await readFile(sourcePath);
  const sizes = [...new Set([
    ...ICNS_VARIANTS.map(({ size }) => size),
    ...ICO_SIZES,
  ])];
  const rendered = await Promise.all(sizes.map(async (size) => [size, await renderPng(svg, size)]));
  const pngBySize = new Map(rendered);
  const basePath = join(outputDir, ICON_BASENAME);
  const paths = {
    base: basePath,
    icns: `${basePath}.icns`,
    ico: `${basePath}.ico`,
    png: `${basePath}.png`,
  };

  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(paths.icns, encodeIcns(pngBySize)),
    writeFile(paths.ico, encodeIco(pngBySize)),
    writeFile(paths.png, pngBySize.get(1024)),
  ]);
  return paths;
}
