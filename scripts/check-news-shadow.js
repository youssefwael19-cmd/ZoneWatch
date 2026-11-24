/*
 * Scratch check, not part of the app: does a setup a news blackout silenced get
 * priced by the shadow book, and is it kept apart from the gate's refusals?
 *
 * Runs the real shadow module against a temporary ledger, then reads the same
 * status the panel uses.
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

try {
  const settings = require("../server/settings");
  settings.setExecConfig({
    enabled: true,
    mode: "paper",
    accountBalance: 500,
    riskPct: 0.5,
    maxDailyLossPct: 2,
    dailyStop: false,
    maxPositions: 3,
  });
  const shadow = require("../server/shadow");

  fs.writeFileSync(path.join(ROOT, "shadow.json"), JSON.stringify({ balance: 500, open: [], closed: [], dayKey: null, dayRealized: 0 }));

  const prices = { EURUSD: 1.085, GBPUSD: 1.27, XAUUSD: 2400 };

  const news = {
    signal: { symbol: "EURUSD", side: "BUY", entry: 1.085, stop: 1.0845, target: 1.086, confidence: "signal" },
    reason: "news blackout (CPI m/m)",
    condition: null,
    newsBlocked: true,
  };
  shadow.cycle([news], prices);

  let ledger = JSON.parse(fs.readFileSync(path.join(ROOT, "shadow.json"), "utf8"));
  check("a blackout-held setup opens in the shadow book", ledger.open.length, 1);
  check("the fill is labelled as news-blocked", ledger.open[0].newsBlocked, true);
  check("the fill names the event that held it", ledger.open[0].heldReason, news.reason);

  let status = shadow.status(prices);
  check("status counts the news trade apart from the gate's", status.news.open, 1);
  check("the news record starts empty", status.news.closed, 0);

  const gate = {
    signal: { symbol: "GBPUSD", side: "BUY", entry: 1.27, stop: 1.2695, target: 1.271, confidence: "signal" },
    reason: "no champion for GBPUSD in a ranging-quiet market",
    condition: "ranging-quiet",
  };
  shadow.cycle([gate], prices);
  status = shadow.status(prices);
  check("a gate refusal is not counted as news", status.news.open, 1);
  check("both reasons are still priced", status.openCount, 2);

  const wide = {
    signal: { symbol: "XAUUSD", side: "BUY", entry: 2400, stop: 1900, target: 2800, confidence: "signal" },
    reason: "news blackout (NFP)",
    condition: null,
    newsBlocked: true,
  };
  shadow.cycle([wide], prices);
  ledger = JSON.parse(fs.readFileSync(path.join(ROOT, "shadow.json"), "utf8"));
  const refusal = (ledger.refusals || []).find((r) => r.symbol === "XAUUSD");
  check("a news setup too wide to size is recorded, not dropped", Boolean(refusal), true);
  check("the refusal keeps the news label", refusal && refusal.newsBlocked, true);

  const now = new Date().toISOString();
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "shadow.json"), "utf8"));
  base.open = [];
  base.closed = [
    { id: "n1", symbol: "EURUSD", side: "BUY", lots: 0.01, entry: 1.085, riskMoney: 5, valuePerUnit: 100000, heldReason: "news blackout (CPI m/m)", newsBlocked: true, pnl: 10, outcome: "win", closedAt: now },
    { id: "g1", symbol: "GBPUSD", side: "BUY", lots: 0.01, entry: 1.27, riskMoney: 5, valuePerUnit: 100000, heldReason: "no champion", newsBlocked: false, pnl: -5, outcome: "loss", closedAt: now },
  ];
  fs.writeFileSync(path.join(ROOT, "shadow.json"), JSON.stringify(base));

  status = shadow.status(prices);
  check("closed news trades are counted separately", status.news.closed, 1);
  check("their money is summed", status.news.pnl, 10);
  check("wins are counted", status.news.wins, 1);
  check("losses are counted", status.news.losses, 0);
} finally {
  restore();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
