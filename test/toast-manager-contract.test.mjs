// Toast Manager contract (Phase 5C / F-16): the single dual-lane feedback
// manager that replaced the legacy single-slot toast — polite lane
// (success/default, role=status container) and assertive lane (error, each
// toast role=alert), FIFO queues with a visible cap of 2 per lane, timers
// that only run while visible, stackable hover/focus pause with
// remaining-based resume, manual error dismissal with a keyboard-safe focus
// strategy, interruptible transitions, and the zero-change perimeters.
// Node standard library only, no network access, and never a whole-file SHA
// of app.js / styles.css / index.html as a substitute for behaviour
// contracts (package manifest pins excepted).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const readApp = () => readFile(resolve(root, "app/app.js"), "utf8");
const readHtml = () => readFile(resolve(root, "app/index.html"), "utf8");
const readCss = () => readFile(resolve(root, "app/styles.css"), "utf8");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const count = (source, needle) => source.split(needle).length - 1;

/** Slices a top-level app.js function up to the next top-level function. */
function functionSlice(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function not found: ${name}`);
  const candidates = ["\nfunction ", "\nasync function "]
    .map((marker) => source.indexOf(marker, start + 1))
    .filter((index) => index !== -1);
  const next = candidates.length ? Math.min(...candidates) : -1;
  return source.slice(start, next === -1 ? source.length : next);
}

/** Slices an indented helper inside the createToastManager closure. */
function managerInnerSlice(managerSource, name) {
  const start = managerSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `manager helper not found: ${name}`);
  const candidates = ["\n  function ", "\n  return { "]
    .map((marker) => managerSource.indexOf(marker, start + 1))
    .filter((index) => index !== -1);
  const next = candidates.length ? Math.min(...candidates) : -1;
  return managerSource.slice(start, next === -1 ? managerSource.length : next);
}

const managerSourceOf = async () => functionSlice(await readApp(), "createToastManager");

// 1-2. One single Toast Manager; showToast is a pure delegation shim.
test("1-2. a single Toast Manager, showToast only delegates", async () => {
  const app = await readApp();
  assert.equal(count(app, "function createToastManager("), 1, "exactly one manager factory");
  assert.equal(count(app, "const toastManager = createToastManager();"), 1, "exactly one manager instance");
  const shim = functionSlice(app, "showToast");
  assert.match(shim, /return toastManager\.show\(message, type\);/, "showToast body is one delegation");
  assert.doesNotMatch(shim, /setTimeout|appendChild|classList/, "showToast carries no queue or DOM logic of its own");
});

// 3-5. Two physically independent containers; the polite ID is preserved.
test("3-5. polite and assertive containers are physically independent", async () => {
  const html = await readHtml();
  assert.equal(count(html, 'id="toastContainer"'), 1, "#toastContainer ID preserved for existing references");
  assert.equal(count(html, 'id="toastErrorContainer"'), 1, "independent #toastErrorContainer added");
  assert.equal(count(html, "toast-stack-polite"), 1, "exactly one polite stack in the markup");
  const polite = html.slice(html.indexOf('id="toastContainer"') - 80, html.indexOf("</div>", html.indexOf('id="toastContainer"')));
  const assertive = html.slice(html.indexOf('id="toastErrorContainer"') - 120, html.indexOf("</div>", html.indexOf('id="toastErrorContainer"')));
  assert.match(polite, /toast-stack toast-stack-polite/, "polite container is the toast-stack class");
  assert.match(assertive, /toast-stack toast-stack-assertive/, "assertive container is the toast-stack class");
  assert.match(html, /id="toastContainer"[^>]*><\/div>/, "polite container starts empty");
  assert.match(html, /id="toastErrorContainer"[^>]*><\/div>/, "assertive container starts empty");
});

// 6-9. Live region semantics: polite container is role=status; the assertive
// container hosts per-toast role=alert and never nests a second live region.
test("6-9. live region split — status container vs per-toast alerts", async () => {
  const html = await readHtml();
  const app = await readApp();
  const polite = html.slice(html.indexOf('class="toast-stack toast-stack-polite"'), html.indexOf("</div>", html.indexOf('class="toast-stack toast-stack-polite"')));
  const assertive = html.slice(html.indexOf('class="toast-stack toast-stack-assertive"'), html.indexOf("</div>", html.indexOf('class="toast-stack toast-stack-assertive"')));
  assert.match(polite, /role="status"/, "polite container is role=status");
  assert.match(polite, /aria-live="polite"/, "polite container is aria-live=polite");
  assert.match(polite, /aria-relevant="additions text"/, "additions and repeated text mutations are announced");
  assert.match(polite, /aria-atomic="false"/, "each addition announced individually");
  assert.doesNotMatch(assertive, /aria-live|role="status"/, "assertive container carries no second polite live region");
  const present = managerInnerSlice(await managerSourceOf(), "present");
  assert.match(present, /if \(entry\.type === "error"\) \{\s*\n\s*element\.setAttribute\("role", "alert"\);/, "every error toast is itself role=alert");
  assert.ok(present.indexOf("message.textContent = entry.message") < present.indexOf("container.appendChild(element)"), "polite toast text is inserted with the status-region addition");
  assert.doesNotMatch(present, /announceTimer|setTimeout\(\(\) =>[\s\S]*message\.textContent/, "polite announcements do not depend on a delayed text mutation");
});

// 10-12. Type routing: success/default → polite, error → assertive.
test("10-12. success/default route to polite, error routes to assertive", async () => {
  const manager = await managerSourceOf();
  assert.match(manager, /const laneOf = \(type\) => \(type === "error" \? "assertive" : "polite"\);/, "error is the only assertive type");
  const show = managerInnerSlice(manager, "show");
  assert.match(show, /const normalizedType = type === "success" \|\| type === "error" \? type : "default";/, "unknown types degrade to default (polite)");
  assert.match(manager, /polite: \{ containerKey: "toastContainer"/, "polite lane paints into #toastContainer");
  assert.match(manager, /assertive: \{ containerKey: "toastErrorContainer"/, "assertive lane paints into #toastErrorContainer");
});

// 13-17. Per-lane visible cap of 2, FIFO pending, never evict a visible toast.
test("13-17. FIFO queues with a visible cap of 2, no eviction", async () => {
  const manager = await managerSourceOf();
  const app = await readApp();
  assert.match(app, /const TOAST_VISIBLE_LIMIT = 2;/, "visible cap constant defined once as 2");
  const pump = managerInnerSlice(manager, "pump");
  assert.match(pump, /while \(lane\.visible\.length < TOAST_VISIBLE_LIMIT && lane\.pending\.length\) \{\s*\n\s*present\(laneName, lane\.pending\.shift\(\)\);/,
    "pump only fills empty visible slots, FIFO via shift");
  const show = managerInnerSlice(manager, "show");
  assert.match(show, /lanes\[lane\]\.pending\.push\(entry\);/, "arrivals join the back of the queue — never the head");
  assert.doesNotMatch(manager, /pending\.pop\(\)|unshift/, "no LIFO anywhere in the manager");
  assert.doesNotMatch(manager, /beginLeave\(lane\.visible\[0\]|visible\.shift\(\)/, "a new toast can never evict a visible one");
});

// 18-22. Timer model: timing starts at visible, per-entry timers, durations.
test("18-22. timers start at visibility, independent per toast, fixed durations", async () => {
  const app = await readApp();
  const manager = await managerSourceOf();
  assert.match(app, /const TOAST_DURATIONS = \{ success: 2200, default: 2200, error: 6000 \};/, "success/default 2200ms, error 6000ms");
  const show = managerInnerSlice(manager, "show");
  assert.match(show, /state: "queued",/, "entries start queued");
  assert.match(show, /timer: null,/, "queued entries hold no timer — waiting consumes no duration");
  const present = managerInnerSlice(manager, "present");
  assert.match(present, /entry\.remaining = entry\.duration;/, "the full duration is granted at visibility");
  assert.match(present, /entry\.timer = setTimeout\(\(\) => beginLeave\(entry\.id, "timeout"\), entry\.remaining\);/, "each visible toast owns its own timer");
  assert.doesNotMatch(app, /\btoastTimer\b/, "no global single timer survives");
});

// 23-29. Pause/resume: stackable reasons, remaining-based resume, no dup timers.
test("23-29. stackable pause reasons with remaining-based resume", async () => {
  const manager = await managerSourceOf();
  const present = managerInnerSlice(manager, "present");
  assert.match(present, /addEventListener\("pointerenter", \(\) => pause\(entry\.id, "pointer"\)\)/, "pointerenter pauses");
  assert.match(present, /addEventListener\("pointerleave", \(\) => resume\(entry\.id, "pointer"\)\)/, "pointerleave resumes");
  assert.match(present, /addEventListener\("focusin", \(\) => pause\(entry\.id, "focus"\)\)/, "focusin pauses");
  assert.match(present, /addEventListener\("focusout", \(event\) => \{ if \(!element\.contains\(event\.relatedTarget\)\) resume\(entry\.id, "focus"\); \}\)/,
    "focusout resumes only when focus really leaves the toast");
  const pause = managerInnerSlice(manager, "pause");
  assert.match(pause, /entry\.pauseReasons\.add\(reason\);/, "reasons accumulate");
  assert.match(pause, /if \(!first\) return;/, "a second reason does not re-settle the remaining time");
  assert.match(pause, /entry\.remaining = Math\.max\(0, entry\.remaining - \(Date\.now\(\) - entry\.startedAt\)\);/, "pause banks the elapsed time");
  const resume = managerInnerSlice(manager, "resume");
  assert.match(resume, /if \(entry\.pauseReasons\.size > 0 \|\| entry\.timer\) return;/, "never resumes while another reason holds or a timer exists");
  assert.match(resume, /setTimeout\(\(\) => beginLeave\(entry\.id, "timeout"\), entry\.remaining\);/, "resume uses the remaining time, never the full duration");
  assert.match(resume, /if \(entry\.remaining <= 0\) \{ beginLeave\(entry\.id, "timeout"\); return; \}/, "zero remaining leaves immediately on resume");
});

// 30-34. Manual dismissal exists only on errors, removes exactly one, pumps next.
test("30-34. error-only native dismiss button pumps the next waiting error", async () => {
  const manager = await managerSourceOf();
  const present = managerInnerSlice(manager, "present");
  assert.equal(count(present, 'dismissButton.type = "button"'), 1, "dismiss is a native button");
  assert.match(present, /dismissButton = document\.createElement\("button"\)/, "created as a real button element");
  const dismissBranch = present.slice(present.indexOf('if (entry.type === "error") {\n      const dismissButton'));
  assert.ok(dismissBranch.length > 0, "the dismiss button only exists inside the error branch");
  assert.doesNotMatch(present.slice(0, present.indexOf('if (entry.type === "error") {\n      const dismissButton')), /dismissButton/, "polite/default toasts render no dismiss button");
  assert.match(present, /dismissButton\.addEventListener\("click", \(event\) => dismiss\(entry\.id, "manual", event\.detail === 0\)\);/,
    "click dismisses only its own toast; event.detail===0 marks keyboard activation");
  const leave = managerInnerSlice(manager, "beginLeave");
  assert.match(leave, /pump\(entry\.lane\);/, "leaving (manual or not) pumps the next waiting item of the same lane");
  assert.match(leave, /lane\.visible = lane\.visible\.filter\(\(item\) => item !== entry\);/, "only the dismissed entry leaves the visible set");
});

// 35-38. Focus: toasts never steal focus; auto-removal never moves it; keyboard
// dismissal has a three-tier safe strategy that never lands on body.
test("35-38. focus never stolen, never dropped to body", async () => {
  const manager = await managerSourceOf();
  const present = managerInnerSlice(manager, "present");
  assert.doesNotMatch(present, /\.focus\(\)/, "present never focuses the toast — appearance is focus-neutral");
  assert.doesNotMatch(present, /tabindex/, "toasts are not tab stops themselves");
  const finalize = managerInnerSlice(manager, "finalize");
  assert.doesNotMatch(finalize, /\.focus\(\)|activeElement/, "auto-removal never touches focus");
  const restore = managerInnerSlice(manager, "restoreAssertiveDismissFocus");
  assert.match(restore, /const nextDismiss = next\?\.element\?\.querySelector\("\.toast-dismiss"\);/, "priority 1: next error's dismiss button");
  assert.match(restore, /isConfirmFocusTarget\(closedEntry\.originFocus\)/, "priority 2: the connected creation-time origin");
  assert.match(restore, /const fallback = state\.viewMode === "asset" \? els\.assetViewBack : els\.searchInput;/, "priority 3: safe per-view element");
  assert.doesNotMatch(restore, /body\.focus|focus\(\);\s*\}$/, "never falls back to body");
  const dismiss = managerInnerSlice(manager, "dismiss");
  assert.match(dismiss, /if \(viaKeyboard && laneName === "assertive"\) restoreAssertiveDismissFocus\(entry\);/,
    "focus restoration only for keyboard dismissal of errors — pointer dismissal never moves focus");
});

// 39-40. Message injection is textContent-only; no HTML pathway exists.
test("39-40. messages are textContent-only, no arbitrary HTML", async () => {
  const manager = await managerSourceOf();
  assert.match(manager, /message\.textContent = entry\.message;/, "the sole message injection point is textContent");
  assert.doesNotMatch(manager, /innerHTML|insertAdjacentHTML|outerHTML/, "no HTML injection surface in the manager");
  const app = await readApp();
  const normalize = functionSlice(app, "normalizeToastMessage");
  assert.match(normalize, /if \(message == null\) return "";/, "null/undefined normalize to empty — never 'undefined'");
  assert.match(normalize, /return text === "\[object Object\]" \? "" : text;/, "plain objects never render as [object Object]");
  assert.match(normalize, /if \(typeof message\.message === "string"\) return message\.message;/, "Error-like payloads unwrap their message");
});

// 41-45. Interruptible transitions, transitionend cleanup, fallback, reduced
// motion, and the legacy single-slot machinery fully removed.
test("41-45. interruptible transitions; legacy single-slot removed", async () => {
  const css = await readCss();
  const app = await readApp();
  const manager = await managerSourceOf();
  assert.match(css, /\.toast \{[^}]*transition: opacity \.18s ease, transform \.18s ease;/, "class + transition model replaces keyframes");
  assert.match(css, /\.toast\.is-visible \{ opacity: 1; transform: translateY\(0\); \}/, "enter state class");
  assert.match(css, /\.toast\.is-leaving \{ opacity: 0; transform: translateY\(4px\); \}/, "leave state class");
  assert.doesNotMatch(css, /@keyframes toast-in|@keyframes toast-out/, "uninterruptible toast keyframes removed");
  assert.doesNotMatch(css, /\.toast\.fading/, "the fading class is gone");
  const leave = managerInnerSlice(manager, "beginLeave");
  assert.match(leave, /element\.classList\.add\("is-leaving"\);/, "leaving flips the transition class");
  assert.match(leave, /addEventListener\("transitionend", \(event\) => \{ if \(event\.target === element\) finalize\(entry\.id\); \}, \{ once: true \}\)/,
    "transitionend drives cleanup");
  assert.match(leave, /entry\.leaveTimer = setTimeout\(\(\) => finalize\(entry\.id\), TOAST_LEAVE_FALLBACK_MS\);/, "short fallback timer guards zombie nodes");
  assert.match(app, /const TOAST_LEAVE_FALLBACK_MS = 400;/, "fallback is short");
  const finalize = managerInnerSlice(manager, "finalize");
  assert.match(finalize, /if \(!entry \|\| entry\.state === "removed"\) return;/, "a toast finalizes exactly once");
  assert.match(css, /\.toast \{ transition: none; transform: none; \}/, "reduced motion: no displacement, no transition");
});

// 46-48. No dedupe, no cross-lane eviction.
test("46-48. no dedupe; polite and assertive never evict each other", async () => {
  const manager = await managerSourceOf();
  const show = managerInnerSlice(manager, "show");
  assert.doesNotMatch(show, /find\(|includes\(|some\(.*message/, "identical messages are never merged or deduped");
  const pump = managerInnerSlice(manager, "pump");
  assert.match(pump, /const lane = lanes\[laneName\];/, "pump only ever touches its own lane");
  assert.doesNotMatch(manager, /lanes\.polite.*assertive|cross/, "no cross-lane manipulation exists");
});

// 49-51. Call-site compatibility: signature, runAction path, Cowart inline feedback.
test("49-51. existing call sites stay compatible", async () => {
  const app = await readApp();
  assert.match(app, /function showToast\(message, type = "default"\)/, "(message, type) signature preserved");
  assert.match(app, /async function runAction\(action\) \{ try \{ await action\(\); \} catch \(error\) \{ showToast\(error\.message, "error"\); \} \}/,
    "runAction still reports through showToast only — no second error pipeline");
  assert.match(app, /state\.cowartInsertFeedback = \{ assetKey, type: "success", message \};/, "Cowart inline success feedback kept");
  assert.match(app, /state\.cowartInsertFeedback = \{ assetKey, type: "error", message: error\.message \};/, "Cowart inline error feedback kept");
  assert.match(app, /renderCowartInsertStatus\(\);/, "Cowart inline renderer kept — the manager does not replace it");
  const successCalls = count(app, '"success")');
  const errorCalls = count(app, '"error")');
  assert.ok(successCalls >= 20, `success call sites preserved (${successCalls} >= 20)`);
  assert.ok(errorCalls >= 5, `error call sites preserved (${errorCalls} >= 5)`);
});

// 52-55. Neighbouring contracts stay structurally intact (their own suites
// carry the full behaviour proof; this file only pins the shared seams).
test("52-55. ConfirmDialog / Anchored Overlay / Viewer / F-08 seams intact", async () => {
  const app = await readApp();
  const html = await readHtml();
  assert.equal(count(html, 'id="confirmDialog"'), 1, "ConfirmDialog DOM still present");
  assert.match(app, /function requestConfirmation\(\{/, "ConfirmDialog Promise API intact");
  assert.equal(count(app, "function createAnchoredOverlayManager("), 1, "Anchored Overlay Manager intact");
  assert.match(app, /state\.libraryReturnSnapshot = \{/, "Viewer return snapshot intact");
  assert.match(app, /function openAssetView\(/, "Viewer open path intact");
  assert.match(app, /data-action="empty-view-all"/, "F-08 gallery empty-state actions intact");
  assert.match(app, /data-action="empty-open-library"/, "F-08 empty-state library entry intact");
});

// 56. i18n: dismiss + container names exist symmetrically in zh and en.
test("56. i18n keys symmetric across zh and en", async () => {
  const { default: translations } = await import(pathToFileURL(resolve(root, "app/i18n.mjs")).href);
  for (const locale of ["zh", "en"]) {
    assert.ok(translations[locale].notifications?.length > 0, `${locale}.notifications exists`);
    assert.ok(translations[locale].dismissNotification?.length > 0, `${locale}.dismissNotification exists`);
  }
  assert.notEqual(translations.zh.notifications, translations.en.notifications, "container name localized");
  assert.notEqual(translations.zh.dismissNotification, translations.en.dismissNotification, "dismiss name localized");
  const app = await readApp();
  assert.match(app, /dismissButton\.dataset\.i18nAriaLabel = "dismissNotification";/, "dismiss buttons re-localize on language switch via applyI18n");
  const html = await readHtml();
  assert.match(html, /id="toastErrorContainer" data-i18n-aria-label="notifications"/, "error container name re-localizes on language switch");
});

// 57-58. Package manifest and lockfile frozen; no new dependencies.
test("57-58. package manifest and lockfile unchanged", async () => {
  const pkg = await readFile(resolve(root, "package.json"), "utf8");
  const lock = await readFile(resolve(root, "package-lock.json"), "utf8");
  assert.equal(sha256(pkg), "e161974a477853703cc88724de39805fe5c65e590bd331060a17be6d087a2f24", "package.json frozen");
  assert.equal(sha256(lock), "50a7d029b6aed62fd921ca013f00dba1b01d2ce96009792fb69c63207a04c8dd", "package-lock.json frozen");
});

// 59. The stylesheet stays free of !important while hosting toast styles.
test("59. toast styles without !important", async () => {
  const css = await readCss();
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(withoutComments, /!important/, "stylesheet must stay free of !important");
  assert.match(css, /\.toast-stack \{ position: fixed; z-index: var\(--z-toast\);/, "stacks reuse the existing toast z-index token");
  assert.match(css, /\.toast-stack \{[^}]*pointer-events: none;/, "stacks never intercept clicks below them");
  assert.match(css, /\.toast \{[^}]*pointer-events: auto;/, "only the toast itself receives the pointer");
  assert.match(css, /\.toast-stack-polite \{ bottom: calc\(20px \+ var\(--toast-error-stack-height, 0px\)\); \}/, "polite stack floats above the error stack");
});

// 60. Exactly one manager — no second parallel implementation anywhere.
test("60. no second toast manager", async () => {
  const app = await readApp();
  const html = await readHtml();
  assert.equal(count(app, "createToastManager("), 2, "factory defined once, instantiated once");
  assert.equal(count(html, "toast-stack"), 4, "exactly two toast stacks in the DOM (class mentions in markup/comments)");
  assert.equal(count(html, 'role="status" aria-live="polite" aria-relevant="additions text"'), 1, "only one toast live region exists");
  assert.equal(count(app, "TOAST_DURATIONS"), 3, "duration table referenced only inside the one manager");
});
