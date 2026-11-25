/*
 * Scratch check, not part of the app: does the key-free Deriv candle source map
 * only known tickers, page backwards past one 5,000-bar request, trim to the
 * requested range, fall back to Yahoo, and stay on market data only?
 *
 * Stubs global WebSocket and fetch, so no account, key or network is needed.
 */
const candles = require("../server/candles");

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} = ${JSON.stringify(actual)}${ok ? "" : "  expected " + JSON.stringify(expected)}`);
  if (ok) passed++;
  else failed++;
}

const saved = {
  provider: process.env.CANDLE_PROVIDER,
  token: process.env.OANDA_API_TOKEN,
};
const realFetch = global.fetch;
const realWarn = console.warn;
const realWebSocket = global.WebSocket;

class FakeSocket {
  static sockets = [];
  static reply = null;

  static reset() {
    FakeSocket.sockets = [];
    FakeSocket.reply = null;
  }

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
    const reply = FakeSocket.reply ? FakeSocket.reply(req, this) : null;
    if (reply) queueMicrotask(() => this.emit("message", { data: JSON.stringify(reply) }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", { code: 1000, reason: "" });
  }
}

function yahooBar(t, c = 1.1) {
  return { t, o: c, h: c + 0.001, l: c - 0.001, c };
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

const H = 60 * 60 * 1000;
const nowHour = Math.floor(Date.now() / H) * H;

function derivCandle(t, c = 1.1) {
  return { epoch: Math.floor(t / 1000), open: c, high: c + 0.001, low: c - 0.001, close: c };
}
// `count` hourly candles ending at endMs, oldest first, like the real response.
function pageEndingAt(endMs, count, stepMs, startPrice = 1.1) {
  const bars = [];
  for (let i = count - 1; i >= 0; i--) bars.push(derivCandle(endMs - i * stepMs, startPrice));
  return bars;
}
function candlesReply(req, bars) {
  return { msg_type: "candles", req_id: req.req_id, echo_req: req, candles: bars };
}

(async () => {
  try {
    global.WebSocket = FakeSocket;

    // --- Explicit provider: mapped ticker stays on Deriv --------------------
    delete process.env.OANDA_API_TOKEN;
    process.env.CANDLE_PROVIDER = "deriv";
    candles.clearCache();
    FakeSocket.reset();
    global.fetch = async () => {
      throw new Error("Yahoo should not be called");
    };
    FakeSocket.reply = (req) => candlesReply(req, pageEndingAt(nowHour, 3, H));

    let bars = await candles.getCandles("GC=F", "1h", "1mo");
    check("opens Deriv's public socket", /^wss:\/\/api\.derivws\.com\/trading\/v1\/options\/ws\/public$/.test(FakeSocket.sockets[0].url), true);
    const first = FakeSocket.sockets[0].sent[0];
    check("maps gold to frxXAUUSD", first.ticks_history, "frxXAUUSD");
    check("asks for candle style", first.style, "candles");
    check("maps 1h to 3600 seconds", first.granularity, 3600);
    check("requests 5,000 bars per page", first.count, 5000);
    check("starts from the latest bar", first.end, "latest");
    check("returns the parsed bars", bars.length, 3);
    check("epoch seconds become milliseconds", bars[2].t, nowHour);
    check("Deriv has no volume, so v is zero", bars[0].v, 0);

    // --- Long range is paged backwards --------------------------------------
    candles.clearCache();
    FakeSocket.reset();
    FakeSocket.reply = (req) => {
      const endMs = req.end === "latest" ? nowHour : Number(req.end) * 1000;
      return candlesReply(req, pageEndingAt(endMs, 5000, H));
    };
    bars = await candles.getCandles("EURUSD=X", "1h", "1y");
    const socket = FakeSocket.sockets[0];
    check("a year of hourly bars takes two pages", socket.sent.length, 2);
    const firstOldest = Math.floor((nowHour - 4999 * H) / 1000);
    check("the second page ends before the oldest bar", socket.sent[1].end, String(firstOldest - 1));
    check("bars from both pages are merged", bars.length > 5000, true);
    check("merged bars are in time order", bars.every((b, i) => i === 0 || b.t > bars[i - 1].t), true);
    const cutoff = Date.now() - 365 * 24 * H;
    check("a 1-year request is trimmed to a year", bars[0].t >= cutoff - H, true);
    check("the trim keeps the whole year", bars.length >= 8700, true);

    // --- The rest of the mappings -------------------------------------------
    for (const [ticker, symbol] of [
      ["^NDX", "OTC_NDX"],
      ["BTC-USD", "cryBTCUSD"],
      ["GBPUSD=X", "frxGBPUSD"],
      ["NZDJPY=X", "frxNZDJPY"],
    ]) {
      candles.clearCache();
      FakeSocket.reset();
      FakeSocket.reply = (req) => candlesReply(req, pageEndingAt(nowHour, 2, H));
      await candles.getCandles(ticker, "1h", "1mo");
      check(`${ticker} maps to ${symbol}`, FakeSocket.sockets[0].sent[0].ticks_history, symbol);
    }

    // --- Incomplete candles are dropped -------------------------------------
    candles.clearCache();
    FakeSocket.reset();
    FakeSocket.reply = (req) =>
      candlesReply(req, [{ epoch: Math.floor(nowHour / 1000), open: 1.1, high: 1.2, low: 1, close: 1.15 }, { epoch: Math.floor(nowHour / 1000) + 3600, open: null }]);
    bars = await candles.getCandles("USDCHF=X", "1h", "1mo");
    check("a candle with no open is skipped", bars.length, 1);

    // --- Unmapped tickers stay on Yahoo -------------------------------------
    candles.clearCache();
    FakeSocket.reset();
    let calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      return jsonResponse(yahooJson([yahooBar(nowHour)]));
    };
    await candles.getCandles("^GDAXI", "1h", "1mo");
    check("unmapped ticker stays on Yahoo", calls[0].includes("finance.yahoo.com"), true);
    check("unmapped ticker opens no Deriv socket", FakeSocket.sockets.length, 0);

    // --- Deriv errors fall back to Yahoo, with one warning ------------------
    candles.clearCache();
    FakeSocket.reset();
    const warnings = [];
    console.warn = (msg) => warnings.push(String(msg));
    FakeSocket.reply = (req) => ({ msg_type: "ticks_history", req_id: req.req_id, error: { code: "MarketIsClosed", message: "Market is closed" } });
    calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      return jsonResponse(yahooJson([yahooBar(nowHour), yahooBar(nowHour + H)]));
    };
    bars = await candles.getCandles("GBPUSD=X", "1h", "1mo");
    check("Deriv was tried before Yahoo", FakeSocket.sockets.length, 1);
    check("a Deriv error falls back to Yahoo", calls[0].includes("finance.yahoo.com"), true);
    check("the fallback returns Yahoo bars", bars.length, 2);
    await candles.getCandles("GBPUSD=X", "1h", "3mo");
    check("the warning is logged once per instrument", warnings.length, 1);
    check("the warning names Deriv", /Deriv unavailable.*using Yahoo candles/.test(warnings[0]), true);

    // --- A Node with no WebSocket client falls back instead of crashing -----
    candles.clearCache();
    FakeSocket.reset();
    warnings.length = 0;
    global.WebSocket = undefined;
    calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      return jsonResponse(yahooJson([yahooBar(nowHour)]));
    };
    bars = await candles.getCandles("AUDUSD=X", "1h", "1mo");
    check("no WebSocket still returns bars", bars.length, 1);
    check("no WebSocket falls back to Yahoo", calls[0].includes("finance.yahoo.com"), true);
    check("the runtime limit is explained", /no WebSocket client|Node 22/.test(warnings[0]), true);
    global.WebSocket = FakeSocket;

    // --- CANDLE_PROVIDER=yahoo still wins -----------------------------------
    process.env.CANDLE_PROVIDER = "yahoo";
    candles.clearCache();
    FakeSocket.reset();
    calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      return jsonResponse(yahooJson([yahooBar(nowHour)]));
    };
    await candles.getCandles("GC=F", "1h", "1mo");
    check("CANDLE_PROVIDER=yahoo forces Yahoo", calls[0].includes("finance.yahoo.com") && FakeSocket.sockets.length === 0, true);

    process.env.CANDLE_PROVIDER = "deriv";

    // --- Caching ------------------------------------------------------------
    candles.clearCache();
    FakeSocket.reset();
    FakeSocket.reply = (req) => candlesReply(req, pageEndingAt(nowHour, 2, H));
    await candles.getCandles("USDCAD=X", "1h", "1mo");
    const socketsUsed = FakeSocket.sockets.length;
    await candles.getCandles("USDCAD=X", "1h", "1mo");
    check("a second call is served from cache", FakeSocket.sockets.length, socketsUsed);

    // --- Only market data is read ------------------------------------------
    const allRequests = FakeSocket.sockets.flatMap((s) => s.sent);
    check("every request is a ticks_history call", allRequests.every((r) => Boolean(r.ticks_history)), true);
    check("no account, order or proposal call is made", allRequests.every((r) => !r.authorize && !r.buy && !r.proposal && !r.sell), true);
  } finally {
    global.fetch = realFetch;
    console.warn = realWarn;
    global.WebSocket = realWebSocket;
    for (const [key, value] of Object.entries(saved)) {
      const envKey = key === "provider" ? "CANDLE_PROVIDER" : "OANDA_API_TOKEN";
      if (value == null) delete process.env[envKey];
      else process.env[envKey] = value;
    }
    candles.clearCache();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
