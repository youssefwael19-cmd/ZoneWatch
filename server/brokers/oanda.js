/**
 * OANDA v20 — a direct execution backend, for accounts with no terminal at all.
 *
 * Why it exists: the MT5 bridge needs a Windows machine that stays awake,
 * because MetaTrader's Python package only speaks to a terminal on the same
 * host. A broker with a real HTTP API removes that entire machine. The app
 * calls it straight from the cloud, the broker holds the stop and the target,
 * and nothing needs to stay on at home.
 *
 * Everything here is one file per broker on purpose (see ./index.js): the
 * executor does not care which one is configured, so adding another is a new
 * file and a registry entry, not a rewrite.
 *
 * Practice and live are different hosts with the same shapes:
 *   practice  https://api-fxpractice.oanda.com
 *   live      https://api-fxtrade.oanda.com
 *
 * Units matter: OANDA trades in units, not lots. 1 lot of gold is 100 ounces,
 * 1 lot of FX is 100,000 units, and 1 lot of the index is 1 unit. Sizes below
 * the broker's minimum are refused rather than rounded up, because rounding up
 * would quietly multiply the risk the app promised to cap.
 */

const BASE = {
  practice: "https://api-fxpractice.oanda.com",
  live: "https://api-fxtrade.oanda.com",
};

// App symbol -> OANDA instrument. Anything else six letters long is treated as
// an FX pair and split (EURUSD -> EUR_USD).
const INSTRUMENTS = {
  XAUUSD: "XAU_USD",
  NASDAQ: "NAS100_USD",
};

const UNITS_PER_LOT = {
  XAUUSD: 100,
  NASDAQ: 1,
};
const FX_UNITS_PER_LOT = 100000;

const NAME = "OANDA (v20 REST)";

function instrumentFor(symbol) {
  const key = String(symbol || "").toUpperCase();
  if (INSTRUMENTS[key]) return INSTRUMENTS[key];
  if (/^[A-Z]{6}$/.test(key)) return `${key.slice(0, 3)}_${key.slice(3)}`;
  return key;
}

function symbolFor(instrument) {
  const name = String(instrument || "").toUpperCase();
  for (const [symbol, mapped] of Object.entries(INSTRUMENTS)) {
    if (mapped === name) return symbol;
  }
  if (/^[A-Z]{3}_[A-Z]{3}$/.test(name)) return name.replace("_", "");
  return name;
}

function unitsPerLot(symbol) {
  const key = String(symbol || "").toUpperCase();
  return UNITS_PER_LOT[key] || FX_UNITS_PER_LOT;
}

function settingsFor(config) {
  const direct = (config && config.direct) || {};
  const environment = direct.environment === "live" ? "live" : "practice";
  // baseUrl exists so the same code can be pointed at a gateway or a test
  // double; in normal use it is empty and the official host is used.
  const base = direct.baseUrl ? String(direct.baseUrl).replace(/\/$/, "") : BASE[environment];
  return {
    token: direct.token || "",
    accountId: direct.accountId || "",
    environment,
    base,
  };
}

/** One place for auth, timeouts and JSON so every call fails the same way. */
async function call(config, path, { method = "GET", body, timeout = 15000 } = {}) {
  const s = settingsFor(config);
  if (!s.token) return { ok: false, error: "no broker API token configured" };
  if (!s.accountId) return { ok: false, error: "no broker account ID configured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${s.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${s.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data.errorMessage || data.errorCode || `HTTP ${res.status}`;
      return { ok: false, error: String(detail).slice(0, 300), status: res.status };
    }
    return { ok: true, data };
  } catch (err) {
    const reason = err.name === "AbortError" ? "timed out" : err.message;
    return { ok: false, error: `broker unreachable: ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

async function summary(config) {
  const s = settingsFor(config);
  const res = await call(config, `/v3/accounts/${encodeURIComponent(s.accountId)}/summary`);
  if (!res.ok) return res;
  const account = (res.data && res.data.account) || {};
  return {
    ok: true,
    account: {
      login: account.alias || account.id || s.accountId,
      server: `OANDA ${s.environment}`,
      currency: account.currency || "USD",
      balance: Number(account.balance),
      equity: Number(account.NAV),
      demo: s.environment === "practice",
    },
  };
}

/** Open trades in the app's shape, so the panel reads the same for any broker. */
async function openTrades(config) {
  const s = settingsFor(config);
  const res = await call(config, `/v3/accounts/${encodeURIComponent(s.accountId)}/openTrades`);
  if (!res.ok) return res;
  const trades = (res.data && res.data.trades) || [];
  return {
    ok: true,
    trades: trades.map((t) => {
      const units = Number(t.currentUnits);
      return {
        ticket: t.id,
        symbol: symbolFor(t.instrument),
        side: units < 0 ? "SELL" : "BUY",
        lots: Number((Math.abs(units) / unitsPerLot(symbolFor(t.instrument))).toFixed(2)),
        units: Math.abs(units),
        entry: Number(t.price),
        sl: t.stopLossOrder ? Number(t.stopLossOrder.price) : null,
        tp: t.takeProfitOrder ? Number(t.takeProfitOrder.price) : null,
        profit: t.unrealizedPL != null ? Number(t.unrealizedPL) : null,
      };
    }),
  };
}

async function account(config) {
  const [summaryRes, tradesRes] = await Promise.all([summary(config), openTrades(config)]);
  if (!summaryRes.ok) return summaryRes;
  const acc = summaryRes.account;
  return {
    ok: true,
    account: {
      ...acc,
      balance: Number.isFinite(acc.balance) ? Number(acc.balance.toFixed(2)) : null,
      equity: Number.isFinite(acc.equity) ? Number(acc.equity.toFixed(2)) : null,
      positions: tradesRes.ok ? tradesRes.trades.slice(0, 25) : [],
    },
  };
}

/**
 * Live spreads, in price units, in the same shape the bridge returns.
 * OANDA quotes bid/ask per instrument; the spread is the difference.
 */
async function pricing(config, symbols) {
  const s = settingsFor(config);
  const list = (symbols || []).map(instrumentFor);
  if (!list.length) return { ok: true, spreads: {} };

  const spreads = {};
  for (let i = 0; i < list.length; i += 10) {
    const chunk = list.slice(i, i + 10);
    const res = await call(
      config,
      `/v3/accounts/${encodeURIComponent(s.accountId)}/pricing?instruments=${encodeURIComponent(chunk.join(","))}`
    );
    if (!res.ok) return res;
    const at = new Date().toISOString();
    for (const price of res.data.prices || []) {
      const bid = Number(price.bids && price.bids[0] && price.bids[0].price);
      const ask = Number(price.asks && price.asks[0] && price.asks[0].price);
      if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask < bid) continue;
      spreads[symbolFor(price.instrument)] = {
        price: Number((ask - bid).toFixed(5)),
        points: null,
        bid,
        ask,
        at,
      };
    }
  }
  return { ok: true, spreads };
}

/** Place a market order with the stop and target attached at the broker. */
async function place(config, order) {
  const s = settingsFor(config);
  const units = Math.round(Number(order.lots) * unitsPerLot(order.symbol));
  if (!(units >= 1)) {
    return { ok: false, error: `size below the broker minimum (${units} units)` };
  }
  const signed = order.side === "SELL" ? -units : units;
  const body = {
    order: {
      type: "MARKET",
      instrument: instrumentFor(order.symbol),
      units: String(signed),
      timeInForce: "FOK",
      positionFill: "DEFAULT",
      // The broker holds the exits, so they survive this process dying.
      stopLossOnFill: { price: Number(order.stop).toFixed(5) },
      takeProfitOnFill: { price: Number(order.target).toFixed(5) },
      clientExtensions: { tag: "zone-watch" },
    },
  };

  const res = await call(config, `/v3/accounts/${encodeURIComponent(s.accountId)}/orders`, {
    method: "POST",
    body,
  });
  if (!res.ok) return res;
  const fill = (res.data && res.data.orderFillTransaction) || {};
  if (!fill.id && !fill.orderID) {
    // A FOK order that did not fill leaves no fill transaction, which is a
    // refusal in everything but name.
    return { ok: false, error: "order was not filled" };
  }
  return {
    ok: true,
    id: fill.orderID || fill.id,
    // The broker's own trade id, distinct from the order id. Moving a stop acts
    // on the trade, so this is the handle a trailing stop needs.
    tradeId: fill.tradeOpened && fill.tradeOpened.tradeID ? String(fill.tradeOpened.tradeID) : null,
    price: fill.price != null ? Number(fill.price) : null,
    units: Math.abs(Number(fill.units) || units),
  };
}

/**
 * Move the stop on a trade the broker already holds.
 *
 * PUT on a trade's orders creates the stop if there is none and replaces it if
 * there is, which is exactly what the stop ladder needs: the stop only ever
 * moves up, so replacing is the whole operation.
 */
async function modifyStop(config, { tradeId, symbol, side, stop }) {
  const s = settingsFor(config);
  if (!(Number(stop) > 0)) return { ok: false, error: "no stop price to send" };

  let id = tradeId ? String(tradeId) : "";
  if (!id) {
    // A position opened before trade ids were recorded has none; ask the broker
    // which trade it is rather than refusing to protect it.
    const open = await openTrades(config);
    if (!open.ok) return open;
    const match = open.trades.find(
      (t) => t.symbol === symbol && (!side || t.side === side)
    );
    if (!match) return { ok: false, error: `no open ${symbol} trade at the broker to amend` };
    id = match.ticket;
  }

  const res = await call(
    config,
    `/v3/accounts/${encodeURIComponent(s.accountId)}/trades/${encodeURIComponent(id)}/orders`,
    {
      method: "PUT",
      body: { stopLoss: { price: Number(stop).toFixed(5), timeInForce: "GTC" } },
    }
  );
  if (!res.ok) return res;
  const tx = (res.data && res.data.stopLossOrderTransaction) || {};
  if (!tx.id) return { ok: false, error: "broker accepted the amend but returned no stop order" };
  return { ok: true, tradeId: id, stop: tx.price != null ? Number(tx.price) : Number(stop) };
}

/** Close whatever the broker holds on one instrument, long or short. */
async function closeInstrument(config, symbol) {
  const s = settingsFor(config);
  const open = await openTrades(config);
  if (!open.ok) return open;
  const trades = open.trades.filter((t) => t.symbol === symbol);
  if (!trades.length) return { ok: false, error: `no open ${symbol} position at the broker` };
  const side = trades[0].side === "SELL" ? "shortUnits" : "longUnits";

  const res = await call(
    config,
    `/v3/accounts/${encodeURIComponent(s.accountId)}/positions/${encodeURIComponent(instrumentFor(symbol))}/close`,
    { method: "PUT", body: { [side]: "ALL" } }
  );
  if (!res.ok) return res;
  return { ok: true, closed: trades.map((t) => t.ticket) };
}

/** Close everything the broker holds — used when the kill switch means it. */
async function closeAll(config) {
  const open = await openTrades(config);
  if (!open.ok) return open;
  const results = [];
  for (const symbol of [...new Set(open.trades.map((t) => t.symbol))]) {
    results.push({ symbol, ...(await closeInstrument(config, symbol)) });
  }
  return { ok: true, results };
}

/** Does the token work and does the account exist? */
async function test(config) {
  const res = await account(config);
  if (!res.ok) return res;
  return { ok: true, broker: res.account };
}

module.exports = {
  name: NAME,
  environmentKey: "oanda",
  instrumentFor,
  symbolFor,
  unitsPerLot,
  account,
  summary,
  openTrades,
  pricing,
  place,
  modifyStop,
  closeInstrument,
  closeAll,
  test,
};
