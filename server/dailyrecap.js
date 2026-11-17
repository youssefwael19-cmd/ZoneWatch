/**
 * The daily recap: one Discord message a day that says where the app stands.
 *
 * Distinct from the weekly recap (a record of closed signals) and from the old
 * conditional digest: this one is sent every day at the same time whether or not
 * anything happened, because "nothing happened, here is why" is the answer to
 * the question you actually ask at the end of a trading day. The text is built
 * from summaries passed in, so it can be tested without a running app.
 */

const fs = require("fs");
const path = require("path");
const { writeJson } = require("./atomicWrite");

const FILE = path.join(__dirname, "..", "dailyrecap.json");
const SEND_HOUR_UTC = 21;
const MAX_CHARS = 1900;

function readState() {
  try {
    const raw = fs.readFileSync(FILE, "utf-8").trim();
    if (!raw) return { lastSentDay: null };
    const parsed = JSON.parse(raw);
    return { lastSentDay: parsed.lastSentDay || null };
  } catch {
    return { lastSentDay: null };
  }
}

function writeState(state) {
  try {
    writeJson(FILE, state, 2);
  } catch {}
}

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** Due once a day, at or after the send hour, and never twice. */
function shouldSend(now = new Date()) {
  if (readState().lastSentDay === dayKey(now)) return false;
  return now.getUTCHours() >= SEND_HOUR_UTC;
}

function markSent(now = new Date()) {
  writeState({ lastSentDay: dayKey(now) });
}

function money(value) {
  const n = Number(value) || 0;
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
}

/** The same money format, with a leading + when it is a gain. */
function signed(value) {
  const n = Number(value) || 0;
  return `${n > 0 ? "+" : ""}${money(n)}`;
}

function startOfDayUtc(now) {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** Trades that closed since midnight UTC, and what they were worth. */
function closedToday(history, now) {
  const from = startOfDayUtc(now);
  const rows = (Array.isArray(history) ? history : []).filter((h) => {
    if (!h.closedAt) return false;
    const at = new Date(h.closedAt).getTime();
    return Number.isFinite(at) && at >= from;
  });
  const wins = rows.filter((h) => h.outcome === "win").length;
  const losses = rows.filter((h) => h.outcome === "loss").length;
  const expired = rows.filter((h) => h.outcome === "expired").length;
  const totalR = rows.reduce((sum, h) => sum + (Number(h.rMultiple) || 0), 0);
  return { rows, wins, losses, expired, totalR: Number(totalR.toFixed(2)) };
}

/** Distance to the nearest zone, phrased for a human reading a phone. */
function describeNearest(row) {
  if (!row) return null;
  const side = row.inZone ? "inside" : `${row.distance} away`;
  return `${row.symbol} ${side} of ${row.type} ${row.low}–${row.high}`;
}

function buildRecap({
  journal = {},
  exec = {},
  history = [],
  openTrades = 0,
  nearest = [],
  proven = [],
  feed = {},
  quotes = [],
  zoneCount = 0,
  autoZoneCount = 0,
  brokenCount = 0,
  now = new Date(),
}) {
  const lines = [];
  const day = now.toUTCString().slice(0, 16);
  lines.push(`**Zone Watch · daily recap · ${day} UTC**`);

  const stale = feed && feed.stale;
  lines.push(
    `Feed: ${quotes.length} market${quotes.length === 1 ? "" : "s"} · ${zoneCount} zone${
      zoneCount === 1 ? "" : "s"
    } (${autoZoneCount} auto)${stale ? ` · **stale${feed.ageMinutes ? ` ${feed.ageMinutes}m` : ""}**` : " · live"}.`
  );

  const sent = Number(journal.sent) || 0;
  const held = Number(journal.held) || 0;
  lines.push(
    `Alerts: ${sent} sent${held ? `, ${held} held by a gate` : ""}${brokenCount ? ` · ${brokenCount} zone${brokenCount === 1 ? "" : "s"} broke` : ""}.`
  );

  const today = closedToday(history, now);
  const record = [];
  record.push(`${today.wins}W/${today.losses}L`);
  if (today.expired) record.push(`${today.expired} expired`);
  if (today.rows.length) record.push(`${today.totalR > 0 ? "+" : ""}${today.totalR}R`);
  lines.push(
    `Signals: ${today.rows.length} closed today (${record.join(", ")}) · ${openTrades} open now.`
  );

  if (exec.enabled) {
    const pnl = Number(exec.dayRealized) || 0;
    // Wins and losses in money, not R: the paper account is the thing being
    // judged, so the day's record belongs on the same line as its equity.
    const tradeRecord = Number(exec.dayClosed)
      ? ` · ${exec.dayWins || 0}W/${exec.dayLosses || 0}L${
          exec.dayBest == null
            ? ""
            : ` (best ${signed(exec.dayBest)}, worst ${signed(exec.dayWorst)})`
        }`
      : " · no closed trades";
    lines.push(
      `Auto-trading (${exec.mode}): equity ${exec.equity == null ? "—" : money(exec.equity)} · today ${signed(pnl)}${tradeRecord} · ${
        exec.openCount || 0
      } open, ${exec.closedCount || 0} closed all time${exec.killSwitch ? ` · **stopped: ${exec.killReason || "by hand"}**` : ""}.`
    );
  } else {
    lines.push("Auto-trading: off.");
  }

  lines.push(
    proven.length
      ? `Gate: ${proven.length} market${proven.length === 1 ? "" : "s"} cleared (${proven.join(", ")}).`
      : "Gate: nothing cleared — the app is staying quiet."
  );

  const closest = nearest.map(describeNearest).filter(Boolean).slice(0, 3);
  if (closest.length) lines.push(`Closest to a zone: ${closest.join(" · ")}.`);

  const text = lines.join("\n");
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1)}…` : text;
}

/**
 * Build from the app's own objects, so the scheduler and the assistant's preview
 * cannot drift apart and describe the same day differently.
 */
function fromApp({ journal, exec, history = [], openTrades = 0, proven = [], live = {} }) {
  const zones = Array.isArray(live.zones) ? live.zones : [];
  return buildRecap({
    journal,
    exec,
    history,
    openTrades,
    proven,
    nearest: Object.values(live.nearest || {}),
    feed: live.feed,
    quotes: live.quotes || [],
    zoneCount: zones.length,
    autoZoneCount: zones.filter((z) => z.source === "auto").length,
    brokenCount: (live.brokenZones || []).length,
  });
}

module.exports = {
  buildRecap,
  fromApp,
  shouldSend,
  markSent,
  dayKey,
  readState,
  closedToday,
  SEND_HOUR_UTC,
};
