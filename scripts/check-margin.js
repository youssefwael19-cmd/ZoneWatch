/*
 * Scratch check, not part of the app: does paper trading model margin?
 *
 * Fabricates a $200 paper account, places orders at a few leverages, and reads
 * the same status the Trading panel uses. The point is that a $200 account
 * cannot paper its way into a position it could not hold at that leverage.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FILES = ["settings.json", "executor.json"];
const backup = {};
for (const f of FILES) {
  const p = path.join(ROOT, f);
  backup[f] = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}
function restore() {
  for (const f of FILES) {
    const p = path.join(ROOT, f);
    if (backup[f] == null) {
      try {
        fs.unlinkSync(p);
      } catch {}
    } else fs.writeFileSync(p, backup[f]);
  }
}

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name} = ${JSON.stringify(actual)}${ok ? "" : "  expected " + JSON.stringify(expected)}`
  );
  if (ok) passed++;
  else failed++;
}
function near(name, actual, expected, tolerance = 0.02) {
  const ok = Number.isFinite(Number(actual)) && Math.abs(Number(actual) - expected) <= tolerance;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} = ${actual}${ok ? "" : `  expected ≈ ${expected}`}`);
  if (ok) passed++;
  else failed++;
}
function contains(name, haystack, needle) {
  const ok = String(haystack).includes(needle);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${JSON.stringify(needle)}${ok ? " present" : " MISSING in: " + haystack}`);
  if (ok) passed++;
  else failed++;
}

const settings = require("../server/settings");
settings.setExecConfig({
  enabled: true,
  mode: "paper",
  accountBalance: 200,
  riskPct: 0.5,
  maxDailyLossPct: 2,
  maxPositions: 5,
  leverage: 2000,
  requireGate: true,
});
// A clean $200 ledger for this run only.
fs.writeFileSync(path.join(ROOT, "executor.json"), JSON.stringify({ balance: 200, open: [], closed: [] }));

const executor = require("../server/executor");
const prices = { EURUSD: 1.085, GBPUSD: 1.27, XAUUSD: 3767, USDJPY: 156, AUDJPY: 100 };
const gate = { blocked: false, condition: "ranging-quiet", verdict: null };

async function run() {
  console.log("--- leverage 1:2000 ---");
  const fx = await executor.place(
    { symbol: "EURUSD", side: "BUY", entry: 1.085, stop: 1.0845, target: 1.086, gate },
    prices
  );
  check("FX order accepted", fx.ok, true);
  near("FX lots", fx.order.lots, 0.02, 0.0001);
  near("FX notional = lots × 100000 × price", fx.order.notional, 0.02 * 100000 * 1.085, 0.05);
  near("FX margin = notional / 2000", fx.order.margin, fx.order.notional / 2000, 0.011);
  check("FX order remembers the leverage", fx.order.leverage, 2000);

  let status = executor.status(prices);
  near("margin used = open position margin", status.margin.used, fx.order.margin, 0.011);
  near("free margin = equity − used", status.margin.free, status.equity - status.margin.used, 0.011);
  check("margin leverage reported", status.margin.leverage, 2000);

  console.log("--- a real $200 account at 1:1 cannot hold it ---");
  settings.setExecConfig({ leverage: 1 });
  const tooBig = await executor.place(
    { symbol: "GBPUSD", side: "SELL", entry: 1.27, stop: 1.2705, target: 1.269, gate },
    prices
  );
  check("order refused at 1:1", tooBig.ok, false);
  contains("refusal names free margin", tooBig.reason, "not enough free margin");
  contains("refusal names the leverage", tooBig.reason, "1:1");
  check("refused order is not on the book", executor.status(prices).openCount, 1);

  console.log("--- stored margin does not move when leverage changes ---");
  const before = executor.status(prices).margin.used;
  settings.setExecConfig({ leverage: 2000 });
  near("used margin is the one reserved at entry", executor.status(prices).margin.used, before, 0.001);

  console.log("--- gold and yen pairs ---");
  const gold = await executor.place(
    { symbol: "XAUUSD", side: "SELL", entry: 3767, stop: 3772, target: 3757, gate },
    prices
  );
  check("gold order accepted", gold.ok, true);
  near("gold notional = 100 oz × lots × price", gold.order.notional, 100 * gold.order.lots * 3767, 0.05);
  near("gold margin = notional / 2000", gold.order.margin, gold.order.notional / 2000, 0.011);

  const jpy = await executor.place(
    { symbol: "USDJPY", side: "BUY", entry: 156, stop: 155.95, target: 156.1, gate },
    prices
  );
  check("USDJPY order accepted", jpy.ok, true);
  near("USD-base notional is already dollars", jpy.order.notional, 100000 * jpy.order.lots, 0.05);

  const cross = await executor.place(
    { symbol: "AUDJPY", side: "BUY", entry: 100, stop: 99.95, target: 100.1, gate },
    prices
  );
  check("AUDJPY order accepted", cross.ok, true);
  near(
    "JPY cross notional is converted to USD",
    cross.order.notional,
    (100000 * cross.order.lots * 100) / 156,
    0.05
  );

  status = executor.status(prices);
  near(
    "margin used sums every open position",
    status.margin.used,
    fx.order.margin + gold.order.margin + jpy.order.margin + cross.order.margin,
    0.05
  );
  near("free margin never goes negative here", status.margin.free, status.equity - status.margin.used, 0.02);

  console.log("--- margin call ---");
  const openedAt = new Date().toISOString();
  const makePos = (over) => ({
    id: `${over.symbol}-test`,
    symbol: over.symbol,
    side: over.side || "BUY",
    lots: over.lots || 0.02,
    entry: over.entry,
    stop: over.stop,
    target: over.target,
    valuePerUnit: over.valuePerUnit || 100000,
    cost: 0,
    openedAt,
    margin: over.margin,
    notional: over.notional,
    leverage: over.leverage,
  });
  const writeLedger = (balance, open) =>
    fs.writeFileSync(path.join(ROOT, "executor.json"), JSON.stringify({ balance, open, closed: [] }));

  // Floating losses have eaten the account: equity below the reserved margin.
  // The stop is never reached: the account runs out of margin first, which is
  // exactly the case a stop cannot protect against.
  writeLedger(200, [
    makePos({ symbol: "EURUSD", entry: 1.085, stop: 1.05, target: 1.2, margin: 2170, notional: 2170, leverage: 2000 }),
  ]);
  let out = executor.mark({ EURUSD: 1.075 });
  check("margin call closes the position", out.closed.length, 1);
  check("close is labelled a margin call", out.closed[0].marginCall, true);
  contains("close reason names the call", out.closed[0].closeReason, "margin call");
  contains("close reason carries the numbers", out.closed[0].closeReason, "below margin used");
  check("nothing left open", executor.status({ EURUSD: 1.075 }).openCount, 0);
  check("balance took the loss", executor.status({ EURUSD: 1.075 }).balance < 200, true);

  // Room to spare: equity covers the margin, so nothing is sold.
  writeLedger(200, [
    makePos({ symbol: "EURUSD", entry: 1.085, stop: 1.08, target: 1.1, margin: 1.08, notional: 2170, leverage: 2000 }),
  ]);
  out = executor.mark({ EURUSD: 1.0849 });
  check("healthy position is not stopped out", out.closed.length, 0);
  check("healthy position stays open", executor.status({ EURUSD: 1.0849 }).openCount, 1);

  // Worst loss first, and it stops as soon as the margin is covered again.
  writeLedger(300, [
    makePos({ symbol: "AAA", entry: 100, stop: 50, target: 200, lots: 1, valuePerUnit: 1, margin: 100, notional: 100 }),
    makePos({ symbol: "BBB", entry: 100, stop: 50, target: 200, lots: 1, valuePerUnit: 1, margin: 100, notional: 100 }),
    makePos({ symbol: "CCC", entry: 100, stop: 50, target: 200, lots: 1, valuePerUnit: 1, margin: 100, notional: 100 }),
  ]);
  out = executor.mark({ AAA: 80, BBB: 95, CCC: 99 });
  check("only the worst loss is closed", out.closed.length, 1);
  check("worst loss is the one closed", out.closed[0].symbol, "AAA");
  check("the rest stay open", executor.status({ AAA: 80, BBB: 95, CCC: 99 }).openCount, 2);

  console.log("--- settings clamp ---");
  settings.setExecConfig({ leverage: 999999 });
  check("leverage is clamped to 3000", settings.getExecConfig().leverage, 3000);
  settings.setExecConfig({ leverage: 0 });
  check("leverage cannot go below 1", settings.getExecConfig().leverage, 1);

  restore();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

run().catch((err) => {
  restore();
  console.error(err);
  process.exitCode = 1;
});
