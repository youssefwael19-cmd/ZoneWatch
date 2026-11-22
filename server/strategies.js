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
const autozones = require("./autozones");

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

/* --------------------- families promoted from the lab --------------------- */

/**
 * The lab tunes a zone-entry config on older bars, then scores it on bars it
 * has not seen. When one of those configs comes out ahead on unseen data it is
 * worth more than a guess, so it is promoted into a family here and the brain
 * tests it on every market in every condition — under the same proof bar as the
 * twelve hand-written rules. Nothing about that bar is relaxed for these.
 *
 * Two caveats are built into the design rather than argued away:
 *
 *  - A promoted config carries a selection advantage: it was picked from
 *    twelve configs because it did well on this data. That is exactly why it
 *    stays a *candidate*. Turning a lab winner into a proven rule still needs
 *    30+ trades, 0.10R, t >= 2.5 and all three blocks positive on folds the
 *    lab never used to choose it.
 *  - The set is derived from the lab's current results, but it is never taken
 *    away by them. A config that earned a place is recorded in promotions.json
 *    and stays in front of the brain, so a later lab run that stops nominating
 *    it cannot delete the cells already measured for it or retract a champion it
 *    earned. Only a change to the rules themselves (RULES_VERSION) retires a
 *    promotion, because then it is a claim about a different rule. The brain's
 *    "a rule must still exist" check therefore still drops cells for a family
 *    that is genuinely gone, but a lab update is not such a case.
 */

const LAB_WINDOW = 200; // the same slice of history the lab walks
const LAB_MAX_PER_SIDE = 4; // the same zone budget the lab uses
const MIN_BLOCK_TRADES = 30; // a block smaller than this is not evidence
const MAX_PROMOTED = 3;

/**
 * Zones as the lab sees them, at every bar, computed once per market run.
 *
 * The brain walks a family six times over ~6,200 bars (three folds, twice).
 * Detecting zones inside that loop would repeat the same 200-bar analysis every
 * time, so the map is built once per displacement multiple and reused.
 */
const labZoneCache = new WeakMap();

function labZoneSeries(ctx, mult) {
  let perMult = labZoneCache.get(ctx);
  if (!perMult) {
    perMult = new Map();
    labZoneCache.set(ctx, perMult);
  }
  const hit = perMult.get(mult);
  if (hit) return hit;

  const bars = ctx.bars;
  const out = new Array(bars.length).fill(null);
  for (let i = LAB_WINDOW; i < bars.length; i++) {
    out[i] = autozones.detectZones(bars.slice(i - LAB_WINDOW, i + 1), {
      displacementMult: mult,
      maxPerSide: LAB_MAX_PER_SIDE,
    });
  }
  perMult.set(mult, out);
  return out;
}

/** Stable id for a lab config, so stored cells survive a restart. */
function labFamilyId(cfg) {
  const mult = String(cfg.mult).replace(".", "");
  return `lab_${mult}_${cfg.stopMode === "zone_width" ? "zw" : "atr"}_${cfg.rr}`;
}

/**
 * One lab config as a family: the same entry the lab simulated on the horizon
 * it chose (price closing inside a freshly detected zone), the same stop the
 * lab tested, and the same target multiple.
 *
 * The sample it produces here is smaller than the lab's, on purpose. The brain
 * walks one trade at a time, like the executor holding one position per market,
 * so signals that overlap an open trade are skipped; the lab's simulation lets
 * them stack. Same entries, fewer of them — and that is what the proof bar is
 * then applied to, so nothing is proven on the looser number.
 */
function labFamily(cfg) {
  const mult = Number(cfg.mult);
  const rr = Number(cfg.rr);
  const zoneStop = cfg.stopMode === "zone_width";
  return {
    id: labFamilyId(cfg),
    name: `Lab zone entry (${mult}× displacement, ${zoneStop ? "zone-edge" : "ATR"} stop, ${rr}R)`,
    promoted: true,
    // The lab tuned this on price action, not on a market condition, so it has
    // no intended tape. All four are left in so a measurement there is never
    // dismissed as "outside this rule's intended condition".
    worksIn: ["trending-volatile", "trending-quiet", "ranging-volatile", "ranging-quiet"],
    why: "A zone-entry config the lab tuned on older bars and that came out ahead on bars it had not seen. The brain measures it everywhere like any other rule; the lab's result is a nomination, not a proof.",
    entryAt(bars, i, ctx) {
      const atr = ctx.atr[i];
      if (!(atr > 0) || i < LAB_WINDOW) return null;
      const zones = labZoneSeries(ctx, mult)[i];
      if (!zones || !zones.length) return null;

      const bar = bars[i];
      for (const zone of zones) {
        if (!(bar.c >= zone.low && bar.c <= zone.high)) continue;

        const side = zone.type === "demand" ? "BUY" : "SELL";
        const width = Math.max(zone.high - zone.low, atr * 0.1);
        const entry = bar.c;
        const stop = zoneStop
          ? side === "BUY"
            ? zone.low - width * 0.5
            : zone.high + width * 0.5
          : side === "BUY"
            ? entry - atr
            : entry + atr;
        const risk = Math.abs(entry - stop);
        if (!(risk > 0)) continue;
        const target = side === "BUY" ? entry + risk * rr : entry - risk * rr;
        return { side, entry, stop, target };
      }
      return null;
    },
  };
}

/**
 * Which lab configs earned a place in the brain, from the lab's own results.
 *
 * A config qualifies by winning at least one unseen block of 30+ trades, and it
 * is ranked on its *whole* unseen record — the blocks it lost count against it,
 * so a config cannot be promoted on one lucky block while losing the next.
 * Only the top few are promoted: every extra family multiplies the tests the
 * brain runs, and a long list of near-winners is how a search starts finding
 * edges that are not there.
 */
function promoteLabConfigs(labResults) {
  const nominated = new Set();
  const all = new Map();

  for (const [symbol, result] of Object.entries(labResults || {})) {
    for (const fold of (result && result.chosen) || []) {
      const cfg = fold && fold.cfg;
      const test = fold && fold.test;
      if (!cfg || !test) continue;
      const n = Number(test.n) || 0;
      const expectancy = Number(test.expectancy);
      if (!Number.isFinite(expectancy) || n <= 0) continue;

      const id = labFamilyId(cfg);
      if (!all.has(id)) {
        all.set(id, {
          id,
          cfg: { mult: cfg.mult, stopMode: cfg.stopMode, rr: cfg.rr },
          n: 0,
          totalR: 0,
          markets: new Set(),
        });
      }
      const row = all.get(id);
      row.n += n;
      row.totalR += expectancy * n;
      row.markets.add(symbol);

      if (n >= MIN_BLOCK_TRADES && expectancy > 0) nominated.add(id);
    }
  }

  return [...nominated]
    .map((id) => {
      const row = all.get(id);
      return {
        ...row,
        markets: [...row.markets],
        expectancy: row.n ? Number((row.totalR / row.n).toFixed(3)) : null,
      };
    })
    .filter((row) => row.expectancy != null && row.expectancy > 0)
    .sort((a, b) => (b.expectancy - a.expectancy) || (b.n - a.n) || a.id.localeCompare(b.id))
    .slice(0, MAX_PROMOTED);
}

/**
 * Resolve one entry forward, bar by bar, with the live stop ladder applied.
 *
 * If a single bar touches both stop and target, the stop is assumed to hit
 * first — the pessimistic reading, so the results are not flattered. A stop
 * raised during a bar only protects from the next bar, which keeps the trail
 * from claiming a fill the bar could not have given.
 *
 * The fills pay what the live book pays, when a cost model is supplied:
 * half the spread on entry and half on exit, adverse slippage on the entry and
 * on a stop (the live model caps it at a quarter of the stop distance),
 * round-turn commission expressed in R, and — with or without a cost model — a
 * gap through the stop fills at the bar's open rather than the stop price.
 *
 * `grossR` is the same walk before those charges, so a caller can report both
 * what the market gave and what the broker took.
 */
function resolve(bars, i, trade, to, costs = null) {
  const limit = Math.min(i + MAX_HOLD_BARS, to);
  const entry = Number(trade.entry);
  const risk = Math.abs(entry - Number(trade.stop));
  if (!(risk > 0)) return { outcome: "open", r: 0, grossR: 0, bars: limit - i };

  const spread = costs ? Math.max(0, Number(costs.spread) || 0) : 0;
  const half = spread / 2;
  const slippage = Math.min(
    costs ? Math.max(0, Number(costs.slippage) || 0) : 0,
    risk * 0.25
  );
  const perUnit = costs ? Number(costs.valuePerUnit) : 0;
  const commission = costs ? Number(costs.commissionPerLot) : 0;
  // Commission is per lot, round turn. Risk per lot is (stop distance ×
  // value per price unit), so lots cancel and the charge is a fixed share of R.
  const commissionR =
    commission > 0 && perUnit > 0 ? commission / (risk * perUnit) : 0;

  const buy = trade.side === "BUY";
  // Against the trade, always: a buyer pays up, a seller gets less.
  const entryFill = buy ? entry + half + slippage : entry - half - slippage;

  function settled(outcome, exit, priceR, j) {
    const net = ((buy ? exit - entryFill : entryFill - exit) / risk) - commissionR;
    return {
      outcome,
      r: Number(net.toFixed(3)),
      grossR: Number(priceR.toFixed(3)),
      bars: j - i,
      costs: {
        spread,
        slippage: Number(slippage.toFixed(8)),
        commissionR: Number(commissionR.toFixed(4)),
      },
    };
  }

  let stop = Number(trade.stop);
  let peakR = 0;

  for (let j = i + 1; j < limit; j++) {
    const b = bars[j];
    if (buy) {
      if (b.l <= stop) {
        // A bar that opens below the stop is a gap: the fill is the open.
        const gapped = Number(b.o) <= stop;
        const base = gapped ? Number(b.o) : stop;
        const exit = gapped ? base - half : base - half - slippage;
        return settled("loss", exit, (base - entry) / risk, j);
      }
      if (b.h >= trade.target) {
        return settled("win", Number(trade.target) - half, (Number(trade.target) - entry) / risk, j);
      }
      peakR = Math.max(peakR, (b.h - entry) / risk);
    } else {
      if (b.h >= stop) {
        const gapped = Number(b.o) >= stop;
        const base = gapped ? Number(b.o) : stop;
        const exit = gapped ? base + half : base + half + slippage;
        return settled("loss", exit, (entry - base) / risk, j);
      }
      if (b.l <= trade.target) {
        return settled("win", Number(trade.target) + half, (entry - Number(trade.target)) / risk, j);
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
  return { outcome: "open", r: 0, grossR: 0, bars: limit - i };
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

    const result = resolve(bars, i, placed, to, opts.costs);
    openUntil = i + Math.max(1, result.bars);
    if (result.outcome === "open") continue;

    trades.push({
      side: placed.side,
      condition: condition || "unclear",
      r: Number(result.r.toFixed(3)),
      grossR: Number(result.grossR.toFixed(3)),
      costR: Number((result.grossR - result.r).toFixed(3)),
      at: new Date(bars[i].t).toISOString(),
    });
  }

  return trades;
}

module.exports = {
  FAMILIES,
  runFamily,
  resolve,
  series,
  labFamily,
  labFamilyId,
  promoteLabConfigs,
  MAX_HOLD_BARS,
  MAX_PROMOTED,
  MIN_BLOCK_TRADES,
  RULES_VERSION,
};
