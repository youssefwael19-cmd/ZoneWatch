/**
 * The learner — the part of the app that judges its own past calls.
 *
 * Every signal that was posted is tracked to a win, a loss or an expiry by
 * signaltracker.js. This module reads those closed results, groups them by
 * market / direction / setup type, and asks a plain question: has this kind of
 * trade actually made money, or has it lost money, by enough of a margin that
 * the app should stop doing it?
 *
 * The thresholds are deliberately conservative. With fewer than 10 closed
 * trades the app says "still learning" and changes nothing, because a 4-trade
 * sample is noise and acting on it is how systems thrash. Only once a group has
 * 15+ closed trades AND a t-statistic past -1.5 AND an average worse than
 * -0.15R does the learner mute that specific setup.
 *
 * Nothing here looks at the future, and nothing is fitted to a curve: the
 * learner only ever reads outcomes that have already happened.
 */

const fs = require("fs");
const path = require("path");
const { writeJson } = require("./atomicWrite");

const tracker = require("./signaltracker");

const FILE = path.join(__dirname, "..", "learning.json");

const MIN_JUDGE = 10; // below this, no verdict is offered
const MIN_SUPPRESS = 15; // below this, the app will not mute anything
const SUPPRESS_EXPECTANCY = -0.15; // R per trade
const SUPPRESS_TSTAT = -1.5;
const GOOD_EXPECTANCY = 0.1;
const GOOD_TSTAT = 1.5;

/* ------------------------------ maths ------------------------------ */

function tStat(values) {
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  if (!sd) return null;
  return Number((mean / (sd / Math.sqrt(n))).toFixed(2));
}

function groupKey(trade) {
  return [trade.symbol, trade.side, trade.confidence || "standard"].join("|");
}

/**
 * Turn closed trades into per-setup verdicts.
 * Exported so the logic can be tested without touching live data.
 */
function evaluate(history) {
  const closed = (history || []).filter((h) => h.outcome === "win" || h.outcome === "loss");

  const groups = new Map();
  for (const t of closed) {
    const key = groupKey(t);
    if (!groups.has(key)) {
      groups.set(key, { symbol: t.symbol, side: t.side, setup: t.confidence || "standard", rs: [] });
    }
    groups.get(key).rs.push(Number(t.rMultiple) || 0);
  }

  const rows = [];
  for (const g of groups.values()) {
    const n = g.rs.length;
    const wins = g.rs.filter((r) => r > 0).length;
    const expectancy = Number((g.rs.reduce((a, b) => a + b, 0) / n).toFixed(3));
    const t = tStat(g.rs);

    let status = "learning";
    let note = "";

    if (n >= MIN_SUPPRESS && expectancy <= SUPPRESS_EXPECTANCY && t != null && t <= SUPPRESS_TSTAT) {
      status = "muted";
      note = `losing on ${n} closed trades (${expectancy}R each, t=${t}) — muted`;
    } else if (n >= MIN_JUDGE && expectancy >= GOOD_EXPECTANCY && t != null && t >= GOOD_TSTAT) {
      status = "working";
      note = `positive on ${n} closed trades (${expectancy}R each, t=${t}) — left alone`;
    } else if (n < MIN_JUDGE) {
      note = `only ${n} closed — too few to judge, still learning`;
    } else {
      note = `around break-even on ${n} closed trades (${expectancy}R each) — no change`;
    }

    rows.push({
      key: groupKey(g),
      symbol: g.symbol,
      side: g.side,
      setup: g.setup,
      n,
      wins,
      winrate: Number(((wins / n) * 100).toFixed(1)),
      expectancy,
      tStat: t,
      status,
      note,
    });
  }

  rows.sort((a, b) => b.n - a.n);
  return rows;
}

/* --------------------------- live state --------------------------- */

function readState() {
  try {
    const raw = fs.readFileSync(FILE, "utf-8").trim();
    if (!raw) return { lastRunAt: null, muted: {}, mutedCount: 0 };
    const parsed = JSON.parse(raw);
    return {
      lastRunAt: parsed.lastRunAt || null,
      muted: parsed.muted || {},
      mutedCount: parsed.mutedCount || 0,
    };
  } catch {
    return { lastRunAt: null, muted: {}, mutedCount: 0 };
  }
}

function writeState(state) {
  try {
    writeJson(FILE, state, 2);
  } catch {}
}

/**
 * Recompute verdicts and remember which setups are currently muted.
 * Throttled to one write every five minutes so a 10-second watch cycle does
 * not hammer the volume; the verdicts themselves are recomputed from scratch
 * on every call, so nothing here can go stale in a way that matters.
 */
const WRITE_GAP_MS = 5 * 60 * 1000;
let lastWrite = 0;

function refresh(force = false) {
  const { history } = tracker.load();
  const rows = evaluate(history);
  if (!force && Date.now() - lastWrite < WRITE_GAP_MS) return rows;

  const state = readState();
  const muted = {};
  for (const row of rows) if (row.status === "muted") muted[row.key] = row.note;
  writeState({
    lastRunAt: new Date().toISOString(),
    muted,
    mutedCount: Object.keys(muted).length,
    suppressed: state.suppressed || [],
  });
  lastWrite = Date.now();
  return rows;
}

/**
 * Should this signal be posted?
 * A mute is always specific: one market, one direction, one setup type.
 */
function verdictFor(signal) {
  const rows = evaluate(tracker.load().history);
  const key = [signal.symbol, signal.side, signal.confidence || "standard"].join("|");
  const row = rows.find((r) => r.key === key || r.key === [signal.symbol, signal.side, "standard"].join("|"));
  if (row && row.status === "muted") {
    return { allowed: false, reason: row.note, row };
  }
  return { allowed: true, reason: row ? row.note : "no history for this setup yet", row: row || null };
}

/** Record that a signal was held back, so the UI can show it was deliberate. */
function noteSuppressed(signal, verdict) {
  const state = readState();
  state.suppressed = (state.suppressed || []).slice(-30);
  state.suppressed.push({
    at: new Date().toISOString(),
    symbol: signal.symbol,
    side: signal.side,
    setup: signal.confidence || "standard",
    reason: verdict.reason,
  });
  writeState(state);
}

function summary() {
  const { history } = tracker.load();
  const rows = evaluate(history);
  const state = readState();
  const closed = rows.reduce((a, r) => a + r.n, 0);
  const totalR = rows.reduce((a, r) => a + r.expectancy * r.n, 0);

  const lessons = [];
  for (const row of rows) {
    lessons.push({
      tone: row.status === "muted" ? "bad" : row.status === "working" ? "good" : "flat",
      text: `${row.symbol} ${row.side} · ${row.setup}: ${row.wins}/${row.n} won, ${row.expectancy}R each. ${row.note}`,
    });
  }
  if (!lessons.length) {
    lessons.push({
      tone: "flat",
      text: "Nothing has closed yet, so I have no evidence to learn from. Verdicts start once trades resolve.",
    });
  }

  return {
    lastRunAt: state.lastRunAt,
    closedTrades: closed,
    totalR: Number(totalR.toFixed(2)),
    rows,
    lessons,
    muted: state.muted || {},
    mutedCount: state.mutedCount || 0,
    suppressed: (state.suppressed || []).slice(-10).reverse(),
    thresholds: {
      judge: MIN_JUDGE,
      suppress: MIN_SUPPRESS,
      suppressExpectancy: SUPPRESS_EXPECTANCY,
      suppressTStat: SUPPRESS_TSTAT,
    },
  };
}

module.exports = { evaluate, verdictFor, noteSuppressed, refresh, summary, tStat };
