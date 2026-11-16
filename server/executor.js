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
 *   direct — the broker's own REST API (see server/brokers), for an account
 *            with no terminal at all. The app places the order from the cloud
 *            and the broker holds the stop and target, so nothing has to stay
 *            switched on at home. Same guards, same sizing, same ledger.
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
const costsMod = require("./costs");
const market = require("./market");
const brokers = require("./brokers");

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
    // Last real account snapshot read from Exness through the bridge.
    account: null,
    // Live spreads read from the broker: symbol -> { price, points, at }.
    spreads: {},
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
  const config = settings.getExecConfig();
  // In bridge mode the broker's own equity is the truth, so it wins whenever we
  // have a recent reading. Everything else is the app's own ledger.
  if (config.mode === "bridge" || config.mode === "direct") {
    const broker = brokerEquity(state);
    if (broker != null) return Number(broker.toFixed(2));
  }
  const start = Number(state.balance ?? config.accountBalance) || 0;
  let floating = 0;
  for (const pos of state.open) {
    const price = priceOf(priceBySymbol, pos.symbol);
    if (!Number.isFinite(price)) continue;
    floating += pnlOf(pos, price) - (pos.cost || 0);
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
  // A TradingView alert carries no measured rule, so it is the one case with
  // its own switch — and that switch defaults to requiring the gate anyway.
  if (config.requireGate) {
    const tvBypass =
      signal.source === "tradingview" && config.tv && config.tv.requireGate === false;
    if (!tvBypass) {
      const gate = signal.gate;
      if (!gate || gate.blocked) return "brain gate has not approved this market";
    }
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

  // A direct API fills in units, not lots, and a fraction of its minimum is
  // simply rejected. Refuse here instead of rounding up: rounding up would
  // quietly multiply the risk this limit exists to cap.
  if (settings.getExecConfig().mode === "direct") {
    const perLot = brokers.unitsPerLot(signal.symbol, settings.getExecConfig());
    const minLots = perLot > 0 ? 1 / perLot : 0;
    if (minLots > 0 && lots < minLots) {
      const riskAtMin = Number((stopDistance * perUnit * minLots).toFixed(2));
      const pct = Number(((riskAtMin / equityNow) * 100).toFixed(2));
      return {
        refused: `broker minimum is ${minLots} lots (${riskAtMin} of risk, ${pct}% of equity), above the ${riskPct}% limit`,
      };
    }
  }
  const riskMoney = Number((stopDistance * perUnit * lots).toFixed(2));
  const riskPctActual = Number(((riskMoney / equityNow) * 100).toFixed(2));

  return { lots, riskAmount: Number(riskAmount.toFixed(2)), riskMoney, riskPctActual, stopDistance };
}

/**
 * The account's own equity, when the broker has told us. Sizing off the real
 * balance is the whole point of reading the account: a 0.5% risk on a demo
 * figure is not the same trade as 0.5% of what is actually there.
 */
const ACCOUNT_FRESH_MS = 15 * 60 * 1000;
const ACCOUNT_SYNC_MS = 5 * 60 * 1000;
let lastSyncAt = 0;

function brokerEquity(state) {
  const account = state.account;
  if (!account || !Number.isFinite(account.equity) || !account.syncedAt) return null;
  // A stale reading is worse than no reading: sizing off an old balance is
  // exactly the kind of quiet error this app is supposed to refuse.
  if (Date.now() - new Date(account.syncedAt).getTime() > ACCOUNT_FRESH_MS) return null;
  return account.equity;
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
  if (size.refused) return { ok: false, reason: size.refused, mode: config.mode };

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
    source: signal.source || "zone-watch",
  };

  // The broker is paid before the trade can pay you: entry half-spread plus
  // round-turn commission. Charged on the order, so equity reflects it at once.
  const entryCost = costsMod.entryCost({
    symbol: order.symbol,
    lots: order.lots,
    valuePerUnit: order.valuePerUnit,
    config,
    live: state.spreads,
  });
  order.cost = entryCost.total;
  order.costDetail = entryCost;

  if (config.mode === "bridge") {
    const sent = await sendToBridge(order);
    if (!sent.ok) {
      state.lastError = sent.reason;
      writeState(state);
      return { ok: false, reason: sent.reason, mode: config.mode };
    }
    order.bridgeTicket = sent.ticket || null;
  }

  if (config.mode === "direct") {
    const sent = await sendToBroker(order);
    if (!sent.ok) {
      state.lastError = sent.reason;
      writeState(state);
      return { ok: false, reason: sent.reason, mode: config.mode };
    }
    order.brokerOrderId = sent.id || null;
    order.brokerFillPrice = Number.isFinite(sent.price) ? sent.price : null;
  }
  // Paper fills at the signal price and pays the modelled broker costs, so it
  // is not flattered by an impossible fill or by free trading.

  state.open.push(order);
  state.lastOrderAt = order.openedAt;
  state.lastError = null;
  writeState(state);
  return { ok: true, order, mode: config.mode };
}

async function sendToBroker(order) {
  const config = settings.getExecConfig();
  const provider = brokers.get(config);
  if (!provider) return { ok: false, reason: "no direct broker configured" };
  const result = await provider.place(config, {
    symbol: order.symbol,
    side: order.side,
    lots: order.lots,
    stop: order.stop,
    target: order.target,
  });
  if (!result.ok) return { ok: false, reason: `broker refused: ${result.error}` };
  return { ok: true, id: result.id, price: result.price };
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
 * Record a position as closed at `exit`, charging the exit half of the spread
 * and any swap. Shared by the app's own stop/target resolution (paper, bridge)
 * and by reconciliation after a broker closed the trade itself (direct), so a
 * position costs the same whichever path closed it.
 */
function settle(state, pos, exit, outcome, note) {
  const config = settings.getExecConfig();
  const grossPnl = Number(pnlOf(pos, exit).toFixed(2));
  const heldMs = Date.now() - new Date(pos.openedAt).getTime();
  const nights = Number.isFinite(heldMs) ? Math.max(0, Math.floor(heldMs / 86400000)) : 0;
  const exitCost = costsMod.exitCost({
    symbol: pos.symbol,
    lots: pos.lots,
    valuePerUnit: pos.valuePerUnit,
    nights,
    config,
    live: state.spreads,
  });
  const cost = Number(((pos.cost || 0) + exitCost.total).toFixed(2));
  const pnl = Number((grossPnl - cost).toFixed(2));
  state.dayRealized += pnl;

  const record = {
    ...pos,
    exit,
    grossPnl,
    cost,
    costDetail: { ...(pos.costDetail || {}), exit: exitCost },
    nights,
    pnl,
    outcome: outcome || (pnl >= 0 ? "win" : "loss"),
    closedAt: new Date().toISOString(),
  };
  if (note) record.note = note;
  return record;
}

/**
 * Mark open positions against live quotes. Stop wins ties, as everywhere else
 * in this app.
 *
 * In direct mode the broker holds the stop and the target, so this only
 * refreshes the floating figure — closing a position here could sell something
 * already closed, or keep something the broker has already flattened.
 * reconcile() is what notices those.
 */
function mark(priceBySymbol) {
  const state = readState();
  const config = settings.getExecConfig();
  rollDay(state);
  if (!state.open.length) return { closed: [] };

  const direct = config.mode === "direct";
  const stillOpen = [];
  const closed = [];

  for (const pos of state.open) {
    const price = priceOf(priceBySymbol, pos.symbol);
    if (!Number.isFinite(price)) {
      stillOpen.push(pos);
      continue;
    }

    if (!direct) {
      const hitStop = pos.side === "BUY" ? price <= pos.stop : price >= pos.stop;
      const hitTarget = pos.side === "BUY" ? price >= pos.target : price <= pos.target;
      if (hitStop || hitTarget) {
        closed.push(settle(state, pos, hitStop ? pos.stop : pos.target, hitStop ? "loss" : "win"));
        continue;
      }
    }

    stillOpen.push({
      ...pos,
      lastPrice: price,
      floating: Number((pnlOf(pos, price) - (pos.cost || 0)).toFixed(2)),
    });
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

/**
 * Ask the broker whether it still holds each of our positions.
 *
 * In direct mode the broker is the one that closes stops and targets, so the
 * app cannot know a trade ended until it asks. A local position the broker no
 * longer holds is settled at the current price, which is close enough to the
 * fill to keep the day's P&L honest — and it is labelled so the journal does
 * not pretend the exit was a precise tick.
 */
async function reconcile(priceBySymbol) {
  const config = settings.getExecConfig();
  if (config.mode !== "direct") return { closed: [] };

  const state = readState();
  rollDay(state);
  if (!state.open.length) return { closed: [] };

  const provider = brokers.get(config);
  if (!provider) return { closed: [], error: "no direct broker configured" };

  const live = await provider.openTrades(config);
  if (!live.ok) {
    state.lastError = live.error;
    writeState(state);
    return { closed: [], error: live.error };
  }

  // Brokers rename markets (NASDAQ is US100 at cTrader, NAS100_USD at OANDA),
  // so a position is matched by the broker's own ticket first and only then by
  // a normalised symbol. Matching on the app's symbol alone would declare a
  // live trade closed the moment the names differ.
  const heldIds = new Set(
    (live.trades || [])
      .map((trade) => String(trade.positionId != null ? trade.positionId : trade.ticket != null ? trade.ticket : trade.id != null ? trade.id : ""))
      .filter(Boolean)
  );
  const heldSymbols = new Set((live.trades || []).map((trade) => marketKey(trade.symbol)).filter(Boolean));
  const stillOpen = [];
  const closed = [];

  for (const pos of state.open) {
    const ticket = pos.brokerOrderId != null ? String(pos.brokerOrderId) : "";
    if ((ticket && heldIds.has(ticket)) || heldSymbols.has(marketKey(pos.symbol))) {
      stillOpen.push(pos);
      continue;
    }
    const price = priceOf(priceBySymbol, pos.symbol);
    const exit = Number.isFinite(price)
      ? price
      : Number.isFinite(pos.lastPrice)
        ? pos.lastPrice
        : pos.entry;
    closed.push(settle(state, pos, exit, null, "closed at the broker (stop or target)"));
  }

  if (closed.length) {
    state.open = stillOpen;
    state.closed.push(...closed);
    state.dayRealizedTotal = 0;
    state.balance = Number((state.balance + closed.reduce((a, c) => a + c.pnl, 0)).toFixed(2));
    if (state.closed.length > 500) state.closed = state.closed.slice(-500);
    writeState(state);
  }

  return { closed };
}

function marketKey(name) {
  return String(name || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
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
  // With a real broker the balance is the broker's, not the app's running
  // ledger: the broker already applied the fills and the P&L.
  const brokerBalance =
    (config.mode === "direct" || config.mode === "bridge") &&
    state.account &&
    Number.isFinite(Number(state.account.balance))
      ? Number(state.account.balance)
      : null;

  return {
    enabled: Boolean(config.enabled),
    mode: config.mode,
    riskPct: config.riskPct,
    maxDailyLossPct: config.maxDailyLossPct,
    maxPositions: config.maxPositions,
    killSwitch: Boolean(state.killedAt),
    killReason: state.killReason,
    balance:
      brokerBalance != null
        ? Number(brokerBalance.toFixed(2))
        : state.balance == null
          ? null
          : Number(state.balance.toFixed(2)),
    equity: eq,
    dayRealized: Number(state.dayRealized.toFixed(2)),
    dayRealizedPct: Number(dayPct.toFixed(2)),
    costs: costsMod.summarize(state.closed, config, state.spreads),
    open: state.open,
    openCount: state.open.length,
    closedCount: state.closed.length,
    closed: state.closed.slice(-20).reverse(),
    lastOrderAt: state.lastOrderAt,
    lastError: state.lastError,
    bridgeUrl: config.bridgeUrl ? `${config.bridgeUrl.replace(/\/$/, "")}` : "",
    bridgeConfigured: Boolean(config.bridgeUrl && config.bridgeSecret),
    account: state.account || null,
    accountSource: state.account ? "exness-mt5" : "app",
    spreads: state.spreads || {},
    spreadSource: Object.keys(state.spreads || {}).length ? "broker" : "model",
    tv: {
      enabled: Boolean(config.tv && config.tv.enabled),
      secretConfigured: Boolean(config.tv && config.tv.secret),
      requireGate: config.tv ? config.tv.requireGate !== false : true,
      endpoint: "/api/tv/webhook",
    },
    broker: config.mode === "direct" ? (brokers.get(config) || {}).name || "direct API" : "Exness (MT5)",
    direct: {
      provider: (config.direct || {}).provider || "",
      environment: (config.direct || {}).environment || "",
      accountId: (config.direct || {}).accountId || "",
      configured: brokers.configured(config),
      providers: brokers.list(),
    },
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

/**
 * Read the real account from Exness through the bridge: balance, equity,
 * currency, demo flag and the broker's own open positions.
 *
 * Deliberately read-only. It does not adopt the broker's positions into the
 * app's ledger, because two owners of the same position is how the daily loss
 * cap silently stops meaning anything. The app tracks what it opened; the
 * broker's list is what you check it against.
 */
async function syncAccount() {
  const config = settings.getExecConfig();

  if (config.mode === "direct") {
    const provider = brokers.get(config);
    if (!provider) return { ok: false, error: "no direct broker configured" };
    const result = await provider.account(config);
    if (!result.ok) return { ok: false, error: result.error, account: readState().account };
    const state = readState();
    state.account = { ...result.account, syncedAt: new Date().toISOString() };
    writeState(state);
    lastSyncAt = Date.now();
    return { ok: true, account: state.account };
  }

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
    if (!res.ok || data.ok !== true) {
      return {
        ok: false,
        error: data.error || `bridge returned ${res.status}`,
        account: readState().account,
      };
    }

    const state = readState();
    state.account = {
      login: data.login ?? null,
      server: data.server ?? null,
      currency: data.currency ?? null,
      balance: Number.isFinite(data.balance) ? data.balance : null,
      equity: Number.isFinite(data.equity) ? data.equity : null,
      demo: data.demo === true,
      positions: Array.isArray(data.positions) ? data.positions.slice(0, 25) : [],
      syncedAt: new Date().toISOString(),
    };
    writeState(state);
    lastSyncAt = Date.now();
    return { ok: true, account: state.account };
  } catch (err) {
    return { ok: false, error: `bridge unreachable: ${err.message}`, account: readState().account };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the account's live spread per market from the bridge. The broker's own
 * number beats the table in costs.js, which cannot know that gold spread has
 * tripled around a news release.
 */
async function syncSpreads() {
  const config = settings.getExecConfig();

  if (config.mode === "direct") {
    const provider = brokers.get(config);
    if (!provider) return { ok: false, error: "no direct broker configured" };
    const symbols = market.instrumentList().map((inst) => inst.symbol);
    const result = await provider.pricing(config, symbols);
    if (!result.ok) return { ok: false, error: result.error };
    const state = readState();
    state.spreads = result.spreads;
    writeState(state);
    return { ok: true, spreads: result.spreads, at: new Date().toISOString() };
  }

  if (!config.bridgeUrl) return { ok: false, error: "no bridge URL configured" };
  if (!config.bridgeSecret) return { ok: false, error: "no bridge secret configured" };

  const pairs = market.instrumentList().map((inst) => [inst.symbol, brokerSymbol(inst.symbol)]);
  const query = encodeURIComponent(pairs.map(([, name]) => name).join(","));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${config.bridgeUrl.replace(/\/$/, "")}/spreads?symbols=${query}`, {
      headers: { "x-bridge-token": config.bridgeSecret },
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok !== true) {
      return { ok: false, error: data.error || `bridge returned ${res.status}` };
    }

    const state = readState();
    const at = data.at || new Date().toISOString();
    const spreads = {};
    for (const [symbol, name] of pairs) {
      const row = data.spreads && data.spreads[name];
      if (row && Number.isFinite(Number(row.spread))) {
        spreads[symbol] = {
          price: Number(row.spread),
          points: Number.isFinite(Number(row.points)) ? Number(row.points) : null,
          at,
        };
      }
    }
    state.spreads = spreads;
    writeState(state);
    return { ok: true, spreads, at };
  } catch (err) {
    return { ok: false, error: `bridge unreachable: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Keep the account reading fresh while auto-trading is in bridge mode, at most
 * once every five minutes, so sizing is based on the real equity rather than a
 * figure someone typed in months ago, and costs on the real spread. Failures
 * are silent here: the status panel and the buttons are where errors surface.
 */
async function maybeSyncAccount() {
  const config = settings.getExecConfig();
  const usable =
    config.mode === "direct"
      ? brokers.configured(config)
      : config.mode === "bridge" && config.bridgeUrl && config.bridgeSecret;
  if (!usable) return null;
  if (Date.now() - lastSyncAt < ACCOUNT_SYNC_MS) return null;
  lastSyncAt = Date.now();
  try {
    const account = await syncAccount();
    await syncSpreads().catch(() => null);
    return account;
  } catch {
    return null;
  }
}

/** Does the configured direct broker answer, and for which account? */
async function testBroker() {
  const config = settings.getExecConfig();
  const provider = brokers.get(config);
  if (!provider) return { ok: false, error: "no direct broker configured" };
  const result = await provider.test(config);
  if (!result.ok) return { ok: false, error: result.error };
  const acc = result.broker || {};
  return {
    ok: true,
    broker: {
      login: acc.login,
      server: acc.server,
      demo: acc.demo === true,
      balance: acc.balance,
      equity: acc.equity,
      currency: acc.currency,
      positions: (acc.positions || []).length,
    },
  };
}

module.exports = {
  maybeSyncAccount,
  reconcile,
  testBroker,
  place,
  mark,
  status,
  kill,
  revive,
  testBridge,
  syncAccount,
  syncSpreads,
  brokerSymbol,
  sizeFor,
  refusal,
};
