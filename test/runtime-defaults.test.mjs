import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MOSA_DESKTOP_PORT,
  DEFAULT_MOSA_PORT,
  normalizeMosaPort,
} from "../lib/runtime-defaults.mjs";

test("keeps the legacy bridge and desktop runtime defaults distinct", () => {
  assert.equal(DEFAULT_MOSA_PORT, 43517);
  assert.equal(DEFAULT_MOSA_DESKTOP_PORT, 43519);
  assert.notEqual(DEFAULT_MOSA_PORT, DEFAULT_MOSA_DESKTOP_PORT);
});

test("allows an ephemeral port only for isolated runtime tests", () => {
  assert.equal(normalizeMosaPort(0, { allowZero: true }), 0);
  assert.throws(() => normalizeMosaPort(0), /1 to 65535/);
  assert.throws(() => normalizeMosaPort("invalid", { allowZero: true }), /0 to 65535/);
});
