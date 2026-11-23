/**
 * The daily gate digest: one Discord message a day that names every market and
 * says which gate is holding it, and why.
 *
 * The app is silent when nothing is proven — that is the design. But "silent"
 * and "stuck" look identical from a phone, and the dashboard's gate card is not
 * where you look at 21:00. This turns the same lock readings into a message:
 * the first gate that would stop a setup in each market plus every gate behind
 * it, in the order the watcher applies them.
 *
 * It is a reading, never a decision. The text is built from a lock summary
 * passed in, so it can be tested without the app, and it can never disagree
 * with the card because both come from the same objects.
 */

const fs = require("fs");
const { writeJson } = require("./atomicWrite");

const FILE = require("./stateDir").file("gatedigest.json");
const SEND_HOUR_UTC = 21;
// Discord's hard limit is 2000 characters. Leave room for the header of a
// continuation message and for the ellipsis on a trimmed reason.
const MAX_CHARS = 1900;
const MAX_REASON = 110;

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

function shorten(text, max = MAX_REASON) {
  const one = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** One market, and only the gates that are actually in its way. */
function marketBlock(row = {}) {
  const blockers = (row.locks || []).filter((lock) => lock.state && lock.state !== "open");
  const lines = [`**${row.symbol}** — ${row.state}`];
  if (!blockers.length) {
    lines.push("• open — nothing is standing in the way");
  } else {
    for (const lock of blockers) lines.push(`• ${lock.name}: ${shorten(lock.detail)}`);
  }
  return lines.join("\n");
}

/** Split blocks into messages Discord will accept, in order, dropping nothing. */
function paginate(blocks, header) {
  const messages = [];
  let current = header;
  for (const block of blocks) {
    if (`${current}\n\n${block}`.length > MAX_CHARS) {
      messages.push(current);
      current = `${header} (cont.)`;
    }
    current = `${current}\n\n${block}`;
  }
  messages.push(current);
  return messages.map((text) => (text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1)}…` : text));
}

/**
 * @param {object} input
 * @param {object} input.locks  locks.explain() output: { rows: [...] }
 * @param {Date}   [input.now]
 * @returns {{ messages: string[], markets: number }}
 */
function buildGateDigest({ locks = {}, now = new Date() } = {}) {
  const rows = Array.isArray(locks.rows) ? locks.rows : [];
  const count = (state) => rows.filter((row) => row.state === state).length;
  const day = now.toUTCString().slice(0, 16);
  const header = `**Zone Watch · gate digest · ${day} UTC**`;
  const summary = rows.length
    ? `${rows.length} markets: ${count("held")} held · ${count("partial")} partly open · ${count("open")} open.`
    : "No markets were measured this cycle.";
  const footer =
    "_Order: market hours → feed → news → loss guard → strategy lab → correlation → proven rule → chop → cooldown. " +
    "Reaction confirmation, thin stop and learner mute are judged only once a setup exists._";

  return {
    messages: paginate([summary, ...rows.map(marketBlock), footer], header),
    markets: rows.length,
  };
}

module.exports = {
  buildGateDigest,
  marketBlock,
  shouldSend,
  markSent,
  dayKey,
  SEND_HOUR_UTC,
  MAX_CHARS,
};
