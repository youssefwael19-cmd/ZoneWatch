/**
 * Is the market actually tradeable right now?
 *
 * Two independent checks, because either one alone has let alerts through:
 *
 * 1. The weekly calendar. Instruments here are FX, spot gold and index CFDs,
 *    which all follow the same week: Sunday evening to Friday evening UTC.
 *    Nothing trades at the weekend, so nothing should be sent at the weekend.
 *
 * 2. The feed itself. Even inside the week, a market can be shut — the daily
 *    rollover gap, or a provider that has stopped updating. If the last real
 *    tick is older than a few minutes, the price on screen is a frozen number
 *    and an alert about it is noise.
 *
 * The watcher keeps tracking zones while this blocks delivery, so nothing is
 * missed: when the market reopens the state is already correct.
 */

const sessions = require("./sessions");

const MAX_STALE_MINUTES = 25;

function weeklyOpen(now = new Date()) {
  try {
    return sessions.marketState(now);
  } catch {
    return true;
  }
}

/**
 * When the current trading week opened (ms), i.e. the most recent Sunday
 * 22:00 UTC. Lets the feed watchdog treat the weekend's silence as expected
 * rather than as minutes of a dead feed.
 */
function weeklyOpenedAt(now = new Date()) {
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const sinceSunday = now.getUTCDay(); // 0 = Sunday
  const sunday = dayStart - sinceSunday * 86400000;
  const at = sunday + 22 * 60 * 60000;
  return at <= now.getTime() ? at : at - 7 * 86400000;
}

function ageMinutes(lastMarketUpdate, now = Date.now()) {
  if (!lastMarketUpdate) return null;
  const t = new Date(lastMarketUpdate).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.round((now - t) / 60000);
}

/**
 * @returns {{allowed: boolean, reason: string|null, ageMinutes: number|null}}
 */
function check({ lastMarketUpdate, now = Date.now(), maxStaleMinutes = MAX_STALE_MINUTES } = {}) {
  if (!weeklyOpen(new Date(now))) {
    return { allowed: false, reason: "the market is closed for the weekend", ageMinutes: null };
  }

  const age = ageMinutes(lastMarketUpdate, now);
  if (age != null && age > maxStaleMinutes) {
    return {
      allowed: false,
      reason: `no fresh price for ${age} minutes — the feed looks shut`,
      ageMinutes: age,
    };
  }

  return { allowed: true, reason: null, ageMinutes: age };
}

module.exports = { check, weeklyOpen, weeklyOpenedAt, ageMinutes, MAX_STALE_MINUTES };
