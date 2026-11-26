#!/usr/bin/env node
/**
 * Quick check for the lab's evidence gate.
 *
 * A verdict is only reusable while the exact inputs it was measured with still
 * hold. These cases build one honest record and then change a single input at a
 * time; every change must make the record untested. No candles, settings or
 * state files are touched.
 */

const lab = require("../server/lab");

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

const BASE = {
  rulesVersion: lab.LAB_RULES_VERSION,
  timeframe: "15m",
  rules: { mtfFilter: true, minConfluence: 2 },
  gate: lab.gateBar(),
  cost: {
    spread: 0.0002,
    slippage: 0.00005,
    commissionPerLot: 3.5,
    valuePerUnit: 100000,
    spreadKnown: true,
    spreadSource: "model",
    slippageSource: "model",
  },
  entry: {
    ticker: "EURUSD=X",
    interval: "15m",
    range: "1y",
    configuredProvider: "deriv",
    configuredSymbol: "frxEURUSD",
    provider: "deriv",
    providerSymbol: "frxEURUSD",
    fallback: false,
    depthFallback: false,
    actualKnown: true,
    bars: 24000,
  },
  daily: {
    ticker: "EURUSD=X",
    interval: "1d",
    range: "10y",
    configuredProvider: "deriv",
    configuredSymbol: "frxEURUSD",
    provider: "deriv",
    providerSymbol: "frxEURUSD",
    fallback: false,
    depthFallback: false,
    actualKnown: true,
    bars: 3000,
  },
};

function variant(section, key, value) {
  const copy = clone(BASE);
  if (section) copy[section][key] = value;
  else copy[key] = value;
  return copy;
}

function variantMany(section, patch) {
  const copy = clone(BASE);
  Object.assign(copy[section], patch);
  return copy;
}

/** A stored lab result: the evidence plus the fields the file keeps beside it. */
function record(evidence, extra = {}) {
  return { timeframe: "15m", at: new Date().toISOString(), evidence, ...extra };
}

/** A record passes only when it still matches itself exactly. */
function accepted(stored) {
  return lab.sameEvidence(stored, BASE);
}

check("gate bar names the live thresholds", () => {
  const gate = lab.gateBar();
  assert(gate.trades === lab.MIN_TEST_TRADES, "trade minimum drifted from the gate");
  assert(gate.expectancy === lab.MIN_EXPECTANCY, "expectancy bar drifted from the gate");
  assert(gate.tStat === lab.MIN_TSTAT, "t-stat bar drifted from the gate");
  assert(gate.positiveFolds === lab.MIN_POSITIVE_FOLDS, "fold bar drifted from the gate");
  assert(gate.blocks === 3, "block count drifted from the split");
});

check("a verdict with matching evidence is reused", () => {
  assert(accepted(BASE), "identical evidence was rejected");
});

check("a missing or unreadable record is untested", () => {
  assert(!accepted(null), "missing evidence was accepted");
  assert(!accepted({}), "empty record was accepted");
  assert(!accepted({ ...clone(BASE), cost: null }), "missing cost model was accepted");
});

check("an older rule version is untested", () => {
  assert(!accepted(variant(null, "rulesVersion", "live-rules-v1")), "old version was accepted");
});

check("a different entry timeframe is untested", () => {
  assert(!accepted(variant(null, "timeframe", "5m")), "other timeframe was accepted");
  assert(!accepted(variant("entry", "interval", "5m")), "entry interval changed but passed");
});

check("a changed live filter is untested", () => {
  assert(!accepted(variant("rules", "mtfFilter", false)), "HTF filter change was accepted");
  assert(!accepted(variant("rules", "minConfluence", 3)), "confluence change was accepted");
});

check("each cost input invalidates the verdict", () => {
  assert(!accepted(variant("cost", "spread", 0.0003)), "spread change was accepted");
  assert(!accepted(variant("cost", "slippage", 0.0001)), "slippage change was accepted");
  assert(!accepted(variant("cost", "commissionPerLot", 0)), "commission change was accepted");
  assert(!accepted(variant("cost", "valuePerUnit", 1)), "contract value change was accepted");
  assert(!accepted(variant("cost", "spreadKnown", false)), "unknown spread was accepted");
  assert(!accepted(variant("cost", "spreadSource", "override")), "spread source change was accepted");
  assert(!accepted(variant("cost", "slippageSource", "override")), "slippage source change was accepted");
});

check("an entry series from another provider, symbol or range is untested", () => {
  assert(!accepted(variant("entry", "configuredProvider", "oanda")), "provider change was accepted");
  assert(!accepted(variant("entry", "configuredSymbol", "EUR_USD")), "symbol change was accepted");
  assert(!accepted(variant("entry", "range", "60d")), "range change was accepted");
  assert(!accepted(variant("entry", "ticker", "GBPUSD=X")), "ticker change was accepted");
});

check("an entry series that fell back is untested", () => {
  assert(!accepted(variant("entry", "fallback", true)), "feed fallback was accepted");
  assert(!accepted(variant("entry", "depthFallback", true)), "depth fallback on entries was accepted");
  assert(!accepted(variant("entry", "actualKnown", false)), "unknown actual source was accepted");
  assert(!accepted(variant("entry", "bars", 0)), "empty entry series was accepted");
  assert(!accepted(variant("entry", "bars", lab.MIN_TEST_TRADES)), "short entry series was accepted");
});

check("a daily series from another provider or symbol is untested", () => {
  assert(!accepted(variant("daily", "configuredProvider", "oanda")), "daily provider change was accepted");
  assert(!accepted(variant("daily", "configuredSymbol", "EUR_USD")), "daily symbol change was accepted");
  assert(!accepted(variant("daily", "range", "2y")), "daily range change was accepted");
  assert(!accepted(variant("daily", "fallback", true)), "daily feed fallback was accepted");
  assert(!accepted(variant("daily", "actualKnown", false)), "unknown daily source was accepted");
});

check("the daily depth fallback is allowed only when recorded", () => {
  const yahooDaily = variantMany("daily", {
    provider: "yahoo",
    providerSymbol: "EURUSD=X",
    depthFallback: true,
  });
  assert(accepted(yahooDaily), "recorded Yahoo daily depth fallback was rejected");
  const silent = variantMany("daily", { provider: "yahoo", providerSymbol: "EURUSD=X" });
  assert(!accepted(silent), "unrecorded Yahoo daily series was accepted");
  const confused = variantMany("daily", { provider: "deriv", depthFallback: true });
  assert(!accepted(confused), "depth fallback without Yahoo was accepted");
});

check("a changed gate threshold is untested", () => {
  assert(!accepted(variant("gate", "trades", 50)), "trade minimum change was accepted");
  assert(!accepted(variant("gate", "expectancy", 0.05)), "expectancy change was accepted");
  assert(!accepted(variant("gate", "tStat", 1.5)), "t-stat change was accepted");
  assert(!accepted(variant("gate", "positiveFolds", 1)), "fold change was accepted");
  assert(!accepted(variant("gate", "blocks", 4)), "block change was accepted");
});

check("a market with no usable verdict is stale, a fresh one is not", () => {
  const now = Date.now();
  const fresh = { timeframe: "15m", at: new Date(now - 1000).toISOString() };
  const old = { timeframe: "15m", at: new Date(now - lab.RESULT_TTL_MS - 1000).toISOString() };
  assert(!lab.isStale({ results: { EURUSD: fresh } }, { symbol: "EURUSD" }, "15m", now), "a fresh verdict was called stale");
  assert(lab.isStale({ results: {} }, { symbol: "EURUSD" }, "15m", now), "a missing verdict was called fresh");
  assert(lab.isStale({ results: { EURUSD: old } }, { symbol: "EURUSD" }, "15m", now), "an expired verdict was called fresh");
  assert(
    lab.isStale({ results: { EURUSD: { ...fresh, timeframe: "5m" } } }, { symbol: "EURUSD" }, "15m", now),
    "a verdict from another timeframe was called fresh"
  );
});

check("a provider switch changes the entry-series signature", () => {
  const deriv = [{ symbol: "EURUSD", provider: "deriv", providerSymbol: "frxEURUSD" }];
  const yahoo = [{ symbol: "EURUSD", provider: "yahoo", providerSymbol: "EURUSD=X" }];
  assert(
    lab.seriesSignature(deriv) !== lab.seriesSignature(yahoo),
    "switching the feed left the signature unchanged, so no market would re-measure"
  );
  assert(
    lab.seriesSignature(deriv) === lab.seriesSignature([...deriv]),
    "the same inputs produced a different signature"
  );
});

check("an unmeasured market names the input that moved", () => {
  const expected = clone(BASE);
  const base = { expected, rulesVersion: lab.LAB_RULES_VERSION, timeframe: "15m" };

  assert(
    lab.whyUnmeasured({ ...base, stored: record(BASE), kept: record(BASE) }) === null,
    "a usable verdict was reported as pending"
  );
  assert(
    lab.whyUnmeasured({ ...base, stored: null, kept: null }) === "never measured",
    "a market that was never measured got another reason"
  );
  assert(
    /rules changed/.test(
      lab.whyUnmeasured({ ...base, stored: record(BASE), kept: null, rulesVersion: "live-rules-v1" })
    ),
    "a rules bump was not named"
  );
  assert(
    /measured on 5m/.test(
      lab.whyUnmeasured({ ...base, stored: record(BASE, { timeframe: "5m" }), kept: null })
    ),
    "a verdict from another timeframe was not named"
  );

  const rangeChanged = lab.whyUnmeasured({
    ...base,
    stored: record(variant("entry", "range", "60d")),
    kept: null,
  });
  assert(/entry series changed/.test(rangeChanged), `range change reason was ${rangeChanged}`);
  assert(/60d/.test(rangeChanged) && /1y/.test(rangeChanged), `reason did not name both ranges: ${rangeChanged}`);

  const feedChanged = lab.whyUnmeasured({
    ...base,
    stored: record(variant("entry", "configuredProvider", "yahoo")),
    kept: null,
  });
  assert(/entry series changed/.test(feedChanged), `feed change reason was ${feedChanged}`);
  assert(/yahoo/.test(feedChanged), `reason did not name the old feed: ${feedChanged}`);

  assert(
    lab.whyUnmeasured({ ...base, stored: record(variant("cost", "spread", 0.0009)), kept: null }) ===
      "cost model changed",
    "a cost change was not named"
  );
  assert(
    lab.whyUnmeasured({ ...base, stored: record(variant("rules", "mtfFilter", false)), kept: null }) ===
      "live filters changed",
    "a live-filter change was not named"
  );
  assert(
    lab.whyUnmeasured({ ...base, stored: record(variant("gate", "tStat", 1.5)), kept: null }) ===
      "gate thresholds changed",
    "a gate change was not named"
  );

  const expired = lab.whyUnmeasured({
    ...base,
    stored: record(BASE),
    kept: record(BASE, { at: new Date(Date.now() - lab.RESULT_TTL_MS - 3600000).toISOString() }),
  });
  assert(/h old/.test(expired), `an expired verdict got reason ${expired}`);
});

if (failures) {
  console.log(`\n${failures} check${failures === 1 ? "" : "s"} failed`);
  process.exitCode = 1;
} else {
  console.log("\nall lab evidence checks passed");
}
