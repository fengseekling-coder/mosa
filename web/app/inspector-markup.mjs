// ===== Inspector markup（单栏检视器区块 markup helper）——提取自 app.js，REFACTORING-PLAN R1 批次 4 =====
// 纯展示 helper：只生成 markup 或格式化显示值；不发 API 请求、不绑定事件、不引入新状态层；
// 事件继续集中在 app.js 的 bindDetailEvents 与既有小型绑定函数中处理。state（locale/groups）、
// t、referenceRightsMarkup 经 createInspectorMarkup 工厂注入；escapeHtml/formatDate/formatDateTime
// 直接来自 utils.mjs，SOURCE_LABEL_KEYS 来自 config.mjs。
//
// 文件事实推导规则（任务书第六节）：
// - 尺寸 / 大小：优先读取服务端规范字段；Web Capture 已持久化的文件事实位于
//   business_fields（width/height/file_bytes），也作为后向兼容的可信来源。缺失时回退
//   「未记录」；不用 naturalWidth 伪装持久化事实、不发 HEAD 请求、不显示 0 × 0 / NaN / undefined。
// - 格式：仅当扩展名明确时确定性推导（大写扩展名），否则回退「未记录」。
import { SOURCE_LABEL_KEYS } from "./config.mjs";
import { assetTags } from "./tag-utils.mjs";
import { displayAssetTitle, escapeHtml, formatDate, formatDateTime } from "./utils.mjs";
import { selectVersionComparisonPair } from "./version-compare.mjs";

// 任务 35：检视器用户标签的折叠阈值——超过时只渲染前 N 个并追加「+N」展开按钮。
// app.mjs 的添加标签路径按它判断新加标签是否会落进隐藏区（是则自动展开）。
export const DETAIL_TAGS_VISIBLE_LIMIT = 9;

// ===== GravityPort A4a：检视器重排的纯数据 helpers（不依赖 factory 注入，可直接单测） =====

// 色块行：最多渲染的色板颜色数（lib/image-palette.ts 提取侧同上限）。
export const INSPECTOR_PALETTE_LIMIT = 8;
// 只接受 #RGB / #RRGGBB 十六进制串（大小写均可）；其余（命名色、rgba、脏数据）一律丢弃。
const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * 素材色板的渲染清洗：palette 缺失 / 非数组 / 视频素材 → 空数组（整行不渲染）；
 * 逐项校验十六进制格式，大小写去重（保留首次出现），截到 INSPECTOR_PALETTE_LIMIT。
 */
export function inspectorPaletteSwatches(asset) {
  if (!asset || isVideoAssetShape(asset)) return [];
  const palette = asset.palette;
  if (!Array.isArray(palette)) return [];
  const seen = new Set();
  const swatches = [];
  for (const value of palette) {
    const hex = String(value || "").trim();
    if (!HEX_COLOR_PATTERN.test(hex)) continue;
    const key = hex.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    swatches.push(hex);
    if (swatches.length >= INSPECTOR_PALETTE_LIMIT) break;
  }
  return swatches;
}

// isVideoAsset 的无依赖版本（factory 内的同名函数会用到 t/业务字段——此处只需
// 判断形态，与 lib/derivative-processor 的 media_kind 约定一致）。
function isVideoAssetShape(asset = {}) {
  const kind = asset.source?.media_kind || asset.business_fields?.media_kind;
  if (kind === "video") return true;
  if (kind === "image") return false;
  const path = String(asset.image_path || asset.asset || asset.image_url || "");
  return /\.(mp4|webm|mov|m4v)(?:$|\?)/i.test(path);
}

// 版本树与上下文框：以当前素材的生成事件为中心，取前后最近的共 N 条。
export const INSPECTOR_VERSION_CONTEXT_ROWS = 3;

/**
 * 生成历史的上下文行：events + context_events 里带产物的事件按 created_at 升序
 * 排列，中心 = output_asset_id === selectedAssetId 的最后一条；无中心（素材不在
 * 历史里但历史非空）时取最近 N 条且不标当前。返回 [{ event, outputAsset, isCurrent }]。
 */
export function generationContextRows(history, selectedAssetId) {
  const events = [...(Array.isArray(history?.events) ? history.events : []), ...(Array.isArray(history?.context_events) ? history.context_events : [])]
    .filter((event) => event && String(event.output_asset_id || "").trim());
  if (!events.length) return [];
  const ordered = events.slice().sort((left, right) => {
    const delta = String(left.created_at || "").localeCompare(String(right.created_at || ""));
    if (delta !== 0) return delta;
    return String(left.id || "").localeCompare(String(right.id || ""));
  });
  const outputAssets = Array.isArray(history?.output_assets) ? history.output_assets : [];
  const assetById = new Map(outputAssets.map((asset) => [asset.id, asset]));
  let centerIndex = -1;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    if (ordered[index].output_asset_id === selectedAssetId) { centerIndex = index; break; }
  }
  // 窗口：以中心行（或无中心时的最近 N 条）为锚取 N 行；中心贴边时向另一侧
  // 补足，保持「前后最近的共 N 条」。
  const anchorStart = centerIndex >= 0
    ? Math.max(0, centerIndex - 1)
    : Math.max(0, ordered.length - INSPECTOR_VERSION_CONTEXT_ROWS);
  const anchorEnd = Math.min(ordered.length, anchorStart + INSPECTOR_VERSION_CONTEXT_ROWS);
  const windowStart = Math.max(0, anchorEnd - INSPECTOR_VERSION_CONTEXT_ROWS);
  const window = ordered.slice(windowStart, anchorEnd);
  return window.map((event) => ({
    event,
    outputAsset: assetById.get(event.output_asset_id) || null,
    isCurrent: centerIndex >= 0 && event.output_asset_id === selectedAssetId,
  }));
}

export function createInspectorMarkup({ state, t, referenceRightsMarkup }) {
  // 任务 41：复制按钮带文字（R21 .copy）：图标 12×12 + 4px 间距 + 文字标签；
  // 可访问名称仍由各按钮的 aria-label 承担完整动作名，可见文字只是短标签
  // （aria-hidden，读屏不会把它读成动作名）。
  const COPY_ICON_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9"/></svg>`;
  const COPY_ACTION_LABEL = `<span aria-hidden="true">${t("copyAction")}</span>`;

  function persistedPositiveNumber(asset, ...keys) {
    for (const source of [asset, asset?.business_fields]) {
      for (const key of keys) {
        const value = Number(source?.[key]);
        if (Number.isFinite(value) && value > 0) return value;
      }
    }
    return null;
  }

  function mediaDimensions(asset) {
    const width = persistedPositiveNumber(asset, "width");
    const height = persistedPositiveNumber(asset, "height");
    if (width && height) return { width: Math.round(width), height: Math.round(height) };
    const match = /^\s*(\d+(?:\.\d+)?)\s*[:/x×]\s*(\d+(?:\.\d+)?)\s*$/iu.exec(String(asset?.ratio || ""));
    if (!match) return null;
    const ratioWidth = Number(match[1]);
    const ratioHeight = Number(match[2]);
    if (!Number.isFinite(ratioWidth) || !Number.isFinite(ratioHeight) || ratioWidth <= 0 || ratioHeight <= 0) return null;
    return { width: Math.max(1, Math.round(ratioWidth)), height: Math.max(1, Math.round(ratioHeight)) };
  }

  function mediaDimensionAttributes(asset) {
    const dimensions = mediaDimensions(asset);
    return dimensions ? ` width="${dimensions.width}" height="${dimensions.height}" data-known-aspect="true"` : "";
  }

  function videoThumbAspectAttributes(asset) {
    const dimensions = mediaDimensions(asset);
    return dimensions
      ? ` data-video-width="${dimensions.width}" data-video-height="${dimensions.height}" data-known-aspect="true"`
      : "";
  }

  function fileDimensionsText(asset) {
    const width = persistedPositiveNumber(asset, "width");
    const height = persistedPositiveNumber(asset, "height");
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return `${Math.round(width)} × ${Math.round(height)}`;
  }

  function fileFormatText(asset) {
    const match = /\.([a-z0-9]+)(?:$|\?)/i.exec(String(asset?.image_path || asset?.asset || ""));
    return match ? match[1].toUpperCase() : null;
  }

  function fileSizeText(asset) {
    const bytes = persistedPositiveNumber(asset, "size_bytes", "file_bytes");
    return Number.isFinite(bytes) && bytes > 0 ? formatFileSize(bytes) : null;
  }

  function formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
  }

  function fileFactRowMarkup(key, value) {
    return `<div class="meta-row"><span class="meta-key">${t(key)}</span><span class="meta-val">${value === null ? `<span class="empty-copy">${t("notRecorded")}</span>` : escapeHtml(value)}</span></div>`;
  }

  function fileAspectRatioText(asset) {
    const width = persistedPositiveNumber(asset, "width");
    const height = persistedPositiveNumber(asset, "height");
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    const roundedWidth = Math.round(width);
    const roundedHeight = Math.round(height);
    const actual = roundedWidth / roundedHeight;
    // File dimensions are often off by a few pixels from the intended canvas
    // ratio after export/re-encode. Prefer a familiar small ratio when it is
    // genuinely close; otherwise keep the exact reduced ratio rather than
    // inventing a misleading approximation.
    const commonRatios = [
      [1, 2], [9, 16], [3, 5], [2, 3], [5, 7], [3, 4], [4, 5],
      [1, 1],
      [5, 4], [4, 3], [7, 5], [3, 2], [5, 3], [16, 9], [2, 1], [21, 9],
    ];
    let nearest = null;
    let nearestError = Number.POSITIVE_INFINITY;
    for (const [left, right] of commonRatios) {
      const ratio = left / right;
      const relativeError = Math.abs(actual - ratio) / ratio;
      if (relativeError < nearestError) {
        nearest = [left, right];
        nearestError = relativeError;
      }
    }
    if (nearest && nearestError <= 0.015) return `${nearest[0]}:${nearest[1]}`;
    const gcd = (left, right) => right ? gcd(right, left % right) : left;
    const divisor = gcd(roundedWidth, roundedHeight);
    return `${roundedWidth / divisor}:${roundedHeight / divisor}`;
  }

  function fileFactTagMarkup(key, value) {
    const text = value === null ? t("notRecorded") : value;
    const label = `${t(key)}: ${text}`;
    return `<span class="detail-fact-tag" aria-label="${escapeHtml(label)}">${escapeHtml(text)}</span>`;
  }

  function detailFavoriteButtonMarkup(asset) {
    // GravityPort A4a：改为纯图标星标按钮（稿子头部右上只有一颗星形），可见文字
    // 移除；可访问名称仍由 aria-label（addFavorite/removeFavorite）承担，
    // aria-pressed 暴露收藏状态。
    const favorite = Boolean(asset.favorite);
    const actionLabel = t(favorite ? "removeFavorite" : "addFavorite");
    return `<button class="detail-fav-btn${favorite ? " is-fav" : ""}" type="button" data-action="toggle-favorite" aria-pressed="${favorite}" aria-label="${escapeHtml(actionLabel)}"><span aria-hidden="true">${favorite ? "★" : "☆"}</span></button>`;
  }

  // R21 头部（GravityPort A4a 调整）：左 130×130 预览小图 + 右侧信息（标题 /
  // 收藏星标 / 来源·日期 / 五行键值事实）。原「打开原始对话」图标按钮随来源信息
  // 区块一并从界面拿掉（用户 10-06 拍板），showRelatedGenerations 的功能代码保留。
  function detailFileSectionMarkup(asset) {
    const title = displayAssetTitle(asset);
    const source = sourceName(asset.source || {});
    const sourceLine = `${escapeHtml(source)} · ${formatDate(asset.created_at, state.locale)}`;
    const facts = [
      ["fileFormat", fileFormatText(asset)],
      ["fileDimensions", fileDimensionsText(asset)],
      ["aspectRatio", fileAspectRatioText(asset)],
      ["fileSize", fileSizeText(asset)],
      ["group", String(asset.group || "").trim() || t("notGrouped")],
    ].map(([key, value]) => fileFactRowMarkup(key, value)).join("");
    return `<section class="inspector-section detail-overview" data-inspector-section="file" aria-labelledby="assetOverviewTitle"><h3 id="assetOverviewTitle" class="visually-hidden">${t("fileFacts")}</h3><div class="asset-head"><div class="asset-mini">${assetMediaPreviewMarkup(asset, "detail")}</div><div class="asset-meta-wrap"><div class="asset-name-row"><h3 id="detailTitle" tabindex="-1" title="${escapeHtml(title)}">${escapeHtml(title)}</h3>${detailFavoriteButtonMarkup(asset)}</div><p class="asset-kind" title="${sourceLine}">${sourceLine}</p><div class="head-facts" role="group" aria-label="${escapeHtml(t("assetMetadata"))}">${facts}</div></div></div></section>`;
  }

  function detailTagsSectionMarkup(asset) {
    // GravityPort A4a：来源标签芯片从标签行拿掉（来源已在头部「来源 · 日期」行
    // 显示，稿子标签行只有用户标签与「添加标签」）；原 duplicateSourceTags 过滤
    // 是为避免与来源芯片重复，随芯片一并移除，用户标签按存储原样渲染。
    const allTags = assetTags(asset);
    // 任务 35：用户标签超过 DETAIL_TAGS_VISIBLE_LIMIT 时折叠——只渲染前 N 个，
    // 隐藏部分根本不进 DOM（不占 Tab 序、读屏不可见），后跟「+N」切换按钮；展开时
    // 全部渲染、按钮变「收起」。展开标志在 state.detailTagsExpanded（app.mjs 维护，
    // 只在当前检视器、当前素材内保持），本纯展示 helper 只读不写。
    const overflowCount = Math.max(allTags.length - DETAIL_TAGS_VISIBLE_LIMIT, 0);
    const expanded = state.detailTagsExpanded === true && overflowCount > 0;
    const tags = expanded ? allTags : allTags.slice(0, DETAIL_TAGS_VISIBLE_LIMIT);
    // 用户标签末尾内联 × 按钮，显示/焦点规则见 styles.css .detail-tag-remove
    // （平时 opacity:0，悬停或标签内聚焦时显示，触屏常显）。
    const tagMarkup = tags.map((tag) => `<span class="detail-tag" data-tag-value="${escapeHtml(tag)}"><span class="detail-tag-label">${escapeHtml(tag)}</span><button class="detail-tag-remove" type="button" data-action="remove-tag" data-tag-value="${escapeHtml(tag)}" aria-label="${escapeHtml(t("removeTag", { tag }))}">×</button></span>`).join("");
    // 「+N」是真按钮：aria-expanded 暴露开合状态，可访问名称带出隐藏个数 / 收起。
    const tagsToggleMarkup = overflowCount > 0
      ? `<button class="detail-tags-toggle" type="button" data-action="toggle-tags" aria-expanded="${expanded}" aria-label="${escapeHtml(expanded ? t("collapseTags") : t("showMoreTags", { count: overflowCount }))}"><span aria-hidden="true">${expanded ? escapeHtml(t("collapseTagsShort")) : `+${overflowCount}`}</span></button>`
      : "";
    return `<section class="inspector-section detail-tags-section" data-inspector-section="tags" aria-label="${escapeHtml(t("tags"))}"><div class="detail-tags-row" data-tags-list>${tagMarkup}${tagsToggleMarkup}<button class="detail-tags-add" type="button" data-action="add-tag"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>${escapeHtml(t("addTag"))}</span></button></div></section>`;
  }

  // GravityPort A4a 新增：色块行——素材主色板（asset.palette），每块 24×12 按
  // 数据上色（全界面唯一允许按数据上色处；颜色由 app.mjs 绑定时经 CSSOM 写入
  // style.background，markup 保持无内联 style），点击复制 hex。palette 缺失/
  // 为空/视频素材时整行不渲染。上限与清洗见模块级 inspectorPaletteSwatches。
  function detailPaletteSectionMarkup(asset) {
    const swatches = inspectorPaletteSwatches(asset);
    if (!swatches.length) return "";
    const buttons = swatches.map((hex) => `<button class="detail-palette-swatch" type="button" data-action="copy-swatch" data-swatch-color="${escapeHtml(hex)}" title="${escapeHtml(hex)}" aria-label="${escapeHtml(t("copyColorAria", { color: hex }))}"></button>`).join("");
    return `<section class="inspector-section detail-palette-section" data-inspector-section="palette"><div class="detail-palette-row" role="group" aria-label="${escapeHtml(t("colorPalette"))}">${buttons}</div></section>`;
  }

  function activeRecipeReferences(asset) {
    const loaded = state.recipeHistory?.project_id === asset.project_id && state.recipeHistory?.asset_id === asset.id
      ? state.recipeHistory
      : null;
    const snapshots = loaded?.snapshots || asset.recipe_snapshots;
    if (Array.isArray(snapshots) && snapshots.length) {
      const activeId = loaded?.active_snapshot_id || asset.active_recipe_snapshot_id || snapshots.at(-1)?.snapshot_id;
      const snapshot = snapshots.find((item) => item.snapshot_id === activeId) || snapshots.at(-1);
      return Array.isArray(snapshot?.references) ? snapshot.references : [];
    }
    const direct = asset.references || asset.business_fields?.references || asset.source?.references;
    if (Array.isArray(direct)) return direct;
    return /^web-/.test(String(asset.source?.type || asset.source_type || "")) ? null : [];
  }

  // GravityPort A4a：参考图区块的整块内容（标题行 + 缩略图盒）。整块都包在
  // data-prompt-references region 里：参考图异步就绪/失败时 app.mjs 重建整块，
  // 「查看」按钮随参考图出现/消失。盒 64 高、缩略图 56×56 一排，放不下截断不换行；
  // 没有参考图时盒里显示「无参考图」，不显示「查看」。
  function promptReferencesMarkup(asset) {
    const references = activeRecipeReferences(asset);
    const viewButton = `<button class="detail-section-view" type="button" data-action="open-reference-overlay" aria-haspopup="dialog">${escapeHtml(t("viewAction"))}</button>`;
    if (references === null) {
      return `<div class="detail-prompt-head"><h3>${t("referenceImage")}</h3></div><div class="detail-reference-box"><div class="detail-reference-row detail-reference-loading" role="status"><span class="detail-reference-label">${t("referenceImage")}</span><span class="detail-reference-value">${t("referenceLoading")}</span></div></div>`;
    }
    if (!references.length) {
      return `<div class="detail-prompt-head"><h3>${t("referenceImage")}</h3></div><div class="detail-reference-box"><span class="empty-copy detail-reference-empty">${t("referenceNone")}</span></div>`;
    }
    const thumbnails = references.slice(0, 8).map((reference, index) => {
      const linked = state.assets.find((item) => item.id === reference.asset_id);
      const thumbnail = linked?.thumbnail_url || reference.attachment_url || linked?.image_url || "";
      const label = reference.role || `${t("referenceImage")} ${index + 1}`;
      return thumbnail
        ? `<span class="detail-reference-thumb" title="${escapeHtml(label)}"><img data-reference-thumb-img src="${escapeHtml(thumbnail)}" alt="${escapeHtml(label)}" loading="lazy" /><span class="detail-reference-thumb-fallback" data-reference-thumb-fallback aria-hidden="true">${index + 1}</span></span>`
        : `<span class="detail-reference-thumb detail-reference-thumb-empty" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${index + 1}</span>`;
    }).join("");
    return `<div class="detail-prompt-head"><h3>${t("referenceImage")}</h3>${viewButton}</div><div class="detail-reference-box"><div class="detail-reference-thumbnails">${thumbnails}</div></div>`;
  }

  // GravityPort A4a：提示词区块——两段提示词时渲染「提示词1 / 提示词2」页签
  // （页签样式见 styles.css .detail-prompt-toggle，aria-pressed 暴露选中态），
  // 只有一段时不显示页签、只显示标题「提示词」。复制按钮复制当前页签内容。
  // 框固定 120 高超出滚动。原「配方与编辑」disclosure 与参考图子块从本区块拿掉
  // （参考图升为独立区块，配方编辑界面整个移除，editRecipeFieldsMarkup 保留实现）。
  function detailPromptSectionMarkup(asset) {
    const source = asset.source || {};
    const promptUnavailable = /^web-(?:chatgpt|gemini|flow|google-ai-studio)$/.test(source.type || asset.source_type || "")
      && source.prompt_status === "not-available";
    const promptText = asset.prompt
      ? escapeHtml(asset.prompt)
      : `<span class="empty-copy">${t(promptUnavailable ? "webPromptUnavailable" : "notRecorded")}</span>`;
    const providerVisiblePrompt = asset.prompt && source.prompt_status === "provider-visible-prompt";
    const providerVisiblePromptKey = source.provider === "gemini" || source.type === "web-gemini"
      ? "geminiVisibleUserPromptUnverified"
      : source.provider === "google-ai-studio" || source.type === "web-google-ai-studio"
      ? "googleAiStudioVisibleUserPromptUnverified"
      : source.provider === "flow" || source.type === "web-flow"
        ? "flowProviderVisiblePromptUnverified"
        : "";
    const promptProvenance = providerVisiblePrompt && providerVisiblePromptKey
      ? `<p class="field-hint prompt-provenance">${escapeHtml(t(providerVisiblePromptKey))}</p>`
      : "";
    // Prompt 不存在时复制按钮不渲染（避免死按钮与空复制成功提示）；用户指令作为独立子段，
    // 不伪装成生成 Prompt；复制 Prompt 只复制生成 Prompt。
    // Prompt 2 is the Prompt ChatGPT's chat model sent to the image tool. It
    // sits beside the caption Prompt as a switchable view, never replacing it.
    const requestPrompt = String(source.generation_request_prompt || "").trim();
    const copyButton = asset.prompt
      ? `<button class="section-head-copy" type="button" data-action="copy-prompt" title="${t("copyPrompt")}" aria-label="${t("copyPrompt")}">${COPY_ICON_SVG}${COPY_ACTION_LABEL}</button>`
      : requestPrompt
        ? `<button class="section-head-copy" type="button" data-action="copy-prompt" title="${t("copyPrompt")}" aria-label="${t("copyPrompt")}" disabled>${COPY_ICON_SVG}${COPY_ACTION_LABEL}</button>`
        : "";
    const promptTitle = requestPrompt
      ? `<h3 class="detail-prompt-switch"><button class="detail-prompt-toggle is-active" type="button" aria-pressed="true" data-prompt-variant="1">${t("promptTab1")}</button><button class="detail-prompt-toggle" type="button" aria-pressed="false" data-prompt-variant="2">${t("promptTab2")}</button></h3>`
      : `<h3>${t("prompt")}</h3>`;
    const requestPromptBox = requestPrompt
      ? `<div class="prompt-box detail-prompt-box" role="textbox" aria-readonly="true" data-prompt-panel="2" hidden>${escapeHtml(requestPrompt)}</div>`
      : "";
    const userInstruction = String(source.user_message || asset.business_fields?.user_message || "").trim();
    const instructionText = userInstruction
      ? escapeHtml(userInstruction)
      : `<span class="empty-copy">${t("userInstructionUnavailable")}</span>`;
    const instructionMarkup = `<div class="detail-prompt-subhead"><h4>${t("userInstruction")}</h4><button class="detail-copy-sub" type="button" data-action="copy-instruction" aria-label="${escapeHtml(t("copyUserInstruction"))}"${userInstruction ? "" : " disabled"}>${COPY_ICON_SVG}${COPY_ACTION_LABEL}</button></div><div class="prompt-box detail-instruction-box">${instructionText}</div>`;
    return `<section class="inspector-section detail-prompt-section" data-inspector-section="prompt"><div class="detail-prompt-head">${promptTitle}${copyButton}</div>${requestPromptBox}<div class="prompt-box detail-prompt-box" role="textbox" aria-readonly="true" data-prompt-panel="1">${promptText}</div>${promptProvenance}${instructionMarkup}</section>`;
  }

  // GravityPort A4a 新增：参考图区块（标题 + 「查看」浮层入口 + 缩略图盒）。
  // 内容整体在 data-prompt-references region 内，随参考图加载状态整块刷新。
  function detailReferenceSectionMarkup(asset) {
    return `<section class="inspector-section detail-reference-section" data-inspector-section="reference"><div data-prompt-references>${promptReferencesMarkup(asset)}</div></section>`;
  }

  // GravityPort A4a 新增：版本树与上下文区块——以当前素材为中心的最多 3 行
  // （40×40 输出缩略图 + 一行「模型：provider · model」，当前素材行加标记）。
  // 「查看」恒可用（无生成历史时显示空态），打开版本树浮层（版本选择/对比/
  // 版本历史/生成树都在浮层里，行为不变）。行数据见模块级 generationContextRows。
  function detailVersionContextSectionMarkup(asset, cachedGenerationHistory) {
    const viewButton = `<button class="detail-section-view" type="button" data-action="open-version-overlay" aria-haspopup="dialog">${escapeHtml(t("viewAction"))}</button>`;
    const boxContent = cachedGenerationHistory
      ? generationContextBoxMarkup(cachedGenerationHistory, asset.id)
      : `<p class="generation-history-status" role="status">${t("generationHistoryLoading")}</p>`;
    return `<section class="inspector-section detail-version-context" data-inspector-section="version"><div class="detail-prompt-head"><h3>${t("versionTreeTitle")}</h3>${viewButton}</div><div class="detail-version-context-box" data-generation-context>${boxContent}</div></section>`;
  }

  // 盒内行的整段 markup：区块渲染与生成历史异步到达后的 region 刷新
  // （app.mjs renderGenerationContextRegion）共用，保证两处渲染一致。
  function generationContextBoxMarkup(history, selectedAssetId) {
    const rows = generationContextRows(history, selectedAssetId);
    return rows.length
      ? rows.map((row) => detailVersionContextRowMarkup(row)).join("")
      : `<p class="empty-copy detail-version-context-empty">${t("generationHistoryEmpty")}</p>`;
  }

  function detailVersionContextRowMarkup({ event, outputAsset, isCurrent }) {
    const provider = String(event.provider || event.capture_channel || "").trim() || t("sourceUnknown");
    const model = String(event.model || "").trim();
    const modelLine = t("generationModelLine", { value: model ? `${provider} · ${model}` : provider });
    const currentMarkup = isCurrent ? `<span class="detail-version-context-current">${escapeHtml(t("generationCurrentAsset"))}</span>` : "";
    return `<div class="detail-version-context-row${isCurrent ? " is-current" : ""}">${generationEventThumbnailMarkup(event, new Map(outputAsset ? [[event.output_asset_id, outputAsset]] : []))}<span class="detail-version-context-line"><span class="detail-version-context-model">${escapeHtml(modelLine)}</span>${currentMarkup}</span></div>`;
  }

  // GravityPort A4a：界面已拿掉，保留实现（配方编辑字段不再渲染，保存链路保留）。
  function editRecipeFieldsMarkup(asset) {
    const rating = Math.min(5, Math.max(0, Math.round(asset.rating || 0)));
    const groupOptions = (Array.isArray(state.groups.groups) ? state.groups.groups : [])
      .map((group) => `<option value="${escapeHtml(group.name)}"></option>`)
      .join("");
    return `<label class="field"><span>${t("prompt")}</span><textarea data-edit="prompt" rows="5">${escapeHtml(asset.prompt || "")}</textarea></label><div class="two"><label class="field"><span>${t("skill")}</span><input data-edit="skill" value="${escapeHtml(asset.skill || "")}" /></label><label class="field"><span>${t("style")}</span><input data-edit="style" value="${escapeHtml(asset.style || "")}" /></label></div><div class="two"><label class="field"><span>${t("ratio")}</span><input data-edit="ratio" value="${escapeHtml(asset.ratio || "")}" /></label><label class="field"><span>${t("theme")}</span><input data-edit="theme" value="${escapeHtml(asset.theme || "")}" /></label></div><div class="two"><label class="field"><span>${t("group")}</span><input data-edit="group" value="${escapeHtml(asset.group || "")}" list="groupSuggestionsEdit" /><datalist id="groupSuggestionsEdit">${groupOptions}</datalist></label><label class="field"><span>${t("category")}</span><select data-edit="category"><option value="">${t("none")}</option>${categoryOptions(asset.category)}</select></label></div><div class="field"><span>${t("rating")}</span><div class="rating-edit" data-edit="rating" role="radiogroup" aria-label="${escapeHtml(t("rating"))}">${[1,2,3,4,5].map((number) => `<button type="button" role="radio" aria-checked="${number === rating}" data-val="${number}" class="${number <= rating ? "on" : ""}" aria-label="${number}/5">${number <= rating ? "★" : "☆"}</button>`).join("")}</div></div><label class="field"><span>${t("businessFields")}</span><textarea data-edit="business_fields" rows="3">${escapeHtml(JSON.stringify(asset.business_fields || {}, null, 2))}</textarea></label>`;
  }

  // GravityPort A4a：界面已拿掉，保留实现（来源信息区块连同「查看同批次」「查看
  // 同对话」按钮与 copy-source 入口一并移除；来源名称已在头部「来源 · 日期」显示）。
  function detailSourceSectionMarkup(asset) {
    const source = asset.source || {};
    const sourceRows = buildSourceRows(source).filter(([key, value]) => key !== "sourceLabel" && value !== undefined && value !== null && value !== "");
    const rowsMarkup = sourceRows.length
      ? `<div class="meta-table">${sourceRows.map(([key, value]) => `<div class="meta-row"><span class="meta-key">${t(key)}</span><span class="meta-val source-value">${escapeHtml(value)}</span></div>`).join("")}</div>`
      : `<p class="empty-copy">${t("notRecorded")}</p>`;
    // 复制来源入口仅在有明确可复制值（原始路径）时渲染；取值与点击复制共用 sourceCopyValue。
    const copyButton = sourceCopyValue(source)
      ? `<button class="section-head-copy" type="button" data-action="copy-source" title="${t("copyOriginalPath")}" aria-label="${t("copyOriginalPath")}">${COPY_ICON_SVG}${COPY_ACTION_LABEL}</button>`
      : "";
    const conversationId = String(source.conversation_id || "").trim();
    const messageId = String(source.message_id || "").trim();
    const sessionActions = conversationId
      ? `<div class="detail-utility-actions generation-navigation" role="group" aria-label="${escapeHtml(t("generationNavigation"))}">${messageId ? `<button class="action-btn secondary" type="button" data-action="view-generation-batch">${t("viewGenerationBatch")}</button>` : ""}<button class="action-btn secondary" type="button" data-action="view-generation-session">${t("viewGenerationSession")}</button></div>`
      : "";
    const copyAction = copyButton ? `<div class="detail-source-copy">${copyButton}</div>` : "";
    return `<section class="inspector-section detail-source-section" data-inspector-section="source"><details class="detail-source-disclosure"><summary class="detail-source-summary"><span>${t("sourceInfo")}</span><strong>${escapeHtml(sourceName(source))}</strong></summary><div class="detail-source-content">${copyAction}${rowsMarkup}${sessionActions}<details class="detail-disclosure" data-reference-rights-section><summary>${t("referenceRights")}</summary><div class="disclosure-content" data-reference-rights>${referenceRightsMarkup(asset)}</div></details></div></details></section>`;
  }

  // GravityPort A4a：本函数改为「版本树与上下文」浮层的内容——版本选择器、
  // 生成树、版本对比、版本历史四个 region 全部搬进浮层（app.mjs 填充浮层主体），
  // 行为与交互不变；原配方快照历史 disclosure 从界面拿掉（recipeHistoryDisclosureMarkup
  // 保留实现）。cachedRecipeHistory 参数保留以维持既有调用形态（参考图权利仍依赖
  // 配方历史数据，只是不再有界面入口）。
  function detailVersionSectionMarkup(asset, cachedHistory, cachedRecipeHistory, cachedGenerationHistory) {
    return `<div class="inspector-section detail-version-section" data-inspector-section="version-overlay"><div class="detail-prompt-head"><h3>${t("tabVersions")}</h3></div><div class="version-picker" data-version-picker>${versionPickerMarkup(asset, cachedHistory)}</div><details class="detail-disclosure generation-history-disclosure" open><summary>${t("generationHistory")}</summary><div class="disclosure-content generation-history-region" data-generation-history aria-live="polite">${cachedGenerationHistory ? generationHistoryMarkup(cachedGenerationHistory, asset.id) : `<p class="generation-history-status" role="status">${t("generationHistoryLoading")}</p>`}</div></details><details class="detail-disclosure version-compare-disclosure"><summary>${t("compareVersions")}</summary><div class="disclosure-content version-compare-region" data-version-compare aria-live="polite">${cachedHistory ? versionCompareMarkup(cachedHistory, asset.id) : `<p class="version-history-status" role="status">${t("versionLoading")}</p>`}</div></details><details class="detail-disclosure"><summary>${t("versionHistory")}</summary><div class="disclosure-content version-history-region" data-version-history aria-live="polite">${cachedHistory ? versionHistoryMarkup(cachedHistory, asset.id) : `<p class="version-history-status" role="status">${t("versionLoading")}</p>`}</div></details></div>`;
  }

  function versionCompareMarkup(history, selectedId, baseId = "", targetId = "") {
    const pair = selectVersionComparisonPair(history, selectedId, baseId, targetId);
    if (!pair) return `<p class="version-history-status">${t("versionCompareNeedsTwo")}</p>`;
    const versions = history?.versions || [];
    const optionMarkup = (selectedIdValue) => versions.map((version) => `<option value="${escapeHtml(version.id)}"${version.id === selectedIdValue ? " selected" : ""}>${escapeHtml(versionOptionLabel(version, version.id === selectedId))}</option>`).join("");
    const mediaMarkup = (version) => {
      const url = version.thumbnail_url || version.preview_url || version.image_url || "";
      return url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(versionOptionLabel(version, false))}" loading="lazy" decoding="async" />` : `<span class="empty-copy">${t("notRecorded")}</span>`;
    };
    const rows = pair.fields.map((field) => `<div class="version-compare-row${field.changed ? " changed" : ""}"><strong>${escapeHtml(t(`versionCompareField_${field.key}`))}</strong><span>${field.before ? escapeHtml(field.before) : `<em>${t("notRecorded")}</em>`}</span><span>${field.after ? escapeHtml(field.after) : `<em>${t("notRecorded")}</em>`}</span></div>`).join("");
    return `<div class="version-compare-controls"><label><span>${t("versionCompareBase")}</span><select data-version-compare-base>${optionMarkup(pair.base.id)}</select></label><label><span>${t("versionCompareTarget")}</span><select data-version-compare-target>${optionMarkup(pair.target.id)}</select></label></div><div class="version-compare-media"><div>${mediaMarkup(pair.base)}</div><div>${mediaMarkup(pair.target)}</div></div><div class="version-compare-grid"><div class="version-compare-head"><span></span><strong>${escapeHtml(versionOptionLabel(pair.base, false))}</strong><strong>${escapeHtml(versionOptionLabel(pair.target, false))}</strong></div>${rows}</div>`;
  }

  // Phase 4B：版本选择器——原生 <select>（无自制 popover/listbox/菜单、无第三方 Select、
  // 无新依赖）。option value 为素材 ID，显示文本用 versionLabelShort（Vn），归档版本追加
  // archivedVersion 文字标记；完整变更说明在选择器下方（复用 detailVersionSummaryMarkup）。
  // 五态模型：加载中 disabled + aria-busy 且显示当前 Vn；单版本 disabled；多版本 enabled
  // 且 option 遵循 API 顺序；错误保留当前版本单选 disabled 且摘要/版本区不清空；缺
  // version_index 回退当前版本/标题文案，不显示 VNaN/V0/undefined。
  function versionPickerMarkup(asset, history, error = null) {
    const versions = error ? [] : (history?.versions || []);
    const options = versions.length ? versions : [asset];
    const multiple = versions.length > 1;
    const busy = !error && !history;
    if (!busy && !error && versions.length === 1) {
      const version = versions[0];
      const change = version.version_change || (Number(version.version_index) === 1 ? t("initialVersion") : t("noVersionChange"));
      return `<div class="version-single" role="status"><strong>${escapeHtml(versionOptionLabel(version, true))}</strong><span>${escapeHtml(t("currentVersion"))}</span><span>${escapeHtml(change)}</span></div>`;
    }
    const selectOptions = options.map((version) => `<option value="${escapeHtml(version.id)}"${version.id === asset.id ? " selected" : ""}>${escapeHtml(versionOptionLabel(version, version.id === asset.id))}</option>`).join("");
    return `<label class="visually-hidden" for="versionSelect">${t("versionPickerLabel")}</label><select id="versionSelect" data-version-select${multiple ? "" : " disabled"}${busy ? ' aria-busy="true"' : ""}>${selectOptions}</select>${detailVersionSummaryMarkup(asset)}`;
  }

  function versionOptionLabel(version, selected) {
    const index = Number(version?.version_index);
    const label = Number.isFinite(index) && index > 0
      ? t("versionLabelShort", { number: index })
      : (selected ? t("currentVersion") : String(version?.theme || version?.asset || version?.id || ""));
    return version?.archived ? `${label} · ${t("archivedVersion")}` : label;
  }

  function detailVersionSummaryMarkup(asset) {
    const index = Number(asset.version_index);
    const label = Number.isFinite(index) && index > 0 ? t("versionLabel", { number: index }) : "";
    const change = asset.version_change || (index === 1 ? t("initialVersion") : t("noVersionChange"));
    return `<div class="version-summary"><span class="version-summary-label">${label ? `<strong>${escapeHtml(label)}</strong>` : ""}<span class="version-current">${t("currentVersion")}</span></span><span class="version-change">${escapeHtml(change)}</span></div>`;
  }

  // GravityPort A4a：界面已拿掉，保留实现（分组并入头部键值的「分组」行）。
  function detailGroupSectionMarkup(asset) {
    const group = String(asset.group || "").trim();
    return `<section class="inspector-section detail-group-section" data-inspector-section="group"><div class="detail-prompt-head"><h3>${t("group")}</h3></div><p class="inspector-readout">${group ? escapeHtml(group) : `<span class="empty-copy">${t("notGrouped")}</span>`}</p></section>`;
  }

  // GravityPort A4a：界面已拿掉，保留实现（图片位置区块由底部固定「素材路径」
  // 胶囊取代，见 app.mjs 的 renderDetailPathbar）。
  function detailMoreSectionMarkup(asset) {
    const imagePath = String(asset.image_path || "").trim();
    const locationValue = imagePath
      ? escapeHtml(asset.image_path)
      : `<span class="empty-copy">${t("notRecorded")}</span>`;
    return `<section class="inspector-section" data-inspector-section="more"><div class="more-location"><span class="meta-key">${t("imageLocation")}</span><div class="path-box detail-path-box"${imagePath ? ` title="${escapeHtml(asset.image_path)}"` : ""}>${locationValue}</div></div></section>`;
  }

  // 任务 41：版本历史改为 R21 竖线时间轴的三栏行（版本号 / 说明 / 时间，见
  // styles.css 的 .version-content 三栏 grid 与 .version-timeline-item::before 竖线）。
  // 「当前版本 / 已归档」标记从版本号格移到说明格尾部：版本号格只放 strong，
  // 各行三栏的列位才能对齐（选中行不再因多一枚徽标把说明列顶右）。行的可交互
  // 契约不变：button[data-version-id] + aria-current + time[datetime] + 深度类。
  function versionHistoryMarkup(history, selectedId) {
    const versions = history?.versions || [];
    return `<ol class="version-timeline" aria-label="${escapeHtml(t("versionHistory"))}">${versions.map((version) => {
      const selected = version.id === selectedId;
      const depth = Math.min(Math.max(Number(version.version_depth) || 0, 0), 6);
      const change = version.version_change || (version.version_index === 1 ? t("initialVersion") : t("noVersionChange"));
      return `<li class="version-timeline-item version-depth-${depth}${selected ? " selected" : ""}"><button type="button" data-version-id="${escapeHtml(version.id)}"${selected ? ' aria-current="true"' : ""}><span class="version-marker" aria-hidden="true"></span><span class="version-content"><span class="version-title"><strong>${escapeHtml(t("versionLabel", { number: version.version_index }))}</strong></span><span class="version-change">${escapeHtml(change)}${selected ? `<span class="version-current">${t("currentVersion")}</span>` : ""}${version.archived ? `<span class="version-archived">${t("archivedVersion")}</span>` : ""}</span><time datetime="${escapeHtml(version.created_at || "")}">${escapeHtml(formatDate(version.created_at))}</time></span></button></li>`;
    }).join("")}</ol>`;
  }

  function generationHistoryMarkup(history, selectedAssetId) {
    const events = Array.isArray(history?.events) ? history.events : [];
    if (!events.length) return `<p class="generation-history-status">${t("generationHistoryEmpty")}</p>`;
    const relations = Array.isArray(history?.relations) ? history.relations : [];
    const contextEvents = Array.isArray(history?.context_events) ? history.context_events : [];
    const outputAssets = Array.isArray(history?.output_assets) ? history.output_assets : [];
    const relationByChild = new Map();
    for (const relation of relations) {
      const list = relationByChild.get(relation.child_generation_id) || [];
      list.push(relation);
      relationByChild.set(relation.child_generation_id, list);
    }
    const eventById = new Map([...events, ...contextEvents].map((event) => [event.id, event]));
    const assetById = new Map(outputAssets.map((asset) => [asset.id, asset]));
    const roots = events.filter((event) => !(event.parent_generation_ids || []).length);
    const ordered = [];
    const seen = new Set();
    const visit = (event, depth = 0) => {
      if (!event || seen.has(event.id)) return;
      seen.add(event.id);
      ordered.push({ event, depth });
      for (const childId of event.child_generation_ids || []) visit(eventById.get(childId), depth + 1);
    };
    for (const root of roots) visit(root, 0);
    for (const event of events) visit(event, 0);
    const treeMarkup = `<ol class="generation-lineage" aria-label="${escapeHtml(t("generationTree"))}">${ordered.map(({ event, depth }) => {
      const verification = String(event.verification_level || "observed");
      const provider = String(event.provider || event.capture_channel || "").trim() || t("sourceUnknown");
      const model = String(event.model || "").trim();
      const prompt = String(event.effective_prompt || event.user_prompt || "").trim();
      const incoming = relationByChild.get(event.id) || [];
      const relationLabel = incoming.length
        ? incoming.map((relation) => `${t(`generationRelation_${relation.relation_type}`)} ${generationEventCompactLabel(eventById.get(relation.parent_generation_id))}`).join(" · ")
        : t("generationRoot");
      const isCurrentAsset = event.output_asset_id === selectedAssetId;
      const depthClass = `generation-depth-${Math.min(Math.max(depth, 0), 6)}`;
      const parentCount = incoming.length > 1 ? `<span class="generation-parent-count">${escapeHtml(t("generationRelationParentCount", { count: incoming.length }))}</span>` : "";
      return `<li class="generation-lineage-item ${depthClass}${isCurrentAsset ? " current-output" : ""}"><details class="generation-lineage-node" data-generation-id="${escapeHtml(event.id)}"><summary class="generation-lineage-summary"><span class="generation-lineage-marker" aria-hidden="true"></span>${generationEventThumbnailMarkup(event, assetById)}<span class="generation-lineage-content"><span class="generation-lineage-head"><strong>${escapeHtml(provider)}${model ? ` · ${escapeHtml(model)}` : ""}</strong><span class="generation-verification ${escapeHtml(verification)}">${escapeHtml(t(`generationVerification_${verification}`))}</span>${parentCount}</span><span class="generation-lineage-relation">${escapeHtml(relationLabel)}${isCurrentAsset ? ` · ${escapeHtml(t("generationCurrentAsset"))}` : ""}</span>${prompt ? `<span class="generation-lineage-prompt">${escapeHtml(prompt)}</span>` : `<span class="generation-lineage-prompt empty-copy">${t("notRecorded")}</span>`}<time datetime="${escapeHtml(event.created_at || "")}">${escapeHtml(formatDateTime(event.created_at))}</time></span></summary>${generationEventDetailMarkup(event, { history, eventById, assetById, incoming, selectedAssetId })}</details></li>`;
    }).join("")}</ol>`;
    return `<p class="generation-tree-hint">${escapeHtml(t("generationTreeHint"))}</p>${treeMarkup}${generationContextCandidatesMarkup(history, contextEvents, eventById, assetById)}`;
  }

  function generationEventThumbnailMarkup(event, assetById) {
    const asset = assetById.get(event.output_asset_id);
    const title = asset ? displayAssetTitle(asset) : event.output_asset_id;
    const thumbnail = asset?.thumbnail_ready && asset.thumbnail_url
      ? asset.thumbnail_url
      : asset?.preview_ready && asset.preview_url
        ? asset.preview_url
        : "";
    return thumbnail
      ? `<span class="generation-output-thumb"><img src="${escapeHtml(thumbnail)}" alt="" loading="lazy" decoding="async" /></span>`
      : `<span class="generation-output-thumb generation-output-thumb-empty" title="${escapeHtml(title || t("notRecorded"))}" aria-hidden="true"></span>`;
  }

  function generationEventCompactLabel(event) {
    if (!event) return t("notRecorded");
    const provider = String(event.provider || event.capture_channel || "").trim() || t("sourceUnknown");
    const prompt = String(event.effective_prompt || event.user_prompt || "").replace(/\s+/g, " ").trim();
    const compactPrompt = prompt.length > 42 ? `${prompt.slice(0, 39)}…` : prompt;
    return compactPrompt ? `${provider} · ${compactPrompt}` : `${provider} · ${formatDateTime(event.created_at)}`;
  }

  function generationRelationOptions(selectedType = "edited_from") {
    return ["edited_from", "variant_of", "derived_from", "based_on"]
      .map((type) => `<option value="${type}"${type === selectedType ? " selected" : ""}>${escapeHtml(t(`generationRelation_${type}`))}</option>`)
      .join("");
  }

  function generationRelationsMarkup(event, incoming, eventById) {
    if (!incoming.length) return `<p class="generation-management-empty">${escapeHtml(t("generationNoRelations"))}</p>`;
    return `<div class="generation-relation-list">${incoming.map((relation) => {
      const verification = String(relation.verification_level || "inferred");
      const locked = verification === "provider_verified";
      const parent = eventById.get(relation.parent_generation_id);
      const actionLabel = verification === "user_confirmed" ? t("generationRelationUpdate") : t("generationRelationSave");
      const controls = locked
        ? `<span class="generation-relation-locked">${escapeHtml(t("generationRelationLocked"))}</span>`
        : `<div class="generation-relation-controls"><label><span class="visually-hidden">${escapeHtml(t("generationRelationType"))}</span><select data-generation-relation-type>${generationRelationOptions(relation.relation_type)}</select></label><button class="action-btn secondary" type="button" data-action="save-generation-relation">${escapeHtml(actionLabel)}</button><button class="action-btn secondary generation-relation-remove" type="button" data-action="delete-generation-relation">${escapeHtml(t("generationRelationDelete"))}</button></div>`;
      return `<div class="generation-relation-row" data-generation-relation-row data-child-generation-id="${escapeHtml(event.id)}" data-parent-generation-id="${escapeHtml(relation.parent_generation_id)}" data-previous-relation-type="${escapeHtml(relation.relation_type)}"><div class="generation-relation-meta"><span>${escapeHtml(t("generationRelationParent"))}</span><strong title="${escapeHtml(relation.parent_generation_id)}">${escapeHtml(generationEventCompactLabel(parent))}</strong><span class="generation-verification ${escapeHtml(verification)}">${escapeHtml(t(`generationVerification_${verification}`))}</span></div>${controls}</div>`;
    }).join("")}</div>`;
  }

  function generationCandidateParentsMarkup(event, history, eventById) {
    const candidates = (Array.isArray(history?.relation_candidates) ? history.relation_candidates : [])
      .filter((candidate) => candidate.child_generation_id === event.id && candidate.status !== "dismissed" && candidate.status !== "confirmed");
    if (!candidates.length) return "";
    return `<div class="generation-candidate-parent-list"><div class="generation-management-head"><strong>${escapeHtml(t("generationPossibleParents"))}</strong></div>${candidates.map((candidate) => {
      const parent = eventById.get(candidate.parent_generation_id);
      const relationType = candidate.suggested_relation_type || candidate.relation_type || "derived_from";
      const confidence = Math.round(Number(candidate.confidence || 0) * 100);
      return `<div class="generation-relation-row generation-candidate-parent-row" data-generation-candidate-row><div class="generation-relation-meta"><span>${escapeHtml(t(`generationRelation_${relationType}`))}</span><strong title="${escapeHtml(candidate.parent_generation_id)}">${escapeHtml(generationEventCompactLabel(parent))}</strong><span class="generation-verification inferred">${escapeHtml(t("generationRelationConfidence", { confidence }))}</span></div><div class="generation-relation-controls"><button class="action-btn secondary" type="button" data-action="confirm-generation-relation-candidate" data-child-generation-id="${escapeHtml(candidate.child_generation_id)}" data-parent-generation-id="${escapeHtml(candidate.parent_generation_id)}" data-relation-type="${escapeHtml(relationType)}">${escapeHtml(t("generationConfirmRelation"))}</button><button class="action-btn secondary generation-relation-remove" type="button" data-action="dismiss-generation-relation-candidate" data-child-generation-id="${escapeHtml(candidate.child_generation_id)}" data-parent-generation-id="${escapeHtml(candidate.parent_generation_id)}">${escapeHtml(t("generationDismissRelation"))}</button></div></div>`;
    }).join("")}</div>`;
  }

  function generationLinkComposerMarkup(event, history, eventById) {
    const relations = Array.isArray(history?.relations) ? history.relations : [];
    const candidates = [...eventById.values()].filter((candidate) => {
      if (!candidate?.id || candidate.id === event.id) return false;
      return !relations.some((relation) => (
        (relation.child_generation_id === event.id && relation.parent_generation_id === candidate.id)
        || (relation.parent_generation_id === event.id && relation.child_generation_id === candidate.id)
      ));
    });
    if (!candidates.length) return `<p class="generation-management-empty">${escapeHtml(t("generationLinkUnavailable"))}</p>`;
    const candidateOptions = candidates.map((candidate) => `<option value="${escapeHtml(candidate.id)}">${escapeHtml(generationEventCompactLabel(candidate))}</option>`).join("");
    const firstCandidate = candidates[0];
    const candidateIsEarlier = String(firstCandidate?.created_at || "") <= String(event.created_at || "");
    return `<div class="generation-link-composer" data-generation-link-form data-anchor-generation-id="${escapeHtml(event.id)}"><label><span>${escapeHtml(t("generationLinkCandidate"))}</span><select data-generation-link-candidate>${candidateOptions}</select></label><label><span>${escapeHtml(t("generationLinkDirection"))}</span><select data-generation-link-direction><option value="candidate-parent"${candidateIsEarlier ? " selected" : ""}>${escapeHtml(t("generationLinkCandidateParent"))}</option><option value="candidate-child"${candidateIsEarlier ? "" : " selected"}>${escapeHtml(t("generationLinkCandidateChild"))}</option></select></label><label><span>${escapeHtml(t("generationRelationType"))}</span><select data-generation-link-type>${generationRelationOptions("edited_from")}</select></label><button class="action-btn secondary" type="button" data-action="create-generation-relation">${escapeHtml(t("generationLinkCreate"))}</button></div>`;
  }

  function generationContextCandidatesMarkup(history, contextEvents, eventById, assetById) {
    if (!contextEvents.length) return "";
    const relationCandidates = Array.isArray(history?.relation_candidates) ? history.relation_candidates : [];
    return `<details class="generation-context-candidates"><summary class="generation-context-candidates-head"><strong>${escapeHtml(t("generationContextCandidates"))}</strong><span>${escapeHtml(t("generationContextCandidateCount", { count: contextEvents.length }))}</span></summary><ol>${contextEvents.map((event) => {
      const provider = String(event.provider || event.capture_channel || "").trim() || t("sourceUnknown");
      const prompt = String(event.effective_prompt || event.user_prompt || "").trim();
      const inferred = relationCandidates.find((candidate) => (
        candidate.child_generation_id === event.id || candidate.parent_generation_id === event.id
      ));
      const otherId = inferred
        ? (inferred.child_generation_id === event.id ? inferred.parent_generation_id : inferred.child_generation_id)
        : "";
      const otherEvent = eventById.get(otherId);
      const candidateLabelKey = inferred?.child_generation_id === event.id
        ? "generationReferenceRelationCandidate"
        : "generationReferenceRelationParentCandidate";
      const inferredEvidence = inferred
        ? `<span class="generation-candidate-evidence">${escapeHtml(t(candidateLabelKey, { generation: generationEventCompactLabel(otherEvent) }))} · ${escapeHtml(t("generationRelationConfidence", { confidence: Math.round(Number(inferred.confidence || 0) * 100) }))}</span>`
        : "";
      const confirmAction = inferred
        ? `<button class="action-btn secondary" type="button" data-action="confirm-generation-relation-candidate" data-child-generation-id="${escapeHtml(inferred.child_generation_id)}" data-parent-generation-id="${escapeHtml(inferred.parent_generation_id)}" data-relation-type="${escapeHtml(inferred.suggested_relation_type || inferred.relation_type || "derived_from")}">${escapeHtml(t("generationConfirmRelation"))}</button><button class="action-btn secondary" type="button" data-action="dismiss-generation-relation-candidate" data-child-generation-id="${escapeHtml(inferred.child_generation_id)}" data-parent-generation-id="${escapeHtml(inferred.parent_generation_id)}">${escapeHtml(t("generationDismissRelation"))}</button>`
        : "";
      return `<li data-context-generation-id="${escapeHtml(event.id)}">${generationEventThumbnailMarkup(event, assetById)}<span class="generation-context-candidate-copy"><span><strong>${escapeHtml(provider)}</strong><span class="generation-verification inferred">${escapeHtml(inferred ? t("generationLikelyRelated") : t("generationUnlinked"))}</span></span>${prompt ? `<span>${escapeHtml(prompt)}</span>` : `<span class="empty-copy">${t("notRecorded")}</span>`}${inferredEvidence}<time datetime="${escapeHtml(event.created_at || "")}">${escapeHtml(formatDateTime(event.created_at))}</time></span><span class="generation-context-candidate-actions">${confirmAction}<button class="action-btn secondary" type="button" data-action="open-generation-output" data-output-asset-id="${escapeHtml(event.output_asset_id)}">${escapeHtml(t("generationOpenAsset"))}</button>${event.conversation_id ? `<button class="action-btn secondary" type="button" data-action="view-generation-context" data-generation-id="${escapeHtml(event.id)}">${escapeHtml(t("generationViewContext"))}</button>` : ""}</span></li>`;
    }).join("")}</ol></details>`;
  }

  function generationEventDetailMarkup(event, context = {}) {
    const effectivePrompt = String(event.effective_prompt || "").trim();
    const userPrompt = String(event.user_prompt || "").trim();
    const references = Array.isArray(event.references) ? event.references : [];
    const evidence = event.evidence && typeof event.evidence === "object" ? event.evidence : {};
    const incoming = Array.isArray(context.incoming) ? context.incoming : [];
    const eventById = context.eventById instanceof Map ? context.eventById : new Map();
    const isCurrentAsset = event.output_asset_id === context.selectedAssetId;
    const identifiers = [
      ["generationEventId", event.id],
      ["generationOutputAsset", event.output_asset_id],
      ["generationCaptureContext", event.capture_context_id],
      ["generationProviderToolCall", event.provider_tool_call_id],
      ["generationProviderCall", event.provider_generation_call_id],
      ["generationProviderResponse", event.provider_response_id],
      ["generationProviderAsset", event.provider_asset_id],
      ["generationConversationId", event.conversation_id],
      ["generationMessageId", event.message_id],
    ].filter(([, value]) => String(value || "").trim());
    const identifierMarkup = identifiers.length
      ? `<div class="generation-detail-identifiers">${identifiers.map(([key, value]) => `<div class="generation-detail-id-row"><span>${escapeHtml(t(key))}</span><code>${escapeHtml(String(value))}</code></div>`).join("")}</div>`
      : `<p class="empty-copy">${t("notRecorded")}</p>`;
    const referencesMarkup = references.length
      ? `<ol class="generation-reference-list">${references.map((reference, index) => {
        const label = String(reference?.role || reference?.asset_id || reference?.provider_asset_id || reference?.sha256 || t("generationReferenceLabel", { number: index + 1 }));
        return `<li><details class="generation-reference-detail"><summary>${escapeHtml(label)}</summary><pre>${escapeHtml(generationJson(reference))}</pre></details></li>`;
      }).join("")}</ol>`
      : `<p class="empty-copy">${t("noReferences")}</p>`;
    const evidenceMarkup = Object.keys(evidence).length
      ? `<pre class="generation-evidence-json">${escapeHtml(generationJson(evidence))}</pre>`
      : `<p class="empty-copy">${t("generationEvidenceEmpty")}</p>`;
    const contextActions = `<div class="generation-node-actions"><button class="action-btn secondary" type="button" data-action="open-generation-output" data-output-asset-id="${escapeHtml(event.output_asset_id)}"${isCurrentAsset ? " disabled" : ""}>${escapeHtml(isCurrentAsset ? t("generationCurrentAsset") : t("generationOpenAsset"))}</button>${event.conversation_id ? `<button class="action-btn secondary" type="button" data-action="view-generation-context" data-generation-id="${escapeHtml(event.id)}">${escapeHtml(t("generationViewContext"))}</button>` : ""}</div>`;
    const relationManagement = `<details class="generation-management-disclosure"><summary>${escapeHtml(t("generationRelations"))}</summary><div class="generation-management">${generationCandidateParentsMarkup(event, context.history, eventById)}${generationRelationsMarkup(event, incoming, eventById)}<details class="generation-link-disclosure"><summary>${escapeHtml(t("generationLinkGeneration"))}</summary>${generationLinkComposerMarkup(event, context.history, eventById)}</details></div></details>`;
    return `<div class="generation-lineage-detail">${contextActions}<div class="generation-detail-field"><span class="generation-detail-label">${t("generationEffectivePrompt")}</span><div class="generation-detail-prompt">${effectivePrompt ? escapeHtml(effectivePrompt) : `<span class="empty-copy">${t("notRecorded")}</span>`}</div></div>${userPrompt && userPrompt !== effectivePrompt ? `<div class="generation-detail-field"><span class="generation-detail-label">${t("generationUserPrompt")}</span><div class="generation-detail-prompt">${escapeHtml(userPrompt)}</div></div>` : ""}${relationManagement}<details class="generation-subdetail"><summary>${t("generationReferences")} · ${references.length}</summary>${referencesMarkup}</details><details class="generation-subdetail"><summary>${t("generationEvidence")}</summary>${evidenceMarkup}</details><details class="generation-subdetail"><summary>${t("generationIdentifiers")}</summary>${identifierMarkup}</details></div>`;
  }

  function generationJson(value) {
    try { return JSON.stringify(value, null, 2); }
    catch { return String(value ?? ""); }
  }

  // GravityPort A4a：界面已拿掉，保留实现（配方快照历史 disclosure 不再渲染；
  // 数据仍由 loadRecipeHistory 拉取，参考图权利快照依赖它）。
  function recipeHistoryDisclosureMarkup(history) {
    const content = history
      ? recipeHistoryMarkup(history)
      : `<p class="recipe-history-status" role="status">${t("recipeSnapshotLoading")}</p>`;
    // Phase 4A：单栏中完整历史默认不强行展开，按需披露（与版本历史 disclosure 一致）。
    return `<details class="detail-disclosure"><summary>${t("recipeHistoryLabel")}</summary><div class="disclosure-content recipe-history-region" data-recipe-history aria-live="polite">${content}</div></details>`;
  }

  /**
   * Summarise reference rights for the snapshot badge.
   *
   * `lib/reference-rights.mjs` is the authority for this vocabulary; the browser
   * bundle cannot import it, so this mirrors its precedence rules. An explicit
   * refusal outranks an unknown here for the same reason it does there, and
   * values are normalised the same way so a hand-edited or legacy row cannot read
   * as unresolved here while the library reads it as restricted.
   */
  function referenceRightsSummary(references) {
    const list = Array.isArray(references) ? references : [];
    if (!list.length) return null;
    const state = (value) => (typeof value === "boolean" ? value : String(value ?? "").trim().toLowerCase());
    let restricted = 0;
    let unresolved = 0;
    for (const reference of list) {
      const rights = reference?.rights || reference || {};
      const consent = state(rights.portrait_consent ?? rights.consent);
      const redistribution = state(rights.redistribution ?? rights.redistribution_allowed);
      if (consent === "denied" || consent === false || redistribution === "forbidden" || redistribution === false) restricted += 1;
      else if ([state(rights.copyright), consent, redistribution].some((value) => !value || value === "unknown")) unresolved += 1;
    }
    if (restricted) return { tone: "restricted", label: t("referenceRightsRestricted", { count: restricted }) };
    if (unresolved) return { tone: "unresolved", label: t("referenceRightsUnresolved", { count: unresolved }) };
    return { tone: "cleared", label: t("referenceRightsCleared") };
  }

  function recipeHistoryMarkup(history) {
    const snapshots = history?.snapshots || [];
    if (!snapshots.length) return `<p class="recipe-history-status">${t("notRecorded")}</p>`;
    return `<ol class="recipe-snapshot-list" aria-label="${escapeHtml(t("recipeSnapshotHistory"))}">${snapshots.map((snapshot, index) => {
      const active = snapshot.snapshot_id === history.active_snapshot_id;
      const tool = [snapshot.model, snapshot.generation_tool, snapshot.provider].filter(Boolean).join(" · ") || t("notRecorded");
      const referenceText = snapshot.references?.length ? t("referenceCount", { count: snapshot.references.length }) : "";
      const rights = referenceRightsSummary(snapshot.references);
      const digest = String(snapshot.recipe_digest || "").slice(0, 12);
      return `<li class="recipe-snapshot-item${active ? " active" : ""}"><div class="recipe-snapshot-head"><span><strong>${escapeHtml(t("recipeSnapshotLabel", { number: index + 1 }))}</strong>${active ? `<span class="recipe-current">${t("currentRecipe")}</span>` : ""}</span><code title="${escapeHtml(snapshot.recipe_digest || "")}">${escapeHtml(digest)}</code></div><p class="recipe-snapshot-change">${escapeHtml(snapshot.change_summary || t("noRecipeChange"))}</p><p class="recipe-snapshot-prompt">${escapeHtml(snapshot.effective_prompt || t("notRecorded"))}</p><div class="recipe-snapshot-meta"><span>${escapeHtml(tool)}</span><span>${escapeHtml(t("promptStatus"))}: ${escapeHtml(snapshot.prompt_status || t("notRecorded"))}</span>${referenceText ? `<span>${escapeHtml(referenceText)}</span>` : ""}${rights ? `<button type="button" class="recipe-reference-rights ${rights.tone}" data-action="open-reference-rights" title="${escapeHtml(t("referenceRights"))}">${escapeHtml(rights.label)}</button>` : ""}</div><div class="recipe-snapshot-footer"><time datetime="${escapeHtml(snapshot.created_at || "")}">${escapeHtml(formatDateTime(snapshot.created_at))}</time><button type="button" data-recipe-snapshot-id="${escapeHtml(snapshot.snapshot_id)}">${t("useRecipe")}</button></div></li>`;
    }).join("")}</ol>`;
  }

  // GravityPort A4a：界面已拿掉，保留实现（唯一调用方 detailSourceSectionMarkup
  // 不再渲染）。
  function categoryOptions(selected) { return ["product", "concept", "texture", "reference", "other"].map((value) => `<option value="${value}"${selected === value ? " selected" : ""}>${t(`category${value[0].toUpperCase()}${value.slice(1)}`)}</option>`).join(""); }
  // GravityPort A4a：界面已拿掉，保留实现（唯一调用方 detailSourceSectionMarkup
  // 不再渲染）。
  function buildSourceRows(source) {
    if (source.type === "codex-generated") return [["sourceLabel", sourceName(source)], ["taskId", source.codex_task_id], ["model", source.model], ["generationTool", source.generation_tool], ["originalPath", source.path]];
    if (source.type === "cowart-generated") return [["sourceLabel", sourceName(source)], ["canvasObject", source.cowart_shape_id], ["pageAsset", source.cowart_asset_id], ["canvasNote", source.cowart_annotation_source_shape_id ? t("canvasEdited") : t("canvasImage")], ["originalPath", source.path]];
    if (source.type === "grok-generated") {
      const mediaLabel = source.media_kind === "video" ? t("mediaKindVideo") : t("mediaKindImage");
      return [
        ["sourceLabel", sourceName(source)],
        ["mediaKind", mediaLabel],
        ["sessionId", source.grok_session_id],
        ["model", source.model],
        ["generationTool", source.generation_tool],
        ["originalPath", source.path || source.grok_media_path],
      ];
    }
    if (/^web-/.test(String(source.type || ""))) return [["sourceLabel", sourceName(source)], ["sessionId", source.conversation_id], ["generationBatch", source.message_id], ["model", source.model], ["generationTool", source.generation_tool]];
    return [["sourceLabel", sourceName(source)], ["originalPath", source.path], ["taskId", source.codex_task_id], ["generationTool", source.generation_tool], ["model", source.model]];
  }
  // 来源名称统一走 SOURCE_LABEL_KEYS 单一映射（与 assetSourceLabel 同口径）：web-chatgpt
  // 显示为 ChatGPT，不得落入手动导入；未知类型回退到原始类型串或“未知来源”。
  function sourceName(source = {}) {
    const type = String(source.type || "");
    return SOURCE_LABEL_KEYS[type] ? t(SOURCE_LABEL_KEYS[type]) : (type || t("sourceUnknown"));
  }

  // GravityPort A4a：界面已拿掉，保留实现（copy-source 按钮不再渲染）。
  // 复制来源路径的统一取值：与 buildSourceRows 的 originalPath 行同一优先级（path →
  // grok_media_path → 空串），保证“显示有路径即可复制”，渲染判断与点击取值不漂移。
  function sourceCopyValue(source = {}) {
    return String(source.path || source.grok_media_path || "");
  }

  function isVideoAsset(asset = {}) {
    const kind = asset.source?.media_kind || asset.business_fields?.media_kind;
    if (kind === "video") return true;
    if (kind === "image") return false;
    const path = String(asset.image_path || asset.asset || asset.image_url || "");
    return /\.(mp4|webm|mov|m4v)(?:$|\?)/i.test(path);
  }

  function assetMediaPreviewMarkup(asset, mode = "thumb") {
    const title = displayAssetTitle(asset);
    const url = mode === "detail" ? (asset.medium_url || asset.preview_url || asset.image_url) : (asset.thumbnail_url || asset.image_url);
    if (isVideoAsset(asset)) {
      if (mode === "detail") {
        return `<div class="detail-video-stack"><video class="detail-image detail-video" src="${escapeHtml(asset.image_url)}" controls playsinline preload="metadata" title="${escapeHtml(title)}">${escapeHtml(t("videoFallback"))}</video></div>`;
      }
      const posterUrl = asset.thumbnail_url && asset.thumbnail_url !== asset.image_url ? asset.thumbnail_url : "";
      const poster = posterUrl
        ? `<img class="thumb-video-poster" src="${escapeHtml(posterUrl)}" alt="" loading="lazy" decoding="async" />`
        : `<span class="thumb-video-placeholder"></span><video class="thumb-video-poster thumb-video-frame" data-gallery-video-src="${escapeHtml(asset.image_url)}" preload="none" muted playsinline tabindex="-1"${mediaDimensionAttributes(asset)}></video>`;
      return `<span class="thumb video-thumb" aria-hidden="true"${videoThumbAspectAttributes(asset)}>${poster}<span class="video-badge">▶</span></span>`;
    }
    if (mode === "thumb" && asset.thumbnail_ready === false) {
      const width = Number(asset.business_fields?.width);
      const height = Number(asset.business_fields?.height);
      const viewBox = Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
        ? `0 0 ${Math.round(width)} ${Math.round(height)}`
        : "0 0 1 1";
      return `<svg class="thumb image-thumb-pending" viewBox="${viewBox}" preserveAspectRatio="none" aria-hidden="true"></svg>`;
    }
    if (mode === "detail") {
      const srcset = [
        asset.thumbnail_url && asset.thumbnail_url !== asset.image_url ? `${escapeHtml(asset.thumbnail_url)} 400w` : "",
        asset.medium_url && asset.medium_url !== asset.image_url ? `${escapeHtml(asset.medium_url)} 960w` : "",
        asset.preview_url && asset.preview_url !== asset.image_url ? `${escapeHtml(asset.preview_url)} 1600w` : "",
      ].filter(Boolean).join(", ");
      // 任务 36：图片包进键盘可及的预览入口（视频分支在上方，不包——视频不走
      // 预览弹窗）。aria-label 用 viewFullImage 给读屏一个明确的名称；尺寸与
      // 焦点样式由 .detail-preview-entry 的规则负责，img 自身规则不变。
      return `<button type="button" class="detail-preview-entry" aria-label="${escapeHtml(t("viewFullImage"))}" title="${escapeHtml(t("viewFullImage"))}"><img class="detail-image" src="${escapeHtml(url)}"${srcset ? ` srcset="${srcset}" sizes="360px"` : ""} alt="${escapeHtml(title)}" decoding="async" /></button>`;
    }
    const thumbSrcset = [
      asset.thumbnail_url && asset.thumbnail_url !== asset.image_url ? `${escapeHtml(asset.thumbnail_url)} 400w` : "",
      asset.medium_ready && asset.medium_url && asset.medium_url !== asset.image_url ? `${escapeHtml(asset.medium_url)} 960w` : "",
      asset.preview_ready && asset.preview_url && asset.preview_url !== asset.image_url ? `${escapeHtml(asset.preview_url)} 1600w` : "",
    ].filter(Boolean).join(", ");
    return `<img class="thumb" src="${escapeHtml(url)}"${thumbSrcset ? ` srcset="${thumbSrcset}" sizes="(max-width: 720px) calc(50vw - 24px), 240px"` : ""} data-gallery-src="${escapeHtml(url)}" alt="${escapeHtml(title)}" loading="lazy" decoding="async"${mediaDimensionAttributes(asset)} />`;
  }

  function readyDerivativeUrl(asset, urlKey, readyKey) {
    const url = String(asset?.[urlKey] || "").trim();
    return url && asset?.[readyKey] !== false ? url : "";
  }

  function stackInspectorMediaMarkup(asset = {}) {
    const title = displayAssetTitle(asset);
    const originalUrl = String(asset.image_url || "").trim();
    const thumbnailUrl = readyDerivativeUrl(asset, "thumbnail_url", "thumbnail_ready");
    const mediumUrl = readyDerivativeUrl(asset, "medium_url", "medium_ready");
    const previewUrl = readyDerivativeUrl(asset, "preview_url", "preview_ready");

    if (isVideoAsset(asset)) {
      const posterUrl = thumbnailUrl || mediumUrl || previewUrl;
      if (posterUrl) {
        return `<img class="thumb-video-poster" src="${escapeHtml(posterUrl)}" alt="${escapeHtml(title)}" loading="lazy" decoding="async" />`;
      }
      if (originalUrl) {
        return `<video class="thumb-video-poster stack-inspector-video" src="${escapeHtml(originalUrl)}" preload="metadata" muted playsinline tabindex="-1" aria-label="${escapeHtml(title)}"${mediaDimensionAttributes(asset)}></video>`;
      }
      return `<span class="thumb-video-placeholder" aria-hidden="true"></span>`;
    }

    const url = thumbnailUrl || mediumUrl || previewUrl || originalUrl;
    if (!url) return `<span class="thumb image-thumb-pending" aria-hidden="true"></span>`;
    const srcset = [
      thumbnailUrl ? `${escapeHtml(thumbnailUrl)} 400w` : "",
      mediumUrl ? `${escapeHtml(mediumUrl)} 960w` : "",
      previewUrl ? `${escapeHtml(previewUrl)} 1600w` : "",
    ].filter(Boolean).join(", ");
    const fallback = originalUrl && originalUrl !== url
      ? ` data-stack-fallback-src="${escapeHtml(originalUrl)}"`
      : "";
    return `<img class="thumb stack-inspector-image" src="${escapeHtml(url)}"${srcset ? ` srcset="${srcset}" sizes="144px"` : ""}${fallback} alt="${escapeHtml(title)}" loading="lazy" decoding="async"${mediaDimensionAttributes(asset)} />`;
  }

  function stackInspectorMarkup(detailStack = {}) {
    const members = Array.isArray(detailStack.members) ? detailStack.members : [];
    const status = detailStack.loading
      ? `<div class="stack-inspector-status" role="status">${escapeHtml(t("stackInspectorLoading"))}</div>`
      : detailStack.error
        ? `<div class="stack-inspector-status is-error" role="alert">${escapeHtml(t("stackInspectorLoadFailed"))}</div>`
        : "";
    const memberMarkup = members.map((asset, index) => `
      <div class="stack-inspector-member" data-stack-member-id="${escapeHtml(asset.id)}" title="${escapeHtml(displayAssetTitle(asset))}">
        <div class="stack-inspector-thumb">${stackInspectorMediaMarkup(asset)}</div>
        <span>${index + 1}</span>
      </div>`).join("");
    const empty = !detailStack.loading && !detailStack.error && members.length === 0
      ? `<div class="stack-inspector-status">${escapeHtml(t("stackInspectorEmpty"))}</div>`
      : "";
    return `<section class="stack-inspector" data-stack-inspector data-stack-id="${escapeHtml(detailStack.id || "")}">
      ${status}${empty}${memberMarkup ? `<div class="stack-inspector-grid">${memberMarkup}</div>` : ""}
    </section>`;
  }

  // GravityPort A4a：detailSourceSectionMarkup / detailGroupSectionMarkup /
  // detailMoreSectionMarkup / editRecipeFieldsMarkup / recipeHistoryDisclosureMarkup /
  // buildSourceRows / sourceCopyValue / categoryOptions 已从界面拿掉（函数体保留，
  // 见各函数上方注释），不再出现在返回值里。
  return { fileDimensionsText, fileFormatText, fileSizeText, fileAspectRatioText, formatFileSize, fileFactRowMarkup, fileFactTagMarkup, detailFavoriteButtonMarkup, detailFileSectionMarkup, detailPaletteSectionMarkup, detailPromptSectionMarkup, detailReferenceSectionMarkup, detailVersionContextSectionMarkup, generationContextBoxMarkup, promptReferencesMarkup, detailVersionSectionMarkup, versionPickerMarkup, versionCompareMarkup, versionOptionLabel, detailVersionSummaryMarkup, detailTagsSectionMarkup, versionHistoryMarkup, generationHistoryMarkup, referenceRightsSummary, recipeHistoryMarkup, sourceName, isVideoAsset, assetMediaPreviewMarkup, stackInspectorMarkup };
}
