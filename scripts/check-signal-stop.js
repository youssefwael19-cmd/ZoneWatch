/*
 * Scratch check, not part of the app: does a signal put its stop beyond both
 * the recent 20-bar sweep extreme and the far zone edge, with half an ATR of
 * clearance, and measure 2R from that wider stop?
 */
const signals = require("../server/signals");

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} = ${JSON.stringify(actual)}${ok ? "" : "  expected " + JSON.stringify(expected)}`);
  if (ok) passed++; else failed++;
}
// Stops and targets are rounded to the instrument's decimals, so allow one cent
// of rounding on either side while still proving the 2R relationship.
function near(name, actual, expected, tolerance = 0.02) {
  check(name, Math.abs(actual - expected) <= tolerance, true);
}

function atrValue(bars, period = 14) {
  const slice = bars.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < slice.length; i++) {
    const b = slice[i];
    const p = slice[i - 1];
    sum += Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c));
  }
  return sum / period;
}

// 80 flat bars around `mid`, with the last 20 lows/highs overridden by sweep.
function makeBars({ mid, sweepLow = null, sweepHigh = null, n = 80 }) {
  const start = Date.now() - n * 15 * 60 * 1000;
  const bars = [];
  for (let i = 0; i < n; i++) {
    bars.push({
      t: start + i * 15 * 60 * 1000,
      o: mid,
      h: mid + 0.5,
      l: mid - 0.5,
      c: mid,
      v: 1,
    });
  }
  if (sweepLow != null) {
    bars[bars.length - 5].l = sweepLow;
    bars[bars.length - 5].c = mid;
  }
  if (sweepHigh != null) {
    bars[bars.length - 5].h = sweepHigh;
    bars[bars.length - 5].c = mid;
  }
  // A finished bar with the trade, so the signal is not held as unconfirmed.
  const last = bars[bars.length - 1];
  last.o = mid - 0.05;
  last.c = mid;
  return bars;
}

function zone(type, low, high) {
  return { type, low, high, label: "check", touches: 0, strength: 1 };
}

// --- BUY: the sweep low is the far point ---------------------------------
{
  const candles = makeBars({ mid: 100.5, sweepLow: 99.4 });
  const atr = atrValue(candles);
  const signal = signals.evaluateSignal({
    symbol: "XAUUSD",
    price: 100.5,
    zones: [zone("demand", 100, 101)],
    candles,
    decimals: 2,
  });
  check("a demand setup produces a signal", Boolean(signal), true);
  if (signal) {
    const sweepLow = Math.min(...candles.slice(-20).map((b) => b.l));
    check("the stop is beyond the zone edge", signal.stop < 100, true);
    check("the stop is beyond the sweep low", signal.stop < sweepLow, true);
    near("the stop clears the sweep low by half an ATR", signal.stop, sweepLow - atr / 2);
    near("the target is 2R from the entry", signal.target, signal.entry + (signal.entry - signal.stop) * 2);
    check("riskReward is still 2", signal.riskReward, 2);
  }
}

// --- BUY: the zone edge is the far point --------------------------------
{
  const candles = makeBars({ mid: 100.5, sweepLow: 100.2 });
  const atr = atrValue(candles);
  const signal = signals.evaluateSignal({
    symbol: "XAUUSD",
    price: 100.5,
    zones: [zone("demand", 99, 101)],
    candles,
    decimals: 2,
  });
  check("a setup whose sweep stays inside the zone still signals", Boolean(signal), true);
  if (signal) {
    near("the stop clears the zone edge by half an ATR", signal.stop, 99 - atr / 2);
    near("the target is 2R from the entry", signal.target, signal.entry + (signal.entry - signal.stop) * 2);
  }
}

// --- SELL: mirror image --------------------------------------------------
{
  const candles = makeBars({ mid: 100.5, sweepHigh: 101.6 });
  const atr = atrValue(candles);
  const signal = signals.evaluateSignal({
    symbol: "XAUUSD",
    price: 100.5,
    zones: [zone("supply", 100, 101)],
    candles,
    decimals: 2,
  });
  check("a supply setup produces a signal", Boolean(signal), true);
  if (signal) {
    const sweepHigh = Math.max(...candles.slice(-20).map((b) => b.h));
    check("the stop is beyond the zone edge", signal.stop > 101, true);
    check("the stop is beyond the sweep high", signal.stop > sweepHigh, true);
    near("the stop clears the sweep high by half an ATR", signal.stop, sweepHigh + atr / 2);
    near("the target is 2R below the entry", signal.target, signal.entry - (signal.stop - signal.entry) * 2);
  }
}

// --- SELL: the zone edge is the far point -------------------------------
{
  const candles = makeBars({ mid: 100.5, sweepHigh: 100.8 });
  const atr = atrValue(candles);
  const signal = signals.evaluateSignal({
    symbol: "XAUUSD",
    price: 100.5,
    zones: [zone("supply", 99, 102)],
    candles,
    decimals: 2,
  });
  check("a supply setup whose sweep stays inside the zone still signals", Boolean(signal), true);
  if (signal) {
    near("the stop clears the zone edge by half an ATR", signal.stop, 102 + atr / 2);
    near("the target is 2R below the entry", signal.target, signal.entry - (signal.stop - signal.entry) * 2);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
