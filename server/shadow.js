/**
 * The shadow book: a second paper account that takes the setups the proven-rule
 * gate refused.
 *
 * The gate can only approve a market and condition pair that has a champion,
 * and most pairs do not have one, so the live paper account takes nothing and
 * produces no evidence. That is safe and completely uninformative. This book
 * answers the question the gate cannot: what would have happened to the trades
 * it held back?
 *
 * It is deliberately separate. It never places an order, never touches
 * executor.json, and never influences what the live account does. Same starting
 * balance, same risk percentage, same spread, slippage and gap modelling, same
 * stop and target — only the gate differs, and every fill records the verdict
 * that rejected it so the two books can be compared by reason rather than by
 * gut feeling.
 *
 * Off unless auto-trading is on in paper mode: comparing a paper experiment
 * against a live broker account would be comparing two different worlds.
 */

const fs = require("fs");
const path = require("path");
const { writeJson } = require("./atomicWrite");
const settings = require("./settings");
const costsMod = require("./costs");
const executor = require("./executor");

const FILE = path.join(__dirname, "..", "shadow.json");
// The smallest size the paper books use. Fractional on purpose: the live paper
// book sizes in the same steps, so the two are comparable, and at a small
// balance a 0.01 floor would decide the risk instead of the percentage.
const LOT_STEP = 0.0001;
const MAX_CLOSED = 500;
const MAX_REFUSALS = 200;

function fresh() {
  return {
    balance: null,
    open: [],
    closed: [],
    dayKey: null,
    dayRealized: 0,
    killedAt: null,
    killReason: null,
    spreads: {},
    refusals: [],
    lastAt: null,
  };
}

function readState() {
  try {
    const raw = fs.readFileSync(FILE, "utf-8").trim();
    if (!raw) return fresh();
    return { ...fresh(), ...JSON.parse(raw) };
  } catch {
    return fresh();
  }
}

function writeState(state) {
  try {
    writeJson(FILE, state, 2);
  } catch {}
}

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** A new UTC day: yesterday's realised loss no longer stops today. */
function rollDay(state) {
  const key = dayKey();
  if (state.dayKey === key) return false;
  state.dayKey = key;
  state.dayRealized = 0;
  state.killedAt = null;
  state.killReason = null;
  return true;
}

/** Only a paper experiment can be compared with the paper account. */
function enabled(config = settings.getExecConfig()) {
  return Boolean(config.enabled) && config.mode === "paper";
}

function priceOf(prices, symbol) {
  if (!prices) return NaN;
  if (prices instanceof Map) return Number(prices.get(symbol));
  return Number(prices[symbol]);
}

function pnlOf(pos, price) {
  const dir = pos.side === "BUY" ? 1 : -1;
  return Number(((price - pos.entry) * dir * pos.lots * pos.valuePerUnit).toFixed(2));
}

/**
 * Lots for the same risk percentage the live book uses. Thousandths of a lot,
 * so a $200 balance can risk $1 instead of the $20 a 0.01 floor would force on
 * gold. A setup whose stop is so wide that even the smallest lot breaks the cap
 * is refused, not rounded up.
 */
function lotsFor(signal, equityNow, riskPct, config) {
  const entry = Number(signal.entry ?? signal.price);
  const stop = Number(signal.stop);
  const perUnit = executor.valuePerUnit(signal.symbol, config);
  const stopDistance = Math.abs(entry - stop);
  if (!(stopDistance > 0) || !(perUnit > 0)) return null;

  const riskAmount = (equityNow * riskPct) / 100;
  const rawLots = riskAmount / (stopDistance * perUnit);
  const lots = Number((Math.floor(rawLots / LOT_STEP) * LOT_STEP).toFixed(4));
  if (lots < LOT_STEP) {
    return {
      refused: `smallest lot would risk ${(stopDistance * perUnit * LOT_STEP).toFixed(2)}, above the ${riskPct}% limit`,
    };
  }
  return {
    lots,
    riskMoney: Number((stopDistance * perUnit * lots).toFixed(2)),
    riskPctActual: Number((((stopDistance * perUnit * lots) / equityNow) * 100).toFixed(2)),
    valuePerUnit: perUnit,
  };
}

function equity(state, prices) {
  const start = Number(state.balance) || 0;
  let floating = 0;
  for (const pos of state.open) {
    const price = priceOf(prices, pos.symbol);
    if (Number.isFinite(price)) floating += pnlOf(pos, price) - (pos.cost || 0);
  }
  return Number((start + floating).toFixed(2));
}

/**
 * The fill the same paper model gives the live book: entry moved against the
 * trade by slippage, capped at a quarter of the stop distance.
 */
function paperFill(signal, signalEntry, config, state, lots) {
  const reading = costsMod.slippageInfo(signal.symbol, config, state.spreads);
  const stopDistance = Math.abs(signalEntry - Number(signal.stop));
  const units = Math.min(Number(reading.units) || 0, stopDistance * 0.25);
  if (!(units > 0)) return { price: signalEntry, slippage: 0, money: 0 };
  const adverse = signal.side === "BUY" ? units : -units;
  return {
    price: Number((signalEntry + adverse).toFixed(6)),
    slippage: Number(adverse.toFixed(6)),
    money: Number((units * lots * executor.valuePerUnit(signal.symbol, config)).toFixed(2)),
  };
}

function openPosition(state, signal, held, config, prices, now) {
  if (state.killedAt) return null;
  if (state.open.length >= Number(config.maxPositions || 2)) return null;
  if (state.open.some((p) => p.symbol === signal.symbol)) return null;

  const price = priceOf(prices, signal.symbol);
  if (!Number.isFinite(price)) return null;
  if (!(Number(signal.stop) > 0) || !(Number(signal.target) > 0)) return null;

  if (state.balance == null) state.balance = Number(config.accountBalance) || 1000;
  const equityNow = equity(state, prices);
  const size = lotsFor(signal, equityNow, Number(config.riskPct ?? 0.5), config);
  if (!size) return null;
  if (size.refused) return { refusal: size.refused };

  const signalEntry = Number(signal.entry ?? signal.price);
  const fill = paperFill(signal, signalEntry, config, state, size.lots);
  const entryCost = costsMod.entryCost({
    symbol: signal.symbol,
    lots: size.lots,
    valuePerUnit: size.valuePerUnit,
    config,
    live: state.spreads,
  });

  const order = {
    id: `shadow-${signal.symbol}-${Date.now()}`,
    symbol: signal.symbol,
    side: signal.side,
    lots: size.lots,
    entry: fill.price,
    signalEntry,
    slippage: fill.slippage,
    slippageMoney: fill.money,
    fillModel: "paper-market",
    stop: Number(signal.stop),
    target: Number(signal.target),
    riskMoney: size.riskMoney,
    riskPct: size.riskPctActual,
    valuePerUnit: size.valuePerUnit,
    cost: entryCost.total,
    costDetail: entryCost,
    openedAt: now.toISOString(),
    heldReason: held.reason || null,
    condition: held.condition || null,
    setup: signal.confidence || signal.type || "signal",
  };
  state.open.push(order);
  return { order };
}

/**
 * Resolve open shadow trades against the current prices. Stops fill the way the
 * live paper book fills them: stop plus slippage, or the gapped price when the
 * market went through both. Targets stay at the target.
 */
function resolve(state, prices, config, now) {
  const stillOpen = [];
  const closed = [];

  for (const pos of state.open) {
    const price = priceOf(prices, pos.symbol);
    if (!Number.isFinite(price)) {
      stillOpen.push(pos);
      continue;
    }
    const hitStop = pos.side === "BUY" ? price <= pos.stop : price >= pos.stop;
    const hitTarget = pos.side === "BUY" ? price >= pos.target : price <= pos.target;
    if (!hitStop && !hitTarget) {
      stillOpen.push(pos);
      continue;
    }

    let exit = pos.target;
    let extra = null;
    if (hitStop) {
      const units = Number(costsMod.slippageInfo(pos.symbol, config, state.spreads).units) || 0;
      const withSlip = pos.side === "BUY" ? pos.stop - units : pos.stop + units;
      exit = pos.side === "BUY" ? Math.min(price, withSlip) : Math.max(price, withSlip);
      exit = Number(exit.toFixed(6));
      const gap = Math.abs(Number((exit - withSlip).toFixed(8)));
      extra = {
        slippageUnits: Number(units.toFixed(8)),
        gap,
        gapMoney: Number((gap * pos.lots * pos.valuePerUnit).toFixed(2)),
        fillModel: "stop-market",
      };
    }

    const grossPnl = pnlOf(pos, exit);
    const heldMs = now.getTime() - new Date(pos.openedAt).getTime();
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

    closed.push({
      ...pos,
      exit,
      grossPnl,
      cost,
      costDetail: { ...(pos.costDetail || {}), exit: exitCost },
      nights,
      pnl,
      outcome: hitStop ? "loss" : "win",
      closedAt: now.toISOString(),
      ...(extra || {}),
    });
  }

  if (!closed.length) {
    state.open = stillOpen;
    return closed;
  }

  state.open = stillOpen;
  state.closed.push(...closed);
  if (state.closed.length > MAX_CLOSED) state.closed = state.closed.slice(-MAX_CLOSED);
  state.balance = Number((state.balance + closed.reduce((a, c) => a + c.pnl, 0)).toFixed(2));

  // The same daily kill switch the live book has. It is part of the strategy
  // being measured, so the experiment keeps it.
  const limit = Number(config.maxDailyLossPct || 2);
  const startEquity = Number(state.balance) || 1;
  if ((state.dayRealized / startEquity) * 100 <= -limit && !state.killedAt) {
    state.killedAt = now.toISOString();
    state.killReason = `daily loss limit reached (${((state.dayRealized / startEquity) * 100).toFixed(2)}%)`;
  }
  return closed;
}

/**
 * Note a setup the book could not size, once per setup per day.
 *
 * A refused setup leaves no trade, so without a note the sample contains only
 * the setups that happened to fit the risk cap. A run of wide stops — gold and
 * the indices at this balance — would then look like a complete result when it
 * is a filtered one. This keeps the filter visible instead of silent.
 */
function recordRefusal(state, signal, held, reason, config, prices, now) {
  if (!Array.isArray(state.refusals)) state.refusals = [];
  const key = [
    dayKey(now),
    signal.symbol,
    signal.side,
    signal.entry ?? signal.price,
    signal.stop,
    signal.target,
  ].join("|");
  if (state.refusals.some((r) => r.key === key)) return false;

  state.refusals.push({
    key,
    at: now.toISOString(),
    symbol: signal.symbol,
    side: signal.side,
    entry: signal.entry ?? signal.price,
    stop: Number(signal.stop),
    target: Number(signal.target),
    equity: equity(state, prices),
    riskPct: Number(config.riskPct ?? 0.5),
    condition: held.condition || null,
    heldReason: held.reason || null,
    reason,
  });
  if (state.refusals.length > MAX_REFUSALS) state.refusals = state.refusals.slice(-MAX_REFUSALS);
  return true;
}

/**
 * One watch cycle: resolve what is open, then take this cycle's rejected
 * setups. `held` is [{ signal, reason, condition }] from the gate.
 */
function cycle(held, prices, now = new Date()) {
  const config = settings.getExecConfig();
  if (!enabled(config)) return { skipped: "shadow book only runs while paper trading is on" };
  const state = readState();
  let dirty = rollDay(state);

  const closed = resolve(state, prices, config, now);
  if (closed.length) dirty = true;

  for (const entry of Array.isArray(held) ? held : []) {
    const result = openPosition(state, entry.signal, entry, config, prices, now);
    if (result && result.order) dirty = true;
    else if (result && result.refusal) {
      if (recordRefusal(state, entry.signal, entry, result.refusal, config, prices, now)) dirty = true;
    }
  }

  if (dirty) {
    state.lastAt = now.toISOString();
    writeState(state);
  }
  return { closed, open: state.open.length };
}

function status(prices) {
  const config = settings.getExecConfig();
  const state = readState();
  const now = new Date();
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayClosed = state.closed.filter((c) => {
    const at = new Date(c.closedAt || 0).getTime();
    return Number.isFinite(at) && at >= dayStart;
  });
  const refusals = Array.isArray(state.refusals) ? state.refusals : [];
  const dayRefusals = refusals.filter((r) => String(r.at || "").slice(0, 10) === dayKey(now));

  return {
    enabled: enabled(config),
    balance: state.balance == null ? null : Number(state.balance.toFixed(2)),
    equity: state.balance == null ? null : equity(state, prices),
    openCount: state.open.length,
    closedCount: state.closed.length,
    dayClosed: dayClosed.length,
    dayWins: dayClosed.filter((c) => c.outcome === "win").length,
    dayLosses: dayClosed.filter((c) => c.outcome === "loss").length,
    dayRealized: Number(state.dayRealized.toFixed(2)),
    dayBest: dayClosed.length
      ? Number(Math.max(...dayClosed.map((c) => Number(c.pnl) || 0)).toFixed(2))
      : null,
    dayWorst: dayClosed.length
      ? Number(Math.min(...dayClosed.map((c) => Number(c.pnl) || 0)).toFixed(2))
      : null,
    killSwitch: Boolean(state.killedAt),
    killReason: state.killReason,
    // Setups that never became trades because no size fit the risk cap. Shown
    // beside the result so the sample cannot be read as the whole story.
    refusedCount: refusals.length,
    refusedToday: dayRefusals.length,
    refusals: refusals.slice(-10).reverse(),
    open: state.open,
    closed: state.closed.slice(-20).reverse(),
  };
}

/** Whether the shadow book has anything worth a line in the recap. */
function hasActivity(stats) {
  return Boolean(stats && stats.enabled && (stats.closedCount || stats.openCount));
}

function reset() {
  writeState(fresh());
  return status();
}

module.exports = {
  cycle,
  status,
  hasActivity,
  enabled,
  readState,
  reset,
  LOT_STEP,
};
