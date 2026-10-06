import sharp from "./sharp-runtime.js";

export interface PaletteColor {
  /** Uppercase "#RRGGBB". */
  hex: string;
  /** Share of the image's opaque pixels, rounded to 3 decimals. */
  ratio: number;
}

// The palette describes the dominant colors of a small thumbnail, so sampling
// beyond 80×80 only adds work. 80 divides the 400px derivative thumbnail (the
// palette's only real input) into whole 5px boxes: libvips box-shrinks by an
// integer factor first, so no sampling window straddles a hard edge and no
// output column comes out as a fabricated blend of the two neighboring
// colors. A fractional factor (64 sampled from 400) puts one full column —
// 1.5% of the image, all pixels identical — mid-blend, which k-means then
// locks in as a genuine-looking cluster. Flat interiors average to
// themselves, so true colors are unaffected. `kernel: "nearest"` keeps the
// final sub-pixel step free of filter ringing; blending is already handled
// by the integer box shrink.
const SAMPLE_SIZE = 80;
const MAX_PALETTE_COLORS = 8;
const MIN_OPAQUE_ALPHA = 128;
// Refined centers whose representatives are closer than this in RGB Euclidean
// distance collapse into one (count-weighted) color.
const MERGE_DISTANCE_SQUARED = 24 * 24;
// Median cut alone only produces bucket-size ratios (halves, quarters, ...),
// and its bucket averages blend distinct colors that landed in one bucket.
// Lloyd's iterations pull each center onto the mean of the pixels actually
// nearest to it, so a center that mixed black with white either moves onto the
// black cluster or starves and is dropped. Ten rounds is plenty: the sample is
// at most 64×64 pixels with at most 8 centers, and every round is one
// assignment pass.
const MAX_KMEANS_ROUNDS = 10;
// Colors covering less than 1% of the image are compression noise and edge
// blends; dropped without renormalizing the remaining shares.
const MIN_RATIO = 0.01;
// A hard edge sampled at a fractional ratio yields one full column (or row) of
// a single blend value — 1/N_cols of the image, e.g. 1.25% at 80×80 — which
// the ratio floor cannot catch and k-means locks in as a real cluster. Such a
// cluster is structurally different from a real color: its center sits on the
// straight RGB line between its two neighbors, within encoder noise. If a
// smaller cluster lies this close to the segment joining two strictly larger
// ones, it is an edge blend and is dropped (pixels excluded, shares not
// renormalized — same semantics as the ratio floor). Edge blends are only ever
// a column or two of the sample, so the rule is capped at 3% of the image: a
// real mid tone (orange between red and yellow, gray between black and white)
// covering more than that is kept.
const BLEND_SEGMENT_DISTANCE = 16;
const MAX_BLEND_RATIO = 0.03;
const MAX_INPUT_PIXELS = 40_000_000;

type Rgb = [number, number, number];

interface BucketSplit {
  channel: number;
  spread: number;
}

/**
 * Extracts up to 8 dominant colors from an image, largest share first.
 *
 * Deterministic by construction: median cut seeds the centers from sorted
 * pixel values, the k-means refinement tie-breaks toward the lower index, and
 * every remaining comparison uses explicit keys, so the same file always
 * yields the same palette. Read/decode failures and fully transparent images
 * return [] instead of throwing — callers treat an empty palette as
 * "computed, nothing to show", never as an error.
 */
export async function extractImagePalette(imagePath: string): Promise<PaletteColor[]> {
  try {
    const { data, info } = await sharp(imagePath, { animated: false, limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: SAMPLE_SIZE, height: SAMPLE_SIZE, fit: "inside", withoutEnlargement: true, kernel: "nearest" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 4) return [];
    const pixels: Rgb[] = [];
    for (let offset = 0; offset + 3 < data.length; offset += 4) {
      if (data[offset + 3] < MIN_OPAQUE_ALPHA) continue;
      pixels.push([data[offset], data[offset + 1], data[offset + 2]]);
    }
    return buildPalette(pixels);
  } catch {
    return [];
  }
}

function buildPalette(pixels: Rgb[]): PaletteColor[] {
  const total = pixels.length;
  if (total === 0) return [];
  const centers = refineCenters(pixels, medianCut(pixels, MAX_PALETTE_COLORS).map(averageColor));
  // Merging first: k-means fragments near a dominant color are absorbed into
  // it, so the blend rule below only ever sees well-separated colors.
  const entries = dropEdgeBlendClusters(mergeSimilarColors(finalAssignments(pixels, centers)), total);
  const palette = entries
    .filter((entry) => entry.count / total >= MIN_RATIO)
    .map((entry) => ({
      hex: colorToHex(entry.color),
      ratio: Math.round((entry.count / total) * 1000) / 1000,
    }));
  // Ratio desc; hex breaks ties so equal shares never flip between runs.
  palette.sort((a, b) => b.ratio - a.ratio || (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0));
  return palette.slice(0, MAX_PALETTE_COLORS);
}

/**
 * Lloyd's algorithm seeded from the median-cut bucket averages. Each round
 * reassigns every pixel to its nearest center (ties go to the lower index) and
 * moves each surviving center onto the mean of its pixels; centers that no
 * pixel claims are dropped. Deterministic: the seed and the tie-break are, and
 * rounding is stable, so the loop stops on a fixed point or the round cap.
 */
function refineCenters(pixels: Rgb[], initialCenters: Rgb[]): Rgb[] {
  let centers = initialCenters;
  for (let round = 0; round < MAX_KMEANS_ROUNDS; round += 1) {
    const sums = centers.map(() => [0, 0, 0]);
    const counts = centers.map(() => 0);
    for (const pixel of pixels) {
      const index = nearestCenterIndex(pixel, centers);
      sums[index][0] += pixel[0];
      sums[index][1] += pixel[1];
      sums[index][2] += pixel[2];
      counts[index] += 1;
    }
    const next: Rgb[] = [];
    for (let index = 0; index < centers.length; index += 1) {
      if (counts[index] === 0) continue;
      next.push([
        Math.round(sums[index][0] / counts[index]),
        Math.round(sums[index][1] / counts[index]),
        Math.round(sums[index][2] / counts[index]),
      ]);
    }
    const converged = next.length === centers.length && next.every((center, index) => compareRgb(center, centers[index]) === 0);
    centers = next;
    if (converged) break;
  }
  return centers;
}

/** Assigns every pixel to its nearest converged center and counts per center. */
function finalAssignments(pixels: Rgb[], centers: Rgb[]): Array<{ color: Rgb; count: number }> {
  const counts = centers.map(() => 0);
  for (const pixel of pixels) {
    counts[nearestCenterIndex(pixel, centers)] += 1;
  }
  const assignments: Array<{ color: Rgb; count: number }> = [];
  for (let index = 0; index < centers.length; index += 1) {
    if (counts[index] > 0) assignments.push({ color: centers[index], count: counts[index] });
  }
  return assignments;
}

function nearestCenterIndex(pixel: Rgb, centers: Rgb[]): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < centers.length; index += 1) {
    const distance = colorDistanceSquared(pixel, centers[index]);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Removes clusters that only exist because an encoder blended two neighboring
 * colors across a hard edge. A real dominant color does not need to sit on the
 * line between two larger colors; an edge blend cannot avoid it. Only clusters
 * strictly smaller than both endpoints are eligible, so the largest clusters
 * are structurally exempt.
 */
function dropEdgeBlendClusters(entries: Array<{ color: Rgb; count: number }>, total: number): Array<{ color: Rgb; count: number }> {
  return entries.filter((entry) => entry.count / total > MAX_BLEND_RATIO || !entries.some(
    (first) => first.count > entry.count && entries.some(
      (second) => second.count > entry.count
        && first !== second
        && distanceToSegment(entry.color, first.color, second.color) <= BLEND_SEGMENT_DISTANCE,
    ),
  ));
}

function distanceToSegment(point: Rgb, endA: Rgb, endB: Rgb): number {
  const ab = [endB[0] - endA[0], endB[1] - endA[1], endB[2] - endA[2]];
  const ap = [point[0] - endA[0], point[1] - endA[1], point[2] - endA[2]];
  const abLengthSquared = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const t = abLengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2]) / abLengthSquared));
  const projected: Rgb = [endA[0] + ab[0] * t, endA[1] + ab[1] * t, endA[2] + ab[2] * t];
  return Math.sqrt(colorDistanceSquared(point, projected));
}

/** Median cut: repeatedly split the bucket with the widest channel at its median. */
function medianCut(pixels: Rgb[], maxBuckets: number): Rgb[][] {
  let buckets: Rgb[][] = [pixels];
  while (buckets.length < maxBuckets) {
    let splitIndex = -1;
    let splitChannel = 0;
    let splitSpread = 0;
    let splitCount = 0;
    for (let index = 0; index < buckets.length; index += 1) {
      const bucket = buckets[index];
      const { channel, spread } = widestChannel(bucket);
      if (spread === 0) continue;
      if (splitIndex !== -1 && spread <= splitSpread && bucket.length <= splitCount) continue;
      splitIndex = index;
      splitChannel = channel;
      splitSpread = spread;
      splitCount = bucket.length;
    }
    if (splitIndex === -1) break;
    const sorted = [...buckets[splitIndex]].sort((a, b) => a[splitChannel] - b[splitChannel]);
    const median = sorted.length >> 1;
    buckets.splice(splitIndex, 1, sorted.slice(0, median), sorted.slice(median));
  }
  return buckets;
}

function widestChannel(bucket: Rgb[]): BucketSplit {
  let channel = 0;
  let spread = 0;
  for (let index = 0; index < 3; index += 1) {
    let min = 255;
    let max = 0;
    for (const pixel of bucket) {
      const value = pixel[index];
      if (value < min) min = value;
      if (value > max) max = value;
    }
    if (max - min > spread) {
      channel = index;
      spread = max - min;
    }
  }
  return { channel, spread };
}

function averageColor(bucket: Rgb[]): Rgb {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const pixel of bucket) {
    r += pixel[0];
    g += pixel[1];
    b += pixel[2];
  }
  const count = bucket.length;
  return [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
}

/**
 * Greedy absorption in count order: the largest color survives and swallows
 * every later color within the merge distance (weighted average), so the
 * result never depends on iteration order beyond the deterministic sort.
 */
function mergeSimilarColors(entries: Array<{ color: Rgb; count: number }>): Array<{ color: Rgb; count: number }> {
  const ordered = [...entries].sort((a, b) => b.count - a.count || compareRgb(a.color, b.color));
  const merged: Array<{ color: Rgb; count: number }> = [];
  for (const entry of ordered) {
    const target = merged.find((candidate) => colorDistanceSquared(candidate.color, entry.color) < MERGE_DISTANCE_SQUARED);
    if (!target) {
      merged.push({ color: [...entry.color] as Rgb, count: entry.count });
      continue;
    }
    const count = target.count + entry.count;
    target.color = [
      Math.round((target.color[0] * target.count + entry.color[0] * entry.count) / count),
      Math.round((target.color[1] * target.count + entry.color[1] * entry.count) / count),
      Math.round((target.color[2] * target.count + entry.color[2] * entry.count) / count),
    ];
    target.count = count;
  }
  return merged;
}

function colorDistanceSquared(a: Rgb, b: Rgb): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function compareRgb(a: Rgb, b: Rgb): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function colorToHex(color: Rgb): string {
  return `#${color.map((value) => value.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}
