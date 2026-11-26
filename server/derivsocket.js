/**
 * One Deriv public-socket session.
 *
 * Candle history and live quotes both talk to the same endpoint with the same
 * rules: open within 15s, answer within 15s, close cleanly. This module owns
 * that plumbing so neither caller reimplements it.
 *
 * No login, key or app id is used, and nothing here can authorize, buy, sell
 * or read an account. Callers send market-data requests only.
 */

const DERIV_ENDPOINT = "wss://api.derivws.com/trading/v1/options/ws/public";

/**
 * Open one socket and hand back a request/response pair.
 *
 * @param {object} [hooks]
 * @param {(json: object) => void} [hooks.onMessage] every parsed message, before
 *   it is matched to a request. Subscriptions use this to receive pushed ticks.
 * @param {(err: Error) => void} [hooks.onClose] the socket failed or closed
 */
function openDeriv(hooks = {}) {
  if (typeof WebSocket !== "function") {
    // Node 20 and older ship no WebSocket client, and the failure otherwise
    // looks like a network problem rather than a runtime that is too old.
    return Promise.reject(
      new Error(`this Node build (${process.version}) has no WebSocket client; Deriv needs Node 22 or newer`)
    );
  }

  let socket;
  try {
    socket = new WebSocket(DERIV_ENDPOINT);
  } catch (err) {
    return Promise.reject(err);
  }

  let nextId = 1;
  let closed = false;
  let notified = false;
  let connectTimer = null;
  const pending = new Map();
  const open = {};
  const opened = new Promise((resolve, reject) => {
    open.resolve = resolve;
    open.reject = reject;
  });
  opened.catch(() => {}); // failures are reported through request(), not here

  const listen = (type, fn) => {
    if (typeof socket.addEventListener === "function") socket.addEventListener(type, fn);
    else if (typeof socket.on === "function") socket.on(type, fn);
  };

  const notifyClose = (err) => {
    if (notified) return;
    notified = true;
    if (typeof hooks.onClose === "function") {
      try {
        hooks.onClose(err);
      } catch {
        /* a hook must not break the socket's own cleanup */
      }
    }
  };

  const fail = (err) => {
    clearTimeout(connectTimer);
    const wasClosed = closed;
    closed = true;
    open.reject(err);
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
    if (!wasClosed) notifyClose(err);
  };

  connectTimer = setTimeout(() => {
    fail(new Error("Deriv did not open a socket in 15s"));
    try {
      socket.close();
    } catch {
      /* already gone */
    }
  }, 15000);

  listen("open", () => {
    clearTimeout(connectTimer);
    open.resolve();
  });
  listen("message", (event) => {
    let json;
    try {
      json = JSON.parse(event && event.data !== undefined ? event.data : event);
    } catch {
      return;
    }
    if (typeof hooks.onMessage === "function") {
      try {
        hooks.onMessage(json);
      } catch {
        /* a listener must not stop req_id routing */
      }
    }
    const p = pending.get(Number(json && json.req_id));
    if (!p) return;
    pending.delete(p.id);
    clearTimeout(p.timer);
    p.resolve(json);
  });
  listen("error", () =>
    fail(new Error("could not reach Deriv; the network may be blocking wss://api.derivws.com"))
  );
  listen("close", () => fail(new Error("Deriv closed the socket before answering")));

  return Promise.resolve({
    async request(payload) {
      await opened;
      if (closed) throw new Error("Deriv socket is closed");
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Deriv did not answer in 15s"));
        }, 15000);
        pending.set(id, { id, timer, resolve, reject });
        try {
          socket.send(JSON.stringify({ ...payload, req_id: id }));
        } catch (err) {
          clearTimeout(timer);
          pending.delete(id);
          reject(err);
        }
      });
    },
    close() {
      closed = true;
      try {
        socket.close();
      } catch {
        /* already gone */
      }
    },
  });
}

module.exports = { openDeriv, DERIV_ENDPOINT };
