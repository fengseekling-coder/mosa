interface CanvasRecord { id: string; typeName?: string; type?: string; parentId?: string; x?: number; y?: number; index?: unknown; props?: Record<string, unknown>; meta?: Record<string, unknown>; [key: string]: unknown; }
interface CanvasStore { [id: string]: CanvasRecord; }
interface CanvasSnapshot { schema?: unknown; store: CanvasStore; }
interface ViewState { currentPageId?: string; camera?: { x?: number; y?: number; z?: number }; }
interface CanvasState { snapshot?: CanvasSnapshot; viewState?: ViewState; [key: string]: unknown; }
interface SelectionState { selection?: { selectedShapes?: Array<{ id?: string } | string> }; selectedShapes?: Array<{ id?: string } | string>; }
export interface InsertTarget { pageId: string | null; anchorShapeId: string | null; anchorSource: string; }
export interface InsertCanvas { id: string; projectDir: string; canvasDir: string; trusted?: boolean; }
export interface InsertResult { pageId: string; assetId: string; shapeId: string; bounds: { x: number; y: number; w: number; h: number }; }

function nonEmptyString(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function finiteNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function isCanvasSnapshot(value: unknown): value is CanvasSnapshot { return Boolean(value) && typeof value === "object" && (value as CanvasSnapshot).store !== undefined && typeof (value as CanvasSnapshot).store === "object"; }

function pageIdForShape(store: CanvasStore, shapeId: string): string | null {
  let record = store?.[shapeId];
  const visited = new Set<string>();
  while (record?.id && !visited.has(record.id)) {
    if (record.typeName === "page") return record.id;
    visited.add(record.id);
    record = store[record.parentId || ""];
  }
  return null;
}

function isPage(store: CanvasStore, pageId: string | undefined | null): boolean { return Boolean(pageId && store?.[pageId!]?.typeName === "page"); }

function directPageShapeCandidates(store: CanvasStore, pageId: string): CanvasRecord[] {
  return Object.values(store).filter((r) => {
    if (r?.typeName !== "shape" || r.parentId !== pageId) return false;
    return finiteNumber(r.x) !== null && finiteNumber(r.y) !== null && finiteNumber(r.props?.w) !== null && finiteNumber(r.props?.h) !== null;
  });
}

function viewportDistance(shape: CanvasRecord, viewState?: ViewState): number {
  const x = (shape.x || 0) + (Number(shape.props?.w) || 0) / 2;
  const y = (shape.y || 0) + (Number(shape.props?.h) || 0) / 2;
  const camera = viewState?.camera;
  const zoom = finiteNumber(camera?.z);
  const cameraX = finiteNumber(camera?.x);
  const cameraY = finiteNumber(camera?.y);
  if (zoom !== null && zoom > 0 && cameraX !== null && cameraY !== null) { return (x * zoom + cameraX) ** 2 + (y * zoom + cameraY) ** 2; }
  return x ** 2 + y ** 2;
}

function firstPageId(store: CanvasStore): string | null {
  return Object.values(store).filter((r) => r?.typeName === "page").sort((l, r) => String(l.index ?? "").localeCompare(String(r.index ?? "")))[0]?.id ?? null;
}

export function chooseCowartInsertTarget(canvasState: CanvasState = {}, selectionState: SelectionState = {}): InsertTarget {
  const snapshot = canvasState.snapshot ?? canvasState as unknown as CanvasSnapshot;
  if (!isCanvasSnapshot(snapshot)) return { pageId: null, anchorShapeId: null, anchorSource: "none" };
  const { store } = snapshot;
  const selection = selectionState.selection ?? selectionState;
  const selectedShapes = Array.isArray(selection?.selectedShapes) ? selection.selectedShapes : [];
  const selectedShape = selectedShapes.map((s) => typeof s === "string" ? s : s?.id).map((id) => store[id || ""]).find((r) => r?.typeName === "shape");
  const selectedPageId = selectedShape ? pageIdForShape(store, selectedShape.id) : null;
  const currentPageId = isPage(store, canvasState.viewState?.currentPageId) ? canvasState.viewState!.currentPageId : null;
  const pageId = selectedPageId || currentPageId || firstPageId(store);
  if (!pageId) return { pageId: null, anchorShapeId: null, anchorSource: "none" };
  if (selectedShape && selectedPageId === pageId) return { pageId, anchorShapeId: selectedShape.id, anchorSource: "selection" };
  const anchor = directPageShapeCandidates(store, pageId).sort((l, r) => viewportDistance(l, canvasState.viewState) - viewportDistance(r, canvasState.viewState))[0];
  return { pageId, anchorShapeId: anchor?.id ?? null, anchorSource: anchor ? "viewport" : "none" };
}

export function resolveCowartInsertCanvas(sources: InsertCanvas[] = [], requestedId: string | undefined = undefined): InsertCanvas | null {
  const targetId = requestedId === undefined ? "mosa" : nonEmptyString(requestedId);
  if (!targetId || !Array.isArray(sources)) return null;
  // Sources that failed the external-canvas trust check stay listed so the user
  // can remove them, but their paths must never reach the Cowart MCP server.
  return sources.find((s) => s?.id === targetId && s.trusted !== false && nonEmptyString(s.projectDir) && nonEmptyString(s.canvasDir)) || null;
}

function normalizeBounds(value: unknown): { x: number; y: number; w: number; h: number } | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const x = finiteNumber(obj.x), y = finiteNumber(obj.y), w = finiteNumber(obj.w), h = finiteNumber(obj.h);
  if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

export function normalizeCowartInsertResult(value: Record<string, unknown> | null): InsertResult | null {
  const pageId = nonEmptyString(value?.pageId), assetId = nonEmptyString(value?.assetId), shapeId = nonEmptyString(value?.shapeId);
  const bounds = normalizeBounds(value?.bounds);
  if (value?.dryRun || !pageId || !assetId || !shapeId || !bounds) return null;
  return { pageId, assetId, shapeId, bounds };
}

export function verifyCowartInsert(canvasState: CanvasState, insertion: Record<string, unknown>, expectedAsset: { id?: string; projectId?: string } = {}): InsertResult | null {
  const normalized = normalizeCowartInsertResult(insertion);
  const snapshot = (canvasState as Record<string, unknown>).snapshot as CanvasSnapshot ?? canvasState as unknown as CanvasSnapshot;
  if (!normalized || !isCanvasSnapshot(snapshot)) return null;
  const { store } = snapshot;
  const shape = store[normalized.shapeId], asset = store[normalized.assetId];
  if (shape?.typeName !== "shape" || shape.type !== "image" || shape.props?.assetId !== normalized.assetId) return null;
  if (pageIdForShape(store, shape.id) !== normalized.pageId) return null;
  if (asset?.typeName !== "asset" || asset.type !== "image") return null;
  if (expectedAsset.id && (asset.meta as Record<string, unknown>)?.mosaAssetId !== expectedAsset.id) return null;
  if (expectedAsset.projectId && (asset.meta as Record<string, unknown>)?.mosaProjectId !== expectedAsset.projectId) return null;
  return normalized;
}
