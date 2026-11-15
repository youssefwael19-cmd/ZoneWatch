/**
 * Initial Balance Breakout (IVB) — Fabio Valentini's opening-range model.
 *
 * Rules implemented (from his public interviews):
 *   1. The initial balance is the first 30 minutes of the New York cash open.
 *   2. A break only counts when a 5-minute candle CLOSES outside that range.
 *   3. Do not chase — the edge comes from the pullback to the broken edge.
 *   4. Stop on the other side of the range, target 1:2.
 *
 * NOT implemented, and it matters: his order-flow confirmation (cumulative
 * volume delta, footprint absorption, large-lot prints). That data is not
 * available for free, and it is a genuine part of his process. Alerts from this
 * module are therefore labelled as missing their confirmation step.
 */

const RR = 2;
const IB_MINUTES = 30;

function isUsDst(date) {
  const year = date.getUTCFullYear();
  const march = new Date(Date.UTC(year, 2, 1));
  const firstSundayMarch = 1 + ((7 - march.getUTCDay()) % 7);
  const dstStart = Date.UTC(year, 2, firstSundayMarch + 7, 7);
  const nov = new Date(Date.UTC(year, 10, 1));
  const firstSundayNov = 1 + ((7 - nov.getUTCDay()) % 7);
  const dstEnd = Date.UTC(year, 10, firstSundayNov, 6);
  const t = date.getTime();
  return t >= dstStart && t < dstEnd;
}

function nyOpenMinuteUtc(date) {
  return isUsDst(date) ? 13 * 60 + 30 : 14 * 60 + 30;
}

function minuteOfDayUtc(ts) {
  const d = new Date(ts);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/**
 * @param {Array} bars5m  5-minute bars for the current day (or more)
 * @param {Date} now
 * @returns {null|object}
 */
function evaluate(bars5m, now = new Date()) {
  if (!Array.isArray(bars5m) || !bars5m.length) return null;

  const today = now.toISOString().slice(0, 10);
  const todays = bars5m.filter((b) => new Date(b.t).toISOString().slice(0, 10) === today);
  if (!todays.length) return null;

  const openMinute = nyOpenMinuteUtc(now);
  const nowMinute = minuteOfDayUtc(now.getTime());

  const ibBars = todays.filter((b) => {
    const m = minuteOfDayUtc(b.t);
    return m >= openMinute && m < openMinute + IB_MINUTES;
  });

  if (!ibBars.length) {
    return { day: today, state: "before_open", note: "New York has not opened yet today." };
  }

  const ibHigh = Math.max(...ibBars.map((b) => b.h));
  const ibLow = Math.min(...ibBars.map((b) => b.l));
  const range = ibHigh - ibLow;

  if (nowMinute < openMinute + IB_MINUTES) {
    return { day: today, state: "forming", ibHigh, ibLow, range };
  }

  const after = todays.filter((b) => minuteOfDayUtc(b.t) >= openMinute + IB_MINUTES);
  const sessionEnded = nowMinute >= openMinute + 390;

  let state = sessionEnded ? "session_over" : "inside_range";
  let side = null;
  let breakoutAt = null;

  for (const bar of after) {
    if (bar.c > ibHigh) {
      state = "break_up";
      side = "BUY";
      breakoutAt = new Date(bar.t).toISOString();
      break;
    }
    if (bar.c < ibLow) {
      state = "break_down";
      side = "SELL";
      breakoutAt = new Date(bar.t).toISOString();
      break;
    }
  }

  const result = { day: today, state, side, ibHigh, ibLow, range, breakoutAt };
  if (side) {
    const entry = side === "BUY" ? ibHigh : ibLow;
    const stop = side === "BUY" ? ibLow : ibHigh;
    const risk = Math.abs(entry - stop);
    result.entry = entry;
    result.stop = stop;
    result.target = side === "BUY" ? entry + risk * RR : entry - risk * RR;
    result.risk = risk;
  }
  return result;
}

module.exports = { evaluate, nyOpenMinuteUtc, isUsDst, IB_MINUTES };
