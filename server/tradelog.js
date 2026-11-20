/**
 * Trade-log review, in JavaScript.
 *
 * This used to shell out to analyze.py. That cannot work where the app is
 * hosted: the runtime image is node:22-slim, which has no python3, and the code
 * directory is read-only once a volume is mounted, so even writing the temp
 * file the script was handed failed with EACCES. The output below is the same
 * report analyze.py printed, computed here so the Journal tab's Analyze button
 * works on the host that actually runs the dashboard.
 *
 * Input: a JSON array of trades (see example_trades.json).
 */

function safeFloat(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string") {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function money(n) {
  const sign = n < 0 ? "-" : "";
  const [whole, cents] = Math.abs(n).toFixed(2).split(".");
  return `${sign}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

function percent(x) {
  return `${(x * 100).toFixed(1)}%`;
}

/** Parse a log into trades, deriving R from risk_usd or the entry-to-stop distance. */
function loadTrades(raw) {
  if (!Array.isArray(raw)) throw new Error("Expected a JSON array of trades.");
  return raw.map((row) => {
    const data = row && typeof row === "object" ? row : {};
    const pnl = safeFloat(data.pnl_usd);
    const risk = safeFloat(data.risk_usd);
    const entry = safeFloat(data.entry_price);
    const stop = safeFloat(data.stop_price);
    let r = null;
    if (risk > 0) r = pnl / risk;
    else if (entry && stop && entry !== stop) {
      const distance = Math.abs(entry - stop);
      if (distance) r = pnl / distance;
    }
    return { data, pnl, profitable: pnl > 0, r };
  });
}

function computeSummary(trades) {
  if (!trades.length) {
    return {
      totalTrades: 0, wins: 0, losses: 0, breakeven: 0, avgPnl: 0, avgR: 0,
      winRate: 0, expectancyUsd: 0, expectancyR: 0, profitFactor: 0,
      biggestWin: 0, biggestLoss: 0, avgWin: 0, avgLoss: 0, totalPnl: 0,
    };
  }
  const pnls = trades.map((t) => t.pnl);
  const rs = trades.filter((t) => t.r !== null).map((t) => t.r);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const winRs = rs.filter((r) => r > 0);
  const lossRs = rs.filter((r) => r < 0);

  const winRateR = rs.length ? winRs.length / rs.length : 0;
  const lossRateR = rs.length ? lossRs.length / rs.length : 0;
  const avgWinR = winRs.length ? mean(winRs) : 0;
  const avgLossR = lossRs.length ? mean(lossRs) : 0;

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: pnls.filter((p) => p === 0).length,
    avgPnl: mean(pnls),
    avgR: rs.length ? mean(rs) : 0,
    winRate: wins.length / trades.length,
    expectancyUsd: mean(pnls),
    expectancyR: winRateR * avgWinR - lossRateR * Math.abs(avgLossR),
    profitFactor: losses.length ? wins.reduce((a, b) => a + b, 0) / Math.abs(losses.reduce((a, b) => a + b, 0)) : Infinity,
    biggestWin: wins.length ? Math.max(...wins) : 0,
    biggestLoss: losses.length ? Math.min(...losses) : 0,
    avgWin: wins.length ? mean(wins) : 0,
    avgLoss: losses.length ? mean(losses) : 0,
    totalPnl: pnls.reduce((a, b) => a + b, 0),
  };
}

function keyOf(trade, field) {
  const value = trade.data[field];
  if (!value) return "unknown";
  return String(value);
}

function groupBy(trades, field) {
  const groups = new Map();
  for (const t of trades) {
    const key = keyOf(t, field);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return groups;
}

function breakdowns(trades) {
  const out = {};
  for (const field of ["instrument", "setup", "session"]) {
    out[field] = {};
    for (const [key, group] of groupBy(trades, field)) {
      out[field][key] = computeSummary(group);
    }
  }
  return out;
}

function recurringMistakes(trades) {
  const notes = [];
  if (!trades.length) return notes;

  let streak = 0;
  for (const t of trades) {
    if (t.pnl < 0) {
      streak += 1;
      if (streak >= 2) {
        notes.push(`Back-to-back losses around ${t.data.date ?? ""} ${t.data.time ?? ""}`.trim());
      }
    } else {
      streak = 0;
    }
  }

  const riskBySetup = groupBy(trades, "setup");
  if (riskBySetup.size) {
    let worst = null;
    for (const [key, group] of riskBySetup) {
      const avg = mean(group.map((t) => safeFloat(t.data.risk_usd)));
      if (!worst || avg > worst.avg) worst = { key, avg };
    }
    notes.push(`Highest average risk per trade came from '${worst.key}'`);
  }

  const exits = groupBy(trades, "exit_reason");
  if (exits.size) {
    let worst = null;
    for (const [key, group] of exits) {
      const avg = mean(group.map((t) => safeFloat(t.data.pnl_usd)));
      if (!worst || avg < worst.avg) worst = { key, avg };
    }
    notes.push(`Worst average result by exit reason: '${worst.key}'`);
  }

  const stopped = trades.filter((t) => keyOf(t, "exit_reason") === "stop" && t.pnl < 0);
  if (stopped.length) {
    notes.push(`${stopped.length} stopped trades. Review whether stops were placed at real invalidation points.`);
  }

  const bySession = groupBy(trades, "session");
  if (bySession.size) {
    let weakest = null;
    for (const [key, group] of bySession) {
      const total = group.reduce((a, t) => a + t.pnl, 0);
      if (!weakest || total < weakest.total) weakest = { key, total };
    }
    notes.push(`Weakest session by total P&L: '${weakest.key}'. Consider rules for when you sit out.`);
  }

  return notes;
}

function printSummary(label, s) {
  const lines = [
    "",
    "========================================",
    "         TRADE REVIEW SUMMARY",
    "========================================",
    "",
    `Log file: ${label}`,
    `Total trades: ${s.totalTrades}`,
    `Wins / Losses / Breakeven: ${s.wins} / ${s.losses} / ${s.breakeven}`,
    `Win rate: ${percent(s.winRate)}`,
    `Total P&L: ${money(s.totalPnl)}`,
    `Average P&L per trade: ${money(s.avgPnl)}`,
    `Biggest win: ${money(s.biggestWin)}`,
    `Biggest loss: ${money(s.biggestLoss)}`,
    `Average win: ${money(s.avgWin)}`,
    `Average loss: ${money(s.avgLoss)}`,
    `Average R per trade: ${s.avgR.toFixed(2)}R`,
    `Expectancy per trade: ${s.expectancyR.toFixed(2)}R (${money(s.expectancyUsd)})`,
    `Profit factor: ${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : "inf"}`,
    "",
  ];
  return lines.join("\n");
}

function printBreakdowns(title, items) {
  const lines = [`--- By ${title} ---`];
  if (!Object.keys(items).length) {
    lines.push("  (no data)");
  } else {
    for (const label of Object.keys(items).sort()) {
      const s = items[label];
      lines.push(`  ${label}`);
      lines.push(`    trades: ${s.totalTrades}, win rate: ${percent(s.winRate)}, total P&L: ${money(s.totalPnl)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * The full report for a trade log.
 *
 * `label` is what the header prints: the file name, or "pasted log" when the
 * text came straight from the textarea and was never written to disk.
 */
function review(raw, label = "trades.json") {
  const trades = loadTrades(raw);
  const parts = [printSummary(label, computeSummary(trades))];
  const bd = breakdowns(trades);
  for (const field of ["instrument", "setup", "session"]) {
    parts.push(printBreakdowns(field, bd[field]));
  }
  const notes = recurringMistakes(trades);
  parts.push("--- Recurring notes / mistakes ---");
  parts.push(notes.length ? notes.map((n) => `  - ${n}`).join("\n") : "  (no clear recurring patterns yet)");
  parts.push("");
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = { review, loadTrades, computeSummary };
