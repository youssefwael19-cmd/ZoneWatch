/**
 * Strategy search with walk-forward validation.
 *
 * Target: at least 45% win rate at a fixed 1:2 risk/reward, measured only on
 * data the tuning never saw. At 2R that is +0.35R per trade.
 *
 * Design notes:
 *  - Zones are precomputed once per displacement setting per bar (rolling
 *    200-bar window) so the grid search stays fast.
 *  - Nothing looks ahead: entries use bar i, outcomes scan forward only.
 *  - Walk-forward: tune on earlier folds, measure on the next unseen fold.
 *
 * Run: node research/edge_search.js
 */

const candlesMod = require("../server/candles");
const autozones = require("../server/autozones");

const SYMBOLS = [
  { tkr: "GC=F", sym: "XAUUSD" },
  { tkr: "^NDX", sym: "NASDAQ" },
];

const RANGE = "1y";
const INTERVAL = "1h";
const WINDOW = 200;
const RR = 2; // fixed 1:2
const MAX_HOLD = 72; // bars to resolve
const MIN_TRAIN_TRADES = 15;

/* ------------------------------------------------------------------ */
/* Precomputation                                                      */
/* ------------------------------------------------------------------ */

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

function emaAt(closes, period, index) {
  const k = 2 / (period + 1);
  let value = closes[0];
  for (let i = 1; i <= index; i++) value = closes[i] * k + value * (1 - k);
  return value;
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
      strength: z.strength,
    }));
  }
  return cache;
}

function buildTrend(bars) {
  const closes = bars.map((b) => b.c);
  const out = new Array(bars.length).fill(null);
  for (let i = 60; i < bars.length; i++) {
    const fast = emaAt(closes, 20, i);
    const slow = emaAt(closes, 50, i);
    out[i] = fast > slow ? "up" : fast < slow ? "down" : "flat";
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Simulation                                                          */
/* ------------------------------------------------------------------ */

function entryMatches(mode, zone, bar, atr, sideAlready) {
  const inside = bar.c >= zone.low && bar.c <= zone.high;

  if (mode === "inside") return inside;

  if (mode === "reject") {
    if (!inside) return false;
    const body = Math.abs(bar.c - bar.o);
    if (body === 0) return false;
    const lowerWick = Math.min(bar.o, bar.c) - bar.l;
    const upperWick = bar.h - Math.max(bar.o, bar.c);
    return zone.type === "demand" ? lowerWick > body : upperWick > body;
  }

  if (mode === "edge") {
    if (inside) return false;
    const approachUp = bar.h >= zone.low - atr * 0.25 && bar.h <= zone.low + atr * 0.25;
    const approachDown = bar.l >= zone.high - atr * 0.25 && bar.l <= zone.high + atr * 0.25;
    return zone.type === "demand" ? approachUp : approachDown;
  }

  return false;
}

function stopPrice(mode, zone, entry, side, atr) {
  const width = zone.high - zone.low;
  if (mode === "far_edge") {
    return side === "BUY" ? zone.low - atr * 0.1 : zone.high + atr * 0.1;
  }
  if (mode === "atr") {
    return side === "BUY" ? entry - atr : entry + atr;
  }
  if (mode === "zone_width") {
    return side === "BUY" ? zone.low - width * 0.5 : zone.high + width * 0.5;
  }
  return side === "BUY" ? zone.low - atr * 0.1 : zone.high + atr * 0.1;
}

function passesFilter(filter, bar, i, trend, zone) {
  if (filter === "none") return true;
  if (filter === "fresh") return zone.touches === 0;

  const hour = new Date(bar.t).getUTCHours();
  const londonNy = hour >= 7 && hour < 21;

  if (filter === "trend") return true; // applied separately (needs side)
  if (filter === "trend_session") return londonNy;
  if (filter === "session") return londonNy;
  return true;
}

function trendOk(filter, side, trend) {
  if (!filter.startsWith("trend")) return true;
  if (!trend || trend === "flat") return true;
  return side === "BUY" ? trend === "up" : trend === "down";
}

function simulate(bars, zonesByBar, trend, atr, from, to, cfg) {
  const trades = [];

  for (let i = Math.max(from, WINDOW + 60); i < to; i++) {
    const bar = bars[i];
    const list = zonesByBar[i];
    if (!list || !list.length) continue;
    const a = atr[i];
    if (!a) continue;

    for (const zone of list) {
      if (!passesFilter(cfg.filter, bar, i, trend[i], zone)) continue;
      if (!entryMatches(cfg.entry, zone, bar, a)) continue;

      const side = zone.type === "demand" ? "BUY" : "SELL";
      if (!trendOk(cfg.filter, side, trend[i])) continue;

      const entry = bar.c;
      const stop = stopPrice(cfg.stop, zone, entry, side, a);
      const risk = Math.abs(entry - stop);
      if (!(risk > 0)) continue;

      const target = side === "BUY" ? entry + risk * RR : entry - risk * RR;

      let outcome = null;
      for (let j = i + 1; j < Math.min(i + MAX_HOLD, to); j++) {
        const b = bars[j];
        if (side === "BUY") {
          if (b.l <= stop) {
            outcome = "loss";
            break;
          }
          if (b.h >= target) {
            outcome = "win";
            break;
          }
        } else {
          if (b.h >= stop) {
            outcome = "loss";
            break;
          }
          if (b.l <= target) {
            outcome = "win";
            break;
          }
        }
      }

      if (outcome) {
        trades.push(outcome === "win" ? RR : -1);
        break; // one trade per bar
      }
    }
  }

  return trades;
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

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const MULT = [1.2, 1.4, 1.6, 2.0];
  const ENTRY = ["inside", "reject", "edge"];
  const STOP = ["far_edge", "atr", "zone_width"];
  const FILTER = ["none", "fresh", "trend", "trend_session", "session"];

  const grid = [];
  for (const mult of MULT)
    for (const entry of ENTRY)
      for (const stop of STOP)
        for (const filter of FILTER) grid.push({ mult, entry, stop, filter });

  console.log(`grid size: ${grid.length} configs`);

  const oosTrades = [];
  const perStep = [];

  for (const s of SYMBOLS) {
    console.log(`\n===== ${s.sym} (${s.tkr}) =====`);
    const bars = await candlesMod.getCandles(s.tkr, INTERVAL, RANGE);
    console.log(
      `bars: ${bars.length} | ${new Date(bars[0].t).toISOString().slice(0, 10)} → ${new Date(bars[bars.length - 1].t).toISOString().slice(0, 10)}`
    );

    const atr = atrSeries(bars, 14);
    const trend = buildTrend(bars);
    const zoneCache = {};
    for (const mult of MULT) zoneCache[mult] = buildZones(bars, mult);

    const foldSize = Math.floor(bars.length / 4);
    const bounds = [0, foldSize, foldSize * 2, foldSize * 3, bars.length];

    for (let k = 0; k < 3; k++) {
      const trainEnd = bounds[k + 1];
      const testStart = bounds[k + 1];
      const testEnd = bounds[k + 2];

      let best = null;
      for (const cfg of grid) {
        const tr = simulate(bars, zoneCache[cfg.mult], trend, atr, bounds[0], trainEnd, cfg);
        const sum = summarise(tr);
        if (sum.n < MIN_TRAIN_TRADES) continue;
        if (!best || sum.expectancy > best.sum.expectancy) best = { cfg, sum };
      }

      if (!best) {
        console.log(`step ${k + 1}: no config with enough training trades`);
        continue;
      }

      const test = simulate(bars, zoneCache[best.cfg.mult], trend, atr, testStart, testEnd, best.cfg);
      const testSum = summarise(test);
      oosTrades.push(...test);

      perStep.push({ symbol: s.sym, step: k + 1, cfg: best.cfg, train: best.sum, test: testSum });

      console.log(
        `step ${k + 1}: ${best.cfg.mult}/${best.cfg.entry}/${best.cfg.stop}/${best.cfg.filter} ` +
          `train ${best.sum.n}t ${best.sum.expectancy}R → OOS ${testSum.n}t ${testSum.winrate}% ${testSum.expectancy}R`
      );
    }
  }

  console.log("\n===== OUT-OF-SAMPLE (all steps) =====");
  console.log(JSON.stringify(summarise(oosTrades), null, 2));

  const finalSum = summarise(oosTrades);
  const hit = finalSum.winrate != null && finalSum.winrate >= 45;
  console.log(`\nTarget 45% @ 1:${RR} → ${hit ? "ACHIEVED" : "NOT ACHIEVED"}`);

  console.log("\nBest individual steps by OOS expectancy:");
  perStep
    .slice()
    .sort((a, b) => (b.test.expectancy || -99) - (a.test.expectancy || -99))
    .slice(0, 5)
    .forEach((p) => {
      console.log(
        `  ${p.symbol} step${p.step} ${p.cfg.mult}/${p.cfg.entry}/${p.cfg.stop}/${p.cfg.filter} → ${p.test.winrate}% ${p.test.n}t ${p.test.expectancy}R`
      );
    });
}

main().catch((err) => {
  console.error("search failed:", err);
  process.exit(1);
});
