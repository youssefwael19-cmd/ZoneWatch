/**
 * Entry timeframes.
 *
 * The app used to hard-code 15m entries and a 1h trend filter because Yahoo's
 * intraday history was too shallow to test anything else. Deriv supplies deep
 * history, so the entry timeframe is now one setting (`ENTRY_TIMEFRAME`) used
 * by the live watcher and the lab together. If the lab tested a different
 * timeframe from the one that sends alerts, its verdict would not be evidence.
 *
 * 1m, 5m, 15m, 30m, 1h and 4h are supported. 4h on Yahoo is built from 1h bars
 * in candles.js; Deriv and OANDA serve it directly.
 */

const INTERVALS = ["1m", "5m", "15m", "30m", "1h", "4h"];
const DEFAULT_ENTRY = "15m";

const MINUTES = { "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240 };

// What the live watcher asks for. These are the ranges the app has always
// used: enough bars for the zone window, not a year of data on every cycle.
const ENTRY_RANGE = {
  "1m": "1d",
  "5m": "5d",
  "15m": "5d",
  "30m": "5d",
  "1h": "1mo",
  "4h": "3mo",
};

// What the lab asks for. The lab needs many blocks of history, not five days.
// Yahoo caps intraday ranges, so labBars() retries the fallback when the long
// range comes back too short.
const LAB_RANGE = {
  "1m": "7d",
  "5m": "3mo",
  "15m": "1y",
  "30m": "1y",
  "1h": "2y",
  "4h": "2y",
};
const LAB_FALLBACK_RANGE = {
  "1m": "5d",
  "5m": "60d",
  "15m": "60d",
  "30m": "60d",
  "1h": "2y",
  "4h": "2y",
};

// The timeframe the confirmation/trend filter reads. One step above the entry:
// a 15m entry should not be fighting the 1h trend.
const HTF = {
  "1m": "5m",
  "5m": "30m",
  "15m": "1h",
  "30m": "1h",
  "1h": "4h",
  "4h": "1d",
};
const HTF_RANGE = {
  "5m": "5d",
  "30m": "1mo",
  "1h": "1mo",
  "4h": "3mo",
  "1d": "1y",
};

// How much history the live zone detector sees. The watcher fetches the entry
// range above and detects zones on all of it; the lab uses the same number of
// bars at every entry instead of a different window that would move the zones.
const ZONE_WINDOW = {
  "1m": 720, // 12 hours: enough for intraday zones without carrying a week of noise
  "5m": 1440, // 5 days
  "15m": 480, // 5 days
  "30m": 240, // 5 days
  "1h": 600, // about a month of market hours
  "4h": 450, // about three months of market hours, what the live range holds
};

// The tracker expires a signal after 24 hours. In bars, that is the same clock
// for every timeframe, so the lab's unresolved trades expire when the live
// ones do.
function maxHoldBars(minutes) {
  return Math.max(1, Math.ceil((24 * 60) / minutes));
}

// The signal cooldown is 30 minutes. In bars, at least one.
function cooldownBars(minutes) {
  return Math.max(1, Math.ceil(30 / minutes));
}

function normalize(value) {
  const v = String(value || "").trim().toLowerCase();
  return INTERVALS.includes(v) ? v : null;
}

/** The entry timeframe for this process. Invalid values fall back to 15m. */
function entry() {
  return normalize(process.env.ENTRY_TIMEFRAME) || DEFAULT_ENTRY;
}

/**
 * Everything the watcher and the lab need to agree on for one timeframe.
 * @param {string} [timeframe]
 */
function plan(timeframe = entry()) {
  const tf = normalize(timeframe) || DEFAULT_ENTRY;
  const minutes = MINUTES[tf];
  const htf = HTF[tf];
  return {
    timeframe: tf,
    minutes,
    entryRange: ENTRY_RANGE[tf],
    labRange: LAB_RANGE[tf],
    fallbackRange: LAB_FALLBACK_RANGE[tf],
    htf,
    htfMinutes: MINUTES[htf],
    htfRange: HTF_RANGE[htf],
    zoneWindow: ZONE_WINDOW[tf],
    maxHoldBars: maxHoldBars(minutes),
    cooldownBars: cooldownBars(minutes),
  };
}

module.exports = {
  INTERVALS,
  DEFAULT_ENTRY,
  normalize,
  entry,
  plan,
  MINUTES,
  ENTRY_RANGE,
  LAB_RANGE,
  HTF,
};
