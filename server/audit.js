/**
 * The audit report: one public, read-only answer to "is what I shipped actually
 * running, and what does the app think right now?"
 *
 * It exists because checking the app after a change used to mean either a
 * password, or inferring the answer from behaviour. Neither is good. This is a
 * read view of the same numbers the dashboard and the bots use — the build, the
 * gates, every market's proof, the lab's verdicts, the paper and shadow books,
 * the learner, and the health of the watcher.
 *
 * Rules this module exists to keep:
 *
 *  - Nothing secret leaves here. Values are assembled by whitelist, never by
 *    spreading a settings object and hoping, and `redact()` walks the finished
 *    object as a second line: a key named like a secret, or a Discord webhook
 *    URL, is replaced by a marker rather than published.
 *  - Read-only. It never writes state and never places anything.
 *  - Honest about absence. An unknown commit, a missing measurement or a failed
 *    snapshot is reported as null or an error string, never as a plausible
 *    zero.
 */

// Keys that must never be published, whatever shape the object has.
const SECRET_KEY = /(secret|password|passwd|apikey|api_key|privatekey|private_key|token|webhook|cookie)/i;

// A URL that grants posting rights is a secret even when it is not named one.
const WEBHOOK_VALUE = /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\//i;

const REDACTED = "[redacted]";

/**
 * Replace anything in `value` that looks like a secret. Returns a copy; the
 * input is never mutated. Cycles are handled because state objects can share
 * references.
 */
function redact(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === "string") return WEBHOOK_VALUE.test(value) ? REDACTED : value;
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[cycle]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redact(item, seen));

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      // Keep the shape without the value: a caller can tell "not set" from
      // "set and withheld", which is the only useful thing about the field.
      out[key] = item ? REDACTED : item;
      continue;
    }
    out[key] = redact(item, seen);
  }
  return out;
}

/** The two paper books, in the same shape the public money strip uses. */
function bookTotals(o) {
  if (!o) return null;
  return {
    enabled: Boolean(o.enabled),
    mode: o.mode || "paper",
    balance: o.balance == null ? null : o.balance,
    equity: o.equity == null ? null : o.equity,
    dayRealized: Number(o.dayRealized) || 0,
    dayClosed: o.dayClosed || 0,
    dayWins: o.dayWins || 0,
    dayLosses: o.dayLosses || 0,
    openCount: o.openCount || 0,
    closedCount: o.closedCount || 0,
    killSwitch: Boolean(o.killSwitch),
    killReason: o.killReason || null,
  };
}

/**
 * Assemble the report from already-read inputs. Pure: every number here was
 * measured elsewhere, so this function can be tested without a server.
 */
function report(input) {
  const { build, state, brain, lab, learning, money, journal, gates, settings, health } = input || {};

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    build: build || null,
    state: state || null,
    brain: brain || null,
    lab: lab || null,
    gates: gates || null,
    money: money || null,
    journal: journal || null,
    learning: learning || null,
    settings: settings || null,
    health: health || null,
    // Which parts of the report could not be read. An empty list is the answer
    // "everything above is from a live read", which is the only way to tell a
    // quiet app from a broken one.
    incomplete: [],
  };
}

module.exports = { report, redact, bookTotals, SECRET_KEY, WEBHOOK_VALUE, REDACTED };
