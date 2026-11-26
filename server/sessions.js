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

/* ------------------------------------------------------------------ *
 * US cash-equity calendar
 *
 * The FX week is 24/5, but the Nasdaq cash session also stops on exchange
 * holidays and closes early on three days a year. Without this the feed
 * watchdog called a frozen Thanksgiving quote "stale" while the session clock
 * said the market was open.
 * ------------------------------------------------------------------ */

function dateKey(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Gregorian Easter Sunday, used only to place Good Friday. */
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

/** A fixed-date holiday, moved to Friday/Monday when it lands on a weekend. */
function observedFixedDate(year, month, day) {
  const date = new Date(Date.UTC(year, month, day));
  const dow = date.getUTCDay();
  if (dow === 6) date.setUTCDate(date.getUTCDate() - 1);
  else if (dow === 0) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

const holidayCache = new Map();

function usEquityHolidayMap(year) {
  const hit = holidayCache.get(year);
  if (hit) return hit;
  const map = new Map();
  const add = (date, name) => map.set(dateKey(date), name);
  add(observedFixedDate(year, 0, 1), "New Year's Day");
  add(new Date(Date.UTC(year, 0, nthWeekdayOfMonth(year, 0, 1, 3))), "Martin Luther King Jr. Day");
  add(new Date(Date.UTC(year, 1, nthWeekdayOfMonth(year, 1, 1, 3))), "Presidents' Day");
  const goodFriday = easterSunday(year);
  goodFriday.setUTCDate(goodFriday.getUTCDate() - 2);
  add(goodFriday, "Good Friday");
  add(new Date(Date.UTC(year, 4, lastWeekdayOfMonth(year, 4, 1))), "Memorial Day");
  add(observedFixedDate(year, 5, 19), "Juneteenth");
  add(observedFixedDate(year, 6, 4), "Independence Day");
  add(new Date(Date.UTC(year, 8, nthWeekdayOfMonth(year, 8, 1, 1))), "Labor Day");
  add(new Date(Date.UTC(year, 10, nthWeekdayOfMonth(year, 10, 4, 4))), "Thanksgiving");
  add(observedFixedDate(year, 11, 25), "Christmas Day");
  holidayCache.set(year, map);
  return map;
}

function usEquityHoliday(date) {
  const key = dateKey(date);
  const year = date.getUTCFullYear();
  // Dec 31 belongs to next year's map when New Year's Day falls on a Saturday.
  return usEquityHolidayMap(year).get(key) || usEquityHolidayMap(year + 1).get(key) || null;
}

/** Whether the NYSE/Nasdaq cash session closes at 13:00 New York time. */
function usEquityEarlyClose(date) {
  if (usEquityHoliday(date)) return false;
  const year = date.getUTCFullYear();
  const key = dateKey(date);
  const weekday = (d) => d.getUTCDay() >= 1 && d.getUTCDay() <= 5;

  const thanksgiving = new Date(Date.UTC(year, 10, nthWeekdayOfMonth(year, 10, 4, 4)));
  const blackFriday = new Date(thanksgiving);
  blackFriday.setUTCDate(thanksgiving.getUTCDate() + 1);
  if (key === dateKey(blackFriday)) return true;

  const christmasEve = new Date(Date.UTC(year, 11, 24));
  if (key === dateKey(christmasEve) && weekday(christmasEve) && weekday(new Date(Date.UTC(year, 11, 25)))) return true;

  const julyThird = new Date(Date.UTC(year, 6, 3));
  if (key === dateKey(julyThird) && weekday(julyThird) && weekday(new Date(Date.UTC(year, 6, 4)))) return true;

  return false;
}

function usEquityCloseMinutes(date) {
  if (!usEquityEarlyClose(date)) return null;
  return isUSADst(date) ? 17 * 60 : 18 * 60; // 13:00 New York
}

/** The session open state, including exchange holidays and early closes. */
function sessionIsOpen(def, now) {
  if (!isOpen(def, now)) return false;
  if (def.name !== "NASDAQ") return true;
  if (usEquityHoliday(now)) return false;
  const early = usEquityCloseMinutes(now);
  if (early == null) return true;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return mins < early;
}

/** The close time to display, shortened on a 13:00 New York half-day. */
function sessionCloseMinutes(def, now) {
  if (def.name === "NASDAQ") {
    const early = usEquityCloseMinutes(now);
    if (early != null) return early;
  }
  return def.close;
}

function getSessionStates(now = new Date()) {
  const defs = sessionDefs(now);
  return defs.map((d) => ({
    name: d.name,
    open: sessionIsOpen(d, now),
    openTime: fmtTime(d.open),
    closeTime: fmtTime(sessionCloseMinutes(d, now)),
  }));
}

/**
 * Instruments that have their own exchange hours instead of the 24/5 week.
 * Anything absent here (gold, the FX pairs) is treated as an FX-style market.
 */
const INSTRUMENT_SESSIONS = { NASDAQ: "NASDAQ" };

function instrumentSession(symbol) {
  return INSTRUMENT_SESSIONS[symbol] || null;
}

/**
 * Is this instrument's own market trading right now?
 *
 * NASDAQ's cash session ends in the afternoon while FX and gold keep going,
 * so the weekly clock alone must not decide whether its feed is late.
 */
function instrumentMarketOpen(symbol, now = new Date()) {
  const name = instrumentSession(symbol);
  if (!name) return marketState(now);
  const def = sessionDefs(now).find((d) => d.name === name);
  return def ? sessionIsOpen(def, now) : marketState(now);
}

/**
 * When the current session for this instrument opened (ms), or null when its
 * market is shut. Used to reset feed-age counts at the open: a price frozen
 * overnight is not "silent for seventeen hours" a minute after the bell.
 */
function sessionOpenedAt(symbol, now = new Date()) {
  const name = instrumentSession(symbol);
  if (!name) return null;
  const def = sessionDefs(now).find((d) => d.name === name);
  if (!def || !sessionIsOpen(def, now)) return null;
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return dayStart + def.open * 60000;
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
    const open = sessionIsOpen(d, now);
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
        closeTime: fmtTime(sessionCloseMinutes(d, now)),
      });
    } else if (prev && !open) {
      events.push({
        name: d.name,
        type: "close",
        at: now.toISOString(),
        time: fmtTime(sessionCloseMinutes(d, now)),
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

/**
 * Instruments that never close.
 *
 * The FX week stops on Friday evening, but bitcoin does not: its market runs
 * through the weekend. Applying the FX calendar to it would silence the app on
 * the two days when nothing else is tradeable.
 */
const ALWAYS_OPEN = new Set(["BTCUSD"]);

function symbolKey(symbol) {
  return String(symbol == null ? "" : symbol)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/** Is this market open now? Unknown and FX-style markets follow the FX week. */
function weeklyOpenFor(symbol, now = new Date()) {
  if (ALWAYS_OPEN.has(symbolKey(symbol))) return true;
  return marketState(now);
}

module.exports = {
  ALWAYS_OPEN,
  weeklyOpenFor,
  getSessionStates,
  sessionCloseMinutes,
  detectSessionEvents,
  detectMarketEvents,
  marketState,
  sessionDefs,
  isOpen,
  instrumentSession,
  instrumentMarketOpen,
  sessionOpenedAt,
};
