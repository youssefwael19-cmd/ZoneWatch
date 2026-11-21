/**
 * The journal: what every alert looked like when it was sent, and how it ended.
 *
 * Meta-AI's advice was right about one thing above all: "that trade lost" is
 * useless data. The useful record is what the market looked like at the moment
 * of the decision, plus *why* it failed afterwards.
 *
 * So every signal — posted or held back — is written down with the features
 * the decision was made from: the higher-timeframe trend, the daily bias, the
 * zone's type and freshness, the session, the volatility condition, whether
 * news was near. When the trade closes, the reason it failed is classified
 * against exactly those features.
 *
 * What this is NOT: a machine-learning model. With a handful of closed trades
 * any model would memorise noise and look brilliant until it met new data.
 * This is the raw material a model would need, written down honestly from day
 * one, and readable as plain statistics until there is enough of it.
 */

const fs = require("fs");
const path = require("path");
const { writeJson } = require("./atomicWrite");

const FILE = require("./stateDir").file("journal.json");
const MAX_ENTRIES = 3000;

function readJournal() {
  try {
    const raw = fs.readFileSync(FILE, "utf-8").trim();
    if (!raw) return { entries: [] };
    const parsed = JSON.parse(raw);
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return { entries: [] };
  }
}

function writeJournal(journal) {
  try {
    const entries = journal.entries.slice(-MAX_ENTRIES);
    writeJson(FILE, { entries }, 1);
  } catch {
    // A failed journal write must never stop an alert from going out.
  }
}

/** The share of the risk budget a signal asked for. No multiplier means full. */
function riskMultiplierOf(signal) {
  const n = Number(signal && signal.riskMultiplier);
  return n > 0 && n <= 1 ? n : 1;
}

function entryId(signal) {
  const zone = signal.zone || {};
  return [signal.symbol, signal.side, zone.low, zone.high, signal.at].join("|");
}

/**
 * Write down an alert at the moment of the decision.
 * @param {object} signal  the signal object
 * @param {object} extras  { status: "sent"|"held", heldReason, regime, atrPercentile, newsNear }
 */
function record(signal, extras = {}) {
  const journal = readJournal();
  const id = entryId(signal);
  if (journal.entries.some((e) => e.id === id && e.status === extras.status)) return null;

  const checks = (signal.confluence && signal.confluence.checks) || [];
  const side = signal.side;
  const htf = signal.htfTrend || null;
  const bias = signal.dailyBias || null;

  const entry = {
    id,
    at: signal.at || new Date().toISOString(),
    symbol: signal.symbol,
    side,
    setup: signal.confidence || "standard",
    status: extras.status || "sent",
    heldReason: extras.heldReason || null,
    entry: signal.entry ?? signal.price ?? null,
    stop: signal.stop ?? null,
    target: signal.target ?? null,
    features: {
      zoneType: (signal.zone && signal.zone.type) || null,
      zoneTouches: Number.isFinite(signal.zone && signal.zone.touches) ? signal.zone.touches : null,
      zoneStrength: Number.isFinite(signal.zone && signal.zone.strength) ? signal.zone.strength : null,
      htfTrend: htf,
      htfAgrees: htf ? (side === "BUY" ? htf === "up" : htf === "down") : null,
      dailyBias: bias,
      dailyAgrees: bias ? (side === "BUY" ? bias === "up" : bias === "down") : null,
      session: checks.find((c) => c.name === "session")?.ok === true ? "london-or-ny" : "off-session",
      volatilityExpanded: checks.find((c) => c.name === "volatility")?.ok ?? null,
      confluenceScore: signal.confluence ? signal.confluence.score : null,
      confluenceTotal: signal.confluence ? signal.confluence.total : null,
      // A trade the app cut in half because its proof came from the
      // neighbouring condition is not the same bet as a full-size one. It is
      // recorded so the two can be scored apart instead of blending into one
      // number that describes neither.
      riskMultiplier: riskMultiplierOf(signal),
      provenCondition: (signal.adjacentProof && signal.adjacentProof.provenIn) || null,
      regime: extras.regime || null,
      atrPercentile: Number.isFinite(extras.atrPercentile) ? extras.atrPercentile : null,
      newsNear: Boolean(extras.newsNear),
    },
    outcome: null,
    rMultiple: null,
    failureReason: null,
    closedAt: null,
  };

  journal.entries.push(entry);
  writeJournal(journal);
  return entry;
}

/**
 * Why did it fail?
 *
 * The order matters: cause before symptom. News is nobody's fault and should
 * never be counted against the setup. Trading against the daily trend is the
 * one the app most wants to see, because it is entirely avoidable.
 */
function classifyFailure(resolved) {
  const features = resolved.features || {};
  if (features.newsNear) return "news_spike";
  if (features.dailyAgrees === false) return "against_daily_bias";
  if (features.htfAgrees === false) return "against_1h_trend";
  if (Number(features.zoneTouches) >= 2) return "zone_already_tested";
  if (features.session === "off-session") return "off_session";
  return "clean_stop";
}

/**
 * Attach the result to its journal entry. Called when a tracked signal closes.
 * Ids match the tracker's, so no lookup table is needed.
 */
function resolve(resolvedSignals) {
  const journal = readJournal();
  let changed = 0;

  for (const r of resolvedSignals) {
    const entry = journal.entries.find((e) => e.id === r.id && e.outcome == null);
    if (!entry) continue;
    entry.outcome = r.outcome;
    entry.rMultiple = r.rMultiple;
    entry.closedAt = r.closedAt || new Date().toISOString();
    entry.heldMinutes = r.heldMinutes ?? null;
    entry.failureReason =
      r.outcome === "loss" ? classifyFailure({ features: entry.features }) : null;
    changed++;
  }

  if (changed) writeJournal(journal);
  return changed;
}

function bucket(entries, keyFn) {
  const map = new Map();
  for (const e of entries) {
    const key = keyFn(e);
    if (key == null) continue;
    const row = map.get(key) || { label: key, n: 0, wins: 0, totalR: 0 };
    row.n++;
    if (e.outcome === "win") row.wins++;
    row.totalR += Number(e.rMultiple) || 0;
    map.set(key, row);
  }
  return [...map.values()]
    .filter((r) => r.n > 0)
    .map((r) => ({
      label: r.label,
      n: r.n,
      winrate: Number(((r.wins / r.n) * 100).toFixed(1)),
      expectancy: Number((r.totalR / r.n).toFixed(2)),
    }))
    .sort((a, b) => b.n - a.n);
}

/**
 * Plain statistics, not a model: does the app do better when the daily bias
 * agrees, when the zone is fresh, in session, and so on. Every row carries its
 * own sample size so a two-trade "100% win rate" can be read as what it is.
 */
function summary() {
  const { entries } = readJournal();
  const sent = entries.filter((e) => e.status !== "held");
  // Break-even is a closed trade, not a win: it belongs in the sample (it is a
  // real 0R outcome) and out of the win count, so neither the win rate nor the
  // expectancy is flattered by stops trailed back to entry.
  const closed = sent.filter(
    (e) => e.outcome === "win" || e.outcome === "loss" || e.outcome === "breakeven"
  );
  const wins = closed.filter((e) => e.outcome === "win").length;

  const failureCounts = new Map();
  for (const e of closed) {
    if (e.outcome !== "loss") continue;
    const key = e.failureReason || "unclassified";
    failureCounts.set(key, (failureCounts.get(key) || 0) + 1);
  }

  return {
    logged: entries.length,
    sent: sent.length,
    held: entries.length - sent.length,
    closed: closed.length,
    open: sent.filter((e) => e.outcome == null).length,
    wins,
    losses: closed.filter((e) => e.outcome === "loss").length,
    breakeven: closed.filter((e) => e.outcome === "breakeven").length,
    winrate: closed.length ? Number(((wins / closed.length) * 100).toFixed(1)) : null,
    expectancy: closed.length
      ? Number((closed.reduce((a, e) => a + (Number(e.rMultiple) || 0), 0) / closed.length).toFixed(2))
      : null,
    failureReasons: [...failureCounts.entries()]
      .map(([reason, n]) => ({ reason, n }))
      .sort((a, b) => b.n - a.n),
    byDailyBiasAgreement: bucket(closed, (e) =>
      e.features.dailyAgrees === true ? "daily bias agrees" : e.features.dailyAgrees === false ? "daily bias against" : null
    ),
    byHtfAgreement: bucket(closed, (e) =>
      e.features.htfAgrees === true ? "1h trend agrees" : e.features.htfAgrees === false ? "1h trend against" : null
    ),
    byZoneFreshness: bucket(closed, (e) => {
      const t = e.features.zoneTouches;
      if (!Number.isFinite(t)) return null;
      return t <= 1 ? "fresh zone (0-1 touches)" : "tested zone (2+)";
    }),
    bySession: bucket(closed, (e) => e.features.session),
    // Is the score the app puts on a setup real? Compare the confluence it
    // counted with what actually happened. No model, no recalibration — just
    // the honest pairing of stated quality and result.
    byConfluence: bucket(closed, (e) => {
      const score = e.features.confluenceScore;
      const total = e.features.confluenceTotal;
      if (!Number.isFinite(score) || !Number.isFinite(total) || !total) return null;
      return score >= 4 ? "4-5 of 5 checks" : score === 3 ? "3 of 5 checks" : "0-2 of 5 checks";
    }),
    byCondition: bucket(closed, (e) => e.features.regime),
    // Did the half-size trades behave like half-size trades should? Entries
    // logged before the multiplier existed were full size, hence the default.
    bySize: bucket(closed, (e) =>
      Number(e.features.riskMultiplier) > 0 && Number(e.features.riskMultiplier) < 1
        ? "half size (proof from the next-door condition)"
        : "full size"
    ),
    byMarket: bucket(closed, (e) => e.symbol),
    recent: [...entries].slice(-8).reverse(),
    note:
      "Every count here is a live record of what the app actually sent. Nothing is simulated, and small samples say nothing — read the n column first.",
  };
}

module.exports = { record, resolve, summary, classifyFailure, readJournal };
