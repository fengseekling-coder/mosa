// ===== Image Preview zoom/pan/pinch（提取自 app.js，REFACTORING-PLAN R1 批次 4）=====
// els/state/t/announceGalleryStatus 经 createImagePreviewViewer 工厂注入；缩放步长常量与
// 活动指针表等模块级状态随闭包迁移；事件语义/钳制公式/手势状态机与原先完全一致。

export function createImagePreviewViewer({ els, state, t, announceGalleryStatus }) {
  // ===== Image Zoom & Pan =====
  const IMAGE_PREVIEW_ZOOM_STEP = 0.25;
  const IMAGE_PREVIEW_PAN_STEP = 48;
  const IMAGE_PREVIEW_MIN_SCALE = 0.5;
  const IMAGE_PREVIEW_MAX_SCALE = 5;
  const IMAGE_PREVIEW_SCALE_EPSILON = 1e-6;
  const IMAGE_PREVIEW_POINTER_EPSILON = 2;
  const imagePreviewActivePointers = new Map();
  let imagePreviewPanSession = null;
  let imagePreviewPinchSession = null;
  let imagePreviewSuppressStageClick = false;

  function imagePreviewStageSize() {
    const stage = els.imagePreviewStage;
    if (!stage) return { width: 0, height: 0 };
    const styles = getComputedStyle(stage);
    return {
      width: Math.max(0, stage.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight)),
      height: Math.max(0, stage.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom)),
    };
  }

  function imagePreviewBaseSize() {
    const image = els.imagePreviewImage;
    if (!image) return { width: 0, height: 0 };
    return {
      width: image.offsetWidth || Number.parseFloat(image.style.width) || 0,
      height: image.offsetHeight || Number.parseFloat(image.style.height) || 0,
    };
  }

  function clampImagePreviewPan(offset, renderedSize, stageSize) {
    if (!(renderedSize > stageSize)) return 0;
    const limit = (renderedSize - stageSize) / 2;
    return Math.min(limit, Math.max(-limit, offset));
  }

  function clampImagePreviewOffsets(scale, offsetX, offsetY) {
    const base = imagePreviewBaseSize();
    const stage = imagePreviewStageSize();
    return {
      offsetX: clampImagePreviewPan(offsetX, base.width * scale, stage.width),
      offsetY: clampImagePreviewPan(offsetY, base.height * scale, stage.height),
    };
  }

  function imagePreviewCanTransform() {
    return Boolean(state.imagePreviewId && els.imagePreviewImage && !els.imagePreviewImage.hidden && imagePreviewBaseSize().width > 0);
  }

  function announceImagePreviewZoom() {
    announceGalleryStatus(t("zoomAnnouncement", { percent: Math.round(state.imageZoom * 100) }));
  }

  function resetImageZoom({ announce = false } = {}) {
    clearImagePreviewPointerSession();
    const changed = Math.abs(state.imageZoom - 1) > IMAGE_PREVIEW_SCALE_EPSILON || state.imagePanX !== 0 || state.imagePanY !== 0;
    state.imageZoom = 1;
    state.imagePanX = 0;
    state.imagePanY = 0;
    state.imageDragging = false;
    applyImageTransform();
    if (announce && changed) announceImagePreviewZoom();
    return changed;
  }

  function applyImageTransform() {
    const img = els.imagePreviewImage;
    if (!img) return;
    img.style.transform = `translate(${state.imagePanX}px, ${state.imagePanY}px) scale(${state.imageZoom})`;
    if (els.imagePreviewStage) {
      const base = imagePreviewBaseSize();
      const stage = imagePreviewStageSize();
      const pannable = state.imageZoom > 1 || base.width * state.imageZoom > stage.width || base.height * state.imageZoom > stage.height;
      els.imagePreviewStage.classList.toggle("zoomed", pannable);
      if (!pannable) els.imagePreviewStage.classList.remove("dragging");
    }
  }

  function reconcileImagePreviewTransform() {
    const offsets = clampImagePreviewOffsets(state.imageZoom, state.imagePanX, state.imagePanY);
    state.imagePanX = offsets.offsetX;
    state.imagePanY = offsets.offsetY;
    applyImageTransform();
  }

  function consumeImagePreviewSuppressedClick() {
    if (!imagePreviewSuppressStageClick) return false;
    imagePreviewSuppressStageClick = false;
    return true;
  }

  function zoomImage(delta, { announce = true } = {}) {
    if (!imagePreviewCanTransform()) return false;
    const nextScale = Math.max(IMAGE_PREVIEW_MIN_SCALE, Math.min(IMAGE_PREVIEW_MAX_SCALE, state.imageZoom + delta));
    if (Math.abs(nextScale - state.imageZoom) <= IMAGE_PREVIEW_SCALE_EPSILON) return false;
    state.imageZoom = nextScale;
    if (Math.abs(state.imageZoom - 1) <= IMAGE_PREVIEW_SCALE_EPSILON) {
      state.imageZoom = 1;
      state.imagePanX = 0;
      state.imagePanY = 0;
    } else {
      const offsets = clampImagePreviewOffsets(state.imageZoom, state.imagePanX, state.imagePanY);
      state.imagePanX = offsets.offsetX;
      state.imagePanY = offsets.offsetY;
    }
    applyImageTransform();
    if (announce) announceImagePreviewZoom();
    return true;
  }

  function panImagePreview(deltaX, deltaY, { announce = true } = {}) {
    if (!imagePreviewCanTransform() || state.imageZoom <= 1) return false;
    const offsets = clampImagePreviewOffsets(state.imageZoom, state.imagePanX + deltaX, state.imagePanY + deltaY);
    if (Math.abs(offsets.offsetX - state.imagePanX) <= IMAGE_PREVIEW_SCALE_EPSILON
      && Math.abs(offsets.offsetY - state.imagePanY) <= IMAGE_PREVIEW_SCALE_EPSILON) return false;
    state.imagePanX = offsets.offsetX;
    state.imagePanY = offsets.offsetY;
    applyImageTransform();
    if (announce) {
      const direction = Math.abs(deltaX) >= Math.abs(deltaY)
        ? (deltaX < 0 ? "imagePreviewPanLeft" : "imagePreviewPanRight")
        : (deltaY < 0 ? "imagePreviewPanUp" : "imagePreviewPanDown");
      announceGalleryStatus(t(direction));
    }
    return true;
  }

  function imagePreviewStagePointer(clientX, clientY) {
    const stage = els.imagePreviewStage;
    if (!stage) return { x: 0, y: 0 };
    const rect = stage.getBoundingClientRect();
    const styles = getComputedStyle(stage);
    const paddingLeft = parseFloat(styles.paddingLeft) || 0;
    const paddingTop = parseFloat(styles.paddingTop) || 0;
    const size = imagePreviewStageSize();
    return {
      x: clientX - rect.left - paddingLeft - size.width / 2,
      y: clientY - rect.top - paddingTop - size.height / 2,
    };
  }

  function imagePreviewPointerIsPannable() {
    if (!imagePreviewCanTransform()) return false;
    const base = imagePreviewBaseSize();
    const stage = imagePreviewStageSize();
    return base.width * state.imageZoom > stage.width + IMAGE_PREVIEW_SCALE_EPSILON
      || base.height * state.imageZoom > stage.height + IMAGE_PREVIEW_SCALE_EPSILON;
  }

  function zoomImageAtPoint(targetScale, pointerX, pointerY, currentScale, currentPanX, currentPanY) {
    const scale = currentScale > 0 ? currentScale : 1;
    const anchorX = (pointerX - currentPanX) / scale;
    const anchorY = (pointerY - currentPanY) / scale;
    return { offsetX: pointerX - anchorX * targetScale, offsetY: pointerY - anchorY * targetScale };
  }

  function imagePreviewPointerEntries(ids = null) {
    const entries = [...imagePreviewActivePointers.entries()];
    return ids ? entries.filter(([pointerId]) => ids.includes(pointerId)) : entries;
  }

  function imagePreviewTouchPointers() {
    return imagePreviewPointerEntries().filter(([, pointer]) => pointer.pointerType === "touch");
  }

  function imagePreviewPointerMidpoint(entries) {
    const first = imagePreviewStagePointer(entries[0][1].clientX, entries[0][1].clientY);
    const second = imagePreviewStagePointer(entries[1][1].clientX, entries[1][1].clientY);
    return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  }

  function imagePreviewPointerDistance(entries) {
    const first = entries[0][1];
    const second = entries[1][1];
    return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
  }

  function captureImagePreviewPointer(pointerId) {
    const stage = els.imagePreviewStage;
    if (!stage?.setPointerCapture) return false;
    try {
      stage.setPointerCapture(pointerId);
      return stage.hasPointerCapture?.(pointerId) ?? true;
    } catch {
      return false;
    }
  }

  function releaseImagePreviewPointer(pointerId) {
    const stage = els.imagePreviewStage;
    if (!stage?.releasePointerCapture) return;
    try {
      if (!stage.hasPointerCapture || stage.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId);
    } catch {
      // Pointer capture can already be gone after a native cancel.
    }
  }

  function startImagePreviewPan(pointer) {
    if (!imagePreviewPointerIsPannable()) return;
    imagePreviewPanSession = {
      pointerId: pointer.pointerId,
      startClientX: pointer.clientX,
      startClientY: pointer.clientY,
      startPanX: state.imagePanX,
      startPanY: state.imagePanY,
      moved: false,
    };
    state.imageDragging = true;
    els.imagePreviewStage?.classList.add("dragging");
  }

  function startImagePreviewPinch() {
    const entries = imagePreviewTouchPointers();
    if (entries.length < 2) return false;
    const distance = imagePreviewPointerDistance(entries);
    if (!(distance > IMAGE_PREVIEW_SCALE_EPSILON)) return false;
    imagePreviewPanSession = null;
    state.imageDragging = false;
    els.imagePreviewStage?.classList.remove("dragging");
    imagePreviewPinchSession = {
      pointerIds: entries.slice(0, 2).map(([pointerId]) => pointerId),
      startDistance: distance,
      startScale: state.imageZoom,
      startPanX: state.imagePanX,
      startPanY: state.imagePanY,
      startMidpoint: imagePreviewPointerMidpoint(entries),
      changed: false,
    };
    return true;
  }

  function updateImagePreviewPinch() {
    const session = imagePreviewPinchSession;
    if (!session) return false;
    const entries = imagePreviewPointerEntries(session.pointerIds);
    if (entries.length !== 2) return false;
    const distance = imagePreviewPointerDistance(entries);
    if (!(distance > IMAGE_PREVIEW_SCALE_EPSILON) || !(session.startDistance > IMAGE_PREVIEW_SCALE_EPSILON)) return false;
    const targetScale = Math.max(IMAGE_PREVIEW_MIN_SCALE, Math.min(IMAGE_PREVIEW_MAX_SCALE, session.startScale * (distance / session.startDistance)));
    const midpoint = imagePreviewPointerMidpoint(entries);
    const zoomed = zoomImageAtPoint(targetScale, session.startMidpoint.x, session.startMidpoint.y, session.startScale, session.startPanX, session.startPanY);
    const midpointDelta = { x: midpoint.x - session.startMidpoint.x, y: midpoint.y - session.startMidpoint.y };
    const offsets = clampImagePreviewOffsets(targetScale, zoomed.offsetX + midpointDelta.x, zoomed.offsetY + midpointDelta.y);
    const changed = Math.abs(targetScale - state.imageZoom) > IMAGE_PREVIEW_SCALE_EPSILON
      || Math.abs(offsets.offsetX - state.imagePanX) > IMAGE_PREVIEW_SCALE_EPSILON
      || Math.abs(offsets.offsetY - state.imagePanY) > IMAGE_PREVIEW_SCALE_EPSILON;
    state.imageZoom = targetScale;
    state.imagePanX = offsets.offsetX;
    state.imagePanY = offsets.offsetY;
    applyImageTransform();
    session.changed ||= changed;
    return changed;
  }

  function finishImagePreviewPinch({ announce = false } = {}) {
    const session = imagePreviewPinchSession;
    imagePreviewPinchSession = null;
    if (announce && session?.changed) announceImagePreviewZoom();
    return Boolean(session?.changed);
  }

  function clearImagePreviewPointerSession({ release = true } = {}) {
    if (release) for (const pointerId of imagePreviewActivePointers.keys()) releaseImagePreviewPointer(pointerId);
    imagePreviewActivePointers.clear();
    imagePreviewPanSession = null;
    imagePreviewPinchSession = null;
    state.imageDragging = false;
    els.imagePreviewStage?.classList.remove("dragging");
  }

  function handleImagePreviewPointerDown(event) {
    if (!state.imagePreviewId || !imagePreviewCanTransform()) return;
    if (event.pointerType === "mouse" && (!event.isPrimary || event.button !== 0)) return;
    if (event.target.closest?.("video")) return;
    if (imagePreviewActivePointers.has(event.pointerId)) return;
    const pointer = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    imagePreviewActivePointers.set(event.pointerId, pointer);
    captureImagePreviewPointer(event.pointerId);
    if (imagePreviewTouchPointers().length >= 2) {
      startImagePreviewPinch();
      return;
    }
    if (event.pointerType === "mouse" || imagePreviewPointerIsPannable()) startImagePreviewPan(pointer);
  }

  function handleImagePreviewPointerMove(event) {
    const pointer = imagePreviewActivePointers.get(event.pointerId);
    if (!pointer) return;
    pointer.clientX = event.clientX;
    pointer.clientY = event.clientY;
    if (!imagePreviewPinchSession && imagePreviewTouchPointers().length >= 2) startImagePreviewPinch();
    if (imagePreviewPinchSession) {
      event.preventDefault();
      updateImagePreviewPinch();
      imagePreviewSuppressStageClick = true;
      return;
    }
    const session = imagePreviewPanSession;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (Math.hypot(event.clientX - session.startClientX, event.clientY - session.startClientY) > IMAGE_PREVIEW_POINTER_EPSILON) {
      session.moved = true;
      imagePreviewSuppressStageClick = true;
    }
    const offsets = clampImagePreviewOffsets(state.imageZoom, session.startPanX + event.clientX - session.startClientX, session.startPanY + event.clientY - session.startClientY);
    state.imagePanX = offsets.offsetX;
    state.imagePanY = offsets.offsetY;
    applyImageTransform();
  }

  function transitionImagePreviewPinchToPan() {
    const [entry] = imagePreviewTouchPointers();
    if (!entry) return;
    if (imagePreviewPointerIsPannable()) startImagePreviewPan(entry[1]);
  }

  function handleImagePreviewPointerEnd(event) {
    const pointer = imagePreviewActivePointers.get(event.pointerId);
    if (!pointer) return;
    pointer.clientX = event.clientX;
    pointer.clientY = event.clientY;
    releaseImagePreviewPointer(event.pointerId);
    if (event.type === "pointercancel") {
      clearImagePreviewPointerSession({ release: false });
      return;
    }
    const endingPinch = imagePreviewPinchSession?.pointerIds.includes(event.pointerId);
    imagePreviewActivePointers.delete(event.pointerId);
    if (endingPinch) {
      finishImagePreviewPinch({ announce: true });
      imagePreviewPanSession = null;
      state.imageDragging = false;
      transitionImagePreviewPinchToPan();
    } else if (imagePreviewPanSession?.pointerId === event.pointerId) {
      imagePreviewPanSession = null;
      state.imageDragging = false;
      els.imagePreviewStage?.classList.remove("dragging");
    }
    if (!imagePreviewActivePointers.size) clearImagePreviewPointerSession({ release: false });
  }

  function setupImageZoomPan() {
    const stage = els.imagePreviewStage; if (!stage) return;
    stage.addEventListener("wheel", (e) => { if (state.imagePreviewId) { e.preventDefault(); zoomImage(e.deltaY < 0 ? IMAGE_PREVIEW_ZOOM_STEP : -IMAGE_PREVIEW_ZOOM_STEP, { announce: false }); } }, { passive: false });
    stage.addEventListener("pointerdown", handleImagePreviewPointerDown);
    stage.addEventListener("pointermove", handleImagePreviewPointerMove);
    stage.addEventListener("pointerup", handleImagePreviewPointerEnd);
    stage.addEventListener("pointercancel", handleImagePreviewPointerEnd);
  }

  return {
    resetImageZoom, zoomImage, panImagePreview, announceImagePreviewZoom, setupImageZoomPan,
    reconcileImagePreviewTransform, consumeImagePreviewSuppressedClick,
    IMAGE_PREVIEW_ZOOM_STEP, IMAGE_PREVIEW_PAN_STEP,
  };
}
