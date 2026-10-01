import assert from "node:assert/strict";
import test from "node:test";
import { createStatusLiveRegion as createWebStatusLiveRegion } from "../web/app/status-live-region.mjs";
import { createStatusLiveRegion as createDesktopStatusLiveRegion } from "../desktop/app/status-live-region.mjs";

// 每棵 UI 树各有一份 status-live-region.mjs 拷贝，行为用例对双树各跑一遍。
const TREES = [
  ["web", createWebStatusLiveRegion],
  ["desktop", createDesktopStatusLiveRegion],
];

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

function createRegion(createStatusLiveRegion) {
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
  for (const [tree, createStatusLiveRegion] of TREES) {
    const { clock, recorder, statusRegion } = createRegion(createStatusLiveRegion);

    // The bridge status landed once; from now on every poll repeats the same text.
    statusRegion.setPersistentStatus(BRIDGE_OFF);
    clock.advance(WRITE_DELAY);
    assert.equal(recorder.text(), BRIDGE_OFF, `${tree}: first bridge status lands`);

    // Import progress starts its clear + delayed write; the poll lands before the
    // delay expires and carries the SAME unchanged status.
    statusRegion.announce(IMPORT_PROGRESS, { persist: true });
    assert.equal(recorder.text(), "", `${tree}: announce clears the region first`);
    statusRegion.setPersistentStatus(BRIDGE_OFF);

    clock.advance(WRITE_DELAY);
    assert.equal(recorder.text(), IMPORT_PROGRESS,
      `${tree}: the import progress announcement still lands in the live region`);
    clock.advance(ANNOUNCEMENT_DURATION);
    assert.equal(recorder.text(), IMPORT_PROGRESS,
      `${tree}: persist announcements keep the region until the next announce`);
  }
});

test("a changed bridge status during the pending write window queues behind the announcement instead of cancelling it", () => {
  for (const [tree, createStatusLiveRegion] of TREES) {
    const { clock, recorder, statusRegion } = createRegion(createStatusLiveRegion);

    statusRegion.setPersistentStatus(BRIDGE_READY);
    clock.advance(WRITE_DELAY);
    assert.equal(recorder.text(), BRIDGE_READY, `${tree}: bridge ready lands first`);

    statusRegion.announce(IMPORT_PROGRESS, { persist: true });
    // The bridge drops to offline while the progress write is still pending.
    statusRegion.setPersistentStatus(BRIDGE_OFF);

    clock.advance(WRITE_DELAY);
    assert.equal(recorder.text(), IMPORT_PROGRESS,
      `${tree}: the announcement is not cancelled by the changed bridge status`);

    // The import lifecycle closes with the empty announcement, which publishes
    // the latest persistent status: the bridge change is announced after it.
    statusRegion.announce("");
    clock.advance(WRITE_DELAY);
    assert.equal(recorder.text(), BRIDGE_OFF,
      `${tree}: the deferred bridge status is announced once the announcement ends`);
    assert.deepEqual(recorder.mutations, ["", BRIDGE_READY, "", IMPORT_PROGRESS, "", BRIDGE_OFF],
      `${tree}: every region mutation keeps the clear-then-write pair`);
  }
});

test("a changed bridge status is announced once and repeated polls never write the region again", () => {
  for (const [tree, createStatusLiveRegion] of TREES) {
    const { clock, recorder, statusRegion } = createRegion(createStatusLiveRegion);

    statusRegion.setPersistentStatus(BRIDGE_READY);
    clock.advance(WRITE_DELAY);
    assert.equal(recorder.text(), BRIDGE_READY, `${tree}: ready announced once`);

    statusRegion.setPersistentStatus(BRIDGE_OFF);
    clock.advance(WRITE_DELAY);
    assert.equal(recorder.text(), BRIDGE_OFF, `${tree}: the transition to offline is announced once`);

    const writesBefore = recorder.mutations.length;
    for (let poll = 0; poll < 5; poll += 1) {
      statusRegion.setPersistentStatus(BRIDGE_OFF);
      clock.advance(WRITE_DELAY);
    }
    clock.advance(ANNOUNCEMENT_DURATION);
    assert.equal(recorder.text(), BRIDGE_OFF, `${tree}: the text stays the announced offline status`);
    assert.equal(recorder.mutations.length, writesBefore,
      `${tree}: repeated identical polls must not clear or rewrite the live region`);
    assert.equal(clock.pendingCount(), 0, `${tree}: no announce or write timer keeps running for skipped polls`);
  }
});

test("an active announcement defers the bridge status and the restore publishes it afterwards", () => {
  for (const [tree, createStatusLiveRegion] of TREES) {
    const { clock, recorder, statusRegion } = createRegion(createStatusLiveRegion);

    statusRegion.setPersistentStatus(BRIDGE_READY);
    clock.advance(WRITE_DELAY);

    statusRegion.announce(DROP_HINT);
    clock.advance(WRITE_DELAY);
    assert.equal(recorder.text(), DROP_HINT, `${tree}: the announcement owns the region`);

    // Bridge goes offline mid-announcement: it must not interrupt.
    statusRegion.setPersistentStatus(BRIDGE_OFF);
    clock.advance(WRITE_DELAY);
    assert.equal(recorder.text(), DROP_HINT, `${tree}: the bridge status waits while the announcement shows`);

    clock.advance(ANNOUNCEMENT_DURATION);
    assert.equal(recorder.text(), BRIDGE_OFF,
      `${tree}: the restore publishes the latest persistent status after the announcement`);
  }
});

test("announcing the same text twice still re-announces it through the clear-then-write pair", () => {
  for (const [tree, createStatusLiveRegion] of TREES) {
    const { clock, recorder, statusRegion } = createRegion(createStatusLiveRegion);

    statusRegion.announce(DROP_HINT, { persist: true });
    clock.advance(WRITE_DELAY);
    statusRegion.announce(DROP_HINT, { persist: true });
    clock.advance(WRITE_DELAY);

    assert.equal(recorder.text(), DROP_HINT, `${tree}: identical consecutive announcements land`);
    assert.deepEqual(recorder.mutations, ["", DROP_HINT, "", DROP_HINT],
      `${tree}: each announcement is its own clear + write mutation pair`);
  }
});

test("a transient announcement restores the previous persistent status, and a missing region is a no-op", () => {
  for (const [tree, createStatusLiveRegion] of TREES) {
    const { clock, recorder, statusRegion } = createRegion(createStatusLiveRegion);

    statusRegion.setPersistentStatus(BRIDGE_READY);
    clock.advance(WRITE_DELAY);
    statusRegion.announce(DROP_HINT);
    clock.advance(WRITE_DELAY);
    clock.advance(ANNOUNCEMENT_DURATION);
    assert.equal(recorder.text(), BRIDGE_READY, `${tree}: transient announcement restores the persistent status`);

    const detached = createStatusLiveRegion({
      getRegion: () => null,
      liveRegionWriteDelay: WRITE_DELAY,
      announcementDuration: ANNOUNCEMENT_DURATION,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    assert.doesNotThrow(() => detached.announce(DROP_HINT), `${tree}: missing region ignores announcements`);
    assert.doesNotThrow(() => detached.setPersistentStatus(BRIDGE_READY), `${tree}: missing region ignores status writes`);
  }
});
