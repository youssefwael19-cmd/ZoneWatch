/**
 * The daily digest: one short message that says what the app did today.
 *
 * Deliberately plain. It reports what happened — alerts, held alerts, executor
 * activity, which markets are cleared to trade — and nothing about what might
 * happen. If nothing happened, nothing is sent: a daily "no news" message is
 * how people stop reading the channel that also carries real alerts.
 */

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "digest.json");
const SEND_HOUR_UTC = 21;

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
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch {}
}

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** Due once a day, at or after the send hour, and never twice. */
function shouldSend(now = new Date()) {
  const state = readState();
  if (state.lastSentDay === dayKey(now)) return false;
  return now.getUTCHours() >= SEND_HOUR_UTC;
}

function markSent(now = new Date()) {
  writeState({ lastSentDay: dayKey(now) });
}

function money(value) {
  const n = Number(value) || 0;
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
}

/**
 * @param {object} input { journal, exec, proven } — already-computed summaries.
 *   Passing them in keeps this a pure text builder, which is what makes it
 *   testable without a running app.
 */
function buildDigest({ journal, exec, proven = [], now = new Date() }) {
  const j = journal || {};
  const e = exec || {};
  const lines = [];

  const day = now.toUTCString().slice(0, 16);
  lines.push(`**Zone Watch · daily summary · ${day} UTC**`);

  const sent = j.sent || 0;
  const held = j.held || 0;
  lines.push(`Alerts: ${sent} sent${held ? `, ${held} held back by the gate` : ""}.`);

  if (j.closed) {
    lines.push(
      `Record: ${j.closed} closed, ${j.winrate}% won, ${j.expectancy > 0 ? "+" : ""}${j.expectancy}R each.`
    );
  } else {
    lines.push("Record: no closed trades yet.");
  }

  if (e.enabled) {
    const pnl = Number(e.dayRealized) || 0;
    lines.push(
      `Auto-trading (${e.mode}): ${e.openCount} open, ${e.closedCount} closed all time, today ${money(pnl)}.` +
        (e.killSwitch ? ` **Stopped: ${e.killReason}**` : "")
    );
  } else {
    lines.push("Auto-trading: off.");
  }

  const gate = proven.length
    ? `Gate: ${proven.length} market${proven.length === 1 ? "" : "s"} cleared (${proven.join(", ")}).`
    : "Gate: nothing cleared — the app is staying quiet.";
  lines.push(gate);

  return lines.join("\n");
}

/** Nothing worth saying means nothing is said. */
function hasSomethingToReport({ journal, exec }) {
  const j = journal || {};
  const e = exec || {};
  return Boolean((j.sent || 0) + (j.held || 0) + (e.openCount || 0) + (e.closedCount || 0));
}

module.exports = { buildDigest, hasSomethingToReport, shouldSend, markSent, dayKey };
