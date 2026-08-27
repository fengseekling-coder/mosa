// 叶子 helpers：纯函数或仅依赖 config/localStorage，app.js 只保留 import 与调用
//（REFACTORING-PLAN R1 批次 2）。
import { CARD_TITLE_MAX, GALLERY_DENSITIES, SORT_ORDERS } from "./config.mjs";

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

export function normalizeDensity(value) {
  return GALLERY_DENSITIES.includes(String(value || "")) ? String(value) : "image";
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

/**
 * Machine-generated facet values such as `black-white-minimal-concept` are hard
 * to scan in a long list. Only lowercase ASCII slugs are reworded; anything else
 * (hand-written collection names, CJK, mixed case) is shown exactly as stored,
 * and the stored value is always what gets sent back to the API.
 */
export function humanizeFacetValue(value) {
  const raw = String(value ?? "");
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(raw)) return raw;
  return raw.split(/[-_]/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
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
