/**
 * Tracks signals from the moment they are posted until they hit their target,
 * hit their stop, or expire.
 *
 * Resolution walks the candles a signal lived through, in order, and takes the
 * first level that was touched. Checking only the live price is not the same
 * thing: a trade that hit its stop on Tuesday and is beyond its target by
 * Thursday would be scored as a win, which is how a tracker reports a 100% win
 * rate it did not earn. When no candle history is available (a market with no
 * bars, or a gap in the feed) it falls back to the live price, and says so.
 *
 * A bar that touches both levels is scored as a loss: intrabar order is
 * unknown, and assuming the exit you wanted is how backtests lie to you.
 *
 * State is persisted to signals.json so a restart does not lose open trades.
 */

const fs = require("fs");
const path = require("path");
const { writeJson } = require("./atomicWrite");

const FILE = path.join(__dirname, "..", "signals.json");
const MAX_HISTORY = 200;
const EXPIRY_MS = 24 * 60 * 60 * 1000; // a day without resolution = expired

function load() {
  try {
    const raw = fs.readFileSync(FILE, "utf-8").trim();
    if (!raw) return { open: [], history: [] };
    const parsed = JSON.parse(raw);
    return {
      open: Array.isArray(parsed.open) ? parsed.open : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    return { open: [], history: [] };
  }
}

function save(state) {
  const trimmed = {
    open: state.open,
    history: state.history.slice(-MAX_HISTORY),
  };
  try {
    writeJson(FILE, trimmed, 2);
  } catch {}
}

function makeId(signal) {
  return [signal.symbol, signal.side, signal.zone.low, signal.zone.high, signal.at].join("|");
}

/** Add a freshly posted signal to the open list. */
function add(signal) {
  const state = load();
  const id = makeId(signal);

  if (state.open.some((s) => s.id === id)) return state.open;
  if (state.history.some((s) => s.id === id)) return state.open;

  // One live signal per market and direction. Auto zones drift by a fraction
  // of a pip between cycles, so without this the same setup is posted again and
  // again and each copy is scored separately.
  if (state.open.some((s) => s.symbol === signal.symbol && s.side === signal.side)) {
    return state.open;
  }

  // Do not track something that is already past its target or stop.
  if (signal.side === "BUY") {
    if (signal.price <= signal.stop || signal.price >= signal.target) return state.open;
  } else {
    if (signal.price >= signal.stop || signal.price <= signal.target) return state.open;
  }

  state.open.push({
    id,
    symbol: signal.symbol,
    side: signal.side,
    confidence: signal.confidence,
    entry: signal.entry,
    stop: signal.stop,
    target: signal.target,
    riskReward: signal.riskReward,
    zone: signal.zone,
    // Kept so the win/loss message can say what it was worth, not just R.
    sizing: signal.sizing || null,
    openedAt: signal.at || new Date().toISOString(),
  });

  save(state);
  return state.open;
}

/**
 * Did this signal's path touch its stop or its target first?
 *
 * Bars are walked oldest-first and only those at or after the signal's open are
 * used. Returns null when there is no history to judge from.
 */
function pathOutcome(s, bars, openedAtMs) {
  if (!Array.isArray(bars) || !bars.length) return null;
  for (const bar of bars) {
    const at = Number(bar.t) < 1e12 ? Number(bar.t) * 1000 : Number(bar.t);
    if (!Number.isFinite(at) || at + 60 * 1000 < openedAtMs) continue;
    const high = Number(bar.h);
    const low = Number(bar.l);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

    const hitStop = s.side === "BUY" ? low <= s.stop : high >= s.stop;
    const hitTarget = s.side === "BUY" ? high >= s.target : low <= s.target;

    // Both inside one bar: the order inside the bar is unknown, so take the
    // pessimistic reading. Anything else flatters the strategy.
    if (hitStop) return { outcome: "loss", exit: s.stop, barAt: at };
    if (hitTarget) return { outcome: "win", exit: s.target, barAt: at };
  }
  return null;
}

/**
 * Check open signals against current prices and the bars they lived through.
 * @param {Map|object} priceBySymbol
 * @param {number} now
 * @param {{barsFor?: (symbol: string) => Array}} [options]
 * @returns {{resolved: Array, open: Array}}
 */
function update(priceBySymbol, now = Date.now(), options = {}) {
  const barsFor = typeof options.barsFor === "function" ? options.barsFor : null;
  const state = load();
  const stillOpen = [];
  const resolved = [];

  for (const s of state.open) {
    const price = priceBySymbol instanceof Map ? priceBySymbol.get(s.symbol) : priceBySymbol[s.symbol];

    if (!Number.isFinite(price)) {
      stillOpen.push(s);
      continue;
    }

    let outcome = null;
    let exit = null;
    let barAt = null;

    const openedAtMs = new Date(s.openedAt).getTime();
    const path = barsFor ? pathOutcome(s, barsFor(s.symbol), openedAtMs) : null;

    if (path) {
      outcome = path.outcome;
      exit = path.exit;
      barAt = path.barAt;
    } else if (s.side === "BUY") {
      if (price <= s.stop) {
        outcome = "loss";
        exit = s.stop;
      } else if (price >= s.target) {
        outcome = "win";
        exit = s.target;
      }
    } else {
      if (price >= s.stop) {
        outcome = "loss";
        exit = s.stop;
      } else if (price <= s.target) {
        outcome = "win";
        exit = s.target;
      }
    }

    const age = now - openedAtMs;
    if (!outcome && age > EXPIRY_MS) {
      outcome = "expired";
      exit = price;
    }

    if (outcome) {
      const rMultiple =
        outcome === "win" ? Number(s.riskReward ?? 0.6) : outcome === "loss" ? -1 : 0;
      resolved.push({
        ...s,
        outcome,
        // Two decimals erased a EURUSD stop (1.095 became 1.1); ten
        // significant digits keep every market's own precision.
        exit: Number(Number(exit).toPrecision(10)),
        priceAtClose: Number(Number(price).toPrecision(10)),
        rMultiple,
        resolution: path ? "candles" : "price",
        touchedAt: barAt ? new Date(barAt).toISOString() : null,
        closedAt: new Date(now).toISOString(),
        heldMinutes: Math.round((barAt ? barAt - openedAtMs : age) / 60000),
      });
    } else {
      stillOpen.push(s);
    }
  }

  if (resolved.length) {
    state.history.push(...resolved);
    state.open = stillOpen;
    save(state);
  }

  return { resolved, open: stillOpen };
}

function stats() {
  const state = load();
  const closed = state.history.filter((h) => h.outcome === "win" || h.outcome === "loss");
  const wins = closed.filter((h) => h.outcome === "win").length;
  const losses = closed.filter((h) => h.outcome === "loss").length;
  const totalR = state.history.reduce((a, h) => a + (h.rMultiple || 0), 0);

  return {
    open: state.open.length,
    wins,
    losses,
    expired: state.history.filter((h) => h.outcome === "expired").length,
    winrate: closed.length ? Number(((wins / closed.length) * 100).toFixed(1)) : null,
    totalR: Number(totalR.toFixed(2)),
    recent: state.history.slice(-10).reverse(),
    openTrades: state.open,
  };
}

module.exports = { add, update, stats, load };
