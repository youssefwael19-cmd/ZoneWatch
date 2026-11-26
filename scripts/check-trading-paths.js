#!/usr/bin/env node
/**
 * Checks for the three things that decide whether the app trades at all:
 * the gate decision, the exploration budget, the live-evidence test — and the
 * ledger that counts what happened. No network, no live state, no dependencies.
 *
 *   node scripts/check-trading-paths.js
 */

const assert = require("assert");

const gate = require("../server/gate");
const exploration = require("../server/exploration");
const learning = require("../server/learning");
const ledger = require("../server/ledger");
const strategies = require("../server/strategies");
const regime = require("../server/regime");
const promotions = require("../server/promotions");
const audit = require("../server/audit");
const brain = require("../server/brain");
const locks = require("../server/locks");
const gatedigest = require("../server/gatedigest");
const paperreview = require("../server/paperreview");
const buildInfo = require("../server/buildinfo");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${name} — ${err.message}`);
  }
}

const refused = {
  allowed: false,
  condition: "ranging-volatile",
  reason: "no rule is proven for EURUSD in a ranging-volatile market",
};

/* ------------------------------ gate ------------------------------ */

check("a proven signal passes through untouched", () => {
  const proven = { allowed: true, condition: "trending-quiet", reason: "proven", sizeMultiplier: 0.5 };
  const out = gate.decide({ symbol: "EURUSD", verdict: proven, live: { positive: false } });
  assert.strictEqual(out, proven);
  assert.strictEqual(out.sizeMultiplier, 0.5);
});

check("a refusal stays a refusal with no evidence and no budget", () => {
  const out = gate.decide({ symbol: "EURUSD", verdict: refused, live: null, explorationAllowed: false });
  assert.strictEqual(out.allowed, false);
  assert.strictEqual(out.reason, refused.reason);
});

check("live evidence buys half size, never full", () => {
  const out = gate.decide({
    symbol: "EURUSD",
    verdict: refused,
    live: { positive: true, n: 24, expectancy: 0.12, tStat: 1.9 },
    explorationAllowed: true,
    liveMultiple: 0.5,
  });
  assert.strictEqual(out.allowed, true);
  assert.strictEqual(out.live, true);
  assert.strictEqual(out.exploration, undefined, "live evidence must win over exploration");
  assert.strictEqual(out.sizeMultiplier, 0.5);
  assert.ok(/half size/.test(out.reason), out.reason);
});

check("exploration only fires when the budget allows it", () => {
  const allowed = gate.decide({ symbol: "GBPUSD", verdict: refused, explorationAllowed: true, exploreMultiple: 0.25 });
  assert.strictEqual(allowed.allowed, true);
  assert.strictEqual(allowed.exploration, true);
  assert.strictEqual(allowed.sizeMultiplier, 0.25);
  assert.ok(/not a proven setup/.test(allowed.reason), allowed.reason);

  const spent = gate.decide({ symbol: "GBPUSD", verdict: refused, explorationAllowed: false });
  assert.strictEqual(spent.allowed, false);
});

check("a setup the lab silenced still reaches the gate while the shadow book is measuring", () => {
  assert.strictEqual(
    gate.worthAsking({ labApproved: false, explorable: false, shadowWatching: true }),
    true,
    "the shadow book needs the refusal to price it"
  );
  assert.strictEqual(gate.worthAsking({ labApproved: false, explorable: true }), true);
  assert.strictEqual(
    gate.worthAsking({ labApproved: false, explorable: false, shadowWatching: false }),
    false,
    "with no consumer there is nothing to ask the gate about"
  );
  assert.strictEqual(gate.worthAsking({ labApproved: true }), true);
  assert.strictEqual(gate.worthAsking({ unproven: true }), true);
});

check("a negative live book does not buy anything", () => {
  const out = gate.decide({
    symbol: "GBPUSD",
    verdict: refused,
    live: { positive: false, n: 40, expectancy: -0.2, tStat: -2 },
    explorationAllowed: false,
  });
  assert.strictEqual(out.allowed, false);
});

/* --------------------------- exploration --------------------------- */

const CFG = { enabled: true, perDay: 3, perSymbolPerDay: 1, sizeMultiplier: 0.25 };
const DAY = Date.UTC(2026, 10, 21, 12);

check("the daily budget counts only today", () => {
  const entries = [
    { at: "2026-11-20T10:00:00.000Z", symbol: "EURUSD" },
    { at: "2026-11-20T11:00:00.000Z", symbol: "XAUUSD" },
    { at: "2026-11-21T09:00:00.000Z", symbol: "EURUSD" },
  ];
  const state = exploration.remainingFor(entries, DAY, CFG);
  assert.strictEqual(state.used, 1);
  assert.strictEqual(state.remaining, 2);
});

check("a full day leaves nothing", () => {
  const entries = ["EURUSD", "XAUUSD", "NASDAQ"].map((symbol) => ({
    at: "2026-11-21T09:00:00.000Z",
    symbol,
  }));
  assert.strictEqual(exploration.remainingFor(entries, DAY, CFG).remaining, 0);
});

check("one per market per day, even with budget left", () => {
  const day = exploration.remainingFor;
  const entries = [{ at: "2026-11-21T09:00:00.000Z", symbol: "EURUSD" }];
  const state = day(entries, DAY, CFG);
  assert.strictEqual(state.remaining, 2, "the day still has room");
  const perSymbol = state.today.filter((e) => e.symbol === "EURUSD").length;
  assert.strictEqual(perSymbol < CFG.perSymbolPerDay, false, "EURUSD has already had its one");
});

check("config clamps nonsense instead of accepting it", () => {
  const cfg = exploration.config({ perDay: 999, perSymbolPerDay: -3, sizeMultiplier: 5 });
  assert.strictEqual(cfg.perDay, 12);
  assert.strictEqual(cfg.perSymbolPerDay, 0);
  assert.strictEqual(cfg.sizeMultiplier, 0.5);
});

check("switching exploration off leaves no budget at all", () => {
  const cfg = exploration.config({ enabled: false });
  assert.strictEqual(cfg.enabled, false);
});

check("a market the lab marked no edge can still take its one exploration trade", () => {
  const cfg = exploration.config({ perDay: 3, perSymbolPerDay: 1 });
  const fresh = exploration.remainingFor([], DAY, cfg);
  assert.strictEqual(exploration.allowsSymbol(fresh, "XAUUSD", cfg), true);

  const used = exploration.remainingFor(
    [{ at: "2026-11-21T09:00:00.000Z", symbol: "XAUUSD" }],
    DAY,
    cfg
  );
  assert.strictEqual(exploration.allowsSymbol(used, "XAUUSD", cfg), false, "one per market per day");
  assert.strictEqual(exploration.allowsSymbol(used, "EURUSD", cfg), true, "another market still has room");
  assert.strictEqual(exploration.allowsSymbol(null, "EURUSD", cfg), false, "no state, no trade");
});

/* ------------------------- live evidence ------------------------- */

function trades(symbol, rs) {
  const outcome = (r) => (r > 0 ? "win" : r < 0 ? "loss" : "breakeven");
  return rs.map((r, i) => ({
    symbol,
    outcome: outcome(r),
    rMultiple: r,
    closedAt: new Date(Date.UTC(2026, 10, 20, i)).toISOString(),
  }));
}

check("nineteen trades is not evidence, twenty is not automatically either", () => {
  const nineteen = learning.liveEvidence(trades("EURUSD", Array.from({ length: 19 }, () => 0.4)), "EURUSD");
  assert.strictEqual(nineteen.n, 19);
  assert.strictEqual(nineteen.positive, false);

  // Twenty identical winners have no variance, so there is no t-statistic: a
  // sample with zero spread is not a measurement, and must not pass.
  const flat = learning.liveEvidence(trades("EURUSD", Array.from({ length: 20 }, () => 0.4)), "EURUSD");
  assert.strictEqual(flat.tStat, null);
  assert.strictEqual(flat.positive, false);
});

check("a positive, statistically real live book passes", () => {
  const rs = [2, -1, 2, -1, 2, -1, 2, -1, 2, -1, 2, -1, 2, -1, 2, -1, 2, -1, 2, 2];
  const ev = learning.liveEvidence(trades("EURUSD", rs), "EURUSD");
  assert.strictEqual(ev.n, 20);
  assert.ok(ev.expectancy > 0.05, String(ev.expectancy));
  assert.ok(ev.tStat >= 1.5, String(ev.tStat));
  assert.strictEqual(ev.positive, true);
});

check("a losing live book fails, and so does a negative-expectancy one", () => {
  const rs = [-1, 1, -1, 1, -1, 1, -1, -1, -1, -1, -1, 1, -1, 1, -1, 1, -1, 1, -1, -1];
  const ev = learning.liveEvidence(trades("GBPUSD", rs), "GBPUSD");
  assert.strictEqual(ev.positive, false);
});

check("thresholds come from settings, not the constants", () => {
  const rs = [1, -0.5, 1, -0.6, 1, -0.4, 1, -0.5, 1, -0.5];
  const loose = learning.liveEvidence(trades("XAUUSD", rs), "XAUUSD", { minTrades: 10, minExpectancy: 0, minTStat: 0.5 });
  const strict = learning.liveEvidence(trades("XAUUSD", rs), "XAUUSD", { minTrades: 30 });
  assert.strictEqual(loose.positive, true);
  assert.strictEqual(strict.positive, false);
});

check("other markets' results do not leak into this one", () => {
  const history = [...trades("EURUSD", [2, 2, 2]), ...trades("GBPUSD", [-1, -1, -1])];
  assert.strictEqual(learning.liveEvidence(history, "EURUSD").n, 3);
  assert.strictEqual(learning.liveEvidence(history, "GBPUSD").n, 3);
});

/* ----------------------------- ledger ---------------------------- */

check("each book is counted apart and nothing is merged", () => {
  const out = ledger.reconcile({
    tracker: {
      open: [{}, {}],
      history: [
        { symbol: "EURUSD", outcome: "win" },
        { symbol: "EURUSD", outcome: "loss" },
        { symbol: "GBPUSD", outcome: "breakeven" },
        { symbol: "XAUUSD", outcome: "expired" },
      ],
    },
    journal: [
      { status: "sent", outcome: "win" },
      { status: "sent", outcome: "loss" },
      { status: "held", outcome: "breakeven" },
      { status: "held", outcome: null },
    ],
    executor: { openCount: 1, closedCount: 1 },
    shadow: { openCount: 2, closedCount: 5, refusedToday: 4 },
  });
  assert.deepStrictEqual(out.books.signals, { open: 2, closed: 3, expired: 1 });
  assert.deepStrictEqual(out.books.live, { open: 1, closed: 1 });
  assert.deepStrictEqual(out.books.shadow, { open: 2, closed: 5, refusedToday: 4 });
  assert.strictEqual(out.journal.closedDelivered, 2, "held results are not delivered results");
  assert.strictEqual(out.journal.heldResolved, 1);
  assert.strictEqual(out.consistent, true);
});

check("a tracked result with no journal entry is reported as a gap", () => {
  const out = ledger.reconcile({
    tracker: { open: [], history: [{ symbol: "EURUSD", outcome: "win" }, { symbol: "EURUSD", outcome: "loss" }] },
    journal: [{ status: "sent", outcome: "win" }],
  });
  assert.strictEqual(out.consistent, false);
  assert.strictEqual(out.gaps.length, 1);
  assert.ok(/1 tracked result/.test(out.gaps[0]), out.gaps[0]);
});

check("expiries are not counted as closed trades", () => {
  const out = ledger.reconcile({
    tracker: { open: [], history: [{ outcome: "expired" }, { outcome: "expired" }] },
    journal: [],
  });
  assert.strictEqual(out.books.signals.closed, 0);
  assert.strictEqual(out.books.signals.expired, 2);
});

/* ---------------------- promoted families ---------------------- */

const ZW2 = { mult: 1.8, stopMode: "zone_width", rr: 2 };

check("a promoted family walks like any other rule", () => {
  const family = strategies.labFamily(ZW2);
  assert.strictEqual(family.id, "lab_18_zw_2");
  assert.strictEqual(family.promoted, true);
  assert.strictEqual(family.worksIn.length, 4, "no condition may be called outside its remit");
  assert.strictEqual(typeof family.entryAt, "function");
  // No candles, no zones: a rule that guessed anyway would be inventing trades.
  const ctx = { bars: [], atr: [] };
  assert.strictEqual(family.entryAt([], 500, ctx), null);
});

/* ---------------------- promotions that stick ---------------------- */

const PROMOTED = { id: "lab_18_zw_2", cfg: ZW2, n: 77, expectancy: 0.487, markets: ["NASDAQ"] };
const OTHER = { id: "lab_12_atr_2", cfg: { mult: 1.2, stopMode: "atr", rr: 2 }, n: 300, expectancy: 0.2, markets: ["USDJPY"] };

check("a promotion survives a lab update that no longer nominates it", () => {
  const first = promotions.merge(promotions.empty(), [PROMOTED], "2026-01-01T00:00:00.000Z");
  assert.deepStrictEqual(first.added, [PROMOTED.id]);

  const stored = { rulesVersion: strategies.RULES_VERSION, at: first.added.length ? "2026-01-01T00:00:00.000Z" : null, configs: first.configs };
  const later = promotions.merge(stored, [], "2026-02-01T00:00:00.000Z");
  assert.strictEqual(later.configs.length, 1, "a lab update must not remove a promotion");
  assert.strictEqual(later.configs[0].id, PROMOTED.id);
  assert.strictEqual(later.configs[0].firstPromotedAt, "2026-01-01T00:00:00.000Z");
  assert.strictEqual(later.changed, false, "nothing new means no rewrite of the state file");
});

check("a new winner joins the standing promotions instead of replacing them", () => {
  const stored = { rulesVersion: strategies.RULES_VERSION, configs: promotions.merge(promotions.empty(), [PROMOTED], "2026-01-01T00:00:00.000Z").configs };
  const later = promotions.merge(stored, [OTHER], "2026-02-01T00:00:00.000Z");
  assert.deepStrictEqual(later.configs.map((e) => e.id), [PROMOTED.id, OTHER.id]);
  assert.deepStrictEqual(later.added, [OTHER.id]);
  assert.strictEqual(later.changed, true);
});

check("re-qualifying keeps the promotion's original date and best record", () => {
  const stored = { rulesVersion: strategies.RULES_VERSION, configs: promotions.merge(promotions.empty(), [PROMOTED], "2026-01-01T00:00:00.000Z").configs };
  const weaker = promotions.merge(stored, [{ ...PROMOTED, n: 40, expectancy: 0.11 }], "2026-03-01T00:00:00.000Z");
  assert.strictEqual(weaker.configs.length, 1, "a re-qualifying config is not duplicated");
  assert.strictEqual(weaker.configs[0].firstPromotedAt, "2026-01-01T00:00:00.000Z");
  assert.strictEqual(weaker.configs[0].lastQualifiedAt, "2026-03-01T00:00:00.000Z");
  assert.strictEqual(weaker.configs[0].best.expectancy, 0.487, "a weaker run must not overwrite the record it earned");
  assert.strictEqual(weaker.added.length, 0);

  const stronger = promotions.merge(stored, [{ ...PROMOTED, expectancy: 0.6 }], "2026-03-01T00:00:00.000Z");
  assert.strictEqual(stronger.configs[0].best.expectancy, 0.6);
  assert.strictEqual(stronger.changed, true, "a better unseen record is worth writing down");
});

check("a stored promotion still names the rule the brain measured", () => {
  const merged = promotions.merge(promotions.empty(), [PROMOTED], "2026-01-01T00:00:00.000Z");
  const family = strategies.labFamily(merged.configs[0].cfg);
  assert.strictEqual(family.id, PROMOTED.id);
  assert.strictEqual(family.promoted, true);
});

check("the public report shows each standing promotion and its unseen record", () => {
  const merged = promotions.merge(promotions.empty(), [PROMOTED], "2026-01-01T00:00:00.000Z");
  const entry = merged.configs[0];

  const kept = promotions.describe(entry, new Set());
  assert.strictEqual(kept.id, PROMOTED.id);
  assert.strictEqual(kept.firstPromotedAt, "2026-01-01T00:00:00.000Z");
  assert.deepStrictEqual(kept.unseen, { n: 77, expectancy: 0.487, markets: ["NASDAQ"] });
  assert.strictEqual(kept.currentlyNominated, false, "this rule is held by the list, not by a current result");

  const nominated = promotions.describe(entry, new Set([PROMOTED.id]));
  assert.strictEqual(nominated.currentlyNominated, true);

  // Nothing in the published view may look like a credential to redact().
  for (const key of Object.keys(kept)) assert.strictEqual(audit.redact({ [key]: "x" })[key], "x", key);
});

check("a promotion from an older rule set is not carried into this build", () => {
  const old = {
    rulesVersion: strategies.RULES_VERSION - 1,
    configs: promotions.merge(promotions.empty(), [PROMOTED], "2026-01-01T00:00:00.000Z").configs,
  };
  assert.deepStrictEqual(promotions.usable(old).configs, [], "the rule itself changed, so it must re-earn its place");
  assert.deepStrictEqual(promotions.usable({ rulesVersion: strategies.RULES_VERSION, configs: [] }).configs, []);
  assert.deepStrictEqual(promotions.usable(null).configs, []);
});

/* -------------------- promotions vs measured cells -------------------- */

check("a promotion with no measured cells is reported, not assumed fine", () => {
  const out = brain.reconcilePromotions(
    {
      TESTX: {
        cells: {
          "trending-quiet|lab_a": { family: "lab_a", proven: true },
          "trending-quiet|sweep": { family: "sweep", proven: false },
        },
        champions: { "trending-quiet": { family: "lab_a", familyName: "A" } },
      },
    },
    [{ id: "sweep" }, { id: "lab_a", promoted: true }, { id: "lab_b", promoted: true }]
  );
  assert.deepStrictEqual(out.listed, ["lab_a", "lab_b"]);
  assert.deepStrictEqual(out.missingCells, ["lab_b"]);
  const covered = out.coverage.find((row) => row.id === "lab_a");
  assert.deepStrictEqual(covered.symbols, ["TESTX"]);
  assert.strictEqual(covered.markets, 1);
  assert.strictEqual(covered.cells, 1);
  assert.strictEqual(covered.proven, 1);
  assert.deepStrictEqual(out.championsNotListed, [], "a champion on a rule that is listed is fine");
});

check("a champion naming a rule that is no longer listed is reported", () => {
  const out = brain.reconcilePromotions(
    {
      TESTX: { cells: {}, champions: { "trending-quiet": { family: "lab_gone", familyName: "Gone" } } },
    },
    [{ id: "sweep" }, { id: "lab_a", promoted: true }]
  );
  assert.deepStrictEqual(out.championsNotListed.map((c) => c.family), ["lab_gone"]);
  assert.strictEqual(out.championsNotListed[0].symbol, "TESTX");
  assert.deepStrictEqual(out.missingCells, ["lab_a"], "a rule with no cells at all is missing everywhere");
});

check("a condition with no trades is not confused with a cell never measured", () => {
  const results = {
    // Measured after the rule was promoted, and it traded in one condition.
    EURUSD: {
      at: "2026-02-01T00:00:00.000Z",
      cells: { "trending-quiet|lab_a": { family: "lab_a", proven: false } },
      champions: {},
    },
    // Measured after the rule was promoted, but it made no trade anywhere.
    GBPUSD: { at: "2026-02-01T00:00:00.000Z", cells: {}, champions: {} },
    // Measured before the rule was promoted, so it was never asked about it.
    USDJPY: { at: "2026-01-01T00:00:00.000Z", cells: {}, champions: {} },
  };
  const families = [{ id: "lab_a", promoted: true, promotedAt: "2026-01-15T00:00:00.000Z" }];
  const out = brain.reconcilePromotions(results, families, ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD"]);

  const row = out.coverage.find((r) => r.id === "lab_a");
  assert.strictEqual(row.conditions.length, regime.CONDITIONS.length, "every condition must be reported");
  assert.strictEqual(row.markets, 1, "only a market with a cell counts as covered");
  assert.strictEqual(row.promotedAt, "2026-01-15T00:00:00.000Z");

  const trending = row.conditions.find((c) => c.condition === "trending-quiet");
  assert.deepStrictEqual(trending.withTrades, ["EURUSD"]);
  assert.deepStrictEqual(trending.noTrades, ["GBPUSD"], "measured, the rule simply took no trade");
  assert.deepStrictEqual(
    trending.unmeasured,
    ["USDJPY", "XAUUSD"],
    "a pre-promotion measurement and a market with no result are both unmeasured"
  );

  const ranging = row.conditions.find((c) => c.condition === "ranging-quiet");
  assert.deepStrictEqual(ranging.withTrades, []);
  assert.deepStrictEqual(
    ranging.noTrades,
    ["EURUSD", "GBPUSD"],
    "both markets were measured for this rule; neither cell exists because it made no trade in this tape"
  );
  assert.deepStrictEqual(ranging.unmeasured, ["USDJPY", "XAUUSD"]);

  // With no market list the results' own keys are the universe.
  const fallback = brain.reconcilePromotions(results, families).coverage.find((r) => r.id === "lab_a");
  assert.deepStrictEqual(
    fallback.conditions.find((c) => c.condition === "ranging-quiet").unmeasured,
    ["USDJPY"]
  );
});

/* ----------------------- proof net of costs ----------------------- */

check("the backtest charges spread, slippage and commission", () => {
  const bars = [
    { t: 0, o: 100, h: 100, l: 100, c: 100, v: 0 },
    { t: 3600000, o: 100.1, h: 102.1, l: 100.05, c: 102, v: 0 },
  ];
  const trade = { side: "BUY", entry: 100, stop: 99, target: 102 };
  const costs = { spread: 0.2, slippage: 0.05, commissionPerLot: 0.1, valuePerUnit: 1 };
  const out = strategies.resolve(bars, 0, trade, 2, costs);

  assert.strictEqual(out.outcome, "win");
  assert.strictEqual(out.grossR, 2, "gross is the target distance");
  // entry 100 + half spread 0.1 + slippage 0.05 = 100.15; exit 102 - half = 101.90;
  // 1.75R before the 0.1R round-turn commission.
  assert.strictEqual(out.r, 1.65);
  assert.strictEqual(out.costs.spread, 0.2);
  assert.strictEqual(out.costs.commissionR, 0.1);
});

check("a gap through the stop fills at the bar open, not the stop", () => {
  const bars = [
    { t: 0, o: 100, h: 100, l: 100, c: 100, v: 0 },
    { t: 3600000, o: 98, h: 99.5, l: 97.5, c: 98, v: 0 },
  ];
  const out = strategies.resolve(
    bars,
    0,
    { side: "BUY", entry: 100, stop: 99, target: 102 },
    2,
    { spread: 0.2, slippage: 0.05, commissionPerLot: 0, valuePerUnit: 1 }
  );

  assert.strictEqual(out.outcome, "loss");
  assert.strictEqual(out.grossR, -2, "the fill is the open, two risk units away");
  assert.strictEqual(out.r, -2.25, "and it still pays the entry and exit charges");
});

check("a cell that clears the bar only before costs is not proven", () => {
  const grossRs = [];
  const netRs = [];
  for (let i = 0; i < 30; i++) {
    const gross = i % 2 === 0 ? 3 : -1; // 1.0R average, t ≈ 2.7
    grossRs.push(gross);
    netRs.push(gross - 0.95); // 0.05R average, t near zero
  }

  const cell = brain.gradeCell({
    condition: "trending-quiet",
    family: "lab_x",
    familyName: "X",
    grossRs,
    netRs,
    grossFolds: [5, 5, 5],
    netFolds: [2, 2, 2],
  });

  assert.strictEqual(cell.gross.proven, true, "the gross sample clears the bar");
  assert.strictEqual(cell.proven, false, "the net sample must not inherit that verdict");
  assert.ok(cell.expectancy < 0.1);
  assert.ok(cell.gross.expectancy > cell.expectancy);
  assert.strictEqual(cell.costR, -28.5, "the sample's total cost is reported in R");
  assert.deepStrictEqual(cell.foldTotals, [2, 2, 2], "fold totals are net");
  assert.deepStrictEqual(cell.gross.foldTotals, [5, 5, 5], "gross fold totals are kept too");
});

check("the paper review compares live R against the net promise", () => {
  const champion = {
    family: "lab_a",
    familyName: "A",
    expectancy: 0.05,
    grossExpectancy: 0.4,
    winrate: 50,
    tStat: 3,
  };
  const exec = {
    closed: Array.from({ length: 20 }, (_, i) => ({
      symbol: "EURUSD",
      riskMoney: 1,
      pnl: i % 2 === 0 ? 1 : -1,
      outcome: i % 2 === 0 ? "win" : "loss",
    })),
  };
  const brainInput = { conditions: [{ symbol: "EURUSD", champion }] };
  const rows = paperreview.buildComparison({ exec, brain: brainInput });

  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].promisedExpectancy, 0.05, "the gross promise is not the comparison");
  assert.strictEqual(rows[0].promisedGrossExpectancy, 0.4);
  assert.strictEqual(rows[0].comparisonBasis, "net of costs");

  const review = paperreview.buildReview({ exec, brain: brainInput });
  assert.strictEqual(review.ready, true);
  assert.strictEqual(review.comparisonBasis, "net of costs");
  assert.ok(/promised \+0\.05R net/.test(review.text), review.text);
});

/* --------------------------- audit / build --------------------------- */

check("the audit report cannot publish a secret, however it is named", () => {
  const out = audit.redact({
    bridgeSecret: "abc123",
    nested: { apiKey: "sk-live-xyz", token: "t", emptySecret: "" },
    webhook: "https://discord.com/api/webhooks/123/abcdef",
    harmless: "not a secret",
  });
  assert.strictEqual(out.bridgeSecret, audit.REDACTED);
  assert.strictEqual(out.nested.apiKey, audit.REDACTED);
  assert.strictEqual(out.nested.token, audit.REDACTED);
  assert.strictEqual(out.nested.emptySecret, "", "an unset secret stays visibly unset");
  assert.strictEqual(out.webhook, audit.REDACTED, "a webhook URL is a secret even unnamed");
  assert.strictEqual(out.harmless, "not a secret");
});

check("the report keeps its shape and never mutates the input", () => {
  const input = { ok: true, settings: { locked: true }, money: null };
  const out = audit.report(input);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.settings.locked, true);
  assert.deepStrictEqual(out.incomplete, []);
  assert.strictEqual(input.incomplete, undefined, "the input object must not be written to");
});

check("a build marker changes with the build, not with a restart", () => {
  const first = buildInfo.get();
  const second = buildInfo.get();
  assert.strictEqual(first.marker, second.marker);
  assert.ok(first.bootId && first.marker, "both must be present to compare runs");
});

check("a new build marks every measurement stale, the same build does not", () => {
  const result = { at: new Date().toISOString() };
  const fresh = { measuredFor: "commit:aaa", invalidatedAt: null };
  assert.strictEqual(brain.isStale(result, fresh), false);

  const invalidated = { measuredFor: "commit:bbb", invalidatedAt: new Date(Date.now() + 1000).toISOString() };
  assert.strictEqual(brain.isStale(result, invalidated), true);

  const old = { at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() };
  assert.strictEqual(brain.isStale(old, { invalidatedAt: null }), true, "a day-old measurement is stale on its own");
  assert.strictEqual(brain.isStale(null, {}), true, "nothing measured is stale");
});

check("a verdict from another feed, rule list or cost model needs re-measuring", () => {
  const inst = { symbol: "EURUSD", candleSymbol: "EURUSD=X" };
  const families = [{ id: "trend", name: "Trend" }];
  const costs = brain.costModelFor(inst.symbol);
  const good = {
    at: new Date().toISOString(),
    series: brain.entrySeries(inst.candleSymbol),
    families: ["trend"],
    costs,
  };
  // Whatever this machine is configured for, a *different* feed is the point.
  const otherFeed = good.series.configuredProvider === "deriv" ? "yahoo" : "deriv";
  const file = (result) => ({ results: result ? { EURUSD: result } : {}, invalidatedAt: null });

  assert.strictEqual(brain.needsMeasure(inst, file(good), families), false, "a current verdict was called stale");
  assert.strictEqual(brain.needsMeasure(inst, file(null), families), true, "a missing verdict was called current");
  assert.strictEqual(
    brain.needsMeasure(inst, file({ ...good, series: { ...good.series, configuredProvider: otherFeed } }), families),
    true,
    "a verdict from another feed was trusted"
  );
  assert.strictEqual(
    brain.needsMeasure(inst, file({ ...good, families: ["trend", "breakout"] }), families),
    true,
    "a verdict from another rule list was trusted"
  );
  // The feed that actually served the bars is a cache detail, not an input:
  // comparing it retired live verdicts that nothing changed for.
  assert.strictEqual(
    brain.needsMeasure(
      inst,
      file({ ...good, series: { ...good.series, provider: "some-other-feed", fallback: true } }),
      families
    ),
    false,
    "an observed feed flip retired a verdict whose configured source did not change"
  );
  assert.strictEqual(
    brain.needsMeasure(inst, file({ ...good, costs: { ...costs, spread: Number(costs.spread || 0) + 1 } }), families),
    true,
    "a verdict from another cost model was trusted"
  );
  assert.strictEqual(
    brain.needsMeasure(
      inst,
      file({ ...good, at: new Date(Date.now() - brain.TTL_MS - 1000).toISOString() }),
      families
    ),
    true,
    "an expired verdict was trusted"
  );
});

check("a provider or market switch changes the brain signature", () => {
  const candles = require("../server/candles");
  const a = [{ symbol: "EURUSD", candleSymbol: "EURUSD=X" }];
  const b = [{ symbol: "EURUSD", candleSymbol: "frxEURUSD" }];
  const source = candles.sourceFor(a[0].candleSymbol).source;
  const signature = brain.signatureFor(a);

  assert.strictEqual(signature, brain.signatureFor([...a]), "the same inputs produced a different signature");
  assert.ok(
    signature.includes(`${a[0].symbol}:${a[0].candleSymbol}:${source}`),
    `the signature does not carry the feed, so a switch could not re-arm it: ${signature}`
  );
  assert.notStrictEqual(
    signature,
    brain.signatureFor(b),
    "an unchanged signature would not re-arm when the feed changed"
  );
});

check("an unmeasured brain market names the input that moved", () => {
  const inst = { symbol: "EURUSD", candleSymbol: "EURUSD=X" };
  const expected = {
    series: brain.entrySeries(inst.candleSymbol),
    families: ["trend"],
    costs: brain.costModelFor(inst.symbol),
  };
  const base = {
    expected,
    rulesVersion: strategies.RULES_VERSION,
    barVersion: brain.BAR_VERSION,
    invalidatedAt: null,
  };
  const rec = (patch = {}) => ({
    at: new Date().toISOString(),
    series: expected.series,
    families: ["trend"],
    costs: expected.costs,
    ...patch,
  });
  const otherFeed = expected.series.configuredProvider === "deriv" ? "yahoo" : "deriv";

  assert.strictEqual(
    brain.whyUnmeasured({ ...base, stored: rec(), kept: rec() }),
    null,
    "a usable verdict was reported as pending"
  );
  assert.strictEqual(
    brain.whyUnmeasured({ ...base, stored: null, kept: null }),
    "never measured",
    "a market that was never measured got another reason"
  );
  assert.ok(
    /rules changed/.test(brain.whyUnmeasured({ ...base, stored: rec(), kept: null, rulesVersion: "v0" })),
    "a rules bump was not named"
  );
  assert.ok(
    /bar rules changed/.test(brain.whyUnmeasured({ ...base, stored: rec(), kept: null, barVersion: 1 })),
    "a bar-rules bump was not named"
  );

  const expired = rec({ at: new Date(Date.now() - brain.TTL_MS - 3600000).toISOString() });
  assert.ok(/h old/.test(brain.whyUnmeasured({ ...base, kept: expired })), "an expired verdict was not named");
  assert.strictEqual(
    brain.whyUnmeasured({ ...base, kept: rec(), invalidatedAt: new Date(Date.now() + 1000).toISOString() }),
    "measured before the last build change",
    "a verdict from before the last build was not named"
  );

  const noSeries = rec();
  delete noSeries.series;
  assert.strictEqual(
    brain.whyUnmeasured({ ...base, stored: noSeries }),
    "measured before the feed was recorded",
    "a verdict with no recorded feed was not named"
  );

  const feed = brain.whyUnmeasured({
    ...base,
    stored: rec({ series: { ...expected.series, configuredProvider: otherFeed } }),
  });
  assert.ok(/entry series changed/.test(feed), `feed change reason was ${feed}`);
  assert.ok(feed.includes(otherFeed), `the reason did not name the old feed: ${feed}`);
  assert.strictEqual(
    brain.whyUnmeasured({
      ...base,
      stored: rec({ series: { ...expected.series, provider: "some-other-feed", fallback: true } }),
    }),
    null,
    "an observed feed flip was reported as a reason"
  );

  // A rule promoted since the measurement is "added"; one dropped is "removed".
  const added = brain.whyUnmeasured({
    ...base,
    stored: rec(),
    expected: { ...expected, families: ["trend", "breakout"] },
  });
  assert.ok(/rule list changed \(added breakout\)/.test(added), `promotion reason was ${added}`);

  const removed = brain.whyUnmeasured({ ...base, stored: rec({ families: ["trend", "breakout"] }) });
  assert.ok(/rule list changed \(removed breakout\)/.test(removed), `removal reason was ${removed}`);

  assert.strictEqual(
    brain.whyUnmeasured({
      ...base,
      stored: rec({ costs: { ...expected.costs, spread: Number(expected.costs.spread || 0) + 1 } }),
    }),
    "cost model changed",
    "a cost change was not named"
  );
});

/* --------------------------- gate digest --------------------------- */

const NO_EDGE = {
  symbol: "XAUUSD",
  marketOpen: true,
  feedStale: false,
  newsActive: false,
  guardStop: false,
  labTradable: false,
  labVerdict: "no edge — -0.078R per trade (needs above 0.08R)",
  exploreAvailable: true,
  brainGateOn: true,
  brainCondition: "trending-volatile",
  brainChampion: null,
  brainAdjacent: null,
  chopHeld: false,
  correlatedWith: null,
  cooldownMinutes: null,
};

check("exploration turns both the lab and the proven-rule locks partly open", () => {
  const row = locks.diagnoseMarket(NO_EDGE);
  const lock = (id) => row.locks.find((l) => l.id === id);
  assert.strictEqual(lock("lab").state, "partial");
  assert.ok(/exploration only/.test(lock("lab").detail), lock("lab").detail);
  assert.strictEqual(lock("brain").state, "partial");
  assert.ok(/exploration can still take/.test(lock("brain").detail), lock("brain").detail);
  assert.strictEqual(row.state, "partial");
  assert.strictEqual(row.stoppedBy, null, "nothing hard-stops a setup while the budget is open");

  // With the day's one trade spent, the same market is genuinely held again.
  const spent = locks.diagnoseMarket({ ...NO_EDGE, exploreAvailable: false });
  assert.strictEqual(spent.locks.find((l) => l.id === "lab").state, "held");
  assert.strictEqual(spent.locks.find((l) => l.id === "brain").state, "held");
  assert.strictEqual(spent.state, "held");
  assert.strictEqual(spent.stoppedBy, "Strategy lab");
});

check("the gate digest names every market and only the gates in its way", () => {
  const rows = [
    locks.diagnoseMarket(NO_EDGE),
    locks.diagnoseMarket({ ...NO_EDGE, symbol: "GBPUSD", labTradable: true, labVerdict: "edge measured" }),
  ];
  const { messages, markets } = gatedigest.buildGateDigest({
    locks: { rows },
    now: new Date(Date.UTC(2026, 10, 23, 21)),
  });
  const text = messages.join("\n");
  assert.strictEqual(markets, 2);
  assert.ok(/XAUUSD/.test(text) && /GBPUSD/.test(text), text);
  assert.ok(/Strategy lab: no edge/.test(text), "the lab reason is the point of the digest");
  assert.ok(/exploration only/.test(text), "a partly open lab says exploration is still available");
  assert.ok(!/Market hours: open/.test(text), "gates that are not in the way are left out");
  assert.ok(/no rule is proven in trending-volatile/.test(text), text);
  assert.ok(/2 markets: 0 held · 2 partly open · 0 open/.test(text), "a market exploration can reach is not called held");
  for (const message of messages) assert.ok(message.length <= gatedigest.MAX_CHARS, "Discord limit");
});

check("the digest splits a long day into messages instead of dropping markets", () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({
    symbol: `M${i}USDT`,
    state: "held",
    locks: [{ name: "Proven rule", state: "held", detail: "no rule has been measured to work in ranging-quiet" }],
  }));
  const { messages } = gatedigest.buildGateDigest({ locks: { rows }, now: new Date() });
  assert.ok(messages.length > 1, "60 markets cannot fit in one message");
  assert.ok(messages.join("\n").includes("M59USDT"), "the last market is not lost");
  for (const message of messages) assert.ok(message.length <= gatedigest.MAX_CHARS, "Discord limit");
});

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
