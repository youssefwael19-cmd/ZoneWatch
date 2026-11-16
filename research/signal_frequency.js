#!/usr/bin/env node
/**
 * How often does a signal actually appear, and what does each extra filter cost?
 *
 * The live rule only fires while price is *inside* a zone, and by default it also
 * demands that the 1h trend agree. The walk-forward edge in server/lab.js was
 * measured with neither condition, so this script replays the same bars three
 * ways and reports trades, win rate and expectancy for each:
 *
 *   inside        price closes inside a zone (what lab.js measured)
 *   inside+trend  also skip trades fighting the 1h trend (what the app sends)
 *   approach      inside, or within a quarter ATR of a zone, with the trend check
 *
 * Run: node research/signal_frequency.js [SYMBOL ...]
 */

const path = require("path");
const market = require(path.join(__dirname, "..", "server", "market"));
const candlesMod = require(path.join(__dirname, "..", "server", "candles"));
const autozones = require(path.join(__dirname, "..", "server", "autozones"));

const WINDOW = 200;
const MAX_HOLD = 72;
const RR = 2;
const PROXIMITY_ATR = 0.25;
const MULT = 1.4;

function atrSeries(bars, period = 14) {
  const out = new Array(bars.length).fill(null);
  const trs = [];
  for (let i = 1; i < bars.length; i += 1) {
    const b = bars[i];
    const p = bars[i - 1];
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
  }
  let sum = 0;
  for (let i = 0; i < period && i < trs.length; i += 1) sum += trs[i];
  let value = sum / period;
  out[period] = value;
  for (let i = period; i < trs.length; i += 1) {
    value = (value * (period - 1) + trs[i]) / period;
    out[i + 1] = value;
  }
  return out;
}

/** EMA over closes; used only to decide which way the trend is pointing. */
function ema(values, period) {
  const k = 2 / (period + 1);
  let out = null;
  return values.map((v, i) => {
    if (i < period) return null;
    if (out == null) {
      out = values.slice(0, period + 1).reduce((a, b) => a + b, 0) / (period + 1);
      return out;
    }
    out = v * k + out * (1 - k);
    return out;
  });
}

function trendAt(fast, slow, i) {
  if (fast[i] == null || slow[i] == null) return null;
  if (fast[i] > slow[i]) return "up";
  if (fast[i] < slow[i]) return "down";
  return null;
}

function zonesAt(bars) {
  const cache = new Array(bars.length).fill(null);
  for (let i = WINDOW; i < bars.length; i += 1) {
    const win = bars.slice(i - WINDOW, i + 1);
    cache[i] = autozones.detectZones(win, { displacementMult: MULT, maxPerSide: 4 });
  }
  return cache;
}

function run(bars, zones, atr, trend, { useTrend, proximity }) {
  const trades = [];
  let setups = 0;

  for (let i = WINDOW + 2; i < bars.length; i += 1) {
    const list = zones[i];
    const a = atr[i];
    if (!list || !list.length || !a) continue;
    const bar = bars[i];

    for (const zone of list) {
      const inside = bar.c >= zone.low && bar.c <= zone.high;
      const near =
        !inside &&
        (bar.c > zone.high ? bar.c - zone.high : zone.low - bar.c) <= a * PROXIMITY_ATR;
      if (!inside && !(proximity && near)) continue;

      const side = zone.type === "demand" ? "BUY" : "SELL";
      if (useTrend) {
        const t = trend[i];
        const against = (side === "BUY" && t === "down") || (side === "SELL" && t === "up");
        if (against) continue;
      }

      setups += 1;
      const width = Math.max(zone.high - zone.low, a * 0.1);
      const entry = bar.c;
      const stop = side === "BUY" ? zone.low - width * 0.5 : zone.high + width * 0.5;
      const risk = Math.abs(entry - stop);
      if (!(risk > 0)) continue;
      const target = side === "BUY" ? entry + risk * RR : entry - risk * RR;

      for (let j = i + 1; j < Math.min(i + MAX_HOLD, bars.length); j += 1) {
        const b = bars[j];
        if (side === "BUY") {
          if (b.l <= stop) { trades.push(-1); break; }
          if (b.h >= target) { trades.push(RR); break; }
        } else {
          if (b.h >= stop) { trades.push(-1); break; }
          if (b.l <= target) { trades.push(RR); break; }
        }
      }
      break;
    }
  }

  const n = trades.length;
  const wins = trades.filter((r) => r > 0).length;
  const totalR = trades.reduce((a, b) => a + b, 0);
  return {
    setups,
    n,
    winrate: n ? Number(((wins / n) * 100).toFixed(1)) : null,
    expectancy: n ? Number((totalR / n).toFixed(3)) : null,
    totalR: Number(totalR.toFixed(1)),
  };
}

function fmt(row) {
  return `n=${String(row.n).padStart(3)} win=${String(row.winrate ?? "-").padStart(5)}% R/trade=${String(
    row.expectancy ?? "-"
  ).padStart(7)} total=${String(row.totalR).padStart(6)}R setups=${row.setups}`;
}

(async () => {
  const wanted = process.argv.slice(2);
  const instruments = market
    .instrumentList()
    .filter((i) => !wanted.length || wanted.includes(i.symbol));

  const totals = {
    inside: { n: 0, r: 0, wins: 0, setups: 0 },
    insideTrend: { n: 0, r: 0, wins: 0, setups: 0 },
    approach: { n: 0, r: 0, wins: 0, setups: 0 },
  };

  console.log(`window ${WINDOW} · mult ${MULT} · rr 1:${RR} · hold ${MAX_HOLD} bars\n`);

  for (const inst of instruments) {
    let bars;
    try {
      bars = await candlesMod.getCandles(inst.candleSymbol, "1h", "1y");
    } catch (err) {
      console.log(`${inst.symbol}: no candles (${err.message})`);
      continue;
    }
    if (!bars || bars.length < WINDOW + 100) {
      console.log(`${inst.symbol}: not enough history (${bars ? bars.length : 0} bars)`);
      continue;
    }

    const atr = atrSeries(bars);
    const closes = bars.map((b) => b.c);
    const fast = ema(closes, 50);
    const slow = ema(closes, 200);
    const trend = bars.map((_, i) => trendAt(fast, slow, i));
    const zones = zonesAt(bars);
    const days = ((bars[bars.length - 1].t - bars[0].t) || 0) / 86400000;

    const inside = run(bars, zones, atr, trend, { useTrend: false, proximity: false });
    const insideTrend = run(bars, zones, atr, trend, { useTrend: true, proximity: false });
    const approach = run(bars, zones, atr, trend, { useTrend: true, proximity: true });

    const perDay = (row) => (days ? (row.n / days).toFixed(2) : "-");
    console.log(`${inst.symbol} (${bars.length} bars, ${days.toFixed(0)}d)`);
    console.log(`  inside        ${fmt(inside)}  · ${perDay(inside)}/day`);
    console.log(`  inside+trend  ${fmt(insideTrend)}  · ${perDay(insideTrend)}/day`);
    console.log(`  approach      ${fmt(approach)}  · ${perDay(approach)}/day`);
    console.log("");

    for (const [key, row] of [
      ["inside", inside],
      ["insideTrend", insideTrend],
      ["approach", approach],
    ]) {
      totals[key].n += row.n;
      totals[key].r += row.totalR;
      totals[key].setups += row.setups;
      if (row.winrate != null) totals[key].wins += Math.round((row.winrate / 100) * row.n);
    }
  }

  const summary = (t) => ({
    n: t.n,
    winrate: t.n ? Number(((t.wins / t.n) * 100).toFixed(1)) : null,
    expectancy: t.n ? Number((t.r / t.n).toFixed(3)) : null,
    totalR: Number(t.r.toFixed(1)),
    setups: t.setups,
  });

  console.log("ALL SYMBOLS");
  console.log(`  inside        ${fmt(summary(totals.inside))}`);
  console.log(`  inside+trend  ${fmt(summary(totals.insideTrend))}`);
  console.log(`  approach      ${fmt(summary(totals.approach))}`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
