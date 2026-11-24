/*
 * Scratch check, not part of the app: does the tracker store the exit path and
 * does the audit turn it into the 1R/target and trail comparison honestly?
 *
 * Builds four signals with known bar paths in a temporary state folder, resolves
 * them through the real tracker, and reads the same audit the Journal tab uses.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zw-exit-audit-"));
process.env.STATE_DIR = dir;
// Point the state files at the temporary folder *before* the tracker resolves
// its file path, and do not carry any existing ledger into it.
require("../server/stateDir").prepare({ dir, root: dir });
const tracker = require("../server/signaltracker");

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} = ${JSON.stringify(actual)}${ok ? "" : "  expected " + JSON.stringify(expected)}`);
  if (ok) passed++; else failed++;
}

const t0 = Date.UTC(2026, 0, 2, 10, 0, 0);
const at = (minutes) => t0 + minutes * 60 * 1000;
const bar = (t, o, h, l) => ({ t, o, h, l, c: o });
const bars = {};
const prices = new Map();

function add(symbol, price = 100) {
  tracker.add({
    symbol,
    side: "BUY",
    price,
    entry: price,
    stop: 90,
    target: 120,
    confidence: "signal",
    riskReward: 2,
    at: new Date(t0).toISOString(),
    zone: { low: 99, high: 101, type: "demand" },
  });
  prices.set(symbol, price);
}

// 1. Runs to the target. Best excursion 2R, never worse than -0.05R.
add("EURUSD");
bars.EURUSD = [bar(at(0), 100, 105, 99.5), bar(at(5), 105, 111, 100), bar(at(10), 111, 121, 110)];

// 2. Reaches +1R, trails to break-even, then comes back to the entry stop.
add("GBPUSD");
bars.GBPUSD = [bar(at(0), 100, 111, 100), bar(at(5), 100, 101, 99)];

// 3. Runs to +1.6R, the trail protects +1.1R, and a fixed stop would have lost.
add("USDJPY");
bars.USDJPY = [bar(at(0), 100, 116, 100), bar(at(5), 111, 112, 110), bar(at(10), 110, 111, 89)];

// 4. Never reaches +1R and hits the opening stop.
add("AUDUSD");
bars.AUDUSD = [bar(at(0), 100, 105, 99), bar(at(5), 99, 100, 89)];

tracker.update(prices, at(40), { barsFor: (symbol) => bars[symbol] });

const history = tracker.load().history;
const bySymbol = (symbol) => history.find((h) => h.symbol === symbol);

const eur = bySymbol("EURUSD");
check("target trade resolved as a win", eur.outcome, "win");
check("target trade records MFE 2R", eur.mfeR, 2);
check("target trade records MAE -0.05R", eur.maeR, -0.05);
check("target trade records that the target was touched", eur.targetHit, true);
check("target trade records when 1R was reached", eur.minutesTo1R, 5);
check("target trade records time to exit", eur.heldMinutes, 10);
check("target trade records the fixed-stop counterfactual", eur.noTrailR, 2);

const gbp = bySymbol("GBPUSD");
check("1R-then-break-even trade is labelled break-even", gbp.outcome, "breakeven");
check("1R-then-break-even records MFE 1.1R", gbp.mfeR, 1.1);
check("1R-then-break-even records the trail moved", gbp.trailMoved, true);
check("no fixed-stop answer when that path never resolved", gbp.noTrailR, null);

const jpy = bySymbol("USDJPY");
check("trail-protected trade closes at +1.1R", jpy.rMultiple, 1.1);
check("trail-protected trade never reaches the target", jpy.targetHit, false);
check("trail-protected MFE is 1.6R", jpy.mfeR, 1.6);
check("fixed stop on the same path loses 1R", jpy.noTrailR, -1);

const aud = bySymbol("AUDUSD");
check("opening-stop trade loses 1R", aud.rMultiple, -1);
check("opening-stop trade never reached 1R", aud.mfeR, 0.5);
check("opening-stop MAE is -1R", aud.maeR, -1);
check("opening-stop trade did not trail", aud.trailMoved, false);

let audit = tracker.exitAudit();
check("audit measures every closed trade", audit.measured, 4);
check("audit counts 1R reaches", audit.reached1R.n, 3);
check("audit gives the 1R rate", audit.reached1R.pct, 75);
check("of those, one went on to the target", audit.after1R.target, 1);
check("of those, one won on the trail", audit.after1R.trailedWin, 1);
check("of those, one came back to break-even", audit.after1R.breakeven, 1);
check("of those, none stopped", audit.after1R.stopped, 0);
check("one never reached 1R", audit.neverReached1R, 1);
check("target hit count", audit.target.n, 1);
check("trail was engaged on three trades", audit.trail.engaged, 3);
check("three trades have a fixed-stop pair", audit.trail.pairs, 3);
check("the trail helped one", audit.trail.helped, 1);
check("the trail hurt none", audit.trail.hurt, 0);
check("the rest were unchanged", audit.trail.same, 2);
check("paired actual R", audit.trail.actualR, 2.1);
check("paired no-trail R", audit.trail.noTrailR, 0);
check("trail delta", audit.trail.deltaR, 2.1);

// A row written before this audit existed must be excluded, not counted as zero.
const file = path.join(dir, "signals.json");
const state = JSON.parse(fs.readFileSync(file, "utf8"));
state.history.push({ id: "old", symbol: "NZDUSD", side: "BUY", outcome: "win", rMultiple: 1.5, heldMinutes: 60 });
fs.writeFileSync(file, JSON.stringify(state));
audit = tracker.exitAudit();
check("older rows are excluded from the measured sample", audit.measured, 4);
check("but still counted as closed", audit.closed, 5);
check("the exclusion is reported", audit.excluded, 1);

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
