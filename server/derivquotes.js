/**
 * Live quotes from Deriv's public market-data socket.
 *
 * The candle layer already names each market by a Deriv instrument. Quoting the
 * identical instrument is what makes a market's candles and its live price one
 * series instead of two feeds joined only by a basis offset. One socket is kept
 * open and subscribed to every market asked for; Deriv pushes about one tick a
 * second and the latest tick is the quote.
 *
 * Market data only: this module never authorizes, buys, sells or reads an
 * account.
 */

const { openDeriv } = require("./derivsocket");

// Ticks arrive every second or so. A tick older than this is not treated as a
// live price; a quiet symbol waits for the next push instead.
const TICK_FRESH_MS = 30 * 1000;
// A symbol that refused or stopped ticking is not retried on every cycle.
const FAIL_COOLDOWN_MS = 60 * 1000;
const WAIT_TIMEOUT_MS = 8000;

const ticks = new Map();
const waiters = new Map();
const subscribed = new Set();
const failed = new Map();

let session = null;
let opening = null;

function resolveWaiters(symbol, tick) {
  const list = waiters.get(symbol);
  if (!list) return;
  waiters.delete(symbol);
  for (const waiter of list) {
    clearTimeout(waiter.timer);
    waiter.resolve(tick);
  }
}

function rejectWaiters(symbol, err) {
  const list = waiters.get(symbol);
  if (!list) return;
  waiters.delete(symbol);
  for (const waiter of list) {
    clearTimeout(waiter.timer);
    waiter.reject(err);
  }
}

function handleMessage(json) {
  const tick = json && json.tick;
  if (tick && tick.symbol) {
    const price = Number(tick.quote);
    if (!Number.isFinite(price)) return;
    const row = {
      price,
      bid: Number(tick.bid),
      ask: Number(tick.ask),
      epoch: Number(tick.epoch),
      at: Date.now(),
    };
    ticks.set(tick.symbol, row);
    failed.delete(tick.symbol);
    resolveWaiters(tick.symbol, row);
    return;
  }

  // A subscription error carries the symbol that was asked for.
  if (json && json.error && json.echo_req && json.echo_req.ticks) {
    const symbol = json.echo_req.ticks;
    const detail = (json.error && (json.error.message || json.error.code)) || "request refused";
    const reason = `Deriv: ${String(detail).slice(0, 200)}`;
    failed.set(symbol, { reason, at: Date.now() });
    subscribed.delete(symbol);
    rejectWaiters(symbol, new Error(reason));
  }
}

function forgetSession() {
  session = null;
  opening = null;
  subscribed.clear();
}

function ensureSession() {
  if (session) return Promise.resolve(session);
  if (opening) return opening;

  opening = openDeriv({
    onMessage: handleMessage,
    onClose: (err) => {
      forgetSession();
      for (const symbol of [...waiters.keys()]) rejectWaiters(symbol, err);
    },
  })
    .then((opened) => {
      session = opened;
      return opened;
    })
    .finally(() => {
      opening = null;
    });

  return opening;
}

async function subscribe(symbol) {
  const open = await ensureSession();
  if (subscribed.has(symbol)) return;

  if (typeof symbol !== "string" || !symbol.trim()) {
    throw new Error("a Deriv quote needs an instrument");
  }

  subscribed.add(symbol);
  // The first tick answers this request; later ticks keep arriving on the same
  // subscription and are routed by symbol in handleMessage. A rejection drops
  // the subscription so a later call can try again.
  open.request({ ticks: symbol, subscribe: 1 }).catch(() => {
    subscribed.delete(symbol);
  });
}

function waitForTick(symbol) {
  return new Promise((resolve, reject) => {
    let list = waiters.get(symbol);
    if (!list) {
      list = new Set();
      waiters.set(symbol, list);
    }

    const waiter = { resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      list.delete(waiter);
      if (!list.size) waiters.delete(symbol);
      const reason = `Deriv sent no tick for ${symbol} in ${WAIT_TIMEOUT_MS / 1000}s`;
      failed.set(symbol, { reason, at: Date.now() });
      reject(new Error(reason));
    }, WAIT_TIMEOUT_MS);

    list.add(waiter);
  });
}

/**
 * Latest tick for a Deriv symbol. A fresh tick is served from memory; a symbol
 * with nothing current waits briefly for the next push rather than returning an
 * arbitrarily old price.
 *
 * @param {string} symbol Deriv instrument, e.g. "frxXAUUSD"
 * @returns {Promise<{price:number,bid:number,ask:number,epoch:number,at:number}>}
 */
async function getTick(symbol) {
  const failure = failed.get(symbol);
  if (failure && Date.now() - failure.at < FAIL_COOLDOWN_MS) {
    throw new Error(failure.reason);
  }

  const cached = ticks.get(symbol);
  if (cached && Date.now() - cached.at < TICK_FRESH_MS) {
    await subscribe(symbol);
    return cached;
  }

  await subscribe(symbol);

  // The first tick can arrive while the subscription is being sent. A tick that
  // landed in the last couple of seconds is that tick, not an old one.
  const landed = ticks.get(symbol);
  if (landed && Date.now() - landed.at < 2000) return landed;

  return waitForTick(symbol);
}

/** Drop the socket and remembered ticks. Used by tests and process shutdown. */
function close() {
  const open = session;
  forgetSession();
  ticks.clear();
  failed.clear();
  if (open) {
    try {
      open.close();
    } catch {
      /* already gone */
    }
  }
  for (const symbol of [...waiters.keys()]) rejectWaiters(symbol, new Error("Deriv quote feed closed"));
}

module.exports = { getTick, close };
