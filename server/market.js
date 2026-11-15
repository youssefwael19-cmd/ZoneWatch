/**
 * Market data adapter with per-instrument providers, throttling and a budget.
 *
 * Providers:
 *   twelvedata : needs a free API key. Real-time spot forex (XAU/USD), US
 *                stocks and ETFs. Free tier is 8 requests/minute and ~800/day,
 *                so it is throttled hard to protect the key.
 *   yahoo      : key-free JSON endpoint. Index levels (^NDX), futures (GC=F),
 *                stocks. Unofficial, so treated as best effort.
 *   demo       : simulated random walk, no network.
 *
 * Minimum gap between real requests per provider:
 *   twelvedata 120s  (800/day is one request per ~108s if run continuously)
 *   yahoo        5s
 *
 * When a request is skipped because of throttling, the last known price is
 * returned with `fromCache: true` and its age, so the UI can be honest about
 * how fresh the number is instead of pretending it just updated.
 */

const settings = require("./settings");

const DEFAULTS = {
  XAUUSD: {
    label: "XAU/USD · Gold",
    provider: "twelvedata",
    twelveData: "XAU/USD",
    yahoo: "GC=F",
    tradingView: "OANDA:XAUUSD",
    decimals: 2,
    unit: "USD",
    valuePerPointPerLot: 100,
  },
  NASDAQ: {
    label: "NASDAQ 100 · ^NDX",
    provider: "yahoo",
    twelveData: "QQQ",
    yahoo: "^NDX",
    tradingView: "OANDA:NAS100USD",
    decimals: 1,
    unit: "pts",
    valuePerPointPerLot: 1,
  },

  // ---- Currencies with the strongest published evidence ----
  // Majors that carry trend and momentum well, plus the two classic carry
  // pairings (AUD/JPY and NZD/JPY: high-yielder against the funding currency).
  // All on Yahoo, so they cost no Twelve Data budget.
  EURUSD: {
    label: "EUR/USD",
    provider: "yahoo",
    twelveData: "EUR/USD",
    yahoo: "EURUSD=X",
    tradingView: "FX:EURUSD",
    decimals: 5,
    unit: "USD",
    valuePerPointPerLot: 100000,
    minUpdateMs: 30000,
  },
  GBPUSD: {
    label: "GBP/USD",
    provider: "yahoo",
    twelveData: "GBP/USD",
    yahoo: "GBPUSD=X",
    tradingView: "FX:GBPUSD",
    decimals: 5,
    unit: "USD",
    valuePerPointPerLot: 100000,
    minUpdateMs: 30000,
  },
  USDJPY: {
    label: "USD/JPY",
    provider: "yahoo",
    twelveData: "USD/JPY",
    yahoo: "USDJPY=X",
    tradingView: "FX:USDJPY",
    decimals: 3,
    unit: "JPY",
    valuePerPointPerLot: 650,
    minUpdateMs: 30000,
  },
  AUDUSD: {
    label: "AUD/USD",
    provider: "yahoo",
    twelveData: "AUD/USD",
    yahoo: "AUDUSD=X",
    tradingView: "FX:AUDUSD",
    decimals: 5,
    unit: "USD",
    valuePerPointPerLot: 100000,
    minUpdateMs: 30000,
  },
  USDCAD: {
    label: "USD/CAD",
    provider: "yahoo",
    twelveData: "USD/CAD",
    yahoo: "USDCAD=X",
    tradingView: "FX:USDCAD",
    decimals: 5,
    unit: "CAD",
    valuePerPointPerLot: 72000,
    minUpdateMs: 30000,
  },
  USDCHF: {
    label: "USD/CHF",
    provider: "yahoo",
    twelveData: "USD/CHF",
    yahoo: "USDCHF=X",
    tradingView: "FX:USDCHF",
    decimals: 5,
    unit: "CHF",
    valuePerPointPerLot: 113000,
    minUpdateMs: 30000,
  },
  AUDJPY: {
    label: "AUD/JPY · carry",
    provider: "yahoo",
    twelveData: "AUD/JPY",
    yahoo: "AUDJPY=X",
    tradingView: "FX:AUDJPY",
    decimals: 3,
    unit: "JPY",
    valuePerPointPerLot: 650,
    minUpdateMs: 30000,
  },
  NZDJPY: {
    label: "NZD/JPY · carry",
    provider: "yahoo",
    twelveData: "NZD/JPY",
    yahoo: "NZDJPY=X",
    tradingView: "FX:NZDJPY",
    decimals: 3,
    unit: "JPY",
    valuePerPointPerLot: 650,
    minUpdateMs: 30000,
  },
};

const THROTTLE_MS = { twelvedata: 120000, yahoo: 5000, demo: 0 };
const TWELVE_DAILY_LIMIT = 780; // leave headroom under 800

const demoState = {
  XAUUSD: { last: 3952.4, volatility: 1.8 },
  NASDAQ: { last: 28370.0, volatility: 24.0 },
  EURUSD: { last: 1.085, volatility: 0.0008 },
  GBPUSD: { last: 1.268, volatility: 0.001 },
  USDJPY: { last: 155.2, volatility: 0.15 },
  AUDUSD: { last: 0.652, volatility: 0.0007 },
  USDCAD: { last: 1.388, volatility: 0.001 },
  USDCHF: { last: 0.884, volatility: 0.0008 },
  AUDJPY: { last: 101.2, volatility: 0.12 },
  NZDJPY: { last: 92.4, volatility: 0.12 },
};

const priceCache = new Map();
const budget = { day: "", twelve: 0 };

function apiKey() {
  return process.env.TWELVE_DATA_API_KEY || settings.getKey() || "";
}

function providerFor(symbol) {
  const saved = settings.getProviders();
  if (saved && typeof saved[symbol] === "string" && saved[symbol]) {
    const chosen = saved[symbol];
    if (chosen === "twelvedata" && !apiKey()) return "demo";
    return chosen;
  }
  if ((process.env.MARKET_PROVIDER || "").toLowerCase() === "demo") return "demo";
  const cfg = DEFAULTS[symbol];
  if (!cfg) return "demo";
  if (cfg.provider === "twelvedata" && !apiKey()) return "demo";
  return cfg.provider;
}

function providerSymbolFor(symbol, provider) {
  const cfg = DEFAULTS[symbol];
  if (!cfg) return symbol;
  const prov = provider || providerFor(symbol);

  const saved = settings.getSymbols();
  if (saved && typeof saved[symbol] === "string" && saved[symbol].trim()) {
    return saved[symbol].trim();
  }

  const envVar =
    symbol === "XAUUSD" ? process.env.TWELVE_XAUUSD_SYMBOL : process.env.TWELVE_NASDAQ_SYMBOL;
  if (envVar && envVar.trim()) return envVar.trim();

  return prov === "yahoo" ? cfg.yahoo : cfg.twelveData;
}

function instrumentList() {
  const savedProviders = settings.getProviders() || {};
  return Object.entries(DEFAULTS).map(([symbol, cfg]) => {
    const provider = providerFor(symbol);
    return {
      symbol,
      label: cfg.label,
      decimals: cfg.decimals,
      unit: cfg.unit,
      tradingView: cfg.tradingView,
      valuePerPointPerLot: cfg.valuePerPointPerLot,
      candleSymbol: cfg.yahoo,
      provider,
      providerSetting: savedProviders[symbol] || "auto",
      providerSymbol: providerSymbolFor(symbol, provider),
      minUpdateMs: cfg.minUpdateMs ?? THROTTLE_MS[provider] ?? 0,
      defaultProviderSymbol: cfg.twelveData,
    };
  });
}

function demoQuote(symbol) {
  const cfg = DEFAULTS[symbol];
  const state = demoState[symbol];
  state.last = Math.max(0.01, state.last + (Math.random() - 0.5) * state.volatility);
  const spread = state.volatility * 0.05;
  return {
    symbol,
    label: cfg.label,
    decimals: cfg.decimals,
    unit: cfg.unit,
    price: Number(state.last.toFixed(cfg.decimals)),
    bid: Number((state.last - spread).toFixed(cfg.decimals)),
    ask: Number((state.last + spread).toFixed(cfg.decimals)),
    providerSymbol: "simulated",
    source: "demo",
    stale: false,
    timestamp: new Date().toISOString(),
  };
}

async function yahooQuote(symbol) {
  const cfg = DEFAULTS[symbol];
  const ticker = providerSymbolFor(symbol, "yahoo");
  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(ticker) +
    "?interval=1m&range=1d";

  const res = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; zone-watch/3.0)" },
  });
  if (!res.ok) throw new Error(`Yahoo responded HTTP ${res.status}`);

  const data = await res.json();
  const meta =
    data && data.chart && data.chart.result && data.chart.result[0] && data.chart.result[0].meta;
  const price = Number(meta && meta.regularMarketPrice);
  if (!Number.isFinite(price)) {
    throw new Error(`No price for "${ticker}" from Yahoo. Check the symbol in Settings.`);
  }

  const marketTime = Number(meta.regularMarketTime) * 1000;
  return {
    symbol,
    label: cfg.label,
    decimals: cfg.decimals,
    unit: cfg.unit,
    price: Number(price.toFixed(cfg.decimals)),
    bid: null,
    ask: null,
    providerSymbol: ticker,
    source: "yahoo",
    stale: false,
    lastMarketUpdate: Number.isFinite(marketTime) ? new Date(marketTime).toISOString() : null,
    timestamp: new Date().toISOString(),
  };
}

async function twelveDataQuote(symbol) {
  const cfg = DEFAULTS[symbol];
  const key = apiKey();
  if (!key) throw new Error("No API key saved yet");

  const ticker = providerSymbolFor(symbol, "twelvedata");
  const url =
    "https://api.twelvedata.com/price?symbol=" +
    encodeURIComponent(ticker) +
    "&apikey=" +
    encodeURIComponent(key);

  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });

  if (res.status === 401 || res.status === 403) {
    throw new Error("The API key was rejected. Check it and save it again.");
  }
  if (res.status === 429) {
    throw new Error("Twelve Data rate limit reached. Gold will refresh again shortly.");
  }
  if (!res.ok) throw new Error(`Twelve Data responded HTTP ${res.status}`);

  const data = await res.json();

  if (data && data.status === "error") {
    const msg = String(data.message || "Price provider error");
    if (/api key/i.test(msg) || data.code === 401 || data.code === 403) {
      throw new Error("The API key was rejected. Check it and save it again.");
    }
    if (/not found|invalid symbol|no data|not available/i.test(msg)) {
      throw new Error(
        `"${ticker}" is not on your plan. Indices need a paid tier — use the Yahoo source for this instrument.`
      );
    }
    if (/limit|credits|requests/i.test(msg)) {
      throw new Error("Twelve Data limit reached. Gold will refresh again shortly.");
    }
    throw new Error(msg);
  }

  const price = Number(data && data.price);
  if (!Number.isFinite(price)) {
    throw new Error(`No price for "${ticker}". Try a different symbol in Settings.`);
  }

  return {
    symbol,
    label: cfg.label,
    decimals: cfg.decimals,
    unit: cfg.unit,
    price: Number(price.toFixed(cfg.decimals)),
    bid: null,
    ask: null,
    providerSymbol: ticker,
    source: "twelvedata",
    stale: false,
    timestamp: new Date().toISOString(),
  };
}

function errorQuote(symbol, provider, message) {
  const cfg = DEFAULTS[symbol] || {};
  return {
    symbol,
    label: cfg.label || symbol,
    decimals: cfg.decimals ?? 2,
    unit: cfg.unit || "",
    price: null,
    bid: null,
    ask: null,
    providerSymbol: providerSymbolFor(symbol, provider),
    source: provider,
    stale: true,
    error: message,
    timestamp: new Date().toISOString(),
  };
}

async function getQuote(symbol) {
  const provider = providerFor(symbol);
  const now = Date.now();
  const cfgGap = DEFAULTS[symbol] && DEFAULTS[symbol].minUpdateMs;
  const gap = cfgGap ?? THROTTLE_MS[provider] ?? 0;
  const cached = priceCache.get(symbol);

  // Serve from cache when the provider's safe interval has not elapsed.
  if (cached && cached.provider === provider && gap > 0 && now - cached.at < gap) {
    return { ...cached.quote, fromCache: true, cacheAgeMs: now - cached.at };
  }

  if (provider === "twelvedata") {
    const today = new Date().toISOString().slice(0, 10);
    if (budget.day !== today) {
      budget.day = today;
      budget.twelve = 0;
    }
    if (budget.twelve >= TWELVE_DAILY_LIMIT) {
      const message =
        "Daily Twelve Data budget reached (~800/day on the free plan). Switch gold to the Yahoo source in Settings for uninterrupted fast updates.";
      if (cached) {
        return { ...cached.quote, fromCache: true, cacheAgeMs: now - cached.at, warning: message };
      }
      return errorQuote(symbol, provider, message);
    }
    budget.twelve++;
  }

  let quote;
  try {
    if (provider === "demo") quote = demoQuote(symbol);
    else if (provider === "yahoo") quote = await yahooQuote(symbol);
    else quote = await twelveDataQuote(symbol);
  } catch (err) {
    // Fall back to the last known good price rather than showing nothing.
    if (cached && cached.quote.price != null) {
      return {
        ...cached.quote,
        fromCache: true,
        cacheAgeMs: now - cached.at,
        warning: err.message,
      };
    }
    return errorQuote(symbol, provider, err.message);
  }

  if (quote.price != null) priceCache.set(symbol, { at: now, provider, quote });
  return quote;
}

async function getQuotes(symbols) {
  const list = symbols && symbols.length ? symbols : Object.keys(DEFAULTS);
  return Promise.all(list.map((s) => getQuote(s)));
}

function providerInfo() {
  const key = apiKey();
  const today = new Date().toISOString().slice(0, 10);
  return {
    provider: "per-instrument",
    hasKey: Boolean(key),
    keyHint: settings.mask(key),
    instruments: instrumentList(),
    budget: {
      day: budget.day,
      used: budget.day === today ? budget.twelve : 0,
      limit: TWELVE_DAILY_LIMIT,
    },
  };
}

async function testAll() {
  const results = [];
  for (const inst of instrumentList()) {
    const quote = await getQuote(inst.symbol);
    results.push({
      symbol: inst.symbol,
      label: inst.label,
      provider: quote.source,
      providerSymbol: quote.providerSymbol,
      ok: quote.price != null,
      price: quote.price,
      fromCache: Boolean(quote.fromCache),
      error: quote.error || null,
    });
  }
  return results;
}

module.exports = {
  DEFAULTS,
  instrumentList,
  getQuote,
  getQuotes,
  providerInfo,
  testAll,
  providerFor,
  providerSymbolFor,
  THROTTLE_MS,
};
