/**
 * Market condition ("regime") detection.
 *
 * The question this answers: is this market trending or going sideways, and is
 * it moving a lot or a little? Two measurements, both deliberately simple so
 * they cannot be fitted to the past:
 *
 *  - Efficiency ratio: net distance travelled divided by the total distance
 *    walked over the last 40 bars. Near 1 means the market went somewhere in a
 *    straight line (trend). Near 0 means it wandered and ended up where it
 *    started (range).
 *
 *  - ATR percentile: today's true range against its own last 200 readings.
 *    Above the median is "volatile", below it is "quiet".
 *
 * Four conditions come out: trending-volatile, trending-quiet, ranging-
 * volatile, ranging-quiet. That is few enough for each to gather a real sample.
 */

const ER_LOOKBACK = 40;
const ATR_PERIOD = 14;
const ATR_LOOKBACK = 200;
const TREND_THRESHOLD = 0.3;
// Split at the median, so every market always lands in a condition. An earlier
// version left a 40-60th percentile band unlabelled, which produced "unclear"
// for whichever market happened to sit there.
const VOL_SPLIT = 0.5;
// The fixed grid the brain measures every rule on. Published so a coverage
// report can tell "no trades in this condition" from "never measured here":
// a measured market with no cell means the rule simply did not trade.
const CONDITIONS = ["trending-volatile", "trending-quiet", "ranging-volatile", "ranging-quiet"];

function atrSeries(bars, period = ATR_PERIOD) {
  const out = new Array(bars.length).fill(null);
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const p = bars[i - 1];
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
  }
  let sum = 0;
  for (let i = 0; i < period && i < trs.length; i++) sum += trs[i];
  if (trs.length < period) return out;
  let value = sum / period;
  out[period] = value;
  for (let i = period; i < trs.length; i++) {
    value = (value * (period - 1) + trs[i]) / period;
    out[i + 1] = value;
  }
  return out;
}

function emaSeries(bars, period) {
  const out = new Array(bars.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i].c;
    prev = prev == null ? c : c * k + prev * (1 - k);
    if (i >= period - 1) out[i] = prev;
  }
  return out;
}

/** Net move over total move: 1 = straight line, 0 = went nowhere. */
function efficiency(bars, i, lookback = ER_LOOKBACK) {
  if (i < lookback) return null;
  const net = Math.abs(bars[i].c - bars[i - lookback].c);
  let total = 0;
  for (let j = i - lookback + 1; j <= i; j++) total += Math.abs(bars[j].c - bars[j - 1].c);
  if (!total) return null;
  return net / total;
}

/** Where this bar's ATR sits in its own recent range, 0..1. */
function atrPercentile(atr, i, lookback = ATR_LOOKBACK) {
  const from = Math.max(0, i - lookback);
  const window = [];
  for (let j = from; j <= i; j++) if (atr[j] != null) window.push(atr[j]);
  if (window.length < 50) return null;
  const current = atr[i];
  if (current == null) return null;
  const below = window.filter((v) => v <= current).length;
  return below / window.length;
}

function labelFor(er, volPct) {
  if (er == null || volPct == null) return null;
  const trending = er >= TREND_THRESHOLD;
  const volatile = volPct >= VOL_SPLIT;
  return `${trending ? "trending" : "ranging"}-${volatile ? "volatile" : "quiet"}`;
}

/**
 * Precompute everything the classifiers need, once per candle series.
 */
function analyze(bars) {
  const atr = atrSeries(bars);
  const ema20 = emaSeries(bars, 20);
  const ema50 = emaSeries(bars, 50);

  function at(i) {
    const er = efficiency(bars, i);
    const volPct = atrPercentile(atr, i);
    return {
      er,
      volPct,
      atr: atr[i],
      ema20: ema20[i],
      ema50: ema50[i],
      label: labelFor(er, volPct),
    };
  }

  const last = bars.length - 1;
  const current = at(last);

  return {
    bars,
    atr,
    ema20,
    ema50,
    at,
    current: {
      label: current.label || "unclear",
      efficiency: current.er == null ? null : Number(current.er.toFixed(2)),
      volatilityPercentile: current.volPct == null ? null : Number(current.volPct.toFixed(2)),
      atr: current.atr == null ? null : Number(current.atr.toFixed(4)),
      asOf: bars.length ? new Date(bars[last].t).toISOString() : null,
    },
  };
}

module.exports = {
  analyze,
  atrSeries,
  emaSeries,
  efficiency,
  atrPercentile,
  CONDITIONS,
  TREND_THRESHOLD,
  ER_LOOKBACK,
};
