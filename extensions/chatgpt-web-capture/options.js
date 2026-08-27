const DEFAULTS = {
  mosaBaseUrl: "http://127.0.0.1:43517",
  mosaToken: "",
  autoCapture: true,
};
const LEGACY_DEV_TOKEN = "mosa-web-capture-dev";

const statusEl = document.getElementById("status");
const baseUrlEl = document.getElementById("mosaBaseUrl");
const tokenEl = document.getElementById("mosaToken");
const autoCaptureEl = document.getElementById("autoCapture");

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("MOSA 地址无效。");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username || url.password) {
    throw new Error("MOSA 地址必须是 http://127.0.0.1:端口 或 http://localhost:端口。");
  }
  return url.origin;
}

async function load() {
  const response = await chrome.runtime.sendMessage({ type: "mosa.getSettings" });
  const settings = response?.ok ? response.settings : await chrome.storage.local.get(DEFAULTS);
  baseUrlEl.value = settings.mosaBaseUrl || DEFAULTS.mosaBaseUrl;
  tokenEl.value = settings.mosaToken || "";
  autoCaptureEl.checked = settings.autoCapture !== false;
}

document.getElementById("save").addEventListener("click", async () => {
  const token = tokenEl.value.trim();
  if (token === LEGACY_DEV_TOKEN) {
    setStatus("旧开发 Token 已失效。请填写与当前 MOSA 服务一致的新随机 Token。", "error");
    return;
  }
  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl(baseUrlEl.value.trim() || DEFAULTS.mosaBaseUrl);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
    return;
  }
  await chrome.storage.local.set({
    mosaBaseUrl: baseUrl,
    mosaToken: token,
    autoCapture: autoCaptureEl.checked,
  });
  setStatus("已保存。请刷新支持的网页使内容脚本生效。", "success");
});

document.getElementById("test").addEventListener("click", async () => {
  setStatus("测试中…", "success");
  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl(baseUrlEl.value.trim() || DEFAULTS.mosaBaseUrl);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
    return;
  }
  const token = tokenEl.value.trim();
  if (!token) {
    setStatus("请先填写 Ingest Token。", "error");
    return;
  }
  if (token === LEGACY_DEV_TOKEN) {
    setStatus("旧开发 Token 已失效。请填写与当前 MOSA 服务一致的新随机 Token。", "error");
    return;
  }
  try {
    // A deliberately incomplete ingest request exercises the real Bearer-token
    // path without writing an asset. A valid token reaches image validation.
    const response = await fetch(`${baseUrl}/api/ingest/web-capture`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ provider: "chatgpt", mimeType: "image/png", imageBase64: "" }),
    });
    const data = await response.json();
    if (response.status === 400 && data.code === "WEB_CAPTURE_BAD_IMAGE") {
      setStatus("连接和 Token 验证成功。", "success");
      return;
    }
    if (response.status === 401 && data.code === "WEB_CAPTURE_UNAUTHORIZED") {
      setStatus("Token 不匹配。请填写当前 MOSA 服务配置的 Token。", "error");
      return;
    }
    if (response.status === 403) {
      setStatus("扩展来源未获服务端批准。请检查 MOSA_WEB_CAPTURE_ORIGINS。", "error");
      return;
    }
    throw new Error(data.error || `HTTP ${response.status}`);
  } catch (error) {
    setStatus(`连接失败：${error instanceof Error ? error.message : String(error)}`, "error");
  }
});

function setStatus(message, kind) {
  statusEl.textContent = message;
  // F-21：错误用独立 alert 语义，其余恢复 polite status；颜色不作唯一表达。
  statusEl.setAttribute("role", kind === "error" ? "alert" : "status");
  statusEl.style.color = kind === "error" ? "var(--mosa-error)" : "var(--mosa-success)";
}

load();
