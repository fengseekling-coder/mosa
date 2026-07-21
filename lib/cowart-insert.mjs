function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isCanvasSnapshot(value) {
  return value && typeof value === "object" && value.schema && value.store && typeof value.store === "object";
}

function pageIdForShape(store, shapeId) {
  let record = store?.[shapeId];
  const visited = new Set();

  while (record?.id && !visited.has(record.id)) {
    if (record.typeName === "page") return record.id;
    visited.add(record.id);
    record = store[record.parentId];
  }
  return null;
}

function isPage(store, pageId) {
  return Boolean(pageId && store?.[pageId]?.typeName === "page");
}

function directPageShapeCandidates(store, pageId) {
  return Object.values(store).filter((record) => {
    if (record?.typeName !== "shape" || record.parentId !== pageId) return false;
    return finiteNumber(record.x) !== null && finiteNumber(record.y) !== null
      && finiteNumber(record.props?.w) !== null && finiteNumber(record.props?.h) !== null;
  });
}

function viewportDistance(shape, viewState) {
  const x = shape.x + shape.props.w / 2;
  const y = shape.y + shape.props.h / 2;
  const camera = viewState?.camera;
  const zoom = finiteNumber(camera?.z);
  const cameraX = finiteNumber(camera?.x);
  const cameraY = finiteNumber(camera?.y);

  if (zoom !== null && zoom > 0 && cameraX !== null && cameraY !== null) {
    const screenX = x * zoom + cameraX;
    const screenY = y * zoom + cameraY;
    return screenX ** 2 + screenY ** 2;
  }
  return x ** 2 + y ** 2;
}

function firstPageId(store) {
  return Object.values(store)
    .filter((record) => record?.typeName === "page")
    .sort((left, right) => String(left.index ?? "").localeCompare(String(right.index ?? "")))[0]?.id ?? null;
}

export function chooseCowartInsertTarget(canvasState = {}, selectionState = {}) {
  const snapshot = canvasState.snapshot ?? canvasState;
  if (!isCanvasSnapshot(snapshot)) return { pageId: null, anchorShapeId: null, anchorSource: "none" };

  const { store } = snapshot;
  const selection = selectionState.selection ?? selectionState;
  const selectedShapes = Array.isArray(selection?.selectedShapes) ? selection.selectedShapes : [];
  const selectedShape = selectedShapes
    .map((shape) => typeof shape === "string" ? shape : shape?.id)
    .map((shapeId) => store[shapeId])
    .find((record) => record?.typeName === "shape");
  const selectedPageId = selectedShape ? pageIdForShape(store, selectedShape.id) : null;

  const currentPageId = isPage(store, canvasState.viewState?.currentPageId)
    ? canvasState.viewState.currentPageId
    : null;
  const pageId = selectedPageId || currentPageId || firstPageId(store);
  if (!pageId) return { pageId: null, anchorShapeId: null, anchorSource: "none" };

  if (selectedShape && selectedPageId === pageId) {
    return { pageId, anchorShapeId: selectedShape.id, anchorSource: "selection" };
  }

  const anchor = directPageShapeCandidates(store, pageId)
    .sort((left, right) => viewportDistance(left, canvasState.viewState) - viewportDistance(right, canvasState.viewState))[0];

  return {
    pageId,
    anchorShapeId: anchor?.id ?? null,
    anchorSource: anchor ? "viewport" : "none",
  };
}

export function resolveCowartInsertCanvas(sources = [], requestedId = undefined) {
  const targetId = requestedId === undefined ? "mosa" : nonEmptyString(requestedId);
  if (!targetId || !Array.isArray(sources)) return null;

  return sources.find((source) => (
    source?.id === targetId
    && nonEmptyString(source.projectDir)
    && nonEmptyString(source.canvasDir)
  )) || null;
}

function normalizeBounds(value) {
  if (!value || typeof value !== "object") return null;
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  const w = finiteNumber(value.w);
  const h = finiteNumber(value.h);
  if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

export function normalizeCowartInsertResult(value) {
  const pageId = nonEmptyString(value?.pageId);
  const assetId = nonEmptyString(value?.assetId);
  const shapeId = nonEmptyString(value?.shapeId);
  const bounds = normalizeBounds(value?.bounds);
  if (value?.dryRun || !pageId || !assetId || !shapeId || !bounds) return null;
  return { pageId, assetId, shapeId, bounds };
}

export function verifyCowartInsert(canvasState, insertion, expectedAsset = {}) {
  const normalized = normalizeCowartInsertResult(insertion);
  const snapshot = canvasState?.snapshot ?? canvasState;
  if (!normalized || !isCanvasSnapshot(snapshot)) return null;

  const { store } = snapshot;
  const shape = store[normalized.shapeId];
  const asset = store[normalized.assetId];
  if (shape?.typeName !== "shape" || shape.type !== "image" || shape.props?.assetId !== normalized.assetId) return null;
  if (pageIdForShape(store, shape.id) !== normalized.pageId) return null;
  if (asset?.typeName !== "asset" || asset.type !== "image") return null;
  if (expectedAsset.id && asset.meta?.mosaAssetId !== expectedAsset.id) return null;
  if (expectedAsset.projectId && asset.meta?.mosaProjectId !== expectedAsset.projectId) return null;

  return normalized;
}
