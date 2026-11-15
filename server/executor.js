/**
 * The executor: turns an alert into an order, with the guards that make it
 * survivable.
 *
 * Two modes:
 *   paper  — nothing leaves the app. Orders are filled at the signal price and
 *            resolved against live quotes, so the whole chain (sizing, stops,
 *            limits) can be proved before any real money is involved.
 *   bridge — a POST to a small service running on the machine that has
 *            MetaTrader 5 open and logged in (see bridge/mt5_bridge.py). MT5
 *            has no public REST API and its Python package is Windows-only, so
 *            the terminal has to live somewhere and be spoken to.
 *
 * The guards are deliberately absolute — every one of them can only ever
 * refuse an order, never invent one:
 *   - off by default
 *   - nothing at all while the brain gate is silent for that market
 *   - 0.5% of equity risked per trade, sized from the real stop distance
 *   - a hard daily loss limit, after which it stops for the rest of the day
 *   - a maximum number of open positions
 *   - one position per market at a time
 *   - a kill switch that survives restarts
 */

const fs = require("fs");
const path = require("path");
const settings = require("./settings");

const FILE = path.join(__dirname, "..", "executor.json");

// Rough value of one unit of price for one lot, per instrument family. Used to
// convert a stop distance into a position size. Exness contract sizes vary by
// account type, so this is deliberately conservative and adjustable.
const VALUE_PER_UNIT = {
  XAUUSD: 100,
  GOLD: 100,
  NASDAQ: 1,
  US100: 1,
  USTEC: 1,
};
const FX_VALUE_PER_UNIT = 100000;

// Exness appends a suffix to instrument names (XAUUSDm, EURUSDm ...) and calls
// the Nasdaq something else entirely. Overridable in settings.
const EXNESS_NAMES = { NASDAQ: "USTEC" };

function readState() {
  try {
    const raw = fs.readFileSync(FILE, "utf-8").trim();
    if (!raw) return fresh();
    const parsed = JSON.parse(raw);
    return { ...fresh(), ...parsed };
  } catch {
    return fresh();
  }
}

function fresh() {
  return {
    balance: null,
    open: [],
    closed: [],
    dayKey: null,
    dayRealized: 0,
    killedAt: null,
    killReason: null,
    lastError: null,
    lastOrderAt: null,
  };
}

function writeState(state) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(state, null, 1), "utf-8");
  } catch (err) {
    state.lastError = `could not save executor state: ${err.message}`;
  }
}

function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function equity(state, priceBySymbol) {
  const start = Number(state.balance ?? settings.getExecConfig().accountBalance) || 0;
  let floating = 0;
  for (const pos of state.open) {
    const price = priceOf(priceBySymbol, pos.symbol);
    if (!Number.isFinite(price)) continue;
    floating += pnlOf(pos, price);
  }
  return Number((start + state.dayRealizedTotal + floating).toFixed(2));
}

function priceOf(priceBySymbol, symbol) {
  if (!priceBySymbol) return NaN;
  return priceBySymbol instanceof Map ? priceBySymbol.get(symbol) : priceBySymbol[symbol];
}

function valuePerUnit(symbol) {
  const config = settings.getExecConfig();
  const override = config.valuePerUnit && config.valuePerUnit[symbol];
  if (Number.isFinite(override)) return override;
  if (VALUE_PER_UNIT[symbol]) return VALUE_PER_UNIT[symbol];
  return FX_VALUE_PER_UNIT;
}

function pnlOf(pos, price) {
  const move = pos.side === "BUY" ? price - pos.entry : pos.entry - price;
  return move * pos.lots * pos.valuePerUnit;
}

/**
 * Exness instrument name for an app symbol.
 *
 * Exness names carry an account-type suffix (XAUUSDm, EURUSDm). Overrides give
 * the base name only, and the suffix is applied to those too — a name that
 * already ends with the suffix is left alone, so a fully qualified name like
 * "USTEC.cash" is not mangled.
 */
function brokerSymbol(symbol) {
  const config = settings.getExecConfig();
  const overrides = config.symbolOverrides || {};
  const suffix = config.symbolSuffix ?? "";
  const base = overrides[symbol] || EXNESS_NAMES[symbol] || symbol;
  // A qualified name (anything with a dot, e.g. USTEC.cash) is used verbatim.
  if (!suffix || base.includes(".") || base.endsWith(suffix)) return base;
  return `${base}${suffix}`;
}

/**
 * Why an order must not be sent. Returns a reason string, or null if it may.
 * Order matters: the cheapest and most absolute checks come first.
 */
function refusal(signal, state, priceBySymbol) {
  const config = settings.getExecConfig();

  if (!config.enabled) return "auto-trading is switched off";
  if (state.killedAt) return `kill switch is on${state.killReason ? `: ${state.killReason}` : ""}`;
  if (!signal || !signal.symbol) return "no signal";
  if (!["BUY", "SELL"].includes(signal.side)) return "signal has no direction";

  const entry = Number(signal.entry ?? signal.price);
  const stop = Number(signal.stop);
  const target = Number(signal.target);
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(target)) {
    return "signal is missing entry, stop or target";
  }
  if (entry === stop) return "stop equals entry";

  // The gate is re-checked here on purpose: a signal reaching the executor by
  // any other path still cannot bypass "is there a proven rule right now".
  if (config.requireGate) {
    const gate = signal.gate;
    if (!gate || gate.blocked) return "brain gate has not approved this market";
  }

  if (state.open.length >= (config.maxPositions || 2)) {
    return `already holding ${state.open.length} position(s)`;
  }
  if (state.open.some((p) => p.symbol === signal.symbol)) {
    return `already holding ${signal.symbol}`;
  }

  const limit = Number(config.maxDailyLossPct || 2);
  const startEquity = Number(state.balance ?? config.accountBalance) || 1;
  const lossPct = (-state.dayRealized / startEquity) * 100;
  if (lossPct >= limit) return `daily loss limit reached (${lossPct.toFixed(2)}%)`;

  if (!Number.isFinite(priceOf(priceBySymbol, signal.symbol))) {
    // Paper fills are honest about this: without a current price there is no
    // fill to record.
    return "no current price for this market";
  }

  return null;
}

/** Position size from the risk budget and the real stop distance. */
function sizeFor(signal, equityNow) {
  const config = settings.getExecConfig();
  const riskPct = Number(config.riskPct ?? 0.5);
  const riskAmount = (equityNow * riskPct) / 100;

  const entry = Number(signal.entry ?? signal.price);
  const stop = Number(signal.stop);
  const perUnit = valuePerUnit(signal.symbol);
  const stopDistance = Math.abs(entry - stop);
  if (!(stopDistance > 0) || !(perUnit > 0)) return null;

  const rawLots = riskAmount / (stopDistance * perUnit);
  // 0.01 is the smallest size most retail accounts accept.
  const lots = Math.max(0.01, Math.floor(rawLots * 100) / 100);
  const riskMoney = Number((stopDistance * perUnit * lots).toFixed(2));
  const riskPctActual = Number(((riskMoney / equityNow) * 100).toFixed(2));

  return { lots, riskAmount: Number(riskAmount.toFixed(2)), riskMoney, riskPctActual, stopDistance };
}

/**
 * Place an order for a signal. Returns { ok, reason, order }.
 * Nothing is recorded unless the order genuinely succeeded.
 */
async function place(signal, priceBySymbol) {
  const config = settings.getExecConfig();
  const state = readState();
  rollDay(state);

  const block = refusal(signal, state, priceBySymbol);
  if (block) return { ok: false, reason: block, mode: config.mode };

  if (state.balance == null) state.balance = Number(config.accountBalance) || 1000;
  const equityNow = equity(state, priceBySymbol);
  const size = sizeFor(signal, equityNow);
  if (!size) return { ok: false, reason: "could not size the position" };

  const order = {
    id: `${signal.symbol}-${Date.now()}`,
    symbol: signal.symbol,
    brokerSymbol: brokerSymbol(signal.symbol),
    side: signal.side,
    lots: size.lots,
    entry: Number(signal.entry ?? signal.price),
    signalEntry: Number(signal.entry ?? signal.price),
    stop: Number(signal.stop),
    target: Number(signal.target),
    riskMoney: size.riskMoney,
    riskPct: size.riskPctActual,
    valuePerUnit: valuePerUnit(signal.symbol),
    mode: config.mode,
    openedAt: new Date().toISOString(),
    signalAt: signal.at || null,
    condition: (signal.gate && signal.gate.condition) || null,
    family: (signal.gate && signal.gate.verdict && signal.gate.verdict.family) || null,
  };

  if (config.mode === "bridge") {
    const sent = await sendToBridge(order);
    if (!sent.ok) {
      state.lastError = sent.reason;
      writeState(state);
      return { ok: false, reason: sent.reason, mode: config.mode };
    }
    order.bridgeTicket = sent.ticket || null;
  } else {
    // Paper: filled at the price the alert was based on plus a spread charge,
    // so paper results are not flattered.
    const spread = sizeValue(order, order.entry) * 0.00002;
    order.entry = Number((order.entry + (order.side === "BUY" ? spread : -spread)).toFixed(5));
  }

  state.open.push(order);
  state.lastOrderAt = order.openedAt;
  state.lastError = null;
  writeState(state);
  return { ok: true, order, mode: config.mode };
}

function sizeValue(order, price) {
  return Math.abs(price) * order.lots;
}

async function sendToBridge(order) {
  const config = settings.getExecConfig();
  if (!config.bridgeUrl) return { ok: false, reason: "no bridge URL configured" };
  if (!config.bridgeSecret) return { ok: false, reason: "no bridge secret configured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${config.bridgeUrl.replace(/\/$/, "")}/order`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-token": config.bridgeSecret,
      },
      body: JSON.stringify({
        symbol: order.brokerSymbol,
        side: order.side,
        lots: order.lots,
        sl: order.stop,
        tp: order.target,
        comment: "zone-watch",
      }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok !== true) {
      return { ok: false, reason: `bridge refused: ${data.error || res.status}` };
    }
    return { ok: true, ticket: data.ticket || null };
  } catch (err) {
    return { ok: false, reason: `bridge unreachable: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mark open positions against live quotes. Stop wins ties, as everywhere else
 * in this app.
 */
function mark(priceBySymbol) {
  const state = readState();
  const config = settings.getExecConfig();
  rollDay(state);
  if (!state.open.length) return { closed: [] };

  const stillOpen = [];
  const closed = [];

  for (const pos of state.open) {
    const price = priceOf(priceBySymbol, pos.symbol);
    if (!Number.isFinite(price)) {
      stillOpen.push(pos);
      continue;
    }

    const hitStop = pos.side === "BUY" ? price <= pos.stop : price >= pos.stop;
    const hitTarget = pos.side === "BUY" ? price >= pos.target : price <= pos.target;

    if (hitStop || hitTarget) {
      const exit = hitStop ? pos.stop : pos.target;
      const pnl = Number(pnlOf(pos, exit).toFixed(2));
      closed.push({ ...pos, exit, pnl, outcome: hitStop ? "loss" : "win", closedAt: new Date().toISOString() });
      state.dayRealized += pnl;
    } else {
      stillOpen.push({ ...pos, lastPrice: price, floating: Number(pnlOf(pos, price).toFixed(2)) });
    }
  }

  if (closed.length) {
    state.open = stillOpen;
    state.closed.push(...closed);
    // Realised profit is folded straight into the balance, so equity stays a
    // single number rather than a pile of running totals.
    state.dayRealizedTotal = 0;
    state.balance = Number((state.balance + closed.reduce((a, c) => a + c.pnl, 0)).toFixed(2));
    writeState(state);

    if (state.closed.length > 500) state.closed = state.closed.slice(-500);
  } else if (stillOpen.some((p) => p.floating != null)) {
    state.open = stillOpen;
    writeState(state);
  }

  const limit = Number(config.maxDailyLossPct || 2);
  const startEquity = Number(state.balance ?? config.accountBalance) || 1;
  if ((state.dayRealized / startEquity) * 100 <= -limit && !state.killedAt) {
    state.killedAt = new Date().toISOString();
    state.killReason = `daily loss limit reached (${((state.dayRealized / startEquity) * 100).toFixed(2)}%)`;
    writeState(state);
  }

  return { closed };
}

function rollDay(state) {
  const key = todayKey();
  if (state.dayKey !== key) {
    state.dayKey = key;
    state.dayRealized = 0;
    state.dayRealizedTotal = 0;
  }
  return state;
}

function kill(reason = "switched off by hand") {
  const state = readState();
  state.killedAt = new Date().toISOString();
  state.killReason = reason;
  writeState(state);
  return status();
}

function revive() {
  const state = readState();
  state.killedAt = null;
  state.killReason = null;
  writeState(state);
  return status();
}

function status(priceBySymbol) {
  const state = readState();
  const config = settings.getExecConfig();
  const startEquity = Number(state.balance ?? config.accountBalance) || 0;
  const eq = equity(state, priceBySymbol);
  const dayPct = ((state.dayRealized + 0) / (startEquity || 1)) * 100;

  return {
    enabled: Boolean(config.enabled),
    mode: config.mode,
    riskPct: config.riskPct,
    maxDailyLossPct: config.maxDailyLossPct,
    maxPositions: config.maxPositions,
    killSwitch: Boolean(state.killedAt),
    killReason: state.killReason,
    balance: state.balance == null ? null : Number(state.balance.toFixed(2)),
    equity: eq,
    dayRealized: Number(state.dayRealized.toFixed(2)),
    dayRealizedPct: Number(dayPct.toFixed(2)),
    open: state.open,
    openCount: state.open.length,
    closedCount: state.closed.length,
    closed: state.closed.slice(-20).reverse(),
    lastOrderAt: state.lastOrderAt,
    lastError: state.lastError,
    bridgeUrl: config.bridgeUrl ? `${config.bridgeUrl.replace(/\/$/, "")}` : "",
    bridgeConfigured: Boolean(config.bridgeUrl && config.bridgeSecret),
    broker: "Exness (MT5)",
    warning:
      "Auto-trading can lose real money. It places orders the app believes in, and the app can be wrong. Keep it on a demo account until the journal has enough closed trades to argue otherwise.",
  };
}

/** Is the bridge alive and logged into the account? */
async function testBridge() {
  const config = settings.getExecConfig();
  if (!config.bridgeUrl) return { ok: false, error: "no bridge URL configured" };
  if (!config.bridgeSecret) return { ok: false, error: "no bridge secret configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${config.bridgeUrl.replace(/\/$/, "")}/health`, {
      headers: { "x-bridge-token": config.bridgeSecret },
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `bridge returned ${res.status}` };
    return { ok: true, bridge: data };
  } catch (err) {
    return { ok: false, error: `bridge unreachable: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { place, mark, status, kill, revive, testBridge, brokerSymbol, sizeFor, refusal };
