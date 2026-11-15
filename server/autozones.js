/**
 * Automatic supply and demand zone detection.
 *
 * The method is deliberately simple and explainable, so you can see exactly
 * why a zone exists rather than trusting a black box:
 *
 *  1. Measure volatility with ATR so "big move" means something on any
 *     instrument and timeframe.
 *  2. Find displacement: a candle that closes more than 1.4 ATR away from the
 *     previous close. That is the impulsive move that leaves a footprint.
 *  3. The zone is the last opposite-coloured base candle before that move.
 *     A strong rally up leaves a demand zone underneath it; a strong drop
 *     leaves a supply zone above it.
 *  4. Discard any zone that price has since closed through (it failed).
 *  5. Count touches, so "untested" zones can be ranked above used ones.
 *  6. Merge overlapping zones of the same type and keep the best few.
 *
 * This is the classic order-block reading of supply and demand. It is a
 * mechanical approximation of what a trader does by eye, so it will sometimes
 * mark a zone you would not have drawn.
 */

function atrSeries(bars, period = 14) {
  const out = new Array(bars.length).fill(null);
  if (bars.length < period + 1) return out;

  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const prev = bars[i - 1];
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c)));
  }

  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  let value = sum / period;
  out[period] = value;

  for (let i = period; i < trs.length; i++) {
    value = (value * (period - 1) + trs[i]) / period;
    out[i + 1] = value;
  }
  return out;
}

function overlaps(a, b) {
  return a.low <= b.high && b.low <= a.high;
}

function mergeZones(zones) {
  const sorted = zones.slice().sort((x, y) => x.low - y.low);
  const merged = [];
  for (const zone of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.type === zone.type && overlaps(last, zone)) {
      last.low = Math.min(last.low, zone.low);
      last.high = Math.max(last.high, zone.high);
      last.strength = Math.max(last.strength, zone.strength);
      last.touches = Math.min(last.touches, zone.touches);
      continue;
    }
    merged.push({ ...zone });
  }
  return merged;
}

/**
 * @param {Array<{t,o,h,l,c}>} bars
 * @param {{displacementMult?:number, lookback?:number, maxPerSide?:number}} opts
 */
function detectZones(bars, opts = {}) {
  const displacementMult = opts.displacementMult ?? 1.4;
  const lookback = opts.lookback ?? 6;
  const maxPerSide = opts.maxPerSide ?? 4;

  if (!Array.isArray(bars) || bars.length < 30) return [];

  const atr = atrSeries(bars, 14);
  const found = [];

  for (let i = 16; i < bars.length; i++) {
    const prevAtr = atr[i - 1];
    if (!prevAtr || prevAtr <= 0) continue;

    const move = bars[i].c - bars[i - 1].c;
    const strength = Math.abs(move) / prevAtr;
    if (strength < displacementMult) continue;

    const bullish = move > 0;

    // Last opposite-coloured candle before the impulse = the base.
    let baseIdx = -1;
    for (let j = i - 1; j >= Math.max(0, i - lookback); j--) {
      const b = bars[j];
      const opposite = bullish ? b.c < b.o : b.c > b.o;
      if (opposite) {
        baseIdx = j;
        break;
      }
    }
    if (baseIdx < 0) continue;

    const base = bars[baseIdx];
    const low = Math.min(base.o, base.c, base.l);
    const high = Math.max(base.o, base.c, base.h);
    if (!(high > low)) continue;

    const type = bullish ? "demand" : "supply";

    // Has price already closed through the far side? Then the zone failed.
    let broken = false;
    let touches = 0;
    for (let k = i + 1; k < bars.length; k++) {
      const c = bars[k];
      if (type === "demand" && c.c < low) {
        broken = true;
        break;
      }
      if (type === "supply" && c.c > high) {
        broken = true;
        break;
      }
      if (c.l <= high && c.h >= low) touches++;
    }
    if (broken) continue;

    found.push({
      type,
      low,
      high,
      strength: Number(strength.toFixed(2)),
      touches,
      formedAt: bars[i].t,
      originBar: bars[baseIdx].t,
    });
  }

  const merged = mergeZones(found);

  // Freshness first (untested zones are the interesting ones), then strength.
  merged.sort((a, b) => a.touches - b.touches || b.strength - a.strength);

  const result = [];
  for (const type of ["supply", "demand"]) {
    result.push(...merged.filter((z) => z.type === type).slice(0, maxPerSide));
  }
  return result;
}

/**
 * Turn detected zones into the same shape the app already uses, so manual and
 * automatic zones flow through one code path.
 *
 * `basisOffset` shifts levels onto the scale of the quoted instrument. Gold is
 * quoted as spot XAU/USD while candles come from GC=F futures, which trades a
 * few dollars higher; shifting by the current difference keeps zones aligned
 * with the price you are actually watching.
 */
function toAppZones(symbol, detected, { basisOffset = 0, alertFraction = 0.0015, decimals = 2 } = {}) {
  const shift = Number(basisOffset) || 0;
  return detected.map((z, index) => {
    const low = Number((z.low + shift).toFixed(decimals));
    const high = Number((z.high + shift).toFixed(decimals));
    const width = Math.max(high - low, 0);
    const mid = (high + low) / 2;
    return {
      id: `auto-${symbol}-${z.type}-${low}-${high}-${index}`,
      symbol,
      type: z.type,
      low,
      high,
      label: `Auto ${z.type} (${z.strength}× ATR${z.touches === 0 ? ", fresh" : ""})`,
      notes: `Displacement ${z.strength}× ATR, ${z.touches} prior touch${z.touches === 1 ? "" : "es"}.`,
      alertDistance: Number(Math.max(width, mid * alertFraction).toFixed(decimals)),
      active: true,
      source: "auto",
      strength: z.strength,
      touches: z.touches,
      createdAt: new Date().toISOString(),
    };
  });
}

module.exports = { detectZones, toAppZones, atrSeries };
