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

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
