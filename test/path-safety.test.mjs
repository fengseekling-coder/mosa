import test from "node:test";
import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import {
  isAbsoluteLocalPath,
  isPathInside,
  isPathInsideOrEqual,
  isUrlLikePath,
  pathsEqual,
} from "../lib/path-safety.mjs";

test("path safety preserves ordinary POSIX containment", () => {
  assert.equal(isPathInside("/Users/example/MOSA Library", "/Users/example/MOSA Library/default", posix), true);
  assert.equal(isPathInside("/Users/example/MOSA Library", "/Users/example/outside", posix), false);
  assert.equal(isPathInside("/Users/example/MOSA Library", "/Users/example/MOSA Library", posix), false);
  assert.equal(isPathInsideOrEqual("/Users/example/MOSA Library", "/Users/example/MOSA Library", posix), true);
});

test("path safety rejects Windows cross-drive containment", () => {
  assert.equal(isPathInside("C:\\Users\\example\\MOSA Library", "C:\\Users\\example\\MOSA Library\\default", win32), true);
  assert.equal(isPathInside("C:\\Users\\example\\MOSA Library", "C:\\Users\\example\\outside", win32), false);
  assert.equal(isPathInside("C:\\Users\\example\\MOSA Library", "D:\\outside", win32), false);
  assert.equal(isPathInsideOrEqual("C:\\Users\\example\\MOSA Library", "D:\\outside", win32), false);
  assert.equal(pathsEqual("C:\\Users\\Example\\MOSA Library", "c:\\users\\example\\mosa library", win32), true);
  assert.equal(pathsEqual("C:\\Users\\example\\MOSA Library", "D:\\Users\\example\\MOSA Library", win32), false);
});

test("path equality remains case-sensitive on POSIX", () => {
  assert.equal(pathsEqual("/Users/Example/MOSA Library", "/Users/Example/MOSA Library", posix), true);
  assert.equal(pathsEqual("/Users/Example/MOSA Library", "/users/example/mosa library", posix), false);
});

test("Windows absolute paths are not mistaken for URL schemes", () => {
  assert.equal(isAbsoluteLocalPath("C:\\Users\\example\\Pictures\\asset.png", win32), true);
  assert.equal(isAbsoluteLocalPath("\\\\server\\share\\asset.png", win32), true);
  assert.equal(isUrlLikePath("C:\\Users\\example\\Pictures\\asset.png", win32), false);
  assert.equal(isUrlLikePath("file:///C:/Users/example/Pictures/asset.png", win32), true);
  assert.equal(isUrlLikePath("https://example.com/asset.png", win32), true);
});
