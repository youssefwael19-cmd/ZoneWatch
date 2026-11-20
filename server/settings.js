/**
 * Local settings store.
 *
 * The price API key lives here, in a file on the machine running the app.
 * It is never sent back to the browser in full and never logged. The browser
 * only ever sees a masked hint such as "••••abcd".
 */

const fs = require("fs");
const path = require("path");
const { writeJson, realTarget } = require("./atomicWrite");

const FILE = require("./stateDir").file("settings.json");

function read() {
  try {
    const raw = fs.readFileSync(FILE, "utf-8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function write(obj) {
  // This file holds the broker credentials, so it is written through the shared
  // atomic writer and keeps its 0600 permissions.
  writeJson(FILE, obj, 2);
  try {
    fs.chmodSync(realTarget(FILE), 0o600);
  } catch {}
}

/**
 * The dashboard password. Stored as a scrypt hash plus the cookie-signing
 * secret; the password itself is never written anywhere.
 */
/**
 * Exa API key for the assistant's internet search. Server-side only: the browser
 * never receives more than the last four characters.
 */
function getWebSearchKey() {
  const stored = read();
  return typeof stored.webSearchKey === "string" ? stored.webSearchKey : "";
}

function setWebSearchKey(key) {
  const stored = read();
  const value = String(key || "").trim();
  if (value) stored.webSearchKey = value.slice(0, 300);
  write(stored);
  return getWebSearchKey();
}

function clearWebSearchKey() {
  const stored = read();
  delete stored.webSearchKey;
  write(stored);
}

function getAuth() {
  const stored = read();
  const auth = stored.auth;
  if (!auth || typeof auth !== "object" || !auth.hash || !auth.salt) return null;
  return auth;
}

function setAuth(auth) {
  const stored = read();
  stored.auth = auth;
  write(stored);
  return auth;
}

function clearAuth() {
  const stored = read();
  delete stored.auth;
  write(stored);
}

function getKey() {
  const stored = read();
  return typeof stored.twelveDataKey === "string" ? stored.twelveDataKey : "";
}

function setKey(key) {
  const stored = read();
  stored.twelveDataKey = String(key || "").trim();
  write(stored);
}

function clearKey() {
  const stored = read();
  delete stored.twelveDataKey;
  write(stored);
}

/** Per-instrument provider symbol overrides, e.g. { NASDAQ: "QQQ" }. */
function getSymbols() {
  const stored = read();
  const s = stored.symbols;
  return s && typeof s === "object" ? s : {};
}

function setSymbols(symbols) {
  const stored = read();
  const clean = {};
  if (symbols && typeof symbols === "object") {
    for (const [k, v] of Object.entries(symbols)) {
      const val = String(v || "").trim();
      if (val) clean[k] = val.slice(0, 24);
    }
  }
  stored.symbols = clean;
  write(stored);
}

/** Per-instrument provider choice, e.g. { NASDAQ: "yahoo" }. */
function getProviders() {
  const stored = read();
  const p = stored.providers;
  return p && typeof p === "object" ? p : {};
}

function setProviders(providers) {
  const stored = read();
  const clean = {};
  const allowed = new Set(["yahoo", "twelvedata", "demo"]);
  if (providers && typeof providers === "object") {
    for (const [k, v] of Object.entries(providers)) {
      const val = String(v || "").trim();
      if (allowed.has(val)) clean[k] = val;
    }
  }
  stored.providers = clean;
  write(stored);
}

/** Discord webhook URL for alert delivery. */
function getDiscord() {
  const stored = read();
  return typeof stored.discordWebhook === "string" ? stored.discordWebhook : "";
}

function setDiscord(url) {
  const stored = read();
  const value = String(url || "").trim();
  if (value) stored.discordWebhook = value;
  else delete stored.discordWebhook;
  write(stored);
}

/**
 * Trading preferences: sizing, news blackout, timeframe filter and the daily
 * loss guard. Stored under a single `trading` object so one call reads them all.
 */
function getTradingConfig() {
  const stored = read();
  const c = stored.trading && typeof stored.trading === "object" ? stored.trading : {};

  const num = (value, fallback, min) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= min ? n : fallback;
  };

  return {
    accountSize: num(c.accountSize, 0, 0),
    riskPercent: num(c.riskPercent, 0, 0),
    newsBlackout: c.newsBlackout !== false,
    blackoutMinutes: num(c.blackoutMinutes, 15, 1),
    mtfFilter: c.mtfFilter !== false,
    dailyMaxLosses: num(c.dailyMaxLosses, 3, 0),
    dailyMaxLossR: num(c.dailyMaxLossR, 2, 0),
    // Measured in research/confluence_test.js: requiring a higher score did not
    // improve results (min 3 was actually worse than min 0). Kept at 0 so the
    // checklist is shown for information but does not block a setup.
    minConfluence: num(c.minConfluence, 0, 0),
  };
}

function setTradingConfig(patch) {
  const stored = read();
  const current = getTradingConfig();
  const next = { ...current };

  if (patch && typeof patch === "object") {
    if (patch.accountSize != null) next.accountSize = Math.max(0, Number(patch.accountSize) || 0);
    if (patch.riskPercent != null) next.riskPercent = Math.max(0, Number(patch.riskPercent) || 0);
    if (patch.blackoutMinutes != null)
      next.blackoutMinutes = Math.max(1, Number(patch.blackoutMinutes) || 15);
    if (patch.dailyMaxLosses != null)
      next.dailyMaxLosses = Math.max(0, Number(patch.dailyMaxLosses) || 0);
    if (patch.dailyMaxLossR != null)
      next.dailyMaxLossR = Math.max(0, Number(patch.dailyMaxLossR) || 0);
    if (patch.newsBlackout != null) next.newsBlackout = Boolean(patch.newsBlackout);
    if (patch.mtfFilter != null) next.mtfFilter = Boolean(patch.mtfFilter);
    if (patch.minConfluence != null)
      next.minConfluence = Math.min(5, Math.max(0, Number(patch.minConfluence) || 0));
  }

  stored.trading = next;
  write(stored);
  return next;
}

/** Which markets the watcher should follow. Missing = enabled. */
function getEnabledMarkets() {
  const stored = read();
  const m = stored.markets;
  if (!m || typeof m !== "object") return null;
  return m;
}

function setEnabledMarkets(patch) {
  const stored = read();
  const current = stored.markets && typeof stored.markets === "object" ? stored.markets : {};
  const next = { ...current };
  if (patch && typeof patch === "object") {
    for (const [symbol, enabled] of Object.entries(patch)) {
      next[String(symbol).toUpperCase()] = Boolean(enabled);
    }
  }
  stored.markets = next;
  write(stored);
  return next;
}

/**
 * Assistant credentials. Stored server-side only; the UI and API only ever see
 * a masked hint, never the key itself.
 */
function getAiConfig() {
  const stored = read();
  const c = stored.ai && typeof stored.ai === "object" ? stored.ai : {};
  return {
    apiKey: typeof c.apiKey === "string" ? c.apiKey : "",
    baseUrl: typeof c.baseUrl === "string" ? c.baseUrl : "",
    model: typeof c.model === "string" ? c.model : "",
  };
}

function setAiConfig(patch) {
  const stored = read();
  const current = getAiConfig();
  const next = { ...current };
  if (patch && typeof patch === "object") {
    if (typeof patch.apiKey === "string" && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim();
    if (patch.baseUrl != null) next.baseUrl = String(patch.baseUrl).trim();
    if (patch.model != null) next.model = String(patch.model).trim();
  }
  stored.ai = next;
  write(stored);
  return next;
}

function clearAiConfig() {
  const stored = read();
  if (stored.ai) {
    stored.ai = { apiKey: "", baseUrl: stored.ai.baseUrl || "", model: stored.ai.model || "" };
    write(stored);
  }
  return getAiConfig();
}

function getIvbAlerts() {
  const stored = read();
  return stored.ivbAlerts !== false;
}

function setIvbAlerts(enabled) {
  const stored = read();
  stored.ivbAlerts = Boolean(enabled);
  write(stored);
}

/**
 * Markets allowed to send signals even though the lab blocked them. These
 * alerts are labelled unproven so the override is never mistaken for an edge.
 * Gold is here by request.
 */
/**
 * Markets that move together. Only one alert is sent per group, so this is the
 * list that decides what counts as "the same trade".
 */
const DEFAULT_CORRELATION_GROUPS = [
  ["EURUSD", "GBPUSD"],
  ["AUDJPY", "NZDJPY"],
  ["USDJPY", "USDCHF"],
  ["AUDUSD", "NZDUSD"],
];

function cleanGroups(groups) {
  if (!Array.isArray(groups)) return [];
  return groups
    .map((g) => {
      if (!Array.isArray(g)) return [];
      const symbols = g
        .map((s) => String(s || "").toUpperCase().trim())
        .filter(Boolean);
      return [...new Set(symbols)];
    })
    .filter((g) => g.length >= 2);
}

/**
 * External uptime ping. The URL belongs to a service like Healthchecks.io;
 * it contains a token, so it is stored like a secret and only shown masked.
 */
function getStatusPingUrl() {
  const stored = read();
  return typeof stored.statusPingUrl === "string" ? stored.statusPingUrl : "";
}

function getStatusPingHint() {
  const url = getStatusPingUrl();
  return url ? "••••" + url.slice(-6) : "";
}

function setStatusPingUrl(url) {
  const stored = read();
  stored.statusPingUrl = String(url || "").trim();
  write(stored);
  return stored.statusPingUrl;
}

/** Only send Discord alerts while the market is actually open. */
function getAlertOnlyWhenOpen() {
  const stored = read();
  return stored.alertOnlyWhenOpen !== false;
}

function setAlertOnlyWhenOpen(on) {
  const stored = read();
  stored.alertOnlyWhenOpen = Boolean(on);
  write(stored);
  return stored.alertOnlyWhenOpen;
}

/**
 * Only alert when the brain has a proven rule for this market's current
 * condition. On by default: silence is the correct answer when nothing has
 * been shown to work, and every held-back signal is listed in the dashboard.
 */
function getBrainGate() {
  const stored = read();
  return stored.brainGate !== false;
}

function setBrainGate(on) {
  const stored = read();
  stored.brainGate = Boolean(on);
  write(stored);
  return stored.brainGate;
}

/** Master switch. Off means every market alerts on its own. */
function getCorrelationEnabled() {
  const stored = read();
  return stored.correlationEnabled !== false;
}

function setCorrelationEnabled(on) {
  const stored = read();
  stored.correlationEnabled = Boolean(on);
  write(stored);
  return stored.correlationEnabled;
}

function getCorrelationGroups() {
  const stored = read();
  if (!Array.isArray(stored.correlationGroups)) {
    return DEFAULT_CORRELATION_GROUPS.map((g) => [...g]);
  }
  return cleanGroups(stored.correlationGroups);
}

/** Passing null (or nothing) resets to the built-in groups. */
function setCorrelationGroups(groups) {
  const stored = read();
  if (groups == null) {
    delete stored.correlationGroups;
    write(stored);
    return getCorrelationGroups();
  }
  stored.correlationGroups = cleanGroups(groups);
  write(stored);
  return stored.correlationGroups;
}

function getUnprovenMarkets() {
  const stored = read();
  const list = stored.unprovenMarkets;
  if (!Array.isArray(list)) return ["XAUUSD"];
  return list.map((s) => String(s).toUpperCase()).filter(Boolean);
}

function setUnprovenMarkets(list) {
  const stored = read();
  const clean = Array.isArray(list)
    ? list.map((s) => String(s).toUpperCase()).filter(Boolean)
    : [];
  stored.unprovenMarkets = clean;
  write(stored);
  return clean;
}

/** Quiet hours, in UTC. Alerts are suppressed but the watcher keeps running. */
function getQuietHours() {
  const stored = read();
  const q = stored.quietHours && typeof stored.quietHours === "object" ? stored.quietHours : {};
  const num = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 23 ? n : fallback;
  };
  return {
    enabled: q.enabled === true,
    from: num(q.from, 22),
    to: num(q.to, 7),
  };
}

function setQuietHours(patch) {
  const stored = read();
  const current = getQuietHours();
  const next = { ...current };
  if (patch && typeof patch === "object") {
    if (patch.enabled != null) next.enabled = Boolean(patch.enabled);
    if (patch.from != null) next.from = Math.min(23, Math.max(0, Number(patch.from) || 0));
    if (patch.to != null) next.to = Math.min(23, Math.max(0, Number(patch.to) || 0));
  }
  stored.quietHours = next;
  write(stored);
  return next;
}

const CHANNEL_KEYS = ["alerts", "signals", "results", "news", "daily", "recap"];

/** Per-purpose webhook overrides, e.g. { news: "https://discord.com/api/webhooks/..." }. */
function getDiscordChannels() {
  const stored = read();
  const raw = stored.discordChannels;
  const out = {};
  if (raw && typeof raw === "object") {
    for (const key of CHANNEL_KEYS) {
      if (typeof raw[key] === "string" && raw[key].trim()) out[key] = raw[key].trim();
    }
  }
  return out;
}

/** Merge a patch of channel webhooks. An empty string clears that channel. */
function setDiscordChannels(patch) {
  const stored = read();
  const current = getDiscordChannels();
  if (patch && typeof patch === "object") {
    for (const key of CHANNEL_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      const value = String(patch[key] || "").trim();
      if (value) current[key] = value;
      else delete current[key];
    }
  }
  stored.discordChannels = current;
  write(stored);
}

/**
 * The Discord application behind the /ask slash command: its id, the Ed25519
 * public key Discord signs interactions with, the one user id allowed to ask,
 * and the bot token used only to register the command. The token never leaves
 * the server and is masked wherever it is shown.
 */
function getDiscordCommand() {
  const stored = read();
  const raw = stored.discordCommand && typeof stored.discordCommand === "object" ? stored.discordCommand : {};
  const text = (v, max) => String(v || "").trim().slice(0, max);
  return {
    appId: text(raw.appId, 32),
    publicKey: text(raw.publicKey, 80),
    ownerId: text(raw.ownerId, 32),
    botToken: text(raw.botToken, 200),
  };
}

/** Merge a patch; clearToken empties the bot token without touching the rest. */
function setDiscordCommand(patch) {
  const stored = read();
  const next = getDiscordCommand();
  if (patch && typeof patch === "object") {
    if (patch.appId != null) next.appId = String(patch.appId).trim().slice(0, 32);
    if (patch.publicKey != null) next.publicKey = String(patch.publicKey).trim().slice(0, 80);
    if (patch.ownerId != null) next.ownerId = String(patch.ownerId).trim().slice(0, 32);
    if (typeof patch.botToken === "string" && patch.botToken.trim()) {
      next.botToken = patch.botToken.trim().slice(0, 200);
    }
    if (patch.clearToken) next.botToken = "";
  }
  stored.discordCommand = next;
  write(stored);
  return next;
}

/** What the browser may see about the /ask setup: no token, only its tail. */
function getDiscordCommandStatus() {
  const cmd = getDiscordCommand();
  return {
    appId: cmd.appId,
    publicKey: cmd.publicKey,
    ownerId: cmd.ownerId,
    token: cmd.botToken ? `\u2022\u2022\u2022\u2022${cmd.botToken.slice(-4)}` : "",
    ready: Boolean(cmd.appId && cmd.publicKey && cmd.ownerId),
  };
}

/** Whether news-risk warnings are also posted to Discord. */
function getDiscordNews() {
  const stored = read();
  return stored.discordNews !== false;
}

function setDiscordNews(enabled) {
  const stored = read();
  stored.discordNews = Boolean(enabled);
  write(stored);
}

/** Whether the bot draws its own zones from candle data. */
function getAutoZones() {
  const stored = read();
  return stored.autoZones !== false;
}

function setAutoZones(enabled) {
  const stored = read();
  stored.autoZones = Boolean(enabled);
  write(stored);
}

/** Whether signal changes are posted to Discord. */
function getSignalAlerts() {
  const stored = read();
  return stored.signalAlerts !== false;
}

function setSignalAlerts(enabled) {
  const stored = read();
  stored.signalAlerts = Boolean(enabled);
  write(stored);
}

/** Whether market session open/close alerts are posted to Discord. */
function getSessionAlerts() {
  const stored = read();
  return stored.sessionAlerts !== false;
}

function getApproachAlerts() {
  const stored = read();
  return stored.approachAlerts !== false;
}

function setApproachAlerts(enabled) {
  const stored = read();
  stored.approachAlerts = Boolean(enabled);
  write(stored);
}

function setSessionAlerts(enabled) {
  const stored = read();
  stored.sessionAlerts = Boolean(enabled);
  write(stored);
}

/** Only ever reveal the last four characters. */
function mask(key) {
  if (!key) return "";
  const tail = key.length >= 4 ? key.slice(-4) : key;
  return "••••" + tail;
}

/* ------------------------------------------------------------------ *
 * Auto-trading
 *
 * Off by default, paper mode by default, and every value clamped to
 * something survivable. The executor refuses anything outside these.
 * ------------------------------------------------------------------ */

const EXEC_DEFAULTS = {
  enabled: false,
  mode: "paper",
  riskPct: 0.5,
  maxDailyLossPct: 2,
  maxPositions: 2,
  accountBalance: 1000,
  // Leverage the paper account models. A real $200 account cannot open these
  // positions without borrowing, so paper reserves notional / leverage as
  // margin and refuses an order that would need more than the free margin.
  leverage: 2000,
  // Margin level (equity / margin used) at which paper stops positions out, as
  // a percentage. 100 closes when equity no longer covers the margin, 50 when
  // half of it is gone — the level most retail brokers use.
  stopOutPct: 100,
  symbolSuffix: "m",
  symbolOverrides: { NASDAQ: "USTEC" },
  bridgeUrl: "",
  bridgeSecret: "",
  // A broker's own REST API, for accounts with no terminal to run: the app
  // places the order from the cloud and the broker holds the stop. Off until
  // an account id and token are filled in.
  direct: { provider: "oanda", environment: "practice", accountId: "", token: "" },
  requireGate: true,
  // TradingView can only send alerts, so these settings describe the receiver.
  // requireGate stays true by default: an alert from outside the app has not
  // been measured by the brain, and should not silently skip it.
  tv: { enabled: false, secret: "", requireGate: true },
  // Broker costs. Spreads come from server/costs.js unless overridden per
  // symbol here; commission and swap default to zero rather than a guess.
  // Slippage is charged as a fraction of the spread, with per-symbol overrides
  // in `slippage` when one market behaves differently.
  costs: {
    spreads: {},
    commissionPerLot: 0,
    swapPerLotPerNight: 0,
    slippage: {},
    slippageSpreadMultiple: 0.25,
  },
};

function getExecConfig() {
  const stored = read();
  const exec = stored.exec && typeof stored.exec === "object" ? stored.exec : {};
  return {
    ...EXEC_DEFAULTS,
    ...exec,
    symbolOverrides: { ...EXEC_DEFAULTS.symbolOverrides, ...(exec.symbolOverrides || {}) },
    tv: { ...EXEC_DEFAULTS.tv, ...(exec.tv || {}) },
    direct: { ...EXEC_DEFAULTS.direct, ...(exec.direct || {}) },
    costs: {
      ...EXEC_DEFAULTS.costs,
      ...(exec.costs || {}),
      spreads: { ...(exec.costs && exec.costs.spreads) },
    },
  };
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function setExecConfig(patch = {}) {
  const stored = read();
  const current = getExecConfig();
  const next = { ...current };

  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  if (patch.mode !== undefined) {
    next.mode = ["paper", "bridge", "direct"].includes(patch.mode) ? patch.mode : "paper";
  }
  if (patch.riskPct !== undefined) next.riskPct = clampNumber(patch.riskPct, 0.01, 3, current.riskPct);
  if (patch.maxDailyLossPct !== undefined) {
    next.maxDailyLossPct = clampNumber(patch.maxDailyLossPct, 0.5, 10, current.maxDailyLossPct);
  }
  if (patch.maxPositions !== undefined) {
    next.maxPositions = Math.round(clampNumber(patch.maxPositions, 1, 5, current.maxPositions));
  }
  if (patch.accountBalance !== undefined) {
    next.accountBalance = clampNumber(patch.accountBalance, 1, 1e9, current.accountBalance);
  }
  if (patch.leverage !== undefined) {
    next.leverage = Math.round(clampNumber(patch.leverage, 1, 3000, current.leverage));
  }
  if (patch.stopOutPct !== undefined) {
    next.stopOutPct = Math.round(clampNumber(patch.stopOutPct, 0, 100, current.stopOutPct));
  }
  if (patch.requireGate !== undefined) next.requireGate = Boolean(patch.requireGate);
  if (patch.symbolOverrides && typeof patch.symbolOverrides === "object") {
    for (const [k, v] of Object.entries(patch.symbolOverrides)) {
      if (typeof v === "string" && v.trim()) next.symbolOverrides[k] = v.trim().slice(0, 40);
    }
  }
  if (typeof patch.symbolSuffix === "string") next.symbolSuffix = patch.symbolSuffix.trim().slice(0, 10);
  if (typeof patch.bridgeUrl === "string") next.bridgeUrl = patch.bridgeUrl.trim().slice(0, 500);
  if (typeof patch.bridgeSecret === "string" && patch.bridgeSecret.trim()) {
    next.bridgeSecret = patch.bridgeSecret.trim().slice(0, 200);
  }
  if (patch.clearBridgeSecret) next.bridgeSecret = "";
  if (patch.direct && typeof patch.direct === "object") {
    const direct = { ...next.direct };
    if (typeof patch.direct.provider === "string") {
      direct.provider = patch.direct.provider.trim().slice(0, 40) || EXEC_DEFAULTS.direct.provider;
    }
    if (patch.direct.environment !== undefined) {
      direct.environment = patch.direct.environment === "live" ? "live" : "practice";
    }
    if (typeof patch.direct.accountId === "string") {
      direct.accountId = patch.direct.accountId.trim().slice(0, 40);
    }
    if (typeof patch.direct.baseUrl === "string") {
      direct.baseUrl = patch.direct.baseUrl.trim().slice(0, 300);
    }
    if (typeof patch.direct.token === "string" && patch.direct.token.trim()) {
      direct.token = patch.direct.token.trim().slice(0, 400);
    }
    // cTrader credentials: the OAuth application and its refresh token.
    for (const field of ["clientId", "clientSecret", "refreshToken"]) {
      if (typeof patch.direct[field] === "string" && patch.direct[field].trim()) {
        direct[field] = patch.direct[field].trim().slice(0, 400);
      }
    }
    if (patch.direct.clearToken) direct.token = "";
    next.direct = direct;
  }
  if (patch.costs && typeof patch.costs === "object") {
    const costs = { ...next.costs, spreads: { ...(next.costs.spreads || {}) } };
    if (patch.costs.commissionPerLot !== undefined) {
      costs.commissionPerLot = clampNumber(patch.costs.commissionPerLot, 0, 1000, costs.commissionPerLot);
    }
    if (patch.costs.swapPerLotPerNight !== undefined) {
      costs.swapPerLotPerNight = clampNumber(patch.costs.swapPerLotPerNight, -1000, 1000, costs.swapPerLotPerNight);
    }
    if (patch.costs.spreads && typeof patch.costs.spreads === "object") {
      for (const [symbol, value] of Object.entries(patch.costs.spreads)) {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) costs.spreads[String(symbol).toUpperCase()] = n;
      }
    }
    if (patch.costs.slippageSpreadMultiple !== undefined) {
      costs.slippageSpreadMultiple = clampNumber(
        patch.costs.slippageSpreadMultiple,
        0,
        5,
        costs.slippageSpreadMultiple
      );
    }
    if (patch.costs.slippage && typeof patch.costs.slippage === "object") {
      costs.slippage = { ...(costs.slippage || {}) };
      for (const [symbol, value] of Object.entries(patch.costs.slippage)) {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) costs.slippage[String(symbol).toUpperCase()] = n;
      }
    }
    next.costs = costs;
  }
  if (patch.tv && typeof patch.tv === "object") {
    const tv = { ...next.tv };
    if (patch.tv.enabled !== undefined) tv.enabled = Boolean(patch.tv.enabled);
    if (patch.tv.requireGate !== undefined) tv.requireGate = Boolean(patch.tv.requireGate);
    if (typeof patch.tv.secret === "string" && patch.tv.secret.trim()) {
      tv.secret = patch.tv.secret.trim().slice(0, 200);
    }
    if (patch.tv.clearSecret) tv.secret = "";
    next.tv = tv;
  }

  stored.exec = next;
  write(stored);
  return next;
}

/** Masked broker API token, the same way the bridge secret is masked. */
function getDirectHint() {
  const direct = getExecConfig().direct || {};
  // cTrader can run on the refresh token alone, so either credential proves
  // something is stored without revealing what.
  const token = direct.token || direct.refreshToken || "";
  if (!token) return "";
  return `••••${token.slice(-4)}`;
}

function getExecHint() {
  const config = getExecConfig();
  const secret = config.bridgeSecret || "";
  if (!secret) return "";
  return `••••${secret.slice(-4)}`;
}

/** The TradingView webhook token, masked the same way. */
function getTvHint() {
  const secret = (getExecConfig().tv || {}).secret || "";
  if (!secret) return "";
  return `••••${secret.slice(-4)}`;
}

module.exports = {
  getBrainGate,
  getExecConfig,
  setExecConfig,
  getExecHint,
  getTvHint,
  getDirectHint,
  setBrainGate,
  getWebSearchKey,
  setWebSearchKey,
  clearWebSearchKey,
  getAuth,
  setAuth,
  clearAuth,
  getKey,
  setKey,
  clearKey,
  getSymbols,
  setSymbols,
  getProviders,
  setProviders,
  getDiscord,
  setDiscord,
  getDiscordChannels,
  setDiscordChannels,
  getTradingConfig,
  setTradingConfig,
  getEnabledMarkets,
  setEnabledMarkets,
  getUnprovenMarkets,
  setUnprovenMarkets,
  getCorrelationGroups,
  setCorrelationGroups,
  getCorrelationEnabled,
  setCorrelationEnabled,
  getAlertOnlyWhenOpen,
  setAlertOnlyWhenOpen,
  getStatusPingUrl,
  getStatusPingHint,
  setStatusPingUrl,
  DEFAULT_CORRELATION_GROUPS,
  getIvbAlerts,
  setIvbAlerts,
  getAiConfig,
  setAiConfig,
  clearAiConfig,
  getQuietHours,
  setQuietHours,
  getDiscordCommand,
  setDiscordCommand,
  getDiscordCommandStatus,
  getDiscordNews,
  setDiscordNews,
  getAutoZones,
  setAutoZones,
  getSignalAlerts,
  setSignalAlerts,
  getSessionAlerts,
  setSessionAlerts,
  getApproachAlerts,
  setApproachAlerts,
  mask,
};
