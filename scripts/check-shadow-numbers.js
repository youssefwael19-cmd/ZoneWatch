/*
 * Scratch check, not part of the app: once the shadow book has closes, do
 * daily recap line and the public /api/money strip report the same money?
 *
 * It fabricates a shadow ledger (gitignored files, restored afterwards), boots
 * the real server on a spare port and compares what each surface says.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FILES = ["settings.json", "shadow.json", "executor.json"];
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
// maxPositions: 0 keeps the server this check boots from opening a real shadow
// trade while the assertions run: this check is about the arithmetic on a
// fixed ledger, and a live watch cycle would add its own position to it.
settings.setExecConfig({ enabled: true, mode: "paper", accountBalance: 200, riskPct: 0.5, maxDailyLossPct: 2, maxPositions: 0 });
const config = settings.getExecConfig();
check("local exec enabled", config.enabled, true);
check("local exec mode", config.mode, "paper");

// ---- a shadow ledger with three closes today, one yesterday and one open ----
const now = new Date();
const dayKey = now.toISOString().slice(0, 10);
const hoursAgo = (h) => new Date(now.getTime() - h * 3600 * 1000).toISOString();
// Anchor "today" between midnight UTC and now, so a check run at 01:00 UTC does
// not put this morning's fabricated closes on the wrong side of the day line.
const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const elapsed = Math.max(now.getTime() - dayStart, 4);
const todayAt = (frac) => new Date(dayStart + Math.floor(elapsed * frac)).toISOString();

const todayClosed = [
  { id: "s1", symbol: "EURUSD", side: "BUY", lots: 0.01, entry: 1.08, stop: 1.079, target: 1.082, valuePerUnit: 100000, openedAt: todayAt(0.1), closedAt: todayAt(0.3), grossPnl: 2, cost: 0.02, pnl: 1.98, outcome: "win" },
  { id: "s2", symbol: "AUDJPY", side: "SELL", lots: 0.0004, entry: 95.5, stop: 95.65, target: 95.2, valuePerUnit: 100000, openedAt: todayAt(0.2), closedAt: todayAt(0.5), grossPnl: -1.05, cost: 0.02, pnl: -1.07, outcome: "loss" },
  { id: "s3", symbol: "EURUSD", side: "BUY", lots: 0.005, entry: 1.078, stop: 1.077, target: 1.08, valuePerUnit: 100000, openedAt: todayAt(0.4), closedAt: todayAt(0.7), grossPnl: -0.5, cost: 0.01, pnl: -0.51, outcome: "loss" },
];
const yesterdayClosed = [
  { id: "s0", symbol: "USDJPY", side: "BUY", lots: 0.0004, entry: 150, stop: 149.9, target: 150.2, valuePerUnit: 100000, openedAt: hoursAgo(28), closedAt: new Date(dayStart - 3600 * 1000).toISOString(), grossPnl: 0.8, cost: 0.02, pnl: 0.78, outcome: "win" },
];
const openPosition = {
  id: "s4", symbol: "EURUSD", side: "BUY", lots: 0.01, entry: 1.08, signalEntry: 1.08, stop: 1.05, target: 1.2,
  valuePerUnit: 100000, cost: 0.01, openedAt: hoursAgo(2), heldReason: "no champion", condition: "trending-quiet", setup: "signal",
};
const allClosed = [...todayClosed, ...yesterdayClosed];
const dayRealized = Number(todayClosed.reduce((a, c) => a + c.pnl, 0).toFixed(2));
const balance = Number((200 + allClosed.reduce((a, c) => a + c.pnl, 0)).toFixed(2));

fs.writeFileSync(path.join(ROOT, "shadow.json"), JSON.stringify({
  balance,
  open: [openPosition],
  closed: allClosed,
  dayKey,
  dayRealized,
  killedAt: null,
  killReason: null,
  spreads: {},
  lastAt: hoursAgo(1),
}, null, 2));

const money = (v) => `${(Number(v) || 0) < 0 ? "-" : ""}$${Math.abs(Number(v) || 0).toFixed(2)}`;
const signed = (v) => `${(Number(v) || 0) > 0 ? "+" : ""}${money(v)}`;

// ---- boot the real server and ask it ----
const PORT = 8107;
const child = spawn(process.execPath, ["server/index.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (b) => (log += b));
child.stderr.on("data", (b) => (log += b));

async function get(p) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

(async () => {
  let watch = null;
  for (let i = 0; i < 30 && !watch; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { watch = await get("/api/watch"); } catch {}
  }
  if (!watch) throw new Error("server never answered on " + PORT + "\n" + log.slice(-800));

  const prices = new Map();
  for (const q of watch.json.quotes || []) if (q.price != null) prices.set(q.symbol, Number(q.price));

  const shadowMod = require("../server/shadow");
  const expected = shadowMod.status(prices);
  console.log("\nshadow.status():", JSON.stringify({
    balance: expected.balance, equity: expected.equity, dayRealized: expected.dayRealized,
    dayClosed: expected.dayClosed, dayWins: expected.dayWins, dayLosses: expected.dayLosses,
    openCount: expected.openCount, closedCount: expected.closedCount,
  }));

  check("dayRealized is today's closes only", expected.dayRealized, dayRealized);
  check("dayClosed counts only today", expected.dayClosed, 3);
  check("dayWins", expected.dayWins, 1);
  check("dayLosses", expected.dayLosses, 2);
  check("closedCount is all time", expected.closedCount, 4);
  check("openCount", expected.openCount, 1);
  check("balance is all-time", expected.balance, balance);

  const moneyRes = await get("/api/money");
  check("/api/money HTTP", moneyRes.status, 200);
  const m = moneyRes.json.shadow;
  check("strip enabled", m.enabled, true);
  check("strip equity == shadow.status equity", m.equity, expected.equity);
  check("strip dayRealized == shadow.status", m.dayRealized, expected.dayRealized);
  check("strip dayClosed == shadow.status", m.dayClosed, expected.dayClosed);
  check("strip dayWins == shadow.status", m.dayWins, expected.dayWins);
  check("strip dayLosses == shadow.status", m.dayLosses, expected.dayLosses);
  check("strip openCount == shadow.status", m.openCount, expected.openCount);
  check("strip closedCount == shadow.status", m.closedCount, expected.closedCount);
  check("strip killSwitch == shadow.status", m.killSwitch, expected.killSwitch);
  check("strip balance == shadow.status balance", m.balance, expected.balance);

  // Leaks: the public strip must not carry config, bridge hints or account data.
  const keys = Object.keys(m).sort();
  check("strip exposes only totals", keys, [
    "balance", "closedCount", "dayClosed", "dayLosses", "dayRealized", "dayRealizedPct",
    "dayWins", "enabled", "equity", "killReason", "killSwitch", "mode", "openCount",
  ].sort());
  const whole = JSON.stringify(m);
  for (const secret of ["bridge", "config", "login", "server", "secret", "account"]) {
    check(`/api/money body has no "${secret}"`, whole.toLowerCase().includes(secret), false);
  }

  // ---- the daily recap line ----
  const recap = require("../server/dailyrecap");
  const text = recap.fromApp({
    journal: { sent: 3, held: 4 },
    exec: { enabled: true, mode: "paper", equity: 200, dayRealized: 0, openCount: 0, closedCount: 0, dayClosed: 0 },
    shadow: expected,
    history: [],
    openTrades: 0,
    proven: ["EURUSD", "AUDJPY"],
    live: { zones: [], nearest: {}, quotes: [], feed: {} },
  });
  const line = text.split("\n").find((l) => l.startsWith("Shadow, gate-rejected:")) || "";
  console.log("\nrecap shadow line:\n" + line + "\n");
  checkText("recap has the shadow line", text, "Shadow, gate-rejected:");
  checkText("recap equity matches", line, `equity ${money(expected.equity)}`);
  checkText("recap today matches", line, `today ${signed(expected.dayRealized)}`);
  checkText("recap record matches", line, `${expected.dayWins}W/${expected.dayLosses}L`);
  checkText("recap open count matches", line, `${expected.openCount} open`);
  checkText("recap closed count matches", line, `${expected.closedCount} closed all time`);
  checkText("recap shows best/worst of today", line, "best ");

  // ---- a killed shadow book and a quiet one ----
  const quietText = recap.fromApp({
    journal: {},
    exec: { enabled: true, mode: "paper", equity: 200 },
    shadow: { ...expected, openCount: 0, closedCount: 0, dayClosed: 0, dayRealized: 0, equity: 200 },
    live: {},
  });
  check("recap omits the shadow line before its first trade", quietText.includes("Shadow, gate-rejected:"), false);
  const quietMoney = await get("/api/money");
  check("strip still flags the shadow book as running", quietMoney.json.shadow.enabled, true);

  console.log(`\n${passed} passed, ${failed} failed`);
  child.kill("SIGTERM");
  restore();
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error("CHECK CRASHED:", err && err.stack || err);
  try { child.kill("SIGTERM"); } catch {}
  restore();
  process.exit(2);
});
