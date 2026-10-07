// GravityPort A4a（任务 73）：检视器重排契约。锁定：滚动列六区块顺序、色块行
// （8 上限/空态不渲染/视频不渲染/aria-label/JS 上色）、提示词页签（两段有两个、
// 一段没有）、版本树与上下文取 3 行规则、底部固定路径栏（有路径/无路径）、
// 新 i18n 键中英文对称，以及两个纯函数（inspectorPaletteSwatches /
// generationContextRows）的直接行为。Node 标准库 + 既有 web/app 模块，零网络。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { createInspectorMarkup, generationContextRows, inspectorPaletteSwatches, INSPECTOR_PALETTE_LIMIT, INSPECTOR_VERSION_CONTEXT_ROWS } from "../web/app/inspector-markup.mjs";
import { createInspectorOverlay } from "../web/app/inspector-overlay.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

const t = (key, params = {}) => {
  const table = {
    copyColorAria: `复制颜色 ${params.color}`,
    colorPalette: "色板",
    notGrouped: "未分组",
    notRecorded: "未记录",
    prompt: "提示词",
    promptTab1: "提示词1",
    promptTab2: "提示词2",
    viewAction: "查看",
    versionTreeTitle: "版本树与上下文",
    assetPathLabel: "素材路径",
    openPathAction: "打开",
    generationModelLine: `模型：${params.value}`,
    generationCurrentAsset: "当前素材",
    generationHistoryEmpty: "暂无生成记录",
    generationHistoryLoading: "正在加载生成历史…",
    referenceImage: "参考图",
    referenceLoading: "正在读取…",
    referenceNone: "无参考图",
    fileFacts: "基础信息",
    assetMetadata: "素材标签",
    tags: "标签",
    addTag: "添加标签",
    userInstruction: "用户指令",
    copyPrompt: "复制提示词",
    copyUserInstruction: "复制用户指令",
    userInstructionUnavailable: "未提供用户指令",
    removeTag: `删除标签「${params.tag}」`,
    sourceUnknown: "未知来源",
  };
  return table[key] ?? key;
};
const state = { groups: { groups: [] }, locale: "zh-CN", assets: [] };
const createHelpers = () => createInspectorMarkup({ state, t, referenceRightsMarkup: () => "" });

// ===== 区块顺序 =====

test("scroll column composes the six A4a sections in the design order", async () => {
  const app = await read("web/app/app.mjs");
  const start = app.indexOf("${detailFileSectionMarkup(asset)}");
  const end = app.indexOf(">", app.indexOf("${detailVersionContextSectionMarkup(asset, cachedGenerationHistory)}"));
  const composition = app.slice(start, end);
  const order = [...composition.matchAll(/\$\{detail(\w+)Markup/g)].map((match) => match[1]);
  assert.deepEqual(order, ["FileSection", "TagsSection", "PaletteSection", "PromptSection", "ReferenceSection", "VersionContextSection"]);
  // 拿掉的区块不得回到滚动列。
  for (const retired of ["detailSourceSectionMarkup", "detailGroupSectionMarkup", "detailMoreSectionMarkup", "editRecipeFieldsMarkup", "recipeHistoryDisclosureMarkup"]) {
    assert.ok(!composition.includes(retired), `${retired} stays out of the scroll column`);
  }
  // 版本树浮层主体由 renderDetailOverlays 组装。
  assert.match(app, /versionBody\.innerHTML = detailVersionSectionMarkup\(asset, cachedHistory, null, cachedGenerationHistory\);/);
  assert.match(app, /<div data-reference-rights>\$\{referenceRightsMarkup\(asset\)\}<\/div>/);
});

// ===== 色块行 =====

test("palette swatches: cap at 8, dedupe, drop invalid hex", () => {
  assert.equal(INSPECTOR_PALETTE_LIMIT, 8);
  const asset = { palette: ["#A1B2C3", "#a1b2c3", "#ABC", "nope", "#12345", "#DDEEFF", "#000000", "#111111", "#222222", "#333333", "#444444"] };
  const swatches = inspectorPaletteSwatches(asset);
  assert.equal(swatches.length, INSPECTOR_PALETTE_LIMIT);
  assert.equal(swatches[0], "#A1B2C3", "first occurrence wins the case-insensitive dedupe");
  assert.ok(!swatches.includes("#a1b2c3"));
  assert.ok(!swatches.includes("nope") && !swatches.includes("#12345"));
});

test("palette row does not render when empty/missing or on video assets", () => {
  const helpers = createHelpers();
  assert.equal(helpers.detailPaletteSectionMarkup({}), "", "missing palette renders no row");
  assert.equal(helpers.detailPaletteSectionMarkup({ palette: [] }), "", "empty palette renders no row");
  assert.equal(helpers.detailPaletteSectionMarkup({ palette: ["#A1B2C3"], source: { media_kind: "video" } }), "", "video assets render no row");
  assert.equal(helpers.detailPaletteSectionMarkup({ palette: ["#A1B2C3"], business_fields: { media_kind: "video" } }), "", "business-field videos render no row");
  const markup = helpers.detailPaletteSectionMarkup({ palette: ["#A1B2C3"] });
  assert.ok(markup.includes('data-inspector-section="palette"'));
  assert.ok(markup.includes('data-swatch-color="#A1B2C3"'));
  // markup 无内联 style（上色由 app.mjs 经 CSSOM 写入，既有卫生约束）。
  assert.ok(!markup.includes('style="'), "palette swatches keep inline styles out of the markup");
  // 8 块上限在渲染层同样生效。
  const eight = helpers.detailPaletteSectionMarkup({ palette: Array.from({ length: 12 }, (_, index) => `#AA${String(index).padStart(4, "0")}`.replace(/#AA0000$/, "#AABBC0")) });
  assert.equal([...eight.matchAll(/data-action="copy-swatch"/g)].length, 8);
});

test("each swatch is a keyboard-focusable button with the copy-color aria-label", () => {
  const helpers = createHelpers();
  const markup = helpers.detailPaletteSectionMarkup({ palette: ["#A1B2C3", "#DDEEFF"] });
  assert.ok(markup.includes('<button class="detail-palette-swatch" type="button" data-action="copy-swatch"'));
  assert.ok(markup.includes('aria-label="复制颜色 #A1B2C3"'));
  assert.ok(markup.includes('aria-label="复制颜色 #DDEEFF"'));
  assert.ok(markup.includes('role="group" aria-label="色板"'));
  // app.mjs 用 CSSOM 上色并绑定复制 + toast。
});

test("app.mjs paints swatches via CSSOM and copies the hex with a toast", async () => {
  const app = await read("web/app/app.mjs");
  const bindings = app.slice(app.indexOf('panel.querySelectorAll(\'[data-action="copy-swatch"]\')'));
  assert.match(bindings, /button\.style\.background = String\(button\.dataset\.swatchColor \|\| "transparent"\)/);
  assert.match(bindings, /writeClipboardText\(String\(button\.dataset\.swatchColor \|\| ""\)\)/);
  assert.match(bindings, /showToast\(t\("copySuccess"\), "success"\)/);
});

// ===== 提示词页签 =====

test("two prompt segments render two tabs; a single segment renders the plain title", () => {
  const helpers = createHelpers();
  const two = helpers.detailPromptSectionMarkup({
    prompt: "主提示词",
    source: { generation_request_prompt: "发给图像工具的提示词" },
  });
  assert.ok(two.includes('data-prompt-variant="1"'), "tab 1 renders");
  assert.ok(two.includes('data-prompt-variant="2"'), "tab 2 renders");
  assert.ok(two.includes(">提示词1</button>") && two.includes(">提示词2</button>"));
  assert.ok(two.includes('aria-pressed="true"') && two.includes('aria-pressed="false"'));
  const one = helpers.detailPromptSectionMarkup({ prompt: "主提示词", source: {} });
  assert.ok(!one.includes("data-prompt-variant"), "a single prompt renders no tabs");
  assert.ok(one.includes("<h3>提示词</h3>"));
});

// ===== 版本树与上下文（3 行规则）=====

const iso = (secondsAgo) => new Date(Date.UTC(2026, 0, 1, 0, 0, secondsAgo)).toISOString();
const historyWith = (events, extra = {}) => ({
  events,
  context_events: extra.context_events || [],
  output_assets: (events).map((event) => ({ id: event.output_asset_id, thumbnail_url: `thumb://${event.output_asset_id}`, thumbnail_ready: true })),
  relations: [],
});

test("generationContextRows centers on the current asset and takes the nearest neighbours", () => {
  assert.equal(INSPECTOR_VERSION_CONTEXT_ROWS, 3);
  const events = [
    { id: "e1", output_asset_id: "a1", provider: "chatgpt", model: "gpt-5", created_at: iso(10) },
    { id: "e2", output_asset_id: "a2", provider: "chatgpt", model: "gpt-5", created_at: iso(20) },
    { id: "e3", output_asset_id: "a3", provider: "chatgpt", model: "gpt-5", created_at: iso(30) },
    { id: "e4", output_asset_id: "a4", provider: "chatgpt", model: "gpt-5", created_at: iso(40) },
    { id: "e5", output_asset_id: "a5", provider: "chatgpt", model: "gpt-5", created_at: iso(50) },
  ];
  // 以 e3（a3）为中心 → 前 1 + 中 + 后 1。
  const centered = generationContextRows(historyWith(events), "a3");
  assert.deepEqual(centered.map((row) => row.event.id), ["e2", "e3", "e4"]);
  assert.deepEqual(centered.map((row) => row.isCurrent), [false, true, false]);
  // 以最早的一条为中心 → 前方不足时向后补足，仍取 3 条。
  const first = generationContextRows(historyWith(events), "a1");
  assert.deepEqual(first.map((row) => row.event.id), ["e1", "e2", "e3"]);
  assert.equal(first[0].isCurrent, true);
  // 以最晚的一条为中心 → 后方不足时向前补足，仍取 3 条。
  const last = generationContextRows(historyWith(events), "a5");
  assert.deepEqual(last.map((row) => row.event.id), ["e3", "e4", "e5"]);
  assert.equal(last.at(-1).isCurrent, true);
  // 中心不在 events 而在 context_events：同样作为中心。
  const withContext = generationContextRows(historyWith(events.slice(0, 2), { context_events: [events[4]] }), "a5");
  assert.deepEqual(withContext.map((row) => row.event.id), ["e1", "e2", "e5"]);
  assert.equal(withContext.at(-1).isCurrent, true);
  // 中心缺失（素材不在历史里）：取最近 N 条且不标当前。
  const missing = generationContextRows(historyWith(events), "zz");
  assert.deepEqual(missing.map((row) => row.event.id), ["e3", "e4", "e5"]);
  assert.ok(missing.every((row) => !row.isCurrent));
  // 少于 3 条时全部返回。
  const two = generationContextRows(historyWith(events.slice(0, 2)), "a1");
  assert.deepEqual(two.map((row) => row.event.id), ["e1", "e2"]);
});

test("the version context section shows rows for cached history and the loading/empty states", () => {
  const helpers = createHelpers();
  const events = [
    { id: "e1", output_asset_id: "a1", provider: "chatgpt", model: "gpt-5-4-thinking", created_at: iso(10) },
    { id: "e2", output_asset_id: "a2", provider: "chatgpt", model: "gpt-5-4-thinking", created_at: iso(20) },
  ];
  const markup = helpers.detailVersionContextSectionMarkup({ id: "a2" }, historyWith(events));
  assert.ok(markup.includes('data-inspector-section="version"'));
  assert.ok(markup.includes('data-action="open-version-overlay"'));
  assert.ok(markup.includes("模型：chatgpt · gpt-5-4-thinking"));
  assert.ok(markup.includes("当前素材"), "the current-asset row carries the marker");
  assert.ok(markup.includes('thumb://a2'), "rows show the output thumbnail");
  assert.ok(markup.includes("data-generation-context"), "the box is a live region the loader can refresh");
  const loading = helpers.detailVersionContextSectionMarkup({ id: "a2" }, null);
  assert.ok(loading.includes("正在加载生成历史…"));
  const empty = helpers.detailVersionContextSectionMarkup({ id: "a2" }, historyWith([]));
  assert.ok(empty.includes("暂无生成记录"));
  // 「查看」在没有历史时仍然可用。
  assert.ok(empty.includes('data-action="open-version-overlay"'));
});

// ===== 底部固定行 =====

test("the pathbar renders the label, the ellipsed path and the open action", async () => {
  const app = await read("web/app/app.mjs");
  const pathbar = app.slice(app.indexOf("function renderDetailPathbar(asset)"));
  const withPath = pathbar.slice(0, pathbar.indexOf("function revealAssetAtPath"));
  // 有路径：title 全路径 + 打开可用。
  assert.match(withPath, /imagePath \? ` title="\$\{escapeHtml\(imagePath\)\}"` : ""/);
  assert.match(withPath, /data-asset-path="\$\{escapeHtml\(imagePath\)\}"/);
  assert.match(withPath, /imagePath \? "" : " disabled"/);
  // 无路径：打开禁用、路径位显示「未记录」。
  assert.match(withPath, /imagePath \? escapeHtml\(imagePath\) : `<span class="empty-copy">\$\{escapeHtml\(t\("notRecorded"\)\)\}<\/span>`/);
  // 「打开」复用右键菜单同一动作（/api/open-folder + reveal）。
  const reveal = app.slice(app.indexOf("async function revealAssetAtPath"));
  assert.match(reveal, /apiFetch\("\/api\/open-folder"/);
  assert.match(reveal, /body: \{ path, reveal: true \}/);
  // 堆叠与空态不显示路径栏。
  const renderDetail = app.slice(app.indexOf("function renderDetail("), app.indexOf("function bindDetailHeaderContext"));
  assert.match(renderDetail, /inspectorOverlay\.close\(\{ restoreFocus: false \}\);/);
  assert.match(renderDetail, /pathbar\.hidden = true;/);
});

// ===== 浮层控制器 =====

test("the overlay controller wires Esc/outside-close/focus-return and registers in hasBlockingOverlay", async () => {
  const app = await read("web/app/app.mjs");
  assert.match(app, /\["gpOverlay", inspectorOverlay\.isOpen\(\)\]/);
  assert.match(app, /if \(inspectorOverlay\.isOpen\(\)\) \{ event\.preventDefault\(\); inspectorOverlay\.close\(\); return; \}/);
  const controller = await read("web/app/inspector-overlay.mjs");
  assert.match(controller, /COVER_BREAKPOINT = 1120/);
  assert.match(controller, /SIDE_OVERLAY_WIDTH = 480/);
  assert.match(controller, /window\.innerHeight - OVERLAY_VIEWPORT_INSET \* 2/, "max height is viewport minus 48");
  assert.match(controller, /document\.addEventListener\("keydown", onDocumentKeydown, true\)/, "Esc is intercepted in the capture phase");
  assert.match(controller, /document\.addEventListener\("pointerdown", onDocumentPointerDown, true\)/, "outside pointer closes the overlay");
  assert.match(controller, /returnTarget\.focus\(\{ preventScroll: true \}\)/, "focus returns to the trigger");
  assert.match(controller, /body\.hidden = body\.dataset\.gpOverlayBody !== type;/, "only one overlay body is visible at a time");
  // 任务 73 返工 1：确认框等高层弹窗打开时浮层让位（isSuspended 注入 + 两个监听器入口）。
  assert.match(controller, /isSuspended = null/);
  assert.match(controller, /if \(!openType \|\| suspended\(\)\) return;/);
});

// 任务 73 返工 1 行为测试：isSuspended 为真时浮层的 keydown/pointerdown 完全让位。
// 用最小 FakeDocument/FakeElement 驱动真实控制器（模块只引用全局 document/window）。
test("suspended overlay ignores Esc/Tab/outside pointer without touching the event", () => {
  const fakeRect = () => ({ left: 1600, top: 0, width: 320, height: 1080 });
  class FakeElement {}
  Object.assign(FakeElement.prototype, { focus() {}, contains() { return false; }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) });
  // 控制器直接引用全局 HTMLElement/Document 做 instanceof——用 FakeElement 顶替。
  const previousHTMLElement = globalThis.HTMLElement;
  globalThis.HTMLElement = FakeElement;
  const makeButton = (name) => Object.assign(new FakeElement(), {
    name, focus: () => {}, hidden: false, disabled: false, isConnected: true,
    closest: () => null, setAttribute: () => {}, getAttribute: () => "",
  });
  const buttons = [makeButton("first"), makeButton("last")];
  const overlayNode = Object.assign(new FakeElement(), {
    hidden: true,
    dataset: {},
    style: {},
    focused: 0,
    focus() { this.focused += 1; },
    contains: (node) => node?.inOverlay === true,
    getBoundingClientRect: fakeRect,
    querySelectorAll: (selector) => selector.includes("gp-overlay-body") ? [{ dataset: { gpOverlayBody: "reference" }, hidden: true }] : buttons,
    querySelector: (selector) => {
      if (String(selector).includes("gp-overlay-title")) return { textContent: "" };
      if (String(selector).includes("close-inspector-overlay")) return makeButton("close");
      return null;
    },
  });
  const triggerButton = makeButton("trigger");
  triggerButton.inOverlay = false;
  const panel = {
    getBoundingClientRect: fakeRect,
    querySelector: (selector) => String(selector).includes("data-gp-overlay") ? overlayNode : null,
  };
  const rafQueue = [];
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
  const listeners = new Map();
  const fakeDocument = {
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type) { listeners.delete(type); },
    activeElement: triggerButton,
  };
  const fakeWindow = { addEventListener: () => {}, removeEventListener: () => {}, innerWidth: 1920, innerHeight: 1080 };
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = fakeDocument;
  globalThis.window = fakeWindow;
  try {
    const controller = createInspectorOverlay({ panel, t, isSuspended: null });
    controller.open("reference", "参考图", triggerButton);
    assert.equal(overlayNode.hidden, false, "overlay opens for the behaviour test");
    const keydown = listeners.get("keydown");
    const pointerdown = listeners.get("pointerdown");
    assert.ok(keydown && pointerdown, "capture listeners registered");

    // —— isSuspended() === true：Esc / Tab / 外点全部让位 ——
    controller.reposition && void 0;
    const suspended = createInspectorOverlay({ panel, t, isSuspended: () => true });
    // 重新 open（新的 controller 实例有独立的监听器注册）。
    suspended.open("reference", "参考图", triggerButton);
    const sKeydown = listeners.get("keydown");
    const sPointerdown = listeners.get("pointerdown");
    let prevented = 0;
    let stopped = 0;
    const suspendedEvent = { key: "Escape", preventDefault: () => { prevented += 1; }, stopPropagation: () => { stopped += 1; }, shiftKey: false, target: { inOverlay: false } };
    sKeydown(suspendedEvent);
    assert.equal(overlayNode.hidden, false, "Esc must not close a suspended overlay");
    assert.equal(prevented, 0, "Esc must not be consumed while suspended");
    assert.equal(stopped, 0, "Esc must not be stopped while suspended");
    fakeDocument.activeElement = triggerButton;
    sKeydown({ key: "Tab", preventDefault: () => { prevented += 1; }, stopPropagation: () => {}, shiftKey: false, target: { inOverlay: false } });
    assert.equal(prevented, 0, "Tab must not be consumed while suspended");
    sPointerdown({ target: { inOverlay: false } });
    assert.equal(overlayNode.hidden, false, "an outside pointerdown must not close a suspended overlay");
    suspended.close({ restoreFocus: false });

    // —— isSuspended() === false：同一输入按既有语义处理（对照） ——
    const active = createInspectorOverlay({ panel, t, isSuspended: () => false });
    active.open("reference", "参考图", triggerButton);
    const aKeydown = listeners.get("keydown");
    const aPointerdown = listeners.get("pointerdown");
    let escPrevented = 0;
    aKeydown({ key: "Escape", preventDefault: () => { escPrevented += 1; }, stopPropagation: () => {}, shiftKey: false, target: { inOverlay: false } });
    assert.equal(overlayNode.hidden, true, "Esc closes an active overlay");
    assert.equal(escPrevented, 1, "Esc is consumed by an active overlay");
    active.open("reference", "参考图", triggerButton);
    fakeDocument.activeElement = triggerButton;
    let tabPrevented = 0;
    aKeydown({ key: "Tab", preventDefault: () => { tabPrevented += 1; }, stopPropagation: () => {}, shiftKey: false, target: { inOverlay: false } });
    assert.equal(tabPrevented, 1, "Tab is trapped by an active overlay");
    aPointerdown({ target: { inOverlay: false } });
    assert.equal(overlayNode.hidden, true, "an outside pointerdown closes an active overlay");
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.requestAnimationFrame = previousRaf;
    if (previousHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = previousHTMLElement;
  }
});

test("restoreFocusInside pulls focus back into the overlay after the confirm dialog's own rAF restore", async () => {
  // 关闭状态下调用必须是无害 no-op（不抛错）：双 rAF 后 openType 为 null 直接返回。
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  try {
    const controller = createInspectorOverlay({ panel: { querySelector: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 1080 }) }, t });
    controller.restoreFocusInside();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(true);
  } finally {
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRaf;
  }
});

// ===== 区块 markup：参考图 / 键值 =====

test("reference section hides 查看 without references and shows the empty copy inside the box", () => {
  const helpers = createHelpers();
  const empty = helpers.detailReferenceSectionMarkup({ references: [] });
  assert.ok(empty.includes("无参考图"));
  assert.ok(!empty.includes("open-reference-overlay"), "no 查看 without references");
  assert.ok(empty.includes("detail-reference-box"));
  const loading = helpers.detailReferenceSectionMarkup({ source: { type: "web-chatgpt" } });
  assert.ok(loading.includes("正在读取…"));
  assert.ok(!loading.includes("open-reference-overlay"));
});

test("the file section keeps the group row and the A4a head anchors", () => {
  const helpers = createHelpers();
  const markup = helpers.detailFileSectionMarkup({ group: "", image_path: "a.png" });
  assert.ok(markup.includes("未分组"));
  assert.ok(markup.includes('id="detailTitle"'));
  assert.ok(markup.includes("data-action=\"toggle-favorite\""));
  // 星标按钮无可见文字 span（纯图标，aria-label 承担名称）。
  const favoriteMarkup = helpers.detailFavoriteButtonMarkup({ favorite: false });
  assert.ok(favoriteMarkup.includes('aria-pressed="false"'));
  assert.ok(favoriteMarkup.includes('aria-label="addFavorite"') || favoriteMarkup.includes("aria-label"));
  assert.ok(!/<span>[^<]*<\/span><span/.test(favoriteMarkup), "no visible text label span");
});

// ===== i18n 对称 =====

test("new A4a i18n keys exist exactly once per locale", async () => {
  const i18n = await read("web/app/i18n.mjs");
  const keys = ["promptTab1", "promptTab2", "copyColorAria", "colorPalette", "viewAction", "versionTreeTitle", "assetPathLabel", "openPathAction", "generationModelLine",
    // 任务 75：轮次行与合计行（含英文单复数的四个 A 级组合与 C 级两态）。
    "generationTurnLine", "generationCurrentTurnLine", "generationRoundsSummary", "generationRoundsSummaryTurnOne", "generationRoundsSummaryImageOne", "generationRoundsSummaryTurnOneImageOne", "generationImagesSummary", "generationImagesSummaryOne"];
  for (const key of keys) {
    assert.equal(i18n.split(`${key}:`).length - 1, 2, `${key} exists once in zh and once in en`);
  }
  assert.match(i18n, /promptTab1: "提示词1"/);
  assert.match(i18n, /promptTab1: "Prompt 1"/);
  assert.match(i18n, /copyColorAria: "复制颜色 \{color\}"/);
  assert.match(i18n, /copyColorAria: "Copy color \{color\}"/);
  assert.match(i18n, /versionTreeTitle: "版本树与上下文"/);
  assert.match(i18n, /versionTreeTitle: "Version tree & context"/);
  assert.match(i18n, /generationTurnLine: "第 \{n\} 轮生成"/);
  assert.match(i18n, /generationTurnLine: "Turn \{n\}"/);
  assert.match(i18n, /generationCurrentTurnLine: "当前素材——第 \{n\} 轮生成"/);
  assert.match(i18n, /generationCurrentTurnLine: "This asset — turn \{n\}"/);
});
