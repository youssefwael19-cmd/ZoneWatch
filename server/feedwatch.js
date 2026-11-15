/**
 * Feed watchdog.
 *
 * The watcher can be perfectly healthy — process running, zones evaluating,
 * no errors — while the price it is looking at has stopped moving. That is the
 * dangerous failure: the app looks fine on the dashboard and sends nothing,
 * because a frozen price never reaches a zone.
 *
 * Two independent staleness signals, because providers differ:
 *
 *  - the provider's own last-tick timestamp, when it gives one (Yahoo does,
 *    Twelve Data's quote endpoint does not);
 *  - when the price last actually changed, tracked in memory on every cycle.
 *    That one works for every provider, at the cost of resetting on restart.
 *
 * The older of the two wins. During the week, twenty minutes without either is
 * not a quiet market — FX and gold do not sit still that long — it is a feed
 * that has stopped.
 */

const marketclock = require("./marketclock");

const STALE_MINUTES = 20;
const REALERT_MS = 60 * 60 * 1000;

/**
 * @param {object} args
 * @param {Array} args.quotes current quotes from the provider
 * @param {Map} args.movedAt symbol -> timestamp the price last changed
 * @param {number} [args.now]
 */
function evaluate({ quotes = [], movedAt = new Map(), now = Date.now() } = {}) {
  const marketOpen = marketclock.weeklyOpen(new Date(now));

  const rows = quotes.map((q) => {
    const feedAge = marketclock.ageMinutes(q.lastMarketUpdate, now);
    const moved = movedAt instanceof Map ? movedAt.get(q.symbol) : null;
    const moveAge = moved ? Math.round((now - moved) / 60000) : null;

    const known = [feedAge, moveAge].filter((v) => v != null && Number.isFinite(v));
    const age = known.length ? Math.max(...known) : null;

    return {
      symbol: q.symbol,
      ageMinutes: age,
      price: q.price == null ? null : q.price,
      error: q.error || null,
    };
  });

  const rawStale = rows.filter((r) => r.ageMinutes != null && r.ageMinutes > STALE_MINUTES);
  const unknown = rows.filter((r) => r.ageMinutes == null).map((r) => r.symbol);

  return {
    marketOpen,
    checked: rows.length,
    // A frozen price outside market hours is normal, not a fault. Only report
    // staleness when the market is supposed to be trading.
    stale: marketOpen ? rawStale : [],
    rawStale,
    unknown,
    staleMinutes: STALE_MINUTES,
  };
}

/** Track when each price last actually changed. */
function recordMoves({ quotes = [], lastPrice = new Map(), movedAt = new Map(), now = Date.now() }) {
  for (const q of quotes) {
    if (q.price == null) continue;
    const previous = lastPrice.get(q.symbol);
    if (previous !== q.price) {
      lastPrice.set(q.symbol, q.price);
      movedAt.set(q.symbol, now);
    } else if (!movedAt.has(q.symbol)) {
      movedAt.set(q.symbol, now);
    }
  }
  return { lastPrice, movedAt };
}

module.exports = { evaluate, recordMoves, STALE_MINUTES, REALERT_MS };
