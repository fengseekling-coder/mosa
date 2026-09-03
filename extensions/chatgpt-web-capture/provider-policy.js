(function installMosaProviderPolicy(root) {
  const FLOW_PATH = /^\/(?:fx\/(?:(?:[a-z]{2,3}(?:-[a-z0-9]{2,8})?)\/)?tools\/)?flow(?:\/|$)/;
  const VIDEO_PROVIDERS = new Set(["flow", "google-ai-studio"]);

  function providerForPageUrl(value) {
    let url;
    try {
      url = new URL(String(value || ""));
    } catch {
      return "";
    }
    if (url.protocol !== "https:") return "";
    const host = url.hostname.toLowerCase();
    if (host === "chatgpt.com" || host === "chat.openai.com") return "chatgpt";
    if (host === "gemini.google.com") return "gemini";
    if (host === "aistudio.google.com") return "google-ai-studio";
    if (host === "labs.google" && FLOW_PATH.test(url.pathname.toLowerCase())) return "flow";
    return "";
  }

  function supportsVideo(provider) {
    return VIDEO_PROVIDERS.has(String(provider || "").trim().toLowerCase());
  }

  root.MosaProviderPolicy = Object.freeze({
    FLOW_PATH,
    providerForPageUrl,
    supportsVideo,
  });
})(globalThis);
