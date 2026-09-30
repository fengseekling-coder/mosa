import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

for (const tree of ["web/app", "desktop/app"]) {
  test(`${tree} context menu cancels deferred listener registration on hide`, async () => {
    const source = await readFile(new URL(`../${tree}/context-menu.mjs`, import.meta.url), "utf8");
    assert.match(source, /const registerTimer = setTimeout\(\(\) => \{\n\s+document\.addEventListener\("click", closeHandler\);/,
      "document/window listeners must be registered through a tracked timer");
    assert.match(source, /menu\._cleanup = \(\) => \{\n\s+clearTimeout\(registerTimer\);/,
      "cleanup must cancel a registration that has not fired yet, or the listeners leak");
  });
}
