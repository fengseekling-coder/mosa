const DEFAULTS = {
  mosaBaseUrl: "http://127.0.0.1:43517",
  mosaToken: "",
  autoCapture: true,
};

const statusEl = document.getElementById("status");
const baseUrlEl = document.getElementById("mosaBaseUrl");
const tokenEl = document.getElementById("mosaToken");
const autoCaptureEl = document.getElementById("autoCapture");

async function load() {
  const response = await chrome.runtime.sendMessage({ type: "mosa.getSettings" });
  const settings = response?.ok ? response.settings : await chrome.storage.local.get(DEFAULTS);
  baseUrlEl.value = settings.mosaBaseUrl || DEFAULTS.mosaBaseUrl;
  tokenEl.value = settings.mosaToken || "";
  autoCaptureEl.checked = settings.autoCapture !== false;
}

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    mosaBaseUrl: baseUrlEl.value.trim() || DEFAULTS.mosaBaseUrl,
    mosaToken: tokenEl.value.trim(),
    autoCapture: autoCaptureEl.checked,
  });
  statusEl.textContent = "已保存。请刷新 ChatGPT 页面使内容脚本生效。";
});

document.getElementById("test").addEventListener("click", async () => {
  statusEl.textContent = "测试中…";
  const baseUrl = (baseUrlEl.value.trim() || DEFAULTS.mosaBaseUrl).replace(/\/+$/, "");
  try {
    const response = await fetch(`${baseUrl}/api/web-capture`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    statusEl.textContent = data.bridge?.enabled
      ? `连接成功：providers=${(data.bridge?.providers || []).join(",")}`
      : "已连接，但 Web Capture 未启用。请检查服务端 Token 与扩展来源白名单。";
  } catch (error) {
    statusEl.textContent = `连接失败：${error instanceof Error ? error.message : String(error)}`;
  }
});

load();
