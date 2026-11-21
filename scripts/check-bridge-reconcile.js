/*
 * Scratch check, not part of the app: does bridge mode settle a trade where the
 * terminal closed it, instead of where a local quote says it should?
 *
 * Stands a fake MT5 bridge on localhost that answers /positions, /closed,
 * /order and /modify, then drives the executor through the cases that used to
 * diverge from the account:
 *   - price crosses the stop while the terminal still holds the position
 *   - the terminal closes it, with a gap through the stop
 *   - a position opened before the app kept the position ticket
 *   - the bridge is unreachable
 *   - the trailing stop amends the position ticket the terminal knows
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "zw-bridge-"));
const stateDir = require("../server/stateDir");
stateDir.prepare({ dir: DIR, root: DIR });

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

// --- the fake terminal ----------------------------------------------------
const TOKEN = "test-secret-long-enough";
let positions = [];
let deals = [];
let orderTicket = 50000;
let positionTicket = 777000;
let amendBodies = [];
let closedCalls = 0;

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const url = new URL(req.url, "http://localhost");
    const send = (code, payload) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.headers["x-bridge-token"] !== TOKEN) {
      send(401, { ok: false, error: "bad or missing token" });
      return;
    }
    if (url.pathname === "/positions") {
      send(200, { ok: true, positions });
      return;
    }
    if (url.pathname === "/closed") {
      closedCalls += 1;
      send(200, { ok: true, deals });
      return;
    }
    if (url.pathname === "/order") {
      const body = JSON.parse(raw || "{}");
      orderTicket += 1;
      positionTicket += 1;
      positions.push({
        ticket: positionTicket,
        symbol: body.symbol,
        side: body.side,
        lots: body.lots,
        entry: 2400,
        sl: body.sl,
        tp: body.tp,
        profit: 0,
      });
      send(200, { ok: true, ticket: orderTicket, position: positionTicket, price: 2400, lots: body.lots });
      return;
    }
    if (url.pathname === "/modify") {
      const body = JSON.parse(raw || "{}");
      amendBodies.push(body);
      const held = positions.find((p) => String(p.ticket) === String(body.ticket));
      if (!held) {
        send(404, { ok: false, error: "no open position for that ticket" });
        return;
      }
      held.sl = body.sl;
      send(200, { ok: true, ticket: held.ticket, sl: held.sl });
      return;
    }
    send(404, { ok: false, error: "unknown path" });
  });
});

async function run() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const settings = require("../server/settings");
  settings.setExecConfig({
    enabled: true,
    mode: "bridge",
    accountBalance: 10000,
    riskPct: 0.5,
    maxDailyLossPct: 50,
    maxPositions: 5,
    requireGate: true,
    bridgeUrl: `http://127.0.0.1:${port}`,
    bridgeSecret: TOKEN,
  });

  const executor = require("../server/executor");
  const prices = { XAUUSD: 2400 };
  const gate = { blocked: false, condition: "trending", verdict: null };

  console.log("--- placing through the bridge ---");
  const placed = await executor.place(
    { symbol: "XAUUSD", side: "BUY", entry: 2400, stop: 2390, target: 2420, gate },
    prices
  );
  check("order accepted", placed.ok, true);
  check("order ticket kept", placed.order.bridgeOrderTicket, 50001);
  check("position ticket kept", placed.order.bridgePositionTicket, "777001");
  const lots = placed.order.lots;

  console.log("--- price crosses the stop, terminal still holds it ---");
  let out = executor.mark({ XAUUSD: 2375 });
  check("mark does not settle locally", out.closed.length, 0);
  check("position stays on the book", executor.status(prices).openCount, 1);
  near("floating is still marked", executor.status().open[0].floating, (2375 - 2400) * lots * 100 - placed.order.cost, 0.05);

  console.log("--- reconcile while the terminal holds it ---");
  let rec = await executor.reconcile({ XAUUSD: 2375 });
  check("nothing closed", rec.closed.length, 0);
  check("position still open", executor.status(prices).openCount, 1);
  check("deal history is not fetched while nothing is gone", closedCalls, 0);

  console.log("--- terminal closed it with a gap through the stop ---");
  positions = [];
  deals = [
    {
      ticket: 90001,
      position: 777001,
      symbol: "XAUUSDm",
      volume: lots,
      price: 2387.25,
      profit: -370.5,
      commission: 0,
      swap: 0,
      reason: "stop loss",
      time: new Date().toISOString(),
    },
  ];
  rec = await executor.reconcile({ XAUUSD: 2375 });
  check("one position closed", rec.closed.length, 1);
  check("booked at the terminal's fill, not the stop or the quote", rec.closed[0].exit, 2387.25);
  check("exit is labelled as the broker's deal", rec.closed[0].exitSource, "broker-deal");
  check("deal reason is kept", rec.closed[0].brokerDeal.reason, "stop loss");
  contains("note says where it closed", rec.closed[0].note, "stop loss");
  check("position left the book", executor.status(prices).openCount, 0);
  check("outcome is a loss", rec.closed[0].outcome, "loss");
  near(
    "balance moved by the booked result",
    executor.status(prices).balance,
    10000 + rec.closed[0].pnl,
    0.011
  );

  console.log("--- a position opened before the app kept the position ticket ---");
  const legacy = await executor.place(
    { symbol: "XAUUSD", side: "BUY", entry: 2400, stop: 2390, target: 2420, gate },
    prices
  );
  check("second order accepted", legacy.ok, true);
  const ledgerFile = path.join(DIR, "executor.json");
  let ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  delete ledger.open[0].bridgePositionTicket;
  ledger.open[0].bridgeTicket = legacy.order.bridgeOrderTicket;
  ledger.open[0].openedAt = new Date(Date.now() - 3600000).toISOString();
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
  positions = [];
  deals = [
    {
      ticket: 90002,
      position: 777002,
      symbol: "XAUUSDm",
      volume: lots,
      price: 2419.5,
      profit: 300,
      commission: 0,
      swap: 0,
      reason: "take profit",
      time: new Date().toISOString(),
    },
  ];
  rec = await executor.reconcile({ XAUUSD: 2419.5 });
  check("matched by broker symbol", rec.closed.length, 1);
  check("booked the take-profit fill", rec.closed[0].exit, 2419.5);
  check("outcome is a win", rec.closed[0].outcome, "win");

  console.log("--- the bridge cannot be reached ---");
  const third = await executor.place(
    { symbol: "XAUUSD", side: "SELL", entry: 2400, stop: 2410, target: 2380, gate },
    prices
  );
  check("third order accepted", third.ok, true);
  settings.setExecConfig({ bridgeUrl: "http://127.0.0.1:1" });
  rec = await executor.reconcile({ XAUUSD: 2380 });
  check("nothing is closed on a guess", rec.closed.length, 0);
  contains("the failure is reported", rec.error, "bridge unreachable");
  check("position survives an unreachable bridge", executor.status(prices).openCount, 1);
  settings.setExecConfig({ bridgeUrl: `http://127.0.0.1:${port}` });

  console.log("--- the trailing stop amends the position the terminal holds ---");
  positions = [
    { ticket: 777003, symbol: "XAUUSDm", side: "SELL", lots, entry: 2400, sl: 2410, tp: 2380, profit: 0 },
  ];
  amendBodies = [];
  const trailed = await executor.trailStops({ XAUUSD: 2385 });
  check("one stop moved", trailed.moved.length, 1);
  check("amendment went to the position ticket", String(amendBodies[0].ticket), "777003");
  check("1.5R on a 10-point risk holds +1R", trailed.moved[0].stop, 2390);
  check("the app records the broker's stop", executor.status().open[0].stop, 2390);

  console.log("--- the broker's stop drifts away from the app's ---");
  // The trail was recorded at 2390, and then the terminal put its old stop back
  // (or the amendment never landed). The app must not keep believing 2390.
  positions = [{ ticket: 777003, symbol: "XAUUSDm", side: "SELL", lots, entry: 2400, sl: 2410, tp: 2380, profit: 0 }];
  rec = await executor.reconcile({ XAUUSD: 2385 });
  check("the drift does not close the position", rec.closed.length, 0);
  check("one stop mismatch is reported", rec.stopDrift, 1);
  let drift = executor.status().stopDrift;
  check("the panel lists it", drift.length, 1);
  check("the app's stop is kept", drift[0].appStop, 2390);
  check("the broker's stop is kept", drift[0].brokerStop, 2410);
  check("a looser broker stop reads as behind", drift[0].direction, "behind");
  check("the open position carries the broker's stop", executor.status().open[0].brokerStop, 2410);
  const onDisk = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  check("the mismatch is written to the ledger, not just held in memory", onDisk.open[0].stopMismatch.broker, 2410);

  console.log("--- the broker takes the stop, and the mismatch clears ---");
  positions[0].sl = 2390;
  rec = await executor.reconcile({ XAUUSD: 2385 });
  check("no drift once the broker holds the app's stop", executor.status().stopDrift.length, 0);
  check("the broker's stop is still recorded", executor.status().open[0].brokerStop, 2390);

  console.log("--- a position the broker holds with no stop ---");
  positions[0].sl = 0;
  await executor.reconcile({ XAUUSD: 2385 });
  drift = executor.status().stopDrift;
  check("a missing broker stop is a mismatch", drift.length, 1);
  check("it reads as no stop at all", drift[0].direction, "none");
  positions[0].sl = 2390;
  await executor.reconcile({ XAUUSD: 2385 });
  check("and clears when the stop is back", executor.status().stopDrift.length, 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
  server.close();
  fs.rmSync(DIR, { recursive: true, force: true });
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  server.close();
});
