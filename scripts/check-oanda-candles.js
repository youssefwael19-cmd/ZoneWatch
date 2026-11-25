/*
 * Scratch check, not part of the app: does the optional OANDA candle source map
 * only known tickers, page past one 5,000-bar request, fall back to Yahoo, and
 * stay out of the way when no token is set?
 *
 * Mocks fetch, so no token or network is needed.
 */
const candles = require("../server/candles");

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} = ${JSON.stringify(actual)}${ok ? "" : "  expected " + JSON.stringify(expected)}`);
  if (ok) passed++; else failed++;
}

const saved = {
  token: process.env.OANDA_API_TOKEN,
  environment: process.env.OANDA_ENVIRONMENT,
  provider: process.env.CANDLE_PROVIDER,
};
const realFetch = global.fetch;
const realWarn = console.warn;

function yahooBar(t, c = 1.1) {
  return { t, o: c, h: c + 0.001, l: c - 0.001, c };
}
function oandaCandle(t, c = 1.1) {
  return {
    complete: true,
    volume: 10,
    time: new Date(t).toISOString().replace("Z", "000000Z"),
    mid: { o: String(c), h: String(c + 0.001), l: String(c - 0.001), c: String(c) },
  };
}
function yahooJson(bars) {
  return {
    chart: {
      result: [
        {
          timestamp: bars.map((b) => Math.round(b.t / 1000)),
          indicators: {
            quote: [
              {
                open: bars.map((b) => b.o),
                high: bars.map((b) => b.h),
                low: bars.map((b) => b.l),
                close: bars.map((b) => b.c),
                volume: bars.map(() => 0),
              },
            ],
          },
        },
      ],
    },
  };
}
function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

(async () => {
  try {
    // --- No token: everything stays on Yahoo -------------------------------
    delete process.env.OANDA_API_TOKEN;
    delete process.env.CANDLE_PROVIDER;
    candles.clearCache();
    let calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      return jsonResponse(yahooJson([yahooBar(1700000000000)]));
    };
    let bars = await candles.getCandles("EURUSD=X", "1h", "1y");
    check("no token reads Yahoo", calls.length === 1 && calls[0].includes("finance.yahoo.com"), true);
    check("no token gets bars back", bars.length, 1);

    // --- Token set: known ticker moves to OANDA and pages backwards --------
    process.env.OANDA_API_TOKEN = "practice-token";
    delete process.env.CANDLE_PROVIDER;
    candles.clearCache();
    calls = [];
    const step = 60 * 60 * 1000;
    const newest = 1700000000000;
    let oandaPages = 0;
    global.fetch = async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("finance.yahoo.com")) throw new Error("Yahoo should not be called");
      oandaPages++;
      if (oandaPages === 1) {
        const candlesOut = [];
        for (let i = 0; i < 5000; i++) candlesOut.push(oandaCandle(newest + i * step));
        return jsonResponse({ instrument: "EUR_USD", candles: candlesOut });
      }
      if (oandaPages === 2) {
        const candlesOut = [];
        for (let i = 0; i < 5000; i++) candlesOut.push(oandaCandle(newest - (i + 1) * step));
        return jsonResponse({ instrument: "EUR_USD", candles: candlesOut });
      }
      return jsonResponse({ instrument: "EUR_USD", candles: [] });
    };
    const now = Date.now();
    // The mock's fixed timestamps are old, so ask for a range wide enough that
    // the range trim keeps them.
    bars = await candles.getCandles("EURUSD=X", "1h", "10y");
    check("known ticker asks OANDA, not Yahoo", calls.every((u) => u.includes("api-fxpractice.oanda.com")), true);
    check("OANDA call uses the mapped instrument", calls[0].includes("/v3/instruments/EUR_USD/candles"), true);
    check("long range is paged", calls.some((u) => u.includes("&to=")), true);
    check("pages are 5,000 bars", calls[0].includes("count=5000"), true);
    check("bars from both pages are returned", bars.length > 5000, true);
    check("bars arrive in time order", bars.every((b, i) => i === 0 || b.t > bars[i - 1].t), true);

    // Headers are part of the contract: the token must travel as a header, not
    // in the URL.
    let seenHeaders = null;
    global.fetch = async (url, opts) => {
      seenHeaders = opts && opts.headers;
      return jsonResponse({ candles: [oandaCandle(now)] });
    };
    candles.clearCache();
    await candles.getCandles("GC=F", "15m", "5d");
    check("token is sent as an Authorization header", seenHeaders && seenHeaders.Authorization, "Bearer practice-token");

    // --- CANDLE_PROVIDER=yahoo forces Yahoo even with a token --------------
    process.env.CANDLE_PROVIDER = "yahoo";
    candles.clearCache();
    calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      return jsonResponse(yahooJson([yahooBar(now)]));
    };
    await candles.getCandles("GC=F", "15m", "5d");
    check("provider override forces Yahoo", calls[0].includes("finance.yahoo.com"), true);

    // --- Unknown tickers stay on Yahoo (BTCUSD is not an OANDA instrument) --
    delete process.env.CANDLE_PROVIDER;
    candles.clearCache();
    calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      return jsonResponse(yahooJson([yahooBar(now)]));
    };
    await candles.getCandles("BTC-USD", "1h", "1y");
    check("unmapped ticker stays on Yahoo", calls[0].includes("finance.yahoo.com"), true);

    // --- A rejected token falls back to Yahoo, with one warning ------------
    candles.clearCache();
    const warnings = [];
    console.warn = (msg) => warnings.push(String(msg));
    calls = [];
    global.fetch = async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("oanda.com")) return jsonResponse({ errorMessage: "unauthorized" }, 401);
      return jsonResponse(yahooJson([yahooBar(now), yahooBar(now + step)]));
    };
    bars = await candles.getCandles("GBPUSD=X", "1h", "1mo");
    check("rejected token falls back to Yahoo bars", bars.length, 2);
    check("fallback still reached OANDA first", calls[0].includes("oanda.com"), true);
    await candles.getCandles("GBPUSD=X", "1h", "3mo");
    check("the warning is logged once per instrument", warnings.length, 1);
    check("the warning names the fallback", /using Yahoo candles/.test(warnings[0]), true);

    // --- Caching ------------------------------------------------------------
    candles.clearCache();
    calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      return jsonResponse({ candles: [oandaCandle(now)] });
    };
    await candles.getCandles("USDCAD=X", "1h", "1mo");
    const afterFirst = calls.length;
    await candles.getCandles("USDCAD=X", "1h", "1mo");
    check("second call is served from cache", calls.length, afterFirst);

    // --- Only market data is read -----------------------------------------
    check("no account or order calls are made", calls.every((u) => u.includes("/candles")), true);
  } finally {
    global.fetch = realFetch;
    console.warn = realWarn;
    for (const [key, value] of Object.entries(saved)) {
      const envKey = key === "token" ? "OANDA_API_TOKEN" : key === "environment" ? "OANDA_ENVIRONMENT" : "CANDLE_PROVIDER";
      if (value == null) delete process.env[envKey];
      else process.env[envKey] = value;
    }
    candles.clearCache();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
