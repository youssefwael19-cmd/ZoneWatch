/**
 * cTrader Open API — the route to Pepperstone, IC Markets and every other
 * cTrader broker.
 *
 * Why this file exists next to oanda.js: an Exness/MT5 account needs a Windows
 * machine, OANDA has a REST API, and cTrader has neither — it speaks its own
 * protocol. The good news, which makes this adapter practical in plain Node, is
 * that cTrader accepts **JSON** on port 5036 as well as protobuf on 5035, over
 * either TCP or WebSocket. So there is no protobuf compiler here, no .proto
 * files and no dependency: a WebSocket, a JSON envelope and the documented
 * payload numbers.
 *
 * Envelope, exactly as the protocol wants it:
 *   { "clientMsgId": "12", "payloadType": 2106, "payload": { ... } }
 *
 * Flow: app auth (clientId + clientSecret) -> account list for the access token
 * -> account auth (account id + access token) -> symbols -> subscribe spots.
 * Then orders carry an absolute stop and target, so the broker holds them.
 *
 * Numbers that are easy to get wrong, all handled here:
 *   - volume is in cents: 1000 means 10.00 units, and symbol.lotSize is in the
 *     same scale, so volume = lots * lotSize
 *   - prices inside spot events are in 1/100000 of a unit
 *   - money is integer scaled by 10^moneyDigits
 *   - stopLoss / takeProfit on an order are absolute prices, as doubles
 */

const settings = require("../settings");

const PAYLOAD = {
  HEARTBEAT: 51,
  ERROR_RES: 2142,
  APP_AUTH_REQ: 2100,
  APP_AUTH_RES: 2101,
  ACCOUNT_AUTH_REQ: 2102,
  ACCOUNT_AUTH_RES: 2103,
  NEW_ORDER_REQ: 2106,
  CLOSE_POSITION_REQ: 2111,
  ASSET_LIST_REQ: 2112,
  ASSET_LIST_RES: 2113,
  SYMBOLS_LIST_REQ: 2114,
  SYMBOLS_LIST_RES: 2115,
  SYMBOL_BY_ID_REQ: 2116,
  SYMBOL_BY_ID_RES: 2117,
  TRADER_REQ: 2121,
  TRADER_RES: 2122,
  RECONCILE_REQ: 2124,
  RECONCILE_RES: 2125,
  EXECUTION_EVENT: 2126,
  SUBSCRIBE_SPOTS_REQ: 2127,
  SUBSCRIBE_SPOTS_RES: 2128,
  SPOT_EVENT: 2131,
  ORDER_ERROR_EVENT: 2132,
  GET_ACCOUNTS_REQ: 2149,
  GET_ACCOUNTS_RES: 2150,
  UNREALIZED_PNL_REQ: 2187,
  UNREALIZED_PNL_RES: 2188,
  CLIENT_DISCONNECT_EVENT: 2148,
  TOKEN_INVALIDATED_EVENT: 2147,
};

const HOSTS = {
  practice: "wss://demo.ctraderapi.com:5036",
  live: "wss://live.ctraderapi.com:5036",
};

const ORDER_TYPE_MARKET = 1;
const SIDE = { BUY: 1, SELL: 2 };
const EXECUTION_FILLED = 3;
const EXECUTION_REJECTED = 7;

const NAME = "cTrader Open API";

// Broker naming varies (US100 vs USTEC vs NAS100), so a market is matched by
// trying each of these aliases against the account's symbol list.
const SYMBOL_ALIASES = {
  NASDAQ: ["NAS100", "US100", "USTEC", "USTECH", "NASDAQ100", "US500TECH"],
};

/**
 * The socket interface this file needs is tiny: send text, receive text, close.
 * Node's built-in WebSocket and the `ws` package disagree about events, so this
 * adapter papers over both, buffers writes until the socket is open, and turns
 * a connection error into a rejection instead of a 15-second silence.
 */
function defaultTransport(url) {
  if (typeof WebSocket !== "function") {
    // Node 20 and older ship no WebSocket client, and the failure otherwise looks
    // like a network problem rather than a runtime that is too old.
    throw new Error(
      `this Node build (${process.version}) has no WebSocket client; cTrader needs Node 22 or newer`
    );
  }
  const socket = new WebSocket(url);
  let listener = () => {};
  let errorListener = () => {};
  const queue = [];
  let open = false;

  const on = (event, handler) => {
    if (typeof socket.addEventListener === "function") socket.addEventListener(event, handler);
    else if (typeof socket.on === "function") socket.on(event, handler);
  };

  on("open", () => {
    open = true;
    for (const text of queue.splice(0)) {
      try {
        socket.send(text);
      } catch {
        /* the socket went away again; the error handler reports it */
      }
    }
  });
  on("message", (event) => listener(event && event.data !== undefined ? event.data : event));
  on("error", (event) =>
    errorListener(new Error((event && event.message) || "could not connect to cTrader"))
  );
  on("close", (event) => {
    open = false;
    errorListener(
      new Error(`cTrader closed the connection${event && event.code ? ` (${event.code})` : ""}`)
    );
  });

  return {
    send(text) {
      if (!open) {
        queue.push(text);
        return;
      }
      try {
        socket.send(text);
      } catch {
        queue.push(text);
      }
    },
    onMessage(handler) {
      listener = handler;
    },
    onError(handler) {
      errorListener = handler;
    },
    close() {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    },
  };
}

// Overridable in tests, so the whole adapter can be exercised without a broker.
let transportFactory = defaultTransport;

function __setTransportFactory(factory) {
  transportFactory = factory;
}

function normalizeName(name) {
  return String(name || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function configFor(config) {
  const direct = (config && config.direct) || {};
  const environment = direct.environment === "live" ? "live" : "practice";
  return {
    environment,
    url: direct.baseUrl ? String(direct.baseUrl) : HOSTS[environment],
    clientId: direct.clientId || "",
    clientSecret: direct.clientSecret || "",
    accessToken: direct.token || "",
    refreshToken: direct.refreshToken || "",
    accountId: direct.accountId || "",
  };
}

function configured(config) {
  const c = configFor(config);
  return Boolean(c.clientId && c.clientSecret && (c.accessToken || c.refreshToken));
}

/* ------------------------------------------------------------------ volume -- */

/**
 * Volume in the protocol's cents, respecting the symbol's own minimum and step.
 * Refusing is deliberate: rounding up to the minimum would silently multiply
 * the risk the executor promised to cap.
 */
function volumeFor({ lots, lotSize, minVolume, stepVolume }) {
  if (!(lotSize > 0)) return { error: "broker did not send a lot size for this symbol" };
  let volume = Math.round(Number(lots) * lotSize);
  if (stepVolume > 0) volume = Math.round(volume / stepVolume) * stepVolume;
  if (volume < minVolume) {
    return {
      error: `broker minimum is ${(minVolume / lotSize).toFixed(2)} lots, this signal sized to ${Number(lots).toFixed(3)}`,
    };
  }
  return { volume, lots: volume / lotSize };
}

function money(value, digits) {
  const scale = Math.pow(10, Number.isFinite(Number(digits)) ? Number(digits) : 2);
  return Number(value) / scale;
}

function priceFromSpot(value) {
  return Number(value) / 100000;
}

/* -------------------------------------------------------------- transport -- */

function createClient(cfg) {
  const transport = transportFactory(cfg.url);
  const pending = new Map();
  const listeners = new Set();
  let sequence = 0;

  transport.onMessage((raw) => {
    let message;
    try {
      message = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(String(raw));
    } catch {
      return;
    }
    const id = message && message.clientMsgId;
    if (id && pending.has(id)) {
      const waiter = pending.get(id);
      pending.delete(id);
      clearTimeout(waiter.timer);
      if (message.payloadType === PAYLOAD.ERROR_RES) {
        waiter.reject(new Error(`${message.payload.errorCode}${message.payload.description ? `: ${message.payload.description}` : ""}`));
      } else {
        waiter.resolve(message);
      }
      return;
    }
    for (const listener of listeners) {
      try {
        listener(message);
      } catch {
        /* a listener must never break the socket */
      }
    }
  });

  if (typeof transport.onError === "function") {
    transport.onError((err) => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(err);
      }
      pending.clear();
    });
  }

  function send(payloadType, payload = {}) {
    const clientMsgId = String(++sequence);
    transport.send(JSON.stringify({ clientMsgId, payloadType, payload }));
    return clientMsgId;
  }

  function request(payloadType, payload = {}, { timeout = 15000 } = {}) {
    const clientMsgId = send(payloadType, payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(clientMsgId);
        reject(new Error(`cTrader did not answer payload ${payloadType} in ${timeout}ms`));
      }, timeout);
      pending.set(clientMsgId, { resolve, reject, timer });
    });
  }

  return {
    transport,
    send,
    request,
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      for (const waiter of pending.values()) clearTimeout(waiter.timer);
      pending.clear();
      try {
        transport.close();
      } catch {
        /* already gone */
      }
    },
  };
}

/* ----------------------------------------------------------------- client -- */

/**
 * One authorised session per environment/token/account, reused across calls so
 * the app does not reconnect for every quote. Everything cached here is
 * per-session state, not per-request.
 */
const sessions = new Map();

function sessionKey(cfg) {
  return `${cfg.environment}|${cfg.accountId}|${cfg.accessToken ? cfg.accessToken.slice(-8) : cfg.refreshToken.slice(-8)}`;
}

async function authorize(cfg) {
  const client = createClient(cfg);
  const state = {
    client,
    accountId: cfg.accountId,
    demo: cfg.environment === "practice",
    symbols: new Map(), // normalized name -> { symbolId, name }
    details: new Map(), // symbolId -> symbol entity
    assets: new Map(), // assetId -> name
    spots: new Map(), // symbolId -> { bid, ask, at }
    subscribed: new Set(),
    executionListeners: new Set(),
    currency: null,
    lastHeartbeat: Date.now(),
    alive: true,
  };

  client.onMessage((message) => {
    if (message.payloadType === PAYLOAD.SPOT_EVENT) {
      const { symbolId, bid, ask } = message.payload || {};
      const previous = state.spots.get(symbolId) || {};
      state.spots.set(symbolId, {
        bid: bid != null ? priceFromSpot(bid) : previous.bid,
        ask: ask != null ? priceFromSpot(ask) : previous.ask,
        at: new Date().toISOString(),
      });
      return;
    }
    if (message.payloadType === PAYLOAD.EXECUTION_EVENT) {
      for (const listener of state.executionListeners) listener(message.payload || {});
      return;
    }
    if (message.payloadType === PAYLOAD.TOKEN_INVALIDATED_EVENT || message.payloadType === PAYLOAD.CLIENT_DISCONNECT_EVENT) {
      state.alive = false;
    }
  });

  await client.request(PAYLOAD.APP_AUTH_REQ, {
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
  });

  // With only a refresh token there may be no access token yet; resolve one.
  if (!cfg.accessToken && cfg.refreshToken) {
    const refreshed = await refreshTokens(cfg);
    if (refreshed.ok) cfg = { ...cfg, accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken };
  }

  const accounts = await client.request(PAYLOAD.GET_ACCOUNTS_REQ, { accessToken: cfg.accessToken });
  const list = (accounts.payload && accounts.payload.ctidTraderAccount) || [];
  if (!list.length) throw new Error("this token is not authorised for any cTrader account");

  let chosen = list[0];
  if (cfg.accountId) {
    const match = list.find((entry) => String(entry.ctidTraderAccountId) === String(cfg.accountId));
    if (!match) throw new Error(`account ${cfg.accountId} is not in this token's account list`);
    chosen = match;
  }
  state.accountId = String(chosen.ctidTraderAccountId);
  state.demo = chosen.isLive !== true;
  state.traderLogin = chosen.traderLogin || null;
  state.broker = chosen.brokerTitleShort || "cTrader";

  await client.request(PAYLOAD.ACCOUNT_AUTH_REQ, {
    ctidTraderAccountId: state.accountId,
    accessToken: cfg.accessToken,
  });

  await loadAssets(state);
  await loadSymbols(state);

  // The proxy drops idle connections; a heartbeat every 25s keeps it.
  state.heartbeat = setInterval(() => {
    try {
      client.send(PAYLOAD.HEARTBEAT, {});
    } catch {
      state.alive = false;
    }
  }, 25000);
  if (state.heartbeat.unref) state.heartbeat.unref();

  return state;
}

async function getSession(config) {
  const cfg = configFor(config);
  if (!cfg.clientId || !cfg.clientSecret) throw new Error("client ID and client secret are required");
  if (!cfg.accessToken && !cfg.refreshToken) throw new Error("an access token or a refresh token is required");

  const key = sessionKey(cfg);
  const existing = sessions.get(key);
  if (existing && existing.alive !== false) {
    try {
      return await existing;
    } catch {
      sessions.delete(key);
    }
  }
  const created = authorize(cfg).catch((err) => {
    sessions.delete(key);
    throw err;
  });
  sessions.set(key, created);
  return created;
}

async function loadAssets(state) {
  const res = await state.client.request(PAYLOAD.ASSET_LIST_REQ, { ctidTraderAccountId: state.accountId });
  for (const asset of (res.payload && res.payload.asset) || []) {
    state.assets.set(asset.assetId, asset.name);
  }
}

async function loadSymbols(state) {
  const res = await state.client.request(PAYLOAD.SYMBOLS_LIST_REQ, {
    ctidTraderAccountId: state.accountId,
  });
  const symbols = (res.payload && res.payload.symbol) || [];
  for (const symbol of symbols) {
    state.symbols.set(normalizeName(symbol.symbolName), {
      symbolId: symbol.symbolId,
      name: symbol.symbolName,
    });
  }
}

/** The broker's symbol for one of our markets, or an explanation. */
function resolveSymbol(state, appSymbol) {
  const wanted = [appSymbol, ...(SYMBOL_ALIASES[appSymbol] || [])].map(normalizeName);
  for (const candidate of wanted) {
    const hit = state.symbols.get(candidate);
    if (hit) return hit;
  }
  // Last resort: a symbol whose name starts with the alias (XAUUSD.raw, US100.cash).
  for (const candidate of wanted) {
    for (const [name, hit] of state.symbols) {
      if (name.startsWith(candidate)) return hit;
    }
  }
  return null;
}

async function detailsFor(state, symbolId) {
  if (state.details.has(symbolId)) return state.details.get(symbolId);
  const res = await state.client.request(PAYLOAD.SYMBOL_BY_ID_REQ, {
    ctidTraderAccountId: state.accountId,
    symbolId: [symbolId],
  });
  const symbol = ((res.payload && res.payload.symbol) || [])[0];
  if (symbol) state.details.set(symbolId, symbol);
  return symbol || null;
}

async function subscribeSpots(state, symbolIds) {
  const missing = symbolIds.filter((id) => !state.subscribed.has(id));
  if (!missing.length) return;
  await state.client.request(PAYLOAD.SUBSCRIBE_SPOTS_REQ, {
    ctidTraderAccountId: state.accountId,
    symbolId: missing,
  });
  for (const id of missing) state.subscribed.add(id);
}

async function waitForSpot(state, symbolId, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const spot = state.spots.get(symbolId);
    if (spot && spot.bid != null && spot.ask != null) return spot;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return state.spots.get(symbolId) || null;
}

async function positionsFor(state, symbolId) {
  const res = await state.client.request(PAYLOAD.RECONCILE_REQ, { ctidTraderAccountId: state.accountId });
  return ((res.payload && res.payload.position) || []).filter(
    (position) => position.tradeData.symbolId === symbolId
  );
}

/**
 * The accounts a token can trade, without opening a trading session. The setup
 * script needs this because the token endpoint never returns the
 * ctidTraderAccountId — only the socket does.
 */
async function listAccounts(config) {
  const cfg = configFor(config);
  try {
    if (!cfg.clientId || !cfg.clientSecret) throw new Error("client ID and client secret are required");
    if (!cfg.accessToken && !cfg.refreshToken) throw new Error("an access token or a refresh token is required");
    const client = createClient(cfg);
    try {
      await client.request(PAYLOAD.APP_AUTH_REQ, {
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
      });
      let accessToken = cfg.accessToken;
      if (!accessToken && cfg.refreshToken) {
        const refreshed = await refreshTokens(cfg);
        if (!refreshed.ok) throw new Error(refreshed.error);
        accessToken = refreshed.accessToken;
      }
      const res = await client.request(PAYLOAD.GET_ACCOUNTS_REQ, { accessToken });
      const accounts = ((res.payload && res.payload.ctidTraderAccount) || []).map((entry) => ({
        accountId: String(entry.ctidTraderAccountId),
        login: entry.traderLogin != null ? String(entry.traderLogin) : null,
        broker: entry.brokerTitleShort || "cTrader",
        live: entry.isLive === true,
      }));
      return { ok: true, accounts, environment: cfg.environment };
    } finally {
      client.close();
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* -------------------------------------------------------------- broker API -- */

async function account(config) {
  try {
    const state = await getSession(config);
    const [traderRes, reconcileRes] = await Promise.all([
      state.client.request(PAYLOAD.TRADER_REQ, { ctidTraderAccountId: state.accountId }),
      state.client.request(PAYLOAD.RECONCILE_REQ, { ctidTraderAccountId: state.accountId }),
    ]);

    const trader = (traderRes.payload && traderRes.payload.trader) || {};
    const digits = trader.moneyDigits != null ? trader.moneyDigits : 2;
    const balance = money(trader.balance || 0, digits);
    const depositAsset = state.assets.get(trader.depositAssetId);
    if (depositAsset) state.currency = depositAsset;

    const positions = ((reconcileRes.payload && reconcileRes.payload.position) || []).map((position) => {
      const symbol = state.symbols.get(normalizeName(symbolForId(state, position.tradeData.symbolId) || ""));
      const detail = state.details.get(position.tradeData.symbolId);
      const lotSize = detail && detail.lotSize ? detail.lotSize : null;
      return {
        ticket: String(position.positionId),
        symbol: symbol ? symbol.name : String(position.tradeData.symbolId),
        side: position.tradeData.tradeSide === SIDE.SELL ? "SELL" : "BUY",
        lots: lotSize ? Number((position.tradeData.volume / lotSize).toFixed(2)) : null,
        volume: position.tradeData.volume,
        symbolId: position.tradeData.symbolId,
        entry: position.price != null ? Number(position.price) : null,
        sl: position.stopLoss != null ? Number(position.stopLoss) : null,
        tp: position.takeProfit != null ? Number(position.takeProfit) : null,
        profit: null,
      };
    });

    // Equity = balance + net unrealised, which the broker computes for us.
    let unrealized = 0;
    try {
      const pnl = await state.client.request(PAYLOAD.UNREALIZED_PNL_REQ, {
        ctidTraderAccountId: state.accountId,
      });
      const pnlDigits = pnl.payload && pnl.payload.moneyDigits != null ? pnl.payload.moneyDigits : digits;
      for (const row of (pnl.payload && pnl.payload.positionUnrealizedPnL) || []) {
        unrealized += money(row.netUnrealizedPnL || 0, pnlDigits);
      }
    } catch {
      // Older servers may not have the message; equity falls back to balance.
    }

    return {
      ok: true,
      account: {
        login: state.traderLogin || state.accountId,
        server: `${state.broker} (cTrader ${state.demo ? "demo" : "live"})`,
        currency: state.currency || "USD",
        balance: Number(balance.toFixed(2)),
        equity: Number((balance + unrealized).toFixed(2)),
        demo: state.demo,
        positions,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function symbolForId(state, symbolId) {
  for (const [name, hit] of state.symbols) {
    if (hit.symbolId === symbolId) return name;
  }
  return null;
}

async function openTrades(config) {
  try {
    const state = await getSession(config);
    const res = await state.client.request(PAYLOAD.RECONCILE_REQ, { ctidTraderAccountId: state.accountId });
    const trades = ((res.payload && res.payload.position) || []).map((position) => {
      const detail = state.details.get(position.tradeData.symbolId);
      const lotSize = detail && detail.lotSize ? detail.lotSize : null;
      return {
        ticket: String(position.positionId),
        positionId: position.positionId,
        symbol: symbolForId(state, position.tradeData.symbolId) || String(position.tradeData.symbolId),
        symbolId: position.tradeData.symbolId,
        side: position.tradeData.tradeSide === SIDE.SELL ? "SELL" : "BUY",
        lots: lotSize ? Number((position.tradeData.volume / lotSize).toFixed(2)) : null,
        volume: position.tradeData.volume,
        entry: position.price != null ? Number(position.price) : null,
        sl: position.stopLoss != null ? Number(position.stopLoss) : null,
        tp: position.takeProfit != null ? Number(position.takeProfit) : null,
      };
    });
    return { ok: true, trades };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function pricing(config, symbols) {
  try {
    const state = await getSession(config);
    const wanted = [];
    const missing = [];
    for (const symbol of symbols || []) {
      const hit = resolveSymbol(state, symbol);
      if (!hit) {
        missing.push(symbol);
        continue;
      }
      wanted.push({ symbol, hit });
    }
    if (!wanted.length) return { ok: false, error: `none of these markets exist at the broker: ${missing.join(", ")}` };

    await subscribeSpots(state, wanted.map((entry) => entry.hit.symbolId));
    const spreads = {};
    const stale = [];
    for (const { symbol, hit } of wanted) {
      const spot = await waitForSpot(state, hit.symbolId, 2500);
      if (!spot || spot.bid == null || spot.ask == null) {
        stale.push(symbol);
        continue;
      }
      spreads[symbol] = {
        price: Number((spot.ask - spot.bid).toFixed(5)),
        bid: spot.bid,
        ask: spot.ask,
        points: null,
        at: spot.at,
      };
    }
    if (!Object.keys(spreads).length) return { ok: false, error: "no quotes came back from the broker" };
    return { ok: true, spreads, missing };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Resolve a market to symbol + metadata, with an error that says why. */
async function prepareOrder(state, appSymbol, lots) {
  const hit = resolveSymbol(state, appSymbol);
  if (!hit) {
    return { error: `this account has no symbol for ${appSymbol}. Ask the broker what it calls it, then set a symbol override.` };
  }
  const detail = await detailsFor(state, hit.symbolId);
  if (!detail) return { error: `no symbol details came back for ${hit.name}` };
  const sizing = volumeFor({
    lots,
    lotSize: detail.lotSize,
    minVolume: detail.minVolume || 0,
    stepVolume: detail.stepVolume || 0,
  });
  if (sizing.error) return { error: `${sizing.error} (${hit.name})` };
  return { hit, detail, volume: sizing.volume, lots: sizing.lots };
}

/** Wait for the execution event that belongs to this order. */
function waitForExecution(state, { clientOrderId, positionId, timeout = 15000 }) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.executionListeners.delete(listener);
      resolve({ timedOut: true });
    }, timeout);

    function listener(payload) {
      const orderMatch = clientOrderId && payload.order && payload.order.clientOrderId === clientOrderId;
      const positionMatch = positionId && payload.position && payload.position.positionId === positionId;
      if (!orderMatch && !positionMatch) return;
      if (payload.executionType === EXECUTION_REJECTED) {
        clearTimeout(timer);
        state.executionListeners.delete(listener);
        resolve({ rejected: true, error: payload.errorCode || "order rejected" });
        return;
      }
      if (payload.executionType === EXECUTION_FILLED) {
        clearTimeout(timer);
        state.executionListeners.delete(listener);
        resolve({ filled: true, payload });
      }
      // ACCEPTED/PARTIAL: keep waiting for the fill.
    }

    state.executionListeners.add(listener);
  });
}

async function place(config, order) {
  try {
    const state = await getSession(config);
    const prepared = await prepareOrder(state, order.symbol, order.lots);
    if (prepared.error) return { ok: false, error: prepared.error };

    // Snapshot the symbol's positions first: if the fill event is lost, this is
    // how we tell "it filled" from "it never went through" without re-sending
    // an order that may already be live.
    const positionsBefore = await positionsFor(state, prepared.hit.symbolId);

    const clientOrderId = `zw-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const execution = waitForExecution(state, { clientOrderId });

    // No response is expected for this payload: the server acknowledges with an
    // execution event, so the promise is the event listener, not request().
    state.client.send(PAYLOAD.NEW_ORDER_REQ, {
      ctidTraderAccountId: state.accountId,
      symbolId: prepared.hit.symbolId,
      orderType: ORDER_TYPE_MARKET,
      tradeSide: order.side === "SELL" ? SIDE.SELL : SIDE.BUY,
      volume: prepared.volume,
      // Absolute prices, so the broker holds both exits.
      stopLoss: Number(order.stop),
      takeProfit: Number(order.target),
      comment: "zone-watch",
      clientOrderId,
    });

    const result = await execution;
    if (result.rejected) return { ok: false, error: `${result.error} (${prepared.hit.name})` };
    if (result.timedOut) {
      // The event may simply have been missed. Ask the broker before claiming
      // failure: reporting a filled order as failed is how duplicate trades
      // happen on the next cycle.
      const now = await positionsFor(state, prepared.hit.symbolId);
      if (now.length > positionsBefore.length) {
        const newest = now[now.length - 1];
        return {
          ok: true,
          id: String(newest.positionId),
          price: newest.price != null ? Number(newest.price) : null,
          lots: prepared.lots,
          volume: prepared.volume,
          symbol: prepared.hit.name,
          note: "filled, confirmation event did not arrive",
        };
      }
      return { ok: false, error: `order sent but the broker shows no position for it (${prepared.hit.name})` };
    }

    const filled = result.payload;
    return {
      ok: true,
      id: filled.position ? String(filled.position.positionId) : filled.order ? String(filled.order.orderId) : null,
      price: filled.deal && filled.deal.executionPrice != null ? Number(filled.deal.executionPrice) : null,
      lots: prepared.lots,
      volume: prepared.volume,
      symbol: prepared.hit.name,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function closeInstrument(config, symbol) {
  try {
    const state = await getSession(config);
    const hit = resolveSymbol(state, symbol);
    if (!hit) return { ok: false, error: `no symbol for ${symbol} at this broker` };

    const res = await state.client.request(PAYLOAD.RECONCILE_REQ, { ctidTraderAccountId: state.accountId });
    const positions = ((res.payload && res.payload.position) || []).filter(
      (position) => position.tradeData.symbolId === hit.symbolId
    );
    if (!positions.length) return { ok: false, error: `no open ${symbol} position at the broker` };

    const closed = [];
    for (const position of positions) {
      const execution = waitForExecution(state, { positionId: position.positionId });
      // Again: the acknowledgement is the execution event, not a response.
      state.client.send(PAYLOAD.CLOSE_POSITION_REQ, {
        ctidTraderAccountId: state.accountId,
        positionId: position.positionId,
        volume: position.tradeData.volume,
      });
      const result = await execution;
      let stillOpen = false;
      if (result.timedOut) {
        stillOpen = (await positionsFor(state, hit.symbolId)).some(
          (each) => each.positionId === position.positionId
        );
      }
      closed.push({
        positionId: String(position.positionId),
        ok: !result.rejected && !result.timedOut ? true : result.timedOut && !stillOpen,
        error: result.rejected ? result.error : result.timedOut && stillOpen ? "no close confirmation" : null,
      });
    }
    const failed = closed.filter((row) => !row.ok);
    if (failed.length) return { ok: false, error: failed.map((row) => row.error).join("; "), closed };
    return { ok: true, closed: closed.map((row) => row.positionId) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function test(config) {
  return account(config);
}

/* ------------------------------------------------------------------ tokens -- */

/**
 * Exchange a refresh token for a fresh access token. Tokens last about a month,
 * so this is the one thing that keeps a cloud deployment running without anyone
 * pasting a new token every few weeks. The result is persisted server-side.
 */
async function refreshTokens(cfg) {
  const query = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: cfg.refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  try {
    const res = await fetch(`https://openapi.ctrader.com/apps/token?${query.toString()}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.accessToken) {
      return { ok: false, error: data.error_description || data.error || `token endpoint returned ${res.status}` };
    }
    try {
      settings.setExecConfig({
        direct: { token: data.accessToken, refreshToken: data.refreshToken || cfg.refreshToken },
      });
    } catch {
      // Persisting is best-effort; the session still works with the new token.
    }
    return { ok: true, accessToken: data.accessToken, refreshToken: data.refreshToken || cfg.refreshToken };
  } catch (err) {
    return { ok: false, error: `token refresh failed: ${err.message}` };
  }
}

/* ------------------------------------------------------ oauth handshake -- */

const CONSENT_URL = "https://id.ctrader.com/my/settings/openapi/grantingaccess/";

/**
 * The page the user approves. `scope=trading` is not decoration: with
 * `accounts` the token can read a balance and never place an order.
 */
function consentUrl({ clientId, redirectUri, state }) {
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "trading",
    product: "web",
  });
  if (state) query.set("state", state);
  return `${CONSENT_URL}?${query.toString()}`;
}

/**
 * Redeem the one-time authorisation code. It lives for about sixty seconds and
 * works once, so this has to be called the moment the browser comes back.
 */
async function exchangeCode({ clientId, clientSecret, redirectUri, code }) {
  const query = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const tokenUrl = process.env.CTRADER_TOKEN_URL || "https://openapi.ctrader.com/apps/token";
  try {
    const res = await fetch(`${tokenUrl}?${query.toString()}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.accessToken) {
      return {
        ok: false,
        error: data.error_description || data.error || `the token endpoint returned ${res.status}`,
      };
    }
    return {
      ok: true,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || "",
      expiresIn: data.expiresIn,
    };
  } catch (err) {
    return { ok: false, error: `could not reach the token endpoint: ${err.message}` };
  }
}

function reset() {
  for (const session of sessions.values()) {
    session.then((state) => {
      if (state.heartbeat) clearInterval(state.heartbeat);
      state.client.close();
    }).catch(() => {});
  }
  sessions.clear();
}

module.exports = {
  name: NAME,
  environmentKey: "ctrader",
  configured,
  account,
  listAccounts,
  openTrades,
  pricing,
  place,
  closeInstrument,
  test,
  refreshTokens,
  consentUrl,
  exchangeCode,
  // Exposed for the executor's size check: cTrader answers in its own symbol
  // metadata, so a static units-per-lot table would be a guess. Returning null
  // tells the executor to let the broker judge the size.
  unitsPerLot: () => null,
  // Test seams.
  __setTransportFactory,
  __reset: reset,
  __volumeFor: volumeFor,
  __normalizeName: normalizeName,
};
