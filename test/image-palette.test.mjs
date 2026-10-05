import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { extractImagePalette } from "../lib/image-palette.js";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

// The palette extractor is the backend for the inspector's dominant-color
// swatches. The contract that matters downstream: deterministic output, at
// most 8 uppercase hex colors sorted by share, [] instead of throwing.

async function makeFixtureDir(t) {
  const root = await mkdtemp(join(tmpdir(), "mosa-image-palette-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  return root;
}

async function writeSolidPng(path, width, height, rgb, { alpha } = {}) {
  const channels = alpha === undefined ? 3 : 4;
  const background = alpha === undefined ? rgb : { ...rgb, alpha };
  await sharp({ create: { width, height, channels, background } }).png().toFile(path);
}

/** Left half red, right half blue — the canonical two-dominant-colors image. */
async function writeHalvedPng(path, width, height) {
  await sharp({ create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([
      { input: await sharp({ create: { width: width / 2, height, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer(), left: 0, top: 0 },
      { input: await sharp({ create: { width: width / 2, height, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer(), left: width / 2, top: 0 },
    ])
    .png()
    .toFile(path);
}

function assertPaletteShape(palette, { maxColors = 8 } = {}) {
  assert.ok(Array.isArray(palette));
  assert.ok(palette.length <= maxColors, `at most ${maxColors} colors`);
  let ratioSum = 0;
  for (const [index, entry] of palette.entries()) {
    assert.match(entry.hex, /^#[0-9A-F]{6}$/);
    assert.ok(Number.isFinite(entry.ratio) && entry.ratio > 0 && entry.ratio <= 1, `ratio in (0, 1]: ${entry.ratio}`);
    if (index > 0) assert.ok(palette[index - 1].ratio >= entry.ratio, "sorted by share descending");
    ratioSum += entry.ratio;
  }
  assert.ok(Math.abs(ratioSum - 1) < 0.01, `ratios sum to ~1, got ${ratioSum}`);
}

test("a solid color image yields exactly one full-share color", async (t) => {
  const root = await makeFixtureDir(t);
  const path = join(root, "solid.png");
  await writeSolidPng(path, 64, 64, { r: 255, g: 136, b: 0 });

  const palette = await extractImagePalette(path);
  assert.deepEqual(palette, [{ hex: "#FF8800", ratio: 1 }]);
});

test("a two-color image yields both colors at about half share each", async (t) => {
  const root = await makeFixtureDir(t);
  const path = join(root, "halves.png");
  await writeHalvedPng(path, 128, 128);

  const palette = await extractImagePalette(path);
  assert.equal(palette.length, 2);
  assertPaletteShape(palette);
  for (const entry of palette) {
    assert.ok(Math.abs(entry.ratio - 0.5) < 0.05, `each half is ~0.5, got ${entry.ratio}`);
  }
  assert.deepEqual(palette.map((entry) => entry.hex).sort(), ["#0000FF", "#FF0000"]);
});

test("a fully transparent image returns an empty palette", async (t) => {
  const root = await makeFixtureDir(t);
  const path = join(root, "transparent.png");
  await writeSolidPng(path, 32, 32, { r: 10, g: 200, b: 30 }, { alpha: 0 });

  assert.deepEqual(await extractImagePalette(path), []);
});

test("the same image always produces the identical palette", async (t) => {
  const root = await makeFixtureDir(t);
  const path = join(root, "photo-like.png");
  // Enough varied colors to exercise bucket splitting, merging, and ordering.
  const stripes = [];
  for (let index = 0; index < 12; index += 1) {
    stripes.push({
      input: await sharp({ create: { width: 8, height: 96, channels: 3, background: { r: (index * 23) % 256, g: (index * 67) % 256, b: (index * 41) % 256 } } }).png().toBuffer(),
      left: index * 8,
      top: 0,
    });
  }
  await sharp({ create: { width: 96, height: 96, channels: 3, background: { r: 250, g: 240, b: 230 } } })
    .composite(stripes)
    .png()
    .toFile(path);

  const first = await extractImagePalette(path);
  const second = await extractImagePalette(path);
  assert.deepEqual(first, second);
  assertPaletteShape(first);
});

test("more than eight distinct colors still cap at eight entries", async (t) => {
  const root = await makeFixtureDir(t);
  const path = join(root, "stripes.png");
  // Nine well-separated stripes — one more than the cap. Seven converge as
  // singletons and the ninth color folds into a neighbor, so the output is
  // exactly the 8-entry cap with true pixel shares (seven at 1/9, one at 2/9).
  const stripes = [];
  for (let index = 0; index < 9; index += 1) {
    stripes.push({
      input: await sharp({ create: { width: 8, height: 64, channels: 3, background: { r: index * 30, g: 255 - index * 28, b: (index * 89) % 256 } } }).png().toBuffer(),
      left: index * 8,
      top: 0,
    });
  }
  await sharp({ create: { width: 72, height: 64, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite(stripes)
    .png()
    .toFile(path);

  const palette = await extractImagePalette(path);
  assert.equal(palette.length, 8);
  assertPaletteShape(palette);
  const singletons = palette.filter((entry) => Math.abs(entry.ratio - 1 / 9) <= 0.02);
  const doubled = palette.filter((entry) => Math.abs(entry.ratio - 2 / 9) <= 0.02);
  assert.equal(singletons.length, 7, `seven stripes keep a 1/9 share: ${JSON.stringify(palette)}`);
  assert.equal(doubled.length, 1, `one entry carries the folded pair at 2/9: ${JSON.stringify(palette)}`);
});

// The derivative pipeline hands the extractor a 400px webp (quality 78), so
// the fidelity fixtures below go through the same encode. webp smoothing
// invents blend colors at band edges — the extractor must report the true
// band colors at their true shares, not the encoder's artifacts.

async function writeStripeWebp(path, bands) {
  const composites = [];
  let left = 0;
  for (const band of bands) {
    composites.push({
      input: await sharp({ create: { width: band.columns, height: 400, channels: 3, background: band.rgb } }).png().toBuffer(),
      left,
      top: 0,
    });
    left += band.columns;
  }
  await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite(composites)
    .webp({ quality: 78 })
    .toFile(path);
}

function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function rgbDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function assertDominantColor(palette, hex, ratio) {
  const target = hexToRgb(hex);
  const entry = palette.find((candidate) => rgbDistance(hexToRgb(candidate.hex), target) <= 12);
  assert.ok(entry, `a color within RGB distance 12 of ${hex}: ${JSON.stringify(palette)}`);
  assert.ok(Math.abs(entry.ratio - ratio) <= 0.02, `${hex} covers ~${ratio}, got ${entry.ratio}`);
}

test("flat webp bands keep their true colors and shares (60/30/10)", async (t) => {
  const root = await makeFixtureDir(t);
  const path = join(root, "bands-three.webp");
  await writeStripeWebp(path, [
    { columns: 240, rgb: { r: 0x14, g: 0x14, b: 0x14 } },
    { columns: 120, rgb: { r: 0xF0, g: 0xF0, b: 0xF0 } },
    { columns: 40, rgb: { r: 0xFF, g: 0xC8, b: 0x00 } },
  ]);

  const palette = await extractImagePalette(path);
  assert.equal(palette.length, 3);
  assertPaletteShape(palette);
  assertDominantColor(palette, "#141414", 0.6);
  assertDominantColor(palette, "#F0F0F0", 0.3);
  assertDominantColor(palette, "#FFC800", 0.1);
});

test("real mid tones between two larger colors are kept (orange between red and yellow, gray between black and white)", async (t) => {
  const root = await makeFixtureDir(t);
  const warm = join(root, "bands-warm.webp");
  await writeStripeWebp(warm, [
    { columns: 180, rgb: { r: 0xE6, g: 0x14, b: 0x14 } },
    { columns: 40, rgb: { r: 0xF0, g: 0x82, b: 0x14 } },
    { columns: 180, rgb: { r: 0xFA, g: 0xF0, b: 0x14 } },
  ]);
  const warmPalette = await extractImagePalette(warm);
  assert.equal(warmPalette.length, 3);
  assertDominantColor(warmPalette, "#F08214", 0.1);

  const neutral = join(root, "bands-neutral.webp");
  await writeStripeWebp(neutral, [
    { columns: 180, rgb: { r: 0x14, g: 0x14, b: 0x14 } },
    { columns: 40, rgb: { r: 0x80, g: 0x80, b: 0x80 } },
    { columns: 180, rgb: { r: 0xF0, g: 0xF0, b: 0xF0 } },
  ]);
  const neutralPalette = await extractImagePalette(neutral);
  assert.equal(neutralPalette.length, 3);
  assertDominantColor(neutralPalette, "#808080", 0.1);
});

test("webp edge blends fold into their nearest true color (90/10)", async (t) => {
  const root = await makeFixtureDir(t);
  const path = join(root, "bands-two.webp");
  await writeStripeWebp(path, [
    { columns: 360, rgb: { r: 0x1E, g: 0x50, b: 0xDC } },
    { columns: 40, rgb: { r: 0xDC, g: 0x1E, b: 0x28 } },
  ]);

  const palette = await extractImagePalette(path);
  assert.equal(palette.length, 2);
  assertPaletteShape(palette);
  assertDominantColor(palette, "#1E50DC", 0.9);
  assertDominantColor(palette, "#DC1E28", 0.1);
});

test("unreadable or missing files return an empty palette instead of throwing", async (t) => {
  const root = await makeFixtureDir(t);
  assert.deepEqual(await extractImagePalette(join(root, "does-not-exist.png")), []);

  const notAnImage = join(root, "garbage.png");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(notAnImage, Buffer.from("this is not an image"));
  assert.deepEqual(await extractImagePalette(notAnImage), []);
});
