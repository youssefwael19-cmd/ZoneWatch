/**
 * Stop management after entry.
 *
 * A trade that runs in your favour and then comes all the way back to a loss is
 * the same mistake whether it was read on a chart or by a rule, so this lives in
 * one place and is applied by every path that resolves a stop: the brain's
 * backtests, the lab's zone simulation, the signal tracker and the paper
 * executor. If those disagreed, the dashboard's numbers would describe a bot
 * that does not exist.
 *
 * The ladder is fixed and absolute — nothing is tuned per market, because a
 * trail fitted to a market's past is another way to invent an edge:
 *
 *   less than 1R of open profit   stop stays where the entry put it
 *   at 1R                         stop moves to break-even
 *   at 1.5R and beyond            stop follows 0.5R behind the best price
 *
 * So at 1.5R it holds +1R, at 2R it holds +1.5R, and so on. It only ever
 * moves in the trade's favour: "protect" may never loosen a stop.
 *
 * Important: this book keeps what the stop *protects*, not what it guarantees.
 * The exit still pays the spread, so a break-even stop is a break-even stop
 * before costs, and the cost of the round trip comes out of the result.
 */

// Open profit, in R, at which the stop may start protecting capital.
const BREAKEVEN_AT_R = 1;
// Open profit, in R, at which the stop starts keeping a slice of the profit.
const LOCK_FROM_R = 1.5;
// How much R stays behind the best price once the ladder is running.
const KEEP_R = 0.5;

/**
 * How much of the trade, in R, the stop protects for a given best excursion.
 * -1 means "still risking the original stop".
 */
function protectedR(peakR) {
  const peak = Number(peakR);
  if (!Number.isFinite(peak) || peak < BREAKEVEN_AT_R) return -1;
  if (peak < LOCK_FROM_R) return 0;
  return Number((peak - KEEP_R).toFixed(4));
}

/**
 * The stop this trade should be holding.
 *
 * @param {object} o
 * @param {"BUY"|"SELL"} o.side
 * @param {number} o.entry        the price the position was filled at
 * @param {number} o.stop         the stop currently held
 * @param {number} o.peakR        best excursion since entry, in R
 * @param {number} [o.initialStop] the stop the trade opened with. This is the
 *   risk unit, and it has to be passed: measuring risk from the stop held now
 *   makes it zero the moment that stop reaches entry, which froze the ladder at
 *   break-even instead of letting it trail the rest of the move.
 * @returns {number} the stop to hold now — never worse than the one passed in
 */
function protect({ side, entry, stop, peakR, initialStop }) {
  const openedWith = Number(initialStop == null ? stop : initialStop);
  const risk = Math.abs(Number(entry) - openedWith);
  if (!(risk > 0)) return stop;
  const keep = protectedR(peakR);
  if (keep < 0) return stop;
  const locked = side === "BUY" ? entry + keep * risk : entry - keep * risk;
  // The stop only moves forwards. A trailing rule that could give capital back
  // is not protection, it is a second way to lose.
  if (side === "BUY") return Math.max(stop, locked);
  return Math.min(stop, locked);
}

/**
 * One live tick's worth of stop management for an open position.
 *
 * The peak is measured with the price actually seen, and the stop it earns only
 * applies from that price onwards — the executor checks the stop against the
 * same price after calling this, so a position that reaches 1R and comes back to
 * entry closes at break-even rather than at the original loss.
 *
 * @param {object} o
 * @param {"BUY"|"SELL"} o.side
 * @param {number} o.entry         filled entry
 * @param {number} o.initialStop   the stop the trade opened with (the risk unit)
 * @param {number} o.stop          the stop held now
 * @param {number} o.peak          best price seen since entry
 * @param {number} o.price         the price just seen
 * @returns {{stop: number, peak: number, peakR: number, protectsR: number, moved: boolean}}
 */
function advance({ side, entry, initialStop, stop, peak, price }) {
  const risk = Math.abs(Number(entry) - Number(initialStop));
  const e = Number(entry);
  const p = Number(price);
  // A position that has not moved yet has no peak. `Number(null)` is 0 and
  // finite, so treating a null peak as a reading put the best price at zero —
  // for a SELL that is the *best possible* price, which yanked the stop to
  // nonsense on the first tick.
  const best = peak == null || !Number.isFinite(Number(peak)) ? e : Number(peak);
  if (!(risk > 0) || !Number.isFinite(p)) {
    return { stop, peak: best, peakR: 0, protectsR: protectedR(0), moved: false };
  }
  const nextPeak = side === "BUY" ? Math.max(best, p) : Math.min(best, p);
  const peakR = side === "BUY" ? (nextPeak - e) / risk : (e - nextPeak) / risk;
  const next = protect({ side, entry: e, stop, peakR, initialStop });
  return {
    stop: next,
    peak: nextPeak,
    peakR: Number(peakR.toFixed(4)),
    protectsR: protectedR(peakR),
    moved: next !== stop,
  };
}

module.exports = { protect, advance, protectedR, BREAKEVEN_AT_R, LOCK_FROM_R, KEEP_R };
