import assert from "node:assert/strict";
import test from "node:test";
import { createStatusLiveRegion } from "../web/app/status-live-region.mjs";

const WRITE_DELAY = 32;
const ANNOUNCEMENT_DURATION = 3000;
const BRIDGE_OFF = "桥接未启用";
const BRIDGE_READY = "就绪";
const IMPORT_PROGRESS = "正在导入 3/12 · 成功 2 · 失败 1";
const DROP_HINT = "松开鼠标，导入文件";

/**
 * Manual clock: writes land only when advance() steps past the write delay, so
 * the "bridge poll arrives inside the pending write window" interleavings are
 * driven deterministically instead of by real timing luck.
 */
function createClock() {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map();
  return {
    setTimeout(callback, ms) {
      const handle = nextHandle;
      nextHandle += 1;
      timers.set(handle, { at: now + ms, callback });
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].callback();
      }
      now = target;
    },
    pendingCount: () => timers.size,
  };
}

/** Records every textContent mutation so "no write at all" is observable. */
function createRegionRecorder() {
  const mutations = [];
  let text = "";
  return {
    mutations,
    region: {
      get textContent() {
        return text;
      },
      set textContent(value) {
        text = value;
        mutations.push(value);
      },
    },
    text: () => text,
  };
}

function createRegion() {
  const clock = createClock();
  const recorder = createRegionRecorder();
  const statusRegion = createStatusLiveRegion({
    getRegion: () => recorder.region,
    liveRegionWriteDelay: WRITE_DELAY,
    announcementDuration: ANNOUNCEMENT_DURATION,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { clock, recorder, statusRegion };
}

test("a bridge poll repeating an unchanged status inside the pending write window never cancels the import progress announcement", () => {
  const { clock, recorder, statusRegion } = createRegion();

  // The bridge status landed once; from now on every poll repeats the same text.
  statusRegion.setPersistentStatus(BRIDGE_OFF);
  clock.advance(WRITE_DELAY);
  assert.equal(recorder.text(), BRIDGE_OFF, "first bridge status lands");

  // Import progress starts its clear + delayed write; the poll lands before the
  // delay expires and carries the SAME unchanged status.
  statusRegion.announce(IMPORT_PROGRESS, { persist: true });
  assert.equal(recorder.text(), "", "announce clears the region first");
  statusRegion.setPersistentStatus(BRIDGE_OFF);

  clock.advance(WRITE_DELAY);
  assert.equal(recorder.text(), IMPORT_PROGRESS,
    "the import progress announcement still lands in the live region");
  clock.advance(ANNOUNCEMENT_DURATION);
  assert.equal(recorder.text(), IMPORT_PROGRESS,
    "persist announcements keep the region until the next announce");
});

test("a changed bridge status during the pending write window queues behind the announcement instead of cancelling it", () => {
  const { clock, recorder, statusRegion } = createRegion();

  statusRegion.setPersistentStatus(BRIDGE_READY);
  clock.advance(WRITE_DELAY);
  assert.equal(recorder.text(), BRIDGE_READY, "bridge ready lands first");

  statusRegion.announce(IMPORT_PROGRESS, { persist: true });
  // The bridge drops to offline while the progress write is still pending.
  statusRegion.setPersistentStatus(BRIDGE_OFF);

  clock.advance(WRITE_DELAY);
  assert.equal(recorder.text(), IMPORT_PROGRESS,
    "the announcement is not cancelled by the changed bridge status");

  // The import lifecycle closes with the empty announcement, which publishes
  // the latest persistent status: the bridge change is announced after it.
  statusRegion.announce("");
  clock.advance(WRITE_DELAY);
  assert.equal(recorder.text(), BRIDGE_OFF,
    "the deferred bridge status is announced once the announcement ends");
  assert.deepEqual(recorder.mutations, ["", BRIDGE_READY, "", IMPORT_PROGRESS, "", BRIDGE_OFF],
    "every region mutation keeps the clear-then-write pair");
});

test("a changed bridge status is announced once and repeated polls never write the region again", () => {
  const { clock, recorder, statusRegion } = createRegion();

  statusRegion.setPersistentStatus(BRIDGE_READY);
  clock.advance(WRITE_DELAY);
  assert.equal(recorder.text(), BRIDGE_READY, "ready announced once");

  statusRegion.setPersistentStatus(BRIDGE_OFF);
  clock.advance(WRITE_DELAY);
  assert.equal(recorder.text(), BRIDGE_OFF, "the transition to offline is announced once");

  const writesBefore = recorder.mutations.length;
  for (let poll = 0; poll < 5; poll += 1) {
    statusRegion.setPersistentStatus(BRIDGE_OFF);
    clock.advance(WRITE_DELAY);
  }
  clock.advance(ANNOUNCEMENT_DURATION);
  assert.equal(recorder.text(), BRIDGE_OFF, "the text stays the announced offline status");
  assert.equal(recorder.mutations.length, writesBefore,
    "repeated identical polls must not clear or rewrite the live region");
  assert.equal(clock.pendingCount(), 0, "no announce or write timer keeps running for skipped polls");
});

test("an active announcement defers the bridge status and the restore publishes it afterwards", () => {
  const { clock, recorder, statusRegion } = createRegion();

  statusRegion.setPersistentStatus(BRIDGE_READY);
  clock.advance(WRITE_DELAY);

  statusRegion.announce(DROP_HINT);
  clock.advance(WRITE_DELAY);
  assert.equal(recorder.text(), DROP_HINT, "the announcement owns the region");

  // Bridge goes offline mid-announcement: it must not interrupt.
  statusRegion.setPersistentStatus(BRIDGE_OFF);
  clock.advance(WRITE_DELAY);
  assert.equal(recorder.text(), DROP_HINT, "the bridge status waits while the announcement shows");

  clock.advance(ANNOUNCEMENT_DURATION);
  assert.equal(recorder.text(), BRIDGE_OFF,
    "the restore publishes the latest persistent status after the announcement");
});

test("announcing the same text twice still re-announces it through the clear-then-write pair", () => {
  const { clock, recorder, statusRegion } = createRegion();

  statusRegion.announce(DROP_HINT, { persist: true });
  clock.advance(WRITE_DELAY);
  statusRegion.announce(DROP_HINT, { persist: true });
  clock.advance(WRITE_DELAY);

  assert.equal(recorder.text(), DROP_HINT, "identical consecutive announcements land");
  assert.deepEqual(recorder.mutations, ["", DROP_HINT, "", DROP_HINT],
    "each announcement is its own clear + write mutation pair");
});

test("a transient announcement restores the previous persistent status, and a missing region is a no-op", () => {
  const { clock, recorder, statusRegion } = createRegion();

  statusRegion.setPersistentStatus(BRIDGE_READY);
  clock.advance(WRITE_DELAY);
  statusRegion.announce(DROP_HINT);
  clock.advance(WRITE_DELAY);
  clock.advance(ANNOUNCEMENT_DURATION);
  assert.equal(recorder.text(), BRIDGE_READY, "transient announcement restores the persistent status");

  const detached = createStatusLiveRegion({
    getRegion: () => null,
    liveRegionWriteDelay: WRITE_DELAY,
    announcementDuration: ANNOUNCEMENT_DURATION,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  assert.doesNotThrow(() => detached.announce(DROP_HINT), "missing region ignores announcements");
  assert.doesNotThrow(() => detached.setPersistentStatus(BRIDGE_READY), "missing region ignores status writes");
});
