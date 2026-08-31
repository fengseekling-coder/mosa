const DEFAULT_CHECK_INTERVAL_MS = 500;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

function encodeEvent(name, payload) {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function createLibraryChangeStream(options = {}) {
  const store = options.store;
  if (!store || typeof store.libraryRevision !== "function") {
    throw new Error("Library change stream requires a store with libraryRevision().");
  }

  const checkIntervalMs = Number.isFinite(options.checkIntervalMs)
    ? Math.max(100, Number(options.checkIntervalMs))
    : DEFAULT_CHECK_INTERVAL_MS;
  const heartbeatIntervalMs = Number.isFinite(options.heartbeatIntervalMs)
    ? Math.max(1_000, Number(options.heartbeatIntervalMs))
    : DEFAULT_HEARTBEAT_INTERVAL_MS;

  const channels = new Map();
  let closed = false;

  function removeChannelIfEmpty(projectId, channel) {
    if (channel.clients.size) return;
    if (channel.checkTimer) clearInterval(channel.checkTimer);
    if (channel.heartbeatTimer) clearInterval(channel.heartbeatTimer);
    channels.delete(projectId);
  }

  function writeClient(client, eventName, payload) {
    if (client.closed || client.res.writableEnded || client.res.destroyed) return false;
    try {
      client.res.write(encodeEvent(eventName, payload));
      return true;
    } catch {
      client.closed = true;
      return false;
    }
  }

  function broadcast(channel, eventName, payload) {
    for (const client of [...channel.clients]) {
      if (!writeClient(client, eventName, payload)) channel.clients.delete(client);
    }
    removeChannelIfEmpty(channel.projectId, channel);
  }

  async function checkChannel(channel) {
    if (closed || channel.checkInFlight || !channel.clients.size) return;
    channel.checkInFlight = true;
    try {
      const nextRevision = String(await store.libraryRevision(channel.projectId));
      if (channel.lastRevision === null) {
        channel.lastRevision = nextRevision;
        return;
      }
      if (nextRevision === channel.lastRevision) return;
      channel.lastRevision = nextRevision;
      broadcast(channel, "library-changed", {
        project: channel.projectId,
        revision: nextRevision,
        at: new Date().toISOString(),
      });
    } catch {
      // The regular revision endpoint remains the fallback. A transient stream
      // check failure must not tear down otherwise healthy browser clients.
    } finally {
      channel.checkInFlight = false;
    }
  }

  function ensureChannel(projectId) {
    let channel = channels.get(projectId);
    if (channel) return channel;
    channel = {
      projectId,
      clients: new Set(),
      lastRevision: null,
      checkInFlight: false,
      checkTimer: null,
      heartbeatTimer: null,
    };
    channel.checkTimer = setInterval(() => {
      void checkChannel(channel);
    }, checkIntervalMs);
    channel.heartbeatTimer = setInterval(() => {
      for (const client of [...channel.clients]) {
        if (client.closed || client.res.writableEnded || client.res.destroyed) {
          channel.clients.delete(client);
          continue;
        }
        try {
          client.res.write(": keepalive\n\n");
        } catch {
          client.closed = true;
          channel.clients.delete(client);
        }
      }
      removeChannelIfEmpty(projectId, channel);
    }, heartbeatIntervalMs);
    channels.set(projectId, channel);
    return channel;
  }

  async function attach(req, res, projectId = "default") {
    if (closed) return false;
    const cleanProjectId = typeof store.projectId === "function"
      ? store.projectId(projectId)
      : String(projectId || "default");
    const channel = ensureChannel(cleanProjectId);
    const client = { res, closed: false };
    channel.clients.add(client);

    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();

    const closeClient = () => {
      if (client.closed) return;
      client.closed = true;
      channel.clients.delete(client);
      removeChannelIfEmpty(cleanProjectId, channel);
    };
    req.once("close", closeClient);
    req.once("aborted", closeClient);
    res.once?.("close", closeClient);

    try {
      const revision = String(await store.libraryRevision(cleanProjectId));
      channel.lastRevision = revision;
      writeClient(client, "ready", {
        project: cleanProjectId,
        revision,
        at: new Date().toISOString(),
      });
    } catch {
      writeClient(client, "ready", {
        project: cleanProjectId,
        revision: null,
        at: new Date().toISOString(),
      });
    }
    return true;
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const [projectId, channel] of channels) {
      if (channel.checkTimer) clearInterval(channel.checkTimer);
      if (channel.heartbeatTimer) clearInterval(channel.heartbeatTimer);
      for (const client of channel.clients) {
        client.closed = true;
        if (!client.res.writableEnded && !client.res.destroyed) client.res.end();
      }
      channel.clients.clear();
      channels.delete(projectId);
    }
  }

  return {
    attach,
    close,
    checkNow(projectId = "default") {
      const cleanProjectId = typeof store.projectId === "function"
        ? store.projectId(projectId)
        : String(projectId || "default");
      const channel = channels.get(cleanProjectId);
      return channel ? checkChannel(channel) : Promise.resolve();
    },
  };
}
