const express = require("express");
const cors = require("cors");
const { execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const market = require("./market");
const zonesStore = require("./zones");
const news = require("./news");
const settings = require("./settings");
const discord = require("./discord");
const candlesMod = require("./candles");
const autozones = require("./autozones");
const signalsMod = require("./signals");
const sessionsMod = require("./sessions");
const tracker = require("./signaltracker");
const recapMod = require("./recap");
const riskMod = require("./risk");
const guardMod = require("./guard");
const runtime = require("./runtimeState");
const labMod = require("./lab");
const orderflow = require("./orderflow");
const aiMod = require("./ai");
const ivbMod = require("./ivb");
const learning = require("./learning");
const marketclock = require("./marketclock");
const feedwatch = require("./feedwatch");
const healthMod = require("./health");
const brainMod = require("./brain");
const journal = require("./journal");
const executor = require("./executor");
const tvMod = require("./tradingview");
const costsMod = require("./costs");
const ctraderBroker = require("./brokers/ctrader");
const { writeJson } = require("./atomicWrite");
const auth = require("./auth");
const digestMod = require("./digest");
const paperReviewMod = require("./paperreview");
const ivbSent = new Set();
const HEARTBEAT_FILE = path.join(__dirname, "..", "heartbeat.json");

const app = express();
const PORT = process.env.PORT || 3000;
const WORKSPACE = path.resolve(__dirname, "..");

// 10s is the floor. Twelve Data is self-throttled to 120s inside market.js so
// a fast loop cannot burn a free-plan key; Yahoo is fine at this rate.
const WATCH_INTERVAL_MS = Math.max(10000, Number(process.env.WATCH_INTERVAL_MS || 10000));
const AUTO_ZONE_TTL_MS = 5 * 60 * 1000;
const SIGNAL_COOLDOWN_MS = 5 * 60 * 1000;
const AUTO_ALERT_COOLDOWN_MS = 5 * 60 * 1000;
const APPROACH_COOLDOWN_MS = 30 * 60 * 1000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

/* ------------------------------------------------------------------ *
 * Access
 *
 * One password, one session cookie. Everything below this middleware needs it
 * except the two pages that hand it out, the TradingView webhook (which carries
 * its own token) and the health probe.
 * ------------------------------------------------------------------ */

app.get("/api/auth/status", (req, res) => {
  const record = settings.getAuth();
  const expires = auth.sessionExpiry(req, record);
  res.json({
    ok: true,
    configured: Boolean(record),
    signedIn: auth.isSignedIn(req, record),
    expiresAt: expires ? new Date(expires).toISOString() : null,
  });
});

app.post("/api/auth/setup", (req, res) => {
  if (settings.getAuth()) {
    res.status(400).json({ ok: false, error: "a password is already set" });
    return;
  }
  const password = String((req.body && req.body.password) || "");
  if (password.length < auth.MIN_PASSWORD) {
    res.status(400).json({ ok: false, error: `use at least ${auth.MIN_PASSWORD} characters` });
    return;
  }
  const record = settings.setAuth(auth.createAuth(password));
  res.setHeader("set-cookie", auth.sessionCookie(req, record));
  res.json({ ok: true });
});

app.post("/api/auth/login", (req, res) => {
  if (!auth.allowAttempt(req)) {
    res.status(429).json({ ok: false, error: "too many attempts; wait a few minutes" });
    return;
  }
  const record = settings.getAuth();
  const password = String((req.body && req.body.password) || "");
  if (!auth.verifyPassword(password, record)) {
    auth.noteFailure(req);
    res.status(401).json({ ok: false, error: "that password is not right" });
    return;
  }
  auth.noteSuccess(req);
  res.setHeader("set-cookie", auth.sessionCookie(req, record));
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  res.setHeader("set-cookie", auth.clearCookie(req));
  res.json({ ok: true });
});

app.get("/login", (req, res) => {
  if (auth.isSignedIn(req, settings.getAuth())) {
    res.redirect("/");
    return;
  }
  res.type("html").send(auth.page({ mode: settings.getAuth() ? "login" : "setup" }));
});

app.get("/setup", (req, res) => {
  if (settings.getAuth()) {
    res.redirect("/login");
    return;
  }
  res.type("html").send(auth.page({ mode: "setup" }));
});

const PUBLIC_PATHS = new Set([
  "/login",
  "/setup",
  "/healthz",
  "/api/auth/status",
  "/api/auth/setup",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/tv/webhook",
]);

app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  const record = settings.getAuth();
  if (!record) {
    // Nothing is protected until a password exists, so send the browser to the
    // one page that creates it rather than failing every request.
    if (req.path.startsWith("/api/")) {
      res.status(401).json({ ok: false, error: "set a dashboard password at /setup first" });
      return;
    }
    res.redirect("/setup");
    return;
  }
  if (auth.isSignedIn(req, record)) return next();
  if (req.path.startsWith("/api/")) {
    res.status(401).json({ ok: false, error: "sign in first" });
    return;
  }
  res.redirect("/login");
});

app.use(express.static(path.join(__dirname, "..", "public")));

function fullInfo() {
  return {
    ...market.providerInfo(),
    discord: discord.status(),
    autoZones: settings.getAutoZones(),
    signalAlerts: settings.getSignalAlerts(),
    ivbAlerts: settings.getIvbAlerts(),
    trading: settings.getTradingConfig(),
    markets: settings.getEnabledMarkets(),
    unprovenMarkets: settings.getUnprovenMarkets(),
    correlationGroups: settings.getCorrelationGroups(),
    correlationEnabled: settings.getCorrelationEnabled(),
    alertOnlyWhenOpen: settings.getAlertOnlyWhenOpen(),
    brainGate: settings.getBrainGate(),
    statusPingHint: settings.getStatusPingHint(),
    statusPingConfigured: Boolean(settings.getStatusPingUrl()),
    quietHours: settings.getQuietHours(),
    lab: { ...labMod.summary(), results: undefined },
    ai: { ...aiMod.status() },
    sessionAlerts: settings.getSessionAlerts(),
    approachAlerts: settings.getApproachAlerts(),
  };
}

/* ------------------------------------------------------------------ *
 * Watcher state
 * ------------------------------------------------------------------ */

const lastStates = new Map();
const announcedNews = new Map();
const autoZoneCache = new Map();
const lastSignalKey = new Map();
const lastSignalSentAt = new Map();
const lastAutoAlertAt = new Map();
const sessionStates = new Map();
const announcedSessions = new Map();
const marketOpenState = { value: undefined };
const lastApproachAt = new Map();
const hotZones = new Set();
const brokenZones = new Set();
const lastAlertAt = new Map();
// Feed watchdog state: when each price last moved, and who has been warned.
const lastPriceBySymbol = new Map();
const lastMoveAt = new Map();
const feedWarned = new Map();
let guardSentDay = null;
let stateRestored = false;

// Markets that move together, editable in Settings. Alerting on both is one
// trade, not two.
function correlationGroups() {
  try {
    return settings.getCorrelationGroups();
  } catch {
    return [];
  }
}
const CORRELATION_WINDOW_MS = 45 * 60 * 1000;

function correlatedRecently(symbol) {
  if (!settings.getCorrelationEnabled()) return false;
  const group = correlationGroups().find((g) => g.includes(symbol));
  if (!group) return false;
  return group.some(
    (s) => s !== symbol && Date.now() - (lastAlertAt.get(s) || 0) < CORRELATION_WINDOW_MS
  );
}

/**
 * The other markets in this symbol's moving group, for the alert message.
 * Only one alert is sent per group, so without this the message never says
 * which other charts would have shown the same move.
 */
function linkedMarketsFor(symbol) {
  if (!settings.getCorrelationEnabled()) return [];
  const group = correlationGroups().find((g) => g.includes(symbol));
  if (!group) return [];
  const enabled = settings.getEnabledMarkets() || {};
  return group
    .filter((s) => s !== symbol && enabled[s] !== false)
    .map((s) => {
      const at = lastAlertAt.get(s);
      const minutesAgo = at ? Math.round((Date.now() - at) / 60000) : null;
      return { symbol: s, minutesAgo: minutesAgo != null && minutesAgo >= 0 && minutesAgo <= 240 ? minutesAgo : null };
    });
}

function restoreState() {
  if (stateRestored) return;
  stateRestored = true;
  const s = runtime.load();
  for (const [k, v] of Object.entries(s.lastApproachAt || {})) lastApproachAt.set(k, v);
  for (const [k, v] of Object.entries(s.lastSignalKey || {})) lastSignalKey.set(k, v);
  for (const [k, v] of Object.entries(s.lastSignalSentAt || {})) lastSignalSentAt.set(k, v);
  for (const [k, v] of Object.entries(s.lastAlertBySymbol || {})) lastAlertAt.set(k, v);
  for (const z of s.hotZones || []) hotZones.add(z);
  for (const z of s.brokenZones || []) brokenZones.add(z);
  if (s.guardSentDay) guardSentDay = s.guardSentDay;

  // These used to live only in memory, so every restart re-sent the same IVB,
  // news and market-open messages. A restart must be invisible to Discord.
  for (const k of s.ivbSent || []) ivbSent.add(k);
  for (const [k, v] of Object.entries(s.announcedNews || {})) announcedNews.set(k, v);
  if (s.marketOpenState !== undefined) marketOpenState.value = s.marketOpenState;
}

function persistState() {
  runtime.save({
    lastApproachAt: Object.fromEntries(lastApproachAt),
    lastSignalKey: Object.fromEntries(lastSignalKey),
    lastSignalSentAt: Object.fromEntries(lastSignalSentAt),
    lastAlertBySymbol: Object.fromEntries(lastAlertAt),
    hotZones: [...hotZones].slice(-400),
    brokenZones: [...brokenZones].slice(-400),
    guardSentDay,
    ivbSent: [...ivbSent].slice(-200),
    announcedNews: Object.fromEntries([...announcedNews.entries()].slice(-200)),
    marketOpenState: marketOpenState.value,
  });
}

function readHeartbeat() {
  try {
    const raw = fs.readFileSync(HEARTBEAT_FILE, "utf-8").trim();
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeHeartbeat() {
  try {
    writeJson(HEARTBEAT_FILE, { at: Date.now(), iso: new Date().toISOString() }, 0);
  } catch {}
}

/**
 * Dead-man's switch. The app pings an external service on a schedule; that
 * service alerts you when the pings STOP, which is the one failure the app
 * cannot report itself. The URL carries a token, so it is never logged.
 */
let lastStatusPingAt = 0;
let lastStatusPingError = null;

async function pingStatus({ force = false } = {}) {
  const url = settings.getStatusPingUrl();
  if (!url) return { skipped: true, reason: "no uptime URL set" };
  if (!force && Date.now() - lastStatusPingAt < 60 * 1000) {
    return { skipped: true, reason: "pinged within the last minute" };
  }
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(8000) });
    lastStatusPingAt = Date.now();
    lastStatusPingError = res.ok ? null : `HTTP ${res.status}`;
    return { ok: res.ok, status: res.status };
  } catch (err) {
    lastStatusPingError = err.message;
    return { ok: false, error: err.message };
  }
}

let snapshot = null;
let snapshotAt = 0;
let inFlight = null;

async function autoZonesFor(inst, price) {
  const cached = autoZoneCache.get(inst.symbol);
  if (cached && Date.now() - cached.at < AUTO_ZONE_TTL_MS) {
    return cached;
  }

  const bars = await candlesMod.getCandles(inst.candleSymbol, "15m", "5d");
  const detected = autozones.detectZones(bars, { maxPerSide: 3 });

  // Candles may come from a different instrument than the quote (gold futures
  // vs spot), so shift levels onto the quoted scale.
  const lastClose = bars[bars.length - 1].c;
  const basisOffset = Number.isFinite(price) && Number.isFinite(lastClose) ? price - lastClose : 0;

  const zones = autozones.toAppZones(inst.symbol, detected, {
    basisOffset,
    decimals: inst.decimals,
  });

  const result = { at: Date.now(), zones, candles: bars, basisOffset };
  autoZoneCache.set(inst.symbol, result);
  return result;
}

async function buildSnapshot() {
  // Heartbeat: notice if the watcher itself was down for a while
  const previousBeat = readHeartbeat();
  let watcherGapMinutes = null;
  if (previousBeat && Number.isFinite(previousBeat.at)) {
    const gapMs = Date.now() - previousBeat.at;
    if (gapMs > Math.max(15 * 60 * 1000, WATCH_INTERVAL_MS * 6)) {
      watcherGapMinutes = Math.round(gapMs / 60000);
    }
  }
  writeHeartbeat();
  pingStatus().catch(() => {});

  const manualZones = zonesStore.loadZones().filter((z) => z.active !== false);

  restoreState();

  const enabledMarkets = settings.getEnabledMarkets();
  const instruments = market.instrumentList().filter(
    (i) => !enabledMarkets || enabledMarkets[i.symbol] !== false
  );

  const symbols = [...new Set(manualZones.map((z) => z.symbol))];
  for (const inst of instruments) {
    if (!symbols.includes(inst.symbol)) symbols.push(inst.symbol);
  }

  const quotes = await market.getQuotes(symbols);
  const priceBySymbol = new Map(quotes.map((q) => [q.symbol, q.price]));

  // Automatic zones
  const autoErrors = [];
  const autoBySymbol = {};
  const candleBySymbol = {};
  if (settings.getAutoZones()) {
    for (const inst of instruments) {
      try {
        const auto = await autoZonesFor(inst, priceBySymbol.get(inst.symbol));
        autoBySymbol[inst.symbol] = auto.zones;
        candleBySymbol[inst.symbol] = auto.candles;
      } catch (err) {
        autoErrors.push(`${inst.symbol}: ${err.message}`);
      }
    }
  }

  const allZones = [...manualZones, ...Object.values(autoBySymbol).flat()];

  // Evaluate every zone against price
  const fired = [];
  const evaluated = allZones.map((zone) => {
    const price = priceBySymbol.get(zone.symbol);
    const evaluation = zonesStore.evaluateZone(zone, price);
    const previous = lastStates.get(zone.id) || "unknown";

    if (Number.isFinite(price)) {
      const message = zonesStore.shouldFire(previous, zone, evaluation);
      if (message) {
        const isAuto = zone.source === "auto";
        const lastAuto = lastAutoAlertAt.get(zone.symbol) || 0;
        // Automatic zones now warn on approach too, not only when price is
        // already inside, so there is time to react before the move happens.
        const autoAllowed =
          !isAuto ||
          (["approaching", "inside"].includes(evaluation.state) &&
            Date.now() - lastAuto >= AUTO_ALERT_COOLDOWN_MS);

        if (autoAllowed) {
          fired.push({
            id: `${zone.id}-${Date.now()}`,
            zoneId: zone.id,
            symbol: zone.symbol,
            label: zone.label,
            type: zone.type,
            state: evaluation.state,
            price,
            low: zone.low,
            high: zone.high,
            distance: evaluation.distance,
            source: zone.source || "manual",
            message,
            at: new Date().toISOString(),
          });
          if (isAuto) lastAutoAlertAt.set(zone.symbol, Date.now());
        }
      }
      lastStates.set(zone.id, evaluation.state);
    }

    return { ...zone, ...evaluation, price };
  });

  for (const alert of fired) zonesStore.appendAlert(alert);

  // Zone invalidation: a level price has closed through after being live
  const newlyBroken = [];
  for (const zone of evaluated) {
    if (["approaching", "inside"].includes(zone.state)) hotZones.add(zone.id);

    const bars = candleBySymbol[zone.symbol];
    if (!bars || !bars.length) continue;

    const lastBar = bars[bars.length - 1];
    const buffer = Math.abs(Number(zone.price) || 0) * 0.0005;
    const closedThrough =
      zone.type === "supply" ? lastBar.c > zone.high + buffer : lastBar.c < zone.low - buffer;

    if (closedThrough && hotZones.has(zone.id) && !brokenZones.has(zone.id)) {
      brokenZones.add(zone.id);
      hotZones.delete(zone.id);
      newlyBroken.push({
        id: zone.id,
        symbol: zone.symbol,
        type: zone.type,
        low: zone.low,
        high: zone.high,
        price: zone.price,
        source: zone.source || "manual",
      });
    }
  }

  const nearest = {};
  for (const zone of evaluated) {
    if (zone.distance == null) continue;
    const current = nearest[zone.symbol];
    if (!current || zone.distance < current.distance) nearest[zone.symbol] = zone;
  }

  // Trading preferences and the things that can suppress a signal
  const trading = settings.getTradingConfig();

  let blackout = { active: false, events: [], minutes: trading.blackoutMinutes };
  if (trading.newsBlackout) {
    try {
      blackout = await news.getBlackout(trading.blackoutMinutes);
    } catch {}
  }

  const guard = guardMod.check({
    history: tracker.load().history,
    maxLosses: trading.dailyMaxLosses,
    maxLossR: trading.dailyMaxLossR,
  });

  const blockSignals = blackout.active || guard.stop;
  const blockReason = blackout.active
    ? `news blackout (${(blackout.events[0] || {}).title || "high-impact event"})`
    : guard.stop
      ? "daily loss limit"
      : null;

  // Higher-timeframe candles: hourly for the trend filter, daily for the bias
  const htfBySymbol = {};
  const dailyBySymbol = {};
  for (const inst of instruments) {
    if (trading.mtfFilter) {
      try {
        htfBySymbol[inst.symbol] = await candlesMod.getCandles(inst.candleSymbol, "1h", "1mo");
      } catch {}
    }
    try {
      dailyBySymbol[inst.symbol] = await candlesMod.getCandles(inst.candleSymbol, "1d", "1y");
    } catch {}
  }

  // Initial balance breakout watch (New York open) — Nasdaq and gold
  const ivbState = {};
  for (const inst of instruments) {
    if (!["XAUUSD", "NASDAQ"].includes(inst.symbol)) continue;
    try {
      const bars5 = await candlesMod.getCandles(inst.candleSymbol, "5m", "5d");
      const result = ivbMod.evaluate(bars5, new Date());
      if (result) ivbState[inst.symbol] = result;
    } catch {}
  }

  // Volume profile and structural levels (decision support, not a filter)
  const levelMaps = {};
  for (const inst of instruments) {
    const bars = candleBySymbol[inst.symbol];
    const price = priceBySymbol.get(inst.symbol);
    if (!bars || bars.length < 60 || !Number.isFinite(price)) continue;
    const roundStep =
      inst.symbol === "NASDAQ" ? 100 : inst.symbol === "XAUUSD" ? 10 : inst.decimals === 5 ? 0.005 : 0.05;
    try {
      levelMaps[inst.symbol] = orderflow.buildLevels({
        bars,
        daily: dailyBySymbol[inst.symbol],
        price,
        decimals: inst.decimals,
        roundStep,
      });
    } catch {}
  }

  const profileFor = (symbol) => {
    const map = levelMaps[symbol];
    if (!map || !map.profile) return null;
    return { poc: map.profile.poc, vah: map.profile.vah, val: map.profile.val };
  };

  for (const zone of evaluated) {
    const map = levelMaps[zone.symbol];
    if (!map) continue;
    const hit = orderflow.levelScoreAt((zone.low + zone.high) / 2, map);
    zone.levelScore = hit.score;
    zone.levelPrice = hit.price;
    zone.profile = profileFor(zone.symbol);
  }

  for (const alert of fired) alert.profile = profileFor(alert.symbol);

  // Overrides and lab verdicts, read once per cycle
  const unprovenMarkets = new Set(settings.getUnprovenMarkets());
  const labSummary = labMod.summary();

  // Signals
  const signals = [];
  const newSignals = [];
  for (const inst of instruments) {
    const bars = candleBySymbol[inst.symbol];
    const price = priceBySymbol.get(inst.symbol);
    if (!bars || !Number.isFinite(price)) continue;

    const zonesForSymbol = evaluated.filter((z) => z.symbol === inst.symbol);
    const signal = signalsMod.evaluateSignal({
      symbol: inst.symbol,
      price,
      zones: zonesForSymbol,
      candles: bars,
      decimals: inst.decimals,
      htfBars: htfBySymbol[inst.symbol],
      dailyBars: dailyBySymbol[inst.symbol],
      requireHtf: trading.mtfFilter,
      minConfluence: trading.minConfluence,
    });
    if (!signal) continue;

    if (trading.accountSize > 0 && trading.riskPercent > 0) {
      signal.sizing = riskMod.sizePosition({
        accountSize: trading.accountSize,
        riskPercent: trading.riskPercent,
        entry: signal.entry,
        stop: signal.stop,
        valuePerPointPerLot: inst.valuePerPointPerLot,
      });
    }

    signal.profile = profileFor(inst.symbol);
    signal.providerSymbol = quotes.find((q) => q.symbol === inst.symbol)?.providerSymbol;
    signals.push(signal);

    if (blockSignals) continue;

    const key = `${signal.symbol}|${signal.side}|${signal.zone.low}|${signal.zone.high}`;
    const changed = lastSignalKey.get(signal.symbol) !== key;
    const cooled = Date.now() - (lastSignalSentAt.get(signal.symbol) || 0) > SIGNAL_COOLDOWN_MS;
    // The lab decides whether this market has ever shown an out-of-sample edge.
    // If it has not, the signal is normally shown but never sent — unless the
    // market is on the explicit override list, in which case it goes out
    // clearly labelled as unproven.
    signal.labApproved = labMod.tradable(signal.symbol);
    signal.unproven = !signal.labApproved && unprovenMarkets.has(signal.symbol);
    if (signal.unproven) {
      const labResult = labSummary.results[signal.symbol];
      signal.labVerdict = labResult ? labResult.verdict : "not tested yet";
    }

    if (changed && cooled && (signal.labApproved || signal.unproven)) {
      newSignals.push(signal);
      lastSignalKey.set(signal.symbol, key);
      lastSignalSentAt.set(signal.symbol, Date.now());
    }
  }

  // News
  let newsSummary = null;
  try {
    newsSummary = await news.getNewsSummary();
  } catch {
    newsSummary = { ok: false, newsRisk: false, upcoming: [], headlines: [] };
  }
  const newsRiskEvents = (newsSummary && newsSummary.highImpactSoon) || [];

  // Early warning: price heading toward a zone where a setup could form
  const approachWarnings = [];
  for (const inst of instruments) {
    const bars = candleBySymbol[inst.symbol];
    const price = priceBySymbol.get(inst.symbol);
    if (!bars || !Number.isFinite(price)) continue;

    const warning = signalsMod.evaluateApproach({
      symbol: inst.symbol,
      price,
      zones: evaluated.filter((z) => z.symbol === inst.symbol),
      candles: bars,
      decimals: inst.decimals,
    });
    if (!warning) continue;

    // Skip if that zone is already producing a real signal
    const hasSignal = signals.some(
      (s) => s.symbol === warning.symbol && s.zone.low === warning.zone.low && s.zone.high === warning.zone.high
    );
    if (hasSignal) continue;

    if (blockSignals) continue;

    const key = `${warning.symbol}|${warning.zone.low}|${warning.zone.high}`;
    if (Date.now() - (lastApproachAt.get(key) || 0) < APPROACH_COOLDOWN_MS) continue;

    approachWarnings.push({ ...warning, key });
  }

  // Track posted signals and resolve any that hit target, stop or expiry
  for (const signal of newSignals) tracker.add(signal);
  const tracked = tracker.update(priceBySymbol);
  const signalStats = tracker.stats();

  // Judge itself on what has actually closed, every cycle.
  let learningRows = [];
  try {
    learningRows = learning.refresh();
  } catch (err) {
    console.error("learner:", err.message);
  }

  // Session open/close transitions
  const sessionResult = sessionsMod.detectSessionEvents(sessionStates, new Date());
  sessionResult.states.forEach((v, k) => sessionStates.set(k, v));
  const sessionEvents = sessionResult.events;

  // Weekly market open/close rides the same channel and toggle
  const marketResult = sessionsMod.detectMarketEvents(marketOpenState.value, new Date());
  marketOpenState.value = marketResult.open;
  sessionEvents.push(...marketResult.events);

  // Gate evaluation is independent of Discord. Auto-trading must work with no
  // webhook configured (and during quiet hours), and the dashboard needs to
  // show what the gates held back whether or not anything was delivered.
  //
  // Nothing is sent or traded while the market is shut: weekend, daily rollover
  // gap, or a price feed that has stopped ticking. Tracking continues either way.
  const onlyWhenOpen = settings.getAlertOnlyWhenOpen();
  const tickBySymbol = new Map((quotes || []).map((q) => [q.symbol, q.lastMarketUpdate]));
  const heldByHours = [];
  const hoursBlocked = (symbol) => {
    if (!onlyWhenOpen) return false;
    const gate = marketclock.check({ lastMarketUpdate: tickBySymbol.get(symbol) });
    if (gate.allowed) return false;
    heldByHours.push({ symbol, reason: gate.reason });
    return true;
  };

  // The brain gate: a trade prompt only goes out if some strategy has been
  // measured to make money in this market, in the condition it is in now.
  // Blocked prompts are recorded rather than dropped silently.
  const brainGateOn = settings.getBrainGate();
  const gateCandleSymbols = new Map(market.instrumentList().map((i) => [i.symbol, i.candleSymbol]));
  const brainHeld = [];
  // Returns the gate verdict, so callers can also journal the condition that
  // was in force when the decision was made.
  const brainVerdict = async (symbol, setup, side) => {
    if (!brainGateOn) return { blocked: false, condition: null, reason: "gate off" };
    let verdict;
    try {
      verdict = await brainMod.gate(symbol, gateCandleSymbols.get(symbol));
    } catch (err) {
      // If the brain cannot answer, do not let that become an alert or an order.
      const reason = `brain gate failed (${err.message})`;
      learning.noteSuppressed({ symbol, side, confidence: setup }, { reason });
      return { blocked: true, condition: null, reason };
    }
    if (verdict.allowed) return { blocked: false, condition: verdict.condition, verdict };
    brainHeld.push({ symbol, condition: verdict.condition, reason: verdict.reason });
    learning.noteSuppressed({ symbol, side, confidence: setup }, { reason: verdict.reason });
    return { blocked: true, condition: verdict.condition, reason: verdict.reason };
  };

  // Is the price actually moving? A running app with a frozen feed looks
  // perfectly healthy and alerts nobody, which is the worst kind of failure.
  feedwatch.recordMoves({ quotes, lastPrice: lastPriceBySymbol, movedAt: lastMoveAt });
  const feed = feedwatch.evaluate({ quotes, movedAt: lastMoveAt });

  // Which of this cycle's signals survived every gate? Evaluated once, so the
  // Discord message and the order can never disagree about what was approved.
  const approvedSignals = [];
  for (const signal of newSignals) {
    if (hoursBlocked(signal.symbol)) continue;
    if (correlatedRecently(signal.symbol)) continue;

    // The learner can mute one specific setup (market + direction + type)
    // after it has lost money on enough closed trades to be sure.
    const verdict = learning.verdictFor(signal);
    if (!verdict.allowed) {
      learning.noteSuppressed(signal, verdict);
      continue;
    }

    // Proven-rule gate. This is the strict one: it can silence the app
    // completely, which is the point — an unproven setup is not news.
    const gateVerdict = await brainVerdict(signal.symbol, signal.confidence || "signal", signal.side);
    if (gateVerdict.blocked) {
      // Still written down: a held signal is evidence about the filter too.
      journal.record(signal, {
        status: "held",
        heldReason: gateVerdict.reason,
        regime: gateVerdict.condition,
        newsNear: Boolean(blackout && blackout.active),
      });
      continue;
    }

    approvedSignals.push({ signal, gate: gateVerdict });
  }

  // Discord delivery
  const discordErrors = [];
  let hoursHeldSnapshot = heldByHours.slice(0, 25);
  let brainHeldSnapshot = brainHeld.slice(0, 25);
  let feedSnapshotStale = feed.stale;
  let feedSnapshotChecked = feed.checked;
  if (discord.configured()) {
    const quiet = settings.getQuietHours();
    const utcHour = new Date().getUTCHours();
    const quietNow =
      quiet.enabled &&
      (quiet.from <= quiet.to
        ? utcHour >= quiet.from && utcHour < quiet.to
        : utcHour >= quiet.from || utcHour < quiet.to);

    const alertsReady = discord.channelConfigured("alerts") && !quietNow;
    const newsReady = discord.channelConfigured("news") && !quietNow;
    const recapReady = discord.channelConfigured("recap") && !quietNow;

    let sent = 0;
    for (const alert of alertsReady ? fired : []) {
      if (sent >= 3) break;
      if (hoursBlocked(alert.symbol)) continue;
      if ((await brainVerdict(alert.symbol, "zone touch", alert.side)).blocked) continue;
      if (correlatedRecently(alert.symbol)) continue;
      try {
        await discord.sendZoneAlert({ ...alert, linked: linkedMarketsFor(alert.symbol) });
        lastAlertAt.set(alert.symbol, Date.now());
        sent++;
      } catch (err) {
        discordErrors.push(err.message);
      }
    }

    if (alertsReady && settings.getApproachAlerts()) {
      for (const warning of approachWarnings.slice(0, 2)) {
        if (hoursBlocked(warning.symbol)) continue;
        if ((await brainVerdict(warning.symbol, "approach", warning.side)).blocked) continue;
        try {
          await discord.sendSignalApproach({ ...warning, linked: linkedMarketsFor(warning.symbol) });
          lastApproachAt.set(warning.key, Date.now());
        } catch (err) {
          discordErrors.push(err.message);
        }
      }
    }

    if (alertsReady && settings.getIvbAlerts()) {
      for (const [symbol, result] of Object.entries(ivbState)) {
        if (!result || !result.side) continue;
        if (hoursBlocked(symbol)) continue;
        const key = `${symbol}|${result.day}|${result.side}`;
        if (ivbSent.has(key)) continue;
        try {
          await discord.sendIvb({ symbol, ...result });
          ivbSent.add(key);
        } catch (err) {
          discordErrors.push(err.message);
        }
      }
    }

    if (alertsReady && newlyBroken.length) {
      for (const info of newlyBroken) {
        if (hoursBlocked(info.symbol)) continue;
        try {
          await discord.sendZoneBroken(info);
        } catch (err) {
          discordErrors.push(err.message);
        }
      }
    }

    if (alertsReady && guard.stop && guardSentDay !== guard.state.day) {
      try {
        await discord.sendDailyGuard(guard);
        guardSentDay = guard.state.day;
      } catch (err) {
        discordErrors.push(err.message);
      }
    }

    if (alertsReady && watcherGapMinutes) {
      try {
        await discord.sendWatcherGap(watcherGapMinutes);
      } catch (err) {
        discordErrors.push(err.message);
      }
    }

    if (alertsReady && settings.getSignalAlerts()) {
      for (const { signal, gate } of approvedSignals) {
        try {
          await discord.sendSignal({ ...signal, linked: linkedMarketsFor(signal.symbol) });
          lastAlertAt.set(signal.symbol, Date.now());
          journal.record(signal, {
            status: "sent",
            regime: gate.condition,
            newsNear: Boolean(blackout && blackout.active),
          });
        } catch (err) {
          discordErrors.push(err.message);
        }
      }
    }

    if (newsReady && settings.getDiscordNews() && newsRiskEvents.length) {
      const fresh = newsRiskEvents.filter((e) => {
        const sentAt = announcedNews.get(`${e.title}|${e.date}`);
        return !sentAt || Date.now() - sentAt > 6 * 60 * 60 * 1000;
      });
      if (fresh.length) {
        try {
          await discord.sendNewsRisk(fresh);
          fresh.forEach((e) => announcedNews.set(`${e.title}|${e.date}`, Date.now()));
        } catch (err) {
          discordErrors.push(err.message);
        }
      }
    }

    for (const result of alertsReady ? tracked.resolved : []) {
      try {
        await discord.sendSignalResult(result);
      } catch (err) {
        discordErrors.push(err.message);
      }
    }

    // Daily digest, due from 21:00 UTC, sent only if something happened.
    if (alertsReady && digestMod.shouldSend(new Date())) {
      try {
        const j = journal.summary();
        const e = executor.status(priceBySymbol);
        const proven = (brainMod.summary().conditions || [])
          .filter((r) => r.champion && r.champion.family)
          .map((r) => r.symbol);
        digestMod.markSent();
        if (digestMod.hasSomethingToReport({ journal: j, exec: e })) {
          await discord.post({ content: digestMod.buildDigest({ journal: j, exec: e, proven }) }, "alerts");
        }
      } catch (err) {
        digestMod.markSent();
        console.error("digest:", err.message);
      }
    }

    // Weekly paper review: the fills against the promise, from Monday 08:00 UTC.
    if (discord.channelConfigured("recap") && !quietNow && paperReviewMod.shouldSend(new Date())) {
      try {
        const review = paperReviewMod.buildReview({
          exec: executor.status(priceBySymbol),
          brain: brainMod.summary(),
        });
        paperReviewMod.markSent();
        if (review.ready) await discord.post({ content: review.text }, "recap");
      } catch (err) {
        paperReviewMod.markSent();
        console.error("paper review:", err.message);
      }
    }

    // Weekly recap, due from Monday 08:00 UTC and sent once per week.
    // Marked as sent even when there is nothing to report, so a quiet week
    // does not produce an empty message and does not re-check all week.
    if (recapReady && recapMod.shouldSend(new Date())) {
      try {
        const recap = recapMod.buildRecap(tracker.load().history);
        if (recap.total > 0) await discord.sendWeeklyRecap(recap);
        recapMod.markSent();
      } catch (err) {
        discordErrors.push(err.message);
      }
    }

    if (newsReady && settings.getSessionAlerts() && sessionEvents.length) {
      for (const ev of sessionEvents) {
        const key = `${ev.name}|${ev.type}|${new Date(ev.at).toISOString().slice(0, 13)}`;
        const sentAt = announcedSessions.get(key);
        if (sentAt && Date.now() - sentAt < 2 * 60 * 60 * 1000) continue;
        try {
          await discord.sendSessionEvent(ev);
          announcedSessions.set(key, Date.now());
        } catch (err) {
          discordErrors.push(err.message);
        }
      }
    }

    // Health pass runs last, so it sees any delivery failure from this cycle.
    try {
      const healthResult = healthMod.observe({
        feed: { marketOpen: feed.marketOpen, checked: feed.checked, stale: feed.stale.length },
        discord: { configured: discord.configured(), failures: discordErrors.length > 0 ? 1 : 0 },
      });

      for (const action of healthResult.actions) {
        const minutes = action.since ? Math.max(1, Math.round((Date.now() - action.since) / 60000)) : 1;
        try {
          if (action.state === "bad" && action.component === "feed") {
            await discord.sendFeedStale(feed.stale, feed.staleMinutes);
          } else if (action.state === "bad") {
            await discord.sendHealthAlert(action.component, "");
          } else if (action.state === "recovered") {
            await discord.sendHealthRecovered(action.component, minutes);
          }
        } catch (err) {
          discordErrors.push(err.message);
          healthMod.markUndelivered(action.component);
        }
      }
    } catch (err) {
      console.error("health:", err.message);
    }
  }

  // Delivery is over. Bookkeeping and orders are the app's own work, so they
  // run whether or not Discord is configured, and whether or not a message got
  // through: an alert the webhook rejected must not silently cancel a trade.
  if (tracked.resolved && tracked.resolved.length) journal.resolve(tracked.resolved);

  try {
    // A direct broker closes the trade itself, so ask it before assuming the
    // position is still there. Paper and bridge resolve their own stops.
    if (settings.getExecConfig().mode === "direct") {
      const reconciled = await executor.reconcile(priceBySymbol);
      for (const done of reconciled.closed) {
        console.log(`executor: ${done.symbol} ${done.side} closed at broker ${done.outcome} ${done.pnl}`);
      }
    }
    const executed = executor.mark(priceBySymbol);
    for (const done of executed.closed) {
      console.log(`executor: ${done.symbol} ${done.side} closed ${done.outcome} ${done.pnl}`);
    }
  } catch (err) {
    console.error("executor mark:", err.message);
  }

  // Auto-trading. The executor re-checks the brain gate itself, so a signal
  // reaching it by any path still cannot bypass "is there a proven rule now".
  if (settings.getExecConfig().enabled) {
    for (const { signal, gate } of approvedSignals) {
      try {
        const placed = await executor.place(
          {
            ...signal,
            gate: {
              blocked: false,
              condition: gate.condition,
              verdict: (gate.verdict && gate.verdict.champion) || null,
            },
          },
          priceBySymbol
        );
        if (placed.ok) {
          console.log(
            `executor: ${placed.mode} ${signal.symbol} ${signal.side} ${placed.order.lots} lots (risk ${placed.order.riskPct}%)`
          );
        } else {
          console.log(`executor: skipped ${signal.symbol} — ${placed.reason}`);
        }
      } catch (err) {
        console.error("executor:", err.message);
      }
    }
  }

  snapshot = {
    ok: true,
    checkedAt: new Date().toISOString(),
    intervalMs: WATCH_INTERVAL_MS,
    provider: fullInfo(),
    quotes,
    zones: evaluated,
    manualZoneCount: manualZones.length,
    autoZoneCount: Object.values(autoBySymbol).flat().length,
    autoErrors,
    nearest,
    signals,
    approachWarnings,
    resourcesRestored: stateRestored,
    signalStats,
    trading,
    blackout,
    guard,
    blockReason,
    levels: levelMaps,
    ivb: ivbState,
    brokenZones: newlyBroken,
    watcherGapMinutes,
    resolvedSignals: tracked.resolved,
    fired,
    alerts: zonesStore.loadAlerts().slice(-40).reverse(),
    newsRisk: Boolean(newsSummary && newsSummary.newsRisk),
    newsRiskEvents,
    sessions: sessionsMod.getSessionStates(new Date()),
    sessionEvents,
    discordErrors,
    marketOpen: sessionsMod.marketState(new Date()),
    alertsHeldByHours: hoursHeldSnapshot,
    alertsHeldByBrain: brainHeldSnapshot,
    feed: { stale: feedSnapshotStale, checked: feedSnapshotChecked, staleMinutes: feedwatch.STALE_MINUTES },
    deliveries: discord.getDeliveries().slice(0, 10),
  };
  persistState();
  snapshotAt = Date.now();
  return snapshot;
}

function runWatchCycle() {
  if (inFlight) return inFlight;
  inFlight = buildSnapshot().finally(() => {
    inFlight = null;
    // The app keeps testing itself in the background, one market at a time.
    labMod.maybeRun(market.instrumentList()).catch(() => {});
    brainMod.maybeRun(market.instrumentList()).catch(() => {});
    // And keeps the Exness balance fresh, if the bridge is set up.
    executor.maybeSyncAccount().catch(() => {});
  });
  return inFlight;
}

async function getSnapshot({ maxAgeMs = 3000 } = {}) {
  if (snapshot && Date.now() - snapshotAt < maxAgeMs) return snapshot;
  try {
    return await runWatchCycle();
  } catch (err) {
    if (snapshot) return snapshot;
    return { ok: false, error: err.message, quotes: [], zones: [], signals: [], alerts: [], fired: [] };
  }
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

app.get("/api/health", (_req, res) => res.json({ ok: true, version: "4.0.0", ...fullInfo() }));
app.get("/api/instruments", (_req, res) => res.json({ ok: true, ...fullInfo() }));

app.get("/api/watch", async (_req, res) => {
  try {
    res.json(await getSnapshot());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/signals", async (_req, res) => {
  const snap = await getSnapshot();
  res.json({ ok: true, signals: snap.signals || [], checkedAt: snap.checkedAt });
});

app.get("/api/signal-results", (_req, res) => {
  res.json({ ok: true, ...tracker.stats() });
});

/** Compact live state handed to the model — numbers come from here, never invented. */
function condense(snap) {
  if (!snap) return {};
  return {
    checkedAt: snap.checkedAt,
    quotes: (snap.quotes || []).map((q) => ({ symbol: q.symbol, price: q.price })),
    zones: (snap.zones || []).slice(0, 18).map((z) => ({
      symbol: z.symbol,
      type: z.type,
      state: z.state,
      low: z.low,
      high: z.high,
      distance: z.distance,
    })),
    signals: (snap.signals || []).map((s) => ({
      symbol: s.symbol,
      side: s.side,
      entry: s.entry,
      stop: s.stop,
      target: s.target,
    })),
    guard: snap.guard,
    blackout: snap.blackout,
    marketOpen: snap.marketOpen,
    feed: snap.feed,
    labGate: labMod.summary().gate,
    brainGate: settings.getBrainGate(),
    alertOnlyWhenOpen: settings.getAlertOnlyWhenOpen(),
    unprovenMarkets: settings.getUnprovenMarkets(),
    // Why a market is or is not prompting right now: the proven rule for its
    // current condition, or null when the brain has nothing for it.
    brain: (brainMod.summary().conditions || []).map((c) => ({
      symbol: c.symbol,
      condition: c.condition,
      proven: c.champion ? c.champion.name : null,
    })),
    quietHours: settings.getQuietHours(),
    signalStats: snap.signalStats,
  };
}

app.get("/api/ai/status", (_req, res) => res.json({ ok: true, ...aiMod.status() }));

app.post("/api/ai/config", (req, res) => {
  try {
    const body = req.body || {};
    settings.setAiConfig({
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
      model: body.model,
    });
    res.json({ ok: true, ...aiMod.status() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/ai/clear", (_req, res) => {
  settings.clearAiConfig();
  aiMod.resetConversation();
  res.json({ ok: true, ...aiMod.status() });
});

app.post("/api/ai/test", async (_req, res) => {
  try {
    const result = await aiMod.testConnection();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.post("/api/ai/ask", async (req, res) => {
  try {
    const question = String((req.body && req.body.question) || "").trim();
    if (!question) return res.status(400).json({ ok: false, error: "Ask a question first" });
    const snap = await getSnapshot();
    const result = await aiMod.ask(question, condense(snap));
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.post("/api/ai/agent", async (req, res) => {
  try {
    const name = String((req.body && req.body.agent) || "briefing");
    const snap = await getSnapshot();
    const result = await aiMod.runAgent(name, condense(snap));
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.get("/api/levels", async (_req, res) => {
  try {
    const snap = await getSnapshot();
    res.json({ ok: true, levels: snap.levels || {}, prices: snap.quotes || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/lab", (_req, res) => res.json({ ok: true, ...labMod.summary() }));

/** Which strategy has proven itself, in which market condition. */
app.get("/api/brain", (_req, res) => res.json({ ok: true, ...brainMod.summary() }));

/* --------------------------- auto-trading --------------------------- */

const priceMapNow = () => {
  const map = new Map();
  const quotes = (snapshot && snapshot.quotes) || [];
  for (const q of quotes) if (q && q.symbol) map.set(q.symbol, q.price);
  return map;
};

/** Never hand a secret back to the browser, even on the same-origin UI. */
function publicExecConfig(config) {
  return {
    ...config,
    bridgeSecret: "",
    tv: { ...(config.tv || {}), secret: "" },
    // Broker credentials are the account. They go in, they never come back out.
    direct: { ...(config.direct || {}), token: "", clientSecret: "", refreshToken: "" },
  };
}

app.get("/api/exec", (_req, res) => {
  res.json({
    ok: true,
    ...executor.status(priceMapNow()),
    bridgeHint: settings.getExecHint(),
    tvHint: settings.getTvHint(),
    directHint: settings.getDirectHint(),
    config: publicExecConfig(settings.getExecConfig()),
  });
});

app.post("/api/exec/config", (req, res) => {
  const body = req.body || {};
  const config = settings.setExecConfig(body);
  res.json({ ok: true, config: publicExecConfig(config), hint: settings.getExecHint() });
});

app.post("/api/exec/kill", (req, res) => {
  const reason = String((req.body && req.body.reason) || "switched off by hand").slice(0, 200);
  res.json({ ok: true, ...executor.kill(reason) });
});

app.post("/api/exec/revive", (_req, res) => {
  res.json({ ok: true, ...executor.revive() });
});

app.post("/api/exec/test-bridge", async (_req, res) => {
  try {
    res.json(await executor.testBridge());
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

/** Read the real Exness account through the bridge (read-only). */
/** Does the direct broker answer, and for which account? */
app.post("/api/exec/test-broker", async (_req, res) => {
  try {
    res.json(await executor.testBroker());
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post("/api/exec/account", async (_req, res) => {
  try {
    res.json(await executor.syncAccount());
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

/**
 * cTrader's OAuth round trip, run from the phone.
 *
 * The dashboard sends the browser here, cTrader shows its own consent page, and
 * the one-time code comes back to /callback in this process — no terminal, no
 * pasting, and the client secret never leaves the server. Sign-in codes die
 * after about a minute, which is why the browser is already open on the consent
 * page when the code is issued.
 */
const ctraderStates = new Map();
const CTRADER_STATE_MS = 10 * 60 * 1000;

/** The origin the browser used, so the redirect URI matches what was registered. */
function originOf(req) {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return `${proto}://${host}`;
}

app.get("/api/exec/ctrader/start", (req, res) => {
  const direct = settings.getExecConfig().direct || {};
  const clientId = String(direct.clientId || "").trim();
  const clientSecret = String(direct.clientSecret || "").trim();
  if (!clientId || !clientSecret) {
    res.status(400).json({ ok: false, error: "Save the cTrader client ID and client secret first." });
    return;
  }
  const now = Date.now();
  for (const [key, value] of ctraderStates) if (value.expires < now) ctraderStates.delete(key);
  const redirectUri = `${originOf(req)}/api/exec/ctrader/callback`;
  const state = crypto.randomBytes(16).toString("hex");
  ctraderStates.set(state, { redirectUri, expires: now + CTRADER_STATE_MS });
  res.redirect(ctraderBroker.consentUrl({ clientId, redirectUri, state }));
});

app.get("/api/exec/ctrader/callback", async (req, res) => {
  const back = (params) => res.redirect(`/?${new URLSearchParams(params).toString()}`);
  const { code, state, error } = req.query || {};
  if (error) {
    back({ ctrader: "error", msg: String(error).slice(0, 200) });
    return;
  }
  const known = ctraderStates.get(String(state || ""));
  if (!known) {
    back({ ctrader: "error", msg: "That sign-in expired or did not start here. Press Connect cTrader again." });
    return;
  }
  ctraderStates.delete(String(state));
  if (!code) {
    back({ ctrader: "error", msg: "cTrader came back without a code." });
    return;
  }

  const direct = settings.getExecConfig().direct || {};
  const clientId = String(direct.clientId || "").trim();
  const clientSecret = String(direct.clientSecret || "").trim();
  const tokens = await ctraderBroker.exchangeCode({
    clientId,
    clientSecret,
    redirectUri: known.redirectUri,
    code: String(code),
  });
  if (!tokens.ok) {
    back({ ctrader: "error", msg: tokens.error });
    return;
  }

  // The token endpoint never says which account the token belongs to: that only
  // comes back over the trading socket, so ask each platform in turn.
  let environment = "";
  let accounts = [];
  for (const host of ["practice", "live"]) {
    const found = await ctraderBroker.listAccounts({
      direct: {
        provider: "ctrader",
        clientId,
        clientSecret,
        token: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        environment: host,
      },
    });
    if (found.ok && found.accounts && found.accounts.length) {
      environment = host;
      accounts = found.accounts;
      break;
    }
  }

  if (!accounts.length) {
    // Keep the tokens regardless: they are the awkward part to obtain, and the
    // account id can be typed in once the demo account is sorted out.
    settings.setExecConfig({
      direct: {
        provider: "ctrader",
        environment: "practice",
        clientId,
        clientSecret,
        token: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      },
    });
    back({
      ctrader: "partial",
      msg: "Tokens saved, but no account answered for them. Check the demo account exists, then press Read account.",
    });
    return;
  }

  const chosen = accounts[0];
  const accountId = String(chosen.accountId);
  settings.setExecConfig({
    direct: {
      provider: "ctrader",
      environment,
      clientId,
      clientSecret,
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accountId,
    },
  });
  back({
    ctrader: "ok",
    account: accountId,
    broker: String(chosen.broker || "cTrader"),
    env: environment === "live" ? "live" : "demo",
    more: accounts.length > 1 ? String(accounts.length) : "",
  });
});

/** Read the account's live spread per market from the bridge. */
app.post("/api/exec/spreads", async (_req, res) => {
  try {
    res.json(await executor.syncSpreads());
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

/**
 * Break-even after broker costs, per market.
 *
 * The stop distance is measured from the app's own closed signals where there
 * are any, then from the signals on the board right now, and only then from an
 * assumption — and the answer says which, because a break-even computed from a
 * guessed stop is a guess too.
 */
app.get("/api/costs/breakeven", (_req, res) => {
  try {
    const config = settings.getExecConfig();
    const spreadState = executor.status(priceMapNow());
    const history = tracker.load().history || [];
    const boardSignals = (snapshot && snapshot.signals) || [];

    const median = (values) => {
      const sorted = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
      return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    };

    const markets = market.instrumentList().map((inst) => {
      const closedStops = history
        .filter((h) => h.symbol === inst.symbol)
        .map((h) => Math.abs(Number(h.entry) - Number(h.stop)));
      let stopDistance = median(closedStops);
      let stopSource = stopDistance ? `median of ${closedStops.filter((v) => Number.isFinite(v) && v > 0).length} closed signal(s)` : null;

      if (!stopDistance) {
        const liveStops = boardSignals
          .filter((sig) => sig.symbol === inst.symbol)
          .map((sig) => Math.abs(Number(sig.entry) - Number(sig.stop)));
        stopDistance = median(liveStops);
        if (stopDistance) stopSource = "current signal stops";
      }

      if (!stopDistance && costsMod.DEFAULT_STOPS[inst.symbol]) {
        stopDistance = costsMod.DEFAULT_STOPS[inst.symbol];
        stopSource = "assumed default";
      }

      return {
        symbol: inst.symbol,
        label: inst.label,
        valuePerUnit: inst.valuePerPointPerLot,
        stopDistance,
        stopSource: stopSource || "unknown",
      };
    });

    res.json({
      ok: true,
      ...costsMod.breakEvenTable({
        markets,
        config,
        live: spreadState.spreads,
      }),
      spreadSource: spreadState.spreadSource,
      spreadReadAt: spreadState.spreads && Object.values(spreadState.spreads)[0]
        ? Object.values(spreadState.spreads)[0].at
        : null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * TradingView alert receiver.
 *
 * TradingView has no order API; this is the only direction that exists. The
 * alert must carry ?token=… (or an x-tv-token header) matching the saved
 * secret, and TradingView alerts are off unless switched on.
 */
app.post("/api/tv/webhook", async (req, res) => {
  const config = settings.getExecConfig();
  if (!config.tv || !config.tv.enabled) {
    return res.status(403).json({
      ok: false,
      error: "TradingView alerts are switched off — enable them in Risk → Auto-trading",
    });
  }
  if (!tvMod.verify(req, config)) {
    return res.status(401).json({ ok: false, error: "bad or missing token" });
  }

  try {
    const alert = tvMod.parseAlert(req.body);
    if (alert.error) return res.status(400).json({ ok: false, error: alert.error });

    const snap =
      snapshot && Date.now() - snapshotAt < 60000 ? snapshot : await getSnapshot();
    const prices = new Map(((snap && snap.quotes) || []).map((q) => [q.symbol, q.price]));
    const result = await tvMod.place(alert, prices);

    res.status(result.ok ? 200 : 422).json({
      ok: result.ok,
      reason: result.reason || null,
      order: result.order || null,
      alert: { symbol: alert.symbol, side: alert.side },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** The journal: every alert, what it saw, and why it failed. */
app.get("/api/journal", (_req, res) => res.json({ ok: true, ...journal.summary() }));

/** Read-only: what would the gate say about this market right now? */
app.get("/api/brain/gate", async (req, res) => {
  const symbol = String(req.query.symbol || "").toUpperCase();
  const inst = market.instrumentList().find((i) => i.symbol === symbol);
  if (!inst) return res.status(400).json({ ok: false, error: "Unknown market." });
  const verdict = await brainMod.gate(inst.symbol, inst.candleSymbol);
  res.json({ ok: true, enabled: settings.getBrainGate(), ...verdict });
});

app.post("/api/brain/run", async (req, res) => {
  const symbol = String((req.body && req.body.symbol) || "EURUSD").toUpperCase();
  const inst = market.instrumentList().find((i) => i.symbol === symbol);
  if (!inst) return res.status(400).json({ ok: false, error: "Unknown market." });
  const result = await brainMod.runFor(inst.symbol, inst.candleSymbol);
  if (!result) return res.status(500).json({ ok: false, error: brainMod.summary().error });
  res.json({ ok: true, symbol, condition: result.current.label, champions: result.champions });
});

/**
 * Performance of every closed signal: cumulative R, drawdown, streaks.
 * Built from the same tracked trades the learner reads, so the two can never
 * disagree about what happened.
 */
app.get("/api/performance", (_req, res) => {
  const { history } = tracker.load();
  const closed = history
    .filter((h) => h.outcome === "win" || h.outcome === "loss")
    .sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt));

  let running = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let streak = 0;
  let worstStreak = 0;
  const series = [];
  const byMarket = new Map();

  for (const t of closed) {
    const r = Number(t.rMultiple) || 0;
    running += r;
    peak = Math.max(peak, running);
    maxDrawdown = Math.min(maxDrawdown, running - peak);

    if (r > 0) streak = 0;
    else {
      streak += 1;
      worstStreak = Math.max(worstStreak, streak);
    }

    series.push({ at: t.closedAt, r, cumulative: Number(running.toFixed(3)), symbol: t.symbol });

    const row = byMarket.get(t.symbol) || { symbol: t.symbol, n: 0, wins: 0, totalR: 0 };
    row.n += 1;
    if (r > 0) row.wins += 1;
    row.totalR += r;
    byMarket.set(t.symbol, row);
  }

  const wins = closed.filter((h) => h.outcome === "win").length;

  res.json({
    ok: true,
    count: closed.length,
    wins,
    losses: closed.length - wins,
    winrate: closed.length ? Number(((wins / closed.length) * 100).toFixed(1)) : null,
    totalR: Number(running.toFixed(2)),
    avgR: closed.length ? Number((running / closed.length).toFixed(3)) : null,
    maxDrawdownR: Number(maxDrawdown.toFixed(2)),
    worstLosingStreak: worstStreak,
    series,
    byMarket: [...byMarket.values()]
      .map((m) => ({
        ...m,
        winrate: Number(((m.wins / m.n) * 100).toFixed(1)),
        totalR: Number(m.totalR.toFixed(2)),
      }))
      .sort((a, b) => b.totalR - a.totalR),
  });
});

/** Every closed signal as a spreadsheet, for your own review. */
app.get("/api/export/signals.csv", (_req, res) => {
  const { history } = tracker.load();
  const cols = [
    "closedAt", "symbol", "side", "setup", "entry", "stop", "target",
    "outcome", "rMultiple", "heldMinutes", "exit",
  ];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = history
    .filter((h) => h.outcome === "win" || h.outcome === "loss" || h.outcome === "expired")
    .map((h) =>
      [
        h.closedAt, h.symbol, h.side, h.confidence || "standard", h.entry, h.stop,
        h.target, h.outcome, h.rMultiple, h.heldMinutes, h.exit,
      ].map(esc).join(",")
    );

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="zone-watch-signals.csv"');
  res.send([cols.join(","), ...rows].join("\n"));
});

/** The learner: what the app has judged about its own past calls. */
app.get("/api/learning", (_req, res) => {
  const learn = learning.summary();
  const lab = labMod.summary();
  const stats = tracker.stats();

  let heartbeatAt = null;
  try {
    heartbeatAt = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, "utf-8")).iso || null;
  } catch {}

  const deliveries = discord.getDeliveries ? discord.getDeliveries() : [];

  res.json({
    ok: true,
    ...learn,
    tracker: {
      open: stats.open,
      wins: stats.wins,
      losses: stats.losses,
      expired: stats.expired,
      totalR: stats.totalR,
    },
    strategy: Object.fromEntries(
      Object.entries(lab.results || {}).map(([symbol, r]) => [
        symbol,
        { tradable: r.tradable === true, verdict: r.verdict, at: r.at, oos: r.oos },
      ])
    ),
    crew: [
      { id: "scout", name: "Scout", role: "watches prices and zone touches", last: heartbeatAt, busy: false },
      { id: "lab", name: "Lab", role: "re-tests the strategy on unseen data", last: lab.lastRunAt, busy: lab.running === true },
      { id: "brain", name: "Brain", role: "matches strategies to market conditions", last: brainMod.summary().lastRunAt, busy: brainMod.summary().running },
      { id: "learner", name: "Learner", role: "judges every closed trade", last: learn.lastRunAt, busy: false },
      { id: "courier", name: "Courier", role: "delivers to Discord", last: deliveries && deliveries[0] ? deliveries[0].at : null, busy: false },
    ],
  });
});

app.post("/api/lab/run", async (req, res) => {
  try {
    const symbol = String((req.body && req.body.symbol) || "").toUpperCase();
    const instruments = market.instrumentList();
    const target = symbol
      ? instruments.find((i) => i.symbol === symbol)
      : instruments[0];
    if (!target) return res.status(400).json({ ok: false, error: "Unknown market" });
    const result = await labMod.runFor(target.symbol, target.candleSymbol);
    if (!result) return res.status(500).json({ ok: false, error: labMod.summary().error });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/heartbeat", (_req, res) => {
  const beat = readHeartbeat();
  const ageMs = beat && Number.isFinite(beat.at) ? Date.now() - beat.at : null;
  res.json({
    ok: true,
    lastBeat: beat ? beat.iso : null,
    ageSeconds: ageMs == null ? null : Math.round(ageMs / 1000),
    stale: ageMs == null ? true : ageMs > WATCH_INTERVAL_MS * 3,
  });
});

/**
 * Endpoint for an external uptime monitor.
 * 200 = alive and the watcher has checked the market recently.
 * 503 = the process answers but the watcher is stuck, which a plain ping misses.
 */
app.get("/healthz", (_req, res) => {
  const beat = readHeartbeat();
  const ageMs = beat && Number.isFinite(beat.at) ? Date.now() - beat.at : null;
  const limitMs = Math.max(90 * 1000, WATCH_INTERVAL_MS * 4);
  const healthy = ageMs != null && ageMs < limitMs;

  res.status(healthy ? 200 : 503).json({
    ok: healthy,
    service: "zone-watch",
    lastCheck: beat ? beat.iso : null,
    checkAgeSeconds: ageMs == null ? null : Math.round(ageMs / 1000),
    limitSeconds: Math.round(limitMs / 1000),
    uptimeUrl: settings.getStatusPingUrl() ? "configured" : "not set",
    lastUptimePingError: lastStatusPingError,
    ...(healthy ? {} : { error: "watcher has not checked the market recently" }),
  });
});

app.post("/api/status-ping/test", async (_req, res) => {
  if (!settings.getStatusPingUrl()) {
    return res.status(400).json({ ok: false, error: "Add an uptime URL first." });
  }
  const result = await pingStatus({ force: true });
  res.json({ ok: Boolean(result.ok), ...result });
});

/** Paper fills measured against what the backtest promised. */
app.get("/api/paper-review", (_req, res) => {
  res.json({
    ok: true,
    ...paperReviewMod.buildReview({
      exec: executor.status(priceMapNow()),
      brain: brainMod.summary(),
    }),
  });
});

/** What today's digest would say, without sending it. */
app.get("/api/digest", (_req, res) => {
  const j = journal.summary();
  const e = executor.status(priceMapNow());
  const proven = (brainMod.summary().conditions || [])
    .filter((r) => r.champion && r.champion.family)
    .map((r) => r.symbol);
  res.json({
    ok: true,
    text: digestMod.buildDigest({ journal: j, exec: e, proven }),
    wouldSend: digestMod.hasSomethingToReport({ journal: j, exec: e }),
    dueAt: "21:00 UTC",
  });
});

app.get("/api/recap", (_req, res) => {
  const recap = recapMod.buildRecap(tracker.load().history);
  res.json({
    ok: true,
    ...recap,
    due: recapMod.shouldSend(),
    lastSentWeek: recapMod.readState().lastSentWeek,
  });
});

app.post("/api/recap/send", async (_req, res) => {
  try {
    const recap = recapMod.buildRecap(tracker.load().history);
    await discord.sendWeeklyRecap(recap);
    recapMod.markSent();
    res.json({ ok: true, recap });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get("/api/alerts", (_req, res) => {
  res.json({ ok: true, alerts: zonesStore.loadAlerts().slice(-100).reverse() });
});

app.delete("/api/alerts", (_req, res) => {
  zonesStore.saveAlerts([]);
  res.json({ ok: true });
});

app.get("/api/zones", (_req, res) => {
  res.json({ ok: true, zones: zonesStore.loadZones() });
});

app.post("/api/zones", (req, res) => {
  try {
    const zone = zonesStore.normaliseZone(req.body || {});
    const zones = zonesStore.loadZones();
    zones.push(zone);
    zonesStore.saveZones(zones);
    lastStates.delete(zone.id);
    res.json({ ok: true, zone });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.put("/api/zones/:id", (req, res) => {
  try {
    const zones = zonesStore.loadZones();
    const index = zones.findIndex((z) => z.id === req.params.id);
    if (index === -1) return res.status(404).json({ ok: false, error: "Zone not found" });
    zones[index] = zonesStore.normaliseZone({ ...zones[index], ...req.body, id: zones[index].id });
    zonesStore.saveZones(zones);
    lastStates.delete(zones[index].id);
    res.json({ ok: true, zone: zones[index] });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/zones/:id", (req, res) => {
  const zones = zonesStore.loadZones();
  const next = zones.filter((z) => z.id !== req.params.id);
  if (next.length === zones.length) {
    return res.status(404).json({ ok: false, error: "Zone not found" });
  }
  zonesStore.saveZones(next);
  lastStates.delete(req.params.id);
  res.json({ ok: true, deleted: req.params.id });
});

app.get("/api/news", async (_req, res) => {
  try {
    res.json(await news.getNewsSummary());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/settings", (_req, res) => res.json({ ok: true, provider: fullInfo() }));

app.post("/api/settings", (req, res) => {
  const body = req.body || {};
  try {
    if (Object.prototype.hasOwnProperty.call(body, "twelveDataKey")) {
      const key = String(body.twelveDataKey || "").trim();
      if (key && key.length < 12) {
        return res.status(400).json({ ok: false, error: "That does not look like a full API key." });
      }
      if (key) settings.setKey(key);
      else settings.clearKey();
    }
    if (body.symbols && typeof body.symbols === "object") settings.setSymbols(body.symbols);
    if (body.providers && typeof body.providers === "object") settings.setProviders(body.providers);

    if (Object.prototype.hasOwnProperty.call(body, "discordWebhook")) {
      const url = String(body.discordWebhook || "").trim();
      if (url && !/^https?:\/\//i.test(url)) {
        return res.status(400).json({ ok: false, error: "Webhook must start with https://" });
      }
      settings.setDiscord(url);
    }
    if (body.discordChannels && typeof body.discordChannels === "object") {
      settings.setDiscordChannels(body.discordChannels);
    }
    if (Object.prototype.hasOwnProperty.call(body, "discordNews")) settings.setDiscordNews(body.discordNews);
    if (Object.prototype.hasOwnProperty.call(body, "autoZones")) {
      settings.setAutoZones(body.autoZones);
      autoZoneCache.clear();
    }
    if (Object.prototype.hasOwnProperty.call(body, "signalAlerts")) {
      settings.setSignalAlerts(body.signalAlerts);
    }
    if (Object.prototype.hasOwnProperty.call(body, "sessionAlerts")) {
      settings.setSessionAlerts(body.sessionAlerts);
    }
    if (Object.prototype.hasOwnProperty.call(body, "approachAlerts")) {
      settings.setApproachAlerts(body.approachAlerts);
    }
    if (Object.prototype.hasOwnProperty.call(body, "ivbAlerts")) {
      settings.setIvbAlerts(body.ivbAlerts);
    }
    if (Object.prototype.hasOwnProperty.call(body, "brainGate")) {
      settings.setBrainGate(Boolean(body.brainGate));
    }
    if (Object.prototype.hasOwnProperty.call(body, "statusPingUrl")) {
      const url = String(body.statusPingUrl || "").trim();
      if (url && !/^https?:\/\//i.test(url)) {
        return res.status(400).json({ ok: false, error: "Uptime URL must start with https://" });
      }
      settings.setStatusPingUrl(url);
    }
    if (Object.prototype.hasOwnProperty.call(body, "alertOnlyWhenOpen")) {
      settings.setAlertOnlyWhenOpen(body.alertOnlyWhenOpen);
    }
    if (Object.prototype.hasOwnProperty.call(body, "correlationEnabled")) {
      settings.setCorrelationEnabled(body.correlationEnabled);
    }
    if (Object.prototype.hasOwnProperty.call(body, "correlationGroups")) {
      if (body.correlationGroups == null) {
        settings.setCorrelationGroups(null);
      } else {
        // Drop anything that is not a watched market, so a typo cannot quietly
        // create a group that never matches.
        const known = new Set(market.instrumentList().map((i) => i.symbol));
        const ignored = new Set();
        const groups = (Array.isArray(body.correlationGroups) ? body.correlationGroups : [])
          .map((g) => (Array.isArray(g) ? g : []))
          .map((g) =>
            g
              .map((sym) => String(sym || "").toUpperCase().trim())
              .filter((sym) => {
                if (!sym) return false;
                if (known.has(sym)) return true;
                ignored.add(sym);
                return false;
              })
          )
          .filter((g) => g.length >= 2);
        settings.setCorrelationGroups(groups);
        if (ignored.size) {
          return res.json({
            ok: true,
            ignored: [...ignored],
            correlationGroups: settings.getCorrelationGroups(),
          });
        }
      }
    }
    if (body.trading && typeof body.trading === "object") {
      settings.setTradingConfig(body.trading);
    }
    if (body.markets && typeof body.markets === "object") {
      settings.setEnabledMarkets(body.markets);
    }
    if (body.quietHours && typeof body.quietHours === "object") {
      settings.setQuietHours(body.quietHours);
    }
    if (Array.isArray(body.unprovenMarkets)) {
      settings.setUnprovenMarkets(body.unprovenMarkets);
    }

    res.json({ ok: true, provider: fullInfo() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/settings/test", async (_req, res) => {
  try {
    res.json({ ok: true, provider: fullInfo(), results: await market.testAll() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/discord/test", async (req, res) => {
  try {
    const channel = req.body && req.body.channel ? String(req.body.channel) : null;
    if (channel) {
      await discord.sendTest(channel);
      return res.json({ ok: true, results: [{ channel, ok: true }], provider: fullInfo() });
    }
    const results = await discord.testAllChannels();
    res.json({ ok: results.every((r) => r.ok), results, provider: fullInfo() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get("/api/delivery", (_req, res) => res.json({ ok: true, deliveries: discord.getDeliveries() }));

/* ---- journal ---- */

function runPython(script, arg) {
  return new Promise((resolve, reject) => {
    const python = process.platform === "win32" ? "python" : "python3";
    const args = arg ? [script, arg] : [script];
    execFile(
      python,
      args,
      { cwd: WORKSPACE, maxBuffer: 12 * 1024 * 1024, timeout: 30000 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        resolve({ stdout, stderr });
      }
    );
  });
}

app.get("/api/read-log", (_req, res) => {
  const logPath = path.join(WORKSPACE, "trades.json");
  try {
    if (!fs.existsSync(logPath)) return res.json({ ok: false, error: "No trades.json found" });
    res.json({ ok: true, data: JSON.parse(fs.readFileSync(logPath, "utf-8")) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/save-log", (req, res) => {
  const jsonText = req.body.jsonText;
  if (!jsonText) return res.status(400).json({ ok: false, error: "No JSON text provided" });
  try {
    writeJson(path.join(WORKSPACE, "trades.json"), JSON.parse(jsonText), 2);
    res.json({ ok: true, message: "Saved trades.json" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/read-example", (_req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(WORKSPACE, "example_trades.json"), "utf-8"));
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/analyze-json", async (req, res) => {
  const jsonText = req.body.jsonText;
  if (!jsonText) return res.status(400).json({ ok: false, error: "No JSON text provided" });
  const tmp = path.join(WORKSPACE, "_tmp_trades.json");
  try {
    fs.writeFileSync(tmp, jsonText, "utf-8");
    const result = await runPython("analyze.py", tmp);
    res.json({ ok: true, text: result.stdout.replace(/\n{3,}/g, "\n\n").trim() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
});

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

app.listen(PORT, () => {
  const info = fullInfo();
  console.log(`Zone Watch v4 running on port ${PORT}`);
  console.log(
    "Instruments: " +
      info.instruments.map((i) => `${i.symbol} via ${i.provider} (${i.providerSymbol})`).join(", ")
  );
  console.log(`Auto zones: ${info.autoZones ? "on" : "off"} | signals: on`);
  console.log(`Discord: ${info.discord.configured ? "on " + info.discord.hint : "not configured"}`);
  console.log(`Watching every ${Math.round(WATCH_INTERVAL_MS / 1000)}s`);

  getSnapshot({ maxAgeMs: 0 }).catch((err) => console.error("First watch failed:", err.message));
  setInterval(() => {
    runWatchCycle().catch((err) => console.error("Watch cycle failed:", err.message));
  }, WATCH_INTERVAL_MS).unref();
});
