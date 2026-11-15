/**
 * Order-flow proxies and structural levels.
 *
 * Honest scope: true order flow (footprint, delta, DOM) and liquidity heatmaps
 * need Level 2 / tick data, which does not exist for free on spot gold or CFD
 * indices. What we CAN build from free OHLCV bars:
 *
 *   volume profile   where volume actually traded (POC, value area, high and
 *                    low volume nodes) — the honest stand-in for "where the
 *                    liquidity sat"
 *   liquidity pools  equal highs / equal lows and round numbers, where stops
 *                    tend to cluster
 *   structural S/R   swing highs and lows, prior day and week extremes
 *
 * Volume is only reported by the source for futures and indices. FX spot
 * returns zeros, so volume-profile output is null there and the code falls
 * back to structure only.
 */

function hasVolume(bars) {
  if (!Array.isArray(bars)) return false;
  const sample = bars.slice(-50);
  return sample.some((b) => Number(b.v) > 0);
}

/**
 * Volume profile: distribute each bar's volume across the price range it
 * covered, then find where the market spent its most volume.
 */
function volumeProfile(bars, { bins = 60, valueArea = 0.7 } = {}) {
  if (!Array.isArray(bars) || bars.length < 20) return null;
  if (!hasVolume(bars)) return null;

  let lo = Infinity;
  let hi = -Infinity;
  for (const b of bars) {
    if (!Number.isFinite(b.h) || !Number.isFinite(b.l)) continue;
    if (b.h > hi) hi = b.h;
    if (b.l < lo) lo = b.l;
  }
  if (!(hi > lo)) return null;

  const step = (hi - lo) / bins;
  const volume = new Array(bins).fill(0);

  for (const b of bars) {
    const v = Number(b.v) || 0;
    if (!v) continue;
    const from = Math.max(0, Math.floor((Math.min(b.l, b.h) - lo) / step));
    const to = Math.min(bins - 1, Math.floor((Math.max(b.l, b.h) - lo) / step));
    const span = to - from + 1;
    for (let i = from; i <= to; i++) volume[i] += v / span;
  }

  const total = volume.reduce((a, b) => a + b, 0);
  if (!total) return null;

  let pocIndex = 0;
  for (let i = 1; i < bins; i++) if (volume[i] > volume[pocIndex]) pocIndex = i;

  let lower = pocIndex;
  let upper = pocIndex;
  let accumulated = volume[pocIndex];
  while (accumulated / total < valueArea && (lower > 0 || upper < bins - 1)) {
    const below = lower > 0 ? volume[lower - 1] : -1;
    const above = upper < bins - 1 ? volume[upper + 1] : -1;
    if (above >= below) {
      upper += 1;
      accumulated += above;
    } else {
      lower -= 1;
      accumulated += below;
    }
  }

  const mean = total / bins;
  const nodes = [];
  for (let i = 0; i < bins; i++) {
    if (volume[i] > mean * 1.8) nodes.push({ price: lo + (i + 0.5) * step, kind: "high" });
    if (volume[i] < mean * 0.25) nodes.push({ price: lo + (i + 0.5) * step, kind: "low" });
  }

  return {
    poc: Number((lo + (pocIndex + 0.5) * step).toFixed(6)),
    vah: Number((lo + (upper + 1) * step).toFixed(6)),
    val: Number((lo + lower * step).toFixed(6)),
    nodes: nodes.filter((n) => n.kind === "high" || n.kind === "low").slice(0, 12),
    step: Number(step.toFixed(6)),
  };
}

/** Swing highs and lows with a symmetric lookback. */
function swingPoints(bars, lookback = 4) {
  const highs = [];
  const lows = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    const bar = bars[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (bars[j].h >= bar.h) isHigh = false;
      if (bars[j].l <= bar.l) isLow = false;
    }
    if (isHigh) highs.push(bar.h);
    if (isLow) lows.push(bar.l);
  }
  return { highs, lows };
}

/** Group nearby prices so a level tested several times scores higher. */
function clusterLevels(points, tolerance) {
  const sorted = [...points].sort((a, b) => a - b);
  const clusters = [];
  for (const price of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(price - last.sum / last.count) <= tolerance) {
      last.sum += price;
      last.count += 1;
    } else {
      clusters.push({ sum: price, count: 1 });
    }
  }
  return clusters.map((c) => ({ price: c.sum / c.count, touches: c.count }));
}

/** Round numbers, where retail stops and option strikes cluster. */
function roundLevels(price, stepSize) {
  const base = Math.round(price / stepSize) * stepSize;
  return [base - stepSize, base, base + stepSize];
}

/**
 * Build the level map for one instrument.
 *
 * @param {object} args
 * @param {Array} args.bars  intraday bars (volume optional)
 * @param {Array} args.daily daily bars, for prior day extremes
 * @param {number} args.price current price, used for tolerances
 * @param {number} args.decimals
 * @param {number} args.roundStep  round-number spacing (10 for gold, 100 for NDX)
 */
function buildLevels({ bars, daily, price, decimals = 2, roundStep = 10 }) {
  if (!Array.isArray(bars) || bars.length < 50) return null;

  const tolerance = Math.max(price * 0.0008, Math.pow(10, -decimals));
  const raw = [];

  const { highs, lows } = swingPoints(bars, 4);
  for (const h of highs) raw.push(h);
  for (const l of lows) raw.push(l);

  const profile = volumeProfile(bars, { bins: 60 });
  if (profile) {
    raw.push(profile.poc, profile.vah, profile.val);
    for (const n of profile.nodes) raw.push(n.price);
  }

  for (const r of roundLevels(price, roundStep)) raw.push(r);

  let priorDay = null;
  if (Array.isArray(daily) && daily.length >= 2) {
    const prev = daily[daily.length - 2];
    priorDay = { high: prev.h, low: prev.l };
    raw.push(prev.h, prev.l);
  }

  const clustered = clusterLevels(raw, tolerance);
  const levels = clustered
    .map((c) => {
      let score = c.touches;
      if (profile && Math.abs(c.price - profile.poc) <= tolerance) score += 2;
      if (priorDay && (Math.abs(c.price - priorDay.high) <= tolerance || Math.abs(c.price - priorDay.low) <= tolerance))
        score += 2;
      return { price: Number(c.price.toFixed(decimals)), touches: c.touches, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 24);

  return {
    levels,
    profile,
    priorDay,
    hasVolume: Boolean(profile),
    tolerance,
  };
}

/**
 * How strongly does a price sit on a level?
 * @returns {{score:number, price:number|null, touches:number}}
 */
function levelScoreAt(price, levelMap) {
  if (!levelMap || !Array.isArray(levelMap.levels)) return { score: 0, price: null, touches: 0 };
  const tolerance = levelMap.tolerance || 0;
  let best = { score: 0, price: null, touches: 0 };
  for (const lvl of levelMap.levels) {
    if (Math.abs(price - lvl.price) <= tolerance * 1.5) {
      if (lvl.score > best.score) best = { score: lvl.score, price: lvl.price, touches: lvl.touches };
    }
  }
  return best;
}

module.exports = { volumeProfile, swingPoints, clusterLevels, buildLevels, levelScoreAt, hasVolume };
