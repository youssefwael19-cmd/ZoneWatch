/**
 * Market session timing and open/close detection.
 *
 * Times are approximate and use UTC with basic DST handling for London and New
 * York. They are meant for awareness alerts, not for precise exchange clocks.
 */

function nthWeekdayOfMonth(year, month, weekday, n) {
  // month 0-11, weekday 0=Sun
  const first = new Date(Date.UTC(year, month, 1));
  const firstDay = first.getUTCDay();
  const offset = (weekday - firstDay + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return day;
}

function lastWeekdayOfMonth(year, month, weekday) {
  const last = new Date(Date.UTC(year, month + 1, 0));
  const lastDay = last.getUTCDay();
  const offset = (lastDay - weekday + 7) % 7;
  return last.getUTCDate() - offset;
}

function isUSADst(date) {
  // Second Sunday in March to first Sunday in November (local 2am, approx UTC boundaries)
  const y = date.getUTCFullYear();
  const marchStartDay = nthWeekdayOfMonth(y, 2, 0, 2); // March, 2nd Sunday
  const novStartDay = nthWeekdayOfMonth(y, 10, 0, 1); // November, 1st Sunday
  const start = Date.UTC(y, 2, marchStartDay, 7, 0, 0); // ~2am local EST
  const end = Date.UTC(y, 10, novStartDay, 6, 0, 0); // ~2am local EDT
  const t = date.getTime();
  return t >= start && t < end;
}

function isEUDst(date) {
  // Last Sunday in March to last Sunday in October (01:00 UTC changeover)
  const y = date.getUTCFullYear();
  const marchEndDay = lastWeekdayOfMonth(y, 2, 0);
  const octEndDay = lastWeekdayOfMonth(y, 9, 0);
  const start = Date.UTC(y, 2, marchEndDay, 1, 0, 0);
  const end = Date.UTC(y, 9, octEndDay, 1, 0, 0);
  const t = date.getTime();
  return t >= start && t < end;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function toHHMM(date) {
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function sessionDefs(date) {
  const usDst = isUSADst(date);
  const euDst = isEUDst(date);

  // All times in UTC minutes from midnight
  const defs = [
    { name: "Sydney", open: 22 * 60, close: 7 * 60, crossesMidnight: true, days: [0, 1, 2, 3, 4, 5, 6] },
    { name: "Tokyo", open: 0 * 60, close: 9 * 60, crossesMidnight: false, days: [1, 2, 3, 4, 5] },
    { name: "London", open: euDst ? 7 * 60 : 8 * 60, close: euDst ? 16 * 60 : 17 * 60, crossesMidnight: false, days: [1, 2, 3, 4, 5] },
    { name: "New York", open: usDst ? 12 * 60 : 13 * 60, close: usDst ? 21 * 60 : 22 * 60, crossesMidnight: false, days: [1, 2, 3, 4, 5] },
    { name: "NASDAQ", open: usDst ? 13 * 60 + 30 : 14 * 60 + 30, close: usDst ? 20 * 60 : 21 * 60, crossesMidnight: false, days: [1, 2, 3, 4, 5] },
  ];

  return defs;
}

function isOpen(def, date) {
  const day = date.getUTCDay();
  const mins = date.getUTCHours() * 60 + date.getUTCMinutes();

  if (!def.crossesMidnight) {
    if (!def.days.includes(day)) return false;
    return mins >= def.open && mins < def.close;
  }

  // crosses midnight: open late day X, closes early day X+1
  if (mins >= def.open) {
    return def.days.includes(day);
  }
  if (mins < def.close) {
    const prevDay = (day + 6) % 7;
    return def.days.includes(prevDay);
  }
  return false;
}

function fmtTime(mins) {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${pad(h)}:${pad(m)} UTC`;
}

function getSessionStates(now = new Date()) {
  const defs = sessionDefs(now);
  return defs.map((d) => ({
    name: d.name,
    open: isOpen(d, now),
    openTime: fmtTime(d.open),
    closeTime: fmtTime(d.close),
  }));
}

function sessionKey(name, type, now) {
  // key per day+event so each open/close fires once
  const y = now.getUTCFullYear();
  const m = pad(now.getUTCMonth() + 1);
  const d = pad(now.getUTCDate());
  return `${y}-${m}-${d}|${name}|${type}`;
}

/**
 * Detect open/close transitions. `prevStates` is a Map of name -> boolean.
 * Returns { events, states } where events are {name, type, time} for new transitions.
 */
function detectSessionEvents(prevStates, now = new Date()) {
  const defs = sessionDefs(now);
  const events = [];
  const states = new Map();

  for (const d of defs) {
    const open = isOpen(d, now);
    const prev = prevStates.get(d.name);

    states.set(d.name, open);

    // Only fire transitions if we have a previous state (avoid spam on startup)
    if (prev === undefined) continue;

    if (!prev && open) {
      events.push({
        name: d.name,
        type: "open",
        at: now.toISOString(),
        time: fmtTime(d.open),
        closeTime: fmtTime(d.close),
      });
    } else if (prev && !open) {
      events.push({
        name: d.name,
        type: "close",
        at: now.toISOString(),
        time: fmtTime(d.close),
        openTime: fmtTime(d.open),
      });
    }
  }

  return { events, states };
}

/**
 * Weekly forex market state.
 *
 * The forex week runs from Sunday evening to Friday evening (UTC). Weekend is
 * closed. Opening is treated as 22:00 UTC; the Friday close follows New York's
 * 17:00 local close, which is 21:00 UTC in summer and 22:00 UTC in winter.
 */
function marketState(now = new Date()) {
  const usDst = isUSADst(now);
  const openMins = 22 * 60;
  const closeMins = usDst ? 21 * 60 : 22 * 60;
  const day = now.getUTCDay();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();

  if (day === 6) return false; // Saturday
  if (day === 0) return mins >= openMins; // Sunday: opens in the evening
  if (day === 5) return mins < closeMins; // Friday: closes in the evening
  return true;
}

/**
 * Detect the weekly market open/close transition.
 * @param {boolean|undefined} prevOpen previous state, undefined on first run
 */
function detectMarketEvents(prevOpen, now = new Date()) {
  const open = marketState(now);
  const events = [];

  if (typeof prevOpen === "boolean" && prevOpen !== open) {
    const usDst = isUSADst(now);
    events.push(
      open
        ? {
            name: "Forex market",
            type: "open",
            at: now.toISOString(),
            time: "22:00 UTC Sunday",
            closeTime: `${fmtTime(usDst ? 21 * 60 : 22 * 60)} Friday`,
            detail:
              "The trading week has started. Gold and the index CFDs are open again.",
          }
        : {
            name: "Forex market",
            type: "close",
            at: now.toISOString(),
            time: `${fmtTime(usDst ? 21 * 60 : 22 * 60)} Friday`,
            openTime: "22:00 UTC Sunday",
            detail:
              "The trading week has ended — the market is closed for the weekend and reopens Sunday evening.",
          }
    );
  }

  return { open, events };
}

module.exports = {
  getSessionStates,
  detectSessionEvents,
  detectMarketEvents,
  marketState,
  sessionDefs,
  isOpen,
};
