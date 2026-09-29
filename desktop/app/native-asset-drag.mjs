import { pointOutsideWindow } from "./drag-gesture.mjs";

function uniquePathsForIds(state, ids) {
  const assetsById = new Map((state?.assets || []).map((asset) => [asset?.id, asset]));
  const paths = [];
  const seen = new Set();
  for (const id of ids) {
    const path = String(assetsById.get(id)?.image_path || "").trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

export function createNativeAssetDrag({ els, state, showToast, t }) {
  let candidate = null;
  let nativeDragInFlight = false;

  function supported() {
    return typeof window !== "undefined" && typeof window.electronAPI?.startNativeDrag === "function";
  }

  function clearCandidate() {
    candidate = null;
  }

  function begin(drag) {
    if (!supported()) return false;
    const assetIds = Array.isArray(drag?.assetIds) ? drag.assetIds.filter(Boolean) : [];
    const paths = uniquePathsForIds(state, assetIds);
    if (!paths.length) return false;
    clearCandidate();
    candidate = { assetIds: [...assetIds], paths };
    return true;
  }

  function startIfOutside(event) {
    if (!candidate || nativeDragInFlight || !supported()) return false;
    if (!pointOutsideWindow(event, window)) return false;
    const paths = [...candidate.paths];
    clearCandidate();
    if (!paths.length) {
      showToast?.(t("nativeDragUnavailable"), "error");
      return false;
    }
    nativeDragInFlight = true;
    Promise.resolve(window.electronAPI.startNativeDrag(paths))
      .then((result) => {
        if (result?.ok === false) showToast?.(t("nativeDragUnavailable"), "error");
      })
      .catch(() => showToast?.(t("nativeDragUnavailable"), "error"))
      .finally(() => { nativeDragInFlight = false; });
    return true;
  }

  function bind() {
    if (!els.assetGrid) return;
    window.addEventListener("pointerup", clearCandidate, { capture: true });
    window.addEventListener("pointercancel", clearCandidate, { capture: true });
    window.addEventListener("blur", clearCandidate);
  }

  return { bind, begin, startIfOutside, clearCandidate, supported };
}
