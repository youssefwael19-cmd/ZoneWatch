/**
 * Candle history for automatic zone detection and signals.
 *
 * Three sources, same bar shape:
 *   Yahoo  : default. Key-free chart endpoint that returns OHLC arrays.
 *   OANDA  : used when OANDA_API_TOKEN is set. The free practice account is
 *            enough, and it is the same token the direct broker uses.
 *   Deriv  : chosen in Settings (or CANDLE_PROVIDER=deriv as the default before
 *            a choice is saved). Its market-data socket needs no login, key or
 *            account at all.
 *
 * Only market data is read from the broker feeds — no account, order or stop
 * call is made from this path. A ticker that is not in the exact map below
 * stays on Yahoo, because guessing an instrument would silently swap the
 * series under zones that were drawn on the other feed.
 *
 * Results are cached per source+symbol+interval+range for three minutes, so a
 * 10-second quote loop does not turn into a candle-hammering loop. The source
 * of the last successful fetch is kept per ticker so the dashboard can show
 * where a market's candles really came from.
 */

const { openDeriv } = require("./derivsocket");
const settings = require("./settings");

const CACHE_TTL_MS = 3 * 60 * 1000;
const PAGE_SIZE = 5000;

// Yahoo candle ticker -> broker instrument. The app's candleSymbol is always
// the Yahoo ticker (see server/market.js), so this is the only lookup needed.
// A broker missing from a row keeps that ticker on Yahoo.
const INSTRUMENTS = {
  "GC=F": { oanda: "XAU_USD", deriv: "frxXAUUSD" },
  "^NDX": { oanda: "NAS100_USD", deriv: "OTC_NDX" },
  "EURUSD=X": { oanda: "EUR_USD", deriv: "frxEURUSD" },
  "GBPUSD=X": { oanda: "GBP_USD", deriv: "frxGBPUSD" },
  "USDJPY=X": { oanda: "USD_JPY", deriv: "frxUSDJPY" },
  "AUDUSD=X": { oanda: "AUD_USD", deriv: "frxAUDUSD" },
  "USDCAD=X": { oanda: "USD_CAD", deriv: "frxUSDCAD" },
  "USDCHF=X": { oanda: "USD_CHF", deriv: "frxUSDCHF" },
  "AUDJPY=X": { oanda: "AUD_JPY", deriv: "frxAUDJPY" },
  "NZDJPY=X": { oanda: "NZD_JPY", deriv: "frxNZDJPY" },
  // OANDA no longer lists crypto; Deriv does.
  "BTC-USD": { deriv: "cryBTCUSD" },
};

const OANDA_BASE = {
  practice: "https://api-fxpractice.oanda.com",
  live: "https://api-fxtrade.oanda.com",
};

const OANDA_GRANULARITY = {
  "1m": "M1",
  "5m": "M5",
  "15m": "M15",
  "30m": "M30",
  "1h": "H1",
  "4h": "H4",
  "1d": "D",
};

// Deriv takes its candle width in seconds.
const DERIV_GRANULARITY = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

// Minutes per bar and days per range, used to decide how much history a
// requested Yahoo range actually means when a broker is asked for bars.
const INTERVAL_MINUTES = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "4h": 240,
  "1d": 1440,
};
const RANGE_DAYS = {
  "1d": 1,
  "5d": 5,
  "7d": 7,
  "1mo": 31,
  "3mo": 92,
  "6mo": 183,
  "60d": 60,
  "1y": 365,
  "2y": 730,
  "10y": 3650,
};

const OANDA_MAX_PAGES = 8;
const DERIV_MAX_PAGES = 16;

const cache = new Map();
const warned = new Set();
const lastUse = new Map();
// Exact source of each interval/range actually used. Unlike lastUse (one
// summary per symbol, overwritten by whichever range was fetched last), this is
// keyed by the series so the lab can record and re-check the bars it measured.
const seriesUse = new Map();

function seriesKey(ticker, interval, range) {
  return `${ticker}|${interval}|${range}`;
}

function rememberSeries(ticker, interval, range, configured, used, bars, extra = {}) {
  seriesUse.set(seriesKey(ticker, interval, range), {
    ticker,
    interval,
    range,
    configuredProvider: configured.source,
    configuredSymbol: configured.symbol || ticker,
    provider: used.source,
    providerSymbol: used.symbol || ticker,
    fallback: Boolean(used.fallback),
    reason: used.reason || extra.reason || null,
    depthFallback: Boolean(extra.depthFallback),
    actualKnown: true,
    bars: bars.length,
    firstBar: bars.length ? bars[0].t : null,
    lastBar: bars.length ? bars[bars.length - 1].t : null,
    at: new Date().toISOString(),
  });
}

/**
 * The period a bar array actually covers.
 *
 * A provider can answer a range request with far fewer bars than that range
 * implies — Deriv serves about three months of 5m for a "2y" request — so a
 * verdict has to say what it measured, not only what it asked for.
 */
function coverageOf(bars) {
  const list = Array.isArray(bars) ? bars : [];
  let from = Infinity;
  let to = -Infinity;
  for (const bar of list) {
    const t = Number(bar && bar.t);
    if (!Number.isFinite(t)) continue;
    if (t < from) from = t;
    if (t > to) to = t;
  }
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    bars: list.length,
  };
}

/** The source actually used for one ticker/interval/range, or null if not read yet. */
function seriesInfo(ticker, interval, range) {
  const seen = seriesUse.get(seriesKey(ticker, interval, range));
  return seen ? { ...seen } : null;
}

function parseChart(json) {
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result || !result.timestamp || !result.indicators) return null;

  const quote = result.indicators.quote && result.indicators.quote[0];
  if (!quote) return null;

  const bars = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const o = quote.open && quote.open[i];
    const h = quote.high && quote.high[i];
    const l = quote.low && quote.low[i];
    const c = quote.close && quote.close[i];
    if ([o, h, l, c].some((v) => v == null || !Number.isFinite(v))) continue;
    // Volume is reported for futures and indices; FX spot returns zeros.
    const v = quote.volume && Number(quote.volume[i]);
    bars.push({ t: result.timestamp[i] * 1000, o, h, l, c, v: Number.isFinite(v) ? v : 0 });
  }

  return bars.length ? bars : null;
}

async function fetchYahoo(ticker, interval, range) {
  // Yahoo has no 4h interval. Four 1h bars, bucketed on the clock, are the
  // same candle the broker feeds serve, so a 4h entry works on every source.
  if (interval === "4h") {
    const hourly = await fetchYahoo(ticker, "1h", range);
    return aggregateBars(hourly, 4 * 60 * 60 * 1000);
  }

  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(ticker) +
    `?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; zone-watch/3.0)" },
  });
  if (!res.ok) throw new Error(`Candle request failed (HTTP ${res.status}) for ${ticker}`);

  const json = await res.json();
  const bars = parseChart(json);
  if (!bars) throw new Error(`No candle data for ${ticker}`);
  return bars;
}

/** Fold consecutive bars into fixed UTC buckets, keeping OHLC and summing volume. */
function aggregateBars(bars, span) {
  const out = [];
  for (const bar of bars) {
    const bucket = Math.floor(bar.t / span) * span;
    const last = out[out.length - 1];
    if (last && last.t === bucket) {
      last.h = Math.max(last.h, bar.h);
      last.l = Math.min(last.l, bar.l);
      last.c = bar.c;
      last.v += bar.v || 0;
    } else {
      out.push({ t: bucket, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v || 0 });
    }
  }
  return out;
}

function oandaConfig() {
  const token = String(process.env.OANDA_API_TOKEN || "").trim();
  if (!token) return null;
  const environment = String(process.env.OANDA_ENVIRONMENT || "").toLowerCase() === "live" ? "live" : "practice";
  return { token, environment, base: OANDA_BASE[environment] };
}

const CANDLE_CHOICES = ["auto", "yahoo", "oanda", "deriv"];

function envCandleProvider() {
  const value = String(process.env.CANDLE_PROVIDER || "").toLowerCase();
  return CANDLE_CHOICES.includes(value) ? value : "";
}

/**
 * The choice saved in Settings wins. CANDLE_PROVIDER is only the default for a
 * server that has never saved one, so changing the feed in the dashboard is not
 * silently undone by an environment variable on the next request.
 */
function candleProvider() {
  return settings.getCandleProvider() || envCandleProvider() || "auto";
}

/** What is in effect, where it came from, and what the Settings control offers. */
function candleProviderInfo() {
  const saved = settings.getCandleProvider();
  const env = envCandleProvider();
  return {
    choice: saved || env || "auto",
    saved,
    env,
    source: saved ? "settings" : env ? "env" : "default",
    options: CANDLE_CHOICES,
  };
}

/**
 * Pick the feed for one ticker. "auto" keeps the old behaviour: OANDA when a
 * token is saved, Yahoo otherwise. The other values are explicit choices, so
 * nobody silently switches a market to a feed they did not ask for.
 */
function sourceFor(ticker) {
  const choice = candleProvider();
  const row = INSTRUMENTS[ticker];
  if (!row || choice === "yahoo") return { source: "yahoo" };

  const wanted = choice === "auto" ? (oandaConfig() ? "oanda" : "yahoo") : choice;
  const symbol = row[wanted];
  return symbol ? { source: wanted, symbol } : { source: "yahoo" };
}

/**
 * Turn Yahoo's range into a number of bars. A year of hourly bars is ~6,000
 * market hours, more than one 5,000-bar page, which is why the fetches page
 * backwards instead of returning the newest page and calling it the range.
 */
function barsNeeded(interval, range) {
  const minutes = INTERVAL_MINUTES[interval];
  const days = RANGE_DAYS[range];
  if (!minutes || !days) return PAGE_SIZE;
  return Math.ceil((days * 24 * 60) / minutes) + 1;
}

function trimToRange(bars, range) {
  const days = RANGE_DAYS[range];
  if (!days) return bars;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const inRange = bars.filter((bar) => bar.t >= cutoff);
  return inRange.length ? inRange : bars;
}

function parseOandaCandles(json) {
  const raw = json && json.candles;
  if (!Array.isArray(raw)) return [];
  const bars = [];
  for (const candle of raw) {
    const mid = candle && candle.mid;
    if (!mid) continue;
    const o = Number(mid.o);
    const h = Number(mid.h);
    const l = Number(mid.l);
    const c = Number(mid.c);
    if ([o, h, l, c].some((v) => !Number.isFinite(v))) continue;
    // OANDA timestamps carry nanoseconds; keep the milliseconds Date parses.
    const iso = String(candle.time || "").replace(/(\.\d{3})\d+/, "$1");
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) continue;
    const v = Number(candle.volume);
    bars.push({ t, o, h, l, c, v: Number.isFinite(v) ? v : 0 });
  }
  return bars;
}

async function fetchOanda(ticker, instrument, interval, range) {
  const cfg = oandaConfig();
  if (!cfg) throw new Error("no OANDA token");

  const granularity = OANDA_GRANULARITY[interval];
  if (!granularity) throw new Error(`OANDA has no ${interval} candles`);

  const wanted = barsNeeded(interval, range);
  const byTime = new Map();
  let to = null;

  for (let page = 0; page < OANDA_MAX_PAGES && byTime.size < wanted; page++) {
    let url =
      `${cfg.base}/v3/instruments/${encodeURIComponent(instrument)}/candles` +
      `?granularity=${encodeURIComponent(granularity)}&count=${PAGE_SIZE}&price=M`;
    if (to) url += `&to=${encodeURIComponent(to)}`;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: "application/json",
      },
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error("OANDA rejected the candle token");
    }
    if (!res.ok) throw new Error(`OANDA candle request failed (HTTP ${res.status}) for ${instrument}`);

    const json = await res.json();
    if (json && json.errorMessage) throw new Error(`OANDA: ${String(json.errorMessage).slice(0, 200)}`);

    const bars = parseOandaCandles(json);
    if (!bars.length) break;

    let oldest = Infinity;
    for (const bar of bars) {
      byTime.set(bar.t, bar);
      if (bar.t < oldest) oldest = bar.t;
    }

    // Ask for the page before the oldest bar we have. One millisecond back so
    // the boundary bar is not returned twice.
    to = new Date(oldest - 1).toISOString();
  }

  if (!byTime.size) throw new Error(`No candle data for ${ticker} from OANDA`);
  const bars = [...byTime.values()].sort((a, b) => a.t - b.t);

  // Match the range the caller asked for instead of handing back every bar the
  // pages happened to contain. A 1-year request must not become 13 years of
  // daily bars just because one page holds 5,000 of them.
  return trimToRange(bars, range);
}

function parseDerivCandles(raw) {
  if (!Array.isArray(raw)) return [];
  const bars = [];
  for (const candle of raw) {
    if (!candle) continue;
    // Deriv stamps candles with epoch seconds and sends no volume.
    const t = Number(candle.epoch) * 1000;
    const o = Number(candle.open);
    const h = Number(candle.high);
    const l = Number(candle.low);
    const c = Number(candle.close);
    if ([t, o, h, l, c].some((v) => !Number.isFinite(v))) continue;
    bars.push({ t, o, h, l, c, v: 0 });
  }
  return bars;
}

async function fetchDeriv(ticker, symbol, interval, range) {
  const granularity = DERIV_GRANULARITY[interval];
  if (!granularity) throw new Error(`Deriv has no ${interval} candles`);

  const wanted = barsNeeded(interval, range);
  const byTime = new Map();
  let end = "latest";

  const session = await openDeriv();
  try {
    for (let page = 0; page < DERIV_MAX_PAGES && byTime.size < wanted; page++) {
      const json = await session.request({
        ticks_history: symbol,
        style: "candles",
        granularity,
        count: PAGE_SIZE,
        end,
      });

      if (json && json.error) {
        const reason = json.error.message || json.error.code || "request refused";
        throw new Error(`Deriv: ${String(reason).slice(0, 200)}`);
      }

      const bars = parseDerivCandles(json && json.candles);
      if (!bars.length) break;

      let oldest = Infinity;
      for (const bar of bars) {
        byTime.set(bar.t, bar);
        if (bar.t < oldest) oldest = bar.t;
      }

      // One second before the oldest candle we have, so the boundary candle is
      // not returned twice.
      if (!Number.isFinite(oldest)) break;
      const before = String(Math.floor(oldest / 1000) - 1);
      if (before === end || Number(before) <= 0) break;
      end = before;
    }
  } finally {
    session.close();
  }

  if (!byTime.size) throw new Error(`No candle data for ${ticker} from Deriv`);
  const bars = [...byTime.values()].sort((a, b) => a.t - b.t);
  return trimToRange(bars, range);
}

function warnOnce(ticker, label, message) {
  if (warned.has(ticker)) return;
  warned.add(ticker);
  console.warn(`[candles] ${label} unavailable for ${ticker} (${message}); using Yahoo candles.`);
}

/**
 * @param {string} ticker  Yahoo symbol, e.g. "^NDX" or "XAUUSD=X"
 * @param {string} interval  1m, 5m, 15m, 30m, 1h, 4h, 1d
 * @param {string} range     1d, 5d, 1mo, 3mo
 */
async function getCandles(ticker, interval = "15m", range = "5d") {
  const chosen = sourceFor(ticker);
  const key = `${chosen.source}|${ticker}|${interval}|${range}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.bars;

  let used = chosen;
  let bars;

  if (chosen.source === "yahoo") {
    bars = await fetchYahoo(ticker, interval, range);
  } else {
    const label = chosen.source === "oanda" ? "OANDA" : "Deriv";
    const fetchFromBroker = chosen.source === "oanda" ? fetchOanda : fetchDeriv;
    try {
      bars = await fetchFromBroker(ticker, chosen.symbol, interval, range);
      warned.delete(ticker);
    } catch (err) {
      // A credential or feed problem costs freshness, not the dashboard.
      warnOnce(ticker, label, err.message);
      bars = await fetchYahoo(ticker, interval, range);
      used = { source: "yahoo", symbol: ticker, fallback: true, reason: err.message };
    }
  }

  rememberSeries(ticker, interval, range, chosen, used, bars);
  lastUse.set(ticker, {
    source: used.source,
    symbol: used.symbol || ticker,
    fallback: Boolean(used.fallback),
    reason: used.reason || null,
    at: Date.now(),
    bars: bars.length,
    lastBar: bars.length ? bars[bars.length - 1].t : null,
  });
  cache.set(key, { at: Date.now(), bars });
  return bars;
}

/**
 * Where one market's candles actually came from: the chosen feed before the
 * first read, then the source of the last successful fetch, including a Yahoo
 * fallback. Read-only and secret-free, so the dashboard can show it.
 */
function feedInfo(ticker) {
  const chosen = sourceFor(ticker);
  const seen = lastUse.get(ticker);
  return {
    configured: candleProvider(),
    provider: seen ? seen.source : chosen.source,
    providerSymbol: seen ? seen.symbol : chosen.symbol || ticker,
    fallback: seen ? seen.fallback : false,
    reason: seen ? seen.reason : null,
    checkedAt: seen ? new Date(seen.at).toISOString() : null,
    bars: seen ? seen.bars : null,
    lastBar: seen && seen.lastBar ? new Date(seen.lastBar).toISOString() : null,
  };
}

function clearCache() {
  cache.clear();
  warned.clear();
  lastUse.clear();
  seriesUse.clear();
}

/** Yahoo history without touching the candle-feed readout. The lab uses this
 * only for the daily bias series, which needs more history than some broker
 * daily feeds return; the entry series still comes from the configured feed. */
async function getYahooCandles(ticker, interval, range, opts = {}) {
  const bars = await fetchYahoo(ticker, interval, range);
  // A caller that records the deliberate depth fallback itself can keep this
  // read from overwriting the configured series' identity.
  if (opts.record === false) return bars;
  const configured = sourceFor(ticker);
  rememberSeries(
    ticker,
    interval,
    range,
    configured,
    { source: "yahoo", symbol: ticker, reason: opts.reason || null },
    bars,
    { depthFallback: opts.depthFallback === true, reason: opts.reason || null }
  );
  return bars;
}

module.exports = {
  getCandles,
  getYahooCandles,
  seriesInfo,
  coverageOf,
  feedInfo,
  clearCache,
  sourceFor,
  candleProvider,
  candleProviderInfo,
  aggregateBars,
};
