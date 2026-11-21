/**
 * Strategy family.
 *
 * Each family is a fixed rule — no tuning knobs per market, because a rule
 * tuned to a market's past is the easiest way to invent an edge that does not
 * exist. The app's job is not to invent clever rules; it is to find out which
 * of these plain rules has actually been working, in which market condition,
 * on which market, on data it never saw while deciding.
 *
 * The library covers the three broad schools a discretionary trader would name:
 *
 *  - Trend following: momentum, break of structure, Donchian-style range
 *    breakout, Bollinger squeeze expansion, Fibonacci extension continuation.
 *  - Mean reversion: stretched reversion, RSI extremes, Fibonacci retracement
 *    into a pullback, engulfing reversal at an extreme.
 *  - Smart-money concepts (SMC): order-block retest after displacement, fair
 *    value gap (imbalance) fill, and liquidity sweep / stop hunt.
 *
 * Every entry defines its own stop and target in R terms so trades are
 * comparable across families, and every family is measured by the brain on
 * every market in every condition — the library is a list of hypotheses, not a
 * list of beliefs. Being in this file means "worth testing", nothing more.
 *
 * Every family is also run through the same stop management the live executor
 * uses (stops.js): break-even at 1R, then 0.5R behind the best price. A
 * backtest that let winners run to a target no live trade would ever reach
 * would measure a bot that does not exist.
 */

const stopsMod = require("./stops");

const MAX_HOLD_BARS = 48;

// Bumped whenever a family's rule, or the way a trade is resolved, changes
// meaning. Stored measurements from an older version are thrown away rather
// than left to back a live alert with a number nobody can reproduce.
// 3: the stop ladder no longer freezes at break-even (stops.protect takes the
// entry stop as the risk unit), so every older backtest resolved its winners
// with a stop that could not trail past entry.
const RULES_VERSION = 3;

/**
 * Series every family may need, computed once per analysed series.
 *
 * The brain walks each family over ~8,700 bars six times (three folds, twice),
 * so anything a rule needs per bar is precomputed here and cached against the
 * context object rather than recomputed inside the loop.
 */
const seriesCache = new WeakMap();

function series(ctx) {
  const cached = seriesCache.get(ctx);
  if (cached) return cached;

  const bars = ctx.bars;
  const n = bars.length;

  // RSI(14), Wilder smoothing.
  const rsi = new Array(n).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < n; i++) {
    const d = bars[i].c - bars[i - 1].c;
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    if (i < 14) {
      gain += g;
      loss += l;
    } else if (i === 14) {
      gain = (gain + g) / 14;
      loss = (loss + l) / 14;
      rsi[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    } else {
      gain = (gain * 13 + g) / 14;
      loss = (loss * 13 + l) / 14;
      rsi[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }

  // Confirmed swing pivots: a high with two lower highs either side, and the
  // mirror for lows. Confirmed two bars late on purpose — a pivot counted on
  // the bar it formed could not have been traded in real time.
  const swingHigh = new Array(n).fill(null);
  const swingLow = new Array(n).fill(null);
  let high = null;
  let low = null;
  for (let i = 0; i < n; i++) {
    const p = i - 2;
    if (p >= 2) {
      if (
        bars[p].h > bars[p - 1].h &&
        bars[p].h > bars[p - 2].h &&
        bars[p].h > bars[p + 1].h &&
        bars[p].h >= bars[p + 2].h
      ) {
        high = { price: bars[p].h, at: p };
      }
      if (
        bars[p].l < bars[p - 1].l &&
        bars[p].l < bars[p - 2].l &&
        bars[p].l < bars[p + 1].l &&
        bars[p].l <= bars[p + 2].l
      ) {
        low = { price: bars[p].l, at: p };
      }
    }
    swingHigh[i] = high;
    swingLow[i] = low;
  }

  // Bollinger(20) band width as a fraction of the mean, for squeeze detection.
  const bandWidth = new Array(n).fill(null);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const c = bars[i].c;
    sum += c;
    sumSq += c * c;
    if (i >= 20) {
      const gone = bars[i - 20].c;
      sum -= gone;
      sumSq -= gone * gone;
    }
    if (i >= 19) {
      const mean = sum / 20;
      const variance = Math.max(0, sumSq / 20 - mean * mean);
      bandWidth[i] = mean > 0 ? (4 * Math.sqrt(variance)) / mean : null;
    }
  }

  const out = { rsi, swingHigh, swingLow, bandWidth };
  seriesCache.set(ctx, out);
  return out;
}

function range(bars, i, lookback) {
  let hi = -Infinity;
  let lo = Infinity;
  for (let j = Math.max(0, i - lookback); j < i; j++) {
    hi = Math.max(hi, bars[j].h);
    lo = Math.min(lo, bars[j].l);
  }
  return { hi, lo };
}

function withTarget(side, entry, stop, multiple = 2) {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  const target = side === "BUY" ? entry + risk * multiple : entry - risk * multiple;
  return { side, entry, stop, target };
}

const FAMILIES = [
  /* ------------------------------ trend ------------------------------ */
  {
    id: "momentum",
    name: "Momentum (EMA 20/50 cross)",
    worksIn: ["trending-volatile", "trending-quiet"],
    why: "Follows a trend once it has already started, rather than guessing the turn.",
    entryAt(bars, i, ctx) {
      const a = ctx.ema20[i];
      const b = ctx.ema50[i];
      const aPrev = ctx.ema20[i - 1];
      const bPrev = ctx.ema50[i - 1];
      const atr = ctx.atr[i];
      if ([a, b, aPrev, bPrev, atr].some((v) => v == null)) return null;
      if (!(atr > 0)) return null;

      const crossedUp = aPrev <= bPrev && a > b;
      const crossedDown = aPrev >= bPrev && a < b;
      if (!crossedUp && !crossedDown) return null;

      const side = crossedUp ? "BUY" : "SELL";
      const entry = bars[i].c;
      const stop = side === "BUY" ? entry - atr * 1.5 : entry + atr * 1.5;
      return withTarget(side, entry, stop, 2);
    },
  },
  {
    id: "breakout",
    name: "Range breakout (20-bar)",
    worksIn: ["trending-volatile"],
    why: "Buys a break of the last 20 bars' high, assuming quiet ranges end in expansion.",
    entryAt(bars, i, ctx) {
      if (i < 21) return null;
      const atr = ctx.atr[i];
      if (!(atr > 0)) return null;

      const { hi, lo } = range(bars, i, 20);
      const c = bars[i].c;
      const long = c > hi;
      const short = c < lo;
      if (!long && !short) return null;

      const side = long ? "BUY" : "SELL";
      const stop = side === "BUY" ? c - atr : c + atr;
      return withTarget(side, c, stop, 2);
    },
  },
  {
    id: "bos",
    name: "Break of structure (confirmed swing)",
    worksIn: ["trending-quiet", "trending-volatile"],
    why: "The SMC structure break: a close beyond the last confirmed swing, not just a 20-bar high.",
    entryAt(bars, i, ctx) {
      const atr = ctx.atr[i];
      if (!(atr > 0) || i < 30) return null;
      const s = series(ctx);
      const bar = bars[i];
      const prev = bars[i - 1];
      const swingHigh = s.swingHigh[i];
      const swingLow = s.swingLow[i];

      if (swingHigh && prev.c <= swingHigh.price && bar.c > swingHigh.price) {
        const structure = swingLow && swingLow.at < swingHigh.at ? swingLow.price : bar.c - atr * 1.2;
        const stop = Math.min(structure, bar.c - atr * 0.8) - atr * 0.1;
        return withTarget("BUY", bar.c, stop, 2);
      }
      if (swingLow && prev.c >= swingLow.price && bar.c < swingLow.price) {
        const structure = swingHigh && swingHigh.at < swingLow.at ? swingHigh.price : bar.c + atr * 1.2;
        const stop = Math.max(structure, bar.c + atr * 0.8) + atr * 0.1;
        return withTarget("SELL", bar.c, stop, 2);
      }
      return null;
    },
  },
  {
    id: "squeeze",
    name: "Bollinger squeeze expansion",
    worksIn: ["ranging-quiet", "trending-quiet"],
    why: "Volatility is mean-reverting too: the tightest band in 50 bars, then the break of its range.",
    entryAt(bars, i, ctx) {
      const atr = ctx.atr[i];
      if (!(atr > 0) || i < 55) return null;
      const s = series(ctx);
      const width = s.bandWidth[i];
      if (!(width > 0)) return null;

      let tightest = Infinity;
      for (let j = Math.max(19, i - 50); j < i; j++) {
        const w = s.bandWidth[j];
        if (w != null && w < tightest) tightest = w;
      }
      // Only act while the bands are still compressed; a squeeze already broken
      // is just a breakout, and that family is measured separately.
      if (!(tightest < Infinity) || width > tightest * 1.05) return null;

      const { hi, lo } = range(bars, i, 20);
      const c = bars[i].c;
      if (c > hi) return withTarget("BUY", c, c - atr, 2);
      if (c < lo) return withTarget("SELL", c, c + atr, 2);
      return null;
    },
  },
  {
    id: "fib_ext",
    name: "Fibonacci 1.272 extension continuation",
    worksIn: ["trending-volatile"],
    why: "In an established trend, entering when price projects past the last leg's 1.272 extension.",
    entryAt(bars, i, ctx) {
      const atr = ctx.atr[i];
      if (!(atr > 0) || i < 40) return null;
      const s = series(ctx);
      const bar = bars[i];
      const prev = bars[i - 1];
      const swingHigh = s.swingHigh[i];
      const swingLow = s.swingLow[i];
      if (!swingHigh || !swingLow) return null;

      if (swingHigh.at > swingLow.at && ctx.ema20[i] > ctx.ema50[i]) {
        const leg = swingHigh.price - swingLow.price;
        if (leg < atr * 1.5) return null;
        const extension = swingHigh.price + leg * 0.272;
        if (prev.c <= extension && bar.c > extension) {
          return withTarget("BUY", bar.c, bar.c - atr * 1.2, 2);
        }
      }
      if (swingLow.at > swingHigh.at && ctx.ema20[i] < ctx.ema50[i]) {
        const leg = swingHigh.price - swingLow.price;
        if (leg < atr * 1.5) return null;
        const extension = swingLow.price - leg * 0.272;
        if (prev.c >= extension && bar.c < extension) {
          return withTarget("SELL", bar.c, bar.c + atr * 1.2, 2);
        }
      }
      return null;
    },
  },

  /* --------------------------- mean reversion --------------------------- */
  {
    id: "reversion",
    name: "Stretched reversion (2 ATR from EMA20)",
    worksIn: ["ranging-volatile"],
    why: "Fades a move that has stretched far from its average, expecting a snap back.",
    entryAt(bars, i, ctx) {
      const ema = ctx.ema20[i];
      const atr = ctx.atr[i];
      if (!(atr > 0) || ema == null) return null;

      const c = bars[i].c;
      const stretchedDown = c < ema - atr * 2;
      const stretchedUp = c > ema + atr * 2;
      if (!stretchedDown && !stretchedUp) return null;

      const side = stretchedDown ? "BUY" : "SELL";
      const stop = side === "BUY" ? c - atr * 1.5 : c + atr * 1.5;
      // Target is the mean it stretched away from, capped at 2R so one huge
      // run does not dominate the sample.
      const risk = Math.abs(c - stop);
      const distance = Math.min(Math.abs(ema - c), risk * 2);
      const target = side === "BUY" ? c + distance : c - distance;
      return { side, entry: c, stop, target };
    },
  },
  {
    id: "rsi_reversion",
    name: "RSI(14) extreme turn",
    worksIn: ["ranging-volatile", "ranging-quiet"],
    why: "The oldest oscillator rule there is: buy an oversold turn, sell an overbought one.",
    entryAt(bars, i, ctx) {
      const atr = ctx.atr[i];
      if (!(atr > 0)) return null;
      const s = series(ctx);
      const now = s.rsi[i];
      const prev = s.rsi[i - 1];
      if (now == null || prev == null) return null;

      const c = bars[i].c;
      if (now < 30 && now > prev) return withTarget("BUY", c, c - atr * 1.5, 2);
      if (now > 70 && now < prev) return withTarget("SELL", c, c + atr * 1.5, 2);
      return null;
    },
  },
  {
    id: "fib_retrace",
    name: "Fibonacci 0.618 retracement in a trend",
    worksIn: ["trending-volatile", "trending-quiet"],
    why: "Buys the pullback to the 0.5–0.618 zone of the last impulse instead of the breakout.",
    entryAt(bars, i, ctx) {
      const atr = ctx.atr[i];
      if (!(atr > 0) || i < 40) return null;
      const s = series(ctx);
      const bar = bars[i];
      const swingHigh = s.swingHigh[i];
      const swingLow = s.swingLow[i];
      if (!swingHigh || !swingLow) return null;

      if (swingHigh.at > swingLow.at) {
        const leg = swingHigh.price - swingLow.price;
        if (leg < atr * 1.5) return null;
        if (bar.h >= swingHigh.price) return null;
        const half = swingHigh.price - leg * 0.5;
        const golden = swingHigh.price - leg * 0.618;
        const deep = swingHigh.price - leg * 0.786;
        if (bar.l <= golden && bar.c >= golden && bar.c < half) {
          const stop = Math.min(deep, bar.c - atr * 0.5);
          return withTarget("BUY", bar.c, stop, 2);
        }
      } else {
        const leg = swingHigh.price - swingLow.price;
        if (leg < atr * 1.5) return null;
        if (bar.l <= swingLow.price) return null;
        const half = swingLow.price + leg * 0.5;
        const golden = swingLow.price + leg * 0.618;
        const deep = swingLow.price + leg * 0.786;
        if (bar.h >= golden && bar.c <= golden && bar.c > half) {
          const stop = Math.max(deep, bar.c + atr * 0.5);
          return withTarget("SELL", bar.c, stop, 2);
        }
      }
      return null;
    },
  },
  {
    id: "engulf",
    name: "Engulfing reversal at a 10-bar extreme",
    worksIn: ["ranging-volatile", "trending-volatile"],
    why: "Price-action classic: a candle that swallows the last one, at a fresh extreme.",
    entryAt(bars, i, ctx) {
      const atr = ctx.atr[i];
      if (!(atr > 0) || i < 12) return null;
      const bar = bars[i];
      const prev = bars[i - 1];

      const { hi, lo } = range(bars, i - 1, 10);
      const bullish = prev.c < prev.o && bar.c > bar.o && bar.o <= prev.c && bar.c >= prev.o;
      const bearish = prev.c > prev.o && bar.c < bar.o && bar.o >= prev.c && bar.c <= prev.o;

      if (bullish && prev.l <= lo) {
        return withTarget("BUY", bar.c, prev.l - atr * 0.2, 2);
      }
      if (bearish && prev.h >= hi) {
        return withTarget("SELL", bar.c, prev.h + atr * 0.2, 2);
      }
      return null;
    },
  },

  /* ------------------------------- SMC ------------------------------- */
  {
    id: "ob_retest",
    name: "SMC order block retest",
    worksIn: ["trending-volatile", "trending-quiet"],
    why: "After a displacement candle leaves a block behind, the first return to it is the entry.",
    entryAt(bars, i, ctx) {
      const atr = ctx.atr[i];
      if (!(atr > 0) || i < 15) return null;
      const bar = bars[i];

      // Walk back only to the most recent displacement: one block at a time,
      // so a stack of old blocks cannot each claim the same retest.
      for (let j = i - 1; j >= Math.max(1, i - 8); j--) {
        const block = bars[j];
        const after = bars[j + 1];
        if (!after) continue;

        const upDisplacement = after.c - after.o >= atr * 1.2 && after.c > block.h;
        const downDisplacement = after.o - after.c >= atr * 1.2 && after.c < block.l;

        if (upDisplacement && block.c < block.o) {
          // The last down candle before the up move, retested from above.
          if (bar.l <= block.h && bar.c >= block.l && bar.c > block.l) {
            const stop = Math.min(block.l, bar.c - atr * 0.5) - atr * 0.2;
            return withTarget("BUY", bar.c, stop, 2);
          }
          return null;
        }
        if (downDisplacement && block.c > block.o) {
          if (bar.h >= block.l && bar.c <= block.h && bar.c < block.h) {
            const stop = Math.max(block.h, bar.c + atr * 0.5) + atr * 0.2;
            return withTarget("SELL", bar.c, stop, 2);
          }
          return null;
        }
      }
      return null;
    },
  },
  {
    id: "fvg",
    name: "SMC fair value gap fill",
    worksIn: ["trending-volatile", "ranging-volatile"],
    why: "An imbalance left by three candles tends to be revisited; enter where it gets filled.",
    entryAt(bars, i, ctx) {
      const atr = ctx.atr[i];
      if (!(atr > 0) || i < 6) return null;
      const bar = bars[i];

      for (let j = i - 1; j >= Math.max(3, i - 10); j--) {
        const first = bars[j - 2];
        const third = bars[j];
        if (!first || !third) continue;

        // Bullish imbalance: the third candle's low never overlapped the first
        // candle's high. The gap is [first.high, third.low].
        if (third.l - first.h > atr * 0.3) {
          const lo = first.h;
          const hi = third.l;
          const mid = (lo + hi) / 2;
          if (bar.l <= mid && bar.c >= mid) {
            return withTarget("BUY", bar.c, lo - atr * 0.25, 2);
          }
          if (bar.l <= hi) return null;
        }
        if (first.l - third.h > atr * 0.3) {
          const lo = third.h;
          const hi = first.l;
          const mid = (lo + hi) / 2;
          if (bar.h >= mid && bar.c <= mid) {
            return withTarget("SELL", bar.c, hi + atr * 0.25, 2);
          }
          if (bar.h >= lo) return null;
        }
      }
      return null;
    },
  },
  {
    id: "sweep",
    name: "SMC liquidity sweep (stop hunt)",
    worksIn: ["ranging-volatile", "ranging-quiet"],
    why: "A wick through a 10-bar extreme that closes back inside is the classic stop hunt.",
    entryAt(bars, i, ctx) {
      const atr = ctx.atr[i];
      if (!(atr > 0) || i < 22) return null;
      const bar = bars[i];
      const { hi, lo } = range(bars, i, 10);

      const sweptLow = bar.l < lo && bar.c > lo;
      const sweptHigh = bar.h > hi && bar.c < hi;
      if (sweptLow === sweptHigh) return null;

      if (sweptLow) return withTarget("BUY", bar.c, bar.l - atr * 0.2, 2);
      return withTarget("SELL", bar.c, bar.h + atr * 0.2, 2);
    },
  },
];

/**
 * Resolve one entry forward, bar by bar, with the live stop ladder applied.
 *
 * If a single bar touches both stop and target, the stop is assumed to hit
 * first — the pessimistic reading, so the results are not flattered. A stop
 * raised during a bar only protects from the next bar, which keeps the trail
 * from claiming a fill the bar could not have given.
 */
function resolve(bars, i, trade, to) {
  const limit = Math.min(i + MAX_HOLD_BARS, to);
  const entry = Number(trade.entry);
  const risk = Math.abs(entry - Number(trade.stop));
  if (!(risk > 0)) return { outcome: "open", r: 0, bars: limit - i };

  let stop = Number(trade.stop);
  let peakR = 0;

  for (let j = i + 1; j < limit; j++) {
    const b = bars[j];
    if (trade.side === "BUY") {
      if (b.l <= stop) {
        return { outcome: "loss", r: Number(((stop - entry) / risk).toFixed(3)), bars: j - i };
      }
      if (b.h >= trade.target) {
        return { outcome: "win", r: Number((Math.abs(trade.target - entry) / risk).toFixed(3)), bars: j - i };
      }
      peakR = Math.max(peakR, (b.h - entry) / risk);
    } else {
      if (b.h >= stop) {
        return { outcome: "loss", r: Number(((entry - stop) / risk).toFixed(3)), bars: j - i };
      }
      if (b.l <= trade.target) {
        return { outcome: "win", r: Number((Math.abs(entry - trade.target) / risk).toFixed(3)), bars: j - i };
      }
      peakR = Math.max(peakR, (entry - b.l) / risk);
    }
    stop = stopsMod.protect({
      side: trade.side,
      entry,
      stop,
      peakR,
      // The risk unit is the entry stop; measuring it from the stop held now
      // collapses it to zero once the stop reaches entry.
      initialStop: Number(trade.stop),
    });
  }
  return { outcome: "open", r: 0, bars: limit - i };
}

/**
 * Walk a slice of bars and produce every closed trade each family would have
 * taken, tagged with the market condition at entry.
 */
/**
 * @param {object} opts  { stopAtr } — when set, every trade uses a fixed stop of
 *   that many ATRs and a 2R target, whatever the family would have chosen.
 *   This exists so the app's own stop placement can be measured against a
 *   simpler one through the identical walk-forward folds.
 */
function runFamily(family, bars, ctx, from, to, opts = {}) {
  const trades = [];
  let openUntil = -1;

  for (let i = Math.max(from, 60); i < to; i++) {
    if (i < openUntil) continue;

    const condition = ctx.at(i).label;
    const trade = family.entryAt(bars, i, ctx);
    if (!trade) continue;

    let placed = trade;
    if (Number.isFinite(opts.stopAtr)) {
      const atr = ctx.atr[i];
      if (!(atr > 0)) continue;
      const risk = atr * opts.stopAtr;
      const stop = trade.side === "BUY" ? trade.entry - risk : trade.entry + risk;
      const target = trade.side === "BUY" ? trade.entry + risk * 2 : trade.entry - risk * 2;
      placed = { ...trade, stop, target };
    }

    const result = resolve(bars, i, placed, to);
    openUntil = i + Math.max(1, result.bars);
    if (result.outcome === "open") continue;

    trades.push({
      side: placed.side,
      condition: condition || "unclear",
      r: Number(result.r.toFixed(3)),
      at: new Date(bars[i].t).toISOString(),
    });
  }

  return trades;
}

module.exports = { FAMILIES, runFamily, resolve, series, MAX_HOLD_BARS, RULES_VERSION };
