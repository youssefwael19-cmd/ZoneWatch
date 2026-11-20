#!/usr/bin/env node
/**
 * Local end-to-end check for "chop yields to proof".
 *
 * The chop rule refuses scalps in a ranging-volatile tape because that
 * combination lost three for three while nothing was proven. A measured proof
 * in that exact tape is the one thing that should lift it — and a proof from
 * the neighbouring condition should not, because the rule is about the pace of
 * the tape, not about trend character.
 *
 * Three markets, all stored as ranging-volatile, differing only in the brain:
 *   GBPUSD  no champion anywhere            → scalp refused, journal says why
 *   USDCHF  proven in ranging-volatile      → released, posted as a signal
 *   USDJPY  proven in ranging-quiet only    → still refused (borrowed proof)
 *
 * Nothing in the real workspace is touched: the app runs from a copy in /tmp.
 *
 *   node scripts/check-chop-proof.js
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TMP = "/tmp/zone-watch-chop-check";
const PORT = 8119;
const HOOK_PORT = 9913;
const HOOK_URL = `http://127.0.0.1:${HOOK_PORT}/webhook/test`;
const APP_URL = `http://127.0.0.1:${PORT}`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (url) => (await fetch(url)).json();

function copyWorkspace() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  for (const entry of fs.readdirSync(ROOT)) {
    if ([".git", "artifacts", "shots"].includes(entry)) continue;
    fs.cpSync(path.join(ROOT, entry), path.join(TMP, entry), { recursive: true });
  }
  for (const stale of [
    "journal.json",
    "learning.json",
    "alerts.json",
    "executor.json",
    "shadow.json",
    "dailyrecap.json",
    "state.json",
    "heartbeat.json",
    "settings.json",
    "zones.json",
    "brain.json",
    "signals.json",
    "lab.json",
  ]) {
    fs.rmSync(path.join(TMP, stale), { force: true });
  }
}

/**
 * Deterministic candles that end on a finished up bar, so the reaction
 * confirmation passes and the chop rule is the only thing being tested.
 */
function stubCandles() {
  const stub = `
const cache = new Map();

function synthetic(ticker) {
  const hit = cache.get(ticker);
  if (hit) return hit;
  const bars = [];
  let price = 1.1;
  for (let i = 0; i < 240; i++) {
    const drift = 0.00002 + Math.sin(i / 9) * 0.0004;
    const open = price;
    let close = price + drift;
    // The last two bars are unambiguously up: a finished green bar is what the
    // entry confirmation requires, and this check is about chop, not about it.
    if (i >= 238) close = open + 0.0006;
    bars.push({
      t: Date.now() - (240 - i) * 300000,
      o: open,
      h: Math.max(open, close) + 0.0004,
      l: Math.min(open, close) - 0.0006,
      c: close,
      v: 0,
    });
    price = close;
  }
  cache.set(ticker, bars);
  return bars;
}

async function getCandles(ticker) {
  return synthetic(ticker);
}

function clearCache() {
  cache.clear();
}

module.exports = { getCandles, clearCache };
`;
  fs.writeFileSync(path.join(TMP, "server", "candles.js"), stub);
}

function writeFixtures() {
  const settings = {
    discordWebhook: HOOK_URL,
    autoZones: true,
    signalAlerts: true,
    approachAlerts: false,
    ivbAlerts: false,
    sessionAlerts: false,
    alertOnlyWhenOpen: false,
    correlationEnabled: false,
    quietHours: { enabled: false, from: 22, to: 7 },
    brainGate: true,
    unprovenMarkets: [],
    markets: { GBPUSD: true, USDCHF: true, USDJPY: true },
    trading: { newsBlackout: false, mtfFilter: false, minConfluence: 0 },
    exec: {
      enabled: true,
      mode: "paper",
      accountBalance: 200,
      riskPct: 3,
      maxDailyLossPct: 2,
      maxPositions: 2,
      leverage: 2000,
      requireGate: true,
    },
  };
  fs.writeFileSync(path.join(TMP, "settings.json"), JSON.stringify(settings, null, 2));

  const now = new Date().toISOString();
  const champion = {
    family: "momentum",
    familyName: "Momentum (EMA 20/50 cross)",
    n: 41,
    expectancy: 0.39,
    winrate: 46.3,
    tStat: 1.65,
    goodFolds: 3,
  };
  const cell = (label) => ({
    at: now,
    current: { label, efficiency: 0.2, volatilityPercentile: 0.5, asOf: now },
    champions: {},
  });

  const brain = {
    updatedAt: now,
    results: {
      // Nothing proven: the chop rule is the one holding this back.
      GBPUSD: cell("ranging-volatile"),
      // Proven in the exact tape it is trading — chop should stand aside. All
      // four cells carry the champion so the fresh condition the gate reads
      // cannot land on an empty one and confuse the test.
      USDCHF: (() => {
        const r = cell("ranging-volatile");
        for (const label of ["trending-volatile", "trending-quiet", "ranging-quiet", "ranging-volatile"]) {
          r.champions[label] = champion;
        }
        return r;
      })(),
      // Proven only in the neighbouring condition: not enough to lift chop.
      USDJPY: (() => {
        const r = cell("ranging-volatile");
        r.champions["ranging-quiet"] = champion;
        return r;
      })(),
    },
  };
  fs.writeFileSync(path.join(TMP, "brain.json"), JSON.stringify(brain, null, 2));

  // The lab is a separate gate that can silence a market on its own. These
  // three are marked tradable so the only thing under test is the chop rule.
  const lab = {
    updatedAt: now,
    results: Object.fromEntries(
      ["GBPUSD", "USDCHF", "USDJPY"].map((symbol) => [
        symbol,
        { symbol, at: now, tradable: true, verdict: "edge: fixture" },
      ])
    ),
  };
  fs.writeFileSync(path.join(TMP, "lab.json"), JSON.stringify(lab, null, 2));

  const zone = (symbol, low, high) => ({
    id: `manual-${symbol}-demand`,
    symbol,
    type: "demand",
    low,
    high,
    label: `Manual ${symbol} demand`,
    notes: "wide test zone",
    alertDistance: 0.0001,
    active: true,
    source: "manual",
    createdAt: now,
  });
  const zones = [
    zone("GBPUSD", 1.0, 1.5),
    zone("USDCHF", 0.5, 1.1),
    zone("USDJPY", 100, 200),
  ];
  fs.writeFileSync(path.join(TMP, "zones.json"), JSON.stringify(zones, null, 2));
}

function startHook() {
  const posts = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        posts.push(JSON.parse(body));
      } catch {
        posts.push({ raw: body });
      }
      res.writeHead(204).end();
    });
  });
  return new Promise((resolve) => server.listen(HOOK_PORT, "127.0.0.1", () => resolve({ server, posts })));
}

function startApp() {
  const log = fs.openSync(path.join(TMP, "app.log"), "w");
  return spawn(process.execPath, ["server/index.js"], {
    cwd: TMP,
    env: { ...process.env, PORT: String(PORT), WATCH_INTERVAL_MS: "10000" },
    stdio: ["ignore", log, log],
  });
}

async function waitForHealth(timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${APP_URL}/api/health`);
      if (res.ok) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

async function main() {
  copyWorkspace();
  stubCandles();
  writeFixtures();

  const { server: hook, posts } = await startHook();
  const app = startApp();
  let failed = false;

  try {
    check("app boots", await waitForHealth(), `dumped to ${TMP}/app.log`);
    await sleep(3000);

    const watch = await getJson(`${APP_URL}/api/watch`);
    check("watch cycle returned quotes", (watch.quotes || []).length > 0, `${(watch.quotes || []).length} quotes`);
    check(
      "the three test markets produced a signal to judge",
      (watch.signals || []).some((s) => ["GBPUSD", "USDCHF", "USDJPY"].includes(s.symbol)),
      (watch.signals || []).map((s) => `${s.symbol}/${s.side}`).join(", ") || "none"
    );

    const journal = await getJson(`${APP_URL}/api/journal`);
    const rows = journal.recent || [];
    const rowFor = (symbol) => rows.find((r) => r.symbol === symbol);
    const heldReason = (symbol) => (rowFor(symbol) || {}).heldReason || "";
    const statusOf = (symbol) => (rowFor(symbol) || {}).status || "missing";

    // Even if the market never reached a zone in this short run, the parse of
    // the brain file decides the chop set; report what actually happened.
    check(
      "GBPUSD scalp in ranging-volatile is held for chop",
      statusOf("GBPUSD") === "held" && /ranging-volatile/.test(heldReason("GBPUSD")),
      `${statusOf("GBPUSD")}: ${heldReason("GBPUSD").slice(0, 90)}`
    );
    check(
      "USDCHF, proven in that exact tape, is released instead of chop-held",
      statusOf("USDCHF") !== "missing" && !/ranging-volatile/.test(heldReason("USDCHF")),
      `${statusOf("USDCHF")}: ${heldReason("USDCHF").slice(0, 90)}`
    );
    check(
      "USDJPY, proven only next door, is still chop-held",
      statusOf("USDJPY") === "held" && /ranging-volatile/.test(heldReason("USDJPY")),
      `${statusOf("USDJPY")}: ${heldReason("USDJPY").slice(0, 90)}`
    );

    // Signal embeds only: zone-touch alerts share the channel and are not
    // what this check is about.
    const titles = posts
      .flatMap((p) => p.embeds || [])
      .map((e) => e.title || "")
      .filter((t) => /BUY|SELL/.test(t));
    check(
      "the released setup actually reaches Discord",
      titles.some((t) => /BUY/.test(t) && /USDCHF/.test(t)),
      titles.join(" | ") || "no embeds"
    );
    check(
      "neither chop-held market is posted",
      !titles.some((t) => /GBPUSD|USDJPY/.test(t)),
      titles.join(" | ") || "no embeds"
    );

    failed = results.some((r) => !r.ok);
  } catch (err) {
    console.error("harness error:", err.message);
    failed = true;
  } finally {
    app.kill("SIGKILL");
    hook.close();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed} passed, ${results.length - passed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
