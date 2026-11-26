/*
 * Scratch check, not part of the app: when a market's candles come from Deriv,
 * does its live quote come from the identical Deriv instrument? Also checks
 * that a market without Deriv candles goes back to its normal quote source.
 *
 * Stubs global WebSocket and fetch, so no account, key or network is needed.
 */
const settings = require("../server/settings");

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} = ${JSON.stringify(actual)}${ok ? "" : "  expected " + JSON.stringify(expected)}`);
  if (ok) passed++;
  else failed++;
}

const savedEnv = {
  provider: process.env.CANDLE_PROVIDER,
  token: process.env.OANDA_API_TOKEN,
  market: process.env.MARKET_PROVIDER,
};
const realFetch = global.fetch;
const realWebSocket = global.WebSocket;
const realSettings = {
  getProviders: settings.getProviders,
  getSymbols: settings.getSymbols,
  getKey: settings.getKey,
};

// A clean, unsaved configuration: no per-market provider or symbol override,
// no Twelve Data key. The environment still selects the candle provider.
settings.getProviders = () => ({});
settings.getSymbols = () => ({});
settings.getKey = () => "";

const PRICES = {
  frxXAUUSD: 3600.12,
  OTC_NDX: 25000.5,
  frxEURUSD: 1.1,
  cryBTCUSD: 60000,
};

class FakeSocket {
  static sockets = [];

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    this.listeners = new Map();
    FakeSocket.sockets.push(this);
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  emit(type, event) {
    for (const fn of [...(this.listeners.get(type) || [])]) fn(event);
  }

  send(text) {
    const req = JSON.parse(text);
    this.sent.push(req);

    if (req.ticks) {
      const price = PRICES[req.ticks] ?? 100;
      const tick = {
        symbol: req.ticks,
        quote: price,
        bid: price - 0.01,
        ask: price + 0.01,
        epoch: Math.floor(Date.now() / 1000),
      };
      queueMicrotask(() =>
        this.emit("message", {
          data: JSON.stringify({ msg_type: "tick", req_id: req.req_id, tick }),
        })
      );
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", { code: 1000, reason: "" });
  }
}

function yahooMeta(price) {
  return {
    chart: {
      result: [
        {
          meta: {
            regularMarketPrice: price,
            regularMarketTime: Math.floor(Date.now() / 1000),
          },
        },
      ],
    },
  };
}

(async () => {
  const candles = require("../server/candles");
  const market = require("../server/market");
  const derivQuotes = require("../server/derivquotes");

  try {
    global.WebSocket = FakeSocket;
    delete process.env.OANDA_API_TOKEN;
    delete process.env.MARKET_PROVIDER;
    process.env.CANDLE_PROVIDER = "deriv";
    candles.clearCache();
    FakeSocket.sockets = [];

    let httpCalls = 0;
    global.fetch = async () => {
      httpCalls++;
      throw new Error("Deriv quotes should not use an HTTP provider");
    };

    const quotes = await market.getQuotes(["XAUUSD", "NASDAQ", "EURUSD", "BTCUSD"]);
    const bySymbol = new Map(quotes.map((q) => [q.symbol, q]));

    check("every mapped market quotes from Deriv", quotes.map((q) => q.source), ["deriv", "deriv", "deriv", "deriv"]);
    check("Deriv quotes make no HTTP request", httpCalls, 0);
    check("gold quotes frxXAUUSD", bySymbol.get("XAUUSD").providerSymbol, "frxXAUUSD");
    check("Nasdaq quotes OTC_NDX", bySymbol.get("NASDAQ").providerSymbol, "OTC_NDX");
    check("EUR/USD quotes frxEURUSD", bySymbol.get("EURUSD").providerSymbol, "frxEURUSD");
    check("Bitcoin quotes cryBTCUSD", bySymbol.get("BTCUSD").providerSymbol, "cryBTCUSD");
    check("the quote symbol is the candle symbol", bySymbol.get("EURUSD").providerSymbol, candles.sourceFor("EURUSD=X").symbol);
    check("gold price is the tick, rounded to the market", bySymbol.get("XAUUSD").price, 3600.12);
    check("a Deriv quote carries a bid", bySymbol.get("EURUSD").bid, 1.09);
    check("a Deriv quote carries an ask", bySymbol.get("EURUSD").ask, 1.11);
    check("the tick timestamp is the market update", /^\d{4}-\d{2}-\d{2}T/.test(bySymbol.get("EURUSD").lastMarketUpdate), true);

    const info = market.quoteInfo("EURUSD");
    check("the readout records the Deriv source", info.source, "deriv");
    check("the readout records the Deriv symbol", info.providerSymbol, "frxEURUSD");
    check("a fresh quote is not cached", info.fromCache, false);

    // The quote feed opens one socket and subscribes, not one socket per quote.
    check("quotes share one socket", FakeSocket.sockets.length, 1);
    const sent = FakeSocket.sockets[0].sent;
    check("only tick subscriptions are sent", sent.every((r) => Boolean(r.ticks)), true);
    check("no account or order request is made", sent.every((r) => !r.authorize && !r.buy && !r.proposal && !r.sell), true);

    // Without Deriv candles, the market returns to its normal quote provider.
    process.env.CANDLE_PROVIDER = "yahoo";
    candles.clearCache();
    httpCalls = 0;
    global.fetch = async () => {
      httpCalls++;
      return { ok: true, status: 200, json: async () => yahooMeta(1.23456) };
    };
    const yahoo = await market.getQuote("EURUSD");
    check("without Deriv candles the quote returns to Yahoo", yahoo.source, "yahoo");
    check("the Yahoo quote uses the Yahoo symbol", yahoo.providerSymbol, "EURUSD=X");
    check("the Yahoo read was made over HTTP", httpCalls, 1);
    check("the readout follows the source back to Yahoo", market.quoteInfo("EURUSD").source, "yahoo");
  } finally {
    derivQuotes.close();
    candles.clearCache();
    global.fetch = realFetch;
    global.WebSocket = realWebSocket;
    for (const [key, fn] of Object.entries(realSettings)) settings[key] = fn;
    const envNames = { provider: "CANDLE_PROVIDER", token: "OANDA_API_TOKEN", market: "MARKET_PROVIDER" };
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value == null) delete process.env[envNames[key]];
      else process.env[envNames[key]] = value;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
