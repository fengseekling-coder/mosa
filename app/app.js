// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  project: "default",
  projects: [],
  assets: [],
  selectedId: null,
  query: "",
  // 当前筛选
  filter: { type: "all", value: "" },
  groups: { total: 0, favorites: 0, recent: 0, codex: 0, groups: [], categories: [], styles: [] },
  libraryPath: "",
  codexImagesDir: ""
};

// ── Elements ───────────────────────────────────────────────────────────────────
const els = {
  projectSelect: document.querySelector("#projectSelect"),
  searchInput: document.querySelector("#searchInput"),
  libraryPathText: document.querySelector("#libraryPathText"),
  openFolderBtn: document.querySelector("#openFolderBtn"),
  quickFilters: document.querySelector("#quickFilters"),
  groupList: document.querySelector("#groupList"),
  categoryList: document.querySelector("#categoryList"),
  styleList: document.querySelector("#styleList"),
  addGroupBtn: document.querySelector("#addGroupBtn"),
  syncCowartBtn: document.querySelector("#syncCowartBtn"),
  newAssetBtn: document.querySelector("#newAssetBtn"),
  importModal: document.querySelector("#importModal"),
  closeImportModal: document.querySelector("#closeImportModal"),
  cancelImportBtn: document.querySelector("#cancelImportBtn"),
  imagePathInput: document.querySelector("#imagePathInput"),
  codexSourceHint: document.querySelector("#codexSourceHint"),
  promptInput: document.querySelector("#promptInput"),
  skillInput: document.querySelector("#skillInput"),
  styleInput: document.querySelector("#styleInput"),
  ratioInput: document.querySelector("#ratioInput"),
  themeInput: document.querySelector("#themeInput"),
  groupInput: document.querySelector("#groupInput"),
  categoryInput: document.querySelector("#categoryInput"),
  businessInput: document.querySelector("#businessInput"),
  saveAssetBtn: document.querySelector("#saveAssetBtn"),
  viewTitle: document.querySelector("#viewTitle"),
  assetCount: document.querySelector("#assetCount"),
  statusText: document.querySelector("#statusText"),
  assetGrid: document.querySelector("#assetGrid"),
  detailPanel: document.querySelector("#detailPanel"),
  demoFlow: document.querySelector("#demoFlow"),
  demoFlowProvenance: document.querySelector("#demoFlowProvenance"),
  toastContainer: document.querySelector("#toastContainer")
};

init();

async function init() {
  bindEvents();
  await loadProjects();
  await loadStats();
  await loadAssets();
  bindKeyboardNav();
}

// 键盘上下导航
function bindKeyboardNav() {
  document.addEventListener("keydown", (e) => {
    if (!state.assets.length) return;
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

    const currentIndex = state.assets.findIndex(a => a.id === state.selectedId);

    if (e.key === "ArrowUp" && currentIndex > 0) {
      state.selectedId = state.assets[currentIndex - 1].id;
      renderGrid();
      renderDetail();
      scrollToSelected();
    } else if (e.key === "ArrowDown" && currentIndex < state.assets.length - 1) {
      state.selectedId = state.assets[currentIndex + 1].id;
      renderGrid();
      renderDetail();
      scrollToSelected();
    }
  });
}

function scrollToSelected() {
  const selectedCard = els.assetGrid.querySelector(".asset-card.selected");
  if (selectedCard) {
    selectedCard.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

// ── Toast Notifications ───────────────────────────────────────────────────────
let _toastTimer = null;

function showToast(message, type = "default") {
  const container = els.toastContainer;
  if (!container) return;

  // Remove any existing toast
  const existing = container.querySelector(".toast");
  if (existing) existing.remove();
  if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }

  const iconSvg = type === "success"
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
    : type === "error"
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon ${type}">${iconSvg}</span>
    <span class="toast-text">${escapeHtml(message)}</span>
  `;
  container.appendChild(toast);

  _toastTimer = setTimeout(() => {
    toast.classList.add("fading");
    setTimeout(() => toast.remove(), 160);
  }, 2200);
}

// ── API ────────────────────────────────────────────────────────────────────────
async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (e) {
    // 非 JSON 响应，尝试提取错误信息
    if (!response.ok) throw new Error(response.statusText);
    return {};
  }
  if (!response.ok) throw new Error(payload.error || response.statusText);
  return payload;
}

async function loadProjects() {
  const result = await api("/api/projects");
  state.projects = result.projects;
  if (els.projectSelect) {
    els.projectSelect.innerHTML = state.projects
      .map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`)
      .join("");
    els.projectSelect.value = state.project;
  }
}

async function loadStats() {
  // Load library path
  try {
    const p = await api(`/api/library-path?project=${encodeURIComponent(state.project)}`);
    state.libraryPath = p.path;
    state.codexImagesDir = p.codexGeneratedImagesDir || "";
    els.libraryPathText.textContent = p.path;
    if (state.codexImagesDir && els.imagePathInput) {
      els.imagePathInput.placeholder = `${state.codexImagesDir}/<task-id>/<image>.png`;
    }
    if (state.codexImagesDir && els.codexSourceHint) {
      els.codexSourceHint.textContent = `默认读取 Codex 生图目录：${state.codexImagesDir}`;
    }
  } catch {
    els.libraryPathText.textContent = "—";
  }

  // Build stats client-side from the full unfiltered asset list
  const result = await api(`/api/assets?project=${encodeURIComponent(state.project)}`);
  const assets = result.assets || [];
  const now = Date.now();
  const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;

  const groupMap = new Map();
  const categoryMap = new Map();
  const styleMap = new Map();
  let favorites = 0;
  let recent = 0;
  let codex = 0;

  for (const a of assets) {
    // 收藏：rating > 0 或 favorite 标记为 true
    if (a.rating > 0 || a.favorite) favorites++;
    if (a.created_at) {
      const age = now - new Date(a.created_at).getTime();
      if (age < ONE_WEEK) recent++;
    }
    if (a.source?.type === "codex-generated") codex++;
    if (a.group)  groupMap.set(a.group,    (groupMap.get(a.group)    || 0) + 1);
    if (a.category) categoryMap.set(a.category, (categoryMap.get(a.category) || 0) + 1);
    if (a.style)  styleMap.set(a.style,    (styleMap.get(a.style)    || 0) + 1);
  }

  state.groups = {
    total: assets.length,
    favorites,
    recent,
    codex,
    groups:    [...groupMap.entries()].sort((a, b) => b[1] - a[1]),
    categories: [...categoryMap.entries()].sort((a, b) => b[1] - a[1]),
    styles:    [...styleMap.entries()].sort((a, b) => b[1] - a[1])
  };

  renderQuickFilters();
  renderGroupList();
  renderCategoryList();
  renderStyleList();
}

async function loadAssets() {
  const params = new URLSearchParams({ project: state.project, q: state.query });

  if (state.filter.type === "favorite") params.set("favorite", "1");
  else if (state.filter.type === "recent") params.set("recent", "1");
  else if (state.filter.type === "codex") params.set("source", "codex-generated");
  else if (state.filter.type === "group") params.set("group", state.filter.value);
  else if (state.filter.type === "category") params.set("category", state.filter.value);
  else if (state.filter.type === "style") params.set("style", state.filter.value);

  const result = await api(`/api/assets?${params}`);
  state.assets = result.assets;
  renderGrid();
  renderDetail();
  updateViewTitle();
}

function updateViewTitle() {
  const titles = {
    all: "全部",
    favorite: "收藏",
    recent: "最近一周",
    codex: "Codex 生成",
    group: state.filter.value,
    category: state.filter.value,
    style: state.filter.value
  };
  els.viewTitle.textContent = titles[state.filter.type] || state.filter.value;
  els.assetCount.textContent = `${state.assets.length} assets`;
}

// ── Events ─────────────────────────────────────────────────────────────────────
function bindEvents() {
  if (els.projectSelect) {
    els.projectSelect.addEventListener("change", async () => {
      state.project = els.projectSelect.value;
      state.selectedId = null;
      state.filter = { type: "all", value: "" };
      await loadStats();
      await loadAssets();
    });
  }

  if (els.searchInput) {
    els.searchInput.addEventListener("input", debounce(async () => {
      state.query = els.searchInput.value;
      await loadAssets();
    }, 180));
  }

  if (els.openFolderBtn) {
    els.openFolderBtn.addEventListener("click", async () => {
      if (!state.libraryPath) return;
      try {
        await api("/api/open-folder", { method: "POST", body: { path: state.libraryPath } });
        showToast("已在 Finder 中打开", "success");
      } catch (e) {
        showToast("打开失败: " + e.message, "error");
      }
    });
  }

  if (els.quickFilters) {
    els.quickFilters.addEventListener("click", e => {
      const li = e.target.closest(".nav-item");
      if (!li || !li.dataset.filter) return;
      state.filter = { type: li.dataset.filter, value: "" };
      state.selectedId = null;
      renderQuickFilters();
      loadAssets();
    });
  }

  if (els.groupList) {
    els.groupList.addEventListener("click", e => {
      const li = e.target.closest(".nav-item[data-group]");
      if (!li) return;
      state.filter = { type: "group", value: li.dataset.group };
      state.selectedId = null;
      renderGroupList();
      loadAssets();
    });
  }

  if (els.addGroupBtn) {
    els.addGroupBtn.addEventListener("click", () => {
      const existing = els.groupList.querySelector(".nav-item[data-new]");
      if (existing) return;
      const input = document.createElement("input");
      input.className = "new-group-input";
      input.placeholder = "分组名，回车确认";
      input.addEventListener("keydown", async (e) => {
        if (e.key === "Enter") {
          const val = input.value.trim();
          if (val) await assignGroupToSelected(val);
          renderGroupList();
        }
        if (e.key === "Escape") renderGroupList();
      });
      input.addEventListener("blur", () => renderGroupList());
      const item = document.createElement("li");
      item.className = "nav-item";
      item.dataset.new = "1";
      item.appendChild(input);
      els.groupList.prepend(item);
      input.focus();
    });
  }

  if (els.categoryList) {
    els.categoryList.addEventListener("click", e => {
      const li = e.target.closest(".nav-item[data-category]");
      if (!li) return;
      state.filter = { type: "category", value: li.dataset.category };
      state.selectedId = null;
      renderCategoryList();
      loadAssets();
    });
  }

  if (els.styleList) {
    els.styleList.addEventListener("click", e => {
      const li = e.target.closest(".nav-item[data-style]");
      if (!li) return;
      state.filter = { type: "style", value: li.dataset.style };
      state.selectedId = null;
      renderStyleList();
      loadAssets();
    });
  }

  if (els.syncCowartBtn) {
    els.syncCowartBtn.addEventListener("click", async () => {
      await runAction(async () => {
        showToast("同步 Cowart 中...");
        const result = await api("/api/assets/sync-cowart", { method: "POST", body: { projectId: state.project } });
        showToast(`导入 ${result.imported.length}，跳过 ${result.skipped.length}`, "success");
        await loadStats();
        await loadAssets();
      });
    });
  }

  if (els.newAssetBtn) {
    els.newAssetBtn.addEventListener("click", () => {
      if (els.importModal) els.importModal.classList.add("open");
    });
  }

  if (els.closeImportModal) {
    els.closeImportModal.addEventListener("click", () => {
      if (els.importModal) els.importModal.classList.remove("open");
    });
  }

  if (els.cancelImportBtn) {
    els.cancelImportBtn.addEventListener("click", () => {
      if (els.importModal) els.importModal.classList.remove("open");
    });
  }

  // Close modal on overlay click
  if (els.importModal) {
    els.importModal.addEventListener("click", (e) => {
      if (e.target === els.importModal) els.importModal.classList.remove("open");
    });
  }

  if (els.saveAssetBtn) {
    els.saveAssetBtn.addEventListener("click", async () => {
      await runAction(async () => {
        // 验证必填字段
        if (!els.imagePathInput.value.trim()) {
          throw new Error("请填写图片路径");
        }
        showToast("保存素材中...");
        let businessFields = {};
        if (els.businessInput.value.trim()) {
          try { businessFields = JSON.parse(els.businessInput.value); }
          catch { throw new Error("Business Fields JSON 格式错误"); }
        }
        const result = await api("/api/assets/create", {
          method: "POST",
          body: {
            projectId: state.project,
            imagePath: els.imagePathInput.value,
            prompt: els.promptInput.value,
            skill: els.skillInput.value,
            style: els.styleInput.value,
            ratio: els.ratioInput.value,
            theme: els.themeInput.value,
            group: els.groupInput.value,
            category: els.categoryInput.value,
            business_fields: businessFields
          }
        });
        state.selectedId = result.asset.id;
        showToast(`已保存 ${result.asset.id}`, "success");
        if (els.importModal) {
          els.importModal.classList.remove("open");
          // Clear form
          els.imagePathInput.value = "";
          els.promptInput.value = "";
          els.skillInput.value = "";
          els.styleInput.value = "";
          els.ratioInput.value = "";
          els.themeInput.value = "";
          els.groupInput.value = "";
          els.categoryInput.value = "";
          els.businessInput.value = "";
        }
        await loadStats();
        await loadAssets();
      });
    });
  }
}

// ── Sidebar Rendering ──────────────────────────────────────────────────────────
function renderQuickFilters() {
  els.quickFilters.querySelectorAll(".nav-item").forEach(li => {
    li.classList.toggle("active", li.dataset.filter === state.filter.type);
  });
  const s = state.groups;
  els.quickFilters.querySelector("[data-filter=all] .nav-count").textContent = s.total;
  els.quickFilters.querySelector("[data-filter=favorite] .nav-count").textContent = s.favorites;
  els.quickFilters.querySelector("[data-filter=recent] .nav-count").textContent = s.recent;
  els.quickFilters.querySelector("[data-filter=codex] .nav-count").textContent = s.codex;
}

function renderGroupList() {
  if (state.groups.groups.length === 0) {
    els.groupList.innerHTML = `<li class="nav-empty">暂无分组</li>`;
    return;
  }
  els.groupList.innerHTML = state.groups.groups.map(([name, count]) => {
    const active = state.filter.type === "group" && state.filter.value === name;
    return `<li class="nav-item${active ? " active" : ""}" data-group="${escapeHtml(name)}">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      </svg>
      <span class="nav-item-text">${escapeHtml(name)}</span>
      <span class="nav-count">${count}</span>
    </li>`;
  }).join("");
}

function renderCategoryList() {
  if (state.groups.categories.length === 0) {
    els.categoryList.innerHTML = `<li class="nav-empty">暂无分类</li>`;
    return;
  }
  els.categoryList.innerHTML = state.groups.categories.map(([name, count]) => {
    const active = state.filter.type === "category" && state.filter.value === name;
    return `<li class="nav-item${active ? " active" : ""}" data-category="${escapeHtml(name)}">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
        <line x1="7" y1="7" x2="7.01" y2="7"/>
      </svg>
      <span class="nav-item-text">${escapeHtml(name)}</span>
      <span class="nav-count">${count}</span>
    </li>`;
  }).join("");
}

function renderStyleList() {
  if (state.groups.styles.length === 0) {
    els.styleList.innerHTML = `<li class="nav-empty">暂无</li>`;
    return;
  }
  els.styleList.innerHTML = state.groups.styles.map(([name, count]) => {
    const active = state.filter.type === "style" && state.filter.value === name;
    return `<li class="nav-item${active ? " active" : ""}" data-style="${escapeHtml(name)}">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="13.5" cy="6.5" r="0.5" fill="currentColor"/>
        <circle cx="17.5" cy="10.5" r="0.5" fill="currentColor"/>
        <circle cx="8.5" cy="7.5" r="0.5" fill="currentColor"/>
        <circle cx="6.5" cy="12.5" r="0.5" fill="currentColor"/>
        <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>
      </svg>
      <span class="nav-item-text">${escapeHtml(name)}</span>
      <span class="nav-count">${count}</span>
    </li>`;
  }).join("");
}

// ── Grid Rendering ─────────────────────────────────────────────────────────────
function renderGrid() {
  if (state.assets.length === 0) {
    els.assetGrid.innerHTML = `
      <div class="empty-state">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
        <p>没有素材</p>
        <span>点「同步 Cowart 图片」开始导入</span>
      </div>`;
    return;
  }

  els.assetGrid.innerHTML = state.assets.map(asset => {
    const title = asset.theme || asset.asset || asset.id;
    const isCodexAsset = asset.source?.type === "codex-generated";
    return `<article class="asset-card${asset.id === state.selectedId ? " selected" : ""}" data-id="${escapeHtml(asset.id)}">
      <img class="thumb" src="${asset.image_url}" alt="${escapeHtml(title)}" loading="lazy" />
      ${isCodexAsset ? '<span class="asset-source-badge">Codex</span>' : ""}
      <div class="card-overlay">
        <div class="card-overlay-title">${escapeHtml(title)}</div>
        <button class="card-quick-copy" data-copy="${escapeHtml(asset.prompt || "")}" title="复制 prompt">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
        </button>
      </div>
    </article>`;
  }).join("");

  els.assetGrid.querySelectorAll(".asset-card").forEach(card => {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".card-quick-copy")) return;
      state.selectedId = card.dataset.id;
      renderGrid();
      renderDetail();
    });
  });

  // Quick-copy button: copy prompt
  els.assetGrid.querySelectorAll(".card-quick-copy").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const prompt = btn.dataset.copy || "";
      navigator.clipboard.writeText(prompt).then(() => {
        showToast("Prompt 已复制", "success");
      });
    });
  });
}

// ── Detail Panel ───────────────────────────────────────────────────────────────
function renderDetail() {
  // 如果没有素材或没有选中项，显示空状态
  if (!state.assets || state.assets.length === 0) {
    renderDemoFlow(null);
    els.detailPanel.innerHTML = `
      <div class="detail-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
        <p>没有素材</p>
        <span>点击「导入图片」开始添加</span>
      </div>`;
    return;
  }

  const asset = state.assets.find(a => a.id === state.selectedId) || state.assets[0];
  if (!asset) {
    renderDemoFlow(null);
    els.detailPanel.innerHTML = `
      <div class="detail-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
        <p>选择一张图片查看配方</p>
        <span>Click any asset in the grid</span>
      </div>`;
    return;
  }

  state.selectedId = asset.id;
  // 确保 rating 在 0-5 范围内
  const rating = Math.min(5, Math.max(0, Math.round(asset.rating || 0)));
  const stars = "★".repeat(rating) + "☆".repeat(5 - rating);

  // Build metadata rows
  const metaRows = [
    { key: "Skill",     val: asset.skill,     chip: true },
    { key: "Style",     val: asset.style,     chip: true },
    { key: "Ratio",     val: asset.ratio,     chip: false },
    { key: "Theme",     val: asset.theme,     chip: false },
    { key: "Group",     val: asset.group,     chip: true },
    { key: "Category",  val: asset.category,  chip: true },
    { key: "Rating",    val: asset.rating ? `${asset.rating}/5` : null, chip: false, stars: true },
  ].filter(row => row.val !== undefined && row.val !== null && row.val !== "");

  const metaTableHtml = metaRows.map(row => {
    if (row.stars) {
      return `<div class="meta-row">
        <span class="meta-key">${escapeHtml(row.key)}</span>
        <span class="meta-val">
          <span class="rating-stars">${stars}</span>
        </span>
      </div>`;
    }
    if (row.chip && row.val) {
      return `<div class="meta-row">
        <span class="meta-key">${escapeHtml(row.key)}</span>
        <span class="meta-val chip-inline"><span class="chip">${escapeHtml(row.val)}</span></span>
      </div>`;
    }
    return `<div class="meta-row">
      <span class="meta-key">${escapeHtml(row.key)}</span>
      <span class="meta-val">${escapeHtml(row.val)}</span>
    </div>`;
  }).join("");

  // Always show empty-state placeholders for unset fields
  const alwaysShow = [
    { key: "Skill",    val: asset.skill,    chip: true },
    { key: "Style",    val: asset.style,    chip: true },
    { key: "Ratio",    val: asset.ratio,    chip: false },
    { key: "Theme",    val: asset.theme,    chip: false },
    { key: "Group",    val: asset.group,    chip: true },
    { key: "Category", val: asset.category, chip: true },
  ];
  const filledKeys = new Set(alwaysShow.filter(r => r.val).map(r => r.key));
  const missingRows = alwaysShow
    .filter(r => !r.val)
    .map(row => `<div class="meta-row">
      <span class="meta-key">${escapeHtml(row.key)}</span>
      <span class="meta-val empty">—</span>
    </div>`)
    .join("");

  const fullMetaHtml = metaTableHtml + missingRows;

  // Business fields
  const bizFields = asset.business_fields || {};
  const hasBizFields = Object.keys(bizFields).length > 0;
  const bizHtml = hasBizFields
    ? `<div class="biz-fields-box">${escapeHtml(JSON.stringify(bizFields, null, 2))}</div>`
    : `<div class="biz-fields-box" style="color:var(--ink-3);font-style:italic">暂无业务字段</div>`;

  const source = asset.source || {};
  const isCodexAsset = source.type === "codex-generated";
  const sourceRows = (isCodexAsset
    ? [
        ["类型", source.type],
        ["任务 ID", source.codex_task_id],
        ["模型", source.model],
        ["生成工具", source.generation_tool],
        ["原始路径", source.path]
      ]
    : [
        ["Type", source.type],
        ["Original path", source.path],
        ["Codex task", source.codex_task_id],
        ["Tool", source.generation_tool],
        ["Model", source.model]
      ])
    .filter(([, value]) => value !== undefined && value !== null && value !== "");
  const sourceHtml = sourceRows.length
    ? `<div class="meta-table">${sourceRows.map(([key, value]) => `<div class="meta-row"><span class="meta-key">${escapeHtml(key)}</span><span class="meta-val source-value">${escapeHtml(value)}</span></div>`).join("")}</div>`
    : `<div class="biz-fields-box" style="color:var(--ink-3);font-style:italic">暂无来源信息</div>`;
  const codexOriginalPath = isCodexAsset ? formatCodexOriginalPath(source) : "";

  // Rating editor - 使用安全的 rating 值
  const safeRating = Math.min(5, Math.max(0, Math.round(asset.rating || 0)));
  const ratingEditorHtml = [1,2,3,4,5].map(n =>
    `<button type="button" data-val="${n}" class="${n <= safeRating ? "on" : ""}">${n <= safeRating ? "★" : "☆"}</button>`
  ).join("");

  // Group datalist
  const groupDatalist = state.groups.groups.map(([n]) => `<option value="${escapeHtml(n)}">`).join("");

  els.detailPanel.innerHTML = `
    <div class="detail-image-wrap">
      <img class="detail-image" src="${asset.image_url}" alt="${escapeHtml(asset.theme || asset.id)}" />
    </div>
    <div class="detail-head">
      <h3>${escapeHtml(asset.theme || asset.asset || asset.id)}</h3>
      <div class="detail-meta">${escapeHtml(asset.id)} · ${escapeHtml(asset.created_at || "").slice(0, 10)}</div>
    </div>

    <!-- Action bar -->
    <div class="detail-actions">
      <button class="action-btn primary" data-action="copy-prompt">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
        复制 Prompt
      </button>
      <button class="action-btn secondary" data-action="copy-path">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
        复制路径
      </button>
      <button class="action-btn secondary" data-action="insert-canvas">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <line x1="3" y1="9" x2="21" y2="9"/>
          <line x1="9" y1="21" x2="9" y2="9"/>
        </svg>
        放到画布
        <select class="placement-select" data-placement style="margin-left:4px;font-size:10px;height:20px;width:56px;border:1px solid var(--border);border-radius:4px;background:var(--surface);">
          <option value="right">右</option>
          <option value="below">下</option>
          <option value="center">中</option>
        </select>
      </button>
      <button class="action-btn secondary" data-action="regenerate">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
        </svg>
        同配方再生成
      </button>
    </div>

    <!-- Prompt -->
    <div class="section">
      <div class="section-head">
        <h4>Prompt</h4>
      </div>
      <div class="prompt-box">${asset.prompt ? escapeHtml(asset.prompt) : '<span style="color:var(--ink-3);font-style:italic">未记录 prompt</span>'}</div>
    </div>

    <!-- Metadata table -->
    <div class="section">
      <div class="section-head">
        <h4>Recipe</h4>
      </div>
      <div class="meta-table">${fullMetaHtml}</div>
    </div>

    <!-- Business fields -->
    <div class="section">
      <div class="section-head">
        <h4>Business Fields</h4>
      </div>
      ${bizHtml}
    </div>

    <div class="section">
      <div class="section-head">
        <h4>Source</h4>
        ${isCodexAsset && codexOriginalPath ? '<button class="source-copy-btn" type="button" data-action="copy-codex-path">复制 Codex 原始路径</button>' : ""}
      </div>
      ${sourceHtml}
    </div>

    <!-- Edit form -->
    <div class="section">
      <div class="section-head">
        <h4>编辑配方</h4>
      </div>
      <div class="detail-fields">
        <label class="field">
          <span>Prompt</span>
          <textarea data-edit="prompt" rows="5">${escapeHtml(asset.prompt || "")}</textarea>
        </label>
        <div class="two">
          <label class="field">
            <span>Skill</span>
            <input data-edit="skill" value="${escapeHtml(asset.skill || "")}" />
          </label>
          <label class="field">
            <span>Style</span>
            <input data-edit="style" value="${escapeHtml(asset.style || "")}" />
          </label>
        </div>
        <div class="two">
          <label class="field">
            <span>Ratio</span>
            <input data-edit="ratio" value="${escapeHtml(asset.ratio || "")}" />
          </label>
          <label class="field">
            <span>Theme</span>
            <input data-edit="theme" value="${escapeHtml(asset.theme || "")}" />
          </label>
        </div>
        <div class="two">
          <label class="field">
            <span>Group</span>
            <input data-edit="group" value="${escapeHtml(asset.group || "")}" list="groupSuggestionsEdit" placeholder="点击设为分组" />
            <datalist id="groupSuggestionsEdit">${groupDatalist}</datalist>
          </label>
          <label class="field">
            <span>Category</span>
            <select data-edit="category">
              <option value="">—</option>
              ${["product","concept","texture","reference","other"].map(c =>
                `<option value="${c}"${asset.category === c ? " selected" : ""}>${c}</option>`
              ).join("")}
            </select>
          </label>
        </div>
        <div class="field">
          <span>Rating</span>
          <div class="rating-edit" data-edit="rating">
            ${ratingEditorHtml}
          </div>
        </div>
        <label class="field">
          <span>Business Fields JSON</span>
          <textarea data-edit="business_fields" rows="3">${escapeHtml(JSON.stringify(asset.business_fields || {}, null, 2))}</textarea>
        </label>
        <button class="save-recipe-btn" data-action="save-recipe">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
            <polyline points="17 21 17 13 7 13 7 21"/>
            <polyline points="7 3 7 8 15 8"/>
          </svg>
          保存配方
        </button>
      </div>
    </div>

    <!-- Image path -->
    <div class="section">
      <div class="section-head">
        <h4>Image Path</h4>
      </div>
      <div class="path-box">${escapeHtml(asset.image_path)}</div>
    </div>
  `;

  bindDetailEvents(asset);
  renderDemoFlow(asset);
}

function bindDetailEvents(asset) {
  const panel = els.detailPanel;

  panel.querySelector('[data-action="copy-prompt"]').addEventListener("click", async () => {
    await runAction(async () => {
      await navigator.clipboard.writeText(asset.prompt || "");
      showToast("Prompt 已复制", "success");
    });
  });

  panel.querySelector('[data-action="copy-path"]').addEventListener("click", async () => {
    await runAction(async () => {
      await navigator.clipboard.writeText(asset.image_path);
      showToast("图片路径已复制", "success");
    });
  });

  const copyCodexPathButton = panel.querySelector('[data-action="copy-codex-path"]');
  if (copyCodexPathButton) {
    copyCodexPathButton.addEventListener("click", async () => {
      await runAction(async () => {
        await navigator.clipboard.writeText(formatCodexOriginalPath(asset.source));
        showToast("Codex 原始路径已复制", "success");
      });
    });
  }

  panel.querySelector('[data-action="insert-canvas"]').addEventListener("click", async (e) => {
    await runAction(async () => {
      // 获取选中的位置
      const placementSelect = e.currentTarget.querySelector('[data-placement]');
      const placement = placementSelect ? placementSelect.value : "right";
      showToast("插入画布中...");
      const result = await api("/api/assets/canvas-insert", {
        method: "POST",
        body: { projectId: asset.project_id, assetId: asset.id, placement }
      });
      showToast(`已放到画布：${result.canvas.shapeId}`, "success");
    });
  });

  panel.querySelector('[data-action="regenerate"]').addEventListener("click", async () => {
    await runAction(async () => {
      const instruction = [
        "请用同配方再生成一版图片，并保存到 GPT Asset Manager：",
        "",
        `asset_id: ${asset.id}`,
        `skill: ${asset.skill}`,
        `style: ${asset.style}`,
        `ratio: ${asset.ratio}`,
        `theme: ${asset.theme}`,
        `group: ${asset.group}`,
        `category: ${asset.category}`,
        `business_fields: ${JSON.stringify(asset.business_fields || {})}`,
        "",
        asset.prompt || ""
      ].join("\n");
      await navigator.clipboard.writeText(instruction);
      showToast("再生成指令已复制", "success");
    });
  });

  // Rating editor
  panel.querySelectorAll('[data-edit="rating"] button').forEach(btn => {
    btn.addEventListener("click", () => {
      const val = parseInt(btn.dataset.val, 10);
      panel.querySelectorAll('[data-edit="rating"] button').forEach(b => {
        b.classList.toggle("on", parseInt(b.dataset.val, 10) <= val);
        b.textContent = parseInt(b.dataset.val, 10) <= val ? "★" : "☆";
      });
    });
  });

  // Save recipe
  panel.querySelector('[data-action="save-recipe"]').addEventListener("click", async () => {
    await runAction(async () => {
      const ratingVal = [...panel.querySelectorAll('[data-edit="rating"] button.on')].length;
      const businessText = panel.querySelector('[data-edit="business_fields"]').value;
      const patch = {
        prompt: panel.querySelector('[data-edit="prompt"]').value,
        skill: panel.querySelector('[data-edit="skill"]').value,
        style: panel.querySelector('[data-edit="style"]').value,
        ratio: panel.querySelector('[data-edit="ratio"]').value,
        theme: panel.querySelector('[data-edit="theme"]').value,
        group: panel.querySelector('[data-edit="group"]').value,
        category: panel.querySelector('[data-edit="category"]').value,
        rating: ratingVal,
        business_fields: businessText.trim() ? JSON.parse(businessText) : {}
      };
      const result = await api(
        `/api/assets/${encodeURIComponent(asset.project_id)}/${encodeURIComponent(asset.id)}`,
        { method: "PATCH", body: patch }
      );
      state.selectedId = result.asset.id;
      showToast("配方已保存", "success");
      await loadStats();
      await loadAssets();
    });
  });
}

// ── Group Assignment ───────────────────────────────────────────────────────────
async function assignGroupToSelected(groupName) {
  const asset = state.assets.find(a => a.id === state.selectedId);
  if (!asset) return;
  try {
    await api(
      `/api/assets/${encodeURIComponent(asset.project_id)}/${encodeURIComponent(asset.id)}`,
      { method: "PATCH", body: { group: groupName } }
    );
    await loadStats();
    await loadAssets();
    showToast(`已设为分组: ${groupName}`, "success");
  } catch (e) {
    showToast("设置分组失败: " + e.message, "error");
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────────
function setStatus(text) {
  if (els.statusText) els.statusText.textContent = text;
}

async function runAction(fn) {
  try {
    await fn();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function renderDemoFlow(asset) {
  if (!els.demoFlow || !els.demoFlowProvenance) return;

  const source = asset?.source || {};
  const isCodexAsset = source.type === "codex-generated";
  els.demoFlow.classList.toggle("is-codex-selected", isCodexAsset);
  els.demoFlow.querySelectorAll("[data-demo-step]").forEach((step) => {
    const stepNumber = Number(step.dataset.demoStep);
    step.classList.toggle("is-highlighted", isCodexAsset && stepNumber >= 2);
  });

  if (!isCodexAsset) {
    els.demoFlowProvenance.textContent = "选择 Codex 素材，查看 MCP 自动归档的来源信息。";
    return;
  }

  const provenance = [
    source.codex_task_id ? `任务 ${source.codex_task_id}` : "任务 ID 未记录",
    source.model || "模型未记录",
    source.generation_tool || "生成工具未记录"
  ];
  els.demoFlowProvenance.textContent = `已选中 Codex 素材：${provenance.join(" · ")}。MCP 已自动归档，可搜索、查看 Prompt 并复用。`;
}

function formatCodexOriginalPath(source = {}) {
  const relativePath = String(source.codex_relative_path || "").replace(/^\/+/, "");
  if (relativePath) return `~/.codex/generated_images/${relativePath}`;

  const originalPath = String(source.path || "");
  const generatedRoot = String(source.codex_generated_images_root || state.codexImagesDir || "").replace(/\/+$/, "");
  if (generatedRoot && originalPath.startsWith(`${generatedRoot}/`)) {
    return `~/.codex/generated_images/${originalPath.slice(generatedRoot.length + 1)}`;
  }

  return originalPath.replace(
    /^(?:\/Users\/[^/]+|\/home\/[^/]+)\/\.codex\/generated_images\//,
    "~/.codex/generated_images/"
  );
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
