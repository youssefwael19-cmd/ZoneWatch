/**
 * The bots' own journal.
 *
 * Each market has its own bot: it watches one symbol, measures its rules, and
 * decides whether to speak. The Journal tab is where they talk, in their own
 * words, at the moment something happens — a measurement finished, a signal was
 * held back, a trade opened, a trade closed.
 *
 * Nothing here is typed by hand and nothing is invented. Every sentence is
 * generated from the number the bot just produced: the cells it measured, the
 * reason the gate gave, the R the trade closed at. A bot with no measurement
 * says exactly that, because "I have not been tested" is a real answer and a
 * page of empty tables is not.
 */

const fs = require("fs");
const { writeJson } = require("./atomicWrite");

const FILE = require("./stateDir").file("botjournal.json");
const MAX_ENTRIES = 500;

// Fallback only: brain exports the real bar and the callers pass it in.
const BAR = { trades: 30, expectancy: 0.1, tStat: 2.5, folds: 3 };

function read() {
  try {
    const raw = fs.readFileSync(FILE, "utf-8").trim();
    if (!raw) return { entries: [] };
    const parsed = JSON.parse(raw);
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return { entries: [] };
  }
}

function write(state) {
  try {
    writeJson(FILE, { entries: state.entries.slice(-MAX_ENTRIES) }, 1);
  } catch {
    // A failed note must never stop a trade decision or an alert.
  }
}

let counter = 0;
function nextId() {
  counter = (counter + 1) % 1000;
  return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function botName(symbol) {
  return symbol ? `${symbol} bot` : "Zone Watch desk";
}

/**
 * Write one post. `key` makes the post idempotent for the same event, so a
 * cycle that re-reads the same state cannot fill the feed with copies.
 */
function post({ symbol = null, kind = "note", text, meta = {}, key = null }) {
  if (!text) return null;
  const state = read();
  if (key && state.entries.some((e) => e.key === key)) return null;
  const entry = {
    id: nextId(),
    at: new Date().toISOString(),
    bot: botName(symbol),
    symbol,
    kind,
    text,
    meta,
    key: key || null,
  };
  state.entries.push(entry);
  write(state);
  return entry;
}

function list({ limit = 60 } = {}) {
  const { entries } = read();
  return entries.slice(-Math.max(1, limit)).reverse();
}

function fmtR(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}R`;
}

function fmtNum(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

function fmtPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return String(Number(n.toFixed(5)));
}

function fmtMultiple(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "a fraction of";
  return `${Math.round(n * 100)}%`;
}

/* ------------------------------------------------------------------ *
 * Roll call: each bot states what it watches and where it stands.
 * Once per UTC day, so a restart cannot flood the feed.
 * ------------------------------------------------------------------ */

function ownRecord(history, symbol) {
  const closed = (history || []).filter(
    (h) =>
      h &&
      h.symbol === symbol &&
      (h.outcome === "win" || h.outcome === "loss" || h.outcome === "breakeven")
  );
  const totalR = closed.reduce((sum, h) => sum + (Number(h.rMultiple) || 0), 0);
  return {
    closed: closed.length,
    wins: closed.filter((h) => h.outcome === "win").length,
    avgR: closed.length ? totalR / closed.length : null,
  };
}

function introText({ symbol, row, own, bar = BAR }) {
  const parts = [`I watch ${symbol}.`];
  if (row && row.champion) {
    const c = row.champion;
    parts.push(
      `That market is ${row.condition} right now, and I am allowed to speak there: ${c.name} cleared the bar with ${c.n} unseen trades at ${fmtR(c.expectancy)} each, t=${fmtNum(c.tStat)}, positive in ${c.goodFolds}/3 blocks.`
    );
  } else if (row) {
    parts.push(
      `Right now it reads ${row.condition}. None of my measured cells has cleared the bar here (${bar.trades}+ unseen trades, ${fmtR(bar.expectancy)} each, t=${bar.tStat}, all ${bar.folds} blocks positive), so I am holding my signals back — a quiet bot is doing its job, not broken.`
    );
  } else {
    parts.push(
      "I have not been measured yet, so I have no permission to send anything from it. An untested market is a no in this app, not a maybe."
    );
  }
  parts.push(
    own.closed
      ? `My own book: ${own.closed} closed, ${own.wins} won, ${fmtR(own.avgR)} each.`
      : "My own book is empty — I have nothing to defend yet."
  );
  return parts.join(" ");
}

function rollCall({ instruments = [], rows = [], history = [], bar = BAR } = {}) {
  const bySymbol = new Map((rows || []).map((r) => [r.symbol, r]));
  const today = new Date().toISOString().slice(0, 10);
  let posted = 0;
  for (const inst of instruments) {
    const symbol = inst && inst.symbol;
    if (!symbol) continue;
    const row = bySymbol.get(symbol) || null;
    const own = ownRecord(history, symbol);
    const entry = post({
      symbol,
      kind: "rollcall",
      text: introText({ symbol, row, own, bar }),
      meta: { condition: row ? row.condition : null, proven: Boolean(row && row.champion) },
      key: `rollcall|${symbol}|${today}`,
    });
    if (entry) posted++;
  }
  return posted;
}

/* ------------------------------------------------------------------ *
 * Measurements: the bot re-tested its market and reports the result.
 * ------------------------------------------------------------------ */

function measured(result, bar = BAR) {
  if (!result || !result.symbol) return null;
  const symbol = result.symbol;
  const cells = Object.values(result.cells || {});
  const proven = cells.filter((c) => c.proven);
  const traded = cells.filter((c) => Number(c.n) > 0);
  const best = traded
    .slice()
    .sort((a, b) => (Number(b.expectancy) || 0) - (Number(a.expectancy) || 0))[0];
  const condition = (result.current && result.current.label) || "unclear";

  const parts = [`I re-measured ${cells.length} rule/condition cells over ${result.bars} bars of 1h history.`];
  if (proven.length) {
    const strongest = proven
      .slice()
      .sort((a, b) => (Number(b.expectancy) || 0) - (Number(a.expectancy) || 0))[0];
    parts.push(
      `${proven.length} of them cleared the bar. Strongest: ${strongest.familyName} in ${strongest.condition} — ${strongest.n} unseen trades, ${fmtR(strongest.expectancy)} each, t=${fmtNum(strongest.tStat)}, positive in ${strongest.goodFolds}/3 blocks.`
    );
  } else {
    parts.push("None of them cleared the bar, so I still have no permission to send anything from this market.");
  }
  if (best) {
    parts.push(
      `Best of the rest: ${best.familyName} in ${best.condition} — ${best.n} trades, ${fmtR(best.expectancy)} each, t=${fmtNum(best.tStat)}. The bar is ${bar.trades}+ trades, ${fmtR(bar.expectancy)} each, t=${bar.tStat} and all ${bar.folds} blocks positive.`
    );
  }
  parts.push(`${symbol} currently reads ${condition}.`);

  return post({
    symbol,
    kind: "measured",
    text: parts.join(" "),
    meta: { condition, proven: proven.length, cells: cells.length },
    key: `measured|${symbol}|${result.at || ""}`,
  });
}

/* ------------------------------------------------------------------ *
 * Decisions: what the bot did with a signal it saw.
 * ------------------------------------------------------------------ */

function decision(signal, extras = {}) {
  if (!signal || !signal.symbol) return null;
  const status = extras.status;
  if (status !== "held" && status !== "approved") return null;

  const symbol = signal.symbol;
  const side = signal.side || "";
  const setup = signal.confidence || "standard";
  const at = signal.at || new Date().toISOString();

  if (status === "held") {
    const reason = extras.heldReason || "no reason recorded";
    return post({
      symbol,
      kind: "held",
      text: `I held back a ${symbol} ${side} (${setup}): ${reason}. Nothing was sent and nothing was traded — the shadow book still prices the decision so the refusal can be scored later.`,
      meta: { reason, condition: extras.regime || null },
      key: `held|${symbol}|${side}|${at}`,
    });
  }

  const levels = `entry ${fmtPrice(signal.entry ?? signal.price)}, stop ${fmtPrice(signal.stop)}, target ${fmtPrice(signal.target)}`;
  const multiplier = Number(signal.riskMultiplier);
  const size =
    Number.isFinite(multiplier) && multiplier > 0 && multiplier < 1
      ? ` at ${fmtMultiple(multiplier)} of normal risk`
      : " at full risk";
  const why = signal.proofReason || "the gate allowed it";
  return post({
    symbol,
    kind: "approved",
    text: `I am sending a ${symbol} ${side} (${setup}) — ${levels}${size}. Why it got through: ${why}.`,
    meta: { condition: extras.regime || null, riskMultiplier: Number.isFinite(multiplier) ? multiplier : 1 },
    key: `approved|${symbol}|${side}|${at}`,
  });
}

/* ------------------------------------------------------------------ *
 * Results: the trade closed, and the bot says how it went.
 * ------------------------------------------------------------------ */

function results(resolved = []) {
  let posted = 0;
  for (const r of resolved) {
    if (!r || !r.symbol || r.outcome == null) continue;
    const score =
      r.outcome === "breakeven"
        ? "break-even (0R)"
        : `${r.outcome === "win" ? "a win" : r.outcome === "loss" ? "a loss" : r.outcome} ${fmtR(r.rMultiple)}`;
    const minutes = Number(r.heldMinutes) > 0 ? ` after ${Math.round(Number(r.heldMinutes))} minutes` : "";
    const entry = post({
      symbol: r.symbol,
      kind: "result",
      text: `I closed my ${r.symbol} ${r.side || ""} trade: ${score}${minutes}. It goes in the book either way — a loss is classified against the features it was taken on, so the next decision knows what let me down.`,
      meta: { outcome: r.outcome, rMultiple: Number(r.rMultiple) || 0 },
      key: `result|${r.id || `${r.symbol}|${r.side}|${r.closedAt || ""}`}`,
    });
    if (entry) posted++;
  }
  return posted;
}

module.exports = { post, list, read, rollCall, measured, decision, results, BAR };
