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
const { writeJson } = require("./atomicWrite");

const candlesMod = require("./candles");
const regime = require("./regime");
const settings = require("./settings");
const costsMod = require("./costs");
const market = require("./market");
const sessions = require("./sessions");
const { FAMILIES, runFamily, RULES_VERSION } = require("./strategies");
const labMod = require("./lab");

const FILE = require("./stateDir").file("brain.json");

const FOLDS = 3;

/*
 * The proof bar.
 *
 * The library is twelve rules wide and every one is measured in all four
 * conditions, so a single market now tests ~48 cells at once. At that width a
 * t-statistic of 1.5 is not evidence: across the app's 525 measured cells, 34
 * clear t=1.5 — roughly 8.5 of them per condition slot would pass on luck
 * alone. That is how a market ends up "proven" on a strategy that simply got
 * the coin to land its way.
 *
 * Tightened accordingly:
 *  - 30+ unseen trades, so a run of three winners cannot carry a cell;
 *  - 0.10R per trade, so a marginal market is not called a champion;
 *  - t >= 2.5, which only 5 of the 525 cells clear — about one per condition
 *    slot would be expected by chance rather than eight;
 *  - positive in ALL THREE unseen blocks, not two. Best-of-48 selection is the
 *    thing being defended against, and fold agreement is the cheapest honest
 *    check that the result is not one lucky block.
 *
 * This is deliberately uncomfortable: on the current data it takes the number
 * of champions from 17 to 2. Fewer, real ones is the point. A market with no
 * champion does not trade, and that is a correct answer, not a gap.
 */
const MIN_TRADES = 30;
const MIN_EXPECTANCY = 0.1;
const MIN_TSTAT = 2.5;
const MIN_GOOD_FOLDS = FOLDS;
// Bumped whenever the bar itself changes. Cells store the `proven` flag they
// were judged with, so raising the bar without re-measuring would leave the old
// verdicts standing under a rule that no longer approves them.
// 3: the t-statistic no longer divides by floating-point noise, so a cell of
// identical results can no longer look proven. Verdicts measured under 2 were
// judged by a statistic that could be astronomically large by accident.
// 4: the measurement charges the live cost model — spread, slippage,
// commission — and gap fills at the bar open. Cells stored under 3 hold a
// gross number, so they are not evidence for a net-of-cost bar and are dropped.
const BAR_VERSION = 4;
const RUN_GAP_MS = 30 * 60 * 1000;
// A proof in the condition next door is real evidence, but it is not evidence
// about this condition. It buys a half-size trade, never a full one.
const ADJACENT_MULTIPLE = 0.5;
const TTL_MS = 24 * 60 * 60 * 1000;

const state = {
  running: false,
  lastRunAt: 0,
  lastSymbol: null,
  error: null,
  burst: false,
  // Which inputs this process has already re-measured against, so a rule or
  // feed change can queue those markets again instead of trusting numbers
  // produced by the old ones.
  signature: null,
  tried: new Set(),
  errors: {},
};

/**
 * Every rule the brain tests: the hand-written library plus whatever the lab has
 * put ahead on unseen bars. A lab winner is only ever a *candidate* — it is
 * measured here under the same bar, and its own history earns or denies the
 * proof. Promotions are kept on disk, so a later lab run that stops nominating
 * a config does not take its measured cells away with it.
 *
 * A failure to read that list is tracked: "this rule does not exist" is only a
 * fact when the list could actually be read.
 */
let familiesError = null;

function familiesNow() {
  try {
    const promoted = labMod.families();
    familiesError = null;
    return promoted.length ? [...FAMILIES, ...promoted] : FAMILIES;
  } catch (err) {
    familiesError = err.message;
    state.error = `lab families: ${err.message}`;
    return FAMILIES;
  }
}

/** The file as written, including verdicts this build no longer trusts. */
function readBrainRaw() {
  try {
    const raw = fs.readFileSync(FILE, "utf-8").trim();
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function readBrain() {
  try {
    const parsed = readBrainRaw();
    if (!parsed) return { results: {}, updatedAt: null, invalidatedAt: null, measuredFor: null };

    // A stored verdict from an older rule set is not reproducible, so it is
    // dropped rather than left to gate a live alert on a number nobody can
    // measure again. The markets are then re-tested back to back instead of
    // waiting a day for the ordinary schedule to reach them.
    if (parsed.rulesVersion !== RULES_VERSION || parsed.barVersion !== BAR_VERSION) {
      // The numbers are gone, so the build that produced them is not "already
      // measured" either: the next start marks this build stale.
      return {
        results: {},
        updatedAt: parsed.updatedAt || null,
        invalidatedAt: parsed.invalidatedAt || null,
        measuredFor: null,
      };
    }
    const results = parsed.results || {};

    // A stored verdict may only ever cite a rule that still exists. If a
    // strategy was removed, its old proof goes with it rather than silently
    // backing a live alert. Skipped when the promotion list could not be read:
    // a read failure is not evidence that a rule was removed, and deleting the
    // cells on one would throw away proofs the app earned.
    const known = new Set(familiesNow().map((f) => f.id));
    if (!familiesError) {
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
    }

    return {
      results,
      barVersion: parsed.barVersion || null,
      updatedAt: parsed.updatedAt || null,
      // Kept so the caller can tell an out-of-date measurement from a current
      // one without re-reading the file: a new build is what sets these.
      invalidatedAt: parsed.invalidatedAt || null,
      measuredFor: parsed.measuredFor || null,
    };
  } catch {
    return { results: {}, updatedAt: null };
  }
}

function writeBrain(brain) {
  try {
    brain.rulesVersion = RULES_VERSION;
    brain.barVersion = BAR_VERSION;
    writeJson(FILE, brain, 2);
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
  // Identical results leave floating-point noise in the variance, not an exact
  // zero, so the old guard never fired and a cell of identical trades produced a
  // t-statistic around 1e16 — enough to clear any bar and be called proven. A
  // sample with no spread is not evidence.
  if (!Number.isFinite(sd) || sd <= 1e-9 * Math.max(1, Math.abs(mean))) return null;
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
 * The cost model a backtest charges, per instrument.
 *
 * The spread comes from the app's configured table or a per-symbol override,
 * not from a 15-minute broker snapshot: a one-year measurement should not
 * change because the spread happened to be wide when the watch cycle ran.
 * Slippage is the live model's fraction of that spread, commission is the
 * configured per-lot round turn, and `valuePerUnit` turns it into R.
 */
function costModelFor(symbol) {
  const config = settings.getExecConfig();
  const spread = costsMod.spreadInfo(symbol, config);
  const slippage = costsMod.slippageInfo(symbol, config);
  const instrument = market.instrumentList().find((i) => i.symbol === symbol);
  return {
    spread: Number.isFinite(spread.units) ? Number(spread.units) : 0,
    spreadSource: spread.source,
    slippage: Number.isFinite(slippage.units) ? Number(slippage.units) : 0,
    slippageSource: slippage.source,
    commissionPerLot: costsMod.costConfig(config).commissionPerLot,
    valuePerUnit: instrument ? Number(instrument.valuePerPointPerLot) : 0,
  };
}

/** Does a cell clear the proof bar? The bar itself is unchanged. */
function meetsBar(stats, goodFolds) {
  return (
    stats.n >= MIN_TRADES &&
    stats.expectancy != null &&
    stats.expectancy >= MIN_EXPECTANCY &&
    stats.tStat != null &&
    stats.tStat >= MIN_TSTAT &&
    goodFolds >= MIN_GOOD_FOLDS
  );
}

/**
 * Judge one cell from its trades, both before and after costs.
 *
 * The proof bar is applied to the **net** numbers: a rule that only clears
 * 0.10R before the broker is paid has not cleared it in the account the app
 * trades. The gross figures are kept beside them — same trades, same folds,
 * without the charges — so the report can show what the costs changed and a
 * cell that was proven only gross cannot hide.
 *
 * Exported so the arithmetic can be checked without candles or a brain file.
 */
function gradeCell({ condition, family, familyName, grossRs, netRs, grossFolds, netFolds, notes = "" }) {
  const gross = summarise(grossRs);
  const net = summarise(netRs);
  const grossGoodFolds = grossFolds.filter((v) => v > 0).length;
  const netGoodFolds = netFolds.filter((v) => v > 0).length;
  return {
    condition,
    family,
    familyName,
    ...net,
    goodFolds: netGoodFolds,
    foldTotals: netFolds,
    proven: meetsBar(net, netGoodFolds),
    // What the broker took over the whole sample, in R.
    costR: Number((net.totalR - gross.totalR).toFixed(2)),
    gross: {
      ...gross,
      goodFolds: grossGoodFolds,
      foldTotals: grossFolds,
      proven: meetsBar(gross, grossGoodFolds),
    },
    notes,
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
  const families = familiesNow();
  const costs = costModelFor(symbol);
  const runOpts = { ...opts, costs };

  for (const family of families) {
    const grossByCondition = {};
    const netByCondition = {};
    const grossFolds = {};
    const netFolds = {};

    for (let k = 0; k < folds.length; k++) {
      const [from, to] = folds[k];
      const trades = runFamily(family, bars, ctx, from, to, runOpts);
      for (const t of trades) {
        const condition = t.condition;
        if (!grossByCondition[condition]) {
          grossByCondition[condition] = [];
          netByCondition[condition] = [];
          grossFolds[condition] = folds.map(() => 0);
          netFolds[condition] = folds.map(() => 0);
        }
        grossByCondition[condition].push(t.grossR);
        netByCondition[condition].push(t.r);
        grossFolds[condition][k] += t.grossR;
        netFolds[condition][k] += t.r;
      }
    }

    for (const condition of Object.keys(netByCondition)) {
      cells[`${condition}|${family.id}`] = gradeCell({
        condition,
        family: family.id,
        familyName: family.name,
        grossRs: grossByCondition[condition],
        netRs: netByCondition[condition],
        grossFolds: grossFolds[condition].map((v) => Number(v.toFixed(2))),
        netFolds: netFolds[condition].map((v) => Number(v.toFixed(2))),
        notes: family.worksIn.includes(condition) ? "" : "outside this rule's intended condition",
      });
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
    // The inputs this measurement was taken on. Recorded so a later provider
    // switch or rule-list change can be detected from the file instead of
    // leaving a verdict that describes a feed no longer being used.
    series: entrySeries(candleSymbol),
    families: families.map((f) => f.id),
    costs,
    current: ctx.current,
    champions,
    cells,
    grid: Object.fromEntries(
      conditions.map((c) => [
        c,
        families.map((f) => {
          const cell = cells[`${c}|${f.id}`];
          return cell
            ? {
                family: f.id,
                n: cell.n,
                expectancy: cell.expectancy,
                grossExpectancy: cell.gross ? cell.gross.expectancy : null,
                proven: cell.proven,
              }
            : null;
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
    delete state.errors[symbol];
    return result;
  } catch (err) {
    state.error = `${symbol}: ${err.message}`;
    state.errors[symbol] = err.message;
    return null;
  } finally {
    state.running = false;
    state.lastRunAt = Date.now();
  }
}

/**
 * Is this market's measurement out of date?
 *
 * Two things age a measurement: the clock (TTL_MS) and a new build. A deploy
 * changes the rules the numbers were produced under, so every stored verdict is
 * re-measured rather than trusted; `invalidatedAt` is what marks that moment,
 * so a plain restart of the same build does not repeat the work.
 */
function isStale(result, brain, now = Date.now()) {
  if (!result || !result.at) return true;
  const at = new Date(result.at).getTime();
  if (!Number.isFinite(at)) return true;
  if (now - at > TTL_MS) return true;
  const invalidated = brain && brain.invalidatedAt ? new Date(brain.invalidatedAt).getTime() : NaN;
  return Number.isFinite(invalidated) ? at < invalidated : false;
}

/* ------------------- what a verdict was measured on ------------------- */

/**
 * The hourly series a market's verdict was measured on, recorded with the
 * result. Same shape the lab records, so both readouts name a feed the same
 * way.
 */
function entrySeries(candleSymbol) {
  const configured = candlesMod.sourceFor(candleSymbol);
  const seen = candlesMod.seriesInfo(candleSymbol, "1h", "1y");
  const known = Boolean(seen && seen.actualKnown);
  return {
    ticker: candleSymbol,
    interval: "1h",
    range: "1y",
    configuredProvider: configured.source,
    configuredSymbol: configured.symbol || candleSymbol,
    provider: known ? seen.provider : null,
    providerSymbol: known ? seen.providerSymbol : null,
    fallback: known ? Boolean(seen.fallback) : null,
    actualKnown: known,
    bars: seen ? seen.bars : null,
  };
}

const SERIES_KEYS = [
  "ticker",
  "interval",
  "range",
  "configuredProvider",
  "configuredSymbol",
  "provider",
  "providerSymbol",
  "fallback",
];

function sameSeries(a, b) {
  if (!a || !b) return false;
  return SERIES_KEYS.every((key) => a[key] === b[key]);
}

// Only the inputs that change the numbers: the spread came from the configured
// table, not a live snapshot, so an equal model is an equal cost.
const COST_KEYS = ["spread", "slippage", "commissionPerLot", "valuePerUnit"];

function sameCosts(a, b) {
  if (!a || !b) return false;
  return COST_KEYS.every((key) => Number(a[key] || 0) === Number(b[key] || 0));
}

/** The rule ids this build tests, in order — a promotion changes this list. */
function familyIds(families = familiesNow()) {
  return families.map((f) => f.id);
}

/** Which rules appeared or disappeared since a verdict was measured. */
function familyDifference(was, want) {
  if (!Array.isArray(was)) return "rule list changed";
  const had = new Set(was);
  const has = new Set(want || []);
  const added = (want || []).filter((id) => !had.has(id));
  const removed = was.filter((id) => !has.has(id));
  if (!added.length && !removed.length) return null;
  const bits = [];
  if (added.length) bits.push(`added ${added.join(", ")}`);
  if (removed.length) bits.push(`removed ${removed.join(", ")}`);
  return `rule list changed (${bits.join("; ")})`;
}

/** The inputs the next run for this market would record. */
function expectedFor(inst, families = familiesNow()) {
  return {
    series: entrySeries(inst.candleSymbol),
    families: familyIds(families),
    costs: costModelFor(inst.symbol),
  };
}

/** Does a stored verdict describe the inputs this build is using now? */
function meetsCurrent(stored, expected) {
  if (!stored || !expected) return false;
  if (!stored.series || !sameSeries(stored.series, expected.series)) return false;
  if (familyDifference(stored.families, expected.families)) return false;
  return sameCosts(stored.costs, expected.costs);
}

/**
 * Does this market need measuring? Either the clock or the build retired its
 * verdict (isStale), or the verdict describes a feed, rule list or cost model
 * that is no longer the one in force.
 */
function needsMeasure(inst, brain, families, now = Date.now()) {
  const stored = brain.results[inst.symbol];
  if (isStale(stored, brain, now)) return true;
  return !meetsCurrent(stored, expectedFor(inst, families));
}

/**
 * Every input that changes a verdict, as one string. When it changes — a rules
 * bump, a promotion, a provider switch — markets this process already
 * re-measured did so under the old inputs, so they queue again.
 */
function signatureFor(instruments) {
  const families = familiesNow()
    .map((f) => `${f.id}${f.promoted ? "+" : ""}`)
    .join(",");
  const feeds = instruments.map(
    (inst) => `${inst.symbol}:${inst.candleSymbol}:${candlesMod.sourceFor(inst.candleSymbol).source}`
  );
  return [RULES_VERSION, BAR_VERSION, "1h", "1y", families, ...feeds].join("|");
}

/**
 * Why a market has no verdict this build will use, naming the input that moved
 * rather than saying "not measured". `kept` is the verdict readBrain() accepted,
 * `stored` is whatever the file holds, and `expected` is what the next run would
 * record now.
 */
function whyUnmeasured({
  stored,
  kept,
  expected,
  rulesVersion,
  barVersion,
  invalidatedAt,
  now = Date.now(),
}) {
  if (rulesVersion && rulesVersion !== RULES_VERSION) {
    return `rules changed (${rulesVersion} → ${RULES_VERSION})`;
  }
  if (barVersion && barVersion !== BAR_VERSION) {
    return `bar rules changed (v${barVersion} → v${BAR_VERSION})`;
  }

  const rec = kept || stored;
  if (!rec) return "never measured";

  if (kept) {
    const age = now - new Date(kept.at).getTime();
    if (Number.isFinite(age) && age > TTL_MS) {
      return `verdict is ${Math.round(age / 3600000)}h old`;
    }
  }

  const marked = invalidatedAt ? new Date(invalidatedAt).getTime() : NaN;
  const at = new Date(rec.at).getTime();
  if (Number.isFinite(marked) && Number.isFinite(at) && at < marked) {
    return "measured before the last build change";
  }

  const want = expected || {};
  if (!rec.series) return "measured before the feed was recorded";
  if (!sameSeries(rec.series, want.series)) {
    const was = rec.series;
    const now2 = want.series || {};
    if (was.range !== now2.range || was.configuredProvider !== now2.configuredProvider) {
      return `entry series changed (${was.range}/${was.configuredProvider} → ${now2.range}/${now2.configuredProvider})`;
    }
    if (was.provider !== now2.provider || was.fallback !== now2.fallback) {
      return `entry feed changed (${was.provider} → ${now2.provider})`;
    }
    return "entry series changed";
  }

  const families = familyDifference(rec.families, want.families);
  if (families) return families;
  if (!sameCosts(rec.costs, want.costs)) return "cost model changed";
  return null;
}

/**
 * Every market with nothing usable behind it, and why. The brain fails closed,
 * so an unmeasured market has no champion and no gate; this answers "is that a
 * closed market, a feed change, or just the queue?" — `reason` names the input
 * that retired the last verdict, `open` says whether the market is trading now,
 * and `error` is the last failure this process hit while measuring it.
 */
function pendingReport(instruments = market.instrumentList()) {
  const raw = readBrainRaw();
  const brain = readBrain();
  const families = familiesNow();
  const now = Date.now();
  const rows = [];

  for (const inst of instruments) {
    const kept = brain.results[inst.symbol] || null;
    const stored = raw && raw.results ? raw.results[inst.symbol] || null : null;
    const reason = whyUnmeasured({
      stored,
      kept,
      expected: expectedFor(inst, families),
      rulesVersion: raw ? raw.rulesVersion : null,
      barVersion: raw ? raw.barVersion : null,
      invalidatedAt: brain.invalidatedAt || null,
      now,
    });
    if (!reason) continue;
    rows.push({
      symbol: inst.symbol,
      reason,
      open: sessions.instrumentMarketOpen(inst.symbol),
      storedAt: stored ? stored.at || null : null,
      error: state.errors[inst.symbol] || null,
    });
  }

  return rows;
}

/**
 * A new build is a reason to doubt every measurement, so mark them all stale.
 *
 * Idempotent against the build marker: the same build booting twice (a crash
 * loop, a host restart) does not send the brain round eleven markets again, and
 * a genuinely new commit does. The work is spread the ordinary way — one market
 * per watch cycle — so a deploy never blocks the watcher.
 */
function markStale(markerValue) {
  const brain = readBrain();
  if (markerValue && brain.measuredFor === markerValue) {
    return { changed: false, reason: "already measured for this build", measuredFor: brain.measuredFor };
  }
  const at = new Date().toISOString();
  brain.invalidatedAt = at;
  brain.measuredFor = markerValue || null;
  writeBrain(brain);
  return { changed: true, invalidatedAt: at, measuredFor: brain.measuredFor };
}

/**
 * Cross-check the rules the app says it is testing against the measurements it
 * actually holds. Pure, so it can be checked without a brain file.
 *
 * Two things can only go wrong through a bug, and both are silent:
 *
 *  - a standing promotion with no measured cells anywhere — the rule is listed
 *    as under test, but nothing was ever measured for it, so a market could sit
 *    with no verdict and no way to see why;
 *  - a champion naming a rule that is no longer in the list — a proof resting on
 *    a strategy that does not exist, which is exactly what readBrain prunes.
 *
 * Coverage is per condition, because the two reasons a cell can be absent mean
 * opposite things. A market measured after the rule was promoted that holds no
 * cell in one condition is a real result: the rule took no trades in that tape.
 * A market with no result at all, or one measured before the rule was promoted,
 * was never measured for it — an absence of evidence, not evidence of no
 * trades. Lumping those together would read as "the rule never trades in quiet
 * markets" when it may simply not have been asked yet.
 *
 * `symbols` is the market universe to report on; without it only the markets
 * already in the brain file can be named.
 *
 * Reporting them is cheap and turns "the list looks right" into a fact.
 */
function reconcilePromotions(results, families, symbols) {
  const tested = new Set(families.map((f) => f.id));
  const promoted = families.filter((f) => f.promoted);
  const markets = Array.isArray(symbols) && symbols.length ? [...new Set(symbols)] : Object.keys(results || {});
  const coverage = new Map(
    promoted.map((f) => [
      f.id,
      {
        id: f.id,
        promotedAt: f.promotedAt || null,
        symbols: [],
        cells: 0,
        proven: 0,
        conditions: regime.CONDITIONS.map((condition) => ({
          condition,
          cells: 0,
          proven: 0,
          withTrades: [],
          noTrades: [],
          unmeasured: [],
        })),
      },
    ])
  );
  const orphans = new Map();

  /** Was this market's measurement taken while the rule was under test? */
  function measuredFor(result, row) {
    const at = result ? new Date(result.at).getTime() : NaN;
    if (!Number.isFinite(at)) return false;
    if (!row.promotedAt) return true;
    const since = new Date(row.promotedAt).getTime();
    return !Number.isFinite(since) || at >= since;
  }

  for (const symbol of markets) {
    const result = (results || {})[symbol];
    for (const row of coverage.values()) {
      const measured = measuredFor(result, row);
      for (const bucket of row.conditions) {
        const cell = result && result.cells && result.cells[`${bucket.condition}|${row.id}`];
        if (cell) {
          row.cells += 1;
          bucket.cells += 1;
          if (cell.proven) {
            row.proven += 1;
            bucket.proven += 1;
          }
          if (!row.symbols.includes(symbol)) row.symbols.push(symbol);
          bucket.withTrades.push(symbol);
        } else if (measured) {
          bucket.noTrades.push(symbol);
        } else {
          bucket.unmeasured.push(symbol);
        }
      }
    }
  }

  for (const [symbol, result] of Object.entries(results || {})) {
    for (const [condition, champion] of Object.entries((result && result.champions) || {})) {
      if (!champion || tested.has(champion.family)) continue;
      orphans.set(`${symbol}|${condition}|${champion.family}`, {
        symbol,
        condition,
        family: champion.family,
        name: champion.familyName || null,
      });
    }
  }

  return {
    listed: promoted.map((f) => f.id),
    coverage: [...coverage.values()].map((row) => ({ ...row, markets: row.symbols.length })),
    missingCells: [...coverage.values()].filter((row) => row.cells === 0).map((row) => row.id),
    championsNotListed: [...orphans.values()],
  };
}

/**
 * What the brain has actually measured, and what is still owed. Read-only.
 * This is the panel that answers "did the deploy make it re-measure?" without
 * needing the dashboard password.
 */
function status(symbols) {
  const brain = readBrain();
  const families = familiesNow();
  const now = Date.now();
  const markets = Object.entries(brain.results || {}).map(([symbol, r]) => {
    const cells = Object.values((r && r.cells) || {});
    const promoted = cells.filter((c) => String(c.family).indexOf("lab_") === 0);
    const condition = r && r.current ? r.current.label : null;
    const champion = r && r.champions && condition ? r.champions[condition] || null : null;
    return {
      symbol,
      at: (r && r.at) || null,
      bars: (r && r.bars) || null,
      condition,
      cells: cells.length,
      provenCells: cells.filter((c) => c.proven).length,
      promotedCells: promoted.length,
      promotedProven: promoted.filter((c) => c.proven).length,
      stale: isStale(r, brain, now),
      champion: champion
        ? {
            family: champion.family,
            name: champion.familyName,
            n: champion.n,
            expectancy: champion.expectancy,
            grossExpectancy: champion.gross ? champion.gross.expectancy : null,
            costR: champion.costR != null ? champion.costR : null,
            tStat: champion.tStat,
          }
        : null,
    };
  });

  return {
    updatedAt: brain.updatedAt || null,
    measuredFor: brain.measuredFor || null,
    invalidatedAt: brain.invalidatedAt || null,
    running: state.running,
    lastRunAt: state.lastRunAt ? new Date(state.lastRunAt).toISOString() : null,
    lastSymbol: state.lastSymbol,
    error: state.error,
    families: families.map((f) => ({ id: f.id, name: f.name, promoted: Boolean(f.promoted) })),
    markets,
    // Does the list of rules match the measurements on hand?
    promotionAudit: reconcilePromotions(brain.results, families, symbols),
    pending: markets.filter((m) => m.stale).map((m) => m.symbol),
    proofBar: {
      trades: MIN_TRADES,
      expectancy: MIN_EXPECTANCY,
      tStat: MIN_TSTAT,
      folds: MIN_GOOD_FOLDS,
    },
  };
}

/**
 * Called every watch cycle. Every market with nothing usable behind it is
 * measured back to back, once each, instead of one per half hour; the ordinary
 * gap only applies when nothing is actually stale.
 */
async function maybeRun(instruments = []) {
  if (state.running) return;

  const signature = signatureFor(instruments);
  if (signature !== state.signature) {
    // A fresh process, a rule change, a promotion or a provider switch: markets
    // this process already re-measured did so on different inputs, so they
    // queue again.
    state.signature = signature;
    state.tried.clear();
  }

  const brain = readBrain();
  const families = familiesNow();
  const stale = instruments.filter((inst) => needsMeasure(inst, brain, families));

  // A market that fails is recorded in state.errors and not retried until the
  // inputs change again, so a broken feed cannot spin the brain.
  const fresh = stale.filter((inst) => !state.tried.has(inst.symbol));
  state.burst = fresh.length > 0;
  if (fresh.length) {
    const target = fresh[0];
    state.tried.add(target.symbol);
    await runFor(target.symbol, target.candleSymbol);
  } else if (stale.length && Date.now() - state.lastRunAt >= RUN_GAP_MS) {
    await runFor(stale[0].symbol, stale[0].candleSymbol);
  }
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
 * The condition one step away: the same trend character, the other
 * volatility reading. Trending-quiet sits next to trending-volatile, and
 * ranging-quiet next to ranging-volatile.
 *
 * Only the volatility axis is treated as adjacent on purpose. Whether a
 * strategy is a breakout or a reversion play follows from whether the market
 * trends, so borrowing a proof across the trend axis would be borrowing a
 * different strategy's result. Hour to hour, quiet and volatile describe the
 * pace of the same tape.
 */
function adjacentCondition(condition) {
  const match = /^(trending|ranging)-(quiet|volatile)$/.exec(String(condition || ""));
  if (!match) return null;
  return `${match[1]}-${match[2] === "quiet" ? "volatile" : "quiet"}`;
}

/**
 * Which champion, if any, covers this condition — exactly or next door.
 *
 * Returns { champion, adjacent, provenCondition } or null. Purity here keeps
 * the gate's one interesting decision testable without candles or a network.
 */
function proofFor(result, condition) {
  if (!result || !result.champions) return null;
  const exact = result.champions[condition] || null;
  if (exact) return { champion: exact, adjacent: false, provenCondition: condition };
  const near = adjacentCondition(condition);
  const borrowed = near ? result.champions[near] || null : null;
  if (borrowed) return { champion: borrowed, adjacent: true, provenCondition: near };
  return null;
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

  const proof = proofFor(result, condition);
  if (!proof) {
    return {
      allowed: false,
      condition,
      fresh: now.fresh,
      reason: `no rule is proven for ${symbol} in a ${condition} market`,
      untested: false,
    };
  }
  const champion = proof.champion;

  // The next-door case: allowed, but at ADJACENT_MULTIPLE of the risk, and it
  // says so, because a trade the settings did not size is a trade the owner
  // should be able to see and override.
  if (proof.adjacent) {
    return {
      allowed: true,
      adjacent: true,
      sizeMultiplier: ADJACENT_MULTIPLE,
      condition,
      provenCondition: proof.provenCondition,
      fresh: now.fresh,
      champion: {
        family: champion.family,
        name: champion.familyName,
        n: champion.n,
        expectancy: champion.expectancy,
        grossExpectancy: champion.gross ? champion.gross.expectancy : null,
        costR: champion.costR != null ? champion.costR : null,
        tStat: champion.tStat,
        outsideUsualCondition: Boolean(champion.notes),
      },
      reason: `nothing is proven for ${symbol} in a ${condition} market; ${champion.familyName} is proven in ${proof.provenCondition} (${champion.n} trades, ${champion.expectancy}R each net of costs, t=${champion.tStat}) — taken at half size`,
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
      grossExpectancy: champion.gross ? champion.gross.expectancy : null,
      costR: champion.costR != null ? champion.costR : null,
      tStat: champion.tStat,
      outsideUsualCondition: Boolean(champion.notes),
    },
    reason: `${champion.familyName} is proven here: ${champion.n} trades, ${champion.expectancy}R each net of costs, t=${champion.tStat}`,
  };
}

function summary() {
  const brain = readBrain();
  const rows = Object.entries(brain.results).map(([symbol, r]) => {
    const condition = r.current ? r.current.label : "unclear";
    const champion = r.champions ? r.champions[condition] : null;
    // A proof in the neighbouring condition is not a proof here, but it is not
    // nothing either: the gate lets it buy a half-size trade. Reported so the
    // dashboard can say why a market that has no champion still prompts.
    const near = adjacentCondition(condition);
    const adjacent = near && r.champions ? r.champions[near] || null : null;
    return {
      symbol,
      at: r.at,
      condition,
      adjacent: adjacent
        ? {
            condition: near,
            name: adjacent.familyName,
            n: adjacent.n,
            expectancy: adjacent.expectancy,
            grossExpectancy: adjacent.gross ? adjacent.gross.expectancy : null,
            costR: adjacent.costR != null ? adjacent.costR : null,
            tStat: adjacent.tStat,
          }
        : null,
      efficiency: r.current ? r.current.efficiency : null,
      volatilityPercentile: r.current ? r.current.volatilityPercentile : null,
      champion: champion
        ? {
            family: champion.family,
            name: champion.familyName,
            n: champion.n,
            expectancy: champion.expectancy,
            grossExpectancy: champion.gross ? champion.gross.expectancy : null,
            costR: champion.costR != null ? champion.costR : null,
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
    bursting: state.burst,
    // Markets with no verdict this build will use, each with the reason. An
    // empty list means every market is measured; `open:false` says a closure,
    // not a broken feed, is in play.
    pending: pendingReport(),
    // Every rule currently being tested, so a lab candidate is never invisible.
    families: familiesNow().map((f) => ({ id: f.id, name: f.name, promoted: Boolean(f.promoted) })),
    conditions: rows,
  };
}

/**
 * Every measured cell, gross and net, for a read-only report.
 *
 * This is the number the proof bar is applied to, per market, condition and
 * rule. `expectancy` and `tStat` are net of spread, slippage and commission;
 * `grossExpectancy` and `grossTStat` are the same trades before those charges;
 * `costR` is what the broker took. `proven` is therefore the net verdict.
 */
function cellReport(symbol) {
  const brain = readBrain();
  const wanted = symbol ? String(symbol).toUpperCase() : null;
  const rows = [];

  for (const [sym, result] of Object.entries(brain.results || {})) {
    if (wanted && sym !== wanted) continue;
    for (const cell of Object.values((result && result.cells) || {})) {
      rows.push({
        symbol: sym,
        at: (result && result.at) || null,
        condition: cell.condition,
        family: cell.family,
        familyName: cell.familyName,
        n: cell.n,
        winrate: cell.winrate,
        expectancy: cell.expectancy,
        grossExpectancy: cell.gross ? cell.gross.expectancy : null,
        costR: cell.costR != null ? cell.costR : null,
        tStat: cell.tStat,
        grossTStat: cell.gross ? cell.gross.tStat : null,
        goodFolds: cell.goodFolds,
        foldTotals: cell.foldTotals,
        grossFoldTotals: cell.gross ? cell.gross.foldTotals : null,
        proven: Boolean(cell.proven),
        provenGross: Boolean(cell.gross && cell.gross.proven),
        notes: cell.notes || "",
      });
    }
  }

  rows.sort(
    (a, b) =>
      a.symbol.localeCompare(b.symbol) ||
      a.condition.localeCompare(b.condition) ||
      a.family.localeCompare(b.family)
  );

  return {
    updatedAt: brain.updatedAt || null,
    barVersion: brain.barVersion || null,
    costBasis:
      "net of configured spread, slippage and per-lot commission; gap fills at the bar open",
    proofBar: {
      trades: MIN_TRADES,
      expectancy: MIN_EXPECTANCY,
      tStat: MIN_TSTAT,
      folds: MIN_GOOD_FOLDS,
    },
    cells: rows,
  };
}

module.exports = {
  maybeRun,
  markStale,
  reconcilePromotions,
  gradeCell,
  costModelFor,
  cellReport,
  isStale,
  needsMeasure,
  whyUnmeasured,
  pendingReport,
  entrySeries,
  signatureFor,
  TTL_MS,
  status,
  gate,
  proofFor,
  adjacentCondition,
  currentCondition,
  runFor,
  summary,
  evaluateMarket,
  MIN_TRADES,
  MIN_EXPECTANCY,
  MIN_TSTAT,
  MIN_GOOD_FOLDS,
  BAR_VERSION,
  ADJACENT_MULTIPLE,
};
