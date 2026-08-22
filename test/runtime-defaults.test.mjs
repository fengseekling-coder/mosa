import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MOSA_DESKTOP_PORT,
  DEFAULT_MOSA_PORT,
  normalizeMosaPort,
} from "../lib/runtime-defaults.mjs";

test("uses one default port for the bridge and desktop runtime", () => {
  assert.equal(DEFAULT_MOSA_PORT, 43517);
  assert.equal(DEFAULT_MOSA_DESKTOP_PORT, 43517);
  assert.equal(DEFAULT_MOSA_PORT, DEFAULT_MOSA_DESKTOP_PORT);
});

test("allows an ephemeral port only for isolated runtime tests", () => {
  assert.equal(normalizeMosaPort(0, { allowZero: true }), 0);
  assert.throws(() => normalizeMosaPort(0), /1 to 65535/);
  assert.throws(() => normalizeMosaPort("invalid", { allowZero: true }), /0 to 65535/);
});
