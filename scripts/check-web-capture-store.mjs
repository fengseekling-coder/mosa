import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MOSA_WEB_CAPTURE_STORE_EXTENSION_ID } from "../desktop/web-capture-pairing.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionDir = resolve(root, "extensions/chatgpt-web-capture");
const releaseMode = process.argv.includes("--release");
const storeId = String(process.env.MOSA_CHROME_STORE_EXTENSION_ID || MOSA_WEB_CAPTURE_STORE_EXTENSION_ID).trim();

const manifest = JSON.parse(await readFile(resolve(extensionDir, "manifest.json"), "utf8"));
const background = await readFile(resolve(extensionDir, "background.js"), "utf8");
const hook = await readFile(resolve(extensionDir, "page-hook.js"), "utf8");
const options = await readFile(resolve(extensionDir, "options.js"), "utf8");
const privacy = await readFile(resolve(root, "PRIVACY.md"), "utf8");

const failures = [];
const warnings = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

check(manifest.manifest_version === 3, "manifest_version must be 3");
check(typeof manifest.name === "string" && manifest.name.trim(), "manifest name is required");
check(typeof manifest.description === "string" && manifest.description.trim(), "manifest description is required");
check(/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(String(manifest.version || "")), "manifest version must be numeric");

const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
check(!permissions.includes("activeTab"), "unused activeTab permission must stay removed");
check(permissions.every((permission) => ["storage", "contextMenus"].includes(permission)), "unexpected extension permission requested");

const hosts = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];
check(!hosts.includes("<all_urls>"), "<all_urls> is not allowed");
check(!hosts.includes("https://*.openai.com/*"), "broad *.openai.com permission is not allowed");
check(!hosts.includes("https://*.oaistatic.com/*"), "oaistatic permission is not required");

check(/autoCapture:\s*false/.test(background), "new installs must default autoCapture to false");
check(/autoCapture:\s*false/.test(options), "options default must match background default");
check(/details\?\.reason === "install"/.test(background), "first install must surface the disclosure/settings page");
check(/set-capture-enabled/.test(hook), "page hook must support explicit capture enable/disable");
check(!/forwardedHeaders|rememberRequestHeaders|oai-device-id|oai-client-version|oai-language/i.test(hook), "page hook must not capture ChatGPT authentication headers");
check(/defaults automatic capture to off/i.test(privacy), "privacy policy must disclose opt-in automatic capture");
check(/does not read, copy, store, post, or replay ChatGPT Authorization headers/i.test(privacy), "privacy policy must describe the authentication-header boundary");

const declaredKey = String(manifest.key || "").trim();
if (!declaredKey) warnings.push("manifest.key is absent; unpacked builds may not keep the expected development extension ID");

if (releaseMode) {
  check(/^[a-p]{32}$/.test(storeId), "MOSA_CHROME_STORE_EXTENSION_ID must be set to the final 32-character Chrome Web Store ID");
  check(storeId === MOSA_WEB_CAPTURE_STORE_EXTENSION_ID, "Chrome Web Store ID must match the ID pinned in desktop/web-capture-pairing.mjs");
  const requiredAssets = [
    "store-assets/icon-128.png",
    "store-assets/screenshot-1.png",
  ];
  for (const relative of requiredAssets) {
    try {
      await access(resolve(extensionDir, relative));
    } catch {
      failures.push(`missing Chrome Web Store asset: ${relative}`);
    }
  }
}

if (warnings.length) {
  for (const warning of warnings) console.warn(`WARN: ${warning}`);
}
if (failures.length) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exitCode = 1;
} else {
  console.log(releaseMode
    ? "Chrome Web Store release preflight passed."
    : "Chrome Web Store code preflight passed.");
}
