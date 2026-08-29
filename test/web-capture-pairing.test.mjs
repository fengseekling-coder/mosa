import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadOrCreateWebCaptureToken,
  MOSA_WEB_CAPTURE_DEFAULT_ORIGINS,
  MOSA_WEB_CAPTURE_DEVELOPMENT_EXTENSION_ID,
  MOSA_WEB_CAPTURE_EXTENSION_ID,
  MOSA_WEB_CAPTURE_EXTENSION_IDS,
  MOSA_WEB_CAPTURE_EXTENSION_ORIGIN,
  MOSA_WEB_CAPTURE_EXTENSION_ORIGINS,
  MOSA_WEB_CAPTURE_STORE_EXTENSION_ID,
} from "../desktop/web-capture-pairing.mjs";

test("desktop Web Capture pairing accepts both development and Chrome Web Store identities", () => {
  assert.match(MOSA_WEB_CAPTURE_EXTENSION_ID, /^[a-p]{32}$/);
  assert.equal(MOSA_WEB_CAPTURE_EXTENSION_ORIGIN, `chrome-extension://${MOSA_WEB_CAPTURE_EXTENSION_ID}`);
  assert.equal(MOSA_WEB_CAPTURE_EXTENSION_ID, MOSA_WEB_CAPTURE_DEVELOPMENT_EXTENSION_ID);
  assert.equal(MOSA_WEB_CAPTURE_STORE_EXTENSION_ID, "bhjibabaiccjjfcdbimeeaoaikhcfncc");
  assert.deepEqual(MOSA_WEB_CAPTURE_EXTENSION_IDS, [
    MOSA_WEB_CAPTURE_DEVELOPMENT_EXTENSION_ID,
    MOSA_WEB_CAPTURE_STORE_EXTENSION_ID,
  ]);
  assert.deepEqual(MOSA_WEB_CAPTURE_EXTENSION_ORIGINS, [
    `chrome-extension://${MOSA_WEB_CAPTURE_DEVELOPMENT_EXTENSION_ID}`,
    `chrome-extension://${MOSA_WEB_CAPTURE_STORE_EXTENSION_ID}`,
  ]);
  assert.equal(MOSA_WEB_CAPTURE_DEFAULT_ORIGINS, MOSA_WEB_CAPTURE_EXTENSION_ORIGINS.join(","));
});

test("desktop creates one private persistent Web Capture token", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-pairing-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await loadOrCreateWebCaptureToken(root);
  const second = await loadOrCreateWebCaptureToken(root);
  assert.equal(second, first);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);

  const tokenPath = join(root, "web-capture-token");
  await access(tokenPath);
  assert.equal((await readFile(tokenPath, "utf8")).trim(), first);
  const mode = (await stat(tokenPath)).mode & 0o777;
  assert.equal(mode, 0o600);
});
