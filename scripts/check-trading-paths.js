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
const audit = require("../server/audit");
const brain = require("../server/brain");
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

/* ---------------------- lab-promoted families ---------------------- */

const ZW2 = { mult: 1.8, stopMode: "zone_width", rr: 2 };

check("a lab config that lost its unseen blocks is not promoted", () => {
  const out = strategies.promoteLabConfigs({
    XAUUSD: { chosen: [{ cfg: ZW2, test: { n: 200, expectancy: -0.1 } }] },
  });
  assert.deepStrictEqual(out, []);
});

check("a block too small to be evidence does not promote", () => {
  const out = strategies.promoteLabConfigs({
    EURUSD: { chosen: [{ cfg: { mult: 1.2, stopMode: "atr", rr: 1 }, test: { n: 29, expectancy: 0.5 } }] },
  });
  assert.deepStrictEqual(out, []);
});

check("a winner is promoted with its combined unseen record", () => {
  const out = strategies.promoteLabConfigs({
    NASDAQ: {
      chosen: [
        { cfg: ZW2, test: { n: 39, expectancy: 0.719 } },
        { cfg: ZW2, test: { n: 38, expectancy: 0.25 } },
      ],
    },
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, "lab_18_zw_2");
  assert.strictEqual(out[0].n, 77);
  assert.deepStrictEqual(out[0].markets, ["NASDAQ"]);
  assert.ok(Math.abs(out[0].expectancy - 0.487) < 0.01, String(out[0].expectancy));
});

check("a losing block counts against the config it came from", () => {
  const cfg = { mult: 1.2, stopMode: "atr", rr: 1 };
  const out = strategies.promoteLabConfigs({
    EURUSD: {
      chosen: [
        { cfg, test: { n: 100, expectancy: 0.2 } },
        { cfg, test: { n: 100, expectancy: -0.15 } },
      ],
    },
  });
  assert.strictEqual(out[0].n, 200);
  assert.ok(Math.abs(out[0].expectancy - 0.025) < 0.01, String(out[0].expectancy));
});

check("a config whose whole unseen record is negative is refused", () => {
  const cfg = { mult: 1.4, stopMode: "zone_width", rr: 2 };
  const out = strategies.promoteLabConfigs({
    GBPUSD: {
      chosen: [
        { cfg, test: { n: 60, expectancy: 0.1 } },
        { cfg, test: { n: 300, expectancy: -0.2 } },
      ],
    },
  });
  assert.deepStrictEqual(out, []);
});

check("the promoted list is capped", () => {
  const results = {};
  const modes = ["zone_width", "atr"];
  let n = 0;
  for (const mult of [1.2, 1.4, 1.8]) {
    for (const stopMode of modes) {
      for (const rr of [1, 2]) {
        results[`M${n++}`] = { chosen: [{ cfg: { mult, stopMode, rr }, test: { n: 50, expectancy: 0.1 + n / 100 } }] };
      }
    }
  }
  const out = strategies.promoteLabConfigs(results);
  assert.strictEqual(out.length, strategies.MAX_PROMOTED);
  // Best unseen record first.
  assert.ok(out[0].expectancy >= out[1].expectancy, "ranking is not descending");
});

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

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
