import sharp from "sharp";

// Windows cannot unlink files that libvips still has open. Keep Sharp's useful
// memory/operation caches, but never let the process retain file descriptors in
// the operation cache after an image task completes. One shared ESM instance is
// exported so every production caller observes the same cache policy.
sharp.cache({ files: 0 });

export default sharp;
