import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { safePixelDigest } from "../lib/image-pixel-hash.js";

test("safePixelDigest keeps opaque RGB/RGBA compatible and preserves meaningful alpha", async () => {
  const width = 8;
  const height = 8;
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < rgb.length; i += 1) rgb[i] = (i * 29) & 255;
  const opaqueRgb = await sharp(rgb, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const opaqueRgba = await sharp(rgb, { raw: { width, height, channels: 3 } }).ensureAlpha(1).png().toBuffer();
  const translucentRgba = await sharp(rgb, { raw: { width, height, channels: 3 } }).ensureAlpha(0.5).png().toBuffer();

  const rgbHash = await safePixelDigest(opaqueRgb);
  assert.ok(rgbHash);
  assert.equal(await safePixelDigest(opaqueRgba), rgbHash);
  const translucentHash = await safePixelDigest(translucentRgba);
  assert.ok(translucentHash);
  assert.notEqual(translucentHash, rgbHash);
});

test("safePixelDigest canonicalises invisible RGB under fully transparent pixels", async () => {
  const first = Buffer.from([255, 0, 0, 0, 0, 255, 0, 255]);
  const second = Buffer.from([0, 0, 255, 0, 0, 255, 0, 255]);
  const firstPng = await sharp(first, { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  const secondPng = await sharp(second, { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  assert.notDeepEqual(firstPng, secondPng);
  assert.equal(await safePixelDigest(firstPng), await safePixelDigest(secondPng));
});

test("safePixelDigest includes EXIF orientation in the displayed pixel identity", async () => {
  const width = 8;
  const height = 12;
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < rgb.length; i += 1) rgb[i] = (i * 17 + Math.floor(i / 9) * 31) & 255;
  const plain = await sharp(rgb, { raw: { width, height, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
  const rotatedByMetadata = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 100 })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  assert.equal((await sharp(rotatedByMetadata).metadata()).orientation, 6);
  assert.notEqual(await safePixelDigest(plain), await safePixelDigest(rotatedByMetadata));
});

test("safePixelDigest refuses multi-frame images instead of hashing only the poster frame", async () => {
  const animatedGif = Buffer.from(
    "47494638396101000100800000000000ffffff" +
    "21f904000a0000002c0000000001000100000202440100" +
    "21f904000a0000002c00000000010001000002024c0100" +
    "3b",
    "hex",
  );
  const metadata = await sharp(animatedGif).metadata();
  assert.ok((metadata.pages || 1) > 1);
  assert.equal(await safePixelDigest(animatedGif), "");
});
