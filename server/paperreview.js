/**
 * The paper review: did the trades the app actually took look like the trades
 * the backtest promised?
 *
 * This is the honest way to compare the two. The backtest promises an
 * expectancy in R; paper trading produces R per closed trade. Same unit, same
 * rules, different world. What matters is not whether paper beat the promise on
 * three trades — it is whether the difference is bigger than the noise the
 * sample size allows for.
 *
 * A review with too few trades says so, and sends nothing. Pretending otherwise
 * is how a lucky week becomes a position size.
 */

const fs = require("fs");
const path = require("path");
const { writeJson } = require("./atomicWrite");

const FILE = path.join(__dirname, "..", "paperreview.json");
const MIN_TRADES_TO_REVIEW = 5;
const MIN_TRADES_TO_JUDGE = 20;

function readState() {
  try {
    const raw = fs.readFileSync(FILE, "utf-8").trim();
    if (!raw) return { lastSentWeek: null };
    const parsed = JSON.parse(raw);
    return { lastSentWeek: parsed.lastSentWeek || null };
  } catch {
    return { lastSentWeek: null };
  }
}

function writeState(state) {
  try {
    writeJson(FILE, state, 2);
  } catch {}
}

function weekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day); // Thursday of this ISO week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function shouldSend(now = new Date()) {
  const state = readState();
  if (state.lastSentWeek === weekKey(now)) return false;
  const day = now.getUTCDay(); // 1 = Monday
  if (day !== 1) return false;
  return now.getUTCHours() >= 8;
}

function markSent(now = new Date()) {
  writeState({ lastSentWeek: weekKey(now) });
}

/** R per trade, from money risked at entry — the backtest's own unit. */
function rOf(trade) {
  const risk = Number(trade.riskMoney);
  const pnl = Number(trade.pnl);
  if (!(risk > 0) || !Number.isFinite(pnl)) return null;
  return pnl / risk;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdev(values) {
  const n = values.length;
  if (n < 2) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / (n - 1));
}

function round(v, places = 2) {
  return v == null ? null : Number(v.toFixed(places));
}

/**
 * Group the closed paper trades by market and pair each group with the promise
 * the brain made for it.
 */
function buildComparison({ exec, brain }) {
  const closed = (exec && exec.closed) || [];
  const promises = new Map();
  for (const row of (brain && brain.conditions) || []) {
    if (row.champion) promises.set(row.symbol, row.champion);
  }

  const byMarket = new Map();
  for (const trade of closed) {
    const r = rOf(trade);
    if (r == null) continue;
    if (!byMarket.has(trade.symbol)) byMarket.set(trade.symbol, []);
    byMarket.get(trade.symbol).push({ r, outcome: trade.outcome, trade });
  }

  const rows = [];
  for (const [symbol, trades] of byMarket) {
    const rs = trades.map((t) => t.r);
    const n = rs.length;
    const wins = trades.filter((t) => t.outcome === "win").length;
    const paperExpectancy = mean(rs);
    const sd = stdev(rs);
    const se = sd != null ? sd / Math.sqrt(n) : null;
    const promise = promises.get(symbol) || null;

    // How far the paper result is from the promise, in standard errors.
    let gapInSe = null;
    let verdict;
    if (!promise) {
      verdict = "no rule is proven for this market";
    } else if (n < MIN_TRADES_TO_JUDGE) {
      verdict = "too few trades to judge";
    } else if (se == null || se === 0) {
      verdict = "no variation in the results yet";
    } else {
      gapInSe = (paperExpectancy - promise.expectancy) / se;
      verdict =
        Math.abs(gapInSe) < 2
          ? "in line with the backtest"
          : gapInSe > 0
            ? "better than the backtest promised"
            : "worse than the backtest promised";
    }

    rows.push({
      symbol,
      n,
      wins,
      winrate: round((wins / n) * 100, 1),
      paperExpectancy: round(paperExpectancy, 3),
      standardError: round(se, 3),
      promisedExpectancy: promise ? promise.expectancy : null,
      promisedWinrate: promise ? promise.winrate : null,
      promisedFamily: promise ? promise.familyName || promise.family : null,
      promisedT: promise ? promise.tStat : null,
      gapInSe: round(gapInSe, 2),
      verdict,
      totalR: round(rs.reduce((a, b) => a + b, 0), 2),
    });
  }

  return rows.sort((a, b) => b.n - a.n);
}

/** Fill quality: how far the paper entry sat from the signal's own price. */
function fillQuality({ exec }) {
  const closed = (exec && exec.closed) || [];
  const gaps = [];
  for (const trade of closed) {
    const signalPrice = Number(trade.signalEntry);
    const fill = Number(trade.entry);
    if (!(signalPrice > 0) || !Number.isFinite(fill)) continue;
    gaps.push(Math.abs(fill - signalPrice) / signalPrice);
  }
  if (!gaps.length) return null;
  return {
    samples: gaps.length,
    avgPct: round(mean(gaps) * 100, 4),
    worstPct: round(Math.max(...gaps) * 100, 4),
  };
}

/**
 * The verdict in one sentence, for someone who does not want to read standard
 * errors. It never softens a negative result and never celebrates a small one.
 */
function plainReading(rows) {
  const judged = rows.filter((r) => r.n >= MIN_TRADES_TO_JUDGE);
  const worse = judged.filter((r) => r.verdict === "worse than the backtest promised").map((r) => r.symbol);
  const better = judged.filter((r) => r.verdict === "better than the backtest promised").map((r) => r.symbol);
  const inLine = judged.filter((r) => ["in line with the backtest", "no variation in the results yet"].includes(r.verdict)).map((r) => r.symbol);

  if (!judged.length) {
    return "**Read plainly:** too early to say. Nothing here yet contradicts the backtest, and nothing confirms it either — the sample is still small.";
  }
  if (worse.length && !better.length) {
    return `**Read plainly:** the backtest looks optimistic. On ${worse.join(" and ")}, paper is landing clearly below what the test promised by more than the sample noise allows. I would not trust those numbers forward.`;
  }
  if (better.length && !worse.length) {
    return `**Read plainly:** the backtest is holding up — and looks conservative. On ${better.join(" and ")}, paper came in above the promise, which is as likely to be a kind stretch of luck as a true edge.`;
  }
  if (inLine.length && !worse.length) {
    return `**Read plainly:** the backtest is holding up. On ${inLine.join(" and ")}, paper results sit within normal noise of what the test promised — which is all a backtest can be asked to do.`;
  }
  if (worse.length && inLine.length) {
    return `**Read plainly:** the backtest looks optimistic on ${worse.join(" and ")}, where paper is clearly below the promise, and holds up on ${inLine.join(" and ")}. I would not trust the ${worse.join(" and ")} numbers forward.`;
  }
  if (worse.length && better.length) {
    return `**Read plainly:** mixed. Better than promised on ${better.join(" and ")}, worse on ${worse.join(" and ")}. One of those is pure luck; the next few weeks will say which.`;
  }
  return "**Read plainly:** not enough judged markets yet to call it either way.";
}

function buildReview({ exec, brain, now = new Date() }) {
  const rows = buildComparison({ exec, brain });
  const totalTrades = rows.reduce((a, r) => a + r.n, 0);
  const allRs = [];
  for (const row of rows) {
    // Reconstruct an aggregate without re-reading the closed list.
    if (row.n && row.paperExpectancy != null) allRs.push(row.paperExpectancy * row.n);
  }
  const overallR = totalTrades ? allRs.reduce((a, b) => a + b, 0) / totalTrades : null;

  if (totalTrades < MIN_TRADES_TO_REVIEW) {
    return {
      ready: false,
      totalTrades,
      need: MIN_TRADES_TO_REVIEW,
      rows,
      text:
        totalTrades === 0
          ? "Paper review: nothing has closed yet, so there is nothing to compare."
          : `Paper review: ${totalTrades} closed trade${totalTrades === 1 ? "" : "s"} — not enough to compare with the backtest yet (${MIN_TRADES_TO_REVIEW} needed).`,
    };
  }

  const lines = [];
  lines.push(`**Zone Watch · paper review · ${weekKey(now)}**`);
  lines.push(
    `${totalTrades} closed paper trade${totalTrades === 1 ? "" : "s"}, ${overallR > 0 ? "+" : ""}${overallR.toFixed(2)}R each on average.`
  );

  for (const row of rows) {
    const promise =
      row.promisedExpectancy != null
        ? `${row.promisedFamily}: promised ${row.promisedExpectancy > 0 ? "+" : ""}${row.promisedExpectancy}R`
        : "no proven rule";
    lines.push(
      `**${row.symbol}** — ${row.n} trades, ${row.winrate}% won, ${row.paperExpectancy > 0 ? "+" : ""}${row.paperExpectancy}R each (±${row.standardError}) vs ${promise}. ${row.verdict.charAt(0).toUpperCase() + row.verdict.slice(1)}.`
    );
  }

  const fill = fillQuality({ exec });
  if (fill) {
    lines.push(
      `Fill quality: entry averaged ${fill.avgPct}% away from the signal price (worst ${fill.worstPct}%), across ${fill.samples} trades.`
    );
  }

  lines.push(plainReading(rows));

  const unjudged = rows.filter((r) => r.n < MIN_TRADES_TO_JUDGE).length;
  if (unjudged) {
    lines.push(`_${unjudged} market${unjudged === 1 ? " has" : "s have"} fewer than ${MIN_TRADES_TO_JUDGE} trades — the verdicts above are provisional._`);
  }

  return { ready: true, totalTrades, rows, overallR: round(overallR, 3), fill, text: lines.join("\n") };
}

module.exports = { buildReview, buildComparison, fillQuality, shouldSend, markSent, weekKey, MIN_TRADES_TO_REVIEW, MIN_TRADES_TO_JUDGE };
