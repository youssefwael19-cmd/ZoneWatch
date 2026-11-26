/**
 * Strategy lab — the app tests the rules it actually trades.
 *
 * The first version of this lab tested a different strategy: hourly bars, a
 * close inside a zone, and a zone-width or ATR stop. The live watcher sends 15m
 * entries with a higher-timeframe filter, a last-bar confirmation and a sweep
 * stop, and the paper book pays spread, slippage and commission. A verdict from
 * the older study could not be evidence for the live rule, so this version
 * calls signals.evaluateSignal() directly and resolves every trade with the
 * same cost-aware resolver the brain uses.
 *
 * The rules are fixed, so there is nothing to tune. The year (or the deepest
 * history the feed allows) is split into three out-of-sample blocks, one trade
 * at a time, with the live 30-minute cooldown. That removes the overlapping
 * trades that made the old t-stat look stronger than it was. The app is still
 * allowed to conclude "no edge"; a market with no verdict is not allowed to
 * send signals at all.
 *
 * The entry timeframe is timeframes.entry(), normally 15m, and the lab records
 * it. Every verdict also carries the exact cost model and the entry/daily
 * series it was measured on. readLab() rebuilds those inputs from the current
 * settings and providers and drops any verdict that no longer matches, so a
 * spread, commission, feed or timeframe change makes old evidence untested
 * instead of letting it stand.
 *
 * Research families are measured in this file but are not live rules. Their
 * verdicts live under `research`, with their own evidence check; the live
 * `results` bucket and tradable() never read them. The first is the NASDAQ
 * opening-range breakout on 5m bars.
 */

const fs = require("fs");
const { writeJson } = require("./atomicWrite");

const candlesMod = require("./candles");
const autozones = require("./autozones");
const signalsMod = require("./signals");
const strategies = require("./strategies");
const costsMod = require("./costs");
const settings = require("./settings");
const market = require("./market");
const promotions = require("./promotions");
const sessions = require("./sessions");
const timeframes = require("./timeframes");

const LAB_FILE = require("./stateDir").file("lab.json");

// 2: verdicts carry the exact cost model and candle sources they used. A
// verdict stored without them cannot be checked, so the bump retires it.
const LAB_RULES_VERSION = "live-rules-v2";
const BLOCKS = 3;
const MIN_TEST_TRADES = 100;
const MIN_EXPECTANCY = 0.08; // R per trade, net of modelled costs
const MIN_TSTAT = 2;
const MIN_POSITIVE_FOLDS = 2;
const RUN_GAP_MS = 45 * 60 * 1000;
const RESULT_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_HISTORY = 600;
const DAILY_RANGE = "10y";

// A research family is measured by the same gate but is never read by the live
// watcher. It is stored under `research`, not `results`, so no unrelated
// verdict can make a market tradable. The first family is the NASDAQ opening
// range breakout: a 15-minute range from three 5m bars, the first completed 5m
// close outside it, the range midpoint as the stop, 1R as the target, and a
// flat exit at that session's last bar.
const ORB_SYMBOL = "NASDAQ";
const ORB_FAMILY = "orb";
const ORB_TIMEFRAME = "5m";
const ORB_RULES_VERSION = "orb-v1";
const ORB_OPENING_BARS = 3;
const ORB_TARGET_R = 1;
const ORB_RULE = Object.freeze({
  openingBars: ORB_OPENING_BARS,
  targetR: ORB_TARGET_R,
  stop: "opening_range_mid",
  exit: "flat_by_close",
  oneTradePerSession: true,
});
// Broker feeds carry years of 5m history. Yahoo caps 5m at 60 days, which is
// not enough sessions for the 100-trade gate; trying the broker ranges there
// only produces failed requests, so Yahoo starts at the range it can answer.
const ORB_RANGES = ["2y", "1y", "6mo", "3mo", "60d"];
const ORB_YAHOO_RANGES = ["60d", "3mo"];
const ORB_TTL_MS = 12 * 60 * 60 * 1000;

const state = {
  running: false,
  lastRunAt: 0,
  lastSymbol: null,
  error: null,
  researchError: null,
  burst: false,
  // The entry series every market would be measured on right now. When it
  // moves, verdicts this process already replaced measured the old one.
  signature: null,
  // Markets re-measured since this process started, so one broken feed cannot
  // make the backlog run forever.
  tried: new Set(),
  // Last failure per market, so a market with no verdict has a reason.
  errors: {},
};

function liveRuleState() {
  const t = settings.getTradingConfig();
  return {
    mtfFilter: t.mtfFilter === true,
    minConfluence: Number(t.minConfluence) || 0,
  };
}

/* -------------------------- evidence gate -------------------------- */

/** The cost fields a verdict is bound to. Every one must match exactly. */
const COST_KEYS = [
  "spread",
  "slippage",
  "commissionPerLot",
  "valuePerUnit",
  "spreadKnown",
  "spreadSource",
  "slippageSource",
];

function gateBar() {
  return {
    trades: MIN_TEST_TRADES,
    expectancy: MIN_EXPECTANCY,
    tStat: MIN_TSTAT,
    positiveFolds: MIN_POSITIVE_FOLDS,
    blocks: BLOCKS,
  };
}

/** The cost model the next trade would pay here, and where each number came from. */
function currentCost(symbol) {
  const exec = settings.getExecConfig();
  const cfg = market.DEFAULTS[symbol] || {};
  const spread = costsMod.spreadInfo(symbol, exec);
  const slippage = costsMod.slippageInfo(symbol, exec);
  const known = Number.isFinite(Number(spread.units));
  return {
    spread: known ? Number(spread.units) : 0,
    slippage: Number(slippage.units) || 0,
    commissionPerLot: costsMod.costConfig(exec).commissionPerLot,
    valuePerUnit: Number(cfg.valuePerPointPerLot) || 0,
    spreadKnown: known,
    spreadSource: spread.source,
    slippageSource: slippage.source,
  };
}

/**
 * One requested series as this process read it. `configured*` is what the
 * current settings pick; `provider*` is what actually answered, including a
 * feed fallback or the deliberate long-daily Yahoo fallback.
 */
function seriesIdentity(ticker, interval, range) {
  const configured = candlesMod.sourceFor(ticker);
  const seen = candlesMod.seriesInfo(ticker, interval, range);
  const known = Boolean(seen && seen.actualKnown);
  return {
    ticker,
    interval,
    range,
    configuredProvider: configured.source,
    configuredSymbol: configured.symbol || ticker,
    provider: known ? seen.provider : null,
    providerSymbol: known ? seen.providerSymbol : null,
    fallback: known ? Boolean(seen.fallback) : null,
    depthFallback: known ? Boolean(seen.depthFallback) : null,
    actualKnown: known,
    bars: seen ? seen.bars : null,
  };
}

/** The candle ticker a market's series are fetched under, not the app symbol. */
function candleTicker(symbol) {
  const cfg = market.DEFAULTS[symbol] || {};
  return cfg.yahoo || symbol;
}

/** Everything a verdict for this market/timeframe must still match to be reused. */
function evidenceFor(symbol, plan, entryRange = plan.labRange) {
  const ticker = candleTicker(symbol);
  return {
    rulesVersion: LAB_RULES_VERSION,
    timeframe: plan.timeframe,
    rules: liveRuleState(),
    gate: gateBar(),
    cost: currentCost(symbol),
    entry: seriesIdentity(ticker, plan.timeframe, entryRange),
    daily: seriesIdentity(ticker, "1d", DAILY_RANGE),
  };
}

/** What a research-family verdict for this range must still match. */
function researchEvidenceFor(range) {
  const ticker = candleTicker(ORB_SYMBOL);
  return {
    kind: "research",
    family: ORB_FAMILY,
    familyVersion: ORB_RULES_VERSION,
    timeframe: ORB_TIMEFRAME,
    rule: { ...ORB_RULE },
    gate: gateBar(),
    cost: currentCost(ORB_SYMBOL),
    entry: seriesIdentity(ticker, ORB_TIMEFRAME, range),
  };
}

function sameFlat(stored, expected, keys) {
  if (!stored || !expected) return false;
  return keys.every((key) => stored[key] === expected[key]);
}

function sameSeries(stored, expected, kind) {
  if (!stored || !expected) return false;
  const identity = ["ticker", "interval", "range", "configuredProvider", "configuredSymbol"];
  if (!sameFlat(stored, expected, identity)) return false;
  // A source that was never recorded, or that silently fell back, is not the
  // series the settings name. Both are untested, never assumed.
  if (stored.actualKnown !== true || stored.fallback !== false) return false;
  if (!(Number(stored.bars) > 0)) return false;

  if (kind === "entry") {
    return stored.depthFallback !== true && Number(stored.bars) >= MIN_HISTORY;
  }

  // The daily series may use the deliberate Yahoo depth fallback, but only as
  // that explicit record. A feed fallback was already refused above.
  if (stored.configuredProvider !== "yahoo") {
    if (stored.provider === "yahoo" && stored.depthFallback !== true) return false;
    if (stored.provider !== "yahoo" && stored.depthFallback === true) return false;
  }
  return true;
}

/**
 * Does a stored verdict still describe the rule, costs and series this process
 * would use now? Missing, changed or merely assumed inputs are all untested.
 */
function sameEvidence(stored, expected) {
  if (!stored || !expected) return false;
  if (stored.rulesVersion !== LAB_RULES_VERSION) return false;
  if (stored.timeframe !== expected.timeframe) return false;
  if (
    !stored.rules ||
    stored.rules.mtfFilter !== expected.rules.mtfFilter ||
    stored.rules.minConfluence !== expected.rules.minConfluence
  ) {
    return false;
  }
  if (!sameFlat(stored.gate, expected.gate, Object.keys(expected.gate))) return false;
  if (!sameFlat(stored.cost, expected.cost, COST_KEYS)) return false;
  return (
    sameSeries(stored.entry, expected.entry, "entry") &&
    sameSeries(stored.daily, expected.daily, "daily")
  );
}

/** The same fail-closed test for a research family, with no daily series. */
function sameResearchEvidence(stored, expected) {
  if (!stored || !expected) return false;
  if (stored.kind !== expected.kind) return false;
  if (stored.family !== expected.family) return false;
  if (stored.familyVersion !== expected.familyVersion) return false;
  if (stored.timeframe !== expected.timeframe) return false;
  if (!sameFlat(stored.rule, expected.rule, Object.keys(expected.rule))) return false;
  if (!sameFlat(stored.gate, expected.gate, Object.keys(expected.gate))) return false;
  if (!sameFlat(stored.cost, expected.cost, COST_KEYS)) return false;
  return sameSeries(stored.entry, expected.entry, "entry");
}

/** The file as written, including verdicts this build no longer trusts. */
function readLabRaw() {
  try {
    const raw = fs.readFileSync(LAB_FILE, "utf-8").trim();
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Read only verdicts that this process can still stand behind: same rule
 * version, timeframe, live filters, cost model and candle sources. Anything
 * else is treated as untested, which is what makes the gate fail closed instead
 * of quoting yesterday's study.
 */
function readLab() {
  try {
    const parsed = readLabRaw();
    if (!parsed) return { results: {}, research: {}, updatedAt: null };
    if (parsed.rulesVersion !== LAB_RULES_VERSION) {
      return { results: {}, research: {}, updatedAt: parsed.updatedAt || null };
    }

    const plan = timeframes.plan(timeframes.entry());
    const results = {};
    for (const [symbol, r] of Object.entries(parsed.results || {})) {
      const range = r && r.evidence && r.evidence.entry ? r.evidence.entry.range : null;
      const expected =
        range === plan.labRange || range === plan.fallbackRange
          ? evidenceFor(symbol, plan, range)
          : null;
      if (r && sameEvidence(r.evidence, expected)) {
        results[symbol] = r;
      }
    }

    const research = {};
    for (const [key, r] of Object.entries(parsed.research || {})) {
      const symbol = r && r.symbol;
      const range = r && r.evidence && r.evidence.entry ? r.evidence.entry.range : null;
      const expected =
        key === researchKey(ORB_SYMBOL) &&
        symbol === ORB_SYMBOL &&
        ORB_RANGES.includes(range)
          ? researchEvidenceFor(range)
          : null;
      if (r && sameResearchEvidence(r.evidence, expected)) {
        research[key] = r;
      }
    }
    return { results, research, updatedAt: parsed.updatedAt || null };
  } catch {
    return { results: {}, research: {}, updatedAt: null };
  }
}

function writeLab(lab) {
  try {
    lab.rulesVersion = LAB_RULES_VERSION;
    lab.timeframe = timeframes.entry();
    lab.rules = liveRuleState();
    writeJson(LAB_FILE, lab, 2);
  } catch (err) {
    state.error = err.message;
  }
}

/* ---------------------------- maths ---------------------------- */

function tStat(values) {
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  if (!sd) return null;
  return Number((mean / (sd / Math.sqrt(n))).toFixed(2));
}

function summarise(values) {
  const n = values.length;
  if (!n) return { n: 0, winrate: null, totalR: 0, expectancy: null };
  const wins = values.filter((r) => r > 0).length;
  const totalR = values.reduce((a, b) => a + b, 0);
  return {
    n,
    winrate: Number(((wins / n) * 100).toFixed(1)),
    totalR: Number(totalR.toFixed(2)),
    expectancy: Number((totalR / n).toFixed(3)),
  };
}

/** The one gate. Both the live rule and research families read it. */
function gateReasons(oos, t, positiveFolds) {
  const reasons = [];
  if (oos.n < MIN_TEST_TRADES) reasons.push(`${oos.n} trades (needs ${MIN_TEST_TRADES})`);
  if (oos.expectancy == null || oos.expectancy <= MIN_EXPECTANCY) {
    reasons.push(`${oos.expectancy}R per trade net (needs above ${MIN_EXPECTANCY}R)`);
  }
  if (t == null || t < MIN_TSTAT) reasons.push(`t-stat ${t ?? "n/a"} (needs ${MIN_TSTAT})`);
  if (positiveFolds < MIN_POSITIVE_FOLDS) {
    reasons.push(`${positiveFolds}/${BLOCKS} blocks positive (needs ${MIN_POSITIVE_FOLDS})`);
  }
  return reasons;
}

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  let prev = values[0];
  const out = [prev];
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/**
 * Latest bar that had closed by `at`. The live watcher sees the forming candle;
 * a backtest must not, so a bar counts only once its whole span has passed.
 */
function latestClosedIndex(bars, at, span) {
  let lo = 0;
  let hi = bars.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t + span <= at) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function trendLookup(bars, span) {
  if (!Array.isArray(bars) || bars.length < 55) return () => null;
  const closes = bars.map((b) => b.c);
  const fast = emaSeries(closes, 20);
  const slow = emaSeries(closes, 50);
  return (at) => {
    const j = latestClosedIndex(bars, at, span);
    if (j < 50) return null;
    return fast[j] > slow[j] ? "up" : fast[j] < slow[j] ? "down" : "flat";
  };
}

function biasLookup(bars) {
  if (!Array.isArray(bars) || bars.length < 210) return () => null;
  const closes = bars.map((b) => b.c);
  const fast = emaSeries(closes, 50);
  const slow = emaSeries(closes, 200);
  return (at) => {
    const j = latestClosedIndex(bars, at, 24 * 60 * 60 * 1000);
    if (j < 200) return null;
    return fast[j] > slow[j] ? "up" : fast[j] < slow[j] ? "down" : "flat";
  };
}

/* ------------------------- market data ------------------------- */

/** Entry bars plus the exact range and source that answered for them. */
async function labBars(candleSymbol, plan) {
  for (const range of [plan.labRange, plan.fallbackRange]) {
    let bars = [];
    try {
      bars = await candlesMod.getCandles(candleSymbol, plan.timeframe, range);
    } catch {}
    if (Array.isArray(bars) && bars.length >= MIN_HISTORY) {
      return {
        bars,
        range,
        info: candlesMod.seriesInfo(candleSymbol, plan.timeframe, range),
      };
    }
  }
  return { bars: [], range: plan.labRange, info: null };
}

async function safeCandles(candleSymbol, interval, range) {
  try {
    const bars = await candlesMod.getCandles(candleSymbol, interval, range);
    return Array.isArray(bars) ? bars : [];
  } catch {
    return [];
  }
}

/* --------------------- research: NASDAQ ORB ---------------------- */

function researchKey(symbol = ORB_SYMBOL) {
  return `${symbol}:${ORB_FAMILY}`;
}

/** Group 5m bars by the cash session that was open when each bar started. */
function orbSessionGroups(bars) {
  const groups = new Map();
  (Array.isArray(bars) ? bars : []).forEach((bar, idx) => {
    const t = Number(bar && bar.t);
    if (!Number.isFinite(t)) return;
    const openedAt = sessions.sessionOpenedAt(ORB_SYMBOL, new Date(t));
    if (!openedAt) return;
    let group = groups.get(openedAt);
    if (!group) {
      group = { openedAt, bars: [] };
      groups.set(openedAt, group);
    }
    group.bars.push({ bar, idx });
  });
  for (const group of groups.values()) {
    group.bars.sort((a, b) => a.bar.t - b.bar.t);
  }
  return [...groups.values()].sort((a, b) => a.openedAt - b.openedAt);
}

/**
 * The ORB rule, applied to bars that are already in hand.
 *
 * A session is skipped unless it has every opening-range bar and its true last
 * bar, so a partial current session cannot be booked as a flat-at-close trade
 * and a holiday or a truncated feed cannot invent one. One trade per session:
 * the first completed 5m close outside the 15-minute range wins, the midpoint
 * is the stop, 1R is the target, and anything still open exits at the session's
 * last close. `strategies.resolve` supplies the same spread, slippage,
 * commission and pessimism as the live lab.
 */
function orbTradesFromBars(bars, costModel = null) {
  const groups = orbSessionGroups(bars);
  const trades = [];
  let incomplete = 0;
  let noBreakout = 0;
  let unresolved = 0;
  const span = 5 * 60 * 1000;

  for (const group of groups) {
    const date = new Date(group.openedAt);
    const def = sessions.sessionDefs(date).find((d) => d.name === ORB_SYMBOL);
    if (!def) {
      incomplete += 1;
      continue;
    }
    const closeMinutes = sessions.sessionCloseMinutes(def, date);
    if (closeMinutes == null) {
      incomplete += 1;
      continue;
    }
    const openMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
    const expectedLastSlot = Math.round((closeMinutes - openMinutes) / 5) - 1;
    if (!(expectedLastSlot >= 3)) {
      incomplete += 1;
      continue;
    }

    const slots = new Map();
    for (const item of group.bars) {
      const offset = Number(item.bar.t) - group.openedAt;
      const slot = Math.round(offset / span);
      if (slot < 0 || slot > expectedLastSlot) continue;
      if (Math.abs(offset - slot * span) > 1000) continue;
      if (!slots.has(slot)) slots.set(slot, item);
    }

    const lastSlot = Math.max(...slots.keys());
    if (lastSlot !== expectedLastSlot) {
      incomplete += 1;
      continue;
    }
    const first = slots.get(0);
    const second = slots.get(1);
    const third = slots.get(2);
    if (!first || !second || !third) {
      incomplete += 1;
      continue;
    }

    const high = Math.max(first.bar.h, second.bar.h, third.bar.h);
    const low = Math.min(first.bar.l, second.bar.l, third.bar.l);
    const stop = (high + low) / 2;

    let entryItem = null;
    let side = null;
    for (let slot = 3; slot < lastSlot; slot++) {
      const item = slots.get(slot);
      if (!item) continue;
      if (Number(item.bar.c) > high) {
        entryItem = item;
        side = "BUY";
        break;
      }
      if (Number(item.bar.c) < low) {
        entryItem = item;
        side = "SELL";
        break;
      }
    }
    if (!entryItem) {
      noBreakout += 1;
      continue;
    }

    const entry = Number(entryItem.bar.c);
    const risk = side === "BUY" ? entry - stop : stop - entry;
    if (!(risk > 0)) {
      noBreakout += 1;
      continue;
    }
    const target =
      side === "BUY" ? entry + risk * ORB_TARGET_R : entry - risk * ORB_TARGET_R;
    const sessionEndIdx = slots.get(lastSlot).idx;
    const result = strategies.resolve(
      bars,
      entryItem.idx,
      { side, entry, stop, target },
      sessionEndIdx + 1,
      costModel,
      {
        maxHoldBars: sessionEndIdx - entryItem.idx + 1,
        closeAtEnd: true,
      }
    );
    if (result.outcome === "open") {
      unresolved += 1;
      continue;
    }

    trades.push({
      entryIndex: entryItem.idx,
      session: date.toISOString(),
      at: new Date(entryItem.bar.t).toISOString(),
      side,
      entry: Number(entry.toFixed(8)),
      stop: Number(stop.toFixed(8)),
      target: Number(target.toFixed(8)),
      risk: Number(risk.toFixed(8)),
      outcome: result.outcome,
      r: result.r,
      grossR: result.grossR,
      bars: result.bars,
      totalCostR: Number((result.grossR - result.r).toFixed(3)),
      spreadR: Number(((Number(result.costs && result.costs.spread) || 0) / risk).toFixed(4)),
      commissionR: Number(result.costs && result.costs.commissionR) || 0,
    });
  }

  return { groups, trades, incomplete, noBreakout, unresolved };
}

function orbBlocks(trades) {
  const size = Math.ceil(trades.length / BLOCKS);
  const blocks = [];
  for (let k = 0; k < BLOCKS; k++) {
    const slice = size ? trades.slice(k * size, (k + 1) * size) : [];
    const net = slice.map((t) => t.r);
    const gross = slice.map((t) => t.grossR);
    blocks.push({
      fold: k + 1,
      ...summarise(net),
      gross: summarise(gross),
      flat: slice.filter((t) => t.outcome === "close").length,
    });
  }
  return blocks;
}

/**
 * Walk one block with the live entry rule. One position at a time, because that
 * is what the watcher and the executor do; overlapping trades would make the
 * sample look bigger and the t-stat stronger than the live record can be.
 */
function simulateBlock({ symbol, bars, from, to, plan, decimals, trading, exec, costModel, htfTrendAt, dayBiasAt }) {
  const trades = [];
  let i = from;

  while (i < to) {
    const bar = bars[i];
    if (!bar || !Number.isFinite(bar.c)) {
      i += 1;
      continue;
    }

    const zoneStart = Math.max(0, i - plan.zoneWindow + 1);
    const zones = autozones.detectZones(bars.slice(zoneStart, i + 1), { maxPerSide: 3 });
    if (!zones.length) {
      i += 1;
      continue;
    }

    const at = Number(bar.t) + plan.minutes * 60 * 1000;
    const candles = bars.slice(Math.max(0, i - 119), i + 1);
    const signal = signalsMod.evaluateSignal({
      symbol,
      price: bar.c,
      zones,
      candles,
      decimals,
      htfBars: null,
      dailyBars: null,
      htfTrend: htfTrendAt(at),
      dayBias: dayBiasAt(at),
      requireHtf: trading.mtfFilter,
      minConfluence: trading.minConfluence,
      at,
      barMs: plan.minutes * 60 * 1000,
    });

    // The watcher holds a setup whose last closed bar finished against it; it
    // is not sent. The lab does not enter it either.
    if (!signal || !signal.confirmation || signal.confirmation.ok !== true) {
      i += 1;
      continue;
    }

    // Thin stops are refused by the watcher before an order exists.
    const thin = costsMod.thinStop({
      symbol,
      entry: signal.entry,
      stop: signal.stop,
      config: exec,
    });
    if (thin.thin) {
      i += 1;
      continue;
    }

    const risk = Math.abs(Number(signal.entry) - Number(signal.stop));
    if (!(risk > 0)) {
      i += 1;
      continue;
    }

    // The same resolver the brain uses: entry half-spread and adverse
    // slippage, exit half-spread, round-turn commission, gap fills, and the
    // live stop ladder.
    const result = strategies.resolve(
      bars,
      i,
      { side: signal.side, entry: signal.entry, stop: signal.stop, target: signal.target },
      to,
      costModel,
      { maxHoldBars: plan.maxHoldBars }
    );

    const expired = result.outcome === "open";
    const spreadR = Number((Number(result.costs && result.costs.spread) / risk).toFixed(4));
    const commissionR = Number(result.costs && result.costs.commissionR) || 0;
    trades.push({
      entryIndex: i,
      outcome: expired ? "expired" : result.outcome,
      r: expired ? 0 : result.r,
      grossR: expired ? 0 : result.grossR,
      bars: result.bars,
      at: new Date(bar.t).toISOString(),
      side: signal.side,
      risk: Number(risk.toFixed(8)),
      spreadR,
      commissionR,
      totalCostR: Number((spreadR + commissionR).toFixed(4)),
    });

    const held = Math.max(1, Number(result.bars) || 1);
    // A closed trade frees the market on the next bar. An expiry frees it at
    // the end of the 24-hour window. The live 30-minute cooldown applies to
    // both, so the lab cannot enter more often than the watcher could.
    const after = expired ? i + held : i + held + 1;
    i = Math.max(after, i + plan.cooldownBars);
  }

  return trades;
}

/* ------------------------- one market -------------------------- */

async function evaluateMarket(symbol, candleSymbol, timeframe = timeframes.entry()) {
  const plan = timeframes.plan(timeframe);
  const entry = await labBars(candleSymbol, plan);
  const bars = entry.bars;
  if (bars.length < MIN_HISTORY) {
    throw new Error(`not enough ${plan.timeframe} history (${bars.length} bars)`);
  }
  // A fallback feed is a different market under the same ticker. The verdict
  // would not describe the series this app actually trades, so it is refused
  // rather than stored with a footnote nobody re-checks.
  if (!entry.info || entry.info.actualKnown !== true) {
    throw new Error(`entry series source unknown for ${candleSymbol} ${plan.timeframe} ${entry.range}`);
  }
  if (entry.info.fallback || entry.info.depthFallback) {
    const why = entry.info.reason ? `: ${entry.info.reason}` : "";
    throw new Error(`entry series came from a fallback feed (${entry.info.provider})${why}`);
  }

  // The lab needs the daily series to cover the entry history plus the 200-day
  // bias warmup, and the higher timeframe to cover the whole entry history.
  // Fetching the live watcher's one-month HTF / one-year daily ranges would
  // leave most of the study with no filter at all, which is not the live rule.
  let dailyBars = await safeCandles(candleSymbol, "1d", DAILY_RANGE);
  let dailyInfo = candlesMod.seriesInfo(candleSymbol, "1d", DAILY_RANGE);
  if (!dailyInfo || dailyInfo.actualKnown !== true) {
    throw new Error(`daily series source unknown for ${candleSymbol} ${DAILY_RANGE}`);
  }
  if (dailyInfo.fallback) {
    throw new Error(`daily series came from a fallback feed (${dailyInfo.provider})`);
  }
  // Some broker daily histories are only a year deep, which leaves the 50/200
  // daily bias with almost no warmup inside the study. Yahoo keeps the long
  // daily series for these tickers; use it only for the bias, never for
  // entries, and record it as the explicit depth fallback it is.
  if (dailyBars.length < 250) {
    const reason = `broker daily history shorter than 250 bars (${dailyBars.length})`;
    let yahooDaily = [];
    try {
      yahooDaily = await candlesMod.getYahooCandles(candleSymbol, "1d", DAILY_RANGE, {
        depthFallback: true,
        record: false,
        reason,
      });
    } catch {}
    if (yahooDaily.length > dailyBars.length) {
      dailyBars = yahooDaily;
      dailyInfo = {
        ...dailyInfo,
        provider: "yahoo",
        providerSymbol: candleSymbol,
        fallback: false,
        depthFallback: true,
        reason,
        actualKnown: true,
        bars: yahooDaily.length,
      };
    }
  }
  const htfBars =
    plan.htf === "1d"
      ? dailyBars
      : candlesMod.aggregateBars(bars, plan.htfMinutes * 60 * 1000);

  const cfg = market.DEFAULTS[symbol] || {};
  const decimals = Number.isFinite(Number(cfg.decimals)) ? Number(cfg.decimals) : 2;
  const exec = settings.getExecConfig();
  const trading = settings.getTradingConfig();
  const rules = {
    mtfFilter: trading.mtfFilter === true,
    minConfluence: Number(trading.minConfluence) || 0,
  };

  // One cost model for the whole study, captured now. If a setting moves while
  // the walk is running, the verdict must name what it actually paid.
  const cost = currentCost(symbol);
  const costModel = {
    spread: cost.spread,
    slippage: cost.slippage,
    commissionPerLot: cost.commissionPerLot,
    valuePerUnit: cost.valuePerUnit,
  };

  const htfTrendAt = trendLookup(htfBars, plan.htfMinutes * 60 * 1000);
  const dayBiasAt = biasLookup(dailyBars);

  // Leave enough bars for the zone window and the 120-bar volatility/confirmation
  // slice. Every block is out of sample by construction: the live rules are fixed.
  const warmup = Math.max(plan.zoneWindow + 1, 210);
  if (bars.length <= warmup + BLOCKS * 20) {
    throw new Error(`not enough ${plan.timeframe} bars after warmup (${bars.length})`);
  }

  const blockSize = Math.floor((bars.length - warmup) / BLOCKS);
  const blocks = [];

  // Walk the whole series once, one trade at a time. Splitting the walk into
  // three separate simulations would cut positions off at a fold boundary and
  // let the next fold enter while the truncated trade was still open. The
  // folds below are entry cohorts: a trade belongs to the third of history in
  // which it was entered, however long it then runs.
  const all = simulateBlock({
    symbol,
    bars,
    from: warmup,
    to: bars.length,
    plan,
    decimals,
    trading,
    exec,
    costModel,
    htfTrendAt,
    dayBiasAt,
  });

  for (let k = 0; k < BLOCKS; k++) {
    const from = warmup + k * blockSize;
    const to = k === BLOCKS - 1 ? bars.length : from + blockSize;
    const trades = all.filter((t) => t.entryIndex >= from && t.entryIndex < to);
    const net = trades.map((t) => t.r);
    const gross = trades.map((t) => t.grossR);
    blocks.push({
      fold: k + 1,
      ...summarise(net),
      gross: summarise(gross),
      expired: trades.filter((t) => t.outcome === "expired").length,
    });
  }

  const net = all.map((t) => t.r);
  const gross = all.map((t) => t.grossR);
  const oos = summarise(net);
  const grossStats = summarise(gross);
  const t = tStat(net);
  const positiveFolds = blocks.filter((b) => (b.expectancy || 0) > 0).length;
  const avgCost = all.length
    ? Number((all.reduce((a, t) => a + (Number(t.totalCostR) || 0), 0) / all.length).toFixed(4))
    : null;

  const reasons = gateReasons(oos, t, positiveFolds);

  const tradable = reasons.length === 0;
  const verdict = tradable
    ? `edge: ${oos.winrate}% win, ${oos.expectancy}R net over ${oos.n} ${plan.timeframe} trades (t=${t}), ${positiveFolds}/${BLOCKS} blocks positive`
    : `no edge — ${reasons.join("; ")} (${plan.timeframe}, net of modelled costs)`;

  const evidence = {
    rulesVersion: LAB_RULES_VERSION,
    timeframe: plan.timeframe,
    rules,
    gate: gateBar(),
    cost,
    entry: { ...entry.info, actualKnown: true },
    daily: dailyInfo,
  };

  return {
    symbol,
    timeframe: plan.timeframe,
    at: new Date().toISOString(),
    // The window actually measured, which can be shorter than the range asked
    // for. "1y" on a provider that serves eight months is not a year.
    covered: candlesMod.coverageOf(bars),
    rules,
    evidence,
    oos,
    gross: grossStats,
    tStat: t,
    positiveFolds,
    blocks,
    expired: all.filter((t) => t.outcome === "expired").length,
    tradable,
    bar: {
      trades: MIN_TEST_TRADES,
      expectancy: MIN_EXPECTANCY,
      tStat: MIN_TSTAT,
      positiveFolds: MIN_POSITIVE_FOLDS,
    },
    cost: {
      spreadUnits: costModel.spread,
      slippageUnits: costModel.slippage,
      commissionPerLot: costModel.commissionPerLot,
      avgSpreadCommissionR: avgCost,
      known: cost.spreadKnown,
    },
    verdict,
  };
}

/* ------------------------ research: NASDAQ ORB ------------------------ */

async function orbBars(candleSymbol) {
  const chosen = candlesMod.sourceFor(candleSymbol);
  const ranges = chosen.source === "yahoo" ? ORB_YAHOO_RANGES : ORB_RANGES;
  let lastError = null;
  for (const range of ranges) {
    let bars = [];
    try {
      bars = await candlesMod.getCandles(candleSymbol, ORB_TIMEFRAME, range);
    } catch (err) {
      lastError = err;
    }
    if (Array.isArray(bars) && bars.length >= MIN_HISTORY) {
      return {
        bars,
        range,
        info: candlesMod.seriesInfo(candleSymbol, ORB_TIMEFRAME, range),
      };
    }
    if (!lastError) lastError = new Error(`only ${bars.length} 5m bars for ${range}`);
  }
  return { bars: [], range: ranges[0], info: null, error: lastError };
}

async function evaluateOrb(symbol, candleSymbol) {
  if (symbol !== ORB_SYMBOL) throw new Error(`ORB is NASDAQ-only, not ${symbol}`);
  const series = await orbBars(candleSymbol);
  const bars = series.bars;
  if (bars.length < MIN_HISTORY) {
    const why = series.error ? `: ${series.error.message}` : "";
    throw new Error(`not enough 5m history (${bars.length} bars)${why}`);
  }
  if (!series.info || series.info.actualKnown !== true) {
    throw new Error(`entry series source unknown for ${candleSymbol} 5m ${series.range}`);
  }
  if (series.info.fallback || series.info.depthFallback) {
    const why = series.info.reason ? `: ${series.info.reason}` : "";
    throw new Error(`5m series came from a fallback feed (${series.info.provider})${why}`);
  }

  const cost = currentCost(symbol);
  const costModel = {
    spread: cost.spread,
    slippage: cost.slippage,
    commissionPerLot: cost.commissionPerLot,
    valuePerUnit: cost.valuePerUnit,
  };
  const sim = orbTradesFromBars(bars, costModel);
  const all = sim.trades;
  const blocks = orbBlocks(all);
  const net = all.map((t) => t.r);
  const gross = all.map((t) => t.grossR);
  const oos = summarise(net);
  const grossStats = summarise(gross);
  const t = tStat(net);
  const positiveFolds = blocks.filter((b) => (b.expectancy || 0) > 0).length;
  const avgCost = all.length
    ? Number(
        (all.reduce((a, tr) => a + (Number(tr.totalCostR) || 0), 0) / all.length).toFixed(4)
      )
    : null;
  const reasons = gateReasons(oos, t, positiveFolds);
  const tradable = reasons.length === 0;
  const ruleLabel = "5m ORB, 15m range, 1R, flat by close";
  const verdict = tradable
    ? `gate passed: ${oos.winrate}% win, ${oos.expectancy}R net over ${oos.n} trades (t=${t}), ${positiveFolds}/${BLOCKS} blocks positive — research only, not live`
    : `no edge — ${reasons.join("; ")} (${ruleLabel}, net of modelled costs)`;

  return {
    symbol,
    family: ORB_FAMILY,
    label: "NASDAQ opening-range breakout",
    timeframe: ORB_TIMEFRAME,
    researchOnly: true,
    live: false,
    at: new Date().toISOString(),
    range: series.range,
    // What the provider actually served for that range request.
    covered: candlesMod.coverageOf(bars),
    rule: { ...ORB_RULE },
    evidence: {
      kind: "research",
      family: ORB_FAMILY,
      familyVersion: ORB_RULES_VERSION,
      timeframe: ORB_TIMEFRAME,
      rule: { ...ORB_RULE },
      gate: gateBar(),
      cost,
      entry: { ...series.info, actualKnown: true },
    },
    oos,
    gross: grossStats,
    tStat: t,
    positiveFolds,
    blocks,
    sessions: sim.groups.length,
    tradedSessions: all.length,
    incompleteSessions: sim.incomplete,
    noBreakoutSessions: sim.noBreakout,
    unresolvedTrades: sim.unresolved,
    flat: all.filter((tr) => tr.outcome === "close").length,
    tradable,
    bar: gateBar(),
    cost: {
      spreadUnits: costModel.spread,
      slippageUnits: costModel.slippage,
      commissionPerLot: costModel.commissionPerLot,
      avgCostR: avgCost,
      known: cost.spreadKnown,
    },
    verdict,
  };
}

/* ------------------------ what is missing ----------------------- */

/** Does this market need measuring under the inputs this process holds? */
function isStale(lab, inst, tf, now = Date.now()) {
  const r = lab.results[inst.symbol];
  if (!r || r.timeframe !== tf) return true;
  const at = new Date(r.at).getTime();
  return !Number.isFinite(at) || now - at > RESULT_TTL_MS;
}

/** The cost inputs that change a verdict's numbers, as one compact string. */
function costFingerprint(symbol) {
  const cost = currentCost(symbol);
  return [cost.spread, cost.slippage, cost.commissionPerLot, cost.valuePerUnit].join(",");
}

/**
 * Every input a verdict depends on, as one string: the rule set, the live
 * filters, the gate bar, the cost model and each market's feed. When any of it
 * changes — a rules bump, a filter toggled in settings, a cost or provider
 * change, a different range — anything this process already re-measured
 * measured the old inputs and has to queue again.
 *
 * `input` exists so the signature can be checked without writing settings;
 * omitted fields come from the running configuration.
 */
function seriesSignature(instruments, input = {}) {
  const plan = timeframes.plan(timeframes.entry());
  const rules = input.rules || liveRuleState();
  const gate = input.gate || gateBar();
  const costs = input.costs || null;
  return [
    LAB_RULES_VERSION,
    plan.timeframe,
    plan.labRange,
    plan.fallbackRange,
    rules.mtfFilter ? "mtf" : "nomtf",
    rules.minConfluence,
    gate.trades,
    gate.expectancy,
    gate.tStat,
    gate.positiveFolds,
    gate.blocks,
    ...instruments.map(
      (i) =>
        `${i.symbol}:${i.provider}:${i.providerSymbol}:${
          costs && costs[i.symbol] != null ? costs[i.symbol] : costFingerprint(i.symbol)
        }`
    ),
  ].join("|");
}

/**
 * Why a market has no verdict this build will use, naming the input that moved
 * rather than saying "not measured". `kept` is the verdict readLab() accepted,
 * `stored` is whatever the file holds for that market, and `expected` is what
 * the next run would record now.
 */
function whyUnmeasured({ stored, kept, expected, rulesVersion, timeframe, now = Date.now() }) {
  if (kept) {
    const age = now - new Date(kept.at).getTime();
    return Number.isFinite(age) && age > RESULT_TTL_MS
      ? `verdict is ${Math.round(age / 3600000)}h old`
      : null;
  }
  if (rulesVersion && rulesVersion !== LAB_RULES_VERSION) {
    return `rules changed (${rulesVersion} → ${LAB_RULES_VERSION})`;
  }
  if (!stored) return "never measured";
  if (stored.timeframe !== timeframe) {
    return `measured on ${stored.timeframe || "an unknown timeframe"}, not ${timeframe}`;
  }
  // A stored verdict keeps its evidence under `.evidence`; the expected record
  // from evidenceFor() is itself that evidence. Accept either shape.
  const ev = stored.evidence || stored;
  if (!expected) return "evidence changed";

  const was = ev.entry || {};
  const want = expected.entry || {};
  if (was.range !== want.range || was.configuredProvider !== want.configuredProvider) {
    return `entry series changed (${was.range}/${was.configuredProvider} → ${want.range}/${want.configuredProvider})`;
  }
  if (was.provider !== want.provider || was.fallback !== want.fallback) {
    return `entry feed changed (${was.provider} → ${want.provider}${want.fallback ? " fallback" : ""})`;
  }
  if (!sameFlat(ev.cost, expected.cost, COST_KEYS)) return "cost model changed";
  if (!sameFlat(ev.rules, expected.rules, ["mtfFilter", "minConfluence"])) {
    return "live filters changed";
  }
  if (!sameFlat(ev.gate, expected.gate, Object.keys(expected.gate))) {
    return "gate thresholds changed";
  }
  if (!sameSeries(ev.daily, expected.daily, "daily")) return "daily series changed";
  return "evidence changed";
}

/**
 * Every market with nothing usable behind it, and why. The lab fails closed, so
 * an unmeasured market sends no signals; this answers "is that a holiday, a
 * feed, or just the queue?" — `reason` names the input that retired the last
 * verdict, `open` says whether the market is trading now, and `error` is the
 * last failure this process hit while measuring it.
 */
function pendingReport(instruments = market.instrumentList()) {
  const raw = readLabRaw();
  const lab = readLab();
  const tf = timeframes.entry();
  const plan = timeframes.plan(tf);
  const now = Date.now();
  const rows = [];

  for (const inst of instruments) {
    try {
      const kept = lab.results[inst.symbol];
      const stored = raw && raw.results ? raw.results[inst.symbol] || null : null;
      const range = stored && stored.evidence && stored.evidence.entry ? stored.evidence.entry.range : null;
      const expected =
        range === plan.labRange || range === plan.fallbackRange
          ? evidenceFor(inst.symbol, plan, range)
          : evidenceFor(inst.symbol, plan);
      const reason = whyUnmeasured({
        stored,
        kept,
        expected,
        rulesVersion: raw ? raw.rulesVersion : null,
        timeframe: tf,
        now,
      });
      if (!reason) continue;
      // The calendar knows the session; only the broker knows its own breaks
      // and holidays. A market it says is closed is closed, whatever the
      // calendar believes.
      const state = market.openState(inst.symbol, sessions.instrumentMarketOpen(inst.symbol));
      rows.push({
        symbol: inst.symbol,
        reason,
        open: state.open,
        closedBy: state.closedBy,
        storedAt: stored ? stored.at || null : null,
        error: state.errors[inst.symbol] || null,
      });
    } catch (err) {
      // A display report must not take the endpoint down with it, and a market
      // that could not be checked is unmeasured rather than silently omitted.
      rows.push({
        symbol: inst.symbol,
        reason: `could not check: ${err.message}`,
        open: null,
        closedBy: null,
        storedAt: null,
        error: state.errors[inst.symbol] || null,
      });
    }
  }

  return rows;
}

/* --------------------------- scheduling ------------------------- */

async function runFor(symbol, candleSymbol, timeframe = timeframes.entry()) {
  state.running = true;
  state.lastSymbol = symbol;
  try {
    const result = await evaluateMarket(symbol, candleSymbol, timeframe);
    const lab = readLab();
    lab.results[symbol] = result;
    lab.updatedAt = new Date().toISOString();
    writeLab(lab);
    state.error = null;
    delete state.errors[symbol];
    return result;
  } catch (err) {
    state.error = `${symbol}: ${err.message}`;
    state.errors[symbol] = err.message;
    return null;
  } finally {
    state.running = false;
    state.lastRunAt = Date.now();
  }
}

async function runOrbFor(candleSymbol) {
  state.running = true;
  state.lastSymbol = ORB_SYMBOL;
  try {
    const result = await evaluateOrb(
      ORB_SYMBOL,
      candleSymbol || candleTicker(ORB_SYMBOL)
    );
    // A research run must not delete live verdicts just because this process
    // has not fetched their series yet. Preserve the raw live bucket and let
    // readLab() decide what is usable at read time. An older rules version is
    // different: those verdicts belong to a rule this build no longer runs.
    let lab = null;
    try {
      const raw = fs.readFileSync(LAB_FILE, "utf-8").trim();
      if (raw) lab = JSON.parse(raw);
    } catch {}
    if (!lab || lab.rulesVersion !== LAB_RULES_VERSION) {
      lab = { results: {}, updatedAt: null };
    }
    if (!lab.results || typeof lab.results !== "object") lab.results = {};
    if (!lab.research || typeof lab.research !== "object") lab.research = {};
    lab.research[researchKey(ORB_SYMBOL)] = result;
    lab.updatedAt = new Date().toISOString();
    writeLab(lab);
    state.researchError = null;
    return result;
  } catch (err) {
    state.researchError = `${ORB_FAMILY}: ${err.message}`;
    return null;
  } finally {
    state.running = false;
    state.lastRunAt = Date.now();
  }
}

/** Called every watch cycle. One stale market per 45 minutes, or a burst after a rule change. */
async function maybeRun(instruments) {
  if (state.running) return;

  const signature = seriesSignature(instruments);
  if (signature !== state.signature) {
    // A fresh process, a rule change or a provider switch: markets this process
    // already re-measured did so on different inputs, so they queue again.
    state.signature = signature;
    state.tried.clear();
  }

  const tf = timeframes.entry();
  const lab = readLab();
  const now = Date.now();
  const stale = instruments.filter((inst) => isStale(lab, inst, tf, now));

  // Every market with nothing this build can stand behind is measured back to
  // back, once each, instead of one per 45 minutes. A redeploy that retires
  // several verdicts therefore refills in a few minutes, not a few hours. A
  // market that fails is recorded in state.errors and not retried until the
  // inputs change again, so a broken feed cannot spin the lab.
  const fresh = stale.filter((inst) => !state.tried.has(inst.symbol));
  state.burst = fresh.length > 0;
  if (fresh.length) {
    const target = fresh[0];
    state.tried.add(target.symbol);
    await runFor(target.symbol, target.candleSymbol, tf);
    // A flag left true until the next cycle would claim work is still queued
    // after the backlog has just been cleared.
    state.burst = fresh.length > 1;
  } else if (stale.length && now - state.lastRunAt >= RUN_GAP_MS) {
    await runFor(stale[0].symbol, stale[0].candleSymbol, tf);
  }

  const after = Date.now();
  const orb = readLab().research[researchKey(ORB_SYMBOL)];
  const orbAge = orb ? after - new Date(orb.at).getTime() : Infinity;
  const orbStale = !orb || !Number.isFinite(orbAge) || orbAge > ORB_TTL_MS;
  if (orbStale) {
    const nasdaq = instruments.find((inst) => inst.symbol === ORB_SYMBOL);
    if (nasdaq) await runOrbFor(nasdaq.candleSymbol);
  }
}

/**
 * Existing promotions are kept as brain families. The lab itself no longer
 * nominates grid configs: it measures one fixed rule now, so there is nothing
 * to promote from it. Standing promotions still have to clear the brain's own
 * proof bar.
 */
function families() {
  return promotions.standings([]).map((entry) => ({
    ...strategies.labFamily(entry.cfg),
    promotedAt: entry.firstPromotedAt || null,
  }));
}

function standingPromotions() {
  return promotions.standingSummary(new Set());
}

/** No verdict means no signals. Fail closed. */
function tradable(symbol) {
  const r = readLab().results[symbol];
  return Boolean(r && r.tradable === true);
}

function summary() {
  const lab = readLab();
  return {
    updatedAt: lab.updatedAt,
    timeframe: timeframes.entry(),
    rules: liveRuleState(),
    running: state.running,
    lastRunAt: state.lastRunAt ? new Date(state.lastRunAt).toISOString() : null,
    lastSymbol: state.lastSymbol,
    error: state.error,
    researchError: state.researchError,
    bursting: state.burst,
    results: lab.results,
    research: lab.research,
    // Markets with no verdict this build will use, each with the reason. An
    // empty list means every market is measured; `open:false` says a closure,
    // not a broken feed, is in play.
    pending: pendingReport(),
    gate: Object.fromEntries(
      Object.entries(lab.results).map(([symbol, r]) => [symbol, r.tradable === true])
    ),
  };
}

module.exports = {
  maybeRun,
  runFor,
  families,
  standingPromotions,
  tradable,
  summary,
  evaluateMarket,
  runOrbFor,
  sameEvidence,
  sameResearchEvidence,
  gateReasons,
  orbSessionGroups,
  orbTradesFromBars,
  researchKey,
  gateBar,
  isStale,
  seriesSignature,
  whyUnmeasured,
  pendingReport,
  LAB_RULES_VERSION,
  RESULT_TTL_MS,
  ORB_SYMBOL,
  ORB_FAMILY,
  ORB_TIMEFRAME,
  ORB_RULES_VERSION,
  ORB_RULE,
  ORB_RANGES,
  MIN_EXPECTANCY,
  MIN_TEST_TRADES,
  MIN_TSTAT,
  MIN_POSITIVE_FOLDS,
};
