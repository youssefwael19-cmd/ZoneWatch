/**
 * Daily discipline guard.
 *
 * Counts today's resolved signals and tells you when you have hit your loss
 * limit for the day. This is a behaviour control, not a market view: the point
 * is to stop the kind of day where one bad session turns into five.
 *
 * The day is measured in UTC so it lines up with the rest of the app.
 */

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function todayState(history, now = new Date(), ignoredBefore) {
  const key = dayKey(now);
  // A manual reset sets the instant the day's history stops counting. Signals
  // that close after it are counted again, so resetting does not disable the
  // guard — it only forgives what happened before the reset.
  const since = ignoredBefore ? Date.parse(ignoredBefore) : NaN;
  const todays = (history || []).filter(
    (h) =>
      typeof h.closedAt === "string" &&
      h.closedAt.slice(0, 10) === key &&
      (!Number.isFinite(since) || Date.parse(h.closedAt) >= since)
  );

  const wins = todays.filter((h) => h.outcome === "win").length;
  const losses = todays.filter((h) => h.outcome === "loss").length;
  const r = todays.reduce((a, h) => a + (h.rMultiple || 0), 0);

  return {
    day: key,
    closed: todays.length,
    wins,
    losses,
    totalR: Number(r.toFixed(2)),
  };
}

/**
 * @returns {{ stop: boolean, reason: string|null, state: object }}
 */
function check({ history, maxLosses, maxLossR, ignoredBefore, now = new Date() }) {
  const state = todayState(history, now, ignoredBefore);
  const lossLimit = Number(maxLosses);
  const rLimit = Number(maxLossR);

  if (Number.isFinite(lossLimit) && lossLimit > 0 && state.losses >= lossLimit) {
    return {
      stop: true,
      reason: `${state.losses} losing signals today (limit ${lossLimit}). Stop trading for today.`,
      state,
    };
  }

  if (Number.isFinite(rLimit) && rLimit > 0 && state.totalR <= -rLimit) {
    return {
      stop: true,
      reason: `Down ${Math.abs(state.totalR)}R today (limit ${rLimit}R). Stop trading for today.`,
      state,
    };
  }

  return { stop: false, reason: null, state };
}

module.exports = { check, todayState, dayKey };
