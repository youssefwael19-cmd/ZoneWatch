/**
 * Does the "profitable trader knowledge" actually help?
 *
 * The app now scores each setup against five documented rules:
 *   1. 1h trend agrees
 *   2. daily bias agrees
 *   3. volatility expanded
 *   4. London or New York session
 *   5. zone is fresh
 *
 * This measures the fixed strategy (inside zone, half zone-width stop, 2R)
 * at every minimum score from 0 to 5, walk-forward: threshold chosen on
 * earlier data, scored on data never seen.
 *
 * Run: node research/confluence_test.js
 */

const candlesMod = require("../server/candles");
const autozones = require("../server/autozones");

const SYMBOLS = [
  { tkr: "GC=F", sym: "XAUUSD" },
  { tkr: "^NDX", sym: "NASDAQ" },
  { tkr: "EURUSD=X", sym: "EURUSD" },
  { tkr: "AUDJPY=X", sym: "AUDJPY" },
];

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

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let v = values[0];
  for (let i = 0; i < values.length; i++) {
    v = i === 0 ? values[0] : values[i] * k + v * (1 - k);
    out[i] = v;
  }
  return out;
}

function trendAt(closes, index) {
  if (index < 55) return null;
  const fast = ema(closes.slice(0, index + 1), 20)[index];
  const slow = ema(closes.slice(0, index + 1), 50)[index];
  if (!Number.isFinite(fast) || !Number.isFinite(slow)) return null;
  return fast > slow ? "up" : fast < slow ? "down" : "flat";
}

function dailyBiasAt(dailyBars, timestamp) {
  if (!dailyBars || dailyBars.length < 210) return null;
  let last = -1;
  for (let i = 0; i < dailyBars.length; i++) {
    if (dailyBars[i].t <= timestamp) last = i;
    else break;
  }
  if (last < 205) return null;
  const closes = dailyBars.slice(0, last + 1).map((b) => b.c);
  const fast = ema(closes, 50)[closes.length - 1];
  const slow = ema(closes, 200)[closes.length - 1];
  if (!Number.isFinite(fast) || !Number.isFinite(slow)) return null;
  return fast > slow ? "up" : fast < slow ? "down" : "flat";
}

function volExpandedAt(bars, index) {
  if (index < 120) return null;
  const trs = [];
  for (let i = index - 120 + 1; i <= index; i++) {
    const b = bars[i];
    const p = bars[i - 1];
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
  }
  const current = trs.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const sorted = [...trs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return current > median;
}

function buildZones(bars) {
  const cache = new Array(bars.length).fill(null);
  for (let i = WINDOW; i < bars.length; i++) {
    const win = bars.slice(i - WINDOW, i + 1);
    const detected = autozones.detectZones(win, { displacementMult: 1.4, maxPerSide: 4 });
    cache[i] = detected.map((z) => ({
      type: z.type,
      low: z.low,
      high: z.high,
      touches: z.touches,
    }));
  }
  return cache;
}

/**
 * @returns trades with the confluence score attached, so any threshold can be
 * applied afterwards without re-simulating.
 */
function simulateScored(bars, dailyBars, zones, atr, from, to) {
  const closes = bars.map((b) => b.c);
  const trades = [];

  for (let i = Math.max(from, WINDOW + 60); i < to; i++) {
    const bar = bars[i];
    const list = zones[i];
    if (!list || !list.length) continue;
    const a = atr[i];
    if (!a) continue;

    for (const zone of list) {
      if (!(bar.c >= zone.low && bar.c <= zone.high)) continue;

      const side = zone.type === "demand" ? "BUY" : "SELL";
      const htf = trendAt(closes, i);
      const day = dailyBiasAt(dailyBars, bar.t);
      const vol = volExpandedAt(bars, i);
      const hour = new Date(bar.t).getUTCHours();

      const checks = [
        Boolean(htf) && (side === "BUY" ? htf === "up" : htf === "down"),
        Boolean(day) && (side === "BUY" ? day === "up" : day === "down"),
        vol === true,
        hour >= 7 && hour < 21,
        Number(zone.touches) <= 1,
      ];
      const score = checks.filter(Boolean).length;

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
        trades.push({ r: outcome === "win" ? RR : -1, score });
        break;
      }
    }
  }

  return trades;
}

function summarise(trades) {
  const n = trades.length;
  if (!n) return { n: 0, winrate: null, totalR: 0, expectancy: null };
  const wins = trades.filter((t) => t.r > 0).length;
  const totalR = trades.reduce((a, t) => a + t.r, 0);
  return {
    n,
    winrate: Number(((wins / n) * 100).toFixed(1)),
    totalR: Number(totalR.toFixed(2)),
    expectancy: Number((totalR / n).toFixed(3)),
  };
}

async function main() {
  const resultsByThreshold = new Map();
  for (let t = 0; t <= 5; t++) resultsByThreshold.set(t, []);

  const steps = [];

  for (const s of SYMBOLS) {
    console.log(`\n===== ${s.sym} =====`);
    const bars = await candlesMod.getCandles(s.tkr, "1h", "1y");
    let dailyBars = [];
    try {
      dailyBars = await candlesMod.getCandles(s.tkr, "1d", "2y");
    } catch {}

    const atr = atrSeries(bars, 14);
    const zones = buildZones(bars);
    const foldSize = Math.floor(bars.length / 4);
    const bounds = [0, foldSize, foldSize * 2, foldSize * 3, bars.length];

    for (let k = 0; k < 3; k++) {
      const trainEnd = bounds[k + 1];
      const testEnd = bounds[k + 2];

      const trainTrades = simulateScored(bars, dailyBars, zones, atr, 0, trainEnd);
      let best = null;
      for (let t = 0; t <= 5; t++) {
        const sum = summarise(trainTrades.filter((x) => x.score >= t));
        if (sum.n < MIN_TRAIN_TRADES) continue;
        if (!best || sum.expectancy > best.sum.expectancy) best = { t, sum };
      }
      if (!best) continue;

      const testTrades = simulateScored(bars, dailyBars, zones, atr, trainEnd, testEnd);
      for (let t = 0; t <= 5; t++) {
        resultsByThreshold.get(t).push(...testTrades.filter((x) => x.score >= t));
      }

      const chosen = summarise(testTrades.filter((x) => x.score >= best.t));
      steps.push({ sym: s.sym, step: k + 1, threshold: best.t, test: chosen });
      console.log(
        `step ${k + 1}: chosen min score ${best.t} (train ${best.sum.n}t ${best.sum.expectancy}R) → ` +
          `OOS ${chosen.n}t ${chosen.winrate}% ${chosen.expectancy}R`
      );
    }
  }

  console.log("\n===== OUT OF SAMPLE BY MINIMUM CONFLUENCE SCORE =====");
  for (let t = 0; t <= 5; t++) {
    const sum = summarise(resultsByThreshold.get(t));
    console.log(`min ${t}: ${JSON.stringify(sum)}`);
  }

  console.log("\nChosen-threshold results above show what live settings would have produced.");
}

main().catch((err) => {
  console.error("test failed:", err);
  process.exit(1);
});
