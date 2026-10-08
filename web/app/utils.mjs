// 叶子 helpers：纯函数或仅依赖 config/localStorage，app.js 只保留 import 与调用
//（REFACTORING-PLAN R1 批次 2）。
import { CARD_TITLE_MAX, SORT_ORDERS } from "./config.mjs";

const LEADING_UI_GLYPH_TOKENS = new Set([
  "play_circle", "play_arrow", "pause_circle", "stop_circle",
  "more_vert", "more_horiz", "fullscreen_exit", "open_in_full",
  "download_for_offline", "file_download", "volume_up", "volume_off",
]);

export function displayAssetTitle(asset = {}) {
  const raw = String(asset.theme || asset.asset || asset.id || "").replace(/\s+/g, " ").trim();
  const parts = raw.split(" ");
  while (parts.length && LEADING_UI_GLYPH_TOKENS.has(parts[0].toLowerCase())) parts.shift();
  return parts.join(" ").trim() || raw;
}

export function normalizeSort(value) {
  return SORT_ORDERS.includes(String(value || "")) ? String(value) : "newest";
}

/**
 * Cards used to expose the whole prompt as their accessible name, which a screen
 * reader read out in full for every tile. The label is now a short title plus
 * source and date; the complete prompt stays in the detail panel.
 */
export function cardShortTitle(asset = {}) {
  const raw = displayAssetTitle(asset);
  if (raw.length <= CARD_TITLE_MAX) return raw;
  const clipped = raw.slice(0, CARD_TITLE_MAX);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > CARD_TITLE_MAX * 0.6 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

// Locale is passed in explicitly: these helpers stay free of the gallery's state.
export function formatDate(value, locale) {
  if (!value) return "";
  try { return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", { year: "numeric", month: "short", day: "numeric" }).format(new Date(value)); } catch { return String(value).slice(0, 10); }
}

export function formatDateTime(value, locale) {
  if (!value) return "";
  try { return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); } catch { return String(value); }
}

export function debounce(fn, delay) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); }; }

export function escapeHtml(value) { return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }

export function safeStorageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }

export function safeStorageSet(key, value) { try { localStorage.setItem(key, value); } catch {} }

// 任务 94：「移至回收站」确认框的「不再提醒」记忆（右键单张/多选、大图页删除
// 三处共用；整组堆叠移至回收站永远确认，不读这个键）。值 "off" = 不再提醒，
// 读不到或任何其他值都当作要提醒。
export const CONFIRM_MOVE_TO_TRASH_KEY = "mosa.confirm-move-to-trash";

export function moveToTrashConfirmSuppressed() {
  return safeStorageGet(CONFIRM_MOVE_TO_TRASH_KEY) === "off";
}

export function setMoveToTrashConfirmSuppressed(suppressed) {
  safeStorageSet(CONFIRM_MOVE_TO_TRASH_KEY, suppressed ? "off" : "on");
}

/**
 * 分组导出的 JSON 会离开本机，而接口返回的素材对象带着本机绝对路径
 * （image_path / source.path / cowart_project_dir 等，含用户名与目录结构）、
 * 只有本机服务能解析的 /library/... 链接，以及采集时记录的网页/媒体链接。
 * 删除只看字段名（*_path、*_url、*_dir、path、prompt_file）并递归处理嵌套
 * 对象与数组，绝不按“值像不像路径”判断——用户写的提示词、业务字段文字、
 * 标签即使以 / 开头也必须原样保留。asset（库内文件名）保留供对照。
 */
const EXPORT_REDACTED_KEY_SUFFIX = /(_path|_url|_dir)$/;
const EXPORT_REDACTED_KEYS = new Set(["path", "prompt_file"]);

export function sanitizeAssetForExport(value) {
  if (Array.isArray(value)) return value.map(sanitizeAssetForExport);
  if (!value || typeof value !== "object") return value;
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    if (EXPORT_REDACTED_KEY_SUFFIX.test(key) || EXPORT_REDACTED_KEYS.has(key)) continue;
    clean[key] = sanitizeAssetForExport(item);
  }
  return clean;
}
