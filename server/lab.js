/**
 * Strategy lab — the app tests itself.
 *
 * Once per day, in the background and one market at a time, the watcher takes
 * a year of hourly candles, tunes a small grid on older data, and scores it on
 * data it has never seen (walk-forward). The verdict is written to lab.json and
 * shown in the dashboard.
 *
 * Crucially the app is allowed to conclude "no edge". If a market's
 * out-of-sample expectancy is not clearly positive, signal alerts for that
 * market are suppressed automatically. That is the whole point: the app decides
 * on evidence instead of enthusiasm.
 *
 * The grid is deliberately small. A big grid finds edges that do not exist —
 * research/edge_search2.js demonstrated exactly that (1,440 configs scored
 * worse out of sample than 180).
 */

const fs = require("fs");
const path = require("path");
const { writeJson } = require("./atomicWrite");

const candlesMod = require("./candles");
const autozones = require("./autozones");
const stopsMod = require("./stops");
const { RULES_VERSION, labFamily, promoteLabConfigs } = require("./strategies");
const promotions = require("./promotions");

const LAB_FILE = require("./stateDir").file("lab.json");

const WINDOW = 200;
const MAX_HOLD = 72;
const FOLDS = 3;
const MIN_TRAIN_TRADES = 15;

// The evidence bar for sending a signal. Raised deliberately: a market now
// needs a large unseen sample, a meaningful expectancy, and statistical
// significance before the app will put it on your phone.
const MIN_TEST_TRADES = 100; // was 20
const MIN_EXPECTANCY = 0.08; // R per trade, was 0.02
const MIN_TSTAT = 2; // expectancy must be ~2 standard errors from zero
const MIN_POSITIVE_FOLDS = 1; // at least one unseen block must be profitable
const RUN_GAP_MS = 45 * 60 * 1000; // one market every 45 minutes
const RESULT_TTL_MS = 24 * 60 * 60 * 1000;

const GRID = [];
for (const mult of [1.2, 1.4, 1.8]) {
  for (const stopMode of ["zone_width", "atr"]) {
    for (const rr of [1, 2]) GRID.push({ mult, stopMode, rr });
  }
}

const state = { running: false, lastRunAt: 0, lastSymbol: null, error: null, burst: false };

function readLab() {
  try {
    const raw = fs.readFileSync(LAB_FILE, "utf-8").trim();
    if (!raw) return { results: {}, updatedAt: null };
    const parsed = JSON.parse(raw);
    // Stored verdicts from an older rule set are not reproducible: the stops
    // were managed differently, so the R figures cannot be compared. Drop them
    // and re-measure rather than gating alerts on numbers nobody can repeat.
    if (parsed.rulesVersion !== RULES_VERSION) {
      state.burst = true;
      return { results: {}, updatedAt: parsed.updatedAt || null };
    }
    return { results: parsed.results || {}, updatedAt: parsed.updatedAt || null };
  } catch {
    return { results: {}, updatedAt: null };
  }
}

function writeLab(lab) {
  try {
    lab.rulesVersion = RULES_VERSION;
    writeJson(LAB_FILE, lab, 2);
  } catch (err) {
    state.error = err.message;
  }
}

/* ---------------------------- maths ---------------------------- */

function atrSeries(bars, period = 14) {
  const out = new Array(bars.length).fill(null);
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const p = bars[i - 1];
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
  }
  let sum = 0;
  for (let i = 0; i < period && i < trs.length; i++) sum += trs[i];
  let value = sum / period;
  out[period] = value;
  for (let i = period; i < trs.length; i++) {
    value = (value * (period - 1) + trs[i]) / period;
    out[i + 1] = value;
  }
  return out;
}

function buildZones(bars, mult) {
  const cache = new Array(bars.length).fill(null);
  for (let i = WINDOW; i < bars.length; i++) {
    const win = bars.slice(i - WINDOW, i + 1);
    const detected = autozones.detectZones(win, { displacementMult: mult, maxPerSide: 4 });
    cache[i] = detected.map((z) => ({
      type: z.type,
      low: z.low,
      high: z.high,
      touches: z.touches,
    }));
  }
  return cache;
}

function simulate(bars, zones, atr, from, to, cfg) {
  const trades = [];

  for (let i = Math.max(from, WINDOW + 2); i < to; i++) {
    const bar = bars[i];
    const list = zones[i];
    if (!list || !list.length) continue;
    const a = atr[i];
    if (!a) continue;

    for (const zone of list) {
      if (!(bar.c >= zone.low && bar.c <= zone.high)) continue;

      const side = zone.type === "demand" ? "BUY" : "SELL";
      const width = Math.max(zone.high - zone.low, a * 0.1);
      const entry = bar.c;
      const stop =
        cfg.stopMode === "zone_width"
          ? side === "BUY"
            ? zone.low - width * 0.5
            : zone.high + width * 0.5
          : side === "BUY"
            ? entry - a
            : entry + a;

      const risk = Math.abs(entry - stop);
      if (!(risk > 0)) continue;
      const target = side === "BUY" ? entry + risk * cfg.rr : entry - risk * cfg.rr;

      // The same stop ladder the executor runs: break-even at 1R, then 0.5R
      // behind the best price. A zone trade that stalls short of its target
      // keeps what it earned instead of handing it all back, and the lab scores
      // the exit the bot would actually have taken.
      let held = stop;
      let peakR = 0;
      let exit = null;
      for (let j = i + 1; j < Math.min(i + MAX_HOLD, to); j++) {
        const b = bars[j];
        const hitStop = side === "BUY" ? b.l <= held : b.h >= held;
        const hitTarget = side === "BUY" ? b.h >= target : b.l <= target;
        if (hitStop) {
          // The stop in force at the start of the bar decides the fill.
          exit = (side === "BUY" ? held - entry : entry - held) / risk;
          break;
        }
        if (hitTarget) {
          exit = cfg.rr;
          break;
        }
        peakR = Math.max(peakR, side === "BUY" ? (b.h - entry) / risk : (entry - b.l) / risk);
        held = stopsMod.protect({ side, entry, stop: held, peakR, initialStop: stop });
      }

      if (exit != null) {
        trades.push(Number(exit.toFixed(4)));
        break;
      }
    }
  }

  return trades;
}

/** How many standard errors the average R sits from zero. */
function tStat(trades) {
  const n = trades.length;
  if (n < 2) return null;
  const mean = trades.reduce((a, b) => a + b, 0) / n;
  const variance = trades.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  if (!sd) return null;
  return Number((mean / (sd / Math.sqrt(n))).toFixed(2));
}

function summarise(trades) {
  const n = trades.length;
  if (!n) return { n: 0, winrate: null, totalR: 0, expectancy: null };
  const wins = trades.filter((r) => r > 0).length;
  const totalR = trades.reduce((a, b) => a + b, 0);
  return {
    n,
    winrate: Number(((wins / n) * 100).toFixed(1)),
    totalR: Number(totalR.toFixed(2)),
    expectancy: Number((totalR / n).toFixed(3)),
  };
}

/* ------------------------- one market -------------------------- */

async function evaluateMarket(symbol, candleSymbol) {
  const bars = await candlesMod.getCandles(candleSymbol, "1h", "1y");
  if (!bars || bars.length < 600) throw new Error("not enough history");

  const atr = atrSeries(bars, 14);
  const zoneCache = {};
  for (const m of [1.2, 1.4, 1.8]) zoneCache[m] = buildZones(bars, m);

  const foldSize = Math.floor(bars.length / FOLDS);
  const bounds = [0, foldSize, foldSize * 2, bars.length];

  const oosTrades = [];
  const chosen = [];

  for (let k = 0; k < FOLDS - 1; k++) {
    const trainEnd = bounds[k + 1];
    const testEnd = bounds[k + 2];

    let best = null;
    for (const cfg of GRID) {
      const sum = summarise(simulate(bars, zoneCache[cfg.mult], atr, 0, trainEnd, cfg));
      if (sum.n < MIN_TRAIN_TRADES) continue;
      if (!best || sum.expectancy > best.sum.expectancy) best = { cfg, sum };
    }
    if (!best) continue;

    const test = simulate(bars, zoneCache[best.cfg.mult], atr, trainEnd, testEnd, best.cfg);
    oosTrades.push(...test);
    chosen.push({ fold: k + 1, cfg: best.cfg, train: best.sum, test: summarise(test) });
  }

  const oos = summarise(oosTrades);
  const t = tStat(oosTrades);
  const positiveFolds = chosen.filter((c) => (c.test.expectancy || 0) > 0).length;

  const reasons = [];
  if (oos.n < MIN_TEST_TRADES) reasons.push(`${oos.n} unseen trades (needs ${MIN_TEST_TRADES})`);
  if (oos.expectancy == null || oos.expectancy <= MIN_EXPECTANCY)
    reasons.push(`${oos.expectancy}R per trade (needs above ${MIN_EXPECTANCY}R)`);
  if (t == null || t < MIN_TSTAT) reasons.push(`t-stat ${t ?? "n/a"} (needs ${MIN_TSTAT})`);
  if (positiveFolds < MIN_POSITIVE_FOLDS) reasons.push("no profitable unseen block");

  const tradable = reasons.length === 0;

  return {
    symbol,
    at: new Date().toISOString(),
    oos,
    tStat: t,
    positiveFolds,
    chosen,
    tradable,
    bar: {
      trades: MIN_TEST_TRADES,
      expectancy: MIN_EXPECTANCY,
      tStat: MIN_TSTAT,
      positiveFolds: MIN_POSITIVE_FOLDS,
    },
    verdict: tradable
      ? `edge: ${oos.winrate}% , ${oos.expectancy}R per trade over ${oos.n} unseen trades (t=${t})`
      : `no edge — ${reasons.join("; ")}`,
  };
}

/* --------------------------- scheduling ------------------------- */

async function runFor(symbol, candleSymbol) {
  state.running = true;
  state.lastSymbol = symbol;
  try {
    const result = await evaluateMarket(symbol, candleSymbol);
    const lab = readLab();
    lab.results[symbol] = result;
    lab.updatedAt = new Date().toISOString();
    writeLab(lab);
    state.error = null;
    return result;
  } catch (err) {
    state.error = `${symbol}: ${err.message}`;
    return null;
  } finally {
    state.running = false;
    state.lastRunAt = Date.now();
  }
}

/**
 * Called every watch cycle. Runs one stale market per RUN_GAP_MS so the app
 * keeps re-testing itself without hammering Yahoo or blocking the watcher.
 */
async function maybeRun(instruments) {
  if (state.running) return;
  // After a rule change every market is stale at once; one per watch cycle
  // until the backlog clears, then back to the ordinary pace.
  const gap = state.burst ? 0 : RUN_GAP_MS;
  if (Date.now() - state.lastRunAt < gap) return;

  const lab = readLab();
  const now = Date.now();

  const stale = instruments.find((inst) => {
    const r = lab.results[inst.symbol];
    if (!r) return true;
    return now - new Date(r.at).getTime() > RESULT_TTL_MS;
  });

  if (!stale) {
    state.burst = false;
    return;
  }
  await runFor(stale.symbol, stale.candleSymbol);
}

/**
 * The configs this lab has put ahead on unseen bars, handed to the brain as
 * families it can measure everywhere. Memoised for a minute: readBrain asks
 * often, and lab.json only changes when a market finishes its test.
 *
 * Today's nominations are folded into the standing list on disk, never
 * substituted for it. A config that was promoted stays in front of the brain
 * after a later lab run stops nominating it, so the cells already measured for
 * it — and any champion it earned — are not deleted by a routine update. It
 * still has to clear the same proof bar on every measurement; stickiness keeps
 * the rule under test, it proves nothing.
 */
let familyMemo = { at: 0, list: [] };

function families() {
  if (Date.now() - familyMemo.at < 60 * 1000) return familyMemo.list;
  const nominated = promoteLabConfigs(readLab().results);
  const list = promotions.standings(nominated).map((entry) => labFamily(entry.cfg));
  familyMemo = { at: Date.now(), list };
  return list;
}

/** Is this market allowed to send signal alerts? Unknown markets are allowed. */
function tradable(symbol) {
  const lab = readLab();
  const r = lab.results[symbol];
  if (!r) return true; // never tested yet
  return r.tradable === true;
}

function summary() {
  const lab = readLab();
  return {
    updatedAt: lab.updatedAt,
    running: state.running,
    lastRunAt: state.lastRunAt ? new Date(state.lastRunAt).toISOString() : null,
    lastSymbol: state.lastSymbol,
    error: state.error,
    results: lab.results,
    gate: Object.fromEntries(
      Object.entries(lab.results).map(([symbol, r]) => [symbol, r.tradable === true])
    ),
  };
}

module.exports = {
  maybeRun,
  runFor,
  families,
  tradable,
  summary,
  evaluateMarket,
  MIN_EXPECTANCY,
  MIN_TEST_TRADES,
  MIN_TSTAT,
};
