import assert from "node:assert/strict";
import test from "node:test";
import translations from "../app/i18n.mjs";
import { createT } from "../app/i18n-runtime.mjs";

const FILE_MANAGER_KEYS = ["openedInFinder", "showInFinder", "shownInFinder", "showInFinderFailed", "openInFinder"];
const EXPLORER_KEYS = ["openedInFileExplorer", "showInFileExplorer", "shownInFileExplorer", "showInFileExplorerFailed", "openInFileExplorer"];
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

function withUserAgent(userAgent, run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { userAgent }, configurable: true });
  try {
    run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
  }
}

test("both locales carry Finder and File Explorer labels for every reveal action", () => {
  for (const locale of ["zh", "en"]) {
    for (const key of [...FILE_MANAGER_KEYS, ...EXPLORER_KEYS]) {
      assert.equal(typeof translations[locale][key], "string", `${locale}.${key} must exist`);
    }
  }
  for (const locale of ["zh", "en"]) {
    for (const key of EXPLORER_KEYS) {
      assert.doesNotMatch(translations[locale][key], /Finder/i, `${locale}.${key} must not mention Finder`);
    }
    assert.match(translations.zh.openInFileExplorer, /资源管理器/);
    assert.match(translations.en.openInFileExplorer, /Explorer/);
  }
});

test("t() resolves Explorer wording on Windows and Finder wording elsewhere", () => {
  withUserAgent(WINDOWS_UA, () => {
    const windowsT = createT({ getLocale: () => "zh" });
    assert.equal(windowsT("showInFinder"), "在文件资源管理器中显示");
    const windowsEnT = createT({ getLocale: () => "en" });
    assert.equal(windowsEnT("showInFinder"), "Show in File Explorer");
    assert.equal(windowsT("appTitle"), translations.zh.appTitle);
  });
  withUserAgent(MAC_UA, () => {
    const macT = createT({ getLocale: () => "zh" });
    assert.equal(macT("showInFinder"), "在 Finder 中显示");
  });
});

test("t() keeps its fallback contract on every platform", () => {
  withUserAgent(WINDOWS_UA, () => {
    const t = createT({ getLocale: () => "zh" });
    assert.equal(t("totally-unknown-key"), "totally-unknown-key");
    assert.equal(t("showInFinder", { unused: 1 }), "在文件资源管理器中显示");
  });
  withUserAgent(MAC_UA, () => {
    const t = createT({ getLocale: () => "zh" });
    assert.equal(t("totally-unknown-key"), "totally-unknown-key");
  });
});
