/**
 * TradingView alerts → orders.
 *
 * TradingView has no retail trading API. Its REST API is a broker-integration
 * product, and its support pages say plainly that there is no data/execution
 * API for individual traders. What it does give every user is an alert that
 * POSTs a message to a URL you own. So that is the integration, and it is the
 * only one that exists: TradingView decides, this endpoint receives, the
 * executor places.
 *
 * Two consequences worth being explicit about:
 *   - the order is only as good as the alert. A Pine strategy repainting, or a
 *     person clicking "test", sends a real order;
 *   - the brain gate cannot approve a TradingView alert, because it has no
 *     idea which rule produced it. Gate bypass is therefore a separate switch,
 *     off by default, and the order is labelled with its source.
 *
 * The alert body may be JSON:
 *   { "symbol": "XAUUSD", "action": "buy", "entry": 4010, "stop": 3990, "target": 4050 }
 * or one plain-text line, which is easier to write in TradingView's message box:
 *   BUY XAUUSD entry=4010 stop=3990 target=4050
 */

const crypto = require("crypto");

const brainMod = require("./brain");
const executor = require("./executor");
const market = require("./market");
const settings = require("./settings");

// TradingView tickers do not match broker tickers. Exchange prefixes are
// stripped first, then these aliases cover the common index and gold symbols.
const ALIASES = {
  GOLD: "XAUUSD",
  "XAU/USD": "XAUUSD",
  XAUUSDT: "XAUUSD",
  "GC=F": "XAUUSD",
  GC: "XAUUSD",
  NDX: "NASDAQ",
  NAS100: "NASDAQ",
  NAS100USD: "NASDAQ",
  US100: "NASDAQ",
  USTEC: "NASDAQ",
  US500: "NASDAQ",
  "NQ=F": "NASDAQ",
  NQ: "NASDAQ",
};

function optionSymbols() {
  try {
    return market.instrumentList().map((i) => i.symbol);
  } catch {
    return [];
  }
}

/**
 * Map a TradingView/broker symbol onto an app market, or null if it is not one.
 * Handles "OANDA:XAUUSD", "^NDX", "XAUUSDm" (Exness suffix) and "EUR/USD".
 */
function normalizeSymbol(raw) {
  const symbols = optionSymbols();
  let s = String(raw || "").trim().toUpperCase();

  s = s.replace(/^[A-Z0-9._-]+:/, ""); // exchange prefix
  s = s.replace(/^\^/, ""); // Yahoo-style index caret
  s = s.replace(/\s+/g, "");
  s = s.replace(/\/(?!USD$)/g, ""); // keep "XAU/USD" for the alias table
  s = s.replace(/\.(CASH|SPOT|F|D)$/, ""); // MT5 contract decorations

  if (symbols.includes(s)) return s;
  if (ALIASES[s]) return ALIASES[s];

  const flat = s.replace(/[^A-Z0-9]/g, "");
  if (symbols.includes(flat)) return flat;
  if (ALIASES[flat]) return ALIASES[flat];

  // Exness suffixes: EURUSDm, XAUUSDm, USTECm.
  const unsuffixed = flat.replace(/M$/, "");
  if (symbols.includes(unsuffixed)) return unsuffixed;
  if (ALIASES[unsuffixed]) return ALIASES[unsuffixed];

  return null;
}

function num(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstNumber(body, keys) {
  for (const key of keys) {
    const n = num(body[key]);
    if (n != null) return n;
  }
  return null;
}

/** Accept JSON objects and TradingView's single-line message format. */
function parseText(text) {
  const tokens = String(text).trim().split(/[\s,]+/).filter(Boolean);
  if (tokens.length < 2) return { error: "alert message is too short" };

  const side = tokens[0].toUpperCase();
  if (!["BUY", "SELL", "LONG", "SHORT"].includes(side)) {
    return { error: `first word must be BUY or SELL, got "${tokens[0]}"` };
  }

  const out = { action: side === "LONG" ? "BUY" : side === "SHORT" ? "SELL" : side, symbol: tokens[1] };
  for (const token of tokens.slice(2)) {
    const m = /^([a-z_]+)=(.+)$/i.exec(token);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2];
    if (key === "entry" || key === "price") out.entry = value;
    else if (key === "stop" || key === "sl" || key === "stoploss") out.stop = value;
    else if (key === "target" || key === "tp" || key === "takeprofit") out.target = value;
    else if (key === "symbol" || key === "ticker") out.symbol = value;
  }
  return out;
}

/**
 * @returns {{error: string}|{symbol: string, side: string, entry: number, stop: number, target: number}}
 */
function parseAlert(body) {
  let raw = body;
  if (typeof raw === "string") raw = parseText(raw);
  else if (raw && typeof raw.raw === "string" && !raw.symbol) raw = parseText(raw.raw);
  else if (raw && typeof raw.message === "string" && !raw.symbol) raw = parseText(raw.message);

  if (!raw || raw.error) return { error: raw && raw.error ? raw.error : "empty alert body" };

  const sideRaw = String(raw.action || raw.side || raw.direction || "").toUpperCase();
  const side = sideRaw === "LONG" ? "BUY" : sideRaw === "SHORT" ? "SELL" : sideRaw;
  if (!["BUY", "SELL"].includes(side)) return { error: 'alert needs "action": "buy" or "sell"' };

  const symbol = normalizeSymbol(raw.symbol || raw.ticker || raw.instrument);
  if (!symbol) {
    return {
      error: `unknown symbol "${raw.symbol || raw.ticker || raw.instrument || ""}". Known markets: ${optionSymbols().join(", ")}`,
    };
  }

  const entry = firstNumber(raw, ["entry", "price", "entryPrice"]);
  const stop = firstNumber(raw, ["stop", "sl", "stopLoss", "stop_loss"]);
  const target = firstNumber(raw, ["target", "tp", "takeProfit", "take_profit"]);

  for (const [name, value] of [["entry", entry], ["stop", stop], ["target", target]]) {
    if (value == null) return { error: `alert is missing ${name}` };
  }
  if (entry === stop) return { error: "stop equals entry" };
  if (side === "BUY" && !(stop < entry && target > entry)) {
    return { error: `a BUY needs stop below entry and target above it (entry ${entry}, stop ${stop}, target ${target})` };
  }
  if (side === "SELL" && !(stop > entry && target < entry)) {
    return { error: `a SELL needs stop above entry and target below it (entry ${entry}, stop ${stop}, target ${target})` };
  }

  return { symbol, side, entry, stop, target };
}

/** Token from a header or the query string, compared in constant time. */
function providedToken(req) {
  const header = req.get ? req.get("x-tv-token") : null;
  const query = req.query && req.query.token;
  return String(header || query || "");
}

function verify(req, config) {
  const secret = config && config.tv && config.tv.secret;
  if (!secret) return false;
  const given = providedToken(req);
  if (!given || given.length !== secret.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  } catch {
    return false;
  }
}

/**
 * Turn a parsed alert into an order. Everything is left to the executor: the
 * kill switch, the daily loss cap, maximum positions and one-position-per-
 * market all still apply, and a refusal is reported rather than retried.
 */
async function place(alert, priceBySymbol) {
  const config = settings.getExecConfig();
  if (!config.tv || !config.tv.enabled) {
    return { ok: false, reason: "TradingView alerts are switched off in the app" };
  }

  const live = priceBySymbol instanceof Map ? priceBySymbol.get(alert.symbol) : null;

  // By default an external alert still has to clear the brain gate: if the app
  // has no proven rule for this market in this condition, the order is refused.
  // Turning the switch off is the only way past that, and it is labelled
  // "gate bypassed" in the status panel.
  let gate = { blocked: false, condition: "tradingview alert", verdict: null };
  const requireGate = !config.tv || config.tv.requireGate !== false;
  if (requireGate) {
    const inst = market.instrumentList().find((i) => i.symbol === alert.symbol);
    if (!inst) return { ok: false, reason: `${alert.symbol} is not a market this app tracks` };

    let verdict;
    try {
      verdict = await brainMod.gate(alert.symbol, inst.candleSymbol);
    } catch (err) {
      return { ok: false, reason: `brain gate failed, so the alert was refused (${err.message})` };
    }
    if (!verdict.allowed) {
      return {
        ok: false,
        reason: `brain gate refused the alert: ${verdict.reason}`,
        condition: verdict.condition,
      };
    }
    gate = { blocked: false, condition: verdict.condition, verdict: verdict.champion || null };
  }

  const signal = {
    symbol: alert.symbol,
    side: alert.side,
    entry: alert.entry,
    price: Number.isFinite(live) ? live : alert.entry,
    stop: alert.stop,
    target: alert.target,
    at: new Date().toISOString(),
    source: "tradingview",
    gate,
  };

  return executor.place(signal, priceBySymbol);
}

module.exports = { parseAlert, normalizeSymbol, verify, place };
