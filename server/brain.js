/**
 * The brain: which strategy works, in which market condition, on which market.
 *
 * It answers one question per cell of that grid: of the plain rules in
 * strategies.js, has any of them actually made money in this market while the
 * market was in this condition — on hours the rule was not allowed to look at
 * while deciding?
 *
 * How the honesty is enforced:
 *  - the rules are fixed, never tuned per market;
 *  - the history is cut into three consecutive blocks and every number comes
 *    from those blocks, not from a fit;
 *  - a cell only becomes "works" if it has 20+ closed trades, positive average
 *    R, a t-statistic of at least 1.5, AND a positive result in at least two of
 *    the three blocks. That last one is what stops a single lucky run from
 *    being promoted to a strategy.
 *
 * Everything else is reported as "no proven strategy", which is a useful
 * answer: it tells you to trade that condition with your own eyes instead of
 * trusting the app.
 */

const fs = require("fs");
const path = require("path");

const candlesMod = require("./candles");
const regime = require("./regime");
const { FAMILIES, runFamily } = require("./strategies");

const FILE = path.join(__dirname, "..", "brain.json");

const FOLDS = 3;
const MIN_TRADES = 20;
const MIN_EXPECTANCY = 0.05;
const MIN_TSTAT = 1.5;
const MIN_GOOD_FOLDS = 2;
const RUN_GAP_MS = 30 * 60 * 1000;
const TTL_MS = 24 * 60 * 60 * 1000;

const state = { running: false, lastRunAt: 0, lastSymbol: null, error: null };

function readBrain() {
  try {
    const raw = fs.readFileSync(FILE, "utf-8").trim();
    if (!raw) return { results: {}, updatedAt: null };
    const parsed = JSON.parse(raw);
    const results = parsed.results || {};

    // A stored verdict may only ever cite a rule that still exists. If a
    // strategy was removed, its old proof goes with it rather than silently
    // backing a live alert.
    const known = new Set(FAMILIES.map((f) => f.id));
    for (const [symbol, result] of Object.entries(results)) {
      if (!result || typeof result !== "object") continue;
      if (result.cells) {
        for (const key of Object.keys(result.cells)) {
          const family = String(key).split("|")[1];
          if (!known.has(family)) delete result.cells[key];
        }
      }
      if (result.champions) {
        const stale = Object.values(result.champions).some(
          (champion) => champion && !known.has(champion.family)
        );
        // Its verdict rested on a removed rule, so throw the whole result away
        // and let the next run re-measure it — do not leave a market silently
        // blocked on the strength of a strategy that no longer exists.
        if (stale) {
          delete results[symbol];
          continue;
        }
      }
    }

    return { results, updatedAt: parsed.updatedAt || null };
  } catch {
    return { results: {}, updatedAt: null };
  }
}

function writeBrain(brain) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(brain, null, 2), "utf-8");
  } catch (err) {
    state.error = err.message;
  }
}

function tStat(values) {
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  if (!sd) return null;
  return Number((mean / (sd / Math.sqrt(n))).toFixed(2));
}

function summarise(rs) {
  const n = rs.length;
  if (!n) return { n: 0, winrate: null, expectancy: null, tStat: null, totalR: 0 };
  const wins = rs.filter((r) => r > 0).length;
  const totalR = rs.reduce((a, b) => a + b, 0);
  return {
    n,
    winrate: Number(((wins / n) * 100).toFixed(1)),
    expectancy: Number((totalR / n).toFixed(3)),
    tStat: tStat(rs),
    totalR: Number(totalR.toFixed(2)),
  };
}

/**
 * Test every family on one market, grouped by the condition at entry.
 */
async function evaluateMarket(symbol, candleSymbol, opts = {}) {
  const bars = await candlesMod.getCandles(candleSymbol, "1h", "1y");
  if (!bars || bars.length < 900) throw new Error("not enough history");

  const ctx = regime.analyze(bars);
  const foldSize = Math.floor(bars.length / FOLDS);
  const folds = [];
  for (let k = 0; k < FOLDS; k++) {
    folds.push([k * foldSize, k === FOLDS - 1 ? bars.length : (k + 1) * foldSize]);
  }

  const cells = {};

  for (const family of FAMILIES) {
    const byCondition = {};
    const foldSigns = {};

    for (const [from, to] of folds) {
      const trades = runFamily(family, bars, ctx, from, to, opts);
      for (const t of trades) {
        if (!byCondition[t.condition]) byCondition[t.condition] = [];
        byCondition[t.condition].push(t.r);

        if (!foldSigns[t.condition]) foldSigns[t.condition] = [];
        foldSigns[t.condition].push(t.r);
      }
    }

    // Per-fold totals, to check the result is not one lucky block.
    const foldTotals = {};
    for (const condition of Object.keys(byCondition)) {
      foldTotals[condition] = folds.map(([from, to]) => {
        const trades = runFamily(family, bars, ctx, from, to, opts).filter((t) => t.condition === condition);
        return Number(trades.reduce((a, t) => a + t.r, 0).toFixed(2));
      });
    }

    for (const [condition, rs] of Object.entries(byCondition)) {
      const stats = summarise(rs);
      const goodFolds = (foldTotals[condition] || []).filter((v) => v > 0).length;
      const proven =
        stats.n >= MIN_TRADES &&
        stats.expectancy != null &&
        stats.expectancy >= MIN_EXPECTANCY &&
        stats.tStat != null &&
        stats.tStat >= MIN_TSTAT &&
        goodFolds >= MIN_GOOD_FOLDS;

      cells[`${condition}|${family.id}`] = {
        condition,
        family: family.id,
        familyName: family.name,
        ...stats,
        goodFolds,
        foldTotals: foldTotals[condition] || [],
        proven,
        notes: family.worksIn.includes(condition) ? "" : "outside this rule's intended condition",
      };
    }
  }

  // Best proven family per condition.
  const champions = {};
  const conditions = [...new Set(Object.values(cells).map((c) => c.condition))];
  for (const condition of conditions) {
    const candidates = Object.values(cells)
      .filter((c) => c.condition === condition && c.proven)
      .sort((a, b) => (b.expectancy || 0) - (a.expectancy || 0));
    champions[condition] = candidates[0] || null;
  }

  return {
    symbol,
    at: new Date().toISOString(),
    bars: bars.length,
    current: ctx.current,
    champions,
    cells,
    grid: Object.fromEntries(
      conditions.map((c) => [
        c,
        FAMILIES.map((f) => {
          const cell = cells[`${c}|${f.id}`];
          return cell ? { family: f.id, n: cell.n, expectancy: cell.expectancy, proven: cell.proven } : null;
        }).filter(Boolean),
      ])
    ),
  };
}

async function runFor(symbol, candleSymbol) {
  state.running = true;
  state.lastSymbol = symbol;
  try {
    const result = await evaluateMarket(symbol, candleSymbol);
    const brain = readBrain();
    brain.results[symbol] = result;
    brain.updatedAt = new Date().toISOString();
    writeBrain(brain);
    state.error = null;
    return result;
  } catch (err) {
    state.error = `${symbol}: ${err.message}`;
    return null;
  } finally {
    state.running = false;
    state.lastRunAt = Date.now();
  }
}

/** One stale market per RUN_GAP_MS, like the lab. */
async function maybeRun(instruments = []) {
  if (state.running) return;
  if (Date.now() - state.lastRunAt < RUN_GAP_MS) return;

  const brain = readBrain();
  const stale = instruments.find((inst) => {
    const r = brain.results[inst.symbol];
    if (!r) return true;
    return Date.now() - new Date(r.at).getTime() > TTL_MS;
  });
  if (!stale) return;

  await runFor(stale.symbol, stale.candleSymbol);
}

/**
 * The condition right now, read fresh from candles when possible so a market
 * that changed character after the last full test is not gated on old news.
 */
async function currentCondition(symbol, candleSymbol) {
  try {
    const bars = await candlesMod.getCandles(candleSymbol, "1h", "1y");
    const ctx = regime.analyze(bars);
    if (ctx.current.label) {
      return { condition: ctx.current.label, fresh: true, asOf: ctx.current.asOf };
    }
  } catch {
    // fall through to the stored reading
  }
  const stored = readBrain().results[symbol];
  if (stored && stored.current) {
    return { condition: stored.current.label || "unclear", fresh: false, asOf: stored.current.asOf };
  }
  return { condition: "unclear", fresh: false, asOf: null };
}

/**
 * Should a trade signal for this market be allowed out?
 *
 * The rule: yes only if some strategy has been measured to make money in this
 * market, in the condition it is in right now. No proves nothing, so it says
 * no — and says exactly why, so the dashboard can show what was withheld.
 */
async function gate(symbol, candleSymbol) {
  const brain = readBrain();
  const result = brain.results[symbol];
  const now = await currentCondition(symbol, candleSymbol);
  const condition = now.condition;

  if (!result) {
    return {
      allowed: false,
      condition,
      fresh: now.fresh,
      reason: `${symbol} has not been tested yet, so nothing is proven for it`,
      untested: true,
    };
  }

  const champion = result.champions ? result.champions[condition] : null;
  if (!champion) {
    return {
      allowed: false,
      condition,
      fresh: now.fresh,
      reason: `no rule is proven for ${symbol} in a ${condition} market`,
      untested: false,
    };
  }

  return {
    allowed: true,
    condition,
    fresh: now.fresh,
    champion: {
      family: champion.family,
      name: champion.familyName,
      n: champion.n,
      expectancy: champion.expectancy,
      tStat: champion.tStat,
      outsideUsualCondition: Boolean(champion.notes),
    },
    reason: `${champion.familyName} is proven here: ${champion.n} trades, ${champion.expectancy}R each, t=${champion.tStat}`,
  };
}

function summary() {
  const brain = readBrain();
  const rows = Object.entries(brain.results).map(([symbol, r]) => {
    const condition = r.current ? r.current.label : "unclear";
    const champion = r.champions ? r.champions[condition] : null;
    return {
      symbol,
      at: r.at,
      condition,
      efficiency: r.current ? r.current.efficiency : null,
      volatilityPercentile: r.current ? r.current.volatilityPercentile : null,
      champion: champion
        ? {
            family: champion.family,
            name: champion.familyName,
            n: champion.n,
            expectancy: champion.expectancy,
            winrate: champion.winrate,
            tStat: champion.tStat,
            goodFolds: champion.goodFolds,
            outsideUsualCondition: Boolean(champion.notes),
          }
        : null,
    };
  });

  return {
    updatedAt: brain.updatedAt,
    running: state.running,
    lastRunAt: state.lastRunAt ? new Date(state.lastRunAt).toISOString() : null,
    lastSymbol: state.lastSymbol,
    error: state.error,
    conditions: rows,
  };
}

module.exports = {
  maybeRun,
  gate,
  currentCondition,
  runFor,
  summary,
  evaluateMarket,
  MIN_TRADES,
  MIN_EXPECTANCY,
  MIN_TSTAT,
};
