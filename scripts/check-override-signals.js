#!/usr/bin/env node
/**
 * Local end-to-end check for the override list.
 *
 * The Settings tab promises "Always send signals for these markets, even when
 * blocked". This boots a copy of the app against a fake Discord webhook, plants
 * a manual zone that the current price sits inside, and checks that BUY/SELL
 * alerts are actually posted for:
 *   - EURUSD: the lab found an edge, the brain gate refuses the condition, so
 *     the alert goes out but no order is placed.
 *   - AUDUSD: the brain gate approves the condition, so the alert goes out and
 *     the signal reaches the paper executor.
 *
 * Nothing in the real workspace is touched: the app runs from a copy in /tmp.
 *
 *   node scripts/check-override-signals.js
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TMP = "/tmp/zone-watch-override-check";
const PORT = 8107;
const HOOK_PORT = 9911;
const HOOK_URL = `http://127.0.0.1:${HOOK_PORT}/webhook/test`;
const APP_URL = `http://127.0.0.1:${PORT}`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

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
  ]) {
    fs.rmSync(path.join(TMP, stale), { force: true });
  }
}

// Yahoo's chart endpoint is not reachable from every sandbox, and the point of
// this check is delivery, not candle fetching. Feed deterministic bars instead.
function stubCandles() {
  const stub = `
const CACHE_TTL_MS = 3 * 60 * 1000;
const cache = new Map();

function synthetic(ticker) {
  const key = ticker + "|" + "fixed";
  const hit = cache.get(key);
  if (hit) return hit;
  const bars = [];
  let price = 1.1;
  for (let i = 0; i < 240; i++) {
    const drift = Math.sin(i / 9) * 0.0004 + 0.00002;
    const open = price;
    const close = price + drift;
    bars.push({
      t: Date.now() - (240 - i) * 300000,
      o: open,
      h: Math.max(open, close) + 0.0004,
      l: Math.min(open, close) - 0.0004,
      c: close,
      v: 0,
    });
    price = close;
  }
  cache.set(key, bars);
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
    unprovenMarkets: ["EURUSD", "AUDUSD"],
    markets: { EURUSD: true, AUDUSD: true },
    trading: { newsBlackout: false, mtfFilter: false, minConfluence: 0 },
    exec: {
      enabled: true,
      mode: "paper",
      accountBalance: 200,
      // The fixture zone is deliberately wide, so the smallest lot risks more
      // than 0.5% would allow; 3% lets the approved setup reach the book.
      riskPct: 3,
      maxDailyLossPct: 2,
      maxPositions: 2,
      leverage: 2000,
      requireGate: true,
    },
  };
  fs.writeFileSync(path.join(TMP, "settings.json"), JSON.stringify(settings, null, 2));

  const now = new Date().toISOString();
  // A measured champion for AUDUSD (all four conditions, so the stubbed candles
  // cannot land on a cell without one), and none for EURUSD.
  const champion = {
    family: "momentum",
    familyName: "Momentum (EMA 20/50 cross)",
    n: 41,
    expectancy: 0.39,
    winrate: 46.3,
    tStat: 1.65,
  };
  const brain = {
    updatedAt: now,
    results: {
      AUDUSD: {
        at: now,
        current: { label: "trending-volatile", efficiency: 0.2, volatilityPercentile: 0.5, asOf: now },
        champions: {
          "trending-volatile": champion,
          "trending-quiet": champion,
          "ranging-quiet": champion,
          "ranging-volatile": champion,
        },
      },
      EURUSD: {
        at: now,
        current: { label: "trending-volatile", efficiency: 0.2, volatilityPercentile: 0.5, asOf: now },
        champions: {},
      },
    },
  };
  fs.writeFileSync(path.join(TMP, "brain.json"), JSON.stringify(brain, null, 2));
  const zones = [
    {
      id: "manual-eurusd-demand",
      symbol: "EURUSD",
      type: "demand",
      low: 1.0,
      high: 1.3,
      label: "Manual EURUSD demand",
      notes: "wide test zone",
      alertDistance: 0.0001,
      active: true,
      source: "manual",
      createdAt: now,
    },
    {
      id: "manual-audusd-demand",
      symbol: "AUDUSD",
      type: "demand",
      low: 0.6,
      high: 0.8,
      label: "Manual AUDUSD demand",
      notes: "wide test zone",
      alertDistance: 0.0001,
      active: true,
      source: "manual",
      createdAt: now,
    },
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
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: TMP,
    env: { ...process.env, PORT: String(PORT), WATCH_INTERVAL_MS: "10000" },
    stdio: ["ignore", log, log],
  });
  return child;
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

    const watch = await getJson(`${APP_URL}/api/watch`);
    check("watch cycle returned quotes", (watch.quotes || []).length > 0, `${(watch.quotes || []).length} quotes`);
    if (process.env.DEBUG_HARNESS) {
      console.log(
        "debug:",
        JSON.stringify({
          signals: (watch.signals || []).length,
          deliveries: watch.deliveries,
          discordErrors: watch.discordErrors,
          posts: posts.length,
        })
      );
    }

    const journal = await getJson(`${APP_URL}/api/journal`);
    const sentRows = (journal.recent || []).filter((r) => r.status === "sent");

    const embeds = posts.flatMap((p) => p.embeds || []);
    const titles = embeds.map((e) => e.title || "");

    // Only the signal embeds: their titles read "🟢 BUY EURUSD · scalp".
    const signalEmbed = (symbol) =>
      embeds.find((e) => /\b(BUY|SELL)\b/.test(e.title || "") && (e.title || "").includes(symbol));
    const eur = signalEmbed("EURUSD");
    const aud = signalEmbed("AUDUSD");

    check("EURUSD BUY/SELL signal posted to Discord", Boolean(eur), titles.join(" | ") || "no embeds");
    check(
      "EURUSD alert says the brain gate was bypassed",
      Boolean(eur) && /Gate bypassed/.test(eur.description || ""),
      eur ? String(eur.description).split("\n")[0].slice(0, 120) : "no embed"
    );
    check(
      "EURUSD alert carries entry/stop/target",
      Boolean(eur) && (eur.fields || []).some((f) => f.name === "Entry") && (eur.fields || []).some((f) => f.name === "Stop") &&
        (eur.fields || []).some((f) => f.name === "Target")
    );
    check("AUDUSD BUY/SELL signal posted to Discord", Boolean(aud), titles.join(" | ") || "no embeds");
    check(
      "AUDUSD alert is labelled UNPROVEN",
      Boolean(aud) && /UNPROVEN/.test(aud.title || ""),
      aud ? aud.title : "no embed"
    );
    check(
      "AUDUSD alert is not marked as bypassed",
      Boolean(aud) && !/Gate bypassed/.test(aud.description || ""),
      aud ? String(aud.description).split("\n")[0].slice(0, 120) : "no embed"
    );

    check(
      "journal records both as sent, not held",
      sentRows.some((r) => r.symbol === "EURUSD") && sentRows.some((r) => r.symbol === "AUDUSD"),
      sentRows.map((r) => `${r.symbol}/${r.status}`).join(", ") || "none"
    );
    check(
      "no held entry for the overridden markets",
      !(journal.recent || []).some((r) => r.status === "held" && ["EURUSD", "AUDUSD"].includes(r.symbol))
    );

    const executorFile = path.join(TMP, "executor.json");
    let book = { open: [], closed: [] };
    try {
      book = JSON.parse(fs.readFileSync(executorFile, "utf-8"));
    } catch {}
    const orders = [...(book.open || []), ...(book.closed || [])];
    check(
      "gate-approved override signal is traded",
      orders.some((o) => o.symbol === "AUDUSD"),
      orders.map((o) => o.symbol).join(", ") || "none"
    );
    check(
      "refused override signal places no trade",
      !orders.some((o) => o.symbol === "EURUSD"),
      orders.map((o) => o.symbol).join(", ") || "none"
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
