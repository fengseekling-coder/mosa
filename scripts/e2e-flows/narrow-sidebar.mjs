// Narrow-viewport e2e: the ≤767px sidebar drawer. Seeds through the API, then
// drives the drawer at two widths: 640 (≤700, the vertical-flow fallback) and
// 720 (the 701–767 band, where the inspector used to dock and hide the drawer
// toggle). Each pass asserts every open/close path and live-resizes to 1280
// mid-run via the driver's __MOSA_E2E_RESIZE__ channel to prove the drawer
// resets across the breakpoint.
import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "narrow-sidebar";
export const description = "640px and 720px drawer: open/close/scrim/Esc/favorites/group/settings entries + focus returns + closable inspector + live 1280 resize reset";

const GROUP_NAME = "Narrow Group";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const seed = await seedAssets(ctx, server.origin);
    // 720 is the 701–767 band: before the docked-inspector breakpoint was
    // aligned to 768px, the inspector force-opened there and the drawer toggle
    // was hidden, so navigation was unreachable.
    for (const width of [640, 720]) {
      const result = await ctx.runInPage(server, drawerJourneySource(seed), { windowSize: [width, 900] });
      assertDrawerJourney(result, seed, width);
    }
    await assertApiRechecks(ctx, server.origin, seed);
    return { seed, narrowViewports: [640, 720] };
  } finally {
    await server.stop();
  }
}

async function seedAssets(ctx, origin) {
  const create = async (fileName, color, extra = {}) => {
    const body = await ctx.api(origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng(fileName, color), prompt: `narrow ${fileName}`, ...extra,
    });
    return body.asset.id;
  };
  const plainA = await create("plain-a.png", [74, 127, 181]);
  const plainB = await create("plain-b.png", [96, 74, 155]);
  const favoriteId = await create("favorite.png", [181, 68, 74]);
  await ctx.api(origin, "POST", `/api/assets/default/${encodeURIComponent(favoriteId)}/favorite`);
  const groupId = await create("group-one.png", [58, 138, 87], { group: GROUP_NAME });
  return { plainA, plainB, favoriteId, groupId, groupName: GROUP_NAME };
}

// ===== Node-side assertions =====

function assertDrawerJourney(r, seed, width) {
  const problems = [];
  const eq = (actual, expected, label) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) problems.push(`@${width} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); };

  // Section 1 — initial state.
  eq(r?.initial?.innerWidth, width, "initial innerWidth");
  eq(r?.initial?.mobileQuery, true, "initial matchMedia(max-width:767px)");
  eq(r?.initial?.dockedQuery, false, "initial matchMedia(min-width:768px) (inspector not docked)");
  eq(r?.initial?.toggle?.display, "grid", "initial toggle visible");
  eq(r?.initial?.toggle?.ariaExpanded, "false", "initial toggle aria-expanded");
  eq(r?.initial?.sidebar?.inert, true, "initial sidebar inert");
  eq(r?.initial?.sidebar?.ariaHidden, "true", "initial sidebar aria-hidden");
  eq(r?.initial?.sidebarRight <= 0, true, "initial sidebar off-viewport (right<=0)");
  eq(r?.initial?.scrimHidden, true, "initial scrim hidden");
  eq(r?.initial?.bodyHasDetailOpen, false, "initial body has no detail-open (overlay band)");

  // Section 2 — toggle click opens the drawer.
  eq(r?.openDrawer?.bodyClass, true, "open: body.mobile-nav-open");
  eq(r?.openDrawer?.ariaExpanded, "true", "open: toggle aria-expanded");
  eq(r?.openDrawer?.scrimHidden, false, "open: scrim visible");
  eq(r?.openDrawer?.sidebar?.inert, false, "open: sidebar not inert");
  eq(r?.openDrawer?.sidebar?.ariaHidden, "false", "open: sidebar aria-hidden");
  eq(r?.openDrawer?.sidebarEnteredViewport, true, "open: sidebar entered viewport");
  eq(r?.openDrawer?.focusOnClose, true, "open: focus moved to #mobileNavClose");

  // Section 3 — favorites entry closes the drawer and filters the gallery.
  eq(r?.favorites?.drawerClosed, true, "favorites: drawer closed");
  eq(r?.favorites?.cardIds, [seed.favoriteId], "favorites: gallery shows only the favorite");

  // Section 4 — scrim click closes and returns focus to the toggle.
  eq(r?.scrimStep?.drawerClosed, true, "scrim: drawer closed");
  eq(r?.scrimStep?.focusOnToggle, true, "scrim: focus returned to toggle");

  // Section 5 — Escape closes and returns focus to the toggle.
  eq(r?.escStep?.drawerClosed, true, "esc: drawer closed");
  eq(r?.escStep?.focusOnToggle, true, "esc: focus returned to toggle");

  // Section 6 — manual group entry closes the drawer and filters the gallery.
  eq(r?.groupStep?.drawerClosed, true, "group: drawer closed");
  eq(r?.groupStep?.cardIds, [seed.groupId], "group: gallery shows only the group asset");

  // Section 7 — settings entry closes the drawer, opens the modal, and after
  // closing the modal focus lands back on the toggle (app.mjs:4604 fallback).
  eq(r?.settingsStep?.drawerClosedAfterTrigger, true, "settings: drawer closed by trigger");
  eq(r?.settingsStep?.modalOpen, true, "settings: modal opened");
  eq(r?.settingsStep?.triggerExpanded, "true", "settings: trigger aria-expanded");
  eq(r?.settingsStep?.modalClosedAfterClose, true, "settings: modal closed");
  eq(r?.settingsStep?.focusOnToggleAfterClose, true, "settings: focus returned to toggle");

  // Section 8 — opening an asset in the drawer band shows the floating inspector (CSS:
  // .mosa-v2 .detail is an in-flow rounded card ≤767px, styles.css:1755), not
  // the docked right column (which at >767px has border-radius 0 and top 0).
  eq(r?.overlay?.bodyDetailOpen, true, "overlay: body.detail-open");
  eq(r?.overlay?.detailAriaHidden, "false", "overlay: inspector visible");
  eq(r?.overlay?.dockedQuery, false, "overlay: matchMedia(min-width:768px) false");
  eq(r?.overlay?.detailBorderRadius, "24px", "overlay: inspector floating radius");
  eq(r?.overlay?.detailPosition, "static", "overlay: inspector not fixed/docked");
  eq(r?.overlay?.detailTop > 0, true, "overlay: inspector below the fold (not a docked column)");
  eq(r?.overlay?.drawerStillClosed, true, "overlay: drawer stayed closed");
  eq(r?.overlay?.afterCloseDetailAriaHidden, "true", "overlay: inspector closable");
  eq(r?.overlay?.afterCloseToggleDisplay, "grid", "overlay: toggle visible again after close");

  // Section 9 — live resize to 1280 while the drawer is open resets it.
  eq(r?.resizeWide?.innerWidth, 1280, "resize: innerWidth 1280");
  eq(r?.resizeWide?.mobileQuery, false, "resize: matchMedia(max-width:767px) false");
  eq(r?.resizeWide?.drawerReset, true, "resize: mobile-nav-open removed");
  eq(r?.resizeWide?.scrimHidden, true, "resize: scrim hidden");
  eq(r?.resizeWide?.sidebar?.inert, false, "resize: sidebar not inert");
  eq(r?.resizeWide?.sidebar?.ariaHidden, "false", "resize: sidebar aria-hidden");
  eq(r?.resizeWide?.sidebarRight >= 200, true, "resize: sidebar visible as desktop rail");
  eq(r?.resizeWide?.toggleDisplay, "none", "resize: toggle hidden on desktop");

  if (problems.length) throw new Error(`Unexpected narrow-sidebar result: ${problems.join("; ")} — ${JSON.stringify(r)}`);
}

async function assertApiRechecks(ctx, origin, seed) {
  const problems = [];
  const listIds = async (path) => {
    const page = await ctx.api(origin, "GET", path);
    return (Array.isArray(page?.assets) ? page.assets : []).map((asset) => asset.id).sort();
  };
  const favoriteIds = await listIds(`/api/assets?project=default&favorite=1`);
  if (JSON.stringify(favoriteIds) !== JSON.stringify([seed.favoriteId])) {
    problems.push(`API favorites listing: expected [${seed.favoriteId}], got ${JSON.stringify(favoriteIds)}`);
  }
  const groupIds = await listIds(`/api/assets?project=default&group=${encodeURIComponent(seed.groupName)}`);
  if (JSON.stringify(groupIds) !== JSON.stringify([seed.groupId])) {
    problems.push(`API group listing: expected [${seed.groupId}], got ${JSON.stringify(groupIds)}`);
  }
  if (problems.length) throw new Error(`narrow-sidebar API recheck failed: ${problems.join("; ")}`);
}

// ===== Page sources =====

function drawerJourneySource(seed) {
  return `(async () => {
    const config = ${JSON.stringify(seed)};
    ${PAGE_HELPERS}
    const q = (selector) => document.querySelector(selector);
    const drawerOpen = () => document.body.classList.contains('mobile-nav-open');
    const toggleEl = () => q('#mobileNavToggle');
    const closeEl = () => q('#mobileNavClose');
    const scrimEl = () => q('#mobileNavScrim');
    const sidebarEl = () => q('#appSidebar');
    const detailEl = () => q('#detailPanel');
    // Focus moves ride requestAnimationFrame, which the hidden driver window
    // throttles, so every focus wait gets a long leash.
    const FOCUS_TIMEOUT = 30000;
    const focusIsOn = (element, label) => waitFor(() => document.activeElement === element(), label, FOCUS_TIMEOUT);
    const openDrawerViaToggle = async () => {
      // A real pointer click focuses the button first; element.click() does
      // not, and setMobileNavOpen records the opener as the focus-return
      // target — so mirror the real click's focus side effect.
      toggleEl().focus();
      toggleEl().click();
      await waitFor(drawerOpen, 'drawer opens', FOCUS_TIMEOUT);
      await focusIsOn(closeEl, 'focus moves to the drawer close button');
    };
    const drawerClosedFacts = async () => {
      await waitFor(() => !drawerOpen() && scrimEl().hidden && sidebarEl().hasAttribute('inert'), 'drawer closes', FOCUS_TIMEOUT);
      return { drawerClosed: !drawerOpen() && scrimEl().hidden && sidebarEl().hasAttribute('inert') };
    };

    await waitFor(() => gallerySettled() && rootCardIds().length === 4, 'four seeded cards', 30000);

    // Section 1 — initial state.
    await waitFor(() => getComputedStyle(toggleEl()).display !== 'none' && sidebarEl().hasAttribute('inert'), 'drawer initial state applied', 30000);
    const initial = {
      innerWidth: window.innerWidth,
      mobileQuery: window.matchMedia('(max-width: 767px)').matches,
      dockedQuery: window.matchMedia('(min-width: 768px)').matches,
      toggle: { display: getComputedStyle(toggleEl()).display, ariaExpanded: toggleEl().getAttribute('aria-expanded') },
      sidebar: { inert: sidebarEl().hasAttribute('inert'), ariaHidden: sidebarEl().getAttribute('aria-hidden') },
      sidebarRight: sidebarEl().getBoundingClientRect().right,
      scrimHidden: scrimEl().hidden,
      bodyHasDetailOpen: document.body.classList.contains('detail-open'),
    };

    // Section 2 — toggle opens the drawer.
    await openDrawerViaToggle();
    // The slide-in is a transform transition: wait for it to settle so the
    // recorded geometry is the final position, not a mid-flight frame.
    await waitFor(() => {
      const rect = sidebarEl().getBoundingClientRect();
      return rect.right >= 280 && Math.abs(rect.left) < 0.5;
    }, 'sidebar slides into viewport', FOCUS_TIMEOUT);
    const openRect = sidebarEl().getBoundingClientRect();
    const openDrawer = {
      bodyClass: drawerOpen(),
      ariaExpanded: toggleEl().getAttribute('aria-expanded'),
      scrimHidden: scrimEl().hidden,
      sidebar: { inert: sidebarEl().hasAttribute('inert'), ariaHidden: sidebarEl().getAttribute('aria-hidden') },
      sidebarEnteredViewport: openRect.right >= 280 && Math.abs(openRect.left) < 0.5,
      focusOnClose: document.activeElement === closeEl(),
    };

    // Section 3 — favorites quick filter inside the drawer.
    q('#quickFilters .nav-item[data-filter="favorite"]').click();
    const favorites = {
      ...(await drawerClosedFacts()),
      cardIds: await waitFor(() => {
        if (!gallerySettled()) return null;
        const ids = rootCardIds();
        return ids.length === 1 && ids[0] === config.favoriteId ? ids : null;
      }, 'favorites filter shows only the favorite', 30000),
    };

    // Section 4 — scrim click closes and restores focus to the toggle.
    await openDrawerViaToggle();
    scrimEl().click();
    const scrimStep = {
      ...(await drawerClosedFacts()),
      focusOnToggle: await waitFor(() => document.activeElement === toggleEl(), 'focus returns to toggle after scrim', FOCUS_TIMEOUT) && true,
    };

    // Section 5 — Escape closes and restores focus to the toggle.
    await openDrawerViaToggle();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const escStep = {
      ...(await drawerClosedFacts()),
      focusOnToggle: await waitFor(() => document.activeElement === toggleEl(), 'focus returns to toggle after Escape', FOCUS_TIMEOUT) && true,
    };

    // Section 6 — manual group entry closes the drawer and filters the gallery.
    await openDrawerViaToggle();
    q('.nav-item.nav-group-item[data-value="' + config.groupName + '"]').click();
    const groupStep = {
      ...(await drawerClosedFacts()),
      cardIds: await waitFor(() => {
        if (!gallerySettled()) return null;
        const ids = rootCardIds();
        return ids.length === 1 && ids[0] === config.groupId ? ids : null;
      }, 'group filter shows only the group asset', 30000),
    };

    // Section 7 — settings entry: drawer closes, modal opens; closing the
    // modal sends focus back to the toggle (the recorded return target sits in
    // the now-inert sidebar, app.mjs:4604 falls back to the toggle).
    await openDrawerViaToggle();
    q('.settings-trigger').click();
    await waitFor(() => !drawerOpen() && !q('#settingsMenu').hidden, 'settings modal opens while drawer closes', FOCUS_TIMEOUT);
    const settingsModalFacts = {
      drawerClosedAfterTrigger: !drawerOpen(),
      modalOpen: !q('#settingsMenu').hidden,
      triggerExpanded: q('.settings-trigger').getAttribute('aria-expanded'),
    };
    q('#settingsMenu .settings-modal-close').click();
    await waitFor(() => q('#settingsMenu').hidden, 'settings modal closes', FOCUS_TIMEOUT);
    const settingsStep = {
      ...settingsModalFacts,
      modalClosedAfterClose: q('#settingsMenu').hidden,
      focusOnToggleAfterClose: await waitFor(() => document.activeElement === toggleEl(), 'focus returns to toggle after settings close', FOCUS_TIMEOUT) && true,
    };

    // Section 8 — an asset opened in the drawer band is a floating inspector, and the
    // drawer stays closed behind it.
    q('.asset-card .asset-card-select').click();
    await waitFor(() => document.body.classList.contains('detail-open') && detailEl().getAttribute('aria-hidden') === 'false', 'inspector opens', 30000);
    const overlay = {
      bodyDetailOpen: document.body.classList.contains('detail-open'),
      detailAriaHidden: detailEl().getAttribute('aria-hidden'),
      dockedQuery: window.matchMedia('(min-width: 768px)').matches,
      detailBorderRadius: getComputedStyle(detailEl()).borderRadius,
      detailPosition: getComputedStyle(detailEl()).position,
      detailTop: detailEl().getBoundingClientRect().top,
      drawerStillClosed: !drawerOpen() && scrimEl().hidden && sidebarEl().hasAttribute('inert'),
    };
    q('#detailPanel .detail-close').click();
    await waitFor(() => detailEl().getAttribute('aria-hidden') === 'true' && getComputedStyle(toggleEl()).display !== 'none', 'inspector closes, toggle visible again', 30000);
    overlay.afterCloseDetailAriaHidden = detailEl().getAttribute('aria-hidden');
    overlay.afterCloseToggleDisplay = getComputedStyle(toggleEl()).display;

    // Section 9 — live resize to 1280 while open: the drawer must reset.
    await openDrawerViaToggle();
    console.log('__MOSA_E2E_RESIZE__ 1280x800');
    await waitFor(() => window.innerWidth === 1280, 'window resizes to 1280', FOCUS_TIMEOUT);
    await sleep(300);
    const resizeWide = {
      innerWidth: window.innerWidth,
      mobileQuery: window.matchMedia('(max-width: 767px)').matches,
      drawerReset: !document.body.classList.contains('mobile-nav-open'),
      scrimHidden: scrimEl().hidden,
      sidebar: { inert: sidebarEl().hasAttribute('inert'), ariaHidden: sidebarEl().getAttribute('aria-hidden') },
      sidebarRight: sidebarEl().getBoundingClientRect().right,
      toggleDisplay: getComputedStyle(toggleEl()).display,
    };

    return { initial, openDrawer, favorites, scrimStep, escStep, groupStep, settingsStep, overlay, resizeWide };
  })()`;
}
