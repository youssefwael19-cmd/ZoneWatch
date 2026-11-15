/**
 * Strategy family.
 *
 * Each family is a fixed rule — no tuning knobs per market, because a rule
 * tuned to a market's past is the easiest way to invent an edge that does not
 * exist. The app's job is not to invent clever rules; it is to find out which
 * of these plain rules has actually been working, in which market condition,
 * on data it never saw while deciding.
 *
 * Every entry defines its own stop and target in R terms so trades are
 * comparable across families.
 */

const MAX_HOLD_BARS = 48;

const FAMILIES = [
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
      const risk = Math.abs(entry - stop);
      const target = side === "BUY" ? entry + risk * 2 : entry - risk * 2;
      return { side, entry, stop, target };
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

      let hi = -Infinity;
      let lo = Infinity;
      for (let j = i - 20; j < i; j++) {
        hi = Math.max(hi, bars[j].h);
        lo = Math.min(lo, bars[j].l);
      }

      const c = bars[i].c;
      const long = c > hi;
      const short = c < lo;
      if (!long && !short) return null;

      const side = long ? "BUY" : "SELL";
      const entry = c;
      const stop = side === "BUY" ? entry - atr : entry + atr;
      const risk = Math.abs(entry - stop);
      const target = side === "BUY" ? entry + risk * 2 : entry - risk * 2;
      return { side, entry, stop, target };
    },
  },
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
      const entry = c;
      const stop = side === "BUY" ? entry - atr * 1.5 : entry + atr * 1.5;
      // Target is the mean it stretched away from, capped at 2R so one huge
      // run does not dominate the sample.
      const risk = Math.abs(entry - stop);
      const meanTarget = ema;
      const rawTarget = Math.abs(meanTarget - entry);
      const distance = Math.min(rawTarget, risk * 2);
      const target = side === "BUY" ? entry + distance : entry - distance;
      return { side, entry, stop, target };
    },
  },
];

/**
 * Resolve one entry forward, bar by bar.
 * If a single bar touches both stop and target, the stop is assumed to hit
 * first — the pessimistic reading, so the results are not flattered.
 */
function resolve(bars, i, trade, to) {
  const limit = Math.min(i + MAX_HOLD_BARS, to);
  for (let j = i + 1; j < limit; j++) {
    const b = bars[j];
    if (trade.side === "BUY") {
      if (b.l <= trade.stop) return { outcome: "loss", r: -1, bars: j - i };
      if (b.h >= trade.target) {
        const risk = Math.abs(trade.entry - trade.stop);
        return { outcome: "win", r: Math.abs(trade.target - trade.entry) / risk, bars: j - i };
      }
    } else {
      if (b.h >= trade.stop) return { outcome: "loss", r: -1, bars: j - i };
      if (b.l <= trade.target) {
        const risk = Math.abs(trade.entry - trade.stop);
        return { outcome: "win", r: Math.abs(trade.target - trade.entry) / risk, bars: j - i };
      }
    }
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

module.exports = { FAMILIES, runFamily, resolve, MAX_HOLD_BARS };
