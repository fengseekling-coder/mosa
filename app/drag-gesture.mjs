export function dragIdsForCard(state, assetId) {
  const selected = state?.selectedIds instanceof Set ? state.selectedIds : new Set();
  if (selected.size > 1 && selected.has(assetId)) return [...selected];
  return assetId ? [assetId] : [];
}

export function dragGestureOwner(event, { startsOnCard = false } = {}) {
  if (!startsOnCard) return "marquee";
  if (event?.shiftKey) return "marquee";
  return "internal-asset";
}

export function pointOutsideWindow(point, metrics, margin = 2) {
  const screenX = Number(point?.screenX);
  const screenY = Number(point?.screenY);
  const left = Number(metrics?.screenX);
  const top = Number(metrics?.screenY);
  const width = Number(metrics?.outerWidth);
  const height = Number(metrics?.outerHeight);
  if (![screenX, screenY, left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return false;
  const right = left + width;
  const bottom = top + height;
  return screenX < left - margin
    || screenX > right + margin
    || screenY < top - margin
    || screenY > bottom + margin;
}
