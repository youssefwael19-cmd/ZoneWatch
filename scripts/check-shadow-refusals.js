/*
 * Scratch check, not part of the app: does the shadow book record the setups
 * it could not size, instead of dropping them silently?
 *
 * Fabricates a gate-held setup whose stop is far too wide for a $200 balance,
 * runs one cycle, then reads the ledger and the status the panel uses.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FILES = ["settings.json", "shadow.json"];
const backup = {};
for (const f of FILES) {
  const p = path.join(ROOT, f);
  backup[f] = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}
function restore() {
  for (const f of FILES) {
    const p = path.join(ROOT, f);
    if (backup[f] == null) {
      try { fs.unlinkSync(p); } catch {}
    } else fs.writeFileSync(p, backup[f]);
  }
}

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} = ${JSON.stringify(actual)}${ok ? "" : "  expected " + JSON.stringify(expected)}`);
  if (ok) passed++; else failed++;
}
function checkText(name, haystack, needle) {
  const ok = String(haystack).includes(needle);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${JSON.stringify(needle)}${ok ? " present" : " MISSING in: " + haystack}`);
  if (ok) passed++; else failed++;
}

const settings = require("../server/settings");
settings.setExecConfig({ enabled: true, mode: "paper", accountBalance: 200, riskPct: 0.5, maxDailyLossPct: 2, maxPositions: 2 });
const shadow = require("../server/shadow");

// No ledger to begin with, apart from the starting balance.
fs.writeFileSync(path.join(ROOT, "shadow.json"), JSON.stringify({ balance: 200, open: [], closed: [] }));

const prices = { XAUUSD: 2400, EURUSD: 1.085 };
const wide = {
  signal: {
    symbol: "XAUUSD",
    side: "BUY",
    entry: 2400,
    stop: 2200, // 200 points = $200 per 0.0001 lot at $100/point/0.01 lot
    target: 2800,
    confidence: "signal",
  },
  reason: "no champion for XAUUSD in a trending-quiet market",
  condition: "trending-quiet",
};
const narrow = {
  signal: { symbol: "EURUSD", side: "BUY", entry: 1.085, stop: 1.0845, target: 1.086, confidence: "signal" },
  reason: "no champion for EURUSD in a ranging-quiet market",
  condition: "ranging-quiet",
};

const first = shadow.cycle([wide], prices);
check("refused setup opens no position", first.open, 0);

let ledger = JSON.parse(fs.readFileSync(path.join(ROOT, "shadow.json"), "utf8"));
check("refusal recorded", ledger.refusals.length, 1);
check("refusal symbol", ledger.refusals[0].symbol, "XAUUSD");
check("refusal side", ledger.refusals[0].side, "BUY");
check("refusal carries the gate reason", ledger.refusals[0].heldReason, wide.reason);
checkText("refusal explains the size", ledger.refusals[0].reason, "above the 0.5% limit");

// The same setup arrives again next cycle: one line, not one per tick.
shadow.cycle([wide], prices);
shadow.cycle([wide], prices);
ledger = JSON.parse(fs.readFileSync(path.join(ROOT, "shadow.json"), "utf8"));
check("repeat cycles do not duplicate the refusal", ledger.refusals.length, 1);

// A setup that sizes normally still trades, and is not logged as a refusal.
shadow.cycle([narrow], prices);
ledger = JSON.parse(fs.readFileSync(path.join(ROOT, "shadow.json"), "utf8"));
check("sizable setup still opens", ledger.open.length, 1);
check("sizable setup adds no refusal", ledger.refusals.length, 1);

const status = shadow.status(prices);
check("status refusedToday", status.refusedToday, 1);
check("status refusedCount", status.refusedCount, 1);
check("status exposes latest refusal", status.refusals[0].symbol, "XAUUSD");

// The daily recap must not read as the whole story either.
const recap = require("../server/dailyrecap");
const recapText = recap.fromApp({
  journal: { sent: 0, held: 0 },
  exec: { enabled: true, mode: "paper", equity: 200, dayRealized: 0, openCount: 0, closedCount: 0 },
  shadow: status,
  live: {},
});
const recapLine = recapText.split("\n").find((l) => l.startsWith("Shadow, gate-rejected:")) || "";
checkText("recap notes the skipped setup", recapLine, "1 setup skipped by sizing");
const quietRecap = recap.fromApp({
  journal: {},
  exec: { enabled: true, mode: "paper", equity: 200 },
  shadow: { ...status, openCount: 0, closedCount: 0, dayClosed: 0, dayRealized: 0, refusedToday: 0 },
  live: {},
});
check("recap stays quiet with nothing to report", quietRecap.includes("Shadow, gate-rejected:"), false);

// A ledger written before this field existed must still load and report zero.
fs.writeFileSync(path.join(ROOT, "shadow.json"), JSON.stringify({ balance: 200, open: [], closed: [] }));
check("old ledger reports no refusals", shadow.status(prices).refusedToday, 0);

restore();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
