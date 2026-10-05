export class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function readJson(req, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let totalBytes = 0;
    let rejected = false;
    const maxSize = Number.isFinite(maxBytes) ? Math.max(1024, maxBytes) : 5 * 1024 * 1024;
    req.on("data", (chunk) => {
      if (rejected) return;
      totalBytes += Buffer.byteLength(chunk);
      if (totalBytes > maxSize) {
        rejected = true;
        rejectBody(new HttpError(413, "REQUEST_BODY_TOO_LARGE", "Request body too large."));
        req.resume();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => {
      if (rejected) return;
      const body = Buffer.concat(chunks).toString("utf8");
      let parsed;
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        rejectBody(new HttpError(400, "INVALID_JSON_BODY", "Invalid JSON in request body."));
        return;
      }
      // Every readJson route reads object properties off the body, so null /
      // arrays / scalars would otherwise surface as TypeError 500s downstream.
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        const received = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
        rejectBody(new HttpError(400, "INVALID_JSON_BODY_TYPE", `Request body must be a JSON object (received ${received}).`));
        return;
      }
      resolveBody(parsed);
    });
    req.on("error", (error) => {
      if (!rejected) rejectBody(error);
    });
  });
}

export function readBytes(req, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let totalBytes = 0;
    let rejected = false;
    const maxSize = Number.isFinite(maxBytes) ? Math.max(1024, maxBytes) : 5 * 1024 * 1024;
    req.on("data", (chunk) => {
      if (rejected) return;
      totalBytes += Buffer.byteLength(chunk);
      if (totalBytes > maxSize) {
        rejected = true;
        rejectBody(new HttpError(413, "REQUEST_BODY_TOO_LARGE", "Request body too large."));
        req.resume();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => {
      if (!rejected) resolveBody(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (!rejected) rejectBody(error);
    });
  });
}

export function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export function pipeStreamToResponse(stream, res, { errorStatusCode = 500, errorPayload = { error: "Stream unavailable" } } = {}) {
  const releaseStream = () => {
    stream.unpipe?.(res);
    if (!stream.destroyed) stream.destroy?.();
  };
  // On Windows an abandoned HTTP/media response otherwise keeps the backing
  // file handle alive until the read stream naturally drains. Releasing it as
  // soon as Chromium closes the response makes subsequent trash/purge cleanup
  // deterministic, especially for long-running video range requests.
  res.once("close", releaseStream);
  res.once("finish", () => res.removeListener("close", releaseStream));
  stream.once("error", (error) => {
    releaseStream();
    if (res.writableEnded || res.destroyed) return;
    if (!res.headersSent) {
      sendJson(res, errorStatusCode, errorPayload);
      return;
    }
    res.destroy(error);
  });
  stream.pipe(res);
}
