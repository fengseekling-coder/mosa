/**
 * The screen-reader announcement lane behind #statusText (role="status",
 * aria-live="polite", visually hidden). Two write sources share one region:
 *
 * - Announcements (announce): import progress, drag hints, scan progress.
 *   Transient unless persist=true; when a transient announcement ends, the
 *   persistent status is written back. Every write clears the region and
 *   repopulates it after LIVE_REGION_WRITE_DELAY as a separate DOM mutation,
 *   which is what makes screen readers re-announce an identical text.
 *
 * - The persistent (bridge) status (setPersistentStatus): polled every few
 *   seconds by the bridge-status poller. Two rules keep the poller from
 *   drowning announcements out of the region:
 *   1. an unchanged value never enters the region (the visible bridge label
 *      is the caller's business and keeps updating on every poll);
 *   2. while an announcement is active the value waits; the announcement
 *      lifecycle publishes the latest persistent status when it ends (the
 *      restore timer or the closing announce("")).
 *
 * Timers are injectable so tests can step through the delay windows.
 */
export function createStatusLiveRegion({
  getRegion,
  liveRegionWriteDelay = 32,
  announcementDuration = 3000,
  setTimeout: setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimeout: clearTimer = (handle) => clearTimeout(handle),
} = {}) {
  if (typeof getRegion !== "function") throw new Error("The status live region requires a getRegion callback.");
  const writeDelayMs = Number.isFinite(liveRegionWriteDelay) ? Math.max(0, liveRegionWriteDelay) : 32;
  const announcementMs = Number.isFinite(announcementDuration) ? Math.max(1, announcementDuration) : 3000;

  let persistentValue = "";
  let announcedPersistentValue = null;
  let writeTimer = null;
  let pendingWriteValue = null;
  let restoreTimer = null;
  let announcementSequence = 0;
  let announcementActive = false;

  // Clear and repopulate the shared status node in separate DOM mutations. This
  // gives VoiceOver a reliable text mutation to announce when the same status is
  // emitted twice in a row.
  function write(value, source) {
    const region = getRegion();
    if (!region) return;
    value = String(value ?? "");
    if (writeTimer !== null) {
      clearTimer(writeTimer);
      writeTimer = null;
      pendingWriteValue = null;
    }
    region.textContent = "";
    if (!value) return;
    pendingWriteValue = value;
    writeTimer = setTimer(() => {
      writeTimer = null;
      const text = pendingWriteValue;
      pendingWriteValue = null;
      const node = getRegion();
      if (!node) return;
      if (source === "persistent") announcedPersistentValue = text;
      node.textContent = text;
    }, writeDelayMs);
  }

  function setPersistentStatus(value) {
    persistentValue = String(value ?? "");
    // The poller repeats the same status every few seconds; rewriting it would
    // cancel whatever announcement is waiting to land.
    if (persistentValue === announcedPersistentValue) return;
    // An active announcement owns the region until it ends; the restore timer
    // or the closing announce("") then writes persistentValue back.
    if (announcementActive) return;
    write(persistentValue, "persistent");
  }

  function announce(message, { persist = false } = {}) {
    const region = getRegion();
    if (!region) return;
    if (restoreTimer !== null) {
      clearTimer(restoreTimer);
      restoreTimer = null;
    }
    const sequence = ++announcementSequence;
    const announcement = String(message ?? "");
    if (!announcement) {
      announcementActive = false;
      write(persistentValue, "persistent");
      return;
    }
    announcementActive = true;
    write(announcement, "announce");
    if (persist) return;
    restoreTimer = setTimer(() => {
      if (sequence !== announcementSequence) return;
      restoreTimer = null;
      announcementActive = false;
      write(persistentValue, "persistent");
    }, announcementMs);
  }

  return { announce, setPersistentStatus };
}
