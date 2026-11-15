/**
 * Tracks signals from the moment they are posted until they hit their target,
 * hit their stop, or expire.
 *
 * Resolution is checked against the live quote on every watch cycle (roughly
 * every 10 seconds), so an intrabar spike that reverses between two checks can
 * be missed. That is a real limitation of price-based tracking; it is stated
 * here rather than hidden.
 *
 * State is persisted to signals.json so a restart does not lose open trades.
 */

const fs = require("fs");
const path = require("path");

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
    fs.writeFileSync(FILE, JSON.stringify(trimmed, null, 2), "utf-8");
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
    openedAt: signal.at || new Date().toISOString(),
  });

  save(state);
  return state.open;
}

/**
 * Check open signals against current prices.
 * @returns {{resolved: Array, open: Array}}
 */
function update(priceBySymbol, now = Date.now()) {
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

    if (s.side === "BUY") {
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

    const age = now - new Date(s.openedAt).getTime();
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
        exit: Number(Number(exit).toFixed(2)),
        priceAtClose: Number(Number(price).toFixed(2)),
        rMultiple,
        closedAt: new Date(now).toISOString(),
        heldMinutes: Math.round(age / 60000),
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
