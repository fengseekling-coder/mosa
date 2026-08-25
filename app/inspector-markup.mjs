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
import { escapeHtml, formatDate, formatDateTime } from "./utils.mjs";

export function createInspectorMarkup({ state, t, referenceRightsMarkup }) {
  const COPY_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9"/></svg>`;

  function persistedPositiveNumber(asset, ...keys) {
    for (const source of [asset, asset?.business_fields]) {
      for (const key of keys) {
        const value = Number(source?.[key]);
        if (Number.isFinite(value) && value > 0) return value;
      }
    }
    return null;
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
    const gcd = (left, right) => right ? gcd(right, left % right) : left;
    const divisor = gcd(Math.round(width), Math.round(height));
    return `${Math.round(width) / divisor}:${Math.round(height) / divisor}`;
  }

  function fileFactTagMarkup(key, value) {
    const text = value === null ? t("notRecorded") : value;
    const label = `${t(key)}: ${text}`;
    return `<span class="detail-fact-tag" aria-label="${escapeHtml(label)}">${escapeHtml(text)}</span>`;
  }

  function detailFavoriteButtonMarkup(asset) {
    const favorite = Boolean(asset.favorite);
    const actionLabel = t(favorite ? "removeFavorite" : "addFavorite");
    const visibleLabel = t(favorite ? "favorited" : "addFavorite");
    return `<button class="detail-fav-btn${favorite ? " is-fav" : ""}" type="button" data-action="toggle-favorite" aria-pressed="${favorite}" aria-label="${escapeHtml(actionLabel)}"><span aria-hidden="true">${favorite ? "★" : "☆"}</span><span>${escapeHtml(visibleLabel)}</span></button>`;
  }

  const MAX_DETAIL_PREVIEW_ASPECT = 9 / 16;

  function detailPreviewAspectRatio(asset) {
    const width = persistedPositiveNumber(asset, "width");
    const height = persistedPositiveNumber(asset, "height");
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return "9 / 16";
    }
    const assetAspect = width / height;
    return assetAspect >= MAX_DETAIL_PREVIEW_ASPECT ? `${width} / ${height}` : "9 / 16";
  }

  function detailFileSectionMarkup(asset) {
    const title = asset.theme || asset.asset || asset.id;
    const source = sourceName(asset.source || {});
    const sourceRef = asset.source || {};
    const previewAspectRatio = detailPreviewAspectRatio(asset);
    const openSourceButton = String(sourceRef.conversation_id || "").trim()
      ? `<button class="section-head-copy detail-overview-open" type="button" data-action="view-generation-session" title="${escapeHtml(t("openOriginalConversation"))}" aria-label="${escapeHtml(t("openOriginalConversation"))}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></button>`
      : "";
    const facts = [
      ["fileFormat", fileFormatText(asset)],
      ["fileDimensions", fileDimensionsText(asset)],
      ["aspectRatio", fileAspectRatioText(asset)],
      ["fileSize", fileSizeText(asset)],
      ["group", String(asset.group || "").trim() || t("notGrouped")],
    ].map(([key, value]) => fileFactTagMarkup(key, value)).join("");
    return `<section class="inspector-section detail-overview" data-inspector-section="file" aria-labelledby="assetOverviewTitle"><div class="detail-overview-heading"><h3 id="assetOverviewTitle">${t("fileFacts")}</h3><p title="${escapeHtml(`${source} · ${formatDate(asset.created_at, state.locale)}`)}">${escapeHtml(source)} · ${formatDate(asset.created_at, state.locale)}</p>${openSourceButton}</div><div class="detail-image-wrap" data-detail-preview-aspect="${escapeHtml(previewAspectRatio)}">${assetMediaPreviewMarkup(asset, "detail")}</div><div class="detail-overview-title-row"><h3 id="detailTitle" tabindex="-1" title="${escapeHtml(title)}">${escapeHtml(title)}</h3>${detailFavoriteButtonMarkup(asset)}</div><div class="detail-facts" role="group" aria-label="${escapeHtml(t("assetMetadata"))}">${facts}</div></section>`;
  }

  function detailTagsSectionMarkup(asset) {
    const tags = assetTags(asset).slice(0, 10);
    const tagMarkup = tags.map((tag) => `<span class="detail-tag" data-tag-value="${escapeHtml(tag)}">${escapeHtml(tag)}</span>`).join("");
    const emptyMarkup = tags.length ? "" : `<span class="empty-copy detail-tags-empty">${t("tagsEmpty")}</span>`;
    return `<section class="inspector-section detail-tags-section" data-inspector-section="tags" aria-label="${escapeHtml(t("tags"))}"><div class="detail-tags-row" data-tags-list>${tagMarkup}${emptyMarkup}<button class="detail-tags-add" type="button" data-action="add-tag"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>${escapeHtml(t("addTag"))}</span></button></div></section>`;
  }

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
    const copyButton = asset.prompt
      ? `<button class="section-head-copy" type="button" data-action="copy-prompt" title="${t("copyPrompt")}" aria-label="${t("copyPrompt")}">${COPY_ICON_SVG}</button>`
      : "";
    const userInstruction = String(source.user_message || asset.business_fields?.user_message || "").trim();
    const instructionText = userInstruction
      ? escapeHtml(userInstruction)
      : `<span class="empty-copy">${t("userInstructionUnavailable")}</span>`;
    // V2 keeps the user-instruction pair at a fixed position even when the
    // upstream source has none.  This preserves the 224px composition instead
    // of letting a legacy recipe disclosure rise into the V2 first view.
    const userInstructionMarkup = `<div class="detail-prompt-subhead"><h4>${t("userInstruction")}</h4><button class="detail-copy-sub" type="button" data-action="copy-instruction" aria-label="${escapeHtml(t("userInstruction"))}"${userInstruction ? "" : " disabled"}>${COPY_ICON_SVG}</button></div><div class="prompt-box detail-instruction-box">${instructionText}</div>`;
    const referenceRow = `<div class="detail-reference-row"><span class="detail-reference-label"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>${t("referenceImage")}</span><span class="detail-reference-value">${t("referenceUnused")}</span></div>`;
    return `<section class="inspector-section detail-prompt-section" data-inspector-section="prompt"><div class="detail-prompt-head"><h3>${t("prompt")}</h3>${copyButton}</div><div class="prompt-box detail-prompt-box" role="textbox" aria-readonly="true">${promptText}</div>${promptProvenance}${userInstructionMarkup}${referenceRow}<details class="detail-disclosure"><summary>${t("recipeAndEditing")}</summary><div class="disclosure-content detail-fields">${editRecipeFieldsMarkup(asset)}<label class="field recipe-change-field"><span>${t("recipeChangeSummary")}</span><textarea data-recipe-change rows="2" placeholder="${escapeHtml(t("recipeChangePlaceholder"))}"></textarea></label><div class="recipe-save-actions"><button class="recipe-save-btn secondary" type="button" data-action="save-recipe">${t("saveRecipe")}</button></div></div></details></section>`;
  }

  function editRecipeFieldsMarkup(asset) {
    const rating = Math.min(5, Math.max(0, Math.round(asset.rating || 0)));
    const groupOptions = state.groups.groups.map(([name]) => `<option value="${escapeHtml(name)}"></option>`).join("");
    return `<label class="field"><span>${t("prompt")}</span><textarea data-edit="prompt" rows="5">${escapeHtml(asset.prompt || "")}</textarea></label><div class="two"><label class="field"><span>${t("skill")}</span><input data-edit="skill" value="${escapeHtml(asset.skill || "")}" /></label><label class="field"><span>${t("style")}</span><input data-edit="style" value="${escapeHtml(asset.style || "")}" /></label></div><div class="two"><label class="field"><span>${t("ratio")}</span><input data-edit="ratio" value="${escapeHtml(asset.ratio || "")}" /></label><label class="field"><span>${t("theme")}</span><input data-edit="theme" value="${escapeHtml(asset.theme || "")}" /></label></div><div class="two"><label class="field"><span>${t("group")}</span><input data-edit="group" value="${escapeHtml(asset.group || "")}" list="groupSuggestionsEdit" /><datalist id="groupSuggestionsEdit">${groupOptions}</datalist></label><label class="field"><span>${t("category")}</span><select data-edit="category"><option value="">${t("none")}</option>${categoryOptions(asset.category)}</select></label></div><label class="field"><span>${t("rating")}</span><div class="rating-edit" data-edit="rating">${[1,2,3,4,5].map((number) => `<button type="button" data-val="${number}" class="${number <= rating ? "on" : ""}" aria-label="${number}/5">${number <= rating ? "★" : "☆"}</button>`).join("")}</div></label><label class="field"><span>${t("businessFields")}</span><textarea data-edit="business_fields" rows="3">${escapeHtml(JSON.stringify(asset.business_fields || {}, null, 2))}</textarea></label>`;
  }

  function detailSourceSectionMarkup(asset) {
    const source = asset.source || {};
    const sourceRows = buildSourceRows(source).filter(([, value]) => value !== undefined && value !== null && value !== "");
    const rowsMarkup = sourceRows.length
      ? `<div class="meta-table">${sourceRows.map(([key, value]) => `<div class="meta-row"><span class="meta-key">${t(key)}</span><span class="meta-val source-value">${escapeHtml(value)}</span></div>`).join("")}</div>`
      : `<p class="empty-copy">${t("notRecorded")}</p>`;
    // 复制来源入口仅在有明确可复制值（原始路径）时渲染；取值与点击复制共用 sourceCopyValue。
    const copyButton = sourceCopyValue(source)
      ? `<button class="section-head-copy" type="button" data-action="copy-source" title="${t("copyOriginalPath")}" aria-label="${t("copyOriginalPath")}">${COPY_ICON_SVG}</button>`
      : "";
    const conversationId = String(source.conversation_id || "").trim();
    const messageId = String(source.message_id || "").trim();
    const sessionActions = conversationId
      ? `<div class="detail-utility-actions generation-navigation" role="group" aria-label="${escapeHtml(t("generationNavigation"))}">${messageId ? `<button class="action-btn secondary" type="button" data-action="view-generation-batch">${t("viewGenerationBatch")}</button>` : ""}<button class="action-btn secondary" type="button" data-action="view-generation-session">${t("viewGenerationSession")}</button></div>`
      : "";
    return `<section class="inspector-section detail-source-section" data-inspector-section="source"><div class="detail-prompt-head"><h3>${t("sourceInfo")}</h3>${copyButton}</div>${rowsMarkup}${sessionActions}<details class="detail-disclosure" data-reference-rights-section><summary>${t("referenceRights")}</summary><div class="disclosure-content" data-reference-rights>${referenceRightsMarkup(asset)}</div></details></section>`;
  }

  function detailVersionSectionMarkup(asset, cachedHistory, cachedRecipeHistory) {
    return `<section class="inspector-section detail-version-section" data-inspector-section="version"><div class="detail-prompt-head"><h3>${t("tabVersions")}</h3></div><div class="version-picker" data-version-picker>${versionPickerMarkup(asset, cachedHistory)}</div><details class="detail-disclosure"><summary>${t("versionHistory")}</summary><div class="disclosure-content version-history-region" data-version-history aria-live="polite">${cachedHistory ? versionHistoryMarkup(cachedHistory, asset.id) : `<p class="version-history-status" role="status">${t("versionLoading")}</p>`}</div></details>${recipeHistoryDisclosureMarkup(cachedRecipeHistory)}</section>`;
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

  function detailGroupSectionMarkup(asset) {
    const group = String(asset.group || "").trim();
    return `<section class="inspector-section detail-group-section" data-inspector-section="group"><div class="detail-prompt-head"><h3>${t("group")}</h3></div><p class="inspector-readout">${group ? escapeHtml(group) : `<span class="empty-copy">${t("notGrouped")}</span>`}</p></section>`;
  }

  function detailNewVersionSectionMarkup() {
    return `<section class="inspector-section detail-regenerate-section" data-inspector-section="new-version"><div class="detail-regenerate-head"><h3>${t("createRecipeVersion")}</h3></div><p class="detail-version-truth-note">${t("createRecipeVersionDescription")}</p><div class="detail-regenerate-composer"><textarea data-version-change rows="3" placeholder="${escapeHtml(t("versionChangePlaceholder"))}"></textarea><div class="detail-regenerate-bar"><button class="action-btn primary detail-save-version" type="button" data-action="save-version">${t("saveAsVersion")}</button></div></div></section>`;
  }

  // Phase 4C：App/Web 原图能力集中判定——desktop-finder（Electron 注入 showItemInFolder 且
  // image_path 为有效非空路径）/ web-open（无桌面能力且 image_url 非空，真实 <a> 新标签页）/
  // unavailable（不渲染死按钮）。同一素材绝不同时表达两套入口；Web 不伪装 Finder 能力。
  function originalMediaCapability(asset) {
    const imagePath = String(asset?.image_path || "").trim();
    if (typeof window.electronAPI?.showItemInFolder === "function" && imagePath) return "desktop-finder";
    const imageUrl = String(asset?.image_url || "").trim();
    if (imageUrl) return "web-open";
    return "unavailable";
  }

  function originalMediaActionMarkup(asset) {
    const capability = originalMediaCapability(asset);
    if (capability === "desktop-finder") return `<button class="action-btn secondary" type="button" data-action="show-in-finder">${t("showInFinder")}</button>`;
    if (capability === "web-open") return `<a class="action-btn secondary original-media-link" href="${escapeHtml(asset.image_url)}" target="_blank" rel="noopener noreferrer">${t("openOriginal")}</a>`;
    return `<p class="empty-copy original-media-unavailable">${t("originalUnavailable")}</p>`;
  }

  // Phase 4C More 终态：显式原图入口默认可见（App「在 Finder 中显示」/ Web「打开原图」/
  // 「原图不可用」，三选一）+ 原生 details「更多操作」（regenerate / copy-path / 图片位置）+
  // 独立 danger 区（归档）。无省略号菜单、无 popover、无三点图标；copy-path 无路径不渲染。
  function detailMoreSectionMarkup(asset) {
    const imagePath = String(asset.image_path || "").trim();
    const copyPathAction = imagePath
      ? `<button class="action-btn secondary" type="button" data-action="copy-path">${t("copyPath")}</button>`
      : "";
    const locationValue = imagePath
      ? escapeHtml(asset.image_path)
      : `<span class="empty-copy">${t("notRecorded")}</span>`;
    return `<section class="inspector-section" data-inspector-section="more"><div class="section-head"><h4>${t("originalAndMore")}</h4></div><div class="original-media-action">${originalMediaActionMarkup(asset)}</div><details class="detail-disclosure" data-more-actions><summary>${t("moreActions")}</summary><div class="disclosure-content"><div class="detail-utility-actions"><button class="action-btn secondary" type="button" data-action="regenerate">${t("regenerate")}</button>${copyPathAction}</div><div class="more-location"><span class="meta-key">${t("imageLocation")}</span><div class="path-box detail-path-box">${locationValue}</div></div></div></details><div class="detail-danger-actions"><button class="action-btn danger" type="button" data-action="archive-asset">${t("batchArchive")}</button></div></section>`;
  }

  function versionHistoryMarkup(history, selectedId) {
    const versions = history?.versions || [];
    return `<ol class="version-timeline" aria-label="${escapeHtml(t("versionHistory"))}">${versions.map((version) => {
      const selected = version.id === selectedId;
      const depth = Math.min(Math.max(Number(version.version_depth) || 0, 0), 6);
      const change = version.version_change || (version.version_index === 1 ? t("initialVersion") : t("noVersionChange"));
      return `<li class="version-timeline-item version-depth-${depth}${selected ? " selected" : ""}"><button type="button" data-version-id="${escapeHtml(version.id)}"${selected ? ' aria-current="true"' : ""}><span class="version-marker" aria-hidden="true"></span><span class="version-content"><span class="version-title"><strong>${escapeHtml(t("versionLabel", { number: version.version_index }))}</strong>${selected ? `<span class="version-current">${t("currentVersion")}</span>` : ""}${version.archived ? `<span class="version-archived">${t("archivedVersion")}</span>` : ""}</span><span class="version-change">${escapeHtml(change)}</span><time datetime="${escapeHtml(version.created_at || "")}">${escapeHtml(formatDate(version.created_at))}</time></span></button></li>`;
    }).join("")}</ol>`;
  }

  function recipeHistoryDisclosureMarkup(history) {
    const content = history
      ? recipeHistoryMarkup(history)
      : `<p class="recipe-history-status" role="status">${t("recipeSnapshotLoading")}</p>`;
    // Phase 4A：单栏中完整历史默认不强行展开，按需披露（与版本历史 disclosure 一致）。
    return `<details class="detail-disclosure"><summary>${t("recipeSnapshotHistory")}</summary><div class="disclosure-content recipe-history-region" data-recipe-history aria-live="polite">${content}</div></details>`;
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

  function categoryOptions(selected) { return ["product", "concept", "texture", "reference", "other"].map((value) => `<option value="${value}"${selected === value ? " selected" : ""}>${t(`category${value[0].toUpperCase()}${value.slice(1)}`)}</option>`).join(""); }
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
    const title = asset.theme || asset.asset || asset.id;
    const url = mode === "detail" ? (asset.preview_url || asset.image_url) : (asset.thumbnail_url || asset.image_url);
    if (isVideoAsset(asset)) {
      if (mode === "detail") {
        return `<div class="detail-video-stack"><video class="detail-image detail-video" src="${escapeHtml(asset.image_url)}" controls playsinline preload="metadata" title="${escapeHtml(title)}">${escapeHtml(t("videoFallback"))}</video><p class="video-fallback-note">${escapeHtml(t("videoFallback"))} <a class="video-open-link" href="${escapeHtml(asset.image_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("openOriginalMedia"))}</a></p></div>`;
      }
      return `<span class="thumb video-thumb" aria-hidden="true"><video class="thumb-video" src="${escapeHtml(asset.image_url)}" muted playsinline preload="metadata"></video><span class="video-badge">▶</span></span>`;
    }
    if (mode === "detail") {
      return `<img class="detail-image" src="${escapeHtml(url)}" alt="${escapeHtml(title)}" title="${escapeHtml(t("viewFullImage"))}" />`;
    }
    return `<img class="thumb" src="${escapeHtml(url)}" alt="${escapeHtml(title)}" loading="lazy" />`;
  }

  return { fileDimensionsText, fileFormatText, fileSizeText, fileAspectRatioText, formatFileSize, fileFactRowMarkup, fileFactTagMarkup, detailFavoriteButtonMarkup, detailFileSectionMarkup, detailPromptSectionMarkup, editRecipeFieldsMarkup, detailSourceSectionMarkup, detailVersionSectionMarkup, versionPickerMarkup, versionOptionLabel, detailVersionSummaryMarkup, detailGroupSectionMarkup, detailTagsSectionMarkup, detailNewVersionSectionMarkup, originalMediaCapability, originalMediaActionMarkup, detailMoreSectionMarkup, versionHistoryMarkup, recipeHistoryDisclosureMarkup, referenceRightsSummary, recipeHistoryMarkup, categoryOptions, buildSourceRows, sourceName, sourceCopyValue, isVideoAsset, assetMediaPreviewMarkup };
}
