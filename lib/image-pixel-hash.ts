import { createHash } from "node:crypto";
import sharp from "sharp";

export const DEFAULT_PIXEL_HASH_LIMIT = 40_000_000;
export const PIXEL_HASH_VERSION = "display-pixels-v2";

/**
 * Return a stable display-pixel SHA-256 for static images. The pipeline applies
 * EXIF orientation, converts to sRGB and canonicalises alpha before hashing.
 * Opaque images deliberately keep MOSA's legacy RGB digest shape so the common
 * orientation=1/sRGB case remains hash-compatible with older libraries.
 *
 * Multi-frame images return an empty digest. A correct animation identity also
 * needs frame timing/disposal metadata, so hashing only decoded pixels would be
 * dangerously incomplete.
 */
export async function safePixelDigest(
  input: Buffer | string,
  options: { limitInputPixels?: number } = {},
): Promise<string> {
  const limitInputPixels = options.limitInputPixels ?? DEFAULT_PIXEL_HASH_LIMIT;
  const sharpOptions = { failOn: "error" as const, limitInputPixels };
  const metadata = await sharp(input, sharpOptions).metadata();
  if ((Number(metadata.pages) || 1) > 1) return "";

  const orientation = Number(metadata.orientation) || 1;
  const swapsAxes = orientation >= 5 && orientation <= 8;
  const width = swapsAxes ? Number(metadata.height) : Number(metadata.width);
  const height = swapsAxes ? Number(metadata.width) : Number(metadata.height);
  if (!width || !height) return "";

  const rgbHash = createHash("sha256").update(`${width}x${height}x3:`);
  const rgbaHash = createHash("sha256").update(`${width}x${height}x4:`);
  const pipeline = sharp(input, sharpOptions)
    .autoOrient()
    .toColourspace("srgb")
    .ensureAlpha(1)
    .raw();
  let carry = Buffer.alloc(0);
  let opaque = true;

  for await (const rawChunk of pipeline) {
    const chunk = carry.length ? Buffer.concat([carry, rawChunk as Buffer]) : rawChunk as Buffer;
    const completeBytes = chunk.length - (chunk.length % 4);
    if (!completeBytes) {
      carry = Buffer.from(chunk);
      continue;
    }
    const complete = chunk.subarray(0, completeBytes);
    const canonicalRgba = Buffer.from(complete);
    const rgb = Buffer.allocUnsafe((completeBytes / 4) * 3);
    for (let sourceOffset = 0, rgbOffset = 0; sourceOffset < completeBytes; sourceOffset += 4, rgbOffset += 3) {
      const alpha = complete[sourceOffset + 3];
      if (alpha !== 255) opaque = false;
      // RGB under a fully transparent pixel is not visible. Canonicalising it
      // prevents encoders that preserve different hidden RGB values from
      // producing different identities for the same displayed image.
      if (alpha === 0) {
        canonicalRgba[sourceOffset] = 0;
        canonicalRgba[sourceOffset + 1] = 0;
        canonicalRgba[sourceOffset + 2] = 0;
      }
      rgb[rgbOffset] = complete[sourceOffset];
      rgb[rgbOffset + 1] = complete[sourceOffset + 1];
      rgb[rgbOffset + 2] = complete[sourceOffset + 2];
    }
    rgbaHash.update(canonicalRgba);
    rgbHash.update(rgb);
    carry = Buffer.from(chunk.subarray(completeBytes));
  }
  if (carry.length) throw new Error("Unexpected partial RGBA pixel from Sharp.");
  return opaque ? rgbHash.digest("hex") : rgbaHash.digest("hex");
}
