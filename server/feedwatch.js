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
 *
 * Each instrument is judged against its OWN hours, not the FX week. NASDAQ's
 * cash session closes in the afternoon while FX and gold carry on, and its
 * price then freezes legitimately until the next open. Measuring that against
 * the weekly clock reported NASDAQ as a dead feed every evening and every
 * weekend, which is exactly the kind of false alarm that teaches you to ignore
 * the real one.
 *
 * Ages are also floored at the current session's open, so a price that sat
 * still overnight is not announced as "silent for seventeen hours" one minute
 * after the bell. If the feed is genuinely dead it still crosses the threshold
 * twenty minutes into the session.
 */

const marketclock = require("./marketclock");
const sessions = require("./sessions");

const STALE_MINUTES = 20;
const REALERT_MS = 60 * 60 * 1000;

/**
 * Whether this instrument should be ticking right now, and since when its
 * current session has been running. Non-exchange instruments follow the
 * weekly FX clock; NASDAQ follows its own cash session.
 */
function marketFor(symbol, now) {
  if (sessions.instrumentSession(symbol)) {
    return {
      open: sessions.instrumentMarketOpen(symbol, now),
      openedAt: sessions.sessionOpenedAt(symbol, now),
    };
  }
  return {
    open: marketclock.weeklyOpen(now),
    openedAt: marketclock.weeklyOpenedAt(now),
  };
}

/**
 * @param {object} args
 * @param {Array} args.quotes current quotes from the provider
 * @param {Map} args.movedAt symbol -> timestamp the price last changed
 * @param {number} [args.now]
 */
function evaluate({ quotes = [], movedAt = new Map(), now = Date.now() } = {}) {
  const nowDate = new Date(now);

  const rows = quotes.map((q) => {
    // A provider that says the market is shut knows better than our clock: a
    // frozen quote is then expected, not a dead feed.
    const closedByProvider = q.marketClosed === true;
    const market = closedByProvider ? { open: false, openedAt: null } : marketFor(q.symbol, nowDate);

    const feedAt = q.lastMarketUpdate ? new Date(q.lastMarketUpdate).getTime() : null;
    const moved = movedAt instanceof Map ? movedAt.get(q.symbol) : null;
    const seen = [feedAt, moved].filter((v) => v != null && Number.isFinite(v));
    // The oldest evidence wins, but never earlier than this session's open:
    // silence before the market opened is not silence.
    const oldest = seen.length ? Math.min(...seen) : null;
    const from = oldest == null ? null : Math.max(oldest, market.openedAt || 0);
    const age = from == null ? null : Math.round((now - from) / 60000);

    return {
      symbol: q.symbol,
      open: market.open,
      ageMinutes: age,
      price: q.price == null ? null : q.price,
      error: q.error || null,
    };
  });

  const rawStale = rows.filter((r) => r.ageMinutes != null && r.ageMinutes > STALE_MINUTES);
  // A frozen price outside this instrument's hours is normal, not a fault.
  // Only report staleness while it is supposed to be trading.
  const stale = rawStale.filter((r) => r.open);
  const unknown = rows.filter((r) => r.open && r.ageMinutes == null).map((r) => r.symbol);

  return {
    marketOpen: rows.some((r) => r.open),
    checked: rows.length,
    stale,
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
