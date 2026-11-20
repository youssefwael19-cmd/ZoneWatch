/**
 * Weekly recap of closed signals.
 *
 * The recap covers the last 7 days of resolved signals and is sent once a week.
 * It is due from Monday 08:00 UTC onward; if the app was down at that moment it
 * catches up later that week rather than skipping the week entirely. The last
 * week sent is persisted so a restart cannot send the same recap twice.
 */

const fs = require("fs");
const path = require("path");
const { writeJson } = require("./atomicWrite");

const FILE = require("./stateDir").file("recap.json");
const SEND_HOUR_UTC = 8;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function readState() {
  try {
    const raw = fs.readFileSync(FILE, "utf-8").trim();
    if (!raw) return { lastSentWeek: null };
    const parsed = JSON.parse(raw);
    return { lastSentWeek: typeof parsed.lastSentWeek === "string" ? parsed.lastSentWeek : null };
  } catch {
    return { lastSentWeek: null };
  }
}

function writeState(state) {
  try {
    writeJson(FILE, state, 2);
  } catch {}
}

/** Monday of the week containing `date`, at 00:00 UTC. */
function mondayOf(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

function weekKey(date) {
  return mondayOf(date).toISOString().slice(0, 10);
}

function dueAt(date) {
  return new Date(mondayOf(date).getTime() + SEND_HOUR_UTC * 3600 * 1000);
}

function shouldSend(now = new Date()) {
  const state = readState();
  const due = dueAt(now);
  if (now < due) return false;
  return state.lastSentWeek !== weekKey(now);
}

function markSent(now = new Date()) {
  writeState({ lastSentWeek: weekKey(now) });
}

/**
 * Build the recap from signal history.
 * @param {Array} history closed signals with closedAt/outcome/rMultiple/symbol/side
 */
function buildRecap(history, now = new Date()) {
  const end = now;
  const start = new Date(end.getTime() - WEEK_MS);

  const closed = (history || []).filter((h) => {
    const at = new Date(h.closedAt || 0).getTime();
    return Number.isFinite(at) && at >= start.getTime() && at <= end.getTime();
  });

  const wins = closed.filter((h) => h.outcome === "win");
  const losses = closed.filter((h) => h.outcome === "loss");
  const expired = closed.filter((h) => h.outcome === "expired");
  const decided = wins.length + losses.length;

  const bySymbol = {};
  for (const h of closed) {
    const key = h.symbol || "UNKNOWN";
    if (!bySymbol[key]) bySymbol[key] = { wins: 0, losses: 0, expired: 0, r: 0 };
    if (h.outcome === "win") bySymbol[key].wins++;
    else if (h.outcome === "loss") bySymbol[key].losses++;
    else bySymbol[key].expired++;
    bySymbol[key].r += h.rMultiple || 0;
  }

  const totalR = closed.reduce((a, h) => a + (h.rMultiple || 0), 0);

  const best = wins.slice().sort((a, b) => (b.rMultiple || 0) - (a.rMultiple || 0))[0] || null;
  const worst = losses.slice().sort((a, b) => (a.rMultiple || 0) - (b.rMultiple || 0))[0] || null;

  return {
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    total: closed.length,
    wins: wins.length,
    losses: losses.length,
    expired: expired.length,
    winrate: decided ? Number(((wins.length / decided) * 100).toFixed(1)) : null,
    totalR: Number(totalR.toFixed(2)),
    bySymbol,
    best,
    worst,
    trades: closed.slice().sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt)),
  };
}

module.exports = { buildRecap, shouldSend, markSent, weekKey, dueAt, readState };
