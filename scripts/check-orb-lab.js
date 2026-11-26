#!/usr/bin/env node
/**
 * Check the NASDAQ opening-range breakout research family.
 *
 * These cases use synthetic 5m bars only: no candles, settings or state files
 * are touched. They pin the parts that would silently change the evidence —
 * session grouping, the opening range, the first-close entry, the midpoint
 * stop, the flat-at-close exit, no look-ahead, and the fact that a research
 * verdict cannot enter the live family list.
 */

const lab = require("../server/lab");
const strategies = require("../server/strategies");

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const SPAN = 5 * 60 * 1000;

function at(date, minutes) {
  return Date.parse(`${date}T00:00:00Z`) + minutes * 60000;
}

/**
 * A complete cash session. The first three slots are the opening range; slot 3
 * is the first post-range bar; every later slot uses `after`; the actual last
 * slot is the flat-at-close bar. `endSlot` and `omitSlot` make deliberately
 * incomplete sessions.
 */
function session({
  date,
  open,
  close,
  rangeHigh = 110,
  rangeLow = 99,
  entry = { o: 106, h: 112, l: 105, c: 111 },
  after = { o: 111, h: 112, l: 110, c: 111 },
  lastClose = 112,
  endSlot = null,
  omitSlot = null,
}) {
  const lastSlot = endSlot == null ? Math.round((close - open) / 5) - 1 : endSlot;
  const bars = [];
  for (let slot = 0; slot <= lastSlot; slot++) {
    if (slot === omitSlot) continue;
    const t = at(date, open) + slot * SPAN;
    let bar;
    if (slot === 0) bar = { o: 100, h: 105, l: rangeLow, c: 104 };
    else if (slot === 1) bar = { o: 104, h: rangeHigh, l: 103, c: 108 };
    else if (slot === 2) bar = { o: 108, h: 109, l: 104, c: 106 };
    else if (slot === 3) bar = entry;
    else if (slot === lastSlot) bar = { ...after, o: after.o == null ? 111 : after.o, c: lastClose };
    else bar = { ...after, o: after.o == null ? 111 : after.o };
    bars.push({ t, ...bar, v: 0 });
  }
  return bars;
}

const NORMAL = { date: "2026-06-02", open: 810, close: 1200 };
const EARLY = { date: "2026-11-27", open: 870, close: 1080 };
const HOLIDAY = { date: "2026-11-26", open: 870, close: 1260 };

check("a complete session makes one trade at the first close outside the range", () => {
  const out = lab.orbTradesFromBars(session(NORMAL));
  assert(out.groups.length === 1, `expected one session, got ${out.groups.length}`);
  assert(out.trades.length === 1, `expected one trade, got ${out.trades.length}`);
  const trade = out.trades[0];
  assert(trade.side === "BUY", `expected BUY, got ${trade.side}`);
  assert(trade.entry === 111, `expected entry 111, got ${trade.entry}`);
  assert(trade.stop === 104.5, `expected midpoint stop 104.5, got ${trade.stop}`);
  assert(trade.target === 117.5, `expected 1R target 117.5, got ${trade.target}`);
  assert(trade.outcome === "close", `expected flat close, got ${trade.outcome}`);
  assert(trade.bars === 74, `expected 74 bars held, got ${trade.bars}`);
  assert(Math.abs(trade.r - 0.154) < 0.001, `expected +0.154R, got ${trade.r}`);
});

check("costs are charged on the flat-at-close exit", () => {
  const out = lab.orbTradesFromBars(session(NORMAL), {
    spread: 1.5,
    slippage: 0.375,
    commissionPerLot: 0.5,
    valuePerUnit: 1,
  });
  const trade = out.trades[0];
  assert(trade.outcome === "close", `expected close, got ${trade.outcome}`);
  assert(trade.r < trade.grossR, "net R did not fall below gross R");
  assert(trade.totalCostR > 0, "costs were not recorded");
});

check("a target hit wins with no flat close", () => {
  const out = lab.orbTradesFromBars(
    session({ ...NORMAL, after: { o: 111, h: 118, l: 110, c: 112 } })
  );
  const trade = out.trades[0];
  assert(trade.outcome === "win", `expected win, got ${trade.outcome}`);
  assert(trade.r === 1, `expected 1R, got ${trade.r}`);
  assert(trade.bars === 1, `expected a one-bar hold, got ${trade.bars}`);
});

check("a stop hit loses, and a bar touching both is read as the stop", () => {
  const out = lab.orbTradesFromBars(
    session({ ...NORMAL, after: { o: 111, h: 118, l: 104, c: 112 } })
  );
  const trade = out.trades[0];
  assert(trade.outcome === "loss", `expected loss, got ${trade.outcome}`);
  assert(trade.r === -1, `expected -1R, got ${trade.r}`);
});

check("a downside breakout uses the same midpoint stop and 1R target", () => {
  const out = lab.orbTradesFromBars(
    session({
      ...NORMAL,
      entry: { o: 101, h: 102, l: 98, c: 98.5 },
      after: { o: 98.5, h: 100, l: 92, c: 95 },
    })
  );
  const trade = out.trades[0];
  assert(trade.side === "SELL", `expected SELL, got ${trade.side}`);
  assert(trade.entry === 98.5, `expected entry 98.5, got ${trade.entry}`);
  assert(trade.stop === 104.5, `expected midpoint stop 104.5, got ${trade.stop}`);
  assert(trade.target === 92.5, `expected 1R target 92.5, got ${trade.target}`);
  assert(trade.outcome === "win", `expected win, got ${trade.outcome}`);
});

check("a range with no breakout produces no trade", () => {
  const out = lab.orbTradesFromBars(
    session({
      ...NORMAL,
      entry: { o: 106, h: 109, l: 105, c: 108 },
      after: { o: 108, h: 109, l: 105, c: 108 },
      lastClose: 108,
    })
  );
  assert(out.trades.length === 0, `expected no trades, got ${out.trades.length}`);
  assert(out.noBreakout === 1, `expected one no-breakout session, got ${out.noBreakout}`);
});

check("an unfinished session is skipped instead of closed early", () => {
  const out = lab.orbTradesFromBars(session({ ...NORMAL, endSlot: 20 }));
  assert(out.trades.length === 0, `expected no trades, got ${out.trades.length}`);
  assert(out.incomplete === 1, `expected one incomplete session, got ${out.incomplete}`);
});

check("a session missing an opening-range bar is skipped", () => {
  const out = lab.orbTradesFromBars(session({ ...NORMAL, omitSlot: 1 }));
  assert(out.trades.length === 0, `expected no trades, got ${out.trades.length}`);
  assert(out.incomplete === 1, `expected one incomplete session, got ${out.incomplete}`);
});

check("a market holiday has no session and no trade", () => {
  const out = lab.orbTradesFromBars(session(HOLIDAY));
  assert(out.groups.length === 0, `expected no session, got ${out.groups.length}`);
  assert(out.trades.length === 0, `expected no trades, got ${out.trades.length}`);
});

check("an early-close session flattens at its own last bar", () => {
  const out = lab.orbTradesFromBars(session(EARLY));
  assert(out.groups.length === 1, `expected one early session, got ${out.groups.length}`);
  const trade = out.trades[0];
  assert(trade.outcome === "close", `expected close, got ${trade.outcome}`);
  assert(trade.bars === 38, `expected 38 bars to the early close, got ${trade.bars}`);
  assert(trade.session === "2026-11-27T14:30:00.000Z", `wrong session: ${trade.session}`);
});

check("the existing gate is the only gate and fails closed", () => {
  assert(lab.gateReasons({ n: 100, expectancy: 0.2 }, 2.5, 2).length === 0, "a passing record was rejected");
  assert(lab.gateReasons({ n: 99, expectancy: 0.2 }, 2.5, 2).length > 0, "99 trades passed");
  assert(lab.gateReasons({ n: 100, expectancy: 0.08 }, 2.5, 2).length > 0, "0.08R passed the strict bar");
  assert(lab.gateReasons({ n: 100, expectancy: 0.2 }, 1.99, 2).length > 0, "t<2 passed");
  assert(lab.gateReasons({ n: 100, expectancy: 0.2 }, 2.5, 1).length > 0, "one positive block passed");
});

const BASE = {
  kind: "research",
  family: lab.ORB_FAMILY,
  familyVersion: lab.ORB_RULES_VERSION,
  timeframe: lab.ORB_TIMEFRAME,
  rule: { ...lab.ORB_RULE },
  gate: lab.gateBar(),
  cost: {
    spread: 1.5,
    slippage: 0.375,
    commissionPerLot: 0.5,
    valuePerUnit: 1,
    spreadKnown: true,
    spreadSource: "model",
    slippageSource: "model",
  },
  entry: {
    ticker: "^NDX",
    interval: "5m",
    range: "2y",
    configuredProvider: "deriv",
    configuredSymbol: "OTC_NDX",
    provider: "deriv",
    providerSymbol: "OTC_NDX",
    fallback: false,
    depthFallback: false,
    actualKnown: true,
    bars: 39000,
  },
};

function variant(section, key, value) {
  const copy = clone(BASE);
  if (section) copy[section][key] = value;
  else copy[key] = value;
  return copy;
}

function accepted(stored) {
  return lab.sameResearchEvidence(stored, BASE);
}

check("matching ORB evidence is reused", () => {
  assert(accepted(BASE), "identical research evidence was rejected");
});

check("a rule, timeframe or family change is untested", () => {
  assert(!accepted(variant("rule", "targetR", 2)), "a changed target was accepted");
  assert(!accepted(variant("rule", "exit", "hold")), "a changed exit was accepted");
  assert(!accepted(variant(null, "timeframe", "15m")), "a changed timeframe was accepted");
  assert(!accepted(variant(null, "familyVersion", "orb-v0")), "an old family version was accepted");
  assert(!accepted(variant(null, "kind", "live")), "a live record was accepted as research");
});

check("a cost, gate or series change is untested", () => {
  assert(!accepted(variant("cost", "spread", 2)), "a spread change was accepted");
  assert(!accepted(variant("cost", "slippage", 0.5)), "a slippage change was accepted");
  assert(!accepted(variant("cost", "spreadKnown", false)), "an unknown spread was accepted");
  assert(!accepted(variant("gate", "trades", 50)), "a gate change was accepted");
  assert(!accepted(variant("entry", "range", "60d")), "a range change was accepted");
  assert(!accepted(variant("entry", "configuredProvider", "yahoo")), "a provider change was accepted");
  assert(!accepted(variant("entry", "fallback", true)), "a fallback feed was accepted");
  assert(!accepted(variant("entry", "actualKnown", false)), "an unknown source was accepted");
  assert(!accepted(variant("entry", "bars", lab.MIN_TEST_TRADES)), "a short series was accepted");
});

check("ORB is not in the live strategy family list", () => {
  assert(
    !strategies.FAMILIES.some((family) => family.id === lab.ORB_FAMILY),
    "the ORB family leaked into the brain's live family list"
  );
});

if (failures) {
  console.log(`\n${failures} check${failures === 1 ? "" : "s"} failed`);
  process.exitCode = 1;
} else {
  console.log("\nall ORB lab checks passed");
}
