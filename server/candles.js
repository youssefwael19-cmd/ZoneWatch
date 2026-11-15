/**
 * Candle history for automatic zone detection and signals.
 *
 * Uses Yahoo's chart endpoint, which is key-free and returns OHLC arrays.
 * Results are cached per symbol+interval so a 10-second quote loop does not
 * turn into a candle-hammering loop.
 */

const CACHE_TTL_MS = 3 * 60 * 1000;

const cache = new Map();

function cacheKey(ticker, interval, range) {
  return `${ticker}|${interval}|${range}`;
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

/**
 * @param {string} ticker  Yahoo symbol, e.g. "^NDX" or "XAUUSD=X"
 * @param {string} interval  1m, 5m, 15m, 30m, 1h, 1d
 * @param {string} range     1d, 5d, 1mo, 3mo
 */
async function getCandles(ticker, interval = "15m", range = "5d") {
  const key = cacheKey(ticker, interval, range);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.bars;

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

  cache.set(key, { at: Date.now(), bars });
  return bars;
}

function clearCache() {
  cache.clear();
}

module.exports = { getCandles, clearCache };
