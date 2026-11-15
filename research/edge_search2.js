/**
 * Second pass: refine around the families that survived pass one, and add
 * zone-quality filters (freshness, displacement strength, position in zone).
 *
 * Same discipline: tune on earlier folds, measure only on unseen ones.
 *
 * Run: node research/edge_search2.js
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
const RR = 2;
const MAX_HOLD = 72;
const MIN_TRAIN_TRADES = 12;

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

function entryMatches(mode, zone, bar, atr) {
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
  return inside;
}

function qualityOk(cfg, zone, bar, atr) {
  if (zone.touches > cfg.touchesMax) return false;
  if (zone.strength < cfg.strengthMin) return false;

  // Require the entry to happen in the outer half of the zone: better price.
  const width = zone.high - zone.low;
  if (width <= 0) return false;
  if (cfg.edgeHalf) {
    const pos = (bar.c - zone.low) / width;
    if (zone.type === "demand" && pos > 0.5) return false;
    if (zone.type === "supply" && pos < 0.5) return false;
  }
  return true;
}

function stopPrice(mode, zone, entry, side, atr) {
  const width = zone.high - zone.low;
  if (mode === "zone_width") {
    return side === "BUY" ? zone.low - width * 0.5 : zone.high + width * 0.5;
  }
  if (mode === "atr") {
    return side === "BUY" ? entry - atr : entry + atr;
  }
  if (mode === "far_edge") {
    return side === "BUY" ? zone.low - atr * 0.1 : zone.high + atr * 0.1;
  }
  return side === "BUY" ? zone.low - atr * 0.1 : zone.high + atr * 0.1;
}

function trendOk(filter, side, trend) {
  if (!filter.startsWith("trend")) return true;
  if (!trend || trend === "flat") return false;
  return side === "BUY" ? trend === "up" : trend === "down";
}

function sessionOk(filter, bar) {
  if (!filter.includes("session")) return true;
  const hour = new Date(bar.t).getUTCHours();
  return hour >= 7 && hour < 21;
}

function simulate(bars, zonesByBar, trend, atr, from, to, cfg) {
  const trades = [];

  for (let i = Math.max(from, WINDOW + 60); i < to; i++) {
    const bar = bars[i];
    const list = zonesByBar[i];
    if (!list || !list.length) continue;
    const a = atr[i];
    if (!a) continue;
    if (!sessionOk(cfg.filter, bar)) continue;

    for (const zone of list) {
      if (!qualityOk(cfg, zone, bar, a)) continue;
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
        break;
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

async function main() {
  const grid = [];
  for (const mult of [1.2, 1.4, 1.6, 1.8, 2.0])
    for (const entry of ["inside", "reject"])
      for (const stop of ["zone_width", "atr", "far_edge"])
        for (const filter of ["none", "trend", "session", "trend_session"])
          for (const touchesMax of [0, 1, 99])
            for (const strengthMin of [0, 1.8])
              for (const edgeHalf of [false, true])
                grid.push({ mult, entry, stop, filter, touchesMax, strengthMin, edgeHalf });

  console.log(`grid size: ${grid.length}`);

  const oos = [];
  const steps = [];

  for (const s of SYMBOLS) {
    console.log(`\n===== ${s.sym} =====`);
    const bars = await candlesMod.getCandles(s.tkr, INTERVAL, RANGE);
    const atr = atrSeries(bars, 14);
    const trend = buildTrend(bars);
    const zoneCache = {};
    for (const mult of [1.2, 1.4, 1.6, 1.8, 2.0]) zoneCache[mult] = buildZones(bars, mult);

    const foldSize = Math.floor(bars.length / 4);
    const bounds = [0, foldSize, foldSize * 2, foldSize * 3, bars.length];

    for (let k = 0; k < 3; k++) {
      const trainEnd = bounds[k + 1];
      const testEnd = bounds[k + 2];

      let best = null;
      for (const cfg of grid) {
        const sum = summarise(
          simulate(bars, zoneCache[cfg.mult], trend, atr, 0, trainEnd, cfg)
        );
        if (sum.n < MIN_TRAIN_TRADES) continue;
        if (!best || sum.expectancy > best.sum.expectancy) best = { cfg, sum };
      }

      if (!best) continue;

      const testSum = summarise(
        simulate(bars, zoneCache[best.cfg.mult], trend, atr, trainEnd, testEnd, best.cfg)
      );
      oos.push(...simulate(bars, zoneCache[best.cfg.mult], trend, atr, trainEnd, testEnd, best.cfg));

      steps.push({ sym: s.sym, step: k + 1, cfg: best.cfg, test: testSum });
      console.log(
        `step ${k + 1}: ${best.cfg.mult}/${best.cfg.entry}/${best.cfg.stop}/${best.cfg.filter}/t<=${best.cfg.touchesMax}/s>=${best.cfg.strengthMin}/half=${best.cfg.edgeHalf}` +
          ` train ${best.sum.n}t ${best.sum.expectancy}R → OOS ${testSum.n}t ${testSum.winrate}% ${testSum.expectancy}R`
      );
    }
  }

  const final = summarise(oos);
  console.log("\n===== OUT-OF-SAMPLE =====");
  console.log(JSON.stringify(final, null, 2));
  console.log(final.winrate >= 45 ? "Target 45% ACHIEVED" : "Target 45% NOT ACHIEVED");
}

main().catch((err) => {
  console.error("search failed:", err);
  process.exit(1);
});
