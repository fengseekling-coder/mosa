// i18n 运行时（提取自 app.js，REFACTORING-PLAN R1 批次 3）：
// resolveLocale / t / applyLanguage 原先在 app.js 内联定义；这里保持完全相同的
// 行为与时序，把 app.js 依赖（state、translations、UI 重渲染链）经工厂参数注入。
// t 保持 (key, variables) 签名，全部既有调用点不变。
import translations from "./i18n.mjs";

export function resolveLocale(value) {
  if (value === "zh" || value === "en") return value;
  return /^zh/i.test(navigator.language || "") ? "zh" : "en";
}

export function createT({ getLocale }) {
  return function t(key, variables = {}) {
    const template = translations[getLocale()]?.[key] ?? translations.en[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (_, name) => String(variables[name] ?? ""));
  };
}

export function createLanguageApplier({ state, t, refreshUI }) {
  return function applyLanguage() {
    state.locale = resolveLocale(state.languagePreference);
    document.documentElement.lang = state.locale === "zh" ? "zh-CN" : "en";
    document.title = t("appTitle");
    document.querySelectorAll("[data-i18n]").forEach((node) => { node.textContent = t(node.dataset.i18n); });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => { node.placeholder = t(node.dataset.i18nPlaceholder); });
    document.querySelectorAll("[data-i18n-aria-label]").forEach((node) => { node.setAttribute("aria-label", t(node.dataset.i18nAriaLabel)); });
    document.querySelectorAll("[data-i18n-title]").forEach((node) => { node.title = t(node.dataset.i18nTitle); });
    refreshUI();
  };
}
