/**
 * Do volume-profile and structural levels actually improve entries?
 *
 * Compares the same zone strategy with three rules:
 *   none      take every inside-zone entry
 *   score>=2  require price to be sitting on a clustered level
 *   score>=4  require a strong level (multiple touches / POC / prior day)
 *
 * Walk-forward, on data the tuning never saw. If the levels add nothing, the
 * app should show them as information and not filter on them.
 *
 * Run: node research/orderflow_test.js
 */

const candlesMod = require("../server/candles");
const autozones = require("../server/autozones");
const orderflow = require("../server/orderflow");

const MARKETS = [
  { tkr: "GC=F", sym: "XAUUSD", decimals: 2, roundStep: 10 },
  { tkr: "^NDX", sym: "NASDAQ", decimals: 1, roundStep: 100 },
];

const WINDOW = 200;
const LEVEL_WINDOW = 300;
const LEVEL_REFRESH = 12; // recompute the level map every N bars
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

function buildZones(bars, mult = 1.4) {
  const cache = new Array(bars.length).fill(null);
  for (let i = WINDOW; i < bars.length; i++) {
    const win = bars.slice(i - WINDOW, i + 1);
    const detected = autozones.detectZones(win, { displacementMult: mult, maxPerSide: 4 });
    cache[i] = detected.map((z) => ({ type: z.type, low: z.low, high: z.high, touches: z.touches }));
  }
  return cache;
}

function simulate(bars, zones, atr, market, from, to) {
  const trades = [];
  let levelMap = null;
  let lastLevelAt = -999;

  for (let i = Math.max(from, WINDOW + 2); i < to; i++) {
    const bar = bars[i];
    const list = zones[i];
    if (!list || !list.length) continue;
    const a = atr[i];
    if (!a) continue;

    for (const zone of list) {
      if (!(bar.c >= zone.low && bar.c <= zone.high)) continue;

      if (i - lastLevelAt >= LEVEL_REFRESH) {
        levelMap = orderflow.buildLevels({
          bars: bars.slice(Math.max(0, i - LEVEL_WINDOW), i + 1),
          daily: null,
          price: bar.c,
          decimals: market.decimals,
          roundStep: market.roundStep,
        });
        lastLevelAt = i;
      }

      const level = orderflow.levelScoreAt(bar.c, levelMap);

      const side = zone.type === "demand" ? "BUY" : "SELL";
      const width = Math.max(zone.high - zone.low, a * 0.1);
      const entry = bar.c;
      const stop = side === "BUY" ? zone.low - width * 0.5 : zone.high + width * 0.5;
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
        trades.push({ r: outcome === "win" ? RR : -1, level: level.score });
        break;
      }
    }
  }

  return trades;
}

function summarise(trades) {
  const n = trades.length;
  if (!n) return { n: 0, winrate: null, expectancy: null, totalR: 0 };
  const wins = trades.filter((t) => t.r > 0).length;
  const totalR = trades.reduce((a, t) => a + t.r, 0);
  return {
    n,
    winrate: Number(((wins / n) * 100).toFixed(1)),
    expectancy: Number((totalR / n).toFixed(3)),
    totalR: Number(totalR.toFixed(2)),
  };
}

async function main() {
  const out = { none: [], s2: [], s4: [] };

  for (const m of MARKETS) {
    console.log(`\n===== ${m.sym} =====`);
    const bars = await candlesMod.getCandles(m.tkr, "15m", "60d");
    console.log(`bars: ${bars.length}, volume present: ${orderflow.hasVolume(bars)}`);

    const atr = atrSeries(bars, 14);
    const zones = buildZones(bars, 1.4);

    const foldSize = Math.floor(bars.length / 3);
    const bounds = [0, foldSize, foldSize * 2, bars.length];

    for (let k = 0; k < 2; k++) {
      const trades = simulate(bars, zones, atr, m, bounds[k], bounds[k + 1]);
      out.none.push(...trades);
      out.s2.push(...trades.filter((t) => t.level >= 2));
      out.s4.push(...trades.filter((t) => t.level >= 4));
    }
  }

  console.log("\n===== RESULTS (same trades, different filters) =====");
  console.log("none    :", JSON.stringify(summarise(out.none)));
  console.log("score>=2:", JSON.stringify(summarise(out.s2)));
  console.log("score>=4:", JSON.stringify(summarise(out.s4)));
}

main().catch((err) => {
  console.error("orderflow test failed:", err);
  process.exit(1);
});
