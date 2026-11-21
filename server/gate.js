/**
 * How a refused signal becomes a small one, or stays refused.
 *
 * brain.js answers one question and answers it honestly: is some rule proven to
 * make money in this market, in this condition? It is not allowed to become
 * generous just because the answer is no — that is how the gate stops meaning
 * anything.
 *
 * This module holds the two things that are allowed to soften a refusal, in
 * order, and the reason each one gives:
 *
 *  1. The market's own live book. Twenty closed trades at a positive expectancy
 *     is weaker evidence than a backtest cell with 30 unseen trades, so it buys
 *     half size — never a full one. This is the path that makes "learn from its
 *     own trades" true: the app's results now change what it does next.
 *  2. The exploration budget, when there is one left. A quarter-size trade to
 *     find out, tagged as exploration everywhere it is recorded, never counted
 *     as proof.
 *
 * Refusal with neither is still a refusal, with its original reason intact.
 */

const LIVE_MULTIPLE = 0.5;
const EXPLORE_MULTIPLE = 0.25;

/**
 * @param {object} args
 * @param {string} args.symbol
 * @param {object} args.verdict      what brain.gate said
 * @param {object} [args.live]       learning.liveEvidence() for this symbol
 * @param {boolean} [args.explorationAllowed]
 * @param {number} [args.liveMultiple]
 * @param {number} [args.exploreMultiple]
 */
function decide({
  symbol,
  verdict,
  live = null,
  explorationAllowed = false,
  liveMultiple = LIVE_MULTIPLE,
  exploreMultiple = EXPLORE_MULTIPLE,
} = {}) {
  if (!verdict) return { allowed: false, condition: null, reason: "the gate had no answer" };
  if (verdict.allowed) return verdict;

  const condition = verdict.condition || null;
  const blocked = verdict.reason || "nothing is proven for this market";

  if (live && live.positive) {
    return {
      allowed: true,
      live: true,
      sizeMultiplier: liveMultiple,
      condition,
      liveEvidence: { n: live.n, expectancy: live.expectancy, tStat: live.tStat },
      reason:
        `no backtest rule is proven for ${symbol}${condition ? ` in a ${condition} market` : ""}, ` +
        `but its own live book is positive: ${live.n} closed trades at ${live.expectancy}R each ` +
        `(t=${live.tStat}) — taken at half size`,
    };
  }

  if (explorationAllowed) {
    return {
      allowed: true,
      exploration: true,
      sizeMultiplier: exploreMultiple,
      condition,
      reason: `exploration: ${blocked} — one small trade (${exploreMultiple}× risk) to gather evidence, not a proven setup`,
    };
  }

  return verdict;
}

module.exports = { decide, LIVE_MULTIPLE, EXPLORE_MULTIPLE };
